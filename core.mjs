import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from './playwright-runtime.mjs';
import { MemoryStore } from './memory.mjs?v=2';
import { TOOL_DEFINITIONS, validateToolArguments } from './tool-definitions.mjs?v=18';
import { VideoLimits } from './video-limits.mjs';
import { resolveRuntimePaths, resolveNodeExecutable } from './runtime-paths.mjs?v=10';
import { PersonaMemory } from './persona-memory.mjs?v=10';
import { BrowserLauncher, connectDedicatedBrowser } from './browser-launcher.mjs';
import { readCommentsInPage } from './comment-reader.mjs';
import { makeOcrService, splitLines } from './ocr-service.mjs?v=1';

// 两帧 32×32 灰度指纹的平均绝对差：0~255。数值越小说明画面越像。
const grayDelta = (left, right) => {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return 255;
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += Math.abs(left[index] - right[index]);
  return sum / left.length;
};

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// 单次工具返回的画面帧上限：超过就按时间轴均匀抽稀，避免一次回传十几张图把上下文和内存一起吃掉。
const MAX_TOOL_FRAMES = 8;
const limitFrames = (result) => {
  const frames = result?.frames;
  if (!Array.isArray(frames) || frames.length <= MAX_TOOL_FRAMES) return result;
  // 字幕带只截一张，先把它留出来，剩下的名额再沿时间轴均匀抽
  const pinned = frames.filter(frame => frame?.role === 'subtitle').slice(0, 1);
  const rest = frames.filter(frame => frame?.role !== 'subtitle');
  const budget = Math.max(0, MAX_TOOL_FRAMES - pinned.length), step = budget ? rest.length / budget : 0, kept = [];
  for (let index = 0; index < budget; index += 1) kept.push(rest[Math.min(rest.length - 1, Math.floor(index * step))]);
  const ordered = [...pinned, ...kept.filter(frame => !pinned.includes(frame))];
  return { ...result, frames: ordered, observation: { ...(result.observation || {}), framesLimited: { returned: ordered.length, sampled: frames.length } } };
};
const VIDEO_ACTIONS=new Set(['douyin_open','douyin_search','douyin_open_video','douyin_next','douyin_previous','douyin_observe','douyin_screenshot','douyin_play','douyin_listen']);
const processAlive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)throw new Error('共享视频操作锁无效。');try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
const optionalRecord=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw new Error('共享视频操作记录无法读取，未操作视频。');}};
async function watchControl(directory,action,signal) {
  const file=path.join(directory,'watch-control.guard'),token=randomUUID();
  for(let attempt=0;;attempt++) {
    signal?.throwIfAborted(); let descriptor;
    try {descriptor=openSync(file,'wx',0o600);}
    catch(error){if(error.code!=='EEXIST'||attempt>=100)throw Object.assign(new Error('共享视频控制正在更新，请稍后重试。'),{status:409});await wait(20,signal);continue;}
    try {writeFileSync(descriptor,JSON.stringify({pid:process.pid,token}));}
    finally {closeSync(descriptor);}
    try{return action();}finally{if(optionalRecord(file)?.token===token)unlinkSync(file);}
  }
}
async function acquireNativeVideoLease(directory,signal) {
  const file=path.join(directory,'watch-manual.lock'),token=randomUUID();
  await watchControl(directory,()=>{
    const owner=optionalRecord(path.join(directory,'watch-loop.lock'));
    if(owner)throw Object.assign(new Error('自主观看正在运行或需要清理残留，请先停止它再手动操作视频。'),{status:409});
    const manual=optionalRecord(file);
    if(manual&&processAlive(manual.pid))throw Object.assign(new Error('另一个入口正在手动操作视频，请等待完成。'),{status:409});
    writeFileSync(file,JSON.stringify({pid:process.pid,token,kind:'native-tool'}),{mode:0o600});
  },signal);
  return ()=>watchControl(directory,()=>{const manual=optionalRecord(file);if(manual?.pid===process.pid&&manual.token===token)unlinkSync(file);});
}
const { browserProfileDir: PROFILE, browserControlDir: CONTROL } = resolveRuntimePaths();
const RECOMMEND = 'https://www.douyin.com/?recommend=1&from_nav=1';
const PORT = 9227;

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function aborted(signal) { signal?.throwIfAborted(); }
async function wait(ms, signal) { await delay(ms, undefined, { signal }); }

const QUEUES = Symbol.for('dafeiyu.browser-operation-queues.v1');
const localQueues = globalThis[QUEUES] ||= new Map();
const lockFailure = name => Object.assign(new Error(`${name.endsWith('-chat') ? '聊天窗口' : '浏览器窗口'}排队等待超时，请检查当前操作。`), { code:'BROWSER_LOCK_BUSY', lockName:name, status:409 });
async function localTurn(key, signal, timeoutMs, name) {
  const previous=localQueues.get(key)||Promise.resolve();let finish;
  const gate=new Promise(resolve=>{finish=resolve;}),tail=previous.catch(()=>{}).then(()=>gate);
  localQueues.set(key,tail);void tail.then(()=>{if(localQueues.get(key)===tail)localQueues.delete(key);});
  let timer,onAbort;
  try {
    aborted(signal);
    await Promise.race([previous.catch(()=>{}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(lockFailure(name)),timeoutMs);if(signal){onAbort=()=>reject(signal.reason||new Error('已取消排队。'));signal.addEventListener('abort',onAbort,{once:true});}})]);
    aborted(signal);return finish;
  } catch(error) {finish();throw error;}
  finally {clearTimeout(timer);if(onAbort)signal.removeEventListener('abort',onAbort);}
}

export async function acquireBrowserOperationLock(name,{signal,directory=CONTROL,timeoutMs=35_000}={}) {
  if(!/^[a-z][a-z0-9-]{0,63}$/.test(name)||!path.isAbsolute(directory)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new TypeError('浏览器操作锁参数无效。');
  const started=Date.now(),key=path.resolve(directory)+String.fromCharCode(0)+name,releaseTurn=await localTurn(process.platform==='win32'?key.toLowerCase():key,signal,timeoutMs,name);
  const file=path.join(directory,`${name}.lock`),token=randomUUID(),deadline=started+timeoutMs;
  try {
    mkdirSync(directory,{recursive:true});
    while(true) {
      aborted(signal);let descriptor;
      try {descriptor=openSync(file,'wx',0o600);}
      catch(error) {
        if(error.code!=='EEXIST')throw error;
        let raw,owner;
        try {raw=readFileSync(file,'utf8');owner=JSON.parse(raw);}
        catch(failure) {
          if(failure.code==='ENOENT')continue;
          let fresh=false;
          try{fresh=Date.now()-statSync(file).mtimeMs<2000;}catch(error){if(error.code==='ENOENT')continue;throw error;}
          if(failure instanceof SyntaxError&&fresh&&Date.now()<deadline){await wait(Math.min(50,timeoutMs),signal);continue;}
          throw Object.assign(new Error('浏览器操作锁记录无法核对，请运行自检。'),{code:'BROWSER_LOCK_RECOVERY',lockName:name,status:409});
        }
        if(!Number.isSafeInteger(owner?.pid)||owner.pid<1)throw Object.assign(new Error('浏览器操作锁归属不明，请运行自检。'),{code:'BROWSER_LOCK_RECOVERY',lockName:name,status:409});
        let ownerAlive;
        try{process.kill(owner.pid,0);ownerAlive=true;}catch(error){if(error.code==='ESRCH')ownerAlive=false;else if(error.code==='EPERM')ownerAlive=true;else throw Object.assign(new Error('浏览器操作锁进程无法核实，请运行自检。'),{code:'BROWSER_LOCK_RECOVERY',lockName:name,status:409});}
        if(!ownerAlive) {
          try{if(readFileSync(file,'utf8')===raw){unlinkSync(file);continue;}}
          catch(error){if(error.code==='ENOENT')continue;throw error;}
        }
        if(Date.now()>=deadline)throw lockFailure(name);
        await wait(Math.min(50,timeoutMs),signal);continue;
      }
      try{writeFileSync(descriptor,JSON.stringify({pid:process.pid,token,createdAt:Date.now()}));}finally{closeSync(descriptor);}
      let released=false;
      return ()=>{if(released)return;released=true;try{const owner=JSON.parse(readFileSync(file,'utf8'));if(owner.pid!==process.pid||owner.token!==token)throw Object.assign(new Error('浏览器操作锁归属已经变化，未删除其他操作的锁。'),{code:'BROWSER_LOCK_CHANGED',lockName:name,status:409});unlinkSync(file);}finally{releaseTurn();}};
    }
  }catch(error){releaseTurn();throw error;}
}
const lock=(name,signal,directory=CONTROL)=>acquireBrowserOperationLock(name,{signal,directory});
// 跨进程、进程内可重入的浏览器操作租约：私信 worker 与视频 worker 不再同时驱动同一个 Edge 窗口。
const leases=new Map();
export async function acquireBrowserLease(signal,directory=CONTROL,{timeoutMs=120_000}={}) {
  const key=path.resolve(directory);
  const current=leases.get(key);
  if(current){
    current.count+=1;
    let released=false;
    return ()=>{if(released)return;released=true;current.count-=1;if(current.count<=0){if(leases.get(key)===current)leases.delete(key);current.release();}};
  }
  const release=await acquireBrowserOperationLock('browser-lease',{signal,directory,timeoutMs});
  const entry={count:1,release};leases.set(key,entry);
  let released=false;
  return ()=>{if(released)return;released=true;entry.count-=1;if(entry.count<=0){if(leases.get(key)===entry)leases.delete(key);release();}};
}

async function version() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1200) });
    return response.ok && /(?:Edg|Chrome)/.test((await response.json()).Browser ?? '');
  } catch { return false; }
}
export function dedicatedHostReadiness(state, { pid, profile, port, processAlive = alive } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !processAlive(pid)) return 'failed';
  // 新宿主写入前可能仍读到旧的已退出记录；只核对本次等待的进程。
  if (!state || state.pid !== pid) return 'pending';
  if (state.profile !== profile || state.port !== port) return 'foreign';
  return state.ready === true ? 'ready' : 'pending';
}
async function endpoint(signal) {
  const release = await lock('launch', signal);
  try {
    const stateFile = path.join(CONTROL, 'browser.json');
    let state;
    try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* 首次运行没有状态。**/ }
    const owned = state?.profile === PROFILE && state.port === PORT && alive(state.pid);
    if (await version()) {
      if (!owned || !state.ready) throw new Error('9227 端口不属于本工具的专用浏览器，请先释放端口。');
      return `http://127.0.0.1:${PORT}`;
    }
    let hostPid = state?.pid;
    if (!owned) {
      const { readAutoLaunch } = await import('./browser-auto-launch.mjs');
      if (!readAutoLaunch(CONTROL)) throw new Error('已关闭「自动打开专用浏览器」：请在设置页「基础设置」重新开启，或自己打开抖音后重试。');
      const output = openSync(path.join(CONTROL, 'browser-host.log'), 'a');
      try {
        const child = spawn(resolveNodeExecutable(), [path.join(ROOT, 'browser-host.mjs'), PROFILE, CONTROL, String(PORT)], {
          detached: true, windowsHide: true, stdio: ['ignore', output, output],
        });
        hostPid = child.pid;
        child.unref();
      } finally { closeSync(output); }
    }
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      aborted(signal);
      await wait(250, signal);
      try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { state = null; }
      const readiness = dedicatedHostReadiness(state, { pid: hostPid, profile: PROFILE, port: PORT });
      if (readiness === 'failed') throw new Error('专用浏览器启动失败；请正常关闭仍使用 cli-profile 的旧专用窗口后重试。');
      if (readiness === 'foreign') throw new Error('专用浏览器宿主归属无法核对，未连接该端口。');
      if (readiness === 'ready' && await version()) return `http://127.0.0.1:${PORT}`;
    }
    throw new Error('专用浏览器启动超时，请查看本机 browser-host.log 日志。');
  } finally { release(); }
}

// 此函数仅读取网页 DOM 与 HTMLVideoElement，不调用抖音私有接口。
export function readPageState() {
  if(location.origin!=='https://www.douyin.com') return {
    url:null,title:null,video:null,searchResults:[],visibleText:'',loginRequired:false,verificationRequired:false,
    unsupportedPage:true,note:'当前专用标签页已离开抖音，没有读取该页面内容。',
  };
  const visible = element => {
    const r = element.getBoundingClientRect(), s = getComputedStyle(element);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const clean = value => (value ?? '').replace(/\s+/g, ' ').trim();
  const workId = value => {
    try { const u = new URL(value, location.href); return /\/video\/(\d+)/.exec(u.pathname)?.[1] || u.searchParams.get('modal_id') || u.searchParams.get('aweme_id'); } catch { return null; }
  };
  const privateArea='[data-e2e="im-dialog"],[data-e2e="conversation-item"]';
  const privateChatVisible=[...document.querySelectorAll('[data-e2e="im-dialog"]')].some(visible);
  const videoVisible = element => {
    if(!visible(element))return false;
    for(let node=element;node;node=node.parentElement)if(Number(getComputedStyle(node).opacity)===0)return false;
    return true;
  };
  const videoElements = [...document.querySelectorAll('video')].filter(e=>videoVisible(e)&&!e.closest(privateArea)).map(element => {
    const r = element.getBoundingClientRect();
    return { element, area: Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left)) * Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) };
  }).sort((a,b) => b.area - a.area);
  const element = videoElements[0]?.element;
  const text = [...document.querySelectorAll('body *')].filter(e => e.childElementCount === 0 && visible(e) && !e.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]')).map(e => clean(e.innerText || e.textContent)).filter(Boolean).join('\n').slice(-9000);
  const loginRequired = /扫码登录|验证码登录|登录后即可|手机扫码登录/.test(text);
  const verificationRequired = [...document.querySelectorAll('#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"]')].some(visible) || /请完成下方验证|请完成验证|安全验证|拖动滑块/.test(text);
  let video = null, activeContainer = null, videoIdentityConflict = false;
  if (element) {
    let container = element.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"]');
    activeContainer = container;
    if(!container) {
      container=element.parentElement;
      for(let i=0;container?.parentElement&&i<8;i++) {
        if(container.querySelector('[class*="video-info-detail"]')) break;
        container=container.parentElement;
      }
    }
    const links = [...(container?.querySelectorAll('a[href]') ?? [])].filter(e=>visible(e)&&!e.closest(privateArea));
    const playerId=/(?:^|\s)video_(\d+)(?:\s|$)/.exec(element.closest('[data-e2e="player-container"]')?.className??'')?.[1],activeId=/(?:^|\s)video_(\d+)(?:\s|$)/.exec(activeContainer?.className??'')?.[1];
    videoIdentityConflict=Boolean(playerId&&activeId&&playerId!==activeId);
    const id = videoIdentityConflict?null:playerId || activeId || links.map(e=>workId(e.href)).find(Boolean) || workId(location.href) || null;
    const authorElement = links.find(e => /\/user\//.test(e.href)) || [...(container?.querySelectorAll('span,div')??[])].find(e=>e.childElementCount===0 && /^@/.test(clean(e.textContent)) && visible(e));
    const titleElement = container?.querySelector('[data-e2e="video-desc"],[data-e2e="video-title"],[data-e2e="detail-video-info"],[class*="video-info-detail"]');
    const detailAuthor=container?.querySelector('[data-e2e="related-video"]')?.innerText?.split('\n').map(clean).find(Boolean);
    const captionAuthor=/@([^·\n]+)·/.exec(titleElement?.textContent??'')?.[1]?.trim();
    const r = element.getBoundingClientRect();
    video = { id, url: id ? `https://www.douyin.com/video/${id}` : null,
      author: clean(authorElement?.textContent).replace(/^@\s*/, '') || detailAuthor || captionAuthor || null,
      title: clean(titleElement?.getAttribute('data-e2e')==='detail-video-info'?titleElement.innerText.split('\n')[0]:titleElement?.textContent) || clean(links.find(e=>workId(e.href))?.textContent) || null,
      time: element.currentTime, duration: Number.isFinite(element.duration) ? element.duration : null,
      paused: element.paused, muted: element.muted, readyState: element.readyState,
      width: element.videoWidth, height: element.videoHeight,
      viewport: { x: Math.max(0,r.left), y: Math.max(0,r.top), width: Math.min(innerWidth,r.right)-Math.max(0,r.left), height: Math.min(innerHeight,r.bottom)-Math.max(0,r.top) } };
  }
  const route = new URL(location.href);
  const recommendFeed = ['/', '/recommend', '/recommend/'].includes(route.pathname) && !workId(route.href);
  const feedCards = [...document.querySelectorAll('[data-e2e="feed-active-video"],[data-e2e="feed-live-card"],[data-e2e="feed-live"]')].filter(e => visible(e) && !e.closest(privateArea));
  if (!activeContainer && feedCards.length === 1) activeContainer = feedCards[0];
  let livePreview = null;
  if (recommendFeed && activeContainer?.matches('[data-e2e="feed-active-video"],[data-e2e="feed-live-card"],[data-e2e="feed-live"]') && !video?.id && !privateChatVisible && !loginRequired && !verificationRequired) {
    const roomIds = [...activeContainer.querySelectorAll('a[href]')].filter(visible).map(link => {
      try { const target = new URL(link.href, location.href); return target.origin === 'https://live.douyin.com' ? /^\/(\d{4,30})\/?$/.exec(target.pathname)?.[1] : null; } catch { return null; }
    }).filter(Boolean);
    const unique = [...new Set(roomIds)];
    if (unique.length === 1) {
      const r = (element || activeContainer).getBoundingClientRect();
      livePreview = { recognized: true, source: 'active-feed-live-link', scope: 'recommend-feed', roomId: unique[0],
        viewport: { x: Math.max(0,r.left), y: Math.max(0,r.top), width: Math.min(innerWidth,r.right)-Math.max(0,r.left), height: Math.min(innerHeight,r.bottom)-Math.max(0,r.top) } };
    }
  }
  let photoGallery = null;
  if (!video?.id && !livePreview && activeContainer && !privateChatVisible && !loginRequired && !verificationRequired) {
    const images = [...activeContainer.querySelectorAll('img')].filter(img => visible(img) && !img.closest(privateArea)).map(img => {
      const r = img.getBoundingClientRect();
      return { r, area: Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left)) * Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) };
    }).filter(x => x.r.width >= innerWidth * 0.2 && x.r.height >= innerHeight * 0.25 && x.area >= innerWidth * innerHeight * 0.12).sort((a, b) => b.area - a.area);
    if (images.length) {
      const links = [...activeContainer.querySelectorAll('a[href]')].filter(e => visible(e));
      const id = workId(location.href) || links.map(e => workId(e.href)).find(Boolean) || null;
      const best = images[0].r;
      photoGallery = { recognized: true, source: 'active-feed-large-images', id, url: id ? `https://www.douyin.com/video/${id}` : null,
        author: clean(links.find(e => /\/user\//.test(e.href))?.textContent).replace(/^@\s*/, '') || null,
        title: clean(activeContainer.querySelector('[data-e2e="video-desc"],[data-e2e="video-title"],[class*="video-info-detail"]')?.textContent) || null,
        imageCount: images.length, imageCountScope: 'visible-large-images-only',
        viewport: { x: Math.max(0, best.left), y: Math.max(0, best.top), width: Math.min(innerWidth, best.right) - Math.max(0, best.left), height: Math.min(innerHeight, best.bottom) - Math.max(0, best.top) } };
    }
  }
  const searchResults = [];
  let adLike = null;
  if (activeContainer && !privateChatVisible && !loginRequired && !verificationRequired) {
    const tagRe = /^(广告|赞助|推广|广告主|推广内容|广告·推广|赞助·推广)$/;
    const scope = activeContainer.querySelector('[data-e2e="video-desc"]')?.closest('div') || activeContainer;
    const hit = [...scope.querySelectorAll('div,span')].filter(e => !e.childElementCount && visible(e)).find(e => tagRe.test(clean(e.textContent)));
    if (hit) {
      const r = hit.getBoundingClientRect();
      adLike = { recognized: true, source: 'active-feed-ad-label', label: clean(hit.textContent).slice(0,16),
        viewport: { x: Math.max(0,r.left), y: Math.max(0,r.top), width: Math.min(innerWidth,r.right)-Math.max(0,r.left), height: Math.min(innerHeight,r.bottom)-Math.max(0,r.top) } };
    }
  }
  if (location.pathname.startsWith('/search/')) {
    const candidates = [...document.querySelectorAll('.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"],a[href*="/video/"],a[href*="modal_id="]')].filter(visible);
    const used = new Set();
    for (const candidate of candidates) {
      const anchor = candidate.matches('a') ? candidate : candidate.querySelector('a[href*="/video/"],a[href*="modal_id="]');
      const id = workId(anchor?.href) || candidate.getAttribute('data-aweme-id') || /waterfall_item_(\d+)/.exec(candidate.closest('[id^="waterfall_item_"]')?.id??'')?.[1];
      const card = candidate.closest('.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"]') || candidate;
      const leaves = [...card.querySelectorAll('div,span')].filter(e=>!e.childElementCount).map(e=>clean(e.textContent));
      const title = clean(card.querySelector('[data-e2e="video-desc"],[data-e2e="video-title"]')?.textContent) || leaves.sort((a,b)=>b.length-a.length)[0] || clean(card.textContent);
      if (!title || used.has(id || title)) continue;
      used.add(id || title);
      searchResults.push({ index: searchResults.length, id: id || null, url: id ? `https://www.douyin.com/video/${id}` : null,
        title: title.slice(0,1000), author: clean(card.querySelector('a[href*="/user/"]')?.textContent).replace(/^@\s*/, '') || /@([^\n·]+)/.exec(card.innerText)?.[1]?.trim() || null });
    }
  }
  const u = new URL(location.href);
  for (const key of [...u.searchParams.keys()]) if (!['modal_id','aweme_id','recommend'].includes(key)) u.searchParams.delete(key);
  return { url: u.href, title: document.title, video, photoGallery, adLike, videoSelection: { candidateCount: videoElements.length, ambiguous: videoElements.length > 1 || videoIdentityConflict, identityConflict: videoIdentityConflict }, pageKind: livePreview ? 'live-preview' : video?.id ? 'video' : photoGallery?.recognized === true ? 'photo-gallery' : location.pathname.startsWith('/search/') ? 'search' : 'unknown', livePreview, searchResults: searchResults.slice(0,20), visibleText: text,
    loginRequired, verificationRequired, privateChatVisible, documentReadyState: document.readyState };
}

export class BrowserController {
  constructor({ source = 'api', memory, videoLimits, personaMemory, controlDirectory = CONTROL } = {}) {
    if (!['api','dsh','verification','api-chat','dsh-chat'].includes(source)) throw new TypeError('不支持这个浏览器入口。');
    if(!path.isAbsolute(controlDirectory))throw new TypeError('浏览器控制目录须为绝对路径。');
    this.controlDirectory=controlDirectory;
    this.source = source; this.memory = memory; this.personaMemory = personaMemory; this.browser = null; this.page = null;
    this.queue = Promise.resolve();
    this.videoLimits = videoLimits;
    this.limitsEnabled = ['api','dsh'].includes(source);
  }
  limits() { return this.videoLimits ??= new VideoLimits(); }
  getMediaAdapter() { return this.mediaPromise??=import('./media/index.mjs?v=10').then(({MediaAdapter})=>new MediaAdapter()); }
  getForwarder() { return this.forwarderPromise??=import('./video-forward.mjs?v=10').then(({VideoForwarder})=>new VideoForwarder({videoLimits:this.limits(),source:this.source==='dsh'?'dsh':'api'})); }
  getOutbound() { return this.outboundPromise??=import('./outbound-service.mjs').then(({OutboundService})=>new OutboundService({stateDir:this.limits().stateDir,source:this.source==='dsh'?'dsh':'api'})); }
  watchVideoLimits() {
    if (!this.limitsEnabled || this.cancelLimitsWatch) return;
    this.cancelLimitsWatch = this.limits().watch({ sources:[this.source], pause:()=>this.pauseForLimits() });
  }
  async checkVideoLimits(name) {
    if (!this.limitsEnabled) return;
    const decision=this.limits().beforeAction(this.source,name);
    if (!decision.allowed) {
      await this.pauseForLimits();
      throw new Error(decision.reason || '当前不在允许的刷视频时间内，请在本机设置开始一轮。');
    }
  }
  async pauseForLimits() {
    if (!['api','dsh'].includes(this.source)) return { paused:0, existingPage:false };
    let accountingError;
    try { this.limits().settleWatching?.(this.source); } catch(error) { if(error.code!=='VIDEO_CONTROL_BUSY')accountingError=error; }
    let connection=this.browser, temporary=false;
    try {
      if(!connection?.isConnected()) {
        let owner;
        try { owner=JSON.parse(readFileSync(path.join(CONTROL,'browser.json'),'utf8')); } catch { return {paused:0,existingPage:false}; }
        if(owner.profile!==PROFILE || owner.port!==PORT || !owner.ready || !alive(owner.pid) || !await version()) return {paused:0,existingPage:false};
        connection=await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`,{timeout:3000}); temporary=true;
      }
      let paused=0,existingPage=false;
      for(const candidate of connection.contexts().flatMap(context=>context.pages())) {
        if(candidate.isClosed() || await candidate.evaluate(()=>window.name).catch(()=>'')!==`deepseek-douyin-${this.source}`) continue;
        existingPage=true;
        paused+=await candidate.evaluate(()=>{
          if(location.origin!=='https://www.douyin.com') return 0;
          let count=0;
          for(const video of document.querySelectorAll('video')) {if(!video.paused) count++;video.pause();}
          return count;
        }).catch(()=>0);
      }
      return {paused,existingPage};
    } finally {
      if(temporary) await connection?.close().catch(()=>{});
      for(let attempt=0;attempt<5;attempt++){try{this.limits().settleWatching?.(this.source);break;}catch(error){if(error.code!=='VIDEO_CONTROL_BUSY'){accountingError ||=error;break;}if(attempt<4)await new Promise(resolve=>setTimeout(resolve,25));}}
      if(accountingError)throw accountingError;
    }
  }
  store() { return this.memory ??= new MemoryStore(resolveRuntimePaths().memoryDbPath); }
  getPersonaMemory() {
    if (!this.personaMemory) {
      this.personaMemory = new PersonaMemory({ memoryDir: path.dirname(this.memory?.dbPath || resolveRuntimePaths().memoryDbPath) });
      this.personaMemory.initialize({ importLegacy: false });
    }
    return this.personaMemory;
  }
  getChatService() {
    this.chatPromise??=Promise.all([import('./chat-browser.mjs?v=18'),import('./chat-service.mjs?v=18'),import('./usage-ledger.mjs')])
      .then(([{ChatBrowser},{ChatService},{UsageLedger}])=>{const stateDir=this.limits().stateDir,source=this.source==='dsh'?'dsh':'api';const service=new ChatService({stateDir,browser:new ChatBrowser({source:source==='dsh'?'dsh-chat':'api-chat'})});service.agent.personaMemory=this.getPersonaMemory();service.agent.usageLedger=new UsageLedger({stateDir});service.agent.source=source;return service;})
      .catch(error=>{this.chatPromise=null;throw error;});
    return this.chatPromise;
  }
  getSparkService() {
    this.sparkPromise ??= Promise.all([this.getChatService(), import('./spark-service.mjs?v=18')]).then(([chat, { SparkService }]) => new SparkService({ browser: chat.browser, config: chat.config, personaMemory: this.getPersonaMemory(), stateDir: this.limits().stateDir, source: this.source === 'dsh' ? 'dsh' : 'api' })).catch(error => { this.sparkPromise = null; throw error; });
    return this.sparkPromise;
  }
  getCommenter() {
    this.commenterPromise ??= import('./comment-browser.mjs?v=18').then(({ CommentBrowser }) => new CommentBrowser({ source: this.source === 'dsh' ? 'dsh' : 'api', videoLimits: this.limits(), stateDir: this.limits().stateDir })).catch(error => { this.commenterPromise = null; throw error; });
    return this.commenterPromise;
  }
  getComments() {
    this.commentsPromise ??= import('./autonomous-comments.mjs?v=10').then(({ AutonomousComments }) => new AutonomousComments({ controller: this, personaMemory: this.getPersonaMemory(), videoLimits: this.limits(), stateDir: this.limits().stateDir, source: this.source === 'dsh' ? 'dsh' : 'api' })).catch(error => { this.commentsPromise = null; throw error; });
    return this.commentsPromise;
  }
  getReport() {
    this.reportPromise ??= import('./daily-report.mjs?v=10').then(({ DailyReport }) => new DailyReport({ personaMemory: this.getPersonaMemory() })).catch(error => { this.reportPromise = null; throw error; });
    return this.reportPromise;
  }
  getWatchMode() {
    this.modePromise ??= import('./watch-mode.mjs?v=18').then(({ WatchMode }) => new WatchMode({ stateDir: this.limits().stateDir, source: this.source === 'dsh' ? 'dsh' : 'api' }));
    return this.modePromise;
  }
  async applyWatchMode({ minimize = false } = {}) {
    if (!['api', 'dsh'].includes(this.source)) return { applied: false, reason: '当前入口不管理视频静默设置。' };
    const mode = await this.getWatchMode();
    return mode.applyBrowser(await this.connectExistingBrowser(), { minimize });
  }
  async connectExistingBrowser() {
    if (this.browser?.isConnected()) return this.browser;
    let owner;
    try { owner = JSON.parse(readFileSync(path.join(CONTROL, 'browser.json'), 'utf8')); } catch { return null; }
    if (owner.profile !== PROFILE || owner.port !== PORT || !owner.ready || !alive(owner.pid) || !await version()) return null;
    // 保存静默设置只重新连接已经存在的专用浏览器，不启动窗口或新建标签。
    this.browser = await connectDedicatedBrowser(`http://127.0.0.1:${PORT}`);
    return this.browser;
  }
  openBrowser({ signal } = {}) {
    const operation = this.queue.catch(() => {}).then(async () => {
      const release = await lock('browser-launcher', signal,this.controlDirectory);
      try {
        this.browserLauncher ??= new BrowserLauncher({
          getBrowser: async currentSignal => { if (!this.browser?.isConnected()) { this.browser = await connectDedicatedBrowser(await endpoint(currentSignal), { signal: currentSignal }); this.page = null; } return this.browser; },
          getWatchState: () => { const worker = optionalRecord(path.join(this.limits().stateDir, 'watch-loop.lock')); if (!worker) return null; if (!Number.isSafeInteger(worker.pid) || worker.pid < 1 || !['api', 'dsh'].includes(worker.source) || typeof worker.runId !== 'string') throw new Error('自主观看锁无法核对，未打开或改动入口页。'); return alive(worker.pid) ? worker : null; },
        });
        return await this.browserLauncher.open({ signal });
      } finally { release(); }
    });
    this.queue = operation; return operation;
  }
  async connect(signal) {
    aborted(signal);
    // 私信与观看共用同一个标签页（主人 2026-10-31 拍板）：少一个页面就少一份内存，也不会两个页面同时自动播视频。
    // 共用后靠 tab-claim 锁与浏览器租约串行；私信读完会把页面送回推荐流（chat-service 里那段）。
    const sharedTab=this.source==='dsh'||this.source==='dsh-chat';
    const label=`deepseek-douyin-${sharedTab?'dsh':this.source}`;
    if(this.browser?.isConnected()&&this.page&&!this.page.isClosed()) {
      if(this.source==='verification')return this.page;
      if(await this.page.evaluate(()=>window.name).catch(()=>null)===label) {
        let owned=0;
        for(const candidate of this.browser.contexts()[0].pages()){aborted(signal);if(!candidate.isClosed()&&await candidate.evaluate(()=>window.name).catch(()=>null)===label)owned++;}
        if(owned>1)throw new Error('发现多个归属相同的专用标签，请保留一个后再试。');
        if(owned===1)return this.page;
      }
      this.page=null;
    }
    if(!this.browser?.isConnected()){this.browser=await connectDedicatedBrowser(await endpoint(signal),{signal});this.page=null;}
    const releaseClaim=await lock('tab-claim',signal,this.controlDirectory);
    try {
      const context=this.browser.contexts()[0],matching=[];
      for(const candidate of context.pages()){aborted(signal);if(!candidate.isClosed()&&await candidate.evaluate(()=>window.name).catch(()=>null)===label)matching.push(candidate);}
      if(matching.length>1)throw new Error('发现多个归属相同的专用标签，请保留一个后再试。');
      this.page=matching[0]||null;
      if(!this.page){
        const initial=[];
        for(const candidate of context.pages()){if(candidate.isClosed()||candidate.url()!=='about:blank')continue;if(await candidate.evaluate(()=>!window.name&&!document.body?.textContent?.trim()&&document.querySelectorAll('body *').length===0).catch(()=>false))initial.push(candidate);}
        this.page=initial.length===1?initial[0]:await context.newPage();
        await this.page.evaluate(name=>{window.name=name;},label);
      }
      this.page.setDefaultTimeout(10_000);this.page.setDefaultNavigationTimeout(25_000);aborted(signal);
      if(await this.page.evaluate(()=>window.name)!==label)throw new Error('专用标签页归属未通过核对，未继续操作。');
      // 合并标签页后，旧的私信专用页会变成多出来的一份：关掉它，避免它继续在后台自动播视频。
      if(sharedTab){
        for(const candidate of context.pages()){
          if(candidate===this.page||candidate.isClosed())continue;
          if(await candidate.evaluate(()=>window.name).catch(()=>null)==='deepseek-douyin-dsh-chat')await candidate.close().catch(()=>{});
        }
      }
    }finally{releaseClaim();}
    if(this.page.url()==='about:blank') {
      if(this.source.endsWith('-chat')){await this.page.goto(RECOMMEND,{waitUntil:'domcontentloaded'});await this.page.evaluate(name=>{window.name=name;},label);await this.page.locator('[data-e2e="im-entry"]').waitFor({state:'visible',timeout:15_000});}
      else await this.navigate(RECOMMEND,signal);
    }
    return this.page;
  }

  async navigate(url, signal) {
    aborted(signal);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.evaluate(name => { window.name = name; }, `deepseek-douyin-${this.source}`);
    if (url === RECOMMEND && this.page.url().includes('/jingxuan')) {
      await this.page.locator('a').filter({hasText:/^推荐$/}).click();
    }
    const targetId=/\/video\/(\d+)/.exec(url)?.[1];
    await this.settle(signal, {kind:targetId?'video':url.includes('/search/')?'search':'recommend',videoId:targetId});
  }
  async settle(signal, {kind='recommend',videoId}={}) {
    for (let i=0;i<16;i++) {
      aborted(signal);
      const state = await this.page.evaluate(readPageState);
      if(state.loginRequired||state.verificationRequired) return state;
      const detail=/\/video\/\d+/.test(state.url??'')||/[?&]modal_id=\d+/.test(state.url??'');
      if(kind==='search' && state.searchResults.length && !detail) return state;
      if(kind==='search' && /暂无搜索结果|没有找到相关|暂无结果/.test(state.visibleText)) return state;
      if(kind==='video' && detail && ((state.video?.id===videoId && state.video.readyState>=2) || (state.photoGallery?.id===videoId))) return state;
      if(kind==='recommend' && (state.video?.id && state.video.readyState>=2 || state.livePreview?.recognized === true || state.photoGallery?.recognized === true)) return state;
      await wait(500, signal);
    }
    throw new Error(kind==='search'?'搜索结果未就绪，未确认搜索完成。':kind==='video'?'目标作品尚未加载完成，请读取状态后重试。':'推荐流尚未读到就绪视频。');
  }
  async state({ record = true } = {}) {
    const state = await this.page.evaluate(readPageState);
    if (['api','dsh'].includes(this.source)) this.limits().notePlayback?.(this.source,state);
    if (record && state.video?.id) {
      try { this.store().recordVideo(state, this.source); } catch { state.memoryWarning = '视频状态已读取，记忆记录暂不可用。'; }
    }
    return state;
  }
  withPage(callback,{signal}={}) {
    const operation=this.queue.catch(()=>{}).then(async()=>{
      const release=await lock(`tab-${this.source}`,signal,this.controlDirectory);
      const releaseLease=await acquireBrowserLease(signal,this.controlDirectory);
      const onAbort=()=>{this.browser?.close().catch(()=>{});};
      signal?.addEventListener('abort',onAbort,{once:true});
      let restoreWindow=null;
      try {
        aborted(signal);
        const page=await this.connect(signal);
        aborted(signal);
        if (['api', 'dsh'].includes(this.source)) {
          const mode=await this.getWatchMode();
          await mode.apply(page);
          // 静默模式最小化的窗口里坐标和命中都不可靠：操作前临时恢复显示，结束后再收回。
          restoreWindow=await mode.ensureInteractive(page).catch(()=>null);
        }
        if(new URL(page.url()).origin!=='https://www.douyin.com') throw new Error('专用标签页已离开抖音，请重新打开抖音后操作。');
        return await callback(page,signal);
      }finally{
        if(restoreWindow) await restoreWindow().catch(()=>{});
        signal?.removeEventListener('abort',onAbort);release();releaseLease();
      }
    });
    this.queue=operation;return operation;
  }
  execute(name, args = {}, { signal, humanAuthorized = false, autonomousRunId, expectedVideoId } = {}) {
    const definition = TOOL_DEFINITIONS.find(tool=>tool.name===name);
    if (!definition) return Promise.reject(new Error('不支持的抖音工具。'));
    try { validateToolArguments(definition,args); } catch(error) { return Promise.reject(error); }
    if(expectedVideoId!==undefined&&(!['douyin_next','douyin_previous'].includes(name)||typeof expectedVideoId!=='string'||!/^\d{1,64}$/.test(expectedVideoId)))return Promise.reject(new TypeError('预期作品ID只供换片宿主使用，须为纯数字字符串。'));
    if (name.startsWith('douyin_diagnostics')) {
      if (!this.diagnosticsService) return Promise.reject(new Error('诊断服务尚未加载，请更新插件或软件。'));
      signal?.throwIfAborted();
      return name === 'douyin_diagnostics' ? this.diagnosticsService.run() : this.diagnosticsService.repair(args, { signal });
    }
    const operation = this.queue.catch(()=>{}).then(async()=>{
      let releaseNativeLease;
      try {
      aborted(signal);
      if(this.source==='dsh'&&!autonomousRunId&&VIDEO_ACTIONS.has(name)) releaseNativeLease=await acquireNativeVideoLease(this.limits().stateDir,signal);
      if (this.limitsEnabled && ['douyin_open','douyin_search','douyin_open_video','douyin_next','douyin_previous','douyin_observe','douyin_screenshot','douyin_play','douyin_listen','douyin_pause'].includes(name)) {
        let owner;
        try { owner=JSON.parse(readFileSync(path.join(this.limits().stateDir,'watch-loop.lock'),'utf8')); }
        catch(error) { if(error.code!=='ENOENT' && name!=='douyin_pause') throw new Error('自主观看锁无法核对，未操作视频。'); }
        if(owner) {
          let living=false;
          if(!Number.isSafeInteger(owner.pid)||owner.pid<1||typeof owner.runId!=='string') { if(name!=='douyin_pause')throw new Error('自主观看锁无效，未操作视频。'); }
          else { try {process.kill(owner.pid,0);living=true;}catch(error){living=error.code==='EPERM';} }
          if(living && owner.runId!==autonomousRunId) {
            if(name!=='douyin_pause') throw Object.assign(new Error('自主观看正在运行，请先停止它再手动操作视频。'),{status:409});
            const requestFile=path.join(this.limits().stateDir,'watch-stop.request.json'),temporary=`${requestFile}.${randomUUID()}.tmp`;
            try {writeFileSync(temporary,JSON.stringify({runId:owner.runId,requestedAt:Date.now()}),{flag:'wx'});renameSync(temporary,requestFile);}
            finally {try{unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
          }
        }
      }
      if(name.startsWith('douyin_chat_')) {
        const chat=await this.getChatService();aborted(signal);
        if(name==='douyin_chat_contacts') return chat.listContacts({signal});
        if(name==='douyin_chat_status') return chat.state();
        if(name==='douyin_chat_start') return chat.start({signal});
        if(name==='douyin_chat_stop') return chat.stop();
        if(name==='douyin_chat_read') return chat.readConversation(args.recipientId,{signal});
        if(name==='douyin_chat_observe') return chat.observeMessage(args.recipientId,args.messageId,{signal});
      }
      if (name.startsWith('douyin_spark_')) {
        if(name==='douyin_spark_start') throw new Error('自动续火花功能已移除。');
        const spark = await this.getSparkService(); aborted(signal);
        if (name === 'douyin_spark_status') return spark.state();
        if (name === 'douyin_spark_start') return spark.start({ schedule: true, explicit: true });
        if (name === 'douyin_spark_stop') return spark.stop({ explicit: true });
      }
      if (name === 'douyin_report_status') return (await this.getReport()).state();
      if (name === 'douyin_report_generate') return (await this.getReport()).generate({ reason: 'manual' });
      if (name === 'douyin_usage_bill') {
        const { UsageBill, renderBill } = await import('./usage-bill.mjs'); aborted(signal);
        const bill = new UsageBill({ stateDir: this.limits().stateDir }).read({ days: args.days ?? 7 });
        return { ...bill, markdown: renderBill(bill) };
      }
      if(name==='douyin_media_status') return (await this.getMediaAdapter()).status();
      if(name==='douyin_forward_video') {
        if(humanAuthorized!==true) return {sent:false,requiresUserAction:true,note:'请在本机控制台选择这位好友并点击转发；此工具不会代替人类按钮授权。',recipientId:args.recipientId,url:args.url??null};
        return (await this.getForwarder()).forward(args,{signal,humanAuthorized:true});
      }
      if (name==='douyin_recall') return this.store().recall({query:args.query??'',limit:args.limit??10});
      if (name==='douyin_persona_status') return this.getPersonaMemory().snapshot();
      if (name==='douyin_watch_status') {
        const {AutonomousWatch}=await import('./autonomous-watch.mjs?v=10');
        this.watchStatusReader??=new AutonomousWatch({controller:this,config:{},videoLimits:this.limits(),personaMemory:this.getPersonaMemory(),source:this.source==='dsh'?'dsh':'api',stateDir:this.limits().stateDir});
        return this.watchStatusReader.state();
      }
      if (name==='douyin_interest_record') return this.getPersonaMemory().updateAgentInterests({ evidenceId:args.evidenceId,topics:[{topic:args.topic,signal:args.signal}],reflection:args.reflection },{source:this.source==='dsh'?'dsh':'api'});
      if (name==='douyin_remember') {
        const state = this.page && !this.page.isClosed() ? await this.state({record:false}) : null;
        return this.store().remember({content:args.content,kind:args.kind??'note',source:this.source,
          videoId:state?.video?.id,url:state?.video?.url,author:state?.video?.author,title:state?.video?.title});
      }
      if(name==='douyin_video_limits_status') return this.limits().state();
      if (name === 'douyin_dm_send' || name === 'douyin_comment_reply') {
        const outbound = await this.getOutbound(); aborted(signal);
        return name === 'douyin_dm_send'
          ? outbound.sendDm(args, { signal })
          : outbound.replyComment(args, { signal });
      }
      this.watchVideoLimits();
      await this.checkVideoLimits(name);
      const release = await lock(`tab-${this.source}`,signal,this.controlDirectory);
      let onAbort;
      try {
        onAbort = () => { this.browser?.close().catch(()=>{}); };
        signal?.addEventListener('abort',onAbort,{once:true});
        await this.connect(signal);
        aborted(signal);
        if (['api', 'dsh'].includes(this.source)) {
          const mode = await this.getWatchMode();
          await mode.apply(this.page);
          if (mode.state().silent) {
            await mode.applyBrowser(this.browser, { minimize: true });
          }
        }
        await this.checkVideoLimits(name);
        if(this.limitsEnabled && !this.limits().state().allowed) await this.pauseForLimits();
        if(!['douyin_open','douyin_search','douyin_open_video'].includes(name) && new URL(this.page.url()).origin!=='https://www.douyin.com') {
          return this.page.evaluate(readPageState);
        }
        if (name==='douyin_open') await this.navigate(RECOMMEND,signal);
        if (name==='douyin_search') await this.navigate(`https://www.douyin.com/search/${encodeURIComponent(args.query)}`,signal);
        if (name==='douyin_open_video') {
          if (args.url) await this.navigate(`https://www.douyin.com/video/${/\/video\/(\d+)/.exec(args.url)[1]}`,signal);
          else {
            const before = await this.state();
            const result = before.searchResults.find(item=>item.index===args.index);
            if (!result) throw new Error('这个 index 不在当前可见搜索结果内，请重新搜索。');
            const card = result.id ? this.page.locator(`[id="waterfall_item_${result.id}"] .search-result-card`) : this.page.locator('.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"]').filter({visible:true}).nth(args.index);
            if(await card.count()) { await card.click(); await this.settle(signal,{kind:'video',videoId:result.id}); }
            else if(result.url) await this.navigate(result.url,signal);
            else throw new Error('搜索结果卡片已变化，请重新搜索。');
          }
        }
        if (name==='douyin_ocr_screen') return await this.ocrScreen(args,signal);
        if (name==='douyin_next'||name==='douyin_previous') return await this.switchVideo(name==='douyin_next'?1:-1,signal,{recordLearning:!autonomousRunId,expectedVideoId});
        if (name==='douyin_play'||name==='douyin_pause') {
          await (await this.currentVideo()).evaluate(async(video, play)=>{ if(play) await video.play();else video.pause(); },name==='douyin_play');
          if (name==='douyin_play') await wait(600,signal);
        }
        if (name==='douyin_observe'||name==='douyin_screenshot') {
          const held = await this.holdCurrentVideo();
          try { return limitFrames(await this.capture(name==='douyin_observe'?args.seconds??3:0,signal,{recordLearning:!autonomousRunId})); }
          finally { await this.releaseVideo(held); }
        }
        if(name==='douyin_listen') return await this.listen(args.seconds??8,signal,{prompt:args.prompt??null});
        if(name==='douyin_comments') return await this.readComments(args.maxRows??10,signal);
        if(name==='douyin_danmaku') return await this.readDanmaku({limit:args.limit??7},signal);
        if(name==='douyin_mention_scan') return await this.scanOwnMentions({maxWorks:args.maxWorks??4},signal);
        if(name==='douyin_mention_reply') return await this.replyToMention({workUrl:args.workUrl,index:args.index,text:args.text,dryRun:args.dryRun===true},signal);
        if(name==='douyin_seek') return await this.seekVideo(args.seconds??0,signal);
        if(name==='douyin_capture_coverage') {
          const held = await this.holdCurrentVideo();
          try { return limitFrames(await this.captureCoverage({maxFrames:args.maxFrames??18},signal)); }
          finally { await this.releaseVideo(held); }
        }
        aborted(signal);
        return this.state();
      } finally { signal?.removeEventListener('abort',onAbort); release(); }
      } finally { await releaseNativeLease?.(); }
    });
    this.queue=operation; return operation;
  }
  async currentVideo() {
    const index = await this.page.locator('video').evaluateAll(videos=>videos.map((video,index)=>{
      const r=video.getBoundingClientRect(),style=getComputedStyle(video);
      let painted=style.display!=='none'&&style.visibility!=='hidden'&&!video.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]');
      for(let node=video;node&&painted;node=node.parentElement)if(Number(getComputedStyle(node).opacity)===0)painted=false;
      return {index,area:painted?Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left))*Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top)):0};
    }).filter(item=>item.area>0).sort((a,b)=>b.area-a.area)[0]?.index);
    if(index===undefined) throw new Error('没有在视口内找到视频。');
    return this.page.locator('video').nth(index);
  }
  async switchVideo(direction,signal,{recordLearning=true,expectedVideoId}={}) {
    if(![-1,1].includes(direction))throw new TypeError('换片方向须为上一条或下一条。');
    if(expectedVideoId!==undefined&&(typeof expectedVideoId!=='string'||!/^\d{1,64}$/.test(expectedVideoId)))throw new TypeError('预期作品ID须为纯数字字符串。');
    const blocked=state=>state.loginRequired||state.verificationRequired||state.privateChatVisible||state.unsupportedPage;
    const identity=state=>{
      if(blocked(state)||state.videoSelection?.ambiguous||state.videoSelection?.candidateCount>1)return null;
      if(typeof state.video?.id==='string'&&/^\d{1,64}$/.test(state.video.id)&&state.video.readyState>=2)return `video:${state.video.id}`;
      if(state.pageKind==='live-preview'&&state.livePreview?.recognized===true&&/^\d{4,30}$/.test(state.livePreview.roomId||''))return `live:${state.livePreview.roomId}`;
      return null;
    };
    let before,previousIdentity=null,stableSamples=0,beforeIdentity=null;
    for(let attempt=0;attempt<18;attempt++){
      aborted(signal);before=await this.state();
      if(blocked(before))return{changed:false,before:before.video,after:before.video,state:before,reasonCode:'switch-blocked'};
      const currentIdentity=identity(before);stableSamples=currentIdentity&&currentIdentity===previousIdentity?stableSamples+1:currentIdentity?1:0;
      previousIdentity=currentIdentity;
      if(stableSamples>=2){beforeIdentity=currentIdentity;break;}
      if(attempt<17)await wait(300,signal);
    }
    if(!beforeIdentity)return{changed:false,before:before?.video,after:before?.video,state:before,reasonCode:'video-identity-not-ready'};
    const beforeLive=beforeIdentity.startsWith('live:');
    if(expectedVideoId!==undefined){
      if(beforeLive)return{changed:false,before:before.video,after:before.video,state:before,expectedVideoId,reasonCode:'expected-video-unavailable'};
      if(before.video.id!==expectedVideoId)return{changed:false,staleObservation:true,reasonCode:'observed-video-changed',expectedVideoId,before:before.video,after:before.video,state:before};
    }
    let skipEvidenceId=null;
    if(recordLearning && direction>0 && before.video?.id && this.lastObservationVideoId===before.video.id && this.lastObservationEvidenceId && this.lastObservationState?.video?.id===before.video.id) {
      const wallSeconds=(Date.now()-this.lastObservationAt)/1000;
      if(Number.isFinite(wallSeconds) && wallSeconds>0 && wallSeconds<=30) {
        try {
          const viewing=this.getPersonaMemory().recordViewing?.({evidenceId:this.lastObservationEvidenceId,from:this.lastObservationState,to:before,wallSeconds,sampleId:randomUUID()},{source:this.source});
          if(viewing?.accepted===true) skipEvidenceId=this.lastObservationEvidenceId;
        }catch{/* 不能核实等待期间的进度时不补记快划偏好，换片仍按原操作执行。**/}
      }
    }
    const arrow=this.page.locator(`[data-e2e="video-switch-${direction>0?'next':'prev'}-arrow"]`).filter({visible:true});
    let inputDenied=null;
    const denied=(state,reasonCode)=>({changed:false,before:state.video,after:state.video,state,reasonCode});
    const checkPendingInput=async()=>{
      aborted(signal);await this.checkVideoLimits(direction>0?'douyin_next':'douyin_previous');aborted(signal);
      const current=await this.state(),currentIdentity=identity(current);
      if(blocked(current)){inputDenied=denied(current,'switch-blocked');return false;}
      if(currentIdentity!==beforeIdentity){
        if(expectedVideoId!==undefined&&currentIdentity?.startsWith('video:')&&current.video.id!==expectedVideoId){
          await wait(300,signal);await this.checkVideoLimits(direction>0?'douyin_next':'douyin_previous');const confirmed=await this.state();
          inputDenied=identity(confirmed)===currentIdentity?{...denied(confirmed,'observed-video-changed'),staleObservation:true,expectedVideoId}:denied(confirmed,'video-changed-before-input');
        }else inputDenied=denied(current,'video-changed-before-input');
        return false;
      }
      before=current;return true;
    };
    if(!await checkPendingInput())return inputDenied;
    const arrowCount=await arrow.count();
    if(arrowCount>1)return denied(before,'switch-control-ambiguous');
    const control=arrowCount===1?arrow.first():null,token=`video-switch-${randomUUID()}`;
    const sameGeometry=(left,right)=>Boolean(left&&right&&['x','y','width','height'].every(key=>Math.abs(left[key]-right[key])<=0.5));
    const readPoint=async()=>{
      if(control){
        if(await arrow.count()!==1||!await control.isVisible()||!await control.isEnabled())return null;
        return control.evaluate((element,currentToken)=>{
          if(element.getAttribute('data-deepseek-switch-token')!==currentToken||element.closest('[disabled],[aria-disabled="true"]'))return null;
          const r=element.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
          if(r.width<2||r.height<2||x<0||y<0||x>=innerWidth||y>=innerHeight||!hit||hit!==element&&!element.contains(hit))return null;
          return{x:r.x,y:r.y,width:r.width,height:r.height,clickX:x,clickY:y};
        },token);
      }
      const box=before.video?.viewport||before.livePreview?.viewport;
      if(!box||box.width<2||box.height<2)return null;
      return this.page.evaluate(rect=>{
        const x=rect.x+rect.width/2,y=rect.y+rect.height/2,hit=document.elementFromPoint(x,y);
        if(x<0||y<0||x>=innerWidth||y>=innerHeight||!hit||hit.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"],#captcha_container')||!hit.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"],[data-e2e="player-container"]'))return null;
        return{...rect,clickX:x,clickY:y};
      },box);
    };
    const installInputGuard=({currentToken,expectedIdentity,selector})=>{
      const visible=element=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight&&s.display!=='none'&&s.visibility!=='hidden';};
      const privateArea='[data-e2e="im-dialog"],[data-e2e="conversation-item"]';
      const workId=value=>{try{const url=new URL(value,location.href);return /\/video\/(\d+)/.exec(url.pathname)?.[1]||url.searchParams.get('modal_id')||url.searchParams.get('aweme_id');}catch{return null;}};
      const currentIdentity=()=>{
        const videos=[...document.querySelectorAll('video')].filter(video=>{if(!visible(video)||video.closest(privateArea))return false;for(let node=video;node;node=node.parentElement)if(Number(getComputedStyle(node).opacity)===0)return false;return true;});
        if(videos.length>1)return null;
        const video=videos[0];
        if(video){
          const active=video.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"]');let root=active;
          if(!root){root=video.parentElement;for(let i=0;root?.parentElement&&i<8;i++){if(root.querySelector('[class*="video-info-detail"]'))break;root=root.parentElement;}}
          const playerId=/(?:^|\s)video_(\d+)(?:\s|$)/.exec(video.closest('[data-e2e="player-container"]')?.className??'')?.[1],activeId=/(?:^|\s)video_(\d+)(?:\s|$)/.exec(active?.className??'')?.[1];
          if(playerId&&activeId&&playerId!==activeId)return null;
          const id=playerId||activeId||[...(root?.querySelectorAll('a[href]')??[])].filter(link=>visible(link)&&!link.closest(privateArea)).map(link=>workId(link.href)).find(Boolean)||workId(location.href);
          if(id)return video.readyState>=2&&/^\d{1,64}$/.test(id)?`video:${id}`:null;
        }
        const route=new URL(location.href);if(!['/','/recommend','/recommend/'].includes(route.pathname)||workId(route.href))return null;
        const cards=[...document.querySelectorAll('[data-e2e="feed-active-video"],[data-e2e="feed-live-card"],[data-e2e="feed-live"]')].filter(card=>visible(card)&&!card.closest(privateArea));if(cards.length!==1)return null;
        const rooms=[...new Set([...cards[0].querySelectorAll('a[href]')].filter(visible).flatMap(link=>{try{const url=new URL(link.href);const id=url.origin==='https://live.douyin.com'?/^\/(\d{4,30})\/?$/.exec(url.pathname)?.[1]:null;return id?[id]:[];}catch{return[];}}))];
        return rooms.length===1?`live:${rooms[0]}`:null;
      };
      const entries=window.__deepseekVideoSwitchInputs??=Object.create(null),elements=selector?[...document.querySelectorAll(selector)].filter(visible):[],element=elements.length===1?elements[0]:null;
      if(selector&&!element)throw new Error('换片控件已变化，未安装输入核对。');
      const entry={armed:false,dispatched:false,blocked:false};if(element)element.setAttribute('data-deepseek-switch-token',currentToken);
      const types=element?['pointerdown','mousedown','mouseup','click']:['wheel'];
      const listener=event=>{
        if(!entry.armed||!event.isTrusted)return;
        if(entry.expired){entry.blocked=true;event.preventDefault();event.stopImmediatePropagation();if(event.type===(element?'click':'wheel')){entry.armed=false;entry.cleanup();delete entries[currentToken];}return;}
        const target=event.target instanceof Element?event.target:null,targetMatches=element?target&&(target===element||element.contains(target)):target?.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"],[data-e2e="player-container"]');
        const protectedPage=[...document.querySelectorAll('#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"],[data-e2e="im-dialog"]')].some(visible)||[...document.querySelectorAll('body *')].some(node=>!node.childElementCount&&visible(node)&&!node.closest(privateArea)&&/扫码登录|验证码登录|登录后即可|手机扫码登录|请完成下方验证|请完成验证|安全验证|拖动滑块/.test(node.textContent||''));
        if(!targetMatches||protectedPage||currentIdentity()!==expectedIdentity){entry.blocked=true;event.preventDefault();event.stopImmediatePropagation();return;}
        if(event.type===(element?'click':'wheel')){entry.dispatched=true;entry.armed=false;}
      };
      for(const type of types)document.addEventListener(type,listener,{capture:true,passive:false});
      entry.cleanup=()=>{clearTimeout(entry.timer);for(const type of types)document.removeEventListener(type,listener,true);if(element?.getAttribute('data-deepseek-switch-token')===currentToken)element.removeAttribute('data-deepseek-switch-token');};
      entries[currentToken]=entry;
    };
    try{
      await this.page.evaluate(installInputGuard,{currentToken:token,expectedIdentity:beforeIdentity,selector:control?`[data-e2e="video-switch-${direction>0?'next':'prev'}-arrow"]`:null});
      let stablePoint,previousPoint,geometrySamples=0;
      const deadline=performance.now()+4000;
      while(performance.now()<deadline){
        if(!await checkPendingInput())return inputDenied;
        const point=await readPoint();geometrySamples=sameGeometry(point,previousPoint)?geometrySamples+1:point?1:0;previousPoint=point;
        if(geometrySamples>=3){stablePoint=point;break;}
        await wait(75,signal);
      }
      if(!stablePoint)return denied(before,'switch-control-not-interactable');
      if(!await checkPendingInput())return inputDenied;
      const finalPoint=await readPoint();if(!sameGeometry(stablePoint,finalPoint))return denied(before,'switch-control-changed');
      aborted(signal);
      const armInput=()=>this.page.evaluate(currentToken=>{const entry=window.__deepseekVideoSwitchInputs?.[currentToken];if(!entry)return false;entry.armed=true;entry.timer=setTimeout(()=>{entry.expired=true;},1500);return true;},token);
      if(control){
        if(!await armInput())return denied(before,'switch-control-changed');
        aborted(signal);
        await this.page.mouse.click(finalPoint.clickX,finalPoint.clickY);
      }else{
        await this.page.mouse.move(finalPoint.clickX,finalPoint.clickY);
        if(!await checkPendingInput())return inputDenied;
        const wheelPoint=await readPoint();if(!sameGeometry(finalPoint,wheelPoint))return denied(before,'switch-control-changed');
        if(!await armInput())return denied(before,'switch-control-changed');
        aborted(signal);await this.page.mouse.wheel(0,direction*700);
      }
      const receipt=await this.page.evaluate(currentToken=>{const entry=window.__deepseekVideoSwitchInputs?.[currentToken];return{blocked:entry?.blocked===true,dispatched:entry?.dispatched===true};},token);
      if(receipt.blocked){if(!await checkPendingInput())return inputDenied;return denied(before,'switch-input-blocked');}
      if(!receipt.dispatched){if(!await checkPendingInput())return inputDenied;return denied(before,'switch-input-unconfirmed');}
    }finally{
      await this.page.evaluate(currentToken=>{const entry=window.__deepseekVideoSwitchInputs?.[currentToken];entry?.cleanup();if(window.__deepseekVideoSwitchInputs)delete window.__deepseekVideoSwitchInputs[currentToken];},token).catch(()=>{});
    }
    let after=before,afterIdentity=null,previousAfter=null,readySamples=0;
    // 一次输入后只回读，不在加载慢或身份暂缺时重复点击，避免连续跳过多条。
    for(let i=0;i<40;i++) {
      await wait(300,signal); after=await this.state();
      if(blocked(after))break;
      const currentIdentity=identity(after),different=currentIdentity&&currentIdentity!==beforeIdentity;
      readySamples=different?currentIdentity===previousAfter?readySamples+1:1:0;previousAfter=different?currentIdentity:null;
      if(readySamples>=2){afterIdentity=currentIdentity;break;}
    }
    const changed=Boolean(afterIdentity&&afterIdentity!==beforeIdentity);
    if(skipEvidenceId && changed && after.video?.id && after.video.id!==before.video?.id && after.video.readyState>=2) {
      try {this.getPersonaMemory().recordBehavior?.({evidenceId:skipEvidenceId,action:'skip',sampleId:randomUUID(),confirmed:true},{source:this.source});}catch{/* 学习失败不改变已确认的切片结果。**/}
    }
    return {changed,before:before.video,beforePageKind:before.pageKind,after:after.video,state:after,...(!changed?{reasonCode:blocked(after)?'switch-blocked':'switch-not-confirmed'}:{})};
  }
  // 采样期间先把当前这条按住（loop=true）：播完就不会被推荐流自动滑到下一条，
  // 否则采到的帧属于 A 作品、读到的 state 已经是 B，最后那层「必须有同一真实作品画面」的校验会整轮判失败。
  async holdCurrentVideo() {
    try { return await this.page.evaluate(() => { const video = document.querySelector('video'); if (!video || video.loop) return false; video.loop = true; return true; }); }
    catch (error) { return false; }
  }
  async releaseVideo(held) {
    if (!held) return;
    try { await this.page.evaluate(() => { const video = document.querySelector('video'); if (video) video.loop = false; }); }
    catch (error) { /* 页面已经关掉就不用还了 */ }
  }
  async capture(seconds,signal,{recordLearning=true}={}) {
    const captureStarted=Date.now();
    let state=await this.state();
    if(state.loginRequired||state.verificationRequired||state.privateChatVisible) return {state,frames:[],note:'登录、验证或私信面板遮挡画面，本次没有采集图片。'};
    if(state.livePreview?.recognized === true) return {state,frames:[],note:'当前是推荐流直播预览，不采集直播画面。'};
    if(!state.video && state.photoGallery?.recognized===true) {
      const {x,y,width,height}=state.photoGallery.viewport;
      if(width<2||height<2) return {state,frames:[],note:'识别到图文作品，但画面区域不足，本次没有采集。'};
      await this.checkVideoLimits('douyin_observe');
      const data=await this.page.screenshot({type:'jpeg',quality:65,clip:{x,y,width,height},animations:'allow',caret:'initial',timeout:10_000});
      return {state,frames:[{mimeType:'image/jpeg',data:data.toString('base64'),time:null,videoId:state.photoGallery.id}],
        observation:{seconds:0,videoId:state.photoGallery.id,kind:'photo-gallery',imageCount:state.photoGallery.imageCount,imageCountScope:state.photoGallery.imageCountScope,
          note:'这是图文作品，采到的是当前这一张大图；图集里其余的图和配文没有读到，也没有音频。'}};
    }
    if(!state.video) return {state,frames:[],note:'没有可见视频画面，请先打开作品。'};
    const frames=[],samples=seconds?Math.min(5,Math.max(3,Math.round(seconds/2)+1)):1;
    const before={...state.video}, firstState=structuredClone(state);
    let sampledState=state,sampledAt=captureStarted,stoppedReason=null;
    for(let index=0;index<samples;index++) {
      aborted(signal);
      if(index) await wait(seconds*1000/(samples-1),signal);
      state=await this.state();
      await this.checkVideoLimits('douyin_observe');
      if(state.loginRequired||state.verificationRequired||state.unsupportedPage||state.privateChatVisible||state.livePreview?.recognized === true) return {state,frames:[],note:'出现登录、验证、私信、直播预览或离开抖音，已丢弃本次画面。'};
      if(state.video?.id!==before.id) {stoppedReason='采样期间切换作品，保留的画面只属于此前作品。';break;}
      const {x,y,width,height}=state.video.viewport;
      if(width<2||height<2) break;
      // 采样保留动画和光标，避免截图期间改写播放器页面的样式。
      const data=await this.page.screenshot({type:'jpeg',quality:65,clip:{x,y,width,height},animations:'allow',caret:'initial',timeout:10_000});
      aborted(signal);
      const checked=await this.state();
      if(checked.loginRequired||checked.verificationRequired||checked.unsupportedPage||checked.privateChatVisible||checked.livePreview?.recognized === true) return {state:checked,frames:[],note:'截图期间出现登录、验证、私信、直播预览或离开抖音，已丢弃本次画面。'};
      if(checked.video?.id!==before.id) {stoppedReason='截图期间切换作品，本帧已丢弃。';break;}
      frames.push({mimeType:'image/jpeg',data:data.toString('base64'),time:state.video.time,videoId:state.video.id});
      sampledState=checked;sampledAt=Date.now();
    }
    let subtitleFrame=null;
    if(frames.length&&sampledState.video?.id===before.id){ try{ subtitleFrame=await this.captureSubtitleBand(sampledState,signal); }catch{ subtitleFrame=null; } }
    const result={state:sampledState,frames:subtitleFrame?[...frames,subtitleFrame]:frames,observation:{seconds,videoId:before.id,stoppedReason,beforeTime:before.time,beforePaused:before.paused,afterTime:sampledState.video?.time,paused:sampledState.video?.paused,
      note:'采集的是实际视频视口画面；没有音频，只能说明这些采样时刻。'}};
    if (frames.length && ['api','dsh'].includes(this.source)) {
      try {
        const persona=this.getPersonaMemory(),origin={source:this.source};
        result.personaEvidenceId=persona.recordObservation({...result,frames:result.frames.slice(0,4)},{...origin,kind:'visual'}).evidenceId;
        const wallSeconds=(sampledAt-captureStarted)/1000,sampleId=randomUUID();
        if(persona.recordViewing && wallSeconds<=30) {
          result.viewing={evidenceId:result.personaEvidenceId,sampleId,...persona.recordViewing({evidenceId:result.personaEvidenceId,from:firstState,to:sampledState,wallSeconds,sampleId},origin)};
          if(recordLearning && this.lastObservationVideoId===before.id && result.viewing.creditedSeconds>0) persona.recordBehavior?.({evidenceId:result.personaEvidenceId,action:'stay',sampleId,confirmed:true},origin);
        }
        this.lastObservationVideoId=before.id;this.lastObservationEvidenceId=result.personaEvidenceId;
        this.lastObservationState=structuredClone(sampledState);this.lastObservationAt=sampledAt;
      }
      catch { result.personaWarning='本次画面未登记为兴趣证据，不能据此更新人格兴趣。'; }
    }
    return result;
  }
  // 整段观看：把播放头移到这条作品的不同时刻各截一帧，覆盖从开头到结尾的内容，再还原播放进度。
  async seekVideo(seconds, signal) {
    aborted(signal);
    const state = await this.state({ record: false });
    if (state.loginRequired || state.verificationRequired || state.privateChatVisible) throw new Error('登录、验证或私信面板遮挡页面，未定位播放头。');
    if (!state.video || !(state.video.duration > 0)) throw new Error('当前没有可定位的公开作品。');
    const total = state.video.duration, target = Math.max(0, Math.min(total - 0.3, Number(seconds) || 0));
    await (await this.currentVideo()).evaluate((el, t) => { try { el.currentTime = t; } catch {} }, target).catch(() => {});
    await wait(260, signal);
    const after = await this.state({ record: false });
    return { ok: true, requested: target, time: after.video?.time ?? null, duration: total, videoId: after.video?.id ?? null };
  }
  // 用本地 OCR 读画面里的弹幕和字幕：跑本机 RapidOCR，不联网、不花钱。
  async ocrScreen({ shots = 5, intervalMs = 700, maxDanmaku = 7 } = {}, signal) {
    const ocr = makeOcrService();
    const box = await this.page.evaluate(() => {
      const list = [...document.querySelectorAll('video')].map((video) => {
        const rect = video.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
      }).filter((rect) => rect.w > 300 && rect.y > -40 && rect.y < 300);
      list.sort((left, right) => right.w * right.h - left.w * left.h);
      return list[0] || null;
    });
    if (!box) return { ok: false, reason: '没有可识别的视频画面。', danmaku: [], subtitles: [] };
    const danmaku = [];
    const subtitles = [];
    const seen = new Set();
    const total = Math.max(1, Math.min(8, shots));
    let extraShots = 0;
    for (let index = 0; index < total + extraShots; index += 1) {
      if (signal?.aborted) throw new Error('aborted');
      const buffer = await this.page.screenshot({ type: 'jpeg', quality: 70, clip: { x: box.x, y: box.y, width: box.w, height: box.h } }).catch(() => null);
      if (buffer) {
        const result = await ocr.readBuffer(buffer, { signal }).catch(() => null);
        if (result?.ok) {
          const parts = splitLines(result, { width: box.w, height: box.h });
          for (const line of parts.danmaku) { if (!seen.has(line)) { seen.add(line); danmaku.push(line); } }
          for (const line of parts.subtitle) { const text = line.replace(/[>»]/g, '').trim(); if (text && !subtitles.includes(text)) subtitles.push(text); }
        }
      }
      if (danmaku.length >= maxDanmaku * 2) break;
      if (index + 1 >= total + extraShots) {
        // 很多视频的字幕要过几秒才出来：到最后一轮还没抓到任何字幕，就再等两轮补拍。
        if (subtitles.length === 0 && extraShots < 2) { extraShots += 1; await delay(2000, undefined, { signal }).catch(() => {}); continue; }
        break;
      }
      await delay(intervalMs, undefined, { signal }).catch(() => {});
    }
    return { ok: true, danmaku: danmaku.slice(0, maxDanmaku), subtitles: subtitles.slice(-12), shots: total + extraShots, box };
  }

  // 翻自己作品评论区找 @ 我 的评论（只读，不点发布）
  async scanOwnMentions({ maxWorks = 4 } = {}, signal) {
    signal?.throwIfAborted();
    const { scanMentions } = await import('./mention-watch.mjs');
    return scanMentions(this.page, { maxWorks }, signal);
  }

  // 回复某条评论：先打开对应作品、点开评论区，再定位那条评论回复
  async replyToMention({ workUrl, index, text, dryRun = false } = {}, signal) {
    const { replyToCommentInPage } = await import('./comment-reply.mjs');
    const target = String(workUrl || '');
    if (!/^https:\/\/www\.douyin\.com\//.test(target)) throw new Error('只接受抖音作品链接。');
    if (this.page.url() !== target) {
      await this.page.goto(target, { waitUntil: 'domcontentloaded' });
      await wait(2600, signal);
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      signal?.throwIfAborted();
      const opened = await this.page.evaluate(() => document.querySelectorAll('[data-e2e="comment-item"]').length > 0).catch(() => false);
      if (opened) break;
      await this.page.evaluate(() => {
        const icon = document.querySelector('[data-e2e="feed-comment-icon"]') || document.querySelector('[data-e2e="comment-icon"]');
        if (icon) icon.click();
      }).catch(() => {});
      await wait(1200, signal);
    }
    return replyToCommentInPage(this.page, { index, text, dryRun, isReplyToMe: false });
  }

  // 弹幕走网络接口 /aweme/v1/web/danmaku/get_v2/：轻微 seek 触发一次请求，拦下响应拿文本。
  async readDanmaku({ limit = 7 } = {}, signal) {
    const state = await this.state();
    if (!state.video?.id) return { ok: false, danmaku: [], note: '没有可见视频画面，请先打开作品。' };
    const itemId = String(state.video.id);
    let collected = null;
    const onResponse = async (response) => {
      const url = response.url();
      if (!url.includes('/danmaku/get_v2/') || !url.includes(`item_id=${itemId}`)) return;
      try {
        const body = await response.json();
        const list = Array.isArray(body?.danmaku_list) ? body.danmaku_list : [];
        if (list.length) collected = list.map(item => ({ text: String(item.text ?? '').replace(/\s+/g, ' ').trim(), at: Math.round(Number(item.offset_time) || 0), likes: Number(item.digg_count) || 0 })).filter(item => item.text);
      } catch { /* 解析失败就保留上一份，不打断观看 */ }
    };
    this.page.on('response', onResponse);
    try {
      // 只挪一点点播放头，用来让页面重新请求弹幕，不改作品也不改播放意愿。
      await this.page.evaluate(() => { const video = document.querySelector('video'); if (video) video.currentTime = Math.max(0, video.currentTime + 0.02); }).catch(() => {});
      for (let index = 0; index < 16 && !collected; index += 1) await wait(250, signal);
    } finally {
      this.page.off('response', onResponse);
    }
    if (!collected?.length) return { ok: false, videoId: itemId, danmaku: [], note: '没有读到弹幕，可能是这条作品本身没有弹幕。' };
    const picked = collected.slice(0, Math.max(1, Math.min(50, limit)));
    return { ok: true, videoId: itemId, total: collected.length, danmaku: picked, note: `读到 ${collected.length} 条弹幕，取前 ${picked.length} 条。` };
  }
  async captureCoverage({ maxFrames = 18 } = {}, signal) {
    let state = await this.state();
    const startState = state;
    if (state.loginRequired || state.verificationRequired || state.privateChatVisible) return { state, frames: [], note: '登录、验证或私信面板遮挡画面，本次没有采集图片。' };
    if (state.livePreview?.recognized === true) return { state, frames: [], note: '当前是推荐流直播预览，不采集直播画面。' };
    if (!state.video || !(state.video.duration > 0)) return this.capture(0, signal);
    const beforeId = state.video.id, total = state.video.duration, wasPaused = state.video.paused !== false, originalTime = state.video.time || 0;
    const finishCoverage = (frames, extra = {}) => {
      const alignedState = state?.video?.id === beforeId ? state : startState;
      const result = { state: alignedState, frames, observation: { kind: 'coverage', videoId: beforeId, duration: total, frameCount: frames.length, wasPaused, ...(extra.observation || {}),
        note: extra.note || `按时间轴抓了 ${frames.length} 帧，覆盖从开头到结尾；这是抽帧覆盖，不等于逐帧连续视频，也没有音频。` } };
      if (frames.length && ['api', 'dsh'].includes(this.source)) {
        try {
          result.personaEvidenceId = this.getPersonaMemory().recordObservation({ state: alignedState, frames: frames.slice(0, 4), observation: result.observation }, { source: this.source, kind: 'visual' }).evidenceId;
        } catch { result.personaWarning = '本次画面未登记为兴趣证据。'; }
      }
      return result;
    };
    const count = Math.max(3, Math.min(20, maxFrames)), raw = [];
    try {
      for (let index = 0; index < count; index += 1) {
        aborted(signal);
        const target = total * ((index + 0.5) / count);
        await (await this.currentVideo()).evaluate((el, payload) => { try { el.currentTime = payload.t; } catch {} }, { t: target }).catch(() => {});
        await wait(320, signal);
        state = await this.state({ record: false });
        await this.checkVideoLimits('douyin_observe');
        if (state.loginRequired || state.verificationRequired || state.unsupportedPage || state.privateChatVisible || state.livePreview?.recognized === true) return { state, frames: [], note: '采样期间出现登录、验证、私信、直播预览或离开抖音，已丢弃本次画面。' };
        if (state.video?.id !== beforeId) break;
        // 直接拿 <video> 画到 canvas：只拍视频本身，不带弹幕和浮层，同时取一个 32×32 灰度指纹用于去重。
        const shot = await (await this.currentVideo()).evaluate((el) => {
          const vw = el.videoWidth || 0, vh = el.videoHeight || 0;
          if (vw < 2 || vh < 2) return null;
          try {
            const width = 640, height = Math.max(2, Math.round((width * vh) / vw));
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            canvas.getContext('2d', { willReadFrequently: true }).drawImage(el, 0, 0, width, height);
            const print = document.createElement('canvas');
            print.width = 32; print.height = 32;
            const printContext = print.getContext('2d', { willReadFrequently: true });
            printContext.drawImage(el, 0, 0, 32, 32);
            const pixels = printContext.getImageData(0, 0, 32, 32).data;
            const gray = new Array(1024);
            for (let index = 0, cursor = 0; index < pixels.length; index += 4, cursor += 1) {
              gray[cursor] = Math.round((pixels[index] * 299 + pixels[index + 1] * 587 + pixels[index + 2] * 114) / 1000);
            }
            return { url: canvas.toDataURL('image/jpeg', 0.62), gray };
          } catch { return null; }
        }).catch(() => null);
        if (!shot?.url) continue;
        raw.push({ data: shot.url.slice(shot.url.indexOf(',') + 1), gray: shot.gray, time: state.video.time });
      }
    } finally {
      await (await this.currentVideo()).evaluate((el, payload) => { try { el.currentTime = payload.t; if (payload.paused) el.pause(); else el.play().catch(() => {}); } catch {} }, { t: originalTime, paused: wasPaused }).catch(() => {});
    }
    // 去掉和上一张几乎一样的帧：静态画面不再重复占用额度，同样的钱换来更多有效画面。
    const frames = [];
    let keptPrint = null, dropped = 0;
    for (const item of raw) {
      const delta = keptPrint ? grayDelta(keptPrint, item.gray) : 255;
      if (frames.length && delta < 3.5) { dropped += 1; continue; }
      frames.push({ mimeType: 'image/jpeg', data: item.data, time: item.time, videoId: beforeId, sceneChange: Number(delta.toFixed(1)) });
      keptPrint = item.gray;
    }
    // 兜底：全片没怎么动静的时候也要留下最少三帧，不能只剩一张。
    if (frames.length < 3 && raw.length >= 3) {
      for (let index = 0; index < raw.length && frames.length < 3; index += 1) {
        const candidate = raw[Math.floor((index * raw.length) / 3) % raw.length];
        if (!candidate || frames.some((frame) => frame.time === candidate.time)) continue;
        frames.push({ mimeType: 'image/jpeg', data: candidate.data, time: candidate.time, videoId: beforeId, sceneChange: null });
      }
      frames.sort((left, right) => (left.time ?? 0) - (right.time ?? 0));
    }
    return finishCoverage(frames, dropped ? { observation: { droppedDuplicates: dropped, sampledFrames: raw.length } } : {});
  }
  async captureAudio(seconds,signal) {
    await this.checkVideoLimits('douyin_listen');
    const before=await this.state({record:false});
    if(before.loginRequired||before.verificationRequired||before.privateChatVisible||!before.video?.id) throw new Error('当前没有可录取的公开作品，或登录、验证、私信面板遮挡页面。');
    const result=await (await this.currentVideo()).evaluate(async(video,seconds)=>{
      if(typeof video.captureStream!=='function' || typeof MediaRecorder==='undefined') throw new Error('浏览器没有提供当前视频的可用音轨采集接口。');
      const wasPaused=video.paused; await video.play();
      const stream=video.captureStream();
      const tracks=stream.getAudioTracks().map(track=>track.clone());
      if(!tracks.length) {if(wasPaused)video.pause();throw new Error('当前作品没有向浏览器暴露可采集音轨，未录取其他声音。');}
      const audio=new MediaStream(tracks),chunks=[];
      const mimeType=['audio/webm;codecs=opus','audio/webm'].find(type=>MediaRecorder.isTypeSupported(type));
      if(!mimeType) {tracks.forEach(track=>track.stop());if(wasPaused)video.pause();throw new Error('浏览器不支持音轨录取格式。');}
      try {
        const recorder=new MediaRecorder(audio,{mimeType,audioBitsPerSecond:64000});
        await new Promise((resolve,reject)=>{
          let size=0; const timer=setTimeout(()=>recorder.state!=='inactive'&&recorder.stop(),seconds*1000);
          recorder.ondataavailable=event=>{size+=event.data.size;if(size>2_000_000){clearTimeout(timer);recorder.stop();reject(new Error('音轨超过2MB采集预算。'));}else chunks.push(event.data);};
          recorder.onerror=()=>{clearTimeout(timer);reject(new Error('当前视频音轨采集失败。'));};
          recorder.onstop=()=>{clearTimeout(timer);resolve();};recorder.start(250);
        });
        const bytes=new Uint8Array(await new Blob(chunks,{type:mimeType}).arrayBuffer());
        if(!bytes.length) throw new Error('当前音轨没有生成可用数据。');
        let encoded='';for(let offset=0;offset<bytes.length;offset+=32768) encoded+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
        return {data:btoa(encoded),mimeType,bytes:bytes.length};
      }finally{tracks.forEach(track=>track.stop());if(wasPaused)video.pause();}
    },seconds);
    aborted(signal);await this.checkVideoLimits('douyin_listen');
    const after=await this.state({record:false});
    if(after.loginRequired||after.verificationRequired||after.privateChatVisible||after.unsupportedPage||after.video?.id!==before.video.id) throw new Error('录音期间页面或作品身份改变，音轨已丢弃。');
    return {...result,videoId:before.video.id,beforeTime:before.video.time,afterTime:after.video.time,seconds,state:after};
  }
  // 画面底部到底有没有字幕，靠整帧看不清；单独截一条底部带、放大 2 倍再送一张。
  async captureSubtitleBand(state,signal) {
    const viewport=state?.video?.viewport;
    if(!viewport||viewport.width<2||viewport.height<2) return null;
    const bandHeight=Math.max(24,Math.min(Math.round(viewport.height*0.26),Math.round(viewport.height/2)));
    const clip={x:viewport.x,y:viewport.y+viewport.height-bandHeight,width:viewport.width,height:bandHeight};
    const data=await this.page.screenshot({type:'jpeg',quality:80,clip,animations:'allow',caret:'initial',timeout:10_000});
    aborted(signal);
    const original=data.toString('base64');
    const scaled=await this.page.evaluate(async source=>{
      const image=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src='data:image/jpeg;base64,'+source;});
      const canvas=document.createElement('canvas');
      canvas.width=Math.min(image.naturalWidth*2,2400);canvas.height=Math.round(image.naturalHeight*(canvas.width/image.naturalWidth));
      const ctx=canvas.getContext('2d');
      if(!ctx) return null;
      ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
      ctx.drawImage(image,0,0,canvas.width,canvas.height);
      return (canvas.toDataURL('image/jpeg',0.86).split(',')[1]||null);
    },original).catch(()=>null);
    return {mimeType:'image/jpeg',data:scaled||original,time:state.video.time??null,videoId:state.video.id,role:'subtitle'};
  }
  // 读当前作品评论区的评论（昵称 + 文本）。优先走作品自己的评论接口，拿不到再退回读 DOM。
  async readComments(maxRows=10,signal) {
    const state=await this.state({record:false});
    if(state.loginRequired||state.verificationRequired||state.privateChatVisible) return {ok:false,reason:'blocked',comments:[]};
    const limit=Math.max(1,Math.min(20,maxRows));
    const fromApi=[];const seen=new Set();
    const onResponse=async response=>{
      try{
        if(!response.url().includes('/aweme/v1/web/comment/list/')) return;
        const body=await response.json();
        const list=Array.isArray(body?.comments)?body.comments:[];
        for(const item of list){
          const text=String(item?.text??'').replace(/[\s\r\n]+/g,' ').trim();
          if(!text) continue;
          const user=String(item?.user?.nickname??'').trim().slice(0,40);
          const key=`${user}|${text}`;
          if(seen.has(key)) continue;
          seen.add(key);
          fromApi.push({user,text:text.slice(0,160),likes:Number(item?.digg_count??0)});
        }
      }catch(error){ /* 单个响应解析失败不影响其它响应 */ }
    };
    this.page.on('response',onResponse);
    const opened=await this.page.evaluate(()=>{
      const visible=node=>Boolean(node&&(node.offsetWidth||node.offsetHeight||node.getClientRects().length));
      if([...document.querySelectorAll('[data-e2e="comment-item"],[data-e2e="comment-list"]')].some(visible)) return false;
      const icon=document.querySelector('[data-e2e="feed-comment-icon"]')||document.querySelector('[data-e2e="comment-icon"]');
      if(!icon) return null;
      icon.click();
      return true;
    }).catch(()=>null);
    if(opened===null){ this.page.off('response',onResponse); return {ok:false,reason:'no-comment-entry',comments:[]}; }
    if(opened) await delay(900,signal);
    aborted(signal);
    for(let index=0;index<16&&fromApi.length<limit;index+=1) await delay(250,signal);
    aborted(signal);
    let comments=fromApi.slice(0,limit);
    let source=comments.length?'api':'none';
    if(!comments.length){
      const dom=await this.page.evaluate(readCommentsInPage,limit).catch(()=>[]);
      comments=Array.isArray(dom)?dom.slice(0,limit):[];
      if(comments.length) source='dom';
    }
    this.page.off('response',onResponse);
    if(opened){ try{ this.page.keyboard.press('Escape').catch(()=>{}); await delay(250,signal); }catch{} }
    return {ok:comments.length>0,opened:Boolean(opened),source,comments};
  }
  async listen(seconds,signal,{prompt=null}={}) {
    const media=await this.getMediaAdapter(),settings=await media.settings();
    if(!settings.enabled) return {ok:true,audioAvailable:false,note:'音频能力默认关闭，请由用户在本机控制台选择开启。'};
    const captured=await this.captureAudio(seconds,signal);
    const directory=resolveRuntimePaths().mediaCaptureDir;mkdirSync(directory,{recursive:true});
    const target=path.join(directory,`${randomUUID()}.webm`);writeFileSync(target,Buffer.from(captured.data,'base64'));
    try {
      const result=await media.transcribeAudio({source:target,backend:settings.backend,durationSeconds:seconds,...(prompt?{initialPrompt:String(prompt).slice(0,600)}:{})},{signal});
      return {ok:true,audioAvailable:result.ok===true,state:captured.state,audio:{...result,videoId:captured.videoId,beforeTime:captured.beforeTime,afterTime:captured.afterTime,seconds},note:'只采集当前视频这一小段实际音轨；转写不能代替音乐或环境声理解。'};
    }finally{try{unlinkSync(target);}catch{}}
  }
  async close() {
    this.cancelLimitsWatch?.(); this.cancelLimitsWatch=null;
    if(this.limitsEnabled) await this.pauseForLimits();
    await this.queue.catch(()=>{});
    await this.browser?.close().catch(()=>{});
    if(this.sparkPromise) await this.sparkPromise.then(spark=>spark.close()).catch(()=>{});
    if(this.commentsPromise) await this.commentsPromise.then(comments=>comments.close()).catch(()=>{});
    if(this.commenterPromise) await this.commenterPromise.then(commenter=>commenter.close?.()).catch(()=>{});
    if(this.chatPromise) await this.chatPromise.then(chat=>chat.close()).catch(()=>{});
    if(this.forwarderPromise) await this.forwarderPromise.then(forwarder=>forwarder.close?.()).catch(()=>{});
    this.memory?.close(); this.browser=null; this.page=null; this.memory=null;
  }
}
