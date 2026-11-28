import test from 'node:test';
import assert from 'node:assert/strict';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {defineOwnerTask} from '../extensions/aurabot/fish-world/owner-tasks.mjs';
const W='mcp__fish-world__world_',NOW=Date.parse('2026-11-28T16:40:00+08:00'),sid='synthetic-observation-background';
function fixture(){
 const l={...newLife(NOW),owner:'synthetic-owner',persona:'synthetic'},task={id:'synthetic-observation-purpose',owner:l.owner,persona:l.persona,revision:1,status:'active',kind:'journey',phase:'needs_definition',originalPurpose:'去合成海岸看看',instruction:'到海岸查看',purposeSource:'owner-current',ownerCompletionType:'observe',createdAt:NOW-60000,journey:{completionType:'action',stage:'arrival-purpose',arrivedAt:NOW-30000,destination:'coast',destinationName:'合成海岸'},destination:{id:'coast',label:'合成海岸'},steps:[],completedSteps:[],receipts:[],history:[],nextAt:NOW,focus:{state:'active'}};
 l.ownerTasks=[task];l.round={id:'synthetic-observation-round',kind:'owner-task',ownerTaskId:task.id,sessionId:sid,status:'running',startedAt:NOW-20000};
 const row={id:'actual-current-now-call',ownerTaskId:task.id,sessionId:'session-'+sid,round:l.round.id,tool:W+'now',args:'{}',status:'confirmed',isError:false,at:NOW-10000,finishedAt:NOW-9900,result:'11-28 周六 16:39 · 晴 6°C\n你在：合成海岸\n身体：合成饱食、精力充足\n现场有合成摊位。'};l.journal.push(row);
 const data={fishId:'synthetic#1',at:{state:NOW-5000},state:{where:{kind:'place',place:{id:'coast',name:'合成海岸'}}}},complete=evidenceIds=>defineOwnerTask(l,{id:task.id,expectedRevision:task.revision,action:'complete_observation',summary:'已经查看当前现场',...(evidenceIds===undefined?{}:{evidenceIds})},{sessionId:sid,background:true,taskId:task.id,now:NOW,data});
 return {l,task,row,data,complete};
}
test('missing, tool-name, arrival-id, old or malformed model hints all resolve to the same current native now receipt',()=>{
 for(const hint of [undefined,[W+'now'],['arrival-event-id'],['old-call'],['made-up','another'],[],'not-an-id-list']){const f=fixture(),journal=structuredClone(f.l.journal),result=f.complete(hint);assert.equal(result.task.status,'completed');assert.deepEqual(f.task.journey.observation.evidenceIds,[f.row.id]);assert.deepEqual(f.task.history.at(-1).evidenceIds,[f.row.id]);assert.deepEqual(f.l.journal,journal);assert.equal(f.l.outbox.length,0);}
});
test('the newest valid current source is selected rather than a model-specified older source',()=>{
 const f=fixture(),newer={...f.row,id:'newest-real-now',at:NOW-3000,finishedAt:NOW-2900};f.l.journal.push(newer);f.complete([f.row.id]);assert.deepEqual(f.task.journey.observation.evidenceIds,[newer.id]);
});
test('a successful same-location activity after now does not demand another internal call ID',()=>{
 const f=fixture();f.l.journal.push({id:'real-watch',sessionId:sid,round:f.l.round.id,ownerTaskId:f.task.id,tool:W+'do',args:'{"id":"synthetic-watch"}',status:'confirmed',isError:false,result:'好的，你看了一会儿海面。',at:NOW-5000,finishedAt:NOW-4900});assert.equal(f.complete().task.status,'completed');assert.deepEqual(f.task.journey.observation.evidenceIds,[f.row.id]);
});
test('no current valid now, failed/stale/future/foreign or pre-arrival reads cannot be replaced by summary or model IDs',()=>{
 for(const alter of [f=>f.l.journal=[],f=>f.row.status='failed',f=>f.row.isError=true,f=>f.row.at=NOW-180001,f=>{f.row.at=NOW+1;f.row.finishedAt=NOW+2;},f=>f.row.at=f.task.journey.arrivedAt-1,f=>f.row.sessionId='foreign',f=>f.row.round='old-round',f=>f.row.owner='foreign',f=>f.row.persona='foreign']){
  const f=fixture();alter(f);const before=structuredClone(f.task),journal=structuredClone(f.l.journal);assert.throws(()=>f.complete([W+'now']));assert.deepEqual(f.task,before);assert.deepEqual(f.l.journal,journal);
 }
});
test('the latest current read at another location cannot be washed by older good reads or a correct-looking cache',()=>{
 const f=fixture();f.l.journal.push({...f.row,id:'latest-other-place',at:NOW-3000,finishedAt:NOW-2900,result:'11-28 周六 16:40 · 晴 6°C\n你在：另一合成地方\n身体：合成饱食、精力充足\n这里是别处。'});const before=structuredClone(f.task);assert.throws(()=>f.complete([f.row.id]),/所在地/);assert.deepEqual(f.task,before);
});
test('a newer cache showing departure rejects completion, while stale trip cache cannot override newer onsite now',()=>{
 const wrong=fixture();wrong.data.state.where={kind:'trip',to:{id:'other'}};assert.throws(()=>wrong.complete(),/所在地/);
 const right=fixture();right.data.state.where={kind:'trip',to:{id:'coast'}};right.data.at.state=NOW-15000;assert.equal(right.complete().task.status,'completed');
});
test('new scoped go operations after the chosen observation invalidate it even when their target is unchanged',()=>{
 for(const status of ['executing','confirmed','uncertain','failed']){const f=fixture();f.l.journal.push({id:'later-go',sessionId:sid,round:f.l.round.id,tool:W+'go',args:'{"place":"other"}',status,isError:status!=='confirmed',result:status==='failed'?'timeout':'好的。',at:NOW-1000,finishedAt:NOW-900});const before=structuredClone(f.task);assert.throws(()=>f.complete());assert.deepEqual(f.task,before);}
});
test('later real unknown mutation invalidates the onsite proof, known rejection and foreign scope do not',()=>{
 for(const status of ['executing','uncertain','failed']){const f=fixture();f.l.journal.push({id:'later-unknown-action',sessionId:sid,round:f.l.round.id,tool:W+'do',args:'{"id":"synthetic-action"}',status,isError:true,result:'timeout',at:NOW-1000,finishedAt:NOW-900});assert.throws(()=>f.complete());}
 for(const patch of [{tool:W+'go',status:'failed',isError:true,result:'Error: [E_RULE] 合成规则拒绝'},{tool:W+'go',status:'confirmed',isError:false,result:'好的。',owner:'other-owner'}]){const f=fixture();f.l.journal.push({id:'later-nonpoison',sessionId:sid,round:f.l.round.id,args:'{}',at:NOW-1000,finishedAt:NOW-900,...patch});assert.equal(f.complete().task.status,'completed');}
});
test('original scope, phase, required purchase and actual observation-summary validation remain in force',()=>{
 for(const alter of [f=>f.task.owner='other',f=>f.task.phase='pending',f=>f.task.journey.stage='outbound',f=>f.task.originalPurpose='去合成商店买米',f=>f.task.focus.state='paused']){const f=fixture();alter(f);const before=structuredClone(f.task);assert.throws(()=>f.complete());assert.deepEqual(f.task,before);}
 const f=fixture();assert.throws(()=>defineOwnerTask(f.l,{id:f.task.id,expectedRevision:f.task.revision,action:'complete_observation',summary:''},{sessionId:sid,background:true,taskId:f.task.id,now:NOW,data:f.data}));assert.equal(f.task.status,'active');
});
