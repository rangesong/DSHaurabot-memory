import test from 'node:test';
import assert from 'node:assert/strict';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {executeSequencedAction,noteActionSessionEvent} from '../extensions/aurabot/fish-world/action-sequence.mjs';
const W='mcp__fish-world__world_',at=Date.parse('2026-11-27T20:42:00+08:00');
const roomLine='· 合成厨房：灶台（倒杯热水喝 hot-water、做饭 cook-，会做14道，现在够做3道）';
const living='11-27 周五 20:42\n你在：家 · 客厅\n别的房间（world_do 填那里的事就自己走过去；只过去看看，world_go 填房间名）：\n'+roomLine;
const menu='11-27 周五 20:44\n你在：家 · 合成厨房\n做饭：\n· 白米饭 cook-white-rice —— 米1份，0贝';
const input={tool:W+'do',arguments:'{"id":"cook-rice"}',category:'daily',cost:0,evidence:'米 rice，做饭 cook-，所以 cook-rice'};
function fixture(){
 const data={version:3,fishId:'synthetic#1',state:{},at:{state:at},life:newLife(at)},clock={now:at};
 const bridge={data,identityReady:true,change:fn=>fn(data)},engine=new LifeEngine({bridge,host:{idle:async()=>true},clock:()=>clock.now,identity:()=>({owner:'synthetic-owner',persona:'synthetic'}),settings:()=>({maxCalls:12})});
 Object.assign(engine.l,{owner:'synthetic-owner',persona:'synthetic'});
 const signal=new AbortController().signal,agent={session:{id:'session-synthetic'}},trace=[];
 engine.l.round={id:'round-synthetic',sessionId:agent.session.id,status:'running',revision:engine.l.revision,startedAt:at,receipts:[],calls:0,observation:'',readOnly:false};
 const f={engine,clock,trace,text:living,timeout:false};
 const tools={definitions:()=>['now','profile','say','go','do','update'].map(n=>({name:W+n})),selectExecutor:()=>({describe:defs=>({schemas:defs})}),async execute(batch){
  assert.equal(batch.log,undefined);assert.equal(batch.maxParallelToolCalls,1);
  const results=[];for(const call of batch.calls){const exec={name:call.name,callId:call.id,arguments:JSON.parse(call.arguments),agent,signal};trace.push({tool:exec.name,args:exec.arguments});
   const denied=engine.guard(exec,true,false);let result;
   if(denied)result={isError:true,content:[{type:'text',text:denied}]};
   else if(f.timeout&&exec.name===W+'do')result={isError:true,content:[{type:'text',text:'timeout: synthetic'}]};
   else result={isError:false,content:[{type:'text',text:exec.name===W+'now'?f.text:exec.name===W+'profile'?(f.profileText||'synthetic#1\n合成身份'):'好的。'}]};
   engine.result(exec,result);results.push({callId:call.id,result});
  }return {results};
 }};
 const exec={agent,signal,callId:'parent-synthetic'};
 noteActionSessionEvent(engine,agent.session,{type:'tool/call',seq:1,data:{name:'fish_life_action',callId:exec.callId,turn:1,step:1}});
 f.run=args=>executeSequencedAction({engine,tools,exec},args||input);
 let reads=0;f.observe=async text=>{f.text=text;clock.now+=1000;await tools.execute({calls:[{id:'read-'+(++reads),name:W+'now',arguments:'{}'}],agent,signal,maxParallelToolCalls:1});};
 return f;
}
test('missing full action options stops before profile and supplies a local guarded room suggestion',async()=>{
 const f=fixture();await f.observe(living);const before=f.trace.length,r=await f.run();
 assert.equal(r.ok,false);assert.equal(r.status,'blocked');assert.equal(r.notSubmitted,true);assert.equal(r.code,'need-options');assert.equal(r.retryableAfterObservation,true);
 assert.equal(f.trace.length,before,'No identity or mutation call before exact options');
 assert.deepEqual(r.nextAction,{tool:'fish_life_action',arguments:{tool:W+'go',arguments:JSON.stringify({place:'合成厨房'}),category:'daily',cost:0,evidence:roomLine}});
 assert.deepEqual(r.then,{tool:W+'now',arguments:{}});assert.equal(f.engine.l.recovery,false);
});
test('an omitted go quote is recovered only from the latest authoritative exact home room row',async()=>{
 const f=fixture();await f.observe(living);const blocked=await f.run(),{evidence:omitted,...go}=blocked.nextAction.arguments;
 const intent=f.engine.intent.bind(f.engine);let usedEvidence;f.engine.intent=args=>{usedEvidence=args.evidence;return intent(args);};
 const r=await f.run(go);assert.equal(r.ok,true);assert.deepEqual(f.trace.map(x=>x.tool),[W+'now',W+'profile',W+'go']);
 assert.equal(f.trace.at(-1).args.place,'合成厨房');assert.equal(usedEvidence,roomLine);
});

test('a bare advertised action family suggests inspection without guessing a complete executable ID',async()=>{
 for(const id of ['cook','cook-']){
  const f=fixture();await f.observe(living);const r=await f.run({...input,arguments:JSON.stringify({id})});
  assert.equal(r.notSubmitted,true);assert.equal(r.nextAction.arguments.evidence,roomLine);assert.equal(f.trace.length,1);
 }
 const f=fixture();await f.observe(living);assert.equal((await f.run({...input,arguments:'{"id":"coo"}'})).nextAction,undefined);
});

test('corrected exact evidence can release a non-submitted preparation hold on the same observation once',async()=>{
 const f=fixture(),line='· 合成公园（world_go 填合成公园）';await f.observe('11-27 周五 20:42\n你在：家 · 客厅\n'+line);
 const go={tool:W+'go',arguments:'{"place":"合成公园"}',category:'daily',cost:0};
 const first=await f.run(go),again=await f.run(go);assert.equal(first.notSubmitted,true);assert.equal(again.reused,true);assert.equal(f.trace.length,2);
 const rejected=await f.run({...go,evidence:'合成公园，我猜可以去'});assert.equal(rejected.reused,true);assert.equal(f.trace.length,2);
 const corrected=await f.run({...go,evidence:line});assert.equal(corrected.ok,true);assert.equal(f.trace.filter(x=>x.tool===W+'go').length,1);
 const duplicate=await f.run({...go,evidence:line});assert.equal(duplicate.reused,true);assert.equal(duplicate.receiptId,corrected.receiptId);assert.equal(f.trace.filter(x=>x.tool===W+'go').length,1);
});
test('omitted go evidence never comes from old/profile/quoted/ambiguous or different-room material',async()=>{
 const go={tool:W+'go',arguments:'{"place":"合成厨房"}',category:'daily',cost:0};
 for(const text of [living.replace(roomLine,'> '+roomLine),living+'\n'+roomLine,living.replace('合成厨房：','合成后厨：'),living.replace('家 · 客厅','合成餐馆 · 大厅'),'11-27 周五 20:44\n你在：家 · 客厅\n—— '+roomLine]){
  const f=fixture();await f.observe(living);await f.observe(text);f.profileText='synthetic#1\n'+roomLine;
  const r=await f.run(go);assert.equal(r.ok,false);assert.equal(r.notSubmitted,true);assert.equal(f.trace.some(x=>x.tool===W+'go'),false);
 }
});
test('non-do actions retain identity-first evidence supplied by the automatic self profile',async()=>{
 const f=fixture();f.profileText='synthetic#1\n合成衣柜：已有 synthetic-shirt';await f.observe(living);
 const r=await f.run({tool:W+'update',arguments:'{"outfit":"synthetic-shirt"}',category:'daily',cost:0,evidence:'合成衣柜：已有 synthetic-shirt'});
 assert.equal(r.ok,true);assert.deepEqual(f.trace.map(x=>x.tool),[W+'now',W+'profile',W+'update']);assert.equal(f.trace.at(-1).args.outfit,'synthetic-shirt');
});
test('the latest successful now overrides old options, profiles and concatenated model quotes',async()=>{
 const f=fixture();await f.observe(menu);await f.observe(living);
 f.engine.l.round.receipts.push({id:'profile-old',tool:W+'profile',text:'· 白米饭 cook-white-rice —— 0贝',isError:false});
 const r=await f.run({...input,arguments:'{"id":"cook-white-rice"}',evidence:'· 白米饭 cook-white-rice —— 米1份，0贝'});
 assert.equal(r.ok,false);assert.equal(r.code,'need-options');assert.equal(f.trace.some(x=>x.tool===W+'profile'||x.tool===W+'do'),false);
});
test('same snapshot and changed model args metadata reuse the hold, while changed real now can validate again',async()=>{
 const f=fixture();await f.observe(living);const a=await f.run();await f.observe(living);
 const b=await f.run({...input,evidence:roomLine,arguments:'{"id":"cook-rice","request_id":"changed"}'});
 assert.equal(b.reused,true);assert.equal(b.evidenceSnapshot,a.evidenceSnapshot);assert.equal(f.trace.filter(x=>x.tool===W+'profile').length,0);
 await f.observe('11-27 周五 20:44\n你在：家 · 合成厨房\n· 合成菜 cook-rice —— 0贝');
 const c=await f.run();assert.equal(c.ok,true);assert.deepEqual(f.trace.slice(-2).map(x=>x.tool),[W+'profile',W+'do']);
});
test('fresh exact full menu permits do immediately without moving rooms, even with stale supplied evidence',async()=>{
 const f=fixture();await f.observe(menu);const r=await f.run({...input,arguments:'{"id":"cook-white-rice"}'});
 assert.equal(r.ok,true);assert.equal(f.trace.some(x=>x.tool===W+'go'),false);assert.equal(f.trace.at(-1).args.id,'cook-white-rice');
});
test('wrong guessed ID returns at most six unchanged current option lines without choosing one',async()=>{
 const f=fixture(),lines=Array.from({length:8},(_,i)=>'· 合成菜'+i+' cook-choice-'+i+' —— 0贝');
 await f.observe(menu.split('\n').slice(0,3).join('\n')+'\n'+lines.join('\n')+'\n> · 旧菜 cook-quoted —— 0贝');
 const r=await f.run();assert.equal(r.ok,false);assert.deepEqual(r.optionLines,lines.slice(0,6));assert.equal(r.nextAction,undefined);assert.equal(f.trace.length,1);
});
test('ambiguous rooms, quoted room rows, nonhome views and action ID prefixes never invent a route',async()=>{
 for(const text of [living+'\n· 合成后厨：另一炉子（做饭 cook-）',living.replace(roomLine,'> '+roomLine),living.replace('家 · 客厅','合成餐馆 · 大厅'),menu.replace('cook-white-rice','cook-rice-long')]){
  const f=fixture();await f.observe(text);const r=await f.run();assert.equal(r.ok,false);assert.equal(r.notSubmitted,true);assert.equal(r.nextAction,undefined);assert.equal(f.trace.length,1);
 }
});
test('a quoted complete action line cannot stand in for the latest real options',async()=>{
 const f=fixture();await f.observe('11-27 周五 20:44\n你在：家 · 客厅\n> · 白米饭 cook-rice —— 0贝');
 const r=await f.run({...input,evidence:'> · 白米饭 cook-rice —— 0贝'});assert.equal(r.ok,false);assert.equal(r.notSubmitted,true);assert.equal(f.trace.length,1);
});
test('confirmed actions cannot replay after a new observation or changed evidence and request ID',async()=>{
 const f=fixture();await f.observe(menu);const args={...input,arguments:'{"id":"cook-white-rice"}'},a=await f.run(args);await f.observe(menu+'\n天气变了');
 const b=await f.run({...args,evidence:'new',arguments:'{"id":"cook-white-rice","request_id":"new"}'});
 assert.equal(a.ok,true);assert.equal(b.reused,true);assert.equal(b.receiptId,a.receiptId);assert.equal(f.trace.filter(x=>x.tool===W+'do').length,1);
});
test('parallel revalidation dispatches one action and a submitted unknown remains sealed',async()=>{
 const f=fixture();await f.observe(living);await f.run();await f.observe('11-27 周五 20:44\n你在：家 · 合成厨房\n· 合成菜 cook-rice —— 0贝');
 const [a,b]=await Promise.all([f.run(),f.run()]);assert.equal(a.ok,true);assert.equal(b.receiptId,a.receiptId);assert.equal(f.trace.filter(x=>x.tool===W+'do').length,1);
 const g=fixture();await g.observe(menu);g.timeout=true;const args={...input,arguments:'{"id":"cook-white-rice"}'},u=await g.run(args),again=await g.run(args);
 assert.equal(u.status,'uncertain');assert.equal(u.notSubmitted,false);assert.equal(again.reused,true);assert.equal(g.trace.filter(x=>x.tool===W+'do').length,1);
});
