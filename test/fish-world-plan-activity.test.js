import test from 'node:test';import assert from 'node:assert/strict';
import {planActivityGuard} from '../extensions/aurabot/fish-world/plan-activity.mjs';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
const now=Date.parse('2026-11-26T12:32:00+08:00'),W='mcp__fish-world__world_';
const trip={at:{state:now},state:{where:{kind:'trip',to:{id:'home'},arrive:'2026-11-26T13:41:00+08:00'},doing:null}};
test('a second ordinary plan cannot reverse a confirmed journey before arrival',()=>{
  const snapshot=JSON.stringify(trip);
  for(const kind of ['plan','idle'])assert.match(planActivityGuard(trip,{kind},W+'go',{place:'workplace'},now),/真实到达/);
  assert.equal(JSON.stringify(trip),snapshot);
  const arrived={...trip,state:{where:{kind:'home'},doing:null}};
  assert.equal(planActivityGuard(arrived,{kind:'plan'},W+'go',{place:'workplace'},now),undefined);
});
test('long activities need actual completion while in-shift items remain actionable',()=>{
  const data={at:{state:now},state:{where:{kind:'place'},doing:{name:'打零工',until:'12:20'}}};
  assert.match(planActivityGuard(data,{kind:'plan'},W+'go',{place:'home'},now),/真实结束/);
  assert.match(planActivityGuard(data,{kind:'plan'},W+'do',{id:'work'},now),/真实结束/);
  assert.equal(planActivityGuard(data,{kind:'plan'},W+'do',{id:'task-4'},now),undefined);
  data.state.doing={name:'喝茶',until:'12:20'};
  assert.match(planActivityGuard(data,{kind:'plan'},W+'do',{id:'work'},now),/真实结束/);
  data.state.doing=null;
  assert.equal(planActivityGuard(data,{kind:'plan'},W+'do',{id:'work'},now),undefined);
});
test('private owner actions, trusted event work, social actions and read-only checks retain their paths',()=>{
  for(const kind of ['owner-task','owner','work','health','doorbell','message','recovery'])assert.equal(planActivityGuard(trip,{kind},W+'go',{place:'new-owner-target'},now),undefined);
  for(const name of ['now','profile','history','find','say','friends','update'])assert.equal(planActivityGuard(trip,{kind:'plan'},W+name,{},now),undefined);
  assert.equal(planActivityGuard({...trip,at:{state:now-180001}},{kind:'plan'},W+'go',{},now),undefined);
});
test('the real engine rejects a conflicting background route before journaling or spending but permits private routes',()=>{
  const data={...structuredClone(trip),fishId:'fixture#1',life:newLife(now)};
  const bridge={data,change:fn=>fn(data)},engine=new LifeEngine({bridge,host:{},clock:()=>now});
  engine.l.round={id:'r',kind:'plan',sessionId:'bg',status:'running',revision:engine.l.revision,priority:3,calls:0,startedAt:now,receipts:[],observation:'fixture',identityConfirmed:true};
  const exec={name:W+'go',arguments:{place:'workplace'},agent:{session:{id:'bg'}},callId:'blocked-route'};
  assert.match(engine.guard(exec,true,false),/真实到达/);
  assert.equal(engine.l.journal.length,0);assert.deepEqual(engine.l.days,{});assert.equal(engine.l.round.calls,0);
  engine.l.round=null;
  engine.ownerTurn('你出门打工去',{sessionId:'private',turnToken:1});
  assert.equal(engine.guard({...exec,agent:{session:{id:'private'}},callId:'owner-route'},false,true),undefined);
  assert.equal(engine.l.journal.at(-1).id,'owner-route');
});
