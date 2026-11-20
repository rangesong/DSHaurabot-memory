import test from 'node:test';
import assert from 'node:assert/strict';
import {workHoursAllowed} from '../extensions/aurabot/fish-world/work-hours.mjs';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';

const bj=s=>Date.parse(`2026-11-20T${s}:00+08:00`);
test('work hours support multiple and midnight ranges with precise boundaries',()=>{
  const hours='18:00-09:00,12:00-14:00';
  for(const t of ['00:00','08:59','12:00','13:59','18:00','23:59'])assert.equal(workHoursAllowed(hours,bj(t)),true,t);
  for(const t of ['09:00','11:59','14:00','17:59'])assert.equal(workHoursAllowed(hours,bj(t)),false,t);
  assert.equal(workHoursAllowed('',bj('10:00')),true);
  assert.equal(workHoursAllowed('00:00-00:00',bj('10:00')),true);
  for(const invalid of ['25:00-02:00','12:99-13:00','12:00-14:00,garbage','09:00','12:00-14:00,'])assert.equal(workHoursAllowed(invalid,bj('12:30')),false,invalid);
});
function makeWorld(hours,activityHours=''){
 const now=bj('10:00'),data={fishId:'synthetic',at:{state:now},state:{where:{kind:'place'},figure:{asleep:false}},life:newLife(now)};
 data.life.nextIdle=now-1;data.life.owner='1';data.life.persona='test';let starts=0;
 const bridge={data,identityReady:true,change(fn){return fn(data);}};
 const host={run:async()=>{starts++;},idle:async()=>true,cancel:async()=>{},remember:async()=>{},deliveryStatus:()=>null};
 const engine=new LifeEngine({bridge,host,settings:()=>({idleWorkHours:hours,activityWorkHours:activityHours,sharing:false}),clock:()=>now,identity:()=>({owner:'1',persona:'test'})});
 return {engine,data,get starts(){return starts;}};
}
test('world defers idle only, while owner events and due plans still run',async()=>{
 let x=makeWorld('18:00-09:00');await x.engine.tick();assert.equal(x.starts,0);
 x=makeWorld('18:00-09:00');x.data.life.queue.push({id:'owner1',kind:'owner',bucket:'work',priority:0,text:'synthetic',status:'pending',notBefore:0,t:1});await x.engine.tick();assert.equal(x.starts,1);
 x=makeWorld('18:00-09:00');x.data.life.plans.push({id:'p',status:'active',nextAt:bj('09:59'),goal:'synthetic'});await x.engine.tick();assert.equal(x.starts,1);
 x=makeWorld('');await x.engine.tick();assert.equal(x.starts,1);
});
test('world activity window retains events and plans but allows owner and recovery',async()=>{
 let x=makeWorld('','18:00-09:00');x.data.life.queue.push({id:'s',kind:'talk',bucket:'social',priority:2,text:'synthetic',status:'pending',notBefore:0,t:1});await x.engine.tick();assert.equal(x.starts,0);assert.equal(x.data.life.queue[0].status,'pending');
 x=makeWorld('','18:00-09:00');x.data.life.plans.push({id:'p',status:'active',nextAt:bj('09:59'),goal:'synthetic'});await x.engine.tick();assert.equal(x.starts,0);assert.equal(x.data.life.plans[0].status,'active');
 x=makeWorld('','18:00-09:00');x.data.life.queue.push({id:'o',kind:'owner',bucket:'work',priority:0,text:'synthetic',status:'pending',notBefore:0,t:1});await x.engine.tick();assert.equal(x.starts,1);
 x=makeWorld('','18:00-09:00');x.data.life.recovery=true;await x.engine.tick();assert.equal(x.starts,1);
});
