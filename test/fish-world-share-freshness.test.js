import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import fishModule from '../extensions/aurabot/fish-world/index.mjs';

const start=Date.parse('2026-11-23T10:00:00+08:00'),ttl=30*60000;
const identity={owner:'synthetic-owner',persona:'synthetic-persona'};
const item=(id,state='pending',extra={})=>({id,state,at:start,importance:'important',text:'合成生活原文 '+id,owner:identity.owner,persona:identity.persona,...extra});
function fixture({outbox=[],initialized=true,sharing=true}={}){
  let now=start,engine;
  const sent=[],queried=[],settings={sharing,autonomy:false};
  const data={fishId:'synthetic-fish',at:{state:now},state:{stage:'alive'},now:'合成现场',life:{...newLife(now),...identity,outbox}};
  if(initialized)data.life.sharingPolicy={version:1,sharing,initializedAt:now,changedAt:now};
  const bridge={data,identityReady:true,change:fn=>fn(data)};
  const host={send:async o=>{sent.push(o.id);return {message_id:'receipt-'+o.id};},deliveryStatus:async id=>{queried.push(id);return {state:'sent'};},remember:async()=>({ok:true})};
  const load=()=>{engine=new LifeEngine({bridge,host,settings:()=>settings,clock:()=>now,identity:()=>identity});};
  load();
  return {get engine(){return engine;},data,host,sent,queried,settings,time(value){now=value;data.at.state=value;},reload(){data.life=JSON.parse(JSON.stringify(data.life));load();}};
}
function complete(f,id,importance='important'){
  const receipt='evidence-'+id,eventId='notification-'+id,now=f.data.at.state;
  f.engine.l.queue.push({id:eventId,kind:'done',t:now,text:'合成生活事项完成',status:'running',lastRoundId:id,provenance:{trusted:true,source:'world-notify'}});
  f.engine.l.round={id,sessionId:'synthetic-session-'+id,status:'running',kind:'idle',readOnly:false,events:[eventId],planIds:[],startedAt:now,bucket:'idle',observation:'合成成功现场',receipts:[{id:receipt,tool:'mcp__fish-world__world_now',text:'合成成功现场',isError:false}]};
  f.engine.finish({events:[{id:eventId,status:'completed'}],planChanges:[],importance,summary:'合成本地总结 '+id,facts:[receipt],share:'合成生活原文 '+id});
  f.engine.end(true);
  return f.engine.l.outbox.find(o=>o.id===id);
}

test('first upgrade archives all old unsubmitted shares once and keeps original receipts and submitted states',async()=>{
  const states=['pending','deferred','failed','queued','uncertain','sent'];
  const rows=states.map(state=>item('old-'+state,state,{reason:'原原因 '+state,receipt:'old-receipt-'+state,receipts:['old-receipt-'+state],deliveryId:'original-'+state,attempts:2}));
  const quota=item('old-quota','pending',{noticeOnly:true,facts:['budget-work']});
  const f=fixture({initialized:false,outbox:[...rows,quota]});
  assert.equal(f.engine.l.sharingPolicy.sharing,true);
  for(const [index,state]of states.entries()){
    const o=rows[index];assert.equal(o.state,index<3?'suppressed':state);
    if(index<3)assert.deepEqual(o.suppressedFrom,{state,reason:'原原因 '+state});
    assert.equal(o.receipt,'old-receipt-'+state);assert.deepEqual(o.receipts,['old-receipt-'+state]);
    assert.equal(o.deliveryId,'original-'+state);assert.equal(o.attempts,2);
  }
  assert.equal(quota.state,'pending');
  await f.engine.deliver();assert.deepEqual(f.sent,[]);assert.deepEqual(f.queried,['original-queued']);
  const fresh=complete(f,'new-after-upgrade');assert.equal(fresh.state,'pending');
  await f.engine.deliver();assert.deepEqual(f.sent,['new-after-upgrade']);
});

test('control closing archives current backlog and shares generated while closed never replay on reopening',async()=>{
  const backlog=['pending','deferred','failed'].map(state=>item('before-close-'+state,state));
  const f=fixture({outbox:backlog});f.engine.control('pauseShare');
  assert.ok(backlog.every(o=>o.state==='suppressed'));
  const off=complete(f,'created-while-off','urgent');
  assert.equal(off.state,'suppressed');assert.equal(off.text,'合成生活原文 created-while-off');assert.deepEqual(off.facts,['evidence-created-while-off']);
  assert.equal(complete(f,'routine-while-off','routine').state,'suppressed');
  f.reload();assert.equal(f.engine.l.sharingPolicy.sharing,false);
  f.engine.control('share');await f.engine.deliver();assert.deepEqual(f.sent,[]);
  const fresh=complete(f,'created-after-reopen');assert.equal(fresh.state,'pending');
  await f.engine.deliver();assert.deepEqual(f.sent,['created-after-reopen']);
});

test('settings changes are reconciled before end appends the first newly enabled share',async()=>{
  const f=fixture({outbox:[item('before-settings-change')]});
  f.settings.sharing=false;
  const off=complete(f,'settings-off');assert.equal(off.state,'suppressed');
  assert.equal(f.engine.l.outbox[0].state,'suppressed');assert.equal(f.engine.l.sharingPolicy.sharing,false);
  f.settings.sharing=true;
  const fresh=complete(f,'first-settings-on');assert.equal(fresh.state,'pending');
  assert.equal(f.engine.l.sharingPolicy.sharing,true);
  await f.engine.deliver();assert.deepEqual(f.sent,['first-settings-on']);
});

test('tick and direct delivery reconcile settings toggles without reviving deferred backlog',async()=>{
  const f=fixture({outbox:[item('settings-backlog','deferred')]});
  f.settings.sharing=false;await f.engine.tick();
  assert.equal(f.engine.l.sharingPolicy.sharing,false);assert.equal(f.engine.l.outbox[0].state,'suppressed');
  f.settings.sharing=true;await f.engine.deliver();assert.deepEqual(f.sent,[]);
  assert.equal(f.engine.l.sharingPolicy.sharing,true);
  complete(f,'fresh-after-settings-sync');await f.engine.deliver();assert.deepEqual(f.sent,['fresh-after-settings-sync']);
});

test('reload preserves a fresh pending share when the persisted effective sharing state has not changed',async()=>{
  const f=fixture();complete(f,'fresh-before-reload');
  const policy=structuredClone(f.engine.l.sharingPolicy);
  f.time(start+5*60000);f.reload();
  assert.deepEqual(f.engine.l.sharingPolicy,policy);assert.equal(f.engine.l.outbox[0].state,'pending');
  await f.engine.deliver();assert.deepEqual(f.sent,['fresh-before-reload']);
});

test('a genuine settings change supersedes an older share control and settings close cannot remain hidden by that control',async()=>{
  const f=fixture({sharing:false});f.engine.control('share');
  assert.equal(f.engine.cfg.sharing,true);assert.equal(f.engine.l.sharingPolicy.settingsSharing,false);
  complete(f,'enabled-by-control');await f.engine.deliver();assert.deepEqual(f.sent,['enabled-by-control']);
  f.settings.sharing=true;await f.engine.deliver();assert.equal(Object.hasOwn(f.engine.l.controls,'sharing'),false);
  f.settings.sharing=false;
  const off=complete(f,'closed-in-settings');assert.equal(off.state,'suppressed');assert.equal(f.engine.cfg.sharing,false);
  await f.engine.deliver();assert.deepEqual(f.sent,['enabled-by-control']);
});

test('saving the same settings value and reloading cannot undo a newer pause control',async()=>{
  const f=fixture();f.engine.control('pauseShare');f.settings.sharing=true;
  f.reload();assert.equal(f.engine.cfg.sharing,false);assert.equal(f.engine.l.controls.sharing,false);
  assert.equal(complete(f,'still-paused').state,'suppressed');await f.engine.deliver();assert.deepEqual(f.sent,[]);
  f.settings.sharing=false;await f.engine.deliver();assert.equal(Object.hasOwn(f.engine.l.controls,'sharing'),false);
  f.settings.sharing=true;
  const fresh=complete(f,'enabled-by-later-settings');assert.equal(fresh.state,'pending');
  await f.engine.deliver();assert.deepEqual(f.sent,['enabled-by-later-settings']);
});

test('settings changes observed during reload supersede stale controls while a missing settings baseline never guesses precedence',async()=>{
  const changed=fixture();changed.engine.control('share');changed.settings.sharing=false;changed.reload();
  assert.equal(changed.engine.cfg.sharing,false);assert.equal(Object.hasOwn(changed.engine.l.controls,'sharing'),false);
  const baseline=fixture({sharing:false});baseline.engine.control('share');
  const fresh=complete(baseline,'fresh-without-settings-baseline');delete baseline.engine.l.sharingPolicy.settingsSharing;
  baseline.reload();assert.equal(baseline.engine.cfg.sharing,true);assert.equal(baseline.engine.l.sharingPolicy.settingsSharing,false);
  assert.equal(baseline.engine.l.outbox.find(o=>o.id===fresh.id).state,'pending');
  await baseline.engine.deliver();assert.deepEqual(baseline.sent,[fresh.id]);
});

test('the latest explicit share control is applied after observing an earlier settings change',async()=>{
  const f=fixture();f.engine.control('pauseShare');
  f.settings.sharing=false;f.engine.control('share');
  assert.equal(f.engine.cfg.sharing,true);assert.equal(f.engine.l.sharingPolicy.settingsSharing,false);
  complete(f,'latest-control-wins');await f.engine.deliver();assert.deepEqual(f.sent,['latest-control-wins']);
});

test('original creation time bounds every unsubmitted state to thirty minutes and invalid timestamps never count as fresh',async()=>{
  const expired=['pending','deferred','failed'].map(state=>item('expired-'+state,state,{retryAt:start+86400000,receipt:'part-'+state,receipts:['part-'+state]}));
  const unknown=[undefined,null,NaN,Infinity,String(start),start+ttl+1].map((at,index)=>item('unknown-time-'+index,'pending',{at}));
  const f=fixture({outbox:[...expired,...unknown]});
  f.time(start+ttl);f.engine.l.outbox.push(item('just-fresh','pending',{at:start+1}));await f.engine.deliver();
  assert.deepEqual(f.sent,['just-fresh']);
  assert.ok(expired.every(o=>o.state==='suppressed'&&o.at===start&&o.retryAt===start+86400000));
  assert.ok(unknown.every(o=>o.state==='suppressed'));
  for(const state of ['pending','deferred','failed']){
    const o=expired.find(row=>row.id==='expired-'+state);assert.equal(o.receipt,'part-'+state);assert.deepEqual(o.receipts,['part-'+state]);
  }
});

test('quiet hours and exhausted share quota cannot build a backlog that replays after its original TTL',async()=>{
  for(const mode of ['quiet','quota']){
    const f=fixture();
    if(mode==='quiet'){f.settings.quietStart=0;f.settings.quietEnd=23;}else f.settings.shareLimit=0;
    const row=complete(f,'deferred-by-'+mode);await f.engine.deliver();assert.equal(row.state,'deferred');
    f.time(start+ttl);await f.engine.deliver();assert.equal(row.state,'suppressed');assert.equal(row.at,start);
    f.settings.quietStart=23;f.settings.quietEnd=8;f.settings.shareLimit=6;
    f.time(start+86400000);await f.engine.deliver();assert.deepEqual(f.sent,[]);
  }
});

test('queued and uncertain shares retain original delivery evidence across toggles and TTL and never submit again',async()=>{
  const queued=item('already-queued','queued',{deliveryId:'original-queue',receipt:'partial',receipts:['partial'],at:start-86400000});
  const uncertain=item('already-uncertain','uncertain',{deliveryId:'original-unknown',receipt:'unknown-part',receipts:['unknown-part'],at:start-86400000});
  const f=fixture({outbox:[queued,uncertain]});
  f.host.deliveryStatus=async id=>{f.queried.push(id);return {state:'failed'};};
  f.engine.control('pauseShare');assert.equal(queued.state,'queued');assert.equal(uncertain.state,'uncertain');
  f.time(start+ttl);await f.engine.deliver();
  assert.deepEqual(f.queried,['original-queue']);assert.equal(queued.state,'suppressed');assert.equal(queued.suppressedFrom.state,'failed');
  f.engine.control('share');await f.engine.deliver();await f.engine.deliver();assert.deepEqual(f.sent,[]);
  assert.equal(queued.deliveryId,'original-queue');assert.equal(queued.receipt,'partial');assert.deepEqual(queued.receipts,['partial']);
  assert.equal(uncertain.state,'uncertain');assert.equal(uncertain.deliveryId,'original-unknown');assert.deepEqual(uncertain.receipts,['unknown-part']);
});

test('a fresh queued share after first upgrade or toggling whose original receipt fails or defers is never submitted a second time',async()=>{
  for(const state of ['failed','defer']){
    const row=item('fresh-queued-'+state,'queued',{deliveryId:'original-'+state,receipt:'partial-'+state,receipts:['partial-'+state]});
    const f=fixture({outbox:[row],initialized:state!=='failed'});
    if(state==='defer'){f.engine.control('pauseShare');f.engine.control('share');}
    f.time(start+1000);f.host.deliveryStatus=async id=>{f.queried.push(id);return {state};};
    await f.engine.deliver();await f.engine.deliver();
    assert.deepEqual(f.sent,[]);assert.deepEqual(f.queried,['original-'+state]);assert.equal(row.state,'suppressed');
    assert.equal(row.deliveryId,'original-'+state);assert.equal(row.receipt,'partial-'+state);assert.deepEqual(row.receipts,['partial-'+state]);
  }
});

test('module config events archive backlog across rapid off and on changes before any tick and preserve the first new share',async t=>{
  const folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'share-config-')),at=Date.now();
  const life={...newLife(at),...identity,outbox:[item('before-config-events','pending',{at})],sharingPolicy:{version:1,sharing:true,settingsSharing:true,initializedAt:at,changedAt:at}};
  fs.writeFileSync(path.join(folder,'runtime.json'),JSON.stringify({version:3,fishId:'synthetic-fish',recent:[],at:{state:at},errors:{},state:{stage:'alive'},life}));
  let config={enabled:true,ownerQQ:identity.owner,persona:{current:identity.persona},ext:{'fish-world':{sharing:true,autonomy:false,quietStart:0,quietEnd:0}}},engine,dispose;
  const hooks=new Map(),sent=[],originalSync=LifeEngine.prototype.syncSharingPolicy;
  // Capture the real engine through the registered config callback, leaving its behavior intact.
  LifeEngine.prototype.syncSharingPolicy=function(...args){engine=this;return originalSync.apply(this,args);};
  t.after(async()=>{LifeEngine.prototype.syncSharingPolicy=originalSync;await dispose?.();});
  const api={config:()=>config,settings:()=>config.ext['fish-world'],dataDir:(...parts)=>path.join(folder,...parts),
    dsh:{get:name=>name==='tools'?{guard:()=>()=>{}}:null,on:()=>()=>{}},lib:()=>({}),
    on(name,fn){const list=hooks.get(name)||[];list.push(fn);hooks.set(name,list);},
    onDispose:fn=>{dispose=fn;},context:()=>{},tool:()=>{},rule:()=>{},command:()=>{},route:()=>{},every:()=>{},later:()=>{},
    use:()=>({addEvent:async()=>({ok:true})}),log:{info:()=>{},warn:()=>{}},core:{hub:{},http:{}},
    proactive:{available:true,submit:async o=>{sent.push(o.itemId);return {message_id:'receipt-'+o.itemId};}}};
  const module=await fishModule.setup(api);assert.equal(module.status().life.outbox[0].state,'pending');
  assert.ok(hooks.get('config')?.length);
  for(const sharing of [false,true]){
    const before=structuredClone(config);config={...config,ext:{'fish-world':{...config.ext['fish-world'],sharing}}};
    for(const hook of hooks.get('config'))hook(config,before);
  }
  LifeEngine.prototype.syncSharingPolicy=originalSync;
  assert.equal(module.status().life.sharingPolicy.sharing,true);assert.equal(module.status().life.outbox[0].state,'suppressed');assert.deepEqual(sent,[]);
  const fresh=complete({engine,data:engine.bridge.data},'new-after-config-events');assert.equal(fresh.state,'pending');
  await engine.deliver();assert.deepEqual(sent,['new-after-config-events']);
});
