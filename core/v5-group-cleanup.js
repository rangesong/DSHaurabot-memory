import {digest} from './v5-store.js';
import {nativePolicyKey} from './v5-native-policy.js';

/** Explicit, resumable operator cleanup; does not change the recurring night schedule. */
export class GroupCleanup {
  constructor(r,{persona,policy,nativePage,vaultPage,allowed=()=>true}={}){Object.assign(this,{r,persona,policy,nativePage,vaultPage,allowed});}
  run({before,action='status'}={}){
    if(!Number.isSafeInteger(before)||before<=0||before>this.r.clock())throw Error('必须指定已经过去的原消息截止时间');
    const r=this.r,persona=this.persona(),key='group-cleanup:'+digest([persona,before]);
    const state=r.store.meta(key,{before,persona,stage:'native',native_cursor:'',vault_cursor:0,staged:0,linked:0,protected:0,skipped:0,applied:0,batches:0});
    if(action==='status')return state;
    if(r.config.W5.group_policy_enabled!==1)throw Error('先启用已验证的群聊策略');
    if(action==='stage'){
      if(state.stage==='ready'||state.stage==='done')return state;
      const native=state.stage==='native',page=(native?this.nativePage:this.vaultPage)({before,after:native?state.native_cursor:state.vault_cursor,limit:200});
      if(!page||!Array.isArray(page.items))throw Error('原生来源分页接口尚未接通');
      r.store.tx(()=>{
        for(const row of page.items){
          if(!/^group:[^\s:]+$/.test(row.chatId??'')||!this.allowed(row)){state.skipped++;continue;}
          const path=native?'memory.fact':'vault.lines',time=native?row.saidAt:row.t;
          if(!Number.isSafeInteger(time)||time<=0||time>=before||row.kind==='gist'){state.skipped++;continue;}
          let scope=r.addScope({persona_id:persona,scope:row.chatId}).id;
          const sources=r.store.sql('SELECT id FROM sources WHERE scope=? AND chat=? AND occurred=? LIMIT 100').all(scope,row.chatId,time);
          const match=sources.map(item=>r.store.getSource(item.id)).find(source=>source?.text===row.text);
          // The shared old vault has no persona column. Retain its exact source in
          // a separate namespace, never as the active persona's learned experience.
          if(!native&&!match){scope=r.addScope({persona_id:'aurabot:history-vault-unattributed',scope:row.chatId},'历史原文 · 未归属人格').id;state.unattributed=(state.unattributed??0)+1;}
          const decision=this.policy.prepare({path,items:[row]}).decisions[0];
          if(!decision||decision.reason==='unverified_source_or_time'){state.skipped++;continue;}
          const keys=[nativePolicyKey(persona,path,row),...(!native?[nativePolicyKey(persona,'memory.tail',row)]:[])];
          let memory=match?r.store.getMemory('raw:'+match.id):null;
          const sourceId='native-retirement:'+digest(keys[0]);
          memory??=r.store.getMemory('raw:'+scope+':'+sourceId);
          if(memory?.layer==='forgotten'){
            for(const k of keys)r.store.setMeta('native-group-retired:'+k,{at:r.clock(),memory_id:memory.id});
            state.linked++;continue;
          }
          if(!memory){
            const receipt=r.ingest({scope,text:String(row.text),role:'document',occurred_at:time,source_id:sourceId,command_id:sourceId,provenance:{kind:'native_group_cleanup',system:'aurabot',upstream_memory_id:row.id,original_message_at:time,speaker_id:String(row.about??row.uid??'aurabot:group-memory')},process:true});
            memory=r.memory(receipt.memory_id);state.staged++;
          }else state.linked++;
          const isProtected=decision.reason==='protected_memory'||decision.reason==='unresolved_intent';
          if(isProtected){if(!['P0','P1'].includes(memory.protection))memory.protection=[0,'core','permanent'].includes(row.tier)?'P0':'P1';memory.protection_reason='保留原生重要等级、未完成跟进或重要来源';state.protected++;}
          memory.attributes.native_policy_keys=[...new Set([...(memory.attributes.native_policy_keys??[]),...keys])];
          r.store.putMemory(memory,null,{history:false});
        }
        if(native){state.native_cursor=page.next_cursor;if(page.done)state.stage='vault';}
        else{state.vault_cursor=page.next_cursor;if(page.done)state.stage='ready';}
        r.store.setMeta(key,state);
      });
      return state;
    }
    if(action!=='apply')throw Error('整理动作不正确');
    if(!['ready','done'].includes(state.stage))throw Error('请先完成来源核对与导入');
    state.scopes??=r.store.scopes().filter(scope=>r.groupLifecycle().enabled(scope.id)).map(scope=>scope.id);state.scope_index??=0;
    const scope=state.scopes[state.scope_index];
    if(!scope){state.stage='done';state.completed_at=r.clock();r.store.setMeta(key,state);return state;}
    const plan=r.retentionPlan({scope,source_before:before,group_only:true});
    if(!plan.items.length){state.scope_results??={};state.scope_results[scope]={blocked:plan.blocked.length};state.scope_index++;if(state.scope_index>=state.scopes.length){state.stage='done';state.completed_at=r.clock();}r.store.setMeta(key,state);return state;}
    const result=r.applyRetention({plan_id:plan.id});state.applied+=result.items.length;state.batches++;state.stage='ready';r.store.setMeta(key,state);
    return {...state,last_batch:result.items.length};
  }
}
