// 本地 OCR：跑 RapidOCR（ONNX，不联网、不花钱），把画面里的字幕和弹幕读成文字。
// 只在用户开启的音频/观察能力里被调用，失败一律返回空，不影响主流程。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OCR_SCRIPT = path.join(import.meta.dirname, 'media', 'ocr_reader.py');

// 界面上那些稳定出现的字样，OCR 到也别当成内容
const UI_NOISE = /^(分享给朋友|复制链接|识别画面|发一条友好的弹幕吧|发送|清屏|倍速|连播|智能|弹弹|听抖音|暂时没有更多了|在线|秒前|刚刚|展开\d+条回复)/;

function runPython(script, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.DOUYIN_MEDIA_PYTHON || 'python', [script, ...args], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`ocr exited ${code}: ${err.slice(0, 200)}`)); return; }
      try { resolve(JSON.parse(out.trim())); } catch { reject(new Error(`ocr bad json: ${out.slice(0, 200)}`)); }
    });
  });
}

// 把一帧里的行按位置分成 弹幕 / 字幕 / 噪声
export function splitLines(result, { width = 0, height = 0 } = {}) {
  const lines = Array.isArray(result?.lines) ? result.lines : [];
  const H = height || Math.max(1, ...lines.map((l) => l.y + l.h));
  const W = width || Math.max(1, ...lines.map((l) => l.x + l.w));
  const danmaku = [];
  const subtitle = [];
  const noise = [];
  for (const line of lines) {
    const text = String(line.text || '').trim();
    if (!text || line.score < 0.55) continue;
    const relY = (line.y + line.h / 2) / H;
    const relX = (line.x + line.w / 2) / W;
    if (UI_NOISE.test(text)) { noise.push(text); continue; }
    // 弹幕：画面顶部三分之一，短句（实测抖音弹幕从右上往左飘）
    if (relY < 0.34 && text.length <= 24) { danmaku.push(text); continue; }
    // 字幕：下部 55%~88%
    if (relY > 0.55 && relY < 0.9) { subtitle.push(text); continue; }
    noise.push(text);
  }
  return { danmaku, subtitle, noise };
}

export class OcrService {
  constructor({ python } = {}) { this.python = python || null; }

  async readFile(file, { signal } = {}) {
    if (!fs.existsSync(file)) throw new Error(`OCR 找不到图片：${file}`);
    if (this.python) process.env.DOUYIN_MEDIA_PYTHON = this.python;
    const result = await runPython(OCR_SCRIPT, [file], { timeoutMs: 20000 });
    if (signal?.aborted) throw new Error('aborted');
    if (!result?.ok) throw new Error(result?.error || 'OCR 没有返回结果');
    return result;
  }

  async readBuffer(buffer, { signal, ext = 'jpg' } = {}) {
    const file = path.join(os.tmpdir(), `douyin-ocr-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${ext}`);
    fs.writeFileSync(file, buffer);
    try { return await this.readFile(file, { signal }); }
    finally { try { fs.unlinkSync(file); } catch {} }
  }
}

export function makeOcrService() { return new OcrService({ python: process.env.DOUYIN_MEDIA_PYTHON || null }); }
