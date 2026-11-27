import test from 'node:test';
import assert from 'node:assert/strict';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife,defaults} from '../extensions/aurabot/fish-world/state.mjs';
import {candidates,admission} from '../extensions/aurabot/fish-world/governance.mjs';
const now=Date.parse('2026-11-27T20:49:51+08:00'),due=now-600000;
function fixture({kind='recovery',readOnly=true,nextIdle=due,nextAt=0}={}){
 const data={fishId:'synthetic#1',state:{where:{kind:'home'},doing:null},at:{state:now},life:{...newLife(now-3600000),owner:'synthetic-owner',persona:'synthetic-persona'}},engine=new LifeEngine({bridge:{data,change:fn=>fn(data)},identity:()=>({owner:'synthetic-owner',persona:'synthetic-persona'}),clock:()=>now,host:{},settings:()=>({sharing:false})});
 engine.l.nextIdle=nextIdle;engine.l.recovery=readOnly;
 engine.l.failureBackoff={streak:1,lastRoundId:'failed-idle',at:now-300000,delayMs:300000};
 engine.l.scheduler.starts.push({roundId:'failed-idle',at:now-360000});
 engine.l.journal.push({id:'failed-idle',type:'round',kind:'idle',status:'uncertain',at:now-300000,actionSequences:{}});
 engine.l.journal.push({id:'synthetic-read',round:'failed-idle',tool:'mcp__fish-world__world_now',status:'confirmed',args:'{}'});
 engine.l.scheduler.lastStartedAt=now-60000;
 engine.l.round={id:'synthetic-round',kind,readOnly,startedAt:now-60000,status:'running',events:[],planIds:[],receipts:[],observation:'合成只读现场',report:{summary:'合成核对完成',events:[],planChanges:[],importance:'routine',facts:[],share:'',nextAt}};
 return {engine,data};
}
test('readonly recovery preserves overdue self-care instead of postponing it another idle interval',()=>{
 const {engine,data}=fixture();engine.end(true);assert.equal(engine.l.nextIdle,due);assert.equal(engine.l.recovery,false);assert.equal(engine.l.outbox.length,0);
 const idle=candidates(engine.l,data,engine.cfg,now).find(x=>x.kind==='idle');assert.ok(idle);const check=admission(engine.l,idle,engine.cfg,{now});assert.equal(check.allowed,false);assert.equal(check.nextAllowedAt,engine.l.scheduler.lastStartedAt+defaults.normalMinGapMs);
});
test('readonly recovery also preserves an already future idle deadline',()=>{
 const future=now+600000,{engine}=fixture({nextIdle:future,nextAt:now+7200000});engine.end(true);assert.equal(engine.l.nextIdle,future);
});
test('normal completed life rounds keep the existing idle interval and explicit later scheduling',()=>{
 for(const nextAt of [0,now+7200000]){const {engine}=fixture({kind:'idle',readOnly:false,nextAt});engine.end(true);assert.equal(engine.l.nextIdle,Math.max(now+defaults.idleMs,nextAt));}
});
test('genuine or unknown mutations and missing recovery provenance retain the original timing protection',()=>{
 for(const variation of ['confirmed-mutation','unknown-dispatch','no-provenance']){
  const {engine}=fixture();
  if(variation==='confirmed-mutation')engine.l.journal.push({id:'actual-change',round:'failed-idle',tool:'mcp__fish-world__world_do',args:'{"id":"synthetic"}',status:'confirmed'});
  if(variation==='unknown-dispatch')engine.l.journal[0].actionSequences={unknown:{calls:[{tool:'mcp__fish-world__world_do',status:'uncertain'}]}};
  if(variation==='no-provenance')delete engine.l.failureBackoff;
  engine.end(true);assert.equal(engine.l.nextIdle,now+defaults.idleMs,variation);
 }
});
test('reload repairs the proved old recovery timer from its own unchanged handoff, without replay or a setting change',()=>{
 const {engine,data}=fixture();const l=engine.l;l.round=null;l.recovery=false;l.backoffUntil=0;
 l.journal.push({id:'old-recovery',type:'round',kind:'recovery',status:'completed',at:now});
 l.scheduler.starts.push({roundId:'old-recovery',at:now-60000});
 l.contextWindow={packet:{snapshot:{identity:{owner:l.owner,persona:l.persona},revision:l.revision,currentRound:{id:'old-recovery',kind:'recovery'},nextIdle:due}}};
 l.nextIdle=now+defaults.idleMs;const before=structuredClone(l.journal),controls=structuredClone(l.controls);
 const restored=new LifeEngine({bridge:{data,change:fn=>fn(data)},identity:()=>({owner:l.owner,persona:l.persona}),clock:()=>now+1000,host:{},settings:()=>({sharing:false})});
 assert.equal(restored.l.nextIdle,due);assert.equal(restored.l.idlePreparationScheduleRepair.recoveryRoundId,'old-recovery');assert.deepEqual(restored.l.journal,before);assert.deepEqual(restored.l.controls,controls);assert.equal(restored.l.outbox.length,0);
});
test('reload does not infer an old deadline across a changed control revision, real mutation or changed timer',()=>{
 for(const variant of ['revision','mutation','timer']){
  const {engine,data}=fixture(),l=engine.l;l.round=null;l.recovery=false;l.backoffUntil=0;
  l.journal.push({id:'old-recovery',type:'round',kind:'recovery',status:'completed',at:now});l.scheduler.starts.push({roundId:'old-recovery',at:now-60000});
  l.contextWindow={packet:{snapshot:{identity:{owner:l.owner,persona:l.persona},revision:l.revision,currentRound:{id:'old-recovery',kind:'recovery'},nextIdle:due}}};l.nextIdle=now+defaults.idleMs;
  if(variant==='revision')l.revision++;
  if(variant==='mutation')l.journal.splice(l.journal.length-1,0,{id:'change',round:'failed-idle',tool:'mcp__fish-world__world_do',status:'confirmed',args:'{"id":"synthetic"}',at:now-1000});
  if(variant==='timer')l.nextIdle+=60000;
  const old=l.nextIdle;new LifeEngine({bridge:{data,change:fn=>fn(data)},identity:()=>({owner:l.owner,persona:l.persona}),clock:()=>now+1000,host:{},settings:()=>({sharing:false})});assert.equal(l.nextIdle,old,variant);assert.equal(l.idlePreparationScheduleRepair,undefined);
 }
});
test('a recovery that copied a future task deadline restores only the overdue idle clock',()=>{
 const {engine,data}=fixture(),l=engine.l,appointment=now+7200000;l.round=null;l.recovery=false;l.backoffUntil=0;
 l.ownerTasks=[{id:'future-task',owner:l.owner,persona:l.persona,kind:'activity',status:'active',phase:'pending',createdAt:now-100000,instruction:'合成未来安排',nextAt:appointment,finalAction:{tool:'mcp__fish-world__world_do',arguments:{id:'future'}}}];
 l.journal.push({id:'old-recovery',type:'round',kind:'recovery',status:'completed',at:now});l.scheduler.starts.push({roundId:'old-recovery',at:now-60000});
 l.contextWindow={packet:{snapshot:{identity:{owner:l.owner,persona:l.persona},revision:l.revision,currentRound:{id:'old-recovery',kind:'recovery'},nextIdle:due}}};l.nextIdle=appointment;
 new LifeEngine({bridge:{data,change:fn=>fn(data)},identity:()=>({owner:l.owner,persona:l.persona}),clock:()=>now+1000,host:{},settings:()=>({sharing:false})});assert.equal(l.nextIdle,due);assert.equal(l.ownerTasks[0].nextAt,appointment);assert.equal(l.idlePreparationScheduleRepair.copiedTaskId,'future-task');
});
test('scoped definitions do not reschedule self-care and other events cannot copy a future appointment into it',()=>{
 for(const flag of ['definitionOnly','planningOnly','availabilityOnly']){const {engine}=fixture({kind:'owner-task',readOnly:false,nextAt:now+7200000});engine.l.round[flag]=true;engine.end(true);assert.equal(engine.l.nextIdle,due,flag);}
 const {engine}=fixture({kind:'talk',readOnly:false,nextAt:now+7200000});engine.end(true);assert.equal(engine.l.nextIdle,now+defaults.idleMs);
});
test('private mutations during or after the failed idle and missing start evidence prevent early resumption',()=>{
 for(const at of [now-330000,now-120000]){
  const {engine}=fixture();engine.l.journal.push({id:'owner-action',round:null,tool:'mcp__fish-world__world_do',args:'{"id":"synthetic-owner-action"}',at,status:'confirmed'});engine.end(true);assert.equal(engine.l.nextIdle,now+defaults.idleMs);
 }
 const {engine}=fixture();engine.l.scheduler.starts=[];engine.end(true);assert.equal(engine.l.nextIdle,now+defaults.idleMs);
});
