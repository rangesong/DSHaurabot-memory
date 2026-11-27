import test from 'node:test';
import assert from 'node:assert/strict';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {preparePlanChanges,applyPlanChanges,finishPlanCheck,advancePlans} from '../extensions/aurabot/fish-world/plans.mjs';
import {proofOfPlanProgress} from '../extensions/aurabot/fish-world/plan-progress.mjs';
const now=Date.parse('2026-11-27T09:00:00+08:00'),W='mcp__fish-world__world_';
function fixture(){const l={...newLife(now),owner:'synthetic-owner',persona:'synthetic-persona'},data={fishId:'合成本鱼#1',state:{where:{kind:'home'},doing:null},at:{state:now},life:l},round={id:'synthetic-round',sessionId:'synthetic-session',startedAt:now,kind:'plan',events:[],receipts:[]};return {l,data,round};}
const base={goal:'到合成超市采购早餐食材',reason:'合成约定',nextStep:'抵达后选购食材，不只停留在店门口',status:'pending',nextAt:now};
function create(f,fields={}){const changes=preparePlanChanges(f.l,{planChanges:[{op:'create',plan:{...base,...fields}}]},{round:f.round,now,fishId:f.data.fishId});applyPlanChanges(f.l,changes,{now,roundId:f.round.id});const p=f.l.plans[0];f.round.planId=p.id;f.round.planIds=[p.id];return p;}
function confirm(f,tool,args){const row={id:'actual-success',tool:W+tool,args:JSON.stringify(args),round:f.round.id,sessionId:f.round.sessionId,status:'confirmed',isError:false,at:now+1000,finishedAt:now+2000,result:'合成已确认回执'};f.l.journal.push(row);f.round.receipts.push({id:row.id,tool:row.tool,text:row.result,isError:false});return row;}

test('normal tool create/apply retains a Chinese destination and attributes its actual go receipt',()=>{
 const f=fixture(),p=create(f,{destination:{id:'synthetic_market',name:'合成青禾超市'}});assert.deepEqual(p.destination,{id:'synthetic_market',name:'合成青禾超市'});confirm(f,'go',{place:'synthetic_market',by:'bike'});
 assert.equal(proofOfPlanProgress(f.l,f.data,f.round,p,{now:now+3000}).progressed,true);
 f.data.state.where={kind:'trip',to:{id:'synthetic_market'}};f.data.at.state=now+3000;finishPlanCheck(f.l,f.data,f.round,{now:now+3000});assert.equal(p.status,'waiting_event');assert.equal(p.waitCondition.when,'idle');
 advancePlans(f.l,f.data,now+3000);assert.equal(p.status,'waiting_event');
 f.data.state.where={kind:'place',place:{id:'synthetic_market'}};f.data.at.state=now+240000;advancePlans(f.l,f.data,now+240000);
 assert.equal(p.status,'pending');assert.equal(p.goal,base.goal);assert.equal(p.nextStep,base.nextStep);assert.notEqual(p.status,'completed','arrival is not the purchase purpose completion');
});
test('explicit steps and expectedAction survive normal registration and link only matching successful args',()=>{
 for(const key of ['steps','expectedAction']){
  const f=fixture(),step={tool:'world_do',arguments:'{"id":"synthetic_action","count":2}',nextStep:'合成后续'},p=create(f,{goal:'照合成约定完成这一步',nextStep:'完成后继续原目的',[key]:key==='steps'?[step]:step});
  const stored=key==='steps'?p.steps[0]:p.expectedAction;assert.equal(stored.tool,W+'do');assert.deepEqual(stored.arguments,{id:'synthetic_action',count:2});
  confirm(f,'do',{id:'synthetic_action',count:1});assert.equal(proofOfPlanProgress(f.l,f.data,f.round,p,{now:now+3000}).progressed,false);
  f.l.journal[0].args=JSON.stringify({id:'synthetic_action',count:2});assert.equal(proofOfPlanProgress(f.l,f.data,f.round,p,{now:now+3000}).reason,'confirmed-related-step');
 }
});
test('args aliases normalize to finite JSON arguments without executing or adding any world action',()=>{
 const f=fixture(),p=create(f,{steps:[{tool:W+'go',args:{place:'synthetic_market'}}]});assert.deepEqual(p.steps,[{tool:W+'go',arguments:{place:'synthetic_market'}}]);assert.deepEqual(f.l.journal,[]);assert.deepEqual(f.l.outbox,[]);
});
test('malformed destinations or steps reject the whole preparation without changing existing plans',()=>{
 const f=fixture();create(f);const before=JSON.stringify(f.l);
 const invalid=[{destination:'somewhere'},{destination:{name:'missing id'}},{destination:{id:'x',extra:true}},{destination:{id:'x',name:'x'.repeat(161)}},{steps:Array.from({length:9},()=>({tool:'world_go',arguments:{place:'x'}}))},{steps:[{tool:'world_now',arguments:{anything:true}}]},{steps:[{tool:'run_code',arguments:{code:'x'}}]},{expectedAction:{tool:'world_go',arguments:{}}},{expectedAction:{tool:'world_friends',arguments:{action:'list'}}},{expectedAction:{tool:'world_friends',arguments:{action:'request'}}},{expectedAction:{tool:'world_update',arguments:{request_id:'synthetic-only'}}},{expectedAction:{tool:'world_do',arguments:'not json'}},{expectedAction:{tool:'world_go',arguments:{place:'x'},args:{place:'y'}}}];
 for(const fields of invalid){assert.throws(()=>preparePlanChanges(f.l,{planChanges:[{op:'create',plan:{...base,goal:'其它合成事项',...fields}}]},{round:f.round,now,fishId:f.data.fishId}));assert.equal(JSON.stringify(f.l),before);}
});
test('non-JSON, cyclic, prototype and oversized arguments are rejected rather than truncated',()=>{
 const circular={id:'x'};circular.self=circular;
 const invalid=[{id:'x',count:NaN},{id:'x',count:Infinity},{id:'x',missing:undefined},{id:'x',fn:()=>{}},circular,JSON.parse('{"id":"x","__proto__":{"polluted":true}}'),{id:'x',text:'x'.repeat(9000)}];
 for(const args of invalid){const f=fixture();assert.throws(()=>create(f,{expectedAction:{tool:'world_do',arguments:args}}));assert.equal(f.l.plans.length,0);}
 assert.equal({}.polluted,undefined);
});
test('duplicate registration keeps the same normalized action; conflicting purposes require explicit update',()=>{
 const f=fixture(),p=create(f,{destination:{id:'synthetic_market',name:'合成超市'},expectedAction:{tool:'world_go',arguments:{place:'synthetic_market',by:'bike'}}});
 const duplicate=preparePlanChanges(f.l,{planChanges:[{op:'create',plan:{...base,destination:{id:'synthetic_market',name:'合成超市'},expectedAction:{tool:W+'go',arguments:{by:'bike',place:'synthetic_market'}}}}]},{round:f.round,now,fishId:f.data.fishId});applyPlanChanges(f.l,duplicate,{now});assert.equal(f.l.plans.length,1);
 const before=JSON.stringify(f.l.plans);assert.throws(()=>preparePlanChanges(f.l,{planChanges:[{op:'create',plan:{...base,destination:{id:'different'}}}]},{round:f.round,now,fishId:f.data.fishId}),/已有 ID/);assert.equal(JSON.stringify(f.l.plans),before);
 const update=preparePlanChanges(f.l,{planChanges:[{op:'update',id:p.id,expectedRevision:f.l.plans[0].revision,patch:{destination:{id:'different',name:'合成替代目的地'}}}]},{round:f.round,now,fishId:f.data.fishId});applyPlanChanges(f.l,update,{now});assert.equal(f.l.plans[0].destination.id,'different');
});
test('the commit boundary revalidates finite execution fields and stays atomic across the batch',()=>{
 const f=fixture(),p=create(f),before=JSON.stringify(f.l.plans);
 const changes=[{op:'update',id:p.id,expectedRevision:p.revision,patch:{destination:{id:'valid'}}},{op:'create',id:'invalid-direct',plan:{...base,id:'invalid-direct',logicalKey:'different',revision:1,steps:[{tool:'world_do',arguments:{id:'x',bad:NaN}}]}}];
 assert.throws(()=>applyPlanChanges(f.l,changes,{now}));assert.equal(JSON.stringify(f.l.plans),before);
});
test('explicit field clearing does not revive terminal plans or change unrelated legacy records',()=>{
 const f=fixture(),p=create(f,{destination:{id:'synthetic_market'},steps:[{tool:'world_go',arguments:{place:'synthetic_market'}}],expectedAction:{tool:'world_go',arguments:{place:'synthetic_market'}}});
 const updates=preparePlanChanges(f.l,{planChanges:[{op:'update',id:p.id,expectedRevision:p.revision,patch:{destination:null,steps:[],expectedAction:null}}]},{round:f.round,now,fishId:f.data.fishId});applyPlanChanges(f.l,updates,{now});assert.equal(f.l.plans[0].destination,null);assert.deepEqual(f.l.plans[0].steps,[]);assert.equal(f.l.plans[0].expectedAction,null);
 f.l.plans[0].status='completed';assert.throws(()=>preparePlanChanges(f.l,{planChanges:[{op:'update',id:p.id,expectedRevision:f.l.plans[0].revision,patch:{destination:{id:'new'}}}]},{round:f.round,now,fishId:f.data.fishId}),/终态/);
});
