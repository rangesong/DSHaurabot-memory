import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

const WORLD='mcp__fish-world__world_',ownerId='fixture-owner',persona='fixture-persona';
const sessionKey=id=>id.replace(/^session-/,'');
let sdkPromise;
let modulePromise;
async function fishRuntime(){
 modulePromise??=(async()=>{
  let root=new URL('../extensions/aurabot/fish-world/',import.meta.url);
  if(process.env.FISH_SESSION_ALIAS_BASELINE){
   assert.equal(process.env.FISH_SESSION_ALIAS_BASELINE,'c3ceedf','Only the diagnosed public code baseline may be replayed');
   const repo=path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')),'..'),base=path.join(process.env.THINKSTAR_TEST_TMP,'session-alias-public-baseline');
   const names=execFileSync('git',['ls-tree','-r','--name-only','c3ceedf','extensions/aurabot/fish-world'],{cwd:repo,encoding:'utf8'}).trim().split('\n').filter(name=>/\.(?:mjs|js|json)$/.test(name));
   for(const name of names){const target=path.join(base,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,execFileSync('git',['show','c3ceedf:'+name],{cwd:repo}));}
   fs.writeFileSync(path.join(base,'package.json'),'{"type":"module"}');root=pathToFileURL(path.join(base,'extensions/aurabot/fish-world/'));
  }
  const[{default:module},{newLife},{worldNames},{registerJourney}]=await Promise.all(['index.mjs','state.mjs','life.mjs','owner-tasks.mjs'].map(name=>import(new URL(name,root).href)));return{module,newLife,worldNames,registerJourney};
 })();return modulePromise;
}
function extractSession(asar,scratch){
 assert.ok(scratch,'Use the managed test runner');const fd=fs.openSync(asar,'r'),head=Buffer.alloc(16);fs.readSync(fd,head,0,16,0);const hs=head.readUInt32LE(4),raw=Buffer.alloc(head.readUInt32LE(12));fs.readSync(fd,raw,0,raw.length,16);const tree=JSON.parse(raw),target=path.join(scratch,'session-alias-sdk'),queue=['@deepseek-ai/dsh-session'],seen=new Set();
 const find=p=>p.split('/').reduce((n,k)=>n?.files?.[k],tree);fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'package.json'),'{"type":"module"}');
 try{while(queue.length){const pkg=queue.shift();if(seen.has(pkg))continue;seen.add(pkg);const prefix=['dsh/node_modules/'+pkg,'node_modules/'+pkg].find(p=>find(p));assert.ok(prefix,'Missing installed SDK '+pkg);
  const copy=(node,relative='')=>{for(const[name,entry]of Object.entries(node.files||{})){const rel=relative?relative+'/'+name:name;if(entry.files){copy(entry,rel);continue;}if(!/\.(js|mjs|cjs|json)$/.test(name))continue;let bytes;if(entry.unpacked)bytes=fs.readFileSync(asar+'.unpacked/'+prefix+'/'+rel);else{bytes=Buffer.alloc(entry.size);fs.readSync(fd,bytes,0,bytes.length,8+hs+Number(entry.offset));}const file=path.join(target,'node_modules',pkg,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);if(/\.(js|mjs|cjs)$/.test(name))for(const match of bytes.toString().matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)){const spec=match[1];if(spec.startsWith('.')||spec.startsWith('node:'))continue;queue.push(spec.startsWith('@')?spec.split('/').slice(0,2).join('/'):spec.split('/')[0]);}}};copy(find(prefix));
 }}finally{fs.closeSync(fd);}return target;
}
async function sdk(t){
 if(!process.env.DSH_ASAR||!process.env.AURABOT_SOURCE){t.skip('Set DSH_ASAR and AURABOT_SOURCE for actual Session/module proof');return null;}
 sdkPromise??=(async()=>{const root=extractSession(process.env.DSH_ASAR,process.env.THINKSTAR_TEST_TMP);const[{Session},{defineTool}]=await Promise.all([import(pathToFileURL(path.join(root,'node_modules/@deepseek-ai/dsh-session/lib/index.js')).href),import(pathToFileURL(path.join(process.env.AURABOT_SOURCE,'src/tools/tools.js')).href)]);return{Session,defineTool};})();return sdkPromise;
}
function ownerTurn(session,text,turn,name,callId){
 if(turn>1)session.append('turn/end',{turn:turn-1,reason:{kind:'completed'}});
 session.append('turn/start',{turn});session.append('user/message',{id:'owner-input-'+turn,role:'user',source:{kind:'aurabot',speaker:{role:'owner',chat:'private'}},content:[{type:'text',text}]},{surfaceOp:'append'});session.append('tool/call',{turn,step:1,name,callId,arguments:'{}'});
}
async function fixture(sdk,{background=false}={}){
 const {module,newLife,worldNames,registerJourney}=await fishRuntime();
 const now=Date.now(),folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'session-alias-module-')),identity={owner:ownerId,persona},session=sdk.Session.create('session-synthetic-owner-alias',[]),bgSession=sdk.Session.create('session-synthetic-background-alias',[]),owner={session,status:'idle',whenIdle:async()=>{},cancel(){}},bg={session:bgSession,status:'idle',whenIdle:async()=>{},cancel(){},ctx:{tools:{restrict:()=>()=>{}}}};
 assert.ok(session.id.startsWith('session-'));assert.notEqual(session.id,sessionKey(session.id));
 for(const agent of [owner,bg])agent.inbox={hasPending:false,nextTurn:[],nextStep:[]};
 const data={version:3,keyId:'',fishId:'fixture-fish#1',cursor:'',recent:[],skipped:0,state:{stage:'alive',fish:'fixture-fish#1',where:{kind:'place',place:{id:'synthetic-shop'}}},now:'合成现场',at:{state:now-2000},errors:{},life:{...newLife(now),...identity}};
 let initialTask;if(background)initialTask=registerJourney(data.life,{goal:'在合成商店买一本书',destination:'synthetic-shop',arrivalStep:'买一本合成书'},{identity,sessionId:session.id,now:now-1000,data}).task;
 fs.writeFileSync(path.join(folder,'runtime.json'),JSON.stringify(data));
 fs.writeFileSync(path.join(folder,'credential.json'),JSON.stringify({key:'fw_synthetic_alias_test_only'}));
 const hooks={},events={},builders=[],guards=[],disposers=[],timers=[],routes=new Map([[session.id,'private:'+ownerId]]),config={enabled:true,ownerQQ:ownerId,persona:{current:persona}};
 let thinkHandler=async()=>assert.fail('Unexpected synthetic think'),network=0,qq=0;
 const tools={guard:fn=>(guards.push(fn),()=>{}),schemas:()=>worldNames.map(name=>({name,parameters:{type:'object',properties:{}}}))};
 const api={config:()=>config,settings:()=>({sharing:false,idleEnabled:true,backgroundContextEnabled:true,idleWorkHours:'00:00-23:59',activityWorkHours:'00:00-23:59'}),dataDir:(...p)=>path.join(folder,...p),dsh:{get:name=>name==='tools'?tools:name==='agents'?{list:()=>[owner,bg],get:id=>[owner,bg].find(a=>sessionKey(a.session.id)===sessionKey(id))}:null,on:(name,fn)=>((events[name]??=[]).push(fn),()=>{})},core:{hub:{chatOfSession:id=>routes.get(id)||routes.get('session-'+sessionKey(id)),turnSendersAllOwner:()=>true},http:{body:async()=>({})}},on:(name,fn)=>hooks[name]=fn,context(){},tool:fn=>builders.push(fn),rule(){},command(){},route(){},every:(ms,fn)=>timers.push({ms,fn}),later(){},onDispose:fn=>disposers.push(fn),defineTool:sdk.defineTool,log:{warn(){},info(){}},use:()=>null,think:(...args)=>thinkHandler(...args),send:async()=>{qq++;assert.fail('No QQ sends');},fetch:async()=>{network++;assert.fail('No network');}};
 // The bridge captures this in-memory fetcher during setup. No request can reach the network.
 const priorFetch=globalThis.fetch;let syntheticReads=0,installed;
 globalThis.fetch=async url=>{syntheticReads++;const endpoint=new URL(url).pathname;assert.ok(['/v1/state','/v1/now','/v1/notify'].includes(endpoint));return new Response(endpoint==='/v1/now'?data.now:JSON.stringify(endpoint==='/v1/state'?data.state:{cursor:'synthetic-empty',items:[]}));};
 try{installed=await module.setup(api);}finally{globalThis.fetch=priorFetch;}
 if(background)await installed.refresh();
 const read=()=>JSON.parse(fs.readFileSync(path.join(folder,'runtime.json'))),info={chat:{kind:'private',userId:ownerId},senderId:ownerId,sessionId:sessionKey(session.id),level:'full'};
 return{api,installed,read,owner,bg,hooks,guards,events,builders,timers,routes,info,initialTask,setThink(fn){thinkHandler=fn;},turn(text,turn,name,callId){ownerTurn(session,text,turn,name,callId);hooks.prompt([],{...info,sessionId:session.id,queryText:text,turnToken:turn});return{agent:owner,name,callId,arguments:{},signal:new AbortController().signal};},async close(){for(const off of disposers.reverse())await off();assert.equal(network,0);assert.equal(qq,0);},diagnostic(t){t.diagnostic(JSON.stringify({actualSession:true,actualAurabotDefineTool:true,actualModuleSetup:true,factorySessionBare:true,modelCalls:0,worldRequests:0,qqSends:0}));}};
}

test('actual module background task factory accepts its prefixed native Session and defines arrival steps',async t=>{
 const native=await sdk(t);if(!native)return;const f=await fixture(native,{background:true});let release,settled;const held=new Promise(resolve=>release=resolve),observed=new Promise(resolve=>settled=resolve);
 try{
  f.setThink(async(_prompt,prepared)=>{try{f.routes.set(f.bg.session.id,'system:ext-fish-world:'+prepared.key);const tools=f.builders[0]({chat:{kind:'system',chatId:'system:ext-fish-world:'+prepared.key},level:'full',sessionId:sessionKey(f.bg.session.id)}),tool=tools.find(t=>t.name==='fish_life_task');assert.ok(tool);const task=f.read().life.ownerTasks.find(t=>t.id===f.initialTask.id),callId='synthetic-background-define';f.bg.session.append('turn/start',{turn:1});f.bg.session.append('tool/call',{turn:1,step:1,name:tool.name,callId,arguments:'{}'});settled(await tool.execute({id:task.id,expectedRevision:task.revision,steps:[{tool:'world_do',arguments:'{"id":"buy-book"}',nextStep:'买一本合成书'}]},{agent:f.bg,name:tool.name,callId,signal:new AbortController().signal}));}catch(e){settled({testHarnessError:e.message});}await held;});
  f.timers.find(x=>x.ms===2000).fn();const result=await Promise.race([observed,new Promise((_,reject)=>setTimeout(()=>reject(Error('Synthetic scheduler did not reach module tool factory: '+f.read().life.blocked)),3000))]);assert.equal(result.testHarnessError,undefined);assert.notEqual(result.ok,false,result.message);const task=f.read().life.ownerTasks.find(t=>t.id===f.initialTask.id);assert.equal(task.phase,'pending');assert.equal(task.steps[0].arguments.id,'buy-book');assert.equal(f.read().life.round.sessionId,f.bg.session.id);f.diagnostic(t);
 }finally{release();await new Promise(resolve=>setImmediate(resolve));await f.close();}
});

test('actual private bare factory registration remains linked after a prefixed owner question clears current context',async t=>{
 const native=await sdk(t);if(!native)return;const f=await fixture(native);
 try{
  const tools=f.builders[0](f.info),journey=tools.find(t=>t.name==='fish_life_journey'),define=tools.find(t=>t.name==='fish_life_task');assert.ok(journey&&define);const exec=f.turn('去合成商店看看？',1,journey.name,'synthetic-journey');const registered=await journey.execute({goal:'在合成商店买一本书',destination:'synthetic-shop',arrivalStep:'买一本合成书'},exec);assert.notEqual(registered.ok,false,registered.message);const task=f.read().life.ownerTasks.at(-1);assert.equal(task.kind,'journey');
  const read=f.turn('书买到了吗？',2,WORLD+'now','synthetic-current-now');for(const guard of f.guards)assert.equal(guard(read),undefined);for(const observe of f.events['tools/result']||[])observe(read,{isError:false,content:[{type:'text',text:'11-27 周五 18:00 · 晴 8°C\n你在：合成商店'}]});assert.equal(f.read().life.journal.at(-1).ownerTaskId,task.id,'the native prefixed execution must retain the explicitly registered purpose after a question');
  const current=f.read().life.ownerTasks.find(t=>t.id===task.id),defineExec=f.turn('接下来呢？',3,define.name,'synthetic-private-define'),result=await define.execute({id:current.id,expectedRevision:current.revision,steps:[{tool:'world_do',arguments:'{"id":"buy-book"}',nextStep:'买一本合成书'}]},defineExec);assert.notEqual(result.ok,false,result.message);const saved=f.read();assert.equal(saved.life.ownerTasks.find(t=>t.id===task.id).steps[0].arguments.id,'buy-book');assert.equal(saved.life.ownerTasks.length,1);assert.equal(saved.life.outbox.length,0);f.diagnostic(t);
 }finally{await f.close();}
});
