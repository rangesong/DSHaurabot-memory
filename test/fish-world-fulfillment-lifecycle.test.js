import test from 'node:test';
import assert from 'node:assert/strict';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {rememberOwnerTurn,registerJourney,defineOwnerTask,noteOwnerTaskResult,reconcilePurposeFulfillment,ownerTaskSnapshot,ownerTaskCandidates,ownerTaskGuard,endOwnerTaskRound} from '../extensions/aurabot/fish-world/owner-tasks.mjs';
const W='mcp__fish-world__world_',now=Date.parse('2026-11-28T15:00:00+08:00'),sid='synthetic-owner-session',identity={owner:'synthetic-owner',persona:'synthetic'};
function fixture(){
 const l={...newLife(now),...identity,ownerTasks:[]},data={life:l,at:{state:now},state:{where:{kind:'place',place:{id:'fixture-shop',name:'合成书店'}}}};let seq=0;
 return {l,data,turn:(text,extra={})=>rememberOwnerTurn(l,identity,{text,sessionId:sid,turnKey:++seq,confirmedWorld:true,...extra},now),journey(input,extra={}){const result=registerJourney(l,input,{sessionId:sid,identity,now,data,...extra});return l.ownerTasks.find(task=>task.id===result.task.id);},
  define(task,id){return defineOwnerTask(l,{id:task.id,expectedRevision:task.revision,steps:[{tool:'world_do',arguments:JSON.stringify({id}),nextStep:'依真实选项继续'}]},{sessionId:sid,now,data});},
  row(task,id,text,tool='do'){const row={id:'receipt-'+(++seq),ownerTaskId:task.id,sessionId:sid,tool:W+tool,args:JSON.stringify(tool==='do'?{id}:{}),status:'confirmed',isError:false,at:now,finishedAt:now,result:text};l.journal.push(row);noteOwnerTaskResult(l,data,row,now);return row;}};
}
function legacy(){
 const f=fixture(),task=f.turn('你现在去鱼的世界买一本合成书');f.define(task,'fixture-shelves');f.row(task,'fixture-shelves','合成书架：看看摆着的书。');
 Object.assign(task,{status:'completed',phase:'completed',completedAt:now});return {...f,task};
}
test('only a proved current-day false purchase completion reopens locally paused, retaining the complete execution prefix and journal',()=>{
 const f=legacy(),before=structuredClone({journal:f.l.journal,steps:f.task.steps,completedSteps:f.task.completedSteps,receipts:f.task.receipts,purpose:f.task.originalPurpose}),r=reconcilePurposeFulfillment(f.l,now);
 assert.deepEqual(r.reopenedIds,[f.task.id]);assert.equal(f.task.status,'active');assert.equal(f.task.phase,'needs_definition');assert.equal(f.task.nextAt,0);assert.equal(f.task.focus.state,'paused');assert.equal(f.task.contractIssue.code,'required-purchase-unproved');assert.equal(f.task.history.at(-1).previousCompletedAt,now);
 assert.deepEqual({journal:f.l.journal,steps:f.task.steps,completedSteps:f.task.completedSteps,receipts:f.task.receipts,purpose:f.task.originalPurpose},before);assert.equal(ownerTaskCandidates(f.l,now,f.data).some(row=>row.ownerTaskId===f.task.id),false);const once=structuredClone(f.task);assert.equal(reconcilePurposeFulfillment(f.l,now).changed,0);assert.deepEqual(f.task,once);assert.equal(ownerTaskSnapshot(f.l)[0].fulfillment.purchaseSucceeded,false);
});
test('past-day, incomplete, foreign, unknown and already purchased completions do not reopen',()=>{
 for(const alter of [f=>{f.task.createdAt-=86400000;f.task.completedAt-=86400000;},f=>f.task.completedSteps[0].callId='missing',f=>f.task.owner='foreign',f=>f.task.persona='foreign',f=>f.l.journal.push({id:'unknown',ownerTaskId:f.task.id,sessionId:sid,tool:W+'do',args:'{"id":"fixture"}',status:'uncertain',at:now}),f=>f.l.journal.push({id:'purchase',ownerTaskId:f.task.id,sessionId:sid,tool:W+'do',args:'{"id":"fixture-book"}',status:'confirmed',at:now,result:'你买了 1 本合成书，花了 5 贝。'})]){
  const f=legacy();alter(f);assert.deepEqual(reconcilePurposeFulfillment(f.l,now).reopenedIds,[]);assert.equal(f.task.status,'completed');
 }
});
test('the current owner pure sightseeing purpose can conclude from onsite evidence despite a model-expanded action goal',()=>{
 const f=fixture();f.turn('你现在去合成书店看看');const result=f.journey({goal:'到合成书店买一本书',destination:'fixture-shop',arrivalStep:'看看货架后自己决定买不买',completionType:'action'}),task=f.l.ownerTasks.find(task=>task.id===result.id);
 assert.equal(task.ownerCompletionType,'observe');assert.equal(task.fulfillment.purchaseRequired,false);const read=f.row(task,null,'11-28 周六 15:00\n你在：合成书店\n当前陈列是合成书','now');
 const done=defineOwnerTask(f.l,{id:task.id,expectedRevision:task.revision,action:'complete_observation',summary:'已核对当前陈列',evidenceIds:[read.id]},{sessionId:sid,now,data:f.data});assert.equal(done.task.status,'completed');assert.equal(done.task.journey.observation.communicationStatus,'not-claimed');
 const required=fixture();required.turn('你现在去鱼的世界买一本合成书');const buy=required.journey({goal:'去合成书店看看',destination:'fixture-shop',arrivalStep:'看看书架',completionType:'observe'}),reading=required.row(buy,null,'11-28 周六 15:00\n你在：合成书店','now');assert.equal(buy.fulfillment.purchaseRequired,true);assert.throws(()=>defineOwnerTask(required.l,{id:buy.id,expectedRevision:buy.revision,action:'complete_observation',summary:'只看了书架',evidenceIds:[reading.id]},{sessionId:sid,now,data:required.data}),/实际行动/);
});
test('an immediate current owner task focuses locally without travel registration; casual, deferred, future and inflight records keep their boundaries',()=>{
 const input={goal:'到合成湖看看',destination:'fixture-lake',arrivalStep:'看看当前水面',completionType:'observe'};
 const f=fixture(),old=f.journey(input),facts=structuredClone({phase:old.phase,steps:old.steps,goal:old.journey.goal});const current=f.turn('你现在去鱼的世界买一盒合成药');assert.equal(current.focus.state,'active');assert.equal(old.focus.state,'paused');assert.deepEqual({phase:old.phase,steps:old.steps,goal:old.journey.goal},facts);
 for(const text of ['买药了吗？','他说去买药','不要去买药','明天去鱼的世界买药','帮我买一盒东西']){const g=fixture(),prior=g.journey(input);g.turn(text,{confirmedWorld:false});assert.equal(prior.focus.state,'active',text);}
 const g=fixture(),busy=g.journey(input);busy.phase='waiting_event';busy.activity={blocking:true};g.turn('你现在去鱼的世界买药');assert.equal(busy.focus.state,'active');assert.equal(busy.phase,'waiting_event');
});
test('an explicit known resume exposes ordinary continuation without changing phase or replaying world steps',()=>{
 const f=fixture(),input={goal:'到合成湖看看',destination:'fixture-lake',arrivalStep:'看看当前水面',completionType:'observe'},old=f.journey(input);old.phase='waiting_evidence';old.nextAt=0;
 f.journey({goal:'到另一合成地点看看',destination:'other-place',arrivalStep:'看看现场',completionType:'observe'});f.journey({...input,resumeTaskId:old.id});
 const candidate=ownerTaskCandidates(f.l,now,f.data).find(row=>row.ownerTaskId===old.id);assert.equal(candidate.definitionOnly,false);assert.equal(old.phase,'waiting_evidence');assert.equal(old.nextAt,0);
 const round={id:'resumed-continuation',sessionId:'background',ownerTaskId:old.id,startedAt:now,definitionOnly:false,report:{}};f.l.round=round;const before=structuredClone(old);assert.equal(ownerTaskGuard(f.l,f.data,{agent:{session:{id:'background'}},name:W+'go',arguments:{place:'fixture-lake'}},true,now),undefined);assert.deepEqual(old,before);endOwnerTaskRound(f.l,round,true,now);assert.equal(ownerTaskCandidates(f.l,now,f.data).some(row=>row.ownerTaskId===old.id),false);assert.equal(old.phase,'waiting_evidence');assert.equal(old.nextAt,0);
});
