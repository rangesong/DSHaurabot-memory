import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {PROFILE_LIFECYCLE_PATCH,PROFILE_PANEL_PATCH,patchProfileLifecycle,patchProfilePanel} from '../scripts/lib/profile-lifecycle-patch.js';
import {testRuntimeRoot} from '../scripts/lib/test-workspace.js';

const nativeRoot=path.join(process.env.THINKSTAR_NATIVE_MODULES_ROOT||'D:/DSH/plugins-data/aurabot/modules','memory');
const available=fs.existsSync(path.join(nativeRoot,'memory.js'));
const options={skip:!available},DAY=86400000,MINUTE=60000,NOW=Date.parse('2026-11-25T04:00:00+08:00');
const owner='100',oldPortrait='合成旧画像仍准确：喜欢安静的蓝色花园。',newPortrait='合成新画像：经常分享蓝色花园和散步见闻。';
const abstract='合成对象喜欢安静的蓝色花园，也会分享散步时的见闻。';
const hash=value=>createHash('sha256').update(value).digest('hex');
const kind=request=>request.system.includes('人物小档案')?'profile':request.system.includes('长期印象')?'compression':request.system.includes('合并')?'merge':'other';
const facts=(qq=owner,count=8)=>Array.from({length:count},(_,i)=>({id:'fact-'+qq+'-'+i,text:'合成花园见闻'+String.fromCharCode(65+i)+'：今天沿蓝色湖边安静散步。',about:qq,aboutName:'合成对象',speaker:qq,chatId:'private:'+qq,source:'auto',tier:1,importance:.6,at:NOW-20*DAY+i*1000,saidAt:NOW-20*DAY+i*1000}));
function initial(){return {items:facts(),gists:[],profiles:{[owner]:{text:oldPortrait,name:'合成对象',alias:'合成称呼',style:'简洁',persona:'安静',handle:'平常相处',tags:['合成'],tagsBy:'owner',at:NOW-DAY}},dirtyProfiles:{},insights:{},styles:{},relations:[],chats:{},runs:{}};}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}

async function fixture(t,{state:input=initial(),respond,compress=false,extractIdleMinutes=0,defer=false}={}){
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const folder=fs.mkdtempSync(path.join(testRuntimeRoot(null),'native-profile-'));
  const before=fs.readFileSync(path.join(nativeRoot,'memory.js'),'utf8');
  const patched=patchProfileLifecycle(before,{version:PROFILE_LIFECYCLE_PATCH.version});
  assert.equal(hash(patched.source),PROFILE_LIFECYCLE_PATCH.after_sha256,'exercise the exact reviewed production patch');
  fs.writeFileSync(path.join(folder,'memory.js'),patched.source);
  for(const name of ['memory-rules.js','memory-store.js','memory-vector.js'])fs.copyFileSync(path.join(nativeRoot,name),path.join(folder,name));
  fs.writeFileSync(path.join(folder,'package.json'),JSON.stringify({type:'module'}));
  let state=structuredClone(input),response=respond,peak=defer;
  const calls=[],warnings=[],writes=[];
  const cfg={ownerQQ:owner,ownerName:'合成主人',botQQ:'999',persona:{current:'synthetic-persona'},cost:{offPeakHolidays:[]},group:{},memory:{enabled:true,profileOnlyAcquainted:false,profileChars:240,profileFieldChars:40,shortTerm:false,dailyConsolidate:true,consolidateTimes:[],scheduledOncePerDay:true,extractIdleMinutes,compress,compressAfterDays:14,keepChatlogDays:-1,gistEnabled:false,recallCount:0,recallTotal:0,residentChars:1200,followUp:false,vector:{enabled:false},assoc:{enabled:false},rerank:{enabled:false}}};
  const lib={
    'core/store.js':{dataDir:(...args)=>path.join(folder,...args),readJson:(_file,fallback)=>typeof fallback==='function'?fallback():fallback,writeJson(){assert.fail('mock storage must keep writes inside the synthetic fixture');}},
    'core/llm.js':{askModel:async(_dsh,request)=>{calls.push(request);if(response)return response(request);return kind(request)==='compression'?JSON.stringify({text:abstract}):kind(request)==='profile'?newPortrait:kind(request)==='merge'?'{}':'[]';},lastEmptyInfo:()=>''},
    'core/text.js':{clipText:(text,n)=>String(text).slice(0,n)},
    'core/offpeak.js':{shouldDeferBackground:()=>peak,isPeak:()=>peak},
    'persona/personas.js':{selfName:()=> 'synthetic-self',selfNames:()=>['synthetic-self'],isSelfName:()=>false},
    'features/memory-vector-local.js':{createLocalVectorIndex:()=>null},
    'features/rerank.js':{createReranker:()=>({configured:()=>false,settings:()=>({})})},
  };
  const previous=globalThis.aurabot;globalThis.aurabot={lib:key=>{assert.ok(key in lib,'unmocked native dependency '+key);return lib[key];}};
  t.after(()=>{globalThis.aurabot=previous;});
  const {createMemoryStore}=await import(pathToFileURL(path.join(folder,'memory.js')).href);
  const storage={load:()=>structuredClone(state),save(next){state=structuredClone(next);writes.push(structuredClone(next));}};
  const hub={chatLogDays:()=>[],chatLogOf:()=>[],chatLogRevision:()=>0,refreshFriends:async()=>{},speakersOf:()=>[],isFriend:()=>false};
  const log={info(){},debug(){},error(){},warn(...args){warnings.push(args.join(' '));}};
  const create=()=>createMemoryStore({getConfig:()=>cfg,hub,log,storage,fetchImpl:()=>assert.fail('synthetic native proof must not use the network')});
  let native=create();
  return {folder,cfg,calls,writes,warnings,get state(){return state;},get native(){return native;},edit(fn){fn(state);},respond(fn){response=fn;},peak(value){peak=value;},at(value){t.mock.timers.setTime(value);},reload(){state=JSON.parse(JSON.stringify(state));native=create();return native;},context(){return native.contextFor({kind:'private',chatId:'private:'+owner,userId:owner},'synthetic-session');}};
}

test('reviewed lifecycle source is hash constrained and idempotent',options,()=>{
  const source=fs.readFileSync(path.join(nativeRoot,'memory.js'),'utf8'),one=patchProfileLifecycle(source,{version:PROFILE_LIFECYCLE_PATCH.version});
  assert.equal(hash(one.source),PROFILE_LIFECYCLE_PATCH.after_sha256);
  assert.equal(patchProfileLifecycle(one.source,{version:PROFILE_LIFECYCLE_PATCH.version}).receipt.unchanged,true);
  assert.throws(()=>patchProfileLifecycle(source+'\n',{version:PROFILE_LIFECYCLE_PATCH.version}),/hash/i);
  assert.throws(()=>patchProfileLifecycle(source,{version:'unreviewed'}),/version/i);
});

test('reviewed panel distinguishes a missing pending portrait and rejects unreviewed code',{skip:!fs.existsSync('D:/DSH/profiles/desktop/node_modules/dsh-aurabot-qq/client/client.js')},()=>{
  const source=fs.readFileSync('D:/DSH/profiles/desktop/node_modules/dsh-aurabot-qq/client/client.js','utf8');
  const result=patchProfilePanel(source,{version:PROFILE_PANEL_PATCH.version});
  assert.ok([PROFILE_PANEL_PATCH.after_sha256,...PROFILE_PANEL_PATCH.compatible_sha256].includes(hash(result.source)));
  assert.match(result.source,/p\.text \|\| \(p\.profilePending \? '整体印象待更新，已有记忆仍保留。'/);
  assert.equal(patchProfilePanel(result.source,{version:PROFILE_PANEL_PATCH.version}).receipt.unchanged,true);
  assert.throws(()=>patchProfilePanel(source+'\n',{version:PROFILE_PANEL_PATCH.version}),/hash/i);
});

test('compression keeps the safe portrait visible and marks only a pending compression refresh',options,async t=>{
  const f=await fixture(t,{compress:true}),before=structuredClone(f.state.profiles[owner]);
  const result=await f.native.compressDetails();
  assert.equal(result.created,1);assert.equal(f.state.dirtyProfiles[owner],'compression');assert.deepEqual(f.state.profiles[owner],before);
  assert.ok(f.context().includes(oldPortrait),'the real native prompt still receives the safe portrait');
  assert.equal(f.native.personaPerson(owner).person.profilePending,true);
  assert.equal(f.state.items.filter(m=>m.compressedInto).length,8);assert.equal(f.state.items.filter(m=>m.source==='abstract').length,1);
});

test('compression cannot downgrade correction invalidation or expose its unsafe old portrait',options,async t=>{
  const state=initial();state.dirtyProfiles[owner]=true;
  const f=await fixture(t,{state,compress:true});
  assert.ok(!f.context().includes(oldPortrait));
  assert.equal((await f.native.compressDetails()).created,1);
  assert.equal(f.state.dirtyProfiles[owner],true);assert.ok(!f.context().includes(oldPortrait));
  assert.equal(f.state.profiles[owner].text,undefined,'a correction retains independent tags without reviving the old text');
  assert.deepEqual(f.state.profiles[owner].tags,['合成']);
});

test('a failed replacement preserves a safe compression portrait and remains pending',options,async t=>{
  const state=initial();state.dirtyProfiles[owner]='compression';
  const f=await fixture(t,{state,respond:async()=>{throw Error('synthetic generation failure');}}),before=structuredClone(state.profiles[owner]);
  await assert.rejects(f.native.buildProfile(owner,{automatic:true}),/synthetic generation failure/);
  assert.deepEqual(f.state.profiles[owner],before);assert.equal(f.state.dirtyProfiles[owner],'compression');assert.ok(f.context().includes(oldPortrait));
  assert.equal(f.state.profileRefreshAttempts[owner].count,1);assert.equal(f.state.profileRefreshAttempts[owner].failures,1);
});

test('an empty model replacement cannot erase a safe old portrait',options,async t=>{
  const state=initial();state.dirtyProfiles[owner]='compression';
  const f=await fixture(t,{state,respond:async()=>''});
  await assert.rejects(f.native.buildProfile(owner,{automatic:true}),/印象/);
  assert.equal(f.state.profiles[owner].text,oldPortrait);assert.equal(f.state.dirtyProfiles[owner],'compression');
});

test('consolidation compresses before its single profile refresh and finishes with a usable portrait',options,async t=>{
  const f=await fixture(t,{compress:true});
  const result=await f.native.consolidate();
  assert.equal(result.ok,true);assert.equal(result.compressed,1);assert.equal(result.profiles,1);
  assert.deepEqual(f.calls.map(kind),['compression','profile']);
  assert.ok(f.calls[1].text.includes(abstract),'the profile is built from the new abstract');
  assert.ok(!f.calls[1].text.includes('合成花园见闻A'),'invalidated source detail is not reintroduced');
  assert.equal(f.state.profiles[owner].text,newPortrait);assert.equal(f.state.dirtyProfiles[owner],undefined);assert.ok(f.context().includes(newPortrait));
});

for(const extractIdleMinutes of [0,1]){
  test('a tick with no extraction batch repairs pending profiles when idle interval is '+extractIdleMinutes,options,async t=>{
    const state=initial();delete state.profiles[owner];state.dirtyProfiles[owner]=true;
    const f=await fixture(t,{state,extractIdleMinutes});
    await f.native.tick();
    assert.equal(f.calls.filter(r=>kind(r)==='profile').length,1);assert.equal(f.state.profiles[owner].text,newPortrait);
    assert.equal(f.state.dirtyProfiles[owner],undefined);assert.equal(f.state.profileRefreshAttempts[owner].count,1);
  });
}

test('a structured portrait shell with blank text is recognized as missing and rebuilt',options,async t=>{
  const state=initial();state.profiles[owner]={alias:'合成别称',style:'简洁',text:'   ',tags:['合成'],at:NOW-DAY};
  const f=await fixture(t,{state});await f.native.tick();
  assert.equal(f.calls.filter(r=>kind(r)==='profile').length,1);assert.equal(f.state.profiles[owner].text,newPortrait);
  assert.equal(f.state.profiles[owner].alias,'合成别称');assert.deepEqual(f.state.profiles[owner].tags,['合成']);
});

test('automatic failures persist the three-per-person daily budget and thirty-minute to two-hour backoff across reload',options,async t=>{
  const state=initial();state.dirtyProfiles[owner]='compression';
  const f=await fixture(t,{state,respond:async()=>{throw Error('synthetic temporary failure');}});
  let at=NOW;
  for(let attempt=1;attempt<=3;attempt++){
    f.at(at);await assert.rejects(f.native.buildProfile(owner,{automatic:true}),/synthetic temporary failure/);
    const row=f.state.profileRefreshAttempts[owner],delay=[30,60,120][attempt-1]*MINUTE;
    assert.equal(row.count,attempt);assert.equal(row.failures,attempt);assert.equal(row.nextAt,at+delay);
    f.reload();f.at(row.nextAt-1);assert.equal(await f.native.buildProfile(owner,{automatic:true}),false);
    assert.equal(f.calls.length,attempt,'cooldown survives a new native store instance');at=row.nextAt;
  }
  f.at(at);assert.equal(await f.native.buildProfile(owner,{automatic:true}),false);assert.equal(f.calls.length,3,'same-day cap remains after the last cooldown');
  f.reload();f.at(NOW+DAY);f.respond(async()=>newPortrait);
  assert.equal(await f.native.buildProfile(owner,{automatic:true}),true);assert.equal(f.state.profileRefreshAttempts[owner].count,1);assert.equal(f.state.profileRefreshAttempts[owner].failures,0);
});

test('the global automatic budget is twenty-four actual attempts per day and survives reload',options,async t=>{
  const state=initial();state.items=[];state.profiles={};
  const ids=Array.from({length:25},(_,i)=>String(2000+i));for(const id of ids)state.items.push(...facts(id,3));
  const f=await fixture(t,{state,respond:async()=>{throw Error('synthetic global-budget failure');}});
  for(const id of ids.slice(0,24))await assert.rejects(f.native.buildProfile(id,{automatic:true}),/synthetic global-budget failure/);
  f.reload();assert.equal(await f.native.buildProfile(ids[24],{automatic:true}),false);assert.equal(f.calls.length,24);
  assert.equal(Object.values(f.state.profileRefreshAttempts).reduce((n,row)=>n+row.count,0),24);
  f.at(NOW+DAY);f.respond(async()=>newPortrait);assert.equal(await f.native.buildProfile(ids[24],{automatic:true}),true);assert.equal(f.calls.length,25);
});

test('explicit manual rebuild remains available without spending or refunding the automatic daily budget',options,async t=>{
  const state=initial();state.profileRefreshAttempts={[owner]:{day:'2026-11-25',count:3,failures:3,nextAt:NOW+DAY}};
  const f=await fixture(t,{state}),before=structuredClone(state.profileRefreshAttempts);
  assert.equal(await f.native.buildProfile(owner,{automatic:true}),false);
  assert.equal(await f.native.buildProfile(owner),true);assert.equal(f.calls.length,1);assert.deepEqual(f.state.profileRefreshAttempts,before);
});

test('automatic refresh obeys off-peak deferral without reserving a call while manual generation is still explicit',options,async t=>{
  const f=await fixture(t,{defer:true});
  assert.equal(await f.native.buildProfile(owner,{automatic:true}),false);assert.equal(f.calls.length,0);assert.equal(f.state.profileRefreshAttempts,undefined);
  assert.equal(await f.native.buildProfile(owner),true);assert.equal(f.calls.length,1);
});

test('one active builder per person prevents parallel model calls and duplicate reservations',options,async t=>{
  const entered=deferred(),reply=deferred();
  const f=await fixture(t,{respond:async()=>{entered.resolve();return reply.promise;}});
  const first=f.native.buildProfile(owner,{automatic:true});await entered.promise;
  assert.equal(await f.native.buildProfile(owner,{automatic:true}),false);assert.equal(await f.native.buildProfile(owner),false);
  assert.equal(f.calls.length,1);assert.equal(f.state.profileRefreshAttempts[owner].count,1);
  reply.resolve(newPortrait);assert.equal(await first,true);assert.equal(f.state.profiles[owner].text,newPortrait);
});

test('a failed active builder releases its lock and allows a later explicit retry',options,async t=>{
  const f=await fixture(t,{respond:async()=>{throw Error('synthetic first failure');}});
  await assert.rejects(f.native.buildProfile(owner,{automatic:true}),/synthetic first failure/);
  f.respond(async()=>newPortrait);assert.equal(await f.native.buildProfile(owner),true);assert.equal(f.calls.length,2);
});

test('a fact correction while generation is awaiting prevents a stale portrait from committing',options,async t=>{
  const entered=deferred(),reply=deferred();
  const f=await fixture(t,{respond:async()=>{entered.resolve();return reply.promise;}});
  const pending=f.native.buildProfile(owner,{automatic:true});await entered.promise;
  assert.equal(f.native.update('fact-'+owner+'-0',{text:'合成更正：现在沿绿色湖边散步。'}).ok,true);
  reply.resolve('合成过期画像不应落盘。');await assert.rejects(pending,/更新|忘记/);
  assert.notEqual(f.state.profiles[owner]?.text,'合成过期画像不应落盘。');assert.equal(f.state.dirtyProfiles[owner],true);
  assert.equal(f.state.profileRefreshAttempts[owner].failures,1);
});

test('a manual profile edit while generation is awaiting wins over the stale generated result',options,async t=>{
  const entered=deferred(),reply=deferred();
  const f=await fixture(t,{respond:async()=>{entered.resolve();return reply.promise;}});
  const pending=f.native.buildProfile(owner,{automatic:true});await entered.promise;
  assert.equal(f.native.savePersonaPerson(owner,{text:'合成手动修订画像。',alias:'合成新称呼'}).ok,true);
  const manual=structuredClone(f.state.profiles[owner]);reply.resolve('合成过期自动画像。');
  await assert.rejects(pending,/更新/);assert.deepEqual(f.state.profiles[owner],manual);assert.equal(f.state.profileRefreshAttempts[owner].failures,1);
});

test('a persona change while generation is awaiting cannot write a portrait under the new persona',options,async t=>{
  const entered=deferred(),reply=deferred();
  const f=await fixture(t,{respond:async()=>{entered.resolve();return reply.promise;}});
  const pending=f.native.buildProfile(owner,{automatic:true});await entered.promise;
  f.cfg.persona.current='synthetic-other-persona';reply.resolve('合成旧人格的画像。');
  await assert.rejects(pending,/更新/);assert.equal(f.state.profiles[owner].text,oldPortrait);
});

test('an owner change while generation is awaiting cannot commit the previous owner context',options,async t=>{
  const entered=deferred(),reply=deferred();
  const f=await fixture(t,{respond:async()=>{entered.resolve();return reply.promise;}});
  const pending=f.native.buildProfile(owner,{automatic:true});await entered.promise;
  f.cfg.ownerQQ='101';reply.resolve('合成旧主人上下文的过期画像。');
  await assert.rejects(pending,/更新/);assert.equal(f.state.profiles[owner].text,oldPortrait);
  assert.equal(f.state.profileRefreshAttempts[owner].count,1);assert.equal(f.state.profileRefreshAttempts[owner].failures,1);
});

test('disabled memory prevents automatic reservations and disabling during generation prevents a stale commit',options,async t=>{
  const entered=deferred(),reply=deferred();
  const f=await fixture(t,{respond:async()=>{entered.resolve();return reply.promise;}});
  f.cfg.memory.enabled=false;
  assert.equal(await f.native.buildProfile(owner,{automatic:true}),false);assert.equal(f.calls.length,0);assert.equal(f.state.profileRefreshAttempts,undefined);
  f.cfg.memory.enabled=true;const pending=f.native.buildProfile(owner,{automatic:true});await entered.promise;
  f.cfg.memory.enabled=false;reply.resolve('合成停用后不应写回的画像。');
  await assert.rejects(pending,/更新/);assert.equal(f.state.profiles[owner].text,oldPortrait);
  assert.equal(f.state.profileRefreshAttempts[owner].count,1);assert.equal(f.state.profileRefreshAttempts[owner].failures,1);
});
