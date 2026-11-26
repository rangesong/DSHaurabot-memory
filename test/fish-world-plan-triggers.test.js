import test from 'node:test';
import assert from 'node:assert/strict';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {inspectPlanTrigger,normalizePlanTriggers,nextPlanWait,matchesPlanEvent,planBusinessAt} from '../extensions/aurabot/fish-world/plan-triggers.mjs';
import {preparePlanChanges,applyPlanChanges,advancePlans} from '../extensions/aurabot/fish-world/plans.mjs';
const now=Date.parse('2026-11-26T12:00:00+08:00'),day=86400000;
function plan(patch={}){return {id:'synthetic-plan',revision:1,status:'pending',goal:'合成未完事务',reason:'合成原因',nextStep:'合成下一步',nextAt:0,createdAt:now-day,updatedAt:now-day,sourceEventIds:[],...patch};}
function life(plans=[]){return {...newLife(now),owner:'synthetic-owner',persona:'synthetic-persona',plans};}
const source=(id,sender='合成朋友#2',t=now-1000)=>({id,kind:'talk',sender,t,status:'completed',provenance:{trusted:true,source:'world-notify'}});

test('absolute future and overdue nextAt remain executable; prose never supplies a clock',()=>{
 for(const nextAt of [now+60000,now-60000])assert.deepEqual(inspectPlanTrigger(plan({nextAt}),life(),{now}),{valid:true,kind:'time',nextAt});
 for(const nextAt of [0,NaN,Infinity,-1,'23:45'])assert.equal(inspectPlanTrigger(plan({nextAt,trigger:'每天23:45'}),life(),{now}).valid,false);
});
test('a pure wish is retained as blocked with an idempotent scheduling issue',()=>{
 const p=plan({trigger:'吃完饭再去'}),l=life([p]),original=structuredClone(p);
 const first=normalizePlanTriggers(l,{now});assert.equal(first.blocked,1);assert.equal(p.status,'blocked');assert.equal(p.scheduleIssue.code,'trigger-needs-definition');
 for(const key of ['id','goal','nextStep','trigger','createdAt'])assert.deepEqual(p[key],original[key]);
 const saved=JSON.stringify(l);assert.equal(normalizePlanTriggers(l,{now:now+60000}).changed,0);assert.equal(JSON.stringify(l),saved);
});
test('natural-language and time names are not valid event kinds',()=>{
 for(const eventKind of ['time','clock','每天23:45','饭好了']){
  const p=plan({status:'waiting_event',trigger:eventKind,waitCondition:{kind:'event',eventKind}}),l=life([p]);
  assert.equal(inspectPlanTrigger(p,l,{now}).valid,false);assert.equal(nextPlanWait(p,l,now),null);normalizePlanTriggers(l,{now});assert.equal(p.status,'blocked');
 }
});
test('a future structured time repairs missing nextAt without replaying an elapsed time',()=>{
 const p=plan({status:'waiting_event',waitCondition:{kind:'time',at:now+60000}}),l=life([p]);normalizePlanTriggers(l,{now});
 assert.equal(p.nextAt,now+60000);assert.equal(p.status,'waiting_event');const saved=JSON.stringify(l);assert.equal(normalizePlanTriggers(l,{now:now+1}).changed,0);assert.equal(JSON.stringify(l),saved);
 advancePlans(l,{life:l,state:{}},now+60000);assert.equal(p.status,'pending');assert.equal(p.lastTimeWake,now+60000);assert.equal(nextPlanWait(p,l,now+60000),null);
});
test('an unconsumed elapsed time is checked once, while a consumed time never becomes a fake event',()=>{
 const p=plan({status:'waiting_event',waitCondition:{kind:'time',at:now-1000}}),l=life([p]);normalizePlanTriggers(l,{now});
 advancePlans(l,{life:l,state:{}},now);assert.equal(p.status,'pending');assert.equal(p.lastTimeWake,now-1000);assert.equal(nextPlanWait(p,l,now),null);
 p.status='waiting_event';normalizePlanTriggers(l,{now:now+1});assert.equal(p.status,'blocked');assert.equal(p.scheduleIssue.code,'time-already-consumed');assert.notEqual(p.waitCondition.eventKind,'time');
});
test('a newly selected future time can replace an already consumed old clock',()=>{
 const p=plan({status:'waiting_event',nextAt:now+60000,lastTimeWake:now-1000,waitCondition:{kind:'time',at:now-1000}}),l=life([p]);
 normalizePlanTriggers(l,{now});assert.deepEqual(p.waitCondition,{kind:'time',at:now+60000});assert.deepEqual(nextPlanWait(p,l,now),p.waitCondition);
});
test('verified social sources become fresh structured waits without replaying their old source',()=>{
 const p=plan({sourceEventIds:['old']}),l=life([p]);l.queue=[source('old')];normalizePlanTriggers(l,{now});
 assert.equal(p.status,'waiting_event');assert.equal(p.waitCondition.subject,'合成朋友#2');assert.equal(p.waitCondition.after,now);assert.equal(matchesPlanEvent(p,l.queue[0]),false);
 const saved=JSON.stringify(l);assert.equal(normalizePlanTriggers(l,{now:now+5000}).changed,0);assert.equal(JSON.stringify(l),saved);
 assert.equal(matchesPlanEvent(p,{...source('fresh','合成朋友#2',now+1),status:'pending'}),true);
 assert.equal(matchesPlanEvent(p,source('foreign','合成别鱼#3',now+1)),false);
 assert.equal(matchesPlanEvent(p,{...source('untrusted','合成朋友#2',now+1),provenance:{trusted:false}}),false);
});
test('multi-peer social sources retain each verified sender and exclude a third peer',()=>{
 const p=plan({sourceEventIds:['a','b']}),l=life([p]);l.queue=[source('a'),source('b','合成朋友#3')];normalizePlanTriggers(l,{now});
 assert.deepEqual(p.waitCondition.subjects,['合成朋友#2','合成朋友#3']);
 assert.equal(matchesPlanEvent(p,source('fresh','合成朋友#3',now+1)),true);assert.equal(matchesPlanEvent(p,source('third','合成朋友#4',now+1)),false);
});
test('untrusted or owner-synthetic source text cannot invent a social trigger',()=>{
 for(const provenance of [{trusted:false,source:'world-notify'},{trusted:true,source:'owner-control'}]){
  const p=plan({sourceEventIds:['old']}),l=life([p]);l.queue=[{...source('old'),provenance}];normalizePlanTriggers(l,{now});assert.equal(p.status,'blocked');
 }
});
test('only canonical event types and the exact trusted bound subject may wake a plan',()=>{
 const p=plan({status:'waiting_event',waitCondition:{kind:'event',eventKind:'done',subject:'合成朋友#2',trustedOnly:true,after:now-1}});
 assert.equal(matchesPlanEvent(p,{...source('done','合成朋友#2',now),kind:'done'}),true);
 assert.equal(matchesPlanEvent(p,source('talk','合成朋友#2',now)),false);
 assert.equal(matchesPlanEvent(p,{...source('done','合成朋友#2',now),kind:'done',provenance:{trusted:false}}),false);
 for(const t of [undefined,NaN,0,'12:00'])assert.equal(matchesPlanEvent(p,{...source('done','合成朋友#2',now),kind:'done',t}),false);
 assert.equal(inspectPlanTrigger(plan({status:'waiting_event',waitCondition:{kind:'event',eventKind:'done',subject:'合成朋友#2',after:0}}),life(),{now}).valid,true);
});
test('legacy state waits and narrow idle conditions preserve their exact contract',()=>{
 for(const waitCondition of [{kind:'state'},{kind:'state',when:'idle'}]){
  const p=plan({status:'waiting_event',waitCondition}),l=life([p]);assert.deepEqual(inspectPlanTrigger(p,l,{now}).waitCondition,waitCondition);assert.deepEqual(nextPlanWait(p,l,now),waitCondition);normalizePlanTriggers(l,{now});assert.deepEqual(p.waitCondition,waitCondition);
 }
 assert.equal(inspectPlanTrigger(plan({waitCondition:{kind:'state',when:'anything'}}),life(),{now}).valid,false);
});
test('only explicit expiry is terminal; business windowEnd alone does not end a cross-day transaction',()=>{
 const expired=plan({id:'expired',nextAt:now-1000,expiresAt:now-1}),transaction=plan({id:'cross-day',nextAt:now-1000,windowEnd:now-day}),l=life([expired,transaction]);
 normalizePlanTriggers(l,{now});assert.equal(expired.status,'expired');assert.equal(transaction.status,'pending');assert.equal(transaction.scheduleIssue,undefined);
});
test('old pure overviews are held by their original target date, even with historical mutation receipts',()=>{
 const p=plan({goal:'按睡前规划过明天：洗衣、菜园、下午工作',createdAt:now-2*day,nextAt:now-1000,sourceEvidenceIds:['old-action']}),l=life([p]);
 l.journal=[{id:'old-action',tool:'mcp__fish-world__world_do',args:'{"id":"wash"}',status:'confirmed'}];normalizePlanTriggers(l,{now});
 assert.equal(p.status,'blocked');assert.equal(p.scheduleIssue.code,'past-daily-overview');assert.notEqual(p.status,'completed');
});
test('explicit business dates and goal dates hold stale overviews without guessing missing dates',()=>{
 for(const patch of [{businessAt:now-day},{semanticIdentity:{window:{businessAt:now-day}}},{goal:'2026-11-25日程安排'}]){
  const p=plan({goal:'合成日程安排',nextAt:now-1,...patch}),l=life([p]);normalizePlanTriggers(l,{now});assert.equal(p.status,'blocked');assert.equal(p.scheduleIssue.code,'past-daily-overview');
 }
 const p=plan({goal:'合成日程安排',nextAt:now-1,windowEnd:now-day}),l=life([p]);normalizePlanTriggers(l,{now});assert.equal(p.status,'pending');
});
test('business target days are creation-anchored and can be shared with local planning proof',()=>{
 const p=plan({goal:'规划明天的日程',createdAt:now-2*day});
 assert.equal(planBusinessAt(p),Date.parse('2026-11-25T00:00:00+08:00'));
 assert.equal(planBusinessAt({...p,businessAt:now}),now);
 assert.equal(planBusinessAt(plan({goal:'无日期的普通事务'})),0);
});
test('an explicit unfinished action chain is not discarded as an old overview',()=>{
 for(const patch of [{steps:[{tool:'synthetic'}]},{ownerTaskId:'synthetic-owner-task'},{travelCallId:'submitted'},{phase:'travelling'}]){
  const p=plan({goal:'按规划过明天',createdAt:now-2*day,nextAt:now-1,...patch}),l=life([p]);normalizePlanTriggers(l,{now});assert.equal(p.status,'pending');
 }
});
test('normalization does not revive business-blocked, reviewed or terminal records',()=>{
 const l=life(['blocked','needs_review','completed','expired','cancelled','abandoned','merged','superseded'].map((status,index)=>plan({id:String(index),status,nextAt:now+1}))),saved=JSON.stringify(l);
 assert.equal(normalizePlanTriggers(l,{now}).changed,0);assert.equal(JSON.stringify(l),saved);
});
test('plan creation returns an actionable local issue and retains the blocked draft without throwing',()=>{
 const l=life(),round={id:'r',events:[],receipts:[{id:'proof',isError:false}]},input={planChanges:[{op:'create',plan:{goal:'合成愿望',reason:'合成原因',nextStep:'等自然语言条件',trigger:'明天起床后',status:'pending'}}]};
 const changes=preparePlanChanges(l,input,{round,now,fishId:'synthetic-fish'});assert.equal(changes[0].scheduleIssue.code,'trigger-needs-definition');
 applyPlanChanges(l,changes,{now});assert.equal(l.plans[0].status,'blocked');assert.equal(l.plans[0].revision,1);assert.equal(l.plans[0].goal,'合成愿望');
 const p=l.plans[0],updates=preparePlanChanges(l,{planChanges:[{op:'update',id:p.id,expectedRevision:p.revision,evidenceIds:['proof'],patch:{nextAt:now+60000,status:'pending'}}]},{round,now,fishId:'synthetic-fish'});
 applyPlanChanges(l,updates,{now});assert.equal(l.plans[0].status,'pending');assert.equal(l.plans[0].scheduleIssue,undefined);
});
test('invalid updates are blocked atomically and cannot persist a fake pending trigger',()=>{
 const l=life([plan({nextAt:now+1})]),round={id:'r',events:[],receipts:[]};
 const changes=preparePlanChanges(l,{planChanges:[{op:'update',id:'synthetic-plan',expectedRevision:1,patch:{nextAt:0,waitCondition:{kind:'event',eventKind:'time'}}}]},{round,now,fishId:'synthetic-fish'});
 assert.equal(changes[0].scheduleIssue.code,'trigger-needs-definition');applyPlanChanges(l,changes,{now});assert.equal(l.plans[0].status,'blocked');assert.equal(l.plans[0].revision,2);
});
test('a scheduling-only hold can be repaired by a valid evidenced timing patch without an explicit status',()=>{
 const p=plan(),l=life([p]);normalizePlanTriggers(l,{now});const round={id:'r',events:[],receipts:[{id:'current-now',isError:false}]};
 const changes=preparePlanChanges(l,{planChanges:[{op:'update',id:p.id,expectedRevision:p.revision,evidenceIds:['current-now'],patch:{nextAt:now+60000}}]},{round,now,fishId:'synthetic-fish'});
 assert.equal(changes[0].patch.status,'pending');applyPlanChanges(l,changes,{now});assert.equal(l.plans[0].status,'pending');assert.equal(l.plans[0].scheduleIssue,undefined);
});
test('timing alone cannot release a business block or an unevidenced scheduling hold',()=>{
 const round={id:'r',events:[],receipts:[{id:'current-now',isError:false}]};
 for(const scheduling of [false,true]){
  const p=plan({status:'blocked',...(scheduling?{scheduleIssue:{version:1,code:'trigger-needs-definition',at:now}}:{})}),l=life([p]);
  const changes=preparePlanChanges(l,{planChanges:[{op:'update',id:p.id,expectedRevision:1,evidenceIds:scheduling?[]:['current-now'],patch:{nextAt:now+60000}}]},{round,now,fishId:'synthetic-fish'});
  applyPlanChanges(l,changes,{now});assert.equal(l.plans[0].status,'blocked');
 }
});
