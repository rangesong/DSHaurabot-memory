import test from 'node:test';
import assert from 'node:assert/strict';
import {LifeEngine,WORLD} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {ownerTaskGuard} from '../extensions/aurabot/fish-world/owner-tasks.mjs';
const now=Date.parse('2026-11-28T13:00:00+08:00'),sid='session-synthetic-recovery',wait=()=>new Promise(resolve=>setTimeout(resolve,5));
function fixture({round=true}={}){
 const data={fishId:'synthetic#1',state:{stage:'alive',where:{kind:'home'},doing:null},at:{state:now},life:{...newLife(now),owner:'synthetic-owner',persona:'synthetic'}},writes=[],cancels=[];
 const bridge={data,identityReady:true,change(fn){const value=fn(data);writes.push(structuredClone(data.life.round));return value;}};
 const host={idle:async()=>true,cancel:async id=>{cancels.push(id);},run:async()=>{throw Error('Unexpected synthetic run');}};
 const engine=new LifeEngine({bridge,host,identity:()=>({owner:'synthetic-owner',persona:'synthetic'}),clock:()=>now,settings:()=>({})});
 if(round)engine.l.round={id:'synthetic-round',sessionId:sid,kind:'recovery',readOnly:true,status:'running',revision:engine.l.revision,startedAt:now,events:[],planIds:[],receipts:[],calls:0,observation:'',priority:1};
 const observe=()=>{const exec={agent:{session:{id:sid}},callId:'synthetic-read',name:WORLD+'world_now',arguments:{}};assert.equal(engine.guard(exec,true,false),undefined);engine.result(exec,{isError:false,content:[{type:'text',text:'合成只读现场'}]});};
 if(round)observe();
 const input={summary:'合成只读恢复核对完成',events:[],importance:'routine',facts:['synthetic-read'],share:'',planChanges:[]};
 return {engine,bridge,data,writes,cancels,host,observe,input};
}
test('validated empty readonly recovery report, completion marker and finished status commit atomically before cancellation',async()=>{
 const f=fixture(),r=f.engine.l.round,result=f.engine.finish(f.input);
 assert.equal(result.ok,true);assert.equal(r.localCompletion?.kind,'readonly-recovery-finished');assert.equal(r.status,'finished');assert.equal(r.report.summary,f.input.summary);
 assert.ok(f.writes.filter(row=>row?.localCompletion).every(row=>row.report&&row.status==='finished'));
 assert.match(f.engine.guard({agent:{session:{id:sid}},name:WORLD+'world_now',arguments:{}},true,false),/停止/);
 await wait();assert.deepEqual(f.cancels,[sid]);
});
test('invalid events/facts or an outstanding tool never create local completion; corrected input remains possible',async()=>{
 for(const mode of ['events','facts','lock']){
  const f=fixture();if(mode==='events'){f.engine.l.round.events=['required'];f.engine.l.queue.push({id:'required',kind:'owner'});}if(mode==='lock')f.engine.lock={callId:'pending'};
  assert.throws(()=>f.engine.finish(mode==='facts'?{...f.input,facts:['a narrative instead of receipt']}:f.input));
  assert.equal(f.engine.l.round.localCompletion,undefined);assert.equal(f.engine.l.round.status,'running');await wait();assert.deepEqual(f.cancels,[]);
  f.engine.lock=null;const corrected=mode==='events'?{...f.input,events:[{id:'required',status:'blocked'}]}:f.input;
  assert.equal(f.engine.finish(corrected).ok,true);assert.equal(f.engine.l.round.localCompletion?.kind,'readonly-recovery-finished');await wait();
 }
});
test('ordinary, writable, plan-changing, stale, externally pending or mutation-bearing rounds retain the original finish path',async()=>{
 for(const mode of ['ordinary','writable','plans','revision','external','mutation']){
  const f=fixture(),r=f.engine.l.round;let input=f.input;
  if(mode==='ordinary')r.kind='idle';if(mode==='writable')r.readOnly=false;if(mode==='revision')r.revision--;
  if(mode==='external')f.engine.l.externalPending={callId:'another-write',sessionId:'another'};
  if(mode==='mutation'){r.receipts.push({id:'impossible-current-write',tool:WORLD+'world_do',text:'合成成功',isError:false});f.engine.l.journal.push({id:'impossible-current-write',round:r.id,sessionId:sid,tool:WORLD+'world_do',args:'{"id":"synthetic"}',status:'confirmed'});}
  if(mode==='plans')input={...input,planChanges:[{op:'create',plan:{goal:'合成后续事项',reason:'继续本地安排',nextStep:'稍后核对现场',trigger:'time',nextAt:now+3600000,status:'active',topic:'synthetic',subject:'self',stage:'later'}}]};
  const result=f.engine.finish(input);assert.equal(result.ok,true,mode);assert.equal(r.localCompletion,undefined,mode);assert.equal(r.status,'running',mode);await wait();assert.deepEqual(f.cancels,[],mode);
 }
});
test('the delayed cancel cannot target a replaced round, changed arrangement, status, session or completion marker',async()=>{
 for(const mode of ['round','revision','status','session','marker']){
  const f=fixture();f.engine.finish(f.input);const r=f.engine.l.round;
  if(mode==='round')r.id='replacement';if(mode==='revision')f.engine.l.revision++;if(mode==='status')r.status='stopping';if(mode==='session')r.sessionId='replacement-session';if(mode==='marker')r.localCompletion={kind:'other'};
  await wait();assert.deepEqual(f.cancels,[],mode);
 }
});
test('a host rejection after valid report preparation settles recovery without failure backoff or replaying unknown actions',async()=>{
 const f=fixture({round:false});f.engine.l.recovery=true;f.engine.l.sessionId=sid;
 const task={id:'unknown-task',owner:'synthetic-owner',persona:'synthetic',status:'active',phase:'uncertain',kind:'activity',source:{sessionId:sid},currentSessionId:sid,steps:[],completedSteps:[],receipts:[],history:[]};
 const unknown={id:'old-unknown-mutation',ownerTaskId:task.id,sessionId:sid,tool:WORLD+'world_do',args:'{"id":"synthetic-action"}',status:'uncertain',at:now-1000};
 f.engine.l.ownerTasks=[task];f.engine.l.ownerTaskContexts={[sid]:{taskId:task.id,at:now-1000}};f.engine.l.journal.push(unknown);const before={task:structuredClone(task),unknown:structuredClone(unknown),outbox:structuredClone(f.engine.l.outbox)};
 let prepared;const reached=new Promise(resolve=>{prepared=resolve;});
 f.host.run=async()=>{f.engine.change(l=>{l.round.sessionId=sid;});f.observe();const result=f.engine.finish(f.input);prepared(result);throw Error('鱼世界完整请求估算超过启动目标：synthetic 64k');};
 await f.engine.tickOnce();assert.equal((await reached).ok,true);await wait();
 assert.equal(f.engine.l.round,null);assert.equal(f.engine.l.journal.findLast(row=>row.type==='round').status,'completed');assert.equal(f.engine.l.backoffUntil,0);assert.equal(f.engine.l.failureBackoff.streak,0);
 assert.deepEqual(f.engine.l.journal.find(row=>row.id===unknown.id),before.unknown);assert.deepEqual(f.engine.l.ownerTasks[0],before.task);assert.deepEqual(f.engine.l.outbox,before.outbox);
 assert.match(ownerTaskGuard(f.engine.l,f.data,{agent:{session:{id:sid}},name:WORLD+'world_do',arguments:{id:'synthetic-action'}},false,now),/未确认/);
});
test('a changed arrangement or stopped round cannot commit a previously prepared recovery report through the rejection branch',async()=>{
 for(const mode of ['revision','status']){
  const f=fixture({round:false});f.engine.l.recovery=true;f.engine.l.sessionId=sid;let prepared;const reached=new Promise(resolve=>{prepared=resolve;});
  f.host.run=async()=>{f.engine.change(l=>{l.round.sessionId=sid;});f.observe();f.engine.finish(f.input);f.engine.change(l=>{if(mode==='revision')l.revision++;else l.round.status='stopping';});prepared();throw Error('synthetic next request rejected');};
  await f.engine.tickOnce();await reached;await wait();assert.equal(f.engine.l.round.status,'stopping',mode);assert.equal(f.engine.l.journal.some(row=>row.type==='round'&&row.status==='completed'),false,mode);assert.equal(f.engine.l.recovery,true,mode);
 }
});
test('post-idle validation stops invalid authority, preserves a temporary lock, and never writes a replacement or closed runtime',async()=>{
 for(const mode of ['revision','unauthorized','round','lock','closed']){
  const f=fixture();f.engine.finish(f.input);const original=f.engine.l.round;let release,entered=false;
  f.host.idle=async()=>{entered=true;return new Promise(resolve=>{release=resolve;});};
  const pending=f.engine.completePreparedRecovery(original.id);assert.equal(entered,true);
  if(mode==='revision')f.engine.l.revision++;
  if(mode==='unauthorized')f.engine.authorized=()=>false;
  if(mode==='round')f.engine.l.round={...original,id:'replacement-round',status:'running',localCompletion:undefined};
  if(mode==='lock'){f.engine.lock={callId:'private-call',sessionId:'private-session'};f.engine.l.externalPending={callId:'private-call',sessionId:'private-session'};}
  if(mode==='closed')f.engine.closed=true;
  const current=f.engine.l.round,writes=f.writes.length;release(true);assert.equal(await pending,false,mode);assert.equal(f.engine.l.round,current,mode);assert.equal(f.engine.l.journal.some(row=>row.type==='round'&&row.status==='completed'),false,mode);
  assert.equal(current.status,['revision','unauthorized'].includes(mode)?'stopping':mode==='round'?'running':'finished',mode);
  if(mode==='closed')assert.equal(f.writes.length,writes,'closed runtime must not write its old bridge');await wait();
 }
});
