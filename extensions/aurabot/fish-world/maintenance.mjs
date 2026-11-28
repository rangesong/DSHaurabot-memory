import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {prepareHistoryReview,applyHistoryReview,historyReviewHash} from './history-review.mjs';
import {equivalentPlans,refinementPatch} from './plan-semantics.mjs';
import {applyPlanChanges,finishPlanCheck} from './plans.mjs';
import {dayKey,timestamp} from './state.mjs';
import {sameSession} from './session-identity.mjs';
const PROTOCOL='fish-world-maintenance/v1',clone=value=>structuredClone(value),bytes=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const sha=value=>createHash('sha256').update(value).digest('hex'),need=(value,message)=>{if(!value)throw Error(message);};
const TIMING_KEYS=['workMs','planRecheckMinMs','socialMs','idleMs'];
function safe(root,...parts){
 root=path.resolve(root);const target=path.resolve(root,...parts),rel=path.relative(root,target);need(!rel.startsWith('..')&&!path.isAbsolute(rel),'维护路径超出鱼世界目录');
 for(let p=target;;p=path.dirname(p)){if(fs.existsSync(p)){need(!fs.lstatSync(p).isSymbolicLink(),'维护路径不能是符号链接或目录重定向');need(fs.realpathSync(p).toLowerCase()===p.toLowerCase(),'维护路径重定向');}if(p===root)break;}return target;
}
function preserve(file,data){if(fs.existsSync(file)){need(sha(fs.readFileSync(file))===sha(data),'已有维护证据哈希冲突');return;}fs.writeFileSync(file,data,{flag:'wx',mode:0o600});}
function atomic(file,value){const tmp=file+'.tmp';if(fs.existsSync(tmp))need(!fs.lstatSync(tmp).isSymbolicLink(),'维护临时文件不能是链接');fs.writeFileSync(tmp,bytes(value),{mode:0o600});fs.renameSync(tmp,file);}
function available(engine){need(engine&&!engine.closed&&!engine.bridge.fatal,'鱼世界当前不可维护');need(!engine.l.round&&!engine.lock&&!engine.l.externalPending&&!engine.deliveryBusy,'请等待当前回合、工具及投递完全结束');}
const RECHECK='fish-world-plan-recheck/v1';
const mutation=row=>{let args;try{args=typeof row.args==='string'?JSON.parse(row.args):row.args;}catch{}return /^mcp__fish-world__world_(?:go|do|say|update)$/.test(row.tool||'')||row.tool==='mcp__fish-world__world_friends'&&args?.action!=='list';};
/** Undo only the latest proved local price-preparation deferral. No action or completion is inferred. */
export function recheckLife(l,input,{now=Date.now()}={}){
 need(input&&Object.keys(input).length===3&&['planId','expectedRevision','failedRoundId'].every(k=>Object.hasOwn(input,k))&&['planId','failedRoundId'].every(k=>typeof input[k]==='string'&&input[k].length>0&&input[k].length<=200)&&Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>0&&Number.isFinite(now),'复核需要精确计划、版本与原失败回合');
 const operationId='maintenance-'+sha(JSON.stringify([RECHECK,l.owner,l.persona,input.planId,input.expectedRevision,input.failedRoundId])).slice(0,24),prior=(l.maintenanceOperations||[]).find(row=>row.operationId===operationId);
 if(prior)return {repeated:true,operationId,planId:input.planId,revision:prior.toRevision,nextAt:prior.nextAt};
 const p=l.plans.find(p=>p.id===input.planId),r=l.journal.find(row=>row.id===input.failedRoundId&&row.type==='round'),cost=l.costs?.rounds?.find(row=>row.roundId===input.failedRoundId),h=l.planHistory?.findLast(row=>row.id===input.planId);
 need(l.owner&&l.persona&&p?.owner===l.owner&&p.persona===l.persona&&(['pending','active'].includes(p.status)||p.status==='waiting_event'&&p.waitCondition?.kind==='time')&&p.revision===input.expectedRevision,'计划身份、状态或版本已变化');
 need(r?.kind==='plan'&&r.status==='completed'&&cost?.triggerKind==='plan'&&cost.status==='completed'&&cost.planId===p.id&&Number.isFinite(cost.at)&&Number.isFinite(cost.finishedAt)&&cost.finishedAt>=cost.at&&cost.finishedAt<=now&&dayKey(cost.at)===dayKey(now)&&now-cost.at<=21600000&&r.at>=cost.at&&r.at<=now,'缺少近期同日普通计划回合的完整来源');
 const closedRevision=Number.isSafeInteger(h?.toRevision)&&p.revision===h.toRevision+1&&h.at===cost.finishedAt&&p.lastCheckedAt===cost.finishedAt&&p.lastCheckedRevision===h.toRevision&&p.updatedAt===cost.finishedAt;
 need(h?.op==='update'&&h.roundId===r.id&&(h.toRevision===p.revision||closedRevision)&&h.fromRevision===h.before?.revision&&h.at>=cost.at&&h.at<=cost.finishedAt&&h.before.nextAt>0&&h.before.nextAt<=cost.at&&p.nextAt>now&&p.nextAt>h.before.nextAt,'最新延期不再对应这次已到期的失败回合');
 need(!(l.ownerInstructions||[]).some(row=>!Number.isFinite(row.at)||row.at>cost.at),'失败后主人已更改安排，不能撤销新要求');
 for(const plan of [h.before,p])for(const key of ['businessAt','windowStart'])if(plan[key]!==undefined&&plan[key]!==null&&plan[key]!==''&&plan[key]!==0)need(timestamp(plan[key])>0&&timestamp(plan[key])<=cost.at,'原业务日期或执行窗口在未来，不能提前');
 need([h.before,p].every(plan=>!plan.waitCondition||plan.waitCondition.kind==='time'&&timestamp(plan.waitCondition.at)>0),'不是单纯时刻等待，不能强制改期');
 const windows=(l.contextWindow?.windows||[]).filter(w=>w.key===cost.windowId&&w.sessionId),tools=l.journal.filter(row=>row.round===r.id&&row.tool),scoped=row=>(row.owner===undefined||row.owner===l.owner)&&(row.persona===undefined||row.persona===l.persona);
 need(windows.length&&tools.length&&tools.every(row=>row.status==='confirmed'&&!row.isError&&scoped(row)&&windows.some(w=>sameSession(w.sessionId,row.sessionId))&&Number.isFinite(row.at)&&row.at>=cost.at&&Number.isFinite(row.finishedAt)&&row.finishedAt>=row.at&&row.finishedAt<=cost.finishedAt),'失败回合不属于当前身份的成功只读世界窗口');
 const sequences=Object.values(r.actionSequences||{}),price=o=>o?.code!=='purchase-cost-understated'&&(['声明消费低于现场单价和数量','消费依据中需要现场价格'].includes(o?.message)||o?.pricePreparation===true&&['purchase-price-unavailable','purchase-price-evidence-required'].includes(o.code));
 need(sequences.length&&sequences.every(s=>s.source==='program-action-sequence'&&s.roundId===r.id&&s.tool==='mcp__fish-world__world_do'&&s.status==='blocked'&&s.outcome?.status==='blocked'&&s.outcome.notSubmitted===true&&price(s.outcome)&&Array.isArray(s.calls)&&s.calls.every(call=>call.status==='confirmed'&&!mutation(call)&&tools.some(row=>row.id===call.id&&row.tool===call.tool))),'不是明确未提交的本地价格准备误拒');
 need(!l.journal.some(row=>scoped(row)&&mutation(row)&&(row.round===r.id||row.tool!=='mcp__fish-world__world_say'&&Number.isFinite(row.at)&&row.at>=cost.at)),'失败回合或其后已有实际变更，不能撤销延期');
 if(closedRevision){
  need(h.patch&&p.nextAt===h.patch.nextAt,'收尾后的延期时间与原更新不一致');
  const replay=clone(l);replay.plans[replay.plans.findIndex(plan=>plan.id===p.id)]=clone(h.before);
  applyPlanChanges(replay,[{op:'update',id:p.id,expectedRevision:h.fromRevision,patch:h.patch,evidenceIds:h.evidenceIds||[],submittedPlan:h.submittedPlan,semanticReason:h.semanticReason}],{now:h.at,roundId:r.id,recordHistory:false});
  need(replay.plans.find(plan=>plan.id===p.id).revision===h.toRevision,'原计划更新无法精确重放');
  finishPlanCheck(replay,{life:replay,state:{},at:{}},{...r,planId:p.id,startedAt:cost.at,sessionId:tools[0].sessionId,receipts:tools.map(row=>({id:row.id,tool:row.tool,text:row.result,isError:false}))},{now:cost.finishedAt});
  const business=plan=>Object.fromEntries(Object.entries(plan).filter(([key])=>key!=='lastEvidenceFingerprint'));
  need(historyReviewHash(business(replay.plans.find(plan=>plan.id===p.id)))===historyReviewHash(business(p)),'计划存在非同轮标准收尾的变化，不能撤销延期');
 }
 const draft=clone(l),target=draft.plans.find(plan=>plan.id===p.id),before=clone(target);target.nextAt=now;target.status='pending';if(target.waitCondition)target.waitCondition={...target.waitCondition,at:now};target.revision++;target.updatedAt=now;target.changeReason='本地价格准备误拒后的正常复核，不代表购买或任务完成';
 draft.planHistory.push({at:now,op:'maintenance-price-recheck',id:p.id,fromRevision:before.revision,toRevision:target.revision,before,operationId,failedRoundId:r.id});
 (draft.maintenanceOperations??=[]).push({operationId,protocol:RECHECK,at:now,planId:p.id,failedRoundId:r.id,fromRevision:before.revision,toRevision:target.revision,previousNextAt:before.nextAt,nextAt:now,worldMutations:0,modelCalls:0,qqSends:0});
 for(const key of ['days','outbox','journal','ownerInstructions'])need(historyReviewHash(draft[key])===historyReviewHash(l[key]),'复核意外改变历史日账、投递、原始回执或主人指令');
 Object.assign(l,draft);return {repeated:false,operationId,planId:p.id,revision:target.revision,previousNextAt:before.nextAt,nextAt:now};
}
function timingOf(input){need(input&&Object.keys(input).length===4&&TIMING_KEYS.every(key=>Number.isSafeInteger(input[key])&&input[key]>=60000&&input[key]<=86400000),'维护只能修改四个明确的间隔参数');return Object.fromEntries(TIMING_KEYS.map(key=>[key,input[key]]));}
function pairProof(l,pair,fishId,now){
 need(Array.isArray(pair)&&pair.length===2&&pair[0]!==pair[1],'同义合并需要两个不同计划 ID');
 const [primary,duplicate]=pair.map(id=>l.plans.find(p=>p.id===id));need(primary&&duplicate,'同义合并目标缺失');
 need(['pending','active','waiting_event','blocked'].includes(primary.status)&&['pending','active','waiting_event','blocked'].includes(duplicate.status),'不能用同义合并激活历史待核对或终态');
 const proof=equivalentPlans(primary,duplicate,l,{fishId,owner:l.owner,persona:l.persona,ownerInstructionRevision:l.ownerInstructionRevision,now,reviewedPair:pair});
 need(proof,'两条计划未通过同义身份验证');
 return {primaryId:primary.id,duplicateId:duplicate.id,expected:[primary,duplicate].map(p=>({id:p.id,revision:p.revision,sha256:historyReviewHash(p)})),proof};
}
export function applyMaintenanceToLife(l,proposal,{now=Date.now()}={}){
 need(proposal?.protocol===PROTOCOL,'维护协议无效');const {proposalSha256,...unsigned}=proposal;need(historyReviewHash(unsigned)===proposalSha256,'维护提案哈希已变化');
 if((l.maintenanceOperations||[]).some(row=>row.operationId===proposal.operationId))return {repeated:true};
 for(const pair of proposal.pairs)for(const expected of pair.expected){const p=l.plans.find(p=>p.id===expected.id);need(p&&p.revision===expected.revision&&historyReviewHash(p)===expected.sha256,'同义合并目标已变化');}
 const draft=clone(l);applyHistoryReview(draft,proposal.history,{now});
 for(const pair of proposal.pairs){
  const primary=draft.plans.find(p=>p.id===pair.primaryId),duplicate=draft.plans.find(p=>p.id===pair.duplicateId);
  const patch=refinementPatch(primary,duplicate,{sourceEventIds:duplicate.sourceEventIds,evidenceIds:duplicate.sourceEvidenceIds||[],proof:pair.proof});
  applyPlanChanges(draft,[{op:'update',id:primary.id,expectedRevision:primary.revision,patch,evidenceIds:duplicate.sourceEvidenceIds||[],submittedPlan:clone(duplicate),semanticReason:pair.proof.reason}],{now});
  const target=draft.plans.find(p=>p.id===primary.id),old=draft.plans.find(p=>p.id===duplicate.id);
  applyPlanChanges(draft,[{op:'merge',id:old.id,expectedRevision:old.revision,targetId:target.id,targetExpectedRevision:target.revision,patch:{status:'merged',changeReason:'同一已核对事项的改述和新增限制'},evidenceIds:[]}],{now});
 }
 draft.nextIdle=Math.max(draft.nextIdle||0,now+proposal.timing.idleMs);
 for(const round of draft.costs?.rounds||[])if(round.budgetBucket==='social'){
  const finished=round.finishedAt||round.at;for(const id of round.sourceEventIds||[]){const q=draft.queue.find(q=>q.id===id);if(q?.sender)draft.cooldowns[q.sender]=Math.max(draft.cooldowns[q.sender]||0,finished+proposal.timing.socialMs);}
 }
 for(const key of TIMING_KEYS)if(key in draft.controls)draft.controls[key]=proposal.timing[key];
 (draft.maintenanceOperations??=[]).push({operationId:proposal.operationId,at:now,protocol:PROTOCOL,historyOperationId:proposal.history.operationId,pairs:proposal.pairs.map(p=>[p.primaryId,p.duplicateId]),timing:proposal.timing});
 for(const key of ['days','outbox','journal','ownerInstructions'])need(historyReviewHash(draft[key])===historyReviewHash(l[key]),'维护意外改变历史日账、投递、原始回执或主人指令');
 Object.assign(l,draft);return {repeated:false,...clone(proposal.history.summary),semanticPairs:proposal.pairs.length};
}
export function installMaintenance(api,engineOf,allowed){
 const root=api.dataDir(),inputRoot=safe(root,'maintenance-inputs'),receiptRoot=safe(root,'maintenance-receipts'),backupRoot=safe(root,'maintenance-backups');
 const prepared=new Map();
 const readInput=id=>{need(/^[a-f0-9]{64}$/.test(id||''),'维护输入编号无效');const file=safe(root,'maintenance-inputs',id+'.json'),raw=fs.readFileSync(file);need(raw.length<=20*1024*1024&&sha(raw)===id,'维护输入哈希或体积无效');return JSON.parse(raw);};
 const paths=id=>{need(/^maintenance-[a-f0-9]{24}$/.test(id||''),'维护操作编号无效');return {receipt:safe(root,'maintenance-receipts',id+'.json'),proposal:safe(root,'maintenance-receipts',id+'.proposal.json'),backup:safe(root,'maintenance-backups',id+'.runtime.json')};};
 async function prepare(engine,body){
  const input=readInput(body.inputId),timing=timingOf(input.timing),pairs=input.pairs||[];
  need(input.ownerDecision==='keep-grouped','本轮历史不确定项必须按主人选择保留分组待核对');
  const operationId='maintenance-'+sha(JSON.stringify([body.inputId,engine.bridge.data.fishId])).slice(0,24),files=paths(operationId);
  if((engine.l.maintenanceOperations||[]).some(row=>row.operationId===operationId))return {ok:true,operationId,repeated:true,status:'applied'};
  if(fs.existsSync(files.receipt)&&fs.existsSync(files.proposal)){
   const receipt=JSON.parse(fs.readFileSync(files.receipt)),existing=JSON.parse(fs.readFileSync(files.proposal));
   need(receipt.status==='prepared','维护回执与当前账本不一致');applyMaintenanceToLife(clone(engine.l),existing,{now:existing.preparedAt});prepared.set(operationId,existing);
   return {ok:true,status:'prepared',operationId,proposalSha256:existing.proposalSha256,reused:true,summary:{...existing.history.summary,semanticPairs:existing.pairs.length},timing:existing.timing,proposalPath:files.proposal};
  }
  const sourceEvents=new Map(),owned=new Set((engine.l.contextWindow?.windows||[]).map(w=>w.sessionId));
  const query=api.dsh.get('sessionQuery');need(query?.readSession,'缺少正式只读来源服务');
  for(const id of new Set(input.report.originals.map(row=>row.selectedOrigin?.sessionId))){
   need(id&&owned.has(id),'维护源窗口不属于鱼世界');const value=await query.readSession(id);need(Array.isArray(value?.events),'原始源事件不可用');sourceEvents.set(id,value.events);
  }
  available(engine);const at=Date.now(),history=prepareHistoryReview(engine.bridge.data,input.report,{now:at,ownerDecision:input.ownerDecision,sourceEvents});
  const proposal={protocol:PROTOCOL,operationId,inputId:body.inputId,preparedAt:at,fishId:engine.bridge.data.fishId,history,pairs:pairs.map(pair=>pairProof(engine.l,pair,engine.bridge.data.fishId,at)),timing,
   previousSettings:Object.fromEntries(TIMING_KEYS.map(key=>[key,engine.cfg[key]])),ownerDecision:input.ownerDecision};
  proposal.proposalSha256=historyReviewHash(proposal);const trial=clone(engine.l);applyMaintenanceToLife(trial,proposal,{now:at});
  prepared.set(operationId,proposal);fs.mkdirSync(receiptRoot,{recursive:true});atomic(files.proposal,proposal);
  return {ok:true,status:'prepared',operationId,proposalSha256:proposal.proposalSha256,summary:{...history.summary,semanticPairs:pairs.length},timing,proposalPath:files.proposal};
 }
 function apply(engine,body){
  const files=paths(body.operationId),proposal=prepared.get(body.operationId)||JSON.parse(fs.readFileSync(files.proposal));
  need(proposal.fishId===engine.bridge.data.fishId&&proposal.operationId===body.operationId,'维护身份或操作编号不匹配');
  if((engine.l.maintenanceOperations||[]).some(row=>row.operationId===proposal.operationId)){
   let old=JSON.parse(fs.readFileSync(files.receipt));need(sha(fs.readFileSync(files.backup))===old.sourceSha256&&sha(fs.readFileSync(files.proposal))===old.proposalFileSha256,'维护恢复材料不一致');
   if(old.status!=='applied'){old={...old,status:'applied',recovered:true,finishedAt:Date.now(),targetSha256:sha(fs.readFileSync(engine.bridge.file)),settingsApplied:TIMING_KEYS.every(key=>api.settings()[key]===proposal.timing[key])};atomic(files.receipt,old);}
   return {ok:true,status:'applied',operationId:proposal.operationId,repeated:true,receiptPath:files.receipt};
  }
  available(engine);const at=Date.now(),draft=clone(engine.l),summary=applyMaintenanceToLife(draft,proposal,{now:at}),before=fs.readFileSync(engine.bridge.file);
  need(sha(before)===sha(bytes(engine.bridge.data)),'内存账本与磁盘尚未一致，请等待采集结束后重试');
  fs.mkdirSync(backupRoot,{recursive:true});fs.mkdirSync(receiptRoot,{recursive:true});
  const previous=fs.existsSync(files.receipt)?JSON.parse(fs.readFileSync(files.receipt)):null;
  if(previous)need(previous.status==='prepared'&&sha(fs.readFileSync(files.backup))===previous.sourceSha256&&previous.proposalFileSha256===sha(fs.readFileSync(files.proposal)),'中断维护恢复材料不一致');
  const attemptBackup=previous?safe(root,'maintenance-backups',proposal.operationId+'.'+sha(before).slice(0,16)+'.runtime.json'):files.backup;preserve(attemptBackup,before);
  const receipt={protocol:PROTOCOL,operationId:proposal.operationId,status:'prepared',at,sourceSha256:previous?.sourceSha256||sha(before),backupPath:files.backup,attemptBackupPath:attemptBackup,attemptSourceSha256:sha(before),proposalPath:files.proposal,proposalFileSha256:sha(fs.readFileSync(files.proposal)),summary,timing:proposal.timing,previousSettings:proposal.previousSettings,schema:{runtime:3,life:2},worldMutations:0,modelCalls:0,qqSends:0};
  atomic(files.receipt,receipt);
  // Only the module's four own settings are patched. All host/global settings stay in place.
  api.saveSettings(proposal.timing);
  need(TIMING_KEYS.every(key=>api.settings()[key]===proposal.timing[key]),'鱼世界四项间隔尚未保存；自动流程仍暂停');
  engine.change(l=>{applyMaintenanceToLife(l,proposal,{now:at});});
  const completed={...receipt,status:'applied',finishedAt:Date.now(),targetSha256:sha(fs.readFileSync(engine.bridge.file)),settingsApplied:true};atomic(files.receipt,completed);
  return {ok:true,status:'applied',operationId:proposal.operationId,receiptPath:files.receipt,summary,timing:proposal.timing};
 }
 api.route('/maintenance',async req=>{
  need(req.method==='POST','维护使用POST');need(allowed(),'模块未启用');const body=await api.core.http.body(req),engine=engineOf();
  available(engine);need(!engine.maintenanceBusy,'维护正在进行');need(!engine.cfg.autonomy,'请先暂停鱼世界自动行动，再准备维护');
  engine.maintenanceBusy=true;
  try{return body.mode==='prepare'?await prepare(engine,body):body.mode==='apply'?apply(engine,body):(()=>{throw Error('维护操作无效');})();}
  finally{engine.maintenanceBusy=false;}
 },{access:'panel'});
 api.route('/plan-recheck',async req=>{
  need(req.method==='POST','复核使用POST');need(allowed(),'模块未启用');const body=await api.core.http.body(req),engine=engineOf();available(engine);need(!engine.maintenanceBusy,'维护正在进行');need(!engine.cfg.autonomy,'请先暂停鱼世界自动行动，再复核计划');
  engine.maintenanceBusy=true;
  try{
   const at=engine.clock?.()??Date.now(),summary=recheckLife(clone(engine.l),body,{now:at}),files=paths(summary.operationId);
   if(summary.repeated){const old=JSON.parse(fs.readFileSync(files.receipt));need(old.protocol===RECHECK&&old.operationId===summary.operationId&&sha(fs.readFileSync(files.backup))===old.sourceSha256,'复核恢复材料不一致');if(old.status!=='applied')atomic(files.receipt,{...old,status:'applied',recovered:true,finishedAt:at,targetSha256:sha(fs.readFileSync(engine.bridge.file))});return {ok:true,status:'applied',...summary,receiptPath:files.receipt};}
   const before=fs.readFileSync(engine.bridge.file);need(sha(before)===sha(bytes(engine.bridge.data)),'内存账本与磁盘尚未一致，请等待采集结束后重试');fs.mkdirSync(backupRoot,{recursive:true});fs.mkdirSync(receiptRoot,{recursive:true});
   const previous=fs.existsSync(files.receipt)?JSON.parse(fs.readFileSync(files.receipt)):null;if(previous)need(previous.protocol===RECHECK&&previous.status==='prepared'&&sha(fs.readFileSync(files.backup))===previous.sourceSha256,'复核恢复材料不一致');
   const attemptBackup=previous?safe(root,'maintenance-backups',summary.operationId+'.'+sha(before).slice(0,16)+'.runtime.json'):files.backup;preserve(attemptBackup,before);
   const receipt={protocol:RECHECK,operationId:summary.operationId,status:'prepared',at,input:clone(body),sourceSha256:previous?.sourceSha256||sha(before),backupPath:files.backup,attemptBackupPath:attemptBackup,attemptSourceSha256:sha(before),summary,worldMutations:0,modelCalls:0,qqSends:0};atomic(files.receipt,receipt);
   available(engine);need(!engine.cfg.autonomy,'自动行动已恢复，保留现有计划');engine.change(l=>recheckLife(l,body,{now:at}));atomic(files.receipt,{...receipt,status:'applied',finishedAt:at,targetSha256:sha(fs.readFileSync(engine.bridge.file))});return {ok:true,status:'applied',...summary,receiptPath:files.receipt};
  }finally{engine.maintenanceBusy=false;}
 },{access:'panel'});
 return {inputRoot,receiptRoot,backupRoot};
}
