import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {prepareHistoryReview,applyHistoryReview,historyReviewHash} from './history-review.mjs';
import {equivalentPlans,refinementPatch} from './plan-semantics.mjs';
import {applyPlanChanges} from './plans.mjs';
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
 return {inputRoot,receiptRoot,backupRoot};
}
