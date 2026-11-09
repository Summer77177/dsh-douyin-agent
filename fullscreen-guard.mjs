// 全屏程序守卫：判断前台是不是全屏应用（游戏、播放器、F11 全屏浏览器）。
// 只读前台窗口几何，不截图、不注入、不改任何进程。
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'fullscreen_check.py');

export async function fullscreenBusy({ python = process.env.DOUYIN_MEDIA_PYTHON || 'python', timeoutMs = 5000 } = {}) {
  return await new Promise((resolve) => {
    execFile(python, [SCRIPT], { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) return resolve({ busy: false, unknown: true, note: '全屏检测不可用，按未全屏处理。' });
      try {
        const value = JSON.parse(String(stdout).trim().split('\n').pop());
        return resolve({ busy: value?.fullscreen === true, process: value?.process ?? null, title: value?.title ?? null, unknown: false });
      } catch {
        return resolve({ busy: false, unknown: true, note: '全屏检测输出无法解析，按未全屏处理。' });
      }
    });
  });
}
