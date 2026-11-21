import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareHistoryReview,applyHistoryReview} from '../extensions/aurabot/fish-world/history-review.mjs';
import {newLife,eventId,dayKey} from '../extensions/aurabot/fish-world/state.mjs';
import {advancePlans} from '../extensions/aurabot/fish-world/plans.mjs';

const now=Date.parse('2026-11-21T22:00:00+08:00'),at=time=>Date.parse('2026-11-21T'+time+':00+08:00');
const hash=text=>createHash('sha256').update(text).digest('hex');
const copy=value=>structuredClone(value);
function fixture(){
  const l=newLife(now),data={version:3,fishId:'fixture-fish',state:{money:77,where:{kind:'home'}},life:l};
  Object.assign(l,{owner:'fixture-owner',persona:'fixture-persona',days:{'2026-11-21':{work:96,idle:150,social:3,spend:7}},controls:{sharing:false},contextWindow:{windows:[{sessionId:'fixture-owned'}]},journal:[],queue:[]});
  const report={protocol:'fish-world-private-history-review/v1',synthetic:true,readOnly:true,applied:false,source:{identity:{fishId:data.fishId,owner:l.owner,persona:l.persona}},summary:{reviewed:8},originals:[],decisions:[],canonicalGroups:[],duplicateGroups:[],evidence:[],existingValidNewPlans:[],eventRecommendations:[],remainingOwnerReview:[{topics:['旧午间安排','旧返家安排']}]};
  const peer='fixture-peer#1',sourceEvents=new Map([['fixture-owned',[]]]);
  function plan(id,goal,nextStep,businessAt,patch={}){
    const n=report.originals.length,sourcePlan={id,goal,reason:'合成依据',nextStep,progress:'原始进展',trigger:'done',status:'pending',nextAt:businessAt,...patch};
    const event={type:'tool/call',seq:n,time:now-100000+n, data:{name:'fish_life_finish',callId:'fixture-call-'+n,arguments:JSON.stringify({plans:[sourcePlan]})}};
    const original={...sourcePlan,updatedAt:event.time+1,revision:1};
    l.plans.push({...copy(original),status:'needs_review',migrationOriginal:copy(original),sourceEventIds:[],sourceEvidenceIds:[],mergedFrom:[],supersedes:[]});
    report.originals.push({id,expectedRevision:1,currentStatus:'needs_review',migrationOriginal:copy(original),originalSubmittedBusinessAt:businessAt,selectedOrigin:{sessionId:'fixture-owned',seq:n,time:event.time,callId:event.data.callId,sourcePlan:copy(sourcePlan)}});
    sourceEvents.get('fixture-owned').push(event);
  }
  plan('a','旧午间做饭','11:30下米',at('11:30'));plan('b','旧午间做饭','11:30下米',at('11:30'));
  plan('c','到合成店，10:25 到','10:25进店',at('10:25'));
  plan('d','询问串珠线材料','今天问线和珠子',at('18:00'));
  plan('e','旧约会和红薯糖葫芦承诺甲','18:00先赴约',at('18:00'));
  plan('f','旧约会和红薯糖葫芦承诺乙','18:00另一步赴约',at('18:00'));
  plan('g','上午休息后做饭','11:30做饭',at('11:30'));plan('h','看完零件后回家','10:35回家',at('10:35'));
  const target={id:'tomorrow',revision:4,status:'pending',goal:'明天询问串珠线材料',reason:'明确改明天',nextStep:'明天白天询问材料',nextAt:now+86400000,windowStart:now+1000,windowEnd:now+172800000,supersedes:[]};
  l.plans.push(copy(target));report.existingValidNewPlans.push(copy(target));
  function queue(kind,time,text){const q={kind,t:time,text,status:'pending',eventVersion:1};q.id=eventId(data.fishId,q);l.queue.push(q);return q;}
  const work=queue('work',at('16:22'),'合成工作：取笔记本（16:32 前处理）'),miss=queue('done',at('16:32'),'没顾上：客人拿了一本就走，扣 6 贝'),settle=queue('done',at('16:48'),'下班结算：处理了 2 件活、没顾上 1 件'),arrive=queue('arrive',at('10:25'),'到了合成店');
  function qProof(id,q){report.evidence.push({id,source:'life.queue',eventId:q.id,eventVersion:1,kindName:q.kind,at:q.t,text:q.text,status:q.status});}
  qProof('work',work);qProof('miss',miss);qProof('settle',settle);qProof('arrive',arrive);
  function receipt(id,text){const j={id,tool:'mcp__fish-world__world_history',sessionId:'fixture-owned',at:now-1000,status:'confirmed',isError:false,args:'{}',result:text};l.journal.push(j);report.evidence.push({id,source:'life.journal',journalId:id,tool:j.tool,sessionId:j.sessionId,at:j.at,status:'confirmed',isError:false,args:{},excerpt:text,fullResultSha256:hash(text)});}
  receipt('promise',peer+'说：下次相遇补你红薯和糖葫芦。');receipt('cancel','旧约会我先离开，别等，改天再约；线珠明天再问。');
  function group(id,members,category,recommendation,evidenceIds=[],extra={}){
    const decision={id:members[0],groupId:id,expectedRevision:1,category,recommendation,evidenceIds,...extra};
    const group={id,canonicalId:members[0],memberIds:members,count:members.length,disposition:copy(decision)};report.canonicalGroups.push(group);report.decisions.push(decision);
    if(members.length>1){report.duplicateGroups.push(copy(group));for(const member of members.slice(1))report.decisions.push({id:member,groupId:id,expectedRevision:1,category:'reliable_duplicate',recommendation:'merge',canonicalId:members[0],evidenceIds:[]});}
  }
  group('ga',['a','b'],'needs_owner_decision','keep-needs-review');group('gc',['c'],'evidence_supported_terminal','completed',['arrive']);
  group('gd',['d'],'evidence_supported_terminal','superseded',['cancel'],{targetId:'tomorrow'});
  const stages=[{key:'old-meeting',status:'expired'},{key:'tomorrow-material',status:'carried_forward',targetId:'tomorrow'},{key:'promise',status:'waiting_event',subject:peer,date:null}];
  group('ge',['e'],'still_valid','retain-after-explicit-stage-split',['promise','cancel'],{stages:copy(stages)});
  group('gf',['f'],'still_valid','retain-after-explicit-stage-split',['promise','cancel'],{stages:copy(stages)});
  group('gg',['g'],'needs_owner_decision','keep-needs-review');group('gh',['h'],'needs_owner_decision','keep-needs-review');
  report.eventRecommendations=[{id:work.id,expectedStatus:'pending',expectedEventVersion:1,action:'expired',evidenceIds:['work','miss','settle'],reconciliation:{deadline:miss.t,noReplay:true,workSuccessful:false,sourceEventIds:[work.id,miss.id,settle.id]}},{id:miss.id,expectedStatus:'pending',action:'observed',evidenceIds:['miss','settle']},{id:settle.id,expectedStatus:'pending',action:'observed',evidenceIds:['settle']},{id:arrive.id,action:'observed',evidenceIds:['arrive']}];
  return {data,l,report,sourceEvents,work,miss,settle,arrive,peer};
}
const prepare=f=>prepareHistoryReview(f.data,f.report,{now,ownerDecision:'keep-grouped',sourceEvents:f.sourceEvents});
const get=(f,id)=>f.l.plans.find(p=>p.id===id);

test('source-verified review merges exact duplicates, applies proven terminals and preserves all originals and budgets',()=>{
  const f=fixture(),before=copy(f.l),money=f.data.state.money,proposal=prepare(f);assert.deepEqual(f.l,before);
  const result=applyHistoryReview(f.l,proposal,{now});assert.equal(result.merged,1);assert.equal(result.completed,1);assert.equal(result.superseded,3);
  assert.equal(get(f,'b').status,'merged');assert.equal(get(f,'b').mergedInto,'a');assert.ok(get(f,'a').mergedFrom.includes('b'));
  assert.equal(get(f,'c').status,'completed');assert.equal(get(f,'d').status,'superseded');assert.equal(get(f,'d').supersededBy,'tomorrow');
  for(const p of before.plans.filter(p=>p.migrationOriginal)){assert.deepEqual(get(f,p.id).migrationOriginal,p.migrationOriginal);assert.deepEqual(f.l.planHistory.find(h=>h.id===p.id).before,p);}
  for(const key of ['days','controls','journal','outbox','scheduler','costs'])assert.deepEqual(f.l[key],before[key]);assert.equal(f.data.state.money,money);
  assert.equal(f.l.queue.find(q=>q.id===f.work.id).status,'expired');assert.equal(f.l.queue.find(q=>q.id===f.work.id).reconciliation.workSuccessful,false);
  assert.ok([f.miss,f.settle,f.arrive].every(q=>f.l.queue.find(x=>x.id===q.id).status==='observed'));
});
test('same-peer composite plans share one undated waiting child and retain all three distinct stages',()=>{
  const f=fixture(),proposal=prepare(f);assert.equal(proposal.createdPlans.length,1);const child=proposal.createdPlans[0];
  assert.equal(child.waitCondition.subject,f.peer);assert.deepEqual(child.preservedPromises,['红薯','糖葫芦']);assert.equal(child.nextAt,0);assert.equal(child.expiresAt,0);assert.equal(child.waitCondition.at,undefined);
  applyHistoryReview(f.l,proposal,{now});for(const id of ['e','f']){assert.equal(get(f,id).supersededBy,child.id);assert.equal(get(f,id).stages[0].status,'expired');assert.equal(get(f,id).stages[1].targetId,'tomorrow');assert.equal(get(f,id).stages[2].targetId,child.id);}
  advancePlans(f.l,f.data,now+86400000);assert.equal(get(f,child.id).status,'waiting_event');
});
test('the two unknown topics remain grouped and do not become automatic model work',()=>{
  const f=fixture(),proposal=prepare(f);applyHistoryReview(f.l,proposal,{now});assert.equal(f.l.historyReviewBatch.planIds.length,3);assert.equal(f.l.historyReviewBatch.topics.length,2);
  for(const id of ['a','g','h']){assert.equal(get(f,id).status,'needs_review');assert.equal(get(f,id).reviewBatchId,f.l.historyReviewBatch.id);}
  assert.equal(f.l.historyReviewBatch.modelWake,false);assert.equal(f.l.historyReviewBatch.automaticModelCalls,0);
});
test('missing raw source events, unowned source windows, projection records and forged source parameters fail closed',()=>{
  {const f=fixture();assert.throws(()=>prepareHistoryReview(f.data,f.report,{now}),/sourceEvents/);}
  {const f=fixture();f.report.originals[0].selectedOrigin.sessionId='unowned';assert.throws(()=>prepare(f),/不属于/);}
  {const f=fixture();f.sourceEvents.get('fixture-owned')[0].type='assistant/message';assert.throws(()=>prepare(f),/原始 fish_life_finish/);}
  {const f=fixture();f.report.originals[0].selectedOrigin.sourcePlan.reason='invented';assert.throws(()=>prepare(f),/sourcePlan/);}
  {const f=fixture();f.sourceEvents.get('fixture-owned')[0].data.name='other-tool';assert.throws(()=>prepare(f),/fish_life_finish/);}
});
test('duplicates from different actual business dates or stages cannot be merged even when the report claims identity',()=>{
  for(const patch of [{nextAt:at('11:30')+86400000},{nextStep:'另一个业务阶段'}]){
    const f=fixture(),row=f.report.originals.find(p=>p.id==='b'),source=row.selectedOrigin.sourcePlan;Object.assign(source,patch);Object.assign(row.migrationOriginal,patch);Object.assign(get(f,'b').migrationOriginal,patch);Object.assign(get(f,'b'),patch);
    if(patch.nextAt)row.originalSubmittedBusinessAt=patch.nextAt;f.sourceEvents.get('fixture-owned')[row.selectedOrigin.seq].data.arguments=JSON.stringify({plans:[source]});
    assert.throws(()=>prepare(f),/不同日期、阶段、对象或状态/);
  }
});
test('failed receipts, changed notification text, changed full receipt hash and wrong identity are rejected',()=>{
  {const f=fixture();f.l.journal[0].isError=true;assert.throws(()=>prepare(f),/失败或未确认/);}
  {const f=fixture();f.work.text+='changed';assert.throws(()=>prepare(f),/来源事件内容/);}
  {const f=fixture();f.l.journal[1].result+='changed';assert.throws(()=>prepare(f),/原文哈希/);}
  {const f=fixture();f.data.fishId='other-fish';assert.throws(()=>prepare(f),/世界身份/);}
});
test('a missing explicit missed-work event cannot be replaced with clock passage or an unrelated receipt',()=>{
  const f=fixture();f.report.eventRecommendations[0].evidenceIds=['work','settle','cancel'];assert.throws(()=>prepare(f),/漏单和后续结算/);
});
test('a later target version conflict or queue change aborts the entire pure application',()=>{
  for(const target of ['plan','queue','evidence']){
    const f=fixture(),proposal=prepare(f);if(target==='plan')get(f,'tomorrow').revision++;else if(target==='queue')f.arrive.status='completed';else f.l.journal[0].memory='changed';
    const before=copy(f.l);assert.throws(()=>applyHistoryReview(f.l,proposal,{now}),/冲突|证据已变化/);assert.deepEqual(f.l,before);
  }
});
test('proposal changes, conflicting new child IDs and changed history are rejected before the first write',()=>{
  {const f=fixture(),p=prepare(f);p.planChanges[0].after.status='pending';const before=copy(f.l);assert.throws(()=>applyHistoryReview(f.l,p,{now}),/提案已被改变/);assert.deepEqual(f.l,before);}
  {const f=fixture(),p=prepare(f);f.l.plans.push(copy(p.createdPlans[0]));const before=copy(f.l);assert.throws(()=>applyHistoryReview(f.l,p,{now}),/新计划 ID/);assert.deepEqual(f.l,before);}
  {const f=fixture(),p=prepare(f);f.l.planHistory.push({id:'concurrent'});const before=copy(f.l);assert.throws(()=>applyHistoryReview(f.l,p,{now}),/历史记录已变化/);assert.deepEqual(f.l,before);}
});
test('owner keep-grouped is explicit, current business edits and repeated pure applications are refused',()=>{
  {const f=fixture();assert.throws(()=>prepareHistoryReview(f.data,f.report,{now,ownerDecision:'abandon',sourceEvents:f.sourceEvents}),/未授权/);}
  {const f=fixture();get(f,'a').goal='changed without version';assert.throws(()=>prepare(f),/业务字段已变化/);}
  {const f=fixture(),p=prepare(f);applyHistoryReview(f.l,p,{now});const before=copy(f.l);assert.throws(()=>applyHistoryReview(f.l,p,{now}),/历史维护批次|历史记录/);assert.deepEqual(f.l,before);}
});
