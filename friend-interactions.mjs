import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { acquireFriendInteractionDispatch } from './friend-interactions-guard.mjs';

const defaults = () => ({ version: 1, enabled: true });
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const active = value => Boolean(value?.running || value?.starting || value?.busy || value?.worker?.alive);
const workerKey = value => value?.worker ? `${value.worker.pid}:${value.worker.runId}` : active(value) ? 'local-active' : '';
const explain = error => String(error?.message || '好友互动暂未就绪，请查看自检。').replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [凭据已隐藏]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[凭据已隐藏]').slice(0, 600);

// 复用既有回复与作品分享服务；总开关不改名单、收据、旧消息基线或预算。
export class FriendInteractions {
  constructor({ stateDir = resolveRuntimePaths().stateDir, getChat, getShare, getSpark, modelReady = () => false, startChat = (chat, { signal }) => chat.start({ schedule: true, signal }), intervalMs = 3000 } = {}) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || typeof getChat !== 'function' || typeof getShare !== 'function' || getSpark !== undefined && typeof getSpark !== 'function' || typeof modelReady !== 'function' || typeof startChat !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 10) throw new TypeError('好友互动需要本机状态目录、现有服务及有效检查间隔。');
    Object.assign(this, { stateDir, getChat, getShare, getSpark, modelReady, startChat, intervalMs });
    this.policyFile = path.join(stateDir, 'friend-interactions-policy.json');
    this.settingsGuard = path.join(stateDir, 'friend-interactions-settings.guard');
    this.timer = null; this.closed = false; this.inflight = null; this.rerun = false; this.startAbort = null;
    this.chat = null; this.share = null; this.spark = null; this.lastError = ''; this.status = 'waiting'; this.lastCheckedAt = null;
    this.chatStopKey = ''; this.sparkStopKey = '';
  }
  policy() {
    let value;
    try { value = JSON.parse(fs.readFileSync(this.policyFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return defaults(); throw fail('好友互动总开关记录损坏，已阻止自动启动。'); }
    if (!value || value.version !== 1 || typeof value.enabled !== 'boolean' || Object.keys(value).some(key => !['version', 'enabled'].includes(key))) throw fail('好友互动总开关记录损坏，已阻止自动启动。');
    return { version: 1, enabled: value.enabled };
  }
  abortStart() { this.startAbort?.abort(fail('好友互动总开关已关闭或入口已退出。')); }
  checkRevocation() {
    let enabled = false;
    try { enabled = this.policy().enabled; } catch { /* 损坏记录按关闭处理，不覆盖原文件。 */ }
    const settings = fs.existsSync(this.settingsGuard);
    if (this.closed || !enabled || settings) this.abortStart();
    return !this.closed && enabled && !settings;
  }
  state() {
    let policy, error = this.lastError, chat, share;
    try { policy = this.policy(); } catch (failure) { policy = { version: 1, enabled: false }; error = explain(failure); }
    try { chat = this.chat?.state(); share = this.share?.state(); } catch (failure) { error ||= explain(failure); }
    const running = active(chat);
    return {
      protocol: 'friend-interactions-v1', policy, enabled: policy.enabled, replyRunning: running, replyStarting: Boolean(chat?.starting),
      shareEnabled: share?.enabled === true, selectedCount: chat?.policy?.allowlist?.length || 0,
      status: this.closed ? 'closed' : error ? 'blocked' : !policy.enabled ? running || share?.enabled ? 'stopping' : 'disabled' : fs.existsSync(this.settingsGuard) ? 'waiting-settings' : this.status,
      lastError: error, lastCheckedAt: this.lastCheckedAt, checking: Boolean(this.inflight),
    };
  }
  async configure(input = {}, { explicit = false } = {}) {
    if (!explicit) throw fail('好友互动总开关只能由本人修改。', 403);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'enabled') || typeof input.enabled !== 'boolean') throw fail('好友互动只接受启用开关。', 400);
    if (this.closed) throw fail('好友互动入口已关闭。');
    const release = acquireFriendInteractionDispatch(this.stateDir);
    try {
      const current = this.policy();
      if (!fs.existsSync(this.policyFile) || current.enabled !== input.enabled) {
        const temporary = `${this.policyFile}.${randomUUID()}.tmp`;
        try { fs.writeFileSync(temporary, JSON.stringify({ version: 1, enabled: input.enabled }) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, this.policyFile); }
        finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      }
      if (!input.enabled) this.abortStart();
    } finally { release(); }
    if (!input.enabled) {
      const chat = await this.getChat();
      if (!this.policy().enabled) await chat?.stop?.({ preservePending: false, reason: 'user-stop' });
    }
    return this.reconcile();
  }
  start() {
    if (this.closed) return Promise.resolve(this.state());
    if (!this.timer) { this.timer = setInterval(() => { void this.reconcile(); }, this.intervalMs); this.timer.unref?.(); }
    return this.reconcile();
  }
  reconcile() {
    this.checkRevocation();
    if (this.closed) return Promise.resolve(this.state());
    this.rerun = true;
    if (this.inflight) return this.inflight.then(() => this.state());
    this.inflight = (async () => {
      while (this.rerun && !this.closed) {
        this.rerun = false;
        try { await this.apply(); } catch (error) { this.lastError = explain(error); this.status = 'blocked'; }
        this.lastCheckedAt = new Date().toISOString();
      }
    })().finally(() => { this.inflight = null; });
    return this.inflight.then(() => this.state());
  }
  async services() {
    const [chat, share, spark] = await Promise.all([this.getChat(), this.getShare(), this.getSpark?.()]);
    this.chat = chat; this.share = share; this.spark = spark;
    return Boolean(chat?.state && chat?.start && chat?.stop && share?.state && share?.configure);
  }
  async retireSpark() {
    if (!this.spark) return;
    const state = this.spark.state(), key = workerKey(state);
    if (active(state) && key !== this.sparkStopKey) { await this.spark.stop({ explicit: true }); this.sparkStopKey = key; }
    if (state.enabled || state.policy?.enabled) await this.spark.configure({ enabled: false }, { explicit: true });
  }
  async disable() {
    if (this.closed) return;
    let enabled = false; try { enabled = this.policy().enabled; } catch { /* 损坏总开关停止外发，但不覆盖记录。 */ }
    if (enabled) { if (!fs.existsSync(this.settingsGuard)) this.rerun = true; this.status = fs.existsSync(this.settingsGuard) ? 'waiting-settings' : 'waiting'; return; }
    this.abortStart();
    const errors = [];
    const chatState = this.chat.state(), key = workerKey(chatState);
    if (active(chatState) && key !== this.chatStopKey) {
      try { await this.chat.stop(); this.chatStopKey = key; } catch (error) { errors.push(error); }
    }
    try { if (!this.closed && !this.checkRevocation() && this.share.state().enabled) await this.share.configure({ enabled: false }, { explicit: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw errors[0];
    this.status = active(this.chat.state()) || this.share.state().enabled ? 'stopping' : 'disabled';
  }
  async apply() {
    const ready = await this.services();
    if (this.closed) return;
    let sparkError;
    try { await this.retireSpark(); } catch (error) { sparkError = error; }
    if (!ready) { if (sparkError) throw sparkError; this.status = 'waiting-modules'; this.lastError = ''; return; }
    if (fs.existsSync(this.settingsGuard)) { this.abortStart(); this.status = 'waiting-settings'; this.lastError = ''; return; }
    let policy, policyError;
    try { policy = this.policy(); } catch (error) { policyError = error; policy = { enabled: false }; }
    if (!policy.enabled) {
      await this.disable();
      if (policyError || sparkError) throw policyError || sparkError;
      this.lastError = ''; return;
    }
    if (sparkError) throw sparkError;
    if (!this.checkRevocation()) { await this.disable(); return; }
    this.chatStopKey = '';
    const chatState = this.chat.state();
    if (!chatState.policy?.allowlist?.length) { this.status = 'waiting-contacts'; this.lastError = ''; return; }
    if (!active(chatState) && chatState.contacts?.some(item => ['inflight', 'delivery-uncertain'].includes(item.status))) throw fail('好友互动有未确认发送，请先核对原收据；不会重置或重发。');
    if (!this.share.state().enabled) {
      await this.share.configure({ enabled: true }, { explicit: true });
      if (!this.checkRevocation()) { await this.disable(); return; }
    }
    if (active(chatState)) { this.status = chatState.starting ? 'starting' : 'running'; this.lastError = ''; return; }
    if (chatState.contacts?.some(item => ['inflight', 'delivery-uncertain'].includes(item.status)) || this.share.state().paused || this.share.state().recoveryRequired) throw fail('好友互动有未确认发送，请先核对原收据；不会重置或重发。');
    if (!await this.modelReady()) { this.status = 'waiting-model'; this.lastError = ''; return; }
    if (!this.checkRevocation()) { await this.disable(); return; }
    const abort = new AbortController(); this.startAbort = abort; this.status = 'starting';
    try {
      await this.startChat(this.chat, { signal: abort.signal });
      if (!this.checkRevocation() || abort.signal.aborted) { await this.disable(); return; }
      this.status = active(this.chat.state()) ? 'running' : 'waiting'; this.lastError = '';
    } catch (error) {
      if (!this.checkRevocation() || abort.signal.aborted) { if (!this.closed) await this.disable(); return; }
      // 另一个入口可能已在同一时刻取得现有worker锁；只接受回读，不重新建立基线。
      if (active(this.chat.state())) { this.status = 'running'; this.lastError = ''; return; }
      throw error;
    } finally { if (this.startAbort === abort) this.startAbort = null; }
  }
  async close() {
    this.closed = true; clearInterval(this.timer); this.timer = null; this.abortStart();
    await this.inflight;
  }
  async configureContacts(input) { return this.withChatPaused(chat => chat.configure(input)); }
  async resumeContact(id) {
    if (typeof id !== 'string' || !id.trim() || id.length > 500) throw fail('请选择已核对的许可会话。', 400);
    const chat = await this.getChat();
    if (!chat?.state?.()?.policy?.allowlist?.some(item => item.id === id)) throw fail('联系人不在当前许可名单。', 403);
    return this.withChatPaused(service => service.resumeContact(id));
  }
  async withChatPaused(action, { timeoutMs = 60_000 } = {}) {
    if (typeof action !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('保存许可名单需要本机操作与最多60秒的停止等待。');
    if (this.closed) throw fail('好友互动入口已关闭。');
    const releaseControl = acquireFriendInteractionDispatch(this.stateDir), owner = { pid: process.pid, token: randomUUID() };
    try {
      let descriptor;
      try { descriptor = fs.openSync(this.settingsGuard, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw Object.assign(fail('许可名单正在其他入口保存，或设置锁需要核对；本次草稿未保存。'), { code: 'FRIEND_SETTINGS_BUSY' }); throw error; }
      try { fs.writeFileSync(descriptor, JSON.stringify(owner)); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      this.abortStart();
    } finally { releaseControl(); }
    let saved, failure;
    try {
      const chat = await this.getChat(); this.chat = chat;
      if (!chat?.state || !chat?.stop || !chat?.configure) throw fail('许可名单服务尚未就绪，草稿未保存。');
      const deadline = Date.now() + timeoutMs; let stoppedKey;
      while (active(chat.state())) {
        if (this.closed) throw fail('当前入口已退出，草稿未保存。');
        if (Date.now() >= deadline) throw fail('等待回复任务停止超过60秒，草稿未保存；请核对原任务状态。');
        const key = workerKey(chat.state());
        if (stoppedKey !== key) { await chat.stop({ preservePending: true, reason: 'settings-update' }); stoppedKey = key; }
        if (active(chat.state())) await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
      }
      if (this.closed) throw fail('当前入口已退出，草稿未保存。');
      saved = await action(chat);
    } catch (error) { failure = error; this.lastError = explain(error); }
    finally {
      let current;
      try { current = JSON.parse(fs.readFileSync(this.settingsGuard, 'utf8')); } catch { /* 锁损坏时保留，不抢占或删除。 */ }
      if (current?.pid === owner.pid && current.token === owner.token) fs.unlinkSync(this.settingsGuard);
      else failure ||= fail('许可设置锁已变化，已保留记录，请核对保存结果。');
    }
    if (failure) throw failure;
    if (!this.closed) await this.reconcile();
    return saved;
  }
}
