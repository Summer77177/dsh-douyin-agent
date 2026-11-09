// 评论回复护栏：禁区过滤 + 额度控制。纯逻辑，不碰浏览器。
import fs from 'node:fs';
import path from 'node:path';

export const REPLY_LIMITS = Object.freeze({
  maxTopLevelPerVideo: 2,   // 一条视频下，我主动发表的评论最多 2 条
  maxRepliesPerThread: 5,   // 别人回了我，同一串里我最多再回 5 条
});

// 禁区：命中任何一条就整条跳过，不回复也不发新评论
export const FORBIDDEN = Object.freeze([
  { key: 'politics', label: '政治敏感', re: /(政府|中央|领导人|主席|书记|政策|党政|人大代表|分裂|台独|港独|政权|体制|国家机密|选举|游行|抗议|政治)/ },
  { key: 'region', label: '地域', re: /([河山广浙江湖福安四云贵陕甘青新宁内蒙黑吉辽]*(东|西|南|北)?[省市县镇村]\s*人.*(就是|都是|没一个|素质|小偷|骗子)|\b(地域黑|地图炮)\b)/ },
  { key: 'gender_body', label: '性别身材', re: /(胖|瘦|丑|坦克|飞机场|男的就这样|女的就这样|娘炮|绿茶|婊|下头女|下头男|身材|腿粗|脸大)/ },
  { key: 'flame', label: '引战', re: /(引战|钓鱼|这不比|吊打|只有我觉得|错别字|不懂别|键盘侠|杠精|傻逼|nmsl|草泥马)/ },
  { key: 'real_info', label: '真实信息', re: /(1[3-9]\d{9}|\d{17}[\dXx]|[\w.+-]+@[\w-]+\.[\w.]+|(住在|家住|学校|班级|公司).{0,12}(路|街|号|中学|大学|小学))/ },
  { key: 'hostile', label: '针对本人的坏话', re: /(蠢鱼|就知道吃大白饭|这鱼魔了|傻鱼|破AI|什么玩意|垃圾助手)/ },
]);

// 没实质内容的短评：回了像机器人凑数，直接跳过
const EMPTY_RE = /^(冇|无|有|我有|没有|没|不懂|\?|？|。|…|哈+|h{2,}|1+|啊+|呃+|嗯+|额|em+|沃日|6+|靠|草|艹)$/i;

export function isEmptyComment(text) {
  const s = String(text || '').replace(/[\s\p{P}\p{S}]/gu, '');
  if (!s) return true;
  if (s.length <= 2) return true;
  return EMPTY_RE.test(s);
}

export function classify(text) {
  const s = String(text || '');
  if (isEmptyComment(s)) return { skip: true, category: 'empty', label: '没有实质内容' };
  for (const rule of FORBIDDEN) if (rule.re.test(s)) return { skip: true, category: rule.key, label: rule.label };
  return { skip: false };
}

// 语气：默认友好；被针对本人骂（hostile）→ 尖锐阴阳，回一次不追吵
export function moodFor(text) {
  const hostile = FORBIDDEN.find((r) => r.key === 'hostile').re.test(String(text || ''));
  return hostile ? 'sharp' : 'friendly';
}

export class CommentGuard {
  constructor({ stateDir, limits = REPLY_LIMITS } = {}) {
    this.file = path.join(stateDir, 'comment-guard.json');
    this.limits = { ...REPLY_LIMITS, ...limits };
  }
  read() {
    try { const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); return raw && typeof raw === 'object' ? raw : { videos: {} }; }
    catch { return { videos: {} }; }
  }
  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, this.file);
  }
  // 判断这条评论还能不能回；返回 { allow, reason, mode }
  decide({ videoId, commentId, threadRoot, isReplyToMe = false }) {
    const data = this.read();
    const video = (data.videos[videoId] ||= { topLevel: 0, threads: {} });
    if (isReplyToMe) {
      const n = video.threads[threadRoot] || 0;
      if (n >= this.limits.maxRepliesPerThread) return { allow: false, reason: `同一串已回 ${n} 条，达到 ${this.limits.maxRepliesPerThread} 条上限` };
      return { allow: true, kind: 'thread-reply', remaining: this.limits.maxRepliesPerThread - n };
    }
    if (video.topLevel >= this.limits.maxTopLevelPerVideo) return { allow: false, reason: `该视频已主动评论 ${video.topLevel} 条，达到 ${this.limits.maxTopLevelPerVideo} 条上限` };
    return { allow: true, kind: 'top-level', remaining: this.limits.maxTopLevelPerVideo - video.topLevel };
  }
  mark({ videoId, commentId, threadRoot, isReplyToMe = false }) {
    const data = this.read();
    const video = (data.videos[videoId] ||= { topLevel: 0, threads: {} });
    if (isReplyToMe) video.threads[threadRoot] = (video.threads[threadRoot] || 0) + 1;
    else video.topLevel += 1;
    this.write(data);
  }
}
