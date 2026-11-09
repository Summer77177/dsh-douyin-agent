// 对外动作服务：主动私信、评论发布/回复。复用插件已有的浏览器与台账通道，只补策略闸门。
import { ChatBrowser } from './chat-browser.mjs';
import { CommentBrowser } from './comment-browser.mjs';
import { OutboundCoordinator } from './outbound-send.mjs';
import { readAllowlist, decideOutbound } from './dm-policy.mjs';
import { classify, CommentGuard } from './comment-guard.mjs';

const replyAuthorize = () =>
  Object.assign(async () => true, { beginDispatch: async () => () => {} });

export class OutboundService {
  constructor({ stateDir, source = 'api', logger = null } = {}) {
    this.stateDir = stateDir;
    this.source = source === 'dsh' ? 'dsh' : 'api';
    this.logger = logger;
    this.coordinator = new OutboundCoordinator({ stateDir, source: this.source });
    this.guard = new CommentGuard({ stateDir });
    this.chat = null;
    this.comments = null;
  }

  chatBrowser() {
    this.chat ??= new ChatBrowser({ source: this.source === 'dsh' ? 'dsh-chat' : 'api-chat' });
    return this.chat;
  }

  commentBrowser() {
    this.comments ??= new CommentBrowser({ source: this.source, stateDir: this.stateDir });
    return this.comments;
  }

  // 主动私信：只发许可名单里的人，每人每天 60 条，内容过黑名单
  async sendDm({ recipientId, text }, { signal } = {}) {
    const body = String(text ?? '').trim();
    if (!body) throw new Error('要发的内容是空的。');
    if (body.length > 200) throw new Error('单条私信请控制在 200 字以内。');
    const allowlist = readAllowlist(this.stateDir);
    const gate = decideOutbound({ coordinator: this.coordinator, recipientId, text: body, allowlist });
    if (!gate.allow) return { sent: false, blocked: true, reason: gate.reason };
    const contact = allowlist.find((item) => item.id === recipientId);
    const browser = this.chatBrowser();
    const before = await browser.readConversation(recipientId, { allowed: true, signal });
    const ids = (before.messages || []).map((item) => item.id);
    const delivery = await this.coordinator.run({ recipientId, purpose: 'reply', signal }, async () =>
      browser.sendMessage(recipientId, body, {
        allowed: true,
        expectedContact: contact,
        expectedMessageIds: ids,
        authorize: replyAuthorize(),
        signal,
      }));
    const confirmed = delivery?.confirmed === true && typeof delivery?.messageId === 'string';
    return {
      sent: confirmed,
      confirmed,
      messageId: delivery?.messageId ?? null,
      name: gate.name,
      remainingToday: Math.max(0, (gate.remaining ?? 0) - (confirmed ? 1 : 0)),
      reason: confirmed ? '' : delivery?.reason ?? '没有取得发送确认，不会自动重发。',
    };
  }

  // 在当前视频下发一条评论；可选 @ 某个昵称，让它看起来是在回那个人
  async replyComment({ text, mention, topLevel = true }, { signal } = {}) {
    const raw = String(text ?? '').trim();
    if (!raw) throw new Error('要发的评论是空的。');
    const body = mention ? `@${String(mention).replace(/^@/, '')} ${raw}` : raw;
    if (body.length > 100) throw new Error('单条评论请控制在 100 字以内。');
    const bad = classify(raw);
    if (bad.skip) return { sent: false, blocked: true, reason: `内容命中黑名单：${bad.label}` };
    const videoId = await this.currentVideoId(signal);
    if (!videoId) return { sent: false, suspended: true, reason: '当前不在可识别的视频页上。' };
    const decision = this.guard.decide({ videoId, commentId: body, isReplyToMe: false });
    if (!decision.allow) return { sent: false, blocked: true, reason: decision.reason };
    const result = await this.commentBrowser().post(
      { expectedVideoId: videoId, text: body },
      { signal, authorize: replyAuthorize(), autonomousRunId: null },
    );
    const confirmed = result?.confirmed === true;
    if (confirmed) this.guard.mark({ videoId, commentId: body, isReplyToMe: false });
    return {
      sent: confirmed,
      confirmed,
      commentId: result?.commentId ?? null,
      videoId,
      mention: mention ?? null,
      remainingOnThisVideo: Math.max(0, (decision.remaining ?? 0) - (confirmed ? 1 : 0)),
      reason: confirmed ? '' : result?.reason ?? '没有取得发布确认，不会自动重发。',
    };
  }

  async currentVideoId() {
    try {
      return await this.commentBrowser().controller.withPage(async (page) => {
        const url = page.url();
        const found = /\/video\/(\d{1,64})/.exec(url);
        return found ? found[1] : null;
      });
    } catch {
      return null;
    }
  }

  async close() {
    await this.chat?.close?.().catch(() => {});
    await this.comments?.close?.().catch(() => {});
    this.chat = null;
    this.comments = null;
  }
}
