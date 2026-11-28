import test from 'node:test';
import assert from 'node:assert/strict';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {registerJourney,ownerTaskGuard,ownerTaskCandidates,taskForExecution,noteOwnerTaskResult} from '../extensions/aurabot/fish-world/owner-tasks.mjs';
import {setOwnerTaskContext} from '../extensions/aurabot/fish-world/session-identity.mjs';
const W='mcp__fish-world__world_',NOW=Date.parse('2026-11-28T16:00:00+08:00'),sid='synthetic-advisory',identity={owner:'synthetic-owner',persona:'synthetic'};
function fixture(){
 const l={...newLife(NOW),...identity},data={life:l,state:{where:{kind:'home'},doing:null},at:{state:NOW}};setOwnerTaskContext(l,sid,{key:'synthetic-turn',ownerText:'去合成公园看看',at:NOW,taskId:null});
 const input={goal:'去合成公园看看',destination:'synthetic-park',arrivalStep:'看看现场',completionType:'observe'},r=registerJourney(l,input,{sessionId:sid,identity,now:NOW,data}),task=l.ownerTasks.find(t=>t.id===r.task.id),exec=(name,args={})=>({name:W+name,arguments:args,callId:'new-call',agent:{session:{id:sid}}});
 return {l,data,task,input,exec};
}
test('unfinished, completed, paused, future and definition-missing task metadata never deny a new world action',()=>{
 for(const patch of [{phase:'needs_definition',steps:[],finalAction:null},{phase:'uncertain'},{phase:'travelling'},{phase:'working'},{phase:'waiting_event'},{phase:'waiting_evidence'},{status:'completed',phase:'completed'},{focus:{state:'paused'}},{notBefore:NOW+86400000},{kind:'planning'},{optional:true},{availability:{checkOnly:true}}]){
  const f=fixture();Object.assign(f.task,patch);const before=structuredClone(f.task);assert.equal(ownerTaskGuard(f.l,f.data,f.exec('do',{id:'new-action'}),false,NOW),undefined,JSON.stringify(patch));assert.equal(ownerTaskGuard(f.l,f.data,f.exec('go',{place:'new-place'}),true,NOW),undefined);assert.deepEqual(f.task,before);
 }
});
test('already successful task steps are progress evidence rather than a permission lock',()=>{
 const f=fixture(),action={tool:W+'do',arguments:{id:'synthetic-meal'}};f.task.completedSteps=[{action,callId:'confirmed'}];f.task.journey.priorActions=[{...action}];f.task.finalAction={tool:W+'go',arguments:{place:'other'}};assert.equal(ownerTaskGuard(f.l,f.data,f.exec('do',{id:'synthetic-meal'}),false,NOW),undefined);
});
test('true unknown same-target operations remain sealed, while another action and normal reads remain available',()=>{
 const f=fixture();f.l.journal.push({id:'unknown',ownerTaskId:f.task.id,sessionId:sid,tool:W+'do',args:'{"id":"old-action","count":1}',status:'uncertain',isError:true,result:'timeout',at:NOW});f.task.phase='uncertain';
 assert.ok(ownerTaskGuard(f.l,f.data,f.exec('do',{id:'old-action',count:3,request_id:'changed'}),false,NOW));assert.equal(ownerTaskGuard(f.l,f.data,f.exec('do',{id:'different'}),false,NOW),undefined);assert.equal(ownerTaskGuard(f.l,f.data,f.exec('now'),false,NOW),undefined);
});
test('an unknown navigation seals only its own destination independently from task state',()=>{
 const f=fixture();f.l.journal.push({id:'unknown-go',ownerTaskId:f.task.id,sessionId:sid,tool:W+'go',args:'{"place":"old-place"}',status:'uncertain'});assert.equal(ownerTaskGuard(f.l,f.data,f.exec('go',{place:'new-place'}),false,NOW),undefined);assert.ok(ownerTaskGuard(f.l,f.data,f.exec('go',{place:'old-place',by:'taxi'}),false,NOW));assert.equal(ownerTaskGuard(f.l,f.data,f.exec('say',{fish:'#123',text:'hello'}),false,NOW),undefined);
});
test('normal missing definitions and exhausted old definition budgets receive ordinary actionable checks',()=>{
 for(const patch of [{phase:'needs_definition',definitionAttempts:3},{phase:'blocked',definitionAttempts:3},{phase:'blocked',definitionAttempts:3,contractIssue:{code:'definition-attempt-limit'}},{phase:'needs_definition',contractIssue:{code:'required-purchase-unproved'}},{phase:'waiting_evidence'}]){
  const f=fixture();Object.assign(f.task,{...patch,nextAt:0,lastCheckedAt:0});const c=ownerTaskCandidates(f.l,NOW,f.data).find(c=>c.ownerTaskId===f.task.id);assert.ok(c,JSON.stringify(patch));assert.equal(c.definitionOnly,false);assert.equal(c.readOnly,false);assert.equal(f.task.phase,patch.phase);
 }
});
test('advisory rechecks keep the existing ten-minute interval without a permanent definition-attempt stop',()=>{
 const f=fixture();Object.assign(f.task,{phase:'waiting_evidence',nextAt:0,lastCheckedAt:NOW,definitionAttempts:99});assert.equal(ownerTaskCandidates(f.l,NOW+599999,f.data).length,0);const c=ownerTaskCandidates(f.l,NOW+600000,f.data)[0];assert.equal(c.ownerTaskId,f.task.id);assert.equal(c.definitionOnly,false);
});
test('dedicated local planning and known-capacity checking keep their special round types',()=>{
 const f=fixture();Object.assign(f.task,{kind:'planning',phase:'pending',nextAt:NOW});assert.equal(ownerTaskCandidates(f.l,NOW,f.data)[0].planningOnly,true);Object.assign(f.task,{kind:'work',phase:'blocked',availability:{checkOnly:true}});const c=ownerTaskCandidates(f.l,NOW,f.data)[0];assert.equal(c.readOnly,true);
});
test('registering or resuming a purpose never fabricates completion or mutates the physical activity',()=>{
 for(const phase of ['travelling','working','waiting_event','uncertain']){
  const f=fixture();f.task.phase=phase;f.data.state.doing={name:'synthetic current activity'};const before=structuredClone({phase:f.task.phase,steps:f.task.steps,receipts:f.task.receipts,completedSteps:f.task.completedSteps,state:f.data.state}),next=registerJourney(f.l,{goal:'去另一合成地点看看',destination:'other',arrivalStep:'看看',completionType:'observe',replaceTaskId:f.task.id},{sessionId:sid,identity,now:NOW+1,data:f.data});assert.equal(next.ok,true);assert.equal(f.task.status,'active');assert.equal(f.task.focus.state,'paused');assert.deepEqual({phase:f.task.phase,steps:f.task.steps,receipts:f.task.receipts,completedSteps:f.task.completedSteps,state:f.data.state},before);
  const resumed=registerJourney(f.l,{...f.input,resumeTaskId:f.task.id},{sessionId:sid,identity,now:NOW+2,data:f.data});assert.equal(resumed.task.phase,phase);assert.deepEqual(f.data.state,before.state);
 }
});
test('the same owner purpose may be retrieved while unknown without requiring a new progress gate',()=>{
 const f=fixture();f.task.phase='uncertain';const result=registerJourney(f.l,f.input,{sessionId:sid,identity,now:NOW+1,data:f.data});assert.equal(result.reused,true);assert.equal(f.task.phase,'uncertain');
});
test('unrelated private actions do not inherit an old task, while exact continuation remains attribution only',()=>{
 const f=fixture();f.task.finalAction={tool:W+'do',arguments:{id:'old-step'}};setOwnerTaskContext(f.l,sid,{key:'question',taskId:null,at:NOW});assert.equal(taskForExecution(f.l,f.exec('do',{id:'new-step'})),undefined);assert.equal(taskForExecution(f.l,f.exec('do',{id:'old-step'})),f.task);assert.equal(ownerTaskGuard(f.l,f.data,f.exec('do',{id:'new-step'}),false,NOW),undefined);
});
test('the actual engine still refuses another tool while a global lock or external request is in flight',()=>{
 for(const field of ['lock','externalPending']){const f=fixture(),e=new LifeEngine({bridge:{data:f.data,change:fn=>fn(f.data)},clock:()=>NOW,identity:()=>identity,settings:()=>({}),host:{cancel:async()=>{}}});if(field==='lock')e.lock={callId:'original'};else e.l.externalPending={callId:'original',sessionId:sid};assert.match(e.guard(f.exec('do',{id:'new'}),false,true),/仍在执行|等待回执/);}
});
test('a confirmed navigation whose receipt format is unrecognized keeps its purpose without creating global recovery',()=>{
 const f=fixture(),row={id:'confirmed-unparsed-go',ownerTaskId:f.task.id,sessionId:sid,tool:W+'go',args:'{"place":"synthetic-park"}',status:'confirmed',isError:false,result:'合成成功回执：行程已提交，具体抵达信息暂不可解析。',at:NOW,finishedAt:NOW};f.l.journal.push(row);
 noteOwnerTaskResult(f.l,f.data,row,NOW);assert.equal(f.task.phase,'waiting_evidence');assert.equal(f.task.status,'active');assert.equal(f.task.contractIssue.code,'travel-evidence-missing');assert.equal(f.l.recovery,false);assert.equal(row.status,'confirmed');assert.equal(f.task.completedSteps.length,0);
 assert.equal(ownerTaskGuard(f.l,f.data,f.exec('do',{id:'another'}),false,NOW),undefined);assert.equal(ownerTaskCandidates(f.l,NOW,f.data)[0].definitionOnly,false);
});
