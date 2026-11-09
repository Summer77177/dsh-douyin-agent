// 「自动打开专用浏览器」开关：只拦插件自己去 spawn 浏览器这条路。
// 用户手动开着的浏览器照常连，不受影响。
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'browser-auto-launch.json';

export function readAutoLaunch(controlDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(controlDir, FILE), 'utf8'));
    return raw?.enabled !== false;
  } catch { return true; }
}

export function saveAutoLaunch(controlDir, enabled) {
  fs.mkdirSync(controlDir, { recursive: true });
  const file = path.join(controlDir, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ enabled: enabled === true }, null, 1));
  fs.renameSync(tmp, file);
  return { enabled: enabled === true };
}
