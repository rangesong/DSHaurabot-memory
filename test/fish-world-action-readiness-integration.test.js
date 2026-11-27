import test from 'node:test';
import assert from 'node:assert/strict';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {executeSequencedAction,noteActionSessionEvent,noteActionGuardRejected} from '../extensions/aurabot/fish-world/action-sequence.mjs';

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
