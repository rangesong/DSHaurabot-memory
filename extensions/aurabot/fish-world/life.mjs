import {isExactFishIdentity} from './action-sequence.mjs';
import {rememberOwnerTurn,taskForExecution,ownerTaskGuard,noteOwnerTaskResult,advanceOwnerTasks,endOwnerTaskRound,worldToolName,reconcileOwnerTasks,defineOwnerTask,registerJourney} from './owner-tasks.mjs';
import {completedWindowRound,bindWindow,buildTaskPrompt} from './world-window.mjs';
import {advancePlans,preparePlanChanges,applyPlanChanges,finishPlanCheck,planEvidenceFingerprint} from './plans.mjs';
import {candidates,admission,reserveRound,effectiveNow,quotaAlert,closeOldAlerts,isQuotaDelivery,observeSatisfiedEvents,estimateTokens} from './governance.mjs';
import {beginCostRound,endCostRound,costSummary,settleMissingUsage} from './costs.mjs';
import {randomUUID} from 'node:crypto';
import {budget,defaults,synthetic,terminal,clean,timestamp,planOpen} from './state.mjs';
import {workHoursAllowed} from './work-hours.mjs';
import {previewShareEvidence,claimShareEvidence,reconcileShareEvidence} from './share-evidence.mjs';
import {planActivityGuard} from './plan-activity.mjs';
import {normalizePlanTriggers} from './plan-triggers.mjs';
import {sameSession,ownerTaskContext} from './session-identity.mjs';
import {recoverSessionAliasFailures} from './journey-recovery.mjs';

export const WORLD='mcp__fish-world__';
export const worldNames=['now','history','find','profile','go','do','say','friends','update','guide'].map(n=>WORLD+'world_'+n);
export const mutating=(name,args={})=>['go','do','say','update'].some(n=>name===WORLD+'world_'+n)||name===WORLD+'world_friends'&&args.action!=='list';
const localNames=new Set(['fish_life_intent','fish_life_finish','fish_life_history','fish_life_action','fish_life_task','fish_dialogue_history','fish_person_impression']);
const textOf=r=>(r?.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const fingerprint=(name,args)=>JSON.stringify([name,canonical(args)]);
const failureBackoffMs=[5,15,30,60].map(minutes=>minutes*60000);
const localFaultReason='系统故障与恢复核对仅保留本地记录，不向 QQ 分享';
const shareTtlMs=30*60000;
const sharingOffReason='分享关闭期间的生活消息仅保留本地，不补发';
const isDiagnosticDelivery=o=>!isQuotaDelivery(o)&&(o.localOnly===true||String(o.id||'').startsWith('fault-'));
const isUnsubmittedShare=o=>!isQuotaDelivery(o)&&!isDiagnosticDelivery(o)&&['pending','deferred','failed'].includes(o.state);
const validSharingPolicy=p=>p?.version===1&&typeof p.sharing==='boolean';
const effectiveSharing=(l,settingsSharing)=>Object.hasOwn(l.controls,'sharing')?!!l.controls.sharing:settingsSharing;
const shareTimeKnown=(o,now)=>Number.isFinite(o.at)&&o.at>0&&o.at<=now;
function suppressUnsubmitted(o,reason,now){
  o.suppressedFrom={state:o.state,reason:o.reason||''};o.suppressedAt=now;o.state='suppressed';o.reason=reason;
}
function suppressDiagnosticDelivery(o,now){
  if(!isDiagnosticDelivery(o)||!['pending','deferred','failed'].includes(o.state))return;
  suppressUnsubmitted(o,localFaultReason,now);
}
function reconcileSharingPolicy(l,settingsSharing,now){
  const initialized=validSharingPolicy(l.sharingPolicy);
  if(initialized&&typeof l.sharingPolicy.settingsSharing==='boolean'&&l.sharingPolicy.settingsSharing!==settingsSharing)delete l.controls.sharing;
  const sharing=effectiveSharing(l,settingsSharing),changed=initialized&&l.sharingPolicy.sharing!==sharing;
  if(!initialized)l.sharingPolicy={version:1,sharing,settingsSharing,initializedAt:now,changedAt:now};
  else {l.sharingPolicy.settingsSharing=settingsSharing;if(changed){l.sharingPolicy.sharing=sharing;l.sharingPolicy.changedAt=now;}}
  for(const o of l.outbox){
    if(!isUnsubmittedShare(o))continue;
    const reason=!initialized?'启用分享新鲜度保护前的积压仅保留本地，不补发':changed?'分享开关改变前的积压仅保留本地，不补发':!sharing?sharingOffReason:!shareTimeKnown(o,now)?'生活分享的原始时间无法确认，仅保留本地，不补发':now-o.at>=shareTtlMs?'生活分享已超过30分钟，仅保留本地，不补发':'';
    if(reason)suppressUnsubmitted(o,reason,now);
  }
}
function recoveryOnlyCheckedIdlePreparation(l,r,{failedId=l.failureBackoff?.lastRoundId,now}={}){
  if(!r.readOnly&&r.kind!=='recovery')return false;
  const failed=l.journal.find(j=>j.type==='round'&&j.id===failedId&&j.status==='uncertain'&&j.kind==='idle');
  if(!failed)return false;
  const started=l.scheduler?.starts?.find(row=>row.roundId===failed.id)?.at??l.costs?.rounds?.find(row=>row.roundId===failed.id)?.at;
  if(!Number.isFinite(now)||!Number.isFinite(started)||started<=0||!Number.isFinite(failed.at)||started>failed.at||failed.at>now)return false;
  if(l.journal.some(j=>j.tool&&mutating(j.tool,(()=>{try{return JSON.parse(j.args);}catch{return {};}})())&&(!Number.isFinite(j.at)||j.at>=started)))return false;
  const rows=l.journal.filter(j=>j.round===failed.id&&j.tool?.startsWith(WORLD));
  if(!rows.length||rows.some(j=>j.status!=='confirmed'||j.isError||mutating(j.tool,(()=>{try{return JSON.parse(j.args);}catch{return {};}})())))return false;
  return Object.values(failed.actionSequences||{}).every(sequence=>(sequence.calls||[]).every(call=>!mutating(call.tool)||call.status==='not-submitted'&&sequence.outcome?.notSubmitted===true&&call.guardRejection?.source==='local-engine.guard-rejection'));
}
function restoreIdlePreparationDeadline(l,cfg,now){
  if(l.round||l.externalPending||l.recovery||l.backoffUntil>now)return;
  const rounds=l.journal.filter(j=>j.type==='round'),recovered=rounds.at(-1),failed=rounds.at(-2),snapshot=l.contextWindow?.packet?.snapshot;
  if(recovered?.kind!=='recovery'||recovered.status!=='completed'||!failed||!snapshot||snapshot.currentRound?.id!==recovered.id||snapshot.revision!==l.revision||!l.owner||!l.persona||snapshot.identity?.owner!==l.owner||snapshot.identity?.persona!==l.persona)return;
  const started=l.scheduler?.starts?.find(row=>row.roundId===recovered.id)?.at,due=snapshot.nextIdle;
  const copiedTask=[...(l.ownerTasks||[]),...l.plans].find(task=>task.owner===l.owner&&task.persona===l.persona&&['pending','active','waiting_event'].includes(task.status)&&task.nextAt===l.nextIdle&&task.nextAt>now);
  if(!Number.isFinite(started)||!Number.isFinite(failed.at)||failed.at>started||!Number.isFinite(due)||due<=0||due>started||now<recovered.at||now-recovered.at>cfg.idleMs||l.nextIdle!==recovered.at+cfg.idleMs&&!copiedTask||l.nextIdle<=now)return;
  if(!recoveryOnlyCheckedIdlePreparation(l,{readOnly:true},{failedId:failed.id,now}))return;
  const previous=l.nextIdle;l.nextIdle=due;l.idlePreparationScheduleRepair={version:1,at:now,recoveryRoundId:recovered.id,failedRoundId:failed.id,previousNextIdle:previous,restoredNextIdle:due,...copiedTask?{copiedTaskId:copiedTask.id}:{},noWorldMutation:true};
}
export class LifeEngine {
  constructor({bridge,host,settings=()=>({}),authorized=()=>true,identity=()=>({}),clock=Date.now}){
    Object.assign(this,{bridge,host,settings,authorized,identity,clock});this.closed=false;this.lock=null;this.agent=null;this.deliveryBusy=false;this.alertVisits=new Map();
    this.ownerPromptTokens=new WeakMap();
    this.change(l=>{
      for(const p of l.plans){p.nextAt=timestamp(p.nextAt);p.trigger=/到|抵达/.test(p.trigger)?'arrive':/结束|完成/.test(p.trigger)?'done':p.trigger;}
      normalizePlanTriggers(l,{now:this.clock()});reconcileOwnerTasks(l,this.bridge.data,this.clock());recoverSessionAliasFailures(l,{now:this.clock()});
      if(l.journal.some(x=>x.status==='executing'))l.recovery=true;
      if(l.round){const reservation=l.scheduler?.reservations?.find(r=>r.roundId===l.round.id);if(reservation)reservation.status='uncertain';l.round.status='uncertain';l.round.stopReason='重启后先确认旧会话停止，再只读核对现场';l.recovery=true;}
      for(const q of l.queue)if(q.status==='running')q.status='uncertain';
      if(l.queue.some(q=>q.status==='uncertain'))l.recovery=true;
      restoreIdlePreparationDeadline(l,{...defaults,...this.settings(),...l.controls},this.clock());
      const recoveryIds=new Set(l.journal.filter(j=>j.type==='round'&&j.kind==='recovery').map(j=>j.id));
      for(const o of l.outbox){if(recoveryIds.has(o.id))o.localOnly=true;if(o.state==='sending')o.state='uncertain';suppressDiagnosticDelivery(o,this.clock());}
      reconcileSharingPolicy(l,!!({...defaults,...this.settings()}.sharing),this.clock());
      reconcileShareEvidence(l,{fishId:this.bridge.data.fishId,now:this.clock()});
    });
  }
  get l(){return this.bridge.data.life;}
  get cfg(){return {...defaults,...this.settings(),...this.l.controls};}
  change(fn){return this.bridge.change(d=>fn(d.life,d));}
  syncSharingPolicy(now=this.clock()){
    const settingsSharing=!!({...defaults,...this.settings()}.sharing),p=this.l.sharingPolicy;
    const settingsChanged=validSharingPolicy(p)&&typeof p.settingsSharing==='boolean'&&p.settingsSharing!==settingsSharing;
    const sharing=settingsChanged?settingsSharing:effectiveSharing(this.l,settingsSharing);
    if(!validSharingPolicy(p)||p.settingsSharing!==settingsSharing||p.sharing!==sharing||this.l.outbox.some(o=>isUnsubmittedShare(o)&&(!sharing||!shareTimeKnown(o,now)||now-o.at>=shareTtlMs)))this.change(l=>reconcileSharingPolicy(l,settingsSharing,now));
  }
  blocked(reason){if(this.l.blocked!==reason)this.change(l=>{l.blocked=reason;});}
  ownerTurn(text,info){
    const token=info.turnToken;let turnKey=typeof token==='string'||typeof token==='number'?token:undefined;
    if(token&&typeof token==='object'){if(!this.ownerPromptTokens.has(token))this.ownerPromptTokens.set(token,randomUUID());turnKey=this.ownerPromptTokens.get(token);}
    turnKey??=(info.archiveMessages||[]).map(m=>m.id).filter(Boolean).join(',')||Math.floor(this.clock()/1000);
    let task;this.change(l=>{task=rememberOwnerTurn(l,this.identity(),{text,sessionId:info.sessionId,turnKey,confirmedWorld:info.confirmedWorld===true},this.clock());
      if(task&&!task.optional){l.revision++;if(l.round){l.round.status='stopping';l.round.stopReason='主人有新的持久任务，先交接';}}});
    if(task&&!task.optional&&this.l.round)void this.host.cancel(this.l.round.sessionId).catch(()=>{});return task;
  }
  snapshot(){const l=structuredClone(this.l);for(const [key,visit]of this.alertVisits){const a=l.alerts?.find(a=>a.key===key);if(a){a.repeatCount+=visit.count;a.lastSeenAt=visit.lastSeenAt;}}return {...l,usage:budget(l,effectiveNow(l,this.clock())),costSummary:costSummary(l,this.clock()),settings:this.cfg,locked:!!this.lock};}
  control(action,text='',{sessionId}={}){
    if(action==='plan'&&(this.l.ownerTasks||[]).some(t=>t.status==='active'&&t.instruction===clean(text)))return;
    const changes={pauseIdle:{idleEnabled:false},pauseAuto:{autonomy:false},pauseShare:{sharing:false},observe:{observeOnly:true},stop:{stopped:true},resume:{stopped:false,autonomy:true,idleEnabled:true,observeOnly:false},share:{sharing:true}};
    if(!changes[action]&&!['plan','probe'].includes(action))throw Error('未知控制');
    this.change((l,d)=>{reconcileSharingPolicy(l,!!({...defaults,...this.settings()}.sharing),this.clock());Object.assign(l.controls,changes[action]||{});l.revision++;
      if(action==='probe'){if(l.round)throw Error('后台正在忙碌');l.recovery=true;l.verification=true;l.verificationInstruction=clean(text).slice(0,500);l.backoffUntil=0;}
      if(action==='plan'){
        const cancelDaily=/(?:取消|停止|不要|不用|不再|别).{0,20}(?:(?:每天|每晚|每日|23[:：]45).{0,12}(?:规划|计划|安排)|(?:规划|计划|安排).{0,12}(?:每天|每晚|每日|23[:：]45))/.test(text);
        const context=ownerTaskContext(l,sessionId),keptJourney=(l.ownerTasks||[]).find(t=>t.status==='active'&&t.kind==='journey'&&sameSession(t.journey?.registeredSessionId,sessionId)&&t.journey?.registeredTurnKey&&t.journey.registeredTurnKey===context?.key);
        for(const t of l.ownerTasks||[])if(t.status==='active'&&t.id!==keptJourney?.id&&(t.kind!=='planning'||cancelDaily)){t.status='cancelled';t.phase='cancelled';t.revision++;t.history.push({at:this.clock(),kind:'owner-changed-plan',instruction:clean(text)});}
        l.ownerInstructionRevision=(l.ownerInstructionRevision||0)+1;(l.ownerInstructions??=[]).push({text:clean(text).slice(0,2000),at:this.clock(),revision:l.ownerInstructionRevision});l.ownerInstructions=l.ownerInstructions.slice(-20);
        for(const p of l.plans)if(planOpen(p.status)){const before=structuredClone(p);p.status='cancelled';p.revision=(p.revision||0)+1;p.updatedAt=this.clock();p.changeReason='主人改变安排';(l.planHistory??=[]).push({at:this.clock(),op:'owner-superseded',id:p.id,before});}
        for(const q of l.queue)if(!terminal(q.status)&&q.bucket==='idle')q.status='cancelled';
        if(!keptJourney)synthetic(d,'owner',clean(text).slice(0,2000),this.clock());
      }
      if(l.round&&['stop','pauseAuto','observe','plan','pauseIdle'].includes(action)){l.round.status='stopping';l.round.stopReason='主人更新了控制或安排';}
      reconcileSharingPolicy(l,!!({...defaults,...this.settings()}.sharing),this.clock());
    });
    if(this.l.round?.status==='stopping')void this.host.cancel(this.l.round.sessionId).catch(()=>{});
  }
  journey(input,{sessionId,sourceKind='owner'}={}){
    const ownerTurnAt=ownerTaskContext(this.l,sessionId)?.at||0;
    let result;this.change(l=>{result=registerJourney(l,input,{sessionId,identity:this.identity(),now:this.clock(),data:this.bridge.data,sourceKind});
      if(sourceKind==='owner'&&ownerTurnAt>0)for(const event of l.queue)if(event.kind==='owner'&&event.provenance?.source==='owner-control'&&event.t>=ownerTurnAt&&event.t<=this.clock()&&['pending','blocked'].includes(event.status)){event.status='cancelled';event.changeReason='当前明确旅程任务已接管同轮安排，原指令保留';event.journeyTaskId=result.task.id;}
      if(!result.reused&&!result.task.optional&&l.round){l.revision++;l.round.status='stopping';l.round.stopReason='主人已登记新的出行目的，先交接当前后台回合';}
    });
    if(this.l.round?.status==='stopping')void this.host.cancel(this.l.round.sessionId).catch(()=>{});
    return result;
  }
  fault(key,message){
    if(key.startsWith('budget-'))return this.noteQuotaAlert(key.slice(7));
    const now=this.clock();this.change(l=>{
      if(now-(l.faults[key]||0)<1800000)return;
      l.faults[key]=now;l.outbox.push({id:'fault-'+randomUUID(),at:now,importance:'urgent',text:message,state:'suppressed',reason:localFaultReason,facts:[key],owner:l.owner,persona:l.persona});
    });
  }
  async tick(){
    if(this.ticking)return;this.ticking=true;
    try{return await this.tickOnce();}finally{this.ticking=false;}
  }
  async tickOnce(){
    if(this.closed||this.bridge.fatal||this.maintenanceBusy)return;
    const id=this.identity(),l=this.l,now=effectiveNow(l,this.clock());
    this.syncSharingPolicy(now);
    const c=this.cfg;
    if(l.owner&&l.owner!==id.owner||l.persona&&l.persona!==id.persona){
      this.blocked('主人或人格已改变，请重新核对身份后恢复');
      if(l.round){this.change(x=>{x.round.status='stopping';});await this.host.cancel(l.round.sessionId);}return;
    }
    if(!l.owner&&id.owner)this.change(x=>{x.owner=id.owner;x.persona=id.persona;});
    const pendingMemory=l.journal.find(x=>x.memory==='pending'&&(!x.memoryRetryAt||x.memoryRetryAt<=now));
    if(pendingMemory){this.change(()=>{pendingMemory.memoryRetryAt=now+300000;});void this.remember(pendingMemory.id);}
    if(l.externalPending&&!this.lock){
      if(await this.host.idle(l.externalPending.sessionId))this.change(x=>{x.externalPending=null;x.recovery=true;});
      else return this.blocked('重启前的 QQ 世界操作尚未结束');
    }
    if(l.round){
      if(l.round.status==='finished'){
        if(await this.host.idle(l.round.sessionId))this.end(true);
        return;
      }
      if(now-l.round.startedAt>=c.turnMs&&l.round.status==='running'){
        this.change(x=>{x.round.status='stopping';x.round.stopReason='执行超时，结果不确定';x.recovery=true;});
        await this.host.cancel(l.round.sessionId);this.fault('timeout','我刚才那一步等太久了，结果还没确认。我先停住，核对清楚再继续。');
      }
      if(['stopping','uncertain'].includes(l.round.status)){
        await this.host.cancel(l.round.sessionId);
        if(await this.host.idle(l.round.sessionId))this.end(false,'已确认旧会话停止；下轮仅核对现场');
      }
      return;
    }
    if(!this.authorized()||c.stopped)return this.blocked('自动流程已停止');
    if(!this.bridge.identityReady||now-(this.bridge.data.at.state||0)>180000)return this.blocked('等待有效世界身份和现状');
    if(!this.deliveryBusy)void this.deliver().catch(()=>{});
    if(!c.autonomy||c.observeOnly)return this.blocked(c.observeOnly?'只观察模式':'自动行动已暂停');
    if(now<l.backoffUntil)return;
    if(this.lock)return this.blocked('QQ 世界工具正在执行');
    if(this.deliveryBusy)return this.blocked('等待当前投递流程收尾');
    if(l.recovery&&l.sessionId){
      if(!await this.host.idle(l.sessionId))return this.blocked('恢复核对等待旧 Agent 与维护任务停止');
      if(!this.lock&&!l.externalPending)this.change(x=>{for(const j of x.journal)if(j.status==='executing'&&j.sessionId===x.sessionId){j.originalExecutionStatus='executing';j.status='uncertain';j.stopConfirmedAt=now;}});
    }
    this.change((life,data)=>{normalizePlanTriggers(life,{now});reconcileOwnerTasks(life,data,now);advancePlans(life,data,now);advanceOwnerTasks(life,data,now);observeSatisfiedEvents(life);closeOldAlerts(life,now);settleMissingUsage(life,now);});
    const choices=candidates(this.l,this.bridge.data,c,now);let chosen,decision,firstBlocked;
    for(const task of choices){
      if(task.ownerTaskId&&this.host.ready){const mission=this.l.ownerTasks.find(t=>t.id===task.ownerTaskId),source=mission?.currentSessionId||mission?.source?.sessionId;if(source&&!await this.host.ready(source)){firstBlocked??={reason:'等待主人当前世界回合收尾'};break;}}
      const check=admission(this.l,task,c,{now,costSummary:costSummary(this.l,now)});
      if(check.allowed){chosen=task;decision=check;break;}
      firstBlocked??=check;if(check.budgetExhausted)this.noteQuotaAlert(check.bucket);if(/工作时间/.test(check.reason))break;
    }
    if(!chosen){
      const denied=firstBlocked||{reason:'',nextAllowedAt:0};this.blocked(denied.reason);
      this.change(l=>{l.admission={reason:denied.reason,nextAllowedAt:denied.nextAllowedAt||0};});return;
    }
    const rawGroup=chosen.group?.length?chosen.group:[chosen];
    const group=(chosen.kind==='recovery'?[chosen,...(chosen.group||[])]:rawGroup).slice(0,8);
    const planIds=[...new Set([chosen.planId,...group.flatMap(q=>q.relatedPlanIds||[])].filter(Boolean))].filter(id=>this.l.plans.some(p=>p.id===id)).slice(0,12);
    const round={id:randomUUID(),sessionId:'',kind:chosen.kind,bucket:chosen.bucket,priority:chosen.priority,
      events:group.map(e=>e.id),sourceEventIds:[...new Set([...group.filter(e=>this.l.queue.some(q=>q.id===e.id)).map(e=>e.id),...(chosen.sourceEventIds||[])])],
      planId:chosen.planId||planIds[0]||null,planIds,ownerTaskId:chosen.ownerTaskId||null,planRevision:chosen.planRevision||null,reason:clean(chosen.plan?.goal||chosen.text).slice(0,1000),
      planNextStep:chosen.plan?.nextStep,
      startedAt:decision.now,status:'running',revision:this.l.revision,calls:0,receipts:[],observation:'',intent:null,report:null,readOnly:chosen.kind==='recovery',
      definitionOnly:chosen.definitionOnly===true,planningOnly:chosen.planningOnly===true,availabilityOnly:chosen.readOnly===true&&chosen.kind!=='recovery'};
    const prompt=this.prompt(group,round);
    let prepared;
    try{prepared=this.host.prepare?await this.host.prepare(prompt,round):{prompt,estimate:{roundPromptTokens:estimateTokens(prompt),requestTokens:estimateTokens(prompt)+16000,scope:'module-plus-unknown-wrapper-reserve'}};}
    catch(error){this.blocked('启动预检受阻：'+clean(error.message));return;}
    if(this.closed||this.lock||this.l.round||this.l.externalPending||this.l.revision!==round.revision)return;
    const check=admission(this.l,chosen,c,{now:this.clock(),estimate:prepared.estimate,costSummary:costSummary(this.l,this.clock())});
    if(!check.allowed){this.blocked(check.reason);this.change(l=>{l.admission={reason:check.reason,nextAllowedAt:check.nextAllowedAt||0,estimate:prepared.estimate};});return;}
    this.change(l=>{
      const reservation=reserveRound(l,chosen,c,{now:this.clock(),roundId:round.id,estimate:prepared.estimate,costSummary:costSummary(l,this.clock())});
      round.startedAt=reservation.allowed.now;round.windowId=prepared.windowKey||l.contextWindow?.key||null;round.estimate=prepared.estimate;
      if(round.kind==='plan-definition')for(const id of round.planIds){const p=l.plans.find(p=>p.id===id);if(p&&p.lastDefinitionRoundId!==round.id){p.definitionChecks=(p.definitionChecks||0)+1;p.lastDefinitionRoundId=round.id;p.nextDefinitionAt=round.startedAt+600000*2**p.definitionChecks;}}
      l.round=round;l.admission={reason:'',nextAllowedAt:round.startedAt+c.normalMinGapMs,estimate:prepared.estimate};
      for(const e of l.queue)if(round.events.includes(e.id)){if(chosen.kind!=='recovery')e.lastRoundId=round.id;e.status='running';}
      l.blocked='';beginCostRound(l,round);
      const row=l.scheduler.reservations.find(r=>r.roundId===round.id);row.status='submission-uncertain';
    });
    const roundId=round.id;
    void Promise.resolve().then(()=>this.host.run(prepared.prompt||prompt,prepared)).then(async()=>{
      if(this.l.round?.id!==roundId)return;
      if(await this.host.idle(this.l.round.sessionId))this.end(true);else this.change(l=>{if(l.round?.id===roundId)l.round.status='finished';});
    }).catch(async()=>{
      if(this.l.round?.id!==roundId)return;
      if(this.l.round.localCompletion){if(await this.host.idle(this.l.round.sessionId))this.end(true);else this.change(l=>{if(l.round?.id===roundId)l.round.status='finished';});return;}
      this.change(l=>{l.round.status='stopping';l.round.stopReason='宿主回合失败，等待旧 Agent 停止';l.backoffUntil=this.clock()+300000;l.recovery=true;});
      void this.host.cancel(this.l.round.sessionId).catch(()=>{});this.fault('host','世界通道刚才未确认完成，已停下核对。');
    });
  }
  noteQuotaAlert(bucket){
    const now=effectiveNow(this.l,this.clock()),day=new Date(now+28800000).toISOString().slice(0,10);
    const old=this.l.alerts?.find(a=>a.kind==='quota'&&a.day===day&&a.bucket===bucket&&a.status==='active');
    if(!old){this.change(l=>{quotaAlert(l,{fishId:this.bridge.data.fishId,bucket,now});});return;}
    const visit=this.alertVisits.get(old.key)||{count:0,lastSeenAt:old.lastSeenAt};visit.count++;visit.lastSeenAt=now;this.alertVisits.set(old.key,visit);
    if(now-old.lastSeenAt>=60000){this.change(l=>{quotaAlert(l,{fishId:this.bridge.data.fishId,bucket,now,repeat:visit.count});});this.alertVisits.delete(old.key);}
  }

  prompt(events,round=this.l.round){return [buildTaskPrompt(this,events,round,this.host.memory?.()||''),
    (this.l.ownerTasks||[]).some(task=>task.id===round?.ownerTaskId&&task.journey?.priorActions?.length)?'当前旅程的 journey.priorActions 是原私聊已成功提交动作的历史回执，保留原时间；不得重放、当成新事件分享或据此声称整件事已办完。若回执只是开始活动，按需只读查真实完成通知；保存并执行尚未完成的后续目的，保留原要求中的条件与自主决定。':'',
    '计划续行：说明文字 trigger 不会自动变成定时器。pending/active 必须登记明确 nextAt 或合法 waitCondition（time 的 at，event 的真实事件种类及对象，或 state 等待现场活动结束）；无法确定就保留待定义，不假装已经安排执行。自然精力/饥饿变化和只读查询不是任务进展。当前行程、班次或活动未真实结束时，普通日程等待对应通知；不因另一份日程重复出发、折返或打断。班内已有待办使用现场 task-*，不能用 work 重新上班代替。',
    round?.definitionOnly?(round.kind==='plan-definition'?'本轮只修复最多六条缺触发条件的旧计划：先按需查当前现场及原始历史，已完成或过时的事项用真实证据结清；仍有效才用 fish_life_finish planChanges.update 保存准确 nextAt/合法 waitCondition、status=pending、expectedRevision 与本轮 evidenceIds。不能把旧日程直接改成现在执行，不能重做历史动作，不能提交世界变更或向QQ补报历史。':'本轮只定义主人任务：先核对现场，再用 fish_life_task 保存完整后续步骤与准确时间，不能提交世界变更。原要求需未来执行时保存未来 nextAt，定义完成后正常结束，由后续到期回合执行。'):'',
    round?.planningOnly?'本轮完成本地每日规划义务：只查现场、用 fish_life_finish 创建或更新对应业务日期的可执行日程，明确 businessAt/windowStart/windowEnd、nextAt 或结构化等待条件。不能用世界动作冒充规划完成，不修改原分享证据要求，不补发旧日程。':'',
    round?.availabilityOnly?'本轮仅复查先前已明确满员的岗位：真实 world_now 核对可用位置，正常保存核对结果并结束；不在此轮重新接班。若已空位，程序会按原任务安排后续执行，未知旧动作仍不重做。':''].filter(Boolean).join('\n\n');}

  defineTask(input,{sessionId}={}){
    const r=this.l.round;if(!r||!sameSession(r.sessionId,sessionId)||r.status!=='running')throw Error('不是当前有效后台定义回合');
    if(this.lock)return {ok:false,retryable:true,message:'等待当前世界读取返回后再定义，不并发猜步骤。'};
    try{return this.change(l=>{const result=defineOwnerTask(l,input,{sessionId,background:true,taskId:l.round?.ownerTaskId,now:this.clock(),data:this.bridge.data});if(input.action==='complete_observation'&&result.task?.status==='completed'&&result.task?.journey?.observation)l.round.journeyObservationCompleted=true;return result;});}
    catch(error){
      if(!r.definitionOnly)throw error;
      const failures=(r.taskDefinitionErrors||0)+1,stop=error.wait===true||error.retryable===false||failures>=2;
      this.change(l=>{
        const current=l.round;current.taskDefinitionErrors=failures;
        if(stop){
          current.localCompletion={kind:'definition-held',reason:clean(error.message),at:this.clock()};
          current.report={summary:'主人任务定义暂存：'+clean(error.message)+'；原始要求保留，未提交世界变更。',events:l.queue.filter(q=>current.events.includes(q.id)).map(q=>({id:q.id,status:'blocked'})),planChanges:[],importance:'routine',facts:[],share:''};
          current.status='finished';
        }
      });
      if(stop)setTimeout(()=>{if(this.l.round?.id===r.id)void Promise.resolve().then(()=>this.host.cancel(sessionId)).catch(()=>{});},0);
      return {ok:false,retryable:!stop,waiting:stop,message:clean(error.message)+(stop?'；本轮已在本地正常收尾，不再尝试登记或重新接班，原要求等待真实选项。':'；仅允许再纠正一次准确参数，不换说法反复尝试。')};
    }
  }

  bind(sessionId,names){
    if(!worldNames.every(n=>names.includes(n)))throw Error('后台实际可见世界工具不完整');
    this.change(l=>{l.sessionId=sessionId;bindWindow(l,sessionId);l.toolNames=names.filter(n=>n.startsWith(WORLD));if(l.round)l.round.sessionId=sessionId;});
  }
  intent(input){
    input={...input,tool:worldToolName(input.tool)};
    const r=this.l.round;if(!r||r.status!=='running'||!r.observation)throw Error('先取得本轮 world_now 真实回执');
    if(!r.identityConfirmed)throw Error('先调用 world_profile({}) 核对本鱼身份，再登记意图；也可使用 fish_life_action 自动完成前置步骤');
    let args;try{args=JSON.parse(input.arguments);}catch{throw Error('arguments 需要完整 JSON 对象');}
    if(!mutating(input.tool,args))throw Error('不是世界变更工具');
    const cost=Number(input.cost),category=input.category,c=this.cfg;
    if(!Number.isFinite(cost)||cost<0||cost>c.singleSpend||budget(this.l,this.clock()).spend+cost>c.dailySpend)throw Error('消费预算不足');
    if((category==='stocks'&&!c.stocks)||(category==='gift'&&!c.gifts))throw Error('该自主范围尚未启用');
    if(!['daily','work','social','stocks','gift'].includes(category))throw Error('需要明确行动类别');
    if(category==='work'&&(this.l.ownerInstructions||[]).some(x=>/今天(?:别|不要)打工/.test(x.text)&&new Date(x.at+28800000).toISOString().slice(0,10)===new Date(this.clock()+28800000).toISOString().slice(0,10)))throw Error('主人今天要求不打工');
    if(!input.evidence||!r.receipts.some(x=>!x.isError&&x.text.includes(input.evidence)))throw Error('依据必须逐字来自本轮真实工具回执');
    if(cost>0&&!new RegExp('(?:'+cost+'\\s*贝|'+cost+'\\s*[/／])').test(input.evidence))throw Error('消费依据中需要现场价格');
    const action=JSON.stringify(args);
    if(!c.stocks&&/股票|证券|买入|卖出|stock|trade/i.test(action))throw Error('自主证券交易未开启');
    if(!c.gifts&&/赠送|送礼|赠礼|gift/i.test(action))throw Error('自主赠礼未开启');
    if(!c.gifts&&(args.give||args.treat||args.price))throw Error('贵重赠礼、请客或定价交易需要单独开启');
    if(input.tool===WORLD+'world_update'&&Object.keys(args).some(k=>k!=='outfit'))throw Error('自主更新仅允许换已有衣服，不能改世界身份和外貌');
    if(input.tool===WORLD+'world_do'&&args.id){
      if(!input.evidence.includes(args.id))throw Error('行动依据必须包含现场完整 id');
      const price=/(\d+(?:\.\d+)?)\s*贝/.exec(input.evidence);
      if(price&&!/报酬|工资|奖励|赚|收入|扣/.test(input.evidence)&&cost<Number(price[1])*(args.count||1))throw Error('声明消费低于现场单价和数量');
    }
    if(input.tool===WORLD+'world_go'&&args.by&&args.by!=='walk'&&args.by!=='bike'&&cost<=0)throw Error('付费交通需要先取得票价并预留消费');
    if(['go','do','say'].some(n=>input.tool===WORLD+'world_'+n))args.request_id??=r.id+':'+r.calls;
    this.change(l=>{l.round.intent={key:fingerprint(input.tool,args),cost,category,evidence:clean(input.evidence)};});
    return {ok:true,arguments:args,message:'意图已核对；请使用以下完整参数（含防重复 request_id）调用 '+input.tool+'：'+JSON.stringify(args)};
  }
  guard(exec,isBackground,isOwner){
    const name=exec.name,world=name.startsWith(WORLD),r=this.l.round,now=this.clock();
    if(isBackground&&!world&&!localNames.has(name)&&name!=='run_code')return '世界后台仅允许世界、计划和汇报能力';
    if(!world)return;
    if(!isBackground&&!isOwner)return;
    if(this.closed||this.maintenanceBusy||this.bridge.fatal||!this.authorized())return '世界模块已停止或状态不可写';
    const deferred=!isBackground&&isOwner&&mutating(name,exec.arguments)&&ownerTaskContext(this.l,exec.agent?.session?.id)?.deferred;
    if(deferred)this.ownerTurn(deferred.text,{sessionId:exec.agent.session.id,turnToken:deferred.turnKey,confirmedWorld:true});
    const taskDenied=ownerTaskGuard(this.l,this.bridge.data,exec,isBackground,now);if(taskDenied)return taskDenied;
    if(!isBackground&&isOwner&&name===WORLD+'world_go'&&!taskForExecution(this.l,exec))return '这次出发尚未绑定要办的事；先用 fish_life_journey 登记 goal、真实 destination 和 arrivalStep，再按原工具出发。到了只算走完路，后续目的仍保留；不要重复提交出发。';
    if(isBackground){
      if(!r||!sameSession(r.sessionId,exec.agent?.session?.id)||r.status!=='running'||r.revision!==this.l.revision||this.cfg.stopped||!this.cfg.autonomy||this.cfg.observeOnly)return '本轮已停止、会话不匹配或主人改变安排';
      if(mutating(name,exec.arguments)&&(r.definitionOnly||r.planningOnly||r.availabilityOnly))return '本轮只核对空位、登记任务时间步骤或本地日程，不提交世界变更；原有未知结果和分享证据规则保持有效';
      const activityDenied=planActivityGuard(this.bridge.data,r,name,exec.arguments,now);if(activityDenied)return activityDenied;
      if(r.calls>=this.cfg.maxCalls||now-r.startedAt>=this.cfg.turnMs)return '达到本轮调用/时间上限';
      if(mutating(name,exec.arguments)){
        if(r.readOnly||!r.observation)return '必须先真实观察；恢复回合禁止变更';
        if(!r.identityConfirmed)return '优先用 fish_life_action 自动补齐本轮 world_profile({})，确认 MCP 和观看接口属于同一只鱼';
        if(this.l.queue.some(q=>q.priority<r.priority&&q.status==='pending'&&q.t>r.startedAt))return '出现更高优先级待办，停止本轮追加行动';
        if(r.intent?.key!==fingerprint(name,exec.arguments))return '请优先用 fish_life_action 核对并执行；当前通道未提供它时，才用 fish_life_intent 声明本次完整行动和预算';
      }
    }else if(mutating(name,exec.arguments)&&r){
      this.change(l=>{l.revision++;l.round.status='stopping';l.round.stopReason='主人 QQ 世界行动优先';l.recovery=true;});
      void this.host.cancel(r.sessionId).catch(()=>{});return '后台正在收尾；请等待停止后再次执行世界行动';
    }
    if(this.lock||this.l.externalPending)return '另一个世界工具仍在执行，请等待回执';
    this.change(l=>{if(isBackground){l.round.calls++;budget(l,now).calls++;if(mutating(name,exec.arguments)){budget(l,now).spend+=l.round.intent.cost;l.round.intent=null;}}
      l.journal.push({id:exec.callId,at:now,sessionId:exec.agent?.session?.id,round:isBackground?r.id:null,ownerTaskId:taskForExecution(l,exec)?.id||null,tool:name,args:clean(JSON.stringify(exec.arguments)),status:'executing'});l.lastToolAt=now;
      if(!isBackground)l.externalPending={callId:exec.callId,sessionId:exec.agent?.session?.id};});
    this.lock={callId:exec.callId,sessionId:exec.agent?.session?.id};
  }
  result(exec,result){
    if(!this.lock&&this.l.externalPending?.callId===exec.callId)this.lock=this.l.externalPending;
    if(!exec.name.startsWith(WORLD)||!this.lock||this.lock.callId!==exec.callId)return;
    const text=clean(textOf(result)),isError=!!result.isError||result.value?.ok===false||/\[E_[A-Z_]+\]/.test(text);
    const uncertain=isError&&/timeout|timed out|超时|abort|ECONNRESET|断线|not connected/i.test(text);
    this.change(l=>{
      const entry=l.journal.find(x=>x.id===exec.callId);if(entry){Object.assign(entry,{status:uncertain?'uncertain':isError?'failed':'confirmed',isError,result:text,finishedAt:this.clock()});noteOwnerTaskResult(l,this.bridge.data,entry,this.clock());}
      const r=l.round;if(r&&sameSession(exec.agent?.session?.id,r.sessionId)){r.receipts.push({id:exec.callId,tool:exec.name,text,isError});if(exec.name===WORLD+'world_now'&&!isError){r.observation=text;r.observationId=exec.callId;r.intent=null;}
        if(exec.name===WORLD+'world_profile'&&!exec.arguments?.fish&&!isError)r.identityConfirmed=!!r.observation&&isExactFishIdentity(text,this.bridge.data.fishId);}
      if(r&&uncertain){r.status='stopping';r.stopReason='世界调用结果不确定，先停止并核对';l.recovery=true;}
      if(l.externalPending?.callId===exec.callId)l.externalPending=null;
    });this.lock=null;
    if(uncertain)void this.host.cancel(this.l.round?.sessionId).catch(()=>{});
  }
  workRecovery(q,r){
    if(!r.readOnly)return null;
    const calls=this.l.journal.filter(j=>j.round===q.lastRoundId);
    const action=calls.findLast(j=>j.tool===WORLD+'world_do'&&['confirmed','uncertain'].includes(j.status));
    if(!action)return null;
    if(action.status==='confirmed')return {eventId:q.id,callId:action.id,source:'success-receipt'};
    const task=JSON.parse(action.args||'{}').id;if(!/^task-\d+$/.test(task||''))return null;
    const before=calls.findLast(j=>j.tool===WORLD+'world_now'&&j.status==='confirmed'&&j.at<=action.at);
    const choice=before?.result.split('\n').map(line=>/^·\s+(task-\d+)\s+(.+)$/.exec(line)).find(m=>m?.[1]===task)?.[2];
    if(!choice)return null;
    const done=this.l.queue.find(e=>e.kind==='done'&&e.t>=action.at&&e.t<=action.at+600000&&[choice+'：',choice+':'].some(prefix=>e.text.startsWith(prefix)));
    const now=r.receipts.findLast(j=>j.tool===WORLD+'world_now'&&!j.isError);
    const progress=text=>/(^[^\n]*下班；)处理了\s*(\d+)\s*件活，没顾上\s*(\d+)\s*件/m.exec(text||'');
    const old=progress(before?.result),current=progress(now?.text);
    if(!done||!old||!current||old[1]!==current[1]||Number(current[2])!==Number(old[2])+1||old[3]!==current[3])return null;
    return {eventId:q.id,callId:action.id,source:'done-and-readonly-progress',doneId:done.id,doneAt:done.t,observationId:now.id,at:this.clock()};
  }
  finish(input){
    const r=this.l.round;if(!r||r.status!=='running'||!r.observation)throw Error('缺少本轮真实观察');
    if(this.lock)throw Error('仍有世界调用未返回');
    const required=this.l.queue.filter(q=>r.events.includes(q.id)).map(q=>q.id);
    if(required.some(id=>!(input.events||[]).some(e=>e.id===id&&['completed','expired','blocked'].includes(e.status))))throw Error('请为本轮全部待办填写真实状态，缺少：'+required.filter(id=>!input.events?.some(e=>e.id===id)).join(','));
    const completedWork=this.l.queue.filter(q=>q.kind==='work'&&(input.events||[]).some(e=>e.id===q.id&&e.status==='completed'));
    const reconciliations=completedWork.map(q=>this.workRecovery(q,r)).filter(Boolean);
    if(completedWork.some(q=>!reconciliations.some(x=>x.eventId===q.id))&&!r.receipts.some(x=>x.tool===WORLD+'world_do'&&!x.isError))throw Error('工作标记完成需要 world_do 成功回执；过期或受阻请如实标记');
    if(input.importance!=='routine'&&!input.facts?.length)throw Error('重要分享需要真实回执编号');
    const facts=(input.facts||[]).map(id=>r.receipts.findLast(x=>(x.id===id||x.tool===id)&&!x.isError)?.id);
    if(facts.some(id=>!id))throw Error('分享依据不属于本轮成功回执；facts 只填下列精确 id 或完整 tool，不附说明：'+JSON.stringify(r.receipts.filter(x=>!x.isError).map(({id,tool})=>({id,tool}))));
    const operations=preparePlanChanges(this.l,input,{round:r,now:this.clock(),fishId:this.bridge.data.fishId});
    const report={...input,reconciliations,facts,summary:clean(input.summary).slice(0,2000),share:clean(input.share).slice(0,1000),planChanges:operations};
    const sharing=previewShareEvidence(this.l,{fishId:this.bridge.data.fishId,round:r,report,now:this.clock()});
    this.change(l=>{l.round.report=report;});
    return {ok:true,preparedPlans:operations.map(op=>({op:op.op,id:op.id,revision:op.plan?.revision??op.expectedRevision,candidateIds:op.candidateIds,
      status:op.op==='propose-refinement'?'blocked-local':op.scheduleIssue?'blocked':op.plan?.status??op.patch?.status,scheduleIssue:op.scheduleIssue??op.plan?.scheduleIssue??op.patch?.scheduleIssue})),sharing,message:'回合报告已准备，结束本轮后原子提交；沿用以上程序计划 ID。计划若为 blocked 且有 scheduleIssue，表示尚未登记可执行条件，可在本轮修正准确时间或事件；不得为此重做世界动作。分享未准入只保留本地，不必为此重试。QQ 投递独立核对。'};
  }
  end(completed,error=''){
    if(!this.l.round)return;
    const r=this.l.round,valid=completed&&['running','finished'].includes(r.status)&&r.report&&r.observation&&!this.lock,now=this.clock();
    this.change(l=>{
      reconcileSharingPolicy(l,!!({...defaults,...this.settings()}.sharing),now);
      const report=r.report;let sharingEvidence;
      for(const e of l.queue)if(r.events.includes(e.id)){
        const disposition=report?.events?.find(x=>x.id===e.id)?.status;
        e.status=valid&&['completed','expired','blocked'].includes(disposition)?disposition:'uncertain';
        if(e.status==='blocked')e.notBefore=now+300000;
        e.result=valid?report.summary:error||r.stopReason||'缺少完整回合报告';
        if(valid){const proof=report.reconciliations?.find(x=>x.eventId===e.id);if(proof)e.reconciliation=proof;}
        if(r.bucket==='social')l.cooldowns[e.sender]=now+this.cfg.socialMs;
      }
      if(valid){
        applyPlanChanges(l,report.planChanges,{now,roundId:r.id});
        endOwnerTaskRound(l,r,valid,now);
        if(r.kind!=='plan-definition')for(const id of r.planIds||[r.planId])finishPlanCheck(l,this.bridge.data,{...r,planId:id},{now,unchangedLimit:this.cfg.unchangedPlanRoundLimit});
        for(const p of l.plans.filter(p=>(r.planIds||[]).includes(p.id)||p.sourceEvidenceIds?.some(id=>r.receipts.some(x=>x.id===id)))){
          const success=r.receipts.filter(x=>!x.isError&&mutating(x.tool));
          if(success.length&&(p.trigger==='arrive'||p.trigger==='done'))(p.satisfiedStages??=[]).push({kind:p.trigger,at:now,expectedAt:p.nextAt||0,roundId:r.id,receiptIds:success.map(x=>x.id)});
        }
        // A proved read-only preparation failure has not completed self-care.
        // Preserve normal timing when any mutation or unknown dispatch may exist.
        if(!r.definitionOnly&&!r.planningOnly&&!r.availabilityOnly&&!recoveryOnlyCheckedIdlePreparation(l,r,{now}))l.nextIdle=r.kind==='idle'&&!r.readOnly?Math.max(now+this.cfg.idleMs,timestamp(report.nextAt)||now+this.cfg.idleMs):now+this.cfg.idleMs;
        if(r.readOnly){l.recovery=false;l.verification=false;}
        const localOnly=r.readOnly||r.kind==='recovery'||r.definitionOnly&&!r.journeyObservationCompleted||r.planningOnly||r.availabilityOnly,sharing=l.sharingPolicy.sharing;
        if(report.share&&(localOnly||!sharing||['urgent','important'].includes(report.importance))){
          const options={fishId:this.bridge.data.fishId,round:r,report,now};
          sharingEvidence=localOnly||!sharing?previewShareEvidence(l,options):claimShareEvidence(l,options);
          const reason=localOnly?localFaultReason:!sharing?sharingOffReason:!sharingEvidence.allowed?sharingEvidence.reason:'';
          l.outbox.push({id:r.id,at:now,importance:report.importance,text:report.share,facts:report.facts,state:reason?'suppressed':'pending',owner:l.owner,persona:l.persona,evidenceVersion:1,keys:sharingEvidence.keys,sourceRefs:sharingEvidence.sourceRefs,shareFacts:sharingEvidence.shareFacts,shareEventIds:sharingEvidence.shareEventIds,...(localOnly||!sharingEvidence.allowed?{localOnly:true}:{}),...(reason?{reason}:{})});
        }
        l.failureBackoff={streak:0,lastRoundId:r.id,at:now,delayMs:0};l.backoffUntil=0;
      }else {
        endOwnerTaskRound(l,r,false,now);
        const prior=l.failureBackoff?.streak,streak=Math.min(Number.MAX_SAFE_INTEGER,(Number.isSafeInteger(prior)&&prior>0?prior:0)+1);
        const delayMs=failureBackoffMs[Math.min(streak-1,failureBackoffMs.length-1)];
        l.failureBackoff={streak,lastRoundId:r.id,at:now,delayMs};l.recovery=true;l.backoffUntil=now+delayMs;
      }
      if(valid)completedWindowRound(l,r);
      l.journal.push({id:r.id,at:now,type:'round',kind:r.kind,status:valid?'completed':'uncertain',summary:report?.summary||error,receipts:r.receipts.map(x=>x.id),sourceEventIds:[...(r.events||[]).filter(id=>l.queue.some(q=>q.id===id))],...(sharingEvidence?{shareEvidence:{version:1,allowed:sharingEvidence.allowed,reason:sharingEvidence.reason,keys:sharingEvidence.keys,sourceRefs:sharingEvidence.sourceRefs}}:{}),actionSequences:structuredClone(r.actionSequences||{}),memory:valid&&report.importance!=='routine'?'pending':'none'});
      endCostRound(l,{...r,finishedAt:now},valid);
      const reservation=l.scheduler?.reservations.find(x=>x.roundId===r.id);if(reservation)reservation.status=valid?'completed':'uncertain';
      l.round=null;
    });
    // A derived local people index cannot change the completed life/share outcome.
    if(valid)try{this.host.recordPeople?.(r);}catch{}
    if(valid&&r.report.importance!=='routine')void this.remember(r.id);
  }
  async remember(id){
    const row=this.l.journal.find(x=>x.id===id);if(!row||row.memory!=='pending')return;
    try{const receipt=await this.host.remember({text:'【鱼的世界自身经历；非主人原话】'+row.summary+'；事实回执：'+row.receipts.join(',')+'；QQ 是否送达另见投递记录。',saidAt:row.at,importance:.7,tags:['fish-world'],meta:{id}});
      const recorded=!!receipt&&receipt.ok!==false&&!receipt.error&&!receipt.isError&&receipt.debug!==true;
      this.change(l=>{l.journal.find(x=>x.id===id).memory=recorded?'recorded':'pending';});
    }catch{this.blocked('重要记忆等待 Thinkstar 正式入口恢复');}
  }
  async deliver(){
    if(this.closed||this.deliveryBusy)return;this.deliveryBusy=true;
    try{
      const now=this.clock();
      if(!this.authorized()||this.cfg.stopped)return;
      this.syncSharingPolicy(now);
      const c=this.cfg;
      const o=this.l.outbox.filter(x=>!isQuotaDelivery(x)&&!isDiagnosticDelivery(x)&&(x.state==='queued'||['pending','deferred','failed'].includes(x.state)&&(!x.retryAt||x.retryAt<=now))).sort((a,b)=>(a.importance==='urgent'?0:1)-(b.importance==='urgent'?0:1)||a.at-b.at)[0]
        ||this.l.outbox.find(x=>isDiagnosticDelivery(x)&&x.state==='queued');if(!o)return;
      if(o.owner!==this.identity().owner||o.persona!==this.identity().persona)return;
      if(o.state==='queued'){
        const r=await this.host.deliveryStatus(o.deliveryId);if(r)this.change(l=>{o.state=this.deliveryState(r);suppressDiagnosticDelivery(o,this.clock());if(isUnsubmittedShare(o))suppressUnsubmitted(o,'原分享已提交，仅核对原回执，不重新提交',this.clock());reconcileSharingPolicy(l,!!({...defaults,...this.settings()}.sharing),this.clock());});return;
      }
      const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hour12:false}).format(now));
      const quiet=c.quietStart>c.quietEnd?hour>=c.quietStart||hour<c.quietEnd:hour>=c.quietStart&&hour<c.quietEnd;
      if(!c.sharing||o.importance!=='urgent'&&(quiet||budget(this.l,now).share>=c.shareLimit)){
        if(o.state!=='deferred')this.change(()=>{o.state='deferred';o.reason=!c.sharing?'分享已暂停':quiet?'免打扰':'今日分享额度已用完';});return;
      }
      this.change((l,d)=>reconcileShareEvidence(l,{fishId:d.fishId,now}));
      if(!isUnsubmittedShare(o)||isDiagnosticDelivery(o))return;
      this.change(l=>{o.state='sending';o.attempts=(o.attempts||0)+1;if(o.importance!=='urgent')budget(l,now).share++;});
      try{
        const r=await this.host.send(o);
        this.change(()=>{o.state=this.deliveryState(r);o.receipt=r?.message_id||r?.message_ids?.at(-1)||null;o.receipts=r?.message_ids||[];o.deliveryId=r?.deliveryId||null;o.reason=r?.reason||'';o.retryAt=now+1800000;if(o.state==='failed'&&o.attempts>=3)o.state='suppressed';});
      }catch{this.change(()=>{o.state='uncertain';o.reason='宿主发送抛错，不能确认送达；不自动重发';});}
    }finally{this.deliveryBusy=false;}
  }
  deliveryState(r){return r?.message_id!==undefined||r?.state==='sent'?'sent':r?.queued||['pending','sending','queued'].includes(r?.state)?'queued':['defer','dropped','suppressed'].includes(r?.state)?'deferred':r===null?'suppressed':r?.state==='failed'?'failed':'uncertain';}
  async dispose(){this.closed=true;if(this.l.round){this.change(l=>{l.round.status='stopping';l.round.stopReason='模块卸载或重载';l.recovery=true;});await this.host.cancel(this.l.round.sessionId);}}
}
