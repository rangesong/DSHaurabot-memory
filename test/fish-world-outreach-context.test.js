import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {outreachWorldSnapshot} from '../extensions/aurabot/fish-world/outreach-context.mjs';
import fishModule from '../extensions/aurabot/fish-world/index.mjs';
import {FishBridge} from '../extensions/aurabot/fish-world/bridge.mjs';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {testRuntimeRoot} from '../scripts/lib/test-workspace.js';

const now=Date.parse('2026-11-26T12:00:00+08:00'),W='mcp__fish-world__world_';
const options={owner:'100',persona:'synthetic-persona',recipient:'100',enabled:true,identityReady:true,sharingEnabled:true,now};
const receipt=(id,extra={})=>({id,tool:W+'do',args:'{"id":"eat"}',at:now-2000,finishedAt:now-1900,status:'confirmed',isError:false,result:'合成吃饭已开始，12:10结束',...extra});
function fixture(extra={}){
  const life={...newLife(now),owner:'100',persona:'synthetic-persona',journal:[],...extra};
  const data={fishId:'合成鱼#9052',state:{fish:'合成鱼#9052',time:'12:00',where:{text:'去家的路上，12:30到',privateDetail:'不能注入完整状态'},doing:{name:'坐车',since:'11:50',until:'12:30',with:['合成朋友']},body:{text:'有点饱'},outfit:{name:'合成卫衣',look:'蓝白配色'},crew:['不能注入完整人员列表']},at:{state:now-1000},life};
  return {data,life};
}

test('outreach projects fresh owner-only state and source-backed recent evidence without modifying its inputs',()=>{
  const f=fixture({journal:[receipt('real-action'),{summary:'模型编造的拔萝卜',status:'completed',at:now-500}],queue:[{id:'message-notification',kind:'message',t:now-3000,receivedAt:now-2500,sender:'合成朋友#1234',text:'合成朋友#1234给你发了一条消息',provenance:{trusted:true,source:'world-notify'}},{id:'model-thought',kind:'message',t:now-100,receivedAt:now-50,text:'模型编造的消息正文',provenance:{trusted:false,source:'model'}}]});
  const before=JSON.stringify(f),packet=outreachWorldSnapshot(f.data,f.life,options);
  assert.equal(packet.available,true);assert.deepEqual(packet.scope,{owner:'100',persona:'synthetic-persona',fish:'#9052'});
  assert.equal(packet.current.fresh,true);assert.equal(packet.current.observedAt,now-1000);assert.equal(packet.current.where,'去家的路上，12:30到');assert.equal(packet.current.doing.until,'12:30');
  assert.equal(packet.correctionOnly,true);assert.equal(packet.recentIsComplete,false);assert.equal(packet.sharingEnabled,true);
  assert.deepEqual(packet.recent.map(row=>row.id),['real-action','message-notification']);
  assert.equal(packet.recent[1].occurredAt,now-3000);assert.equal(packet.recent[1].observedAt,now-2500);
  assert.ok(!/编造|完整状态|人员列表/.test(JSON.stringify(packet)));assert.equal(JSON.stringify(f),before);
  packet.current.doing.with.push('不能改原始资料');packet.recent[0].text='不能改回执';assert.equal(JSON.stringify(f),before);
});

test('recipient persona fish identity and readiness gates never reveal foreign evidence',()=>{
  for(const patch of [{recipient:'200'},{recipient:'private:100'},{persona:'other'},{persona:''},{owner:'200'},{identityReady:false},{enabled:false}]){
    const f=fixture({journal:[receipt('private-receipt')]});const packet=outreachWorldSnapshot(f.data,f.life,{...options,...patch});
    assert.equal(packet.available,false);assert.equal(packet.scope,null);assert.deepEqual(packet.recent,[]);assert.ok(!JSON.stringify(packet).includes('private-receipt'));
  }
  for(const mutate of [f=>f.life.owner='200',f=>f.life.persona='other',f=>f.data.state.fish='另一条鱼#2347',f=>f.data.fishId='不是明确编号',f=>f.data.life={...f.life}]){
    const f=fixture();mutate(f);assert.equal(outreachWorldSnapshot(f.data,f.life,options).available,false);
  }
});

test('missing stale and future observations remain unknown and current activity null does not mean all tasks ended',()=>{
  for(const at of [undefined,now-180001,now+1]){
    const f=fixture();f.data.at.state=at;const packet=outreachWorldSnapshot(f.data,f.life,options);
    assert.equal(packet.current.fresh,false);assert.equal(packet.current.where,undefined);assert.equal(packet.current.body,undefined);
  }
  const f=fixture();f.data.state.doing=null;assert.equal(outreachWorldSnapshot(f.data,f.life,options).current.doing,null);
  delete f.data.state.doing;assert.equal(Object.hasOwn(outreachWorldSnapshot(f.data,f.life,options).current,'doing'),false);
  f.data.at.state=now-180000;assert.equal(outreachWorldSnapshot(f.data,f.life,options).current.fresh,true);
});

test('world changes after the state sample invalidate present-state claims without inferring action completion',()=>{
  for(const status of ['confirmed','executing','uncertain']){
    const f=fixture({journal:[receipt('new-move',{tool:W+'go',args:'{"place":"home"}',at:now-500,finishedAt:status==='confirmed'?now-400:undefined,status,result:'12:30到家，尚未到达'})]});
    const packet=outreachWorldSnapshot(f.data,f.life,options);assert.equal(packet.current.fresh,false);assert.equal(packet.current.reason,'changed-after-observation');assert.equal(packet.current.where,undefined);
    assert.equal(packet.recent.length,status==='confirmed'?1:0);
    if(status==='confirmed')assert.match(packet.recent[0].text,/尚未到达/);
  }
  for(const row of [receipt('read-history',{tool:W+'history',at:now-500,finishedAt:now-400}),receipt('failed-action',{status:'failed',at:now-500,finishedAt:now-400,isError:true}),receipt('foreign-action',{owner:'200',at:now-500,finishedAt:now-400})]){
    const f=fixture({journal:[row]});const packet=outreachWorldSnapshot(f.data,f.life,options);assert.equal(packet.current.fresh,true);assert.deepEqual(packet.recent,[]);
  }
});

test('recent evidence rejects history model summaries failed future and invalid-time rows',()=>{
  const f=fixture({journal:[receipt('old',{at:now-86400001,finishedAt:now-86400000}),receipt('future',{at:now+1,finishedAt:now+2}),receipt('no-finish',{finishedAt:undefined}),receipt('backwards',{finishedAt:now-3000}),receipt('history',{tool:W+'history'}),receipt('friends-list',{tool:W+'friends',args:'{"action":"list"}'}),receipt('friends-default',{tool:W+'friends',args:'{}'}),receipt('error',{isError:true}),receipt('malformed',{at:'today'})],queue:[{id:'future-message',kind:'message',t:now+1,receivedAt:now+2,text:'不可信未来消息',provenance:{trusted:true,source:'world-notify'}},{id:'unknown-kind',kind:'invented',t:now-1000,receivedAt:now-500,text:'未知通知不可提升为世界事实',provenance:{trusted:true,source:'world-notify'}},{id:'foreign-notification',owner:'200',kind:'message',t:now-1000,receivedAt:now-500,text:'外人资料不可使用',provenance:{trusted:true,source:'world-notify'}}]});
  assert.deepEqual(outreachWorldSnapshot(f.data,f.life,options).recent,[]);
});

test('body location and disabled sharing remain separate privacy and delivery constraints',()=>{
  const f=fixture({journal:[receipt('action')]});
  const hidden=outreachWorldSnapshot(f.data,f.life,{...options,body:false,location:false,sharingEnabled:false});
  assert.equal(hidden.available,true);assert.equal(hidden.sharingEnabled,false);assert.equal(hidden.correctionOnly,true);assert.equal(hidden.current.fresh,true);
  for(const field of ['where','doing','body','outfit'])assert.equal(Object.hasOwn(hidden.current,field),false);
  assert.equal(hidden.recent.length,0,'free-form evidence cannot bypass a hidden body or location');
  const sharingOff=outreachWorldSnapshot(f.data,f.life,{...options,sharingEnabled:false});
  assert.equal(sharingOff.recent.length,1,'sharing off alone preserves correction evidence without granting delivery');
});

test('at most eight evidence rows and 2000 actual serialized characters survive escapes and long identifiers',()=>{
  for(const character of ['"','\\','\ud800','🐟']){
    const f=fixture({journal:Array.from({length:40},(_,i)=>receipt('r-'+i,{at:now-30000+i,finishedAt:now-29900+i,result:character.repeat(10000)+' fw_syntheticsecretvalue'}))});
    f.data.state.where.text=character.repeat(10000);f.data.state.doing={name:character.repeat(10000),with:[character.repeat(10000),character.repeat(10000)]};
    f.life.owner=character.repeat(128);f.life.persona=character.repeat(128);
    const packet=outreachWorldSnapshot(f.data,f.life,{...options,owner:f.life.owner,persona:f.life.persona,recipient:f.life.owner});
    assert.ok(packet.recent.length<=8);assert.ok(JSON.stringify(packet).length<=2000,JSON.stringify({character,length:JSON.stringify(packet).length}));assert.ok(!JSON.stringify(packet).includes('syntheticsecretvalue'));
  }
});

test('module export reads only its scoped cache with no network writes models snapshots or new permissions',async t=>{
  const directory=fs.mkdtempSync(path.join(testRuntimeRoot(null),'outreach-module-')),at=Date.now(),f=fixture();
  f.data.at.state=at;const key='fw_synthetic_outreach_credential_123456';
  fs.writeFileSync(path.join(directory,'credential.json'),JSON.stringify({key}));
  fs.writeFileSync(path.join(directory,'runtime.json'),JSON.stringify({version:3,keyId:createHash('sha256').update(key).digest('hex'),...f.data,recent:[],at:{state:at},errors:{}}));
  const config={enabled:true,ownerQQ:'100',persona:{current:'synthetic-persona'}},settings={autonomy:false,sharing:false},tools=[],contexts=[];let dispose,fetches=0,bridge;
  const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{fetches++;assert.fail('No world network calls');};
  const api={config:()=>config,settings:()=>settings,dataDir:(...parts)=>path.join(directory,...parts),dsh:{get:name=>name==='tools'?{guard:()=>()=>{}}:null,on:()=>()=>{}},on:()=>{},onDispose:fn=>{dispose=fn;},context:fn=>contexts.push(fn),tool:fn=>tools.push(fn),rule:()=>{},command:()=>{},route:()=>{},every:()=>{},later:()=>{},use:()=>null,defineTool:value=>value,log:{info:()=>{},warn:()=>{}},core:{hub:{turnSendersAllOwner:()=>true},http:{}},think:()=>assert.fail('No model calls'),send:()=>assert.fail('No messages')};
  const originalSync=FishBridge.prototype.sync,originalSnapshot=FishBridge.prototype.snapshot,originalLifeSnapshot=LifeEngine.prototype.snapshot;
  t.after(async()=>{FishBridge.prototype.sync=originalSync;FishBridge.prototype.snapshot=originalSnapshot;LifeEngine.prototype.snapshot=originalLifeSnapshot;globalThis.fetch=oldFetch;await dispose?.();});
  const service=await fishModule.setup(api);assert.equal(service.outreachSnapshot({recipient:'100',persona:'synthetic-persona'}).available,false,'restart cache needs existing identity verification');
  FishBridge.prototype.sync=async function(){bridge=this;this.identityReady=true;};await service.refresh();FishBridge.prototype.sync=originalSync;
  FishBridge.prototype.snapshot=()=>assert.fail('No full bridge snapshot');LifeEngine.prototype.snapshot=()=>assert.fail('No full life snapshot');
  const bytes=()=>Object.fromEntries(fs.readdirSync(directory).filter(name=>fs.statSync(path.join(directory,name)).isFile()).map(name=>[name,fs.readFileSync(path.join(directory,name),'utf8')]));
  const beforeFiles=bytes(),beforeData=JSON.stringify(bridge.data),beforeHooks={tools:tools.length,contexts:contexts.length};
  const packet=service.outreachSnapshot({recipient:'100',persona:'synthetic-persona'});assert.equal(packet.available,true);assert.equal(packet.sharingEnabled,false);assert.equal(fetches,0);assert.equal(JSON.stringify(bridge.data),beforeData);assert.deepEqual(bytes(),beforeFiles);assert.deepEqual({tools:tools.length,contexts:contexts.length},beforeHooks);
  for(const request of [{recipient:'200',persona:'synthetic-persona'},{recipient:'100',persona:'other'},undefined])assert.equal(service.outreachSnapshot(request).available,false);
  config.persona.current='other';assert.equal(service.outreachSnapshot({recipient:'100',persona:'other'}).available,false);config.persona.current='synthetic-persona';
  fs.writeFileSync(path.join(directory,'credential.json'),JSON.stringify({key:key+'changed'}));assert.equal(service.outreachSnapshot({recipient:'100',persona:'synthetic-persona'}).available,false);fs.writeFileSync(path.join(directory,'credential.json'),JSON.stringify({key}));
  config.enabled=false;assert.equal(service.outreachSnapshot({recipient:'100',persona:'synthetic-persona'}).available,false);config.enabled=true;
  await dispose();dispose=null;assert.equal(service.outreachSnapshot({recipient:'100',persona:'synthetic-persona'}).available,false);
});
