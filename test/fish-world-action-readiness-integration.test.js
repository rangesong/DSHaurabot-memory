import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {executeSequencedAction,noteActionSessionEvent,noteActionGuardRejected} from '../extensions/aurabot/fish-world/action-sequence.mjs';
import {renderLifeTool} from '../extensions/aurabot/fish-world/tool-output.mjs';

const W='mcp__fish-world__world_',NOW=Date.parse('2026-11-27T20:42:00+08:00');
// Verified server protocol, with anonymous inventory counts and no private text.
const ROOM_HEADER='别的房间（world_do 填那里的事就自己走过去；只过去看看，world_go 填房间名）：';
const ROOM_LINE='· 厨房：灶台（倒杯热水喝 hot-water、做饭 cook-，会做 4 道，现在够做 2 道）、小冰箱（空的）';
const EXACT_LINE='· 做白米饭 cook-white-rice：用合成大米 1 份，0 贝';
const prefix=room=>['11-27 周五 20:42 · 晴 6°C','你在：家 · '+room,'身体：合成饱食 · 合成精力',''];
const living=()=>[...prefix('客厅'),ROOM_HEADER,ROOM_LINE].join('\n');
const kitchen=()=>[...prefix('厨房'),'厨房（world_do）：',EXACT_LINE].join('\n');
const invalid={tool:W+'do',arguments:'{"id":"cook-rice"}',category:'daily',cost:0,evidence:ROOM_LINE};
function fixture(options={}){
 let nativeStep=0,room='客厅',clock=NOW,seq=0;
 const identity={owner:'synthetic-owner',persona:'synthetic-persona'},data={fishId:'synthetic-fish#1',at:{state:NOW},state:{where:{kind:'home'},doing:null},life:{...newLife(NOW),...identity}};
 const bridge={data,change:fn=>fn(data)},engine=new LifeEngine({bridge,host:{cancel:async()=>{},idle:async()=>true,send:async()=>assert.fail('No QQ send')},clock:()=>clock,identity:()=>identity,settings:()=>({maxCalls:6})});
 const agent={session:{id:'session-synthetic-readiness',append:()=>assert.fail('No orphan session surface')}},signal=new AbortController().signal;
 const round=engine.l.round={id:'synthetic-readiness-round',kind:'idle',sessionId:agent.session.id,status:'running',priority:4,revision:engine.l.revision,startedAt:NOW,receipts:[],calls:0,events:[],planIds:[],observation:'',intent:null};
 const trace=[],effects=[],native=[];
 const definitions=['now','profile','guide','go','do','say'].map(name=>({name:W+name,async execute(args){
  effects.push({name:W+name,args:structuredClone(args)});
  if(name==='now')return options.nowText?.()||(room==='厨房'?kitchen():living());
  if(name==='profile')return 'synthetic-fish#1\n合成本鱼身份';
  if(name==='guide')return '做饭动作以 cook- 开头；真实菜谱须从现场读取。';
  if(name==='go'){assert.equal(args.place,'厨房');room='厨房';return '好的，你走进了厨房。';}
  if(name==='do'){assert.equal(args.id,'cook-white-rice','only the exact observed complete ID may execute');return options.timeoutAction?'timeout: synthetic unknown action result':'好的，你在灶上做白米饭 1 份，用了合成大米 1 份，20:50 做好。\n—— 现在 20:42 · 在家 · 同时：做白米饭（20:50 做好）';}
  return '合成成功';
 }}));
 const tools={definitions:()=>definitions,selectExecutor:()=>({describe:defs=>({schemas:defs.map(def=>({name:def.name}))})}),async execute(batch){
  assert.equal(batch.log,undefined);assert.equal(batch.agent,agent);assert.equal(batch.signal,signal);assert.equal(batch.maxParallelToolCalls,1);
  const results=[];for(const call of batch.calls){const exec={name:call.name,callId:call.id,arguments:JSON.parse(call.arguments),agent,signal,toolSet:batch.toolSet};trace.push({name:call.name,args:structuredClone(exec.arguments)});
   const denied=engine.guard(exec,true,false);let result;
   if(denied){noteActionGuardRejected(engine,exec,denied);result={isError:true,content:[{type:'text',text:denied}]};}
   else {const text=await definitions.find(def=>def.name===call.name).execute(exec.arguments);result={isError:options.timeoutAction&&call.name===W+'do',content:[{type:'text',text}]};}
   engine.result(exec,result);clock+=10;results.push({callId:call.id,result});
  }return {results,additionalContexts:[],concluded:false};
 }};
 const parent=(name,args)=>{nativeStep++;const exec={name,callId:'native-parent-'+(++seq),agent,signal,toolSet:{synthetic:true}};native.push({step:nativeStep,name,args:structuredClone(args)});if(name==='fish_life_action')noteActionSessionEvent(engine,agent.session,{type:'tool/call',seq, data:{turn:1,step:nativeStep,callId:exec.callId,name,arguments:JSON.stringify(args)}});return exec;};
 const action=args=>executeSequencedAction({engine,tools,exec:parent('fish_life_action',args)},args);
 const manual=async(name,args={})=>{const exec=parent(W+name,args);const batch=await tools.execute({calls:[{type:'tool-call',id:exec.callId,name:exec.name,arguments:JSON.stringify(args)}],agent,signal,maxParallelToolCalls:1});return batch.results[0].result;};
 const intent=args=>{parent('fish_life_intent',args);try{return engine.intent(args);}catch(error){return {ok:false,message:error.message};}};
 return {engine,round,data,trace,effects,native,action,manual,intent,tools,getRoom:()=>room};
}

test('anonymous replay of the actual ten native calls avoids spending profile calls on the invalid prefix action',async t=>{
 const f=fixture();await f.manual('now');await f.manual('guide',{topic:'food'});
 const first=await f.action(invalid),again=await f.action({...invalid,arguments:'{"id":"cook-rice","request_id":"changed"}'});
 await f.manual('now',{full:true});await f.manual('do',{id:'cook-rice',count:1});f.intent(invalid);await f.manual('profile');const third=await f.action(invalid);f.intent(invalid);
 assert.equal(f.native.length,10);assert.equal(f.effects.some(call=>call.name===W+'do'),false);assert.equal(f.engine.l.recovery,false);
 t.diagnostic(JSON.stringify({nativeSteps:f.native.length,worldBodies:f.effects.length,profileBodies:f.effects.filter(call=>call.name===W+'profile').length,mutations:0,allLocalFailuresNotSubmitted:[first,again,third].every(r=>r.notSubmitted===true)}));
 assert.equal(first.notSubmitted,true);assert.equal(again.notSubmitted,true);assert.equal(third.notSubmitted,true);
 assert.equal(f.effects.length,4,'historical baseline dispatches five read-only bodies because preparation wastes one profile');
});

test('a unique prefix room produces a directly usable guarded action suggestion with no automatic navigation or profile',async()=>{
 const f=fixture();await f.manual('now');const before=structuredClone(f.data),result=await f.action(invalid);
 assert.equal(result.ok,false);assert.equal(result.status,'blocked');assert.equal(result.code,'need-options');assert.equal(result.notSubmitted,true);assert.equal(result.automaticReplay,false);
 assert.equal(f.effects.length,1);assert.equal(f.round.calls,1);assert.equal(f.getRoom(),'客厅');assert.deepEqual(f.data.state,before.state);assert.deepEqual(f.data.life.outbox,before.life.outbox);
 assert.deepEqual(result.nextAction,{tool:'fish_life_action',arguments:{tool:W+'go',arguments:'{"place":"厨房"}',category:'daily',cost:0,evidence:ROOM_LINE}});
 assert.deepEqual(result.then,{tool:W+'now',arguments:{}});assert.equal(typeof result.evidenceSnapshot,'string');
});

test('following the returned room suggestion then reading the actual menu completes exactly one cook in the original six-call allowance',async t=>{
 const f=fixture();await f.manual('now');await f.manual('guide',{topic:'food'});const blocked=await f.action(invalid);
 assert.equal(blocked.nextAction?.tool,'fish_life_action');const moved=await f.action(blocked.nextAction.arguments);assert.equal(moved.ok,true);
 assert.deepEqual(blocked.then,{tool:W+'now',arguments:{}});await f.manual('now',blocked.then.arguments);
 const options=await f.action(invalid);assert.equal(options.notSubmitted,true);assert.deepEqual(options.optionLines,[EXACT_LINE]);assert.notEqual(options.evidenceSnapshot,blocked.evidenceSnapshot);assert.equal(f.round.calls,5,'the fresh options hint does not consume another MCP call or select an action');
 const actual={tool:W+'do',arguments:'{"id":"cook-white-rice"}',category:'daily',cost:0,evidence:EXACT_LINE},result=await f.action(actual);
 assert.equal(result.ok,true);assert.equal(result.status,'confirmed');assert.equal(f.effects.filter(call=>call.name===W+'do').length,1);assert.equal(f.effects.find(call=>call.name===W+'do').args.id,'cook-white-rice');
 assert.equal(f.round.calls,6);assert.ok(f.round.calls<=f.engine.cfg.maxCalls);assert.equal(f.effects.filter(call=>call.name===W+'profile').length,1);
 const duplicate=await f.action({...actual,arguments:'{"id":"cook-white-rice","request_id":"different"}'});assert.equal(duplicate.reused,true);assert.equal(duplicate.receiptId,result.receiptId);assert.equal(f.round.calls,6);
 assert.equal(f.engine.l.recovery,false);assert.equal(f.engine.l.outbox.length,0);assert.equal(f.engine.l.plans.length,0);assert.equal(f.engine.l.ownerTasks?.length||0,0);assert.equal(f.engine.l.contextWindow,undefined);
 t.diagnostic(JSON.stringify({worldCalls:f.round.calls,limit:f.engine.cfg.maxCalls,go:1,cook:1,automaticNavigation:false,qqSends:0,modelCalls:0,realWorldCalls:0}));
});

test('an unchanged latest observation cannot be retried by changing budget, quote or request_id',async()=>{
 const f=fixture();await f.manual('now');const first=await f.action(invalid),before=f.effects.length;
 for(const input of [{...invalid,category:'social'},{...invalid,evidence:'rewritten claim'},{...invalid,arguments:'{"request_id":"new","id":"cook-rice"}'}]){
  const result=await f.action(input);assert.equal(result.reused,true);assert.equal(result.notSubmitted,true);assert.equal(result.evidenceSnapshot,first.evidenceSnapshot);
 }
 assert.equal(f.effects.length,before);assert.equal(f.round.calls,1);
});

test('a complete current menu ID can execute directly without requiring a redundant room movement',async()=>{
 const full=[...prefix('客厅'),ROOM_HEADER,'· 厨房：灶台（做白米饭 cook-white-rice，0 贝）'].join('\n');
 const f=fixture({nowText:()=>full});await f.manual('now');const result=await f.action({tool:W+'do',arguments:'{"id":"cook-white-rice"}',category:'daily',cost:0,evidence:'· 厨房：灶台（做白米饭 cook-white-rice，0 贝）'});
 assert.equal(result.ok,true);assert.equal(f.effects.filter(call=>call.name===W+'go').length,0);assert.equal(f.round.calls,3);
});

test('a pure preparation failure may be reevaluated after the latest authentic menu really supplies the same complete ID',async()=>{
 let ready=false;const f=fixture({nowText:()=>ready?[...prefix('厨房'),'厨房（world_do）：','· cook-rice 做合成饭，0 贝'].join('\n'):living()});await f.manual('now');const blocked=await f.action(invalid);assert.equal(blocked.notSubmitted,true);
 ready=true;await f.manual('now');const original=f.tools.definitions().find(def=>def.name===W+'do');original.execute=async args=>{f.effects.push({name:W+'do',args});assert.equal(args.id,'cook-rice');return '合成成功';};
 const result=await f.action({...invalid,evidence:'· cook-rice 做合成饭，0 贝'});assert.equal(result.ok,true);assert.equal(f.effects.filter(call=>call.name===W+'do').length,1);
});

test('unknown submitted outcomes preserve their original evidence and never execute again under a changed request_id',async()=>{
 const f=fixture({nowText:kitchen,timeoutAction:true});await f.manual('now');const action={tool:W+'do',arguments:'{"id":"cook-white-rice"}',category:'daily',cost:0,evidence:EXACT_LINE},first=await f.action(action);
 assert.equal(first.status,'uncertain');const before=f.effects.length;const repeated=await f.action({...action,arguments:'{"request_id":"changed","id":"cook-white-rice"}'});
 assert.equal(repeated.status,'uncertain');assert.equal(repeated.reused,true);assert.equal(repeated.receiptId,first.receiptId);assert.equal(f.effects.length,before);assert.equal(f.effects.filter(call=>call.name===W+'do').length,1);
});

function extractReadinessNative(asar,scratch){
 assert.ok(scratch,'Use the managed test runner');const fd=fs.openSync(asar,'r'),head=Buffer.alloc(16);fs.readSync(fd,head,0,16,0);const hs=head.readUInt32LE(4),raw=Buffer.alloc(head.readUInt32LE(12));fs.readSync(fd,raw,0,raw.length,16);const tree=JSON.parse(raw),target=path.join(scratch,'readiness-native-sdk'),queue=['@deepseek-ai/dsh-tool-executor-native'],seen=new Set(),find=p=>p.split('/').reduce((n,k)=>n?.files?.[k],tree);
 fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'package.json'),'{"type":"module"}');
 try{while(queue.length){const pkg=queue.shift();if(seen.has(pkg))continue;seen.add(pkg);const prefix=['dsh/node_modules/'+pkg,'node_modules/'+pkg].find(p=>find(p));assert.ok(prefix,'Missing installed runtime '+pkg);
  const copy=(node,relative='')=>{for(const[name,entry]of Object.entries(node.files||{})){const rel=relative?relative+'/'+name:name;if(entry.files){copy(entry,rel);continue;}if(!/\.(js|mjs|cjs|json)$/.test(name))continue;let bytes;if(entry.unpacked)bytes=fs.readFileSync(asar+'.unpacked/'+prefix+'/'+rel);else{bytes=Buffer.alloc(entry.size);fs.readSync(fd,bytes,0,bytes.length,8+hs+Number(entry.offset));}const file=path.join(target,'node_modules',pkg,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);if(/\.(js|mjs|cjs)$/.test(name))for(const match of bytes.toString().matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)){const spec=match[1];if(spec.startsWith('.')||spec.startsWith('node:'))continue;const dep=spec.startsWith('@')?spec.split('/').slice(0,2).join('/'):spec.split('/')[0];if(!['fs','path','crypto','os','url','util','stream','events','buffer','assert','async_hooks','module'].includes(dep))queue.push(dep);}}};copy(find(prefix));
 }}finally{fs.closeSync(fd);}return target;
}
test('actual native wrapper can follow a current room suggestion without model-supplied evidence',async t=>{
 if(!process.env.DSH_ASAR||!process.env.AURABOT_SOURCE){t.skip('Set DSH_ASAR and AURABOT_SOURCE for installed native readiness integration');return;}
 const root=extractReadinessNative(process.env.DSH_ASAR,process.env.THINKSTAR_TEST_TMP),[{NativeToolExecutor},{defineTool}]=await Promise.all([import(pathToFileURL(path.join(root,'node_modules/@deepseek-ai/dsh-tool-executor-native/lib/index.js')).href),import(pathToFileURL(path.join(process.env.AURABOT_SOURCE,'src/tools/tools.js')).href)]),f=fixture(),signal=new AbortController().signal,toolSet={synthetic:'native-readiness'},agent={session:{id:f.round.sessionId,append:()=>assert.fail('No orphan session surface')}};
 const guarded=[],observed=[],intents=[],nested=[];let official,sequence=0;
 const originalIntent=f.engine.intent.bind(f.engine);f.engine.intent=input=>{intents.push(structuredClone(input));return originalIntent(input);};
 const definitions=f.tools.definitions().map(def=>defineTool({name:def.name,properties:{},execute:async args=>({ok:true,message:await def.execute(args)})}));
 definitions.push(defineTool({name:'fish_life_action',render:renderLifeTool,execute:(args,exec)=>executeSequencedAction({engine:f.engine,tools:official,exec},args)}));
 const registry={executable:name=>definitions.find(def=>def.name===name),checkGuards(exec){guarded.push(exec.name);const reason=f.engine.guard(exec,true,false);if(reason)noteActionGuardRejected(f.engine,exec,reason);return reason?{reason}:undefined;}};
 const context={tools:registry,waterfall:async(...args)=>args.at(-1)(),get:()=>undefined,logger:{warn:message=>assert.fail(message)},events:{dispatch:()=>[(exec,result)=>{observed.push(exec.name);f.engine.result(exec,result);}]}};
 const executor=new NativeToolExecutor(context,()=>1);official={definitions:()=>definitions,selectExecutor:()=>executor,execute:batch=>{assert.equal(batch.log,undefined);assert.equal(batch.agent,agent);assert.equal(batch.signal,signal);assert.equal(batch.toolSet,toolSet);assert.equal(batch.maxParallelToolCalls,1);if(batch.calls[0].id.startsWith('fishseq-'))nested.push(batch.calls[0].name);return executor.execute(batch);}};
 const invoke=async(name,args)=>{const id='readiness-native-parent-'+(++sequence);if(name==='fish_life_action')noteActionSessionEvent(f.engine,agent.session,{type:'tool/call',seq:sequence,data:{turn:1,step:sequence,callId:id,name,arguments:JSON.stringify(args)}});const batch=await official.execute({calls:[{type:'tool-call',id,name,arguments:JSON.stringify(args)}],agent,signal,toolSet,maxParallelToolCalls:1});const result=batch.results[0].result;assert.equal(result.isError,false);return name==='fish_life_action'?JSON.parse(result.content[0].text):result;};
 await invoke(W+'now',{});const blocked=await invoke('fish_life_action',invalid);assert.equal(blocked.notSubmitted,true);assert.equal(f.effects.length,1);assert.equal(f.getRoom(),'客厅');
 const next={...blocked.nextAction.arguments};delete next.evidence;assert.equal(Object.hasOwn(next,'evidence'),false);const moved=await invoke('fish_life_action',next);assert.equal(moved.ok,true,moved.message);assert.equal(f.getRoom(),'厨房');
 assert.equal(intents.length,1);assert.equal(intents[0].evidence,ROOM_LINE);assert.equal(intents[0].tool,W+'go');assert.equal(JSON.parse(intents[0].arguments).place,'厨房');
 assert.deepEqual(nested,[W+'profile',W+'go']);assert.equal(f.effects.filter(e=>e.name===W+'go').length,1);assert.equal(f.effects.filter(e=>e.name===W+'do').length,0);assert.deepEqual(observed.filter(name=>name.startsWith(W)),guarded.filter(name=>name.startsWith(W)));assert.equal(observed.filter(name=>name==='fish_life_action').length,2);assert.equal(f.engine.l.journal.find(row=>row.id===moved.receiptId).status,'confirmed');assert.equal(f.round.calls,3);assert.ok(f.round.calls<=6);assert.equal(f.engine.l.recovery,false);assert.equal(f.engine.l.outbox.length,0);
 t.diagnostic(JSON.stringify({actualNativeToolExecutor:true,actualAurabotDefineTool:true,omittedEvidence:true,guardedRoomEvidence:true,worldCalls:f.round.calls,limit:6,modelCalls:0,realWorldCalls:0,qqSends:0}));
});
