import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { BrowserController } from './core.mjs?v=9';
import { messageFingerprint } from './chat-message.mjs';
import { MessageIdentityTracker } from './message-tracker.mjs';
import { matchesAuthorizedContact } from './contact-authorization.mjs';
import { resolveRuntimePaths } from './runtime-paths.mjs';
export { MessageIdentityTracker } from './message-tracker.mjs';

const HOME = 'https://www.douyin.com/?recommend=1&from_nav=1';
const hash = value => createHash('sha256').update(value).digest('hex');
const stop = signal => signal?.throwIfAborted();
const AUDIO_LIMIT = 25 * 1024 * 1024;
const publicAudioAddress = address => !/^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|192\.0\.|192\.0\.2\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|198\.(?:18|19|51)\.|203\.0\.113\.|22[4-9]\.|2[3-5]\d\.)/.test(address);
function voiceAudioResponse(url, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method: 'GET', family: 4, signal, lookup: (hostname, options, callback) => {
      lookup(hostname, { all: true, family: 4 }).then(addresses => {
        if (!addresses.length || addresses.some(item => !publicAudioAddress(item.address))) throw new Error('语音资源没有可核对的公网地址。');
        if (options.all) callback(null, addresses); else callback(null, addresses[0].address, 4);
      }).catch(callback);
    } }, response => {
      const status = response.statusCode || 500, headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      if ([204, 205, 304].includes(status)) { response.resume(); resolve(new Response(null, { status, headers })); }
      else resolve(new Response(Readable.toWeb(response), { status, headers }));
    });
    request.once('error', () => reject(new Error('指定语音资源下载失败，未读取其他音频。')));
    request.setTimeout(20_000, () => request.destroy(new Error('指定语音资源下载超时。'))); request.end();
  });
}
const allowedAudioUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && ['douyin.com', 'douyincdn.com', 'douyinstatic.com', 'byteimg.com', 'ibytedtos.com', 'bytedance.com', 'douyinpic.com', 'snssdk.com', 'bytecdn.cn', 'douyinvod.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)); } catch { return false; }
};
function chatAudioFormat(bytes) {
  if (bytes.length < 8) return null;
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE') return { mimeType: 'audio/wav', extension: 'wav' };
  if (bytes.subarray(0, 4).toString() === 'OggS') return { mimeType: 'audio/ogg', extension: 'ogg' };
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { mimeType: 'audio/webm', extension: 'webm' };
  if (bytes.subarray(4, 8).toString() === 'ftyp') return { mimeType: 'audio/mp4', extension: 'm4a' };
  if (bytes.subarray(0, 6).toString() === '#!AMR\n' || bytes.subarray(0, 9).toString() === '#!AMR-WB\n') return { mimeType: 'audio/amr', extension: 'amr' };
  if (bytes.subarray(0, 3).toString() === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0) return { mimeType: 'audio/mpeg', extension: 'mp3' };
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return { mimeType: 'audio/aac', extension: 'aac' };
  return null;
}
const readableDraft = value => value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
const localDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const contactIdentityKey = row => row.nativeId ? `native:${row.nativeId}` : row.identityKey ? `rendered:${row.identityKey}` : row.conversationType === 'direct' && row.profileUrl ? `user:${row.profileUrl}` : null;
const sameConversationIdentity = (current, contact) => Boolean(current && contact && current.identityUnavailable !== true && !current.identityConflict && !contact.identityConflict
  && current.isGroup === contact.isGroup && current.conversationType === contact.conversationType
  && (!current.identityKey || !contact.identityKey || current.identityKey === contact.identityKey)
  && contactIdentityKey(current) && contactIdentityKey(current) === contactIdentityKey(contact));
const contactOpaqueId = row => `conv:${hash(contactIdentityKey(row) ?? `${row.displayName}\0${row.avatar}`)}`;
const contactIdentityBinding = row => !row.identityConflict && contactIdentityKey(row) && ['direct', 'group'].includes(row.conversationType)
  ? `binding:${hash(`${row.conversationType}\0${contactIdentityKey(row)}`)}` : null;
const stableIdentityFields = row => contactIdentityBinding(row) ? { identityVersion: 2, identityKind: row.nativeId ? 'native-conversation' : row.identityKey ? `rendered-${row.identityKey.split(':')[0]}` : 'profile-user', identityHash: hash(contactIdentityKey(row)) } : {};
const expectedDomIdentity = contact => ({ expectedKey: contactIdentityKey(contact), expectedType: contact.conversationType, expectedRenderedKey: contact.identityKey || null });

export function analyzeConversationDay(snapshot, { now = Date.now, confirmedHistory = [] } = {}) {
  const current = typeof now === 'function' ? now() : now, today = localDay(current);
  const recipientId = snapshot?.conversation?.id || snapshot?.contact?.id;
  if (typeof recipientId === 'string' && recipientId.trim() && confirmedHistory.some(item => item?.confirmed === true && item.recipientId === recipientId && typeof item.messageId === 'string' && item.messageId.trim() && item.date === today && Number.isFinite(Date.parse(item.at)) && localDay(Date.parse(item.at)) === today && Date.parse(item.at) <= current)) return { status: 'already-sent', reason: '共同账本已确认今天向这位好友发过消息。' };
  const evidence = snapshot?.dayEvidence;
  if (snapshot?.blocked || snapshot?.loginRequired || snapshot?.verificationRequired || !recipientId || !Array.isArray(snapshot.messages) || !evidence?.latestEndVerified || evidence.chronology !== 'oldest-first' || !Number.isFinite(Date.parse(evidence.observedAt)) || localDay(Date.parse(evidence.observedAt)) !== today || Date.parse(evidence.observedAt) > current || current - Date.parse(evidence.observedAt) > 60_000) return { status: 'date-unknown', reason: '会话最新端、日期或快照时效尚未核实。' };
  const messages = snapshot.messages;
  if (messages.some(item => !['incoming', 'outgoing'].includes(item.sender || item.direction) || item.pending || item.failed)) return { status: 'date-unknown', reason: '会话含方向不明或未确认的消息，未自动问候。' };
  const dayOf = item => {
    if (item.dateEvidence?.kind === 'unknown') return null;
    const raw = String(item.dateEvidence?.raw ?? item.sentAt ?? item.timestamp ?? '').trim();
    if (/^今天(?:\s|$)/.test(raw)) return today;
    const date = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?(?:$|[ T\s])/.exec(raw);
    if (!date) return null;
    const padded = `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`;
    if (!Number.isFinite(Date.parse(padded + 'T00:00:00+08:00')) || localDay(Date.parse(padded + 'T00:00:00+08:00')) !== padded) return null;
    if (/T.*(?:Z|[+-]\d\d:\d\d)$/.test(raw)) return Number.isFinite(Date.parse(raw)) ? localDay(Date.parse(raw)) : null;
    return padded;
  };
  if (messages.some(item => (item.sender || item.direction) === 'outgoing' && dayOf(item) === today)) return { status: 'already-sent', reason: '当前会话已读到今天真实发出的消息。' };
  const outgoing = messages.findLastIndex(item => (item.sender || item.direction) === 'outgoing');
  if (messages.slice(outgoing + 1).some(item => (item.sender || item.direction) === 'incoming')) return { status: 'pending-incoming', reason: '对方有待回复消息，优先交给聊天回复。' };
  if (!messages.length && evidence.emptyTodayVerified === true) return { status: 'eligible', reason: '当前最新会话明确显示今天尚无消息。' };
  if (outgoing >= 0) {
    const date = dayOf(messages[outgoing]);
    if (date && date < today) return { status: 'eligible', reason: '已核对最新端，最近发出消息的明确日期早于今天。' };
  }
  return { status: 'date-unknown', reason: '没有足够日期证据判断今天是否发过消息。' };
}

// 只采集会话身份和未读标识，不读取预览或其他会话正文。
export async function readContactDom() {
  const clean = value => (value ?? '').replace(/\s+/g, ' ').trim();
  const resource = value => { try { return new URL(value, location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch { return ''; } };
  const own = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  const digest = async value => globalThis.crypto?.subtle ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('') : null;
  const renderedIdentity = async row => {
    const keys = Object.getOwnPropertyNames(row).filter(key => key.startsWith('__reactProps$'));
    if (keys.length !== 1) return { identityKey: null, identitySource: null, identityConflict: keys.length > 1 };
    const identities = new Map(), types = new Set(), seen = new Set();
    const inspect = (value, conversation = false) => {
      if (!value || typeof value !== 'object') return;
      for (const [family, fields] of [['conversation', ['conversationId', ...(conversation ? ['id'] : [])]], ['conversation-short', ['conversationShortId', ...(conversation ? ['shortId'] : [])]], ['group', ['groupId']], ['user', ['secUid', ...(conversation ? ['_toParticipantSecUserId'] : [])]], ['user-id', ['userId']]]) {
        for (const field of fields) { const id = own(value, field); if (typeof id !== 'string' && !Number.isSafeInteger(id)) continue; const normalized = String(id).trim(); if (normalized && normalized.length <= 512) { const set = identities.get(family) ?? new Set(); set.add(normalized); identities.set(family, set); } }
      }
      for (const field of ['conversationType', 'type']) { const type = own(value, field); if (typeof type === 'string' && ['direct', 'single', 'personal', 'group'].includes(type.toLowerCase())) types.add(type.toLowerCase() === 'group' ? 'group' : 'direct'); }
    };
    const visit = (props, depth) => {
      if (!props || typeof props !== 'object' || seen.has(props)) return; seen.add(props); inspect(props);
      for (const key of ['conversation', 'conversationInfo', 'conversationData']) inspect(own(props, key), true);
      if (depth >= 3) return;
      const children = own(props, 'children');
      for (const child of (Array.isArray(children) ? children : [children]).slice(0, 100)) visit(own(child, 'props'), depth + 1);
    };
    // 只读取已渲染行的三层 children props 和明确会话对象的标量身份，不执行 getter。
    visit(own(row, keys[0]), 0);
    if ([...identities.values()].some(values => values.size !== 1) || types.size > 1) return { identityKey: null, identitySource: null, identityConflict: true };
    const selected = [...identities].find(([family]) => ['conversation', 'conversation-short', 'group'].includes(family)) ?? [...identities].find(([family]) => family === 'user') ?? [...identities][0];
    if (!selected) return { identityKey: null, identitySource: null, identityConflict: false, renderedType: [...types][0] ?? null };
    const fingerprint = await digest([...selected[1]][0]);
    return { identityKey: fingerprint ? `${selected[0]}:${fingerprint}` : null, identitySource: fingerprint ? 'rendered-row-metadata' : null, identityConflict: false, renderedType: [...types][0] ?? null };
  };
  const dialog = document.querySelector('[data-e2e="im-dialog"]');
  return Promise.all([...(dialog?.querySelectorAll('[data-e2e="conversation-item"]') ?? [])].map(async (row, index) => {
    const metadata = await renderedIdentity(row);
    let profileUrl = null;
    const name = row.querySelector('.conversationConversationItemtitle,[data-e2e="conversation-name"]');
    const link = name?.closest('a[href]') || name?.querySelector('a[href]') || row.querySelector('a[data-e2e="conversation-user"][href]');
    try { const url = new URL(link?.getAttribute('href'), location.href); if (url.protocol === 'https:' && url.hostname === 'www.douyin.com' && /^\/user\/[^/?#]+\/?$/.test(url.pathname)) profileUrl = url.origin + url.pathname; } catch {}
    const relationshipLabel = clean(row.querySelector('[data-e2e="follow-status"],[data-e2e="relationship"]')?.textContent);
    const groupAvatar = row.querySelector('[class*="GroupAvatar"],[data-e2e="group-avatar"]');
    const declared = row.getAttribute('data-conversation-type') || metadata.renderedType;
    const isGroup = declared === 'group' || row.getAttribute('data-is-group') === 'true' || Boolean(groupAvatar);
    const isDirect = !isGroup && (['direct', 'single', 'personal'].includes(declared) || row.getAttribute('data-is-group') === 'false' || Boolean(profileUrl) || /^user(?:-id)?:/.test(metadata.identityKey || '') && Boolean(row.querySelector('.commonIMAvataravatarContainer img')));
    const conversationType = isGroup ? 'group' : isDirect ? 'direct' : 'unknown';
    const groupImages = [...(groupAvatar?.querySelectorAll('img') ?? [])].map(image => resource(image.getAttribute('src'))).filter(Boolean).sort();
    const avatar = isGroup ? groupImages.length ? `group-avatar:${JSON.stringify(groupImages)}` : groupAvatar ? 'group-marker' : resource(row.querySelector('img')?.getAttribute('src')) : resource(row.querySelector('.commonIMAvataravatarContainer img,img')?.getAttribute('src'));
    const identityConflict = metadata.identityConflict || Boolean(metadata.renderedType && metadata.renderedType !== conversationType);
    const identityKey = isGroup && metadata.identityKey && !/^(?:conversation|conversation-short|group):/.test(metadata.identityKey) ? null : metadata.identityKey;
    return ({
    index,
    displayName: clean(name?.textContent),
    nativeId: row.getAttribute('data-conversation-id') || row.getAttribute('data-conversation-short-id') || null,
    avatar,
    unread: Boolean(row.querySelector('[class*="unread"],[class*="Unread"],[data-e2e="unread-count"]')),
    isGroup: isGroup ? true : isDirect ? false : null, conversationType,
    profileUrl, relationshipLabel: !isGroup && ['已关注', '相互关注', '互相关注'].includes(relationshipLabel) ? relationshipLabel : null,
    ...metadata, identityKey, identityConflict,
  }); }));
}

export function readFollowingDom() {
  const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const roots = [...document.querySelectorAll('[data-e2e="user-fans-container"],[data-e2e="following-list"],[data-e2e="follow-list"]')].filter(visible);
  const rows = roots.flatMap(root => [...root.querySelectorAll('.OlxToPIh,[data-e2e="follow-user-item"],[data-e2e="user-item"]')]).filter(visible);
  return rows.map(row => {
    const link = row.querySelector('.Zce7SWd3 a,[data-e2e="user-name"],a[href*="/user/"]');
    const displayName = link?.textContent.trim();
    const labels = [...row.querySelectorAll('button,[data-e2e="follow-status"],[data-e2e="relationship"]')].map(e => e.textContent.trim());
    return { displayName, mutual: labels.some(label => ['相互关注', '互相关注'].includes(label)) };
  }).filter(row => row.displayName);
}

export function readConversationListDom() {
  const selectors = ['[data-e2e="im-dialog"] [data-e2e="conversation-list"]', '[data-e2e="im-dialog"] [class*="conversationConversationListwrapper"]'];
  const found = [];
  for (const selector of selectors) [...document.querySelectorAll(selector)].forEach((element, index) => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    if (rect.width < 1 || rect.height < 1 || style.display === 'none' || style.visibility === 'hidden' || found.some(item => item.element === element)) return;
    if (!element.querySelector('[data-e2e="conversation-item"]')) return;
    found.push({ element, selector, index });
  });
  if (found.length !== 1) return null;
  const { element, selector, index } = found[0];
  const loading = [...element.querySelectorAll('[data-e2e="conversation-loading"],[aria-busy="true"],[class*="loading"],[class*="Loading"]')].some(node => { const rect = node.getBoundingClientRect(), style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; });
  return { selector, index, scrollTop: element.scrollTop, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, loading };
}

export function readChatBlockers() {
  const visible = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
  const labels = [...document.querySelectorAll('body *')].filter(e => !e.childElementCount && visible(e) && !e.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]'));
  return {
    loginRequired: labels.some(e => /扫码登录|验证码登录|登录后即可|手机扫码登录/.test(e.textContent)),
    verificationRequired: [...document.querySelectorAll('#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"]')].some(visible) || labels.some(e => /请完成下方验证|请完成验证|安全验证|拖动滑块/.test(e.textContent)),
  };
}

export async function readConversationDom({ expectedKey, expectedType, expectedRenderedKey } = {}) {
  const clean = value => (value ?? '').trim();
  const readableText = element => {
    const parts = [];
    const visit = node => {
      if (node.nodeType === Node.TEXT_NODE) { parts.push(node.textContent || ''); return; }
      if (!(node instanceof Element) || node.matches('script,style,[aria-hidden="true"]')) return;
      if (node.tagName === 'IMG') { const label = clean(node.getAttribute('title') || node.getAttribute('alt') || node.getAttribute('aria-label')); parts.push(label || '[未命名表情]'); return; }
      if (node.tagName === 'BR') { parts.push('\n'); return; }
      for (const child of node.childNodes) visit(child);
    };
    visit(element); return clean(parts.join(''));
  };
  const resource = value => { try { return new URL(value, location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch { return ''; } };
  const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
  const dialog = document.querySelector('[data-e2e="im-dialog"]');
  const headers = [...(dialog?.querySelectorAll('[class*="StackLayoutStackChatHeaderuser"],[data-e2e="chat-header"],[data-e2e="group-chat-header"]') ?? [])].filter(visible);
  const header = headers.length === 1 ? headers[0] : null;
  const root = header?.closest('[class*="StackLayoutpagespageRoot"],[data-e2e="chat-page"]');
  const displayName = clean(header?.querySelector('[class*="StackLayoutStackChatHeadertitle"],[data-e2e="chat-title"],[data-e2e="group-chat-title"]')?.textContent).replace(/\s+/g, ' ');
  const groupAvatar = header?.querySelector('[class*="GroupAvatar"],[data-e2e="group-avatar"]');
  const declaredGroup = header?.getAttribute('data-conversation-type') === 'group' || root?.getAttribute('data-conversation-type') === 'group' || header?.getAttribute('data-is-group') === 'true' || Boolean(groupAvatar) || header?.getAttribute('data-e2e') === 'group-chat-header';
  const groupImages = [...(groupAvatar?.querySelectorAll('img') ?? [])].map(image => resource(image.getAttribute('src'))).filter(Boolean).sort();
  const avatar = declaredGroup ? groupImages.length ? `group-avatar:${JSON.stringify(groupImages)}` : groupAvatar ? 'group-marker' : resource(header?.querySelector('img')?.getAttribute('src')) : resource(header?.querySelector('img')?.getAttribute('src'));
  const conversationNativeId = header?.getAttribute('data-conversation-id') || root?.getAttribute('data-conversation-id') || header?.getAttribute('data-conversation-short-id') || root?.getAttribute('data-conversation-short-id') || null;
  const own = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  const digest = async value => globalThis.crypto?.subtle ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('') : null;
  const identities = new Map(), types = new Set(), add = (family, value) => {
    if (typeof value !== 'string' && !Number.isSafeInteger(value)) return;
    const id = String(value).trim(); if (!id || id.length > 512) return;
    const values = identities.get(family) ?? new Set(); values.add(id); identities.set(family, values);
  };
  // 只读取当前可见会话头部已核实的固定 props 路径，不执行 getter 或访问消息对象。
  const keys = header ? Object.getOwnPropertyNames(header).filter(key => key.startsWith('__reactProps$')) : [];
  const props = keys.length === 1 ? own(header, keys[0]) : null, children = own(props, 'children');
  const conversation = own(own(Array.isArray(children) ? own(children, '0') : children, 'props'), 'conversation');
  for (const [family, fields] of [['conversation', ['conversationId', 'id']], ['conversation-short', ['conversationShortId', 'shortId']], ['group', ['groupId']], ['user', ['secUid', '_toParticipantSecUserId']], ['user-id', ['userId']]]) for (const field of fields) add(family, own(conversation, field));
  for (const field of ['conversationType', 'type']) { const type = own(conversation, field); if (typeof type === 'string' && ['direct', 'single', 'personal', 'group'].includes(type.toLowerCase())) types.add(type.toLowerCase() === 'group' ? 'group' : 'direct'); }
  let profileUrl = null;
  for (const link of header?.querySelectorAll('a[href]') ?? []) {
    try { const url = new URL(link.getAttribute('href'), location.href); if (url.protocol === 'https:' && url.hostname === 'www.douyin.com' && /^\/user\/[^/?#]+\/?$/.test(url.pathname)) { if (profileUrl && profileUrl !== url.origin + url.pathname) types.add('conflict'); profileUrl = url.origin + url.pathname; } } catch {}
  }
  for (const declared of [header?.getAttribute('data-conversation-type'), root?.getAttribute('data-conversation-type')]) if (declared && ['direct', 'single', 'personal', 'group'].includes(declared)) types.add(declared === 'group' ? 'group' : 'direct');
  if (declaredGroup) types.add('group');
  else if (profileUrl || identities.has('user') || identities.has('user-id') || header?.getAttribute('data-is-group') === 'false') types.add('direct');
  const conversationType = types.size === 1 ? [...types][0] : 'unknown';
  const conflictingNativeIds = new Set([header?.getAttribute('data-conversation-id'), root?.getAttribute('data-conversation-id'), header?.getAttribute('data-conversation-short-id'), root?.getAttribute('data-conversation-short-id')].filter(Boolean));
  let identityConflict = keys.length > 1 || types.size > 1 || conflictingNativeIds.size > 1 || [...identities.values()].some(values => values.size !== 1);
  const selected = [...identities].find(([family]) => ['conversation', 'conversation-short', 'group'].includes(family)) ?? [...identities].find(([family]) => family === 'user') ?? [...identities][0];
  const metadataSignature = () => JSON.stringify(['conversationId', 'id', 'conversationShortId', 'shortId', 'groupId', 'secUid', '_toParticipantSecUserId', 'userId', 'conversationType', 'type'].map(key => { const value = own(conversation, key); return typeof value === 'string' || Number.isSafeInteger(value) ? String(value) : null; }));
  const domMetadataSignature = () => JSON.stringify([header, root].map(element => element ? ['data-e2e', 'data-conversation-id', 'data-conversation-short-id', 'data-conversation-type', 'data-is-group'].map(key => element.getAttribute(key)) : null).concat(Boolean(header?.querySelector('[class*="GroupAvatar"],[data-e2e="group-avatar"]'))));
  const initialMetadata = metadataSignature(), initialDomMetadata = domMetadataSignature();
  const fingerprint = selected && !identityConflict ? await digest([...selected[1]][0]) : null;
  const currentProps = keys.length === 1 ? own(header, keys[0]) : null;
  const currentChildren = own(currentProps, 'children'), currentConversation = own(own(Array.isArray(currentChildren) ? own(currentChildren, '0') : currentChildren, 'props'), 'conversation');
  const currentHeaders = [...document.querySelectorAll('[data-e2e="im-dialog"] [class*="StackLayoutStackChatHeaderuser"],[data-e2e="im-dialog"] [data-e2e="chat-header"],[data-e2e="im-dialog"] [data-e2e="group-chat-header"]')].filter(visible);
  if (!header?.isConnected || currentHeaders.length !== 1 || currentHeaders[0] !== header || currentProps !== props || currentConversation !== conversation || metadataSignature() !== initialMetadata || domMetadataSignature() !== initialDomMetadata) identityConflict = true;
  const identityKey = fingerprint && (conversationType !== 'group' || ['conversation', 'conversation-short', 'group'].includes(selected[0])) ? `${selected[0]}:${fingerprint}` : null;
  const identity = { displayName, avatar, nativeId: conversationNativeId, identityKey, profileUrl, identityConflict, isGroup: conversationType === 'group' ? true : conversationType === 'direct' ? false : null, conversationType };
  const stableKey = conversationNativeId ? `native:${conversationNativeId}` : identityKey ? `rendered:${identityKey}` : conversationType === 'direct' && profileUrl ? `user:${profileUrl}` : null;
  if (!header || identityConflict || !stableKey || conversationType === 'unknown' || expectedKey && (stableKey !== expectedKey || conversationType !== expectedType || expectedRenderedKey && identityKey && identityKey !== expectedRenderedKey)) return { ...identity, messages: [], identityUnavailable: true, loading: false };
  let timestamp = null;
  const messages = [];
  const contents = '[data-e2e="msg-item-content"],[data-e2e="message-content"],[data-testid="message-content"]';
  const nodes = [...(root?.querySelectorAll(`[class*="MessageBoxTimetimeLayout"],time,${contents}`) ?? [])].filter(node => !node.matches(contents) || !node.parentElement?.closest(contents));
  const list = root?.querySelector('[class*="messageMessageListlist"],[data-e2e="message-list"]');
  let newestFirst = false, chronologySource = list ? 'message-list-order-unverified' : 'dom-order';
  if (list) {
    const style = getComputedStyle(list);
    let verticallyFlipped = false;
    try { verticallyFlipped = style.transform !== 'none' && new DOMMatrix(style.transform).d < 0; } catch {}
    newestFirst = verticallyFlipped || style.flexDirection === 'column-reverse';
    if (newestFirst) chronologySource = verticallyFlipped ? 'message-list-vertical-transform' : 'message-list-column-reverse';
  }
  for (const node of nodes) {
    if (!node.matches(contents)) { timestamp = node.getAttribute('datetime') || clean(node.textContent) || timestamp; continue; }
    const box = node.closest('[class*="messageMessageBoxmessageBox"],[data-e2e="message-row"]') || node;
    const ancestors = []; for (let e = node; e && e !== root && root?.contains(e); e = e.parentElement) ancestors.push(e);
    const fromMe = ancestors.some(e => e.getAttribute('data-direction') === 'outgoing' || e.getAttribute('data-is-self') === 'true' || e.getAttribute('data-is-from-me') === 'true' || [...e.classList].some(token => /(?:^|[_-]|Content|Box)isFromMe(?:[_-]|$)/i.test(token)));
    const incoming = ancestors.some(e => e.getAttribute('data-direction') === 'incoming' || e.getAttribute('data-is-self') === 'false' || e.getAttribute('data-is-from-me') === 'false');
    const direction = fromMe && !incoming ? 'outgoing' : incoming && !fromMe || !fromMe && box.classList.contains('messageMessageBoxmessageBox') ? 'incoming' : 'unknown';
    const textNode = node.querySelector('[class*="MessageItemTextcontainer"],[data-e2e="message-text"]');
    const emoji = node.querySelector('[class*="MessageItemEmojiemojiBox"],[data-e2e="message-emoji"]');
    const shareCard = node.querySelector('[class*="MessageItemShareAwemecontainer"],[data-e2e="shared-video-card"]');
    const shareFallback = shareCard ? null : node.querySelector('a[href*="/video/"]');
    const share = shareCard || shareFallback || null;
    const image = !textNode && !emoji && !share ? node.querySelector('[class*="MessageItemImagecontainer"],[class*="MessageItemImageimageBox"],[class*="MessageItemImageImageBox"],[data-e2e="message-image"]') : null;
    const voice = !textNode && !emoji && !share && !image ? node.querySelector('[class*="MessageItemAudio"],[class*="MessageItemVoice"],[data-e2e="message-voice"],[data-e2e="message-audio"]') : null;
    // 抖音「互动玩法」卡片（如点亮聊天火花邀请）由 Lynx 渲染，没有文本节点也没有链接，但 innerText 可读
    const bulletCard = !textNode && !emoji && !share && !image && !voice ? node.querySelector('[class*="BulletGeneralCard"],[data-tag="lynx-card"]') : null;
    const inlineEmoji = textNode ? [...textNode.querySelectorAll('[class*="TextMessageTextemoji"] img,[data-e2e="inline-emoji"] img,img[data-e2e="inline-emoji"]')] : [];
    const kind = textNode ? 'text' : emoji ? 'emoji' : share ? 'video' : image ? 'image' : voice ? 'voice' : bulletCard ? 'card' : 'unsupported';
    const text = textNode ? readableText(textNode) : '';
    let media = null;
    if (inlineEmoji.length && inlineEmoji.some(item => !clean(item.getAttribute('title') || item.getAttribute('alt') || item.getAttribute('aria-label')))) {
      media = { type: 'emoji', inline: true, label: null, images: inlineEmoji.map(item => ({ src: item.currentSrc || item.getAttribute('src') || '', label: clean(item.getAttribute('title') || item.getAttribute('alt') || item.getAttribute('aria-label')) || null })), requiresVisual: true, understandingScope: 'single-message-image' };
    }
    if (emoji) {
      const images = [...emoji.querySelectorAll('img')].map(image => ({ src: image.currentSrc || image.getAttribute('src') || '', label: clean(image.getAttribute('alt') || image.getAttribute('aria-label') || image.getAttribute('title')) || null }));
      const label = clean(emoji.getAttribute('aria-label') || emoji.getAttribute('title')) || images.map(image => image.label).filter(Boolean).join(' ') || null;
      media = { type: 'emoji', label, images, requiresVisual: true, understandingScope: 'single-message-image' };
    }
    if (share) {
      let url = null, videoId = null;
      for (const link of [share, ...share.querySelectorAll('a[href]')]) {
        try { const candidate = new URL(link.getAttribute('href'), location.href); const match = /^\/video\/(\d+)\/?$/.exec(candidate.pathname);
          if (candidate.protocol === 'https:' && /^(?:www\.)?douyin\.com$/.test(candidate.hostname) && match) { videoId = match[1]; url = `https://www.douyin.com/video/${videoId}`; break; }
        } catch {}
      }
      const title = clean(share.querySelector('[class*="MessageItemShareAwemetitle"],[class*="MessageItemShareAwemedesc"],[data-e2e="shared-video-title"]')?.textContent) || null;
      const author = clean(share.querySelector('[class*="MessageItemShareAwemeauthorName"],[data-e2e="shared-video-author"]')?.textContent) || null;
      const cover = share.querySelector('.MessageItemShareAwemeawemeContainer,img:not(.MessageItemShareAwemephotosTag):not(.MessageItemShareAwemeauthorAvatar)');
      media = { type: 'shared-work', videoId, url, title, author, isPhotoGallery: Boolean(share.querySelector('.MessageItemShareAwemephotosTag')),
        images: cover ? [{ src: cover.currentSrc || cover.getAttribute('src') || '', label: clean(cover.getAttribute('alt')) || null }] : [],
        requiresVisual: true, understandingScope: 'card-cover-and-dom-metadata', publicUrlSource: url ? 'dom-link' : null, canResolveByOpeningCard: true };
    }
    if (image) {
      const images = [...image.querySelectorAll('img')].map(item => ({ src: item.currentSrc || item.getAttribute('src') || '', label: clean(item.getAttribute('alt') || item.getAttribute('aria-label')) || null }));
      if (image.tagName === 'IMG') images.unshift({ src: image.currentSrc || image.getAttribute('src') || '', label: clean(image.getAttribute('alt')) || null });
      const actual = image.tagName === 'IMG' ? image : image.querySelector('img');
      media = { type: 'image', images, imageReady: images.length === 1 && Boolean(images[0].src) && actual?.complete === true && actual.naturalWidth > 0, requiresVisual: true, understandingScope: 'single-message-image' };
    }
    if (voice) {
      const audio = voice.matches('audio') ? voice : voice.querySelector('audio');
      let source = audio?.currentSrc || audio?.getAttribute('src') || audio?.querySelector('source[src]')?.getAttribute('src') || voice.getAttribute('data-audio-src') || '';
      let rendererDuration = null;
      if (!source && voice.matches('[class*="MessageItemAudioaudioBoxWrapper"]')) {
        const own = (object, key) => object && typeof object === 'object' ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
        const keys = Object.getOwnPropertyNames(voice).filter(key => key.startsWith('__reactProps$'));
        if (keys.length === 1) {
          // 仅取这条已渲染语音控件的固定资源字段，不遍历状态、不执行 getter 或播放器回调。
          const children = own(own(own(voice, keys[0]), 'children'), '0');
          const audioChild = own(own(own(children, 'props'), 'children'), '1');
          const data = own(own(audioChild, 'props'), 'data');
          const urls = own(own(data, 'resource_url'), 'url_list');
          const first = own(urls, '0');
          if (typeof first === 'string' && first.length <= 8192) source = first;
          const duration = own(data, 'duration'); if (Number.isFinite(duration) && duration > 0) rendererDuration = duration;
        }
      }
      const durationValue = voice.getAttribute('data-duration') || audio?.getAttribute('data-duration') || '';
      const durationMatch = /^\s*(\d+(?:\.\d+)?)\s*(?:秒|["″])?\s*$/.exec(durationValue || clean(voice.querySelector('[data-e2e="voice-duration"],[class*="duration"],[class*="Duration"]')?.textContent));
      const visibleDuration = durationMatch ? Number(durationMatch[1]) : Number.isFinite(audio?.duration) ? audio.duration : null;
      const durationVerified = visibleDuration !== null && (rendererDuration === null || rendererDuration / 1000 >= visibleDuration && rendererDuration / 1000 < visibleDuration + 1.05);
      const durationSeconds = durationVerified ? rendererDuration === null ? visibleDuration : rendererDuration / 1000 : null;
      media = { type: 'voice', durationSeconds, audioSources: source ? [{ src: source }] : [], requiresTranscription: true, understandingScope: 'single-message-audio' };
    }
    if (bulletCard) {
      const label = clean(bulletCard.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
      if (label) media = { type: 'interaction-card', label, text: label, requiresVisual: false, understandingScope: 'card-text' };
    }
    const indexNode = node.closest('[data-index]');
    const rawOrder = indexNode?.getAttribute('data-index');
    const order = rawOrder !== null && rawOrder !== undefined && /^\d+$/.test(rawOrder) ? Number(rawOrder) : null;
    const nativeId = box.getAttribute('data-message-id') || box.getAttribute('data-msg-id') || node.getAttribute('data-message-id') || null;
    const ownTimestamp = box.getAttribute('data-sent-at') || box.getAttribute('data-timestamp') || node.getAttribute('data-sent-at');
    const ownTimeNode = box.querySelector('[class*="MessageBoxTimetimeLayout"],time');
    const ownTime = ownTimeNode?.getAttribute('datetime') || clean(ownTimeNode?.textContent);
    const dated = ownTimestamp || ownTime || (!newestFirst ? timestamp : null);
    const memberNode = declaredGroup ? box.querySelector('[data-e2e="message-sender"],[data-e2e="sender-name"]') : null;
    const member = declaredGroup ? { nativeId: box.getAttribute('data-sender-id') || memberNode?.getAttribute('data-user-id') || null, name: clean(memberNode?.textContent) || null } : null;
    const mentionedSelf = Boolean(declaredGroup && box.querySelector('[data-mention-self="true"],[data-is-self-mention="true"],[data-e2e="mention"][data-self="true"]'));
    messages.push({ nativeId, direction, sender: direction, text, kind, media, timestamp: ownTimestamp || timestamp, order, domIndex: order, domPosition: messages.length, orderMode: list ? 'relative' : 'absolute',
      ...(declaredGroup ? { member, mentionedSelf } : {}),
      dateEvidence: { raw: dated || timestamp || '', kind: dated ? /^今天(?:\s|$)/.test(dated) ? 'today' : /^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.test(dated) ? 'absolute' : 'unknown' : 'unknown', source: ownTimestamp ? 'message-attribute' : ownTime ? 'message-time' : !newestFirst ? 'group-label' : 'unverified-group-label' },
      failed: Boolean(box.querySelector('[class*="sendFail"],[class*="SendFail"],[data-e2e="message-failed"]')),
      pending: Boolean(box.querySelector('[class*="sending"],[class*="Sending"],[data-e2e="message-pending"]')) });
  }
  const emptyTodayVerified = messages.length === 0 && [...(root?.querySelectorAll('[data-e2e="empty-conversation"],[class*="empty" i]') ?? [])].some(element => visible(element) && /^今天(?:还)?(?:暂无|没有|尚无)消息[。！!\s]*$/.test(clean(element.textContent)));
  const latestEndVerified = emptyTodayVerified || newestFirst && messages.some(message => message.domIndex === 0);
  if (list) messages.forEach(message => { message.latestEndVerified = latestEndVerified; });
  if (newestFirst) {
    messages.reverse();
    let previousTime = null;
    messages.forEach((message, index) => { message.order = index; message.timestamp ??= previousTime; previousTime = message.timestamp; });
  }
  const loading = [...(root?.querySelectorAll('[class*="loading"],[class*="Loading"],[aria-busy="true"]') ?? [])].some(visible);
  const historyStartVerified = [...(root?.querySelectorAll('[data-e2e="history-start"],[class*="no-more-tip"],[class*="noMoreTip"]') ?? [])].some(element => visible(element) && /没有更多消息|暂无更多消息|已显示全部消息/.test(clean(element.textContent)));
  return { ...identity, messages, loading, latestEndVerified, emptyTodayVerified, historyStartVerified, observedAt: new Date().toISOString(), chronology: list && !newestFirst && !emptyTodayVerified ? 'unknown' : 'oldest-first', chronologySource, sourceDomOrder: newestFirst ? 'newest-first' : list ? 'unknown' : 'oldest-first' };
}

export async function readChatIdentityDom() {
  const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
  const headers = [...document.querySelectorAll('[data-e2e="im-dialog"] [class*="StackLayoutStackChatHeaderuser"],[data-e2e="im-dialog"] [data-e2e="chat-header"],[data-e2e="im-dialog"] [data-e2e="group-chat-header"]')].filter(visible);
  const header = headers.length === 1 ? headers[0] : null;
  const root = header?.closest('[class*="StackLayoutpagespageRoot"],[data-e2e="chat-page"]');
  const resource = value => { try { return new URL(value, location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch { return ''; } };
  const groupAvatar = header?.querySelector('[class*="GroupAvatar"],[data-e2e="group-avatar"]');
  const isGroup = header?.getAttribute('data-conversation-type') === 'group' || root?.getAttribute('data-conversation-type') === 'group' || header?.getAttribute('data-is-group') === 'true' || Boolean(groupAvatar) || header?.getAttribute('data-e2e') === 'group-chat-header';
  const groupImages = [...(groupAvatar?.querySelectorAll('img') ?? [])].map(image => resource(image.getAttribute('src'))).filter(Boolean).sort();
  const avatar = isGroup ? groupImages.length ? `group-avatar:${JSON.stringify(groupImages)}` : groupAvatar ? 'group-marker' : resource(header?.querySelector('img')?.getAttribute('src')) : resource(header?.querySelector('img')?.getAttribute('src'));
  const nativeId = header?.getAttribute('data-conversation-id') || root?.getAttribute('data-conversation-id') || header?.getAttribute('data-conversation-short-id') || root?.getAttribute('data-conversation-short-id') || null;
  const own = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  const digest = async value => globalThis.crypto?.subtle ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('') : null;
  const identities = new Map(), types = new Set(), add = (family, value) => {
    if (typeof value !== 'string' && !Number.isSafeInteger(value)) return;
    const id = String(value).trim(); if (!id || id.length > 512) return;
    const values = identities.get(family) ?? new Set(); values.add(id); identities.set(family, values);
  };
  // 只读取当前可见会话头部已核实的固定 props 路径，不执行 getter 或访问消息对象。
  const keys = header ? Object.getOwnPropertyNames(header).filter(key => key.startsWith('__reactProps$')) : [];
  const props = keys.length === 1 ? own(header, keys[0]) : null, children = own(props, 'children');
  const conversation = own(own(Array.isArray(children) ? own(children, '0') : children, 'props'), 'conversation');
  for (const [family, fields] of [['conversation', ['conversationId', 'id']], ['conversation-short', ['conversationShortId', 'shortId']], ['group', ['groupId']], ['user', ['secUid', '_toParticipantSecUserId']], ['user-id', ['userId']]]) for (const field of fields) add(family, own(conversation, field));
  for (const field of ['conversationType', 'type']) { const type = own(conversation, field); if (typeof type === 'string' && ['direct', 'single', 'personal', 'group'].includes(type.toLowerCase())) types.add(type.toLowerCase() === 'group' ? 'group' : 'direct'); }
  let profileUrl = null;
  for (const link of header?.querySelectorAll('a[href]') ?? []) {
    try { const url = new URL(link.getAttribute('href'), location.href); if (url.protocol === 'https:' && url.hostname === 'www.douyin.com' && /^\/user\/[^/?#]+\/?$/.test(url.pathname)) { if (profileUrl && profileUrl !== url.origin + url.pathname) types.add('conflict'); profileUrl = url.origin + url.pathname; } } catch {}
  }
  for (const declared of [header?.getAttribute('data-conversation-type'), root?.getAttribute('data-conversation-type')]) if (declared && ['direct', 'single', 'personal', 'group'].includes(declared)) types.add(declared === 'group' ? 'group' : 'direct');
  if (isGroup) types.add('group');
  else if (profileUrl || identities.has('user') || identities.has('user-id') || header?.getAttribute('data-is-group') === 'false') types.add('direct');
  const conversationType = types.size === 1 ? [...types][0] : 'unknown';
  const conflictingNativeIds = new Set([header?.getAttribute('data-conversation-id'), root?.getAttribute('data-conversation-id'), header?.getAttribute('data-conversation-short-id'), root?.getAttribute('data-conversation-short-id')].filter(Boolean));
  let identityConflict = keys.length > 1 || types.size > 1 || conflictingNativeIds.size > 1 || [...identities.values()].some(values => values.size !== 1);
  const selected = [...identities].find(([family]) => ['conversation', 'conversation-short', 'group'].includes(family)) ?? [...identities].find(([family]) => family === 'user') ?? [...identities][0];
  const metadataSignature = () => JSON.stringify(['conversationId', 'id', 'conversationShortId', 'shortId', 'groupId', 'secUid', '_toParticipantSecUserId', 'userId', 'conversationType', 'type'].map(key => { const value = own(conversation, key); return typeof value === 'string' || Number.isSafeInteger(value) ? String(value) : null; }));
  const domMetadataSignature = () => JSON.stringify([header, root].map(element => element ? ['data-e2e', 'data-conversation-id', 'data-conversation-short-id', 'data-conversation-type', 'data-is-group'].map(key => element.getAttribute(key)) : null).concat(Boolean(header?.querySelector('[class*="GroupAvatar"],[data-e2e="group-avatar"]'))));
  const initialMetadata = metadataSignature(), initialDomMetadata = domMetadataSignature();
  const fingerprint = selected && !identityConflict ? await digest([...selected[1]][0]) : null;
  const currentProps = keys.length === 1 ? own(header, keys[0]) : null;
  const currentChildren = own(currentProps, 'children'), currentConversation = own(own(Array.isArray(currentChildren) ? own(currentChildren, '0') : currentChildren, 'props'), 'conversation');
  const currentHeaders = [...document.querySelectorAll('[data-e2e="im-dialog"] [class*="StackLayoutStackChatHeaderuser"],[data-e2e="im-dialog"] [data-e2e="chat-header"],[data-e2e="im-dialog"] [data-e2e="group-chat-header"]')].filter(visible);
  if (!header?.isConnected || currentHeaders.length !== 1 || currentHeaders[0] !== header || currentProps !== props || currentConversation !== conversation || metadataSignature() !== initialMetadata || domMetadataSignature() !== initialDomMetadata) identityConflict = true;
  const identityKey = fingerprint && (conversationType !== 'group' || ['conversation', 'conversation-short', 'group'].includes(selected[0])) ? `${selected[0]}:${fingerprint}` : null;
  const rect = header?.getBoundingClientRect();
  return { displayName: header?.querySelector('[class*="StackLayoutStackChatHeadertitle"],[data-e2e="chat-title"],[data-e2e="group-chat-title"]')?.textContent.replace(/\s+/g, ' ').trim(), avatar, nativeId, identityKey, profileUrl, identityConflict, isGroup: conversationType === 'group' ? true : conversationType === 'direct' ? false : null, conversationType,
    identityUnavailable: !header || identityConflict || !(nativeId || identityKey || profileUrl) || conversationType === 'unknown', headerCount: headers.length,
    geometry: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null };
}

export class ChatBrowser {
  constructor({ source = 'api-chat', controller, voiceCaptureDir = resolveRuntimePaths().mediaCaptureDir, fetchImpl = voiceAudioResponse } = {}) {
    if (!['api-chat', 'dsh-chat'].includes(source)) throw new TypeError('私信入口须为 api-chat 或 dsh-chat。');
    if (!path.isAbsolute(voiceCaptureDir)) throw new TypeError('消息音频临时目录须为绝对路径。');
    this.controller = controller ?? new BrowserController({ source });
    this.contacts = new Map();
    this.following = null;
    this.relationshipDiscovery = { status: 'unverified', code: 'FOLLOWING_NOT_CHECKED', reason: '尚未核对本人的关注关系。' };
    this.identities = new MessageIdentityTracker();
    this.mediaResources = new Map();
    this.voiceCaptureDir = path.resolve(voiceCaptureDir); this.voiceCaptures = new Map(); this.fetchImpl = fetchImpl;
    this.incomingBinding = `__deepseekIncoming_${randomUUID().replaceAll('-', '')}`;
    this.incomingPages = new WeakSet(); this.incomingHandlers = new Map(); this.incomingCleanup = new Set();
  }
  async subscribeIncoming(callback, { recipientIds = [], signal } = {}) {
    if (typeof callback !== 'function' || !Array.isArray(recipientIds) || recipientIds.length < 1 || recipientIds.some(id => typeof id !== 'string' || !/^conv:[a-f0-9]{64}$/.test(id))) throw new TypeError('消息唤醒需要已许可会话列表和回调。');
    stop(signal);
    const token = randomUUID(); let page, active = true;
    const cleanup = async () => {
      if (!active) return; active = false;
      signal?.removeEventListener('abort', aborted);
      this.incomingHandlers.delete(token); this.incomingCleanup.delete(cleanup);
      if (page && !page.isClosed()) await page.evaluate(current => { const entry = window.__deepseekIncomingObservers?.[current]; entry?.observer.disconnect(); clearTimeout(entry?.timer); if (window.__deepseekIncomingObservers) delete window.__deepseekIncomingObservers[current]; }, token).catch(() => {});
    };
    const aborted = () => { void cleanup(); };
    this.incomingCleanup.add(cleanup);
    const recipients = new Set(recipientIds);
    this.incomingHandlers.set(token, recipientId => { if (active && !signal?.aborted && recipients.has(recipientId)) { try { Promise.resolve(callback({ type: 'wake', recipientId })).catch(() => {}); } catch {} } });
    try {
      await this.controller.withPage(async current => {
        page = current;
        const flags = await this.dialog(page, signal);
        if (flags.blocked) throw new Error('消息通知需要本人先完成登录或验证。');
        if (!this.incomingPages.has(page)) {
          await page.exposeBinding(this.incomingBinding, (source, id, recipientId) => { if (source.page === page && typeof id === 'string') this.incomingHandlers.get(id)?.(recipientId); });
          this.incomingPages.add(page);
        }
        await page.evaluate(({ currentToken, binding, allowedIds }) => {
          const entries = window.__deepseekIncomingObservers ??= Object.create(null);
          const entry = { observer: null, timer: null }, allowed = new Set(allowedIds), previous = new Map();
          const unreadCounts = () => {
            const counts = new Map();
            for (const row of document.querySelectorAll('[data-e2e="im-dialog"] [data-e2e="conversation-item"][data-deepseek-chat-id]')) {
              const id = row.getAttribute('data-deepseek-chat-id'); if (!allowed.has(id)) continue;
              let count = 0;
              for (const badge of row.querySelectorAll('[class*="unread"],[class*="Unread"],[data-e2e="unread-count"]')) {
                const style = getComputedStyle(badge); if (style.display === 'none' || style.visibility === 'hidden') continue;
                const numericBadge = badge.matches('[data-e2e="unread-count"],[class*="unread-count"],[class*="unreadCount"],[class*="UnreadCount"],[class*="unreadBadge"],[class*="UnreadBadge"]');
                const raw = badge.getAttribute('data-unread-count') || badge.getAttribute('data-count') || badge.getAttribute('aria-label') || (numericBadge ? badge.textContent : '') || '';
                const match = /^\s*(\d+)\+?(?:\s*条未读(?:消息)?)?\s*$/.exec(raw);
                count = Math.max(count, match ? Number(match[1]) : 1);
              }
              if (row.getAttribute('data-unread') === 'true') count = Math.max(count, 1);
              counts.set(id, count);
            }
            return counts;
          };
          const check = notify => {
            for (const [id, count] of unreadCounts()) { if (notify && previous.has(id) && count > previous.get(id) && entries[currentToken]) void window[binding]?.(currentToken, id).catch(() => {}); previous.set(id, count); }
          };
          check(false);
          entry.observer = new MutationObserver(records => {
            const relevant = records.some(record => { const element = record.target instanceof Element ? record.target : record.target?.parentElement; return element?.closest('[data-e2e="im-dialog"]') || record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && (node.matches('[data-e2e="im-dialog"]') || node.querySelector('[data-e2e="im-dialog"]'))); });
            if (!relevant) return;
            clearTimeout(entry.timer);
            entry.timer = setTimeout(() => check(true), 200);
          });
          // 只比较许可行的未读标记；选中样式、正文和输入框变化不会触发轮询。
          entry.observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'data-unread', 'data-unread-count', 'data-count', 'data-deepseek-chat-id', 'aria-label'] });
          entries[currentToken] = entry;
        }, { currentToken: token, binding: this.incomingBinding, allowedIds: recipientIds });
      }, { signal });
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) await cleanup();
      return cleanup;
    } catch (error) { await cleanup(); throw error; }
  }
  async dialog(page, signal) {
    stop(signal);
    await page.evaluate(() => {
      if (!window.__deepseekChatPauseVideo) {
        window.__deepseekChatPauseVideo = true;
        document.addEventListener('play', event => { if (event.target instanceof HTMLVideoElement) event.target.pause(); }, true);
      }
      for (const video of document.querySelectorAll('video')) video.pause();
    });
    const flags = await page.evaluate(readChatBlockers);
    if (flags.loginRequired || flags.verificationRequired) return { ...flags, blocked: true };
    if (!await page.locator('[data-e2e="im-dialog"]').isVisible().catch(() => false)) {
      const entry = page.locator('[data-e2e="im-entry"]');
      try { await entry.waitFor({ state: 'visible', timeout: 20_000 }); }
      catch { throw new Error('没有找到抖音消息入口。'); }
      await entry.click();
      await page.locator('[data-e2e="im-dialog"]').waitFor({ state: 'visible' });
    }
    stop(signal);
    return { ...flags, blocked: false };
  }
  async verifyFollowing(page, signal) {
    // 本人的关注名单仅在首次发现联系人时核对；后续新增联系人不会进入服务的固定白名单。
    this.following = [];
    this.relationshipDiscovery = { status: 'unavailable', code: 'FOLLOWING_LIST_UNAVAILABLE', reason: '当前抖音网页版未提供可读取的关注列表。关注关系未确认；已有个人会话需由本人核对并单独授权。' };
    try {
      await page.goto(HOME, { waitUntil: 'domcontentloaded' });
      const my = page.locator('a').filter({ has: page.locator('span').filter({ hasText: /^我的$/ }) });
      if (await my.count() !== 1) return;
      const target = new URL(await my.getAttribute('href'), HOME);
      if (target.protocol !== 'https:' || target.hostname !== 'www.douyin.com' || !/^\/user\/[^/?#]+\/?$/.test(target.pathname)) return;
      await page.goto(target.href, { waitUntil: 'domcontentloaded' });
      const flags = await page.evaluate(readChatBlockers);
      if (flags.loginRequired || flags.verificationRequired) { this.relationshipDiscovery = { status: 'blocked', code: 'FOLLOWING_REQUIRES_USER', reason: '关注关系核对需要本人完成登录或验证。' }; return; }
      const follow = page.locator('[data-e2e="user-info-follow"]').filter({ visible: true });
      if (await follow.count() !== 1) return;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        stop(signal);
        await follow.click({ timeout: 1800 });
        await page.waitForFunction(() => [...document.querySelectorAll('[data-e2e="user-fans-container"],[data-e2e="following-list"],[data-e2e="follow-list"]')].some(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }), undefined, { timeout: 1800 }).catch(() => {});
        const rows = await page.evaluate(readFollowingDom);
        if (rows.length) { this.following = rows; this.relationshipDiscovery = { status: 'verified', code: 'FOLLOWING_LIST_READ', reason: '已读取当前页面提供的关注列表，逐联系人核对关系。' }; break; }
      }
    } catch (error) {
      stop(signal);
      if (page.isClosed()) throw error;
      const flags = await page.evaluate(readChatBlockers);
      if (flags.loginRequired || flags.verificationRequired) this.relationshipDiscovery = { status: 'blocked', code: 'FOLLOWING_REQUIRES_USER', reason: '关注关系核对需要本人完成登录或验证。' };
      else this.relationshipDiscovery = { status: 'unavailable', code: 'FOLLOWING_LIST_UNAVAILABLE', reason: '关注入口被遮挡或当前页面未提供可读取的列表。未确认关注关系；现有会话需由本人核对后单独授权。' };
    } finally {
      stop(signal);
      if (this.relationshipDiscovery.status !== 'blocked') { await page.goto(HOME, { waitUntil: 'domcontentloaded' }); await this.dialog(page, signal); }
    }
  }
  async contactList(page, signal, { enumerate = false, locateId } = {}) {
    const flags = await this.dialog(page, signal);
    if (flags.blocked) return { ...flags, contacts: [] };
    await page.locator('[data-e2e="im-dialog"] [data-e2e="conversation-item"]').first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
    const collected = new Map(), started = Date.now(); let visibleRows = [], scannedToEnd = false, reason = '', found = false;
    const capture = async () => {
      stop(signal); const rows = await page.evaluate(readContactDom), ids = rows.map(contactOpaqueId);
      if (new Set(ids).size !== ids.length || rows.some(row => !row.displayName || (!row.nativeId && !row.avatar))) throw new Error('联系人身份不完整或存在歧义，已停止读取会话。');
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index], id = ids[index], previous = collected.get(id);
        if (previous && JSON.stringify([previous.nativeId, previous.identityKey, previous.isGroup, previous.conversationType, previous.identityConflict]) !== JSON.stringify([row.nativeId, row.identityKey, row.isGroup, row.conversationType, row.identityConflict])) throw new Error('读取列表期间会话身份发生变化，未合并不一致的名单。');
        collected.set(id, row);
      }
      visibleRows = rows; found = Boolean(locateId && ids.includes(locateId)); return rows;
    };
    await capture();
    const origin = await page.evaluate(readConversationListDom);
    const scroll = async top => {
      stop(signal); const metrics = await page.evaluate(readConversationListDom);
      if (!metrics || origin && (metrics.selector !== origin.selector || metrics.index !== origin.index)) throw new Error('当前会话列表容器发生变化，已停止滚动读取。');
      await page.locator(metrics.selector).nth(metrics.index).evaluate((element, value) => { element.scrollTop = value; }, top);
      await page.waitForTimeout(150); stop(signal);
    };
    try {
      if (origin && (enumerate || locateId && !found)) {
        if (origin.scrollTop > 0) await scroll(0);
        let stableEnd = 0, previousEnd = '';
        while (Date.now() - started < 12_000) {
          await capture(); if (locateId && found) break;
          const metrics = await page.evaluate(readConversationListDom);
          if (!metrics) throw new Error('读取期间会话列表容器已消失。');
          const maximum = Math.max(0, metrics.scrollHeight - metrics.clientHeight), atEnd = metrics.scrollTop >= maximum - 1;
          if (atEnd && !metrics.loading) {
            const signature = JSON.stringify([metrics.scrollHeight, ...visibleRows.map(contactOpaqueId)]);
            stableEnd = previousEnd === signature ? stableEnd + 1 : 0; previousEnd = signature;
            if (stableEnd >= 2) { scannedToEnd = true; break; }
            await page.waitForTimeout(150); continue;
          }
          stableEnd = 0; previousEnd = '';
          if (metrics.loading && atEnd) { await page.waitForTimeout(150); continue; }
          const next = Math.min(maximum, metrics.scrollTop + Math.max(1, Math.floor(metrics.clientHeight * 0.8)));
          if (next <= metrics.scrollTop && !atEnd) { reason = '列表无法继续滚动，只返回已核对的当前会话。'; break; }
          await scroll(next);
        }
        if (!scannedToEnd && !(locateId && found) && !reason) reason = '本次读取已到时间预算，只返回已核对的当前会话；可以稍后重新读取。';
      } else if (!origin) reason = '当前页面没有唯一可遍历的会话列表容器，只读取已挂载会话。';
    } finally {
      if (origin && (enumerate || locateId && !found)) {
        const current = await page.evaluate(readConversationListDom).catch(() => null);
        if (current && Math.abs(current.scrollTop - origin.scrollTop) > 1) await scroll(origin.scrollTop);
        await capture();
      }
    }
    const rows = [...collected.values()];
    const identities = rows.map(contactOpaqueId);
    if (new Set(identities).size !== identities.length || rows.some(row => !row.displayName || (!contactIdentityKey(row) && !row.avatar))) throw new Error('联系人身份不完整或存在歧义，已停止读取会话。');
    const contacts = [];
    this.contacts.clear();
    for (const [index, row] of rows.entries()) {
      const id = identities[index];
      const matching = this.following?.filter(item => item.displayName === row.displayName && item.mutual) ?? [];
      const uniqueName = rows.filter(item => item.displayName === row.displayName).length === 1;
      const directRelationship = Boolean(row.conversationType !== 'group' && row.profileUrl && row.relationshipLabel && uniqueName);
      const followed = row.conversationType === 'direct' && uniqueName && (matching.length === 1 || directRelationship) ? true : null;
      const conversationType = row.conversationType;
      const identityBinding = contactIdentityBinding(row, rows), identityVerified = Boolean(identityBinding);
      const relationshipStatus = conversationType === 'group' ? 'unavailable' : followed ? 'verified' : this.relationshipDiscovery.status === 'unavailable' ? 'unavailable' : 'unverified';
      const contact = { id, displayName: row.displayName, name: row.displayName, unread: row.unread, followed, identityVerified, identityBinding, ...stableIdentityFields(row), identitySource: row.identitySource || (row.nativeId ? 'dom-conversation-id' : row.profileUrl ? 'public-profile-link' : null), relationshipStatus, isGroup: conversationType === 'group' ? true : conversationType === 'direct' ? false : null, conversationType,
        relationshipEvidence: followed ? { source: directRelationship ? 'conversation-profile-label' : 'self-follow-list', label: directRelationship ? row.relationshipLabel : '相互关注', matchedBy: directRelationship ? 'conversation-id-and-profile' : 'unique-display-name', accountIdCrossChecked: directRelationship } : null };
      this.contacts.set(id, { ...contact, avatar: row.avatar, nativeId: row.nativeId, identityKey: row.identityKey, profileUrl: row.profileUrl, identityConflict: row.identityConflict });
      contacts.push(contact);
    }
    const markMapping = visibleRows.map(row => ({ id: contactOpaqueId(row), displayName: row.displayName, nativeId: row.nativeId }));
    const markOnce = () => page.evaluate(mapping => {
      const nodes = [...document.querySelectorAll('[data-e2e="im-dialog"] [data-e2e="conversation-item"]')];
      if (nodes.length !== mapping.length) throw new Error('标记会话前虚拟列表窗口已经改变。');
      for (const [index, expected] of mapping.entries()) {
        const element = nodes[index], name = element.querySelector('.conversationConversationItemtitle,[data-e2e="conversation-name"]')?.textContent.replace(/\s+/g, ' ').trim();
        const native = element.getAttribute('data-conversation-id') || element.getAttribute('data-conversation-short-id') || null;
        if (name !== expected.displayName || native !== expected.nativeId) throw new Error('标记会话前列表身份已经改变。');
      }
      for (const [index, expected] of mapping.entries()) nodes[index].setAttribute('data-deepseek-chat-id', expected.id);
    }, markMapping);
    // 会话列表会自己重渲染（新消息进来自动上移），一次没对上就等一会儿再标，最多三次，三次都乱才报错。
    for (let attempt = 1; ; attempt += 1) {
      try { await markOnce(); break; }
      catch (error) {
        if (attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
    return { ...flags, contacts, relationshipDiscovery: this.relationshipDiscovery, listDiscovery: { source: 'current-conversation-list', scannedToEnd, count: contacts.length, note: `已读取当前消息列表的 ${contacts.length} 个会话；不代表全部关注好友或所有群聊。`, ...(reason ? { reason } : {}) } };
  }
  listContacts({ signal, verifyFollowing = this.following === null } = {}) {
    return this.controller.withPage(async page => {
      const initial = await this.dialog(page, signal);
      if (initial.blocked) return { ...initial, contacts: [] };
      if (verifyFollowing) await this.verifyFollowing(page, signal);
      if (this.relationshipDiscovery.status === 'blocked') return { blocked: true, contacts: [], relationshipDiscovery: this.relationshipDiscovery };
      return this.contactList(page, signal, { enumerate: true });
    }, { signal });
  }
  async select(page, recipientId, signal, { refresh = false } = {}) {
    if (typeof recipientId !== 'string' || !/^conv:[a-f0-9]{64}$/.test(recipientId)) throw new TypeError('需要已发现的精确联系人 ID。');
    const flags = await this.contactList(page, signal, { locateId: recipientId });
    if (flags.blocked) return { flags };
    const contact = this.contacts.get(recipientId);
    if (!contact || contact.conversationType === 'unknown') throw new Error('指定会话已变化或类型尚未核实，已停止操作。');
    const row = page.locator(`[data-e2e="conversation-item"][data-deepseek-chat-id="${recipientId}"]`);
    if (await row.count() !== 1) throw new Error('指定会话不是唯一匹配，已停止操作。');
    const current = await page.evaluate(readChatIdentityDom);
    if (refresh || !sameConversationIdentity(current, contact)) {
      const back = page.locator('[data-stack-layer="chat"] .StackLayoutStackTitleBarbackBtn');
      if (current.displayName && await back.count() === 1) {
        await back.click({ timeout: 5000 });
        await this.contactList(page, signal, { locateId: recipientId });
      }
      try { await row.click({ timeout: 5000 }); }
      catch { throw new Error('指定会话未成功打开，未读取正文或点击发送。'); }
    }
    let identity, previous, stableSamples = 0;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      stop(signal);
      const blockers = await page.evaluate(readChatBlockers);
      if (blockers.loginRequired || blockers.verificationRequired) return { flags: { ...flags, ...blockers, blocked: true } };
      identity = await page.evaluate(readChatIdentityDom);
      const geometryStable = previous && identity.geometry && ['x', 'y', 'width', 'height'].every(key => Math.abs(identity.geometry[key] - previous.geometry[key]) <= 0.5);
      stableSamples = sameConversationIdentity(identity, contact) ? geometryStable ? stableSamples + 1 : 1 : 0;
      if (stableSamples >= 3) break;
      previous = sameConversationIdentity(identity, contact) && identity.geometry ? identity : null;
      await page.waitForTimeout(150);
    }
    if (stableSamples < 3) throw new Error(identity?.identityUnavailable ? '当前会话缺少可核对的稳定身份信息，或切换动画尚未结束；未读取正文或发送。' : '当前会话的稳定身份或类型与许可联系人不一致，未读取正文或发送。');
    stop(signal);
    return { contact, flags };
  }
  async stableConversation(page, contact, signal) {
    let previous;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      stop(signal);
      const current = await page.evaluate(readConversationDom, expectedDomIdentity(contact));
      if (!sameConversationIdentity(current, contact)) throw new Error('读取前会话身份发生变化。');
      const signature = JSON.stringify(current.messages);
      if (!current.loading && previous === signature) return current;
      previous = current.loading ? undefined : signature;
      await page.waitForTimeout(150);
    }
    throw new Error('指定会话的消息列表仍在加载或变化，未确认正文快照。');
  }
  async verifyContactBinding(page, contact, expectedContact) {
    const rows = await page.evaluate(readContactDom), matching = rows.filter(row => contactOpaqueId(row) === contact.id);
    if (matching.length !== 1) throw new Error('许可会话的稳定身份已变化，未继续发送。');
    const row = matching[0], binding = contactIdentityBinding(row, rows);
    const current = { ...contact, name: row.displayName, displayName: row.displayName, nativeId: row.nativeId, identityKey: row.identityKey, profileUrl: row.profileUrl, isGroup: row.isGroup, conversationType: row.conversationType, identityVerified: Boolean(binding), identityBinding: binding, ...stableIdentityFields(row) };
    if (!sameConversationIdentity(row, contact) || contact.identityVerified && binding !== contact.identityBinding || expectedContact && !matchesAuthorizedContact(expectedContact, current)) throw new Error('许可会话的稳定身份、类型或身份绑定已变化，未继续发送。');
    return current;
  }
  publicMessages(recipientId, rawRows) {
    const rows = rawRows.map(row => {
      const { member, ...rest } = row;
      const base = member ? { ...rest, memberId: member.nativeId ? `member:${hash(`${recipientId}\0${member.nativeId}`)}` : null, memberName: member.name || null, mentionedSelf: row.mentionedSelf === true } : rest;
      if (!row.media) return base;
      const { images = [], audioSources = [], ...media } = row.media;
      const resources = [...images, ...audioSources].filter(image => image.src).map(image => {
        const ref = `media:${hash(image.src.startsWith('data:') ? image.src : (() => { try { return new URL(image.src).pathname; } catch { return image.src; } })())}`;
        this.mediaResources.set(ref, { src: image.src, label: image.label ?? null, recipientId, type: media.type });
        return { resourceRef: ref, label: image.label ?? null };
      });
      return { ...base, media: { ...media, ...(media.type === 'voice' ? { sourceCount: resources.length } : { imageCount: resources.length }), resources } };
    });
    const identified = this.identities.identify(recipientId, rows);
    return identified.map(row => row.media?.type === 'shared-work' ? { ...row, media: { ...row.media,
      safeOpenSelector: `[data-deepseek-message-id="${row.id}"] .MessageItemShareAwemecontainer` } } : row);
  }
  async markMessages(page, messages) {
    await page.evaluate(mapping => {
      const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
      const header = [...document.querySelectorAll('[data-e2e="im-dialog"] [class*="StackLayoutStackChatHeaderuser"],[data-e2e="im-dialog"] [data-e2e="chat-header"],[data-e2e="im-dialog"] [data-e2e="group-chat-header"]')].filter(visible);
      const root = header.length === 1 ? header[0].closest('[class*="StackLayoutpagespageRoot"],[data-e2e="chat-page"]') : null;
      const selector = '[data-e2e="msg-item-content"],[data-e2e="message-content"],[data-testid="message-content"]';
      const nodes = [...(root?.querySelectorAll(selector) ?? [])].filter(node => !node.parentElement?.closest(selector));
      if (nodes.length !== mapping.length || new Set(mapping.map(item => item.domPosition)).size !== nodes.length) throw new Error('消息窗口已经改变。');
      for (const item of mapping) {
        if (!Number.isSafeInteger(item.domPosition) || item.domPosition < 0 || item.domPosition >= nodes.length) throw new Error('消息 DOM 位置不可核对。');
        nodes[item.domPosition].setAttribute('data-deepseek-message-id', item.id);
      }
    }, messages.map((message, index) => ({ id: message.id, domPosition: message.domPosition ?? index })));
  }
  readConversation(recipientId, { allowed = false, signal, refresh = false } = {}) {
    if (allowed !== true) return Promise.reject(new Error('读取正文需要这个指定联系人的明确授权。'));
    return this.controller.withPage(async page => {
      const { contact, flags } = await this.select(page, recipientId, signal, { refresh });
      if (flags.blocked) return { ...flags, conversation: null, contact: null, messages: [] };
      const raw = await this.stableConversation(page, contact, signal);
      if (!sameConversationIdentity(raw, contact)) throw new Error('读取前会话身份发生变化。');
      const { avatar, nativeId: _nativeId, identityKey: _identityKey, profileUrl: _profileUrl, identityConflict: _identityConflict, ...publicContact } = contact;
      const messages = this.publicMessages(recipientId, raw.messages);
      await this.markMessages(page, messages);
      return { ...flags, conversation: { id: contact.id, displayName: contact.displayName, isGroup: contact.isGroup, conversationType: contact.conversationType }, contact: publicContact,
        messages, dayEvidence: { observedAt: raw.observedAt, latestEndVerified: raw.latestEndVerified, chronology: raw.chronology, historyStartVerified: raw.historyStartVerified, emptyTodayVerified: raw.emptyTodayVerified } };
    }, { signal });
  }
  captureMessage(recipientId, messageId, { allowed = false, signal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('查看画面需要这个指定联系人的明确授权。'));
    if (typeof messageId !== 'string' || !/^msg:[a-f0-9]{64}$/.test(messageId)) return Promise.reject(new TypeError('需要已读取的精确消息 ID。'));
    return this.controller.withPage(async page => {
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, frames: [], imageStatus: '登录或验证画面未采集。' };
      const raw = await this.stableConversation(page, contact, signal);
      const messages = this.publicMessages(recipientId, raw.messages);
      const message = messages.find(item => item.id === messageId);
      if (!message?.media || message.unsupported || !['emoji', 'image', 'shared-work'].includes(message.media.type)) throw new Error('该消息没有已识别的图片、表情或分享作品画面。');
      if (message.media.type === 'image' && message.media.imageReady !== true) throw new Error('这条图片仍在加载或未提供实际图像，未把占位符当作图片。');
      await this.markMessages(page, messages);
      const frame = page.locator(`[data-e2e="im-dialog"] [data-deepseek-message-id="${messageId}"]`).locator(message.media.inline ? '[class*="MessageItemTextcontainer"],[data-e2e="message-text"]' : '.MessageItemEmojiemojiBox,.MessageItemShareAwemecontainer,[class*="MessageItemImagecontainer"],[class*="MessageItemImageimageBox"],[class*="MessageItemImageImageBox"],[data-e2e="message-image"],[data-e2e="message-emoji"],[data-e2e="shared-video-card"]');
      if (await frame.count() !== 1) throw new Error('没有唯一的指定消息画面。');
      const current = await page.evaluate(readChatIdentityDom);
      const protectedScreen = await page.evaluate(readChatBlockers);
      if (protectedScreen.loginRequired || protectedScreen.verificationRequired) return { ...protectedScreen, frames: [], imageStatus: '登录或验证画面未采集。' };
      if (!sameConversationIdentity(current, contact)) throw new Error('截取画面前会话身份发生变化。');
      stop(signal);
      const rectangle=await frame.boundingBox();
      const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
      if(!rectangle) throw new Error('指定消息画面目前不可见，未采集。');
      const clip={x:Math.max(0,rectangle.x),y:Math.max(0,rectangle.y),width:Math.min(viewport.width,rectangle.x+rectangle.width)-Math.max(0,rectangle.x),height:Math.min(viewport.height,rectangle.y+rectangle.height)-Math.max(0,rectangle.y)};
      if(clip.width<2||clip.height<2) throw new Error('指定消息不在当前视口内，未采集其他区域。');
      const unobstructed=await frame.evaluate(element=>{const r=element.getBoundingClientRect(),x=Math.max(1,Math.min(innerWidth-1,r.x+r.width/2)),y=Math.max(1,Math.min(innerHeight-1,r.y+r.height/2));return element.contains(document.elementFromPoint(x,y));});
      if(!unobstructed) throw new Error('指定消息被其他界面遮挡，未采集。');
      // 倒转的虚拟列表不能依赖 locator 的自动滚动稳定等待；只截取当前消息的可见矩形。
      const data = await page.screenshot({ type:'jpeg',quality:70,clip,timeout:5000 });
      const afterRectangle=await frame.boundingBox();
      if(!afterRectangle||['x','y','width','height'].some(key=>Math.abs(afterRectangle[key]-rectangle[key])>1)) throw new Error('截图期间指定消息位置改变，画面已丢弃。');
      const afterIdentity=await page.evaluate(readChatIdentityDom);
      const afterProtection=await page.evaluate(readChatBlockers);
      if(afterProtection.loginRequired||afterProtection.verificationRequired) return {...afterProtection,frames:[],imageStatus:'截图期间出现登录或验证，本次画面已丢弃。'};
      if(!sameConversationIdentity(afterIdentity,contact)) throw new Error('截图期间会话身份发生变化，画面已丢弃。');
      const afterRaw=await this.stableConversation(page,contact,signal);
      const afterMessages=this.publicMessages(recipientId,afterRaw.messages);
      const afterMessage=afterMessages.find(item=>item.id===messageId);
      const mediaIdentity=value=>JSON.stringify([value?.sender,value?.kind,value?.text,value?.media?.type,value?.media?.resources,value?.media?.label,value?.media?.title,value?.media?.videoId]);
      if(!afterMessage || mediaIdentity(afterMessage)!==mediaIdentity(message)) throw new Error('截图期间指定消息发生变化，画面已丢弃。');
      return { ...flags, conversation: { id: recipientId, displayName: contact.displayName }, messageId,
        media: message.media, understandingScope: message.media.understandingScope,
        frames: [{ mimeType: 'image/jpeg', data: data.toString('base64') }], imageStatus: '已采集指定消息的实际画面，尚需支持图像的模型读取。' };
    }, { signal });
  }
  captureVoiceMessage(recipientId, messageId, { allowed = false, signal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('读取语音需要这个指定联系人的明确授权。'));
    if (typeof messageId !== 'string' || !/^msg:[a-f0-9]{64}$/.test(messageId)) return Promise.reject(new TypeError('需要已读取的精确消息 ID。'));
    return this.controller.withPage(async page => {
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) throw new Error('登录或验证尚未完成，未读取语音。');
      await this.verifyContactBinding(page, contact);
      const raw = await this.stableConversation(page, contact, signal), messages = this.publicMessages(recipientId, raw.messages);
      const message = messages.find(item => item.id === messageId), seconds = message?.media?.durationSeconds;
      if (message?.media?.type !== 'voice' || message.unsupported || !Number.isFinite(seconds) || seconds <= 0 || seconds > 120 || message.media.resources.length !== 1) throw new Error('该语音缺少唯一资源或可靠时长，或超过 120 秒，未采集。');
      const source = this.mediaResources.get(message.media.resources[0].resourceRef);
      if (!source || source.recipientId !== recipientId || source.type !== 'voice' || !allowedAudioUrl(source.src)) throw new Error('指定语音没有可核对的平台 HTTPS 资源，未采集。');
      stop(signal);
      const timeout = AbortSignal.timeout(20_000), bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let bytes;
      try {
        const response = await this.fetchImpl(source.src, { redirect: 'error', credentials: 'omit', signal: bounded });
        if (!response?.ok || response.redirected || !response.body || response.url && response.url !== source.src) throw new Error();
        const advertised = response.headers.get('content-length');
        if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > AUDIO_LIMIT)) { await response.body.cancel(); throw new Error(); }
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
          for (;;) {
            bounded.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength; if (size > AUDIO_LIMIT) { await reader.cancel(); throw new Error(); } chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        bytes = Buffer.concat(chunks, size);
      } catch { stop(signal); throw new Error('指定语音下载失败、超时或超过 25 MiB，未采集其他资源。'); }
      stop(signal);
      const format = chatAudioFormat(bytes);
      if (!format) throw new Error('指定资源没有可识别的音频文件头，未交给转写。');
      await this.verifyContactBinding(page, contact);
      const protectedScreen = await page.evaluate(readChatBlockers);
      if (protectedScreen.loginRequired || protectedScreen.verificationRequired) throw new Error('读取语音期间出现登录或验证，数据已丢弃。');
      const after = this.publicMessages(recipientId, (await this.stableConversation(page, contact, signal)).messages).find(item => item.id === messageId);
      if (!after || messageFingerprint(after) !== messageFingerprint(message)) throw new Error('读取语音期间指定消息发生变化，数据已丢弃。');
      fs.mkdirSync(this.voiceCaptureDir, { recursive: true });
      const directory = fs.mkdtempSync(path.join(this.voiceCaptureDir, 'chat-voice-'));
      const target = path.join(directory, `audio.${format.extension}`), captureId = `voice:${hash(`${recipientId}\0${messageId}\0${randomUUID()}`)}`;
      try { fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }); stop(signal); }
      catch (error) { try { fs.unlinkSync(target); } catch {} try { fs.rmdirSync(directory); } catch {} throw error; }
      this.voiceCaptures.set(captureId, { target, directory });
      return { conversation: { id: recipientId }, messageId, captureId, media: { type: 'voice', durationSeconds: seconds }, understandingScope: 'single-message-audio', interval: { scope: 'single-message-audio', startSeconds: 0, durationSeconds: seconds }, audio: { path: target, mimeType: format.mimeType, bytes: bytes.length } };
    }, { signal });
  }
  async releaseVoiceCapture(captureId) {
    const capture = this.voiceCaptures.get(captureId); if (!capture) return false;
    try { fs.unlinkSync(capture.target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { fs.rmdirSync(capture.directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.voiceCaptures.delete(captureId);
    return true;
  }
  openSharedVideo(recipientId, messageId, { allowed = false, signal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('打开分享作品需要这个指定联系人的明确授权。'));
    if (typeof messageId !== 'string' || !/^msg:[a-f0-9]{64}$/.test(messageId)) return Promise.reject(new TypeError('需要已读取的精确消息 ID。'));
    return this.controller.withPage(async page => {
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, opened: false };
      const raw = await this.stableConversation(page, contact, signal);
      const messages = this.publicMessages(recipientId, raw.messages);
      const message = messages.find(item => item.id === messageId);
      if (message?.media?.type !== 'shared-work') throw new Error('该消息不是已识别的分享作品卡片。');
      if (message.media.url) return { ...flags, opened: false, videoId: message.media.videoId, url: message.media.url, source: 'dom-link' };
      await this.markMessages(page, messages);
      const card = page.locator(`[data-e2e="im-dialog"] ${message.media.safeOpenSelector}`);
      if (await card.count() !== 1) throw new Error('没有唯一的指定分享卡片。');
      const beforeUrl = new URL(page.url());
      const beforeId = /^\/video\/(\d+)\/?$/.exec(beforeUrl.pathname)?.[1] || beforeUrl.searchParams.get('modal_id') || null;
      const pop = page.waitForEvent('popup', { timeout: 2500 }).catch(() => null);
      stop(signal);
      const parentSource = this.controller.source?.startsWith('dsh') ? 'dsh' : 'api';
      const decision = this.controller.limits().beforeAction(parentSource, 'douyin_open_video');
      if (!decision.allowed) throw new Error(decision.reason || '当前时间不允许打开分享作品。');
      let popup, target = page;
      try {
        await card.click();
        popup = await pop;
        target = popup ?? page;
        if (popup) await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await target.waitForFunction(({ beforeId, newPopup }) => {
          const observed = new URL(location.href);
          const id = /^\/video\/(\d+)\/?$/.exec(observed.pathname)?.[1] || observed.searchParams.get('modal_id');
          return /^\d+$/.test(id || '') && (newPopup || id !== beforeId);
        }, { beforeId, newPopup: Boolean(popup) }, { timeout: 5000 }).catch(() => {});
        const observed = new URL(target.url());
        const id = /^\/video\/(\d+)\/?$/.exec(observed.pathname)?.[1] || observed.searchParams.get('modal_id');
        if (observed.protocol !== 'https:' || !/^(?:www\.)?douyin\.com$/.test(observed.hostname) || !/^\d+$/.test(id || '')) return { ...flags, opened: true, videoId: null, url: null, reason: '实际打开页面没有可核实的公开作品 ID。' };
        if (!popup && id === beforeId) return { ...flags, opened: true, videoId: null, url: null, reason: '点击后没有核实新的作品页面，未采用原详情页的作品 ID。' };
        return { ...flags, opened: true, videoId: id, url: `https://www.douyin.com/video/${id}`, source: 'actual-opened-page-url', isPhotoGallery: message.media.isPhotoGallery };
      } finally {
        if (!popup) { popup = await pop; if (popup) target = popup; }
        await target.evaluate(() => { for (const video of document.querySelectorAll('video')) video.pause(); }).catch(() => {});
        if (popup) await popup.close().catch(() => {});
      }
    }, { signal });
  }
  sendMessage(recipientId, message, { allowed = false, expectedContact, expectedMessageIds, expectedMessageContent, signal: parentSignal, authorize } = {}) {
    if (allowed !== true) return Promise.reject(new Error('发送需要这个指定联系人的明确授权。'));
    if (typeof message !== 'string' || !message.trim() || [...message].length > 1000) return Promise.reject(new TypeError('发送内容须为 1 到 1000 字的非空文字。'));
    if (authorize !== undefined && (typeof authorize !== 'function' || typeof authorize.beginDispatch !== 'function')) return Promise.reject(new TypeError('主动问候需要本机许可检查和最终短输入控制。'));
    const interrupt = new AbortController(), signal = AbortSignal.any([interrupt.signal, ...(parentSignal ? [parentSignal] : [])]);
    const authorized = async phase => { stop(signal); if (authorize && await authorize({ phase, recipientId }) !== true) throw new Error('主动问候许可已撤回，未继续发送。'); stop(signal); };
    return this.controller.withPage(async page => {
      await authorized('prepare');
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, confirmed: false, deliveryUncertain: false };
      await this.verifyContactBinding(page, contact, expectedContact);
      const before = await page.evaluate(readConversationDom, expectedDomIdentity(contact));
      if (!sameConversationIdentity(before, contact) || before.identityUnavailable) throw new Error('填写回复前会话的稳定身份已变化，未填写或发送。');
      const initialMessages = this.publicMessages(recipientId, before.messages);
      const expected = expectedMessageIds ?? initialMessages.map(item => item.id);
      const contentOf = messages => messages.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) }));
      const expectedContent = expectedMessageContent ?? contentOf(initialMessages);
      if (!Array.isArray(expected) || expected.some(id => typeof id !== 'string') || initialMessages.some(item => item.direction === 'unknown') || JSON.stringify(initialMessages.map(item => item.id)) !== JSON.stringify(expected)
        || !Array.isArray(expectedContent) || expectedContent.some(item => !item || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.fingerprint ?? '')) || JSON.stringify(contentOf(initialMessages)) !== JSON.stringify(expectedContent)) return { confirmed: false, deliveryUncertain: false, reason: '私信水位或内容已变化，未填写或发送回复。' };
      let guardDiagnostic;
      const sameWatermark = (messages, raw) => {
        const known = new Map(expectedContent.map(item => [item.id, item.fingerprint])), actual = contentOf(messages), anchor = expected.at(-1), anchorIndex = messages.findIndex(item => item.id === anchor);
        const diagnostic = { expectedCount: expected.length, currentCount: messages.length, expectedLatestEndVerified: initialMessages.length > 0 && initialMessages.every(item => item.latestEndVerified === true), currentLatestEndVerified: messages.length > 0 && messages.every(item => item.latestEndVerified === true), chronology: raw?.chronology || 'unknown', suffixOffset: messages.length <= expected.length ? expected.length - messages.length : null,
          latestAnchorPresent: anchorIndex >= 0, latestAnchorAtEnd: anchorIndex >= 0 && anchorIndex === messages.length - 1, latestAnchorFingerprintMatches: anchorIndex >= 0 && actual[anchorIndex].fingerprint === known.get(anchor), allOverlapContentMatches: actual.filter(item => known.has(item.id)).every(item => item.fingerprint === known.get(item.id)), unknownDirectionCount: messages.filter(item => item.direction === 'unknown').length,
          additionalCount: messages.filter(item => !known.has(item.id)).length, additionalClassifications: Object.fromEntries(['old-history', 'known-old-window', 'new-tail', 'ambiguous-new', 'baseline'].map(kind => [kind, messages.filter(item => !known.has(item.id) && item.arrivalClassification === kind).length])) };
        guardDiagnostic = diagnostic;
        if (messages.some(item => item.direction === 'unknown')) return false;
        if (JSON.stringify(messages.map(item => item.id)) === JSON.stringify(expected)) return JSON.stringify(contentOf(messages)) === JSON.stringify(expectedContent);
        // 输入框扩高和trial滚动可移除或补载旧前缀；原最新端和完整重叠后缀必须保持。
        if (!messages.length || before.chronology !== 'oldest-first' || raw?.chronology !== 'oldest-first' || !initialMessages.every(item => item.latestEndVerified === true) || !messages.every(item => item.latestEndVerified === true) || !diagnostic.latestAnchorAtEnd || !diagnostic.latestAnchorFingerprintMatches) return false;
        const firstOverlap = messages.findIndex(item => known.has(item.id)), expectedOffset = expected.indexOf(messages[firstOverlap]?.id);
        if (firstOverlap < 0 || expectedOffset < 0) return false;
        const overlap = messages.slice(firstOverlap), prefix = messages.slice(0, firstOverlap);
        diagnostic.suffixOffset = expectedOffset; diagnostic.additionalPrefixCount = prefix.length;
        return JSON.stringify(overlap.map(item => item.id)) === JSON.stringify(expected.slice(expectedOffset)) && JSON.stringify(contentOf(overlap)) === JSON.stringify(expectedContent.slice(expectedOffset))
          && prefix.every(item => !known.has(item.id) && ['old-history', 'known-old-window'].includes(item.arrivalClassification) && item.eligibleForReply !== true);
      };
      const receipt = { conversation: { id: contact.id, displayName: contact.displayName }, contact: { id: contact.id, name: contact.displayName } };
      const editor = page.locator('[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"]');
      if (await editor.count() !== 1) throw new Error('没有唯一的私信文字输入框。');
      if (readableDraft(await editor.innerText()) || await editor.locator('img,video,audio,[data-slate-void="true"]').count()) throw new Error('当前会话已有草稿，已停止发送以保留原内容。');
      let clicked = false, monitoring = false, monitor, polling, releaseDispatch, failureStage = 'fill', precheckFailureCode;
      const witnessId = `chat-${hash(`${recipientId}:${Date.now()}:${Math.random()}`)}`;
      try {
        await editor.fill(message);
        stop(signal);
        failureStage = 'identity';
        const ready = await page.evaluate(readConversationDom, expectedDomIdentity(contact));
        if (!sameConversationIdentity(ready, contact) || readableDraft(await editor.innerText()) !== readableDraft(message)) throw new Error('发送前身份或输入文字回读不一致。');
        await this.verifyContactBinding(page, contact, expectedContact);
        failureStage = 'watermark';
        const readyMessages = this.publicMessages(recipientId, ready.messages);
        if (!sameWatermark(readyMessages, ready)) throw new Error('填写回复期间私信水位或内容发生变化，未点击发送。');
        const escaped = contact.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        failureStage = 'button';
        const targetPage = page.locator('[class*="StackLayoutpagespageRoot"],[data-e2e="chat-page"]').filter({ has: page.locator('[class*="StackLayoutStackChatHeadertitle"],[data-e2e="chat-title"],[data-e2e="group-chat-title"]').filter({ hasText: new RegExp(`^${escaped}$`) }) });
        const send = targetPage.locator('.e2e-send-msg-btn,[data-e2e="send-msg-btn"]');
        if (await send.count() !== 1) throw new Error('没有唯一的指定会话发送按钮。');
        await send.evaluate((button, token) => {
          const entries = window.__deepseekChatInputs ??= Object.create(null), entry = { dispatched: false };
          button.setAttribute('data-deepseek-send-token', token);
          const witness = event => { if (event.isTrusted && (event.target === button || button.contains(event.target))) entry.dispatched = true; };
          document.addEventListener('click', witness, true);
          entry.cleanup = () => { document.removeEventListener('click', witness, true); if (button.getAttribute('data-deepseek-send-token') === token) button.removeAttribute('data-deepseek-send-token'); }; entries[token] = entry;
        }, witnessId);
        const inputDispatched = () => page.evaluate(token => window.__deepseekChatInputs?.[token]?.dispatched === true, witnessId);
        const readSendPoint = async () => {
          if (await send.count() !== 1 || !await send.isVisible() || !await send.isEnabled()) return null;
          return send.evaluate((button, token) => {
            if (button.getAttribute('data-deepseek-send-token') !== token || button.closest('[disabled],[aria-disabled="true"]')) return null;
            const r = button.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
            if (r.width < 2 || r.height < 2 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
            const hit = document.elementFromPoint(x, y);
            if (!hit || hit !== button && !button.contains(hit)) return null;
            return { x: r.x, y: r.y, width: r.width, height: r.height, clickX: x, clickY: y };
          }, witnessId);
        };
        const sameGeometry = (left, right) => left && right && ['x', 'y', 'width', 'height'].every(key => Math.abs(left[key] - right[key]) <= 0.5);
        const checkPendingInput = async () => {
          if (clicked && await inputDispatched()) return;
          await authorized('monitor');
          if (await editor.count() !== 1 || await send.count() !== 1 || readableDraft(await editor.innerText()) !== readableDraft(message)) throw new Error('等待期间发送按钮或草稿发生变化，未发送。');
          const current = await page.evaluate(readConversationDom, expectedDomIdentity(contact)), blockers = await page.evaluate(readChatBlockers);
          if (clicked && await inputDispatched()) return;
          if (blockers.loginRequired || blockers.verificationRequired || !sameConversationIdentity(current, contact)) throw new Error('等待期间会话身份或页面许可发生变化，未发送。');
          await this.verifyContactBinding(page, contact, expectedContact);
          const messages = this.publicMessages(recipientId, current.messages);
          if (!sameWatermark(messages, current)) throw new Error('等待期间收到新消息或消息内容变化，未发送。');
          stop(signal);
        };
        monitoring = true;
        monitor = setInterval(() => { if (polling || !monitoring) return; polling = checkPendingInput().catch(async error => { if (monitoring && !await inputDispatched().catch(() => false)) { precheckFailureCode = { '等待期间发送按钮或草稿发生变化，未发送。': 'CHAT_DRAFT_OR_BUTTON_CHANGED_DURING_WAIT', '等待期间会话身份或页面许可发生变化，未发送。': 'CHAT_IDENTITY_CHANGED_DURING_WAIT', '等待期间收到新消息或消息内容变化，未发送。': 'CHAT_WATERMARK_CHANGED_DURING_WAIT' }[error.message] || 'CHAT_AUTHORIZATION_CHECK_FAILED_DURING_WAIT'; interrupt.abort(error); } }).finally(() => { polling = null; }); }, 40);
        await checkPendingInput();
        failureStage = 'trial';
        await send.evaluate(button => button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }));
        let stablePoint, previousPoint, stableSamples = 0;
        const geometryDeadline = Date.now() + 3000;
        while (Date.now() < geometryDeadline) {
          stop(signal); await checkPendingInput();
          const point = await readSendPoint();
          stableSamples = sameGeometry(point, previousPoint) ? stableSamples + 1 : point ? 1 : 0;
          previousPoint = point;
          if (stableSamples >= 3) { stablePoint = point; break; }
          await page.waitForTimeout(75);
        }
        if (!stablePoint) throw new Error('发送控件未通过连续几何及命中核对，未点击发送。');
        failureStage = 'identity';
        stop(signal); await checkPendingInput(); await authorized('before-click');
        await this.verifyContactBinding(page, contact, expectedContact);
        if (await inputDispatched()) throw new Error('等待期间已发生发送输入，未再点击一次。');
        failureStage = 'authorization';
        if (authorize) { releaseDispatch = await authorize.beginDispatch(); if (typeof releaseDispatch !== 'function') throw new Error('最终输入控制没有返回可释放的许可。'); }
        await this.verifyContactBinding(page, contact, expectedContact);
        await checkPendingInput();
        const finalPoint = await readSendPoint();
        if (!sameGeometry(finalPoint, stablePoint)) throw new Error('最终输入前发送控件移动、替换或被遮挡，未点击发送。');
        failureStage = 'dispatch';
        stop(signal); clicked = true;
        await page.mouse.click(finalPoint.clickX, finalPoint.clickY);
        releaseDispatch?.(); releaseDispatch = null;
        if (!await inputDispatched()) throw new Error('没有核对到真实发送输入，结果需要核对。');
        monitoring = false; clearInterval(monitor); stop(signal);
        failureStage = 'readback';
        const beforeIds = new Set(expected), sentCandidates = new Map();
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (attempt === 3 && !readableDraft(await editor.innerText().catch(() => ''))) {
            // 只重新挂载这个已授权会话一次，不重复输入或点击发送。
            const reopened = await this.select(page, recipientId, signal, { refresh: true });
            if (reopened.flags.blocked || !sameConversationIdentity(reopened.contact, contact)) return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '发送后无法重新核对原会话，未再次发送。' };
          }
          const after = await page.evaluate(readConversationDom, expectedDomIdentity(contact));
          if (!sameConversationIdentity(after, contact)) return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '发送后会话发生变化，未再次发送。' };
          const messages = this.publicMessages(recipientId, after.messages);
          for (const item of messages) if (item.direction === 'outgoing' && item.text === message.trim() && item.arrivalClassification === 'new-tail' && !beforeIds.has(item.id)) sentCandidates.set(item.id, messageFingerprint(item));
          const sent = sentCandidates.size === 1 ? messages.find(item => sentCandidates.has(item.id) && item.direction === 'outgoing' && item.text === message.trim() && sentCandidates.get(item.id) === messageFingerprint(item)) : null;
          if (sent && !sent.failed && !sent.pending) return { ...receipt, confirmed: true, messageId: sent.id, deliveryUncertain: false };
          if (sent?.failed) return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '网页显示发送失败，未自动重试。' };
          stop(signal);
          await page.waitForTimeout(200);
        }
        return { ...receipt, confirmed: false, deliveryUncertain: true, failureStage: 'readback', failureCode: 'CHAT_RECEIPT_UNCONFIRMED', reason: '未取得新发出消息的界面回读，未自动重试。' };
      } catch (error) {
        monitoring = false; clearInterval(monitor);
        let draftCleanup = clicked ? 'not-required' : 'preserved';
        if (!clicked) try {
          // 受控编辑器须通过真实输入更新模型；只删除本次完整草稿，保留用户改动。
          if (readableDraft(await editor.innerText()) === readableDraft(message)) {
            await editor.press('ControlOrMeta+A');
            if (readableDraft(await editor.innerText()) === readableDraft(message)) { await editor.press('Backspace'); draftCleanup = readableDraft(await editor.innerText()) ? 'not-cleared' : 'cleared'; }
          }
        } catch { draftCleanup = 'unavailable'; }
        const failureCode = precheckFailureCode || { fill: 'CHAT_INPUT_FILL_FAILED', identity: 'CHAT_IDENTITY_OR_DRAFT_CHECK_FAILED', watermark: 'CHAT_WATERMARK_CHANGED', button: 'CHAT_SEND_BUTTON_UNAVAILABLE', trial: 'CHAT_SEND_BUTTON_NOT_INTERACTABLE', authorization: 'CHAT_FINAL_AUTHORIZATION_REJECTED', dispatch: 'CHAT_SEND_INPUT_UNCERTAIN', readback: 'CHAT_RECEIPT_READBACK_FAILED' }[failureStage] || 'CHAT_PRECHECK_FAILED';
        const detail = String(error?.message || '');
        const failureEvidence = { timeout: error?.name === 'TimeoutError', pointerIntercepted: /intercepts pointer events/.test(detail), elementUnstable: /element is not stable/.test(detail), elementDetached: /not attached to the DOM|detached from the DOM/.test(detail), outsideViewport: /outside of the viewport/.test(detail), notVisible: /element is not visible/.test(detail), disabled: /element is not enabled/.test(detail) };
        return { ...receipt, confirmed: false, deliveryUncertain: clicked, failureStage, failureCode, draftCleanup, failureEvidence, ...(guardDiagnostic ? { guardDiagnostic } : {}), reason: clicked ? '发送动作已尝试但结果不确定，未自动重试。' : '发送前检查未通过，未点击发送。' };
      } finally {
        monitoring = false; clearInterval(monitor); releaseDispatch?.();
        await page.evaluate(token => { const entry = window.__deepseekChatInputs?.[token]; entry?.cleanup(); if (window.__deepseekChatInputs) delete window.__deepseekChatInputs[token]; }, witnessId).catch(() => {});
      }
    }, { signal });
  }
  async close() {
    const results = await Promise.allSettled([...this.incomingCleanup].map(cleanup => cleanup()));
    results.push(...await Promise.allSettled([...this.voiceCaptures.keys()].map(id => this.releaseVoiceCapture(id))));
    try { await this.controller.close(); }
    finally { const failed = results.find(result => result.status === 'rejected'); if (failed) throw new Error('部分私信临时资源尚未清理，请关闭占用文件后重试。', { cause: failed.reason }); }
  }
}
