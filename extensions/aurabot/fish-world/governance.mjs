import {createHash} from 'node:crypto';
import {dayKey,planOpen} from './state.mjs';
import {provedWorkSource} from './plans.mjs';
import {workHoursAllowed} from './work-hours.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const estimateTokens=value=>Math.ceil(Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value??''),'utf8')/2);
export const effectiveNow=(l,now)=>Math.max(Number(now)||0,l.scheduler?.clockFloor||0,l.scheduler?.lastStartedAt||0);
export function taskClass(task,l){
  if(['recovery','inspection','work','doorbell','health'].includes(task.kind))return {priority:1,bucket:'work'};
  if(task.kind==='owner')return {priority:0,bucket:'idle'};
  if(['talk','message','note','friend_request'].includes(task.kind))return {priority:2,bucket:'social'};
  if(['done','arrive'].includes(task.kind)&&(task.relatedPlanIds||[]).some(id=>l.plans.some(p=>p.id===id&&provedWorkSource(l,p))))return {priority:1,bucket:'work'};
  if(['done','arrive'].includes(task.kind)&&(task.sourceEventIds||[]).some(id=>l.queue.some(q=>q.id===id&&['work','doorbell','health'].includes(q.kind)&&q.provenance?.trusted)))return {priority:1,bucket:'work'};
  if(task.kind==='plan')return {priority:3,bucket:provedWorkSource(l,task.plan||{})?'work':'idle'};
  return {priority:task.kind==='idle'?4:3,bucket:'idle'};
}
export function realUrgency(task){
  return ['work','doorbell','health'].includes(task.kind)&&task.provenance?.trusted===true&&!!task.id;
}
export function candidates(l,data,cfg,now){
  if(l.recovery)return [{id:'recovery',kind:'recovery',priority:1,bucket:'work',text:'只读核对未知结果，禁止重复变更。',group:l.queue.filter(q=>q.status==='uncertain').slice(0,8)}];
  const pending=l.queue.filter(q=>['pending','blocked'].includes(q.status)&&q.notBefore<=now).map(q=>({...q,...taskClass(q,l)})).sort((a,b)=>a.priority-b.priority||a.t-b.t||a.id.localeCompare(b.id));
  const list=pending.map(q=>({...q,group:q.bucket==='social'?pending.filter(p=>p.bucket==='social'&&p.sender===q.sender).slice(0,8):[q]}));
  const working=/work|打工|上班|零工/.test(JSON.stringify(data.state?.doing||''));
  if(working&&now-(l.lastToolAt||l.createdAt)>=cfg.workMs)list.push({id:'inspection',kind:'inspection',priority:1,bucket:'work',text:'工作兜底巡检；没有工作就等待。',group:[]});
  for(const p of l.plans.filter(p=>['pending','active'].includes(p.status)&&p.nextAt>0&&p.nextAt<=now).sort((a,b)=>a.nextAt-b.nextAt||a.id.localeCompare(b.id))){
    list.push({id:p.id,kind:'plan',planId:p.id,planRevision:p.revision,plan:p,...taskClass({kind:'plan',plan:p},l),sourceEventIds:p.sourceEventIds||[],text:JSON.stringify(p),group:[]});
  }
  const doing=data.state?.doing,end=Date.parse(doing?.until||doing?.endAt||data.state?.where?.arrive||'')||Number(doing?.endAt)||0;
  const long=!!doing||data.state?.figure?.asleep||data.state?.where?.kind==='trip';
  if(cfg.idleEnabled&&!working&&now>=l.nextIdle&&(!long||end>0&&end<=now))list.push({id:'idle',kind:'idle',priority:4,bucket:'idle',text:'照顾基本生活，允许保持现状并等待。',group:[]});
  const seen=new Set();return list.sort((a,b)=>a.priority-b.priority||(a.t||a.plan?.nextAt||0)-(b.t||b.plan?.nextAt||0)).filter(c=>{const k=c.kind+':'+c.id;if(seen.has(k))return false;seen.add(k);return true;});
}
export function admission(l,task,cfg,{now,estimate,costSummary}={}){
  now=effectiveNow(l,now);
  const blocked=(reason,nextAllowedAt=0,extra={})=>({allowed:false,reason,nextAllowedAt,...extra});
  if(cfg.stopped||!cfg.autonomy||cfg.observeOnly)return blocked('自动行动已暂停');
  if(task.kind==='idle'&&!workHoursAllowed(cfg.idleWorkHours,now))return blocked('闲时生活不在设置的工作时间');
  if(!['owner','recovery','idle'].includes(task.kind)&&!workHoursAllowed(cfg.activityWorkHours,now))return blocked('自动事件与计划不在设置的工作时间');
  if(!cfg.idleEnabled&&task.bucket==='idle')return blocked('闲时活动已暂停');
  const day=dayKey(now),used=l.days[day]?.[task.bucket]||0,limit=Number(cfg[task.bucket+'Limit']);
  if(used>=limit)return blocked(task.bucket+' 自动处理受阻：今日额度已用完',0,{budgetExhausted:true,bucket:task.bucket,day});
  if(cfg.costGuardEnabled&&costSummary){
    if(costSummary.pendingRequests||costSummary.unknownRequests||costSummary.unknownRounds||costSummary.inFlightRounds)return blocked('费用准入暂停：存在在途或未知用量');
    if(costSummary.estimatedCny>=cfg.costStopLimitCny)return blocked('今日估算费用达到自动启动停止阈值');
    if(costSummary.estimatedCny>=cfg.costSoftLimitCny&&task.bucket==='idle'&&task.priority>0)return blocked('今日估算费用达到软阈值，普通探索与低优先级计划暂停');
  }
  const schedule=l.scheduler||{},claimed=schedule.urgentClaims?.[task.id],urgent=realUrgency(task)&&claimed!==(task.eventVersion||task.id);
  let next=(schedule.lastStartedAt||0)+(urgent?cfg.urgentMinGapMs:cfg.normalMinGapMs);
  if(!schedule.lastStartedAt)next=0;
  if(urgent){
    const recent=(schedule.starts||[]).filter(s=>s.urgent&&s.at>now-600000);
    if(recent.length>=cfg.urgentMaxRoundsPer10Min)next=Math.max(next,recent[0].at+600000);
  }
  if(task.planId){
    const p=l.plans.find(p=>p.id===task.planId);
    if(!p||!planOpen(p.status)||!['pending','active'].includes(p.status))return blocked('计划不再可执行');
    if(p.lastCheckedAt&&p.lastCheckedRevision===p.revision)next=Math.max(next,p.lastCheckedAt+cfg.planRecheckMinMs);
  }
  if(now<next)return blocked(urgent?'紧急事件正在频率冷却':'普通回合或同一计划正在冷却',next);
  if(estimate){
    if(estimate.roundPromptTokens>cfg.roundPromptEstimatedTokenLimit)return blocked('本轮新增提示超过估算体积门槛');
    if(estimate.requestTokens>cfg.requestAdmissionEstimatedTokenLimit)return blocked('启动前完整请求估算超过目标上限');
    if(estimate.held)return blocked(estimate.held);
  }
  return {allowed:true,day,bucket:task.bucket,urgent,now,nextAllowedAt:now,estimate:estimate||null};
}
export function reserveRound(l,task,cfg,{now,roundId,estimate,costSummary}){
  const allowed=admission(l,task,cfg,{now,estimate,costSummary});if(!allowed.allowed)throw Error('准入条件已变化：'+allowed.reason);
  const s=l.scheduler??={lastStartedAt:0,starts:[],urgentClaims:{},reservations:[],clockFloor:0};
  const bucket=l.days[allowed.day]??={work:0,idle:0,social:0,share:0,spend:0,calls:0};bucket[task.bucket]++;
  s.lastStartedAt=allowed.now;s.clockFloor=Math.max(s.clockFloor||0,allowed.now);s.budgetDay=allowed.day;
  s.starts.push({roundId,at:allowed.now,kind:task.kind,bucket:task.bucket,urgent:allowed.urgent});
  if(allowed.urgent)s.urgentClaims[task.id]=task.eventVersion||task.id;
  const reservation={roundId,at:allowed.now,day:allowed.day,bucket:task.bucket,status:'reserved'};s.reservations.push(reservation);return {allowed,reservation};
}
export function quotaAlert(l,{fishId,bucket,now,reason='daily-limit',repeat=1}){
  const day=dayKey(effectiveNow(l,now)),key='quota-'+hash([fishId,l.owner,l.persona,day,bucket,reason]);
  l.alerts??=[];const old=l.alerts.find(a=>a.key===key);
  if(old){old.lastSeenAt=Math.max(old.lastSeenAt,now);old.repeatCount+=repeat;return old;}
  const alert={id:key,key,kind:'quota',fishId,day,bucket,reason,status:'active',firstSeenAt:now,lastSeenAt:now,repeatCount:repeat,noticeOnly:true,deliveryEvidence:[]};
  l.alerts.push(alert);return alert;
}
export function closeOldAlerts(l,now){
  const day=dayKey(effectiveNow(l,now));for(const a of l.alerts||[])if(a.kind==='quota'&&a.day<day&&a.status==='active'){a.status='closed';a.closedAt=now;}
}
export const isQuotaDelivery=o=>o.noticeOnly||o.facts?.some(k=>String(k).startsWith('budget-'));
export function observeSatisfiedEvents(l){
  for(const q of l.queue){
    if(!['pending','blocked'].includes(q.status)||!['arrive','done'].includes(q.kind)||!q.provenance?.trusted)continue;
    const stage=l.plans.flatMap(p=>(p.satisfiedStages||[]).map(s=>({...s,planId:p.id}))).find(s=>s.kind===q.kind&&(q.relatedPlanIds||[]).includes(s.planId)&&s.expectedAt>0&&Math.abs(s.expectedAt-q.t)<=1000&&s.receiptIds?.length);
    if(stage){q.status='observed';q.observedByRound=stage.roundId;q.planId=stage.planId;q.receiptIds=stage.receiptIds;}
  }
}
