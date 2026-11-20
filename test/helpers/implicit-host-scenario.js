import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';

/** Reusable pre/post-deployment proof: the real adapter and engine, a synthetic host and provider. */
export async function implicitHostScenario({V5Runtime,startThinkstar,scratch}){
 const folder=fs.mkdtempSync(path.join(scratch,'implicit-host-')),file=path.join(folder,'memory.sqlite'),DAY=86400000,clock={at:Math.floor((Date.now()+8*3600000)/DAY)*DAY-8*3600000-4*DAY+2*3600000};
 const r=new V5Runtime({file,clock:()=>clock.at}),scope=r.addScope({persona_id:'aurabot:alpha',scope:'private:100'}).id;let n=0,ruleId;
 const add=(text,role='user')=>r.ingest({scope,text,role,source_id:'host-proof:'+ ++n,command_id:'host-proof:'+n,occurred_at:clock.at,provenance:{speaker_id:role==='user'?'100':'bot'},process:true});
 try{
  for(let i=0;i<3;i++){
   const input=add('今天有点累'),q=r.query({scope,query:'今天有点累'});q.host_context_ids=q.context.map(m=>m.id);q.dialogue_strategy=r.dialogue.strategy(scope,'今天有点累');r.dialogue.prepared(q,{sessionId:'training:'+i,chatId:'private:100',input_source_ids:[input.source_id]});clock.at+=1000;
   const output=add('我在这里，慢慢来。','assistant');r.dialogue.observeReply({scope,turn_id:q.id,text:'我在这里，慢慢来。',source_id:output.source_id,at:clock.at,message_id:'reply:'+i,stage:'observed_host_activity'});clock.at+=1000;
   const row=r.dialogue.onUser({source_id:add('摸摸头').source_id});await r.dialogue.reflect({model:'synthetic',status:()=>({configured:true}),json:async()=>({value:{items:[{id:row.id,is_feedback:true,meaning:'affection',reason:'合成语境中的亲近表达'}]}})},{force:true});clock.at+=DAY;
  }
  assert.equal(r.dialogue.consolidate().maturation.promoted,1);ruleId=r.store.all(scope).find(m=>m.layer==='implicit').id;
  r.updateConfig({region:'W2',values:{rerank_enabled:1},expected_version:r.configVersion});
 }finally{r.close();}
 const events=new Map(),observers=new Map(),routes=new Map(),requests=[],settings={mode:'active',masterEnabled:true,contextTokens:1536,allowHostModel:true,captureGroups:false},chat={kind:'private',chatId:'private:100',userId:'100'};
 const config={debug:false,ownerQQ:'100',persona:{current:'alpha'},model:{}},dsh={get:()=>null,on:(name,fn)=>{observers.set(name,fn);return()=>observers.delete(name);}};
 const api={apiVersion:1,dir:folder,dsh,config:()=>config,settings:()=>settings,isOwner:id=>id==='100',dataDir:(...parts)=>path.join(folder,...parts),has:()=>true,use:id=>id==='memory'?{remembers:()=>true}:null,
  log:{info(){},warn(){}},onDispose(){},rule(){},context(){},tool(){},defineTool:x=>x,ask:async()=>JSON.stringify({ids:[]}),send:()=>assert.fail('No QQ sending'),on:(name,fn)=>{events.set(name,fn);return()=>events.delete(name);},every:()=>()=>{},route:(name,fn,options)=>{routes.set(name,{fn,options});return()=>routes.delete(name);}};
 const module=await startThinkstar(api);
 const request=async(query,session)=>{
  const content=await events.get('prompt')([{type:'text',text:query}],{chat,sessionId:session,queryText:query,recentMessages:[],archiveMessages:[]});
  const req={provider:'synthetic',model:'synthetic',sessionId:session,messages:[{role:'user',source:{kind:'aurabot'},content}]};requests.push(req);
  let answer='';for await(const chunk of observers.get('llm/stream')(req,()=>({async *[Symbol.asyncIterator](){yield {type:'block-end',index:0,block:{type:'text',text:JSON.stringify(content).includes('已形成的条件表达准则')?'我在呢，慢慢来。':'请补充当前任务的具体需求。'}};yield {type:'finish',reason:{kind:'stop'}};}})))if(chunk.type==='block-end')answer=chunk.block.text;
  return {content,answer};
 };
 try{
  const before=await request('今天有点累','same-session');assert.match(JSON.stringify(before.content),/已形成的条件表达准则/);
  const unrelated=await request('帮我分析编译器','other-session');assert.doesNotMatch(JSON.stringify(unrelated.content),/已形成的条件表达准则/);
  const edit=new V5Runtime({file});try{const m=edit.memory(ruleId);edit.writeCentralRule({scope,id:ruleId,expected_revision:m.revision,action:'pause',reason:'合成宿主验证中暂停'});}finally{edit.close();}
  const paused=await request('今天有点累','same-session');assert.doesNotMatch(JSON.stringify(paused.content),/已形成的条件表达准则/,'a same-session cached prompt cannot retain paused implicit influence');
  assert.notEqual(before.answer,paused.answer);
  const listRoute=routes.get('/atlas/api/v5/implicit-learning');assert.ok(listRoute);assert.equal(listRoute.options.access,'panel');
  const db=new DatabaseSync(file,{readOnly:true});try{const row=JSON.parse(db.prepare('SELECT json FROM recalls ORDER BY created DESC LIMIT 1').get().json);assert.ok(row.host_receipts.some(h=>h.completion==='completed'));}finally{db.close();}
  assert.equal(module.status().last_error,null);
  return {normal_model_input_has_implicit_rule:true,unrelated_model_input_has_no_implicit_rule:true,pause_removes_cached_influence:true,provider_stub_reply_before:before.answer,provider_stub_reply_after:paused.answer,real_model_calls:0,qq_sends:0,requests:requests.length,request_receipt_completed:true,actual_provider_reply_quality:'not_measured_synthetic_provider',managed_source_id:ruleId};
 }finally{await module.dispose();}
}
