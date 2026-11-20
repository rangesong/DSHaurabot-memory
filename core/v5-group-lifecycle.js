import { DAY, HANDOFF } from './v5-config.js';
import { makeGist } from './v5-retention.js';
import { digest } from './v5-store.js';

const INHERITED = { applies:false, eligible:true, phase:'inherited' };
const PROTECTED = new Set(['P0','P1']);
const TRACE_ALGORITHM = 'group-extractive-v1';
export const GROUP_PHASE_LABELS={inherited:'继承原有策略',recent:'完整近期',related:'按相关性召回',trace:'残迹召回',expired:'已到期，待移入废弃库',retired:'来源已移入废弃库',retired_sources:'部分来源已移入废弃库',held:'保护或暂缓'};
export const GROUP_HOLD_LABELS={protected_memory:'重要或明确保护的记忆',protected_source:'重要记忆仍依赖该来源',unresolved_intent:'事项尚未完成或取消',handoff_pending:'交接尚未完成',model_handoff_pending:'模型处理仍在交接',unknown_protection:'保护等级尚不能确认',source_scope_mismatch:'来源不属于同一人格或聊天',unverified_source_or_time:'来源或原始时间无法安全确认',inactive_record:'已删除、撤回或退出原有活跃层'};
// Only the deterministic, content-free grouping scaffold is projected source by source.
// Explicit P0 protection, a corrected bundle or a semantically written experience is never exempted.
export const automaticGroupExperience = memory => memory.kind==='experience'&&memory.protection!=='P0'
  &&memory.source_refs.length>1&&memory.attributes.grouping_basis==='explicit_topic_or_local_state'
  &&memory.attributes.semantic_validation==='not_connected'&&!memory.attributes.correction_source
  &&/^经历包含 \d+ 个有序来源跨度；未明确说明的起因和结果保持未知。$/.test(memory.body??'');
const groupScope = value => /^group:[^\s:]+$/.test(value??'');
const stamp = (value,at) => Number.isSafeInteger(value)&&value>0&&value<=at;

export const GROUP_POLICY_COVERAGE = {
  thinkstar:'covered',
  native_memory:'uncovered_unstructured_recall',
  history_vault:'uncovered_independent_injection',
};

/** A new view per preparation/preview. Never caches eligibility across turns or config updates. */
export class GroupLifecycle {
  constructor(runtime,at=runtime.clock()){
    this.r=runtime;
    this.at=at;
    this.config=runtime.config.W5;
    this.version=runtime.configVersion;
    this.scopes=new Map();
    this.protected=new Map();
    this.headers=new Map();
    this.decisions=new Map();
    this.gists=new Map();
    this.hasTrash=runtime.groupTrashPresent??=runtime.store.meta('group-trash-present',false);
  }

  scopeInfo(scope){if(!this.scopes.has(scope))this.scopes.set(scope,this.r.store.getScope(scope));return this.scopes.get(scope);}
  enabled(scope){
    if(this.config.group_policy_enabled!==1)return false;
    return groupScope(this.scopeInfo(scope)?.native_scope);
  }
  constrains(scope){return this.enabled(scope)||this.hasTrash&&groupScope(this.scopeInfo(scope)?.native_scope);}

  header(id){
    if(!this.headers.has(id))this.headers.set(id,this.r.store.sql(
      "SELECT s.scope,s.chat AS chat_id,s.occurred,s.json IS NOT NULL AS hot,s.json IS NOT NULL OR s.packed IS NOT NULL AS available,raw.layer AS raw_layer,json_extract(raw.json,'$.attributes.group_retirement.at') AS retired_at,json_extract(raw.json,'$.attributes.group_retirement.source_time') AS retired_source_time,coalesce(json_extract(s.json,'$.recorded_at'),json_extract(raw.json,'$.created_at')) AS recorded FROM sources s LEFT JOIN memories raw ON raw.id='raw:'||s.id WHERE s.id=?"
    ).get(id));
    return this.headers.get(id);
  }

  retiredSource(id){const header=this.hasTrash?this.header(id):null;return header?.raw_layer==='forgotten'&&header.retired_at!=null;}
  retiredRefs(memory){return this.hasTrash&&groupScope(this.scopeInfo(memory.scope)?.native_scope)?memory.source_refs.filter(id=>this.retiredSource(id)):[];}
  needsProjection(memory){return this.enabled(memory.scope)||this.retiredRefs(memory).length>0;}

  sourceDate(id,scope){
    const row=this.header(id);
    if(!row||row.scope!==scope.id||row.chat_id!==scope.native_scope)return null;
    if(this.retiredSource(id)&&stamp(row.retired_source_time,this.at))return {at:row.retired_source_time};
    if(!row.available)return null;
    // Existing imported summaries and mirrored native reports can lack original-message alignment.
    const derivedReport=/(?:^|:)src:aurabot:legacy-|:builtin_memory_api:/.test(id);
    if(!derivedReport&&stamp(row.occurred,row.recorded))return {at:row.occurred};
    const source=this.r.store.getSource(id);
    const firstRecorded=source?.recorded_at??row.recorded;
    if(!derivedReport&&stamp(row.occurred,firstRecorded))return {at:row.occurred};
    if(derivedReport&&stamp(source?.provenance?.original_message_at,firstRecorded))return {at:source.provenance.original_message_at};
    if(derivedReport&&source?.provenance?.kind!=='builtin_memory_api')return null;
    return stamp(firstRecorded,this.at)
      ?{at:firstRecorded,fallback:row.occurred==null?'missing_original_time':'untrusted_original_time'}
      :null;
  }

  sourceProtected(scope,id){
    if(!this.protected.has(scope)){
      const revision=this.r.store.protectionRevision??0;
      const cache=this.r.groupProtectionCache??={revision,scopes:new Map(),refs:0};
      if(cache.revision!==revision){cache.revision=revision;cache.scopes.clear();cache.refs=0;}
      if(!cache.scopes.has(scope)){
        const refs=this.r.protectedSources(scope,{currentOnly:true});
        // Large protection bundles remain correct, but are not kept between preparations.
        if(refs.size<=40000){
          while(cache.scopes.size&&(cache.scopes.size>=8||cache.refs+refs.size>40000)){
            const first=cache.scopes.keys().next().value;cache.refs-=cache.scopes.get(first).size;cache.scopes.delete(first);
          }
          cache.scopes.set(scope,refs);cache.refs+=refs.size;
        }
        this.protected.set(scope,refs);
      }else this.protected.set(scope,cache.scopes.get(scope));
    }
    return this.protected.get(scope).has(id);
  }

  resolve(memory){
    if(!this.needsProjection(memory))return INHERITED;
    if(this.decisions.has(memory.id))return this.decisions.get(memory.id);
    const decision=this.evaluate(memory);
    decision.phase_label=GROUP_PHASE_LABELS[decision.phase];
    if(decision.reason)decision.reason_label=GROUP_HOLD_LABELS[decision.reason]??decision.reason;
    this.decisions.set(memory.id,decision);
    return decision;
  }

  evaluate(memory){
    const result={applies:true,eligible:true,phase:'held',version:this.version};
    const hold=reason=>({...result,reason});
    if(memory.validity!=='current'||memory.layer==='forgotten'||memory.review==='invalid'){
      return {...hold('inactive_record'),eligible:false};
    }
    const allRefs=[...new Set([...memory.source_refs,...(memory.attributes.counterexamples??[])])];
    const scope=this.scopeInfo(memory.scope),retired=allRefs.filter(id=>this.retiredSource(id)),refs=allRefs.filter(id=>!this.retiredSource(id));
    if(refs.some(id=>{const row=this.header(id);return row&&(row.scope!==scope.id||row.chat_id!==scope.native_scope);}))return {...hold('source_scope_mismatch'),eligible:false};
    const grouped=automaticGroupExperience(memory),aggregate=grouped||memory.kind==='archive_digest';
    if(PROTECTED.has(memory.protection)&&!grouped)return hold('protected_memory');
    if(memory.kind==='intent'&&!['completed','cancelled'].includes(memory.attributes.status))return hold('unresolved_intent');
    if(!PROTECTED.has(memory.protection)&&!['P2','P3'].includes(memory.protection))return hold('unknown_protection');
    if(memory.attributes.model_processing)return hold('model_handoff_pending');
    if(memory.handoff!==HANDOFF.at(-1))return hold('handoff_pending');
    if(!aggregate&&refs.some(id=>this.sourceProtected(memory.scope,id)))return hold('protected_source');
    if(retired.length&&!refs.length)return {...result,phase:'retired',eligible:false,retired_source_refs:retired};
    if(retired.length&&!this.enabled(memory.scope))return {...result,phase:'retired_sources',retired_source_refs:retired};
    const dates=refs.map(id=>this.sourceDate(id,scope));
    if(!dates.length||dates.some(date=>!date))return hold('unverified_source_or_time');
    const sourceTime=dates.reduce((latest,date)=>Math.max(latest,date.at),0);
    return {...result,...this.timeDecision(memory.protection,sourceTime),fallback_reasons:[...new Set(dates.flatMap(date=>date.fallback?[date.fallback]:[]))]};
  }

  timeDecision(protection,sourceTime){
    const age=Math.max(0,this.at-sourceTime);
    const exitDays=protection==='P3'?this.config.group_low_value_exit_days:this.config.group_ordinary_trace_exit_days;
    const phase=age>=exitDays*DAY?'expired':age>=this.config.group_trace_after_days*DAY?'trace':age>=this.config.group_recent_days*DAY?'related':'recent';
    const nextDays=phase==='recent'?this.config.group_recent_days:phase==='related'?this.config.group_trace_after_days:phase==='trace'?exitDays:null;
    return {phase,eligible:phase!=='expired',age,source_time:sourceTime,exit_at:sourceTime+exitDays*DAY,next_transition_at:nextDays===null?null:sourceTime+nextDays*DAY};
  }

  sourceFull(source,{recent=false}={}){
    if(!source)return false;
    if(this.retiredSource(source.id))return false;
    if(!this.enabled(source.scope))return true;
    const raw=this.r.store.getMemory('raw:'+source.id);
    if(!raw)return false;
    const state=this.resolve(raw);
    if(!state.eligible||state.phase==='trace')return false;
    if(!recent)return true;
    return state.phase==='recent'||['protected_memory','protected_source','unresolved_intent','handoff_pending','model_handoff_pending'].includes(state.reason);
  }

  trace(memory,text){
    const key=digest([TRACE_ALGORITHM,this.config.summary_ratio,text]);
    const saved=memory.attributes.group_trace;
    if(saved?.fingerprint===key)return saved;
    if(!this.gists.has(key))this.gists.set(key,{fingerprint:key,body:makeGist(text,this.config.summary_ratio).body});
    return this.gists.get(key);
  }

  /** Project stored material at the actual preparation boundary, including mixed-source objects. */
  project(memory,{recentOnly=false,onDemand=false}={}){
    const state=onDemand?{applies:true,eligible:memory.layer!=='forgotten',phase:'on_demand',version:this.version}:this.resolve(memory);
    if(!state.eligible)return null;
    const runtime=this.r;
    const original=()=>({get text(){return runtime.body(memory);},refs:memory.source_refs,precision:memory.storage,projected:false,state});
    if(!state.applies)return original();
    if(recentOnly&&['related','trace'].includes(state.phase))return null;
    const retired=this.retiredRefs(memory);
    if(state.phase==='held'&&state.reason!=='protected_source'&&!retired.length)return original();

    if(memory.kind==='raw'&&state.phase!=='trace')return original();
    const rawRefs=memory.kind==='raw'?[memory]:memory.source_refs.map(id=>this.r.store.getMemory('raw:'+id));
    const parts=rawRefs.map((raw,index)=>({raw,id:memory.source_refs[index],state:raw?this.resolve(raw):null}));
    const mixed=retired.length||parts.some(part=>part.state&&(!part.state.eligible||part.state.phase==='trace'));
    if(state.phase!=='trace'&&!mixed)return original();
    const usable=parts.filter(part=>!this.retiredSource(part.id)&&(onDemand||part.state?.eligible!==false));
    const texts=[];
    const refs=[];
    for(const part of usable){
      const source=this.r.store.getSource(part.id);
      if(!source)continue;
      const asTrace=!onDemand&&(state.phase==='trace'||part.state?.phase==='trace');
      texts.push(asTrace?this.trace(part.raw??memory,source.text).body:source.text);
      refs.push(part.id);
    }
    if(!refs.length)return null;
    return {text:texts.join('\n'),refs,precision:'gist_with_evidence',projected:true,state};
  }

  accepts(item,scope){
    const memory=this.r.store.getMemory(item.id);
    if(!this.enabled(scope))return !memory||!this.retiredRefs(memory).length;
    return !!memory&&memory.scope===scope&&this.resolve(memory).eligible&&this.resolve(memory).phase===item.lifecycle_phase;
  }

  action(memory,state=this.resolve(memory)){
    if(!this.enabled(memory.scope))return null;
    if((!['P0','P1'].includes(memory.protection)||automaticGroupExperience(memory))&&!memory.kind.startsWith('archive_')
        &&(state.phase==='expired'&&memory.kind==='raw'||state.phase==='retired'))return {
      id:memory.id,scope:memory.scope,action:'group_trash',target:'forgotten',revision:memory.revision,group_phase:state.phase,source_time:state.source_time,
      reason:'普通群聊达到专用期限，移入按年月保存的废弃记忆库'};
    if(memory.kind!=='raw'||!['related','trace','expired'].includes(state.phase))return null;
    const layer=state.phase==='related'?'warm':'faint';
    const hot=this.header(memory.source_refs[0])?.hot;
    const stored=memory.attributes.group_lifecycle;
    const traceReady=memory.attributes.group_trace?.ratio===this.config.summary_ratio&&memory.attributes.group_trace?.algorithm===TRACE_ALGORITHM;
    if(!hot&&memory.layer===layer&&stored?.phase===state.phase&&stored?.source_time===state.source_time&&(state.phase!=='trace'||traceReady))return null;
    return {id:memory.id,scope:memory.scope,action:'group_archive',target:layer,revision:memory.revision,group_phase:state.phase,source_time:state.source_time,
      reason:state.phase==='related'?'群聊原文无损冷存':'群聊残迹与冷档整理'};
  }

  archive(memory,state=this.resolve(memory)){
    const id=memory.source_refs[0];
    if(state.phase==='trace'){
      const source=this.r.store.getSource(id);
      memory.attributes.group_trace={...this.trace(memory,source.text),ratio:this.config.summary_ratio,algorithm:TRACE_ALGORITHM};
    }
    memory.attributes.group_lifecycle={phase:state.phase,eligible:state.eligible,source_time:state.source_time,policy_version:this.version,fallback_reasons:state.fallback_reasons};
    memory.layer=state.phase==='related'?'warm':'faint';
    memory.storage='lossless_cold';
    memory.updated_at=this.at;
    this.r.store.putMemory(memory,null,{history:false});
    this.r.store.packSource(id);
  }
}
