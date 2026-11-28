import test from 'node:test';
import assert from 'node:assert/strict';
import {candidates,admission} from '../extensions/aurabot/fish-world/governance.mjs';
import {newLife,defaults} from '../extensions/aurabot/fish-world/state.mjs';

const NOW=Date.parse('2026-11-27T20:15:00+08:00'),identity={owner:'synthetic-owner',persona:'synthetic-persona'};
function fixture(patch={}){
 const life={...newLife(NOW-3600000),...identity,ownerTasks:[]},data={fishId:'synthetic#1',at:{state:NOW},state:{where:{kind:'home'},doing:null},life};
 const journey={id:'synthetic-journey',...identity,status:'active',phase:'pending',kind:'journey',optional:false,priority:0,createdAt:NOW-600000,nextAt:NOW+3600000,notBefore:NOW+3600000,definitionAttempts:0,definitionNextAt:0,lastCheckedAt:0,history:[],receipts:[],steps:[],completedSteps:[],journey:{registeredSessionId:'synthetic-private',stage:'arrival-purpose'},...patch};
 const other={id:'synthetic-other-owner',...identity,status:'active',phase:'pending',kind:'activity',optional:false,priority:0,createdAt:NOW-1200000,nextAt:NOW-1000,lastCheckedAt:0,history:[],receipts:[],steps:[],completedSteps:[]};
 life.ownerTasks=[journey,other];life.nextIdle=NOW-1;
 life.queue=[{id:'current-note',kind:'note',text:'合成新留言',sender:'synthetic-peer#9',t:NOW-60000,notBefore:NOW-60000,status:'pending',provenance:{trusted:true,source:'world-notify'}},{id:'current-message',kind:'message',text:'合成消息',sender:'synthetic-other#8',t:NOW-50000,notBefore:NOW-50000,status:'pending',provenance:{trusted:true,source:'world-notify'}},{id:'new-owner-event',kind:'owner',text:'合成新主人安排',t:NOW-1000,notBefore:NOW-1000,status:'pending',provenance:{trusted:true,source:'owner-control'}},{id:'urgent-work',kind:'work',text:'合成紧急工作',t:NOW-1000,notBefore:NOW-1000,status:'pending',provenance:{trusted:true,source:'world-notify'}}];
 life.plans=[{id:'current-plan',status:'pending',revision:1,goal:'合成当前计划',nextAt:NOW-1,sourceEventIds:[],sourceEvidenceIds:[]}];
 const cfg={...defaults,idleEnabled:true,idleWorkHours:'',activityWorkHours:''};return {life,data,journey,other,cfg,read:()=>candidates(life,data,cfg,NOW)};
}
const has=(list,id)=>list.some(candidate=>candidate.id===id||candidate.ownerTaskId===id);

test('missing steps, a known waiting state and exhausted record-definition attempts admit an ordinary continuation round',()=>{
 for(const phase of ['needs_definition','waiting_evidence','blocked']){
  const f=fixture({phase,nextAt:0,notBefore:0,definitionAttempts:9,contractIssue:{code:'definition-attempt-limit'}}),task=f.read().find(c=>c.ownerTaskId===f.journey.id);
  assert.ok(task,phase);assert.equal(task.definitionOnly,false);assert.equal(admission(f.life,task,f.cfg,{now:NOW}).allowed,true,phase);
 }
});

test('a paused purpose retains its record without taking scheduler focus from current plans or private events',()=>{
 for(const phase of ['pending','ready','needs_definition']){
  const f=fixture({phase,nextAt:NOW,notBefore:NOW,focus:{state:'paused',pausedAt:NOW-1000,pausedBy:'new-purpose'}}),before=structuredClone(f.journey),list=f.read();
  assert.equal(has(list,f.journey.id),false);
  for(const id of ['current-note','current-message','synthetic-other-owner','current-plan','idle','new-owner-event','urgent-work'])assert.equal(has(list,id),true,phase+' '+id);
  assert.deepEqual(f.journey,before);
 }
});

test('a saved future journey leaves current notes, social messages, another owner task, plans and idle runnable',()=>{
 const f=fixture(),before=structuredClone(f.life),list=f.read();
 for(const id of ['current-note','current-message','synthetic-other-owner','current-plan','idle','new-owner-event','urgent-work'])assert.equal(has(list,id),true,id);
 assert.equal(has(list,f.journey.id),false,'the future journey must not start early');
 for(const candidate of list)assert.equal(admission(f.life,candidate,f.cfg,{now:NOW}).allowed,true,candidate.id);
 assert.deepEqual(f.life,before,'enumeration and admission do not write quotas, delivery state or tasks');
});

test('a future notBefore still releases unrelated work when nextAt is already due',()=>{
 const f=fixture({nextAt:NOW-1,notBefore:NOW+3600000}),list=f.read();
 for(const id of ['current-note','current-message','synthetic-other-owner','current-plan','idle'])assert.equal(has(list,id),true,id);
 assert.equal(has(list,f.journey.id),false,'an automatic schedule still honors the explicit future time');
});

test('a future record-definition retry does not turn the original purpose into an action lock',()=>{
 const f=fixture({phase:'needs_definition',nextAt:0,notBefore:0,definitionNextAt:NOW+600000}),list=f.read();
 for(const id of ['current-note','current-message','synthetic-other-owner','current-plan','idle'])assert.equal(has(list,id),true,id);
 assert.equal(has(list,f.journey.id),true);assert.equal(list.find(t=>t.ownerTaskId===f.journey.id).definitionOnly,false);
});

test('a due pending or ready journey retains owner priority without suppressing unrelated plans',()=>{
 for(const phase of ['pending','ready']){
  const f=fixture({phase,nextAt:NOW,notBefore:NOW}),list=f.read();
  assert.equal(has(list,f.journey.id),true);assert.equal(has(list,'new-owner-event'),true);assert.equal(has(list,'urgent-work'),true);
  for(const id of ['idle','current-plan','current-note','current-message','synthetic-other-owner'])assert.equal(has(list,id),true,phase+' '+id);
  const task=list.find(candidate=>candidate.ownerTaskId===f.journey.id);assert.equal(task.priority,0);assert.equal(admission(f.life,task,f.cfg,{now:NOW}).allowed,true);
 }
});

test('a due missing-steps purpose can act normally while unrelated work remains available',()=>{
 const f=fixture({phase:'needs_definition',nextAt:0,notBefore:0,definitionNextAt:NOW}),list=f.read(),task=list.find(candidate=>candidate.ownerTaskId===f.journey.id);
 assert.ok(task);assert.equal(task.definitionOnly,false);assert.equal(has(list,'idle'),true);assert.equal(has(list,'current-plan'),true);assert.equal(has(list,'new-owner-event'),true);assert.equal(has(list,'urgent-work'),true);
});

test('task phase records alone never become a global lock on unrelated current work',()=>{
 for(const phase of ['travelling','working','waiting_event']){
  const f=fixture({phase,nextAt:NOW+86400000,notBefore:NOW+86400000}),list=f.read();
  for(const id of ['idle','current-plan','current-note','current-message'])assert.equal(has(list,id),true,phase+' '+id);
  assert.equal(has(list,'new-owner-event'),true);assert.equal(has(list,'urgent-work'),true);
 }
});

test('foreign and missing task scope cannot lock current-scope social or owner work',()=>{
 for(const patch of [{owner:'foreign-owner'},{persona:'foreign-persona'},{owner:undefined},{persona:undefined}]){
  const f=fixture({phase:'pending',nextAt:NOW,notBefore:0,...patch}),list=f.read();
  for(const id of ['current-note','current-message','synthetic-other-owner','current-plan','idle'])assert.equal(has(list,id),true,JSON.stringify(patch)+' '+id);
 }
});

test('missing current owner or persona does not borrow a task identity to suppress unrelated work',()=>{
 for(const key of ['owner','persona']){
  const f=fixture({nextAt:NOW,notBefore:0});f.life[key]='';
  const list=f.read();assert.equal(has(list,'current-note'),true,key);assert.equal(has(list,'current-message'),true,key);
 }
});

test('future-focus evaluation preserves sharing, original receipts, world state, quota and scheduling records',()=>{
 const f=fixture();f.life.outbox=[{id:'existing-share',state:'sent',receipt:{message_id:'synthetic-message'}}];f.life.days={'2026-11-27':{work:5,idle:2,share:1,spend:8}};
 f.life.journal=[{id:'original-receipt',status:'confirmed',tool:'mcp__fish-world__world_do',args:'{"id":"synthetic-action"}',result:'合成原回执'}];
 const before=structuredClone(f.data);for(let i=0;i<3;i++)f.read();assert.deepEqual(f.data,before);
 assert.equal(f.life.outbox.length,1,'there is no QQ/proactive send, replay or new share creation in candidate selection');
});
