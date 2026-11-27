import test from 'node:test';
import assert from 'node:assert/strict';
import * as host from '../extensions/aurabot/fish-world/host-runtime.mjs';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import fs from 'node:fs';
import path from 'node:path';
import module from '../extensions/aurabot/fish-world/index.mjs';
function fixture(cancel){
 const at=Date.parse('2026-11-27T22:00:00+08:00'),order=[],data={fishId:'synthetic#1',at:{state:at},state:{},life:newLife(at)};
 data.life.round={id:'synthetic-round',sessionId:'synthetic-session',status:'running'};
 const bridge={data,active:true,change(fn){fn(data);order.push('save:'+data.life.round.status);},dispose(){this.active=false;order.push('bridge-closed');}};
 const engine=new LifeEngine({bridge,clock:()=>at,identity:()=>({owner:'synthetic',persona:'synthetic'}),host:{cancel:sid=>{assert.equal(sid,'synthetic-session');order.push('cancel');return cancel?.();}}});
 order.length=0;let guards=2;const offs=[()=>{order.push('release-first');guards--;},()=>{order.push('release-second');guards--;}];
 return {order,bridge,engine,offs,get guards(){return guards;}};
}
test('a rejected cancellation cannot retain any old guard or an active bridge',async()=>{
 const error=Error('synthetic cancel rejected'),f=fixture(()=>Promise.reject(error));
 const pending=host.disposeHostRuntime(f.offs,f.engine,f.bridge);
 assert.equal(f.guards,0);assert.equal(f.bridge.active,false);assert.equal(f.engine.closed,true);assert.equal(f.engine.l.round.status,'stopping');assert.equal(f.engine.l.recovery,true);
 assert.deepEqual(f.order,['release-second','release-first','save:stopping','cancel','bridge-closed']);await assert.rejects(pending,error);
});
test('a hanging cancellation leaves no guard or bridge and does not delay the stop write',async()=>{
 let finish;const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=host.disposeHostRuntime(f.offs,f.engine,f.bridge);let settled=false;pending.then(()=>{settled=true;});await Promise.resolve();
 assert.equal(settled,false);assert.equal(f.guards,0);assert.equal(f.bridge.active,false);assert.equal(f.engine.closed,true);assert.equal(f.engine.l.round.status,'stopping');
 assert.ok(f.order.indexOf('save:stopping')<f.order.indexOf('bridge-closed'));finish();await pending;
});
test('one release exception cannot skip any other release, normal stop, or bridge close',async()=>{
 const f=fixture();f.offs.splice(1,0,()=>{f.order.push('release-throws');throw Error('synthetic release failure');});
 await host.disposeHostRuntime(f.offs,f.engine,f.bridge);
 assert.equal(f.guards,0);assert.equal(f.bridge.active,false);assert.equal(f.offs.length,0);
 assert.deepEqual(f.order,['release-second','release-throws','release-first','save:stopping','cancel','bridge-closed']);
});
test('even a synchronous engine stop exception closes the bridge after all hooks are released',()=>{
 const order=[],error=Error('synthetic stop write failed'),offs=[()=>order.push('release')];
 assert.throws(()=>host.disposeHostRuntime(offs,{dispose(){order.push('engine');throw error;}},{dispose(){order.push('bridge');}}),error);
 assert.deepEqual(order,['release','engine','bridge']);
});
test('an unloaded real module guard is inert even when its official release throws',async()=>{
 const folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'dispose-module-')),guards=[],disposers=[];let releases=0;
 const tools={guard:fn=>{guards.push(fn);return()=>{releases++;throw Error('synthetic release failure');};},schemas:()=>[]};
 const api={config:()=>({enabled:true,ownerQQ:'synthetic-owner',persona:{current:'synthetic'}}),settings:()=>({}),dataDir:(...parts)=>path.join(folder,...parts),
  dsh:{get:name=>name==='tools'?tools:name==='agents'?{list:()=>[]}:null,on:()=>()=>{}},core:{hub:{chatOfSession:()=> 'system:ext-fish-world:new-synthetic-window',turnSendersAllOwner:()=>true}},
  log:{warn(){},info(){}},use:()=>null,on(){},context(){},tool(){},rule(){},command(){},route(){},every(){},later(){},onDispose:fn=>disposers.push(fn),defineTool:v=>v};
 await module.setup(api);assert.equal(guards.length,2);
 const exec={name:'mcp__fish-world__world_now',arguments:{},agent:{session:{id:'new-synthetic-session'}}};
 assert.equal(guards[1](exec),'后台尚未完成工具能力校验');
 for(const dispose of disposers)await dispose();assert.equal(releases,2);
 assert.deepEqual(guards.map(guard=>guard(exec)),[undefined,undefined]);
});
