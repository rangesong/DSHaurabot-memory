import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverSessionAliasFailures} from '../extensions/aurabot/fish-world/journey-recovery.mjs';
import {defineOwnerTask,ownerTaskGuard} from '../extensions/aurabot/fish-world/owner-tasks.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';

const NOW=Date.parse('2026-11-27T18:00:00+08:00'),W='mcp__fish-world__world_';
const OWNER='11111111-1111-4111-8111-111111111111',identity={owner:'synthetic-owner',persona:'synthetic-persona'};
function fixture(){
 const life={...newLife(NOW-3600000),...identity,ownerTasks:[],ownerTaskContexts:{},controls:{sharing:true},days:{'2026-11-27':{idle:3,share:1,spend:4}},outbox:[{id:'synthetic-old-share',state:'sent',receipt:{message_id:'synthetic-receipt'}}]};
 const task={id:'synthetic-journey',...identity,status:'active',kind:'journey',phase:'blocked',revision:6,createdAt:NOW-3600000,updatedAt:NOW-60000,currentSessionId:OWNER,source:{kind:'owner',sessionId:OWNER},instruction:'查看合成目的地后继续原安排',nextStep:'根据现场登记后续动作',nextAt:0,finalAction:null,steps:[],stepIndex:0,completedSteps:[],receipts:[],history:[],checks:3,lastCheckedAt:NOW-60000,definitionAttempts:3,definitionNextAt:0,contractIssue:{code:'definition-attempt-limit',at:NOW-60000,requiresOwnerClarification:true},journey:{goal:'查看合成目的地后继续原安排',destination:'synthetic-place',arrivalStep:'根据现场登记后续动作',completionType:'action',registeredSessionId:OWNER,stage:'arrival-purpose',arrivedAt:NOW-3500000}};
 life.ownerTasks.push(task);life.ownerTaskContexts[OWNER]={taskId:task.id,key:'synthetic-turn',at:task.createdAt};
 for(let i=0;i<3;i++){
  const id='synthetic-definition-round-'+i,at=NOW-1800000+i*600000,sid='22222222-2222-4222-8222-22222222222'+i;
  task.history.push({kind:'definition-incomplete',at,roundId:id,attempts:i+1,nextAt:i===2?0:at+600000,noWorldMutation:true});
  const calls=[{id:'synthetic-local-block-'+i,tool:W+'do',status:'not-submitted'}];
  life.journal.push({id,at,type:'round',kind:'owner-task',status:i===0?'uncertain':'completed',summary:i===0?'任务定义入口返回非有效后台回合':'不是当前有效后台定义回合',receipts:['synthetic-now-'+i,'synthetic-profile-'+i],actionSequences:i===1?{}:{['synthetic-sequence-'+i]:{tool:W+'do',status:'blocked',calls,outcome:{ok:false,status:'blocked',notSubmitted:true}}}});
  for(const name of ['now','profile'])life.journal.push({id:'synthetic-'+name+'-'+i,tool:W+name,args:'{}',round:id,sessionId:'session-'+sid,status:'confirmed',isError:false,at:at-3000,finishedAt:at-1000,result:'合成只读成功'});
  life.costs.rounds.push({roundId:id,sessionId:sid,status:i===0?'uncertain':'completed'});
 }
 const prior=[{id:'synthetic-prior-posters',tool:W+'do',args:'{"id":"posters"}',result:'合成告示已查看',at:task.createdAt+1000,finishedAt:task.createdAt+2000},{id:'synthetic-prior-read',tool:W+'do',args:'{"id":"read","request_id":"old-request"}',result:'合成阅读已开始',at:NOW-2000,finishedAt:NOW-1000}];
 for(const row of prior)life.journal.push({...row,sessionId:'session-'+OWNER,ownerTaskId:null,round:null,status:'confirmed',isError:false});
 return {life,task,prior,rounds:()=>life.journal.filter(row=>row.type==='round'),reads:()=>life.journal.filter(row=>row.round)};
}
const recover=f=>recoverSessionAliasFailures(f.life,{now:NOW});
const noRecovery=f=>{const before=structuredClone(f.life);assert.deepEqual(recover(f),{changed:false,recoveredIds:[]});assert.deepEqual(f.life,before);};

test('the exact three-round alias failure restores only a local definition opportunity and preserves all original evidence',()=>{
 const f=fixture(),before=structuredClone(f.life),issue=structuredClone(f.task.contractIssue);
 assert.deepEqual(recover(f),{changed:true,recoveredIds:[f.task.id]});
 assert.equal(f.task.phase,'needs_definition');assert.equal(f.task.status,'active');assert.equal(f.task.nextAt,NOW);assert.equal(f.task.definitionNextAt,NOW);assert.equal(f.task.definitionAttempts,0);assert.equal(f.task.lastCheckedAt,0);assert.equal(f.task.revision,before.ownerTasks[0].revision+1);
 assert.equal(f.task.contractIssue,undefined);assert.deepEqual(f.task.journey.sessionAliasRecovery,{version:1,at:NOW,previousIssue:issue,previousAttempts:3,roundIds:before.ownerTasks[0].history.map(row=>row.roundId)});
 assert.deepEqual(f.task.history.slice(0,-1),before.ownerTasks[0].history);assert.equal(f.task.history.at(-1).kind,'session-alias-recovered');assert.equal(f.task.history.at(-1).noWorldMutation,true);assert.equal(f.task.history.at(-1).localOnly,true);
 for(const key of ['journal','queue','outbox','days','controls','scheduler','costs','ownerTaskContexts'])assert.deepEqual(f.life[key],before[key],key+' must not change');
 for(const key of ['steps','completedSteps','receipts','source','instruction'])assert.deepEqual(f.task[key],before.ownerTasks[0][key]);
 assert.equal(f.task.completedAt,undefined,'a successful start is not completion of the original purpose');
});

test('the marker makes recovery idempotent and cannot refund a new attempt limit after reblocking',()=>{
 const f=fixture();recover(f);const once=structuredClone(f.life);assert.deepEqual(recover(f),{changed:false,recoveredIds:[]});assert.deepEqual(f.life,once);
 Object.assign(f.task,{phase:'blocked',definitionAttempts:3,contractIssue:{code:'definition-attempt-limit'}});noRecovery(f);
});

test('different background UUIDs from the registered private UUID are valid when each round has the exact prefixed read source',()=>{
 const f=fixture();assert.notEqual(f.reads()[0].sessionId,'session-'+OWNER);assert.equal(recover(f).changed,true);
});

test('recovery never operates while a round, external write or global unknown recovery is active',()=>{
 for(const patch of [{round:{id:'active-round'}},{externalPending:{callId:'pending-world'}},{recovery:true}]){const f=fixture();Object.assign(f.life,patch);noRecovery(f);}
});

test('terminal, foreign-scope and nonjourney business blocks remain untouched',()=>{
 for(const patch of [{status:'cancelled'},{status:'completed'},{kind:'activity'},{phase:'uncertain'},{owner:'other-owner'},{persona:'other-persona'},{contractIssue:{code:'business-rule-rejected'}}]){const f=fixture();Object.assign(f.task,patch);noRecovery(f);}
});

test('outbound tasks and already known pending steps cannot be guessed into an arrival definition',()=>{
 for(const change of [f=>{f.task.journey.stage='outbound';},f=>{f.task.finalAction={tool:W+'do',arguments:{id:'read'}};},f=>{f.task.steps=[{tool:W+'do',arguments:{id:'read'}}];}]){const f=fixture();change(f);noRecovery(f);}
});

test('a newer active owner purpose prevents revival of an older blocked journey',()=>{
 const f=fixture();f.life.ownerTasks.push({...structuredClone(f.task),id:'newer-purpose',phase:'pending',createdAt:f.task.createdAt+1});noRecovery(f);
});

test('two failures, duplicate round references or a missing exact round journal are not enough evidence',()=>{
 for(const change of [f=>{f.task.history.pop();},f=>{f.task.history[2].roundId=f.task.history[1].roundId;},f=>{f.life.journal=f.life.journal.filter(row=>row.id!==f.task.history[1].roundId);}]){const f=fixture();change(f);noRecovery(f);}
});

test('every failed attempt must explicitly report no world mutation and the session alias definition error',()=>{
 for(const change of [f=>{delete f.task.history[1].noWorldMutation;},f=>{f.task.history[1].noWorldMutation=false;},f=>{f.rounds()[1].summary='参数不完整，需要重新定义';},f=>{f.rounds()[1].status='executing';}]){const f=fixture();change(f);noRecovery(f);}
});

test('missing, unprefixed, failed and uncertain world read evidence cannot prove this precise seam',()=>{
 for(const change of [f=>{f.life.journal=f.life.journal.filter(row=>row.round!==f.task.history[1].roundId);},f=>{f.reads()[0].sessionId=OWNER;},f=>{f.reads()[0].status='failed';},f=>{f.reads()[0].status='uncertain';},f=>{f.reads()[0].isError=true;}]){const f=fixture();change(f);noRecovery(f);}
});

test('one round with unrelated native session identities is ambiguous rather than a session prefix alias',()=>{
 const f=fixture();f.reads()[1].sessionId='session-33333333-3333-4333-8333-333333333333';noRecovery(f);
});

test('any actually submitted mutation in a failed definition round blocks automatic recovery',()=>{
 for(const status of ['executing','confirmed','uncertain','failed']){
  const f=fixture(),row={...f.reads()[0],id:'submitted-world',tool:W+'do',args:'{"id":"read"}',status};f.life.journal.push(row);noRecovery(f);
 }
});

test('friends list is read-only but a friend request is a submitted mutation',()=>{
 const f=fixture();f.life.journal.push({...f.reads()[0],id:'friends-list',tool:W+'friends',args:'{"action":"list"}'});assert.equal(recover(f).changed,true);
 const g=fixture();g.life.journal.push({...g.reads()[0],id:'friends-request',tool:W+'friends',args:'{"action":"request","fish":"#42"}'});noRecovery(g);
});

test('a not-submitted child is safe only together with its explicit non-submission outcome',()=>{
 for(const change of [f=>{Object.values(f.rounds()[0].actionSequences)[0].calls[0].status='uncertain';},f=>{delete Object.values(f.rounds()[0].actionSequences)[0].outcome.notSubmitted;},f=>{Object.values(f.rounds()[0].actionSequences)[0].outcome.notSubmitted=false;}]){const f=fixture();change(f);noRecovery(f);}
});

test('a mutation sequence with missing children and an unknown outcome cannot pass an empty every check',()=>{
 for(const sequence of [{tool:W+'do',status:'uncertain'},{tool:W+'do',status:'blocked',calls:[],outcome:{ok:false}}]){const f=fixture();f.rounds()[0].actionSequences={unknown:sequence};noRecovery(f);}
});

test('a task-bound executing or uncertain call outside the three rounds keeps the journey protected',()=>{
 for(const status of ['executing','uncertain','failed']){const f=fixture();f.life.journal.push({id:'old-unknown',tool:W+'do',args:'{"id":"read"}',ownerTaskId:f.task.id,sessionId:'session-'+OWNER,at:NOW-100000,status});noRecovery(f);}
});

test('unbound same-session submitted or unknown actions prevent recovery even when the global recovery flag is false',()=>{
 for(const [status,result]of [['executing',''],['executed','合成结果不明确'],['uncertain','未确认'],['failed','连接中断'],['failed','[E_RULE] 操作超时'],['failed','[E_RULE] ECONNRESET']]){
  const f=fixture();assert.equal(f.life.recovery,false);
  f.life.journal.push({...f.life.journal.at(-1),id:'unbound-unknown',ownerTaskId:null,round:null,status,result});noRecovery(f);
 }
});

test('an unbound explicit known rule rejection can be skipped without becoming a successful prior action',()=>{
 const f=fixture();f.life.journal.push({...f.life.journal.at(-1),id:'known-rule-only',ownerTaskId:null,round:null,status:'failed',isError:true,result:'[E_RULE] 合成选项目前不可用'});
 assert.equal(recover(f).changed,true);assert.deepEqual(f.task.journey.priorActions.map(row=>row.id),f.prior.map(row=>row.id));
});

test('prior actions keep exact confirmed original arguments, text and times as local history without claiming completion',()=>{
 const f=fixture();recover(f);assert.equal(f.task.journey.priorActions.length,2);
 assert.deepEqual(f.task.journey.priorActions,f.prior.map(row=>({id:row.id,tool:row.tool,arguments:JSON.parse(row.args),at:row.at,finishedAt:row.finishedAt,result:row.result,localOnly:true,historyOnly:true})));
 assert.equal(f.task.status,'active');assert.equal(f.task.phase,'needs_definition');assert.equal(f.task.journey.stage,'arrival-purpose');assert.equal(f.life.outbox.length,1);
});

test('history collection excludes foreign sessions, other tasks, pre-registration rows, known rule rejections and read-only calls',()=>{
 const f=fixture(),sample=f.life.journal.at(-1);
 for(const [i,patch]of [{sessionId:'session-33333333-3333-4333-8333-333333333333'},{ownerTaskId:'other-task'},{at:f.task.createdAt-1},{status:'failed',result:'[E_RULE] 合成选项目前不可用'},{isError:true},{tool:W+'now'},{tool:W+'friends',args:'{"action":"list"}'}].entries())f.life.journal.push({...sample,id:'excluded-'+i,...patch});
 recover(f);assert.deepEqual(f.task.journey.priorActions.map(row=>row.id),f.prior.map(row=>row.id));
});

test('malformed or not-yet-finished evidence is not promoted into a confirmed prior action',()=>{
 const f=fixture(),sample=f.life.journal.at(-1);f.life.journal.push({...sample,id:'bad-args',args:'not-json'},{...sample,id:'future-finish',finishedAt:NOW+1});
 recover(f);assert.deepEqual(f.task.journey.priorActions.map(row=>row.id),f.prior.map(row=>row.id));
});

test('prior action projection is bounded to eight records and retains recent original receipts',()=>{
 const f=fixture();for(let i=0;i<12;i++)f.life.journal.push({...f.life.journal.at(-1),id:'bounded-'+i,args:JSON.stringify({id:'synthetic-action-'+i}),at:NOW-100+i,finishedAt:NOW-90+i});
 recover(f);assert.equal(f.task.journey.priorActions.length,8);assert.equal(f.task.journey.priorActions[0].id,'bounded-4');assert.equal(f.task.journey.priorActions.at(-1).id,'bounded-11');
});

test('an exact historical success cannot be redefined or submitted merely with a new request_id',()=>{
 const f=fixture();recover(f);
 assert.throws(()=>defineOwnerTask(f.life,{id:f.task.id,expectedRevision:f.task.revision,steps:[{tool:W+'do',arguments:'{"request_id":"new-request","id":"read"}',nextStep:'重复阅读开始'}]},{sessionId:'session-'+OWNER,now:NOW}),/成功回执|重放/);
 Object.assign(f.task,{phase:'pending',finalAction:{tool:W+'do',arguments:{id:'read'}}});
 const exec={name:W+'do',arguments:{request_id:'new-request',id:'read'},agent:{session:{id:'session-'+OWNER}}};
 assert.match(ownerTaskGuard(f.life,{state:{},life:f.life},exec,false,NOW),/成功|重放/);
});

test('the exact-action rule permits a different amount while original purpose remains active',()=>{
 const f=fixture();f.life.journal.push({...f.life.journal.at(-1),id:'prior-count',args:'{"id":"synthetic-item","count":2}'});recover(f);
 assert.doesNotThrow(()=>defineOwnerTask(f.life,{id:f.task.id,expectedRevision:f.task.revision,steps:[{tool:W+'do',arguments:'{"id":"synthetic-item","count":1}',nextStep:'另一个数量明确的后续动作'}]},{sessionId:OWNER,now:NOW}));
 assert.equal(f.task.status,'active');assert.equal(f.task.phase,'pending');
});
