import test from 'node:test';
import assert from 'node:assert/strict';
import {proofOfPlanProgress} from '../extensions/aurabot/fish-world/plan-progress.mjs';
import {preparePlanChanges,applyPlanChanges} from '../extensions/aurabot/fish-world/plans.mjs';

const NOW=Date.parse('2026-11-26T12:00:00+08:00'),DAY=86400000,TOMORROW=Date.parse('2026-11-27T00:00:00+08:00'),W='mcp__fish-world__world_';
function fixture(patch={}){
 const plan={id:'plan-a',revision:1,status:'pending',goal:'向合成朋友#9询问线和珠进货渠道',nextStep:'问合成朋友#9线和珠从哪里进货',subject:'self',trigger:'message',nextAt:NOW,createdAt:NOW-DAY,lastProgressAt:NOW-60000,lastCheckedAt:NOW-30000,...patch};
 const life={owner:'synthetic-owner',persona:'synthetic-persona',ownerInstructionRevision:0,plans:[plan],queue:[],journal:[],planHistory:[],planProposals:[],ownerTasks:[]};
 const round={id:'round-a',sessionId:'session-a',kind:'plan',startedAt:NOW-10000,planId:plan.id,planIds:[plan.id],events:[],receipts:[],report:{events:[],planChanges:[]}};
 return {life,round,plan,data:{fishId:'合成自己#1',state:{body:{full:70,energy:80},money:100},life}};
}
function receipt(f,name,args,extra={}){
 const id='receipt-'+f.round.receipts.length,entry={id,tool:W+name,args:JSON.stringify(args),round:f.round.id,sessionId:f.round.sessionId,status:'confirmed',isError:false,at:NOW-1000,finishedAt:NOW,result:'合成成功回执',...extra};
 f.life.journal.push(entry);f.round.receipts.push({id,tool:W+name,text:entry.result,isError:false});return entry;
}
const proof=(f,options={})=>proofOfPlanProgress(f.life,f.data,f.round,f.plan,{now:NOW,...options});

test('global full, energy, money, doing and location changes are observations rather than plan progress',()=>{
 const f=fixture();receipt(f,'now',{});f.plan.lastEvidenceFingerprint='old-fingerprint';
 const before=proof(f);Object.assign(f.data.state,{body:{full:10,energy:20},money:1000,doing:'合成新活动',where:{id:'new-place'}});
 assert.deepEqual(proof(f),before);assert.equal(before.progressed,false);assert.equal(proof(f,{hasMutation:true}).progressed,false,'legacy whole-round flags cannot manufacture attribution');
});

test('an unrelated successful meal, work, movement, update or friend-list call does not advance the peer inquiry',()=>{
 for(const [name,args]of [['do',{id:'eat'}],['do',{id:'work'}],['go',{place:'home'}],['update',{outfit:'blue'}],['friends',{action:'list'}]]){
  const f=fixture();receipt(f,name,args);assert.equal(proof(f).progressed,false,name);
 }
});

test('a message to the exact planned peer and topic proves progress with its real receipt',()=>{
 const f=fixture(),row=receipt(f,'say',{fish:'合成朋友#9',text:'请问线和珠从哪里进货？'}),before=structuredClone(f);
 assert.deepEqual(proof(f),{progressed:true,receiptIds:[row.id],reason:'confirmed-related-action'});assert.deepEqual(f,before,'progress evaluation is pure');
});

test('same peer with another topic and same topic with another peer remain unrelated',()=>{
 for(const args of [{fish:'#9',text:'今天的天气怎么样？'},{fish:'#90',text:'请问线和珠从哪里进货？'}]){
  const f=fixture();receipt(f,'say',args);assert.equal(proof(f).progressed,false);
 }
});

test('legacy and explicit evidence-ID bags cannot turn an unrelated mutation into progress',()=>{
 for(const legacy of [true,false]){
  const f=fixture(),row=receipt(f,'do',{id:'eat'});f.plan.sourceEvidenceIds=[row.id];
  f.round.report.planChanges=[{op:'update',id:f.plan.id,legacy,evidenceIds:[row.id],patch:{progress:'合成声称有进展'}}];
  f.life.planHistory.push({roundId:f.round.id,at:NOW,op:'update',id:f.plan.id,evidenceIds:[row.id],before:{progress:''},patch:{progress:'合成声称有进展'}});
  assert.equal(proof(f).progressed,false);
 }
});

test('an exact tool and argument step is progress without declaring the plan complete',()=>{
 const f=fixture({goal:'买书之后回家',nextStep:'回家继续后续步骤',steps:[{tool:'world_go',arguments:'{"place":"home"}'}]}),row=receipt(f,'go',{place:'home',by:'walk',request_id:'synthetic-request'});
 assert.equal(proof(f).progressed,true);assert.deepEqual(proof(f).receiptIds,[row.id]);assert.equal(proof(f).reason,'confirmed-related-step');assert.equal(f.plan.status,'pending');
});

test('step matching compares all declared arguments, not only the action name',()=>{
 const f=fixture({steps:[{tool:'world_do',arguments:{id:'buy-book',count:2}}]});receipt(f,'do',{id:'buy-book',count:1});assert.equal(proof(f).progressed,false);
});

test('an explicit linked owner task step can attribute progress but another task cannot',()=>{
 for(const linked of [true,false]){
  const f=fixture({ownerTaskId:'task-a'});f.round.ownerTaskId=linked?'task-a':'task-b';f.life.ownerTasks.push({id:'task-a',steps:[{tool:W+'do',arguments:{id:'buy-book'}}]});receipt(f,'do',{id:'buy-book'});
  assert.equal(proof(f).progressed,linked);
 }
});

test('confirmed travel to the structured destination advances a stage while unrelated travel does not',()=>{
 for(const place of ['library','cafe']){
  const f=fixture({goal:'前往图书馆继续读书',nextStep:'到达后看书',subject:'library',trigger:'arrive'});receipt(f,'go',{place});assert.equal(proof(f).progressed,place==='library');
 }
});

test('recognized work, reading, cooking and meal goals require their corresponding real do IDs',()=>{
 for(const [goal,id]of [['去上班打工','work'],['在图书馆读书','read'],['回家做饭','cook'],['先吃饭再继续','eat']]){
  const f=fixture({goal,nextStep:goal});receipt(f,'do',{id});assert.equal(proof(f).progressed,true,goal);
 }
 const f=fixture({goal:'去上班打工',nextStep:'继续本班工作'});receipt(f,'do',{id:'eat'});assert.equal(proof(f).progressed,false);
});

test('an inquiry about another fish working or eating is not fulfilled by doing that activity oneself',()=>{
 for(const [goal,id]of [['向合成朋友#9询问工作情况','work'],['向合成朋友#9询问吃饭情况','eat'],['购买上班的衣服','work']]){
  const f=fixture({goal,nextStep:goal});receipt(f,'do',{id});assert.equal(proof(f).progressed,false,goal);
 }
});

test('friend listing stays read-only even when included in a declared step; actual request must match its friendship goal',()=>{
 const f=fixture({goal:'加合成朋友#9为好友',nextStep:'申请好友',steps:[{tool:'world_friends',arguments:{action:'list'}}]});receipt(f,'friends',{action:'list'});assert.equal(proof(f).progressed,false);
 const g=fixture({goal:'加合成朋友#9为好友',nextStep:'申请好友'});receipt(g,'friends',{action:'request',fish:'#9'});assert.equal(proof(g).progressed,true);
 const h=fixture({goal:'加合成朋友#9为好友',nextStep:'申请好友'});receipt(h,'friends',{action:'remove',fish:'#9'});assert.equal(proof(h).progressed,false);
});

test('failed, uncertain, stale, foreign-round, foreign-session and malformed receipts never prove an action',()=>{
 for(const extra of [{status:'failed'},{status:'uncertain'},{isError:true},{round:'other-round'},{sessionId:'other-session'},{at:NOW-20000},{finishedAt:NOW+1},{finishedAt:NOW-2000},{args:'bad-json'}]){
  const f=fixture();receipt(f,'say',{fish:'#9',text:'请问线和珠从哪里进货？'},extra);assert.equal(proof(f).progressed,false,JSON.stringify(extra));
 }
 const f=fixture();receipt(f,'say',{fish:'#9',text:'请问线和珠从哪里进货？'});f.round.receipts[0].isError=true;assert.equal(proof(f).progressed,false);
});

test('a journal entry alone, forged receipt text or a different selected plan cannot advance this plan',()=>{
 for(const change of [f=>{f.round.receipts=[];},f=>{f.round.receipts[0].text='合成不一致正文';},f=>{f.round.planId='another';f.round.planIds=['another'];}]){
  const f=fixture();receipt(f,'say',{fish:'#9',text:'请问线和珠从哪里进货？'});change(f);assert.equal(proof(f).progressed,false);
 }
});

function event(f,extra={}){
 const q={id:'event-a',kind:'message',sender:'合成朋友#9',t:NOW-500,lastRoundId:f.round.id,status:'completed',provenance:{trusted:true,source:'world-notify'},relatedPlanIds:[f.plan.id],...extra};
 f.life.queue.push(q);f.round.events=[q.id];f.round.report.events=[{id:q.id,status:'completed'}];return q;
}
test('a newly processed trusted event bound to the explicit plan wait proves real external progress',()=>{
 const f=fixture({waitCondition:{kind:'event',eventKind:'message',subject:'合成朋友#9',trustedOnly:true,after:NOW-20000}});event(f);
 assert.deepEqual(proof(f),{progressed:true,receiptIds:[],reason:'completed-related-event'});
});

test('old source events, untrusted notices, another sender and noncompleted dispositions cannot reset no-progress',()=>{
 for(const change of [
  f=>{f.life.queue[0].t=NOW-60000;},f=>{f.life.queue[0].provenance.trusted=false;},f=>{f.life.queue[0].provenance.source='owner-control';},
  f=>{f.life.queue[0].sender='另一个#10';},f=>{f.life.queue[0].lastRoundId='other-round';},f=>{f.round.events=[];},f=>{f.round.report.events[0].status='blocked';},f=>{f.life.queue[0].t=NOW+1;}
 ]){
  const f=fixture({waitCondition:{kind:'event',eventKind:'message',subject:'合成朋友#9',trustedOnly:true,after:NOW-20000}});event(f);change(f);assert.equal(proof(f).progressed,false);
 }
});

function planner(){return fixture({goal:'规划明天一天的日程',nextStep:'保存明天的活动计划',topic:'daily-planning',businessAt:TOMORROW+8*3600000,windowStart:TOMORROW,windowEnd:TOMORROW+DAY});}
function schedule(f,{at=TOMORROW+9*3600000,apply=true,now=NOW}={}){
 const input={planChanges:[{op:'create',plan:{goal:'前往合成图书馆读书',reason:'合成日程',nextStep:'阅读合成书',subject:'self',stage:'morning',businessAt:at,nextAt:at,trigger:'time',waitCondition:{kind:'time',at},windowStart:TOMORROW,windowEnd:TOMORROW+DAY}}]};
 const operations=preparePlanChanges(f.life,input,{round:f.round,now,fishId:f.data.fishId});f.round.report.planChanges=operations;
 if(apply)applyPlanChanges(f.life,operations,{now,roundId:f.round.id});return operations[0].id;
}
test('a daily planning round can fulfill its job by committing a valid dated local plan without a world mutation',()=>{
 const f=planner();receipt(f,'now',{});schedule(f);const before=structuredClone(f);
 assert.equal(proof(f).progressed,true);assert.equal(proof(f).reason,'committed-local-planning');assert.deepEqual(f,before);assert.equal(f.round.receipts.length,1);
});

test('a real 23:45 tomorrow-planning instance accepts next-day schedules despite its automatically generated same-day window',()=>{
 const tonight=Date.parse('2026-11-26T23:45:00+08:00'),today=TOMORROW-DAY;
 const f=fixture({goal:'规划明天一天的日程',nextStep:'保存明天的活动计划',topic:'daily-planning',createdAt:NOW,nextAt:tonight,windowStart:today,windowEnd:TOMORROW});
 f.round.startedAt=tonight-10000;schedule(f,{now:tonight});
 assert.equal(proof(f,{now:tonight}).reason,'committed-local-planning');
});

test('relative planning dates remain anchored to creation and never accept an arbitrary later day',()=>{
 const tonight=Date.parse('2026-11-26T23:45:00+08:00');
 for(const [createdAt,at]of [[NOW-DAY,TOMORROW+9*3600000],[NOW,TOMORROW+DAY+9*3600000]]){
  const f=fixture({goal:'制定次日日程',nextStep:'提交次日安排',topic:'daily-planning',createdAt,nextAt:tonight});
  f.round.startedAt=tonight-10000;schedule(f,{now:tonight,at});
  assert.equal(proof(f,{now:tonight}).progressed,false);
 }
});

test('an explicit planning business date takes precedence over prose and an old check-day window',()=>{
 const tonight=Date.parse('2026-11-26T23:45:00+08:00');
 const f=fixture({goal:'规划明天一天的日程',nextStep:'保存活动计划',topic:'daily-planning',createdAt:NOW-DAY,nextAt:tonight,businessAt:TOMORROW+8*3600000,windowStart:TOMORROW-DAY,windowEnd:TOMORROW});
 f.round.startedAt=tonight-10000;schedule(f,{now:tonight});
 assert.equal(proof(f,{now:tonight}).progressed,true);
});

test('an unapplied draft, existing/no-op change and mere self deferral are not a local planning deliverable',()=>{
 const draft=planner();schedule(draft,{apply:false});assert.equal(proof(draft).progressed,false);
 const f=planner();f.round.report.planChanges=[{op:'existing',id:f.plan.id}];assert.equal(proof(f).progressed,false);
 f.round.report.planChanges=[{op:'update',id:f.plan.id,patch:{nextAt:TOMORROW}}];f.life.planHistory.push({id:f.plan.id,roundId:f.round.id,at:NOW,op:'update',before:{nextAt:NOW},patch:{nextAt:TOMORROW}});assert.equal(proof(f).progressed,false);
});

test('invalid, blocked, wrong-day or foreign-round child plans do not fulfill the daily planner',()=>{
 for(const change of [
  (f,id)=>{f.life.plans.find(p=>p.id===id).status='blocked';},(f,id)=>{f.life.plans.find(p=>p.id===id).scheduleIssue={code:'trigger-needs-definition'};},
  (f,id)=>{Object.assign(f.life.plans.find(p=>p.id===id),{nextAt:0,waitCondition:undefined,trigger:'明天再看看'});},
  (f,id)=>{f.life.planHistory[0].roundId='other-round';},(f,id)=>{f.life.plans.find(p=>p.id===id).businessAt=TOMORROW+DAY+3600000;}
 ]){
  const f=planner(),id=schedule(f);change(f,id);assert.equal(proof(f).progressed,false);
 }
});

test('a newly scheduled unrelated plan does not advance an ordinary inquiry or an ambiguous second daily planner',()=>{
 const ordinary=fixture();schedule(ordinary);assert.equal(proof(ordinary).progressed,false);
 const f=planner();f.life.plans.push({...f.plan,id:'second-planner'});f.round.planIds.push('second-planner');schedule(f);assert.equal(proof(f).progressed,false);
});

test('executing a future activity is not a substitute for the daily planning commit',()=>{
 const f=planner();f.plan.goal='规划明天工作和吃饭的日程';receipt(f,'do',{id:'work'});receipt(f,'do',{id:'eat'});assert.equal(proof(f).progressed,false);
});
