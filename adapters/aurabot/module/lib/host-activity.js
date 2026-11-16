import {digest,scopeId} from '../../../../core/v5-store.js';

/** Read-only lifecycle observations, restricted to Aurabot-owned sessions. */
export function observeHostActivity(api,{runtime,active,allowedChat,persona}){
  const pending=new Map(),bound=new Map(),answers=new Map(),off=[];
  const chatFor=id=>{try{if(api.core?.hub?.isOwnedSession?.(id)!==true)return null;const chatId=api.core.hub.chatOfSession(id);return allowedChat(chatId)?chatId:null;}catch{return null;}};
  try{
    if(typeof api.dsh?.on!=='function')return ()=>{};
    off.push(api.dsh.on('tools/pre-execute',(exec,next)=>{
      try{const sessionId=exec?.agent?.session?.id,chatId=chatFor(sessionId);if(active()&&chatId&&exec.callId){const scope=scopeId({persona_id:persona(),scope:chatId}),id='tool:'+digest([sessionId,exec.callId]);
        pending.set(sessionId+'|'+exec.callId,{id,scope,at:Date.now(),tool:exec.name,persona:persona()});while(pending.size>256)pending.delete(pending.keys().next().value);
        runtime.dialogue.activity({id,scope,category:'tool',title:'调用工具：'+String(exec.name),status:'started',detail:{session_id:sessionId,call_id:exec.callId,tool:exec.name}});
      }}catch{}return next();
    }));
    off.push(api.dsh.on('session/event',(session,event)=>{
      try{if(!active())return;const sessionId=session?.id,chatId=chatFor(sessionId);if(!chatId)return;
        const data=event?.data??{},scope=scopeId({persona_id:persona(),scope:chatId}),at=Number.isSafeInteger(event.time)?event.time:Number.isSafeInteger(event.timestamp)?event.timestamp:Date.now();
        if(event.type==='turn/start'){const dialogue=runtime.dialogue.bindHostTurn({scope,session_id:sessionId,host_turn_id:data.turn,at});bound.set(sessionId,{scope,persona:persona(),host_turn_id:data.turn,dialogue_id:dialogue?.id??null,id:'turn:'+digest([sessionId,data.turn??at])});while(bound.size>64)bound.delete(bound.keys().next().value);runtime.dialogue.activity({id:bound.get(sessionId).id,scope,category:'task',title:'开始处理本轮对话',status:'started',at,detail:{session_id:sessionId}});}
        if(event.type==='assistant/message'&&!data.interrupted){const text=(data.message?.content??[]).filter(b=>b.type==='text'&&typeof b.text==='string').map(b=>b.text).join('\n');answers.set(sessionId,{text,turn:data.turn,persona:persona()});while(answers.size>64)answers.delete(answers.keys().next().value);}
        const lifecycle=bound.get(sessionId);
        if(event.type==='turn/end'){const current=lifecycle;if(current&&current.persona===persona()){const status=data.error?'failed':data.reason?.kind==='completed'?'completed':data.reason?.kind==='cancelled'?'cancelled':'ended_unknown';runtime.dialogue.activity({id:current.id,scope:current.scope,category:'task',title:status==='failed'?'本轮处理失败':'本轮处理结束',status,at,detail:{session_id:sessionId,delivery:'not_a_qq_delivery_receipt'}});}bound.delete(sessionId);}
        if(event.type==='turn/end'&&data.reason?.kind==='completed'){
          const answer=answers.get(sessionId);answers.delete(sessionId);if(!answer?.text||answer.persona!==persona()||answer.turn!==data.turn)return;
          if(!lifecycle?.dialogue_id||lifecycle.persona!==persona()||lifecycle.host_turn_id!==data.turn)return;
          const turn=runtime.dialogue.get('dialogue_turns',lifecycle.dialogue_id);if(!runtime.dialogue.validTurn(turn)||turn.scope!==scope||turn.host_turn_id!==String(data.turn))return;
          let sourceId=turn.reply===answer.text?turn.reply_source_id:null;
          if(!sourceId){const key='session-reply:'+digest([sessionId,data.turn,answer.text]);sourceId=runtime.ingest({scope,text:answer.text,role:'assistant',command_id:key,source_id:key,provenance:{system:'aurabot',kind:'host_model_reply',speaker_id:'aurabot:bot',delivery_evidence:'completed_session_output_not_delivery'}}).source_id;}
          runtime.dialogue.observeReply({scope,text:answer.text,source_id:sourceId,turn_id:turn.id,session_id:sessionId,host_turn_id:data.turn,binding_verified:true,stage:'completed_session_output_not_delivery',at});
        }
        if(event.type==='tool/result'){
          const message=data.message??{},callId=String(data.callId??message.toolCallId??message.source?.callId??''),key=sessionId+'|'+callId,prior=pending.get(key);if(!prior||prior.persona!==persona())return;
          const failed=!!data.error||message.isError===true;runtime.dialogue.activity({id:prior.id,scope:prior.scope,category:'tool',title:'工具'+(failed?'失败：':'返回：')+prior.tool,status:failed?'failed':'result_observed',at,detail:{session_id:sessionId,call_id:callId,tool:prior.tool,duration_ms:Math.max(0,at-prior.at),result:'宿主已提供结果；不据此推断整个任务成功'}});pending.delete(key);
        }
      }catch{}
    }));
  }catch{}
  return ()=>{for(const remove of off)try{remove?.();}catch{}pending.clear();bound.clear();answers.clear();};
}
