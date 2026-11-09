// 评论读取：把面板 DOM 里混在一起的「昵称 / 正文 / 时间地区点赞」拆干净
// 关键事实（CDP 实测）：昵称在 a.RZuwF26I.ALink-a 里，正文没有稳定的 data-e2e，
// 详情页会把「2周前·内蒙古 12 分享 回复」直接拼在正文后面。

const META_LINE = /^(刚刚|昨天|前天|\d+\s*(秒|分钟|分钟|小时|天|周|个月|年)前|\d{1,2}-\d{1,2})/;
const META_WORD = /(分享|回复|点赞|作者|置顶|展开\d+条回复|收起)/;

export function cleanText(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  // 尾部元信息：时间[·地区] 点赞数 动作
  t = t.replace(/\s*((\d+\s*(秒|分钟|小时|天|周|个月|年)前)|刚刚|昨天|前天|\d{1,2}-\d{1,2})\s*·?[^\n]{0,24}$/, '');
  t = t.replace(/[\s·]*(作者|置顶)?[\s·]*\d*[\s·]*(分享|回复|点赞|赞)+$/g, '');
  t = t.replace(/^(\.{2,}|…+)\s*/, '');
  return t.trim();
}

// 这个函数会被送进页面执行，不能引用外部变量
export function readCommentsInPage(maxRows = 10) {
  const clean = (raw) => {
    let t = String(raw || '').replace(/\s+/g, ' ').trim();
    t = t.replace(/\s*((\d+\s*(秒|分钟|小时|天|周|个月|年)前)|刚刚|昨天|前天|\d{1,2}-\d{1,2})\s*·?[^\n]{0,24}$/, '');
    t = t.replace(/[\s·]*(作者|置顶)?[\s·]*\d*[\s·]*(分享|回复|点赞|赞)+$/g, '');
    t = t.replace(/^(\.{2,}|…+)\s*/, '');
    return t.trim();
  };
  const isMeta = (line) => /^(刚刚|昨天|前天|\d+\s*(秒|分钟|小时|天|周|个月|年)前|\d{1,2}-\d{1,2})/.test(line)
    || (line.length < 32 && /(分享|回复|点赞|作者|置顶|展开\d+条回复)/.test(line))
    || /^\.{2,}$|^…+$/.test(line);

  const rows = [...document.querySelectorAll('[data-e2e="comment-item"]')].slice(0, maxRows);
  return rows.map((row, i) => {
    const linkEl = row.querySelector('a.RZuwF26I') || row.querySelector('a.ALink-a') || row.querySelector('a[href*="/user/"]');
    const nick = (linkEl?.textContent || linkEl?.querySelector('img')?.alt || '').replace(/\s+/g, ' ').trim();
    const lines = (row.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const body = lines
      .filter((l) => l !== nick && !isMeta(l))
      .map(clean)
      .filter((l) => l && l !== nick && !isMeta(l));
    const text = body.sort((a, b) => b.length - a.length)[0] || '';
    return { i, nick, text };
  });
}
