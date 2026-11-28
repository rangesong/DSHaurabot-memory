import test from 'node:test';
import assert from 'node:assert/strict';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {nativeOwnerPurposeSource,captureNativeOwnerPurpose,attachConfirmedOwnerPurpose} from '../extensions/aurabot/fish-world/owner-purpose.mjs';
import {linkOwnerTaskEvent,defineOwnerTask} from '../extensions/aurabot/fish-world/owner-tasks.mjs';
const N=Date.parse('2026-11-28T15:00:00+08:00'),id={owner:'123456',persona:'synthetic'},sid='synthetic-owner-purpose',W='mcp__fish-world__world_';
function event(text,{role='owner',at=N,id='native-purpose-one'}={}){return {type:'user/message',seq:1,time:at,data:{id,role:'user',source:{kind:'aurabot',speaker:{role,chat:'private'}},content:[{type:'text',text:'【私聊】[15:00] 合成主人(123456)：'+text}]}};}
function fixture(){
 const data={fishId:'synthetic#1',state:{where:{kind:'home'},doing:null},at:{state:N},life:{...newLife(N),...id}};let clock=N;
 const engine=new LifeEngine({bridge:{data,change:fn=>fn(data)},host:{cancel:async()=>{throw Error('no model or cancellation expected');}},clock:()=>clock,identity:()=>id});
 const source=e=>nativeOwnerPurposeSource({id:sid},e,{identity:id,chatId:'private:'+id.owner,now:clock}),capture=e=>engine.nativeOwnerMessage({id:sid},e,'private:'+id.owner);
 const go=(place='beach-n',text='好的。15:01 出发：坐合成车到海边站，15:30 到海边·北堤。',origin={kind:'owner',worldAuthorized:true,evidence:'events',sourceMessageId:'current-owner-question'})=>{
  clock+=1000;const exec={name:W+'go',callId:'go-'+clock,arguments:{place,by:'walk',request_id:'unchanged-original'},agent:{session:{id:'session-'+sid}}};assert.equal(engine.guard(exec,false,true,origin),undefined);engine.result(exec,{content:[{type:'text',text}]});return data.life.journal.find(row=>row.id===exec.callId);
 };
 return {data,engine,source,capture,go,setNow:value=>{clock=value;}};
}
test('only a fresh native private owner source supplies a bounded purpose anchor',()=>{
 const f=fixture();const e=event('下午去海边看看');assert.equal(f.source(e).messageId,'native-purpose-one');f.capture(e);assert.equal(f.data.life.ownerPurposeAnchors[0].text,'下午去海边看看');assert.equal(f.data.life.round,null);assert.equal(f.data.life.ownerTasks?.length||0,0);assert.equal(f.data.life.outbox.length,0);
 for(const change of [e=>e.data.source.speaker.role='guest',e=>e.data.source.speaker.chat='group',e=>e.data.source.kind='memory-context',e=>e.data.content.push({...e.data.content[0]}),e=>e.data.content[0].text=e.data.content[0].text.replace('(123456)','(999)'),e=>e.time=N-180001]){const x=event('去合成公园看看');change(x);assert.equal(f.source(x),null);}
 assert.equal(nativeOwnerPurposeSource({id:sid},e,{identity:id,chatId:'private:other',now:N}),null);
});
test('questions, guest reminders and injected text cannot overwrite the real outstanding owner purpose',()=>{
 const f=fixture();f.capture(event('下午去海边看看'));f.capture(event('试试看能动了吗',{id:'question'}));f.capture(event('去合成商店买米',{id:'guest',role:'guest'}));const quoted=event('> 去别的地方\n试试看');quoted.data.content.push({type:'text',text:'记忆资料：去合成药房买药'});f.capture(quoted);
 assert.equal(f.data.life.ownerPurposeAnchors.length,1);assert.equal(f.data.life.ownerPurposeAnchors[0].place,'海边');
 f.engine.ownerTurn('试试看能动了吗',{sessionId:sid,turnToken:'question'});const row=f.go();const t=f.data.life.ownerTasks.find(t=>t.id===row.ownerTaskId);assert.equal(t.originalPurpose,'下午去海边看看');assert.equal(t.purposeSource,'owner-native-event');assert.equal(t.source.nativeOwnerEvent.messageId,'native-purpose-one');assert.equal(t.phase,'travelling');assert.equal(t.ownerCompletionType,'observe');assert.equal(t.journey.completionType,'observe');assert.equal(t.status,'active');assert.equal(f.data.life.ownerPurposeAnchors[0].status,'bound');
 assert.equal(row.args,JSON.stringify({place:'beach-n',by:'walk',request_id:'unchanged-original'}));assert.equal(t.finalAction.arguments.by,'walk');assert.equal(t.journey.priorActions[0].arguments.request_id,'unchanged-original');assert.equal(f.data.life.outbox.length,0);
});
test('the confirmed trip progresses by a real arrival and finishes only from a successful onsite read',()=>{
 const f=fixture();f.capture(event('下午去海边看看'));const row=f.go(),t=f.data.life.ownerTasks.find(t=>t.id===row.ownerTaskId);const arrived={id:'arrival',kind:'arrive',text:'到了海边·北堤',t:N+1800000,provenance:{trusted:true,source:'world-notify'},status:'observed'};linkOwnerTaskEvent(f.data.life,arrived,N+1800000);assert.equal(t.phase,'needs_definition');assert.equal(t.status,'active');assert.equal(t.completedSteps.length,1);
 const now=N+1800001;f.data.state.where={kind:'place',place:{id:'beach-n'}};f.data.at.state=now;f.data.life.journal.push({id:'onsite-now',tool:W+'now',ownerTaskId:t.id,sessionId:sid,status:'confirmed',isError:false,at:now,finishedAt:now,result:'11-28 周六 15:30 · 晴 4°C\n你在：海边·北堤\n身体：精神不错'});
 defineOwnerTask(f.data.life,{id:t.id,expectedRevision:t.revision,action:'complete_observation',summary:'看到真实海景'},{sessionId:sid,now,data:f.data});assert.equal(t.status,'completed');assert.deepEqual(t.journey.observation.evidenceIds,['onsite-now']);assert.equal(f.data.life.outbox.length,0);
});
test('unrelated destinations and old purposes do not bind a new private go',()=>{
 for(const [purpose,place,label]of [['去合成商店买药','beach-n','海边·北堤'],['帮我做去海边的报告','beach-n','海边·北堤'],['去海边的便利店买水','beach-n','海边·北堤']]){const f=fixture();f.capture(event(purpose));const row=f.go(place,'好的。15:01 出发：步行，15:30 到'+label+'。');assert.equal(row.ownerTaskId,null);assert.equal(f.data.life.ownerTasks?.length||0,0);}
 const f=fixture();f.capture(event('去海边看看'));f.setNow(N+86400000);assert.equal(f.go().ownerTaskId,null);
});
test('an explicit replacement or cancellation updates pending candidates without dispatching',()=>{
 const f=fixture();f.capture(event('去海边看看'));f.capture(event('那改去合成公园逛逛',{id:'new-place'}));assert.equal(f.data.life.ownerPurposeAnchors[0].status,'superseded');assert.equal(f.go().ownerTaskId,null);
 const g=fixture();g.capture(event('下午去海边看看'));g.capture(event('下午不要去海边',{id:'cancel'}));assert.equal(g.data.life.ownerPurposeAnchors[0].status,'cancelled');assert.equal(g.go().ownerTaskId,null);
 const unrelated=fixture();unrelated.capture(event('下午去海边看看'));unrelated.capture(event('不要去药房',{id:'other-cancel'}));assert.equal(unrelated.data.life.ownerPurposeAnchors[0].status,'pending');assert.ok(unrelated.go().ownerTaskId);
 const general=fixture();general.capture(event('去海边看看'));general.capture(event('算了不去了',{id:'cancel-current'}));assert.equal(general.data.life.ownerPurposeAnchors[0].status,'cancelled');assert.equal(general.go().ownerTaskId,null);
 const explicit=fixture();explicit.capture(event('去海边看看'));explicit.capture(event('取消去药房的行程',{id:'cancel-other'}));assert.equal(explicit.data.life.ownerPurposeAnchors[0].status,'pending');explicit.capture(event('取消海边的行程',{id:'cancel-matching'}));assert.equal(explicit.data.life.ownerPurposeAnchors[0].status,'cancelled');
});
test('an existing in-flight, unknown or previously mutated task is never rewritten as an empty journey',()=>{
 for(const patch of [{phase:'uncertain'},{phase:'travelling'},{phase:'working'},{phase:'waiting_event'},{phase:'pending',unknown:true}]){
  const f=fixture();f.capture(event('下午去海边看看'));const t={id:'owned',status:'active',kind:'activity',phase:patch.phase,createdAt:N,owner:id.owner,persona:id.persona,instruction:'下午去海边看看',currentSessionId:sid,steps:[],receipts:[],completedSteps:[],history:[]};f.data.life.ownerTasks=[t];
  if(patch.unknown)f.data.life.journal.push({id:'old-unknown',ownerTaskId:t.id,tool:W+'do',args:'{"id":"synthetic-old"}',status:'uncertain',at:N});
  const row={id:'existing-go',tool:W+'go',round:null,sessionId:sid,ownerTaskId:t.id,status:'confirmed',isError:false,at:N+1,finishedAt:N+2,args:'{"place":"beach-n"}',result:'好的。15:01 出发：步行，15:30 到海边·北堤。',ownerOrigin:{kind:'owner',sourceMessageId:'question',evidence:'events'}};f.data.life.journal.push(row);const before=structuredClone(f.data.life);assert.equal(attachConfirmedOwnerPurpose(f.data.life,row,id,N+2).changed,false);assert.deepEqual(f.data.life,before);
 }
});
test('failed, unknown, preview and scheduled-source calls never turn a candidate into a journey',()=>{
 for(const result of ['Error: [E_RULE] 路没通。','timeout','去海边·北堤有 3 种走法，15:30 到海边·北堤。']){const f=fixture();f.capture(event('去海边看看'));assert.equal(f.go('beach-n',result).ownerTaskId,null);assert.equal(f.data.life.ownerTasks?.length||0,0);}
 const f=fixture();f.capture(event('去海边看看'));assert.equal(f.go('beach-n',undefined,{kind:'schedule',worldAuthorized:true,evidence:'events',sourceMessageId:'scheduled'}).ownerTaskId,null);
});
test('an empty generic task from the same original purpose upgrades without stealing another task receipt',()=>{
 const f=fixture();f.engine.ownerTurn('下午去海边看看',{sessionId:sid,turnToken:'original',confirmedWorld:true});const old=f.data.life.ownerTasks[0];f.capture(event('下午去海边看看'));f.engine.ownerTurn('能动了吗',{sessionId:sid,turnToken:'question'});const row=f.go();assert.equal(row.ownerTaskId,old.id);const t=f.data.life.ownerTasks.find(t=>t.id===old.id);assert.equal(t.kind,'journey');assert.equal(t.phase,'travelling');assert.equal(f.data.life.ownerTasks.length,1);
 const g=fixture();g.capture(event('下午去海边看看'));const row2={id:'existing-go',tool:W+'go',round:null,sessionId:sid,ownerTaskId:'owned',status:'confirmed',isError:false,at:N+1,finishedAt:N+2,args:'{"place":"beach-n"}',result:'好的。15:01 出发：步行，15:30 到海边·北堤。',ownerOrigin:{kind:'owner',sourceMessageId:'question',evidence:'events'}};g.data.life.ownerTasks=[{id:'owned',status:'active',kind:'journey',steps:[{tool:W+'go'}],owner:id.owner,persona:id.persona}];g.data.life.journal.push(row2);const before=structuredClone(g.data.life);assert.equal(attachConfirmedOwnerPurpose(g.data.life,row2,id,N+2).changed,false);assert.deepEqual(g.data.life,before);
});
test('immediate room arrivals retain the original actual action goal and no synthetic completion',()=>{
 const f=fixture();f.capture(event('去厨房做饭'));const row=f.go('厨房','好的，你走进了厨房。'),t=f.data.life.ownerTasks.find(t=>t.id===row.ownerTaskId);assert.equal(t.originalPurpose,'去厨房做饭');assert.equal(t.phase,'needs_definition');assert.equal(t.status,'active');assert.equal(t.journey.completionType,'action');assert.equal(t.completedSteps.length,1);
});
test('new anchors are bounded, idempotent and never replay old history on construction',()=>{
 const f=fixture();for(let i=0;i<10;i++)f.capture(event('去合成公园看看',{id:'purpose-'+i}));assert.equal(f.data.life.ownerPurposeAnchors.length,8);f.capture(event('去合成公园看看',{id:'purpose-9'}));assert.equal(f.data.life.ownerPurposeAnchors.length,8);assert.equal(f.data.life.ownerTasks?.length||0,0);assert.equal(f.data.life.journal.length,0);assert.equal(f.data.life.round,null);
});
