// 主动私信策略：许可名单 + 每人每天 60 条（含视频）+ 黑名单禁区。纯逻辑，不碰浏览器。
import fs from 'node:fs';
import path from 'node:path';
import { FORBIDDEN } from './comment-guard.mjs';

export const DM_LIMITS = Object.freeze({
  perRecipientPerDay: 60, // 同一个人一天最多 60 条，文字和视频一起算
});

const shanghaiDay = (value) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));

// 视频这边额外要挡：带真实住址/学校/单位、带车牌、带身份证号这类
const VIDEO_EXTRA = [
  { key: 'real_place', label: '带真实地点', re: /(我家在|住在|家住|我在.{0,8}(小区|路|街|号)|学校是|就读|上班在|公司在)/ },
];

export function classifyOutbound(text, { kind = 'text' } = {}) {
  const s = String(text || '');
  for (const rule of FORBIDDEN) if (rule.re.test(s)) return { skip: true, category: rule.key, label: rule.label };
  // 真实地点类的内容，文字和视频都挡，不只挡视频
  for (const rule of VIDEO_EXTRA) if (rule.re.test(s)) return { skip: true, category: rule.key, label: rule.label };
  return { skip: false };
}

export function readAllowlist(stateDir) {
  const file = path.join(stateDir, 'chat-policy.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || !Array.isArray(raw.allowlist)) throw new Error('私信许可名单格式不对，未继续。');
  return raw.allowlist.filter((item) => typeof item?.id === 'string' && item.id.startsWith('conv:'));
}

// 从共同发出账本里数今天已经给这个人发了几条（文字 + 视频 + 问候都算）
export function countSentToday(coordinator, recipientId, now = Date.now()) {
  const today = shanghaiDay(now);
  return (coordinator.history(recipientId) || []).filter((item) => item.date === today).length;
}

export function decideOutbound({ coordinator, recipientId, text, kind = 'text', allowlist, now = Date.now(), limits = DM_LIMITS }) {
  const allowed = (allowlist || []).find((item) => item.id === recipientId);
  if (!allowed) return { allow: false, reason: '这个联系人不在已核对许可名单里，不发。' };
  const bad = classifyOutbound(text, { kind });
  if (bad.skip) return { allow: false, reason: `内容命中黑名单：${bad.label}` };
  const used = countSentToday(coordinator, recipientId, now);
  if (used >= limits.perRecipientPerDay) return { allow: false, reason: `今天已经给这位发了 ${used} 条，到 ${limits.perRecipientPerDay} 条上限了。` };
  return { allow: true, remaining: limits.perRecipientPerDay - used, name: allowed.name };
}
