// 需要人工处理时，弹一条 Windows 通知 + 响一声，并留一份可查的待处理记录。
// 触发点：自动观看反复失败/超标、私信不可恢复的启动失败、会话连续标记失败。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const QUIET_MS = 10 * 60 * 1000; // 同一个 key 十分钟内只弹一次，避免刷屏

function toastScript(title, body) {
  const clean = (value) => String(value || '').replace(/[\r\n]+/g, ' ').replace(/["`]/g, "'").slice(0, 180);
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${clean(title)}</text><text>${clean(body)}</text></binding></visual></toast>')`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    "try { [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DeepSeek Harness').Show($toast) } catch { }",
    'try { [System.Media.SystemSounds]::Exclamation.Play() } catch { }',
  ].join('; ');
}

export class HumanNotifier {
  constructor({ stateDir } = {}) {
    this.file = stateDir ? path.join(stateDir, 'needs-user.json') : null;
  }

  read() {
    try { const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); return raw && typeof raw === 'object' ? raw : {}; }
    catch { return {}; }
  }

  write(data) {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(data, null, 1));
      fs.renameSync(temporary, this.file);
    } catch { /* 通知存不下来不影响主流程 */ }
  }

  // key 用来去重：同一个问题十分钟内只提醒一次。
  notify({ key = 'unknown', title = '抖音助手需要你', body = '' } = {}) {
    const now = Date.now();
    const data = this.read();
    const previous = Number(data[key]?.at ?? 0);
    const quiet = now - previous < QUIET_MS;
    data[key] = { at: now, title, body, atISO: new Date(now).toISOString(), repeats: (Number(data[key]?.repeats ?? 0) || 0) + 1 };
    this.write(data);
    if (quiet) return { shown: false, reason: 'quiet' };
    try {
      const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', toastScript(title, body)], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      });
      child.unref?.();
      return { shown: true };
    } catch (error) {
      return { shown: false, reason: String(error?.message || error).slice(0, 120) };
    }
  }

  // 人工处理完就清掉对应条目。
  clear(key) {
    const data = this.read();
    if (data[key]) { delete data[key]; this.write(data); }
  }

  pending() {
    const data = this.read();
    return Object.entries(data)
      .map(([key, value]) => ({ key, ...value }))
      .sort((left, right) => Number(right.at) - Number(left.at));
  }
}

export default HumanNotifier;
