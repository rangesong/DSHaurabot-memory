import test from 'node:test';
import assert from 'node:assert/strict';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {registerJourney,advanceOwnerTasks,linkOwnerTaskEvent,ownerTaskGuard} from '../extensions/aurabot/fish-world/owner-tasks.mjs';
import {setOwnerTaskContext} from '../extensions/aurabot/fish-world/session-identity.mjs';
const W='mcp__fish-world__world_',NOW=Date.parse('2026-11-28T16:00:00+08:00'),sid='synthetic-post-travel',identity={owner:'synthetic-owner',persona:'synthetic'},destination='synthetic-coast',label='合成海岸';
const input={goal:'去合成海岸看看',destination,arrivalStep:'看看现场，不要求购买',completionType:'action'};
function fixture(){
 const l={...newLife(NOW-3600000),...identity},row={id:'confirmed-private-go',sessionId:'session-'+sid,round:null,ownerTaskId:null,tool:W+'go',args:JSON.stringify({place:destination,by:'bus',request_id:'original-request'}),status:'confirmed',isError:false,at:NOW-600000,finishedAt:NOW-599900,result:'好的。15:50 出发：坐合成线路到海岸站 → 步行到合成海岸，16:30 到合成海岸。车费 2 贝。'},data={fishId:'synthetic#1',life:l,at:{state:NOW},errors:{},state:{where:{kind:'trip',to:{id:destination,name:label},arrive:'2026-11-28T16:30:00+08:00'},doing:null}};
 l.journal.push(row);setOwnerTaskContext(l,sid,{key:'actual-owner-source',ownerText:'下午去合成海岸看看',taskId:null,at:NOW});
 const register=()=>registerJourney(l,input,{sessionId:sid,identity,now:NOW,data});return {l,row,data,register};
}
const registerTask=f=>{const r=f.register();return f.l.ownerTasks.find(t=>t.id===r.task.id);};
test('post-action registration adopts only the existing confirmed trip and preserves original receipts without dispatch',()=>{
 const f=fixture(),journal=structuredClone(f.l.journal),r=f.register(),task=f.l.ownerTasks.find(t=>t.id===r.task.id);
 assert.equal(task.phase,'travelling');assert.equal(task.createdAt,NOW);assert.equal(task.travelAt,f.row.finishedAt);assert.equal(task.travelCallId,f.row.id);assert.equal(task.journey.adoptedTravel.receiptId,f.row.id);assert.equal(task.journey.adoptedTravel.linkedAt,NOW);assert.equal(task.steps[0].arguments.by,'bus');assert.equal(task.status,'active');assert.equal(task.completedSteps.length,0);assert.deepEqual(f.l.journal,journal);
 const prior=task.journey.priorActions[0];assert.equal(prior.at,f.row.at);assert.equal(prior.finishedAt,f.row.finishedAt);assert.equal(prior.arguments.request_id,'original-request');assert.equal(prior.historyOnly,true);assert.equal(f.l.outbox.length,0);
 const twice=f.register();assert.equal(twice.reused,true);assert.equal(f.l.ownerTasks.length,1);assert.deepEqual(f.l.journal,journal);
});
test('real fresh arrival advances the adopted travel leg but never completes the remaining purpose',()=>{
 const f=fixture(),task=registerTask(f);f.data.state.where={kind:'place',place:{id:destination,name:label}};f.data.at.state=NOW+180000;advanceOwnerTasks(f.l,f.data,NOW+180000);
 assert.equal(task.status,'active');assert.equal(task.phase,'needs_definition');assert.equal(task.journey.stage,'arrival-purpose');assert.equal(task.completedSteps.length,1);assert.equal(task.completedSteps[0].callId,f.row.id);assert.equal(task.journey.arrivalStep,input.arrivalStep);
});
test('a trusted actual arrival event naturally continues an adopted trip and remains pending',()=>{
 const f=fixture(),r=f.register(),task=f.l.ownerTasks.find(t=>t.id===r.task.id),event={id:'real-arrival',kind:'arrive',text:'到了'+label,t:NOW+60000,provenance:{trusted:true,source:'world-notify'},status:'observed'};linkOwnerTaskEvent(f.l,event,NOW+60000);assert.equal(task.phase,'needs_definition');assert.equal(task.status,'active');assert.deepEqual(event.ownerTaskIds,[task.id]);assert.equal(event.status,'pending');
});
test('already arrived fresh state adopts the old physical trip as history and retains the unfinished purpose',()=>{
 const f=fixture();f.data.state.where={kind:'place',place:{id:destination,name:label}};const task=registerTask(f);assert.equal(task.phase,'needs_definition');assert.equal(task.journey.stage,'arrival-purpose');assert.equal(task.journey.adoptedTravel.receiptId,f.row.id);assert.equal(task.travelAt,f.row.finishedAt);assert.equal(task.status,'active');assert.equal(task.completedSteps.length,1);
});
test('a passed ETA while state still says trip never proves arrival',()=>{
 const f=fixture();f.data.state.where.arrive='2026-11-28T15:55:00+08:00';const task=registerTask(f);assert.equal(task.phase,'travelling');assert.equal(task.journey.arrivedAt,undefined);assert.equal(task.completedSteps.length,0);
});
test('foreign scope/session/fish, stale or erroneous state, and mismatched location never adopt an old trip',()=>{
 for(const alter of [f=>f.row.sessionId='foreign',f=>f.row.owner='foreign',f=>f.row.persona='foreign',f=>f.row.fishId='other#2',f=>f.data.at.state=NOW-180001,f=>f.data.at.state=NOW+1,f=>f.data.at.state=f.row.at,f=>f.data.errors.state='failed',f=>f.data.state.where.to.id='other',f=>f.data.state.where={kind:'place',place:{id:'other'}}]){
  const f=fixture();alter(f);const before=structuredClone(f.l.journal),task=registerTask(f);assert.equal(task.journey.adoptedTravel,undefined);assert.deepEqual(f.l.journal,before);
 }
});
test('any later failed, unknown or different-target go supersedes the older confirmed travel for adoption',()=>{
 for(const [status,place,session]of [['failed',destination,sid],['uncertain',destination,sid],['confirmed','other',sid],['confirmed',destination,'other-session']]){
  const f=fixture();f.l.journal.push({...f.row,id:'later-go',sessionId:session,status,isError:status!=='confirmed',args:JSON.stringify({place}),at:NOW-1000,finishedAt:NOW-900});const task=registerTask(f);assert.equal(task.journey.adoptedTravel,undefined);
 }
});
test('a route preview or weak success string cannot become an authoritative departure',()=>{
 for(const text of ['去合成海岸有 3 种走法，16:30 到合成海岸。','好的，路线建议：16:30 到合成海岸。','好的，预计16:30到合成海岸。']){const f=fixture();f.row.result=text;assert.equal(f.register().task.journey.adoptedTravel,undefined);}
});
test('owned or already post-linked receipts never transfer to another purpose',()=>{
 const f=fixture();f.row.ownerTaskId='old-owned-task';assert.equal(f.register().task.journey.adoptedTravel,undefined);
 const g=fixture(),first=g.register(),before=structuredClone(g.l.journal);const other=registerJourney(g.l,{...input,goal:'另一个目的',arrivalStep:'另一个后续'},{sessionId:sid,identity,now:NOW+1,data:g.data});assert.equal(other.task.journey.adoptedTravel,undefined);assert.equal(g.l.ownerTasks.find(t=>t.id===first.task.id).travelCallId,g.row.id);assert.deepEqual(g.l.journal,before);
});
test('bad timestamps/arguments or read failures simply skip adoption and never block raw actions',()=>{
 for(const alter of [f=>f.row.args='broken',f=>f.row.finishedAt=NOW+1,f=>f.row.at=undefined,f=>f.row.isError=true,f=>f.row.status='failed']){const f=fixture();alter(f);assert.equal(f.register().task.journey.adoptedTravel,undefined);}
 const f=fixture();f.data.errors.state='read failed';f.l.journal.push({id:'failed-read',tool:W+'now',status:'failed',isError:true,sessionId:sid,result:'timeout'});f.register();assert.equal(ownerTaskGuard(f.l,f.data,{name:W+'go',arguments:{place:'other'},agent:{session:{id:sid}}},false,NOW),undefined);assert.equal(f.l.outbox.length,0);
});
test('an explicit existing travel receipt must be adopted exactly or registration fails without changing any state',()=>{
 const f=fixture(),result=registerJourney(f.l,{...input,existingTravelCallId:f.row.id},{sessionId:sid,identity,now:NOW,data:f.data});assert.equal(result.task.journey.adoptedTravel.receiptId,f.row.id);
 for(const alter of [g=>g.data.at.state=NOW-180001,g=>g.row.ownerTaskId='already-owned',g=>g.row.status='uncertain',g=>g.l.journal.push({...g.row,id:'newer',args:'{"place":"other"}',at:NOW-500,finishedAt:NOW-400})]){
  const g=fixture();registerJourney(g.l,{goal:'旧合成目的',destination:'old',arrivalStep:'旧目的'},{sessionId:sid,identity,now:NOW-1,data:g.data});alter(g);const before=structuredClone(g.l);assert.throws(()=>registerJourney(g.l,{...input,existingTravelCallId:g.row.id},{sessionId:sid,identity,now:NOW,data:g.data}),/回执|行程/);assert.deepEqual(g.l,before);
 }
 const g=fixture(),before=structuredClone(g.l);assert.throws(()=>registerJourney(g.l,{...input,existingTravelCallId:'wrong-call'},{sessionId:sid,identity,now:NOW,data:g.data}),/回执|行程/);assert.deepEqual(g.l,before);
});
