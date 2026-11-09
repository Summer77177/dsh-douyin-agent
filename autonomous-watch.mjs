import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiAgent, redact, watchDecisionMessages, parseWatchDecision } from './api-agent.mjs?v=13';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { AutonomousShare } from './autonomous-share.mjs?v=9';
import { AutonomousComments } from './autonomous-comments.mjs?v=9';
import { PublicCommentAgent } from './public-comment-agent.mjs?v=9';
import { DailyReport } from './daily-report.mjs?v=9';
import { fullscreenBusy } from './fullscreen-guard.mjs';

import { WatchOptions } from './watch-options.mjs';
import { UsageLedger } from './usage-ledger.mjs';

export const WATCH_LIMITS = Object.freeze({ sampleSeconds: 8, maxLiveSkips: 3, coverageMaxDuration: 1200, coverageFrames: 18, audioSeconds: 10, audioFirstSeconds: 4, audioSpanSeconds: 8, audioSpanWindow: 20, audioSpanSegments: 16, commentRows: 7, prescreenCommentRows: 10, danmakuRows: 7, ocrShots: 6, ocrIntervalMs: 1000, shortMaxSeconds: 120, prescreenMaxSeconds: 600 });
const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('自主观看状态文件损坏，未重置预算或运行锁。'); } };
const write = (file, value) => { const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } };
const day = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const failure = (message, watchStatus = 'failed') => Object.assign(new Error(message), { watchStatus });
const isLivePreview = state => state?.pageKind === 'live-preview' && state.livePreview?.recognized === true && state.livePreview.source === 'active-feed-live-link' && state.livePreview.scope === 'recommend-feed' && /^\d{4,30}$/.test(state.livePreview.roomId || '');
const readyVideo = state => !isLivePreview(state) && /^\d{10,30}$/.test(state?.video?.id || '') && state.video.readyState >= 2;

// API 与原生入口通过同一锁、有限视频轮次和持久预算协调，不在重启时恢复循环。
export class AutonomousWatch {
  constructor({ controller, config = {}, videoLimits, personaMemory, agent, shareService, commentService, commentAgent, reportService, decisionProvider, stateDir = resolveRuntimePaths().stateDir, source = 'api', fetchImpl = fetch, now = Date.now, delayImpl = (ms, signal) => delay(ms, undefined, { signal }), onEvent = () => {} } = {}) {
    if (!controller?.execute || !videoLimits?.state || !personaMemory?.context || !['api', 'dsh'].includes(source)) throw new Error('自主观看缺少浏览器、时限或共同人格接口。');
    Object.assign(this, { controller, config, videoLimits, personaMemory, shareService, decisionProvider, stateDir, source, now, delayImpl, onEvent });
    this.optionsService = new WatchOptions({ stateDir });
    this.usageLedger = new UsageLedger({ stateDir, now });
    this.agent = agent || new ApiAgent({ controller, config, personaMemory, fetchImpl });
    Object.assign(this, { commentService, reportService });
    this.agent.usageLedger = this.usageLedger; this.agent.source = source;
    this.commentAgent = commentAgent || new PublicCommentAgent({ config, fetchImpl });
    this.commentAgent.usageLedger = this.usageLedger; this.commentAgent.source = source;
    fs.mkdirSync(stateDir, { recursive: true });
    this.files = Object.fromEntries(['lock', 'guard', 'budget', 'state', 'stop'].map(name => [name, path.join(stateDir, `watch-${name === 'lock' ? 'loop.lock' : name === 'guard' ? 'control.guard' : name === 'stop' ? 'stop.request.json' : name + '.json'}`)]));
    this.files.manual = path.join(stateDir, 'watch-manual.lock');
    this.running = false; this.completion = null; this.abort = null; this.runId = null; this.sessionId = null;
  }
  control(action) {
    let descriptor; const token = randomUUID();
    try { descriptor = fs.openSync(this.files.guard, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('自主观看控制记录正被使用，请稍后重试。'), { status: 409, code: 'WATCH_CONTROL_BUSY' }); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(descriptor); }
    try { return action(); } finally { const current = read(this.files.guard, null); if (current?.token === token && current.pid === process.pid) fs.unlinkSync(this.files.guard); }
  }
  worker() {
    const worker = read(this.files.lock, null);
    if (!worker) return null;
    if (worker.version !== 1 || typeof worker.runId !== 'string' || typeof worker.sessionId !== 'string' || !['api', 'dsh'].includes(worker.source) || !Number.isSafeInteger(worker.pid)) throw new Error('自主观看锁格式无效，请核对原记录。');
    return { ...worker, alive: alive(worker.pid), owned: worker.runId === this.runId && worker.pid === process.pid };
  }
  budget() {
    const value = read(this.files.budget, { version: 1, sessions: {}, days: {} });
    if (!value || value.version !== 1 || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions) || !value.days || typeof value.days !== 'object' || Array.isArray(value.days) || Object.values(value.sessions).some(item => !item || !Number.isSafeInteger(item.requests) || item.requests < 0) || Object.values(value.days).some(count => !Number.isSafeInteger(count) || count < 0)) throw new Error('自主观看预算损坏，未重新计数。');
    return value;
  }
  state() {
    const worker = this.worker(), saved = read(this.files.state, {}), time = this.videoLimits.state();
    const sessionId = worker?.sessionId || time.session?.id || saved.sessionId || null;
    const budget = this.budget(), counts = budget.sessions[sessionId] || { requests: 0 };
    const request = read(this.files.stop, null), stopping = worker?.alive && request?.runId === worker.runId;
    const savedRunMatches=worker?.alive&&Number.isFinite(worker.heartbeatAt)&&this.now()-worker.heartbeatAt>=0&&this.now()-worker.heartbeatAt<5000&&saved.runId===worker.runId&&saved.sessionId===worker.sessionId&&saved.source===worker.source;
    return redact({ protocol: 'autonomous-watch-v1', running: Boolean(worker?.alive), owned: Boolean(worker?.owned), worker, status: stopping ? 'stopping' : worker?.alive ? 'running' : ['running', 'stopping'].includes(saved.status) ? 'stopped' : saved.status || 'stopped', sessionId, counts: { ...counts, maxRequests:null, dailyRequests: time.daily?.requests ?? budget.days[day(this.now())] ?? 0, dailyLimit: time.policy.dailyRequests ?? null }, phase: this.running ? this.phase || 'waiting' : savedRunMatches?saved.phase||'waiting':'idle', pendingRequests:this.running ? this.pendingRequests || 0 : savedRunMatches&&saved.pendingRequests===1?1:0, options: this.optionsService.state().policy, lastDecision: saved.lastDecision || null, lastError: saved.lastError || '', remainingSeconds: time.allowed && time.session?.id === sessionId ? time.remainingSeconds : 0 }, [this.config.apiKey]);
  }
  save(value) { write(this.files.state, redact({ ...read(this.files.state, {}), ...value, source: this.source, sessionId: this.sessionId, runId:this.runId, updatedAt: new Date(this.now()).toISOString() }, [this.config.apiKey])); }
  // 把看到的弹幕和评论按天落地，供收工时挑生词、新梗去学。只存短文本，最多 400 行/天。
  logLanguage(kind, rows) {
    try {
      if (!Array.isArray(rows) || !rows.length) return;
      const dir = path.join(this.stateDir, 'language-log');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date(this.now());
      const file = path.join(dir, `${stamp.toISOString().slice(0, 10)}.jsonl`);
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
      if (existing >= 400) return;
      const lines = rows.slice(0, 400 - existing).map((text) => JSON.stringify({ at: stamp.toISOString(), kind, text: String(text).replace(/\s+/g, ' ').trim().slice(0, 80) })).filter((line) => !line.endsWith('""}'));
      if (lines.length) fs.appendFileSync(file, lines.join('\n') + '\n');
    } catch (error) { /* 语言日志只是学习素材，写不进去不能影响观看 */ }
  }
  // 作品记忆：同一条作品 12 小时内不重复观察。只存 id 与作者，不存画面。
  videoMemoryFile() { return path.join(this.stateDir, 'watch-video-memory.json'); }
  readVideoMemory() {
    try { const raw = JSON.parse(fs.readFileSync(this.videoMemoryFile(), 'utf8')); return raw && typeof raw === 'object' ? raw : {}; } catch { return {}; }
  }
  rememberVideo(videoId, extra = {}) {
    try {
      if (!videoId) return;
      const memory = this.readVideoMemory();
      const cutoff = this.now() - 12 * 3600 * 1000;
      for (const key of Object.keys(memory)) if (!(Number(memory[key]?.at) >= cutoff)) delete memory[key];
      memory[videoId] = { at: this.now(), ...extra };
      fs.writeFileSync(this.videoMemoryFile(), JSON.stringify(memory));
    } catch (error) { /* 记忆写不进去不影响观看 */ }
  }
  seenRecently(videoId) {
    if (!videoId) return false;
    return this.now() - Number(this.readVideoMemory()[videoId]?.at ?? 0) < 12 * 3600 * 1000;
  }
  // 分享记忆：发过哪条视频、发给谁、当时说了什么话。留最近 300 条，供以后回想。
  shareMemoryFile() { return path.join(this.stateDir, 'share-memory.json'); }
  readShareMemory() {
    try { const raw = JSON.parse(fs.readFileSync(this.shareMemoryFile(), 'utf8')); return Array.isArray(raw?.entries) ? raw : { entries: [] }; } catch { return { entries: [] }; }
  }
  rememberShare(entry) {
    try {
      if (!entry?.videoId) return;
      const data = this.readShareMemory();
      data.entries.push({
        videoId: String(entry.videoId),
        author: String(entry.author || '').slice(0, 40),
        title: String(entry.title || '').slice(0, 100),
        recipientId: String(entry.recipientId || ''),
        note: String(entry.note || '').slice(0, 200),
        at: this.now(),
      });
      data.entries = data.entries.slice(-300);
      fs.writeFileSync(this.shareMemoryFile(), JSON.stringify(data));
    } catch (error) { /* 记忆写不进去不影响观看 */ }
  }
  assertAllowed() {
    this.abort?.signal.throwIfAborted();
    const worker = this.worker(); if (!worker?.owned) throw failure('自主观看已失去运行锁，停止操作。');
    const time = this.videoLimits.state();
    if ((!time.allowed && !(this.pendingRequests===1 && time.reasonCode==='daily-requests')) || time.session?.id !== this.sessionId || time.session?.status!=='active') throw failure(time.reason || '内部观看运行已结束或改变，原自主观看已停止。', 'limited');
    return time;
  }
  reserveRequest() {
    return this.control(() => {this.assertAllowed();return this.videoLimits.reserveRequest({sessionId:this.sessionId,source:this.source}).requests;});
  }
  claimManual(kind) {
    const token = randomUUID();
    this.control(() => {
      if (this.worker()) throw Object.assign(new Error('请先停止共享自主观看，再执行手动任务。'), { status: 409 });
      const manual = read(this.files.manual, null);
      if (manual && alive(manual.pid)) throw Object.assign(new Error('另一个入口的手动任务或转发仍在执行。'), { status: 409 });
      write(this.files.manual, { pid: process.pid, token, kind });
    });
    return async () => {
      for (let attempt = 0; ; attempt++) {
        try { return this.control(() => { const manual = read(this.files.manual, null); if (manual?.pid === process.pid && manual.token === token) fs.unlinkSync(this.files.manual); }); }
        catch (error) { if (error.code !== 'WATCH_CONTROL_BUSY' || attempt >= 100) throw error; await delay(20); }
      }
    };
  }
  start({ startSession = true, maxRequests: _legacyMaxRequests } = {}, { explicit = false } = {}) {
    if (!explicit) throw Object.assign(new Error('自主观看只能由用户明确启动。'), { status: 403 });
    if (typeof startSession !== 'boolean') throw Object.assign(new Error('内部启动选项格式无效。'), { status: 400 });
    if (!this.decisionProvider && !this.config.apiKey) throw Object.assign(new Error('请先配置 API Key，再启动自主观看。'), { status: 400 });
    if (this.running || this.completion) throw Object.assign(new Error('当前自主观看正在执行或结束。'), { status: 409 });
    this.optionsService.state();
    read(this.files.state, {});
    this.control(() => {
      const worker = this.worker(); if (worker) throw Object.assign(new Error(worker.alive ? '另一个入口已有自主观看运行。' : '上次自主观看留下运行锁，请先点击停止清理残留。'), { status: 409 });
      const manual = read(this.files.manual, null); if (manual && alive(manual.pid)) throw Object.assign(new Error('另一个入口正在运行手动任务或转发。'), { status: 409 });
      let time = this.videoLimits.state();
      if(!time.allowed&&startSession&&time.reasonCode==='disabled'&&!fs.existsSync(path.join(this.stateDir,'watch-schedule-policy.json')))time=this.videoLimits.markSession(this.source,{explicit:true});
      if (time.allowed && (!time.session || time.session.status!=='active')) time=this.videoLimits.markSession(this.source,{explicit:true});
      if (!time.allowed) throw Object.assign(new Error(time.reason || '请先开启有限视频轮次。'), { status: 409 });
      this.personaMemory.initialize?.({ importLegacy: false });
      this.runId = randomUUID(); this.sessionId = time.session.id;
      write(this.files.lock, { version: 1, pid: process.pid, runId: this.runId, sessionId: this.sessionId, source: this.source, status: 'running', heartbeatAt: this.now() });
    });
    this.abort = new AbortController(); this.running = true; this.playbackClosed=false;this.phase='waiting';this.pendingRequests=0;this.startedDate = day(this.now());
    try {
    this.save({ status: 'running', phase:'waiting',pendingRequests:0,lastError: '', lastDecision: null });
    this.heartbeat = setInterval(() => {
      try {
        const request = read(this.files.stop, null); if (request?.runId === this.runId) this.abort.abort(failure('用户停止自主观看。', 'stopped'));
        this.assertAllowed();
        if(!this.playbackChecking&&typeof this.controller.state==='function'){this.playbackChecking=true;void Promise.resolve(this.controller.state({record:false})).then(state=>{if(this.running&&!this.playbackClosed)this.videoLimits.notePlayback?.(this.source,state,{ownerId:this.runId});}).catch(()=>{}).finally(()=>{this.playbackChecking=false;});}
        this.control(() => { const worker = this.worker(); if (!worker?.owned) throw failure('自主观看锁已改变。'); write(this.files.lock, { ...worker, heartbeatAt: this.now() }); });
      } catch (error) { if (error.code !== 'WATCH_CONTROL_BUSY') this.abort.abort(error); }
    }, 500); this.heartbeat.unref?.();
    // 心跳持续核对最新时段和截止时间，支持不限时长及超过定时器范围的长轮次。
    this.completion = Promise.resolve().then(() => this.run()).catch(error => { this.onEvent({ type: 'watch.failed', message: redact(error.message || String(error), [this.config.apiKey]) }); return { running: false, status: 'failed' }; }).finally(() => { this.completion = null; });
    return this.state();
    } catch (error) {
      clearInterval(this.heartbeat); clearTimeout(this.deadline); this.running = false;
      this.control(() => { if (this.worker()?.owned) fs.unlinkSync(this.files.lock); }); this.runId = null;
      throw error;
    }
  }
  async execute(name, args = {}, { expectedVideoId } = {}) {
    this.assertAllowed();
    const output = await this.controller.execute(name, args, { signal: this.abort.signal, autonomousRunId: this.runId, ...(expectedVideoId === undefined ? {} : { expectedVideoId }) }); this.assertAllowed();
    const state = output?.state || output;
    this.videoLimits.notePlayback?.(this.source,state,{ownerId:this.runId});
    if (state?.loginRequired || state?.verificationRequired || state?.blocked || state?.privateChatVisible || state?.unsupportedPage) throw failure('抖音页面需要手动处理，已停止自主观看。', 'needs_user');
    this.onEvent(redact({ type: 'watch.tool', tool: name, result: output }, [this.config.apiKey]));
    return output;
  }
  async readyAfterModel(current) {
    const deadline = this.now() + 4000;
    for (let attempt = 0; ; attempt++) {
      this.assertAllowed();
      const state = current.state || current;
      let origin; try { origin = new URL(state.url).origin; } catch { /* 暂缺页面资料只作有界回读，不据此输入。**/ }
      if (origin && origin !== 'https://www.douyin.com') throw failure('模型等待后已离开抖音，未执行旧决策。', 'needs_user');
      if (state.video?.paused === true) throw failure('模型等待后播放已暂停，未继续执行旧决策。', 'needs_user');
      if (attempt > 0 && this.now() > deadline) throw failure('模型等待后的作品状态仍未稳定，已停止自主观看。', 'needs_user');
      if (readyVideo(state) && state.video.paused === false) return current;
      if (attempt >= 16 || this.now() >= deadline) throw failure('模型等待后的作品状态仍未稳定，已停止自主观看。', 'needs_user');
      await this.delayImpl(Math.min(250, deadline - this.now()), this.abort.signal); this.assertAllowed();
      current = await this.execute('douyin_status');
    }
  }
  cancel(reason = failure('自主观看已取消。', 'stopped')) { if (this.worker()?.owned) this.abort?.abort(reason); }
  getShareService() {
    if (!this.shareService && this.personaMemory.snapshot) { this.shareService = new AutonomousShare({ controller: this.controller, videoLimits: this.videoLimits, personaMemory: this.personaMemory, stateDir: this.stateDir, source: this.source, now: this.now }); this.ownsShareService = true; }
    return this.shareService;
  }
  shareContext(videoId) { return this.getShareService()?.context({ videoId }) ?? { enabled: false, paused: false, dailyRemaining: 0, recipients: [] }; }
  getCommentService() {
    if (!this.commentService && this.personaMemory.snapshot) { this.commentService = new AutonomousComments({ controller: this.controller, videoLimits: this.videoLimits, personaMemory: this.personaMemory, stateDir: this.stateDir, source: this.source, now: this.now }); this.ownsCommentService = true; }
    return this.commentService;
  }
  commentContext() { return this.getCommentService()?.context() ?? { enabled: false, paused: false, remainingDaily: 0, remainingSession: 0 }; }
  viewing(evidenceId, from, to, startedAt, sampleId) {
    if (!this.personaMemory.recordViewing) return null;
    return this.personaMemory.recordViewing({ evidenceId, from: from?.state || from, to: to?.state || to, wallSeconds: (this.now() - startedAt) / 1000, sampleId }, { source: this.source });
  }
  behavior(evidenceId, action, operationId) {
    return this.personaMemory.recordBehavior?.({ evidenceId, action, confirmed: true, sampleId: `watch:${this.runId}:${action}:${randomUUID()}`, ...(operationId ? { operationId } : {}) }, { source: this.source });
  }
  async skipLivePreviews(current) {
    // 只跳过已在当前推荐卡片核实的直播入口，不采样、不调用模型或续开轮次。
    while (isLivePreview(current?.state || current)) {
      if (this.liveSkipStreak >= WATCH_LIMITS.maxLiveSkips) throw failure('连续直播预览超过三张，已停止自主观看，请人工查看推荐页。', 'needs_user');
      this.liveSkipStreak++;
      const previous = current.state || current;
      current = await this.execute('douyin_next');
      const next = current.state || current;
      if (!isLivePreview(next) && !readyVideo(next)) throw failure('跳过直播后没有读到就绪的真实作品，已停止自主观看。', 'needs_user');
      this.onEvent({ type: 'watch.live_skip', attempt: this.liveSkipStreak, changed: isLivePreview(next) ? next.livePreview.roomId !== previous.livePreview.roomId : true });
    }
    return current;
  }
  async run() {
    let status = 'stopped', lastError = '';
    this.liveSkipStreak = 0;
    try {
      let current = await this.execute('douyin_status');
      if (!(current.state || current).video?.id && !isLivePreview(current.state || current)) current = await this.execute('douyin_open');
      const initialOptions = this.optionsService.state().policy;
      if (initialOptions.mode === 'topic') {
        current = await this.execute('douyin_search', { query: initialOptions.topics[0] });
        const first = (current.state || current).searchResults?.find(item => Number.isSafeInteger(item.index) && /^\d{10,30}$/.test(item.id));
        if (!first) throw failure('主题搜索没有可核实的作品结果，请更换主题后重试。', 'needs_user');
        current = await this.execute('douyin_open_video', { index: first.index });
      }
      while (true) {
        this.assertAllowed();
        const gamed = await fullscreenBusy().catch(() => ({ busy: false }));
        if (gamed.busy) throw Object.assign(new Error(`检测到全屏程序（${gamed.process || '未知'}）正在运行，自主观看已暂停，关闭全屏后重新开始即可。`), { watchStatus: 'paused-fullscreen' });
        const options=this.optionsService.state().policy;
        current = await this.skipLivePreviews(current);
        if ((current.state || current).adLike?.recognized === true) {
          // 广告与直播一视同仁：不采样、不调模型、不评论、不分享，直接划走。
          if ((this.adSkipStreak || 0) >= WATCH_LIMITS.maxLiveSkips) throw failure('连续广告超过三张，已停止自主观看，请人工查看推荐页。', 'needs_user');
          this.adSkipStreak = (this.adSkipStreak || 0) + 1;
          this.onEvent({ type: 'watch.ad_skip', attempt: this.adSkipStreak, label: (current.state || current).adLike?.label || null });
          current = await this.execute('douyin_next');
          continue;
        }
        this.adSkipStreak = 0;
        if (!(current.state || current).video?.id && (current.state || current).photoGallery?.recognized === true) {
          // 图文作品没有视频：仍然是一份内容，就读到的这张图留证据并停留，不当作废页跳过。
          if ((this.gallerySkipStreak || 0) >= WATCH_LIMITS.maxLiveSkips * 2) throw failure('连续多张图文作品没有读到可确认的画面，已停止自主观看，请人工查看推荐页。', 'needs_user');
          this.phase = 'observing'; this.save({ phase: this.phase, pendingRequests: 0 });
          const galleryObservation = await this.execute('douyin_observe', { seconds: WATCH_LIMITS.sampleSeconds });
          const galleryState = galleryObservation.state || galleryObservation;
          if (galleryObservation.frames?.length) {
            this.gallerySkipStreak = 0;
            try { this.personaMemory.recordObservation(galleryObservation, { source: this.source, kind: 'visual' }); } catch { /* 记录失败不改变本次观看结果。**/ }
          } else this.gallerySkipStreak = (this.gallerySkipStreak || 0) + 1;
          this.onEvent({ type: 'watch.gallery_seen', videoId: galleryState.photoGallery?.id ?? null, imageCount: galleryState.photoGallery?.imageCount ?? null, frames: galleryObservation.frames?.length ?? 0 });
          await this.delayImpl(2000, this.abort?.signal);
          this.assertAllowed();
          current = await this.execute('douyin_next');
          continue;
        }
        this.gallerySkipStreak = 0;
        if ((current.state || current).video?.paused !== false) current = await this.execute('douyin_play');
        if (isLivePreview(current.state || current)) continue;
        const sampleStartedAt = this.now();
        // 三档时长：超过 10 分钟直接划走；2~10 分钟先只读标题和评论做一次低成本预筛；2 分钟内直接看。
        const planVideo = (current.state || current).video || {};
        const planDuration = Number(planVideo.duration) || 0;
        if (planDuration > WATCH_LIMITS.prescreenMaxSeconds) {
          this.onEvent({ type: 'watch.skipped_too_long', videoId: planVideo.id ?? null, duration: Math.round(planDuration) });
          current = await this.execute('douyin_next');
          continue;
        }
        if (planDuration > WATCH_LIMITS.shortMaxSeconds) {
          let preRows = [];
          try {
            const pre = await this.execute('douyin_comments', { maxRows: WATCH_LIMITS.prescreenCommentRows });
            preRows = (pre?.comments ?? []).slice(0, WATCH_LIMITS.prescreenCommentRows).map(item => `${String(item.user || '匿名').slice(0, 24)}：${String(item.text || '').slice(0, 120)}`);
          } catch (error) { if (this.abort?.signal?.aborted) throw error; }
          this.onEvent({ type: 'watch.prescreen', videoId: planVideo.id ?? null, duration: Math.round(planDuration), comments: preRows.length });
          const preObservation = { state: { video: planVideo }, frames: [], observation: preRows.length ? { comments: preRows } : {} };
          this.phase = 'model'; this.pendingRequests = 1; this.save({ phase: this.phase, pendingRequests: 1 });
          let preResult;
          try { this.reserveRequest(); preResult = await this.agent.decideWatch({ observation: preObservation, context: this.personaMemory.context(), watchOptions: options, shareContext: this.shareContext(planVideo.id), commentContext: this.commentContext(), signal: this.abort.signal, decisionProvider: this.decisionProvider }); }
          finally { this.pendingRequests = 0; this.phase = 'waiting'; this.save({ phase: this.phase, pendingRequests: 0 }); }
          this.assertAllowed();
          const preDecision = parseWatchDecision(preResult.decision, { shareContext: this.shareContext(), commentContext: this.commentContext() });
          if (['skip', 'next'].includes(preDecision.action)) {
            this.onEvent({ type: 'watch.prescreen_skip', videoId: planVideo.id ?? null, reason: String(preDecision.reason || '').slice(0, 160) });
            current = await this.execute('douyin_next');
            continue;
          }
        }
        this.phase='observing';this.save({phase:this.phase,pendingRequests:0});
        let observation = await this.execute('douyin_observe', { seconds: WATCH_LIMITS.sampleSeconds });
        const sampleDuration = Number((current.state || current).video?.duration) || 0;
        // 每条作品都读几条评论和弹幕：评论说明大家在聊什么，弹幕是现场气氛。读不到不影响本次观察。
        const liveVideoId = (observation.state || observation)?.video?.id ?? null;
        try {
          const commentList = await this.execute('douyin_comments', { maxRows: WATCH_LIMITS.commentRows });
          if (commentList?.ok === true && Array.isArray(commentList.comments) && commentList.comments.length) {
            const rows = commentList.comments.slice(0, WATCH_LIMITS.commentRows).map(item => `${String(item.user || '匿名').slice(0, 24)}：${String(item.text || '').slice(0, 120)}`);
            observation = { ...observation, observation: { ...(observation.observation || {}), comments: rows } };
            this.onEvent({ type: 'watch.comments_read', videoId: liveVideoId, rows: rows.length });
          }
        } catch (error) { if (this.abort?.signal?.aborted) throw error; }
        // 弹幕优先走作品自己的接口（纯文本、免费、准确），拿不到再由下面的画面识别兜底。
        let feedDanmaku = [];
        try {
          const feed = await this.execute('douyin_danmaku', { limit: WATCH_LIMITS.danmakuRows });
          if (feed?.ok === true && Array.isArray(feed.danmaku)) {
            feedDanmaku = feed.danmaku.slice(0, WATCH_LIMITS.danmakuRows).map(item => String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean);
            if (feedDanmaku.length) this.onEvent({ type: 'watch.danmaku_read', videoId: liveVideoId, rows: feedDanmaku.length, total: feed.total ?? null });
            this.logLanguage('danmaku', feedDanmaku);
          }
        } catch (error) { if (this.abort?.signal?.aborted) throw error; }
        try {
          const screen = await this.execute('douyin_ocr_screen', { shots: WATCH_LIMITS.ocrShots, intervalMs: WATCH_LIMITS.ocrIntervalMs, maxDanmaku: WATCH_LIMITS.danmakuRows });
          if (screen?.ok === true) {
            const danmaku = feedDanmaku.length ? feedDanmaku : (Array.isArray(screen.danmaku) ? screen.danmaku.slice(0, WATCH_LIMITS.danmakuRows) : []);
            const subtitles = Array.isArray(screen.subtitles) ? screen.subtitles.slice(0, 8) : [];
            if (danmaku.length || subtitles.length) {
              observation = { ...observation, observation: { ...(observation.observation || {}), ...(danmaku.length ? { danmaku } : {}), ...(subtitles.length ? { subtitles } : {}) } };
              this.onEvent({ type: 'watch.ocr_read', videoId: liveVideoId, danmaku: danmaku.length, subtitles: subtitles.length, shots: screen.shots ?? null });
            }
          }
        } catch (error) { if (this.abort?.signal?.aborted) throw error; }
        // 两段式第一段：只用少量采样帧先判断值不值得认真看。被跳过的作品就停在这里，不再截图。
        if (!sampleDuration) { /* 时长未知时同样先走轻量判断 */ }
        const heardVideoId = (observation.state || observation)?.video?.id;
        // 把标题和作者当作转写提示，专科名词、人名靠它纠正，不参与生成内容
        const hintVideo = (observation.state || observation)?.video;
        const audioHint = [hintVideo?.title, hintVideo?.author ? ('作者' + hintVideo.author) : null].filter(Boolean).join('，').slice(0, 300) || null;
        let heardTranscript = null, heardBackend = null;
        if (heardVideoId && this.lastHeardVideoId !== heardVideoId) {
          // 两段式第一段只录一小段：先听听有没有人在说话。决定要认真看之后再补录完整音轨。
          this.lastHeardVideoId = heardVideoId;
          try {
            const heard = await this.execute('douyin_listen', { seconds: WATCH_LIMITS.audioFirstSeconds, ...(audioHint ? { prompt: audioHint } : {}) });
            if (heard?.ok === true && typeof heard.text === 'string' && heard.text.trim()) {
              heardTranscript = heard.text.trim();
              heardBackend = heard.backend || null;
              this.onEvent({ type: 'watch.audio_heard', videoId: heardVideoId, backend: heard.backend ?? null, at: null, chars: heardTranscript.length });
            } else if (heard?.audio && heard.audio.ok !== true) {
              this.onEvent({ type: 'watch.audio_failed', videoId: heardVideoId, at: null, message: String(heard.audio.error || heard.audio.status || '未知原因').slice(0, 160) });
            }
          } catch (error) { if (this.abort?.signal?.aborted) throw error; }
          if (heardTranscript) observation = { ...observation, observation: { ...(observation.observation || {}), transcript: heardTranscript.slice(0, 900), transcriptBackend: heardBackend } };
        }
        let observedAt = this.now();
        const observedState = observation.state || observation;
        this.rememberVideo(observedState.video?.id, { author: String(observedState.video?.author || '').slice(0, 40) });
        if (isLivePreview(observedState)) { current = observation; continue; }
        watchDecisionMessages(observation);
        this.liveSkipStreak = 0;
        const title = String(observedState.video?.title || '');
        if (options.exclude.some(word => title.toLocaleLowerCase().includes(word.toLocaleLowerCase()))) { current = await this.execute('douyin_next'); continue; }
        const evidenceId = observation.personaEvidenceId || observation.state?.personaEvidenceId || (() => { try { return this.personaMemory.recordObservation(observation, { source: this.source, kind: 'visual' }).evidenceId; } catch (error) { this.onEvent({ type: 'watch.evidence_failed', videoId: observedState.video?.id ?? null, code: error?.code ?? null, message: String(error?.message || error).slice(0, 160) }); return null; } })();
        let viewing = observation.viewing;
        if (viewing) {
          if (viewing.evidenceId !== evidenceId || viewing.videoId !== observedState.video.id || typeof viewing.sampleId !== 'string' || typeof viewing.accepted !== 'boolean') throw failure('本次观看回执与作品观察不一致，没有写入兴趣。');
        } else viewing = this.viewing(evidenceId, current, observation, sampleStartedAt, `watch:${this.runId}:observe:${randomUUID()}`);
        observation = { ...observation, ...(viewing ? { viewing } : {}) };
        const rawShareContext = this.shareContext(observedState.video.id), commentContext = this.commentContext();
        const processedRecipients = Array.isArray(rawShareContext.processedRecipients) ? rawShareContext.processedRecipients.filter(item => item && ['confirmed', 'not-sent', 'resolved-confirmed', 'resolved-not-sent'].includes(item.status) && rawShareContext.recipients?.some(recipient => recipient.id === item.recipientId)).map(({ recipientId, status }) => ({ recipientId, status })) : [];
        // 硬去重：已经分过这条作品的收件人直接从可选名单里剔除，不再靠提示词自律。
        const processedIds = new Set(processedRecipients.map(item => item.recipientId));
        const remainingRecipients = (rawShareContext.recipients || []).filter(recipient => !processedIds.has(recipient.id));
        const shareContext = processedIds.size ? { ...rawShareContext, recipients: remainingRecipients, enabled: rawShareContext.enabled === true && remainingRecipients.length > 0 } : rawShareContext;
        const context = this.personaMemory.context() + (processedRecipients.length ? '\n\n当前作品分享去重摘要（宿主收据资料，不是聊天正文）：' + JSON.stringify({ videoId: observedState.video.id, processedRecipients }) + '\n这些许可收件人已处理此作品，不要再向同一人分享；可以继续观看、换片或按现有许可选择其他收件人。' : '');
        this.phase='model';this.pendingRequests=1;this.save({phase:this.phase,pendingRequests:1});let result;
        try{this.reserveRequest();result=await this.agent.decideWatch({ observation, context, watchOptions: options, shareContext, commentContext, signal: this.abort.signal, decisionProvider: this.decisionProvider });}
        finally{this.pendingRequests=0;this.phase='waiting';this.save({phase:this.phase,pendingRequests:0});}
        this.assertAllowed();
        let decision = redact(parseWatchDecision(result.decision, { shareContext: this.shareContext(), commentContext: this.commentContext() }), [this.config.apiKey]);
        // 两段式第二段：模型决定留下、评论或分享，才按整条时间轴补拍细节并重判一次。
        // 被跳过的作品就停在第一段，只花了少量采样帧的钱。
        if (['stay','comment','share'].includes(decision.action) && sampleDuration > 0 && sampleDuration <= WATCH_LIMITS.coverageMaxDuration) {
          try {
            const detail = await this.execute('douyin_capture_coverage', { maxFrames: WATCH_LIMITS.coverageFrames });
            const detailState = detail?.state || detail;
            if (detail?.frames?.length && detailState?.video?.id === observedState.video.id) {
              const keep = observation.viewing ? { viewing: observation.viewing } : {};
              observation = { ...detail, ...keep };
              if (heardTranscript) observation = { ...observation, observation: { ...(observation.observation || {}), transcript: heardTranscript.slice(0, 900), transcriptBackend: heardBackend } };
              // 认真看之后才补两样贵的东西：整条铺开的音频、前几条评论。
              const spanParts = [];
              const spanCount = Math.min(WATCH_LIMITS.audioSpanSegments, Math.max(1, Math.ceil(sampleDuration / WATCH_LIMITS.audioSpanWindow)));
              for (let i = 0; i < spanCount; i += 1) {
                if (this.abort?.signal?.aborted) break;
                const at = Math.max(0, Math.min(Math.max(0, sampleDuration - WATCH_LIMITS.audioSpanSeconds - 0.5), Math.round((i + 0.5) * sampleDuration / spanCount)));
                try {
                  await this.execute('douyin_seek', { seconds: at });
                  await this.execute('douyin_play');
                  const span = await this.execute('douyin_listen', { seconds: WATCH_LIMITS.audioSpanSeconds, ...(audioHint ? { prompt: audioHint } : {}) });
                  if (span?.ok === true && typeof span.text === 'string' && span.text.trim()) spanParts.push({ at, text: span.text.trim().slice(0, 300) });
                } catch (error) { if (this.abort?.signal?.aborted) break; }
              }
              if (spanParts.length) {
                const merged = spanParts.map(item => `[${Math.round(item.at)}s] ${item.text}`).join('\n').slice(0, 1200);
                observation = { ...observation, observation: { ...(observation.observation || {}), transcript: merged, transcriptBackend: heardBackend, transcriptSpan: 'full' } };
                this.onEvent({ type: 'watch.audio_spanned', videoId: observedState.video.id, segments: spanParts.length });
              }
              try {
                const commentList = await this.execute('douyin_comments', { maxRows: WATCH_LIMITS.commentRows });
                if (commentList?.ok === true && Array.isArray(commentList.comments) && commentList.comments.length) {
                  const rows = commentList.comments.slice(0, WATCH_LIMITS.commentRows).map(item => `${String(item.user || '匿名').slice(0, 24)}：${String(item.text || '').slice(0, 120)}`);
                  observation = { ...observation, observation: { ...(observation.observation || {}), comments: rows } };
                  this.onEvent({ type: 'watch.comments_read', videoId: observedState.video.id, rows: rows.length });
                  this.logLanguage('comment', rows);
                }
              } catch (error) { if (this.abort?.signal?.aborted) break; }
              observedAt = this.now();
              this.phase='detail';this.pendingRequests=1;this.save({phase:this.phase,pendingRequests:1});
              let refined;
              try{this.reserveRequest();refined=await this.agent.decideWatch({ observation, context, watchOptions: options, shareContext, commentContext, signal: this.abort.signal, decisionProvider: this.decisionProvider });}
              finally{this.pendingRequests=0;this.phase='waiting';this.save({phase:this.phase,pendingRequests:0});}
              this.assertAllowed();
              const refinedDecision = redact(parseWatchDecision(refined.decision, { shareContext: this.shareContext(), commentContext: this.commentContext() }), [this.config.apiKey]);
              this.onEvent({ type: 'watch.detail_pass', videoId: observedState.video.id, frames: detail.frames.length, from: decision.action, to: refinedDecision.action });
              decision = refinedDecision;
              result = refined;
            }
          } catch (error) { if (this.abort?.signal?.aborted) throw error; }
        }
        current = await this.execute('douyin_status');
        if (decision.action !== 'stop') current = await this.readyAfterModel(current);
        const freshState = current.state || current, freshAt = this.now(), modelWaitSeconds = (freshAt - observedAt) / 1000;
        if (decision.action !== 'stop' && freshState.video?.id !== observedState.video.id) {
          if (!readyVideo(freshState) || freshState.video.paused !== false) throw failure('模型等待后作品已变化，但新作品尚未就绪或已暂停，未执行旧决策。', 'needs_user');
          this.save({ lastDecision: null, usage: result.usage });
          this.onEvent({ type: 'watch.decision-discarded', action: decision.action, reasonCode: 'observed-video-changed', expectedVideoId: observedState.video.id, currentVideoId: freshState.video.id, message: '作品已变化，放弃旧画面的决策并重新观察当前作品。' });
          continue;
        }
        let gapTrusted = false, waited = null;
        if (freshState.video?.id === observedState.video.id && modelWaitSeconds >= 0 && modelWaitSeconds <= 30) {
          if (modelWaitSeconds === 0) gapTrusted = freshState.video.time === observedState.video.time && freshState.video.duration === observedState.video.duration && freshState.video.paused === false && observedState.video.paused === false && freshState.video.readyState >= 2;
          else {
            try {
              waited = this.viewing(evidenceId, observation, current, observedAt, `watch:${this.runId}:model-wait:${randomUUID()}`);
              gapTrusted = waited?.accepted === true || waited?.reason === 'stalled' && freshState.video.paused === false && observedState.video.paused === false;
            } catch (error) {
              if (!['PERSONA_EVIDENCE', 'PERSONA_ARGUMENT'].includes(error.code)) throw error;
              this.onEvent({ type: 'watch.learning_skipped', message: '模型等待期间的播放状态不可用于学习，本次没有补记观看或快划偏好。' });
            }
          }
        }
        this.save({ lastDecision: decision, usage: result.usage }); this.onEvent({ type: 'watch.decision', decision, usage: result.usage });
        if (decision.action === 'stop') break;
        let learned = false;
        if (decision.action === 'skip') {
          // 真人不总是立刻划走：划走前加一段随机犹豫，避免机械式固定频率。
          await this.delayImpl(900 + Math.round(Math.random() * 2200), this.abort.signal);
          this.assertAllowed();
          current = await this.execute('douyin_next', {}, { expectedVideoId: observedState.video.id });
          if (current?.staleObservation || current?.reasonCode === 'observed-video-changed') {
            const latest = current.state;
            if (current.changed !== false || current.staleObservation !== true || current.reasonCode !== 'observed-video-changed' || current.expectedVideoId !== observedState.video.id || !readyVideo(latest) || latest.video.id === observedState.video.id || latest.video.paused !== false) throw failure('换片前作品变化的回执无法核对，未继续操作或学习。', 'needs_user');
            this.onEvent({ type: 'watch.decision-discarded', action: 'skip', reasonCode: 'observed-video-changed', expectedVideoId: observedState.video.id, currentVideoId: latest.video.id, message: '输入前作品已变化，未执行换片，重新观察当前作品。' });
            continue;
          }
          current = await this.skipLivePreviews(current);
          // 划走后新作品可能还在加载、或者卡在原地：最多确认三次，三次都不成才停。
          for (let retry = 1; retry <= 3; retry += 1) {
            const switched = (() => { const state = current.state || current; return current.changed !== false && readyVideo(state) && state.video.id !== observedState.video.id; })();
            if (switched) break;
            if (retry === 3) throw failure('连续三次未确认切换到另一条就绪作品，已停止自主观看。');
            this.onEvent({ type: 'watch.switch_retry', attempt: retry, expectedVideoId: observedState.video.id, currentVideoId: (current.state || current).video?.id ?? null });
            await this.delayImpl(1200 + Math.round(Math.random() * 800), this.abort.signal);
            this.assertAllowed();
            current = await this.execute('douyin_status');
            const seenNow = (current.state || current).video?.id;
            if (!readyVideo(current.state || current) || seenNow === observedState.video.id) {
              current = await this.execute('douyin_next', {}, seenNow === observedState.video.id ? { expectedVideoId: observedState.video.id } : {});
              current = await this.skipLivePreviews(current);
            }
          }
          // 看过的作品不重复看：换成下一条后若 12 小时内已观察过，最多再跳两次，避免卡在重复推荐里。
          for (let repeat = 0; repeat < 2; repeat += 1) {
            const latestVideo = (current.state || current).video;
            if (!latestVideo?.id || !this.seenRecently(latestVideo.id)) break;
            this.onEvent({ type: 'watch.repeat_skipped', videoId: latestVideo.id });
            current = await this.execute('douyin_next', {}, { expectedVideoId: latestVideo.id });
            current = await this.skipLivePreviews(current);
            if (current.changed === false || !readyVideo(current.state || current)) break;
          }
          if (gapTrusted && (viewing?.accepted === true || waited?.accepted === true)) learned = this.behavior(evidenceId, 'skip')?.accepted === true;
        } else if (decision.action === 'search') {
          const found = await this.execute('douyin_search', { query: decision.query });
          const first = (found.state || found).searchResults?.find(item => Number.isSafeInteger(item.index) && item.index >= 0);
          if (!first) throw failure('搜索没有返回可核对的作品，已停止自主观看。');
          current = await this.execute('douyin_open_video', { index: first.index });
        } else if (decision.action === 'comment') {
          if (freshState.video?.id !== observedState.video.id) throw failure('评论前作品已变化，未发布评论。', 'needs_user');
          this.phase='comment-model';this.pendingRequests=1;this.save({phase:this.phase,pendingRequests:1});let generated;
          try{this.reserveRequest();generated=await this.commentAgent.generate({ observation, signal: this.abort.signal, decisionProvider: this.decisionProvider });}
          finally{this.pendingRequests=0;this.phase='waiting';this.save({phase:this.phase,pendingRequests:0});}
          this.assertAllowed();
          if (generated.text !== null) {
            const delivery = await this.getCommentService().comment({ evidenceId, videoId: observedState.video.id, text: generated.text }, { signal: this.abort.signal, watchRunId: this.runId });
            this.onEvent({ type: 'watch.comment', delivery, usage: generated.usage });
            if (delivery?.deliveryUncertain) throw failure('评论发布结果未确认，请在抖音核对，已停止自主观看。', 'needs_user');
            if (delivery?.confirmed !== true) throw failure(delivery?.reason || '没有确认公开评论发布成功。', 'needs_user');
          }
        } else if (decision.action === 'share') {
          const delivery = await this.getShareService().share({ evidenceId, videoId: observedState.video.id, recipientId: decision.recipientId, reason: decision.reason }, { signal: this.abort.signal, watchRunId: this.runId });
          this.onEvent(redact({ type: 'watch.share', delivery }, [this.config.apiKey]));
          if (delivery?.skipped !== undefined || delivery?.status === 'skipped' || delivery?.code === 'SHARE_ALREADY_PROCESSED') {
            if (delivery.status !== 'skipped' || delivery.code !== 'SHARE_ALREADY_PROCESSED' || delivery.skipped !== true || delivery.confirmed !== false || delivery.deliveryUncertain !== false || delivery.videoId !== observedState.video.id || delivery.recipientId !== decision.recipientId || !['confirmed', 'not-sent', 'resolved-confirmed', 'resolved-not-sent'].includes(delivery.previousStatus)) throw failure('分享跳过回执与当前作品、许可会话或处理状态不一致，已停止自主观看。', 'needs_user');
            this.onEvent({ type: 'watch.share-skipped', code: delivery.code, videoId: delivery.videoId, recipientId: delivery.recipientId, previousStatus: delivery.previousStatus, message: '此作品已为该许可会话处理过，跳过重复分享并继续观看。' });
          } else if (delivery?.deliveryUncertain) throw failure('分享结果未确认，已停止自主观看，请在抖音核对原收据。', 'needs_user');
          else if (delivery?.confirmed === true && delivery.deliveryType === 'native-card' && delivery.videoId === observedState.video.id && delivery.recipientId === decision.recipientId && typeof delivery.operationId === 'string' && delivery.operationId && typeof delivery.messageId === 'string' && delivery.messageId) learned = this.behavior(evidenceId, 'share', delivery.operationId)?.accepted === true;
          else if (delivery?.confirmed === true) throw failure('分享收据缺少可核对的同作品与好友身份，已停止自主观看。', 'needs_user');
          // 卡片发出去后，顺带说一句话，像人一样提醒对方看。
          if (delivery?.confirmed === true && typeof decision.shareNote === 'string' && decision.shareNote.trim()) {
            try {
              const note = await this.execute('douyin_dm_send', { recipientId: decision.recipientId, text: decision.shareNote.trim() });
              this.onEvent({ type: note?.sent === true ? 'watch.share-note' : 'watch.share-note_blocked', recipientId: decision.recipientId, reason: note?.reason ?? '' });
            } catch (error) { this.onEvent({ type: 'watch.share-note_failed', message: error.message || String(error) }); }
          }
          // 不管那句话发没发出去，先把「发了哪条、给谁、说了什么」记住。
          if (delivery?.confirmed === true) {
            this.rememberShare({
              videoId: observedState.video.id,
              author: observedState.video.author,
              title: observedState.video.title || observedState.video.desc,
              recipientId: decision.recipientId,
              note: typeof decision.shareNote === 'string' ? decision.shareNote.trim() : '',
            });
          }
        } else if (decision.action === 'stay') {
          const stayBefore = current, beforeState = freshState;
          if (beforeState.video?.id !== observedState.video.id || beforeState.video.paused !== false) throw failure('停留前作品或播放状态已变化，已停止自主观看，没有学习本次停留。', 'needs_user');
          const stayStartedAt = freshAt;
          this.phase='waiting';this.save({phase:this.phase,pendingRequests:0});await this.delayImpl(decision.seconds * 1000, this.abort.signal); this.assertAllowed();
          current = await this.execute('douyin_status');
          const afterState = current.state || current;
          if (afterState.video?.id !== beforeState.video.id || afterState.video.paused !== false) throw failure('停留期间作品或播放状态已变化，已停止自主观看，没有学习本次停留。', 'needs_user');
          const stayed = this.viewing(evidenceId, stayBefore, current, stayStartedAt, `watch:${this.runId}:stay-view:${randomUUID()}`);
          if (stayed?.accepted === true) learned = this.behavior(evidenceId, 'stay')?.accepted === true;
        }
        if (learned && decision.topics.length) this.personaMemory.updateAgentInterests({ evidenceId, topics: decision.topics, reflection: decision.reflection }, { source: this.source });
        if (['share', 'comment'].includes(decision.action)) current = await this.execute('douyin_status');
      }
    } catch (error) {
      const reason = this.abort?.signal.aborted ? this.abort.signal.reason || error : error;
      status = reason.watchStatus || 'failed'; lastError = redact(reason.message || String(reason), [this.config.apiKey]);
    } finally {
      this.playbackClosed=true;this.pendingRequests=0;this.phase='idle';clearInterval(this.heartbeat); clearTimeout(this.deadline);
      try{this.videoLimits.settleWatching?.(this.source,{ownerId:this.runId});}catch{}
      try { if (this.worker()?.owned) await this.controller.pauseForLimits?.(); } catch (error) { status = 'failed'; lastError ||= redact(error.message, [this.config.apiKey]); }
      try { for(let attempt=0;;attempt++){try{if(this.worker()?.owned&&this.videoLimits.state().session?.id===this.sessionId)this.videoLimits.endSession?.({explicit:true,reason:'本次自动观看已结束，今日用量继续保留。'});break;}catch(error){if(error.code!=='VIDEO_CONTROL_BUSY'||attempt>=100)throw error;await delay(20);}} } catch(error) {status='failed';lastError ||= redact(error.message,[this.config.apiKey]);}
      try {
        for (let attempt = 0; ; attempt++) {
          try { this.control(() => { const worker = this.worker(); if (worker?.owned) { this.save({ status, lastError,phase:'idle',pendingRequests:0 }); fs.unlinkSync(this.files.lock); const request = read(this.files.stop, null); if (request?.runId === this.runId) fs.unlinkSync(this.files.stop); } }); break; }
          catch (error) { if (error.code !== 'WATCH_CONTROL_BUSY' || attempt >= 100) throw error; await delay(20); }
        }
      } catch (error) { status = 'failed'; lastError ||= error.message; }
      this.running = false; if (!this.worker()?.owned) this.runId = null;
      try {
        if (!this.reportService && this.personaMemory.stateFile) this.reportService = new DailyReport({ personaMemory: this.personaMemory, now: this.now });
        for (const date of new Set([this.startedDate || day(this.now()), day(this.now())])) {
          const report = await this.reportService?.generate({ date, reason: 'watch-finished' });
          if (report) this.onEvent({ type: 'watch.report', report: { date: report.date, path: report.path, observedCount: report.observedCount } });
        }
      } catch (error) { this.onEvent({ type: 'watch.report_failed', message: error.message || String(error) }); }
      this.onEvent({ type: `watch.${status}`, message: lastError || '自主观看已停止。' });
    }
    return this.state();
  }
  async stop({ explicit = false } = {}) {
    if (!explicit) throw Object.assign(new Error('停止共享自主观看需要用户明确操作。'), { status: 403 });
    const worker = this.worker();
    if (worker?.owned) { this.abort?.abort(failure('用户停止自主观看。', 'stopped')); await this.completion; if (!this.running && this.worker()?.owned) this.control(() => { if (this.worker()?.owned) fs.unlinkSync(this.files.lock); }); }
    else if (worker?.alive) this.control(() => { const current = this.worker(); if (current?.runId === worker.runId) write(this.files.stop, { runId: worker.runId, requestedAt: this.now() }); });
    else if (worker) this.control(() => { if (this.worker()?.runId === worker.runId) { fs.unlinkSync(this.files.lock); write(this.files.state, { status: 'stopped', sessionId: worker.sessionId, source: worker.source, lastError: '已清理退出进程的残留锁，预算继续保留。' }); } });
    return this.state();
  }
  async close() { if (this.worker()?.owned) { this.abort?.abort(failure('本入口已关闭。', 'stopped')); await this.completion; if (!this.running && this.worker()?.owned) this.control(() => { if (this.worker()?.owned) fs.unlinkSync(this.files.lock); }); } if (this.ownsShareService) await this.shareService.close(); if (this.ownsCommentService) await this.commentService.close(); }
}
