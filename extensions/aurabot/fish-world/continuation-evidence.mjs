import {createHash} from 'node:crypto';
import {sessionKey} from './session-identity.mjs';
import {knownWorldRejection} from './tool-output.mjs';

const W='mcp__fish-world__world_',unique=values=>[...new Set(values.filter(value=>typeof value==='string'&&value.length>0&&value.length<=200))];
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const size=value=>JSON.stringify(value).length;
const clip=(value,max)=>String(value??'').toWellFormed().slice(0,max).toWellFormed();
function actionOf(row,life,now,index){
 if(typeof row?.id!=='string'||!row.id||row.id.length>200||row.owner!==undefined&&row.owner!==life.owner||row.persona!==undefined&&row.persona!==life.persona)return;
 if(!['go','do','say','update','friends'].some(tool=>row.tool===W+tool))return;
 const at=row.finishedAt??row.at;if(!Number.isFinite(row.at)||!Number.isFinite(at)||at<row.at||at>now||at<=0)return;
 try{
  const args=typeof row.args==='string'?JSON.parse(row.args):row.args;
  if(!args||typeof args!=='object'||Array.isArray(args)||!Object.keys(args).some(key=>key!=='request_id')||row.tool===W+'friends'&&(typeof args.action!=='string'||args.action==='list'))return;
  const {request_id:ignored,...business}=args,key=createHash('sha256').update(JSON.stringify([row.tool,canonical(business)])).digest('hex');
  return {row,args,key,at,index};
 }catch{return;}
}
function attribution(life){
 const byEvent=new Map(),byReceipt=new Map(),byRound=new Map(),rounds=new Map();
 const sameScope=value=>(value.owner===undefined||value.owner===life.owner)&&(value.persona===undefined||value.persona===life.persona);
 const plans=new Map((life.plans||[]).filter(sameScope).map(plan=>[plan.id,plan])),tasks=new Map((life.ownerTasks||[]).filter(sameScope).map(task=>[task.id,task]));
 const windows=life.contextWindow?.windows||[],ownedSessions=new Set(windows.map(window=>sessionKey(window.sessionId)).filter(Boolean));
 const add=(map,key,ids)=>{if(typeof key==='string')map.set(key,unique([...(map.get(key)||[]),...ids]));};
 for(const event of life.queue||[])add(byEvent,event.id,event.relatedPlanIds||[]);
 for(const plan of plans.values()){for(const id of plan.sourceEventIds||[])add(byEvent,id,[plan.id]);for(const id of plan.sourceEvidenceIds||[])add(byReceipt,id,[plan.id]);}
 for(const row of life.costs?.rounds||[])if(sameScope(row))rounds.set(row.roundId,row);
 if(life.round&&!rounds.has(life.round.id))rounds.set(life.round.id,{...life.round,roundId:life.round.id});
 for(const row of [...(life.costs?.rounds||[]),...(life.journal||[]).filter(row=>row.type==='round')]){
  const id=row.roundId||row.id,plans=[row.planId,...(row.planIds||[]),...(row.sourceEventIds||[]).flatMap(id=>byEvent.get(id)||[])];add(byRound,id,plans);
 }
 const forRow=row=>unique([row.planId,...(row.planIds||[]),...(byRound.get(row.round)||[]),...(byReceipt.get(row.id)||[])]);
 return {plans,tasks,forEvents:ids=>unique(ids.flatMap(id=>byEvent.get(id)||[])),forRow,
  owned:row=>{
   const sid=sessionKey(row.sessionId),meta=rounds.get(row.round);
   if(!life.owner||!life.persona||!row.round||!meta||!sid||!ownedSessions.has(sid)||!sameScope(row))return false;
   if(meta.sessionId!==undefined&&sessionKey(meta.sessionId)!==sid)return false;
   const start=meta.at??meta.startedAt;if(Number.isFinite(start)&&row.at<start)return false;
   if(meta.windowId&&!windows.some(window=>window.key===meta.windowId&&sessionKey(window.sessionId)===sid))return false;
   if(forRow(row).some(id=>!plans.has(id))||row.ownerTaskId&&!tasks.has(row.ownerTaskId))return false;
   return true;
  }};
}

/** Historical tool results only. This projection never guards, retries, completes, or changes a plan. */
export function continuationEvidence(life,round={}, {now=Date.now(),maxChars=2400,maxItems=4}={}){
 const limit=Math.max(256,Math.min(2400,Number.isFinite(maxChars)?Math.trunc(maxChars):2400));
 const count=Math.max(0,Math.min(4,Number.isFinite(maxItems)?Math.trunc(maxItems):4)),links=attribution(life);
 const wanted=new Set(unique([round.planId,...(round.planIds||[]),...links.forEvents([...(round.sourceEventIds||[]),...(round.events||[])])]));
 const actions=(life.journal||[]).flatMap((row,index)=>links.owned(row)?[actionOf(row,life,now,index)]:[]).filter(Boolean).sort((a,b)=>a.at-b.at||a.index-b.index),pending=new Map(),success=[];
 for(const action of actions){
  const {row,key}=action,line=typeof row.result==='string'?row.result.trim().split(/\r?\n/,1)[0]:'';
  if(knownWorldRejection(row)){
   const prior=pending.get(key);pending.set(key,{...action,line,planIds:unique([...(prior?.planIds||[]),...links.forRow(row)]),ownerTaskIds:unique([...(prior?.ownerTaskIds||[]),row.ownerTaskId]),occurrences:(prior?.occurrences||0)+1});
  }else if(row.status==='confirmed'&&!row.isError&&!/^(?:Error:\s*)?\[E_[A-Z_]+\]/u.test(line)){
   pending.delete(key);success.push({...action,planIds:links.forRow(row)});
  }
 }
 const relevant=item=>item.planIds.some(id=>wanted.has(id))||item.ownerTaskIds.includes(round.ownerTaskId);
 const active=item=>item.planIds.some(id=>['pending','active','blocked','waiting_event','needs_review'].includes(links.plans.get(id)?.status))||item.ownerTaskIds.some(id=>links.tasks.get(id)?.status==='active');
 const selected=[...pending.values()].filter(item=>relevant(item)||active(item)||!item.planIds.length&&!item.ownerTaskIds.length&&now-item.at<=86400000).sort((a,b)=>Number(relevant(b))-Number(relevant(a))||Number(active(b))-Number(active(a))||b.at-a.at||b.index-a.index);
 const result={kind:'known-business-rejections',source:'local-journal',instruction:false,note:'仅所覆盖自有世界回合的历史拒绝，未见同动作成功；私聊等其他来源未覆盖，不代表当前必然失败。库存、移动和后续变更引用不证明条件解除。不是新指令。',items:[],omittedCount:selected.length};
 for(const entry of selected){
  if(result.items.length>=count)break;
  const {request_id:ignored,...business}=entry.args,args=structuredClone(business),argumentChars=size(args),later=success.filter(action=>(action.at>entry.at||action.at===entry.at&&action.index>entry.index)&&action.row.tool!==W+'go'&&(!entry.planIds.length||!action.planIds.length||action.planIds.some(id=>entry.planIds.includes(id)))).slice(-2);
  const item={tool:entry.row.tool,...argumentChars<=500?{arguments:args}:{argumentsOmitted:true,argumentChars},receiptId:entry.row.id,occurredAt:entry.at,
   planIds:entry.planIds.slice(0,3),resultExcerpt:clip(entry.line,240),...entry.line.length>240?{excerptTruncated:true}:{},occurrences:entry.occurrences,
   laterMutationRefs:later.map(action=>({receiptId:action.row.id,tool:action.row.tool,occurredAt:action.at,planIds:action.planIds.slice(0,2)})),historyRef:{kind:'journal',id:entry.row.id}};
  const fits=()=>size({...result,items:[...result.items,item],omittedCount:selected.length-result.items.length-1})<=limit;
  if(!fits())item.laterMutationRefs=[];
  if(!fits()&&item.arguments){delete item.arguments;item.argumentsOmitted=true;item.argumentChars=argumentChars;}
  if(!fits()){item.resultExcerpt=clip(entry.line,100);item.excerptTruncated=entry.line.length>100;item.planIds=item.planIds.slice(0,1);}
  if(fits()){result.items.push(item);result.omittedCount--;}
 }
 return result;
}
