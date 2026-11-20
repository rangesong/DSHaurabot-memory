import fs from 'node:fs';import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
function localOrigin(value){const u=new URL(value);if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('压缩引擎地址必须是无凭据的本机 HTTP origin');return u.origin;}
const readJson=(file,fallback)=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):fallback;
export function externalSummaryEnabled(value){if(!value||typeof value!=='object')return false;for(const[k,v]of Object.entries(value)){if(k==='externalSummary'&&v?.enabled===true)return true;if(externalSummaryEnabled(v))return true;}return false;}
export async function existingImageProof(api,cfg,scope,{fetcher=fetch}={}){
 const plan=readJson(api.dataDir('context-governance-plan.json'),null),p=plan?.imageCompatibility;
 if(!p?.verified||!p.allImageRefsBlocked||!p.noImagesInCompressedSubstrate||!p.allExistingBlocksPreservedEvenIfAllImagesRemoved||!plan.backupReceipt?.verified||JSON.stringify(plan.scope)!==JSON.stringify(scope))return false;
 const r=await fetcher(localOrigin(cfg().contextCompressionOrigin)+'/__bili/plugin/manifest',{signal:AbortSignal.timeout(5000)});if(!r.ok)return false;const manifest=await r.json();return manifest.version===p.engineVersion&&manifest.commit===p.engineCommit;
}
export async function applyExistingPlan(api,cfg,{sessionId,chatId,persona,apply=true,fetcher=fetch}={}){
 const c=cfg(),file=api.dataDir('context-governance-plan.json'),plan=readJson(file,null),receipts=api.dataDir('context-engine-receipts.jsonl');
 if(!plan)return {held:'awaiting-verified-existing-engine-plan',engine:'billion-context'};
 if(plan.hold)return {held:plan.hold,engine:'billion-context'};
 if(plan.kind!=='verified-existing-engine-plan'||plan.scope?.sessionId!==sessionId||plan.scope.chatId!==chatId||plan.scope.persona!==persona||!plan.backupReceipt?.verified)throw Error('治理计划范围或必要备份校验失败');
 const pending=plan.ranges.filter(r=>!r.applied&&(r.kind==='memo'?c.contextMemoEnabled!==false:r.kind==='image'?c.contextImagesEnabled!==false:c.contextToolsEnabled!==false));
 if(!pending.length)return {engine:'billion-context',pending:0,alreadyApplied:plan.ranges.filter(r=>r.applied).length};
 if(!apply)return {engine:'billion-context',pending:pending.length,stats:plan.stats,backupVerified:true};
 const origin=localOrigin(c.contextCompressionOrigin),get=async(p,opts)=>{const r=await fetcher(origin+p,{signal:AbortSignal.timeout(10000),...opts});if(!r.ok)throw Error('压缩接口 HTTP '+r.status);return r.json();};
 const config=await get('/__bili/config');if(externalSummaryEnabled(config))throw Error('现有引擎启用了额外模型摘要；本次确定性治理不会触发付费摘要');
 // Validate source refs immediately before asking the owning engine to fold them.
 for(const range of pending)for(const p of range.proof){const m=await get('/__bili/sessions/'+encodeURIComponent(sessionId)+'/message?ref='+encodeURIComponent(p.ref));if(m.truncated||m.role!==p.role||hash(m.text||'')!==p.textSha256)throw Error('原始引用内容已变化，保留原文：'+p.ref);}
 const before=await get('/__bili/sessions/'+encodeURIComponent(sessionId)+'/detail'),status=await get('/__bili/plugin/status?conversationId='+encodeURIComponent(sessionId)),prior=new Set(before.blockDetails.filter(b=>b.active).map(b=>b.blockId));
 const content=pending.map(r=>r.startRef+'–'+r.endRef+' deterministic exact dedup\n'+r.summary).join('\n\n'),body={conversationId:sessionId,tool:'compress',args:{content}};if(/^[a-f0-9]{64}$/.test(status.sessionRevision||''))body.expectedRevision=status.sessionRevision;
 const result=await get('/__bili/plugin/tool',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const after=await get('/__bili/sessions/'+encodeURIComponent(sessionId)+'/detail');if([...prior].some(id=>!after.blockDetails.some(b=>b.blockId===id&&b.active)))throw Error('既有压缩块状态发生变化，停止后续治理并保留回执');
 for(const r of pending){const b=after.blockDetails.find(b=>b.active&&b.startRef===r.startRef&&b.endRef===r.endRef&&b.summary.startsWith(r.summary));if(b)r.applied={at:Date.now(),blockId:b.blockId};}
 const receipt={at:Date.now(),engine:'billion-context',sessionId,submitted:pending.length,applied:pending.filter(r=>r.applied).length,blocksCreated:result.blocksCreated??0,outcome:result.outcome,existingActiveBlocksPreserved:prior.size,sourceLogsModified:false,modelCalls:0,opaqueRevisionUnavailable:!body.expectedRevision};
 if(receipt.applied<pending.length)plan.hold='partial-or-refused: refresh verified plan before retry';
 fs.writeFileSync(file+'.tmp',JSON.stringify(plan,null,2)+'\n');fs.renameSync(file+'.tmp',file);fs.appendFileSync(receipts,JSON.stringify(receipt)+'\n');return receipt;
}
