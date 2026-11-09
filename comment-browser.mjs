import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserController, readPageState } from './core.mjs?v=9';
import { VideoLimits } from './video-limits.mjs';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { validateCommentText } from './autonomous-comments.mjs';

const stop = signal => signal?.throwIfAborted();
const cleanDraft = value => String(value ?? '').replace(/[\u200B-\u200F\uFEFF]/g, '').trim();
const EDITORS = ['.comment-input-container [contenteditable="true"]', '.comment-input-container textarea', '.comment-input-inner-container [contenteditable="true"]', '.comment-input-inner-container textarea', '[data-e2e="comment-input"] [contenteditable="true"]', 'textarea[data-e2e="comment-input"]', '[contenteditable="true"][data-e2e="comment-input"]'].map(selector => `${selector}:not([data-e2e="im-dialog"] *):not([data-e2e="danmaku-container"] *)`).join(',');
const BUTTONS = '[data-e2e="comment-post"],[data-e2e="comment-submit"],[data-e2e="comment-publish"],button,[role="button"],a,div,span';
const LABELLED_BUTTONS = '[aria-label="发布"],[aria-label="发送"],[aria-label="发表评论"],[aria-label="发布评论"],[title="发布"],[title="发表评论"],[title="发布评论"]';
const NATIVE_PUBLISH = '.commentInput-right-ct .oWdMk9B9 span.wchsYBpK';
// 2026-10-24从专用浏览器只读核对；无标签图标仅接受这组结构与几何。
const NATIVE_PUBLISH_ICON = {
  viewBox: '0 0 36 36',
  paths: [
    { d: 'M17.5 30C23.851 30 29 24.851 29 18.5S23.851 7 17.5 7 6 12.149 6 18.5 11.149 30 17.5 30zm-5.16-13.883a1.16 1.16 0 0 0 1.64 1.64l2.395-2.394v8.838a1.16 1.16 0 0 0 2.321 0v-8.839l1.028 1.028 1.368 1.368a1.16 1.16 0 1 0 1.64-1.641l-4.219-4.22a1.382 1.382 0 0 0-1.954 0l-4.22 4.22h.001z', fill: '#fe2c55' },
    { d: 'M12.34 16.117a1.16 1.16 0 0 0 1.64 1.64l2.395-2.394v8.838a1.16 1.16 0 0 0 2.321 0v-8.839l1.028 1.028 1.368 1.368a1.16 1.16 0 1 0 1.64-1.641l-4.219-4.22a1.382 1.382 0 0 0-1.954 0l-4.22 4.22h.001z', fill: '#fff' },
  ],
};
const PUBLISH_LABEL = /^(?:发布|发送|发表评论|发布评论)$/;
const write = (file, value) => { const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } };

async function composerScopeValid(root, expectedVideoId) {
  return root.evaluate((element, expected) => {
    if (element.closest('[data-e2e="im-dialog"],[data-e2e="danmaku-container"],[data-e2e="comment-item"],[data-e2e="comment-list"]')) return false;
    const owner = element.closest('[data-aweme-id],[data-video-id]');
    const videoId = owner?.getAttribute('data-aweme-id') || owner?.getAttribute('data-video-id');
    return !videoId || videoId === expected;
  }, expectedVideoId);
}

async function activateCommentEditor(page, expectedVideoId, check) {
  let editors = page.locator(EDITORS).filter({ visible: true });
  if (await editors.count()) return editors;
  // 评论面板有时整个是关着的（沉浸式播放），此时页面上根本没有输入区域：先点一次评论入口再重新取。
  const panelOpen = await page.locator('.comment-input-inner-container,[data-e2e="comment-list"],[data-e2e="comment-item"]').filter({ visible: true }).count();
  if (!panelOpen) {
    const opener = page.locator('[data-e2e="feed-comment-icon"],[data-e2e="comment-icon"]').filter({ visible: true });
    if (await opener.count() !== 1) return editors;
    await check();
    await opener.click({ timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(900);
    await check();
    editors = page.locator(EDITORS).filter({ visible: true });
    if (await editors.count()) return editors;
  }
  const lazy = page.locator('.comment-input-inner-container:not([data-e2e="im-dialog"] *):not([data-e2e="danmaku-container"] *)').filter({ visible: true });
  if (await lazy.count() !== 1 || !await composerScopeValid(lazy, expectedVideoId)) return editors;
  const canActivate = await lazy.evaluate(element => {
    if (element.querySelector('[data-e2e="comment-reply-target"],.PPsJmqBy,img,video,audio,a,button,[role="button"]')) return false;
    for (const input of element.querySelectorAll('input,textarea,[contenteditable]')) {
      if ((input.value ?? input.innerText ?? input.textContent ?? '').replace(/[\u200B-\u200F\uFEFF]/g, '').trim()) return false;
    }
    const text = (element.innerText || '').trim();
    const placeholder = element.getAttribute('data-placeholder') || element.getAttribute('aria-placeholder') || '';
    const currentPlaceholder = element.querySelector('span.RXtfhfhu');
    const knownEmpty = currentPlaceholder?.textContent.trim() === '留下你的精彩评论吧' && text === '留下你的精彩评论吧' && Boolean(element.closest('.comment-input-container'));
    return !text || Boolean(placeholder && text === placeholder.trim()) || knownEmpty;
  });
  if (!canActivate) return editors;
  await check();
  const bounds = await lazy.boundingBox();
  if (!bounds || bounds.width < 8 || bounds.height < 8) return editors;
  // 只激活已核对的空评论输入区域，不点击发布或使用回车提交。
  await lazy.click({ position: { x: Math.min(16, bounds.width / 2), y: bounds.height / 2 }, timeout: 1000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.comment-input-inner-container [contenteditable="true"],.comment-input-inner-container textarea')].some(element => {
    const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  }), undefined, { timeout: 1500 }).catch(() => {});
  await check();
  editors = page.locator(EDITORS).filter({ visible: true });
  return editors;
}

async function findCommentSubmit(editor, expectedVideoId) {
  let root = editor.locator('xpath=ancestor-or-self::*[contains(concat(" ",normalize-space(@class)," ")," comment-input-container ") or contains(concat(" ",normalize-space(@class)," ")," comment-input-inner-container ") or @data-e2e="comment-input"][1]');
  let lastRoot = root;
  for (let level = 0; level < 5 && await root.count() === 1; level++) {
    if (!await composerScopeValid(root, expectedVideoId)) return { invalid: true };
    const bounded = await root.evaluate(element => !element.matches('body,html') && !element.querySelector('[data-e2e="comment-item"],[data-e2e="comment-list"],[data-e2e="im-dialog"],[data-e2e="danmaku-container"]') && element.querySelectorAll('[contenteditable="true"],textarea').length + Number(element.matches('[contenteditable="true"],textarea')) === 1);
    if (!bounded) break;
    lastRoot = root;
    const controls = root.locator(BUTTONS).filter({ hasText: PUBLISH_LABEL }).or(root.locator(LABELLED_BUTTONS)).or(root.locator(NATIVE_PUBLISH)).filter({ visible: true });
    const indices = await controls.evaluateAll((elements, icon) => {
      const nativeIcon = element => {
        if (!element.matches('span.wchsYBpK') || element.textContent.trim()) return false;
        const toolbar = element.closest('.commentInput-right-ct'), box = element.closest('.oWdMk9B9'), composer = element.closest('.comment-input-inner-container');
        if (!toolbar || !box || !composer || !composer.closest('.comment-input-container') || toolbar.closest('.comment-input-inner-container') !== composer || box.closest('.commentInput-right-ct') !== toolbar || box.lastElementChild !== element || box.querySelectorAll('span.wchsYBpK').length !== 1 || !box.querySelector('input[type="file"]')) return false;
        const svgs = element.querySelectorAll('svg');
        if (svgs.length !== 1 || svgs[0].getAttribute('viewBox')?.trim().replace(/\s+/g, ' ') !== icon.viewBox) return false;
        const paths = [...svgs[0].querySelectorAll('path')], compact = value => (value || '').replace(/[\s,]+/g, '');
        return paths.length === icon.paths.length && paths.every((node, index) => compact(node.getAttribute('d')) === compact(icon.paths[index].d) && node.getAttribute('fill')?.trim().toLowerCase() === icon.paths[index].fill);
      };
      const official = element => nativeIcon(element) || element.matches('[data-e2e="comment-post"],[data-e2e="comment-submit"],[data-e2e="comment-publish"],button,[role="button"],[aria-label="发布"],[aria-label="发送"],[aria-label="发表评论"],[aria-label="发布评论"],[title="发布"],[title="发表评论"],[title="发布评论"]');
      const eligible = elements.filter(element => {
        if (element.closest('[data-e2e="im-dialog"],[data-e2e="danmaku-container"],[data-e2e="comment-item"],[data-e2e="comment-list"],[contenteditable="true"]') || element.querySelector('[contenteditable],textarea,input')) return false;
        return official(element) || /^(?:发布|发送|发表评论|发布评论)$/.test((element.innerText || element.textContent || '').trim()) && (getComputedStyle(element).cursor === 'pointer' || element.tabIndex >= 0 || typeof element.onclick === 'function' || /(?:comment[-_].*(?:post|submit|publish|send)|(?:post|submit|publish|send)[-_].*comment)/i.test(element.className || ''));
      });
      // 嵌套的文字和按钮是同一控件；两个并列发布控件仍视为歧义。
      const independent = eligible.filter(element => official(element) || !eligible.some(other => other !== element && official(other) && other.contains(element)));
      const selected = independent.filter(element => !independent.some(other => other !== element && element.contains(other) && (official(other) || !official(element))));
      return selected.map(element => ({ index: elements.indexOf(element), nativeIcon: nativeIcon(element) }));
    }, NATIVE_PUBLISH_ICON);
    if (indices.length > 1) return { ambiguous: true, root };
    if (indices.length === 1) return { root, send: controls.nth(indices[0].index), nativeIcon: indices[0].nativeIcon };
    root = root.locator('xpath=..');
  }
  return { missing: true, root: lastRoot };
}

export async function inspectCommentComposer(page, expectedVideoId) {
  const editors = page.locator(EDITORS).filter({ visible: true }), editorCount = await editors.count();
  if (editorCount !== 1) return { editorCount, inputReady: false, submitFound: false, needsUserAction: true };
  const selected = await findCommentSubmit(editors, expectedVideoId);
  if (!selected.send) return { editorCount, inputReady: !selected.invalid, submitFound: false, ambiguous: Boolean(selected.ambiguous), needsUserAction: true };
  const enabled = await selected.send.evaluate((element, nativeIcon) => !element.closest(':disabled,[aria-disabled="true"],[data-disabled="true"],.disabled') && (!nativeIcon || element.classList.contains('jfGCpJo0')), selected.nativeIcon);
  return { editorCount, inputReady: true, submitFound: true, nativeIcon: Boolean(selected.nativeIcon), enabled };
}

// 只读公开评论的编号、正文和自身发出状态；不采集其他评论者的账号、昵称或头像。
export function readCommentDom(expectedVideoId) {
  const visible = element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden'; };
  const profileId = anchor => {
    try { const url = new URL(anchor.getAttribute('href'), 'https://www.douyin.com/'); return url.origin === 'https://www.douyin.com' && !url.username && !url.password ? /^\/user\/([A-Za-z0-9_-]{5,300})\/?$/.exec(url.pathname)?.[1] || null : null; } catch { return null; }
  };
  const privateArea = '[data-e2e="im-dialog"],[data-e2e="conversation-item"]';
  const ownNavigation = [...document.querySelectorAll('.tab-user_self a[href]')].filter(anchor => visible(anchor) && !anchor.closest(`${privateArea},[data-e2e="comment-item"]`) && anchor.textContent.trim() === '我的');
  const ownProfile = ownNavigation.length === 1 ? profileId(ownNavigation[0]) : null;
  const pageVideoIds = new Set();
  try { const url = new URL(location.href), id = /^\/video\/(\d+)\/?$/.exec(url.pathname)?.[1] || url.searchParams.get('modal_id') || url.searchParams.get('aweme_id'); if (/^\d{1,64}$/.test(id || '')) pageVideoIds.add(id); } catch {}
  for (const player of document.querySelectorAll('[data-e2e="player-container"]')) {
    if (!visible(player) || player.closest(privateArea) || ![...player.querySelectorAll('video')].some(visible)) continue;
    const id = /(?:^|\s)video_(\d+)(?:\s|$)/.exec(player.className || '')?.[1]; if (id) pageVideoIds.add(id);
  }
  if (pageVideoIds.size && (pageVideoIds.size !== 1 || !pageVideoIds.has(expectedVideoId))) return { rows: [] };
  const result = [];
  for (const row of document.querySelectorAll('[data-e2e="comment-item"]')) {
    if (!visible(row) || row.closest(privateArea) || row.parentElement?.closest('[data-e2e="comment-item"]')) continue;
    const owned = selector => [...row.querySelectorAll(selector)].filter(element => element.closest('[data-e2e="comment-item"]') === row);
    const ancestorVideoId = row.closest('[data-aweme-id],[data-video-id]')?.getAttribute('data-aweme-id') || row.closest('[data-video-id]')?.getAttribute('data-video-id');
    if (ancestorVideoId && ancestorVideoId !== expectedVideoId) continue;
    const videoBound = ancestorVideoId === expectedVideoId || pageVideoIds.size === 1 && pageVideoIds.has(expectedVideoId);
    const ids = [row.getAttribute('data-comment-id'), /^comment_(\d+)$/.exec(row.id)?.[1], ...owned('[id^="tooltip_"]').map(element => /^tooltip_(\d+)$/.exec(element.id)?.[1])].filter(Boolean);
    const rawId = new Set(ids).size === 1 ? ids[0] : null;
    const content = owned('[data-e2e="comment-content"],.comment-item-content,.FduGc_lz > .Sh1Da424');
    const textNode = content.length === 1 ? content[0] : null;
    const text = (textNode?.innerText || textNode?.textContent || '').trim();
    const authors = owned('.comment-item-avatar a[href]').filter(anchor => visible(anchor) && !anchor.closest('[data-e2e="comment-content"],.comment-item-content,.FduGc_lz > .Sh1Da424'));
    const authorProfile = authors.length === 1 ? profileId(authors[0]) : null;
    const selfMarker = row.getAttribute('data-is-self') === 'true' || row.getAttribute('data-author-is-self') === 'true' || owned('[data-e2e="comment-self"]').length === 1;
    const mine = videoBound && (selfMarker || Boolean(ownProfile && authorProfile && ownProfile === authorProfile));
    const status = row.getAttribute('data-send-status') || row.getAttribute('data-comment-status') || '';
    const labels = owned('[data-e2e="comment-status"],.comment-item-tag-text').map(element => element.textContent.trim());
    const pending = /^(?:sending|pending|reviewing)$/.test(status) || owned('[data-e2e="comment-pending"],[aria-busy="true"],[class*="sending" i]').length > 0 || labels.some(value => /^(?:待审核|审核中|评论审核中|发送中|发布中)$/.test(value));
    const failed = /^(?:failed|rejected|error)$/.test(status) || owned('[data-e2e="comment-failed"],[class*="sendFail"]').length > 0 || labels.some(value => /^(?:审核未通过|发布失败|评论未发布|发送失败)$/.test(value));
    const sent = /^(?:sent|published|success)$/.test(status) || mine && /^\d{1,64}$/.test(rawId || '') && !pending && !failed;
    result.push({ commentId: /^\d{1,64}$/.test(rawId || '') ? rawId : null, videoId: ancestorVideoId || expectedVideoId, text, mine, sent, pending, failed });
  }
  return { rows: result };
}

function assertVideo(state, expectedVideoId) {
  if (state?.loginRequired || state?.verificationRequired || state?.unsupportedPage || state?.privateChatVisible || state?.blocked || state?.video?.id !== expectedVideoId || state.video.readyState < 2) throw new Error('当前作品、登录状态或页面遮挡无法核对，未发布评论。');
  const url = state.video.url || state.url;
  if (url) { let current; try { current = new URL(url); } catch {} if (!current || current.origin !== 'https://www.douyin.com' || /^\/video\/(\d+)\/?$/.exec(current.pathname)?.[1] !== expectedVideoId) throw new Error('当前作品链接与预期不一致，未发布评论。'); }
}

export class CommentBrowser {
  constructor({ source = 'api', controller, videoLimits, stateDir = resolveRuntimePaths().stateDir } = {}) {
    if (!['api', 'dsh'].includes(source)) throw new TypeError('评论入口只能是 api 或 dsh。');
    this.source = source; this.stateDir = stateDir;
    this.videoLimits = videoLimits ?? new VideoLimits({ stateDir });
    // 默认创建独立的同入口控制器，不能复用正在等待评论结果的父控制器队列。
    this.controller = controller ?? new BrowserController({ source, videoLimits: this.videoLimits }); this.ownsController = !controller;
    this.receiptsFile = path.join(stateDir, 'comment-browser-receipts.json'); this.guardFile = path.join(stateDir, 'comment-post.guard');
  }
  receipts() { try { const value = JSON.parse(fs.readFileSync(this.receiptsFile, 'utf8')); if (!value || value.version !== 1 || !Array.isArray(value.operations) || value.operations.some(item => !item || typeof item.operationId !== 'string' || !/^\d{1,64}$/.test(item.videoId) || !['clicking', 'confirmed', 'uncertain'].includes(item.status))) throw Error(); return value; } catch (error) { if (error.code === 'ENOENT') return { version: 1, operations: [] }; throw new Error('原评论发布收据无法核对，未自动重发。'); } }
  record(operation) { const value = this.receipts(), index = value.operations.findIndex(item => item.operationId === operation.operationId); if (index < 0) value.operations.push(operation); else value.operations[index] = operation; write(this.receiptsFile, value); }
  acquire() { fs.mkdirSync(this.stateDir, { recursive: true }); let descriptor; try { descriptor = fs.openSync(this.guardFile, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw new Error('其他评论仍在处理，或发布锁需要核对；未抢锁重试。'); throw error; } const owner = { pid: process.pid, token: randomUUID() }; try { fs.writeFileSync(descriptor, JSON.stringify(owner)); } finally { fs.closeSync(descriptor); } return () => { const current = JSON.parse(fs.readFileSync(this.guardFile, 'utf8')); if (current?.pid === owner.pid && current.token === owner.token) fs.unlinkSync(this.guardFile); }; }
  async gate(signal) { stop(signal); const state = this.videoLimits.state(); if (!state.allowed) throw new Error(state.reason || '有限观看时段已结束，未发布评论。'); }
  async post({ expectedVideoId, text, ...extra } = {}, { signal: parentSignal, authorize, autonomousRunId } = {}) {
    if (typeof expectedVideoId !== 'string' || !/^\d{1,64}$/.test(expectedVideoId) || Object.keys(extra).length) throw new TypeError('评论只能指定当前作品编号与纯文字。');
    text = validateCommentText(text);
    if (typeof authorize !== 'function' || typeof authorize.beginDispatch !== 'function') return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, reason: '评论缺少可信本机许可与最终短输入控制，未发布。' };
    const interrupt = new AbortController(), signal = AbortSignal.any([interrupt.signal, ...(parentSignal ? [parentSignal] : [])]);
    const authorized = async phase => { stop(signal); if (await authorize({ phase, videoId: expectedVideoId }) !== true) throw new Error('自主评论许可已撤回，未继续发布。'); stop(signal); };
    await authorized('prepare'); await this.gate(signal);
    const release = this.acquire(), operation = { operationId: randomUUID(), videoId: expectedVideoId, startedAt: new Date().toISOString(), status: 'clicking' };
    let clicked = false, dispatched = false, receiptWritten = false;
    try {
      if (this.receipts().operations.filter(item => item.videoId === expectedVideoId).length >= 2) throw new Error('同一作品已有两条发布或待核对评论收据，达到每作品上限，未再次点击。');
      return await this.controller.withPage(async page => {
        const checkPage = async () => { await authorized('monitor'); await this.gate(signal); assertVideo(await page.evaluate(readPageState), expectedVideoId); };
        await checkPage();
        const editors = await activateCommentEditor(page, expectedVideoId, checkPage);
        if (await editors.count() !== 1) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, needsUserAction: true, reason: '当前页面没有唯一可核对的评论输入框，需要先打开评论面板或等待适配。' };
        const editor = editors;
        const initial = await findCommentSubmit(editor, expectedVideoId);
        let root = initial.root, send = null;
        if (initial.invalid || !root || await root.count() !== 1) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, needsUserAction: true, reason: '当前评论输入区域归属尚未支持，未发布。' };
        if (initial.ambiguous) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, needsUserAction: true, reason: '当前评论区域存在多个发布控件，未填写或发布。' };
        const draft = () => editor.evaluate(element => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.innerText);
        const hasFile = () => root.locator('input[type="file"]').evaluateAll(inputs => inputs.some(input => input.files?.length || input.value));
        if (cleanDraft(await draft()) || await editor.locator('img,video,audio,a,[data-slate-void="true"]').count() || await hasFile()) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, reason: '评论输入框已有草稿或媒体内容，已保留原内容。' };
        if (await root.locator('[data-e2e="comment-reply-target"],.PPsJmqBy').filter({ visible: true }).count() || await editor.getAttribute('aria-label').then(value => /回复\s*[@＠]/.test(value || ''))) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, reason: '当前输入框处于回复他人的状态，未改发回复或@。' };
        const before = await page.evaluate(readCommentDom, expectedVideoId), knownIds = new Set(before.rows.map(item => item.commentId).filter(Boolean));
        let monitoring = true, polling, prepared = false, releaseDispatch;
        const witnessId = operation.operationId;
        const inputDispatched = () => page.evaluate(token => window.__deepseekCommentInputs?.[token]?.dispatched === true, witnessId);
        const check = async () => {
          if (clicked && await inputDispatched()) return;
          await checkPage();
          if (await editors.count() !== 1 || !await composerScopeValid(root, expectedVideoId) || prepared && cleanDraft(await draft()) !== text || await hasFile() || await root.locator('[data-e2e="comment-reply-target"],.PPsJmqBy').filter({ visible: true }).count()) throw new Error('等待期间评论输入、发布目标或草稿发生变化，未发布。');
          if (send) {
            const latest = await findCommentSubmit(editor, expectedVideoId);
            if (await send.count() !== 1 || !latest.send || await latest.send.getAttribute('data-deepseek-comment-control') !== witnessId) throw new Error('等待期间评论发布控件发生变化或出现歧义，未发布。');
          }
          stop(signal);
        };
        const timer = setInterval(() => { if (!monitoring || polling) return; polling = check().catch(async error => { if (monitoring && !await inputDispatched().catch(() => false)) interrupt.abort(error); }).finally(() => { polling = null; }); }, 40);
        try {
          await check(); await editor.click({ timeout: 1000 }); stop(signal);
          // 使用浏览器真实文字输入触发受控编辑器；填写与页面回读一致后才等待发布按钮。
          await editor.pressSequentially(text, { delay: 10 }); stop(signal); prepared = true; await check();
          const selected = await findCommentSubmit(editor, expectedVideoId);
          if (!selected.send) throw Object.assign(new Error(selected.ambiguous ? '当前评论区域存在多个发布控件，草稿已保留，未发布。' : '当前评论输入已激活，但没有唯一可核对的发布控件；草稿已保留，需要适配当前抖音页面。'), { needsUserAction: true });
          root = selected.root;
          await selected.send.evaluate((element, { token, nativeIcon }) => { element.setAttribute('data-deepseek-comment-control', token); if (nativeIcon) element.setAttribute('data-deepseek-comment-native-publish', token); }, { token: witnessId, nativeIcon: selected.nativeIcon });
          send = root.locator(`[data-deepseek-comment-control="${witnessId}"]`);
          await send.evaluate((button, token) => { const entries = window.__deepseekCommentInputs ??= Object.create(null), entry = { dispatched: false }; const witness = event => { if (event.isTrusted && (event.target === button || button.contains(event.target))) entry.dispatched = true; }; document.addEventListener('click', witness, true); entry.cleanup = () => document.removeEventListener('click', witness, true); entries[token] = entry; }, witnessId);
          await check();
          await page.waitForFunction(token => {
            const element = [...document.querySelectorAll('[data-deepseek-comment-control]')].find(item => item.getAttribute('data-deepseek-comment-control') === token);
            return Boolean(element && !element.closest(':disabled,[aria-disabled="true"],[data-disabled="true"],.disabled') && (element.getAttribute('data-deepseek-comment-native-publish') !== token || element.classList.contains('jfGCpJo0')));
          }, witnessId, { timeout: 3000 }).catch(() => { throw Object.assign(new Error('评论发布控件尚不可用，草稿已保留，未点击。'), { needsUserAction: true }); });
          await send.click({ trial: true, timeout: 3000 }); stop(signal); await check();
          if (await inputDispatched()) { dispatched = true; throw new Error('等待期间已发生发布输入，未再点击一次。'); }
          await authorized('before-click'); releaseDispatch = await authorize.beginDispatch(); if (typeof releaseDispatch !== 'function') throw new Error('最终评论输入未取得可释放的本机许可。');
          stop(signal); this.record(operation); receiptWritten = true; clicked = true;
          await send.click({ timeout: 350, noWaitAfter: true }); releaseDispatch?.(); releaseDispatch = null;
          dispatched = await inputDispatched(); if (!dispatched) throw new Error('没有核对到真实发布输入，评论结果需要核对。');
          monitoring = false; clearInterval(timer); let previousId;
          for (let attempt = 0; attempt < 12; attempt++) {
            stop(signal); assertVideo(await page.evaluate(readPageState), expectedVideoId);
            const current = await page.evaluate(readCommentDom, expectedVideoId);
            const matches = current.rows.filter(item => item.commentId && !knownIds.has(item.commentId) && item.videoId === expectedVideoId && item.text === text && item.mine && item.sent && !item.failed && !item.pending);
            if (matches.length > 1 || new Set(current.rows.map(item => item.commentId).filter(Boolean)).size !== current.rows.filter(item => item.commentId).length) break;
            if (matches.length === 1 && previousId === matches[0].commentId && !cleanDraft(await draft())) { const result = { confirmed: true, deliveryUncertain: false, operationId: operation.operationId, videoId: expectedVideoId, commentId: matches[0].commentId }; this.record({ ...operation, status: 'confirmed', completedAt: new Date().toISOString(), commentId: result.commentId }); return result; }
            previousId = matches.length === 1 ? matches[0].commentId : null;
            await page.waitForTimeout(150);
          }
          this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString() });
          return { confirmed: false, deliveryUncertain: true, operationId: operation.operationId, videoId: expectedVideoId, reason: '已尝试一次发布，但没有同作品的新本人评论编号与发出状态回读；请核对，未重试。' };
        } catch (error) { dispatched ||= await inputDispatched().catch(() => false); throw error; }
        finally { monitoring = false; clearInterval(timer); releaseDispatch?.(); await page.evaluate(token => { const entry = window.__deepseekCommentInputs?.[token]; entry?.cleanup(); if (window.__deepseekCommentInputs) delete window.__deepseekCommentInputs[token]; for (const element of document.querySelectorAll('[data-deepseek-comment-control]')) if (element.getAttribute('data-deepseek-comment-control') === token) { element.removeAttribute('data-deepseek-comment-control'); if (element.getAttribute('data-deepseek-comment-native-publish') === token) element.removeAttribute('data-deepseek-comment-native-publish'); } }, witnessId).catch(() => {}); }
      }, { signal, autonomousRunId });
    } catch (error) {
      if (clicked || dispatched) { try { this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString() }); } catch { /* 保留原始发布收据，未自动重试。 */ } return { confirmed: false, deliveryUncertain: true, operationId: operation.operationId, videoId: expectedVideoId, reason: '发布输入后的结果不明，请人工核对，未再次点击。' }; }
      if (receiptWritten) this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString() });
      return { confirmed: false, deliveryUncertain: false, operationId: operation.operationId, videoId: expectedVideoId, ...(error.needsUserAction ? { needsUserAction: true } : {}), reason: error.message || '评论发布前检查未通过，草稿已保留。' };
    } finally { release(); }
  }
  async close() { if (this.ownsController) await this.controller.close(); }
}
