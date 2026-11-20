import {assessContent} from './v5-runtime.js';
import {digest,scopeId} from './v5-store.js';
import {makeGist} from './v5-retention.js';

export const NATIVE_POLICY_VERSION='thinkstar-group-preparation/1';
const group=id=>/^group:[^\s:]+$/.test(id??'');
const rawPath=path=>['memory.tail','memory.cross','memory.backdrop','vault.lines'].includes(path);
// Stable source identity, independent of browsing, summarization or maintenance time.
export const nativePolicyKey=(persona,path,item)=>digest([path.startsWith('vault.')?'aurabot:history-vault-unattributed':persona,path.startsWith('vault.')?'vault':rawPath(path)?'native-row':'native-fact',item.chatId,rawPath(path)?null:item.id??null,item.uid??item.about??item.speaker??null,item.t??item.saidAt??null,item.text]);

/** Filters structured external material; never reads the rubbishmemory or calls a model. */
export class NativeGroupPolicy {
  constructor(runtime,{persona=()=> 'aurabot:default',enabled=()=>true,allowed=()=>true}={}){this.r=runtime;this.persona=persona;this.enabled=enabled;this.allowed=allowed;this.last=new Map();}
  prepare({path='memory.fact',items=[],chat=null,manual=false}={}){
    if(!Array.isArray(items)||items.length>50000)throw Error('原生准备包格式不正确');
    const r=this.r,lifecycle=r.groupLifecycle(),persona=this.persona(),on=this.enabled()&&r.config.W5.group_policy_enabled===1;
    const out=[],decisions=[],counts={kept:0,trace:0,expired:0,protected:0,unknown:0,retired:0,blocked:0};let next=null;
    for(const item of items){
      if(!item||typeof item!=='object')continue;
      const chatId=item.chatId,scope=group(chatId)?scopeId({persona_id:persona,scope:chatId}):null;
      const key=scope?nativePolicyKey(persona,path,item):null;
      let state={phase:'inherited',eligible:true};
      if(scope&&on&&!this.allowed(item))state={phase:'blocked',reason:'no_memory_permission',eligible:false};
      else if(scope&&r.store.meta('native-group-retired:'+key,false))state={phase:'retired',eligible:false};
      else if(scope&&on&&!manual){
        const assessed=assessContent(String(item.text??''),item.role??(rawPath(path)?item.who==='bot'?'assistant':'user':'document'));
        const time=rawPath(path)?item.t:item.saidAt;
        const canonical=Number.isSafeInteger(time)?r.store.sql('SELECT id FROM sources WHERE scope=? AND chat=? AND occurred=? LIMIT 100').all(scope,chatId,time).map(row=>r.store.getSource(row.id)).find(source=>source?.text===item.text):null;
        const original=canonical?r.store.getMemory('raw:'+canonical.id):null;
        const protection=original?lifecycle.resolve(original):null;
        const important=assessed.protection==='P0'||assessed.protection==='P1'||[0,3,'core','permanent'].includes(item.tier)||Number(item.importance)>=.65;
        if(protection?.reason&&protection.reason!=='inactive_record')state={phase:'held',reason:protection.reason,eligible:protection.eligible};
        else if(important)state={phase:'held',reason:'protected_memory',eligible:true};
        else if(item.followUp&&!['completed','cancelled','done'].includes(item.followUp.status))state={phase:'held',reason:'unresolved_intent',eligible:true};
        else if(item.policyOpaque||item.kind==='gist')state={phase:'held',reason:'legacy_aggregate_without_source_alignment',eligible:true};
        else{
          if(!Number.isSafeInteger(time)||time<=0||time>lifecycle.at)state={phase:'held',reason:'unverified_source_or_time',eligible:true};
          else state={...lifecycle.timeDecision(assessed.protection==='P3'?'P3':'P2',time),protection:assessed.protection,eligible:true};
          if(state.phase==='expired')state.eligible=false;
        }
      }
      if(state.next_transition_at!=null)next=next===null?state.next_transition_at:Math.min(next,state.next_transition_at);
      decisions.push({key,scope,id:item.id??null,...state});
      if(!state.eligible){counts[state.phase==='retired'?'retired':state.phase==='expired'?'expired':'blocked']++;continue;}
      if(state.reason){counts[state.reason==='protected_memory'||state.reason==='unresolved_intent'?'protected':'unknown']++;}
      if(state.phase==='trace'){out.push({...item,text:'【记忆残迹，非完整原话】'+makeGist(String(item.text??''),r.config.W5.summary_ratio).body,thinkstar_precision:'extractive_gist'});counts.trace++;}
      else out.push(item);
      counts.kept++;
    }
    const result={version:NATIVE_POLICY_VERSION,enabled:on,applies:on||lifecycle.hasTrash,path,items:out,decisions,counts,next_transition_at:next};
    this.last.set(path,{at:r.clock(),counts,enabled:on});return result;
  }
  status(){return {version:NATIVE_POLICY_VERSION,paths:Object.fromEntries(this.last),rubbishmemory_read:false};}
}
