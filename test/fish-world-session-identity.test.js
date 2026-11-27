import test from 'node:test';
import assert from 'node:assert/strict';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {registerJourney,rememberOwnerTurn,taskForExecution,defineOwnerTask} from '../extensions/aurabot/fish-world/owner-tasks.mjs';
import {sessionKey,sameSession,ownerTaskContext,setOwnerTaskContext} from '../extensions/aurabot/fish-world/session-identity.mjs';

const W='mcp__fish-world__world_',bare='11111111-2222-4333-8444-555555555555',native='session-'+bare,foreign='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',now=Date.parse('2026-11-27T18:00:00+08:00'),identity={owner:'synthetic-owner',persona:'synthetic-persona'};
const input={goal:'到合成商店买两份物品',destination:'fixture-shop',arrivalStep:'按现场真实选项购买物品'},step={tool:'world_do',arguments:'{"id":"fixture-item","count":2}',nextStep:'买两份物品'};
const fixture=()=>{const l={...newLife(now),...identity},data={life:l,at:{state:now},state:{where:{kind:'place',place:{id:input.destination,name:'合成商店'}}}};return {l,data};};
const register=(f,sid=bare)=>{const r=registerJourney(f.l,input,{sessionId:sid,identity,now,data:f.data});return f.l.ownerTasks.find(t=>t.id===r.task.id);};

test('a journey registered by the factory bare UUID remains visible to the same native-prefixed execution after a question',()=>{
 for(const [registered,executing]of [[bare,native],[native,bare]]){const f=fixture(),t=register(f,registered);rememberOwnerTurn(f.l,identity,{text:'东西买了吗？',sessionId:executing,turnKey:2},now+1);assert.equal(taskForExecution(f.l,{name:W+'now',arguments:{},agent:{session:{id:executing}}})?.id,t.id);assert.equal(t.journey.registeredSessionId,registered);}
});

test('private journey definition accepts only the two aliases of its own session',()=>{
 const f=fixture(),t=register(f);assert.throws(()=>defineOwnerTask(f.l,{id:t.id,expectedRevision:t.revision,steps:[step]},{sessionId:foreign,now}),/当前主人任务/);defineOwnerTask(f.l,{id:t.id,expectedRevision:t.revision,steps:[step]},{sessionId:native,now});assert.equal(t.finalAction.arguments.id,'fixture-item');assert.equal(t.source.sessionId,bare);
});

test('a background work-item definition recognizes native-prefixed now evidence when the tool factory carries its bare UUID',()=>{
 const f=fixture(),t=rememberOwnerTurn(f.l,identity,{text:'打工的地方有工作让你处理',sessionId:bare,turnKey:1,confirmedWorld:true},now);f.l.round={id:'synthetic-round',sessionId:native,status:'running',ownerTaskId:t.id};f.l.journal.push({id:'offered',tool:W+'now',status:'confirmed',isError:false,sessionId:native,round:f.l.round.id,at:now,finishedAt:now,result:'· task-17 合成班内事项'});
 assert.throws(()=>defineOwnerTask(f.l,{id:t.id,expectedRevision:t.revision,steps:[{tool:'world_do',arguments:'{"id":"task-17"}',nextStep:'处理事项'}]},{sessionId:foreign,background:true,taskId:t.id,now}),/当前主人任务/);
 defineOwnerTask(f.l,{id:t.id,expectedRevision:t.revision,steps:[{tool:'world_do',arguments:'{"id":"task-17"}',nextStep:'处理现场事项'}]},{sessionId:bare,background:true,taskId:t.id,now});assert.equal(t.finalAction.arguments.id,'task-17');
});

test('session keys normalize only one prefix and empty IDs never identify a session',()=>{
 assert.equal(sessionKey(native),bare);assert.equal(sessionKey(bare),bare);assert.equal(sameSession(native,bare),true);assert.equal(sameSession(bare,native),true);assert.equal(sameSession(bare,foreign),false);
 for(const value of ['',undefined,null,'session-',' ',123]){assert.equal(sessionKey(value),'');assert.equal(sameSession(value,value),false);}
 assert.equal(sameSession('session-'+native,bare),false);assert.equal(sameSession(foreign.toUpperCase(),foreign),false);
});

test('context reads the latest canonical alias and writes preserve old raw records without shared references',()=>{
 const l=newLife(now),old={key:'old',at:now,taskId:'old-task'},recent={key:'newer',at:now+1,taskId:null};l.ownerTaskContexts={[bare]:old,[native]:recent};assert.equal(ownerTaskContext(l,bare),recent);assert.equal(ownerTaskContext(l,native),recent);
 const kept=structuredClone(recent),written=setOwnerTaskContext(l,native,{...recent,at:now+2,key:'latest',taskId:'current-task'});assert.equal(ownerTaskContext(l,native),written);assert.deepEqual(l.ownerTaskContexts[native],kept);written.taskId=null;assert.deepEqual(l.ownerTaskContexts[native],kept,'old prefixed audit record is independent');
 l.ownerTaskContexts[native]={key:'tie-prefixed',at:now+2};assert.equal(ownerTaskContext(l,native),written,'ties prefer the future canonical record');const before=structuredClone(l);assert.equal(setOwnerTaskContext(l,'',{at:now}),undefined);assert.deepEqual(l,before);assert.equal(ownerTaskContext(l,''),undefined);
});

test('one prompt token across both aliases cannot duplicate a task or overwrite its original raw source',()=>{
 const f=fixture(),a=rememberOwnerTurn(f.l,identity,{text:'你出门打个工去',sessionId:native,turnKey:'same'},now);assert.equal(rememberOwnerTurn(f.l,identity,{text:'你出门打个工去',sessionId:bare,turnKey:'same'},now),null);assert.equal(f.l.ownerTasks.length,1);assert.equal(a.source.sessionId,native);assert.equal(ownerTaskContext(f.l,native).taskId,a.id);assert.ok(f.l.ownerTaskContexts[bare]);assert.equal(f.l.ownerTaskContexts[native],undefined,'future writes use only the canonical key');
});

test('observation evidence accepts aliases but never another session or a newer foreign record',()=>{
 for(const [registered,reading]of [[bare,native],[native,bare]]){const f=fixture(),r=registerJourney(f.l,{goal:'去合成商店看陈列',destination:input.destination,arrivalStep:'读取现场陈列说明',completionType:'observe'},{sessionId:registered,identity,now,data:f.data}),t=f.l.ownerTasks.find(x=>x.id===r.task.id);f.l.journal.push({id:'current-read',tool:W+'now',status:'confirmed',isError:false,sessionId:reading,at:now,finishedAt:now,result:'11-27 周五 18:00 · 晴 6°C\n你在：合成商店 · 货架\n身体：精神很好'});const args=()=>({id:t.id,expectedRevision:t.revision,action:'complete_observation',summary:'看到了合成陈列',evidenceIds:['current-read']});
  assert.throws(()=>defineOwnerTask(f.l,args(),{sessionId:foreign,now,data:f.data}),/当前主人任务/);f.l.journal.push({id:'foreign-read',tool:W+'now',status:'confirmed',sessionId:'session-'+foreign,at:now,finishedAt:now,result:'别处'});defineOwnerTask(f.l,args(),{sessionId:registered,now,data:f.data});assert.equal(t.status,'completed');assert.equal(t.journey.registeredSessionId,registered);assert.equal(f.l.journal[0].sessionId,reading);}
});

test('background registration and exact task matching accept aliases without crossing session or persona',()=>{
 const f=fixture();f.l.round={id:'round',status:'running',sessionId:native};const r=registerJourney(f.l,input,{sessionId:bare,identity,now,background:true,data:f.data});assert.equal(f.l.round.ownerTaskId,r.task.id);assert.equal(taskForExecution(f.l,{name:W+'now',agent:{session:{id:native}}}).id,r.task.id);assert.throws(()=>registerJourney(f.l,input,{sessionId:foreign,identity,now,background:true,data:f.data}),/后台会话/);
 f.l.persona='other-persona';assert.equal(taskForExecution(f.l,{name:W+'now',agent:{session:{id:native}}}),undefined);assert.throws(()=>defineOwnerTask(f.l,{id:r.task.id,expectedRevision:r.task.revision,steps:[step]},{sessionId:bare,background:true,taskId:r.task.id,now}),/当前主人任务/);
 const w=fixture(),t=rememberOwnerTurn(w.l,identity,{text:'打工的地方有工作让你处理',sessionId:bare,turnKey:1,confirmedWorld:true},now);w.l.round={id:'work-round',sessionId:native,status:'running',ownerTaskId:t.id};w.l.journal.push({id:'real-work',tool:W+'now',status:'confirmed',sessionId:bare,round:'work-round',at:now,finishedAt:now,result:'· task-17 真实事项'});defineOwnerTask(w.l,{id:t.id,expectedRevision:t.revision,steps:[{tool:'world_do',arguments:'{"id":"task-17"}',nextStep:'处理真实事项'}]},{sessionId:native,background:true,taskId:t.id,now});w.l.round.ownerTaskId=null;assert.equal(taskForExecution(w.l,{name:W+'do',arguments:{id:'task-17'},agent:{session:{id:bare}}}).id,t.id);assert.equal(taskForExecution(w.l,{name:W+'do',arguments:{id:'task-18'},agent:{session:{id:bare}}}),undefined);assert.equal(taskForExecution(w.l,{name:W+'do',arguments:{id:'task-17'},agent:{session:{id:foreign}}}),undefined);
});
