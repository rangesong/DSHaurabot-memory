import test from 'node:test';
import assert from 'node:assert/strict';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import * as tasks from '../extensions/aurabot/fish-world/owner-tasks.mjs';
import {setOwnerTaskContext,ownerTaskContext} from '../extensions/aurabot/fish-world/session-identity.mjs';
const W='mcp__fish-world__world_',NOW=Date.parse('2026-11-28T14:52:00+08:00'),sid='synthetic-private',identity={owner:'synthetic-owner',persona:'synthetic'};
const first={goal:'合成采购目的',destination:'synthetic-shop',arrivalStep:'核对合成商品并购买'},next={goal:'去合成海边观察',destination:'synthetic-coast',arrivalStep:'看现场',completionType:'observe'};
function fixture({uncertain=true}={}){
 const l={...newLife(NOW-10000),...identity},data={state:{where:{kind:'home'},doing:null},at:{state:NOW}},options={sessionId:sid,identity,now:NOW-5000,sourceKind:'owner',data};
 setOwnerTaskContext(l,sid,{key:'old-turn',ownerText:'去合成商店买东西',taskId:null,at:NOW-5000});const old=tasks.registerJourney(l,first,options).task,task=l.ownerTasks.find(t=>t.id===old.id);
 Object.assign(task,{phase:uncertain?'uncertain':'pending',nextAt:uncertain?0:NOW-1000});task.journey.stage='arrival-purpose';task.finalAction={tool:W+'do',arguments:{id:'synthetic-test'},nextStep:'合成剩余步骤',waitFor:'receipt'};task.steps=[structuredClone(task.finalAction)];task.stepIndex=0;task.receipts=[{id:'old-success'}];task.completedSteps=[{index:-1,action:{tool:W+'do',arguments:{id:'synthetic-buy'}},callId:'old-success',at:NOW-4000}];
 if(uncertain){l.journal.push({id:'old-unknown',ownerTaskId:task.id,sessionId:'session-'+sid,tool:W+'do',args:'{"id":"synthetic-test","count":1}',status:'uncertain',isError:true,result:'Error: Request timed out',at:NOW-2000,finishedAt:NOW-1900});task.history.push({kind:'uncertain',tool:W+'do',callId:'old-unknown',at:NOW-1900});}
 const register=input=>tasks.registerJourney(l,input,{...options,now:NOW}),exec=(name,args={},session='session-'+sid)=>({name:W+name,arguments:args,agent:{session:{id:session}}});
 return {l,data,task,register,exec};
}
const facts=t=>structuredClone(Object.fromEntries(['phase','nextAt','steps','stepIndex','receipts','completedSteps','finalAction','instruction','journey'].map(key=>[key,t[key]])));
test('an explicit new private purpose pauses the old unknown purpose without changing its execution facts',()=>{
 const f=fixture(),before=facts(f.task),journal=structuredClone(f.l.journal),result=f.register(next);
 assert.equal(result.ok,true);assert.deepEqual(result.pausedIds,[f.task.id]);assert.equal(f.task.focus.state,'paused');assert.equal(f.task.focus.pausedBy,result.task.id);assert.deepEqual(facts(f.task),before);assert.deepEqual(f.l.journal,journal);assert.equal(ownerTaskContext(f.l,sid).taskId,result.task.id);assert.equal(result.task.focus.state,'active');
 assert.equal(tasks.ownerTaskGuard(f.l,f.data,f.exec('go',{place:next.destination}),false,NOW),undefined);
});
test('explicit replacement retains an unknown operation as a paused purpose instead of cancelling it',()=>{
 const f=fixture(),before=facts(f.task),result=f.register({...next,replaceTaskId:f.task.id});assert.deepEqual(result.replacedIds,[]);assert.deepEqual(result.pausedIds,[f.task.id]);assert.equal(f.task.status,'active');assert.deepEqual(facts(f.task),before);
});
test('a safe explicit replacement retains its existing cancellation meaning',()=>{
 const f=fixture({uncertain:false}),result=f.register({...next,replaceTaskId:f.task.id,switchPolicy:'replace'});assert.deepEqual(result.replacedIds,[f.task.id]);assert.equal(f.task.status,'cancelled');
});
test('resume requires the exact purpose contract and preserves the original unknown phase and nextAt',()=>{
 const f=fixture(),before=facts(f.task),switched=f.register(next),resumed=f.register({...first,resumeTaskId:f.task.id});assert.equal(resumed.resumed,true);assert.equal(resumed.task.id,f.task.id);assert.equal(f.task.focus.state,'active');assert.equal(f.l.ownerTasks.find(t=>t.id===switched.task.id).focus.state,'paused');assert.deepEqual(facts(f.task),before);
 assert.match(tasks.ownerTaskGuard(f.l,f.data,f.exec('do',{id:'synthetic-test'}),false,NOW),/未确认|未知|核对/);
});
test('mismatched, foreign, background and scheduled resume/switch never steal owner focus',()=>{
 for(const alter of [input=>({...input,goal:'另一个目的'}),input=>({...input,destination:'other'}),input=>({...input,arrivalStep:'other'}),input=>({...input,completionType:'observe'})]){
  const f=fixture();f.register(next);const before=structuredClone(f.l);assert.throws(()=>f.register(alter({...first,resumeTaskId:f.task.id})));assert.deepEqual(f.l,before);
 }
 for(const patch of [{sourceKind:'world-schedule'},{background:true},{identity:{...identity,persona:'other'}},{sessionId:'foreign-private'}]){
  const f=fixture(),before=structuredClone(f.l);assert.throws(()=>tasks.registerJourney(f.l,{...next,replaceTaskId:f.task.id},{sessionId:sid,identity,now:NOW,sourceKind:'owner',data:f.data,...patch}));assert.deepEqual(f.l,before);
 }
});
test('paused candidates remain visible in bounded snapshots but are not scheduled automatically',()=>{
 const f=fixture({uncertain:false}),switched=f.register(next),candidates=tasks.ownerTaskCandidates(f.l,NOW,f.data);assert.ok(!candidates.some(c=>c.ownerTaskId===f.task.id));assert.ok(candidates.some(c=>c.ownerTaskId===switched.task.id));
 const snapshot=tasks.ownerTaskSnapshot(f.l,{ownerTaskId:switched.task.id});assert.ok(snapshot.some(t=>t.id===f.task.id&&t.focus.state==='paused'));assert.ok(snapshot.some(t=>t.id===switched.task.id&&t.focus.state==='active'));
});
test('private mutation does not inherit a unique old task after context is cleared; read-only lookup still can',()=>{
 const f=fixture();setOwnerTaskContext(f.l,sid,{key:'new-chat',taskId:null,at:NOW});assert.equal(tasks.taskForExecution(f.l,f.exec('do',{id:'other'})),undefined);assert.equal(tasks.taskForExecution(f.l,f.exec('now')),f.task);
 assert.equal(tasks.ownerTaskGuard(f.l,f.data,f.exec('do',{id:'other'}),false,NOW),undefined);
});
test('only an exact unique unpaused final action can preserve a purpose through a private follow-up question',()=>{
 const f=fixture({uncertain:false});setOwnerTaskContext(f.l,sid,{key:'question',taskId:null,at:NOW});assert.equal(tasks.taskForExecution(f.l,f.exec('do',{id:'synthetic-test',request_id:'transport'})),f.task);assert.equal(tasks.taskForExecution(f.l,f.exec('go',{place:'new-purpose'})),undefined);assert.equal(tasks.taskForExecution(f.l,f.exec('do',{id:'other'})),undefined);f.task.focus={state:'paused'};assert.equal(tasks.taskForExecution(f.l,f.exec('do',{id:'synthetic-test'})),undefined);
});
test('unknown mutation protection survives task switches, request-id/count changes and restart',()=>{
 const f=fixture();f.register(next);const l=JSON.parse(JSON.stringify(f.l));for(const args of [{id:'synthetic-test'},{id:'synthetic-test',count:8,request_id:'new'}])assert.match(tasks.unknownWorldMutationGuard(l,f.exec('do',args)),/未确认|未知|核对/);
 assert.equal(tasks.unknownWorldMutationGuard(l,f.exec('do',{id:'different'})),undefined);assert.equal(tasks.unknownWorldMutationGuard(l,f.exec('go',{place:'synthetic-coast'})),undefined);
});
test('an unresolved go prevents later navigation while unrelated read-only calls remain available',()=>{
 const f=fixture();Object.assign(f.l.journal[0],{tool:W+'go',args:'{"place":"old-place"}'});assert.equal(tasks.unknownWorldMutationGuard(f.l,f.exec('go',{place:'new-place'})),undefined);assert.match(tasks.unknownWorldMutationGuard(f.l,f.exec('go',{place:'old-place',by:'taxi'})),/未确认|未知|核对/);assert.equal(tasks.unknownWorldMutationGuard(f.l,f.exec('now')),undefined);
});
test('unresolved say uses peer and exact content; malformed targets fail closed inside that tool',()=>{
 const f=fixture();Object.assign(f.l.journal[0],{tool:W+'say',args:'{"fish":"#123","text":"synthetic"}'});assert.ok(tasks.unknownWorldMutationGuard(f.l,f.exec('say',{fish:'#123',text:'synthetic',request_id:'changed'})));assert.equal(tasks.unknownWorldMutationGuard(f.l,f.exec('say',{fish:'#123',text:'new-message'})),undefined);assert.equal(tasks.unknownWorldMutationGuard(f.l,f.exec('say',{fish:'#999',text:'synthetic'})),undefined);
 f.l.journal[0].args='broken';assert.ok(tasks.unknownWorldMutationGuard(f.l,f.exec('say',{fish:'#999',text:'other'})));assert.equal(tasks.unknownWorldMutationGuard(f.l,f.exec('do',{id:'new'})),undefined);
});
test('peer aliases cannot evade the cross-purpose unresolved say and friend-operation seal',()=>{
 for(const [oldFish,newFish] of [['合成鱼#123','#123'],['#123','合成鱼#123'],['#00123','123'],['unknown-name','#123']]){
  const f=fixture();Object.assign(f.l.journal[0],{tool:W+'say',args:JSON.stringify({fish:oldFish,text:'synthetic'})});assert.ok(tasks.unknownWorldMutationGuard(f.l,f.exec('say',{fish:newFish,text:'synthetic'})));assert.equal(tasks.unknownWorldMutationGuard(f.l,f.exec('say',{fish:newFish,text:'different'})),undefined);
  Object.assign(f.l.journal[0],{tool:W+'friends',args:JSON.stringify({action:'add',fish:oldFish})});assert.ok(tasks.unknownWorldMutationGuard(f.l,f.exec('friends',{action:'add',fish:newFish})));assert.equal(tasks.unknownWorldMutationGuard(f.l,f.exec('friends',{action:'list'})),undefined);
 }
});
test('all true unknown statuses remain guarded, known rejections and foreign records are not replay locks',()=>{
 for(const status of ['executing','uncertain','failed']){const f=fixture();f.l.journal[0].status=status;assert.ok(tasks.unknownWorldMutationGuard(f.l,f.exec('do',{id:'synthetic-test'})));}
 const f=fixture();Object.assign(f.l.journal[0],{status:'failed',result:'Error: [E_RULE] 合成规则拒绝'});assert.equal(tasks.unknownWorldMutationGuard(f.l,f.exec('do',{id:'synthetic-test'})),undefined);
 Object.assign(f.l.journal[0],{status:'uncertain',persona:'other'});assert.equal(tasks.unknownWorldMutationGuard(f.l,f.exec('do',{id:'synthetic-test'})),undefined);
});
test('a late result keeps its original paused task attribution without completing the new purpose',()=>{
 const f=fixture(),newTask=f.register(next).task,before=structuredClone(f.l.ownerTasks.find(t=>t.id===newTask.id)),row={...f.l.journal[0],status:'confirmed',isError:false,result:'好的，合成动作成功。',finishedAt:NOW};tasks.noteOwnerTaskResult(f.l,f.data,row,NOW);assert.deepEqual(f.l.ownerTasks.find(t=>t.id===newTask.id),before);assert.equal(row.ownerTaskId,f.task.id);
});
test('current owner text is retained verbatim, time-prefixed directives are recognized and model expansion is not promoted',()=>{
 for(const text of ['下午去海边看看','上午去超市买米','待会去海边看看','临时去海边看看','改去海边看看']){
  const f=fixture({uncertain:false});tasks.rememberOwnerTurn(f.l,identity,{text,sessionId:sid,turnKey:text},NOW);assert.equal(ownerTaskContext(f.l,sid).ownerText,text);const result=f.register(next);assert.equal(result.task.originalPurpose,text);assert.equal(result.task.purposeSource,'owner-current');
 }
 const f=fixture();tasks.rememberOwnerTurn(f.l,identity,{text:'别又发呆啊',sessionId:sid,turnKey:'neutral'},NOW);const result=f.register(next);assert.equal(result.task.originalPurpose,next.goal);assert.equal(result.task.purposeSource,'agent-proposed');assert.equal(tasks.ownerTaskSnapshot(f.l).find(t=>t.id===result.task.id).originalPurpose,next.goal);
});
test('only the original current owner pure sightseeing request creates an observe completion contract',()=>{
 for(const text of ['下午去海边看看','去合成公园逛逛']){const f=fixture();tasks.rememberOwnerTurn(f.l,identity,{text,sessionId:sid,turnKey:text},NOW);const result=f.register({...next,goal:'模型追加：捡贝壳再回家',arrivalStep:'模型追加动作',completionType:'action'});assert.equal(result.task.originalPurpose,text);assert.equal(result.task.ownerCompletionType,'observe');}
 for(const text of ['下午去海边看看并捡贝壳','下午去超市买米','你去问店主价格']){const f=fixture();tasks.rememberOwnerTurn(f.l,identity,{text,sessionId:sid,turnKey:text},NOW);assert.equal(f.register(next).task.ownerCompletionType,undefined);}
});
test('questions, negations, quotations and information chatter never become current owner directives',()=>{
 for(const text of ['下午去海边吗？','下午不要去海边','上午别去海边','他说下午去海边看看','引用：下午去海边看看','下午研究去海边的攻略','下午我们聊聊海边吧']){
  const f=fixture({uncertain:false});assert.equal(tasks.rememberOwnerTurn(f.l,identity,{text,sessionId:sid,turnKey:text},NOW),null,text);const result=f.register(next);assert.equal(result.task.purposeSource,'agent-proposed',text);
 }
});
test('exact known option rejection may release only local task uncertainty without rewriting failed history',()=>{
 const f=fixture();Object.assign(f.l.journal[0],{status:'failed',isError:true,result:'Error: [E_UNKNOWN] 这里没有「synthetic-test」。这里能做：睡觉 sleep、休息 rest'});f.task.history=f.task.history.filter(e=>e.kind!=='uncertain');f.task.history.push({kind:'unknown-failure',callId:'old-unknown',at:NOW-1800});const before=structuredClone(f.l.journal);assert.equal(tasks.reconcileKnownOwnerTaskFailures(f.l,NOW).changed,1);assert.equal(f.task.phase,'waiting_evidence');assert.equal(f.task.nextAt,0);assert.deepEqual(f.l.journal,before);assert.equal(tasks.reconcileKnownOwnerTaskFailures(f.l,NOW).changed,0);
});
test('an audited resolved readonly cause does not hide a later exact known rejection or erase its original history',()=>{
 const f=fixture(),read={id:'old-read',ownerTaskId:f.task.id,sessionId:sid,tool:W+'now',args:'{}',status:'uncertain',isError:true,result:'timeout',at:NOW-3000,finishedAt:NOW-2900};f.l.journal.unshift(read);
 Object.assign(f.l.journal[1],{status:'failed',result:'Error: [E_UNKNOWN] 这里没有「synthetic-test」。这里能做：睡觉 sleep、休息 rest'});
 f.task.history=f.task.history.filter(e=>e.kind!=='uncertain');f.task.history.push({kind:'uncertain',tool:W+'now',callId:read.id,at:NOW-2900},{kind:'readonly-failure-reconciled',causeCallIds:[read.id],readCallIds:['original-read-success'],at:NOW-2500},{kind:'unknown-failure',callId:'old-unknown',at:NOW-1800});
 const before=structuredClone(f.l.journal);assert.equal(tasks.reconcileKnownOwnerTaskFailures(f.l,NOW).changed,1);assert.equal(f.task.phase,'waiting_evidence');assert.deepEqual(f.l.journal,before);assert.equal(f.task.history.at(-1).classification,'known-not-executed');
});
test('legacy release rejects transport unknown, unmatched causes, foreign scope and other pending mutations',()=>{
 for(const alter of [f=>{},f=>f.task.history.at(-1).callId='missing',f=>f.task.persona='other',f=>f.l.journal.push({...f.l.journal[0],id:'second',tool:W+'go',args:'{"place":"other"}'})]){
  const f=fixture();alter(f);const before=structuredClone(f.task);assert.equal(tasks.reconcileKnownOwnerTaskFailures(f.l,NOW).changed,0);assert.deepEqual(f.task,before);
 }
});
