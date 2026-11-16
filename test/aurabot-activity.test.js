import test from 'node:test';
import assert from 'node:assert/strict';
import {V5Runtime} from '../core/v5-runtime.js';
import {observeHostActivity} from '../adapters/aurabot/module/lib/host-activity.js';

test('owned session final text joins an empty-memory turn and tool logs never become social activity',t=>{
  const r=new V5Runtime(),scope=r.addScope({persona_id:'aurabot:test',scope:'private:100'}).id,listeners=new Map();t.after(()=>r.close());
  const source=r.ingest({scope,text:'你好',provenance:{speaker_id:'100'}}),recall=r.query({scope,query:'不相关的内容'});assert.equal(recall.context.length,0);r.dialogue.prepared(recall,{sessionId:'abc',chatId:'private:100',input_source_ids:[source.source_id]});
  const api={dsh:{on:(name,fn)=>{listeners.set(name,fn);return()=>listeners.delete(name);}},core:{hub:{isOwnedSession:id=>id==='session-abc',chatOfSession:()=> 'private:100'}}};
  const stop=observeHostActivity(api,{runtime:r,active:()=>true,allowedChat:id=>id==='private:100',persona:()=> 'aurabot:test'}),session={id:'session-abc'},emit=(type,data)=>listeners.get('session/event')(session,{type,data});
  emit('turn/start',{turn:1});emit('assistant/message',{turn:1,message:{content:[{type:'text',text:'你好，我在这里。'}]}});emit('turn/end',{turn:1,reason:{kind:'completed'}});
  const turn=r.dialogue.get('dialogue_turns',recall.id);assert.equal(turn.reply,'你好，我在这里。');assert.equal(turn.delivery,'completed_session_output_not_delivery');
  const sentinel={unchanged:true};assert.equal(listeners.get('tools/pre-execute')({name:'search',callId:'one',arguments:{secret:'not_stored'},agent:{session}},()=>sentinel),sentinel);
  emit('tool/result',{message:{toolCallId:'one',content:[{type:'text',text:'private tool result must not be copied'}]}});
  const tools=r.dialogue.list({category:'tool'}).items;assert.equal(tools.length,1);assert.equal(tools[0].status,'result_observed');assert.ok(!JSON.stringify(tools).includes('not_stored'));assert.equal(r.dialogue.list({category:'interaction'}).items.length,0);
  stop();assert.equal(listeners.size,0);
});
test('unrelated DSH sessions and a changed persona cannot be attributed to the previous dialogue',t=>{
  const r=new V5Runtime(),listeners=new Map();t.after(()=>r.close());const stop=observeHostActivity({dsh:{on:(n,f)=>{listeners.set(n,f);return()=>listeners.delete(n);}},core:{hub:{isOwnedSession:()=>false,chatOfSession:()=> 'private:100'}}},{runtime:r,active:()=>true,allowedChat:()=>true,persona:()=> 'test'});
  listeners.get('session/event')({id:'unowned'},{type:'assistant/message',data:{message:{content:[{type:'text',text:'Unrelated conversation'}]}}});assert.equal(r.store.stats().sources,0);assert.equal(r.dialogue.list().items.length,0);stop();
});
