import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHostAgentLifecycle} from '../extensions/aurabot/fish-world/host-runtime.mjs';

const SID='11111111-2222-4333-8444-555555555555',ALIAS='session-'+SID,OTHER='66666666-7777-4888-8999-aaaaaaaaaaaa';
let remotePromise;
async function installedRemote(t){
 if(!process.env.DSH_ASAR){t.skip('Set DSH_ASAR for installed RemoteError contract integration');return null;}
 remotePromise??=(async()=>{
  assert.ok(process.env.THINKSTAR_TEST_TMP,'Use the managed test runner');const asar=process.env.DSH_ASAR,fd=fs.openSync(asar,'r'),head=Buffer.alloc(16);let bytes;
  try{fs.readSync(fd,head,0,16,0);const raw=Buffer.alloc(head.readUInt32LE(12));fs.readSync(fd,raw,0,raw.length,16);const tree=JSON.parse(raw),find=p=>p.split('/').reduce((n,k)=>n?.files?.[k],tree),suffix='@deepseek-ai/dsh-typert-protocol/lib/types/remote-error.js',file=['dsh/node_modules/'+suffix,'node_modules/'+suffix].find(p=>find(p));assert.ok(file,'Installed RemoteError module is required');const entry=find(file);if(entry.unpacked)bytes=fs.readFileSync(asar+'.unpacked/'+file);else{bytes=Buffer.alloc(entry.size);fs.readSync(fd,bytes,0,bytes.length,8+head.readUInt32LE(4)+Number(entry.offset));}}
  finally{fs.closeSync(fd);}
  const folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'host-session-sdk-')),target=path.join(folder,'remote-error.mjs');fs.writeFileSync(target,bytes);return import(pathToFileURL(target).href);
 })();return remotePromise;
}
function fixture(RemoteError,{code='session/not-found',details={sessionId:SID},owned=true,agents=[],lookup=()=>null}={}){
 const calls=[],state={journal:[{id:'synthetic-unknown',status:'uncertain'}],outbox:[{id:'synthetic-delivery',state:'uncertain'}],round:{status:'uncertain'},plans:[{id:'synthetic-purpose',status:'pending'}]},before=structuredClone(state);
 const lifecycle=createHostAgentLifecycle({findAgent:id=>{assert.equal(id,SID);return lookup(id);},listAgents:()=>agents,ownsSession:id=>{assert.equal(id,SID);return owned;},resolveAgent:async id=>{calls.push(id);assert.equal(id,SID,'The SDK receives its canonical bare UUID, never the directory alias');return{error:new RemoteError(code,'Synthetic SDK failure; no live session was read',details)};}});
 return{lifecycle,calls,state,before};
}

test('actual installed RemoteError details and canonical SDK lookup prove only an owned absent agent has stopped',async t=>{
 const sdk=await installedRemote(t);if(!sdk)return;const {RemoteError}=sdk,error=new RemoteError('session/not-found','Synthetic missing session',{sessionId:SID});assert.equal(error.name,'RemoteError');assert.equal(error.code,'session/not-found');assert.equal(error.isDSHRemoteError,true);assert.deepEqual(error.details,{sessionId:SID});assert.equal(error.data,undefined);
 const f=fixture(RemoteError);await assert.rejects(f.lifecycle.resolve(ALIAS),e=>e instanceof RemoteError&&e.code==='session/not-found'&&e.details.sessionId===SID);await f.lifecycle.cancel(ALIAS);assert.equal(await f.lifecycle.idle(ALIAS),true);assert.equal(await f.lifecycle.ready(ALIAS),false);assert.equal(f.calls.length,4);assert.ok(f.calls.every(id=>id===SID));assert.deepEqual(f.state,f.before,'Agent absence never changes unknown world results, purposes or deliveries');
 t.diagnostic(JSON.stringify({actualInstalledRemoteError:true,syntheticSdkResolver:true,canonicalSdkCalls:f.calls.length,liveSessionReads:0,modelCalls:0,worldCalls:0,qqSends:0}));
});

test('real SDK writer-held and internal errors cannot be mistaken for a stopped agent',async t=>{
 const sdk=await installedRemote(t);if(!sdk)return;for(const code of ['session/writer-held','gateway/internal','session/agent-busy']){const f=fixture(sdk.RemoteError,{code});for(const method of ['cancel','idle','ready'])await assert.rejects(f.lifecycle[method](ALIAS),error=>error instanceof sdk.RemoteError&&error.code===code);assert.deepEqual(f.state,f.before);}
});

test('real not-found errors fail closed without the same target, ownership and a complete absent registry',async t=>{
 const sdk=await installedRemote(t);if(!sdk)return;
 for(const config of [{details:{sessionId:OTHER}},{details:{}},{owned:false},{agents:null},{agents:[{}]},{agents:[{session:{id:ALIAS}}]}]){const f=fixture(sdk.RemoteError,config);for(const method of ['cancel','idle'])await assert.rejects(f.lifecycle[method](ALIAS),error=>error instanceof sdk.RemoteError&&error.code==='session/not-found');assert.deepEqual(f.state,f.before);}
});

test('a concurrently present agent wins over actual typed remote absence and cannot be declared stopped',async t=>{
 const sdk=await installedRemote(t);if(!sdk)return;let lookups=0;const agent={session:{id:ALIAS}},f=fixture(sdk.RemoteError,{lookup:()=>++lookups>=2?agent:null});await assert.rejects(f.lifecycle.idle(ALIAS),error=>error instanceof sdk.RemoteError&&error.code==='session/not-found');assert.equal(lookups,2);assert.deepEqual(f.state,f.before);
});
