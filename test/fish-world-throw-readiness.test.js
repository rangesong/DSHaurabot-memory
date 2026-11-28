import test from 'node:test';
import assert from 'node:assert/strict';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {executeSequencedAction,noteActionSessionEvent,proveCurrentSpoiledDiscard} from '../extensions/aurabot/fish-world/action-sequence.mjs';
const W='mcp__fish-world__world_',now=Date.parse('2026-11-28T08:00:00+08:00');
const inventory='你的食材（做饭用）：鸡蛋 egg 6 个（不新鲜了）、葱 scallion 1 把（用了一些，还剩 4 份）（坏了）、大米 rice 1 袋（用了一些，还剩 1 份）';
const template='你的家（合成住处）· 不要的东西 world_do 填 throw- 加 id 扔掉，count 是扔几件 · 摆着的换房间填 put- 加它的 home- 编号，name 填房间';
const view=['11-28 周六 08:00 · 晴 6°C','你在：家 · 厨房',template,inventory].join('\n');
const input={tool:W+'do',arguments:'{"id":"throw-scallion","count":1}',category:'daily',cost:0,evidence:inventory};
function fixture(){
 const data={version:3,fishId:'synthetic#1',state:{},at:{state:now},life:newLife(now)},bridge={data,change:fn=>fn(data)};
 const engine=new LifeEngine({bridge,clock:()=>now,host:{idle:async()=>true},identity:()=>({owner:'synthetic-owner',persona:'synthetic'}),settings:()=>({maxCalls:6})});
 Object.assign(engine.l,{owner:'synthetic-owner',persona:'synthetic'});
 const agent={session:{id:'synthetic-session'}},signal=new AbortController().signal,trace=[],state={view};
 engine.l.round={id:'synthetic-round',sessionId:agent.session.id,status:'running',revision:engine.l.revision,startedAt:now,receipts:[],calls:0,readOnly:false,observation:''};
 const tools={definitions:()=>['now','profile','say','do'].map(name=>({name:W+name})),selectExecutor:()=>({describe:schemas=>({schemas})}),async execute(batch){
  assert.equal(batch.log,undefined);assert.equal(batch.maxParallelToolCalls,1);const results=[];
  for(const call of batch.calls){const exec={name:call.name,callId:call.id,arguments:JSON.parse(call.arguments),agent,signal};trace.push(exec.name);
   const denied=engine.guard(exec,true,false),text=exec.name===W+'now'?state.view:exec.name===W+'profile'?'synthetic#1\n合成本鱼身份':'好的，扔掉了合成坏原料。';
   const result={isError:!!denied,content:[{type:'text',text:denied||text}]};engine.result(exec,result);results.push({callId:call.id,result});
  }return {results};
 }};
 const exec={agent,signal,callId:'synthetic-parent'};noteActionSessionEvent(engine,agent.session,{type:'tool/call',seq:1,data:{name:'fish_life_action',callId:exec.callId,turn:1,step:1}});
 let reads=0;const read=async tool=>tools.execute({calls:[{id:'synthetic-read-'+(++reads),name:W+tool,arguments:'{}'}],agent,signal,maxParallelToolCalls:1});
 return {engine,tools,exec,trace,read,state};
}
test('a current declared throw template and exact own spoiled ingredient should be actionable through the unchanged wrapper guards',async t=>{
 const f=fixture();await f.read('now');const r=await executeSequencedAction(f,input);
 t.diagnostic(JSON.stringify({status:r.status,code:r.code,message:r.message,notSubmitted:r.notSubmitted,worldCalls:f.trace.length,mutationCalls:f.trace.filter(tool=>tool===W+'do').length,modelCalls:0,realWorldCalls:0,qqSends:0}));
 assert.equal(r.ok,true);assert.deepEqual(f.trace,[W+'now',W+'profile',W+'do']);
});
test('the real LifeEngine intent must accept exact current spoiled-inventory evidence for the declared throw template',async t=>{
 const f=fixture();await f.read('now');await f.read('profile');
 let result,error;try{result=f.engine.intent(input);}catch(caught){error=caught;}
 t.diagnostic(JSON.stringify({ok:!!result?.ok,error:error?.message,currentIdentity:f.engine.l.round.identityConfirmed,exactCurrentEvidence:f.engine.l.round.receipts[0].text.includes(inventory),modelCalls:0,realWorldCalls:0,qqSends:0}));
 assert.equal(error,undefined);assert.equal(result.ok,true);
});
test('only unique own currently spoiled items can use the declared template, without borrowing another item status',async()=>{
 const invalid=[view.replace('（坏了）','（不新鲜了）'),view.replace('鸡蛋 egg 6 个（不新鲜了）','鸡蛋 egg 6 个（坏了）').replace('）（坏了）','）'),view.replace(inventory,'> '+inventory),view.replace('你的食材（做饭用）：','别人的食材（做饭用）：'),view.replace(template,'> '+template),view.replace('家 · 厨房','合成超市 · 后排货架'),view+'\n'+inventory,view.replace('、大米 rice','、另一把葱 scallion 1 把（坏了）、大米 rice')];
 for(const text of invalid){const f=fixture();f.state.view=text;await f.read('now');assert.equal(proveCurrentSpoiledDiscard(f.engine,{id:'throw-scallion',count:1}),null);assert.equal(f.trace.includes(W+'do'),false);}
 const f=fixture();await f.read('now');
 for(const args of [{id:'throw-egg'},{id:'cook-scallion'},{id:'throw-scallion-long'},...[0,-1,1.5,2,11].map(count=>({id:'throw-scallion',count}))])assert.equal(proveCurrentSpoiledDiscard(f.engine,args),null,JSON.stringify(args));
});
test('the proof binds current original journal text and loses validity after mutation or a newer fresh item view',async()=>{
 for(const mode of ['confirmed','uncertain','executing','journal-text','foreign-session','new-view','old-time']){
  const f=fixture();await f.read('now');const j=f.engine.l.journal.at(-1);
  if(['confirmed','uncertain','executing'].includes(mode))f.engine.l.journal.push({id:'later',tool:W+'do',round:f.engine.l.round.id,sessionId:f.exec.agent.session.id,args:'{"id":"buy-fixture"}',status:mode,at:now,finishedAt:now,result:'合成后续'});
  if(mode==='journal-text')j.result+='伪造差异';if(mode==='foreign-session')j.sessionId='foreign';
  if(mode==='old-time'){j.at=now-240000;j.finishedAt=now-240000;f.engine.l.round.startedAt=now-240001;}
  if(mode==='new-view'){f.state.view=view.replace('（坏了）','（新鲜）');await f.read('now');}
  assert.equal(proveCurrentSpoiledDiscard(f.engine,{id:'throw-scallion',count:1}),null,mode);
 }
});
