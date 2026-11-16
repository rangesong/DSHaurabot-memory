import test from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceWindow } from '../core/v5-maintenance.js';
import { V5Runtime } from '../core/v5-runtime.js';
import { AtlasPlayback,atlasForeground,atlasPanelMessage,bindAtlasActivity } from '../apps/memory-sea/src/v5-playback.js';
import { V5Scene } from '../apps/memory-sea/src/v5-scene.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const time=value=>Date.parse(`2026-11-14T${value}+08:00`);

test('actual atlas frames draw in focused DSH without iframe focus and stop in the background',()=>{
  const savedRAF=globalThis.requestAnimationFrame,savedCancel=globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};
  try{
    const host={document:{hidden:false,hasFocus:()=>true}};host.parent=host;
    const child={hidden:false,hasFocus:()=>false,defaultView:{parent:host}};let draws=0;
    const scene=Object.assign(Object.create(V5Scene.prototype),{running:true,isForeground:()=>atlasForeground(child),camera:{tick(){}},canvas:{dataset:{}},graph:{},draw(){draws++;},queueCharacter(){}});
    scene.renderFrame(100);assert.equal(draws,1);assert.ok(scene.canvas.dataset.firstFrameAt);
    host.document.hidden=true;scene.renderFrame(200);assert.equal(draws,1);assert.equal(scene.running,false);
  }finally{if(savedRAF===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=savedRAF;if(savedCancel===undefined)delete globalThis.cancelAnimationFrame;else globalThis.cancelAnimationFrame=savedCancel;}
});

test('hidden character preload is queued after the first atlas frame and paused with the atlas',()=>{
  const savedRAF=globalThis.requestAnimationFrame,savedCancel=globalThis.cancelAnimationFrame,queued=new Map();let next=0,loads=0;
  globalThis.requestAnimationFrame=fn=>{queued.set(++next,fn);return next;};globalThis.cancelAnimationFrame=id=>queued.delete(id);
  try{
    const scene=Object.assign(Object.create(V5Scene.prototype),{running:true,showWire:false,isForeground:()=>true,canvas:{dataset:{}},loadCharacter(){loads++;}});
    scene.queueCharacter();assert.equal(loads,0);assert.equal(queued.size,1);
    scene.setRunning(false);assert.equal(queued.size,0);assert.equal(loads,0);
    scene.running=true;scene.queueCharacter();[...queued.values()][0]();assert.equal(loads,1);
  }finally{if(savedRAF===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=savedRAF;if(savedCancel===undefined)delete globalThis.cancelAnimationFrame;else globalThis.cancelAnimationFrame=savedCancel;}
});

test('new scene hides the model and ordinary camera actions never reveal a ready preload',()=>{
  const saved=new Map(['document','window','ResizeObserver'].map(key=>[key,globalThis[key]])),label={textContent:''};
  globalThis.document={getElementById:()=>label,querySelector:()=>null};
  globalThis.window={matchMedia:()=>({matches:false}),addEventListener(){}};
  globalThis.ResizeObserver=class{observe(){}disconnect(){}};
  try{
    const scene=new V5Scene({dataset:{},getContext:()=>({}),addEventListener(){}},{foreground:()=>true});
    const layer={hidden:true};scene.glb={renderer:{domElement:layer},invalidate(){},dispose(){}};
    scene.updateCharacterStatus({state:'ready',message:'琉璃轮廓'});
    assert.equal(scene.showWire,false);assert.equal(scene.brainOnly,true);assert.match(label.textContent,/已预载/);
    scene.reset();scene.focusRegion('HEAD');scene.focusMemory('missing');assert.equal(scene.showWire,false);assert.equal(layer.hidden,true);
    scene.setModelVisible(true);assert.equal(scene.showWire,true);assert.equal(scene.brainOnly,false);assert.equal(label.textContent,'琉璃轮廓');
    scene.setBrainOnly(true);assert.equal(scene.showWire,false);assert.equal(layer.hidden,true);
    scene.setBrainOnly(false);assert.equal(scene.showWire,true);scene.dispose();
  }finally{for(const [key,value]of saved)if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});

test('retained iframe visibility accepts only its own same-origin parent and a boolean state',()=>{
  const parent={},win={parent,location:{origin:'dsh-app://app'}},message={source:parent,origin:win.location.origin,data:{type:'thinkstar-atlas-visibility',visible:false}};
  assert.equal(atlasPanelMessage(message,win),false);
  assert.equal(atlasPanelMessage({...message,data:{...message.data,visible:true}},win),true);
  assert.equal(atlasPanelMessage({...message,source:{}},win),undefined);
  assert.equal(atlasPanelMessage({...message,origin:'https://elsewhere.invalid'},win),undefined);
  assert.equal(atlasPanelMessage({...message,data:{...message.data,visible:'false'}},win),undefined);
});
test('night window uses Beijing time with exact boundaries and overnight settings',()=>{
  const config={maintenance_start_hour:1,maintenance_hours:5};
  for(const value of ['00:59:59','06:00:00','18:00:00'])assert.equal(maintenanceWindow(time(value),config).allowed,false);
  for(const value of ['01:00:00','05:59:59'])assert.equal(maintenanceWindow(time(value),config).allowed,true);
  assert.equal(maintenanceWindow(time('00:59:59'),config).next_start,time('01:00:00'));
  assert.equal(maintenanceWindow(time('00:30:00'),{maintenance_start_hour:23,maintenance_hours:3}).allowed,true);
});

test('daytime skips heavy maintenance while known due intentions still trigger and raw stays readable',async t=>{
  let now=time('12:00:00');const r=new V5Runtime({clock:()=>now});t.after(()=>r.close());
  const receipt=r.ingest({text:'承诺：完成这个合成任务。',process:true}),intent=r.store.all(receipt.scope).find(m=>m.kind==='intent');
  intent.attributes.due_at=now-1000;r.store.putMemory(intent,null,{history:false});
  r.retentionPlan=()=>{throw new Error('daytime retention scan');};r.archive.index=()=>{throw new Error('daytime archive scan');};
  assert.equal(r.maintenance().deferred,true);assert.equal((await r.archive.maintain()).deferred,true);
  assert.equal(r.memory(intent.id).attributes.trigger_status,'due');assert.match(r.body(r.memory(receipt.memory_id)),/合成任务/);
  assert.ok(r.query({scope:receipt.scope,query:'合成任务'}).context.length>0);
});

test('scheduled maintenance resumes within the night window',async t=>{
  const r=new V5Runtime({clock:()=>time('01:00:00')});t.after(()=>r.close());
  assert.equal(r.maintenance().deferred,undefined);assert.deepEqual(await r.archive.maintain(),{processed:0});
});

test('background animation is stopped and resumes only after the latest successful refresh',async()=>{
  let resolveFirst,starts=0,stops=0;const pending=new Promise(resolve=>{resolveFirst=resolve;});
  let calls=0;const playback=new AtlasPlayback({refresh:()=>++calls===1?pending:Promise.resolve(true),start:()=>starts++,stop:()=>stops++});
  const first=playback.update(true);await playback.update(false);resolveFirst(true);await first;assert.equal(starts,0);
  await playback.update(true);assert.equal(starts,1);assert.equal(stops,3);
  const failed=new AtlasPlayback({refresh:async()=>false,start:()=>{throw new Error('stale animation resumed');},stop:()=>{}});await failed.update(true);
  assert.equal(atlasForeground({hidden:true,hasFocus:()=>true}),false);
  assert.equal(atlasForeground({hidden:false,hasFocus:()=>false}),false);
  assert.equal(atlasForeground({hidden:false,hasFocus:()=>true}),true);
  const parentDocument={hidden:false,hasFocus:()=>true},host={document:parentDocument};host.parent=host;
  const child={parent:host};
  assert.equal(atlasForeground({hidden:false,hasFocus:()=>false,defaultView:child}),true,'a visible embedded atlas follows the focused DSH window');
  parentDocument.hidden=true;assert.equal(atlasForeground({hidden:false,hasFocus:()=>true,defaultView:child}),false);
});

test('iframe focus transfer keeps drawing, coalesces refreshes and recovers an omitted host focus event',async()=>{
  const surface=()=>{const handlers=new Map();return {handlers,addEventListener(type,fn){if(!handlers.has(type))handlers.set(type,new Set());handlers.get(type).add(fn);},removeEventListener(type,fn){handlers.get(type)?.delete(fn);},emit(type,event={}){for(const fn of [...handlers.get(type)??[]])fn(event);}};};
  let hostFocused=true,childFocused=false,running=false,reads=0,next=0;const timers=new Map(),intervals=new Map();
  const host=surface();host.parent=host;host.document={hidden:false,hasFocus:()=>hostFocused};
  const win=Object.assign(surface(),{parent:host,setTimeout(fn){timers.set(++next,fn);return next;},clearTimeout(id){timers.delete(id);},setInterval(fn){intervals.set(++next,fn);return next;},clearInterval(id){intervals.delete(id);}});
  const doc=Object.assign(surface(),{hidden:false,defaultView:win,hasFocus:()=>childFocused});
  const playback=new AtlasPlayback({refresh:async()=>{reads++;return true;},start:()=>{running=true;},stop:()=>{running=false;}});
  const activity=bindAtlasActivity({win,doc,playback});await playback.pending;assert.equal(running,true);assert.equal(reads,1);
  // Some embedded hosts emit blur while focusing their child document.
  hostFocused=false;host.emit('blur');childFocused=true;win.emit('focus');
  for(const fn of [...timers.values()])fn();timers.clear();await playback.pending;
  assert.equal(running,true);assert.equal(reads,1,'moving into the atlas must not stop for a new snapshot');
  running=false;for(const fn of intervals.values())fn();assert.equal(running,true,'a transient foreground frame pause heals without another request');
  hostFocused=false;childFocused=false;win.emit('blur');for(const fn of [...timers.values()])fn();timers.clear();assert.equal(running,false);
  // Return to the host even if it does not dispatch a new focus event.
  hostFocused=true;for(const fn of intervals.values())fn();const read=playback.pending;for(const fn of intervals.values())fn();assert.equal(playback.pending,read);await read;
  assert.equal(running,true);assert.equal(reads,2,'a real return reads one fresh snapshot');
  doc.hidden=true;doc.emit('visibilitychange');assert.equal(running,false);
  win.emit('pagehide',{persisted:false});assert.equal(intervals.size,0);assert.equal(timers.size,0);assert.ok([...host.handlers.values()].every(set=>set.size===0));activity.dispose();
});

test('failed foreground refresh waits for explicit retry without polling the database',async()=>{
  let reads=0;const playback=new AtlasPlayback({refresh:async()=>++reads>1,start(){},stop(){}});
  await playback.update(true);assert.equal(playback.ready,false);
  for(let i=0;i<5;i++)await playback.update(true);assert.equal(reads,1);
  await playback.update(true,{retry:true});assert.equal(reads,2);assert.equal(playback.ready,true);
});

test('a temporary snapshot read failure preserves the loaded atlas and cannot cover its controls',async()=>{
  const source=readFileSync(new URL('../apps/memory-sea/src/v5-main.js',import.meta.url),'utf8'),refreshSource=source.slice(source.indexOf('async function refresh('),source.indexOf('async function loadRecentHistory('));
  for(const cached of [true,false]){
    const nodes=new Map(),notices=[],s={graph:cached?{nodes:[{id:'existing'}]}:null},graph=s.graph;
    const $=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,dataset:{},textContent:'',querySelector:()=>$('error-title')});return nodes.get(id);};
    const refresh=vm.runInNewContext(refreshSource+';refresh',{generation:0,s,$,toast:message=>notices.push(message),api:async()=>{throw Error('Failed to fetch');}});
    assert.equal(await refresh(),cached);assert.equal(s.graph,graph);assert.equal($('error-state').hidden,cached);
    assert.equal($('sea-canvas').dataset.snapshotState,'stale');
    if(cached){assert.match(notices[0],/上次快照/);await refresh();assert.equal(notices.length,1,'one outage does not spam a toast at each refresh');}
    else{assert.match($('error-title').textContent,/暂时无法读取/);assert.doesNotMatch($('error-message').textContent,/Ctrl\+C|旧版本/);}
  }
});
