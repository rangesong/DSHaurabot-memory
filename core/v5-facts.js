import { digest } from './v5-store.js';
const fail=message=>{throw Object.assign(new Error(message),{code:'REVISION_CONFLICT'});};
const keyOf=(scope,subject,field)=>'fact-current:'+digest([scope,subject,field]);
export function factIndex(r,{scope}={}){
  r.requireScope(scope);return {scope,items:r.store.sql("SELECT json FROM meta WHERE key LIKE 'fact-current:%'").all().map(row=>JSON.parse(row.json)).filter(row=>row.scope===scope).map(row=>({...row,memory:r.store.getMemory(row.id)})).filter(row=>row.memory?.validity==='current'&&row.memory.layer!=='forgotten').map(({memory,...row})=>({...row,text:r.body(memory),revision:memory.revision}))};
}
/** Called only by the trusted operator panel. Model tools cannot supersede a fact. */
export function writeFact(r,{scope,source_id,quote,field,expected_id=null,expected_revision=null,reason}={}){
  r.requireScope(scope);if(typeof field!=='string'||!/^\p{L}[\p{L}\p{N}_.:-]{1,63}$/u.test(field)||!reason?.trim())fail('请填写对象无关的事实字段和变更理由，例如 budget.limit；字段中不要写具体值');
  const source=r.store.getSource(source_id);if(!source||source.scope!==scope||source.role!=='user')fail('事实更新必须有同范围的用户原话');
  const subject=source.speaker_id,key=keyOf(scope,subject,field),before=r.store.meta(key),old=before?r.store.getMemory(before.id):null;
  if((old?.id??null)!==expected_id||(old&&old.revision!==expected_revision))fail('当前事实已经改变，请刷新事实列表后重试');
  if(source.occurred_at===null||old?.occurred_at!==null&&old&&source.occurred_at<old.occurred_at)fail('时间未知或早于现行事实；请作为历史原话保留，不覆盖现行值');
  if(typeof quote!=='string'||quote.length<3||!source.text.includes(quote))fail('请逐字引用仍存在的用户原话');
  const memoryId='fact:'+digest([scope,subject,field,source_id,quote]);
  if(old?.id===memoryId)return {memory:old,cached:true};
  const parent=r.memory('raw:'+source_id,scope);let memory;
  r.store.tx(()=>{memory=r.derive(parent,{id:memoryId,kind:'claim',body:quote,label:quote.slice(0,44),source_refs:[source_id],source_roots:[source.support_root],protection:parent.protection==='P0'?'P0':'P1',protection_reason:'人工确认的可更新事实；来源保留',review:'ready',representation:['exact_claim'],evidence:{origin:'direct_statement',alignment:'exact_quote_aligned',truth:'source_report'},attributes:{subject,quote,explicit_remember:true}});
    if(old){const revision=old.revision;old.validity='superseded';old.revision++;old.updated_at=r.clock();r.store.putMemory(old);r.invalidateDependents(old.id,revision);for(const sourceId of old.source_refs){const raw=r.store.getMemory('raw:'+sourceId);if(raw){raw.attributes.superseded_fact_fields=[...new Set([...(raw.attributes.superseded_fact_fields??[]),field])];r.store.putMemory(raw,null,{history:false});}}}
    memory.attributes.fact_key={subject,field,previous_id:old?.id??null,confirmed_by:'local_operator',reason};memory.validity='current';memory.revision++;memory.updated_at=r.clock();r.store.putMemory(memory);
    r.store.setMeta(key,{scope,subject,field,id:memory.id});
  });
  const run=r.beginRun(scope,'fact_update');r.event(run,'W2','W5','核对事实键与原话，旧值留作历史',{output:[memory.id],extra:{previous_id:old?.id??null}});r.event(run,'W5','U','提交有来源的现行事实版本',{output:[memory.id]});r.endRun(run);r.rebuildCatalogs(scope);
  return {memory,previous_id:old?.id??null,run_id:run.id};
}
export function restoreFact(r,{scope,id,expected_revision,reason}={}){
  const current=r.memory(id,scope),fact=current.attributes.fact_key;
  if(!fact||!fact.previous_id||!reason?.trim())fail('没有可恢复的上一个事实版本，或缺少恢复理由');
  const key=keyOf(scope,fact.subject,fact.field),pointer=r.store.meta(key),previous=r.store.getMemory(fact.previous_id);
  if(pointer?.id!==id||current.revision!==expected_revision||!previous||previous.validity==='withdrawn'||!previous.source_refs.every(id=>r.store.getSource(id)))fail('事实已改变或旧证据已删除，不能恢复');
  r.store.tx(()=>{const revision=current.revision;current.validity='superseded';current.revision++;r.store.putMemory(current);r.invalidateDependents(current.id,revision);previous.validity='current';previous.revision++;previous.updated_at=r.clock();r.store.putMemory(previous);for(const [m,retired]of [[current,true],[previous,false]])for(const sourceId of m.source_refs){const raw=r.store.getMemory('raw:'+sourceId);if(raw){const fields=(raw.attributes.superseded_fact_fields??[]).filter(field=>field!==fact.field);raw.attributes.superseded_fact_fields=retired?[...fields,fact.field]:fields;r.store.putMemory(raw,null,{history:false});}}r.store.setMeta(key,{scope,subject:fact.subject,field:fact.field,id:previous.id});});
  const run=r.beginRun(scope,'fact_restore');r.event(run,'W5','U','撤回事实更新，恢复有原文的前一版本',{output:[previous.id],extra:{reason}});r.endRun(run);r.rebuildCatalogs(scope);return {memory:previous,run_id:run.id};
}
