import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {newLife,dayKey,planTerminal} from './state.mjs';
import {logicalPlanKey,planIdentity,provedWorkSource} from './plans.mjs';

export const MIGRATION_VERSION='fish-world-runtime-3-life-2/v1';
export const WITNESS_PROTOCOL='fish-world-migration-witness/v1';
export const TARGET_MODULE_VERSION='1.3.0';
export const sha256=value=>createHash('sha256').update(value).digest('hex');
const copy=value=>structuredClone(value);
const requireThat=(test,message)=>{if(!test)throw Error(message);};
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const normalized=p=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
const unique=values=>[...new Set(values)];
const legacyOpen=new Set(['pending','active','waiting_event','blocked','needs_review']);
const safeTime=value=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):0;
const quotaBucket=row=>(row.facts||[]).map(String).find(v=>/^budget-(work|idle|social|share)$/.test(v))?.slice(7);
const isQuota=row=>row.noticeOnly===true||(row.facts||[]).some(v=>String(v).startsWith('budget-'));
const opId=hash=>'migration-'+sha256(MIGRATION_VERSION+':'+hash).slice(0,24);

export function migrationRequired(raw){
  return raw?.version!==3||raw?.life?.version!==2;
}
function checkSource(raw){
  requireThat(raw&&typeof raw==='object'&&!Array.isArray(raw),'鱼世界账本必须是对象');
  requireThat(raw.version===2&&(raw.life?.version===undefined||raw.life.version===1),'仅支持 runtime schema 2 / life schema 1 的显式迁移');
  for(const key of ['plans','queue','journal','outbox'])requireThat(Array.isArray(raw.life[key]),'旧账本缺少 '+key);
  requireThat(raw.life.days&&typeof raw.life.days==='object'&&!Array.isArray(raw.life.days),'旧额度账本无效');
}
function explicitIdentity(p,life,fishId){
  return !!(fishId&&life.owner&&life.persona&&typeof p.topic==='string'&&p.topic.trim()
    &&typeof p.subject==='string'&&p.subject.trim()&&typeof p.stage==='string'&&p.stage.trim()
    &&safeTime(p.windowStart)&&safeTime(p.windowEnd)>safeTime(p.windowStart)
    &&Number.isSafeInteger(p.ownerInstructionRevision)&&p.ownerInstructionRevision>=0
    &&(!p.owner||p.owner===life.owner)&&(!p.persona||p.persona===life.persona)&&(!p.fishId||p.fishId===fishId));
}
function semanticPlan(p){
  const keys=['goal','reason','nextStep','progress','topic','subject','stage','businessAt','windowStart','windowEnd',
    'nextAt','expiresAt','trigger','waitCondition','status','sourceEventIds','sourceEvidenceIds','ownerInstructionRevision'];
  return Object.fromEntries(keys.map(key=>[key,p[key]??null]));
}

/** Pure migration. The caller keeps the exact input bytes separately for recovery. */
export function migrateLedger(raw,{now=Date.now(),sourceSha256=sha256(JSON.stringify(raw)),fishId=raw?.fishId||raw?.state?.fish||'',synthetic=false}={}){
  requireThat(validHash(sourceSha256),'迁移源哈希无效');
  if(!migrationRequired(raw)){
    requireThat(raw.migration?.version===MIGRATION_VERSION,'当前 schema 没有本迁移的回执标识');
    return {ledger:copy(raw),report:{protocol:MIGRATION_VERSION,status:'already_migrated',synthetic,operationId:raw.migration.operationId,sourceSha256}};
  }
  checkSource(raw);const ledger=copy(raw),l=ledger.life,source=raw.life,id=opId(sourceSha256);
  const report={protocol:MIGRATION_VERSION,status:'planned',synthetic,operationId:id,at:now,sourceSha256,
    sourceSchema:{runtime:raw.version,life:source.version??1},targetSchema:{runtime:3,life:2},
    originalCounts:{plans:source.plans.length,queue:source.queue.length,journal:source.journal.length,outbox:source.outbox.length},
    planMapping:[],proposedGroups:[],ambiguities:[],alertMapping:[],
    unchangedFields:['identity','credential-reference','controls','days','cooldowns','queue','journal','contextWindow','receipts','non-quota-outbox'],
    warnings:[]};
  const defaults=newLife(now);
  for(const key of ['ownerInstructionRevision','planHistory','alerts','scheduler','costs'])if(l[key]===undefined)l[key]=copy(defaults[key]);
  l.ownerInstructionRevision=source.ownerInstructionRevision??source.revision??0;
  requireThat(Array.isArray(l.planHistory)&&Array.isArray(l.alerts),'新增计划历史或告警结构无效');
  const reserved=new Set(),groups=new Map();
  l.plans=source.plans.map((p,index)=>{
    requireThat(p&&typeof p==='object'&&!Array.isArray(p),'历史计划记录无效');
    const previousId=typeof p.id==='string'?p.id:null;
    let newId=previousId;
    if(!newId||reserved.has(newId))newId='legacy-plan-'+sha256(id+':'+index+':'+JSON.stringify(p)).slice(0,24);
    reserved.add(newId);
    const value={...copy(p),id:newId,revision:Number.isSafeInteger(p.revision)&&p.revision>0?p.revision:1,
      sourceEventIds:copy(Array.isArray(p.sourceEventIds)?p.sourceEventIds:[]),
      sourceEvidenceIds:copy(Array.isArray(p.sourceEvidenceIds)?p.sourceEvidenceIds:[]),
      supersedes:copy(Array.isArray(p.supersedes)?p.supersedes:[]),mergedFrom:copy(Array.isArray(p.mergedFrom)?p.mergedFrom:[]),
      lastCheckedAt:p.lastCheckedAt??0,lastProgressAt:p.lastProgressAt??p.updatedAt??p.createdAt??now,
      lastEvidenceFingerprint:p.lastEvidenceFingerprint??'',
      migrationOriginal:copy(p)};
    let proof=false;try{proof=provedWorkSource(source,value);}catch{report.warnings.push({kind:'malformed-work-proof',index,id:newId});}
    value.budgetBucket=proof?'work':'idle';
    const mapping={index,originalId:previousId,id:newId,canonicalId:newId,originalStatus:p.status??null,
      status:p.status??null,action:'retained',basis:'original-terminal-state'};
    if(explicitIdentity(p,source,fishId)){
      const context={now,fishId,owner:source.owner,persona:source.persona,ownerInstructionRevision:p.ownerInstructionRevision};
      Object.assign(value,planIdentity(p,context));value.logicalKey=logicalPlanKey(p,context);
      const group=groups.get(value.logicalKey)||[];group.push({value,mapping,semantic:JSON.stringify(semanticPlan(p))});groups.set(value.logicalKey,group);
      mapping.basis='explicit-identity-and-business-window';
    }else{
      // A title, old random ID, or expired nextAt cannot establish historical identity or completion.
      value.logicalKey='legacy-review-'+sha256(id+':'+index);
      if(!planTerminal(p.status)){
        value.status='needs_review';mapping.action='needs_review';mapping.basis='insufficient-explicit-identity';
        report.ambiguities.push({id:newId,index,reason:mapping.basis});
      }
    }
    if(!planTerminal(p.status)&&!legacyOpen.has(p.status)){
      value.status='needs_review';mapping.action='needs_review';mapping.basis='unknown-original-status';
      report.ambiguities.push({id:newId,index,reason:mapping.basis});
    }
    mapping.status=value.status;report.planMapping.push(mapping);return value;
  });
  for(const [logicalKey,rows] of groups){
    if(rows.length<2)continue;
    const identical=rows.every(row=>row.semantic===rows[0].semantic);
    const allOpen=rows.every(row=>legacyOpen.has(row.value.status));
    if(identical&&allOpen){
      const primary=rows[0];primary.value.mergedFrom=unique([...primary.value.mergedFrom,...rows.slice(1).map(row=>row.value.id)]);
      for(const row of rows.slice(1)){
        row.value.status='merged';row.value.mergedInto=primary.value.id;row.value.revision++;
        Object.assign(row.mapping,{canonicalId:primary.value.id,status:'merged',action:'merged',basis:'identical-explicit-identity-and-state'});
      }
      primary.value.revision++;
      report.proposedGroups.push({logicalKey,canonicalId:primary.value.id,ids:rows.map(row=>row.value.id),basis:'identical-explicit-identity-and-state'});
    }else{
      // Conflicting state or terminal records are never silently picked as the winner.
      for(const row of rows)if(!planTerminal(row.value.status)){
        row.value.status='needs_review';row.mapping.status='needs_review';row.mapping.action='needs_review';row.mapping.basis='conflicting-duplicate-state';
        report.ambiguities.push({id:row.value.id,index:row.mapping.index,reason:row.mapping.basis});
      }
    }
  }
  const alertGroups=new Map();
  l.outbox=source.outbox.map((row,index)=>{
    if(!isQuota(row))return copy(row);
    const bucket=quotaBucket(row)||'unknown',at=safeTime(row.at),day=at?dayKey(at):'unknown';
    const key='quota-'+sha256(JSON.stringify([fishId,row.owner??source.owner,row.persona??source.persona,day,bucket,'daily-limit']));
    const alert=alertGroups.get(key)||{id:key,key,kind:'quota',fishId,day,bucket,reason:'daily-limit',
      status:day===dayKey(now)?'active':'closed',firstSeenAt:at,lastSeenAt:at,repeatCount:0,noticeOnly:true,deliveryEvidence:[]};
    alert.repeatCount++;alert.firstSeenAt=Math.min(alert.firstSeenAt,at);alert.lastSeenAt=Math.max(alert.lastSeenAt,at);
    alert.deliveryEvidence.push({index,id:row.id??null,state:row.state??null,receipt:copy(row.receipt??null),deliveryId:row.deliveryId??null});
    alertGroups.set(key,alert);report.alertMapping.push({index,id:row.id??null,originalState:row.state??null,alertKey:key,action:'notice-only-no-delivery'});
    // Keep original delivery state and every receipt; the new delivery selector skips noticeOnly.
    return {...copy(row),noticeOnly:true,deliveryDisabledByMigration:true,migrationOriginalState:row.state??null,migrationAlertKey:key};
  });
  for(const alert of alertGroups.values()){
    const existing=l.alerts.find(a=>a.key===alert.key);
    if(existing){existing.deliveryEvidence=[...(existing.deliveryEvidence||[]),...alert.deliveryEvidence];existing.repeatCount=(existing.repeatCount||0)+alert.repeatCount;}
    else l.alerts.push(alert);
  }
  l.scheduler={...copy(defaults.scheduler),...l.scheduler,lastStartedAt:Math.max(now,l.scheduler?.lastStartedAt||0),clockFloor:Math.max(now,l.scheduler?.clockFloor||0)};
  l.costs={...copy(defaults.costs),...l.costs};
  if(!l.costs.baselines?.[dayKey(now)])l.costs.historicalDay=dayKey(now);
  if(source.round)l.recovery=true;
  l.version=2;ledger.version=3;
  ledger.migration={version:MIGRATION_VERSION,operationId:id,sourceSha256,at:now,sourceSchema:report.sourceSchema,
    planMapping:copy(report.planMapping),alertMapping:copy(report.alertMapping),requiresRecovery:!!source.round};
  requireThat(equal(l.days,source.days)&&equal(l.controls,source.controls)&&equal(l.queue,source.queue)&&equal(l.journal,source.journal),'迁移改变了历史额度、控制、事件或操作账本');
  requireThat(l.plans.length===source.plans.length&&l.outbox.length===source.outbox.length,'迁移丢失历史记录');
  return {ledger,report};
}
export const inspectLegacyLedger=(raw,options={})=>migrateLedger(raw,options).report;

export function validateMigrationWitness(witness,{runtimePath,runtimeSha256,now=Date.now()}){
  requireThat(witness?.protocol===WITNESS_PROTOCOL,'缺少正式迁移只读门禁证明');
  requireThat(typeof witness.runtimePath==='string'&&normalized(witness.runtimePath)===normalized(runtimePath),'证明不属于该账本');
  requireThat(validHash(runtimeSha256)&&witness.runtimeSha256===runtimeSha256,'迁移证明的 runtime 哈希不匹配');
  requireThat(Number.isFinite(witness.capturedAt)&&Number.isFinite(witness.expiresAt)&&witness.capturedAt<=now&&now-witness.capturedAt<=30000&&witness.expiresAt>now&&witness.expiresAt-witness.capturedAt<=30000,'迁移证明已过期或时间无效');
  for(const key of ['oldWriterStopped','agentsIdle','toolsIdle','outboundIdle'])requireThat(witness[key]===true,'无法证明安全独占：'+key);
  const gate=witness.readOnlyGate,proof=witness.writerProof;
  requireThat(gate?.active===true&&gate.version===TARGET_MODULE_VERSION&&gate.generation!==undefined&&gate.generation!==null&&gate.generation!=='','新版本迁移只读门禁尚未生效');
  requireThat(proof?.kind==='module-lifecycle-quiescence'&&proof.oldModuleDetached===true&&proof.runtimeSha256===runtimeSha256,'缺少旧写入者生命周期证明');
  requireThat(Number.isFinite(proof.stableSince)&&Number.isFinite(proof.stableThrough)&&proof.stableThrough-proof.stableSince>=15000&&proof.stableThrough<=witness.capturedAt&&witness.capturedAt-proof.stableThrough<=1000,'旧账本稳定观察不足十五秒');
  return true;
}
function noLinks(target){
  for(let cursor=path.resolve(target);;cursor=path.dirname(cursor)){
    if(fs.existsSync(cursor)){
      const stat=fs.lstatSync(cursor);
      requireThat(!stat.isSymbolicLink(),'迁移路径含符号链接或目录重定向');
      requireThat(normalized(fs.realpathSync(cursor))===normalized(cursor),'迁移路径发生目录重定向');
    }
    if(path.dirname(cursor)===cursor)break;
  }
}
function locations(runtimePath,{backupDir,receiptDir}={},operationId=''){
  requireThat(path.isAbsolute(runtimePath),'账本必须使用绝对路径');runtimePath=path.resolve(runtimePath);noLinks(runtimePath);
  requireThat(path.basename(runtimePath)==='runtime.json'&&path.basename(path.dirname(runtimePath))==='fish-world','仅允许鱼世界私有 runtime.json');
  requireThat(!operationId||/^migration-[a-f0-9]{24}$/.test(operationId),'迁移操作标识无效');
  const root=path.dirname(runtimePath),inside=(candidate)=>{const rel=path.relative(root,candidate);return rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);};
  backupDir=path.resolve(backupDir||path.join(root,'migration-backups'));
  receiptDir=path.resolve(receiptDir||path.join(root,'migration-receipts'));
  requireThat(inside(backupDir)&&inside(receiptDir)&&backupDir!==receiptDir,'备份和回执必须在鱼世界私有子目录');
  for(const directory of [backupDir,receiptDir])noLinks(directory);
  return {runtimePath,root,backupDir,receiptDir,backupPath:path.join(backupDir,operationId+'.runtime.json'),mappingPath:path.join(receiptDir,operationId+'.mapping.json'),receiptPath:path.join(receiptDir,operationId+'.json'),lockPath:runtimePath+'.migration.lock'};
}
function readRuntime(file){noLinks(file);const bytes=fs.readFileSync(file);return {bytes,hash:sha256(bytes),raw:JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''))};}
function exclusiveFile(file,bytes){
  noLinks(file);const fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function preserveFile(file,bytes){
  if(fs.existsSync(file)){requireThat(sha256(fs.readFileSync(file))===sha256(bytes),'已有迁移保全文件哈希冲突');return;}
  exclusiveFile(file,bytes);
}
function jsonBytes(value){return Buffer.from(JSON.stringify(value,null,2)+'\n');}
function leaseAt(loc,clock){
  const lease={protocol:MIGRATION_VERSION,id:randomUUID(),owner:'fish-world-ledger-migration',pid:process.pid,acquiredAt:clock(),expiresAt:clock()+60000};
  exclusiveFile(loc.lockPath,jsonBytes(lease));
  const check=()=>{noLinks(loc.lockPath);const active=JSON.parse(fs.readFileSync(loc.lockPath));requireThat(active.id===lease.id&&clock()<active.expiresAt,'迁移独占租约失效');};
  return {lease,check,release(){check();fs.unlinkSync(loc.lockPath);}};
}
function replaceFile(file,bytes,token,beforeReplace){
  const tmp=file+'.'+token+'.tmp';noLinks(tmp);
  if(fs.existsSync(tmp))requireThat(sha256(fs.readFileSync(tmp))===sha256(bytes),'中断迁移临时文件不匹配');
  else exclusiveFile(tmp,bytes);
  try{beforeReplace?.();fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp)&&sha256(fs.readFileSync(tmp))===sha256(bytes))fs.unlinkSync(tmp);}
}
function verifyArtifacts(loc,receipt){
  for(const key of ['backupPath','mappingPath'])noLinks(receipt[key]);
  requireThat(normalized(receipt.backupPath)===normalized(loc.backupPath)&&normalized(receipt.mappingPath)===normalized(loc.mappingPath),'迁移回执路径不匹配');
  requireThat(sha256(fs.readFileSync(loc.backupPath))===receipt.sourceSha256,'私有原账本备份哈希不匹配');
  requireThat(sha256(fs.readFileSync(loc.mappingPath))===receipt.mappingSha256,'迁移映射哈希不匹配');
}

/** Writes only this module's ledger, private backup, mapping, receipt and owned lease. */
export function applyMigration({runtimePath,witness,backupDir,receiptDir,synthetic=false,clock=Date.now}){
  const first=readRuntime(runtimePath);
  if(!migrationRequired(first.raw)){
    const operationId=first.raw.migration?.operationId,loc=locations(runtimePath,{backupDir,receiptDir},operationId);
    const receipt=JSON.parse(fs.readFileSync(loc.receiptPath));verifyArtifacts(loc,receipt);
    requireThat(receipt.operationId===operationId&&receipt.sourceSha256===first.raw.migration.sourceSha256,'已迁移账本与回执不一致');
    if(receipt.status==='applied')return {...receipt,repeated:true,currentSha256:first.hash,hasNewData:first.hash!==receipt.targetSha256};
    requireThat(receipt.status==='prepared'&&first.hash===receipt.targetSha256,'迁移状态无法安全恢复');
    // Interrupted after atomic replacement: finish the receipt only under a new fresh witness.
    validateMigrationWitness(witness,{runtimePath,runtimeSha256:first.hash,now:clock()});
    const held=leaseAt(loc,clock);
    try{
      held.check();requireThat(readRuntime(runtimePath).hash===first.hash,'账本在恢复迁移期间改变');
      const completed={...receipt,status:'applied',appliedAt:clock(),recovered:true};
      replaceFile(loc.receiptPath,jsonBytes(completed),held.lease.id);return completed;
    }finally{held.release();}
  }
  const operationId=opId(first.hash),loc=locations(runtimePath,{backupDir,receiptDir},operationId);
  validateMigrationWitness(witness,{runtimePath,runtimeSha256:first.hash,now:clock()});
  const held=leaseAt(loc,clock);
  try{
    const check=()=>{held.check();validateMigrationWitness(witness,{runtimePath,runtimeSha256:first.hash,now:clock()});requireThat(readRuntime(runtimePath).hash===first.hash,'账本在迁移期间改变，拒绝覆盖');};
    check();
    const previous=fs.existsSync(loc.receiptPath)?JSON.parse(fs.readFileSync(loc.receiptPath)):null;
    if(previous)requireThat(previous.status==='prepared'&&previous.sourceSha256===first.hash,'该操作已有其他最终回执，拒绝重复应用');
    const at=previous?.preparedAt??clock(),{ledger,report}=migrateLedger(first.raw,{now:at,sourceSha256:first.hash,synthetic});
    const target=jsonBytes(ledger),mapping=jsonBytes(report);
    for(const directory of [loc.backupDir,loc.receiptDir]){noLinks(directory);fs.mkdirSync(directory,{recursive:true,mode:0o700});noLinks(directory);}
    preserveFile(loc.backupPath,first.bytes);preserveFile(loc.mappingPath,mapping);
    const receipt={protocol:MIGRATION_VERSION,operationId,status:'prepared',synthetic,preparedAt:at,sourceSha256:first.hash,targetSha256:sha256(target),backupPath:loc.backupPath,mappingPath:loc.mappingPath,mappingSha256:sha256(mapping),witnessSha256:sha256(JSON.stringify(witness)),sourceSchema:report.sourceSchema,targetSchema:report.targetSchema};
    if(previous)requireThat(previous.targetSha256===receipt.targetSha256&&previous.mappingSha256===receipt.mappingSha256,'中断迁移计算结果不一致');
    else preserveFile(loc.receiptPath,jsonBytes(receipt));
    verifyArtifacts(loc,receipt);check();
    replaceFile(runtimePath,target,held.lease.id,check);
    requireThat(readRuntime(runtimePath).hash===receipt.targetSha256,'迁移后账本校验失败，保留恢复材料');
    const completed={...receipt,status:'applied',appliedAt:clock()};
    replaceFile(loc.receiptPath,jsonBytes(completed),held.lease.id,()=>held.check());return completed;
  }finally{held.release();}
}

/** A changed target is never replaced by an old snapshot. Forward repair is required. */
export function rollbackMigration({runtimePath,witness,backupDir,receiptDir,clock=Date.now}){
  const current=readRuntime(runtimePath),id=current.raw.migration?.operationId;
  requireThat(id,'账本没有可核对的迁移标识');
  const loc=locations(runtimePath,{backupDir,receiptDir},id),receipt=JSON.parse(fs.readFileSync(loc.receiptPath));verifyArtifacts(loc,receipt);
  requireThat(receipt.status==='applied'&&receipt.operationId===id,'迁移尚未完成，不能回退');
  requireThat(current.hash===receipt.targetSha256,'已有新事件或账本变化，禁止旧快照覆盖；请保留最新账本并向前修复或生成兼容导出');
  validateMigrationWitness(witness,{runtimePath,runtimeSha256:current.hash,now:clock()});
  const held=leaseAt(loc,clock);
  try{
    const check=()=>{held.check();validateMigrationWitness(witness,{runtimePath,runtimeSha256:current.hash,now:clock()});requireThat(readRuntime(runtimePath).hash===current.hash,'回退前账本已变化');};
    check();const original=fs.readFileSync(loc.backupPath);requireThat(sha256(original)===receipt.sourceSha256,'回退备份哈希不匹配');
    preserveFile(path.join(loc.backupDir,id+'.migrated-runtime.json'),current.bytes);
    replaceFile(runtimePath,original,held.lease.id,check);
    const rolledBack={...receipt,status:'rolled_back',rolledBackAt:clock(),restoredSha256:receipt.sourceSha256};
    replaceFile(loc.receiptPath,jsonBytes(rolledBack),held.lease.id,()=>held.check());return rolledBack;
  }finally{held.release();}
}

/** Read-only startup check: a replaced ledger is not live until its durable apply receipt is complete. */
export function readAppliedMigrationReceipt({runtimePath,backupDir,receiptDir}){
  const current=readRuntime(runtimePath),marker=current.raw.migration;
  requireThat(!migrationRequired(current.raw)&&marker?.version===MIGRATION_VERSION,'账本缺少已知显式迁移标识');
  const loc=locations(runtimePath,{backupDir,receiptDir},marker.operationId);
  requireThat(!fs.existsSync(loc.lockPath),'迁移仍持有独占租约');
  const receipt=JSON.parse(fs.readFileSync(loc.receiptPath));verifyArtifacts(loc,receipt);
  requireThat(receipt.protocol===MIGRATION_VERSION&&receipt.status==='applied'&&receipt.operationId===marker.operationId,'迁移应用回执尚未完整，保持只读');
  requireThat(receipt.sourceSha256===marker.sourceSha256&&validHash(receipt.targetSha256),'迁移标识与回执哈希不匹配');
  requireThat(receipt.targetSchema?.runtime===3&&receipt.targetSchema?.life===2,'迁移目标 schema 不匹配');
  return {...receipt,receiptPath:loc.receiptPath,currentSha256:current.hash,hasNewData:current.hash!==receipt.targetSha256};
}
