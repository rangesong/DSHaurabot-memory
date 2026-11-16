import test from 'node:test';
import assert from 'node:assert/strict';
import { HostContextMonitor } from '../adapters/aurabot/module/lib/host-context-monitor.js';

function fixture(){
  const route={provider:'synthetic-provider',model:'synthetic-model'},listeners=new Map(),rows=new Map();
  let occupied=7000,current=route,active=true,allowed=true,now=1000;
  const session={requestContext:()=>({...route,contextWindow:12000}),requestHeader:()=>({config:{...route,maxTokens:2048}})};
  const services={agents:{get:id=>id==='session-a'?{session,model:{current:()=>current}}:null},tokenMeter:{measure:()=>({totalTokens:occupied,baseline:{kind:'estimated'}})}};
  const api={dsh:{get:name=>services[name],on(name,fn){listeners.set(name,fn);return()=>listeners.delete(name);}}};
  const monitor=new HostContextMonitor(api,{active:()=>active,clock:()=>now,load:id=>structuredClone(rows.get(id)),save:row=>rows.set(row.id,structuredClone(row)),valid:(row,chatId)=>allowed&&row.scope==='scope-a'&&chatId==='private:100'});monitor.start();
  const row={id:'recall-a',scope:'scope-a',context:[{id:'memory-a',text:'合成来源'}],host_context_ids:['memory-a'],actual_use:'unknown',model_actual_use:'unknown',candidates:[{id:'memory-a',actual_use:false}]};
  rows.set(row.id,structuredClone(row));monitor.prepare(row,{sessionId:'session-a',chatId:'private:100',text:'完整合成证据包 nonce-a'});
  const request=()=>Object.freeze({...route,sessionId:'session-a',maxTokens:2048,messages:Object.freeze([Object.freeze({role:'user',source:{kind:'aurabot'},content:[{type:'text',text:'完整合成证据包 nonce-a'}]})])});
  const normal=[{type:'text-delta',text:'合成回答'},{type:'usage',usage:{inputTokens:100,outputTokens:20,cacheReadTokens:50,cacheWriteTokens:30}},{type:'finish',reason:{kind:'stop'}}];
  const stream=async function*(chunks=normal){for(const chunk of chunks)yield chunk;};
  return {monitor,api,rows,listeners,request,normal,stream,services,session,setOccupied:value=>occupied=value,setCurrent:value=>current=value,setActive:value=>active=value,setAllowed:value=>allowed=value,setClock:value=>now=value};
}

test('session metering shrinks the cap to zero without changing configuration, and route changes fall back',()=>{
  const f=fixture(),options={sessionId:'session-a',cap:1536,stableCost:128,content:[{type:'text',text:'合成新问题'}]};
  const sized=f.monitor.budget(options);assert.equal(sized.mode,'host_meter_estimate');assert.ok(sized.available<1408);assert.equal(sized.context_window,12000);assert.equal(sized.complete_final_window_known,false);
  f.setOccupied(11500);assert.equal(f.monitor.budget(options).available,0);
  f.setCurrent({provider:'other',model:'changed'});const fallback=f.monitor.budget(options);assert.equal(fallback.mode,'module_cap_fallback');assert.equal(fallback.available,1408);assert.equal(options.cap,1536);
});

test('first turn, absent services and failed measurement safely retain the module cap',()=>{
  const f=fixture();assert.equal(f.monitor.budget({sessionId:'unknown',cap:1536}).mode,'module_cap_fallback');
  f.services.tokenMeter.measure=()=>{throw Error('synthetic meter failure');};assert.equal(f.monitor.budget({sessionId:'session-a',cap:1536}).available,1536);
  delete f.services.tokenMeter;assert.equal(f.monitor.status().session_meter,false);
  const absent=new HostContextMonitor({},{});absent.start();assert.equal(absent.status().request_observer,false);assert.equal(absent.budget({cap:256}).available,256);
});

test('Aurabot shortened session keys resolve to the actual live session without conflating exact identities',async()=>{
  const f=fixture();f.session.id='session-a';f.monitor.pending.clear();f.monitor.prepare(f.rows.get('recall-a'),{sessionId:'a',chatId:'private:100',text:'完整合成证据包 nonce-a'});
  assert.equal(f.monitor.budget({sessionId:'a',cap:1536}).mode,'host_meter_estimate');assert.ok(f.monitor.pending.has('session-a'));for await(const chunk of f.monitor.observe(f.request(),()=>f.stream())){}assert.equal(f.rows.get('recall-a').host_receipts[0].completion,'completed');
  const other=fixture();other.monitor.pending.clear();other.services.agents.get=id=>id==='a'?{session:{...other.session,id:'a'}}:id==='session-a'?{session:{...other.session,id:'session-a'}}:null;other.monitor.prepare(other.rows.get('recall-a'),{sessionId:'a',chatId:'private:100',text:'完整合成证据包 nonce-a'});for await(const chunk of other.monitor.observe(other.request(),()=>other.stream())){}assert.equal(other.rows.get('recall-a').host_receipts,undefined);
});

test('DSH request observation preserves object and chunks, records whole-call usage, never claims actual use',async()=>{
  const f=fixture(),request=f.request(),before=JSON.stringify(request);let calls=0;
  const output=[];for await(const chunk of f.listeners.get('llm/stream')(request,()=>{calls++;return f.stream();}))output.push(chunk);
  assert.equal(calls,1);assert.equal(JSON.stringify(request),before);assert.deepEqual(output,f.normal);for(let i=0;i<output.length;i++)assert.equal(output[i],f.normal[i]);
  const row=f.rows.get('recall-a'),receipt=row.host_receipts[0];assert.equal(row.request_inclusion,'observed_at_dsh_llm_boundary');assert.equal(receipt.completion,'completed');assert.deepEqual(receipt.included_ids,['memory-a']);assert.equal(receipt.usage.prompt_tokens,180);assert.equal(receipt.usage.total_tokens,200);assert.equal(receipt.window.input_estimate,7000);
  assert.equal(row.actual_use,'unknown');assert.equal(row.model_actual_use,'unknown');assert.equal(row.candidates[0].actual_use,false);assert.equal(f.monitor.status().completed,1);
});

test('unrelated sessions, partial evidence, wrong message source, stale identity and expired preparation never receive receipts',async()=>{
  for(const mutate of [r=>({...r,sessionId:'another'}),r=>({...r,messages:[{...r.messages[0],content:[{type:'text',text:'nonce-a'}]}]}),r=>({...r,messages:[{...r.messages[0],source:{kind:'user'}}]})]){
    const f=fixture(),stream=f.stream(),output=f.monitor.observe(mutate(f.request()),()=>stream);assert.equal(output,stream);for await(const chunk of output){}assert.equal(f.rows.get('recall-a').host_receipts,undefined);
  }
  for(const invalidate of [f=>f.setAllowed(false),f=>f.setActive(false),f=>f.setClock(31*60000),f=>{f.rows.get('recall-a').context=[];}]){
    const f=fixture();invalidate(f);for await(const chunk of f.monitor.observe(f.request(),()=>f.stream())){}assert.equal(f.rows.get('recall-a').host_receipts,undefined);
  }
});

test('stream errors and cancellation stay errors; incomplete streams never become successful use',async()=>{
  const f=fixture(),error=Error('synthetic stream error');
  await assert.rejects(async()=>{for await(const chunk of f.monitor.observe(f.request(),()=>({async *[Symbol.asyncIterator](){yield f.normal[0];throw error;}}))){}},error);
  assert.equal(f.rows.get('recall-a').host_receipts[0].completion,'stream_threw');assert.equal(f.rows.get('recall-a').model_usage,null);
  const broken=fixture();assert.throws(()=>broken.monitor.observe(broken.request(),()=>{throw error;}),error);assert.equal(broken.rows.get('recall-a').host_receipts[0].completion,'dispatch_threw');
  const cancelled=fixture();for await(const chunk of cancelled.monitor.observe(cancelled.request(),()=>cancelled.stream([{type:'finish',reason:{kind:'aborted'}}]))){}assert.equal(cancelled.rows.get('recall-a').host_receipts[0].completion,'aborted');
});

test('privacy erasure and disposal during a stream cannot resurrect prepared memory or leave listeners mounted',async()=>{
  const f=fixture(),output=f.monitor.observe(f.request(),()=>f.stream());f.rows.get('recall-a').context=[];for await(const chunk of output){}
  assert.equal(f.rows.get('recall-a').context.length,0);assert.equal(f.rows.get('recall-a').host_receipts[0].completion,'pending');
  const stopped=fixture(),late=stopped.monitor.observe(stopped.request(),()=>stopped.stream());stopped.monitor.stop();for await(const chunk of late){}
  assert.equal(stopped.listeners.size,0);assert.equal(stopped.monitor.pending.size,0);assert.equal(stopped.rows.get('recall-a').host_receipts[0].completion,'pending');
});

test('observation failure never prevents the original model call; receipt history is bounded',async()=>{
  const f=fixture();for(let i=0;i<12;i++)for await(const chunk of f.monitor.observe(f.request(),()=>f.stream())){}
  assert.equal(f.rows.get('recall-a').host_receipts.length,8);
  f.monitor.save=()=>{throw Error('synthetic write failure');};let calls=0;for await(const chunk of f.monitor.observe(f.request(),()=>{calls++;return f.stream();})){}assert.equal(calls,1);
});
