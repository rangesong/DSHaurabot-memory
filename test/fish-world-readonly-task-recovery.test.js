import test from 'node:test';
import assert from 'node:assert/strict';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import * as tasks from '../extensions/aurabot/fish-world/owner-tasks.mjs';
const W='mcp__fish-world__world_',now=Date.parse('2026-11-28T12:39:00+08:00'),sid='11111111-2222-4333-8444-555555555555';
function fixture(){
 const l={...newLife(now),owner:'synthetic-owner',persona:'synthetic',ownerTasks:[]};
 const action={tool:W+'do',arguments:{id:'synthetic-action'},nextStep:'继续原始目的',waitFor:'receipt'};
 const task={id:'synthetic-task',owner:l.owner,persona:l.persona,status:'active',phase:'ready',kind:'journey',revision:2,createdAt:now-5000,updatedAt:now-4000,instruction:'合成原始目的',nextStep:'继续原始目的',nextAt:now-4000,steps:[action],finalAction:action,stepIndex:0,receipts:[],completedSteps:[],history:[{kind:'arrived',at:now-4000,purposeStillPending:true}],source:{sessionId:sid},journey:{stage:'arrival-purpose'}};
 l.ownerTasks.push(task);return {l,task};
}
function poison(f){
 const cause={id:'readonly-timeout',ownerTaskId:f.task.id,sessionId:'session-'+sid,tool:W+'now',args:'{}',status:'uncertain',isError:true,result:'timeout: synthetic read',at:now-3000,finishedAt:now-2900};
 f.l.journal.push(cause);f.task.phase='uncertain';f.task.history.push({kind:'uncertain',callId:cause.id,tool:cause.tool,at:now-2900,noReplay:true});
 const checked={id:'readonly-success',ownerTaskId:f.task.id,sessionId:sid,tool:W+'now',args:'{}',status:'confirmed',isError:false,result:'合成现场',at:now-2000,finishedAt:now-1900};f.l.journal.push(checked);return {cause,checked};
}
test('readonly uncertain results do not poison a ready owner task or set recovery',()=>{
 const f=fixture(),before=structuredClone(f.task),entry={id:'read-timeout',ownerTaskId:f.task.id,sessionId:sid,tool:W+'now',args:'{}',status:'uncertain',isError:true};
 tasks.noteOwnerTaskResult(f.l,{},entry,now);assert.deepEqual(f.task,before);assert.equal(f.l.recovery,false);
 f.l.journal.push(entry);assert.equal(tasks.uncertainTask(f.l,f.task),false);
});
test('strict read-after-timeout proof restores only a local waiting stage and preserves original evidence, steps and purpose',()=>{
 const f=fixture();poison(f);const journal=structuredClone(f.l.journal),old=structuredClone(f.task),result=tasks.reconcileReadonlyOwnerTaskFailures(f.l,now);
 assert.equal(result.changed,1);assert.equal(f.task.phase,'waiting_evidence');assert.equal(f.task.nextAt,0);assert.equal(f.task.status,'active');assert.equal(f.task.instruction,old.instruction);assert.deepEqual(f.task.steps,old.steps);assert.deepEqual(f.task.receipts,old.receipts);assert.deepEqual(f.task.completedSteps,old.completedSteps);assert.deepEqual(f.l.journal,journal);
 assert.equal(f.task.history.at(-1).kind,'readonly-failure-reconciled');const once=structuredClone(f.task);assert.equal(tasks.reconcileReadonlyOwnerTaskFailures(f.l,now).changed,0);assert.deepEqual(f.task,once);
});
test('mutation unknown, executing and non-rule failures keep the original protection',()=>{
 for(const status of ['executing','uncertain','failed']){
  const f=fixture();poison(f);f.l.journal.push({id:'real-unknown',ownerTaskId:f.task.id,sessionId:sid,tool:W+'do',args:'{"id":"synthetic-action"}',status,result:'timeout',at:now-1000});
  const before=structuredClone(f.task);assert.equal(tasks.uncertainTask(f.l,f.task),true);assert.equal(tasks.reconcileReadonlyOwnerTaskFailures(f.l,now).changed,0);assert.deepEqual(f.task,before);
 }
});
test('missing or mismatched causal/read/session/scope evidence cannot restore a task',()=>{
 for(const change of [f=>f.l.journal.pop(),f=>f.l.journal[1].sessionId='different',f=>f.l.journal.forEach(row=>row.sessionId='foreign'),f=>f.l.journal[1].tool=W+'profile',f=>f.task.owner='different',f=>f.task.persona='different',f=>f.task.history.at(-1).callId='missing',f=>f.task.history.push({kind:'unknown-failure',callId:'missing',at:now-1000}),f=>f.l.journal[0].args='broken',f=>f.l.journal[1].ownerTaskId='other-task']){
  const f=fixture();poison(f);change(f);const before=structuredClone(f.task);assert.equal(tasks.reconcileReadonlyOwnerTaskFailures(f.l,now).changed,0);assert.deepEqual(f.task,before);
 }
});
test('read success is historical transport evidence without a three-minute expiry, never evidence that the pending action ran',()=>{
 const f=fixture();poison(f);f.task.createdAt-=3600000;for(const row of f.l.journal){row.at-=1800000;row.finishedAt-=1800000;}f.task.history.at(-1).at-=1800000;
 assert.equal(tasks.reconcileReadonlyOwnerTaskFailures(f.l,now).changed,1);assert.equal(f.task.phase,'waiting_evidence');assert.deepEqual(f.task.completedSteps,[]);assert.deepEqual(f.task.receipts,[]);
 const unknown=fixture();poison(unknown);unknown.l.journal.push({id:'unbound-write',sessionId:sid,tool:W+'go',args:'{"place":"synthetic"}',status:'uncertain',at:now-1000});assert.equal(tasks.reconcileReadonlyOwnerTaskFailures(unknown.l,now).changed,0);
});
test('an unbound unknown mutation before the readonly timeout but after task creation still prevents restoration',()=>{
 const f=fixture();poison(f);f.l.journal.unshift({id:'earlier-unknown',sessionId:'session-'+sid,tool:W+'do',args:'{"id":"synthetic-action"}',status:'uncertain',at:f.task.createdAt+500});
 const before=structuredClone(f.task);assert.equal(tasks.reconcileReadonlyOwnerTaskFailures(f.l,now).changed,0);assert.deepEqual(f.task,before);
 for(const createdAt of [undefined,NaN,0,now+1]){const invalid=fixture();poison(invalid);invalid.task.createdAt=createdAt;assert.equal(tasks.reconcileReadonlyOwnerTaskFailures(invalid.l,now).changed,0);}
});
test('the existing local reconciliation path repairs only the qualified readonly poison',()=>{
 const f=fixture();poison(f);const before=structuredClone(f.l.journal);const result=tasks.reconcileOwnerTasks(f.l,{},now);
 assert.equal(result.changed,1);assert.equal(f.task.phase,'waiting_evidence');assert.equal(f.task.nextAt,0);assert.deepEqual(f.l.journal,before);
});
