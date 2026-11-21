import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {LifeEngine,worldNames} from '../extensions/aurabot/fish-world/life.mjs';
import {FishBridge} from '../extensions/aurabot/fish-world/bridge.mjs';
import {newLife,enqueue} from '../extensions/aurabot/fish-world/state.mjs';
import {preparePlanChanges,applyPlanChanges} from '../extensions/aurabot/fish-world/plans.mjs';
import {carryForward,chooseWindow,windowPrompt} from '../extensions/aurabot/fish-world/world-window.mjs';
import {historyPage,boundedRaw} from '../extensions/aurabot/fish-world/history.mjs';
import {installUsage,prepareRequest} from '../extensions/aurabot/fish-world/host-runtime.mjs';
const start=Date.parse('2026-11-21T10:00:00+08:00');
const flush=()=>new Promise(r=>setImmediate(r));
function fixture(settings={}){let now=start,calls=0,e;
 const data={version:3,fishId:'fixture',state:{stage:'alive',where:{kind:'home'}},now:'现场',at:{state:now},life:newLife(now)};
 const bridge={data,identityReady:true,change(fn){const old=structuredClone(this.data);try{return fn(this.data);}catch(error){this.data=old;throw error;}}};
 const host={cancel:async()=>{},idle:async()=>true,remember:async()=>{},send:async()=>{throw Error('禁止发送');},
  async run(){calls++;e.bind('session-fixture',worldNames);e.l.round.observation='真实现场';e.finish({events:e.l.round.events.filter(id=>e.l.queue.some(q=>q.id===id)).map(id=>({id,status:'completed'})),plans:[],importance:'routine',summary:'观察后等待',facts:[],share:''});}};
 e=new LifeEngine({bridge,host,settings:()=>({sharing:false,idleLimit:150,...settings}),clock:()=>now,identity:()=>({owner:'fixture-owner',persona:'fixture-persona'})});
 return {e,bridge,get calls(){return calls;},time(n){now=n;bridge.data.at.state=n;},now:()=>now};
}
test('three hours of two-second local ticks make only configured idle starts, with persistent global reservations',async()=>{
 const f=fixture();for(let n=0;n<=10800000;n+=2000){f.time(start+n);await f.e.tick();await flush();}
 assert.equal(f.calls,6);assert.equal(f.e.l.scheduler.reservations.length,6);assert.equal(f.e.l.days['2026-11-21'].idle,6);
 for(let i=1;i<6;i++)assert.ok(f.e.l.scheduler.starts[i].at-f.e.l.scheduler.starts[i-1].at>=180000);
});
test('a due plan gets one no-progress round and then remains asleep through clock-only ticks',async()=>{
 const f=fixture({idleEnabled:true});const ops=preparePlanChanges(f.e.l,{plans:[{goal:'等到门口',reason:'安排',nextStep:'等通知',trigger:'arrive',nextAt:start,status:'pending'}]},{now:start,fishId:'fixture'});
 applyPlanChanges(f.e.l,ops,{now:start});f.e.l.nextIdle=start+86400000;
 for(let n=0;n<10800000;n+=2000){f.time(start+n);await f.e.tick();await flush();}
 assert.equal(f.e.l.journal.filter(j=>j.type==='round'&&j.kind==='plan').length,1);assert.equal(f.e.l.plans[0].status,'waiting_event');
 enqueue(f.bridge.data,{kind:'arrive',text:'抵达',t:start+10800000},start+10800000);
 // An unrelated arrival cannot revive the old plan when its business time does not match.
 f.time(start+10802000);await f.e.tick();await flush();assert.equal(f.e.l.journal.filter(j=>j.type==='round'&&j.kind==='plan').length,1);
});
test('477 plans remain durable while a single updated ID yields a small keyed delta',()=>{
 const f=fixture();f.e.l.plans=Array.from({length:477},(_,i)=>({id:'p'+i,goal:'事项'+i,revision:1,status:'active',nextAt:start+i}));
 const round={id:'r',planIds:['p17'],events:[]};chooseWindow(f.e,'fixture');
 const first=windowPrompt(f.e,'本轮任务快照：unused',{round,identity:{},now:start});
 f.e.l.plans[17].revision++;const next=windowPrompt(f.e,'本轮任务快照：unused',{round,identity:{},visible:first,now:start});
 assert.ok(next.includes('"updated":{"p17"'));assert.ok(!next.includes('事项476'));assert.ok(next.length<5000);assert.equal(f.e.l.plans.length,477);
 assert.equal(Object.keys(carryForward(f.e,{},start,round).plans).length,1);
});
test('large receipts page losslessly with exact prices deadlines counts and request IDs',()=>{
 const f=fixture(),raw='金额123数量4期限2026-11-22 request_id=EXACT '+ '原文'.repeat(15000);
 f.e.l.journal=[{id:'exact',result:raw}];let part=0,joined='';do{const page=historyPage(f.e.l,{kind:'journal',id:'exact',part});assert.ok(JSON.stringify(page).length<4000);joined+=page.text;part=page.nextPart;}while(part!==null);
 assert.equal(JSON.parse(joined)[0].result,raw);assert.ok(boundedRaw({raw},{sessionId:'own',seq:2,part:0}).nextPart);
});
test('the legacy bridge is read-only and a no-op transaction does not rewrite a new ledger',()=>{
 const dir=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'bridge-')),file=path.join(dir,'runtime.json');
 const data={version:2,fishId:'fixture',recent:[],at:{},errors:{},life:{...newLife(),version:1}};
 fs.writeFileSync(file,JSON.stringify(data));const before=fs.readFileSync(file,'utf8'),old=new FishBridge({file,credential:()=>''});
 assert.equal(old.migrationRequired,true);assert.throws(()=>old.change(d=>{d.cursor='changed';}),/显式迁移/);assert.equal(fs.readFileSync(file,'utf8'),before);
 fs.writeFileSync(file,JSON.stringify({...data,version:3,life:newLife()}));let writes=0;const current=new FishBridge({file,credential:()=>'',changed:()=>writes++});current.change(()=>{});assert.equal(writes,0);current.change(d=>{d.cursor='one';});assert.equal(writes,1);
});
test('official usage hooks count own sessions only and complete request preflight stops oversized requests before next',async()=>{
 const f=fixture(),hooks={};f.e.l.sessionId='session-fixture';f.e.l.round={id:'r',sessionId:'session-fixture',startedAt:start,kind:'idle',bucket:'idle',events:[],receipts:[]};
 const off=installUsage({dsh:{on:(name,fn)=>(hooks[name]=fn,()=>{})},lib:()=>({costOf:()=>({cost:.01,unpriced:false})})},()=>f.e);
 hooks['session/event']({id:'foreign'},{type:'assistant/message',surfaceOp:'append',seq:1,data:{usage:{inputTokens:1}}});assert.equal(f.e.l.costs.records.length,0);
 hooks['session/event']({id:'session-fixture'},{type:'turn/start',seq:0,data:{turn:1},time:start});
 const usage={type:'assistant/message',surfaceOp:'append',seq:1,time:start,data:{turn:1,message:{source:{model:'fixture'}},usage:{inputTokens:3,outputTokens:1}}};
 hooks['session/event']({id:'session-fixture'},usage);hooks['session/event']({id:'session-fixture'},usage);assert.equal(f.e.l.costs.records.length,1);
 let submitted=0;const stream=hooks['llm/stream']({sessionId:'session-fixture',messages:[{content:'大'.repeat(100000)}],tools:[]},()=>{submitted++;return (async function*(){yield 1;})();});
 await assert.rejects(async()=>{for await(const _ of stream){}},/完整请求/);assert.equal(submitted,0);off();
});
test('a huge stopped recovery rotates to a bounded read-only window without forgetting unknown operations',async()=>{
 const f=fixture({backgroundContextEnabled:true});const prior=chooseWindow(f.e,'fixture');f.e.l.contextWindow.windows.at(-1).sessionId='session-fixture';f.e.l.sessionId='session-fixture';f.e.l.recovery=true;
 f.e.l.journal.push({id:'unknown',status:'uncertain',tool:'mcp__fish-world__world_do',args:'{"request_id":"do-not-repeat"}'});
 const agent={session:{deriveMessages:()=>[{content:[{type:'text',text:'长'.repeat(100000)}]}]}};
 const api={dsh:{get:name=>name==='tools'?{schemas:()=>[]}:null},dataDir:(...p)=>path.join(process.env.THINKSTAR_TEST_TMP,...p)};
 const result=await prepareRequest(f.e,api,{scope:()=> 'fixture',findAgent:()=>agent,identity:()=>({})},f.e.prompt([{id:'recovery',kind:'recovery'}],{readOnly:true,events:[],planIds:[]}),{readOnly:true,events:[],planIds:[]});
 assert.notEqual(result.windowKey,prior);assert.equal(result.estimate.visibleContextTokens,0);assert.ok(result.prompt.includes('unknown'));assert.equal(f.e.l.journal[0].args,'{"request_id":"do-not-repeat"}');
});

test('host preparation matches real message text for incremental snapshots and reuses an unbound window',async()=>{const f=fixture({backgroundContextEnabled:true});chooseWindow(f.e,'fixture');f.e.l.contextWindow.windows.at(-1).sessionId='session-fixture';f.e.l.sessionId='session-fixture';const round={events:[],planIds:[]};let messages=[];const agent={session:{id:'session-fixture',deriveMessages:()=>messages}},api={dsh:{get:n=>n==='tools'?{schemas:()=>[]}:null},dataDir:(...p)=>path.join(process.env.THINKSTAR_TEST_TMP,'prepare-delta',...p)},opts={scope:()=> 'fixture',identity:()=>({}),findAgent:()=>agent};const first=await prepareRequest(f.e,api,opts,f.e.prompt([],round),round);messages=[{content:[{type:'text',text:first.prompt}]}];const second=await prepareRequest(f.e,api,opts,f.e.prompt([],round),round);assert.ok(second.prompt.includes('状态变化'));assert.ok(!second.prompt.includes('完整交接快照'));});
