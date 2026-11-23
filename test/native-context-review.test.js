import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {reviewNativeContext} from '../adapters/aurabot/native/context-review.js';
import {NATIVE_CONTEXT_PATCH,patchNativeContextReview} from '../scripts/lib/native-context-patch.js';

const OWNER='10000001',OTHER='10000002',PERSONA='synthetic-persona';
const clone=structuredClone;
const emptyPlan=()=>({schema:1,owner:OWNER,persona:PERSONA});
const scope={owner:OWNER,persona:PERSONA};
function store(){
  const state={rev:1,relations:[
    {id:'relation-owner',subj:'synthetic-owner',subjQq:OWNER,pred:'synthetic',obj:'synthetic-bot',objQq:'',chatId:'private:'+OWNER,speaker:OWNER,at:123},
    {id:'relation-other',subj:'other',subjQq:OTHER,pred:'untouched',obj:'third',objQq:'10000003',chatId:'group:30000001',speaker:OTHER,at:456}],
    insights:{['qq:'+OWNER]:[{id:'insight-one',text:'synthetic before one',at:100,extra:{preserve:true}},{id:'insight-two',text:'synthetic before two',at:200},{id:'insight-keep',text:'keep insight',at:300}],['qq:'+OTHER]:[{id:'other-insight',text:'untouched',at:400}]},
    styles:{['qq:'+OWNER]:['synthetic style before','keep second style'],['qq:'+OTHER]:['untouched other style']}};
  const calls=[],hooks={};
  function write(kind,op){calls.push(kind);hooks.before?.(kind,state);op();state.rev++;hooks.after?.(kind,state);return {ok:true};}
  const memory={
    list:()=>[],
    personaPerson:owner=>({person:{qq:owner},relations:clone(state.relations.filter(row=>row.subjQq===owner||row.objQq===owner)).map(row=>({...row,text:row.subj+' '+row.pred+' '+row.obj}))}),
    insights:()=>Object.entries(state.insights).map(([key,list])=>({key,name:'synthetic',list:clone(list)})),
    styles:()=>clone(state.styles),
    setInsights:(key,list)=>write('insights',()=>{state.insights[key]=clone(list);}),
    setStyle:(key,list)=>write('styles',()=>{state.styles[key]=clone(list);}),
    deleteRelation:id=>write('delete',()=>{state.relations=state.relations.filter(row=>row.id!==id);}),
    saveRelation:row=>write('restore-relation',()=>{state.relations=state.relations.filter(old=>old.id!==row.id);state.relations.push(clone(row));})};
  const plan=()=>{const before=reviewNativeContext(memory,emptyPlan(),scope).before;return {...emptyPlan(),deleteRelations:[{id:'relation-owner',from:before.relations.find(row=>row.id==='relation-owner')}],
    insights:[{id:'insight-one',from:'synthetic before one',to:'synthetic after one'},{id:'insight-two',from:'synthetic before two',to:'synthetic after two'}],
    styles:[{index:0,from:'synthetic style before',to:'先完整回应文字，再适量用口头禅和表情'}]};};
  return {memory,state,calls,hooks,plan};
}
const preview=(f,plan=f.plan())=>reviewNativeContext(f.memory,plan,scope);
const apply=(f,plan=f.plan(),expectedHash=preview(f,plan).snapshotHash)=>reviewNativeContext(f.memory,plan,{...scope,apply:true,expectedHash});
const semantic=state=>({...clone(state),rev:0,relations:clone(state.relations).sort((a,b)=>a.id.localeCompare(b.id))});

test('native context preview is read only and preserves full target metadata in the proposed result',()=>{
  const f=store(),before=clone(f.state),p=preview(f);
  assert.equal(p.applied,false);assert.equal(f.calls.length,0);assert.deepEqual(f.state,before);
  assert.deepEqual(p.after.insights[0],{...before.insights['qq:'+OWNER][0],text:'synthetic after one'});
  assert.equal(p.after.insights[0].at,100);assert.equal(p.after.insights[0].id,'insight-one');
});
test('native context apply changes only the selected records and deletes relation last',()=>{
  const f=store(),before=clone(f.state),result=apply(f);
  assert.equal(result.applied,true);assert.deepEqual(f.calls,['insights','styles','delete']);
  assert.deepEqual(f.state.relations,[before.relations[1]]);assert.deepEqual(f.state.insights['qq:'+OTHER],before.insights['qq:'+OTHER]);
  assert.deepEqual(f.state.styles['qq:'+OTHER],before.styles['qq:'+OTHER]);assert.deepEqual(f.state.insights['qq:'+OWNER][2],before.insights['qq:'+OWNER][2]);
  assert.equal(f.state.styles['qq:'+OWNER][1],before.styles['qq:'+OWNER][1]);assert.equal(preview(f,emptyPlan()).snapshotHash,result.resultHash);
});
test('hash and each id/from CAS are checked before any write',()=>{
  for(const mutate of [p=>{p.insights[1].from='stale';},p=>{p.styles[0].from='stale';},p=>{p.deleteRelations[0].from.at=999;}]){
    const f=store(),p=f.plan();mutate(p);assert.throws(()=>apply(f,p),/conflict/);assert.deepEqual(f.calls,[]);
  }
  const f=store();assert.throws(()=>apply(f,f.plan(),'0'.repeat(64)),/stale-snapshot/);assert.deepEqual(f.calls,[]);
  const p=f.plan(),hash=preview(f,p).snapshotHash;f.state.insights['qq:'+OWNER][2].text='concurrent change';
  assert.throws(()=>apply(f,p,hash),/stale-snapshot/);assert.deepEqual(f.calls,[]);
});
test('scope, strict fields, duplicate targets, nonboolean apply, and excess styles are refused',()=>{
  for(const mutate of [p=>{p.owner=OTHER;},p=>{p.persona='other-persona';},p=>{p.extra=true;},p=>{p.insights[1]={...p.insights[0]};},p=>{p.styles.push({index:1,from:'keep second style',to:'other'});},p=>{p.styles[0].to='x'.repeat(41);}]){
    const f=store(),p=f.plan();mutate(p);assert.throws(()=>apply(f,p),/context-review-/);assert.deepEqual(f.calls,[]);
  }
  const f=store();assert.throws(()=>reviewNativeContext(f.memory,f.plan(),{...scope,apply:'true'}),/invalid-request/);assert.deepEqual(f.calls,[]);
  const pollution=JSON.parse('{"schema":1,"owner":"10000001","persona":"synthetic-persona","__proto__":{"polluted":true}}');
  assert.throws(()=>preview(f,pollution),/invalid-plan/);assert.equal({}.polluted,undefined);
});
test('a relation visible by name alone cannot be deleted without owner provenance',()=>{
  const f=store(),original=f.memory.personaPerson;
  f.memory.personaPerson=owner=>{const result=original(owner);result.relations[0].subjQq=OTHER;result.relations[0].speaker=OTHER;return result;};
  assert.throws(()=>preview(f),/relation-outside-owner/);assert.deepEqual(f.calls,[]);
});
test('write failure reverses semantic records, preserves id/at, and states revision/order limitations',()=>{
  const f=store(),before=semantic(f.state);let once=true;
  f.hooks.after=kind=>{if(kind==='delete'&&once){once=false;throw Error('synthetic failure after mutation');}};
  assert.throws(()=>apply(f),error=>{
    assert.equal(error.code,'context-review-apply-failed');assert.equal(error.rollback.semantic_records_restored,true);
    assert.equal(error.rollback.limitations.revisionRestored,false);assert.equal(error.rollback.limitations.relationOrderRestored,false);return true;
  });
  assert.deepEqual(semantic(f.state),before);assert.equal(f.state.relations.find(row=>row.id==='relation-owner').text,undefined);
  assert.deepEqual(f.calls,['insights','styles','delete','restore-relation','styles','insights']);
});
test('rollback failure is reported without falsely asserting restored records',()=>{
  const f=store();let deleted=false;
  f.hooks.after=kind=>{if(kind==='delete'){deleted=true;throw Error('synthetic deletion failure');}};
  f.hooks.before=kind=>{if(kind==='restore-relation'&&deleted)throw Error('synthetic restore failure');};
  assert.throws(()=>apply(f),error=>{assert.equal(error.rollback.semantic_records_restored,false);assert.deepEqual(error.rollback.failures,[{section:'relation',code:'restore-failed'}]);return true;});
});
test('readback mismatch triggers reversal rather than success',()=>{
  const f=store(),before=semantic(f.state);let once=true;
  f.hooks.after=(kind,state)=>{if(kind==='styles'&&once){once=false;state.styles['qq:'+OWNER][0]='synthetic rejected write';}};
  assert.throws(()=>apply(f),error=>error.rollback.semantic_records_restored===true);assert.deepEqual(semantic(f.state),before);
});

const nativeDir=process.env.AURABOT_NATIVE_MEMORY_SOURCE;
const installed=!!nativeDir&&fs.existsSync(path.join(nativeDir,'index.mjs'));
const scratch=process.env.THINKSTAR_TEST_TMP;
const host=process.env.AURABOT_SOURCE;
let nativeModule,originalSource,scopeCoreForModule;
if(host)({scopeCoreForModule}=await import(pathToFileURL(path.join(host,'src/core/modules.js')).href));
if(installed){
  assert.ok(scratch,'Run through scripts/run-tests.js');originalSource=fs.readFileSync(process.env.AURABOT_NATIVE_MEMORY_BASELINE||path.join(nativeDir,'index.mjs'),'utf8');
  const staged=path.join(scratch,'native-context-module');fs.mkdirSync(staged,{recursive:true});
  fs.writeFileSync(path.join(staged,'index.mjs'),patchNativeContextReview(originalSource,{version:NATIVE_CONTEXT_PATCH.version}).source);
  fs.copyFileSync(new URL('../adapters/aurabot/native/context-review.js',import.meta.url),path.join(staged,'context-review.js'));
  fs.writeFileSync(path.join(staged,'memory.js'),"export const createMemoryStore=()=>globalThis.__nativeContextSyntheticMemory; export const memoryLine=()=>''; export const looksLikeRuleMemory=()=>false; export const parseValidityDate=()=>0;\n");
  const previous=globalThis.aurabot;globalThis.aurabot={lib:()=>({})};
  try{nativeModule=(await import(pathToFileURL(path.join(staged,'index.mjs')).href)).default;}finally{if(previous===undefined)delete globalThis.aurabot;else globalThis.aurabot=previous;}
}
const active={skip:!installed};
function moduleFixture({agents,patched=true,patchVersion=patched?'thinkstar-owner-reply-boundaries-v1':undefined,plugins,hmr=true}={}){
  const f=store(),dir=fs.mkdtempSync(path.join(scratch,'native-maintenance-')),routes=new Map(),reloads=[],toolRegistrations=[];
  const entries=plugins??[{entryId:'synthetic-aurabot-entry',moduleName:'dsh-aurabot-qq',patchId:'synthetic-patch',enabled:true}];
  const agentList=agents??[{session:{id:'owned-session'},status:'idle',inbox:{hasPending:false,nextStep:[],nextTurn:[]}}];
  const manager={listPlugins:async()=>clone(entries),setPluginEnabled:async(id,enabled)=>{reloads.push({id,enabled});return {application:'applied',applied:true,restartReason:null};}};
  const hub={chatOfSession:id=>id.startsWith('owned-')?'private:'+OWNER:null,onSessionEvent:patched?function(){beginOwnerReplyBatch();sealOwnerReply();finishOwnerReplies();}:function(){},subagentFor:()=>()=>{}};
  if(patchVersion!==undefined)Object.defineProperty(hub,'ownerReplyPatchVersion',{get:()=>patchVersion,enumerable:true});
  const core={hub,http:{body:async req=>clone(req.body)}};
  const api={core:scopeCoreForModule?scopeCoreForModule(core,'memory'):core,dsh:{get:name=>({pluginManager:manager,agents:{list:()=>agentList},hmr:hmr?{}:null})[name]},
    config:()=>({ownerQQ:OWNER,persona:{current:PERSONA},memory:{}}),dataDir:(...parts)=>path.join(dir,...parts),
    route:(name,fn,options)=>routes.set(name,{fn,options}),context:()=>{},on:()=>{},every:()=>{},tool:fn=>toolRegistrations.push(fn),use:()=>null,log:{},setConfig:()=>{}};
  const previous=globalThis.__nativeContextSyntheticMemory;globalThis.__nativeContextSyntheticMemory=f.memory;
  try{assert.equal(nativeModule.setup(api),f.memory);}finally{if(previous===undefined)delete globalThis.__nativeContextSyntheticMemory;else globalThis.__nativeContextSyntheticMemory=previous;}
  const call=(route,body,method='POST')=>routes.get('/maintenance/'+route).fn({method,body});
  return {...f,dir,routes,manager,hub,api,entries,agentList,reloads,toolRegistrations,call};
}
async function receiptSettled(file){for(let i=0;i<40;i++){const receipt=JSON.parse(fs.readFileSync(file,'utf8'));if(receipt.status!=='prepared')return receipt;await new Promise(setImmediate);}throw Error('Synthetic maintenance did not settle');}

test('native context patch rejects unknown version/hash and is exact and idempotent',active,()=>{
  assert.throws(()=>patchNativeContextReview(originalSource,{version:'unknown'}),/version/);
  assert.throws(()=>patchNativeContextReview(originalSource+'\n',{version:NATIVE_CONTEXT_PATCH.version}),/hash/);
  const first=patchNativeContextReview(originalSource,{version:NATIVE_CONTEXT_PATCH.version}),again=patchNativeContextReview(first.source,{version:NATIVE_CONTEXT_PATCH.version});
  assert.equal(first.receipt.unchanged,false);assert.equal(again.receipt.unchanged,true);assert.equal(first.source,again.source);
  const deployed=fs.readFileSync(path.join(nativeDir,'index.mjs'),'utf8');
  assert.equal(patchNativeContextReview(deployed,{version:NATIVE_CONTEXT_PATCH.version}).source,first.source);
});
test('actual fork module registers all maintenance routes as panel-only and offers no new model tool',active,()=>{
  const f=moduleFixture();for(const route of ['context-review','host-status','host-reload'])assert.deepEqual(f.routes.get('/maintenance/'+route).options,{access:'panel'});
  assert.equal(f.toolRegistrations.length,1);
});
test('context route previews without receipts, then writes prepared receipt before every store change',active,async()=>{
  const f=moduleFixture(),p=f.plan(),result=await f.call('context-review',{plan:p});
  assert.equal(result.ok,true);assert.equal(result.applied,false);assert.deepEqual(fs.readdirSync(f.dir),[]);assert.deepEqual(f.calls,[]);
  f.hooks.before=()=>{const files=fs.readdirSync(path.join(f.dir,'context-review-receipts'));assert.equal(files.length,1);assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'context-review-receipts',files[0]),'utf8')).status,'prepared');};
  const applied=await f.call('context-review',{plan:p,apply:true,expectedHash:result.snapshotHash});
  assert.equal(applied.ok,true);assert.equal(applied.applied,true);assert.equal(JSON.parse(fs.readFileSync(applied.receiptPath,'utf8')).status,'applied');
});
test('context route stale hash or prepared receipt failure makes no data change',active,async()=>{
  const f=moduleFixture(),p=f.plan(),before=clone(f.state),preview=await f.call('context-review',{plan:p});
  assert.equal((await f.call('context-review',{plan:p,apply:true,expectedHash:'stale'})).ok,false);assert.deepEqual(f.calls,[]);
  fs.writeFileSync(path.join(f.dir,'context-review-receipts'),'synthetic blocker');
  const result=await f.call('context-review',{plan:p,apply:true,expectedHash:preview.snapshotHash});
  assert.equal(result.ok,false);assert.deepEqual(f.calls,[]);assert.deepEqual(f.state,before);assert.equal('stack' in result,false);
});
test('context route failure returns only stable code and accurate logical rollback receipt',active,async()=>{
  const f=moduleFixture(),p=f.plan(),preview=await f.call('context-review',{plan:p});let once=true;
  f.hooks.after=kind=>{if(kind==='styles'&&once){once=false;throw Error('synthetic private failure detail');}};
  const result=await f.call('context-review',{plan:p,apply:true,expectedHash:preview.snapshotHash});
  assert.equal(result.code,'context-review-apply-failed');assert.equal(result.rollback.semantic_records_restored,true);
  assert.equal(JSON.stringify(result).includes('synthetic private failure detail'),false);assert.equal(JSON.parse(fs.readFileSync(result.receiptPath,'utf8')).status,'failed');
});
test('host status checks only Aurabot agent ownership and reports loaded patch marker as a boolean',active,async()=>{
  const f=moduleFixture({agents:[{session:{id:'owned-session'},status:'idle',inbox:{hasPending:false,nextStep:[],nextTurn:[]}},{session:{id:'unrelated-session'},status:'busy'}]});
  const status=await f.call('host-status',undefined,'GET');assert.equal(status.quiescent,true);assert.equal(status.agents.length,1);assert.equal(status.ownerReplyPatchLoaded,true);assert.equal(status.hmrAvailable,true);
  assert.equal(JSON.stringify(status).includes('owned-session'),false);
  assert.equal((await moduleFixture({patched:false}).call('host-status',undefined,'GET')).ownerReplyPatchLoaded,false);
  assert.equal((await moduleFixture({patchVersion:'unknown-old-version'}).call('host-status',undefined,'GET')).ownerReplyPatchLoaded,false);
});
test('actual host scope makes function-source probing false while the runtime getter remains observable', {skip:!installed||!scopeCoreForModule},async()=>{
  const f=moduleFixture();assert.notEqual(f.api.core.hub,f.hub);
  assert.equal(Function.prototype.toString.call(f.api.core.hub.onSessionEvent).includes('beginOwnerReplyBatch('),false);
  assert.equal((await f.call('host-status',undefined,'GET')).ownerReplyPatchLoaded,true);
  assert.equal(Reflect.set(f.api.core.hub,'ownerReplyPatchVersion','unknown'),false);
});
test('host reload refuses owned busy, pending, and unknown inbox states; leaves all agents untouched',active,async()=>{
  for(const agent of [{session:{id:'owned-session'},status:'busy',inbox:{hasPending:false,nextStep:[],nextTurn:[]}},{session:{id:'owned-session'},status:'idle',inbox:{hasPending:true,nextStep:[],nextTurn:[]}},{session:{id:'owned-session'},status:'idle',inbox:{hasPending:false,nextStep:[{}],nextTurn:[]}},{session:{id:'owned-session'},status:'idle'}]){
    const f=moduleFixture({agents:[agent]}),before=clone(agent),result=await f.call('host-reload',{id:'synthetic-aurabot-entry'});
    assert.equal(result.code,'host-maintenance-owned-agents-busy');assert.deepEqual(f.reloads,[]);assert.deepEqual(agent,before);
  }
});
test('host reload rejects arbitrary entry, duplicate Aurabot entries, disabled and readonly plugin',active,async()=>{
  const f=moduleFixture();assert.equal((await f.call('host-reload',{id:'other-entry'})).ok,false);assert.deepEqual(f.reloads,[]);
  for(const plugins of [[...f.entries,...f.entries],[{...f.entries[0],enabled:false}],[{...f.entries[0],readOnlyReason:'synthetic readonly'}]]){
    const fixture=moduleFixture({plugins});assert.equal((await fixture.call('host-reload',{id:'synthetic-aurabot-entry'})).ok,false);assert.deepEqual(fixture.reloads,[]);
  }
});
test('official same-true reload has prepared receipt first and finishes with captured writer after module disposal',active,async()=>{
  const f=moduleFixture();let preparedPath;
  f.manager.setPluginEnabled=async(id,enabled)=>{f.reloads.push({id,enabled});const files=fs.readdirSync(path.join(f.dir,'context-review-receipts'));preparedPath=path.join(f.dir,'context-review-receipts',files[0]);assert.equal(JSON.parse(fs.readFileSync(preparedPath,'utf8')).status,'prepared');f.api.dataDir=()=>{throw Error('synthetic disposed API');};return {application:'applied',applied:true,restartReason:null};};
  const result=await f.call('host-reload',{id:'synthetic-aurabot-entry'});assert.equal(result.accepted,true);
  const receipt=await receiptSettled(result.receiptPath);assert.equal(result.receiptPath,preparedPath);assert.deepEqual(f.reloads,[{id:'synthetic-aurabot-entry',enabled:true}]);
  assert.equal(receipt.status,'settled');assert.deepEqual(receipt.result,{application:'applied',applied:true,restartReason:null});
});
test('parallel host reload requests reserve once after asynchronous status check',active,async()=>{
  const f=moduleFixture(),results=await Promise.all([f.call('host-reload',{id:'synthetic-aurabot-entry'}),f.call('host-reload',{id:'synthetic-aurabot-entry'})]);
  assert.equal(results.filter(result=>result.accepted).length,1);assert.equal(results.filter(result=>result.code==='host-maintenance-reload-pending').length,1);
  await receiptSettled(results.find(result=>result.accepted).receiptPath);assert.equal(f.reloads.length,1);
});
test('host reload rechecks owned idle immediately before official call and records changed precondition',active,async()=>{
  const f=moduleFixture();let lists=0;f.manager.listPlugins=async()=>{if(++lists===2)f.agentList[0].status='busy';return clone(f.entries);};
  const result=await f.call('host-reload',{id:'synthetic-aurabot-entry'}),receipt=await receiptSettled(result.receiptPath);
  assert.equal(receipt.status,'blocked');assert.deepEqual(f.reloads,[]);
});
