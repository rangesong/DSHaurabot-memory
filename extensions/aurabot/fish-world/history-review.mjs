import {createHash} from 'node:crypto';
import {dayKey,timestamp,eventId,planTerminal} from './state.mjs';

export const HISTORY_REVIEW_PROTOCOL='fish-world-history-review/v1';
const clone=value=>structuredClone(value);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const wire=value=>JSON.stringify(canonical(value))??'undefined';
export const historyReviewHash=value=>createHash('sha256').update(wire(value)).digest('hex');
const textHash=value=>createHash('sha256').update(String(value)).digest('hex');
const same=(a,b)=>wire(a)===wire(b);
const need=(condition,message)=>{if(!condition)throw Error(message);};
const unique=values=>[...new Set(values)];
const parse=value=>{if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{throw Error('历史来源参数不是合法 JSON');}};
const fields=['goal','reason','nextStep','trigger','status','progress'];
const identityOf=(data,original,businessAt)=>[data.fishId,data.life.owner,data.life.persona,original.revision,original.goal,original.reason,original.nextStep,original.trigger,businessAt,original.status];
const recordBy=(rows,id,label)=>{const found=rows.filter(r=>r.id===id);need(found.length===1,label+' ID 缺失或重复：'+id);return found[0];};

function verifyEvidence(l,report){
  const verified=new Map(),reads=[];
  for(const evidence of report.evidence||[]){
    need(evidence.id&&!verified.has(evidence.id),'历史证据 ID 重复');
    let actual,collection,text;
    if(evidence.source==='life.queue'){
      collection='queue';actual=recordBy(l.queue,evidence.eventId,'来源事件');text=actual.text;
      need(actual.kind===evidence.kindName&&actual.t===evidence.at&&actual.text===evidence.text&&(actual.eventVersion??1)===evidence.eventVersion,'来源事件内容或版本已变化：'+evidence.id);
    }else if(evidence.source==='life.journal'){
      collection='journal';actual=recordBy(l.journal,evidence.journalId,'来源回执');text=String(actual.result||'');
      need(actual.status==='confirmed'&&!actual.isError&&evidence.status==='confirmed'&&!evidence.isError,'终态不能使用失败或未确认回执');
      need(actual.tool===evidence.tool&&actual.sessionId===evidence.sessionId&&actual.at===evidence.at&&same(parse(actual.args),evidence.args),'来源回执身份或参数已变化：'+evidence.id);
      need(typeof evidence.fullResultSha256==='string'&&textHash(text)===evidence.fullResultSha256&&text.includes(evidence.excerpt??''),'来源回执原文哈希不匹配：'+evidence.id);
    }else throw Error('不支持的历史证据来源');
    reads.push({collection,id:actual.id,sha256:historyReviewHash(actual)});
    verified.set(evidence.id,{evidence,actual,text,collection});
  }
  return {verified,reads};
}
function evidenceFor(ids,verified){
  need(Array.isArray(ids)&&ids.length>0,'历史状态推进缺少证据');
  return ids.map(id=>{need(verified.has(id),'引用未知历史证据：'+id);return verified.get(id);});
}
function sourceProof(data,row,sourceEvents){
  const source=row.selectedOrigin,original=row.migrationOriginal;
  need(sourceEvents instanceof Map,'缺少正式原始 sourceEvents，禁止历史归并');
  need(source&&Number.isSafeInteger(source.seq)&&(data.life.contextWindow?.windows||[]).some(w=>w.sessionId===source.sessionId),'来源窗口不属于当前身份');
  const events=sourceEvents.get(source.sessionId);need(Array.isArray(events),'缺少所属窗口原始事件');
  const hits=events.filter(e=>e.seq===source.seq);need(hits.length===1,'原始事件序号缺失或重复');
  const event=hits[0];need(event.type==='tool/call'&&event.data?.name==='fish_life_finish','来源不是原始 fish_life_finish 调用');
  need(event.time===source.time&&event.data.callId===source.callId,'来源事件时间或调用标识不匹配');
  const args=parse(event.data.arguments),plans=args?.plans;
  need(Array.isArray(plans),'原始 finish 不含旧计划提交');
  const candidates=plans.filter(p=>same(p,source.sourcePlan));need(candidates.length===1,'报告 sourcePlan 与原始事件不一致或不唯一');
  const submitted=candidates[0];
  need(!submitted.id||submitted.id===original.id,'原始计划 ID 不匹配');
  for(const key of fields)need(same(submitted[key],original[key]),'原始计划业务字段不匹配：'+key);
  const businessAt=timestamp(submitted.nextAt);
  need(businessAt>0&&businessAt===row.originalSubmittedBusinessAt,'原始业务时间不匹配');
  return {...clone(source),sourceEventSha256:historyReviewHash(event),sourcePlanSha256:historyReviewHash(submitted),businessAt,identity:identityOf(data,original,businessAt)};
}
function completedBy(original,proofs,businessAt){
  const goal=original.goal||'',events=proofs.filter(p=>p.collection==='queue').map(p=>p.actual),receipts=proofs.filter(p=>p.collection==='journal').map(p=>p.actual);
  need(events.every(q=>dayKey(q.t)===dayKey(businessAt)),'完成证据与计划不属于同一业务日');
  if(/零工|班次|工作/.test(goal))need(receipts.some(r=>parse(r.args)?.id==='work')&&events.some(q=>/下班|结算/.test(q.text)),'缺少同班次接班和结算证据');
  else if(/洗衣机|衣服洗到/.test(goal))need(receipts.some(r=>parse(r.args)?.id==='hang-clothes')&&events.some(q=>/晾完|晾衣服/.test(q.text)),'缺少洗衣及晾衣完成证据');
  else need(events.some(q=>q.kind==='arrive'&&/^到了/.test(q.text)&&goal.includes(q.text.replace(/^到了/,''))),'缺少对应目的地到达证据');
}

/** Pure preparation; report claims are checked against current evidence and original owned tool calls. */
export function prepareHistoryReview(data,report,{now=Date.now(),ownerDecision='keep-grouped',sourceEvents}={}){
  need(data?.version===3&&data.life?.version===2,'需要已完成 schema 迁移的鱼世界账本');
  need(report?.protocol==='fish-world-private-history-review/v1'&&report.readOnly===true&&report.applied===false,'不是已审核的只读历史报告');
  need(ownerDecision==='keep-grouped','未授权自动放弃两类未知历史安排');
  const l=data.life,identity={fishId:data.fishId,owner:l.owner,persona:l.persona};
  need(same(identity,report.source?.identity),'历史报告不属于当前世界身份');
  const originals=report.originals||[],decisions=report.decisions||[],groups=report.canonicalGroups||[];
  need(originals.length>0&&originals.length===report.summary?.reviewed&&decisions.length===originals.length,'历史报告覆盖数量不完整');
  const rows=new Map(),sourceRefs=[],proofs=new Map();
  for(const row of originals){
    need(!rows.has(row.id),'报告存在重复计划 ID');
    const p=recordBy(l.plans,row.id,'历史计划');
    need(p.status==='needs_review'&&p.revision===row.expectedRevision&&same(p.migrationOriginal,row.migrationOriginal),'历史计划状态、版本或原件已变化：'+row.id);
    for(const field of fields.filter(f=>f!=='status'))need(same(p[field],row.migrationOriginal[field]),'当前历史计划业务字段已变化：'+field);
    const proof=sourceProof(data,row,sourceEvents);rows.set(row.id,row);proofs.set(row.id,proof);sourceRefs.push({id:row.id,...proof});
  }
  const byDecision=new Map();for(const decision of decisions){need(rows.has(decision.id)&&!byDecision.has(decision.id)&&decision.expectedRevision===rows.get(decision.id).expectedRevision,'历史决策 ID 或版本不匹配');byDecision.set(decision.id,decision);}
  const covered=new Set(),groupBy=new Map();
  for(const group of groups){
    need(group.id&&!groupBy.has(group.id)&&group.count===group.memberIds?.length&&group.memberIds.includes(group.canonicalId),'历史组结构无效');
    const base=proofs.get(group.canonicalId);need(base,'历史主计划不在报告中');
    for(const id of group.memberIds){need(rows.has(id)&&!covered.has(id)&&same(proofs.get(id).identity,base.identity),'历史归并混入不同日期、阶段、对象或状态');covered.add(id);}
    groupBy.set(group.id,group);
    if(group.count>1){const duplicate=(report.duplicateGroups||[]).filter(g=>g.id===group.id);need(duplicate.length===1&&same(duplicate[0].memberIds,group.memberIds)&&duplicate[0].canonicalId===group.canonicalId,'重复归并映射不完整');}
  }
  need(covered.size===rows.size,'历史组没有覆盖全部原计划');
  const {verified,reads}=verifyEvidence(l,report),after=new Map(),reasons=new Map(),targets=new Map();
  const operationId='history-review-'+historyReviewHash({identity,report:historyReviewHash(report),plans:originals.map(r=>[r.id,r.expectedRevision]),ownerDecision}).slice(0,24);
  const batchId='batch-'+operationId,reviewIds=[],still=[],createdPlans=[];
  const edit=id=>{if(!after.has(id))after.set(id,clone(recordBy(l.plans,id,'目标计划')));return after.get(id);};
  const verifyTarget=(id,businessAt)=>{
    const target=recordBy(l.plans,id,'延续目标'),snapshot=(report.existingValidNewPlans||[]).find(p=>p.id===id);
    need(snapshot&&!target.migrationOriginal&&!planTerminal(target.status),'缺少有效的延续目标计划');
    for(const field of ['goal','reason','nextStep','nextAt','windowStart','windowEnd'])need(same(target[field],snapshot[field]),'延续目标业务字段已变化');
    need(timestamp(target.nextAt)>businessAt&&dayKey(timestamp(target.nextAt))>dayKey(businessAt),'禁止把不同日期计划直接归并或错误延续');
    targets.set(id,{id,revision:target.revision,sha256:historyReviewHash(target)});return edit(id);
  };
  for(const decision of decisions){
    const row=rows.get(decision.id),p=edit(decision.id),group=groupBy.get(decision.groupId);
    need(group&&group.memberIds.includes(decision.id),'历史决策所属组无效');
    reasons.set(decision.id,{reason:decision.rationale||decision.recommendation,evidenceIds:clone(decision.evidenceIds||[]),sourceRefs:[proofs.get(decision.id)]});
    if(decision.category==='reliable_duplicate'){
      need(decision.id!==group.canonicalId&&decision.canonicalId===group.canonicalId&&decision.recommendation==='merge','重复归并目标无效');
      p.status='merged';p.mergedInto=group.canonicalId;const primary=edit(group.canonicalId);primary.mergedFrom=unique([...(primary.mergedFrom||[]),p.id]);
    }else{
      need(decision.id===group.canonicalId,'非主计划不能单独处置');
      if(decision.category==='evidence_supported_terminal'){
        const evidence=evidenceFor(decision.evidenceIds,verified);
        if(decision.recommendation==='completed'){completedBy(row.migrationOriginal,evidence,proofs.get(row.id).businessAt);p.status='completed';}
        else if(decision.recommendation==='superseded'){
          need(evidence.some(e=>e.collection==='journal'&&/明天|明晚|改天/.test(e.text)),'缺少明确改约或延期证据');
          const target=verifyTarget(decision.targetId,proofs.get(row.id).businessAt);p.status='superseded';p.supersededBy=target.id;target.supersedes=unique([...(target.supersedes||[]),p.id]);
        }else throw Error('不允许的历史终态操作');
        if(decision.stages)p.stages=clone(decision.stages);
      }else if(decision.category==='still_valid')still.push(decision);
      else if(decision.category==='needs_owner_decision'){
        p.status='needs_review';p.reviewBatchId=batchId;p.reviewOwnerDecision=ownerDecision;reviewIds.push(p.id);
      }else throw Error('未知历史处置类别');
    }
  }
  if(still.length){
    let peer=null,carried=null;const sharedEvidence=[],parents=[];
    for(const decision of still){
      const evidence=evidenceFor(decision.evidenceIds,verified),stages=decision.stages||[],wait=stages.find(s=>s.status==='waiting_event'),carry=stages.find(s=>s.status==='carried_forward'),expired=stages.find(s=>s.status==='expired');
      need(wait?.subject&&wait.date===null&&carry?.targetId&&expired,'复合计划缺少明确的三阶段拆分');
      need(!peer||peer===wait.subject,'不同对象不能共用等待子计划');peer=wait.subject;
      need(!carried||carried===carry.targetId,'不同后续事项不能共用等待子计划');carried=carry.targetId;
      need(evidence.some(e=>e.collection==='journal'&&e.text.includes(peer)&&/下次|下回|再碰|相遇/.test(e.text)&&/红薯/.test(e.text)&&/糖葫芦/.test(e.text)),'缺少同对象的两件未履行承诺原文');
      need(evidence.some(e=>e.collection==='journal'&&/别等|改天再约|先走|离开/.test(e.text)),'缺少旧约会结束证据');
      const p=edit(decision.id),target=verifyTarget(carry.targetId,proofs.get(p.id).businessAt);target.supersedes=unique([...(target.supersedes||[]),p.id]);
      sharedEvidence.push(...decision.evidenceIds);parents.push(p.id);
    }
    const childId='plan-history-wait-'+historyReviewHash([identity,peer,'shared-next-encounter-promise']).slice(0,24);
    need(!l.plans.some(p=>p.id===childId),'共享等待子计划已经存在，不能重复应用');
    const evidenceIds=unique(sharedEvidence),child={id:childId,revision:1,status:'waiting_event',goal:'等'+peer+'下次相遇兑现红薯与糖葫芦约定',reason:'原始回执是下次相遇承诺，没有今日固定时限',nextStep:'仅在同一对象的真实新消息或相遇后核对两件承诺，不自动发消息或购买',
      topic:'下次相遇的两件承诺',subject:peer,stage:'waiting-for-peer-event',fishId:identity.fishId,owner:identity.owner,persona:identity.persona,ownerInstructionRevision:l.ownerInstructionRevision??0,
      logicalKey:'logical-'+historyReviewHash([identity,peer,'shared-next-encounter-promise']),businessAt:0,windowStart:0,windowEnd:0,nextAt:0,expiresAt:0,trigger:'peer-event',
      waitCondition:{kind:'event',eventKinds:['message','talk','encounter'],subject:peer,trustedOnly:true,after:now},lastCheckedAt:now,lastProgressAt:now,lastEvidenceFingerprint:'',budgetBucket:'idle',
      sourceEventIds:[],sourceEvidenceIds:evidenceIds.map(id=>verified.get(id).actual.id),supersedes:parents,mergedFrom:[],createdAt:now,updatedAt:now,
      preservedPromises:['红薯','糖葫芦'],historyReview:{operationId,evidenceIds,sourceRefs:parents.map(id=>proofs.get(id))}};
    createdPlans.push(child);
    for(const decision of still){const p=edit(decision.id);p.status='superseded';p.supersededBy=childId;p.carriedForwardTo=unique([carried,childId]);p.stages=clone(decision.stages).map(s=>s.status==='waiting_event'?{...s,targetId:childId}:s);}
  }
  const queueChanges=[];
  for(const action of report.eventRecommendations||[]){
    const before=recordBy(l.queue,action.id,'待处理通知'),proof=evidenceFor(action.evidenceIds,verified);
    need(['pending','blocked','uncertain'].includes(before.status)&&(!action.expectedStatus||before.status===action.expectedStatus)&&(!action.expectedEventVersion||(before.eventVersion??1)===action.expectedEventVersion),'通知状态或版本已变化');
    need(before.id===eventId(data.fishId,before),'通知内容与原始 ID 不一致');
    need(action.action==='expired'||action.action==='observed','历史通知仅可过期或观察关闭');
    if(action.action==='expired'){
      need(before.kind==='work'&&action.reconciliation?.noReplay===true&&action.reconciliation?.workSuccessful===false,'旧工作只能记录已确认过期，禁止伪造成功');
      const deadline=/([0-2]?\d:[0-5]\d)\s*前/.exec(before.text)?.[1],at=deadline?Date.parse(dayKey(before.t)+'T'+deadline.padStart(5,'0')+':00+08:00'):0;
      const miss=proof.find(p=>p.collection==='queue'&&p.actual.t===at&&/没顾上|过期|超时/.test(p.text)),settle=proof.find(p=>p.collection==='queue'&&p.actual.t>at&&/下班|结算/.test(p.text)&&/没顾上\s*[1-9]|漏\s*[1-9]/.test(p.text));
      need(at>before.t&&miss&&settle&&action.reconciliation.deadline===at,'缺少相同期限的漏单和后续结算证据');
    }else need(['done','arrive'].includes(before.kind),'只能观察关闭已发生的完成或到达通知');
    const next={...clone(before),status:action.action,reconciliation:{...clone(before.reconciliation||{}),...clone(action.reconciliation||{}),protocol:HISTORY_REVIEW_PROTOCOL,operationId,reviewedAt:now,originalStatus:before.status,noReplay:true,evidenceIds:clone(action.evidenceIds),sourceRefs:proof.map(p=>clone(p.evidence))}};
    queueChanges.push({id:before.id,before:clone(before),beforeSha256:historyReviewHash(before),after:next,afterSha256:historyReviewHash(next),reason:action.reason,evidenceIds:clone(action.evidenceIds)});
  }
  const planChanges=[];
  for(const [id,p]of after){
    const before=recordBy(l.plans,id,'计划'),reason=reasons.get(id)||{reason:'保全归并及替代关系',evidenceIds:[],sourceRefs:[]};
    p.revision=(before.revision||0)+1;p.updatedAt=now;p.historyReview={operationId,...clone(reason)};
    planChanges.push({id,before:clone(before),beforeRevision:before.revision,beforeSha256:historyReviewHash(before),after:p,afterSha256:historyReviewHash(p),...clone(reason)});
  }
  const topics=unique((report.remainingOwnerReview||[]).flatMap(r=>r.topics||[]));
  const reviewBatch={id:batchId,status:'needs_review',planIds:reviewIds,topics,ownerDecision,noticeOnly:true,modelWake:false,automaticModelCalls:0,operationId,createdAt:now};
  const proposal={protocol:HISTORY_REVIEW_PROTOCOL,operationId,preparedAt:now,identity,ownerDecision,reportSha256:historyReviewHash(report),expected:{plans:planChanges.map(p=>({id:p.id,revision:p.beforeRevision,sha256:p.beforeSha256})),queue:queueChanges.map(q=>({id:q.id,status:q.before.status,eventVersion:q.before.eventVersion??1,sha256:q.beforeSha256})),evidence:reads,planHistorySha256:historyReviewHash(l.planHistory||[]),reviewBatchSha256:historyReviewHash(l.historyReviewBatch)},planChanges,createdPlans,queueChanges,reviewBatch,evidence:clone(report.evidence),sourceRefs,
    summary:{reviewed:originals.length,merged:decisions.filter(d=>d.category==='reliable_duplicate').length,completed:decisions.filter(d=>d.recommendation==='completed').length,superseded:decisions.filter(d=>d.recommendation==='superseded').length+still.length,groupedNeedsReview:reviewIds.length,waitingChildren:createdPlans.length,queueActions:queueChanges.length,automaticModelCalls:0,qqSends:0,worldMutations:0}};
  proposal.proposalSha256=historyReviewHash(proposal);return proposal;
}

/** All optimistic checks precede all changes. Only the four named life fields are committed. */
export function applyHistoryReview(l,proposal,{now=Date.now()}={}){
  need(proposal?.protocol===HISTORY_REVIEW_PROTOCOL,'历史维护提案协议无效');
  const {proposalSha256,...unsigned}=proposal;need(proposalSha256===historyReviewHash(unsigned),'历史维护提案已被改变');
  need(l.owner===proposal.identity.owner&&l.persona===proposal.identity.persona,'维护应用身份已变化');
  need(historyReviewHash(l.planHistory||[])===proposal.expected.planHistorySha256&&historyReviewHash(l.historyReviewBatch)===proposal.expected.reviewBatchSha256,'历史维护批次或历史记录已变化');
  const ids=new Set();
  for(const change of proposal.planChanges){const p=recordBy(l.plans,change.id,'计划');need(!ids.has(change.id)&&p.revision===change.beforeRevision&&historyReviewHash(p)===change.beforeSha256&&historyReviewHash(change.after)===change.afterSha256,'计划版本或内容冲突：'+change.id);ids.add(change.id);}
  const queueIds=new Set();for(const change of proposal.queueChanges){const q=recordBy(l.queue,change.id,'通知');need(!queueIds.has(change.id)&&historyReviewHash(q)===change.beforeSha256&&historyReviewHash(change.after)===change.afterSha256,'通知内容冲突：'+change.id);queueIds.add(change.id);}
  for(const expected of proposal.expected.evidence){const entry=recordBy(l[expected.collection],expected.id,'证据');need(historyReviewHash(entry)===expected.sha256,'应用前来源证据已变化');}
  for(const p of proposal.createdPlans){need(!l.plans.some(old=>old.id===p.id||old.logicalKey===p.logicalKey),'新计划 ID 或身份冲突');need(p.status==='waiting_event'&&p.nextAt===0&&p.expiresAt===0&&!p.waitCondition.at,'共享子计划不能取得时钟自动唤醒');}
  const plans=clone(l.plans),queue=clone(l.queue),history=clone(l.planHistory||[]);
  for(const change of proposal.planChanges){plans[plans.findIndex(p=>p.id===change.id)]=clone(change.after);history.push({at:now,op:'history-review-'+change.after.status,operationId:proposal.operationId,id:change.id,fromRevision:change.beforeRevision,toRevision:change.after.revision,before:clone(change.before),afterSha256:change.afterSha256,evidenceIds:clone(change.evidenceIds),sourceRefs:clone(change.sourceRefs)});}
  for(const p of proposal.createdPlans){plans.push(clone(p));history.push({at:now,op:'history-review-create-wait',operationId:proposal.operationId,id:p.id,toRevision:p.revision,evidenceIds:clone(p.historyReview.evidenceIds),sourceRefs:clone(p.historyReview.sourceRefs)});}
  for(const change of proposal.queueChanges){queue[queue.findIndex(q=>q.id===change.id)]=clone(change.after);history.push({at:now,op:'history-review-event-'+change.after.status,targetType:'event',operationId:proposal.operationId,id:change.id,before:clone(change.before),evidenceIds:clone(change.evidenceIds)});}
  l.plans=plans;l.queue=queue;l.planHistory=history;l.historyReviewBatch=clone(proposal.reviewBatch);
  return {ok:true,operationId:proposal.operationId,...clone(proposal.summary)};
}
