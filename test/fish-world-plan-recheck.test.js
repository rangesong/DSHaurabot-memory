import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {newLife,defaults} from '../extensions/aurabot/fish-world/state.mjs';
import {FishBridge} from '../extensions/aurabot/fish-world/bridge.mjs';
import {recheckLife,installMaintenance} from '../extensions/aurabot/fish-world/maintenance.mjs';
import {unknownWorldMutationGuard} from '../extensions/aurabot/fish-world/owner-tasks.mjs';
import {applyPlanChanges,finishPlanCheck} from '../extensions/aurabot/fish-world/plans.mjs';

const NOW=Date.parse('2026-11-28T17:40:00+08:00'),START=NOW-1200000,FINISH=START+60000,W='mcp__fish-world__world_';
const identity={owner:'synthetic-owner',persona:'synthetic-persona'},sid='11111111-2222-4333-8444-555555555555';
const input={planId:'synthetic-price-plan',expectedRevision:5,failedRoundId:'synthetic-price-round'},copy=value=>structuredClone(value);
function lifeFixture(){
 const before={id:input.planId,...identity,revision:4,status:'active',goal:'保留原始合成采购目的',originalGoal:'保留原始合成采购目的',nextStep:'核对现场后继续',nextAt:START-1000,businessAt:START-3600000,windowStart:START-3600000,waitCondition:{kind:'time',at:START-1000},updatedAt:START-2000};
 const plan={...copy(before),revision:5,status:'pending',nextAt:NOW+43200000,waitCondition:{kind:'time',at:NOW+43200000},updatedAt:FINISH};
 const sequence={id:'local-price-check',source:'program-action-sequence',roundId:input.failedRoundId,tool:W+'do',cost:2,at:START+1000,status:'blocked',calls:[{id:'profile-only',tool:W+'profile',status:'confirmed'}],outcome:{ok:false,status:'blocked',notSubmitted:true,message:'声明消费低于现场单价和数量',automaticReplay:false}};
 const l={...newLife(START-86400000),...identity,controls:{autonomy:false},ownerInstructions:[],days:{'2026-11-28':{work:3,idle:7,social:2,share:1,spend:9,calls:25}},outbox:[{id:'prior-share',state:'sent',receipt:{id:'synthetic-delivery'}}],contextWindow:{key:'owned-window',windows:[{key:'owned-window',sessionId:'session-'+sid}]}};
 l.plans=[plan,{...copy(before),id:'unrelated-plan',revision:1,nextAt:NOW+60000}];
 l.planHistory=[{at:FINISH,roundId:input.failedRoundId,op:'update',id:plan.id,fromRevision:4,toRevision:5,before:copy(before),patch:{nextAt:plan.nextAt,status:'pending',waitCondition:copy(plan.waitCondition)}}];
 l.costs.rounds=[{roundId:input.failedRoundId,windowId:'owned-window',triggerKind:'plan',planId:plan.id,at:START,finishedAt:FINISH,status:'completed'}];
 l.journal=[{id:'profile-only',round:input.failedRoundId,sessionId:sid,tool:W+'profile',args:'{}',status:'confirmed',isError:false,at:START+1000,finishedAt:START+2000,result:'synthetic#1'},
  {id:input.failedRoundId,type:'round',kind:'plan',status:'completed',at:FINISH,receipts:['profile-only'],actionSequences:{'local-price-check':sequence}}];
 return {l,get plan(){return l.plans[0];},get history(){return l.planHistory[0];},get header(){return l.costs.rounds[0];},get round(){return l.journal.find(row=>row.type==='round');},get sequence(){return this.round.actionSequences['local-price-check'];}};
}
const preserved=l=>copy(Object.fromEntries(['journal','outbox','ownerInstructions','days','controls','nextIdle','scheduler'].map(key=>[key,l[key]])));
function rejectsUnchanged(alter){const f=lifeFixture();alter(f);const before=copy(f.l);assert.throws(()=>recheckLife(f.l,input,{now:NOW}));assert.deepEqual(f.l,before);}
function routeFixture(){
 assert.ok(process.env.THINKSTAR_TEST_TMP,'Use the managed test runner');const folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'plan-recheck-')),file=path.join(folder,'runtime.json'),f=lifeFixture();
 fs.writeFileSync(file,JSON.stringify({version:3,fishId:'synthetic#1',state:{},at:{},errors:{},recent:[],life:f.l},null,2)+'\n');
 const bridge=new FishBridge({file,credential:()=>''});bridge.save();let enabled=true,settingsWrites=0;
 const engine={bridge,closed:false,clock:()=>NOW,get l(){return bridge.data.life;},get cfg(){return {...defaults,...this.l.controls};},change:fn=>bridge.change(data=>fn(data.life,data))},routes=new Map();
 const api={dataDir:(...parts)=>path.join(folder,...parts),core:{http:{body:async req=>req.body}},settings:()=>defaults,saveSettings:()=>{settingsWrites++;assert.fail('Plan recheck must not write settings');},route:(name,handler,options)=>{assert.equal(options.access,'panel');routes.set(name,handler);}};
 installMaintenance(api,()=>engine,()=>enabled);
 return {folder,file,bridge,engine,routes,get settingsWrites(){return settingsWrites;},disable:()=>{enabled=false;},call:(body=input,method='POST')=>routes.get('/plan-recheck')({method,body})};
}
function finishedCheckFixture(){
 const f=lifeFixture(),tomorrow=Date.parse('2026-11-29T08:00:00+08:00');f.l.plans[0]=copy(f.history.before);f.l.planHistory=[];
 applyPlanChanges(f.l,[{op:'update',id:input.planId,expectedRevision:4,patch:{nextAt:tomorrow,status:'pending',waitCondition:{kind:'time',at:tomorrow}},evidenceIds:[]}],{now:FINISH,roundId:input.failedRoundId});
 const data={life:f.l,state:{where:{kind:'place',place:{id:'synthetic-shop'}},doing:null},at:{state:FINISH}},round={id:input.failedRoundId,kind:'plan',planId:input.planId,planIds:[input.planId],startedAt:START,events:[],receipts:[{id:'profile-only',tool:W+'profile',text:'synthetic#1',isError:false}]};
 finishPlanCheck(f.l,data,round,{now:FINISH});return f;
}

test('a proved local price-preparation deferral changes only its own scheduling time and leaves all execution evidence intact',()=>{
 const f=lifeFixture(),before=copy(f.l),protectedBefore=preserved(f.l),r=recheckLife(f.l,input,{now:NOW});
 assert.equal(r.repeated,false);assert.equal(r.planId,input.planId);assert.equal(f.plan.nextAt,NOW);assert.equal(f.plan.status,'pending');assert.equal(f.plan.revision,6);assert.equal(f.plan.waitCondition.at,NOW);assert.equal(f.plan.goal,before.plans[0].goal);assert.equal(f.plan.originalGoal,before.plans[0].originalGoal);assert.equal(f.plan.nextStep,before.plans[0].nextStep);assert.deepEqual(f.l.plans[1],before.plans[1]);assert.deepEqual(preserved(f.l),protectedBefore);
 assert.equal(f.l.planHistory.length,2);assert.equal(f.l.planHistory.at(-1).id,input.planId);assert.deepEqual(f.l.planHistory.at(-1).before,before.plans[0]);assert.equal(f.l.maintenanceOperations.length,1);assert.equal(f.l.maintenanceOperations[0].operationId,r.operationId);
 // Actual plans use zero/null/empty-string as unset business-date sentinels.
 // A timed wait introduced by the failed price check may be rechecked now.
 for(const unset of [0,null,'']){
  const g=lifeFixture(),midnight=Date.parse('2026-11-28T00:00:00+08:00'),tomorrow=Date.parse('2026-11-29T08:00:00+08:00');
  Object.assign(g.history.before,{businessAt:unset,windowStart:midnight});Object.assign(g.plan,{businessAt:unset,windowStart:midnight,status:'waiting_event',nextAt:tomorrow,waitCondition:{kind:'time',at:tomorrow}});Object.assign(g.history.patch,{status:'waiting_event',nextAt:tomorrow,waitCondition:copy(g.plan.waitCondition)});
  const original=copy(g.l),protectedBefore=preserved(g.l);recheckLife(g.l,input,{now:NOW});assert.equal(g.plan.status,'pending');assert.equal(g.plan.nextAt,NOW);assert.equal(g.plan.waitCondition.at,NOW);assert.equal(g.plan.businessAt,unset);assert.equal(g.plan.windowStart,midnight);assert.equal(g.plan.goal,original.plans[0].goal);assert.deepEqual(preserved(g.l),protectedBefore);
 }
 // Rechecking metadata neither clears old unknown outcomes nor treats unrelated
 // earlier inventory uncertainty or later conversation as an action permission.
 for(const mode of ['old-unknown','recovery','later-say']){
  const g=lifeFixture();if(mode==='old-unknown'){
   g.l.ownerTasks=[{id:'old-rice-task',...identity,status:'active',kind:'buy',phase:'uncertain',currentSessionId:sid,originalPurpose:'旧合成买米要求'}];
   g.l.journal.push({id:'old-unknown',ownerTaskId:'old-rice-task',sessionId:sid,...identity,tool:W+'do',args:'{"id":"rice"}',status:'uncertain',at:START-60000});
  }else if(mode==='recovery')g.l.recovery=true;
  else g.l.journal.push({id:'later-say',round:'other-round',sessionId:sid,...identity,tool:W+'say',args:'{"fish":"#123","text":"合成问候"}',status:'confirmed',at:FINISH+1000,finishedAt:FINISH+2000});
  const journal=copy(g.l.journal),tasks=copy(g.l.ownerTasks),recovery=g.l.recovery;recheckLife(g.l,input,{now:NOW});assert.equal(g.plan.nextAt,NOW);assert.deepEqual(g.l.journal,journal);assert.deepEqual(g.l.ownerTasks,tasks);assert.equal(g.l.recovery,recovery);
  if(mode==='old-unknown')assert.match(unknownWorldMutationGuard(g.l,{name:W+'do',arguments:{id:'rice',request_id:'changed'},agent:{session:{id:sid}}}),/未确认/);
 }
});

test('scope, revision, newer history and later owner instructions fail closed without editing the plan',()=>{
 for(const alter of [f=>f.l.owner='',f=>f.plan.owner='foreign',f=>f.plan.persona='foreign',f=>f.plan.revision++,f=>f.history.toRevision=4,f=>f.history.fromRevision=3,f=>f.history.roundId='other-round',f=>f.l.planHistory.push({...copy(f.history),roundId:'new-round',at:FINISH+1}),f=>f.l.ownerInstructions.push({text:'新的合成要求',at:START+1000,revision:1})])rejectsUnchanged(alter);
});

test('future original business windows, terminal plans, stale days and non-time waits cannot be pulled forward',()=>{
 for(const alter of [f=>f.history.before.nextAt=START+1,f=>f.history.before.businessAt=NOW+60000,f=>f.history.before.windowStart=NOW+60000,f=>f.plan.businessAt=NOW+60000,f=>f.plan.windowStart=NOW+60000,f=>f.plan.status='completed',f=>f.plan.nextAt=START-1000,f=>f.plan.waitCondition={kind:'event',eventKind:'done'},f=>Object.assign(f.plan,{status:'waiting_event',waitCondition:{kind:'event',eventKind:'done'}}),f=>Object.assign(f.plan,{status:'waiting_event',waitCondition:{kind:'state',condition:'idle'}}),f=>{f.plan.status='waiting_event';delete f.plan.waitCondition;},f=>f.header.at-=86400000,f=>f.header.finishedAt=NOW+1,f=>f.history.at=FINISH+1])rejectsUnchanged(alter);
});

test('same-round mutation or later inventory changes prevent recheck, and budget insufficiency is never relabelled a price-software repair',()=>{
 for(const alter of [f=>f.sequence.calls.push({id:'action-child',tool:W+'do',status:'not-submitted'}),f=>f.l.journal.push({id:'mutation',round:input.failedRoundId,sessionId:sid,tool:W+'do',args:'{"id":"synthetic-item"}',status:'failed',isError:true,at:START+1000,result:'Error: [E_RULE] 合成拒绝'}),f=>f.l.journal.push({id:'round-unknown',round:input.failedRoundId,sessionId:sid,...identity,tool:W+'do',args:'{"id":"old-target"}',status:'uncertain',at:START+1000}),...['do','go','friends'].map(tool=>f=>f.l.journal.push({id:'later-'+tool,round:'other-round',sessionId:sid,...identity,tool:W+tool,args:JSON.stringify(tool==='do'?{id:'new-item'}:tool==='go'?{place:'other'}:{action:'add',fish:'#123'}),status:'confirmed',at:FINISH+1000,finishedAt:FINISH+2000})),f=>f.sequence.outcome.notSubmitted=false,f=>f.sequence.outcome.status='uncertain',f=>f.sequence.outcome.message='本次消费超过预算',f=>Object.assign(f.sequence.outcome,{message:'实际总价不足',code:'purchase-cost-understated',pricePreparation:true})])rejectsUnchanged(alter);
});

test('the same maintenance request is idempotent even though its expected revision is now old',()=>{
 const f=lifeFixture(),first=recheckLife(f.l,input,{now:NOW}),applied=copy(f.l),again=recheckLife(f.l,input,{now:NOW+1000});assert.equal(again.repeated,true);assert.equal(again.operationId,first.operationId);assert.deepEqual(f.l,applied);
});

test('the real update and finish-check lifecycle permits exactly its one derived revision and rejects every unrelated drift',()=>{
 const f=finishedCheckFixture(),h=f.history,protectedBefore=preserved(f.l),goal=f.plan.goal;assert.equal(h.fromRevision,4);assert.equal(h.toRevision,5);assert.equal(h.at,FINISH);assert.equal(f.plan.revision,6);assert.equal(f.plan.lastCheckedAt,FINISH);assert.equal(f.plan.lastCheckedRevision,5);assert.equal(f.plan.status,'waiting_event');assert.equal(f.plan.waitCondition.kind,'time');assert.equal(f.plan.waitCondition.at,Date.parse('2026-11-29T08:00:00+08:00'));
 recheckLife(f.l,{...input,expectedRevision:6},{now:NOW});assert.equal(f.plan.revision,7);assert.equal(f.plan.status,'pending');assert.equal(f.plan.nextAt,NOW);assert.equal(f.plan.waitCondition.at,NOW);assert.equal(f.plan.goal,goal);assert.deepEqual(preserved(f.l),protectedBefore);
 for(const alter of [g=>g.plan.revision++,g=>g.plan.lastCheckedAt++,g=>g.plan.lastCheckedRevision=4,g=>g.plan.goal+='改变',g=>g.plan.nextStep+='改变',g=>g.plan.windowStart++,g=>g.plan.windowEnd=NOW+60000,g=>g.plan.nextAt++,g=>g.l.planHistory.push({...copy(g.history),roundId:'newer-round',at:FINISH+1})]){
  const g=finishedCheckFixture();alter(g);const before=copy(g.l);assert.throws(()=>recheckLife(g.l,{...input,expectedRevision:g.plan.revision},{now:NOW}));assert.deepEqual(g.l,before);
 }
});

test('the panel route preserves a full private backup and receipt before changing only the selected plan',async()=>{
 const f=routeFixture(),before=fs.readFileSync(f.file),protectedBefore=preserved(f.engine.l),r=await f.call();assert.ok(f.routes.has('/maintenance'));assert.equal(r.status,'applied');assert.equal(f.engine.l.plans[0].nextAt,NOW);assert.equal(f.engine.l.plans[0].status,'pending');assert.deepEqual(preserved(f.engine.l),protectedBefore);assert.equal(f.settingsWrites,0);assert.equal(f.engine.maintenanceBusy,false);
 const receipt=JSON.parse(fs.readFileSync(r.receiptPath,'utf8'));assert.deepEqual(fs.readFileSync(receipt.backupPath),before);assert.equal(receipt.worldMutations,0);assert.equal(receipt.modelCalls,0);assert.equal(receipt.qqSends,0);
 const applied=fs.readFileSync(f.file),again=await f.call();assert.equal(again.repeated,true);assert.equal(again.operationId,r.operationId);assert.deepEqual(fs.readFileSync(f.file),applied);assert.equal(f.engine.l.maintenanceOperations.length,1);
});

test('the panel route requires POST, authorization, paused autonomy and an entirely idle module',async()=>{
 for(const alter of [f=>f.disable(),f=>f.engine.l.controls.autonomy=true,f=>f.engine.l.round={id:'active'},f=>f.engine.lock={callId:'active'},f=>f.engine.l.externalPending={callId:'active'},f=>f.engine.deliveryBusy=true,f=>f.engine.maintenanceBusy=true,f=>f.engine.closed=true,f=>f.bridge.fatal='synthetic-fatal']){const f=routeFixture();alter(f);const before=copy(f.engine.l),disk=fs.readFileSync(f.file);await assert.rejects(()=>f.call());assert.deepEqual(f.engine.l,before);assert.deepEqual(fs.readFileSync(f.file),disk);assert.equal(f.settingsWrites,0);}
 const f=routeFixture();await assert.rejects(()=>f.call(input,'GET'));assert.equal(f.engine.l.maintenanceOperations,undefined);
});

test('missing provenance, unowned windows, absent readonly receipts and arbitrary body fields do not create a repair receipt',async()=>{
 for(const alter of [f=>f.l.costs.rounds=[],f=>f.header.planId='other-plan',f=>f.header.triggerKind='recovery',f=>f.l.contextWindow.windows=[],f=>f.l.journal[0].sessionId='foreign',f=>f.l.journal[0].status='failed',f=>f.round.actionSequences={},f=>delete f.sequence.outcome])rejectsUnchanged(alter);
 const f=routeFixture(),before=fs.readFileSync(f.file);await assert.rejects(()=>f.call({...input,nextAt:NOW+1}));assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(f.engine.l.maintenanceOperations,undefined);
});
