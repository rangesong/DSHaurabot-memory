import {testRuntimeRoot,writeTestResult} from '../scripts/lib/test-workspace.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join,dirname,resolve,basename } from 'node:path';
import { startThinkstar } from '../adapters/aurabot/module/lib/host-bridge.js';
import { HostModelClient } from '../adapters/aurabot/module/lib/host-model-client.js';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';

const runtimeRoot=testRuntimeRoot(fileURLToPath(new URL('../runtime-data/',import.meta.url)));
async function fixture(t,{dsh,readMethods={}}={}){
  mkdirSync(runtimeRoot,{recursive:true});const dir=mkdtempSync(join(runtimeRoot,'module-test-')),instances=[];
  const config={debug:false,persona:{current:'alpha'}},settings={mode:'active',captureGroups:false,captureOtherPrivate:false,contextTokens:1536,allowHostModel:false};
  const listeners=new Map(),routes=new Map(),timers=[],blocked=new Set(),contexts=[],tools=[];let counter=0;const builtin={remembers:uid=>!blocked.has(String(uid)),add:()=>({ok:true,id:'synthetic-'+(++counter)}),addEvent:()=>({ok:true,id:'event-'+(++counter)}),remove:()=>true,noteVia:()=>({ok:true}),invalidate:()=>true,restore:()=>({ok:true}),setNoMemory:()=>({ok:true}),handleCommand:()=>({ok:true,forgotten:true})};
  Object.assign(builtin,readMethods);
  const api={id:'thinkstar-memory',apiVersion:1,dir,dsh,config:()=>config,settings:()=>settings,dataDir:(...parts)=>join(dir,...parts),isOwner:id=>String(id)==='100',has:()=>true,use:id=>id==='memory'?builtin:null,
    log:{info(){},warn(){}},onDispose(){},rule(){},context(fn){contexts.push(fn);},tool(fn){tools.push(fn);},defineTool:value=>value,ask(){throw new Error('No model calls are allowed in this fixture');},
    on(event,fn){const list=listeners.get(event)??[];list.push(fn);listeners.set(event,list);return()=>listeners.set(event,list.filter(item=>item!==fn));},
    every(ms,fn){timers.push(fn);return()=>{};},route(path,fn,options){routes.set(path,{fn,options});return()=>routes.delete(path);}};
  const start=async()=>{const module=await startThinkstar(api);instances.push(module);return module;};
  t.after(async()=>{for(const module of instances.reverse())await module.dispose();assert.equal(dirname(resolve(dir)),resolve(runtimeRoot));assert.ok(basename(dir).startsWith('module-test-'));rmSync(dir,{recursive:true,force:true});});
  const emit=(event,...args)=>(listeners.get(event)??[]).map(fn=>fn(...args));
  return {module:await start(),start,api,config,settings,listeners,routes,timers,blocked,emit,contexts,tools,builtin};
}
const message=(id,text,extra={})=>({kind:'private',chatId:'private:100',userId:'100',groupId:'',messageId:String(id),nickname:'合成主人',text,raw:{time:1794567000},...extra});
const chat={kind:'private',chatId:'private:100',userId:'100'};

test('master switch pauses capture, prompt injection, jobs and model access without disabling native memory',async t=>{
  const f=await fixture(t);f.emit('message',message('before','合成旧记事'));const before=f.module.status().stats.sources;f.settings.masterEnabled=false;
  f.emit('message',message('off','这条不应被Thinkstar记录'));const original=[{type:'text',text:'合成旧记事'}];assert.equal(f.emit('prompt',original,{chat,sessionId:'off',queryText:'合成旧记事'})[0],original);f.timers[0]();assert.equal(f.module.status().stats.sources,before);assert.equal(f.module.status().master_enabled,false);assert.equal(f.module.status().model.configured,false);
  f.settings.masterEnabled=true;f.emit('message',message('after','重新启用后的合成记事'));assert.equal(f.module.status().stats.sources,before+1);
});

test('real adapter keeps assistant output outside user input roots and injects a grounded historical correction',async t=>{
  const observers=new Map(),f=await fixture(t,{dsh:{get:()=>null,on:(name,fn)=>{observers.set(name,fn);return()=>observers.delete(name);}}});f.api.send=()=>assert.fail('QQ sending is forbidden');
  for(const [id,query,reply]of [['one','聊聊今天','好啊，天气不错。'],['two','取完快递了','那快去吃饭']]){
    f.emit('message',message(id,query,{raw:{time:Date.now()/1000}}));const output=await f.emit('prompt',[{type:'text',text:query}],{chat,sessionId:'learning',queryText:query})[0];
    const request={sessionId:'learning',messages:[{role:'user',source:{kind:'aurabot'},content:output}]};
    for await(const chunk of observers.get('llm/stream')(request,()=>({async *[Symbol.asyncIterator](){yield {type:'block-end',block:{type:'text',text:reply}};yield {type:'finish',reason:{kind:'stop'}};}}))){}
  }
  f.emit('message',message('correction','我刚刚吃过饭，你这回答不对',{raw:{time:(Date.now()+1500)/1000}}));
  const output=await f.emit('prompt',[{type:'text',text:'现在要不要提醒我吃饭'}],{chat,sessionId:'learning',queryText:'现在要不要提醒我吃饭'})[0];assert.ok(output.some(b=>b.text?.includes('先核对最近原话')));
});

test('ordinary reaction schedules a capped background model review without sending QQ',async t=>{
  const observers=new Map(),f=await fixture(t,{dsh:{get:()=>null,on:(n,fn)=>{observers.set(n,fn);return()=>observers.delete(n);}}});f.settings.allowHostModel=true;let calls=0;
  f.api.ask=async({text})=>{calls++;const input=JSON.parse(text);return JSON.stringify({items:input.items.map(x=>({id:x.id,is_feedback:true,meaning:'comfort',reason:'接住先前道歉'}))});};
  f.emit('message',message('q','刚才怎么回事',{raw:{time:Date.now()/1000}}));const content=await f.emit('prompt',[{type:'text',text:'刚才怎么回事'}],{chat,sessionId:'background-feedback',queryText:'刚才怎么回事'})[0];
  for await(const chunk of observers.get('llm/stream')({sessionId:'background-feedback',messages:[{role:'user',source:{kind:'aurabot'},content}]},()=>({async *[Symbol.asyncIterator](){yield {type:'block-end',block:{type:'text',text:'对不起，我理解错了。'}};yield {type:'finish',reason:{kind:'stop'}};}}))){}
  assert.deepEqual(f.emit('message',message('reaction','摸摸头',{raw:{time:(Date.now()+1500)/1000}})),[false]);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls,1);
  const db=new DatabaseSync(f.api.dataDir('memory.sqlite'),{readOnly:true});try{const row=JSON.parse(db.prepare('SELECT json FROM dialogue_feedback ORDER BY created DESC LIMIT 1').get().json);assert.equal(row.model_review.mode,'interactive');assert.equal(row.interpretation.meaning,'comfort');assert.equal(row.interpretation.approval,false);}finally{db.close();}
});

test('ordinary prompt, completed model text and natural feedback join in the real adapter without sending QQ',async t=>{
  const observers=new Map(),route={provider:'synthetic',model:'synthetic'},dsh={get:()=>null,on:(name,fn)=>{observers.set(name,fn);return()=>observers.delete(name);}};
  const f=await fixture(t,{dsh});f.api.send=()=>assert.fail('QQ sending is forbidden');
  const now=Date.now();f.emit('message',message('pref','当我疲惫时，以后请简短陪伴，不要连续追问。',{raw:{time:(now-5000)/1000}}));f.timers[0]();
  f.emit('message',message('ask','我今天很疲惫',{raw:{time:(now-1000)/1000}}));
  const [output]=f.emit('prompt',[{type:'text',text:'我今天很疲惫'}],{chat,sessionId:'ordinary-learning',queryText:'我今天很疲惫'});assert.ok(output[0].text.includes('减少追问'));
  const request={...route,sessionId:'ordinary-learning',messages:[{role:'user',source:{kind:'aurabot'},content:output}]};
  for await(const chunk of observers.get('llm/stream')(request,()=>({async *[Symbol.asyncIterator](){yield {type:'block-end',index:0,block:{type:'text',text:'好，我在这里陪你，今天先不追问。'}};yield {type:'finish',reason:{kind:'stop'}};}}))){}
  f.emit('message',message('feedback','摸摸头',{raw:{time:(Date.now()+1500)/1000}}));
  const db=new DatabaseSync(f.api.dataDir('memory.sqlite'),{readOnly:true});try{
    const feedback=JSON.parse(db.prepare('SELECT json FROM dialogue_feedback ORDER BY created DESC LIMIT 1').get().json);assert.equal(feedback.interpretation.meaning,'affection');assert.equal(feedback.interpretation.approval,false);
    const turn=JSON.parse(db.prepare('SELECT json FROM dialogue_turns WHERE id=?').get(feedback.turn_id).json);assert.equal(turn.reply,'好，我在这里陪你，今天先不追问。');assert.equal(turn.delivery,'completed_model_output_not_delivery');
    const recall=JSON.parse(db.prepare('SELECT json FROM recalls WHERE id=?').get(turn.query_id).json);assert.equal(recall.actual_use,'unknown');assert.equal(recall.host_receipts[0].completion,'completed');
  }finally{db.close();}
});

test('native module captures without taking over replies and deduplicates the same host event',async t=>{
  const f=await fixture(t),row=message(1,'项目：合成晨星；预算上限300元');
  assert.deepEqual(f.emit('message',row),[false]);f.emit('message',row);
  assert.equal(f.module.status().stats.sources,1);assert.equal(f.module.status().stats.pending,1);
  f.emit('message',message(2,'这条只属于模拟测试',{raw:{simulated:true}}));f.emit('message',message(3,'插件注入的背景不冒充用户发言',{source:{kind:'plugin:synthetic'}}));assert.equal(f.module.status().stats.sources,1);
});
test('native recall stays within persona and chat and does not count preparation as actual use',async t=>{
  const f=await fixture(t);f.emit('message',message(1,'项目：合成晨星；预算上限300元'));
  const result=f.module.recall(chat,'合成晨星');assert.ok(result.context.some(item=>item.text.includes('300元')));assert.equal(result.actual_use,'unknown');assert.ok(result.candidates.every(item=>!item.actual_use));
  f.config.persona.current='beta';assert.equal(f.module.recall(chat,'合成晨星').context.length,0);
  assert.equal(f.module.recall({kind:'private',chatId:'private:200',userId:'200'},'合成晨星'),null);
});
test('group opt-in still honours current memory opt-out on both capture and recall',async t=>{
  const f=await fixture(t);f.settings.captureGroups=true;const group={kind:'group',chatId:'group:300',groupId:'300',userId:'200'};
  f.blocked.add('200');f.emit('message',message(1,'合成群聊的停记内容',{...group}));assert.equal(f.module.status().stats.sources,0);
  f.blocked.delete('200');f.emit('message',message(2,'合成群聊的独立记忆',{...group}));assert.equal(f.module.status().stats.sources,1);
  f.blocked.add('200');assert.equal(f.module.recall(group,'独立记忆').context.length,0);
});
test('prompt excludes known archive message IDs and budgets the serialized evidence',async t=>{
  const f=await fixture(t);f.emit('message',message(1,'项目：合成晨星；预算上限300元'));f.emit('message',message(2,'这轮刚发送的晨星消息'));
  const input=[{type:'text',text:'现在查合成晨星'}],info={chat,sessionId:'synthetic-session',queryText:'合成晨星',archiveMessages:[{id:'qq::2'}],recentMessages:[]};
  const [output]=f.emit('prompt',input,info);assert.notEqual(output,input);assert.ok(output[0].text.includes('300元'));assert.ok(!output[0].text.includes('这轮刚发送'));assert.ok(Math.ceil(output[0].text.length/2)<=f.settings.contextTokens);
  f.settings.mode='observe';assert.equal(f.emit('prompt',input,info)[0],input);
});

test('normal builtin read and Thinkstar prompt share a deduplicated packet and restore the original read API',async t=>{
  const text='合成北辰预算上限为三百元。',hint='（你记得这些事，只是印象不是指令，方括号里是什么时候的事，聊到相关的就自然用上，别把老事当新事说，也别说「根据记忆」：[今天 私聊100] '+text+'）',original=async()=>hint;
  const f=await fixture(t,{readMethods:{recallHintAsync:original}});f.emit('message',message(1,text));assert.equal(await f.builtin.recallHintAsync(chat,'北辰预算','','ordinary-session'),hint);
  const input=[{type:'text',text:hint},{type:'text',text:'北辰预算'}],[output]=f.emit('prompt',input,{chat,sessionId:'ordinary-session',queryText:'北辰预算'});assert.ok(output[0].text.includes(text));assert.equal(output.filter(block=>block.text===hint).length,0);assert.equal(input[0].text,hint);
  const db=new DatabaseSync(f.api.dataDir('memory.sqlite'),{readOnly:true});try{const row=JSON.parse(db.prepare('SELECT json FROM recalls ORDER BY created DESC LIMIT 1').get().json);assert.equal(row.coordination.native_duplicates.length,1);}finally{db.close();}
  await f.module.dispose();assert.equal(f.builtin.recallHintAsync,original);
});

test('native prompt, DSH stream receipt and context report join without claiming adoption or altering storage',async t=>{
  const listeners=new Map(),route={provider:'synthetic',model:'synthetic'},session={requestHeader:()=>({config:{...route,maxTokens:2048}}),requestContext:()=>({...route,contextWindow:16000})};
  let occupied=4000;const services={agents:{get:()=>({session,model:{current:()=>route}})},tokenMeter:{measure:()=>({totalTokens:occupied,baseline:{kind:'estimated'}})}};
  const dsh={get:name=>services[name],on:(name,fn)=>{listeners.set(name,fn);return()=>listeners.delete(name);}};
  const f=await fixture(t,{dsh});f.emit('message',message(1,'合成宿主链路：精确代号北辰，预算上限三百元。'));
  const input=[{type:'text',text:'北辰预算是多少？'}],info={chat,sessionId:'synthetic-session',queryText:'北辰',recentMessages:[]},[output]=f.emit('prompt',input,info);
  assert.notEqual(output,input);assert.ok(output[0].text.includes('三百元'));assert.equal(f.module.status().host_context.request_observer,true);
  const request=Object.freeze({...route,sessionId:info.sessionId,maxTokens:2048,messages:[{role:'user',source:{kind:'aurabot'},content:output}]});
  const chunks=[{type:'usage',usage:{inputTokens:123,outputTokens:25}},{type:'finish',reason:{kind:'stop'}}];
  for await(const chunk of listeners.get('llm/stream')(request,()=>({async *[Symbol.asyncIterator](){yield*chunks;}}))){}
  const db=new DatabaseSync(f.api.dataDir('memory.sqlite'),{readOnly:true});
  try{
    const row=JSON.parse(db.prepare('SELECT json FROM recalls ORDER BY created DESC LIMIT 1').get().json);
    assert.equal(row.budget.host_sizing.mode,'host_meter_estimate');assert.equal(row.budget.actual_model_window_known,false);assert.equal(row.host_receipts[0].completion,'completed');assert.equal(row.model_usage.total_tokens,148);assert.equal(row.actual_use,'unknown');
    const object=JSON.parse(db.prepare("SELECT json FROM memories WHERE id LIKE 'raw:%' LIMIT 1").get().json);assert.equal(object.used_count,0);
    assert.equal(f.module.status().stats.sources,1);
  }finally{db.close();}
  f.builtin.addEvent({text:'合成预算测试：她完成了项目资料草稿。',importance:.9});
  assert.ok(f.contexts[0]({chat,sessionId:info.sessionId}).includes('资料草稿'));
  occupied=15999;assert.equal(f.contexts[0]({chat,sessionId:info.sessionId}),'');
  assert.equal(f.module.recall(chat,'北辰',{sessionId:info.sessionId,content:input}).context.length,0);
  assert.equal(f.module.readHistory(chat).items[0].text,'合成宿主链路：精确代号北辰，预算上限三百元。');
  await f.module.dispose();assert.equal(listeners.size,0);
});

test('panel historical evaluation uses isolated DSH requests, real prompt receipts and idempotence without storing fake dialogue',async t=>{
  const listeners=new Map(),route={provider:'synthetic',model:'synthetic'};let modelCalls=0;
  const sessions={prepare:(id,{seed})=>(assert.equal(Object.hasOwn(seed.find(row=>row.type==='request/header').data.header,'tools'),false),assert.equal(seed.find(row=>row.type==='system/message').data.message.source.kind,'system-prompt'),{id,requestHeader:()=>seed.find(row=>row.type==='request/header').data.header,requestContext:()=>seed.find(row=>row.type==='request/context').data,deriveMessages:()=>seed.filter(row=>['system/message','user/message'].includes(row.type)).map(row=>row.data.message??row.data)})};
  const llm={async prepareCall(config){return {config,context:{contextWindow:20000},stream(request){modelCalls++;return listeners.get('llm/stream')(request,()=>({async *[Symbol.asyncIterator](){const evidence=request.messages.flatMap(row=>row.content).find(block=>block.text?.includes('资料编号：')),id=/"id":"([^"]+)"/.exec(evidence?.text??'')?.[1];yield {type:'block-end',index:0,block:{type:'text',text:JSON.stringify({answer:evidence?'北辰预算是三百元。':'没有资料，不知道。',cited_ids:id?[id]:[],unknown:!evidence})}};yield {type:'usage',usage:{inputTokens:100,outputTokens:40}};yield {type:'finish',reason:{kind:'stop'}};}}));}};}};
  const services={sessions,llm,tokenMeter:{measure:()=>({totalTokens:200,baseline:{kind:'estimated'}})}};
  const f=await fixture(t,{dsh:{get:name=>services[name],on:(name,fn)=>{listeners.set(name,fn);return()=>listeners.delete(name);}}});f.api.lib=()=>({defaultModel:()=>route});f.settings.allowHostModel=true;
  f.api.send=()=>{throw Error('QQ sending is forbidden');};f.api.saveSettings=patch=>Object.assign(f.settings,patch);
  f.emit('message',message(1,'合成北辰项目预算为三百元，须保留原话。'));
  const original=f.module.readHistory(chat).items[0],body={command_id:'11111111-1111-4111-8111-111111111111',chat,cases:[{id:'historical',question:'北辰预算是多少？',source_refs:[original.source_id],expected_groups:[['三百元']]}]};
  const call=async(method,name,payload)=>{const req=Readable.from(payload?[Buffer.from(JSON.stringify(payload))]:[]);Object.assign(req,{method,url:'/aurabot/api/ext/thinkstar-memory/atlas/api/v5/'+name,headers:{host:'127.0.0.1:9','content-type':'application/json'},socket:{localPort:9}});let result;const res={writeHead(){},end(value){result=JSON.parse(value);}};await f.routes.get('/atlas/api/v5/'+name).fn(req,res);return result;};
  const result=await call('POST','evaluation-run',body);assert.equal(result.status,'passed');assert.equal(modelCalls,2);assert.equal(result.qq_sends,0);assert.equal(result.tools_executed,0);assert.equal(result.attempts[1].request_receipt.completion,'completed');assert.equal(result.attempts[1].budget.host_sizing.mode,'host_meter_estimate');
  assert.equal(f.module.status().stats.sources,1);assert.equal(f.module.readHistory(chat).items[0].text,original.text);const panelReport=await call('GET','evaluation-report');assert.equal(panelReport.available,true);assert.equal(panelReport.attempts[0].expected_present,true);assert.ok(panelReport.attempts.every(attempt=>attempt.assessment));
  assert.equal((await call('POST','evaluation-run',body)).id,result.id);assert.equal(modelCalls,2);
  f.config.persona.current='other';assert.equal((await call('GET','evaluation-report')).available,false);
});
test('all module management routes use the host panel gate; reload closes the old instance and preserves data',async t=>{
  const f=await fixture(t);f.emit('message',message(1,'项目：合成晨星；预算上限300元'));
  assert.ok(f.routes.size>20);assert.ok([...f.routes.values()].every(route=>route.options.access==='panel'));
  const old=f.module,next=await f.start();assert.equal(old.status().state,'stopped');assert.equal(next.status().stats.sources,1);
  assert.ok(next.recall(chat,'合成晨星').context.length>0);
});
test('a stopped host model client never starts a deferred model request',async()=>{
  let active=true,calls=0;const client=new HostModelClient({ask(){calls++;return '{}';}},{active:()=>active,enabled:()=>true});
  const result=client.json('Return JSON',{});active=false;client.stop();await assert.rejects(result,{code:'MODEL_CANCELLED'});assert.equal(calls,0);
});


test('history tools are persona-scoped and archived raw remains readable independently of recent session state',async t=>{
  const f=await fixture(t);f.emit('message',message(1,'合成历史：精确预算31元，不是30元。'));
  const tool=f.tools[0]({chat}).find(tool=>tool.name==='thinkstar_history');
  const history=await tool.execute({level:0});assert.equal(history.items[0].text,'合成历史：精确预算31元，不是30元。');
  const saved=f.module.remember(chat,{source_id:history.items[0].source_id,quote:'精确预算31元，不是30元'});assert.equal(saved.memory.protection,'P1');
  f.config.persona.current='beta';assert.equal((await tool.execute({level:0})).ok,false);assert.equal(f.module.readHistory(chat).items.length,0);
});
test('successful builtin writes are mirrored without truncating inputs and original APIs are restored on dispose',async t=>{
  const f=await fixture(t),wrapped=f.builtin.add,text='合成模块事实。'.repeat(80),result=f.builtin.add({chatId:chat.chatId,about:'100',text});
  assert.equal(result.ok,true);const row=f.module.readHistory(chat).items[0];assert.equal(row.text,text);assert.equal(row.role,'document');assert.equal(row.provenance.upstream_memory_id,result.id);
  f.builtin.remove(result.id);assert.equal(f.module.readHistory(chat).items.length,0);
  await f.module.dispose();assert.notEqual(f.builtin.add,wrapped);
});
test('unscoped self events stay separate and send observations preserve full text without claiming delivery',async t=>{
  const f=await fixture(t);f.builtin.addEvent({text:'合成：她完成了歌曲草稿，不表示已发布',importance:.9});
  assert.match(f.module.contextFor(chat),/歌曲草稿/);assert.equal(f.module.readHistory(chat).items.length,0);
  const text='合成发送正文。'.repeat(100);f.emit('send',[{type:'text',data:{text}}],{chatId:chat.chatId});
  assert.equal(f.module.status().stats.sources,2);assert.equal(f.module.recall(chat,'合成发送').context.length,0);
});
test('activity fallback does not count a message hook a second time or skip independent identical messages',async t=>{
  const f=await fixture(t),row=message(1,'合成相同原话');f.emit('message',row);f.emit('activity',{kind:'in',chatId:chat.chatId,userId:'100',text:row.text});
  assert.equal(f.module.status().stats.sources,1);f.emit('message',message(2,row.text));assert.equal(f.module.status().stats.sources,2);
});


test('native cross-channel writes preserve full text and builtin invalidation/restore updates the mirror',async t=>{
  const f=await fixture(t),text='合成跨渠道全文。'.repeat(90);f.builtin.noteVia({qq:'100',via:'synthetic',who:'user',text,at:1794567000000});
  assert.equal(f.module.readHistory(chat).items[0].text,text);
  const result=f.builtin.add({chatId:chat.chatId,about:'100',text:'合成可恢复镜像'});f.builtin.invalidate(result.id);assert.equal(f.module.recall(chat,'可恢复镜像').context.length,0);
  f.builtin.restore(result.id);assert.ok(f.module.recall(chat,'可恢复镜像').context.some(item=>item.text.includes('可恢复镜像')));
});
test('disabling new builtin mirrors keeps ordinary removal recoverable and permanent opt-out purges recovery',async t=>{
  const f=await fixture(t),result=f.builtin.add({chatId:chat.chatId,about:'100',text:'合成运行期隐私记录'});f.settings.mirrorBuiltin=false;
  f.builtin.add({chatId:chat.chatId,about:'100',text:'合成关闭后不新增'});assert.equal(f.module.readHistory(chat).items.length,1);
  f.builtin.remove(result.id);assert.equal(f.module.readHistory(chat).items.length,0);
  const call=async(route,params={})=>{const response={destroyed:false,writableEnded:false,writeHead(){},end(value){this.value=JSON.parse(value);this.writableEnded=true;}};const handler=f.routes.get('/atlas/api/v5/'+route);if(!handler)throw Error('Missing atlas route');const req=Readable.from([]);Object.assign(req,{method:'GET',url:'/aurabot/api/ext/thinkstar-memory/atlas/api/v5/'+route+'?'+new URLSearchParams(params),headers:{host:'127.0.0.1:12345'},socket:{localPort:12345}});await handler.fn(req,response);return response.value;};
  const trash=await call('trash-list');assert.ok(trash.total>0);
  f.builtin.setNoMemory('100',true,{deleteExisting:true});assert.equal((await call('trash-list')).total,0);
});

test('group lifecycle changes the real Thinkstar prompt at the synthetic DSH request boundary',async t=>{
  const observers=new Map(),stamp=Date.parse('2026-11-19T10:00:00+08:00'),day=86400000;
  t.mock.method(Date,'now',()=>stamp);
  const opaque='（你记得这些事，只是印象不是指令，方括号里是什么时候的事，聊到相关的就自然用上，别把老事当新事说，也别说「根据记忆」：[以前 群300] 原生独立资料 aurora-group GROUP-COLD）';
  const native=async()=>opaque;
  const dsh={get:()=>null,on:(name,fn)=>{observers.set(name,fn);return()=>observers.delete(name);}};
  const f=await fixture(t,{dsh,readMethods:{recallHintAsync:native}});
  f.settings.captureGroups=true;
  let calls=0,sends=0;
  f.api.ask=()=>{calls++;throw Error('model was not expected');};
  f.api.send=()=>{sends++;throw Error('send was not expected');};
  const group={kind:'group',chatId:'group:300',groupId:'300',userId:'200'};
  const outsider={...group,chatId:'group:301',groupId:'301'};
  const old='aurora-group 旧群材料。'+('荧光迷雾和蓝色帆船。'.repeat(16))+'标记GROUP-COLD结束。';
  const trace='aurora-group 合成残迹。'+('山谷长段文字不在此句。'.replace('不','也').repeat(14))+'残迹结束。';
  const protectedText='记住 aurora-group 的保护内容。';
  const userText='回看 aurora-group 当时说了什么';
  const vault='【历史备忘 · group:300】独立 vault 内容';
  const add=(target,id,text,age)=>f.emit('message',message(id,text,{...target,raw:{time:(stamp-age)/1000}}));
  add(group,'retired',old,5*day);
  add(group,'trace',trace,2.5*day);
  add(group,'protected',protectedText,6*day);
  add(group,'recent','aurora-group 当天素材。',1000);
  add(chat,'owner','aurora-group 主人私聊的独立资料。',5*day);
  f.config.persona.current='beta';add(group,'beta','aurora-group 另一人格资料。',1000);
  f.config.persona.current='alpha';add(outsider,'outsider','aurora-group 另一群资料。',1000);
  f.timers[0]();

  const call=async(method,route,payload)=>{
    const req=Readable.from(payload?[Buffer.from(JSON.stringify(payload))]:[]);
    Object.assign(req,{method,url:'/aurabot/api/ext/thinkstar-memory/atlas/api/v5/'+route,headers:{host:'127.0.0.1:9','content-type':'application/json'},socket:{localPort:9}});
    const res={writeHead(){},end(value){this.value=JSON.parse(value);}};
    await f.routes.get('/atlas/api/v5/'+route).fn(req,res);
    return res.value;
  };
  async function prepare(target,sessionId){
    const hint=await f.builtin.recallHintAsync(target,userText,'',sessionId);
    const input=target===group?[{type:'text',text:hint},{type:'text',text:userText},{type:'text',text:vault}]:[{type:'text',text:userText}];
    const content=await f.emit('prompt',input,{chat:target,sessionId,queryText:userText})[0];
    const stable=f.contexts.map(fn=>fn({chat:target,sessionId})).filter(Boolean);
    const request={sessionId,messages:[...stable.map(text=>({role:'system',content:[{type:'text',text}]})),{role:'user',source:{kind:'aurabot'},content}]};
    let captured;
    const stream=observers.get('llm/stream')(request,value=>{captured=value??request;return {async *[Symbol.asyncIterator](){yield {type:'finish',reason:{kind:'stop'}};}};});
    for await(const _chunk of stream){}
    const packets=content.filter(block=>block.text?.includes('Thinkstar 同人格同聊天资料'));
    const text=packets.map(block=>block.text).join('\n');
    const items=JSON.parse(text.split('\n')[1]??'[]');
    return {text,items,content,stable,request:captured};
  }
  const before=await prepare(group,'group-before'),privateBefore=await prepare(chat,'owner-before');
  const config=await call('GET','config');
  assert.ok(before.text.includes('GROUP-COLD'));
  const saved=await call('POST','config',{region:'W5',values:{group_policy_enabled:1},expected_version:config.version});
  assert.equal(saved.effective_config.W5.group_policy_enabled,1);
  const after=await prepare(group,'group-after'),privateAfter=await prepare(chat,'owner-after');
  assert.ok(after.request);
  const ownRequestBlocks=after.request.messages.flatMap(message=>message.content??[]).filter(block=>block.text?.includes('Thinkstar 同人格同聊天资料'));
  assert.ok(ownRequestBlocks.length>0&&ownRequestBlocks.every(block=>!block.text.includes('GROUP-COLD')));
  // Deliberate coverage-negative case: opaque native text can still carry the same old fact.
  // Without structured provenance it must survive, so this feature is not whole-host enforcement.
  assert.ok(JSON.stringify(after.request).includes('GROUP-COLD'));
  assert.ok(!after.text.includes('另一人格')&&!after.text.includes('另一群')&&!after.text.includes('主人私聊'));
  assert.ok(after.text.includes(protectedText));
  assert.ok(after.items.some(item=>item.precision==='gist_with_evidence'&&item.text.includes('合成残迹')));
  assert.ok(after.content.some(block=>block.text===opaque)&&after.content.some(block=>block.text===vault)&&after.content.some(block=>block.text===userText));
  assert.deepEqual(privateBefore.items,privateAfter.items);
  assert.deepEqual(privateBefore.stable,privateAfter.stable);
  assert.ok(after.text.length<before.text.length);
  assert.equal(f.module.readHistory(group,{keyword:'GROUP-COLD'}).items[0].text,old);
  assert.equal(f.module.readHistory(outsider,{keyword:'GROUP-COLD'}).items.length,0);
  f.blocked.add('200');
  assert.equal(f.module.readHistory(group,{keyword:'GROUP-COLD'}).items.length,0);
  assert.ok(!(await prepare(group,'group-optout')).text);
  f.blocked.delete('200');
  const fresh=await f.start();
  assert.ok(!(await prepare(group,'group-reloaded')).text.includes('GROUP-COLD'));
  const disabled=await call('POST','config',{region:'W5',values:{group_policy_enabled:0},expected_version:saved.version});
  assert.equal(disabled.effective_config?.W5.group_policy_enabled,0,JSON.stringify(disabled));
  const retiredSource=fresh.readHistory(group,{keyword:'GROUP-COLD'}).items[0];
  const recovered=fresh.recall(group,'raw:'+retiredSource.source_id);
  assert.ok(recovered.context.some(item=>item.text===old),JSON.stringify(recovered.omitted));
  // Expiry retirement is separate from the pre-maintenance cold lookup above.
  const reenabled=await call('POST','config',{region:'W5',values:{group_policy_enabled:1},expected_version:disabled.version});
  const plan=await call('POST','retention-plan',{scope:recovered.scope});
  assert.ok(plan.items.some(item=>item.id==='raw:'+retiredSource.source_id&&item.action==='group_trash'));
  await call('POST','retention-apply',{plan_id:plan.id});
  assert.equal(fresh.readHistory(group,{keyword:'GROUP-COLD'}).items.length,0);
  assert.equal(fresh.recall(group,'raw:'+retiredSource.source_id).context.length,0);
  const trash=await call('GET','trash-list');assert.ok(trash.items.some(item=>item.memory_id==='raw:'+retiredSource.source_id));
  await call('POST','config',{region:'W5',values:{group_policy_enabled:0},expected_version:reenabled.version});
  const afterTrash=await prepare(group,'group-after-trash');assert.ok(!afterTrash.text.includes('GROUP-COLD'));
  assert.equal(calls,0);
  assert.equal(sends,0);
  const characters=packet=>JSON.stringify(packet.request.messages).length;
  writeTestResult({
    scenario:'synthetic Aurabot prompt and llm/stream request',
    group_before:{thinkstar_items:before.items.length,thinkstar_chars:before.text.length,prepared_message_json_chars:characters(before)},
    group_after:{thinkstar_items:after.items.length,thinkstar_chars:after.text.length,prepared_message_json_chars:characters(after)},
    owner_before:{thinkstar_items:privateBefore.items.length,thinkstar_chars:privateBefore.text.length},
    owner_after:{thinkstar_items:privateAfter.items.length,thinkstar_chars:privateAfter.text.length},
    cold_query_exact_before_retirement:true,trash_retirement_removes_normal_history:true,trash_not_revived_by_disabling:true,native_hint_preserved:true,history_vault_block_preserved:true,additional_model_calls:calls,qq_sends:sends,
    expired_marker_in_thinkstar_packet:false,expired_marker_can_remain_in_opaque_native_packet:true,
    coverage:{thinkstar:'controlled',native_memory:'uncovered_unstructured_recall',history_vault:'uncovered_independent_injection'},
    measurement:'synthetic final prepared message JSON characters; not provider token usage or billed cost'
  });
  await fresh.dispose();assert.equal(f.builtin.recallHintAsync,native);
});

test('optional reranking receives projected group material and an in-flight old result cannot refill an expired packet',async t=>{
  let now=Date.parse('2026-11-19T10:00:00+08:00');const day=86400000;
  t.mock.method(Date,'now',()=>now);
  const f=await fixture(t);f.settings.captureGroups=true;f.settings.allowHostModel=true;
  const target={kind:'group',chatId:'group:300',groupId:'300',userId:'200'};
  const query='之前 aurora-focus 的讨论',payloads=[];let release,hold=false;
  f.api.ask=async({text})=>{const input=JSON.parse(text);payloads.push(input);if(hold)await new Promise(resolve=>{release=resolve;});return JSON.stringify({ids:input.candidates.map(row=>row.id)});};
  f.api.send=()=>assert.fail('QQ sending is forbidden');
  for(let i=0;i<4;i++)f.emit('message',message('rerank-'+i,'aurora-focus 开头。'+('中间蓝色湖泊 RERANK-LONG-MIDDLE。'.repeat(15))+'结尾。',{...target,raw:{time:(now-2.5*day)/1000}}));
  f.emit('message',message('old-rerank','aurora-focus EXPIRED-RERANK-ITEM。',{...target,raw:{time:(now-5*day)/1000}}));
  f.timers[0]();
  const config=async(values)=>{
    const route='/atlas/api/v5/config',req=Readable.from(values?[Buffer.from(JSON.stringify(values))]:[]),res={writeHead(){},end(value){this.value=JSON.parse(value);}};
    Object.assign(req,{method:values?'POST':'GET',url:'/aurabot/api/ext/thinkstar-memory'+route,headers:{host:'127.0.0.1:9','content-type':'application/json'},socket:{localPort:9}});
    await f.routes.get(route).fn(req,res);return res.value;
  };
  let saved=await config();saved=await config({region:'W2',values:{rerank_enabled:1,rerank_top_n:8},expected_version:saved.version});
  assert.equal(saved.effective_config?.W2.rerank_enabled,1,JSON.stringify(saved));
  saved=await config({region:'W5',values:{group_policy_enabled:1},expected_version:saved.version});
  assert.equal(saved.effective_config?.W5.group_policy_enabled,1,JSON.stringify(saved));
  const prepare=()=>f.emit('prompt',[{type:'text',text:query}],{chat:target,queryText:query,sessionId:'group-rerank'})[0];
  await prepare();assert.equal(payloads.length,1);
  assert.ok(payloads[0].candidates.length>=3);
  assert.ok(!JSON.stringify(payloads[0]).includes('EXPIRED-RERANK-ITEM'));
  assert.ok(payloads[0].candidates.some(item=>item.text.length<150));
  hold=true;const pending=prepare();for(let i=0;i<10&&!release;i++)await new Promise(setImmediate);assert.ok(release);
  // Move all ordinary sources past their hard automatic-recall deadline during the optional request.
  now+=2*day;release();const output=await pending;
  assert.ok(!output.some(block=>block.text?.includes('RERANK-LONG-MIDDLE')||block.text?.includes('EXPIRED-RERANK-ITEM')));
  assert.equal(payloads.length,2,'the lifecycle does not add a new model request or retry');
});
