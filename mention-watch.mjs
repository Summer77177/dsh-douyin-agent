// 翻自己的作品评论区，找「有人 @ 我」的评论，并逐一回复。
// 复用 comment-reply.mjs 的真发通道（自带护栏、额度台账、发布后复核）。
// 只做增量的、有据可查的动作：同一个作品里同一条评论只回一次。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCommentsInPage } from './comment-reader.mjs';
import { replyToCommentInPage } from './comment-reply.mjs';

const DEFAULT_STATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'state');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 我的名字会被别人 @ 的各种写法（用 DOUYIN_MENTION_NAMES 逗号分隔覆盖）
export const DEFAULT_KEYWORDS = (process.env.DOUYIN_MENTION_NAMES || '助手,DeepSeek,deepseek')
  .split(',').map((k) => k.trim()).filter(Boolean);

export function mentionsMe(text, keywords = DEFAULT_KEYWORDS) {
  const s = String(text || '');
  if (!s.includes('@')) return false;
  return keywords.some((k) => s.includes(k));
}

export class MentionWatch {
  constructor({ stateDir = DEFAULT_STATE, keywords = DEFAULT_KEYWORDS } = {}) {
    this.stateDir = stateDir;
    this.file = path.join(stateDir, 'mention-watch.json');
    this.keywords = keywords;
  }
  read() {
    try { const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); return raw && typeof raw === 'object' ? raw : { replied: {} }; }
    catch { return { replied: {} }; }
  }
  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, this.file);
  }
  repliedKey(videoId, user, text) { return `${videoId}|${user || ''}|${String(text || '').slice(0, 60)}`; }
  alreadyReplied(key) { return Boolean(this.read().replied[key]); }
  markReplied(key, detail) { const data = this.read(); data.replied[key] = { at: new Date().toISOString(), ...detail }; this.write(data); }
}

// 读自己主页里的作品 id（按页面顺序，最新在前）
async function ownWorkIds(page, limit = 8) {
  const ids = await page.evaluate((max) => {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/video/"]')) {
      const m = (a.getAttribute('href') || '').match(/\/video\/(\d{15,})/);
      if (m && !out.includes(m[1])) out.push(m[1]);
      if (out.length >= max) break;
    }
    return out;
  }, limit).catch(() => []);
  return Array.isArray(ids) ? ids : [];
}

// 打开作品详情页，确保评论面板出来
async function openWork(page, videoId) {
  await page.goto(`https://www.douyin.com/video/${videoId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await wait(2500);
  for (let i = 0; i < 3; i += 1) {
    const n = await page.evaluate(() => document.querySelectorAll('[data-e2e="comment-item"]').length).catch(() => 0);
    if (n > 0) return true;
    await page.evaluate(() => {
      const icon = document.querySelector('[data-e2e="feed-comment-icon"]') || document.querySelector('[data-e2e="comment-icon"]');
      if (icon) icon.click();
    }).catch(() => {});
    await wait(1600);
  }
  return false;
}

async function readRows(page, maxRows = 20) {
  const raw = await page.evaluate(readCommentsInPage, maxRows).catch(() => []);
  return (Array.isArray(raw) ? raw : []).map((item) => ({ i: item.i, user: item.nick, text: item.text }));
}

// 跳到自己的主页（作品网格在这里），主页是懒加载的，滚一下再读
async function openOwnProfile(page) {
  await page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await wait(3200);
  await page.evaluate(() => window.scrollTo(0, 700)).catch(() => {});
  await wait(1500);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await wait(700);
}

/**
 * 扫自己的作品，返回命中「@ 我」的评论（只读，不发）。
 * @returns {{works:number, scanned:number, hits:Array, profileLoaded:boolean}}
 */
export async function scanMentions(page, { maxWorks = 8, keywords = DEFAULT_KEYWORDS, stateDir = DEFAULT_STATE, restore = true } = {}) {
  const watch = new MentionWatch({ stateDir, keywords });
  const origin = page.url();
  // 关键：先真的进到自己的主页，否则当前页面（推荐流）里一条自己作品的链接都没有
  await openOwnProfile(page);
  const works = await ownWorkIds(page, maxWorks);
  const hits = [];
  let scanned = 0;
  try {
    for (const videoId of works) {
      const ready = await openWork(page, videoId);
      if (!ready) continue;
      const rows = await readRows(page, 20);
      scanned += rows.length;
      for (const row of rows) {
        if (!mentionsMe(row.text, keywords)) continue;
        const key = watch.repliedKey(videoId, row.user, row.text);
        hits.push({ videoId, index: row.i, user: row.user, text: row.text, replied: watch.alreadyReplied(key), key });
      }
    }
  } finally {
    // 扫完把页面放回原处：自主观看正在推荐流里，不要把它挪走
    if (restore && /douyin\.com\/\?recommend=1/.test(origin) && !/user\//.test(page.url())) {
      await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await wait(1800);
    }
  }
  return { works: works.length, scanned, hits, profileLoaded: works.length > 0 };
}

/**
 * 扫一遍并回复尚未回过的 @。
 * @param {(hit:object)=>Promise<string>|string} composeReply 生成回复文本（由调用方接模型）
 */
export async function replyMentions(page, { composeReply, maxWorks = 8, keywords = DEFAULT_KEYWORDS, stateDir = DEFAULT_STATE, dryRun = false, limit = 5 } = {}) {
  const watch = new MentionWatch({ stateDir, keywords });
  const scan = await scanMentions(page, { maxWorks, keywords, stateDir });
  const pending = scan.hits.filter((hit) => !hit.replied).slice(0, limit);
  const done = [];
  for (const hit of pending) {
    const ready = await openWork(page, hit.videoId);
    if (!ready) { done.push({ ...hit, sent: false, reason: '评论面板没有打开' }); continue; }
    let text = '';
    try { text = String(await composeReply(hit) || '').trim(); }
    catch (error) { done.push({ ...hit, sent: false, reason: `生成回复失败：${error.message}` }); continue; }
    if (!text) { done.push({ ...hit, sent: false, reason: '没有生成出内容' }); continue; }
    try {
      const out = await replyToCommentInPage(page, { index: hit.index, expectUser: hit.user, text, dryRun, stateDir, isReplyToMe: true });
      if (out.sent && !dryRun) watch.markReplied(hit.key, { videoId: hit.videoId, user: hit.user, text, reply: out.typed });
      done.push({ ...hit, sent: Boolean(out.sent), blocked: out.blocked, reason: out.reason, verify: out.verify, reply: out.typed });
    } catch (error) {
      done.push({ ...hit, sent: false, reason: error.message, code: error.code });
    }
    await wait(1200);
  }
  return { works: scan.works, scanned: scan.scanned, hits: scan.hits.length, pending: pending.length, done };
}
