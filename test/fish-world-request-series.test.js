import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
import {installWorldRequestSeries} from '../extensions/aurabot/fish-world/world-request-series.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {estimateTokens} from '../extensions/aurabot/fish-world/governance.mjs';

const base='synthetic-world-base',windowKey='cw:synthetic-window',route='system:ext-fish-world:'+windowKey;
function fixture(){
 const controller=new AbortController(),identity={owner:'synthetic-owner',persona:'synthetic-persona'},session={id:'session-request-proof'},agent={session},events=new Map();
 const life={...identity,revision:4,contextWindow:{base,key:windowKey,windows:[{key:windowKey,sessionId:session.id}]},round:{id:'life-round-1',sessionId:session.id,status:'running',revision:4},days:{today:{calls:2}},outbox:[{id:'keep-partial',state:'uncertain',receipts:['keep-receipt']}]};
 const engine={l:life,closed:false,bridge:{},authorized:()=>true,cfg:{autonomy:true,stopped:false,observeOnly:false}},options={getEngine:()=>engine,identity:()=>identity,scope:()=>base,chatOfSession:()=>route};
 const dsh={on(name,fn){events.set(name,fn);return ()=>events.delete(name);}},off=installWorldRequestSeries(dsh,options),proposal={agent,turn:1,step:1,signal:controller.signal};
 return {controller,identity,session,agent,life,engine,options,events,off,proposal,invoke:decision=>events.get('agent/pre-step')(proposal,async()=>decision)};
}
test('only the current owned first step starts a series, preserving the native decision and ledger',async()=>{
 const f=fixture(),decision={kind:'enter',messages:[{synthetic:true}],other:'keep'},before=structuredClone(f.life),result=await f.invoke(decision);
 assert.notEqual(result,decision);assert.equal(result.startsRequestSeries,true);assert.equal(result.messages,decision.messages);assert.equal(result.other,'keep');assert.equal(decision.startsRequestSeries,undefined);assert.deepEqual(f.life,before);
 f.proposal.step=2;assert.equal(await f.invoke(decision),decision);f.off();assert.equal(f.events.size,0);
});
test('native reject, abort, foreign scopes and changed contexts cannot be rewritten',async()=>{
 const reject=fixture(),blocked={kind:'reject',reason:'native-policy'};assert.equal(await reject.invoke(blocked),blocked);
 for(const mutate of [f=>{f.identity.owner='other';},f=>{f.identity.persona='other';},f=>{f.life.contextWindow.base='other';},f=>{f.life.contextWindow.windows[0].sessionId='other';},f=>{f.proposal.agent={session:{id:'other'}};},f=>{f.options.chatOfSession=()=> 'private:synthetic-owner';},f=>{f.life.round.revision++;},f=>{f.life.round.status='stopping';},f=>{f.controller.abort();},f=>{f.engine.closed=true;}]){
  const f=fixture();mutate(f);if(f.options.chatOfSession().startsWith('private:')){f.off();f.off=installWorldRequestSeries({on:(n,fn)=>(f.events.set(n,fn),()=>f.events.delete(n))},f.options);}
  const decision={kind:'enter',messages:[]};assert.equal(await f.invoke(decision),decision);
 }
 for(const mutate of [f=>{f.identity.persona='new';},f=>{f.life.round.id='new-round';},f=>{f.controller.abort();}]){
  const f=fixture(),decision={kind:'enter',messages:[]},result=await f.events.get('agent/pre-step')(f.proposal,async()=>{mutate(f);return decision;});assert.equal(result,decision);
 }
 const failed=fixture();await assert.rejects(()=>failed.events.get('agent/pre-step')(failed.proposal,async()=>{throw Error('native failure');}),/native failure/);
});

function extractSdk(asar,scratch){
 assert.ok(scratch,'Run through scripts/run-tests.js');const fd=fs.openSync(asar,'r'),head=Buffer.alloc(16);fs.readSync(fd,head,0,16,0);const hs=head.readUInt32LE(4),raw=Buffer.alloc(head.readUInt32LE(12));fs.readSync(fd,raw,0,raw.length,16);const tree=JSON.parse(raw),target=path.join(scratch,'request-series-sdk'),queue=['@deepseek-ai/dsh-agent-loop'],seen=new Set();
 const find=p=>{let n=tree;for(const part of p.split('/'))n=n?.files?.[part];return n;};fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'package.json'),'{"type":"module"}');
 try{while(queue.length){const pkg=queue.shift();if(seen.has(pkg))continue;seen.add(pkg);const prefix=['dsh/node_modules/'+pkg,'node_modules/'+pkg].find(p=>find(p));assert.ok(prefix,'Missing installed SDK package '+pkg);
  function copy(node,relative=''){for(const[name,entry]of Object.entries(node.files||{})){const rel=relative?relative+'/'+name:name;if(entry.files){copy(entry,rel);continue;}if(!/\.(js|mjs|cjs|json)$/.test(name))continue;let bytes;if(entry.unpacked)bytes=fs.readFileSync(asar+'.unpacked/'+prefix+'/'+rel);else{bytes=Buffer.alloc(entry.size);fs.readSync(fd,bytes,0,bytes.length,8+hs+Number(entry.offset));}const file=path.join(target,'node_modules',pkg,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);if(/\.(js|mjs|cjs)$/.test(name))for(const match of bytes.toString().matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)){const spec=match[1];if(spec.startsWith('.')||spec.startsWith('node:'))continue;queue.push(spec.startsWith('@')?spec.split('/').slice(0,2).join('/'):spec.split('/')[0]);}}}copy(find(prefix));
 }}finally{fs.closeSync(fd);}return target;
}
let sdkPromise;
async function installed(t){
 if(!process.env.DSH_ASAR){t.skip('Set DSH_ASAR for actual SDK series projection proof');return null;}
 sdkPromise??=(async()=>{const root=extractSdk(process.env.DSH_ASAR,process.env.THINKSTAR_TEST_TMP),load=p=>import(pathToFileURL(path.join(root,'node_modules',p,'lib/index.js')).href);
  const sdk=Object.assign({},...await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-session','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-scope'].map(load))),source=fs.readFileSync(path.join(root,'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'),'utf8');
  const textOf=source.match(/function textOf\(message\) \{[\s\S]*?\n\}/u)?.[0],begin=source.indexOf('var SystemPromptProjection = class'),end=source.indexOf('var RuntimeContextProjection = class',begin);assert.ok(textOf&&begin>0&&end>begin);
  sdk.SystemPromptProjection=vm.runInNewContext(textOf+'\n'+source.slice(begin,end)+'\nSystemPromptProjection',{createSystemMessage:sdk.createSystemMessage});return sdk;
 })();return sdkPromise;
}
async function nativeFixture(t,sdk,patched){
 const f=fixture(),ctx=new sdk.Context(),session=sdk.Session.create('session-request-proof',[]),agent={session};
 const scoped=sdk.createScope(ctx,agent);agent.ctx=scoped.ctx;f.session=session;f.agent=agent;f.proposal.agent=agent;
 const dispatch=sdk.agentEvents(ctx,agent);if(patched)f.nativeOff=installWorldRequestSeries(ctx,f.options);
 t.after(async()=>{f.nativeOff?.();await scoped.dispose();await ctx.dispose?.();});
 return {...f,ctx,dispatch,projection:new sdk.SystemPromptProjection(session)};
}
function prompt(swapped=false){const a='Synthetic rule A '+'.'.repeat(199),b='Synthetic rule B '+'.'.repeat(199),tail=swapped?b+'\n'+a:a+'\n'+b;return 'S'.repeat(39879-Buffer.byteLength(tail))+tail;}
function project(f,text,decision,turn,step){for(const item of f.projection.project(text,{inHistory:true,startsSeries:decision.startsRequestSeries===true}))f.session.append('system/message',{turn,step,message:item.message},item.intent);}
const nonSystem=f=>structuredClone(f.session.deriveMessages().filter(m=>m.role!=='system'));
function appendUser(f,text,id){f.session.append('user/message',{id,role:'user',content:[{type:'text',text}],source:{kind:'aurabot',speaker:{role:'owner',chat:'system'}}},{surfaceOp:'append'});}
function appendAssistant(f,text,turn,step,id){f.session.append('assistant/message',{turn,step,message:{id,role:'assistant',content:[{type:'text',text}]}},{surfaceOp:'append'});}
const toolSchemas=()=>{const tools=Array.from({length:19},(_,i)=>({name:'synthetic_'+i,description:'',parameters:{type:'object',properties:{}}}));tools[0].description='D'.repeat(17020-Buffer.byteLength(JSON.stringify(tools)));return tools;};
async function firstRound(f,sdk){
 f.session.append('turn/start',{turn:1});f.session.append('step/start',{turn:1,step:1});
 const decision=await f.dispatch.waterfall('agent/pre-step',{turn:1,step:1,signal:f.controller.signal},()=>Promise.resolve({kind:'enter',messages:[]}));project(f,prompt(),decision,1,1);
 appendUser(f,'U'.repeat(21000),'user-one');appendAssistant(f,'Synthetic thought before a read',1,1,'assistant-before-read');
 f.session.append('tool/call',{turn:1,step:1,callId:'read-one',name:'synthetic_read',arguments:'{}'});
 f.session.append('tool/result',{turn:1,step:1,message:sdk.createToolResultMessage({callId:'read-one',content:[{type:'text',text:'T'.repeat(12000)}],isError:false})},{surfaceOp:'append'});
 appendAssistant(f,'F'.repeat(504),1,1,'assistant-final');f.session.append('step/end',{turn:1,step:1});f.session.append('turn/end',{turn:1,reason:{kind:'completed'}});
 return estimateTokens({messages:f.session.deriveMessages(),tools:toolSchemas()});
}
test('actual Cordis/AgentLoop fused events reproduce the 64k second-round failure, and native series fixes it without losing conversation',async t=>{
 const sdk=await installed(t);if(!sdk)return;let unpatched,patched;
 for(const enabled of [false,true]){
  const f=await nativeFixture(t,sdk,enabled),firstTokens=await firstRound(f,sdk),original=nonSystem(f),ledger=structuredClone(f.life);f.life.round.id='life-round-2';
  f.session.append('turn/start',{turn:2});f.session.append('step/start',{turn:2,step:1});
  const decision=await f.dispatch.waterfall('agent/pre-step',{turn:2,step:1,signal:f.controller.signal},()=>Promise.resolve({kind:'enter',messages:[],native:'preserved'}));
  assert.equal(decision.native,'preserved');assert.equal(decision.startsRequestSeries===true,enabled);project(f,prompt(true),decision,2,1);assert.deepEqual(nonSystem(f),original);
  appendUser(f,'N'.repeat(3483),'user-two');const tokens=estimateTokens({messages:f.session.deriveMessages(),tools:toolSchemas()}),systems=f.session.deriveMessages().filter(m=>m.role==='system'&&m.content.some(b=>b.text));
  assert.equal(systems.length,enabled?1:2);assert.equal(systems.at(-1).content[0].text,prompt(true));assert.deepEqual(f.life.days,ledger.days);assert.deepEqual(f.life.outbox,ledger.outbox);
  assert.ok(firstTokens>40000&&firstTokens<50000);if(enabled){assert.ok(tokens<64000);patched={firstTokens,tokens};}else{assert.ok(tokens>64000);unpatched={firstTokens,tokens};}
  if(enabled){
   const before=f.session.snapshotEvents().length,step2=await f.dispatch.waterfall('agent/pre-step',{turn:2,step:2,signal:f.controller.signal},()=>Promise.resolve({kind:'enter',messages:[]}));assert.equal(step2.startsRequestSeries,undefined);project(f,prompt(true),step2,2,2);assert.equal(f.session.snapshotEvents().length,before);
   f.life.round.id='life-round-3';const third=await f.dispatch.waterfall('agent/pre-step',{turn:3,step:1,signal:f.controller.signal},()=>Promise.resolve({kind:'enter',messages:[]}));project(f,prompt(),third,3,1);assert.equal(f.session.deriveMessages().filter(m=>m.role==='system'&&m.content.some(b=>b.text)).length,1);assert.deepEqual(nonSystem(f),[...original,f.session.deriveMessages().find(m=>m.id==='user-two')]);
   const later=await f.dispatch.waterfall('agent/pre-step',{turn:3,step:2,signal:f.controller.signal},()=>Promise.resolve({kind:'enter',messages:[]}));project(f,prompt(true),later,3,2);assert.equal(f.session.deriveMessages().filter(m=>m.role==='system'&&m.content.some(b=>b.text)).length,2,'changed later-step prompts keep native in-history semantics');
  }
 }
 t.diagnostic(JSON.stringify({kind:'actual-sdk-native-world-round-series',unpatched,patched,modelCalls:0,qqSends:0}));
});
test('actual AgentLoop rejects and foreign fused payloads pass through unchanged',async t=>{
 const sdk=await installed(t);if(!sdk)return;const f=await nativeFixture(t,sdk,true),reject={kind:'reject',reason:'native-policy'};
 assert.equal(await f.dispatch.waterfall('agent/pre-step',{turn:1,step:1,signal:f.controller.signal},()=>Promise.resolve(reject)),reject);
 const decision={kind:'enter',messages:[]};f.identity.owner='foreign';assert.equal(await f.dispatch.waterfall('agent/pre-step',{turn:1,step:1,signal:f.controller.signal},()=>Promise.resolve(decision)),decision);
 f.nativeOff();f.identity.owner=f.life.owner;assert.equal(await f.dispatch.waterfall('agent/pre-step',{turn:1,step:1,signal:f.controller.signal},()=>Promise.resolve(decision)),decision);
});
test('actual fish module setup installs and disposes the request-series listener',async()=>{
 const folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'request-series-module-')),now=Date.now(),data={version:3,keyId:'',fishId:'synthetic-fish#1',cursor:'',recent:[],skipped:0,state:{stage:'alive'},now:'synthetic',at:{state:now},errors:{},life:newLife(now)};fs.writeFileSync(path.join(folder,'runtime.json'),JSON.stringify(data));
 const listeners=new Map(),disposers=[],registry={guard:()=>()=>{}},api={core:{hub:{chatOfSession:()=>'',turnSendersAllOwner:()=>true}},dsh:{get:name=>name==='tools'?registry:null,on(name,fn){const rows=listeners.get(name)||[];rows.push(fn);listeners.set(name,rows);return ()=>{listeners.set(name,(listeners.get(name)||[]).filter(x=>x!==fn));};}},config:()=>({enabled:true,ownerQQ:'10000001',persona:{current:'synthetic-persona'}}),settings:()=>({autonomy:false}),dataDir:(...parts)=>path.join(folder,...parts),use:()=>null,lib:()=>({}),on(){},context(){},tool(){},rule(){},command(){},route(){},every(){},later(){},onDispose:fn=>disposers.push(fn),defineTool:definition=>definition,log:{info(){},warn(){}}};
 const module=(await import('../extensions/aurabot/fish-world/index.mjs')).default;await module.setup(api);assert.equal(listeners.get('agent/pre-step').length,1);assert.equal(listeners.get('agent/pre-step')[0].length,2);
 for(const dispose of disposers.reverse())await dispose();assert.equal(listeners.get('agent/pre-step').length,0);
});
