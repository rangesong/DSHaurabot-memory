import {semanticPlan} from './plan-semantics.mjs';
import {inspectPlanTrigger,matchesPlanEvent,planBusinessAt} from './plan-triggers.mjs';
import {dayKey,timestamp,planOpen} from './state.mjs';

const WORLD='mcp__fish-world__world_',DAY=86400000;
const unique=values=>[...new Set(values)];
const parse=value=>{try{const result=typeof value==='string'?JSON.parse(value):value;return result&&typeof result==='object'&&!Array.isArray(result)?result:null;}catch{return null;}};
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const tool=value=>String(value||'').startsWith(WORLD)?value:String(value||'').startsWith('world_')?'mcp__fish-world__'+value:'';
const fish=value=>typeof value==='string'&&/^(?:[^#\s]+)?#[1-9]\d{0,11}$/u.test(value)?value.slice(value.lastIndexOf('#')):null;
const mutation=(name,args)=>['go','do','say','update'].some(value=>name===WORLD+value)||name===WORLD+'friends'&&typeof args?.action==='string'&&args.action!==''&&args.action!=='list';
const positiveText=plan=>[plan.goal,plan.nextStep,plan.topic].map(value=>String(value||'').split(/不替|别替|不要|不得|不帮|不给|禁止/)[0]).join('；');
const exact=(text,value)=>typeof value==='string'&&value.length>0&&new RegExp('(^|[^\\p{L}\\p{N}_#-])'+value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![\\p{L}\\p{N}_#-])','u').test(text);

function receipts(l,round,now){
 if(!round?.id||!round.sessionId||!Number.isFinite(round.startedAt))return [];
 return (round.receipts||[]).filter(receipt=>receipt&&receipt.id&&!receipt.isError).flatMap(receipt=>{
  const row=(l.journal||[]).find(row=>row.id===receipt.id&&row.tool===receipt.tool&&row.round===round.id&&row.sessionId===round.sessionId&&row.status==='confirmed'&&!row.isError);
  if(!row||!Number.isFinite(row.at)||row.at<round.startedAt||!Number.isFinite(row.finishedAt)||row.finishedAt<row.at||row.finishedAt>now||typeof receipt.text==='string'&&typeof row.result==='string'&&receipt.text!==row.result)return [];
  const args=parse(row.args);return args?[{receipt,row,args}]:[];
 });
}

function stepsFor(l,round,plan){
 const result=[...(Array.isArray(plan.steps)?plan.steps:[]),plan.expectedAction,plan.action].filter(Boolean);
 const taskId=plan.ownerTaskId||plan.sourceOwnerTaskId;
 if(taskId&&round.ownerTaskId===taskId){
  const task=(l.ownerTasks||[]).find(task=>task.id===taskId);
  if(task)result.push(...(task.steps||[]),...(task.completedSteps||[]).filter(step=>step.at>=round.startedAt).map(step=>step.action));
 }
 return result.flatMap(step=>{const args=parse(step.arguments??step.args);return args&&Object.keys(args).some(key=>key!=='request_id')?[{tool:tool(step.tool),args}]:[];});
}
function matchesStep(row,steps){
 return steps.some(step=>step.tool===row.row.tool&&Object.entries(step.args).filter(([key])=>key!=='request_id').every(([key,value])=>same(row.args[key],value)));
}

function relatedAction(item,plan,semantic){
 const {row,args}=item,text=positiveText(plan),targets=unique([...(semantic.targets||[]),fish(plan.subject)].filter(Boolean));
 if(row.tool===WORLD+'say'){
  if(!targets.includes(fish(args.fish))||typeof args.text!=='string'||!args.text.trim()||!(/问|询问|打听|咨询|核实|了解|告诉|告知|联系|致谢|道谢|回复|聊天/.test(text)||semantic.action==='inquire'))return false;
  return !semantic.topic||semanticPlan({goal:args.text,nextStep:''},{plans:[],queue:[]}).topic===semantic.topic;
 }
 if(row.tool===WORLD+'friends'){
  if(!targets.includes(fish(args.fish)))return false;
  if(/(?:取消|移除|删除|解除).{0,6}好友/.test(text))return ['remove','delete','unfriend'].includes(args.action);
  if(/(?:同意|接受).{0,6}好友/.test(text))return args.action==='accept';
  if(/(?:拒绝).{0,6}好友/.test(text))return args.action==='reject';
  return /(?:加|交|申请|成为).{0,6}好友|交友/.test(text)&&['request','add'].includes(args.action);
 }
 if(row.tool===WORLD+'go'){
  const places=[plan.destination?.id,plan.location?.id,plan.targetPlaceId,plan.waitCondition?.place,plan.waitCondition?.destination];
  if(plan.subject&&plan.subject!=='self'&&!fish(plan.subject)&&plan.subject!==semantic.actor?.fishId)places.push(plan.subject);
  return typeof args.place==='string'&&(places.includes(args.place)||exact(text,args.place)||args.place==='home'&&/回家|到家/.test(text));
 }
 if(row.tool===WORLD+'do'){
  if(typeof args.id!=='string'||!args.id)return false;
  if([plan.actionId,plan.targetActionId,plan.task?.id,plan.waitCondition?.actionId].includes(args.id)||exact(text,args.id))return true;
  if(['inquire','buy','collect'].includes(semantic.action))return false;
  return args.id==='work'&&/打工|上班|工作|班次/.test(text)||args.id==='read'&&/看书|读书|阅读/.test(text)||args.id==='cook'&&/做饭|煮饭|焖饭/.test(text)||args.id==='eat'&&/吃饭|用餐|吃完饭/.test(text);
 }
 if(row.tool===WORLD+'update')return typeof args.outfit==='string'&&/穿|换|着装|衣服/.test(text)&&([plan.outfit,plan.targetOutfit,plan.subject].includes(args.outfit)||exact(text,args.outfit));
 return false;
}

function relatedEvent(l,round,plan,now){
 const wait=plan.waitCondition||{},since=Math.max(plan.lastProgressAt||plan.createdAt||0,plan.lastCheckedAt||0),kinds=wait.eventKinds||[wait.eventKind||plan.trigger].filter(Boolean);
 return (l.queue||[]).some(event=>{
  if(!(round.events||[]).includes(event.id)||event.lastRoundId!==round.id||!event.provenance?.trusted||event.provenance.source!=='world-notify'||!Number.isFinite(event.t)||event.t<=since||event.t>now||!(round.report?.events||[]).some(row=>row.id===event.id&&row.status==='completed'))return false;
  if(!['pending','running','completed'].includes(event.status))return false;
  if(wait.kind==='event')return matchesPlanEvent(plan,event);
  const linked=(event.relatedPlanIds||[]).includes(plan.id)||(plan.sourceEventIds||[]).includes(event.id);
  if(!linked||kinds.length&&!kinds.includes(event.kind))return false;
  return true;
 });
}

function planning(plan){
 if(plan.kind==='planning'||plan.semanticIdentity?.action==='plan'||['daily-planning','daily-schedule'].includes(plan.topic))return true;
 return /(?:规划|制定|整理).{0,12}(?:计划|日程|安排|一天|明天|次日)|(?:每日|每天|明天|次日).{0,10}(?:规划|日程|计划)|(?:安排).{0,8}(?:一整天|一天的活动)/.test(positiveText(plan));
}
function windowOf(plan,now){
 const semantic=plan.semanticIdentity?.window||{},target=planBusinessAt(plan),declaredStart=timestamp(plan.windowStart)||timestamp(semantic.start),declaredEnd=timestamp(plan.windowEnd)||timestamp(semantic.end);
 if(target){
  const start=Date.parse(dayKey(target)+'T00:00:00+08:00'),end=start+DAY;
  // A planner's generated check-day window must not override its target day.
  // Preserve a narrower declared window when it overlaps that business day.
  return declaredStart&&declaredEnd&&declaredStart<end&&declaredEnd>start?{start:Math.max(start,declaredStart),end:Math.min(end,declaredEnd)}:{start,end};
 }
 const start=declaredStart||Date.parse(dayKey(timestamp(plan.nextAt)||now)+'T00:00:00+08:00');
 return {start,end:declaredEnd||start+DAY};
}
function localCommit(l,round,plan,now,successful){
 if(!planning(plan))return null;
 const focused=unique([round.planId,...(round.planIds||[])]).filter(Boolean),planners=(l.plans||[]).filter(candidate=>focused.includes(candidate.id)&&planning(candidate));
 const sole=planners.length===1&&planners[0].id===plan.id,window=windowOf(plan,now);
 for(const history of l.planHistory||[]){
  if(history.roundId!==round.id||!Number.isFinite(history.at)||history.at<round.startedAt||history.at>now||history.id===plan.id||!['create','update'].includes(history.op))continue;
  const change=(round.report?.planChanges||[]).find(change=>change.id===history.id&&change.op===history.op),child=(l.plans||[]).find(candidate=>candidate.id===history.id);
  if(!change||!child||!planOpen(child.status)||['blocked','needs_review'].includes(child.status)||child.scheduleIssue)continue;
  const parent=change.parentPlanId||change.plan?.parentPlanId||change.patch?.parentPlanId||child.parentPlanId||child.sourcePlanId;
  if(parent?parent!==plan.id:!sole)continue;
  if(history.op==='update'&&!Object.entries(history.patch||{}).some(([key,value])=>['goal','nextStep','nextAt','trigger','waitCondition','expiresAt','constraints'].includes(key)&&!same(history.before?.[key],value)))continue;
  const trigger=inspectPlanTrigger(child,l,{now});if(!trigger.valid||trigger.kind==='time'&&trigger.nextAt<=now)continue;
  const at=timestamp(child.businessAt)||timestamp(child.semanticIdentity?.window?.businessAt)||timestamp(child.nextAt)||timestamp(child.windowStart);
  if(!at||at<window.start||at>=window.end)continue;
  return unique((history.evidenceIds||[]).filter(id=>successful.some(item=>item.receipt.id===id)));
 }
 return null;
}

/** Progress is an attributable result, not a changed observation or a whole-round mutation flag. */
export function proofOfPlanProgress(l,data,round,plan,{now=Date.now()}={}){
 const none={progressed:false,receiptIds:[],reason:'no-related-progress'};
 if(!l||!round?.id||!plan?.id||!Number.isFinite(now)||!Number.isFinite(round.startedAt)||round.startedAt>now)return none;
 const focused=unique([round.planId,...(round.planIds||[]),...(round.events||[])]).filter(Boolean);if(!focused.includes(plan.id))return none;
 const successful=receipts(l,round,now),steps=stepsFor(l,round,plan),semantic=plan.semanticIdentity||semanticPlan(plan,l,{now,fishId:data?.fishId||plan.fishId});
 const mutations=successful.filter(item=>mutation(item.row.tool,item.args));
 const matchedSteps=mutations.filter(item=>matchesStep(item,steps));
 if(matchedSteps.length)return {progressed:true,receiptIds:unique(matchedSteps.map(item=>item.receipt.id)),reason:'confirmed-related-step'};
 const matchedActions=planning(plan)?[]:mutations.filter(item=>relatedAction(item,plan,semantic));
 if(matchedActions.length)return {progressed:true,receiptIds:unique(matchedActions.map(item=>item.receipt.id)),reason:'confirmed-related-action'};
 if(relatedEvent(l,round,plan,now))return {progressed:true,receiptIds:[],reason:'completed-related-event'};
 const local=localCommit(l,round,plan,now,successful);
 return local!==null?{progressed:true,receiptIds:local,reason:'committed-local-planning'}:none;
}
