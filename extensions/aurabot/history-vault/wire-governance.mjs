import {createHash} from 'node:crypto';
import {ownedRanges,legacyVaultBlock} from './context-dedup.mjs';
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const readonlyTool=n=>/^(?:thinkstar_(?:history|recall)|recall_history|fish_world_state|mcp__[^ ]+__(?:get|read|list|find|search|fetch|snapshot|screenshot|world_now|world_profile|world_history|world_find|world_guide)(?:$|\b))/.test(n||'');
export function planWireGovernance({messages,rawMessages=messages,state,sourceEvents,scope,files=[],retainTurns=8,settings={}}){
 const {chatId,persona,sessionId}=scope,proofs=new Map(),imagesById=new Map(),callProofs=new Map(),sourceTurns=new Map();let turn=0;
 const done=new Set(sourceEvents.filter(e=>e.type==='turn/end'&&e.data.reason?.kind==='completed').map(e=>e.data.turn)),protectedTurns=new Set([...done].slice(-Math.max(4,retainTurns)));
 for(const e of sourceEvents){if(e.type==='turn/start')turn=e.data.turn;sourceTurns.set(e.seq,e.data?.turn??turn);}
 const latest=sourceEvents.filter(e=>e.type==='user/message'&&e.data.source?.kind==='aurabot').slice(-2).flatMap(e=>e.data.content.filter(b=>b.type==='text'&&/^【私聊(?:】| · )/.test(b.text)).map(b=>b.text)).join('\n'),pinImages=/(?:对比|比较).{0,24}(?:图|截图|照片)|(?:图|截图|照片).{0,24}(?:对比|比较)|识字|OCR|坐标|多图|(?:上面|上一张|之前).{0,16}(?:图|截图|照片)|(?:compare|coordinate).{0,24}(?:image|screenshot)/i.test(latest);
 for(const file of files){for(const id of [file.attachmentId,file.variantId])if(id){const rows=imagesById.get(file.fileId)||[];rows.push(id);imagesById.set(file.fileId,rows);}}
 const attachments=new Map();
 for(const e of sourceEvents){const m=e.type==='user/message'?e.data:e.data?.message;if(!m)continue;
  if(e.type==='assistant/message')for(const c of m.content.filter(b=>b.type==='tool-call'))callProofs.set(c.id,{event:e,call:c,turn:sourceTurns.get(e.seq)});
  if(e.type==='tool/result'){const p=callProofs.get(m.toolCallId);if(p)p.result={event:e,message:m};}
  if(e.type!=='user/message')continue;
  const framedOwner=m.content.some(b=>b.type==='text'&&/^【私聊(?:】| · )/.test(b.text)&&b.text.split('\n')[0].includes('('+chatId.slice(8)+')'));
  const isSnapshot=m.source?.kind==='runtime-context'&&m.source.form==='snapshot',isOwner=m.source?.kind==='aurabot'&&(m.source.speaker?m.source.speaker.role==='owner'&&m.source.speaker.chat==='private':framedOwner);
  for(let i=0;i<m.content.length;i++){const b=m.content[i];if(b.type==='image'&&isOwner){const key=b.attachment?.attachmentId;if(key){const a=attachments.get(key)||[];a.push({event:e,block:b,turn:sourceTurns.get(e.seq),eligible:done.has(sourceTurns.get(e.seq))&&!protectedTurns.has(sourceTurns.get(e.seq))});attachments.set(key,a);}}
   if(b.type!=='text')continue;const k=hash(b.text),rows=proofs.get(k)||[];
   if(isSnapshot&&m.source.sections?.some(s=>s.name==='aurabot-context'))rows.push({kind:'snapshot',event:e,sections:m.source.sections.filter(s=>s.name==='aurabot-context')});
   else if(isOwner&&legacyVaultBlock(m,i,chatId))rows.push({kind:'vault',event:e});
   else if(isOwner&&/^【私聊(?:】| · )/.test(b.text))rows.push({kind:'owner-body',event:e});
   if(rows.length)proofs.set(k,rows);
  }
 }
 const carrierSources=new Map();for(const m of rawMessages){const owners=(proofs.get(hash(m.text||''))||[]).filter(p=>p.kind==='owner-body');if(owners.length){const seen=carrierSources.get(m.wireIndex)||new Set();owners.forEach(p=>seen.add(p.event.seq));carrierSources.set(m.wireIndex,seen);}}
 const seenMemo=new Map(),seenImages=new Map(),seenTools=new Map(),ranges=[],stats={memoBlocks:0,imageBlocks:0,toolPairs:0,sourceEvents:sourceEvents.length,pinImages,uniqueToolResultsPreserved:true};
 const refs=state.messageRefs.byRaw;
 const proof=m=>({ref:refs[m.id],role:m.role,textSha256:hash(m.text||''),rawId:m.id,imageHash:m.imagePart?hash(m.rawAnthropicBlock):null});
 const add=(ms,summary,kind,anchorRef)=>{if(ms.some(m=>!/^m\d+$/.test(refs[m.id]||'')))return;const originalChars=ms.reduce((n,m)=>n+(m.text?.length||0),0);if(kind!=='image'&&originalChars<summary.length+64)return;ranges.push({startRef:refs[ms[0].id],endRef:refs[ms.at(-1).id],summary,kind,anchorRef,proof:ms.map(proof)});};
 for(let i=0;i<messages.length;i++){
  const m=messages[i];if(m.id?.startsWith('acp_summary_'))continue;
  if(settings.memo!==false&&m.role==='user'&&!m.imagePart){const owners=proofs.get(hash(m.text||''))||[];
   if(owners.some(p=>p.kind==='snapshot')){let summary=m.text,removed=0;const sections=owners.find(p=>p.kind==='snapshot').sections;
    for(const s of sections)for(const span of ownedRanges(s.text)){const k=hash([persona,chatId,sessionId,'runtime-context',s.name,span.producer,span.version,m.role,span.text]),first=seenMemo.get(k);if(!first){seenMemo.set(k,refs[m.id]);continue;}const replacement='〔同来源同版本资料沿用 '+first+'〕';if(summary.includes(span.text)&&span.text.length>replacement.length+32){summary=summary.replace(span.text,replacement);removed++;}}
    if(removed){add([m],summary,'memo');stats.memoBlocks+=removed;}
   }else if(owners.some(p=>p.kind==='vault')){const k=hash([persona,chatId,sessionId,'history-vault','memo/1',m.role,m.text]),first=seenMemo.get(k);if(!first)seenMemo.set(k,refs[m.id]);else{add([m],'同一人格同一私聊的精确重复历史备忘，完整同版本资料保留于 '+first+'。原始备忘仍可通过 decompress 或 context_evidence_read 查回。','memo',first);stats.memoBlocks++;}}
  }
  if(settings.images!==false&&m.imagePart&&m.role==='user'){
   const fid=m.rawAnthropicBlock?.source?.file_id,keys=imagesById.get(fid)||[],carrier=carrierSources.get(m.wireIndex),sources=keys.flatMap(k=>attachments.get(k)||[]).filter(s=>!carrier||carrier.has(s.event.seq)),variants=new Set(sources.map(s=>hash(s.block)));
   if(!fid||!sources.length||variants.size!==1)continue;
   const key=hash([persona,chatId,sessionId,m.role,m.rawAnthropicBlock,[...variants][0]]),first=seenImages.get(key);
   if(!first){seenImages.set(key,refs[m.id]);continue;}if(pinImages||sources.some(s=>!s.eligible))continue;
   const seq=sources[0].event.seq;add([m],`此图片是同一原文件和同一变体的重复引用，完整图片保留于 ${first}；本条伴随文字仍在原处。原始附件 ${[...new Set(keys)].join(',')}；需要精确识图时用 context_evidence_read(sessionId="${sessionId}",seq=${seq},images=true) 恢复，不按此条猜测图中文字。`,'image',first);stats.imageBlocks++;
  }
  if(settings.tools!==false&&m.contentType==='tool-call'&&readonlyTool(m.toolName)){
   const r=messages[i+1],p=callProofs.get(m.toolCallId);if(!p?.result||r?.contentType!=='tool-result'||r.toolCallId!==m.toolCallId||p.result.message.isError||/timeout|timed out|未确认|ECONNRESET/i.test(r.text||''))continue;
   const k=hash([persona,chatId,sessionId,m.toolName,m.text,r.text,r.role]),first=seenTools.get(k);if(!first){seenTools.set(k,refs[m.id]);continue;}if(!done.has(p.turn)||protectedTurns.has(p.turn))continue;
   add([m,r],`已完成且已消费的相同只读工具 ${m.toolName}，状态=成功。完整参数与所有精确结果同 ${first}（内容哈希 ${k}）。原始调用与回执一并保存在原日志，context_evidence_read(sessionId="${sessionId}",seq=${p.event.seq},after=${p.result.event.seq-p.event.seq}) 可展开。不要将历史过程当作再次调用的授权。`,'tool',first);stats.toolPairs++;
  }
 }
 return {schema:1,kind:'verified-existing-engine-plan',scope:{sessionId,chatId,persona},createdAt:Date.now(),ranges,stats,sourceLogsPreserved:true,extraModelCalls:0};
}
