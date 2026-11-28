import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {rememberOwnerTurn,defineOwnerTask,ownerTaskGuard,ownerTaskCandidates,taskForExecution,noteOwnerTaskResult,endOwnerTaskRound,reconcileOwnerTasks,ownerTaskPlanningComplete} from '../extensions/aurabot/fish-world/owner-tasks.mjs';

const W='mcp__fish-world__world_',at=Date.parse('2026-11-26T12:00:00+08:00'),identity={owner:'synthetic-owner',persona:'synthetic-persona'};
const planningInstruction='你每天晚上23:45前把明天在鱼的世界要干什么想好并告诉我，第二天照着做';
function fixture(start=at){
 const l={...newLife(start),...identity},data={fishId:'合成本鱼#1',life:l,state:{where:{kind:'home'}},at:{state:start}};let clock=start,token=0;
 const owner='synthetic-owner-session',bg='synthetic-background-session';
 return {l,data,owner,bg,get now(){return clock;},time(value){clock=value;},turn(text,confirmedWorld=true){return rememberOwnerTurn(l,identity,{text,sessionId:owner,turnKey:++token,confirmedWorld},clock);},round(task,extra={}){const r={id:'round-'+(++token),sessionId:bg,ownerTaskId:task?.id,startedAt:clock,status:'running',receipts:[],report:{},...extra};l.round=r;return r;},exec(name,args={},session=bg){return {name:W+name,arguments:args,agent:{session:{id:session}}};},observe(task,name,args,result,status='confirmed',session=bg){const row={id:'receipt-'+(++token),ownerTaskId:task?.id||null,tool:W+name,args:JSON.stringify(args),result,status,isError:status!=='confirmed',at:clock,finishedAt:clock,sessionId:session,round:l.round?.id||null};l.journal.push(row);noteOwnerTaskResult(l,data,row,clock);return row;}};
}
const define=(f,t,steps,nextAt)=>defineOwnerTask(f.l,{id:t.id,expectedRevision:t.revision,steps,...nextAt===undefined?{}:{nextAt}},{sessionId:f.bg,background:true,taskId:t.id,now:f.now});
const workStep=id=>({tool:'world_do',arguments:JSON.stringify({id}),nextStep:'执行当前真实班内事项'});
const allowsAction=(f,task,name,args,background=true,session=f.bg)=>{const before=structuredClone(task);assert.equal(ownerTaskGuard(f.l,f.data,f.exec(name,args,session),background,f.now),undefined);assert.deepEqual(task,before,'task tracking does not deny an action or fabricate progress');};
const nextPlan=(f,id='next-day',extra={})=>({id,owner:identity.owner,persona:identity.persona,goal:'次日实际活动',reason:'主人每日安排',nextStep:'到时执行',status:'pending',businessAt:Date.parse('2026-11-27T08:00:00+08:00'),nextAt:Date.parse('2026-11-27T08:00:00+08:00'),createdAt:f.now,...extra});
function commit(f,r,plan){f.l.plans.push(plan);f.l.planHistory.push({at:f.now,roundId:r.id,op:'create',id:plan.id,fromRevision:null,toRevision:1});}

test('an in-shift request becomes a definition of real task items rather than taking another work shift',()=>{
 const f=fixture(),task=f.turn('打工的地方有工作让你处理');assert.equal(task.kind,'work-items');assert.equal(task.phase,'needs_definition');assert.equal(task.finalAction,null);assert.deepEqual(task.steps,[]);
 assert.equal(ownerTaskCandidates(f.l,f.now,f.data).length,0);f.data.now='· task-17 处理传菜 0 贝';f.data.at.now=f.now;const r=f.round(task);assert.equal(ownerTaskCandidates(f.l,f.now,f.data)[0].definitionOnly,false);
 allowsAction(f,task,'do',{id:'work'});
 assert.throws(()=>define(f,task,[workStep('work')]),/真实 task/);
 f.observe(task,'now',{},'合成现场\n· task-17 处理传菜 0 贝\n· task-18 收拾桌子 0 贝');
 assert.throws(()=>define(f,task,[workStep('task-999')]),/真实 task/);
 define(f,task,[workStep('task-17'),workStep('task-18')]);assert.equal(task.finalAction.arguments.id,'task-17');
 allowsAction(f,task,'do',{id:'task-17'});
 assert.equal(r.id,f.l.round.id);const other=f.turn('你出门打个工去');assert.equal(other.kind,'work');assert.equal(other.finalAction.arguments.id,'work');
});

test('work-item definitions wait locally until a fresh real choice exists, without treating state or old notices as options',()=>{
 const f=fixture(),task=f.turn('打工的地方有工作让你处理'),before=structuredClone(task),choices=()=>ownerTaskCandidates(f.l,f.now,f.data);
 f.data.state.doing=null;assert.deepEqual(choices(),[]);f.data.state.doing={name:'正在上班'};assert.deepEqual(choices(),[],'state freshness alone is not an action choice');
 f.data.now='· task-17 处理传菜 0 贝';f.data.at.now=f.now-180001;assert.deepEqual(choices(),[]);f.data.at.now=f.now+1;assert.deepEqual(choices(),[]);
 f.data.at.now=f.now;f.data.errors={now:'读取失败'};assert.deepEqual(choices(),[]);delete f.data.errors.now;f.data.now='> · task-17 引用里的旧事项';assert.deepEqual(choices(),[]);
 f.data.now='当前无班内待办';const event={id:'synthetic-work',kind:'work',status:'pending',t:f.now-1,receivedAt:f.now,notBefore:f.now,provenance:{trusted:true,source:'world-notify'},text:'· task-17 处理传菜 0 贝'};f.l.queue.push(event);assert.deepEqual(choices(),[],'newer empty now supersedes an older notification');
 f.data.at.now=f.now-1000;assert.equal(choices()[0].definitionOnly,false);for(const change of [{status:'completed'},{kind:'talk'},{provenance:{trusted:false,source:'world-notify'}},{provenance:{trusted:true,source:'owner-control'}},{t:f.now-180001},{receivedAt:f.now-180001},{receivedAt:f.now+1},{notBefore:f.now+1},{text:'有班内工作等你处理，请先 world_now 查看'}]){const saved=structuredClone(event);Object.assign(event,change);assert.deepEqual(choices(),[],JSON.stringify(change));Object.assign(event,saved);}
 f.l.queue=[];f.data.now='· task-17 处理传菜 0 贝';f.data.at.now=f.now;assert.equal(choices()[0].definitionOnly,false);assert.deepEqual(task,before,'waiting and candidate inspection preserve the original request');
 f.round(task,{definitionOnly:true});f.observe(task,'now',{},'· task-17 处理传菜 0 贝');f.observe(task,'now',{},'当前无班内待办');assert.throws(()=>define(f,task,[workStep('work')]),error=>error.code==='OWNER_WORK_ITEMS_WAIT'&&error.wait===true&&error.retryable===false);assert.deepEqual(task,before,'a no-options rejection does not turn a work-item request into another shift');
 f.observe(task,'now',{},'· task-17 处理传菜 0 贝');assert.throws(()=>define(f,task,[workStep('work')]),error=>error.code==='OWNER_WORK_ITEMS_INVALID_ACTION'&&error.retryable===false);define(f,task,[workStep('task-17')]);assert.equal(task.finalAction.arguments.id,'task-17');
});

test('ordinary descriptions questions and quotations do not become new planning or work-item tasks',()=>{
 const f=fixture();for(const text of ['我每天23:45规划明天','他每天23:45规划明天','每天他23:45规划明天','我的习惯是每天23:45规划明天的事','我在班内处理工作','你知道我在班上处理工作','我刚看了工作地方有活让你处理的说明','他说打工的地方有工作让你处理','你每天23:45规划明天吗？'])assert.equal(f.turn(text),null,text);
 assert.equal(f.l.ownerTasks,undefined);for(const text of ['请每天23:45规划明天的科研实验','你每天23:45规划明天的工作','打工的地方有工作让你处理'])assert.equal(f.turn(text,false),null,text);assert.equal(f.l.ownerTasks,undefined,'outside-world planning and work items remain deferred');
});

test('future needs-definition tasks can save a schedule without making the task record an action permission gate',()=>{
 const f=fixture(),task=f.turn('你明天去食堂打工'),candidate=ownerTaskCandidates(f.l,f.now,f.data).find(x=>x.ownerTaskId===task.id);
 assert.equal(candidate.definitionOnly,false);const r=f.round(task);
 assert.throws(()=>define(f,task,[workStep('work')]),/未来时间/);
 const future=f.now+86400000;define(f,task,[workStep('work')],future);endOwnerTaskRound(f.l,r,true,f.now+1);
 assert.equal(task.phase,'pending');assert.equal(task.nextAt,future);allowsAction(f,task,'go',{place:'synthetic-work'});
 f.round(task);allowsAction(f,task,'go',{place:'synthetic-work'});assert.equal(ownerTaskCandidates(f.l,future-1,f.data).length,0);
 assert.ok(ownerTaskCandidates(f.l,future,f.data).some(x=>x.ownerTaskId===task.id));
});

test('legacy missing-definition attempts retain their audit issue without permanently disabling ordinary continuation',()=>{
 const f=fixture(),task=f.turn('你明天去食堂打工');
 for(let attempt=0;attempt<3;attempt++){const r=f.round(task,{definitionOnly:true});endOwnerTaskRound(f.l,r,true,f.now+1);assert.equal(task.definitionAttempts,attempt+1);if(attempt<2){assert.ok(task.definitionNextAt>=f.now+600000);f.time(task.definitionNextAt);}}
 assert.equal(task.phase,'blocked');assert.equal(task.contractIssue.code,'definition-attempt-limit');const next=ownerTaskCandidates(f.l,f.now+86400000,f.data).find(row=>row.ownerTaskId===task.id);assert.ok(next);assert.equal(next.definitionOnly,false);assert.equal(task.definitionAttempts,3);
 f.time(f.now+600000);f.turn('你明天去食堂打工');assert.equal(task.phase,'needs_definition');assert.equal(task.definitionAttempts,0);allowsAction(f,task,'go',{place:'synthetic-work'},false,f.owner);
});

test('an explicit full-capacity rule schedules bounded read-only checks without replaying an unsubmitted action',()=>{
 const f=fixture(),task=f.turn('你出门打个工去');f.round(task);
 const failure=f.observe(task,'do',{id:'work'},'Error: [E_RULE] 合成岗位人手够了（4/4），最早 12:20 有人下班','failed');
 assert.equal(task.phase,'blocked');assert.equal(f.l.recovery,false);assert.ok(task.nextAt>=f.now+180000&&task.nextAt<=f.now+1800000);
 const candidate=ownerTaskCandidates(f.l,task.nextAt,f.data)[0];assert.equal(candidate.readOnly,true);allowsAction(f,task,'do',{id:'work'});
 f.time(task.nextAt);let r=f.round(task);f.observe(task,'now',{},'· work 合成岗位（4/4）满员，最早 12:40 有人下班');endOwnerTaskRound(f.l,r,true,f.now+1);assert.equal(task.phase,'blocked');assert.ok(task.nextAt>f.now);
 f.time(task.nextAt);r=f.round(task);f.observe(task,'now',{},'· work 合成岗位（3/4）0 贝');endOwnerTaskRound(f.l,r,true,f.now+1);assert.equal(task.phase,'pending');assert.equal(task.availability.checkOnly,false);assert.ok(task.nextAt>=f.now+180000);assert.equal(task.receipts.length,0);assert.equal(task.availability.failureCallId,failure.id);
 const later=fixture(),laterTask=later.turn('你出门打个工去');later.round(laterTask);later.observe(laterTask,'do',{id:'work'},'[E_RULE] 合成岗位满员（4/4），最早 13:10 有人下班','failed');assert.equal(laterTask.nextAt,Date.parse('2026-11-26T13:10:00+08:00'),'an explicit earliest time is not shortened to the default thirty-minute recheck cap');
});

test('unknown mutation failures remain uncertain, while failed reads do not manufacture mutation uncertainty',()=>{
 const f=fixture(),task=f.turn('你出门打个工去');f.round(task);f.observe(task,'now',{},'synthetic network failure','failed');assert.equal(task.phase,'pending');assert.equal(f.l.recovery,false);
 f.observe(task,'do',{id:'work'},'upstream connection failed after submission','failed');assert.equal(task.phase,'uncertain');assert.equal(f.l.recovery,true);const before=structuredClone(f.l.ownerTasks);reconcileOwnerTasks(f.l,f.data,f.now+86400000);assert.deepEqual(f.l.ownerTasks,before);assert.equal(ownerTaskCandidates(f.l,f.now+86400000,f.data).length,0);
 assert.match(ownerTaskGuard(f.l,f.data,f.exec('do',{id:'work'}),true,f.now),/未确认/);
});

test('exact unique task-* contracts continue in normal rounds, while generic work and ambiguous contracts do not auto-complete',()=>{
 const f=fixture(),task=f.turn('打工的地方有工作让你处理');f.round(task);f.observe(task,'now',{},'· task-17 合成事项 0 贝');define(f,task,[workStep('task-17')]);
 f.round(null);const exec=f.exec('do',{id:'task-17'});assert.equal(taskForExecution(f.l,exec).id,task.id);const row={id:'normal-task',ownerTaskId:taskForExecution(f.l,exec).id,tool:exec.name,args:JSON.stringify(exec.arguments),status:'confirmed',at:f.now,result:'合成班内事项完成'};noteOwnerTaskResult(f.l,f.data,row,f.now);assert.equal(task.status,'completed');
 const work=f.turn('你出门打个工去');f.round(null);assert.equal(taskForExecution(f.l,f.exec('do',{id:'work'})),undefined);assert.equal(work.status,'active');
 const other=f.turn('班内有工作让你处理');f.round(other);f.observe(other,'now',{},'· task-18 合成事项 0 贝');define(f,other,[workStep('task-18')]);
 f.l.ownerTasks.push({...structuredClone(other),id:'another-contract'});f.round(null);assert.equal(taskForExecution(f.l,f.exec('do',{id:'task-18'})),undefined);
});

test('old known misclassified tasks reconcile idempotently without changing instruction or replaying unknown work',()=>{
 const f=fixture(),task=f.turn('打工的地方有工作让你处理'),instruction=task.instruction;Object.assign(task,{kind:'work',phase:'waiting_evidence',steps:[{tool:W+'do',arguments:{id:'work'},nextStep:'旧错误接班'}],finalAction:{tool:W+'do',arguments:{id:'work'}},nextAt:0});
 f.l.journal.push({id:'full',ownerTaskId:task.id,tool:W+'do',args:'{"id":"work"}',status:'failed',at:f.now,result:'[E_RULE] 人手够了（4/4）'});
 assert.equal(reconcileOwnerTasks(f.l,f.data,f.now).changed,1);assert.equal(task.kind,'work-items');assert.equal(task.phase,'needs_definition');assert.equal(task.finalAction,null);assert.equal(task.instruction,instruction);const before=structuredClone(f.l);assert.equal(reconcileOwnerTasks(f.l,f.data,f.now+1000).changed,0);assert.deepEqual(f.l,before);
 const unknown=structuredClone(task);unknown.id='unknown-old';unknown.kind='work';unknown.phase='waiting_evidence';unknown.finalAction={tool:W+'do',arguments:{id:'work'}};f.l.ownerTasks.push(unknown);f.l.journal.push({id:'unknown',ownerTaskId:unknown.id,tool:W+'do',args:'{"id":"work"}',status:'uncertain',at:f.now,result:'timeout'});const preserved=structuredClone(unknown);reconcileOwnerTasks(f.l,f.data,f.now+2000);assert.deepEqual(unknown,preserved);
});

test('daily 23:45 planning is one local obligation with no synthetic world action or claimed QQ delivery',()=>{
 const f=fixture(Date.parse('2026-11-26T22:00:00+08:00')),task=f.turn(planningInstruction);assert.equal(task.kind,'planning');assert.equal(task.phase,'pending');assert.equal(task.finalAction,null);assert.equal(task.nextAt,Date.parse('2026-11-26T23:45:00+08:00'));assert.equal(ownerTaskCandidates(f.l,f.now,f.data).length,0);
 f.time(task.nextAt);const candidate=ownerTaskCandidates(f.l,f.now,f.data)[0];assert.equal(candidate.planningOnly,true);const r=f.round(task,{planningOnly:true});allowsAction(f,task,'do',{id:'work'});
 assert.throws(()=>define(f,task,[workStep('work')]),/本地次日计划/);
 commit(f,r,nextPlan(f));endOwnerTaskRound(f.l,r,true,f.now+1000);const completed=task.planning.completed['2026-11-26'];assert.ok(completed);assert.equal(completed.localOnly,true);assert.equal(completed.communicationStatus,'not-claimed');assert.equal(task.status,'active');assert.equal(task.nextAt,Date.parse('2026-11-27T23:45:00+08:00'));assert.equal(task.receipts.length,0);
 const before=structuredClone(task);assert.equal(ownerTaskPlanningComplete(f.l,r,f.now+2000).alreadyCompleted,true);endOwnerTaskRound(f.l,r,true,f.now+2000);assert.deepEqual(task,before);assert.equal(ownerTaskCandidates(f.l,f.now+3000,f.data).length,0);
});

test('planning completion requires this round applied executable next-day plans rather than summaries or stale dates',()=>{
 const f=fixture(Date.parse('2026-11-26T23:45:00+08:00')),task=f.turn(planningInstruction),r=f.round(task,{planningOnly:true,report:{summary:'已经想好了并告诉主人'}});
 assert.equal(ownerTaskPlanningComplete(f.l,r,f.now).completed,false);
 const invalid=nextPlan(f,'invalid',{nextAt:0,trigger:'明早起床',businessAt:Date.parse('2026-11-27T08:00:00+08:00')});commit(f,r,invalid);assert.equal(ownerTaskPlanningComplete(f.l,r,f.now).completed,false);
 commit(f,r,nextPlan(f,'old-day',{businessAt:Date.parse('2026-11-26T08:00:00+08:00')}));assert.equal(ownerTaskPlanningComplete(f.l,r,f.now).completed,false);
 const foreign=nextPlan(f,'foreign',{owner:'other-owner'});commit(f,r,foreign);assert.equal(ownerTaskPlanningComplete(f.l,r,f.now).completed,false);
 const notThis=nextPlan(f,'other-round');f.l.plans.push(notThis);f.l.planHistory.push({id:notThis.id,op:'create',at:f.now,roundId:'other-round'});assert.equal(ownerTaskPlanningComplete(f.l,r,f.now).completed,false);
 commit(f,r,nextPlan(f,'valid'));assert.equal(ownerTaskPlanningComplete(f.l,r,f.now).completed,true);
});

test('existing committed next-day planning can satisfy a legacy obligation once without replay or duplicate daily instances',()=>{
 const created=Date.parse('2026-11-25T20:00:00+08:00'),f=fixture(created),task=f.turn(planningInstruction);Object.assign(task,{kind:'activity',phase:'needs_definition',planning:undefined,steps:[],finalAction:null,nextAt:0});
 f.time(Date.parse('2026-11-25T22:00:00+08:00'));const r=f.round(null),plan=nextPlan(f,'existing',{businessAt:Date.parse('2026-11-26T08:00:00+08:00'),nextAt:Date.parse('2026-11-26T08:00:00+08:00')});commit(f,r,plan);
 f.time(Date.parse('2026-11-26T12:00:00+08:00'));reconcileOwnerTasks(f.l,f.data,f.now);assert.equal(task.kind,'planning');assert.ok(task.planning.completed['2026-11-25']);assert.equal(task.nextAt,Date.parse('2026-11-26T23:45:00+08:00'));const before=structuredClone(f.l);reconcileOwnerTasks(f.l,f.data,f.now+1000);assert.deepEqual(f.l,before);
 assert.equal(f.l.ownerTasks.length,1);assert.equal(task.instruction,planningInstruction);assert.equal(ownerTaskCandidates(f.l,f.now,f.data).length,0);
});

test('task contracts survive a synthetic restart and foreign owner evidence cannot advance them',()=>{
 assert.ok(process.env.THINKSTAR_TEST_TMP);const f=fixture(),task=f.turn('打工的地方有工作让你处理');reconcileOwnerTasks(f.l,f.data,f.now);const file=path.join(fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'task-continuation-')),'synthetic.json');fs.writeFileSync(file,JSON.stringify(f.l));const restored=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(restored.ownerTasks,f.l.ownerTasks);
 restored.owner='other-owner';const before=structuredClone(restored.ownerTasks);reconcileOwnerTasks(restored,f.data,f.now+1000);assert.deepEqual(restored.ownerTasks,before);assert.equal(ownerTaskCandidates(restored,f.now+1000,f.data).length,0);noteOwnerTaskResult(restored,f.data,{ownerTaskId:task.id,tool:W+'do',args:'{"id":"task-17"}',status:'uncertain'},f.now);assert.deepEqual(restored.ownerTasks,before);
});
