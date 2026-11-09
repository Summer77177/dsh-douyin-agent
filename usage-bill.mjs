// 用量账单：把 state/usage/*.jsonl 的 token 按 DeepSeek 官方价目换算成钱。
// 价目来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/（deepseek-flash）
// 高峰 = 北京时间周一至周五（不含法定节假日）9:00-12:00、14:00-18:00，其余为空闲。
import fs from 'node:fs';
import path from 'node:path';
import { resolveRuntimePaths } from './runtime-paths.mjs';

export const PRICES = Object.freeze({
  'deepseek-flash': Object.freeze({
    hit: Object.freeze({ peak: 0.04, idle: 0.02 }),
    miss: Object.freeze({ peak: 2, idle: 1 }),
    out: Object.freeze({ peak: 8, idle: 4 }),
  }),
});
// 未登记过的模型按 flash 价保守估算，并在结果里标注。
const FALLBACK = PRICES['deepseek-flash'];

const CN = 'Asia/Shanghai';
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CN, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23', weekday: 'short',
});
const partsOf = (at) => {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = formatter.formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return { day: `${pick('year')}-${pick('month')}-${pick('day')}`, weekday: pick('weekday'), hour: Number(pick('hour')), minute: Number(pick('minute')) };
};

// 周末整天空闲；工作日只有 9:00-12:00 与 14:00-18:00 是高峰（法定节假日无法在本地判断，按高峰算偏保守）。
export function isPeak(at) {
  const parts = partsOf(at);
  if (!parts || !Number.isFinite(parts.hour)) return false;
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const minutes = parts.hour * 60 + parts.minute;
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080);
}

export function costOf(record) {
  const price = PRICES[record?.model] || FALLBACK;
  const usage = record?.usage && typeof record.usage === 'object' ? record.usage : {};
  const promptTokens = Number.isFinite(usage.promptTokens) ? usage.promptTokens : 0;
  const cachedTokens = Number.isFinite(usage.cachedTokens) ? Math.min(usage.cachedTokens, promptTokens) : 0;
  const completionTokens = Number.isFinite(usage.completionTokens) ? usage.completionTokens : 0;
  const missTokens = Math.max(0, promptTokens - cachedTokens);
  const band = isPeak(record?.at) ? 'peak' : 'idle';
  const yuan = (missTokens * price.miss[band] + cachedTokens * price.hit[band] + completionTokens * price.out[band]) / 1e6;
  return { yuan, band, promptTokens, cachedTokens, missTokens, completionTokens, known: PRICES[record?.model] !== undefined };
}

const blank = () => ({ requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, peakRequests: 0, yuan: 0, unknownModel: false, kinds: {} });

export class UsageBill {
  constructor({ stateDir = resolveRuntimePaths().stateDir } = {}) {
    this.directory = path.join(stateDir, 'usage');
  }
  read({ days = 7 } = {}) {
    const files = fs.existsSync(this.directory) ? fs.readdirSync(this.directory).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort().slice(-Math.max(1, Math.min(30, days))) : [];
    const byDay = new Map();
    let damaged = 0;
    const seen = new Set();
    for (const file of files) {
      const full = path.join(this.directory, file);
      let stat;
      try { stat = fs.lstatSync(full); } catch { damaged += 1; continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) { damaged += 1; continue; }
      for (const line of fs.readFileSync(full, 'utf8').split('\n').filter(Boolean)) {
        let record;
        try { record = JSON.parse(line); } catch { damaged += 1; continue; }
        if (!record?.id || !record?.at) { damaged += 1; continue; }
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        const parts = partsOf(record.at);
        if (!parts || parts.day !== file.slice(0, 10)) { damaged += 1; continue; }
        const cost = costOf(record);
        if (!byDay.has(parts.day)) byDay.set(parts.day, { date: parts.day, ...blank() });
        const day = byDay.get(parts.day);
        day.requests += 1;
        day.promptTokens += cost.promptTokens;
        day.cachedTokens += cost.cachedTokens;
        day.completionTokens += cost.completionTokens;
        day.yuan += cost.yuan;
        if (cost.band === 'peak') day.peakRequests += 1;
        if (!cost.known) day.unknownModel = true;
        const kind = typeof record.kind === 'string' ? record.kind : '未知';
        if (!day.kinds[kind]) day.kinds[kind] = { requests: 0, yuan: 0 };
        day.kinds[kind].requests += 1;
        day.kinds[kind].yuan += cost.yuan;
      }
    }
    const rows = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
    const total = rows.reduce((sum, row) => ({ requests: sum.requests + row.requests, promptTokens: sum.promptTokens + row.promptTokens, cachedTokens: sum.cachedTokens + row.cachedTokens, completionTokens: sum.completionTokens + row.completionTokens, yuan: sum.yuan + row.yuan }), { requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, yuan: 0 });
    return { protocol: 'usage-bill-v1', priceTable: 'deepseek-flash 官方价目', days: rows, total, damagedRecords: damaged, note: '按官方价目估算，高峰/空闲按每条记录的北京时间分档；法定节假日无法本地判断，工作日按高峰算。只统计本助手发起的调用，DSH 普通会话不在其中。' };
  }
}

const yuan = (value) => `¥${value.toFixed(2)}`; // 显示到分
export function renderBill(bill) {
  if (!bill || !Array.isArray(bill.days) || !bill.days.length) return '暂无用量记录。';
  const lines = ['| 日期 | 调用 | 输入 | 其中命中缓存 | 输出 | 花费 |', '| --- | ---: | ---: | ---: | ---: | ---: |'];
  for (const day of bill.days) lines.push(`| ${day.date} | ${day.requests} | ${day.promptTokens} | ${day.cachedTokens} | ${day.completionTokens} | ${yuan(day.yuan)} |`);
  lines.push(`| 合计 | ${bill.total.requests} | ${bill.total.promptTokens} | ${bill.total.cachedTokens} | ${bill.total.completionTokens} | ${yuan(bill.total.yuan)} |`);
  return lines.join('\n');
}
