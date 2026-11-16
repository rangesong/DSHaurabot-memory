import { randomUUID } from 'node:crypto';

const number=value=>Number.isFinite(value)&&value>=0?value:null;
const sameRoute=(a,b)=>!!a?.provider&&a.provider===b?.provider&&a.model===b?.model;
const textBlocks=message=>(message?.content??[]).filter(block=>block.type==='text'&&typeof block.text==='string').map(block=>block.text);

/** Optional, read-only DSH services. Never rewrite a frozen request or intercept sending. */
export class HostContextMonitor {
  constructor(api,{active,load,save,valid,onCompletion=()=>{},clock=Date.now}){
    Object.assign(this,{api,active,load,save,valid,onCompletion,clock});
    this.pending=new Map();this.isolatedSessions=new Map();this.connected=false;this.closed=false;
    this.summary={requests:0,completed:0,failed:0,last:null};
  }
  service(name){try{return this.api.dsh?.get?.(name)??this.api.dsh?.[name];}catch{return null;}}
  sessionCandidates(id){if(typeof id!=='string'||!id)return [];return [id,id.startsWith('session-')?id.slice(8):'session-'+id];}
  agent(id){try{for(const candidate of this.sessionCandidates(id)){const agent=this.service('agents')?.get?.(candidate);if(agent)return agent;}return null;}catch{return null;}}
  session(id){try{for(const candidate of this.sessionCandidates(id)){const session=this.isolatedSessions.get(candidate)?.session??this.service('agents')?.get?.(candidate)?.session??this.service('sessions')?.get?.(candidate);if(session)return session;}return null;}catch{return null;}}
  bindIsolated(session,cap){if(!this.isolatedSessions.has(session.id)&&this.isolatedSessions.size>=4)throw Error('隔离请求数量过多');this.isolatedSessions.set(session.id,{session,cap});}
  isolatedCap(id){return this.isolatedSessions.get(this.session(id)?.id??id)?.cap;}
  releaseIsolated(id){this.isolatedSessions.delete(id);this.pending.delete(id);}
  start(){
    try{
      if(typeof this.api.dsh?.on==='function'){
        this.off=this.api.dsh.on('llm/stream',(request,next)=>this.observe(request,next));
        this.connected=typeof this.off==='function';
      }
    }catch{this.connected=false;}
  }
  stop(){this.closed=true;try{this.off?.();}finally{this.pending.clear();this.isolatedSessions.clear();this.connected=false;}}
  status(){return {request_observer:this.connected,session_meter:typeof this.service('tokenMeter')?.measure==='function',...this.summary};}
  budget({sessionId,content=[],stableCost=0,cap}){
    const fallback={mode:'module_cap_fallback',cap,available:Math.max(0,cap-stableCost),complete_final_window_known:false};
    try{
      const session=this.session(sessionId),meter=this.service('tokenMeter');
      const context=session?.requestContext?.(),header=session?.requestHeader?.();
      const selection=this.agent(sessionId)?.model?.current?.()??header?.config;
      // Do not borrow the preceding model's capacity when a route has just changed.
      if(!sameRoute(context,selection)||!sameRoute(header?.config,selection)||!(context.contextWindow>0)||typeof meter?.measure!=='function')return fallback;
      const measured=meter.measure(session),occupied=number(measured.totalTokens);
      if(occupied===null)return fallback;
      const incoming=Math.ceil(JSON.stringify(content).length/2)+32;
      const outputReserve=number(header.config.maxTokens)??Math.max(2048,cap);
      // Later Aurabot additions and the refreshed system prompt are not yet admitted.
      const safetyReserve=Math.max(2048,Math.ceil(context.contextWindow*.05));
      const remaining=Math.max(0,Math.floor(context.contextWindow-occupied-incoming-outputReserve-safetyReserve-stableCost));
      return {...fallback,mode:'host_meter_estimate',available:Math.min(fallback.available,remaining),context_window:context.contextWindow,occupied_estimate:occupied,incoming_estimate:incoming,output_reserve:outputReserve,safety_reserve:safetyReserve,meter_baseline:measured.baseline?.kind??'estimated'};
    }catch{return fallback;}
  }
  prepare(row,{sessionId,chatId,text}){
    if(!this.connected||!sessionId||!text||this.closed)return;
    sessionId=this.session(sessionId)?.id??sessionId;
    const now=this.clock();
    for(const [id,rows]of this.pending){for(const [key,value]of rows)if(now-value.at>30*60000)rows.delete(key);if(!rows.size)this.pending.delete(id);}
    if(!this.pending.has(sessionId))this.pending.set(sessionId,new Map());
    const rows=this.pending.get(sessionId);rows.set(row.id,{id:row.id,scope:row.scope,chatId,text,at:now});
    while(rows.size>8)rows.delete(rows.keys().next().value);
    while(this.pending.size>32)this.pending.delete(this.pending.keys().next().value);
  }
  live(prepared){
    if(this.closed||!this.active()||this.clock()-prepared.at>30*60000)return null;
    const row=this.load(prepared.id);
    return row?.scope===prepared.scope&&(row.context?.length||row.dialogue_strategy?.text)&&this.valid(row,prepared.chatId)?row:null;
  }
  measureRequest(request){
    try{
      const session=this.session(request.sessionId),context=session?.requestContext?.(),meter=this.service('tokenMeter');
      if(!sameRoute(context,request)||typeof meter?.measure!=='function')return null;
      const measured=meter.measure(session),tokens=number(measured.totalTokens);
      if(tokens===null)return null;
      const reserved=number(request.maxTokens);
      return {context_window:context.contextWindow??null,input_estimate:tokens,output_reserve:reserved,remaining_estimate:context.contextWindow>0&&reserved!==null?Math.max(0,context.contextWindow-tokens-reserved):null,precision:'host_meter_estimate',stage:'dsh_llm_boundary'};
    }catch{return null;}
  }
  observe(request,next){
    if(this.closed||!this.active())return next();
    let attempts=[];
    try{
      const rows=this.pending.get(request?.sessionId);
      if(rows?.size){
        // Historical injected packets also occur in later requests. Only the current user message is binding evidence.
        const latest=(request.messages??[]).filter(message=>message?.source?.kind==='aurabot'&&message.role!=='assistant').at(-1);
        const blocks=latest?textBlocks(latest):[];
        const measurement=this.measureRequest(request);
        for(const prepared of rows.values()){
          const row=this.live(prepared);if(!row||!blocks.some(text=>text.includes(prepared.text)))continue;
          const receipt={id:randomUUID(),at:this.clock(),stage:'observed_at_dsh_llm_boundary',provider:request.provider,model:request.model,included_ids:[...(row.host_context_ids??[])],window:measurement,completion:'pending',usage:null,isolated_evaluation:!!row.evaluation};
          row.request_inclusion='observed_at_dsh_llm_boundary';
          row.host_receipts=[...(row.host_receipts??[]),receipt].slice(-8);this.save(row);
          attempts.push({prepared,receipt});
        }
      }
    }catch{attempts=[];} // Observation must not break the host's request.
    if(!attempts.length)return next();
    this.summary.requests++;this.summary.last={at:this.clock(),stage:'observed_at_dsh_llm_boundary',completion:'pending'};
    let stream;
    try{stream=next();}catch(error){this.settle(attempts,'dispatch_threw',null);throw error;}
    return this.wrap(stream,attempts);
  }
  async *wrap(stream,attempts){
    let completion='interrupted',usage=null;const blocks=new Map();
    try{
      for await(const chunk of await stream){
        if(chunk?.type==='block-end'&&chunk.block?.type==='text'&&typeof chunk.block.text==='string')blocks.set(chunk.index??blocks.size,chunk.block.text);
        if(chunk?.type==='usage'&&chunk.usage){
          const input=number(chunk.usage.inputTokens),output=number(chunk.usage.outputTokens);
          // DSH uses disjoint buckets: inputTokens excludes cached reads/writes.
          const cached=number(chunk.usage.cacheReadTokens??0),written=number(chunk.usage.cacheWriteTokens??0);
          const prompt=input!==null&&cached!==null&&written!==null?input+cached+written:null;
          usage={prompt_tokens:prompt,uncached_input_tokens:input,completion_tokens:output,total_tokens:prompt!==null&&output!==null?prompt+output:null,cache_read_tokens:cached,cache_write_tokens:written,known:prompt!==null&&output!==null,source:'dsh_llm_stream'};
        }
        if(chunk?.type==='finish')completion=['stop','tool-calls','max-tokens'].includes(chunk.reason?.kind)?'completed':chunk.reason?.kind??'unknown';
        yield chunk;
      }
    }catch(error){completion='stream_threw';throw error;}
    finally{this.settle(attempts,completion,usage,[...blocks.entries()].sort((a,b)=>a[0]-b[0]).map(([,text])=>text).join('\n'));}
  }
  settle(attempts,completion,usage,text=''){
    if(this.closed)return;
    try{
      for(const {prepared,receipt}of attempts){
        const row=this.live(prepared);if(!row)continue;
        const target=row.host_receipts?.find(value=>value.id===receipt.id);if(!target)continue;
        Object.assign(target,{completion,usage,settled_at:this.clock()});
        // Provider usage belongs to the whole call, never just this memory package.
        row.model_usage=usage;row.model_actual_use='unknown';row.actual_use='unknown';this.save(row);
        if(completion==='completed'&&text&&!row.evaluation)this.onCompletion({row,prepared,text,completion,usage});
      }
      if(completion==='completed')this.summary.completed++;else this.summary.failed++;
      this.summary.last={at:this.clock(),stage:'observed_at_dsh_llm_boundary',completion,usage};
    }catch{} // Privacy erasure or unload can invalidate an in-flight observation.
  }
}
