const pendingPhases = new Set(['observing', 'model', 'sending', 'outbound-wait', 'recovering']);
const timeOf = value => typeof value === 'number' ? value : Date.parse(value);
const sharingActive = share => share.enabled === true && share.inProgress === true && share.busy === true
  && share.paused !== true && share.recoveryRequired !== true && Array.isArray(share.needsReview) && share.needsReview.length === 0
  && share.activity?.status === 'sending' && ['reserved', 'clicking'].includes(share.activity.phase)
  && typeof share.activity.operationId === 'string' && Boolean(share.activity.operationId);
export function interactionPresence({chat={},share={},watch={},modelReady=false,friend,now=Date.now()}={}) {
  const selected = chat.policy?.allowlist || [], contacts = chat.contacts || [];
  const readyCount = selected.filter(item => contacts.some(mark => mark.id === item.id && mark.status === 'ready')).length;
  const pending = contacts.filter(item => pendingPhases.has(item.pending?.phase));
  const pendingManualCount = chat.recovery?.pendingManualCount ?? contacts.reduce((sum,item)=>sum+(item.recovery?.pendingManualCount ?? (item.unanswered||[]).filter(entry=>!entry.handledByUserAt).length),0);
  const base = { checkedAt:new Date(now).toISOString(),selectedCount:selected.length,readyCount,pendingCount:pending.length,pendingManualCount };
  const result = (status,online,label,reason='') => ({...base,status,online,label,reason});
  if (friend?.policy?.enabled === false || friend?.enabled === false) return result('offline',false,'离线','好友互动已关闭。');
  if (!modelReady) return result('attention',false,'需要处理','请先配置回复使用的模型。');
  if (!selected.length) return result('preparing',false,'准备中','请先选择允许互动的好友或群聊。');
  if (friend?.status === 'waiting-settings') return result('preparing',false,'准备中','正在更新许可名单，完成后自动恢复回复。');
  if (friend?.lastError || share.paused || share.recoveryRequired || share.needsReview?.length) return result('attention',false,'需要处理','回复服务或发送收据需要核对，请查看好友互动。');
  if (pendingManualCount) return result('attention',false,'有未答消息','有已保留的消息需要人工核对；新消息仍会继续检查。');
  const stalled = pending.some(item => !Number.isFinite(timeOf(item.pending?.at)) || now-timeOf(item.pending.at)>180_000);
  const blocked = contacts.some(item => ['paused','delivery-uncertain'].includes(item.status) || item.status==='inflight' && item.pending?.phase!=='sending');
  if (blocked || stalled) return result('attention',false,'需要处理','部分许可会话已暂停或处理超时，请查看好友互动。');
  if (chat.starting || friend?.status === 'starting') return result('preparing',false,'准备中','正在核对会话身份并准备接收消息。');
  const heartbeatAt = timeOf(chat.worker?.heartbeatAt),fresh = chat.worker?.alive===true && Number.isFinite(heartbeatAt) && now-heartbeatAt>=-1000 && now-heartbeatAt<5000;
  if (!chat.running || !fresh) return result('attention',false,'回复未就绪','回复服务未运行或连接已失效，暂不能确认在线。');
  if (readyCount + contacts.filter(item=>selected.some(row=>row.id===item.id) && item.status==='inflight' && item.pending?.phase==='sending').length !== selected.length) return result('preparing',false,'准备中','正在核对所选会话的接收状态。');
  if (pending.length || (chat.recovery?.recoverableCount||0)>0) return result('replying',true,'在线 · 回复中','正在优先处理许可会话的消息。');
  const maxAge=Math.max(45_000,Math.min(120_000,selected.length*8000));
  if (selected.some(row=>{const mark=contacts.find(item=>item.id===row.id),checked=timeOf(mark?.lastCheckedAt);return !Number.isFinite(checked)||now-checked>maxAge;})) return result('attention',false,'消息检查延迟','尚未及时完成许可会话检查，暂不能确认在线。');
  if (sharingActive(share)) return result('sharing',true,'在线 · 分享中','正在向许可会话分享当前作品，好友新消息仍会继续检查。');
  const watchHeartbeat=timeOf(watch.worker?.heartbeatAt),watching=watch.running===true&&watch.worker?.alive===true&&Number.isFinite(watchHeartbeat)&&now-watchHeartbeat>=-1000&&now-watchHeartbeat<5000;
  if (watching) return result('watching',true,watch.phase==='model'?'在线 · 挑选视频':'在线 · 看视频中','许可好友发来新消息时优先回复。');
  return result('online',true,'在线 · 等待消息','正在检查许可好友与群聊的新消息。');
}

export function interactionStatus({chat={},share={},comments={},watch={},modelReady=false,friend}={}) {
  const active=value=>Boolean(value.running||value.starting||value.worker?.alive),viewing=active(watch),rows=[];
  const contacts=chat.contacts||[],paused=contacts.filter(item=>/paused|uncertain/.test(item.status||'')).length,identityPaused=contacts.some(item=>/联系人已变化|群聊/.test(item.reason||''));
  rows.push({id:'chat',label:'好友新私信自动回复',running:active(chat),pausedContacts:paused,message:!modelReady?'尚未配置模型。':!chat.policy?.allowlist?.length?'尚未保存许可好友。':active(chat)?`服务已启动，只处理启动后新收到的消息。${paused?`其中${paused}位好友已暂停；${identityPaused?'联系人身份核对未通过，请在抖音确认后重新读取许可名单。':'请查看下方联系人状态和待核对事项。'}`:''}`:'许可好友已保存，但回复服务未启动。',lastCheckedAt:contacts.map(item=>item.lastCheckedAt).filter(Boolean).sort().at(-1)||null});
  rows.push({id:'share',label:'自主分享视频',running:sharingActive(share)||viewing&&share.enabled&&!share.paused,message:!share.enabled?'自主分享开关未开启。':sharingActive(share)?'正在分享当前作品，结果以发送回执为准。':share.paused?'有未确认发送，已暂停。':!viewing?'分享许可已开启，等待自主观看运行。':'自主观看运行中，助手按当前作品和许可好友自行决定分享。'});
  rows.push({id:'comments',label:'自主公开视频评论',running:viewing&&comments.enabled&&!comments.paused,message:!comments.enabled?'自主评论开关未开启。':comments.paused?'评论结果待核对，已暂停。':!viewing?'评论许可已开启，等待自主观看运行。':'自主观看运行中，按观察与剩余次数决定是否评论。'});
  return{protocol:'interaction-status-v1',checkedAt:new Date().toISOString(),presence:interactionPresence({chat,share,watch,modelReady,friend}),rows,...(friend?{policy:friend.policy,friend}:{}),note:'好友互动共用一个总开关，保留所选名单，不限制人数或回复、分享次数。送达以发送回执为准。'};
}
