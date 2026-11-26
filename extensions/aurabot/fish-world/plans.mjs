import {findEquivalentPlan,equivalentPlans,refinementPatch,semanticPlan,constraintsOf} from './plan-semantics.mjs';
import {createHash} from 'node:crypto';
import {dayKey,timestamp,planOpen,planTerminal} from './state.mjs';
import {inspectPlanTrigger,normalizePlanTriggers,nextPlanWait,matchesPlanEvent} from './plan-triggers.mjs';
import {proofOfPlanProgress} from './plan-progress.mjs';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const norm=x=>String(x??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const unique=x=>[...new Set(x||[])];
const fields=['goal','reason','nextStep','topic','subject','stage','businessAt','windowStart','windowEnd','nextAt','expiresAt','trigger','waitCondition','status','constraints','semanticAliases','semanticIdentity','sourceEventIds','refinements'];
const terminalOps={complete:'completed',expire:'expired',abandon:'abandoned',block:'blocked',supersede:'superseded',merge:'merged'};
export const planIdentity=(plan,context={})=>{
  const at=timestamp(plan.businessAt),anchor=at||timestamp(plan.nextAt)||context.now||Date.now();
  const day=dayKey(anchor),start=timestamp(plan.windowStart)||Date.parse(day+'T00:00:00+08:00'),end=timestamp(plan.windowEnd)||start+86400000;
  if(end<=start)throw Error('计划业务时间窗口无效');
  return {fishId:context.fishId||'',owner:context.owner||'',persona:context.persona||'',
    topic:norm(plan.topic||plan.goal),subject:norm(plan.subject||context.subject||context.fishId||'self'),
    stage:norm(plan.stage||plan.trigger||'continue'),businessAt:at,windowStart:start,windowEnd:end,
    ownerInstructionRevision:context.ownerInstructionRevision||0};
};
export const logicalPlanKey=(plan,context)=>'logical-'+hash(planIdentity(plan,context));
export function planContext(l,round={},now=Date.now(),fishId=''){
  return {now,fishId,owner:l.owner,persona:l.persona,ownerInstructionRevision:l.ownerInstructionRevision??l.revision??0,
    sourceEventIds:unique((round.sourceEventIds||round.events||[]).filter(id=>l.queue.some(q=>q.id===id)))};
}
export function provedWorkSource(l,plan){
  if((plan.sourceEventIds||[]).some(id=>l.queue.some(q=>q.id===id&&['work','doorbell','health'].includes(q.kind)&&q.provenance?.trusted)))return true;
  return (plan.sourceEvidenceIds||[]).some(id=>l.journal.some(j=>j.id===id&&j.status==='confirmed'&&j.tool==='mcp__fish-world__world_do'&&JSON.parse(j.args||'{}').id==='work'));
}
function receiptIds(round,requested,legacy){
  const ids=requested?.length?requested:legacy?(round.receipts||[]).filter(r=>!r.isError).map(r=>r.id):[];
  if(ids.some(id=>!(round.receipts||[]).some(r=>r.id===id&&!r.isError)))throw Error('计划证据不属于本轮真实成功回执');
  return unique(ids);
}
export function preparePlanChanges(l,input,{round={},now=Date.now(),fishId=''}={}){
  const context=planContext(l,round,now,fishId),draft=structuredClone(l),result=[],changes=[];
  for(const operation of input.planChanges||[])changes.push({...operation,legacy:false});
  for(const p of input.plans||[]){
    const existing=draft.plans.find(x=>x.id===p.id);
    changes.push({op:existing?'update':'create',id:existing?.id,expectedRevision:existing?.revision,plan:p,legacy:true,requestedId:p.id});
  }
  for(const event of input.events||[]){
    const p=draft.plans.find(p=>p.id===event.id),q=draft.queue.find(q=>q.id===event.id);
    if(p&&q)throw Error('计划和事件 ID 类型冲突');
    if(event.targetType==='plan'&&!p||event.targetType==='event'&&!q)throw Error('事件处置的对象类型不匹配');
    if(p){
      if(!round.events?.includes(p.id)&&round.planId!==p.id&&!round.planIds?.includes(p.id))throw Error('计划不属于本轮处理对象');
      if(!['completed','expired','blocked'].includes(event.status))throw Error('计划处置状态无效');
      if(!changes.some(c=>c.id===p.id))changes.push({op:event.status==='completed'?'complete':event.status==='expired'?'expire':'block',id:p.id,expectedRevision:p.revision,legacy:true});
    }else if(!q&&!round.events?.includes(event.id))throw Error('未知事件或计划 ID：'+event.id);
  }
  for(const raw of changes){
    const op=String(raw.op||''),p=raw.plan||raw.patch||{},old=raw.id?draft.plans.find(x=>x.id===raw.id):null;
    if(op!=='create'&&!old)throw Error('未知计划 ID：'+raw.id);
    if(old&&raw.expectedRevision!==old.revision)throw Error('计划版本冲突：'+old.id);
    if(!['create','update',...Object.keys(terminalOps)].includes(op))throw Error('计划增量操作无效');
    const evidenceIds=receiptIds(round,raw.evidenceIds||p.evidenceIds,raw.legacy);
    let operation;
    if(op==='create'){
      if(!p.goal||!p.reason||!p.nextStep)throw Error('创建计划需要事项、原因和下一步');
      const sourceEventIds=unique(p.sourceEventIds||context.sourceEventIds);
      if(sourceEventIds.some(id=>!draft.queue.some(q=>q.id===id)))throw Error('计划来源事件不存在');
      const identity=planIdentity(p,context),logicalKey=logicalPlanKey(p,context);
      const candidate={...p,...identity,sourceEventIds};
      let same=draft.plans.find(x=>x.logicalKey===logicalKey),proof;
      const refinesId=raw.refinesPlanId||p.refinesPlanId;
      if(refinesId){same=draft.plans.find(x=>x.id===refinesId);if(!same)throw Error('同义细化引用的计划不存在');
        proof=equivalentPlans(same,candidate,draft,{...context,refinesPlanId:same.id});if(!proof&&same.logicalKey!==logicalKey)throw Error('细化计划身份没有通过核对');}
      if(!same){const match=findEquivalentPlan(draft,candidate,context);
        if(match?.ambiguous){const id='plan-proposal-'+hash([context.fishId,context.owner,context.persona,context.ownerInstructionRevision,match.candidateIds.sort(),identity.windowStart,identity.windowEnd]).slice(0,24);
          const operation={op:'propose-refinement',id,candidateIds:match.candidateIds,reason:match.reason,submission:structuredClone(p),sourceEventIds,at:now};
          applyPlanChanges(draft,[operation],{now,roundId:round.id,recordHistory:false});result.push(operation);continue;}
        if(match){same=match.old;proof=match.proof;}}
      if(p.logicalKey&&p.logicalKey!==logicalKey&&p.logicalKey!==same?.logicalKey)throw Error('模型给出的逻辑身份未通过程序核对');
      if(same){
        if(planTerminal(same.status)||same.status==='needs_review'){result.push({op:'existing',id:same.id,expectedRevision:same.revision,legacy:raw.legacy});continue;}
        const patch=refinementPatch(same,candidate,{sourceEventIds,evidenceIds,proof:proof||{identity:semanticPlan(same,draft,context)}});
        const changed=Object.keys(patch).some(k=>JSON.stringify(same[k])!==JSON.stringify(patch[k]));
        const operation=changed?{op:'update',id:same.id,expectedRevision:same.revision,patch,evidenceIds,legacy:raw.legacy,submittedPlan:p,semanticReason:proof?.reason||'existing-program-identity'}:{op:'existing',id:same.id,expectedRevision:same.revision,legacy:raw.legacy};
        applyPlanChanges(draft,[operation],{now,roundId:round.id,recordHistory:false});result.push(operation);continue;
      }
      const id=same?.id||'plan-'+hash(logicalKey).slice(0,24);
      const value={...Object.fromEntries(fields.filter(k=>p[k]!==undefined).map(k=>[k,p[k]])),...identity,id,logicalKey,
        revision:same?.revision||1,status:p.status||'pending',nextAt:timestamp(p.nextAt),expiresAt:timestamp(p.expiresAt),
        progress:norm(p.progress),constraints:constraintsOf(p),semanticAliases:[],refinements:[],semanticIdentity:semanticPlan({...p,...identity,sourceEventIds},draft,context),sourceEventIds,sourceEvidenceIds:evidenceIds,lastCheckedAt:0,lastProgressAt:now,lastEvidenceFingerprint:'',
        supersedes:[],mergedFrom:[],createdAt:now,updatedAt:now,legacyRequestedId:raw.requestedId||null};
      if(!planOpen(value.status))throw Error('新计划必须使用开放初态，终态需针对已有 ID 明确处置');
      if(same&&same.nextAt!==value.nextAt&&!p.businessAt&&!p.windowStart&&!p.windowEnd&&round.planId!==same.id)throw Error('计划业务窗口不明确，请用已有 ID 更新：'+same.id);
      value.budgetBucket=provedWorkSource(draft,value)?'work':'idle';
      operation=same?{op:'update',id:same.id,expectedRevision:same.revision,patch:value,evidenceIds,legacy:raw.legacy}:{op:'create',id,plan:value,evidenceIds,legacy:raw.legacy};
    }else if(op==='update'){
      const patch=Object.fromEntries([...fields,'progress'].filter(k=>p[k]!==undefined).map(k=>[k,p[k]]));
      for(const k of ['nextAt','expiresAt'])if(k in patch)patch[k]=timestamp(patch[k]);
      // Scheduling holds are repairable with this round's evidence. A business
      // block still needs its original explicit status transition.
      if(old.status==='blocked'&&old.scheduleIssue?.version===1&&patch.status===undefined&&evidenceIds.length&&['nextAt','waitCondition'].some(key=>key in patch)&&inspectPlanTrigger({...old,...patch,status:'pending'},draft,{now}).valid)patch.status='pending';
      for(const k of ['topic','subject','stage','businessAt','windowStart','windowEnd'])if(k in patch&&JSON.stringify(patch[k])!==JSON.stringify(old[k]))throw Error('计划身份字段不可变，请创建新阶段并明确替代');
      if(planTerminal(old.status)&&Object.entries(patch).some(([k,v])=>JSON.stringify(v)!==JSON.stringify(old[k])))throw Error('终态计划不能重新激活或改写');
      if(old.status==='needs_review'&&patch.status&&patch.status!=='needs_review'&&!(raw.reviewed===true&&round.kind==='owner'&&evidenceIds.length))throw Error('历史歧义计划需要主人明确核对');
      if(['blocked','waiting_event'].includes(old.status)&&['pending','active'].includes(patch.status)&&!evidenceIds.length)throw Error('解除阻塞或等待需要新证据');
      if(patch.status&&!planOpen(patch.status)&&!planTerminal(patch.status))throw Error('计划状态无效');
      if(['completed','expired'].includes(patch.status)&&!evidenceIds.length)throw Error('计划终态需要真实证据');
      operation={op,id:old.id,expectedRevision:old.revision,patch,evidenceIds,legacy:raw.legacy};
    }else{
      if(planTerminal(old.status)&&terminalOps[op]!==old.status)throw Error('终态计划不能改写');
      if(['complete','expire'].includes(op)&&!evidenceIds.length&&!(op==='expire'&&old.expiresAt&&now>=old.expiresAt))throw Error('计划终态需要真实证据或明确期限');
      if(op==='merge'){
        const target=draft.plans.find(p=>p.id===raw.targetId);
        if(!target||target.id===old.id||target.logicalKey!==old.logicalKey&&!equivalentPlans(old,target,draft,context))throw Error('仅允许归并同一逻辑事项');
        if(raw.targetExpectedRevision!==target.revision)throw Error('归并目标计划版本冲突');
      }
      if(op==='supersede'){const target=draft.plans.find(p=>p.id===raw.targetId);if(!target)throw Error('替代计划不存在');if(raw.targetExpectedRevision!==target.revision)throw Error('替代目标计划版本冲突');}
      operation={op,id:old.id,expectedRevision:old.revision,targetId:raw.targetId||null,targetExpectedRevision:raw.targetExpectedRevision,patch:{status:terminalOps[op],changeReason:norm(raw.reason||p.changeReason||'明确计划处置')},evidenceIds,legacy:raw.legacy};
    }
    applyPlanChanges(draft,[operation],{now,roundId:round.id,recordHistory:false});
    result.push(operation);
  }
  return result.map(operation=>{
    const issue=draft.plans.find(plan=>plan.id===operation.id)?.scheduleIssue;
    return issue?{...operation,scheduleIssue:structuredClone(issue)}:operation;
  });
}
export function applyPlanChanges(l,changes,options={}){
  const draft={plans:structuredClone(l.plans),queue:l.queue||[],journal:l.journal||[],planHistory:structuredClone(l.planHistory||[]),planProposals:structuredClone(l.planProposals||[])};
  applyPrepared(draft,changes,options);l.plans=draft.plans;l.planProposals=draft.planProposals;if(options.recordHistory!==false)l.planHistory=draft.planHistory;
}
function applyPrepared(l,changes,{now=Date.now(),roundId=null,recordHistory=true}={}){
  for(const change of changes||[]){
    if(change.op==='propose-refinement'){
      l.planProposals??=[];let row=l.planProposals.find(p=>p.id===change.id);
      if(!row){row={id:change.id,status:'blocked',noticeOnly:true,modelWake:false,candidateIds:change.candidateIds,reason:change.reason,firstSeenAt:now,submissions:[],repeatCount:0};l.planProposals.push(row);}
      if(!row.submissions.some(p=>JSON.stringify(p)===JSON.stringify(change.submission)))row.submissions.push(structuredClone(change.submission));
      row.lastSeenAt=now;row.repeatCount++;row.sourceEventIds=unique([...(row.sourceEventIds||[]),...change.sourceEventIds]);continue;
    }
    if(change.op==='existing'){if(!l.plans.some(p=>p.id===change.id&&p.revision===change.expectedRevision))throw Error('计划版本冲突');continue;}
    if(change.op==='create'){
      if(l.plans.some(p=>p.id===change.id||p.logicalKey===change.plan.logicalKey&&planOpen(p.status)))throw Error('计划身份在提交后发生变化');
      const created=structuredClone(change.plan);
      normalizePlanTriggers({plans:[created],queue:l.queue,journal:l.journal},{now,bumpRevision:false});
      l.plans.push(created);
      if(recordHistory)(l.planHistory??=[]).push({at:now,roundId,op:'create',id:change.id,toRevision:change.plan.revision,evidenceIds:change.evidenceIds});
      continue;
    }
    const p=l.plans.find(p=>p.id===change.id);
    if(!p||p.revision!==change.expectedRevision)throw Error('计划版本冲突：'+change.id);
    const before=structuredClone(p),patch=change.patch||{};
    if(change.targetId){const target=l.plans.find(x=>x.id===change.targetId);if(!target||target.revision!==change.targetExpectedRevision)throw Error('目标计划版本冲突');}
    for(const key of fields)if(key in patch)p[key]=structuredClone(patch[key]);
    if(change.evidenceIds?.length&&patch.progress!==undefined)p.progress=norm(patch.progress);
    if(change.targetId)p[change.op==='merge'?'mergedInto':'supersededBy']=change.targetId;
    if(change.op==='merge'){
      const target=l.plans.find(x=>x.id===change.targetId),previous=structuredClone(target);target.mergedFrom=unique([...(target.mergedFrom||[]),p.id]);target.revision++;target.updatedAt=now;
      if(recordHistory)(l.planHistory??=[]).push({at:now,roundId,op:'merge-target',id:target.id,fromRevision:previous.revision,toRevision:target.revision,before:previous,evidenceIds:change.evidenceIds});
    }
    if(change.op==='supersede'){
      const target=l.plans.find(x=>x.id===change.targetId),previous=structuredClone(target);target.supersedes=unique([...(target.supersedes||[]),p.id]);target.revision++;target.updatedAt=now;
      if(recordHistory)(l.planHistory??=[]).push({at:now,roundId,op:'supersede-target',id:target.id,fromRevision:previous.revision,toRevision:target.revision,before:previous,evidenceIds:change.evidenceIds});
    }
    normalizePlanTriggers({plans:[p],queue:l.queue,journal:l.journal},{now,bumpRevision:false});
    const changed=fields.some(k=>JSON.stringify(before[k])!==JSON.stringify(p[k]))||p.progress!==before.progress||JSON.stringify(p.scheduleIssue)!==JSON.stringify(before.scheduleIssue)||change.targetId;
    if(changed){
      p.revision++;p.updatedAt=now;p.sourceEvidenceIds=unique([...(p.sourceEvidenceIds||[]),...(change.evidenceIds||[])]);
      if(recordHistory)(l.planHistory??=[]).push({at:now,roundId,op:change.op,id:p.id,fromRevision:before.revision,toRevision:p.revision,before,patch:structuredClone(patch),submittedPlan:change.submittedPlan,semanticReason:change.semanticReason,evidenceIds:change.evidenceIds});
    }
  }
}
export function planEvidenceFingerprint(data,plan){
  const s=data.state||{},where=s.where||{},doing=s.doing;
  const events=(data.life?.queue||[]).filter(q=>(plan.sourceEventIds||[]).includes(q.id)||plan.waitCondition?.eventId===q.id||(q.relatedPlanIds||[]).includes(plan.id));
  return hash({where:{kind:where.kind,id:where.place?.id||where.area?.id||where.to?.id,arrive:where.arrive},doing,
    body:{ill:s.body?.ill},
    events:events.map(q=>[q.id,q.eventVersion||1,q.status])});
}
export function advancePlans(l,data,now){
  for(const p of l.plans){
    if(!planOpen(p.status)||p.status==='needs_review'||p.status==='blocked')continue;
    if(p.expiresAt&&now>=p.expiresAt){p.status='expired';p.revision++;p.updatedAt=now;continue;}
    if(p.status==='waiting_event'){
      const f=planEvidenceFingerprint(data,p),w=p.waitCondition||{};
      const event=w.kind==='event'&&(l.queue||[]).some(q=>matchesPlanEvent(p,q));
      const stage=w.kind==='time'&&w.at>0&&now>=w.at&&p.lastTimeWake!==w.at;
      const stateFresh=Number(data.at?.state)>=(p.lastCheckedAt||0)&&Number(data.at?.state)<=now&&now-Number(data.at?.state)<=180000;
      const busy=!!data.state?.doing||data.state?.where?.kind==='trip';
      if(w.kind==='state'&&w.when==='idle'&&stateFresh&&busy)p.waitObservedBusy=true;
      const afterReceipt=p.waitAfterReceiptAt>0&&Number(data.at?.state)>p.waitAfterReceiptAt;
      const stateReady=w.kind==='state'&&(w.when==='idle'?stateFresh&&!busy&&(afterReceipt||p.waitObservedBusy||f!==p.lastEvidenceFingerprint):f!==p.lastEvidenceFingerprint);
      if(event||stage||stateReady){
        p.status='pending';p.nextAt=now;p.revision++;p.updatedAt=now;p.lastWakeFingerprint=f;
        delete p.waitObservedBusy;delete p.waitAfterReceiptAt;
        if(stage)p.lastTimeWake=w.at;
      }
    }
  }
}
export function finishPlanCheck(l,data,round,{now=Date.now(),unchangedLimit=1}={}){
  if(!round.planId)return;
  const p=l.plans.find(p=>p.id===round.planId);if(!p||!planOpen(p.status)||['needs_review','blocked'].includes(p.status))return;
  const fingerprint=planEvidenceFingerprint(data,p),proof=proofOfPlanProgress(l,data,round,p,{now});
  p.lastCheckedAt=now;p.lastCheckedRevision=p.revision;p.lastEvidenceFingerprint=fingerprint;
  if(proof.progressed){
    const freshActions=proof.receiptIds.flatMap(id=>{const j=l.journal.find(j=>j.id===id);if(!j)return [];let args;try{args=JSON.parse(j.args);}catch{return [];}return [{tool:j.tool,args,finishedAt:j.finishedAt}];});
    const prior=p.lastProgressProof,executedStep=round.planNextStep??prior?.executedStep??p.nextStep;
    const actions=[...(prior?.executedStep===executedStep?prior?.actions||[]:[]),...freshActions].filter((action,index,all)=>all.findIndex(other=>other.tool===action.tool&&JSON.stringify(other.args)===JSON.stringify(action.args))===index);
    p.lastProgressAt=now;p.unchangedChecks=0;p.lastProgressProof={roundId:round.id,reason:proof.reason,receiptIds:proof.receiptIds,actions,executedStep};
    const activity=freshActions.some(action=>/^mcp__fish-world__world_(?:go|do)$/.test(action.tool));
    if(activity&&!(p.nextAt>now)){
      if(p.waitCondition?.kind==='time'&&p.waitCondition.at<=now)p.lastTimeWake=p.waitCondition.at;
      p.status='waiting_event';p.nextAt=0;p.waitCondition={kind:'state',when:'idle'};
      p.waitAfterReceiptAt=Math.max(0,...freshActions.map(a=>a.finishedAt||0));
      p.waitObservedBusy=!!data.state?.doing||data.state?.where?.kind==='trip';p.revision++;p.updatedAt=now;
    }
    return;
  }
  p.unchangedChecks=(p.unchangedChecks||0)+1;
  if(p.unchangedChecks>=unchangedLimit){
    const wait=nextPlanWait(p,l,now);
    if(p.waitCondition?.kind==='time'&&p.waitCondition.at<=now)p.lastTimeWake=p.waitCondition.at;
    if(wait){p.status='waiting_event';p.waitCondition=wait;}
    else {p.status='blocked';p.scheduleIssue={version:1,code:'trigger-needs-definition',at:now};}
    p.revision++;p.updatedAt=now;
  }
}
