import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {renderLifeTool} from '../extensions/aurabot/fish-world/tool-output.mjs';
import {chooseWindow} from '../extensions/aurabot/fish-world/world-window.mjs';

const WORLD='mcp__fish-world__world_history',TOOL='fish_dialogue_history';
const startedAt=Date.parse('2026-11-23T12:00:00+08:00');
let runtimePromise;
function extractNativeRuntime(asar,scratch){
  assert.ok(scratch,'Use the managed test runner');
  const fd=fs.openSync(asar,'r'),head=Buffer.alloc(16);fs.readSync(fd,head,0,16,0);
  const hs=head.readUInt32LE(4),raw=Buffer.alloc(head.readUInt32LE(12));fs.readSync(fd,raw,0,raw.length,16);const tree=JSON.parse(raw);
  const target=path.join(scratch,'dialogue-native-sdk'),queue=['@deepseek-ai/dsh-tool-executor-native'],seen=new Set();
  fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'package.json'),'{"type":"module"}');
  const find=p=>{let node=tree;for(const part of p.split('/'))node=node?.files?.[part];return node;};
  try{while(queue.length){
    const pkg=queue.shift();if(seen.has(pkg))continue;seen.add(pkg);
    const prefix=['dsh/node_modules/'+pkg,'node_modules/'+pkg].find(p=>find(p));assert.ok(prefix,'Missing installed runtime package '+pkg);
    function copy(node,relative=''){for(const[name,entry]of Object.entries(node.files||{})){
      const relativeFile=relative?relative+'/'+name:name;if(entry.files){copy(entry,relativeFile);continue;}if(!/\.(js|mjs|cjs|json)$/.test(name))continue;
      let bytes;if(entry.unpacked)bytes=fs.readFileSync(asar+'.unpacked/'+prefix+'/'+relativeFile);else{bytes=Buffer.alloc(entry.size);fs.readSync(fd,bytes,0,bytes.length,8+hs+Number(entry.offset));}
      const file=path.join(target,'node_modules',pkg,relativeFile);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
      if(/\.(js|mjs|cjs)$/.test(name))for(const match of bytes.toString().matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)){
        const dep=match[1];if(dep.startsWith('.')||dep.startsWith('node:'))continue;
        const key=dep.startsWith('@')?dep.split('/').slice(0,2).join('/'):dep.split('/')[0];
        if(!['fs','path','crypto','os','url','util','stream','events','buffer','assert','async_hooks','module'].includes(key))queue.push(key);
      }
    }}copy(find(prefix));
  }}finally{fs.closeSync(fd);}return target;
}
async function installed(t){
  if(!process.env.DSH_ASAR||!process.env.AURABOT_SOURCE){t.skip('Set DSH_ASAR and AURABOT_SOURCE for installed native/Aurabot dialogue integration');return null;}
  runtimePromise??=(async()=>{
    const runtime=extractNativeRuntime(process.env.DSH_ASAR,process.env.THINKSTAR_TEST_TMP);
    const [{NativeToolExecutor},{defineTool},reader]=await Promise.all([
      import(pathToFileURL(path.join(runtime,'node_modules/@deepseek-ai/dsh-tool-executor-native/lib/index.js')).href),
      import(pathToFileURL(path.join(process.env.AURABOT_SOURCE,'src/tools/tools.js')).href),
      import('../extensions/aurabot/fish-world/dialogue-history.mjs'),
    ]);return {NativeToolExecutor,defineTool,...reader};
  })();return runtimePromise;
}
const page=(number,{last=false}={})=>'合成同伴#321 的往来\n合成第'+number+'页：我们在星桥见过面。'+(last?'':'\n—— 更早的：before=m_'+(100+number))+'\n—— 现在 2026-11-23 12:00';
function fixture(sdk,options={}){
  const background=options.background??true,time={now:startedAt},identity={owner:'fixture-owner',persona:'fixture-persona'},controller=new AbortController(),surface=[],guarded=[],observed=[],bodies=[],childBatches=[];
  let contextValid=true,checks=0,qqSends=0;
  const data={version:3,keyId:'',fishId:'fixture-fish#1',cursor:'',recent:[],skipped:0,state:{stage:'alive',fish:'fixture-fish#1'},now:'合成现场',at:{state:startedAt},errors:{},life:newLife(startedAt)};
  const bridge={data,identityReady:true,change(fn){const old=structuredClone(this.data);try{return fn(this.data);}catch(error){this.data=old;throw error;}}};
  const engine=new LifeEngine({bridge,host:{cancel:async()=>{},idle:async()=>true,send:async()=>{qqSends++;assert.fail('QQ sending is forbidden');}},clock:()=>time.now,identity:()=>identity,settings:()=>({sharing:false,maxCalls:6,turnMs:90000,...options.settings})});
  Object.assign(engine.l,{owner:identity.owner,persona:identity.persona});
  const agent={session:{id:'session-dialogue-fixture',append(type,data){surface.push({type,data});return {seq:surface.length};}},ctx:{tools:{restrict:()=>()=>{}}},status:'idle'};
  if(background)engine.l.round={id:'round-dialogue-fixture',sessionId:agent.session.id,status:'running',revision:engine.l.revision,priority:3,startedAt,events:[],planIds:[],receipts:[],calls:0,readOnly:!!options.readOnly,observation:'合成真实现场已观察',intent:null};
  if(options.readOnly)engine.l.recovery=true;
  const exec={callId:'dialogue-parent-fixture',agent,signal:controller.signal,toolSet:{fixture:true}};
  const assertCurrent=()=>{checks++;if(!contextValid||engine.l.owner!==identity.owner||engine.l.persona!==identity.persona)throw Error('Synthetic current owner/persona context changed');};
  let tools;
  const history={name:WORLD,description:'Synthetic official world history',parameters:{type:'object',properties:{fish:{type:'string'},before:{type:'string'}},required:['fish'],additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:value.text}]},execute:async(args,childExec)=>{
    bodies.push({args:structuredClone(args),callId:childExec.callId});await options.onBody?.({engine,time,identity,controller,makeForeign:()=>{contextValid=false;},number:bodies.length});
    return {text:options.pages?.[bodies.length-1]??page(bodies.length,{last:!!options.lastPage})};
  }};
  const dialogue=sdk.defineTool({name:TOOL,properties:{fish:{type:'string'},query:{type:'string'},date:{type:'string'},before:{type:'string'},maxPages:{type:'integer'}},required:['fish'],render:renderLifeTool,execute:(args,call)=>sdk.executeDialogueHistory({engine,tools,exec:call,background,assertCurrent},args)});
  const finish=sdk.defineTool({name:'fish_life_finish',render:renderLifeTool,execute:args=>engine.finish(args)});
  const definitions=[history,dialogue,finish];
  const registry={executable:name=>definitions.find(def=>def.name===name),checkGuards(call){
    if(call.name===WORLD){guarded.push(call.callId);const denied=options.denyPage===guarded.length?'Synthetic independent world-history guard':null;if(denied)return {reason:denied};}
    const reason=engine.guard(call,background,!background);return reason?{reason}:undefined;
  }};
  const context={tools:registry,waterfall:async(...args)=>args.at(-1)(),get:()=>undefined,logger:{warn:message=>assert.fail(message)},events:{dispatch:()=>[(call,result)=>{
    if(call.name===WORLD){observed.push(call.callId);if(options.dropResultHook)return;}
    engine.result(call,result);
  }]}};
  const executor=new sdk.NativeToolExecutor(context,()=>1);
  tools={definitions:()=>definitions,schemas:()=>executor.describe(definitions).schemas,selectExecutor:()=>executor,guard:()=>()=>{},execute:batch=>{
    if(batch.calls.some(call=>call.name===WORLD)){assert.equal(batch.calls.length,1);assert.equal(batch.maxParallelToolCalls,1);assert.equal(batch.log,undefined,'Nested reads must not append orphan tool surface results');assert.equal(batch.agent,agent);assert.equal(batch.signal,controller.signal);childBatches.push(batch);}
    return executor.execute(batch);
  }};
  const invoke=async(args={fish:'合成同伴#321',maxPages:3})=>{
    const settled=await tools.execute({calls:[{type:'tool-call',id:exec.callId,name:TOOL,arguments:JSON.stringify(args)}],agent,signal:controller.signal,toolSet:exec.toolSet,maxParallelToolCalls:1});
    const result=settled.results[0].result,text=result.content[0].text;let value;
    try{value=JSON.parse(text);}catch{assert.equal(result.isError,true,'Only a native executor failure may bypass the Aurabot JSON renderer');value={ok:false,message:text};}
    return {result,value};
  };
  return {engine,tools,exec,invoke,agent,definitions,history,bridge,identity,time,controller,surface,guarded,observed,bodies,childBatches,makeForeign:()=>{contextValid=false;},checks:()=>checks,qqSends:()=>qqSends};
}
function noSideEffects(f){assert.equal(f.qqSends(),0);assert.deepEqual(f.engine.l.outbox,[]);assert.deepEqual(f.surface,[]);assert.equal(f.engine.l.journal.some(row=>row.tool&&row.tool!==WORLD),false);}

test('installed owner dialogue tool uses numbered peer and at most three serial official reads with full receipts',async t=>{
  const sdk=await installed(t);if(!sdk)return;const f=fixture(sdk,{background:false});
  assert.equal(sdk.canReadDialogue(f.agent,f.tools,f.exec.toolSet),true);
  const {value}=await f.invoke();assert.equal(value.ok,true);assert.equal(value.fish,'#321');assert.equal(value.pages.length,3);
  assert.deepEqual(f.bodies.map(row=>row.args),[{fish:'#321'},{fish:'#321',before:'m_101'},{fish:'#321',before:'m_102'}]);
  assert.equal(f.guarded.length,3);assert.deepEqual(f.observed,f.guarded);assert.equal(f.childBatches.length,3);
  for(const p of value.pages){const row=f.engine.l.journal.find(row=>row.id===p.receiptId);assert.equal(row.status,'confirmed');assert.equal(row.sessionId,f.agent.session.id);assert.equal(row.result,p.text);}
  assert.equal(f.engine.l.round,null);assert.equal(f.engine.l.externalPending,null);assert.ok(f.checks()>=3);noSideEffects(f);
});

test('installed background dialogue retains the exact-limit page and its facts are accepted by existing finish',async t=>{
  const sdk=await installed(t);if(!sdk)return;const f=fixture(sdk,{settings:{maxCalls:2}}),{value}=await f.invoke();
  assert.equal(value.pages.length,2);assert.equal(f.bodies.length,2);assert.equal(f.engine.l.round.calls,2);assert.ok(value.stopReason);
  const facts=value.pages.map(row=>row.receiptId);assert.ok(facts.every(id=>f.engine.l.round.receipts.some(row=>row.id===id&&!row.isError)));
  const settled=await f.tools.execute({calls:[{type:'tool-call',id:'dialogue-finish',name:'fish_life_finish',arguments:JSON.stringify({summary:'合成对话已核对',events:[],importance:'routine',facts,share:''})}],agent:f.agent,signal:f.controller.signal,toolSet:f.exec.toolSet,maxParallelToolCalls:1});
  assert.equal(JSON.parse(settled.results[0].result.content[0].text).ok,true);assert.deepEqual(f.engine.l.round.report.facts,facts);noSideEffects(f);
});

test('readonly recovery permits dialogue reads without identity actions or world mutations',async t=>{
  const sdk=await installed(t);if(!sdk)return;const f=fixture(sdk,{readOnly:true,lastPage:true}),{value}=await f.invoke();
  assert.equal(value.ok,true);assert.equal(value.pages.length,1);assert.equal(f.engine.l.round.readOnly,true);assert.equal(f.engine.l.recovery,true);assert.equal(f.engine.l.round.calls,1);noSideEffects(f);
});

test('native independent guard denial and missing result observer cannot become fabricated dialogue pages',async t=>{
  const sdk=await installed(t);if(!sdk)return;
  const denied=fixture(sdk,{denyPage:2}),{value}=await denied.invoke();assert.equal(denied.bodies.length,1);assert.equal(value.pages.length,1);assert.ok(value.stopReason);assert.equal(denied.engine.l.journal.length,1);noSideEffects(denied);
  const missing=fixture(sdk,{dropResultHook:true}),rejected=await missing.invoke();assert.equal(missing.bodies.length,1);assert.equal(rejected.value.ok,false);assert.equal(rejected.value.pages?.length??0,0);assert.equal(missing.engine.l.journal[0].status,'executing');noSideEffects(missing);
});

test('quota, elapsed time and cancellation stop reads before the next official dispatch',async t=>{
  const sdk=await installed(t);if(!sdk)return;
  for(const mode of ['quota','deadline','cancel']){
    const f=fixture(sdk,{settings:mode==='quota'?{maxCalls:0}:{}});if(mode==='deadline')f.time.now=startedAt+90001;if(mode==='cancel')f.controller.abort();
    const {value}=await f.invoke();assert.equal(value.ok,false,mode);assert.equal(f.bodies.length,0,mode);assert.equal(f.engine.l.journal.length,0,mode);noSideEffects(f);
  }
  const timed=fixture(sdk,{onBody:({number,time})=>{if(number===1)time.now=startedAt+90001;}}),{value}=await timed.invoke();
  assert.equal(timed.bodies.length,1);assert.equal(value.pages.length,1);assert.ok(value.stopReason);noSideEffects(timed);
});

test('current owner/agent callback rejects foreign and in-flight switched contexts before exposing a page',async t=>{
  const sdk=await installed(t);if(!sdk)return;
  const foreign=fixture(sdk);foreign.makeForeign();const before=await foreign.invoke();assert.equal(before.value.ok,false);assert.equal(foreign.bodies.length,0);noSideEffects(foreign);
  const switched=fixture(sdk,{onBody:({makeForeign})=>makeForeign()}),after=await switched.invoke();assert.equal(after.value.ok,false);assert.equal(after.value.pages?.length??0,0);assert.equal(switched.bodies.length,1);noSideEffects(switched);
  const later=fixture(sdk,{onBody:({number,identity})=>{if(number===2)identity.persona='foreign-persona';}}),changed=await later.invoke();assert.equal(changed.value.ok,false);assert.equal(changed.value.pages?.length??0,0,'Previously read pages must not leak to the changed persona');assert.equal(later.bodies.length,2);noSideEffects(later);
});

async function moduleFixture(t,sdk,{background=false}={}){
  const {default:module}=await import('../extensions/aurabot/fish-world/index.mjs'),f=fixture(sdk,{background:false});
  const folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'dialogue-module-'));
  const base=createHash('sha256').update(JSON.stringify([f.bridge.data.fishId,f.identity])).digest('hex').slice(0,24),route=chooseWindow(f.engine,base,{now:startedAt});
  if(background)f.engine.l.round={id:'module-owned-round',sessionId:f.agent.session.id,status:'running',revision:f.engine.l.revision,events:[],receipts:[],calls:0,startedAt};
  fs.writeFileSync(path.join(folder,'runtime.json'),JSON.stringify(f.bridge.data));
  const builders=[],disposers=[],rules=[],guards=[],events={},config={enabled:true,ownerQQ:f.identity.owner,persona:{current:f.identity.persona}};let ownerTurn=true;
  const worldNames=['now','history','find','profile','go','do','say','friends','update','guide'].map(name=>'mcp__fish-world__world_'+name);
  Object.assign(f.agent,{cancel(){},whenIdle:async()=>{}});
  f.tools.guard=fn=>{guards.push(fn);return()=>{};};f.tools.schemas=()=>worldNames.map(name=>({name}));
  const api={config:()=>config,settings:()=>({sharing:false,autonomy:false,backgroundContextEnabled:true}),dataDir:(...parts)=>path.join(folder,...parts),
    dsh:{get:name=>name==='tools'?f.tools:name==='agents'?{list:()=>[f.agent],get:id=>id===f.agent.session.id?f.agent:null}:null,on:(name,fn)=>{(events[name]??=[]).push(fn);return()=>{};}},
    core:{hub:{chatOfSession:()=>background?'system:ext-fish-world:'+route:'private:'+f.identity.owner,turnSendersAllOwner:()=>ownerTurn},http:{body:async()=>({})}},
    use:()=>null,lib:()=>({}),on(){},context(){},tool:fn=>builders.push(fn),rule:fn=>rules.push(fn),command(){},route(){},every(){},later(){},onDispose:fn=>disposers.push(fn),defineTool:sdk.defineTool,
    think:()=>assert.fail('No model requests'),send:()=>assert.fail('No QQ sends'),proactive:{send:()=>assert.fail('No proactive messages')},log:{warn(){},info(){}}};
  await module.setup(api);t.after(async()=>{for(const dispose of disposers.reverse())await dispose();});
  const ownerChat={kind:'private',chatId:'private:'+f.identity.owner,userId:f.identity.owner},systemChat={kind:'system',chatId:'system:ext-fish-world:'+route};
  return {...f,config,folder,rules,guards,events,build:info=>builders[0]({chat:ownerChat,level:'full',sessionId:f.agent.session.id,...info}),ownerChat,systemChat,base,route,setOwnerTurn:value=>{ownerTurn=value;}};
}

test('module adds native dialogue lookup while retaining existing owner tools and the original MCP definition',async t=>{
  const sdk=await installed(t);if(!sdk)return;const f=await moduleFixture(t,sdk),original=f.history;
  const tools=f.build(),names=tools.map(tool=>tool.name);
  assert.deepEqual(names.filter(name=>name!==TOOL),['fish_world_state','fish_life_history','fish_life_task','fish_world_control']);assert.equal(names.filter(name=>name===TOOL).length,1);
  assert.equal(f.definitions.find(tool=>tool.name===WORLD),original);assert.equal(f.history.execute,original.execute);
  for(const level of ['guest','readonly'])assert.equal(f.build({level}).some(tool=>tool.name===TOOL),false);
  assert.equal(f.build({chat:{kind:'private',chatId:'private:fixture-guest',userId:'fixture-guest'}}).length,0);
  const unavailable=f.tools.selectExecutor;f.tools.selectExecutor=()=>({describe:()=>({schemas:[{name:'run_code'}]})});
  assert.deepEqual(f.build().map(tool=>tool.name),['fish_world_state','fish_life_history','fish_life_task','fish_world_control']);f.tools.selectExecutor=unavailable;
  assert.ok(f.rules.some(rule=>rule('private').includes('自然回答')));noSideEffects(f);
});

test('module renderer exposes dialogue prose without JSON receipts or pagination control fields',async t=>{
  const sdk=await installed(t);if(!sdk)return;const f=await moduleFixture(t,sdk),tool=f.build().find(tool=>tool.name===TOOL);
  const rendered=tool.output.render({fish:'#321'},{ok:true,dialogueText:'合成同伴说：周末在星桥见。',pages:[{receiptId:'internal-receipt',text:'internal raw'}],nextBefore:'m_123',stopReason:'max-pages'}).map(block=>block.text).join('\n');
  assert.ok(rendered.includes('周末在星桥见'));for(const text of ['internal-receipt','internal raw','m_123','nextBefore','"pages"','max-pages'])assert.equal(rendered.includes(text),false,text);assert.equal(tool.slow,undefined);noSideEffects(f);
});

test('captured module dialogue tools reject stale owner, sender and session scopes without dispatch',async t=>{
  const sdk=await installed(t);if(!sdk)return;const f=await moduleFixture(t,sdk),tool=f.build().find(tool=>tool.name===TOOL);
  const foreign=await tool.execute({fish:'#321'},{...f.exec,agent:{session:{id:'foreign-session'}}});assert.equal(foreign.ok,false);
  f.setOwnerTurn(false);assert.equal((await tool.execute({fish:'#321'},f.exec)).ok,false);f.setOwnerTurn(true);
  f.config.persona.current='different-persona';assert.equal((await tool.execute({fish:'#321'},f.exec)).ok,false);f.config.persona.current=f.identity.persona;
  f.config.enabled=false;assert.equal((await tool.execute({fish:'#321'},f.exec)).ok,false);assert.equal(f.bodies.length,0);noSideEffects(f);
});

test('module exposes dialogue only to its exact owned background route without replacing existing background tools',async t=>{
  const sdk=await installed(t);if(!sdk)return;const f=await moduleFixture(t,sdk,{background:true});
  const tools=f.build({chat:f.systemChat}),names=tools.map(tool=>tool.name);
  assert.equal(names.filter(name=>name===TOOL).length,1);assert.deepEqual(names.filter(name=>name!==TOOL),['fish_life_task','fish_life_history','fish_life_intent','fish_life_finish']);
  assert.equal(f.build({chat:{kind:'system',chatId:'system:ext-fish-world:'+f.base}}).length,0);
  const stale=tools.find(tool=>tool.name===TOOL);f.config.persona.current='different-persona';assert.equal((await stale.execute({fish:'#321'},f.exec)).ok,false);assert.equal(f.bodies.length,0);noSideEffects(f);
});
