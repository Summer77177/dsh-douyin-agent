import { readFriendInteractionsEnabled, acquireFriendInteractionDispatch } from './friend-interactions-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { randomUUID } from 'node:crypto';
import { ChatAgent, normalizeChatReplyText, splitChatReply } from './chat-agent.mjs?v=9';
import { loadApiConfig, redact } from './api-agent.mjs';
import { messageFingerprint } from './chat-message.mjs';
import { OutboundCoordinator } from './outbound-send.mjs';
import { canAuthorizeConversation, hasStableConversationIdentity, isStoredContactAuthorized, matchesAuthorizedContact, upgradeAuthorizedContact } from './contact-authorization.mjs';
import { groupMessageAddressesSelf, normalizeMentionNames } from './group-reply-trigger.mjs';

const basePolicy = () => ({ version: 1, enabled: false, allowlist: [], dailyReplyLimit: null });
const dayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const load = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
const alive = (pid) => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
function save(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temporary, file); }
function initialize(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); let descriptor; try { descriptor = fs.openSync(file, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return; throw error; } try { fs.writeFileSync(descriptor, JSON.stringify(value, null, 2)); } finally { fs.closeSync(descriptor); } }
function recentEvents(file) {
  if (!fs.existsSync(file)) return [];
  const descriptor = fs.openSync(file, 'r');
  try { const size = fs.fstatSync(descriptor).size; const length = Math.min(size, 65_536); const buffer = Buffer.alloc(length); fs.readSync(descriptor, buffer, 0, length, size - length); const lines = buffer.toString('utf8').split('\n'); if (size > length) lines.shift(); return lines.filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).slice(-30); }
  finally { fs.closeSync(descriptor); }
}
function validatePolicy(policy) {
  if(!policy||policy.version!==1||typeof policy.enabled!=='boolean')throw new Error('私信许可记录损坏，已阻止自动回复。');
  if (!Array.isArray(policy.allowlist) || new Set(policy.allowlist.map((item) => item?.id)).size !== policy.allowlist.length) throw new Error('许可名单须为不同的个人或群聊会话，不能重复选择。');
  for (const item of policy.allowlist) if (!isStoredContactAuthorized(item)) throw new Error('许可名单必须有已核对的关注关系，或本人明确授权的个人、群聊会话身份。');
  return { ...policy, dailyReplyLimit: null, groupMentionNames: normalizeMentionNames(policy.groupMentionNames) };
}
function messagesOf(snapshot) {
  if (snapshot?.loginRequired || snapshot?.verificationRequired || snapshot?.blocked) throw new Error('抖音私信需要手动登录、验证或解除页面限制。');
  if (!Array.isArray(snapshot?.messages)) throw new Error('没有读到可靠的私信消息列表。');
  const messages = snapshot.messages.map((message) => ({ ...structuredClone(message), sender: message.sender || message.direction }));
  if (messages.some((message) => typeof message.id !== 'string' || !message.id || !['incoming', 'outgoing', 'unknown'].includes(message.sender))) throw new Error('私信消息缺少稳定 ID 或方向，未回复。');
  return messages;
}
function assertConversationSnapshot(contact, snapshot) {
  if (!matchesAuthorizedContact(contact, snapshot?.contact) || snapshot?.conversation?.id !== contact.id) throw new Error('会话身份或许可绑定回读不一致，已暂停。');
  if (typeof snapshot.conversation.isGroup === 'boolean' && snapshot.conversation.isGroup !== contact.isGroup) throw new Error('会话类型回读不一致，已暂停。');
}
function verifiedAuthorizedContact(stored, current) {
  if (!hasStableConversationIdentity(current)) throw new Error('未读到许可会话可靠的稳定身份，未继续自动回复；请本人重新核对授权。');
  const upgraded = upgradeAuthorizedContact(stored, current);
  if (!upgraded) throw new Error('许可会话的稳定身份尚未核对，旧关注名单不能自动迁移；请本人重新核对授权。');
  return upgraded;
}
const contentOf=messages=>messages.map(message=>({id:message.id,fingerprint:messageFingerprint(message)}));
const unresolvedManual=mark=>(mark.unanswered||[]).filter(item=>!item.handledByUserAt).length;
function maintenanceActive(stateDir){try{const value=load(path.join(stateDir,'friend-interactions-policy.json'),{version:1,enabled:true});return value?.version===1&&value.enabled===true&&fs.existsSync(path.join(stateDir,'friend-interactions-settings.guard'));}catch{return false;}}
function revokeError(stateDir,phase){const maintenance=maintenanceActive(stateDir);return Object.assign(new Error(maintenance?'正在维护好友名单，发送已暂缓。':'好友互动开关或回复许可已撤回，未继续发送。'),{code:maintenance?'CHAT_MAINTENANCE_REVOKED':'CHAT_INTERACTIONS_REVOKED',safeBeforeDispatch:phase==='prepare'});}
function allowMaintenanceRecovery(pending){if(pending?.recoveryEvidence?.beforeDispatch===true){pending.restartAllowed=true;pending.recoveryExpiresAt??=Date.now()+5*60_000;}}
function archivePending(mark,pending,reason,{handledByUserAt}={}) {
  if(!pending)return;
  mark.unanswered||=[];const archiveKey=JSON.stringify([pending.phase,pending.incoming||[]]);const existing=mark.unanswered.find(item=>item.archiveKey===archiveKey&&!item.handledByUserAt);if(existing){if(handledByUserAt)existing.handledByUserAt=handledByUserAt;return;}
  mark.unanswered.push({...structuredClone(pending),archiveKey,skippedAt:new Date().toISOString(),reason,...(handledByUserAt?{handledByUserAt}:{})});
}
function recoveryEvidence(contact,incoming,messages,prior,stopRequest) {
  if(!incoming.length)return null;
  const qualifiedIncoming=incoming.map(message=>{const qualified=message.eligibleForReply===true||prior?.qualifiedIncoming?.some(item=>item.qualified===true&&item.originalEligibleForReply===true&&item.message?.id===message.id&&item.fingerprint===messageFingerprint(message))===true;return{message:structuredClone(message),fingerprint:messageFingerprint(message),qualified,originalEligibleForReply:qualified};});
  if(qualifiedIncoming.some(item=>!item.qualified||item.message.sender!=='incoming'))return null;
  return{version:1,beforeDispatch:true,contact:structuredClone(contact),qualifiedIncoming,expectedContent:contentOf(messages),qualifiedAt:prior?.qualifiedAt||new Date().toISOString(),stopRequestId:prior?.stopRequestId??stopRequest?.requestId??null};
}
function recoverableIncoming(pending,contact,messages,stopRequest) {
  const evidence=pending?.recoveryEvidence;
  if(!pending?.restartAllowed||!Number.isFinite(pending.recoveryExpiresAt)||pending.recoveryExpiresAt<Date.now()||evidence?.version!==1||evidence.beforeDispatch!==true||!matchesAuthorizedContact(evidence.contact,contact)||!matchesAuthorizedContact(contact,evidence.contact)||!Array.isArray(evidence.qualifiedIncoming)||!evidence.qualifiedIncoming.length||JSON.stringify(evidence.expectedContent)!==JSON.stringify(contentOf(messages))||messages.some(item=>item.sender==='unknown'))return null;
  if(stopRequest&&stopRequest.preservePending!==true&&stopRequest.requestId!==evidence.stopRequestId)return null;
  const incoming=[];
  for(const item of evidence.qualifiedIncoming){const current=messages.find(value=>value.id===item.message?.id);if(item.qualified!==true||item.originalEligibleForReply!==true||!current||current.sender!=='incoming'||item.fingerprint!==messageFingerprint(current))return null;incoming.push(current);}
  const last=messages.findLastIndex(item=>incoming.some(value=>value.id===item.id));if(last<0||messages.slice(last+1).some(item=>item.sender==='outgoing'))return null;
  return incoming;
}

// 沿用视频工具的本机配置与直接 API 请求；私信状态及正文只写本机 state。
export class ChatService {
  constructor({ browser, config = loadApiConfig(), agent = new ChatAgent({ config }), stateDir = resolveRuntimePaths().stateDir, pollIntervalMs = 2_000, outboundCoordinator, mediaAdapter } = {}) {
    if (!browser?.listContacts || !browser?.readConversation || !browser?.sendMessage) throw new Error('缺少私信浏览器控制器。');
    Object.assign(this, { browser, config, agent, stateDir, pollIntervalMs, mediaAdapter });
    this.outbound = outboundCoordinator ?? new OutboundCoordinator({ stateDir, source: browser.controller?.source === 'dsh-chat' ? 'dsh' : 'api' });
    this.policyFile = path.join(stateDir, 'chat-policy.json');
    this.watermarkFile = path.join(stateDir, 'chat-watermarks.json');
    this.logFile = path.join(stateDir, 'chat-events.jsonl');
    this.lockFile = path.join(stateDir, 'chat-loop.lock'); this.stopFile = path.join(stateDir, 'chat-stop.request.json'); this.guardFile = path.join(stateDir, 'chat-control.guard');
    this.policy = validatePolicy(load(this.policyFile, basePolicy()));
    this.watermarks = load(this.watermarkFile, { version: 1, contacts: {}, days: {} });
    this.running = false; this.busy = false; this.timer = null; this.abort = null; this.starting = null; this.runId = null; this.heartbeat = null; this.ownershipLost = false;
    this.pollRequested = false; this.pollScheduled = null; this.incomingPriority = new Set(); this.incomingUnsubscribe = null; this.notificationsTask = null; this.notificationCleanup = null;
    this.events = [];
    if (!fs.existsSync(this.watermarkFile)) initialize(this.watermarkFile, this.watermarks);
    if (!fs.existsSync(this.policyFile)) initialize(this.policyFile, this.policy);
  }

  log(type, value = {}) {
    const event = redact({ at: new Date().toISOString(), type, ...value }, [this.config?.apiKey]);
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.appendFileSync(this.logFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    this.events.push(event); if (this.events.length > 100) this.events.shift();
  }
  persist() { if (this.ownershipLost) throw new Error('回复进程已失去锁，未覆盖其他入口的水位。'); if (this.runId) this.assertOwned(); save(this.watermarkFile, this.watermarks); }
  refreshAuthorizedContact(stored, verified) {
    if (JSON.stringify(stored) === JSON.stringify(verified)) return stored;
    return this.control(() => {
      this.assertOwned();
      const policy = validatePolicy(load(this.policyFile, this.policy));
      const index = policy.allowlist.findIndex(item => item.id === stored.id);
      if (index < 0 || JSON.stringify(policy.allowlist[index]) !== JSON.stringify(stored)) throw new Error('核对期间许可名单已变化，未覆盖新设置或继续回复。');
      policy.allowlist[index] = verified;
      this.policy = policy; save(this.policyFile, policy);
      return verified;
    });
  }
  control(action) {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const token = randomUUID(); let descriptor;
    try { descriptor = fs.openSync(this.guardFile, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('另一个入口正在更新回复锁，或控制锁需要人工核对；未自动删除控制锁。'), { code: 'CHAT_CONTROL_BUSY' }); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })); }
    finally { fs.closeSync(descriptor); }
    try { return action(); }
    finally { const current = load(this.guardFile, null); if (current?.token === token && current.pid === process.pid) fs.unlinkSync(this.guardFile); }
  }
  loseOwnership() {
    if (this.ownershipLost) return;
    this.ownershipLost = true; this.running = false;
    this.stopPolling(); clearInterval(this.heartbeat); this.heartbeat = null;
    this.abort?.abort(new Error('回复进程已失去 worker 锁，已停止操作。'));
    this.runId = null;
    this.log('worker.ownership_lost', { message: '已停止旧入口，不改新入口的锁、配置或水位。' });
  }
  assertOwned() { const worker = this.worker(); if (!this.runId || worker?.owned !== true || worker.pid !== process.pid) { this.loseOwnership(); throw new Error('回复进程已失去 worker 锁，未继续操作。'); } return worker; }
  worker() {
    try { const worker = load(this.lockFile, null); return worker ? { ...worker, alive: alive(worker.pid), heartbeatFresh: Date.now() - Date.parse(worker.heartbeatAt) < 10_000, owned: worker.runId === this.runId } : null; }
    catch { return fs.existsSync(this.lockFile) ? { alive: Date.now() - fs.statSync(this.lockFile).mtimeMs < 30_000, owned: false, status: 'starting', note: '锁文件尚未写完，暂不启动第二个回复进程。' } : null; }
  }
  acquire() {
    this.control(() => {
      const existing = this.worker();
      if (existing?.alive) throw new Error('另一个入口已经运行私信自动回复；请使用状态或停止工具。');
      if (existing) fs.unlinkSync(this.lockFile);
      const descriptor = fs.openSync(this.lockFile, 'wx', 0o600);
      this.runId = randomUUID(); this.ownershipLost = false;
      try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, runId: this.runId, heartbeatAt: new Date().toISOString(), status: 'starting' })); }
      finally { fs.closeSync(descriptor); }
      this.watermarks = load(this.watermarkFile, { version: 1, contacts: {}, days: {} });
      for (const mark of Object.values(this.watermarks.contacts)) if (mark.status === 'inflight') { mark.status = 'delivery-uncertain'; mark.reason = '上次进程在发送确认前结束，请人工核对。'; }
      this.persist();
    });
    this.heartbeat = setInterval(() => {
      try {
        this.assertOwned();
        const request = load(this.stopFile, null);
        if (request?.targetRunId === this.runId && (this.running || this.starting)) this.stop({preservePending:request.preservePending===true,reason:request.reason});
        if (this.runId) this.control(() => { this.assertOwned(); save(this.lockFile, { pid: process.pid, runId: this.runId, heartbeatAt: new Date().toISOString(), status: this.running ? 'running' : this.starting ? 'starting' : 'stopping' }); });
        if (!this.running && !this.busy && !this.starting) this.release();
      } catch (error) { if (error.code !== 'CHAT_CONTROL_BUSY') this.log('worker.control_error', { message: error.message }); }
    }, 1000); this.heartbeat.unref?.();
  }
  release() {
    if (!this.runId || this.busy || this.starting) return;
    try { this.control(() => { this.assertOwned(); const policy = validatePolicy(load(this.policyFile, this.policy)); policy.enabled = false; save(this.policyFile, policy); fs.unlinkSync(this.lockFile); }); }
    catch (error) { if (error.code === 'CHAT_CONTROL_BUSY') return; if (this.ownershipLost) return; throw error; }
    clearInterval(this.heartbeat); this.heartbeat = null; this.runId = null;
  }
  state() {
    const worker = this.worker();
    if (!worker?.owned) { this.policy = validatePolicy(load(this.policyFile, this.policy)); this.watermarks = load(this.watermarkFile, this.watermarks); this.events = recentEvents(this.logFile); }
    const contacts=Object.entries(this.watermarks.contacts).filter(([id])=>this.policy.allowlist.some(item=>item.id===id)).map(([id,mark])=>({id,status:mark.status,reason:mark.reason||'',pending:mark.pending||null,unanswered:mark.unanswered||[],lastCheckedAt:mark.lastCheckedAt,recovery:{pendingManualCount:unresolvedManual(mark)+(mark.pending?.incoming?.length&&mark.pending.phase!=='handled-by-user'&&!mark.pending.restartAllowed&&(mark.status==='paused'||!worker?.alive)?1:0),recoverableCount:mark.recoveryQueue||mark.pending?.restartAllowed?1:0}}));
    return { running: this.running || Boolean(worker?.alive && worker.status === 'running'), starting: Boolean(this.starting || worker?.status === 'starting'), busy: this.busy, worker, coordination: { protocol: 'guard-v1', guardPresent: fs.existsSync(this.guardFile) }, pollSeconds: this.pollIntervalMs / 1000, replyTokens: this.agent.replyTokens ?? 512, policy: this.policy, daily: { date: dayKey(), requests: this.watermarks.days[dayKey()] ?? 0, limit: null, remaining: null },contacts,recovery:{pendingManualCount:contacts.reduce((sum,item)=>sum+item.recovery.pendingManualCount,0),recoverableCount:contacts.reduce((sum,item)=>sum+item.recovery.recoverableCount,0)}, events: this.events.slice(-30) };
  }
  async listContacts({ signal } = {}) { return this.browser.listContacts({ verifyFollowing: true, signal }); }
  async readConversation(id, { signal } = {}) {
    const policy = validatePolicy(load(this.policyFile, this.policy));
    const contact=policy.allowlist.find((item) => item.id === id);
    if (!contact) throw new Error('联系人不在已核对白名单，未读取私信。');
    const snapshot=await this.browser.readConversation(id, { allowed: true, signal });
    assertConversationSnapshot(contact,snapshot); return snapshot;
  }
  async videoInspector() {
    this.inspectorPromise??=import('./core.mjs?v=9').then(({BrowserController})=>new BrowserController({source:this.browser.controller?.source==='dsh-chat'?'dsh':'api'}));
    return this.inspectorPromise;
  }
  async chatMediaAdapter() {
    if(this.mediaAdapter) return this.mediaAdapter;
    this.mediaAdapterPromise??=import('./media/index.mjs').then(({MediaAdapter})=>new MediaAdapter());
    return this.mediaAdapterPromise;
  }
  async transcribeMessage(id,message,{signal}={}) {
    const adapter=await this.chatMediaAdapter(), settings=await adapter.settings(); signal?.throwIfAborted();
    if(settings?.enabled!==true || settings.backend!=='local-whisper') throw new Error('语音消息需要本人开启本地 Whisper 转写；当前会话已暂停，未猜测语音内容。');
    const status=await adapter.status(); signal?.throwIfAborted();
    if(status?.enabled!==true || status.backend!=='local-whisper' || status.backends?.['local-whisper']?.available!==true) throw new Error('本地 Whisper 尚不可用，语音未转写；当前会话已暂停，请本人查看。');
    if(typeof this.browser.captureVoiceMessage!=='function'||typeof this.browser.releaseVoiceCapture!=='function') throw new Error('指定语音消息的采集适配尚未就绪，当前会话已暂停。');
    let captured;
    try {
      captured=await this.browser.captureVoiceMessage(id,message.id,{allowed:true,signal}); signal?.throwIfAborted();
      const audio=captured?.audio, seconds=captured?.media?.durationSeconds;
      const mime=audio?.mimeType?.split(';')[0].trim().toLowerCase();
      if(captured?.conversation?.id!==id || captured.messageId!==message.id || !/^voice:[a-f0-9]{64}$/.test(captured.captureId||'') || captured.understandingScope!=='single-message-audio' || captured.media?.type!=='voice' || captured.interval?.scope!=='single-message-audio' || captured.interval.startSeconds!==0 || !Number.isFinite(seconds) || seconds<=0 || seconds>120 || captured.interval.durationSeconds!==seconds || !audio || !path.isAbsolute(audio.path||'') || !Number.isSafeInteger(audio.bytes) || audio.bytes<1 || audio.bytes>25*1024*1024 || !['audio/wav','audio/x-wav','audio/wave','audio/mpeg','audio/mp3','audio/mp4','audio/x-m4a','audio/ogg','audio/webm','audio/aac','audio/amr'].includes(mime)) throw new Error('指定语音消息的身份、时长或采集范围未核实，当前会话已暂停。');
      const stat=fs.lstatSync(audio.path);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==audio.bytes) throw new Error('指定语音的临时文件未通过核对，当前会话已暂停。');
      const result=await adapter.transcribeAudio({source:audio.path,startSeconds:0,durationSeconds:seconds,backend:'local-whisper',language:'auto'},{signal}); signal?.throwIfAborted();
      const intervalValid=result?.interval?.startSeconds===0 && Number.isFinite(result.interval.durationSeconds) && result.interval.durationSeconds>0 && result.interval.durationSeconds<=Math.min(120,seconds+1/16000);
      if(result?.ok===false && result.status==='no-speech' && result.backend==='local-whisper' && result.kind==='transcription' && typeof result.text==='string' && !result.text.trim() && Array.isArray(result.segments) && result.segments.length===0 && intervalValid) return {messageId:message.id,media:{type:'voice',durationSeconds:seconds},frames:[],audioStatus:'no-recognized-speech',understandingScope:'single-message-audio-no-speech',backend:'local-whisper',interval:{startSeconds:0,durationSeconds:result.interval.durationSeconds},note:'本地识别未识别到对白，不能据此确定是否静音、声音太轻或听不清；没有推断说话内容或环境声。'};
      if(result?.ok!==true || result.backend!=='local-whisper' || result.kind!=='transcription' || typeof result.text!=='string' || !result.text.trim() || result.text.length>16_000 || !intervalValid) throw new Error('语音转写失败或未返回有效文字和有界时长，当前会话已暂停，请本人查看，未猜测内容。');
      return {messageId:message.id,media:{type:'voice',durationSeconds:seconds},frames:[],transcription:{text:result.text.trim(),backend:'local-whisper',interval:{startSeconds:0,durationSeconds:result.interval.durationSeconds}},understandingScope:'single-message-audio-transcription',note:'仅转写这条许可会话中的语音消息，未写入全局视频记忆。'};
    } finally { if(/^voice:[a-f0-9]{64}$/.test(captured?.captureId||'')) await this.browser.releaseVoiceCapture(captured.captureId); }
  }
  async observeMessage(id,messageId,{signal,includeWork=true}={}) {
    const snapshot=await this.readConversation(id,{signal});
    const message=this.hydrateSharedLinks(messagesOf(snapshot)).find(item=>item.id===messageId);
    if(!message?.media || message.unsupported) throw new Error('指定消息没有可核对的图片、表情、作品卡片或语音。');
    if(message.media.type==='voice') {
      const result=await this.transcribeMessage(id,message,{signal});
      const after=messagesOf(await this.readConversation(id,{signal})).find(item=>item.id===messageId);
      if(!after || messageFingerprint(after)!==messageFingerprint(message)) throw new Error('语音采集或转写期间消息已变化，当前会话已暂停，未回复。');
      return result;
    }
    if(typeof this.browser.captureMessage!=='function') throw new Error('私信画面适配尚未加载，请重新加载插件。');
    const captured=await this.browser.captureMessage(id,messageId,{allowed:true,signal});
    if(captured.loginRequired||captured.verificationRequired||!captured.frames?.length) throw new Error('没有取得指定消息的画面，请核对登录或验证。');
    if(captured.messageId!==messageId || captured.blocked) throw new Error('指定消息的画面身份未通过核对，未回复。');
    const after=messagesOf(await this.readConversation(id,{signal})).find(item=>item.id===messageId);
    if(!after || messageFingerprint(after)!==messageFingerprint(message)) throw new Error('截图期间指定消息已变化，未回复。');
    const result={...captured,messageId,frames:captured.frames.slice(0,1)};
    if(includeWork && message.media.type==='shared-work') {
      const inspector=await this.videoInspector();
      const limits=inspector.limits().state();
      if(!limits.allowed) {result.note=`当前只读取分享卡片封面和网页元数据，未播放作品：${limits.reason}`;return result;}
      try {
        const resolved=await this.browser.openSharedVideo(id,messageId,{allowed:true,signal});
        result.sharedWork=resolved;
        // 分享卡 DOM 里没有链接，打开一次拿到真实 videoId 就记住：下次读列表直接补上，不用再开卡片。
        if(resolved.videoId&&resolved.url){this.sharedLinks??=new Map();this.sharedLinks.set(messageId,{videoId:resolved.videoId,url:resolved.url});}
        if(!resolved.url) {result.note=resolved.reason||'分享作品链接未核实，只读取卡片。';return result;}
        if(resolved.isPhotoGallery===true) {result.note='分享的是图文作品；本次只读取卡片封面及核实公开链接，没有播放视频。';return result;}
        await inspector.execute('douyin_open_video',{url:resolved.url},{signal});
        let observed;
        try {
          observed=await inspector.execute('douyin_observe',{seconds:3},{signal});
        } catch(first) {
          // 视频标签页可能停在推荐流未就绪的地方：先归位推荐流，再重开目标作品一次。
          signal?.throwIfAborted();
          await inspector.execute('douyin_open',{},{signal});
          await inspector.execute('douyin_open_video',{url:resolved.url},{signal});
          try { observed=await inspector.execute('douyin_observe',{seconds:3},{signal}); }
          catch(second) { second.message=`${second.message}（首次：${first.message}）`; throw second; }
        }
        if(observed.state?.video?.id!==resolved.videoId || observed.observation?.videoId!==resolved.videoId) throw new Error('作品采样身份与分享消息不一致。');
        result.frames.push(...(observed.frames??[]).slice(0,3));
        let transcript=null;
        try {
          const heard=await inspector.execute('douyin_listen',{seconds:8},{signal});
          const interval=heard?.interval;
          if(heard?.ok===true && typeof heard.text==='string' && heard.text.trim() && Number.isFinite(interval?.durationSeconds)) transcript={text:heard.text.trim().slice(0,600),backend:heard.backend||null,interval};
        } catch(error) { signal?.throwIfAborted(); }
        result.sharedWork={...resolved,state:observed.state,observation:observed.observation,...(transcript?{transcript}:{})};
        result.understandingScope=transcript?'card-cover-video-sampling-and-audio-transcription':'card-cover-and-three-second-video-sampling';
        result.note=transcript?'第一张是分享卡片，其余是实际作品的采样；附带的转写只说明录取片段里的人声，不认识音乐和环境声，不代表看完整条作品。':'第一张是分享卡片，其余是实际作品三秒内的采样；没有取得音频转写，不代表听过声音或看完整条作品。';
        await inspector.execute('douyin_pause',{}, {signal});
      }catch(error) {signal?.throwIfAborted();result.note=`分享卡片已读取，作品观察未完成：${redact(error.message,[this.config.apiKey])}`;await inspector.pauseForLimits().catch(()=>{});}
    }
    return result;
  }

  // 分享卡在网页里是不带链接的灰块，打开一次拿到的 videoId 存在内存表里，之后的读列表直接补上。
  hydrateSharedLinks(messages) {
    if (!this.sharedLinks?.size || !Array.isArray(messages)) return messages;
    for (const item of messages) {
      if (item?.media?.type !== 'shared-work' || item.media.videoId) continue;
      const known = this.sharedLinks.get(item.id);
      if (known) Object.assign(item.media, { videoId: known.videoId, url: known.url, publicUrlSource: 'opened-card' });
    }
    return messages;
  }

  async configure({ recipientIds, dailyReplyLimit: _legacyDailyReplyLimit, allowConversationOnly = false, groupMentionNames = this.policy.groupMentionNames } = {}) {
    if (this.running || this.starting || this.busy || this.worker()?.alive) throw new Error('请先停止私信自动回复，再修改白名单或预算。');
    if (!Array.isArray(recipientIds) || recipientIds.some((id) => typeof id !== 'string') || new Set(recipientIds).size!==recipientIds.length) throw new Error('请选择已核对的个人或群聊会话，不能重复选择。');
    if (typeof allowConversationOnly !== 'boolean') throw new Error('已有会话授权必须由本人明确勾选。');
    const result = await this.browser.listContacts({ verifyFollowing: true });
    if (result.blocked || result.loginRequired || result.verificationRequired) throw new Error('请在专用 Edge 完成登录或验证。');
    const allowlist = recipientIds.map((id) => {
      const contact = result.contacts?.find((item) => item.id === id);
      const following = contact?.followed === true && contact.isGroup === false;
      const manual = allowConversationOnly && canAuthorizeConversation(contact);
      if (!hasStableConversationIdentity(contact)) throw new Error('所选会话尚未核对可靠的稳定身份，未保存授权。');
      if (!following && !manual) throw new Error('所选会话尚未核对。群聊或网页未提供关注名单时，请本人核对现有会话并勾选授权；身份不明的会话不能选择。');
      return { id, name: contact.name || contact.displayName || '联系人', followed: following ? true : null, isGroup: contact.isGroup, verifiedAt: new Date().toISOString(), authorizationKind: following ? 'following' : contact.isGroup ? 'existing-group' : 'existing-conversation', ...(contact.identityVerified === true && contact.identityBinding ? { identityVerified: true, identityBinding: contact.identityBinding } : {}), ...(hasStableConversationIdentity(contact) ? { identityVersion: 2, identityKind: contact.identityKind, identityHash: contact.identityHash } : {}), ...(manual ? { relationshipStatus: 'unavailable' } : {}), relationshipEvidence: following ? contact.relationshipEvidence || '浏览器关系回读' : contact.isGroup ? '本人核对群聊稳定身份并明确授权。' : '本人核对稳定会话身份后明确授权；网页未提供关注关系。' };
    });
    const policy = validatePolicy({ version: 1, enabled: false, allowlist, dailyReplyLimit: null, groupMentionNames });
    this.acquire();
    try { this.control(() => { this.assertOwned(); this.policy = policy; save(this.policyFile, this.policy); }); this.log('policy.updated', { recipientIds, dailyReplyLimit: null }); }
    finally { this.release(); }
    return this.state();
  }

  async start({ schedule = true, signal } = {}) {
    signal?.throwIfAborted();
    if (this.running) return this.state();
    if (this.starting) return this.starting;
    this.starting = this.begin(schedule, signal);
    try { return await this.starting; } finally { this.starting = null; if (!this.running) this.release(); }
  }
  setReplyProvider(provider) {
    if (provider !== undefined && typeof provider !== 'function') throw new TypeError('私信回复提供器必须是本机函数。');
    if (this.running || this.starting || this.busy) throw new Error('请先停止私信自动回复，再修改回复提供器。');
    this.agent.replyProvider = provider;
  }
  notifyIncoming(recipientId) {
    if (recipientId !== undefined && !this.policy.allowlist.some(contact => contact.id === recipientId)) return false;
    if (!this.running || this.abort?.signal.aborted) return false;
    if (recipientId !== undefined) this.incomingPriority.add(recipientId);
    return this.requestPoll();
  }
  requestPoll() {
    if (!this.running || this.abort?.signal.aborted || !this.runId) return false;
    this.pollRequested = true;
    // 新通知与定时检查合并；生成或发送中到达的消息只留下一个补扫请求。
    if (this.busy || this.pollScheduled) return true;
    const scheduled = { runId: this.runId };
    this.pollScheduled = scheduled;
    queueMicrotask(() => {
      if (this.pollScheduled !== scheduled) return;
      this.pollScheduled = null;
      if (!this.running || this.runId !== scheduled.runId || this.abort?.signal.aborted) return;
      this.pollRequested = false;
      void this.poll().catch(() => {});
    });
    return true;
  }
  startPolling() {
    this.stopPolling();
    const runId = this.runId, signal = this.abort.signal;
    this.timer = setInterval(() => this.requestPoll(), this.pollIntervalMs); this.timer.unref?.();
    if (typeof this.browser.subscribeIncoming === 'function') {
      try {
        const subscription = this.browser.subscribeIncoming(event => {
          if (this.runId !== runId || signal.aborted) return;
          this.notifyIncoming(typeof event === 'string' ? event : event?.recipientId);
        }, { recipientIds: this.policy.allowlist.map(contact => contact.id), signal });
        this.notificationsTask = Promise.resolve(subscription).then(unsubscribe => {
          if (typeof unsubscribe !== 'function') return;
          if (this.running && this.runId === runId && !signal.aborted) this.incomingUnsubscribe = unsubscribe;
          else return unsubscribe();
        }).catch(() => { if (this.running && this.runId === runId) this.log('service.notifications_unavailable', { message: '消息通知暂不可用，继续使用定时检查。' }); });
      } catch { this.log('service.notifications_unavailable', { message: '消息通知暂不可用，继续使用定时检查。' }); }
    }
    this.requestPoll();
  }
  stopPolling() {
    clearInterval(this.timer); this.timer = null;
    this.incomingPriority.clear();
    this.pollRequested = false; this.pollScheduled = null;
    const unsubscribe = this.incomingUnsubscribe; this.incomingUnsubscribe = null;
    if (typeof unsubscribe === 'function') {
      try { this.notificationCleanup = Promise.resolve(unsubscribe()).catch(() => {}); } catch { /* 关闭订阅失败不恢复服务或重复发送。 */ }
    }
  }
  async begin(schedule, externalSignal) {
    // 5 分钟内连续失败 3 次就先停下：以前页面一离开抖音就被外面每 3 秒拉一次，日志里能刷出十几条 start_failed。
    const recentFails = (this.startFailures || []).filter((at) => Date.now() - at < 5 * 60 * 1000);
    if (recentFails.length >= 3) throw new Error('私信自动回复 5 分钟内已经连续启动失败 3 次，先停下等你处理（看看专用浏览器是不是离开抖音了）。');
    if(!readFriendInteractionsEnabled(this.stateDir))throw new Error('好友互动总开关已关闭，未启动私信回复。');
    if (!this.config?.apiKey && typeof this.agent.replyProvider !== 'function') throw new Error('没有找到 DeepSeek API Key。');
    this.acquire();
    this.policy = validatePolicy(load(this.policyFile, this.policy));
    const authorizedBefore = JSON.stringify(this.policy.allowlist);
    if (!this.policy.allowlist.length) throw new Error('请先保存核对后的白名单。');
    this.abort = new AbortController();
    this.stopContext=null;
    const externalAbort = () => this.abort.abort(externalSignal.reason || new Error('启动任务已停止。'));
    if (externalSignal?.aborted) externalAbort(); else externalSignal?.addEventListener('abort', externalAbort, { once: true });
    const signal = this.abort.signal;
    try {
      const contacts = await this.browser.listContacts({ signal, verifyFollowing: true }); signal.throwIfAborted();
      if (contacts.blocked || contacts.loginRequired || contacts.verificationRequired) throw new Error('抖音私信页面需要手动处理。');
      const verifiedAllowlist = [];
      for (const stored of this.policy.allowlist) {
        const current = contacts.contacts?.find((item) => item.id === stored.id);
        let contact = verifiedAuthorizedContact(stored, current);
        const old = this.watermarks.contacts[contact.id];
        if (['inflight', 'delivery-uncertain'].includes(old?.status)) throw new Error('有发送未确认的联系人，请先人工核对并解除暂停。');
        const snapshot = await this.browser.readConversation(contact.id, { allowed: true, signal }); signal.throwIfAborted();
        const messages = this.hydrateSharedLinks(messagesOf(snapshot));
        assertConversationSnapshot(contact, snapshot);
        contact = verifiedAuthorizedContact(contact, snapshot.contact);
        verifiedAllowlist.push(contact);
        const next={status:'ready',seen:messages.map(item=>item.id).slice(-2000),context:[],unanswered:structuredClone(old?.unanswered||[]),startedAt:new Date().toISOString(),lastCheckedAt:new Date().toISOString()};
        const pending=old?.recoveryQueue||old?.pending;
        if(pending?.incoming?.length&&pending.phase!=='handled-by-user'){
          const restored=recoverableIncoming(pending,contact,messages,load(this.stopFile,null));
          if(restored){next.recoveryQueue=structuredClone(pending);this.log('recovery.queued',{recipientId:contact.id,messageIds:restored.map(item=>item.id),message:'维护中断前已核对且未开始发送的消息进入恢复队列，未修改旧消息水位。'});}
          else{archivePending(next,pending,'重启时缺少完整未发送与消息资格证据，或消息/会话已变化；仅留人工待答，不自动补发。');this.log('baseline.skipped_pending',{recipientId:contact.id,message:'未答消息保留在本机清单，不自动补发。'});}
        }
        this.watermarks.contacts[contact.id]=next;
      }
      signal.throwIfAborted();
      this.control(() => {
        this.assertOwned();
        const policy = validatePolicy(load(this.policyFile, this.policy));
        if (JSON.stringify(policy.allowlist) !== authorizedBefore) throw new Error('启动核对期间许可名单已变化，未覆盖新设置或启动回复。');
        this.policy = { ...policy, allowlist: verifiedAllowlist, enabled: true };
        this.persist(); save(this.policyFile, this.policy); save(this.lockFile, { pid: process.pid, runId: this.runId, heartbeatAt: new Date().toISOString(), status: 'running' });
      }); this.running = true;
      try { save(path.join(this.stateDir, 'chat-auto-start.json'), { enabled: true }); } catch (error) { /* 标记写不进去不影响本次启动 */ }
      this.log('service.started', { message: '已建立现有消息基线，只回复此后新收到的私信。' });
      if (schedule) this.startPolling();
      return this.state();
    } catch (error) { this.running = false; this.stopPolling(); this.policy.enabled = false;
      this.startFailures = [...(this.startFailures || []).filter((at) => Date.now() - at < 5 * 60 * 1000), Date.now()];
      this.log('service.start_failed', { message: error.message });
      // 页面离开抖音、需要手动处理、缺 Key、名单空、连续失败这类不会自己好的，直接弹通知。
      if (/(专用标签页已离开抖音|需要手动处理|没有找到 DeepSeek API Key|请先保存核对后的白名单|好友互动总开关已关闭|连续启动失败)/.test(String(error.message))) {
        try { this.notifier?.notify({ key: 'chat-start-fatal', title: '抖音私信起不来', body: String(error.message).slice(0, 160) }); } catch { /* 通知失败不影响停下 */ }
      }
      throw error; }
    finally { externalSignal?.removeEventListener('abort', externalAbort); }
  }
  stop({preservePending=false,reason='user-stop'}={}) {
    if(preservePending){try{const master=load(path.join(this.stateDir,'friend-interactions-policy.json'),{version:1,enabled:true});if(master?.version!==1||master.enabled!==true)preservePending=false;}catch{preservePending=false;}}
    if (this.ownershipLost) return this.state();
    const worker = this.worker();
    if (this.runId && worker?.owned !== true) { this.loseOwnership(); return this.state(); }
    if (worker?.alive && !worker.owned) {
      if (!worker.runId) throw new Error('另一个入口正在取得锁，请稍后停止。');
      save(this.stopFile, { targetRunId: worker.runId, requestId: randomUUID(), requestedAt: new Date().toISOString(),preservePending:preservePending===true,reason });
      return { ...this.state(), stopping: true, message: '已向当前回复进程发送停止请求。' };
    }
    if(!this.runId&&!preservePending)this.acquire();
    this.stopContext={preservePending:preservePending===true,reason};if(this.runId){for(const mark of Object.values(this.watermarks.contacts)){if(!preservePending){if(mark.pending)mark.pending.restartAllowed=false;if(mark.recoveryQueue)mark.recoveryQueue.restartAllowed=false;}else if(mark.pending?.restartAllowed)allowMaintenanceRecovery(mark.pending);}this.persist();}this.running = false; this.stopPolling(); this.abort?.abort(new Error('用户停止私信自动回复。')); this.policy.enabled = false; if (reason === 'user-stop') { try { save(path.join(this.stateDir, 'chat-auto-start.json'), { enabled: false }); } catch (error) { /* 标记写不进去不影响停止 */ } } this.log('service.stopped',{preservePending:preservePending===true,reason}); this.release(); return this.state();
  }
  resumeContact(id) {
    if (this.running || this.starting || this.busy || this.worker()?.alive) throw new Error('请先停止自动回复，再人工解除联系人暂停。');
    this.acquire();
    try { this.control(() => { this.assertOwned(); this.policy = validatePolicy(load(this.policyFile, this.policy)); this.watermarks = load(this.watermarkFile, this.watermarks);
      if (!this.policy.allowlist.some((item) => item.id === id)) throw new Error('联系人不在白名单。');
      const mark = this.watermarks.contacts[id]; if (mark) {const at=new Date().toISOString();for(const item of mark.unanswered||[])if(!item.handledByUserAt)item.handledByUserAt=at;if(mark.pending)archivePending(mark,mark.pending,'用户明确核对后解除暂停，保留审计，不重发旧消息。',{handledByUserAt:at});if(mark.recoveryQueue)archivePending(mark,mark.recoveryQueue,'用户明确核对后结束恢复队列，不自动补发。',{handledByUserAt:at});delete mark.pending;delete mark.recoveryQueue;mark.status = 'ready'; mark.reason = ''; this.persist(); }
    }); this.log('contact.manually_resolved', { recipientId: id, message: '用户确认已核对发送结果；下次启动将重新建立基线，不重发旧消息。' }); }
    finally { this.release(); }
    return this.state();
  }

  async deliverReply(contact, mark, reply, latest, signal) {
    reply={...reply,text:normalizeChatReplyText(reply?.text)};
    let expectedContent = latest.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) }));
    let entered = false, delivery;
    try {
      delivery = await this.outbound.run({ recipientId: contact.id, purpose: 'reply', signal }, async () => {
        signal.throwIfAborted(); this.assertOwned();
        const currentPolicy = validatePolicy(load(this.policyFile, this.policy));
        const authorized = currentPolicy.allowlist.find(item => item.id === contact.id);
        if(!readFriendInteractionsEnabled(this.stateDir))throw revokeError(this.stateDir);
        if (!currentPolicy.enabled || !matchesAuthorizedContact(contact, authorized)) throw new Error('回复许可或会话绑定已变化，未发送。');
        const current = await this.browser.readConversation(contact.id, { allowed: true, signal });
        const messages = messagesOf(current);
        assertConversationSnapshot(contact, current);
        if (JSON.stringify(messages.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) }))) !== JSON.stringify(expectedContent)) {
          mark.pending.phase = 'superseded'; this.persist();
          return { confirmed: false, deliveryUncertain: false, superseded: true };
        }
        const checkAuthorization=phase=>{signal.throwIfAborted();this.assertOwned();const policy=validatePolicy(load(this.policyFile,this.policy));if(!readFriendInteractionsEnabled(this.stateDir))throw revokeError(this.stateDir,phase);if(!policy.enabled||!matchesAuthorizedContact(contact,policy.allowlist.find(item=>item.id===contact.id)))throw new Error('回复许可或会话绑定已撤回，未继续发送。');return true;};
        const authorize=({recipientId,phase}={})=>{if(recipientId!==contact.id||!['prepare','monitor','before-click'].includes(phase))throw new Error('回复发送核对的会话或阶段无效。');return checkAuthorization(phase);};
        authorize.beginDispatch=()=>{const release=acquireFriendInteractionDispatch(this.stateDir);try{checkAuthorization();}catch(error){release();throw error;}return release;};
        checkAuthorization();entered = true; mark.status = 'inflight'; mark.pending = { ...mark.pending,phase:'sending',text:reply.text,recoveryEvidence:mark.pending.recoveryEvidence?{...mark.pending.recoveryEvidence,beforeDispatch:false}:null,at:new Date().toISOString() }; this.persist();
        // 连发：一次生成可以拆成最多三条，像真人补话、改口；第一条用原有水位快照，后面每条重读会话再发。
        const segments = splitChatReply(reply.text);
        let delivery = null, sentCount = 0;
        for (let index = 0; index < segments.length; index += 1) {
          if (index > 0) {
            await new Promise((resolve) => setTimeout(resolve, 900 + Math.floor(Math.random() * 1500)));
            signal.throwIfAborted(); this.assertOwned(); checkAuthorization();
            const followUp = await this.browser.readConversation(contact.id, { allowed: true, signal });
            assertConversationSnapshot(contact, followUp);
            latest = messagesOf(followUp);
            expectedContent = latest.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) }));
          }
          delivery = await this.browser.sendMessage(contact.id, segments[index], { allowed: true, signal, expectedContact: contact, expectedMessageIds: latest.map(item => item.id), expectedMessageContent: expectedContent, authorize });
          if (delivery?.confirmed !== true) break;
          sentCount += 1;
        }
        return delivery && sentCount > 1 ? { ...delivery, sentCount } : delivery;
      });
    } catch (error) {
      if (!entered && error.beforeDelivery && error.code === 'OUTBOUND_BUSY') {
        mark.status = 'ready'; mark.pending = { ...mark.pending, phase: 'outbound-wait', generatedText: reply.text, expectedContent, usage: reply.usage, at: new Date().toISOString() }; this.persist(); this.log('reply.waiting_for_sender', { recipientId: contact.id }); return;
      }
      if (!entered) throw error;
      if(error.code==='CHAT_MAINTENANCE_REVOKED'&&error.safeBeforeDispatch&&mark.pending?.recoveryEvidence){mark.pending.recoveryEvidence.beforeDispatch=true;mark.pending.phase='stopped-before-send';allowMaintenanceRecovery(mark.pending);mark.status='ready';mark.reason='维护前未开始发送，待核对消息恢复。';this.persist();return;}
      mark.status = 'delivery-uncertain'; mark.reason = '发送中断或失败，需人工核对；不会自动重发。'; this.persist(); this.log('delivery.uncertain', { recipientId: contact.id, message: error.message }); return;
    }
    if (delivery?.superseded) { this.log('reply.superseded', { recipientId: contact.id }); return; }
    if (delivery?.confirmed !== true || typeof delivery.messageId !== 'string' || !delivery.messageId.trim()) {
      const notSent = delivery?.confirmed === false && delivery.deliveryUncertain === false;
      mark.status = notSent ? 'paused' : 'delivery-uncertain'; mark.reason = notSent ? '发送前检查未通过，未点击发送；请核对会话与输入框状态。' : '未取得发送确认，需人工核对；不会自动重发。';
      if (notSent) {mark.pending.phase = 'not-sent';if(mark.pending.recoveryEvidence)mark.pending.recoveryEvidence.beforeDispatch=true;}
      this.persist(); this.log(notSent ? 'reply.not_sent' : 'delivery.uncertain', { recipientId: contact.id, failureCode: delivery?.failureCode || null, failureStage: delivery?.failureStage || null }); return;
    }
    mark.status = 'ready'; mark.reason = ''; mark.context.push({ id: delivery.messageId, sender: 'outgoing', text: reply.text }); mark.context = mark.context.slice(-12);
    mark.seen.push(delivery.messageId); delete mark.pending; this.persist();
    this.log('reply.sent', { recipientId: contact.id, text: reply.text, messageId: delivery.messageId, usage: reply.usage });
  }
  // 自己最近主动分享出去的作品。对方把这条转发回来时网页端只显示“暂不支持”，
  // 拿不到任何 id，只能靠自己的分享账本反查它问的是哪一条。
  recentOwnShares(hours = 12, limit = 2) {
    try {
      const file = path.join(this.stateDir, 'video-forward-receipts.json');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const cutoff = Date.now() - hours * 3600 * 1000;
      return (Array.isArray(raw?.operations) ? raw.operations : [])
        .filter((op) => op && ['confirmed', 'uncertain'].includes(op.status) && typeof op.videoId === 'string' && /^\d{6,32}$/.test(op.videoId) && Number.isFinite(Date.parse(op.startedAt)) && Date.parse(op.startedAt) >= cutoff)
        .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
        .slice(0, limit)
        .map((op) => ({ videoId: op.videoId, at: op.startedAt, recipient: op.recipient?.name ?? null, delivery: op.status === 'confirmed' ? 'sent' : 'sent-unverified' }));
    } catch (error) { return []; }
  }
  // 有人来信时的提醒：先响一声，再请自主观看让出浏览器，回完话再看。
  async notifyIncoming() {
    try {
      const { execFile } = await import('node:child_process');
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object Media.SoundPlayer "C:\\Windows\\Media\\Windows Notify Messaging.wav").Play()'], { windowsHide: true }, () => {});
    } catch { /* 响不了不影响回消息 */ }
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'watch-loop.lock'), 'utf8'));
      if (typeof lock?.runId === 'string') fs.writeFileSync(path.join(this.stateDir, 'watch-stop.request.json'), JSON.stringify({ runId: lock.runId, requestedAt: Date.now() }));
    } catch { /* 没在看就不用停 */ }
  }
  async poll() {
    if (!this.running) return;
    if(!readFriendInteractionsEnabled(this.stateDir)){const maintenance=maintenanceActive(this.stateDir);this.stop({preservePending:maintenance,reason:maintenance?'settings-update':'master-off'});return;}
    if (this.busy) { this.pollRequested = true; return; }
    this.assertOwned();
    this.pollRequested = false; this.busy = true; const signal = this.abort.signal;
    try {
      const prioritized = [...this.policy.allowlist].sort((left, right) => Number(this.incomingPriority.has(right.id)) - Number(this.incomingPriority.has(left.id)));
      // 没有新消息提示时不去打开会话：打开会话要点击页面，会把浏览器从推荐流切到私信页、窗口跟着弹到前面。
      // 兜底全扫 1 分钟一次：页面被自主观看抢回推荐流后，未读观察器看不见会话列表，只能靠它防漏。
      // 每分钟扫完会自己退回推荐流，所以页面只是闪一下就回来，不会一直停在私信页。
      const fullScanDue = Date.now() - (this.lastFullScanAt ?? 0) > 60 * 1000;
      let visitedAny = false;
      for (let contact of prioritized) {
        const flagged = this.incomingPriority.delete(contact.id);
        signal.throwIfAborted(); this.assertOwned(); const mark = this.watermarks.contacts[contact.id];
        if(!mark)continue;
        const waitingSend = mark.pending && ['outbound-wait', 'sending'].includes(mark.pending.phase);
        if (!flagged && !fullScanDue && !waitingSend) continue;
        visitedAny = true;
        if(mark.status==='paused'){
          if(mark.pending?.phase==='sending'||mark.pending?.recoveryEvidence?.beforeDispatch===false)continue;
          if(mark.pending){archivePending(mark,mark.pending,'先前处理未完成，旧待答留人工核对；继续接收此后的可靠新消息。');delete mark.pending;}
          mark.status='ready';mark.reason='';this.persist();
        }
        if(mark.status!=='ready')continue;
        try {
          const snapshot = await this.browser.readConversation(contact.id, { allowed: true, signal }); signal.throwIfAborted();
          const verified = verifiedAuthorizedContact(contact, snapshot.contact);
          assertConversationSnapshot(verified, snapshot);
          contact = this.refreshAuthorizedContact(contact, verified);
          const messages = this.hydrateSharedLinks(messagesOf(snapshot));let restored=[],restoreEvidence;
          if(mark.recoveryQueue){restoreEvidence=mark.recoveryQueue.recoveryEvidence;restored=recoverableIncoming(mark.recoveryQueue,contact,messages,load(this.stopFile,null))||[];if(!restored.length)archivePending(mark,mark.recoveryQueue,'维护恢复前消息、会话或停止许可已经变化，未补发旧待答。');delete mark.recoveryQueue;this.persist();}
          if (hasStableConversationIdentity(contact) && mark.pending && (!matchesAuthorizedContact(mark.pending.recoveryEvidence?.contact, contact) || !matchesAuthorizedContact(contact, mark.pending.recoveryEvidence?.contact))) {
            archivePending(mark, mark.pending, '待答记录的旧身份凭据无法与当前稳定身份双向核对，仅留人工待答。'); delete mark.pending; this.persist();
          }
          if (mark.pending?.phase === 'outbound-wait') {
            const latest = messagesOf(snapshot), content = latest.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) }));
            if (JSON.stringify(content) === JSON.stringify(mark.pending.expectedContent)) {
              await this.deliverReply(contact, mark, { text: mark.pending.generatedText, usage: mark.pending.usage }, latest, signal); continue;
            }
            mark.pending.phase = 'superseded'; this.persist();
          }
          const seen = new Set(mark.seen);
          const discovered = messages.filter((item) => !seen.has(item.id));
          const oldHistory = discovered.filter((item) => ['baseline', 'known-old-window', 'old-history'].includes(item.arrivalClassification));
          const restoredIds=new Set(restored.map(item=>item.id));const fresh=[...restored,...discovered.filter(item=>!oldHistory.includes(item)&&!restoredIds.has(item.id))];
          if (fresh.some((item) => item.sender === 'unknown')) { mark.pending = { phase: 'unclassified', incoming: fresh.map((item) => ({ id: item.id, sender: item.sender, text: item.text || '' })), at: new Date().toISOString() }; throw new Error('新消息方向未确认，联系人已暂停，消息未计入已处理水位。'); }
          mark.seen = [...seen, ...discovered.map((item) => item.id)].slice(-2000); mark.lastCheckedAt = new Date().toISOString(); this.persist();
          if (oldHistory.length) this.log('message.old_history_skipped', { recipientId: contact.id, messageIds: oldHistory.map((item) => item.id), message: '已知旧窗口或加载的历史行只更新水位，不回复。' });
          if (!fresh.length) continue;
          const supported=item=>item.unsupported!==true && (item.media && ['emoji','shared-work','image','voice'].includes(item.media.type) || (!item.kind||item.kind==='text') && (!item.type||item.type==='text') && typeof item.text==='string' && item.text.trim());
          const unsupported = fresh.filter((item) => item.sender === 'incoming' && !supported(item));
          if (unsupported.length) this.log('message.unsupported', { recipientId: contact.id, messageIds: unsupported.map((item) => item.id), message: '没有可靠消息采集证据的附件、撤回或未知消息已跳过。' });
          const needsManual=unsupported.filter(item=>item.media?.type!=='interaction-card'&&item.nonReplyableNotice!==true&&!['recalled','withdrawn','system','system-notice'].includes(item.kind)&&!['recalled','withdrawn','system','system-notice'].includes(item.type)&&(contact.isGroup!==true||groupMessageAddressesSelf(item,this.policy.groupMentionNames)));
          if(needsManual.length){archivePending(mark,{phase:'unsupported-media',incoming:needsManual.map(item=>({id:item.id,kind:item.kind||null,type:item.type||null,mediaType:item.media?.type||null,unsupported:true}))},'新消息包含尚未可靠采集的附件，未编造内容或假装已理解，请人工查看。');this.persist();}
          // 网页端显示不了的消息（转发卡片等）给模型留一句可读的提示，别让它对着一片空白猜。
          const opaqueNotice = unsupported.some((item) => item.sender === 'incoming' && item.nonReplyableNotice !== true)
            ? { direction: 'incoming', sender: 'incoming', kind: 'text', text: '[对方发来一条抖音网页版显示不了的内容，可能是转发的视频卡片，我这边只能看到“暂不支持该消息类型展示”，读不到画面也读不到链接]' }
            : null;
          mark.context = [...mark.context, ...fresh.filter((item) => ['incoming', 'outgoing'].includes(item.sender) && !unsupported.includes(item) && supported(item)), ...(opaqueNotice ? [opaqueNotice] : [])].slice(-12); this.persist();
          const incoming = fresh.filter((item) => item.sender === 'incoming' && !unsupported.includes(item) && (contact.isGroup !== true || groupMessageAddressesSelf(item, this.policy.groupMentionNames)));
          if (!incoming.length) { if (fresh.some((item) => item.sender === 'outgoing') && mark.pending?.phase === 'superseded') { mark.pending.phase = 'handled-by-user'; this.persist(); this.log('reply.handled_by_user', { recipientId: contact.id }); } continue; }
          if (incoming.some((item) => item.eligibleForReply !== true&&!restoredIds.has(item.id))) { mark.pending = { phase: 'unqualified', incoming: incoming.map((item) => ({ id: item.id, text: item.text })), at: new Date().toISOString() }; throw new Error('新消息尚未取得可靠的新到达资格，联系人已暂停。'); }
          const lastIncoming = messages.findLastIndex((item) => incoming.some((freshItem) => freshItem.id === item.id));
          if (messages.slice(lastIncoming + 1).some((item) => item.sender === 'outgoing')) { this.log('message.handled_by_user', { recipientId: contact.id, messageIds: incoming.map((item) => item.id) }); mark.pending = { phase: 'handled-by-user', incoming: incoming.map((item) => ({ id: item.id, text: item.text })), at: new Date().toISOString() }; this.persist(); continue; }
          const date = dayKey();
          const evidence=recoveryEvidence(contact,incoming,messages,restoreEvidence,load(this.stopFile,null));const pendingIncoming=structuredClone(incoming);
          const mediaObservations=[];
          const sharedVideos=[];
          if(incoming.some(item=>item.media)) {mark.pending={phase:'observing',incoming:pendingIncoming,recoveryEvidence:evidence,at:new Date().toISOString()};this.persist();}
          for(const item of incoming.filter(item=>item.media && item.media.type!=='interaction-card')) {
            if(item.media.type!=='voice' && mediaObservations.reduce((count,entry)=>count+entry.frames.length,0)>=4) throw new Error('同时收到的媒体消息超过本次四张采样预算，联系人已暂停，请人工查看。');
            const observed=await this.observeMessage(contact.id,item.id,{signal});
            const remaining=4-mediaObservations.reduce((count,entry)=>count+entry.frames.length,0);
            mediaObservations.push({...observed,frames:observed.frames.slice(0,remaining)});
            const shared=observed.sharedWork;
            if(item.media.type==='shared-work'&&shared&&typeof shared.videoId==='string'&&/^\d{1,64}$/.test(shared.videoId)) sharedVideos.push({videoId:shared.videoId,title:shared.title??null,author:shared.author??null,url:shared.url??null,transcript:shared.transcript?.text??null,messageId:item.id,at:new Date().toISOString()});
          }
          // 会话内分享作品记忆：48 小时内、最多保留 5 条，供之后对方追问时接得上。
          if(sharedVideos.length) mark.sharedVideos=[...(Array.isArray(mark.sharedVideos)?mark.sharedVideos:[]),...sharedVideos].filter(entry=>entry&&typeof entry.videoId==='string'&&Number.isFinite(Date.parse(entry.at))).filter((entry,index,list)=>list.findIndex(other=>other.videoId===entry.videoId&&other.messageId===entry.messageId)===index).slice(-5);
          this.watermarks.days[date] = (this.watermarks.days[date] ?? 0) + 1;
          mark.pending = { phase: 'model', incoming:pendingIncoming,recoveryEvidence:evidence, at: new Date().toISOString() }; this.persist();
          this.log('message.received', { recipientId: contact.id, messages: incoming.map((item) => ({ id: item.id, text: item.text })) });
          // 有人来信：先响一声，再请自主观看停一下，把浏览器让出来回话。
          await this.notifyIncoming();
          const recentSharedVideos = (Array.isArray(mark.sharedVideos) ? mark.sharedVideos : []).filter(entry => entry && Number.isFinite(Date.parse(entry.at)) && Date.parse(entry.at) >= Date.now() - 48 * 3600 * 1000).slice(-5);
          const reply = await this.agent.reply({ messages: mark.context, mediaObservations, sharedVideos: recentSharedVideos, ownShares: this.recentOwnShares(), conversation: { displayName: contact.name, isGroup: contact.isGroup }, signal }); signal.throwIfAborted();
          mark.pending.generatedText = reply.text; this.persist();
          // 生成期间若用户已经回复，或对方又发消息，跳过本次发送。
          const latestSnapshot = await this.browser.readConversation(contact.id, { allowed: true, signal }); signal.throwIfAborted();
          assertConversationSnapshot(contact, latestSnapshot);
          const latest = messagesOf(latestSnapshot);
          if (latest.some((item) => item.sender === 'unknown') || incoming.some((item) => !latest.some((current) => current.id === item.id && current.sender === 'incoming' && messageFingerprint(current)===messageFingerprint(item)))) { mark.pending.phase = 'superseded'; mark.pending.readback = latest.filter((item) => incoming.some((before) => before.id === item.id)).map((item) => ({ id: item.id, sender: item.sender, kind: item.kind, text: item.text })); throw new Error('待回复消息在生成期间被撤回、改动或方向不明，未发送。'); }
          // 生成期间的变化分三类，不再一律丢弃：
          // ① 对方真发了新内容 → 带上新消息重新生成一次（最多一次，8 秒超时就用原回复）
          // ② 我方抢先回了 → 不发，记为人工已回
          // ③ 只是列表重渲染/抖动、内容没变 → 照发
          const seenIds = new Set(Array.isArray(mark.seen) ? mark.seen : []);
          const added = latest.filter((item) => !seenIds.has(item.id));
          const freshIncoming = added.filter((item) => item.sender === 'incoming');
          if (freshIncoming.length) {
            this.log('reply.regenerating', { recipientId: contact.id, added: freshIncoming.map((item) => item.id) });
            let regenerated = null;
            try {
              const merged = [...mark.context, ...freshIncoming];
              regenerated = await Promise.race([
                this.agent.reply({ messages: merged, mediaObservations, sharedVideos: recentSharedVideos, ownShares: this.recentOwnShares(), conversation: { displayName: contact.name, isGroup: contact.isGroup }, signal }),
                new Promise((resolve) => { const timer = setTimeout(() => resolve(null), 8000); timer.unref?.(); }),
              ]);
            } catch (error) { signal.throwIfAborted(); regenerated = null; }
            if (regenerated?.text) { reply.text = regenerated.text; reply.usage = regenerated.usage ?? reply.usage; mark.pending.generatedText = reply.text; this.persist(); this.log('reply.regenerated', { recipientId: contact.id }); }
            else this.log('reply.regenerate_failed_use_original', { recipientId: contact.id });
          } else if (added.some((item) => item.sender === 'outgoing')) {
            mark.pending.phase = 'handled-by-user'; mark.pending.reason = '生成期间已有人工回复，本次未发送。'; this.persist(); this.log('reply.handled_by_user', { recipientId: contact.id }); continue;
          }
          await this.deliverReply(contact, mark, reply, latest, signal);
        } catch (error) {
          if (mark.status === 'inflight') { mark.status = 'delivery-uncertain'; mark.reason = '发送被中断，需要人工核对。'; }
          else if(signal.aborted||error.code==='CHAT_MAINTENANCE_REVOKED'){mark.status='ready';mark.reason='';if(mark.pending){mark.pending.phase='stopped-before-send';mark.pending.restartAllowed=(this.stopContext?.preservePending===true||error.code==='CHAT_MAINTENANCE_REVOKED')&&mark.pending.recoveryEvidence?.beforeDispatch===true;if(mark.pending.restartAllowed)allowMaintenanceRecovery(mark.pending);mark.reason=mark.pending.restartAllowed?'维护前未开始发送，待核对消息恢复。':'停止前的未答消息已保留，默认不补发。';}}
          else { mark.status='paused';mark.reason=redact(error.message,[this.config?.apiKey]); }
          this.persist(); if (!signal.aborted) this.log('contact.paused', { recipientId: contact.id, message: mark.reason });
        }
      }
      if (visitedAny) this.lastFullScanAt = Date.now();
      // 扫完自己退回推荐流：不退回的话页面会一直停在私信页，窗口跟着弹在前面。
      // 有会话还等着发/核对时不退，避免把发送中的页面抢走。
      const feedIdle = !Object.values(this.watermarks?.contacts ?? {}).some((mark) => mark?.pending);
      if (visitedAny && feedIdle) {
        try {
          await this.browser.controller?.withPage?.(async (page) => {
            const url = page.url();
            if (!url.includes('douyin.com') || url.includes('/user/') || url.includes('modal_id=')) return;
            if (!/^(https:\/\/www\.douyin\.com\/?(\?.*)?|https:\/\/www\.douyin\.com\/jingxuan.*)$/.test(url)) return;
            await page.goto('https://www.douyin.com/?recommend=1&from_nav=1', { waitUntil: 'domcontentloaded' });
          });
        } catch (error) { /* 退回推荐流失败不影响下一轮 */ }
      }
    } finally { this.busy = false; if (!this.running) this.release(); else if (this.pollRequested) this.requestPoll(); }
  }
  async close() { this.stopPolling(); if (this.runId) this.stop(); while (this.busy || this.starting) await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.allSettled([this.notificationsTask, this.notificationCleanup]); await this.browser.close?.(); if(this.inspectorPromise) await this.inspectorPromise.then(inspector=>inspector.close()).catch(()=>{}); }
}
