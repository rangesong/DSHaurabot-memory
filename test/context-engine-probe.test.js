import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createEngineProbe,existingImageProof} from '../extensions/aurabot/history-vault/existing-engine.mjs';
import {installMemoContextDedup} from '../extensions/aurabot/history-vault/context-dedup.mjs';

const origin='http://127.0.0.1:18788',manifest={version:'fixture-1',commit:'fixture-build'};
const response=()=>({ok:true,json:async()=>manifest});
test('unresponsive read-only probe has a deadline, coalesces requests and cools down without late work',async()=>{
 let clock=0,calls=0,aborted=false;
 const probe=createEngineProbe({now:()=>clock,timeoutMs:20,retryAfterMs:100,fetcher:async(_url,{signal})=>{calls++;signal.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});}});
 const start=performance.now(),[one,two]=await Promise.all([probe(origin),probe(origin)]);
 assert.equal(one.held,'engine-probe-unavailable');assert.deepEqual(two,one);assert.equal(calls,1);assert.equal(aborted,true);assert.ok(performance.now()-start<1000);
 clock=99;assert.equal((await probe(origin)).held,'engine-probe-cooldown');assert.equal(calls,1);
});
test('unavailable engine skips session reads and writes; cooldown expiry allows recovery and fresh version checks',async()=>{
 let clock=0,calls=0,up=false,reads=0,writes=0;
 const probe=createEngineProbe({now:()=>clock,retryAfterMs:100,fetcher:async()=>{calls++;if(!up)throw Error('offline');return response();}});
 const folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'engine-probe-')),events=[{seq:0,type:'permission/preset',data:{}}];
 const cfg={contextCompressionOrigin:origin,contextEngine:'existing',contextDedupEnabled:true},hooks=new Map();
 const api={config:()=>({ownerQQ:'10001',persona:{current:'fixture'}}),dataDir:n=>path.join(folder,n),core:{hub:{chatOfSession:()=> 'private:10001'}},dsh:{get:n=>n==='sessionQuery'?{readSurface:async()=>{reads++;return {capturedThroughSeq:0,events};},readSession:async()=>{reads++;return {events};}}:null,on:(n,fn)=>{hooks.set(n,fn);return()=>{};}},route(){},tool(){},onDispose(){},log:{warn(){}}};
 const governance=installMemoContextDedup(api,()=>cfg,{engineProbe:probe}),agent={session:{id:'fixture-session',seq:1,append(){writes++;}}};
 let next=0;await hooks.get('agent/request')({agent},()=>{next++;});assert.equal(next,1);assert.equal(reads,0);assert.equal(writes,0);assert.equal(calls,1);assert.equal(governance.status().last.held,'engine-probe-unavailable');
 up=true;clock=50;assert.equal((await governance.prepare(agent)).held,'engine-probe-cooldown');assert.equal(calls,1);assert.equal(reads,0);
 clock=100;assert.equal((await governance.prepare(agent)).applied,false);assert.equal(reads,2);assert.equal(calls,2);assert.equal(writes,0);
 await governance.prepare(agent);assert.equal(calls,3); // Successful manifests are never reused across requests.
});
test('origin changes bypass old failure cooldown and image proof still refuses version/commit mismatch',async()=>{
 let calls=0;
 const probe=createEngineProbe({fetcher:async url=>{calls++;if(url.startsWith(origin+'/'))throw Error('offline');return response();}});
 await probe(origin);assert.equal((await probe('http://127.0.0.1:18789')).ok,true);assert.equal(calls,2);
 const folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'image-proof-')),api={dataDir:n=>path.join(folder,n)},scope={sessionId:'fixture',chatId:'private:10001',persona:'fixture'};
 const plan={scope,backupReceipt:{verified:true},imageCompatibility:{verified:true,allImageRefsBlocked:true,noImagesInCompressedSubstrate:true,allExistingBlocksPreservedEvenIfAllImagesRemoved:true,engineVersion:manifest.version,engineCommit:manifest.commit}};
 fs.writeFileSync(api.dataDir('context-governance-plan.json'),JSON.stringify(plan));
 const noFetch=async()=>{throw Error('duplicate network request');};
 assert.equal(await existingImageProof(api,()=>({}),scope,{manifest,fetcher:noFetch}),true);
 assert.equal(await existingImageProof(api,()=>({}),scope,{manifest:{...manifest,commit:'new-build'},fetcher:noFetch}),false);
 assert.equal(await existingImageProof(api,()=>({}),scope,{manifest:{...manifest,version:'new-version'},fetcher:noFetch}),false);
});
