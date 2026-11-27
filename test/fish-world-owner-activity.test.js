import test from 'node:test';
import assert from 'node:assert/strict';
import {newLife,enqueue} from '../extensions/aurabot/fish-world/state.mjs';
import {rememberOwnerTurn,defineOwnerTask,noteOwnerTaskResult,ownerTaskGuard,ownerTaskCandidates,taskForExecution,endOwnerTaskRound,reconcileOwnerTasks,advanceOwnerTasks,ownerTaskSnapshot,linkOwnerTaskEvent} from '../extensions/aurabot/fish-world/owner-tasks.mjs';
import {finiteActivityFromReceipt} from '../extensions/aurabot/fish-world/finite-activity.mjs';

const W='mcp__fish-world__world_',start=Date.parse('2026-11-27T12:00:00+08:00'),identity={owner:'synthetic-owner',persona:'synthetic-persona'},sid='11111111-2222-4333-8444-555555555555',bg='session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const step=(id,nextStep,extra={})=>({tool:'world_do',arguments:JSON.stringify({id}),nextStep,...extra});
function fixture(){let now=start,sequence=0;const l={...newLife(now),...identity},data={life:l,at:{state:now},state:{where:{kind:'home'}}};return {l,data,get now(){return now;},time(at){now=at;},turn(text){return rememberOwnerTurn(l,identity,{text,sessionId:sid,turnKey:++sequence,confirmedWorld:true},now);},define(t,steps,extra={}){return defineOwnerTask(l,{id:t.id,expectedRevision:t.revision,steps,...extra},{sessionId:sid,now,data});},round(t,extra={}){return l.round={id:'round-'+(++sequence),sessionId:bg,status:'running',ownerTaskId:t.id,startedAt:now,definitionOnly:false,report:{},...extra};},receipt(t,id,text,status='confirmed'){const row={id:'receipt-'+(++sequence),ownerTaskId:t.id,tool:W+'do',args:JSON.stringify({id}),status,isError:status!=='confirmed',at:now,finishedAt:now,sessionId:sid,result:text};l.journal.push(row);noteOwnerTaskResult(l,data,row,now);return row;}};}

test('cooking starts a finite activity and cannot advance to eating before its real completion',()=>{
 const f=fixture(),t=f.turn('请煮饭再吃饭');f.define(t,[step('cook','做好饭'),step('eat','吃饭')]);f.receipt(t,'cook','好的，你开始煮白米饭，12:20 结束。\n—— 现在 12:00 · 在家 · 在做：煮白米饭（12:20 结束）');assert.equal(t.phase,'waiting_event');assert.equal(t.stepIndex,0);assert.equal(t.completedSteps.length,0);
 const r=f.round(t);assert.match(ownerTaskGuard(f.l,f.data,{name:W+'do',arguments:{id:'eat'},agent:{session:{id:bg}}},true,f.now),/完成|结束/);assert.equal(r.ownerTaskId,t.id);f.time(start+1200000);enqueue(f.data,{kind:'done',t:f.now,text:'煮白米饭：饭做好了，热气散了出来'},f.now);assert.equal(t.phase,'pending');assert.equal(t.finalAction.arguments.id,'eat');assert.equal(t.stepIndex,1);
});

test('reading starts an activity and a background return cannot interrupt it',()=>{
 const f=fixture(),t=f.turn('请去图书馆读书然后回家');f.define(t,[step('read','读完书'),{tool:'world_go',arguments:'{"place":"home"}',nextStep:'回家'}]);f.receipt(t,'read','好的，你开始读合成书，12:30 结束。\n—— 现在 12:00 · 在图书馆 · 在做：读合成书（12:30 结束）');f.round(t);assert.equal(t.phase,'waiting_event');assert.match(ownerTaskGuard(f.l,f.data,{name:W+'go',arguments:{place:'home'},agent:{session:{id:bg}}},true,f.now),/完成|结束/);f.time(start+1800000);enqueue(f.data,{kind:'done',t:f.now,text:'读合成书：最后一页看完了'},f.now);assert.equal(t.finalAction.tool,W+'go');assert.equal(t.phase,'pending');
});

test('an immediate purchase still completes its receipt step normally',()=>{
 const f=fixture(),t=f.turn('请去商店买一袋米');f.define(t,[step('rice','买一袋米')]);f.receipt(t,'rice','你买了 1 袋米。\n—— 现在 12:00 · 在商店');assert.equal(t.status,'completed');assert.equal(t.completedSteps.length,1);
});

test('new empty buy and activity contracts request definition instead of launching an action round with no final action',()=>{
 for(const text of ['请去商店买东西','请去小镇办点事']){const f=fixture(),t=f.turn(text);assert.equal(t.finalAction,null);assert.equal(t.phase,'needs_definition');assert.equal(ownerTaskCandidates(f.l,f.now,f.data)[0].definitionOnly,true);}
});

test('a declared done wait can derive the actual label from its start receipt without predicting the narrative',()=>{
 const f=fixture(),t=f.turn('请去图书馆读书然后回家');assert.doesNotThrow(()=>f.define(t,[step('read','读完再走',{waitFor:'done'})]));f.receipt(t,'read','好的，你开始读合成书，12:30 结束。\n—— 现在 12:00 · 在图书馆 · 在做：读合成书（12:30 结束）');assert.equal(t.phase,'waiting_event');f.time(start+1800000);enqueue(f.data,{kind:'done',t:f.now,text:'读合成书：翻过了最后一页，合上书'},f.now);assert.equal(t.status,'completed');
});

test('successful local definition clears the ten-minute check cooldown for ordinary work-items too',()=>{
 const f=fixture(),t=f.turn('打工的地方有工作让你处理'),r=f.round(t,{definitionOnly:true});f.l.journal.push({id:'options',tool:W+'now',status:'confirmed',sessionId:bg,round:r.id,at:f.now,finishedAt:f.now,result:'· task-17 合成班内待办'});defineOwnerTask(f.l,{id:t.id,expectedRevision:t.revision,steps:[step('task-17','处理真实待办')]},{sessionId:bg,background:true,taskId:t.id,now:f.now,data:f.data});endOwnerTaskRound(f.l,r,true,f.now+1000);assert.equal(t.lastCheckedAt,0);assert.equal(t.phase,'pending');
});

test('a current ordinary read task keeps same-session action attribution after an owner question',()=>{
 const f=fixture(),t=f.turn('请去图书馆读书');assert.ok(t.finalAction);f.turn('书看完了吗？');const exec={name:W+'do',arguments:{id:'read'},agent:{session:{id:'session-'+sid}}};assert.equal(taskForExecution(f.l,exec)?.id,t.id);assert.equal(taskForExecution(f.l,{...exec,agent:{session:{id:'foreign'}}}),undefined);
});

test('finite activity evidence requires the exact start label and final server primary activity, never a busy footer or parallel tea',()=>{
 const footer='—— 现在 12:00 · 在图书馆 · 在做：读合成书（12:30 结束）';assert.equal(finiteActivityFromReceipt('好的，你开始读合成书了。\n'+footer).label,'读合成书');
 for(const text of ['你买了一本书。\n'+footer,'好的，你开始读合成书评，12:30 结束。\n'+footer,'好的，你开始看看车了。\n—— 现在 12:00 · 在车行 · 在做：看看车','好的，你开始读合成书，12:30 结束。\n> '+footer,'好的，你开始读合成书，12:30 结束。\n'+footer+'\n> 引用尾注'])assert.equal(finiteActivityFromReceipt(text),null,text);
 assert.equal(finiteActivityFromReceipt('好的，你开始泡茶，12:05 结束。\n'+footer+' · 同时：泡茶（12:05 结束）').blocking,false);
 const f=fixture(),t=f.turn('请去商店买一本书');f.define(t,[step('book','买书')]);f.receipt(t,'book','你买了一本书。\n'+footer);assert.equal(t.status,'completed','an immediate purchase is not held for an unrelated existing reading activity');
});

test('ETA and idle state do not complete a finite action, and snapshot keeps the original activity evidence',()=>{
 const f=fixture(),t=f.turn('请去图书馆读书');f.receipt(t,'read','好的，你开始读合成书，12:30 结束。\n—— 现在 12:00 · 在图书馆 · 在做：读合成书（12:30 结束）');const activity=structuredClone(t.activity);f.time(start+7200000);f.data.at.state=f.now;f.data.state.doing=null;advanceOwnerTasks(f.l,f.data,f.now);reconcileOwnerTasks(f.l,f.data,f.now);assert.equal(t.phase,'waiting_event');assert.equal(t.status,'active');assert.equal(t.stepIndex,0);assert.deepEqual(ownerTaskSnapshot(f.l)[0].activity,activity);assert.equal(ownerTaskCandidates(f.l,f.now,f.data).length,0);
});

test('trusted completion keeps its original event pending for normal reporting without creating an outbox item',()=>{
 const f=fixture(),t=f.turn('请去图书馆读书'),receipt=f.receipt(t,'read','好的，你开始读合成书，12:30 结束。\n—— 现在 12:00 · 在图书馆 · 在做：读合成书（12:30 结束）');f.time(start+1800000);enqueue(f.data,{kind:'done',t:f.now,text:'读合成书：最后一页读完了'},f.now);const event=f.l.queue.at(-1);assert.equal(t.status,'completed');assert.equal(event.status,'pending');assert.equal(event.provenance.source,'world-notify');assert.equal(event.text,'读合成书：最后一页读完了');assert.deepEqual(event.completedPurpose.receiptIds,[receipt.id]);assert.equal(event.completedPurpose.goal,t.instruction);assert.equal(f.l.outbox.length,0);
});

test('a queued completion can be reconciled after result ordering or restart without fabricating another event',()=>{
 for(const restart of [false,true]){const f=fixture(),t=f.turn('请去图书馆读书');f.time(start+1800000);const event={id:'actual-done',kind:'done',t:f.now,text:'读合成书：读完了',status:'observed',provenance:{trusted:true,source:'world-notify'}};
  if(restart){f.time(start);f.receipt(t,'read','好的，你开始读合成书，12:30 结束。\n—— 现在 12:00 · 在图书馆 · 在做：读合成书（12:30 结束）');f.time(start+1800000);f.l.queue.push(event);const restored=JSON.parse(JSON.stringify(f.l));reconcileOwnerTasks(restored,{...f.data,life:restored},f.now);assert.equal(restored.ownerTasks[0].status,'completed');assert.equal(restored.queue.length,1);assert.equal(restored.queue[0].id,event.id);}
  else{f.l.queue.push(event);const row={id:'late-start',tool:W+'do',args:'{"id":"read"}',status:'confirmed',at:start,finishedAt:f.now,ownerTaskId:t.id,result:'好的，你开始读合成书，12:30 结束。\n—— 现在 12:00 · 在图书馆 · 在做：读合成书（12:30 结束）'};f.l.journal.push(row);noteOwnerTaskResult(f.l,f.data,row,f.now);assert.equal(t.status,'completed');assert.equal(f.l.queue.length,1);}}
});

test('untrusted, earlier, different-label and ambiguous completion events cannot finish the step',()=>{
 const f=fixture(),t=f.turn('请去图书馆读书');f.receipt(t,'read','好的，你开始读合成书，12:30 结束。\n—— 现在 12:00 · 在图书馆 · 在做：读合成书（12:30 结束）');f.time(start+1800000);
 for(const patch of [{provenance:{trusted:false,source:'world-notify'}},{provenance:{trusted:true,source:'owner-control'}},{t:start-1},{text:'读合成书评：结束了'},{text:'> 读合成书：结束了'}]){linkOwnerTaskEvent(f.l,{id:'unproven',kind:'done',t:f.now,text:'读合成书：结束了',provenance:{trusted:true,source:'world-notify'},...patch},f.now);assert.equal(t.phase,'waiting_event');}
 const other=structuredClone(t);other.id='other-wait';f.l.ownerTasks.push(other);enqueue(f.data,{kind:'done',t:f.now,text:'读合成书：结束了'},f.now);assert.equal(t.phase,'waiting_event');assert.equal(other.phase,'waiting_event');
});

test('explicit completion text remains compatible but ambiguous identical manual waits do not advance twice',()=>{
 const f=fixture(),t=f.turn('请去图书馆读书');f.define(t,[step('read','读完',{waitFor:'done',eventText:'合成读书结束'})]);f.receipt(t,'read','合成阅读开始');f.time(start+1000);const other=structuredClone(t);other.id='manual-other';f.l.ownerTasks.push(other);enqueue(f.data,{kind:'done',t:f.now,text:'合成读书结束'},f.now);assert.equal(t.status,'active');assert.equal(other.status,'active');f.l.ownerTasks.pop();reconcileOwnerTasks(f.l,f.data,f.now);assert.equal(t.status,'completed');
});

test('old empty contracts reconcile once without resetting unknown or exhausted definition budgets',()=>{
 const f=fixture(),t=f.turn('请去小镇办点事');Object.assign(t,{phase:'pending',definitionAttempts:2,definitionNextAt:start+600000});const before=t.history.length;assert.equal(reconcileOwnerTasks(f.l,f.data,f.now).changed,1);assert.equal(t.phase,'needs_definition');assert.equal(t.definitionAttempts,2);assert.equal(t.definitionNextAt,start+600000);assert.equal(t.history.length,before+1);assert.equal(reconcileOwnerTasks(f.l,f.data,f.now).changed,0);
 const u=structuredClone(t);Object.assign(u,{id:'unknown-old',phase:'uncertain'});const exhausted=structuredClone(t);Object.assign(exhausted,{id:'exhausted',phase:'blocked',definitionAttempts:3});f.l.ownerTasks.push(u,exhausted);reconcileOwnerTasks(f.l,f.data,f.now);assert.equal(u.phase,'uncertain');assert.equal(exhausted.phase,'blocked');assert.equal(exhausted.definitionAttempts,3);
});

test('persistent attribution never guesses between two same-session tasks or crosses persona boundaries',()=>{
 const f=fixture(),t=f.turn('请去图书馆读书');f.turn('读到哪里了？');const exec={name:W+'do',arguments:{id:'read'},agent:{session:{id:'session-'+sid}}};const other=structuredClone(t);other.id='another-active';f.l.ownerTasks.push(other);assert.equal(taskForExecution(f.l,exec),undefined);f.l.ownerTasks.pop();f.l.persona='other-persona';assert.equal(taskForExecution(f.l,exec),undefined);
});
