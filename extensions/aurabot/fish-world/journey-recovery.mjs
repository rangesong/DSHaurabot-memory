import {sameSession} from './session-identity.mjs';

const WORLD='mcp__fish-world__world_';
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const mutation=(tool,args={})=>['go','do','say','update'].some(name=>tool===WORLD+name)||tool===WORLD+'friends'&&args.action!=='list';
const definitionAliasError=text=>/不是当前有效后台定义回合|任务定义入口返回非有效后台回合/.test(text||'');
function safeDefinitionRound(l,event){
 const round=(l.journal||[]).find(row=>row.type==='round'&&row.id===event.roundId);
 if(event.noWorldMutation!==true||!round||round.kind!=='owner-task'||!['completed','uncertain'].includes(round.status)||!definitionAliasError(round.summary))return false;
 const rows=l.journal.filter(row=>row.round===round.id&&row.tool?.startsWith(WORLD));
 if(!rows.length||rows.some(row=>!String(row.sessionId||'').startsWith('session-')||!sameSession(row.sessionId,rows[0].sessionId)||row.status!=='confirmed'||row.isError||mutation(row.tool,parse(row.args)||{})))return false;
 return Object.values(round.actionSequences||{}).every(sequence=>{
  const calls=sequence.calls||[];
  if(mutation(sequence.tool)&&(!calls.some(call=>mutation(call.tool))||sequence.outcome?.notSubmitted!==true))return false;
  return calls.every(call=>mutation(call.tool)?call.status==='not-submitted'&&sequence.outcome?.notSubmitted===true:call.status==='confirmed');
 });
}
/** One-time local repair for the pre-1.3.22 factory/native session-ID seam. Never submits or shares anything. */
export function recoverSessionAliasFailures(l,{now}={}){
 const recoveredIds=[];
 if(!Number.isFinite(now)||now<=0||l.round||l.externalPending||l.recovery)return {changed:false,recoveredIds};
 for(const task of l.ownerTasks||[]){
  if(task.status!=='active'||task.kind!=='journey'||task.phase!=='blocked'||task.contractIssue?.code!=='definition-attempt-limit'||task.journey?.sessionAliasRecovery||task.journey?.stage!=='arrival-purpose'||task.finalAction||task.steps?.length||task.owner!==l.owner||task.persona!==l.persona)continue;
  const registered=task.journey.registeredSessionId;
  if(!registered||registered.startsWith('session-'))continue;
  if(l.ownerTasks.some(other=>other.id!==task.id&&other.status==='active'&&other.kind!=='planning'&&other.owner===task.owner&&other.persona===task.persona&&other.createdAt>task.createdAt))continue;
  const rounds=(task.history||[]).filter(event=>event.kind==='definition-incomplete').slice(-3);
  if(rounds.length!==3||new Set(rounds.map(event=>event.roundId)).size!==3||!rounds.every(event=>safeDefinitionRound(l,event)))continue;
  const sameTaskRows=(l.journal||[]).filter(row=>row.ownerTaskId===task.id);
  if(sameTaskRows.some(row=>['executing','uncertain'].includes(row.status)||mutation(row.tool,parse(row.args)||{})&&row.status!=='confirmed'))continue;
  const sessionActions=(l.journal||[]).filter(row=>row.at>=task.createdAt&&sameSession(row.sessionId,registered)&&(!row.ownerTaskId||row.ownerTaskId===task.id)&&mutation(row.tool,parse(row.args)||{}));
  if(sessionActions.some(row=>row.status!=='confirmed'&&!(row.status==='failed'&&/\[E_RULE\]/.test(row.result||'')&&!/timeout|超时|abort|断线|ECONN|未确认|不确定/i.test(row.result||''))))continue;
  const actions=(l.journal||[]).filter(row=>{const args=parse(row.args);return args&&typeof args==='object'&&!Array.isArray(args)&&row.at>=task.createdAt&&row.at<=now&&row.finishedAt>=row.at&&row.finishedAt<=now&&sameSession(row.sessionId,registered)&&(!row.ownerTaskId||row.ownerTaskId===task.id)&&row.status==='confirmed'&&!row.isError&&mutation(row.tool,args);});
  task.journey.sessionAliasRecovery={version:1,at:now,previousIssue:structuredClone(task.contractIssue),previousAttempts:task.definitionAttempts||0,roundIds:rounds.map(event=>event.roundId)};
  task.journey.priorActions=actions.slice(-8).map(row=>({id:row.id,tool:row.tool,arguments:parse(row.args)||{},at:row.at,finishedAt:row.finishedAt,result:row.result,localOnly:true,historyOnly:true}));
  task.phase='needs_definition';task.nextAt=now;task.definitionNextAt=now;task.definitionAttempts=0;task.lastCheckedAt=0;delete task.contractIssue;
  task.revision++;task.updatedAt=now;
  task.history.push({at:now,kind:'session-alias-recovered',roundIds:rounds.map(event=>event.roundId),noWorldMutation:true,localOnly:true});
  recoveredIds.push(task.id);
 }
 return {changed:recoveredIds.length>0,recoveredIds};
}
