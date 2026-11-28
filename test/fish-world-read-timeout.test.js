import test from 'node:test';import assert from 'node:assert/strict';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {carryForward} from '../extensions/aurabot/fish-world/world-window.mjs';
const W='mcp__fish-world__world_';
function fixture(){
 const now=Date.parse('2026-11-28T12:16:00+08:00'),identity={owner:'synthetic-owner',persona:'synthetic'},agent={session:{id:'synthetic-owner-session'}};
 const data={version:3,fishId:'synthetic#1',state:{where:{kind:'place',place:{id:'shop'}}},at:{state:now},life:newLife(now)};Object.assign(data.life,identity);
 const bridge={data,identityReady:true,change(fn){return fn(data);}},cancels=[];
 const engine=new LifeEngine({bridge,host:{cancel:async id=>{cancels.push(id);},idle:async()=>true,ready:async()=>true},clock:()=>now,settings:()=>({sharing:false}),identity:()=>identity});
 const task=engine.ownerTurn('你出门打个工去',{sessionId:agent.session.id,turnToken:'synthetic-turn'});
 const fail=(name,args={})=>{const exec={name:W+name,arguments:args,callId:'synthetic-'+name,agent};assert.equal(engine.guard(exec,false,true),undefined);engine.result(exec,{isError:true,content:[{type:'text',text:'Error: Request timed out'}]});return data.life.journal.find(row=>row.id===exec.callId);};
 return {engine,data,task,agent,cancels,fail,identity,now};
}
test('read-only timeouts release the tool lock without turning an owner purpose into an unknown action',()=>{
 for(const [name,args] of [['now',{}],['profile',{}],['history',{limit:10}],['friends',{action:'list'}]]){
  const f=fixture(),before={phase:f.task.phase,revision:f.task.revision,steps:structuredClone(f.task.steps)};
  const row=f.fail(name,args);assert.equal(row.status,'failed',name);assert.equal(f.task.phase,before.phase,name);assert.equal(f.task.revision,before.revision,name);assert.deepEqual(f.task.steps,before.steps);assert.equal(f.engine.l.recovery,false);assert.equal(f.engine.l.externalPending,null);assert.equal(f.engine.lock,null);assert.deepEqual(f.cancels,[]);
  assert.equal(f.engine.guard({name:W+'do',arguments:{id:'work'},callId:'synthetic-next',agent:f.agent},false,true),undefined,name);
 }
});
test('submitted mutations with a timeout remain unknown despite a later successful read',()=>{
 const f=fixture(),row=f.fail('do',{id:'work'});assert.equal(row.status,'uncertain');assert.equal(f.task.phase,'uncertain');
 const read={name:W+'now',arguments:{},callId:'synthetic-later-now',agent:f.agent};assert.equal(f.engine.guard(read,false,true),undefined);f.engine.result(read,{content:[{type:'text',text:'synthetic current shop'}]});
 assert.match(f.engine.guard({name:W+'do',arguments:{id:'work'},callId:'synthetic-retry',agent:f.agent},false,true),/未确认/);assert.equal(f.task.phase,'uncertain');
});
test('a failed background refresh invalidates the old observation and intent until a successful fresh read',()=>{
 const f=fixture(),round=f.engine.l.round={id:'synthetic-round',sessionId:f.agent.session.id,status:'running',kind:'owner-task',ownerTaskId:f.task.id,revision:f.engine.l.revision,startedAt:f.now,calls:0,receipts:[],events:[],planIds:[],priority:0,identityConfirmed:true};
 const read=(id,isError=false)=>{const exec={name:W+'now',arguments:{},callId:id,agent:f.agent};assert.equal(f.engine.guard(exec,true,false),undefined);f.engine.result(exec,{isError,content:[{type:'text',text:isError?'Error: Request timed out':'Synthetic shop: work'}]});};
 const intent=()=>f.engine.intent({tool:'world_do',arguments:'{"id":"work"}',category:'work',cost:0,evidence:'work'}).arguments;
 read('synthetic-before');const approved=intent();assert.ok(round.observation);assert.ok(round.intent);
 read('synthetic-timeout',true);assert.equal(round.observation,'');assert.equal(round.observationId,undefined);assert.equal(round.intent,null);assert.equal(round.status,'running');assert.equal(f.task.phase,'pending');
 assert.match(f.engine.guard({name:W+'do',arguments:approved,callId:'synthetic-stale-action',agent:f.agent},true,false),/必须先真实观察/);
 read('synthetic-fresh');const args=intent(),exec={name:W+'do',arguments:args,callId:'synthetic-current-action',agent:f.agent};assert.equal(f.engine.guard(exec,true,false),undefined);f.engine.result(exec,{content:[{type:'text',text:'Synthetic work started'}]});assert.equal(f.task.phase,'working');assert.equal(f.engine.l.recovery,false);assert.equal(f.engine.l.journal.some(row=>row.id==='synthetic-stale-action'),false);
});
test('handoff distinguishes failed legacy reads from unconfirmed mutations without changing old journal records',()=>{
 const f=fixture();f.engine.l.journal.push({id:'synthetic-old-read',tool:W+'now',args:'{}',status:'uncertain'},{id:'synthetic-old-write',tool:W+'do',args:'{"id":"work"}',status:'uncertain'});
 const before=JSON.stringify(f.engine.l.journal),packet=carryForward(f.engine,f.identity,f.now);assert.deepEqual(packet.unconfirmed.map(x=>x.id),['synthetic-old-write']);assert.equal(JSON.stringify(f.engine.l.journal),before);
});
