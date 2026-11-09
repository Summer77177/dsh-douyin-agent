// 最轻量的一次体检：把仓库里所有 .mjs / .js 过一遍语法。
// 不做联网、不启动浏览器、不碰 state/ 目录。
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'state', 'media/models', '.git']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (SKIP.has(name)) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

const files = walk(root);
let failed = 0;
let blocked = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      // 被限制的环境不允许起子进程，不算语法错误。
      blocked += 1;
      continue;
    }
    failed += 1;
    console.error(`✗ ${path.relative(root, file)}`);
    console.error(String(error.stderr || error.message).trim().split('\n').slice(0, 4).join('\n'));
  }
}

if (blocked) {
  console.log(`有 ${blocked} 个文件因为当前环境禁止创建子进程而跳过检查。`);
  console.log('换成普通终端重跑，或者逐个执行：node --check <文件>');
}
console.log(`检查 ${files.length} 个文件，失败 ${failed} 个。`);
process.exitCode = failed ? 1 : 0;
