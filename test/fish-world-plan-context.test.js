import test from 'node:test';
import assert from 'node:assert/strict';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {preparePlanChanges,applyPlanChanges} from '../extensions/aurabot/fish-world/plans.mjs';
import {buildTaskPrompt,carryForward,chooseWindow,windowPrompt} from '../extensions/aurabot/fish-world/world-window.mjs';

const NOW=Date.parse('2026-11-27T18:00:00+08:00'),W='mcp__fish-world__world_';
function fixture(extra={}){
 const identity={owner:'synthetic-owner',persona:'synthetic-fish'},data={fishId:'synthetic#1',state:{where:{kind:'place',place:{id:'synthetic-home'}},doing:null},now:'合成现场',at:{state:NOW},life:{...newLife(NOW),...identity}};
 const engine=new LifeEngine({bridge:{data,change:fn=>fn(data)},identity:()=>identity,clock:()=>NOW,settings:()=>({sharing:false,backgroundContextEnabled:true}),host:{cancel:async()=>{},idle:async()=>true,send:async()=>assert.fail('No QQ sends')}});
 const plan={goal:'去合成书店买书，再带回来',reason:'合成日程',nextStep:'到达后买书，保留回程',status:'pending',nextAt:NOW,businessAt:NOW,windowStart:NOW-3600000,windowEnd:NOW+3600000,destination:{id:'synthetic-store-id',name:'合成书店'},steps:[{tool:'world_go',arguments:{place:'synthetic-store-id'},nextStep:'前往书店'},{tool:'world_do',arguments:{id:'synthetic-buy-book',count:2},nextStep:'买两本书'},{tool:'world_go',arguments:{place:'home'},nextStep:'带书回家'}],expectedAction:{tool:'world_do',arguments:{id:'synthetic-buy-book',count:2},nextStep:'买两本书'},...extra};
 const registration={id:'registration',receipts:[],events:[]},changes=preparePlanChanges(engine.l,{planChanges:[{op:'create',plan}]},{round:registration,now:NOW,fishId:data.fishId});applyPlanChanges(engine.l,changes,{now:NOW,roundId:registration.id});
 const stored=engine.l.plans[0],round={id:'continued-round',kind:'plan',planId:stored.id,planIds:[stored.id],events:[],receipts:[],sessionId:'synthetic-session',startedAt:NOW,revision:engine.l.revision};
 stored.lastProgressProof={roundId:'prior-round',reason:'confirmed-related-step',receiptIds:['synthetic-go-receipt'],executedStep:'前往书店',actions:[{tool:W+'go',args:{place:'synthetic-store-id',by:'walk'},finishedAt:NOW-1000}],result:'RAW_RESULT_MUST_STAY_IN_LEDGER'};
 return{engine,data,stored,round,project:()=>carryForward(engine,identity,NOW,round).plans[stored.id]};
}
function assertContract(actual,p){
 assert.deepEqual(actual.destination,p.destination);assert.deepEqual(actual.steps,p.steps);assert.deepEqual(actual.expectedAction,p.expectedAction);
 for(const key of ['businessAt','windowStart','windowEnd'])assert.equal(actual[key],p[key]);
 assert.equal(actual.lastProgressProof.executedStep,p.lastProgressProof.executedStep);assert.deepEqual(actual.lastProgressProof.actions,p.lastProgressProof.actions);assert.deepEqual(actual.lastProgressProof.receiptIds,p.lastProgressProof.receiptIds);assert.equal(actual.lastProgressProof.historical,true);assert.equal(actual.lastProgressProof.noReplay,true);assert.equal(actual.lastProgressProof.result,undefined);
}
function packetBody(prompt){const line=prompt.split('\n\n').find(part=>part.startsWith('【世界生活状态 '));assert.ok(line);return JSON.parse(line.slice(line.indexOf('\n')+1).replace(/^(?:完整交接快照（当前任务）：|状态变化（按ID增量）：)/,''));}

test('registered ordinary plan carries the complete purpose, business window and confirmed no-replay evidence',()=>{
 const f=fixture(),original=structuredClone(f.stored),value=f.project();assertContract(value,f.stored);assert.deepEqual(f.stored,original);assert.notEqual(value.steps,f.stored.steps);value.steps[0].arguments.place='do-not-change-ledger';value.lastProgressProof.actions[0].args.place='do-not-change-proof';assert.deepEqual(f.stored,original);
});
test('normal buildTaskPrompt includes execution IDs and prior evidence without raw result text',()=>{
 const f=fixture(),text=buildTaskPrompt(f.engine,[],f.round);assert.ok(text.includes('synthetic-buy-book'));assert.ok(text.includes('synthetic-store-id'));assert.ok(text.includes('synthetic-go-receipt'));assert.ok(text.includes('"historical":true'));assert.ok(!text.includes('RAW_RESULT_MUST_STAY_IN_LEDGER'));
});
test('fresh window handoff preserves every validated action parameter and business window',()=>{
 const f=fixture();chooseWindow(f.engine,'synthetic-scope',{now:NOW,nonce:()=> 'fresh'});const body=packetBody(windowPrompt(f.engine,buildTaskPrompt(f.engine,[],f.round),{identity:{},round:f.round,now:NOW,visible:''}));assertContract(body.plans[f.stored.id],f.stored);assertContract(f.engine.l.contextWindow.packet.snapshot.plans[f.stored.id],f.stored);
});
test('incremental plan changes retain the new exact action and never mutate the previous packet',()=>{
 const f=fixture();chooseWindow(f.engine,'synthetic-scope',{now:NOW,nonce:()=> 'incremental'});const first=windowPrompt(f.engine,buildTaskPrompt(f.engine,[],f.round),{identity:{},round:f.round,now:NOW}),prior=structuredClone(f.engine.l.contextWindow.packet.snapshot);
 f.stored.expectedAction={tool:W+'go',arguments:{place:'home',by:'walk'},nextStep:'带书回家'};f.stored.nextStep='带书回家';f.stored.revision++;
 const body=packetBody(windowPrompt(f.engine,buildTaskPrompt(f.engine,[],f.round),{identity:{},round:f.round,now:NOW+1,visible:first}));assertContract(body.plans.updated[f.stored.id],f.stored);assert.equal(prior.plans[f.stored.id].expectedAction.arguments.id,'synthetic-buy-book');
});
test('restart and another fresh task handoff keep the ordinary purpose without resetting ledgers or window limits',()=>{
 const f=fixture();chooseWindow(f.engine,'synthetic-scope',{now:NOW,nonce:()=> 'restart'});windowPrompt(f.engine,buildTaskPrompt(f.engine,[],f.round),{identity:{},round:f.round,now:NOW});const restored=JSON.parse(JSON.stringify(f.data)),original=JSON.stringify(restored.life.plans),windows=JSON.stringify(restored.life.contextWindow.windows);
 const e=new LifeEngine({bridge:{data:restored,change:fn=>fn(restored)},identity:()=>({owner:'synthetic-owner',persona:'synthetic-fish'}),clock:()=>NOW+1000,settings:()=>({sharing:false,backgroundContextEnabled:true}),host:{cancel:async()=>{},idle:async()=>true}}),body=packetBody(windowPrompt(e,buildTaskPrompt(e,[],f.round),{identity:{},round:f.round,now:NOW+1000,visible:''}));assertContract(body.plans[f.stored.id],f.stored);assert.equal(JSON.stringify(restored.life.plans),original);assert.equal(JSON.stringify(restored.life.contextWindow.windows),windows);assert.equal(e.cfg.backgroundContextRounds,16);assert.equal(e.cfg.requestAdmissionEstimatedTokenLimit,64000);
});
test('all eight permitted steps keep full JSON arguments rather than truncating action meaning',()=>{
 const steps=Array.from({length:8},(_,i)=>({tool:'world_do',arguments:{id:'synthetic-action-'+i,text:'x'.repeat(7900)},nextStep:'合成步骤'+i})),f=fixture({steps});assert.equal(f.project().steps.length,8);assert.deepEqual(f.project().steps,f.stored.steps);assert.equal(f.project().steps[7].arguments.text.length,7900);
});
test('oversized legacy step arrays are explicit references, never a silently shortened executable chain',()=>{
 const f=fixture();f.stored.steps.push(...Array.from({length:6},(_,i)=>({tool:W+'do',arguments:{id:'legacy-'+i}})));const p=f.project();assert.equal(p.steps,undefined);assert.equal(p.executionOmitted.steps.count,9);assert.equal(p.executionOmitted.steps.limit,8);assert.deepEqual(p.executionOmitted.steps.reference,{kind:'plans',id:f.stored.id});assert.equal(f.stored.steps.length,9);
});
test('confirmed history is bounded and labelled, with exact actions and a reference for omitted entries',()=>{
 const f=fixture();f.stored.lastProgressProof.actions=Array.from({length:11},(_,i)=>({tool:W+'do',args:{id:'synthetic-done-'+i},finishedAt:NOW-i}));f.stored.lastProgressProof.receiptIds=Array.from({length:11},(_,i)=>'synthetic-receipt-'+i);const p=f.project().lastProgressProof;assert.equal(p.historical,true);assert.equal(p.noReplay,true);assert.equal(p.actions.length,8);assert.equal(p.actionCount,11);assert.equal(p.omittedActionCount,3);assert.deepEqual(p.actions,f.stored.lastProgressProof.actions.slice(-8));assert.equal(p.receiptIds.length,8);assert.equal(p.receiptCount,11);assert.deepEqual(p.historyReference,{kind:'plans',id:f.stored.id});assert.equal(f.stored.lastProgressProof.actions.length,11);
});
test('oversized legacy string parameters are referenced in full rather than leaking a partial action into context',()=>{
 const f=fixture(),raw=' '.repeat(12001)+'{"place":"synthetic-store-id"}';f.stored.steps[0].arguments=raw;f.stored.expectedAction.arguments=raw;f.stored.lastProgressProof.actions[0].args=raw;const p=f.project();assert.equal(p.steps,undefined);assert.equal(p.expectedAction,undefined);assert.equal(p.executionOmitted.steps.reason,'invalid-legacy-steps');assert.equal(p.executionOmitted.expectedAction.reason,'invalid-legacy-action');assert.equal(p.lastProgressProof.actions.length,0);assert.equal(p.lastProgressProof.omittedActionCount,1);assert.equal(f.stored.steps[0].arguments,raw);
});
