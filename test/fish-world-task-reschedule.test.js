import test from 'node:test';
import assert from 'node:assert/strict';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {registerJourney,defineOwnerTask,endOwnerTaskRound,ownerTaskCandidates,noteOwnerTaskResult} from '../extensions/aurabot/fish-world/owner-tasks.mjs';

const W='mcp__fish-world__world_',identity={owner:'synthetic-owner',persona:'synthetic-persona'},sid='11111111-2222-4333-8444-555555555555',bg='session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const at=Date.parse('2026-11-28T08:50:00+08:00'),future=Date.parse('2026-11-28T09:00:00+08:00'),steps=[{tool:'world_do',arguments:'{"id":"bike"}',nextStep:'按原决定买车'},{tool:'world_do',arguments:'{"id":"bike-lock"}',nextStep:'配锁'},{tool:'world_go',arguments:'{"place":"home"}',nextStep:'带车回家'}];
function fixture(){
 const l={...newLife(at-86400000),...identity},data={life:l,at:{state:at-3600000},state:{where:{kind:'place',place:{id:'synthetic-shop'}}}},registered=registerJourney(l,{goal:'试骑后按决定买车配锁回家',destination:'synthetic-shop',arrivalStep:'完成买车配锁并带回家'},{identity,sessionId:sid,now:at-3600000,data}),task=l.ownerTasks.find(t=>t.id===registered.task.id);
 defineOwnerTask(l,{id:task.id,expectedRevision:task.revision,steps,nextAt:at},{sessionId:sid,now:at-3600000,data});
 const round={id:'synthetic-reschedule',sessionId:bg,ownerTaskId:task.id,startedAt:at,status:'running',definitionOnly:false,report:{summary:'现场还未开门，已把原后续步骤改到09:00，未执行世界动作'}};l.round=round;
 return {l,data,task,round,define(){return defineOwnerTask(l,{id:task.id,expectedRevision:task.revision,steps,nextAt:future},{sessionId:bg,background:true,taskId:task.id,now:at+1000,data});}};
}

test('an ordinary execution round preserves its newly saved future schedule after a read-only closed-shop check',()=>{
 const f=fixture(),original=f.task.instruction;f.l.journal.push({id:'onsite',tool:W+'now',args:'{}',status:'confirmed',sessionId:bg,round:f.round.id,at,finishedAt:at,result:'合成商店尚未开门，09:00营业'});f.define();assert.equal(f.task.history.at(-1).kind,'defined');endOwnerTaskRound(f.l,f.round,true,at+2000);
 assert.equal(f.task.phase,'pending');assert.equal(f.task.nextAt,future);assert.equal(f.task.notBefore,future);assert.equal(f.task.finalAction.arguments.id,'bike');assert.equal(f.task.completedSteps.length,0);assert.equal(f.task.instruction,original);assert.equal(ownerTaskCandidates(f.l,future-1,f.data).length,0);assert.equal(ownerTaskCandidates(f.l,future,f.data)[0].ownerTaskId,f.task.id);
});

test('an old definition, summary-only promise or inconsistent deadline keeps the existing no-progress protection',()=>{
 for(const change of [f=>{f.task.nextAt=future;f.task.notBefore=future;},f=>{f.define();f.task.history.at(-1).at=at-1;},f=>{f.define();f.task.history.at(-1).at=at+3000;},f=>{f.define();f.task.notBefore=at+2000;},f=>{f.define();f.task.nextAt=future-1;}]){const f=fixture();change(f);endOwnerTaskRound(f.l,f.round,true,at+2000);assert.equal(f.task.phase,'waiting_evidence');assert.equal(f.task.nextAt,0);assert.equal(f.task.completedSteps.length,0);}
});

test('an unknown mutation after rescheduling remains uncertain and is never made runnable by the future-definition exception',()=>{
 const f=fixture();f.define();const unknown={id:'unknown',tool:W+'do',args:'{"id":"bike"}',ownerTaskId:f.task.id,sessionId:bg,round:f.round.id,at:at+1500,status:'uncertain',result:'unknown synthetic submission'};f.l.journal.push(unknown);noteOwnerTaskResult(f.l,f.data,unknown,at+1500);endOwnerTaskRound(f.l,f.round,true,at+2000);assert.equal(f.task.phase,'uncertain');assert.equal(f.l.recovery,true);assert.equal(f.task.completedSteps.length,0);assert.equal(ownerTaskCandidates(f.l,future,f.data).length,0);
});
