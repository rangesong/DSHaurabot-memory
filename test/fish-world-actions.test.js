import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {executeSequencedAction,canSequenceAction,noteActionSessionEvent,noteActionGuardRejected} from '../extensions/aurabot/fish-world/action-sequence.mjs';
import {renderLifeTool} from '../extensions/aurabot/fish-world/tool-output.mjs';
const PREFIX='mcp__fish-world__world_';
const start=Date.parse('2026-11-21T12:00:00+08:00');
const input={tool:PREFIX+'do',arguments:'{"id":"fixture-action"}',category:'daily',cost:0,evidence:'允许 fixture-action'};
function fixture(options={}){
 const time={now:start},identity={owner:'fixture-owner',persona:'fixture'},controller=new AbortController(),surface=[];
 const data={version:3,fishId:'fixture-fish#1',at:{state:start},state:{},now:'fixture',life:newLife(start)};
 const bridge={data,identityReady:true,change(fn){const old=structuredClone(data);try{return fn(data);}catch(error){this.data=old;throw error;}}};
 const engine=new LifeEngine({bridge,host:{cancel:async()=>{},idle:async()=>true},clock:()=>time.now,identity:()=>identity,settings:()=>({maxCalls:6,...options.settings})});
 Object.assign(engine.l,{owner:identity.owner,persona:identity.persona});
 const agent={session:{id:'session-fixture',append(type,data,opts){surface.push({type,data,...opts});return {seq:surface.length};}}};
 engine.l.round={id:'round-fixture',sessionId:agent.session.id,status:'running',priority:3,revision:engine.l.revision,startedAt:start,receipts:[],calls:0,readOnly:false,observation:'',intent:null};
 const trace=[],effects=[],definitions=['now','profile','do','say','go','friends'].map(n=>({name:PREFIX+n,description:'synthetic',parameters:{type:'object',additionalProperties:true},
  output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:value.text}]},
  async execute(args,exec){effects.push(exec.name);await options.onBody?.(exec,engine);
   if(n==='now')return {text:options.nowText||'合成现场：允许 fixture-action；0 贝'};
   if(n==='profile')return {text:options.profileText||(options.otherFish?'different-fish#9':'fixture-fish#1\n合成身份')};
   return {text:'合成成功'};
  }}));
 const tools={definitions:()=>definitions,selectExecutor:()=>({describe:defs=>({schemas:defs.map(d=>({name:d.name}))})}),
  async execute(batch){assert.equal(batch.log,undefined,'Subcalls must not append orphan native surface results');assert.equal(batch.maxParallelToolCalls,1);assert.equal(batch.agent,agent);assert.equal(batch.signal,controller.signal);
   const results=[];for(const block of batch.calls){const exec={callId:block.id,name:block.name,arguments:JSON.parse(block.arguments),agent,signal:batch.signal,toolSet:batch.toolSet};
    trace.push({name:block.name,args:exec.arguments,callId:block.id});
    const denied=engine.guard(exec,true,false);if(denied&&options.trackGuardRejections)noteActionGuardRejected(engine,exec,denied);let result;
    if(denied)result={isError:true,content:[{type:'text',text:'Error: '+denied}]};
    else if(options.timeoutAction&&block.name===input.tool)result={isError:true,content:[{type:'text',text:'timeout: synthetic uncertain response'}]};
    else {const value=await definitions.find(d=>d.name===block.name).execute(exec.arguments,exec);result={isError:false,value,content:[{type:'text',text:value.text}]};}
    if(!options.dropResultHook)engine.result(exec,result);await options.afterResult?.(exec,engine,controller);
    results.push({callId:block.id,result});
   }return {results,additionalContexts:[],concluded:false};
  }};
 const exec={callId:'parent-fixture',agent,signal:controller.signal,toolSet:{fixture:true}};
 noteActionSessionEvent(engine,agent.session,{type:'tool/call',seq:11,time:start,data:{turn:1,step:3,callId:exec.callId,name:'fish_life_action',arguments:JSON.stringify(input)}});
 return {engine,tools,exec,trace,effects,surface,controller,time,identity,definitions};
}
const run=(f,args=input)=>executeSequencedAction(f,args);
test('native action obtains real now, self profile, exact intent and one mutation through official guards/results',async()=>{
 const f=fixture(),result=await run(f);
 assert.equal(result.ok,true);assert.deepEqual(f.trace.map(c=>c.name),['now','profile','do'].map(n=>PREFIX+n));
 assert.deepEqual(f.trace[1].args,{});assert.equal(f.trace[2].args.id,'fixture-action');assert.match(f.trace[2].args.request_id,/^fa:[a-f0-9]{32}$/);assert.equal(f.trace[2].args.request_id,result.requestId);
 assert.equal(f.engine.l.round.calls,3);assert.equal(f.engine.l.journal.filter(j=>j.tool).length,3);
 assert.ok(f.engine.l.journal.filter(j=>j.tool).every(j=>j.status==='confirmed'));
 const sequence=Object.values(f.engine.l.round.actionSequences)[0];assert.equal(sequence.parent.seq,11);assert.equal(sequence.parent.turn,1);assert.equal(sequence.parent.step,3);
 assert.equal(sequence.source,'program-action-sequence');assert.equal(sequence.calls[2].id,result.receiptId);assert.deepEqual(result.facts,[result.receiptId]);
 assert.equal(f.surface.length,0);
});
test('same round duplicate and concurrent input performs the mutation once and returns its existing evidence',async()=>{
 const f=fixture(),[a,b]=await Promise.all([run(f),run(f)]);assert.equal(a.receiptId,b.receiptId);
 const c=await run(f);assert.equal(c.reused,true);assert.equal(c.receiptId,a.receiptId);assert.equal(f.trace.length,3);
});

test('a model short world_do alias uses the same guarded native action and duplicate key',async()=>{
 const f=fixture(),result=await run(f,{...input,tool:'world_do'});assert.equal(result.ok,true);assert.equal(result.tool,input.tool);assert.equal(f.trace.at(-1).name,input.tool);
 const again=await run(f);assert.equal(again.reused,true);assert.equal(f.trace.length,3);
});
test('wrong identity never submits an intent or mutation',async()=>{
 for(const options of [{otherFish:true},{profileText:'fixture-fish#10\n合成身份'}]){const f=fixture(options),r=await run(f);assert.equal(r.ok,false);assert.equal(r.status,'blocked');assert.deepEqual(f.effects,['now','profile'].map(n=>PREFIX+n));assert.equal(f.engine.l.round.intent,null);}
});
test('missing formal result observer cannot be substituted with fabricated success',async()=>{
 const f=fixture({dropResultHook:true}),r=await run(f);assert.equal(r.ok,false);assert.equal(r.status,'uncertain');assert.equal(f.trace.length,1);assert.equal(f.engine.l.recovery,true);assert.equal(f.engine.l.round.status,'stopping');
});
test('owner revision, cancellation and timeout prevent later mutation',async()=>{
 for(const mode of ['revision','cancel','timeout']){
  const f=fixture({afterResult:async(exec,e,controller)=>{if(exec.name===PREFIX+'profile'){if(mode==='revision')e.change(l=>{l.revision++;});if(mode==='cancel')controller.abort();if(mode==='timeout')f.time.now=start+100000;}}});
  const r=await run(f);assert.equal(r.ok,false,mode);assert.ok(!f.effects.includes(PREFIX+'do'),mode);
 }
});
test('readonly recovery, external lock, stopped controls and foreign agent cannot start subcalls',async()=>{
 for(const mode of ['readOnly','recovery','lock','external','stopped','foreign']){
  const f=fixture();if(mode==='readOnly')f.engine.l.round.readOnly=true;if(mode==='recovery')f.engine.l.recovery=true;if(mode==='lock')f.engine.lock={callId:'old'};
  if(mode==='external')f.engine.l.externalPending={callId:'old'};if(mode==='stopped')f.engine.l.controls.stopped=true;if(mode==='foreign')f.exec.agent={session:{id:'foreign'}};
  await assert.rejects(()=>run(f),undefined,mode);assert.equal(f.trace.length,0,mode);
 }
});
test('call allowance covers prerequisites and action, including success at the exact limit',async()=>{
 const short=fixture({settings:{maxCalls:2}}),denied=await run(short);assert.equal(denied.ok,false);assert.equal(short.trace.length,0);
 const exact=fixture({settings:{maxCalls:3}}),result=await run(exact);assert.equal(result.ok,true);assert.equal(exact.engine.l.round.calls,3);
});
test('uncertain world action retains receipts and cannot be automatically submitted again',async()=>{
 const f=fixture({timeoutAction:true}),r=await run(f);assert.equal(r.status,'uncertain');assert.equal(f.engine.l.recovery,true);assert.equal(f.engine.l.round.status,'stopping');
 const journal=f.engine.l.journal.find(j=>j.id===r.receiptId);assert.equal(journal.status,'uncertain');
 const again=await run(f,{...input,arguments:'{"id":"fixture-action","request_id":"model-changed-again"}'});assert.equal(again.status,'uncertain');assert.equal(again.reused,true);assert.equal(f.trace.length,3);
});
test('origin comes from the exact formal parent event; metadata spoofing and PTC are rejected',async()=>{
 const f=fixture();f.exec.callId='unknown-parent';await assert.rejects(()=>run(f),/来源/);assert.equal(f.trace.length,0);
 assert.equal(canSequenceAction(f.exec.agent,f.tools),true);
 const ptc={...f.tools,selectExecutor:()=>({describe:()=>({schemas:[{name:'run_code'}],knownNames:['run_code']})})};
 assert.equal(canSequenceAction(f.exec.agent,ptc),false);await assert.rejects(()=>executeSequencedAction({...f,tools:ptc},input),/原生/);
});
test('approved action arguments are used verbatim and all independent guards remain authoritative',async()=>{
 const f=fixture(),original=f.engine.intent.bind(f.engine),approved=[];
 f.engine.intent=args=>{const r=original(args);approved.push(structuredClone(r.arguments));return r;};
 const result=await run(f);assert.equal(result.ok,true);assert.deepEqual(f.trace.at(-1).args,approved[0]);
 const g=fixture(),guard=g.engine.guard.bind(g.engine);g.engine.guard=(exec,...rest)=>exec.name===PREFIX+'do'?'synthetic independent guard':guard(exec,...rest);
 const denied=await run(g);assert.equal(denied.ok,false);assert.ok(!g.effects.includes(PREFIX+'do'));assert.equal(denied.status,'uncertain');
});
test('model request_id, evidence and budget-label changes cannot repeat a confirmed business action',async()=>{
 const f=fixture(),a=await run(f,{...input,arguments:'{"id":"fixture-action","request_id":"random-one"}'});
 const b=await run(f,{...input,category:'social',cost:1,evidence:'different quote',arguments:'{"request_id":"random-two","id":"fixture-action"}'});
 assert.equal(a.ok,true);assert.equal(b.ok,true);assert.equal(b.reused,true);assert.equal(a.receiptId,b.receiptId);assert.equal(a.requestId,b.requestId);
 assert.notEqual(a.requestId,'random-one');assert.equal(f.trace.length,3);
});
test('fallback evidence is one exact action ID line from a current successful receipt',async()=>{
 const f=fixture(),captured=[],original=f.engine.intent.bind(f.engine);f.engine.intent=args=>{captured.push(args.evidence);return original(args);};
 const result=await run(f,{...input,evidence:'a rewritten untrusted quote'});assert.equal(result.ok,true);
 assert.equal(captured[0],'合成现场：允许 fixture-action；0 贝');assert.equal(f.trace.length,3);
 const say=fixture({nowText:'合成消息：peer#3（当面）：\n> 你好'}),reply=await run(say,{tool:PREFIX+'say',arguments:'{"fish":"peer#3","text":"你好"}',category:'social',cost:0});
 assert.equal(reply.ok,true);assert.equal(say.trace.at(-1).args.fish,'peer#3');
});
test('ambiguous IDs, ID prefixes and unsupported action types cannot borrow generic evidence',async()=>{
 for(const [options,args]of [
  [{nowText:'· fixture-action 可以做\n· fixture-action 已过期'},input],
  [{nowText:'· fixture-action-long 可以做'},input],
  [{},{tool:PREFIX+'update',arguments:'{"outfit":"fixture-shirt"}',category:'daily',cost:0}],
 ]){
  const f=fixture(options),result=await run(f,{...args,evidence:''});assert.equal(result.ok,false);assert.deepEqual(f.effects,args.tool===PREFIX+'do'?[PREFIX+'now']:[PREFIX+'now',PREFIX+'profile']);assert.equal(result.notSubmitted,true);assert.ok(!f.effects.includes(args.tool));
 }
});
test('valid explicit evidence wins over fallback ambiguity without guessed prices',async()=>{
 const f=fixture({nowText:'· fixture-action 免费\n· fixture-action 有另一条记录'}),r=await run(f,{...input,evidence:'· fixture-action 免费'});assert.equal(r.ok,true);
 const paid=fixture({nowText:'· fixture-action 价格8贝'}),denied=await run(paid,{...input,cost:0,evidence:''});assert.equal(denied.ok,false);assert.ok(!paid.effects.includes(PREFIX+'do'));
});
test('an explicit same-call local guard denial is not submitted and does not cause a paid recovery loop',async()=>{
 const f=fixture({trackGuardRejections:true,afterResult:async(exec,e)=>{if(exec.name===PREFIX+'profile')e.l.queue.push({id:'urgent-new',priority:0,status:'pending',t:start+1});}});
 const result=await run(f);assert.equal(result.ok,false);assert.equal(result.status,'blocked');assert.equal(result.notSubmitted,true);
 assert.equal(f.engine.l.recovery,false);assert.equal(f.engine.l.round.status,'running');assert.equal(f.effects.length,2);
 assert.equal(f.engine.l.journal.filter(j=>j.tool).length,2);
 const sequence=Object.values(f.engine.l.round.actionSequences)[0],action=sequence.calls.at(-1);
 assert.equal(action.status,'not-submitted');assert.equal(action.guardRejection.source,'local-engine.guard-rejection');
 assert.equal(action.guardRejection.callId,action.id);assert.equal(action.guardRejection.roundId,f.engine.l.round.id);
 const repeated=await run(f,{...input,arguments:'{"id":"fixture-action","request_id":"new-random-id"}'});
 assert.equal(repeated.reused,true);assert.equal(repeated.notSubmitted,true);assert.equal(f.trace.length,3);
});
function extractNativeRuntime(asar,scratch){
 assert.ok(scratch,'Managed scratch is required');
 const fd=fs.openSync(asar,'r'),head=Buffer.alloc(16);fs.readSync(fd,head,0,16,0);
 const hs=head.readUInt32LE(4),raw=Buffer.alloc(head.readUInt32LE(12));fs.readSync(fd,raw,0,raw.length,16);const tree=JSON.parse(raw);
 const target=path.join(scratch,'action-sdk'),queue=['@deepseek-ai/dsh-tool-executor-native'],seen=new Set();
 fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'package.json'),'{"type":"module"}');
 const find=p=>{let n=tree;for(const part of p.split('/'))n=n?.files?.[part];return n;};
 try{while(queue.length){
  const pkg=queue.shift();if(seen.has(pkg))continue;seen.add(pkg);const prefix=['dsh/node_modules/'+pkg,'node_modules/'+pkg].find(p=>find(p));assert.ok(prefix,'Missing runtime package '+pkg);
  function copy(node,relative=''){for(const[name,n]of Object.entries(node.files||{})){const q=relative?relative+'/'+name:name;if(n.files){copy(n,q);continue;}if(!/\.(js|mjs|cjs|json)$/.test(name))continue;
   let bytes;if(n.unpacked)bytes=fs.readFileSync(asar+'.unpacked/'+prefix+'/'+q);else{bytes=Buffer.alloc(n.size);fs.readSync(fd,bytes,0,bytes.length,8+hs+Number(n.offset));}
   const file=path.join(target,'node_modules',pkg,q);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
   if(/\.(js|mjs|cjs)$/.test(name))for(const m of bytes.toString().matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)){const dep=m[1];if(dep.startsWith('.')||dep.startsWith('node:'))continue;
    const key=dep.startsWith('@')?dep.split('/').slice(0,2).join('/'):dep.split('/')[0];if(!['fs','path','crypto','os','url','util','stream','events','buffer','assert','async_hooks','module'].includes(key))queue.push(key);
   }
  }}copy(find(prefix));
 }}finally{fs.closeSync(fd);}return target;
}
test('installed NativeToolExecutor pipeline runs guard/result observers with no orphan session surface',async t=>{
 if(!process.env.DSH_ASAR){t.skip('Set DSH_ASAR for exact installed native pipeline integration');return;}
 const runtime=extractNativeRuntime(process.env.DSH_ASAR,process.env.THINKSTAR_TEST_TMP),{NativeToolExecutor}=await import(pathToFileURL(path.join(runtime,'node_modules/@deepseek-ai/dsh-tool-executor-native/lib/index.js')).href);
 const f=fixture(),guarded=[],observed=[];
 const registry={executable:name=>f.definitions.find(d=>d.name===name),checkGuards(exec){guarded.push(exec.name);const reason=f.engine.guard(exec,true,false);return reason?{reason}:undefined;}};
 const ctx={tools:registry,waterfall:async(...args)=>args.at(-1)(),get:()=>undefined,logger:{warn:message=>assert.fail(message)},
  events:{dispatch:()=>[(exec,result)=>{observed.push(exec.name);f.engine.result(exec,result);}]}};
 const executor=new NativeToolExecutor(ctx,()=>1),official={definitions:()=>f.definitions,selectExecutor:()=>executor,execute:batch=>{assert.equal(batch.log,undefined);return executor.execute(batch);}};
 const result=await executeSequencedAction({...f,tools:official},input);
 assert.equal(result.ok,true);assert.deepEqual(guarded,['now','profile','do'].map(n=>PREFIX+n));assert.deepEqual(observed,guarded);
 assert.equal(f.surface.length,0);assert.equal(f.engine.l.journal.filter(j=>j.tool&&j.status==='confirmed').length,3);
 assert.equal(Object.values(f.engine.l.round.actionSequences)[0].parent.source,'official-session/event-tool/call');
});

test('life rendering preserves receipt IDs, action facts, approved arguments and failures',()=>{
 for(const value of [{ok:true,arguments:{id:'fixture-action',request_id:'exact-id'}},{ok:true,receiptId:'receipt-fixture',facts:['receipt-fixture'],result:{content:[{type:'text',text:'合成成功'}]}},{ok:false,message:'合成失败'}]){
  assert.deepEqual(JSON.parse(renderLifeTool({},value)[0].text),value);
 }
});

test('actual Aurabot defineTool and NativeToolExecutor show action facts and finish in one attempt',async t=>{
 if(!process.env.DSH_ASAR||!process.env.AURABOT_SOURCE){t.skip('Set DSH_ASAR and AURABOT_SOURCE for installed Aurabot/native rendering integration');return;}
 const {defineTool}=await import(pathToFileURL(path.join(process.env.AURABOT_SOURCE,'src/tools/tools.js')).href);
 const runtime=extractNativeRuntime(process.env.DSH_ASAR,process.env.THINKSTAR_TEST_TMP),{NativeToolExecutor}=await import(pathToFileURL(path.join(runtime,'node_modules/@deepseek-ai/dsh-tool-executor-native/lib/index.js')).href);
 const f=fixture();Object.assign(f.engine.l.round,{events:[],planIds:[]});
 let official;const action=defineTool({name:'fish_life_action',render:renderLifeTool,execute:(args,exec)=>executeSequencedAction({...f,tools:official,exec},args)});
 const finish=defineTool({name:'fish_life_finish',render:renderLifeTool,execute:args=>f.engine.finish(args)});
 const definitions=[...f.definitions,action,finish],registry={executable:name=>definitions.find(d=>d.name===name),checkGuards(exec){const reason=f.engine.guard(exec,true,false);return reason?{reason}:undefined;}};
 const ctx={tools:registry,waterfall:async(...args)=>args.at(-1)(),get:()=>undefined,logger:{warn:message=>assert.fail(message)},events:{dispatch:()=>[(exec,result)=>f.engine.result(exec,result)]}};
 const executor=new NativeToolExecutor(ctx,()=>1);official={definitions:()=>definitions,selectExecutor:()=>executor,execute:batch=>executor.execute(batch)};
 const invoke=async(name,id,args)=>{const batch=await official.execute({calls:[{type:'tool-call',id,name,arguments:JSON.stringify(args)}],agent:f.exec.agent,signal:f.controller.signal,toolSet:f.exec.toolSet,maxParallelToolCalls:1});return batch.results[0].result;};
 const result=await invoke('fish_life_action',f.exec.callId,input),visible=JSON.parse(result.content[0].text);
 assert.equal(visible.ok,true);assert.match(visible.receiptId,/^fishseq-/);assert.deepEqual(visible.facts,[visible.receiptId]);assert.equal(visible.result.content[0].text,'合成成功');
 const prepared=await invoke('fish_life_finish','finish-fixture',{summary:'合成动作已确认',events:[],importance:'routine',facts:visible.facts,share:''});
 assert.equal(JSON.parse(prepared.content[0].text).ok,true);assert.deepEqual(f.engine.l.round.report.facts,visible.facts);assert.equal(f.engine.l.round.calls,3);
 const invalid=await invoke('fish_life_finish','invalid-fixture',{summary:'不接受附带说明的伪编号',events:[],importance:'routine',facts:[PREFIX+'do(附加说明)'],share:''});
 const failure=JSON.parse(invalid.content[0].text);assert.equal(failure.ok,false);assert.ok(failure.message.includes(visible.receiptId));assert.ok(failure.message.includes(PREFIX+'do'));
 assert.equal(f.engine.l.round.calls,3,'Local formatting errors must not execute or replay world actions');assert.deepEqual(f.engine.l.round.report.facts,visible.facts);
});
