// 评论区「回复某人」：点该条评论的回复 → 确认输入框进入回复态 → 打字 → 发布 → 复核。
// 纯 DOM 操作，不自己建浏览器；由调用方把 page 传进来（和 comment-reader 一致）。
import { cleanText, readCommentsInPage } from './comment-reader.mjs';
import { classify, moodFor, CommentGuard } from './comment-guard.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_STATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'state');

const ROW = '[data-e2e="comment-item"]';
const EDITOR = 'div.public-DraftEditor-content,[data-e2e="comment-input"] [contenteditable="true"],textarea[data-e2e="comment-input"]';
const PLACEHOLDER = '.comment-input-inner-container ._x9Gwl7G,.comment-input-inner-container span';
const PUBLISH = '.commentInput-right-ct .oWdMk9B9 span.wchsYBpK,[data-e2e="comment-post"],[data-e2e="comment-submit"],[data-e2e="comment-publish"]';
const PUBLISH_LABEL = /^(发布|发送|发表评论|发布评论)$/;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// readCommentsInPage 是「送进页面执行」的函数，必须在 evaluate 里跑
async function readRows(page, maxRows = 12) {
  const raw = await page.evaluate(readCommentsInPage, maxRows).catch(() => []);
  const list = Array.isArray(raw) ? raw : [];
  return list.map((item) => ({ i: item.i, user: item.nick, text: item.text }));
}

function fail(message, code = 'REPLY_FAILED', extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

// 在页面里找到「回复」入口并点击，返回是否点上
async function clickReplyTarget(page, { index, expectUser }) {
  return page.evaluate(({ index, expectUser, ROW }) => {
    const rows = [...document.querySelectorAll(ROW)];
    const pick = () => {
      if (typeof index === 'number' && rows[index]) return rows[index];
      if (expectUser) {
        const hit = rows.find((row) => {
          const alt = row.querySelector('img')?.alt || '';
          return alt && expectUser && alt.includes(expectUser);
        });
        if (hit) return hit;
      }
      return null;
    };
    const row = pick();
    if (!row) return { ok: false, reason: '没有找到目标评论行' };
    // 回复入口：优先精确文本的 span/div，其次 data-e2e
    const nodes = [...row.querySelectorAll('[data-e2e="comment-reply"],span,div,a')];
    const entry = nodes.find((n) => {
      const t = (n.innerText || '').trim();
      return t === '回复' && n.offsetParent !== null && n.getBoundingClientRect().width > 0;
    }) || nodes.find((n) => n.getAttribute('data-e2e') === 'comment-reply');
    if (!entry) return { ok: false, reason: '这条评论没有可见的「回复」入口' };
    const r = entry.getBoundingClientRect();
    entry.click();
    return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, { index, expectUser, ROW });
}

// 读输入框状态：是否进入「回复 @某人」态、占位文字、当前文本
async function readEditor(page) {
  return page.evaluate((EDITOR) => {
    const el = document.querySelector(EDITOR);
    if (!el) return { found: false };
    const text = (el.innerText || '').trim();
    const placeholder = el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || '';
    const scope = el.closest('[data-e2e="comment-input"]') || el.parentElement;
    const hint = scope ? (scope.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    return { found: true, text, placeholder, hint, replying: /回复\s*@/.test(placeholder) || /回复\s*@/.test(hint) };
  }, EDITOR);
}

// 在输入框里打字：抖音用的是 Draft.js，只能靠真实键盘事件，execCommand 不认
async function typeText(page, text) {
  const el = await page.$(EDITOR);
  if (!el) return { typed: '', editor: { found: false } };
  await page.click(EDITOR).catch(() => {});
  await wait(160);
  // 清掉可能已经打了一半的内容，避免重复拼接
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Delete').catch(() => {});
  await wait(120);
  await page.keyboard.type(text, { delay: 26 });
  await wait(380);
  const state = await readEditor(page);
  return { typed: state.text || '', editor: state };
}

// 点发布，回到列表里复核自己这条有没有真的出现
async function submitAndVerify(page, text) {
  const before = await page.evaluate((ROW) => document.querySelectorAll(ROW).length, ROW).catch(() => 0);
  const clicked = await page.evaluate(({ PUBLISH, PUBLISH_LABEL }) => {
    const cands = [...document.querySelectorAll(PUBLISH)];
    const byLabel = [...document.querySelectorAll('[aria-label],[title]')].filter((n) => {
      const l = n.getAttribute('aria-label') || n.getAttribute('title') || '';
      return PUBLISH_LABEL.test(l.trim());
    });
    const target = cands.find((n) => n.offsetParent !== null && n.getBoundingClientRect().width > 0) || byLabel[0];
    if (!target) return { ok: false, reason: '没找到发布按钮' };
    const r = target.getBoundingClientRect();
    target.click();
    return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, { PUBLISH, PUBLISH_LABEL });
  if (!clicked.ok) return { confirmed: false, code: 'PUBLISH_BUTTON_MISSING', reason: clicked.reason };

  const needle = text.replace(/\s+/g, '').slice(0, 10);
  for (let i = 0; i < 12; i += 1) {
    await wait(600);
    const hit = await page.evaluate(({ ROW, needle }) => {
      const rows = [...document.querySelectorAll(ROW)];
      for (const row of rows) {
        const t = (row.innerText || '').replace(/\s+/g, '');
        if (needle && t.includes(needle)) {
          const id = row.getAttribute('data-id') || row.id || '';
          return { found: true, id, snippet: t.slice(0, 40) };
        }
      }
      return { found: false };
    }, { ROW, needle });
    if (hit.found) return { confirmed: true, ...hit, rows: { before, checked: i } };
  }
  return { confirmed: false, code: 'REPLY_NOT_VISIBLE', reason: '点了发布，但列表里没看到自己的回复' };
}

/**
 * 回复评论区里的某一条。
 * @param {object} page  playwright 页面
 * @param {object} opts
 * @param {number} [opts.index] 目标评论在列表中的下标
 * @param {string} [opts.expectUser] 目标评论的作者昵称
 * @param {string} opts.text 要发的话
 * @param {boolean} [opts.dryRun] 只走到「打上字」不点发布
 */
export async function replyToCommentInPage(page, { index, expectUser, text, dryRun = false, stateDir = DEFAULT_STATE, isReplyToMe = false } = {}) {
  const body = String(text || '').trim();
  if (!body) throw fail('回复内容为空', 'REPLY_EMPTY');
  if (body.length > 100) throw fail(`回复超长（${body.length} 字），抖音评论区放不下`, 'REPLY_TOO_LONG');

  const rows = await readRows(page, 12);
  const target = (typeof index === 'number' && rows[index]) || (expectUser && rows.find((r) => r.user === expectUser)) || null;
  if (!target) throw fail('评论区里没有找到要回复的那一条', 'REPLY_TARGET_MISSING');

  const adLike = await page.evaluate(() => {
    const container = document.querySelector('[data-e2e="feed-active-video"]') || document.body;
    const tagRe = /^(广告|赞助|推广|广告主|推广内容|广告·推广)$/;
    return [...container.querySelectorAll('div,span')].filter((e) => !e.childElementCount).some((e) => tagRe.test((e.textContent || '').trim()));
  }).catch(() => false);
  if (adLike) return { sent: false, blocked: true, reason: '当前作品带广告标记，不评论也不分享。', target };

  const gate = classify(target.text);
  if (gate.skip) return { sent: false, skipped: true, reason: `禁区：${gate.label}`, target };
  const mood = moodFor(target.text);

  // 额度台账：同一作品主动评论最多两条、同一串最多五条；这条路径以前不记账，会漏算。
  const videoId = (String(page.url()).match(/\/video\/(\d+)/) || [])[1] || 'unknown';
  const threadKey = `${target.user || ''}#${target.i}`;
  const guard = new CommentGuard({ stateDir });
  const quota = guard.decide({ videoId, commentId: threadKey, isReplyToMe });
  if (!quota.allow) return { sent: false, blocked: true, counted: false, reason: quota.reason, target };

  const clicked = await clickReplyTarget(page, { index: typeof index === 'number' ? index : rows.indexOf(target), expectUser: target.user });
  if (!clicked.ok) throw fail(clicked.reason, 'REPLY_ENTRY_MISSING');
  await wait(650);

  const editor = await readEditor(page);
  if (!editor.found) {
    // 详情页的评论框是假占位块，要先点它，Draft.js 编辑器才会挂上去
    await page.click(PLACEHOLDER).catch(() => {});
    await wait(600);
  }
  const after = await readEditor(page);
  if (!after.found) throw fail('评论区输入框没有出现', 'REPLY_EDITOR_MISSING');

  const typing = await typeText(page, body);
  if (!typing.editor?.text?.trim()) throw fail('字没打进输入框', 'REPLY_TYPING_FAILED', { editor: typing.editor });
  if (dryRun) return { sent: false, dryRun: true, mood, target, typed: typing.editor.text, replying: Boolean(typing.editor.replying) };

  const verified = await submitAndVerify(page, body);
  if (verified.confirmed === true) {
    try { guard.mark({ videoId, commentId: threadKey, isReplyToMe }); } catch { /* 记账失败不推翻已发出的评论 */ }
  }
  return { sent: verified.confirmed === true, mood, target, typed: typing.editor.text, replying: Boolean(typing.editor.replying), verify: verified, videoId, quota: { kind: quota.kind, remaining: quota.remaining } };
}

// 只读：评论区当前状态，给上层判断该不该动
export async function inspectReplySurface(page) {
  const rows = await readRows(page, 12);
  const editor = await readEditor(page);
  const videoId = (String(page.url()).match(/\/video\/(\d+)/) || [])[1] || 'unknown';
  return { rows, editor, videoId };
}

export { cleanText };
