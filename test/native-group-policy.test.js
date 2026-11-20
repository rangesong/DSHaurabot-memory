import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {V5Runtime} from '../core/v5-runtime.js';
import {NativeGroupPolicy,nativePolicyKey} from '../core/v5-native-policy.js';
import {GroupCleanup} from '../core/v5-group-cleanup.js';
import {forkBuiltinMemory,patchNativeSource,nativePatchManifest} from '../scripts/lib/native-patches.js';
import {testRuntimeRoot} from '../scripts/lib/test-workspace.js';
import {snapshotContextModule} from '../scripts/lib/context-module-updater.js';
import {createHash} from 'node:crypto';
const DAY=86400000,NOW=Date.parse('2026-11-19T21:00:00+08:00');
const builtin='D:/DSH/profiles/desktop/node_modules/dsh-aurabot-qq/src',modules='D:/DSH/plugins-data/aurabot/modules';
const enable=r=>r.updateConfig({region:'W5',values:{group_policy_enabled:1},expected_version:r.configVersion});
const temporary=name=>fs.mkdtempSync(path.join(testRuntimeRoot(null),name));
const quiet={info(){},warn(){},error(){},debug(){}};
function policyFixture(t){let now=NOW;const r=new V5Runtime({clock:()=>now});t.after(()=>r.close());const p=new NativeGroupPolicy(r,{persona:()=> 'aurabot:alpha'});return {r,p,at:value=>now=value};}

test('structured external policy shares deadlines, respects protection and does not read the rubbishmemory',t=>{
  const {r,p,at}=policyFixture(t);enable(r);r.trash.all=()=>assert.fail('must not read discarded copies');
  const item={id:'ordinary',chatId:'group:123',text:'普通蓝色湖泊资料',saidAt:NOW-4*DAY,importance:.4};
  const scopeCount=r.store.scopes().length;
  assert.equal(p.prepare({items:[item]}).items.length,0);
  assert.equal(r.store.scopes().length,scopeCount,'preparation of an unregistered group must remain read-only');
  for(const extra of [{tier:0},{tier:3},{importance:.8},{followUp:{status:'waiting'}},{text:'记住这条准确约定'}])assert.equal(p.prepare({items:[{...item,...extra}]}).items.length,1);
  const unknown=p.prepare({items:[{...item,kind:'gist'}]});assert.equal(unknown.decisions[0].reason,'legacy_aggregate_without_source_alignment');
  const restricted=new NativeGroupPolicy(r,{allowed:row=>row.uid!=='blocked'});
  assert.equal(restricted.prepare({path:'vault.lines',items:[{...item,t:NOW,uid:'blocked'}]}).items.length,0);
  assert.equal(restricted.prepare({path:'vault.lines',items:[{...item,chatId:'private:123',t:NOW,uid:'blocked'}]}).items.length,1);
  assert.equal(p.prepare({items:[{...item,chatId:'private:123'}]}).items[0].text,item.text);
  const key=nativePolicyKey('aurabot:alpha','memory.fact',item);r.store.setMeta('native-group-retired:'+key,{at:NOW});
  assert.notEqual(nativePolicyKey('aurabot:alpha','vault.lines',{...item,t:NOW,uid:'a'}),nativePolicyKey('aurabot:alpha','vault.lines',{...item,t:NOW,uid:'b'}),'same text at the same time from different speakers must not share retirement identity');
  r.updateConfig({region:'W5',values:{group_policy_enabled:0},expected_version:r.configVersion});
  assert.equal(p.prepare({items:[item],manual:true}).items.length,0);
  at(NOW+DAY);assert.equal(p.prepare({items:[item]}).items.length,0);
});

test('explicit past-only cleanup finishes due phases, preserves today/private/important and is resumable',t=>{
  const {r,p}=policyFixture(t);enable(r);const persona='aurabot:alpha',scope=r.addScope({persona_id:persona,scope:'group:123'}).id;
  const old=r.ingest({scope,text:'old-channel 普通合成旧资料',occurred_at:NOW-5*DAY,process:true});
  const today=r.ingest({scope,text:'today-channel 今天的新资料',occurred_at:NOW,process:true});
  const important=r.ingest({scope,text:'记住 important-channel 的精确约定',occurred_at:NOW-8*DAY,process:true});
  const privateScope=r.addScope({persona_id:persona,scope:'private:100'}).id,privateRow=r.ingest({scope:privateScope,text:'owner-channel 私聊资料',occurred_at:NOW-5*DAY,process:true});
  const row={id:1,t:NOW-5*DAY,chatId:'group:123',uid:'200',text:'old-channel 普通合成旧资料'};
  const cleanup=new GroupCleanup(r,{persona:()=>persona,policy:p,nativePage:()=>({items:[],next_cursor:'',done:true}),vaultPage:()=>({items:[row],next_cursor:1,done:true})});
  const before=Date.parse('2026-11-19T00:00:00+08:00');
  cleanup.run({before,action:'stage'});cleanup.run({before,action:'stage'});
  let result;for(let i=0;i<20;i++){result=cleanup.run({before,action:'apply'});if(result.stage==='done')break;}
  assert.equal(result.stage,'done');assert.equal(r.memory(old.memory_id).storage,'trash_only');
  assert.notEqual(r.memory(today.memory_id).layer,'forgotten');assert.notEqual(r.memory(important.memory_id).layer,'forgotten');assert.notEqual(r.memory(privateRow.memory_id).layer,'forgotten');
  assert.equal(p.prepare({path:'vault.lines',items:[row],manual:true}).items.length,0);
  assert.equal(cleanup.run({before}).applied,result.applied);
});

test('actual current native memory filters before reranking and renders only permitted sources',{skip:!fs.existsSync(builtin)},async t=>{
  const {r,p,at}=policyFixture(t);let now=NOW;t.mock.method(Date,'now',()=>now);
  const folder=temporary('native-memory-'),patches=nativePatchManifest().files;
  const originals=forkBuiltinMemory(builtin);
  for(const [name,bytes]of originals){const patch=patches.find(e=>e.module==='memory'&&e.file===name);fs.writeFileSync(path.join(folder,name),patch?patchNativeSource(bytes,patch):bytes);}
  const modelCalls=[],logs=[];
  const lib={
    'core/store.js':{dataDir:(...args)=>path.join(folder,...args),readJson:(_file,fallback)=>typeof fallback==='function'?fallback():fallback,writeJson(){}},
    'core/llm.js':{askModel:(_dsh,request)=>{modelCalls.push(request);return 'synthetic profile';},lastEmptyInfo:()=>''},
    'core/text.js':{clipText:(text,n)=>String(text).slice(0,n)},
    'core/offpeak.js':{shouldDeferBackground:()=>true},
    'persona/personas.js':{selfName:()=> 'synthetic',selfNames:()=>['synthetic'],isSelfName:()=>false},
    'features/memory-vector-local.js':{createLocalVectorIndex:()=>null},
  };
  const reranks=[];lib['features/rerank.js']={createReranker:()=>({rank:async(_q,hits)=>{reranks.push(hits);return hits;},configured:()=>false,settings:()=>({})})};
  const originalGlobal=globalThis.aurabot;globalThis.aurabot={lib:key=>{if(!(key in lib))throw Error('Unmocked native library '+key);return lib[key];}};t.after(()=>globalThis.aurabot=originalGlobal);
  const cfg={ownerQQ:'100',ownerName:'synthetic',botQQ:'999',memory:{enabled:true,profileOnlyAcquainted:false,gistEnabled:false,keepChatlogDays:-1,recallCount:8,preferPersonal:false,recallMinRelevance:0,vector:{enabled:false},assoc:{enabled:false},rerank:{enabled:true,topN:20}},group:{ownerBrief:{enabled:true}}};
  let state={items:[],gists:[],profiles:{},insights:{},styles:{},relations:[],chats:{}};
  const {createMemoryStore}=await import(pathToFileURL(path.join(folder,'memory.js')).href);
  const native=createMemoryStore({getConfig:()=>cfg,hub:{speakersOf:()=>['200'],chatLogDays:()=>logs.length?['2026-11-14']:[],chatLogOf:()=>logs},log:quiet,storage:{load:()=>structuredClone(state),save:next=>state=structuredClone(next)},preparationPolicy:()=>args=>p.prepare(args)});
  const chat={kind:'group',chatId:'group:123',groupId:'123',userId:'200'};
  for(const [text,days,importance]of [['aurora EXPIRED-NATIVE',5,.4],['aurora TRACE-NATIVE 湖泊。'+('蓝色波纹。'.repeat(25))+'结束。',2.5,.4],['aurora PROTECTED-NATIVE',8,.9]])native.add({text,about:'200',chatId:chat.chatId,saidAt:now-days*DAY,importance,source:'tool'});
  assert.ok(native.recall('aurora',{about:['200'],where:chat.chatId,groupChatId:chat.chatId}).some(h=>h.it.text.includes('EXPIRED-NATIVE')));
  enable(r);const hint=await native.recallHintAsync(chat,'aurora','', 'synthetic',['200']);
  assert.ok(!hint.includes('EXPIRED-NATIVE'));assert.ok(hint.includes('PROTECTED-NATIVE'));assert.ok(reranks.at(-1).every(h=>!h.it.text.includes('EXPIRED-NATIVE')));
  assert.equal(modelCalls.length,0,'retrieval proof must not use the model');
  assert.ok(!native.recall('aurora',{about:['200'],where:chat.chatId,groupChatId:chat.chatId}).some(h=>h.it.text.includes('EXPIRED-NATIVE')),'internal calls without a chat preparation argument must also filter');
  const manual=await native.recallAsync('aurora',{about:['200'],where:chat.chatId,groupChatId:chat.chatId,preparationChat:{...chat,thinkstarManual:true}});
  assert.ok(manual.some(h=>h.it.text.includes('EXPIRED-NATIVE')),'explicit cold retrieval remains available until retirement');
  for(let i=0;i<3;i++)native.add({text:'PROFILE-PRIVATE-'+i,about:'400',chatId:'private:400',saidAt:now,importance:.4,source:'tool'});
  native.add({text:'PROFILE-EXPIRED',about:'400',chatId:chat.chatId,saidAt:now-5*DAY,importance:.4,source:'tool'});
  native.add({text:'PROFILE-TRACE',about:'400',chatId:chat.chatId,saidAt:now-2.5*DAY,importance:.4,source:'tool'});
  assert.equal(await native.buildProfile('400'),true);
  assert.equal(modelCalls.length,1);assert.ok(modelCalls[0].text.includes('PROFILE-PRIVATE-0'));assert.ok(!modelCalls[0].text.includes('PROFILE-EXPIRED'));assert.ok(!modelCalls[0].text.includes('PROFILE-TRACE'));
  modelCalls.length=0;
  logs.push({t:now-5*DAY,chatId:chat.chatId,uid:'200',who:'synthetic',text:'LOG-EXPIRED'},{t:now-2.5*DAY,chatId:chat.chatId,uid:'200',who:'synthetic',text:'LOG-TRACE'});
  const storedCount=state.items.length;
  const consolidated=await native.consolidate();assert.equal(consolidated.ok,true);assert.equal(modelCalls.length,0,'expired/trace-only group logs must not be re-extracted or reflected');assert.equal(state.items.length,storedCount,'source storage must not be deleted by preparation');
  assert.equal(native.preparationPolicyStatus().connected,true);
  now+=2*DAY;at(now);const later=await native.recallHintAsync(chat,'aurora','', 'synthetic',['200']);assert.ok(!later.includes('TRACE-NATIVE'));
});

test('overdue automatic native consolidation waits for off-peak; manual consolidation remains available',{skip:!fs.existsSync(builtin)},async t=>{
  const at=Date.parse('2026-11-20T10:00:00+08:00');t.mock.timers.enable({apis:['Date'],now:at});
  const folder=temporary('native-peak-'),patches=nativePatchManifest().files;
  for(const [name,bytes]of forkBuiltinMemory(builtin)){const patch=patches.find(e=>e.module==='memory'&&e.file===name);fs.writeFileSync(path.join(folder,name),patch?patchNativeSource(bytes,patch):bytes);}
  const {isPeak}=await import(pathToFileURL(path.join(builtin,'core/offpeak.js')).href);
  let calls=0,state={items:[],gists:[],profiles:{},insights:{},styles:{},relations:[],chats:{},runs:{}};
  const lib={'core/store.js':{dataDir:(...args)=>path.join(folder,...args),readJson:(_f,fallback)=>typeof fallback==='function'?fallback():fallback,writeJson(){}},'core/llm.js':{askModel:()=>{calls++;return '';},lastEmptyInfo:()=>''},'core/text.js':{clipText:(x,n)=>String(x).slice(0,n)},'core/offpeak.js':{isPeak,shouldDeferBackground:()=>false},'persona/personas.js':{selfName:()=> 'synthetic',selfNames:()=>['synthetic'],isSelfName:()=>false},'features/memory-vector-local.js':{createLocalVectorIndex:()=>null},'features/rerank.js':{createReranker:()=>({configured:()=>false,settings:()=>({})})}};
  const old=globalThis.aurabot;globalThis.aurabot={lib:key=>lib[key]};t.after(()=>globalThis.aurabot=old);
  const {createMemoryStore}=await import(pathToFileURL(path.join(folder,'memory.js')).href);
  const cfg={cost:{offPeakHolidays:[]},ownerQQ:'100',botQQ:'999',memory:{enabled:true,dailyConsolidate:true,consolidateTimes:['04:00'],scheduledOncePerDay:true,shortTerm:false,vector:{enabled:false},assoc:{enabled:false},gistEnabled:false,compress:false,keepChatlogDays:-1,extractIdleMinutes:0},group:{}};
  const native=createMemoryStore({getConfig:()=>cfg,hub:{chatLogDays:()=>[],chatLogOf:()=>[]},log:quiet,storage:{load:()=>structuredClone(state),save:next=>state=structuredClone(next)}});
  await native.tick();assert.equal(state.runs['04:00'],undefined);assert.equal(calls,0);
  const manual=await native.consolidate();assert.equal(manual.ok,true,'manual operation remains available');
  t.mock.timers.setTime(Date.parse('2026-11-20T18:00:00+08:00'));await native.tick();assert.equal(state.runs['04:00'],'2026-11-20');
  cfg.memory.consolidateTimes.push('20:00');t.mock.timers.setTime(Date.parse('2026-11-20T20:00:00+08:00'));await native.tick();assert.equal(state.runs['20:00'],'2026-11-20','another slot is acknowledged but does not start a second consolidation');
});

test('actual history-vault prompt rebuilds a mixed day from eligible originals and leaves private injection unchanged',{skip:!fs.existsSync(path.join(modules,'history-vault'))},async t=>{
  const {r,p}=policyFixture(t),folder=temporary('native-vault-'),source=path.join(modules,'history-vault');
  const bytes=fs.readFileSync(path.join(source,'index.mjs')),patch=nativePatchManifest().files.find(e=>e.module==='history-vault'&&e.file==='index.mjs'),hash=b=>createHash('sha256').update(b).digest('hex');
  if([patch.before_sha256,patch.after_sha256].includes(hash(bytes))){
    for(const name of ['index.mjs','context-dedup.mjs']){const input=fs.readFileSync(path.join(source,name));fs.writeFileSync(path.join(folder,name),name==='index.mjs'?patchNativeSource(input,patch):input);}
  }else{
    // The maintained context extension already includes the native preparation bridge.
    // Verify its exact installed program against this checkout, never weaken old patch hashes.
    const current=snapshotContextModule(source,'history-vault'),maintained=snapshotContextModule(fileURLToPath(new URL('../extensions/aurabot/history-vault',import.meta.url)),'history-vault');
    for(const [name,input]of current.entries){if(/\.(?:mjs|js)$/.test(name))assert.equal(hash(input),hash(maintained.entries.get(name)),'Installed history-vault changed; rebase the integration proof');fs.writeFileSync(path.join(folder,name),input);}
  }
  const mod=(await import(pathToFileURL(path.join(folder,'index.mjs')).href)).default,callbacks=[],dispose=[];
  const api={settings:()=>({enabled:true,contextDedupEnabled:false,promptInjectionEnabled:true,injectOnce:false,injectDays:3,injectChars:2000}),dataDir:()=>folder,log:quiet,dsh:{},core:{hub:{}},use:id=>id==='thinkstar-memory'?{nativePreparation:args=>p.prepare(args)}:null,on:(name,fn)=>{if(name==='prompt')callbacks.push(fn);return()=>{};},onDispose:fn=>dispose.push(fn),every:()=>()=>{},route(){},rule(){},tool(){},command(){},ask:()=>assert.fail('no remote model')};
  await mod.setup(api);t.after(()=>{for(const fn of dispose)fn();});
  const db=new DatabaseSync(path.join(folder,'vault.sqlite'));t.after(()=>db.close());
  const day='2026-11-14',time=NOW-5*DAY;
  for(const [chatId,text]of [['group:123','EXPIRED-VAULT'],['group:123','记住 PROTECTED-VAULT 约定'],['private:100','PRIVATE-VAULT']])db.prepare('INSERT INTO vault_lines(t,chatId,day,dir,who,uid,text) VALUES(?,?,?,?,?,?,?)').run(time,chatId,day,'in','synthetic','200',text);
  for(const id of ['group:123','private:100'])db.prepare('INSERT INTO vault_days VALUES(?,?,?,?,?)').run(id,day,id.startsWith('group:')?'EXPIRED-VAULT 与 PROTECTED-VAULT':'PRIVATE-VAULT','synthetic',NOW);
  const prompt=callbacks.at(-1),prepare=chatId=>prompt([{type:'text',text:'真实用户正文不变'}],{chat:{chatId,kind:chatId.startsWith('group:')?'group':'private'},sessionId:'synthetic'});
  const privateBefore=prepare('private:100');assert.ok(JSON.stringify(prepare('group:123')).includes('EXPIRED-VAULT'));
  enable(r);const group=prepare('group:123');assert.ok(!JSON.stringify(group).includes('EXPIRED-VAULT'));assert.ok(JSON.stringify(group).includes('PROTECTED-VAULT'));assert.deepEqual(prepare('private:100'),privateBefore);
  assert.equal(db.prepare('SELECT count(*) n FROM vault_lines').get().n,3);
});
