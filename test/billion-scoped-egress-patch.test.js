import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {patchBillionScopedEgress,scopedEgressFunction,scopedHttpEgressBudget,resolveScopedImageRef,BILI_SCOPED_EGRESS_VERSION} from '../scripts/lib/billion-scoped-egress-patch.js';
import {writeTestResult} from '../scripts/lib/test-workspace.js';
const source=process.env.BILI_KERNEL_FILE?fs.readFileSync(process.env.BILI_KERNEL_FILE,'utf8'):null;
const endpoint='http://127.0.0.1:34567/v1/chat/completions';
const contextFor=(extra={})=>({sessionId:'synthetic-owner',upstreamUrl:endpoint,phase:'pre-send',...extra});
const ruleFor=(extra={})=>({conversationId:'synthetic-owner',upstream:endpoint,bytes:7000,...extra});
const sha=value=>createHash('sha256').update(value).digest('hex');
function runtime(patched,{globalBudget=10000,rules=[ruleFor()],transport='http'}={}){
 const text=patched?patchBillionScopedEgress(source,{version:BILI_SCOPED_EGRESS_VERSION}).source:source;
 const imageCache=new Map,context=vm.createContext({Buffer,URL,Date,Math,Set,Map,JSON,Number,settings:{network:{httpScopedBudgets:rules}},globalBudget,transport,readFile6:async file=>{if(!imageCache.has(file))throw Error('missing synthetic image');return imageCache.get(file);}});
 const helpers=['byteLen2','formatMiB2','dataUrl','shedNote','parseDataUrl','collectOccurrences'].map(n=>scopedEgressFunction(source,n).text).join('');
 vm.runInContext(`var downscaleCalls=0,restored=new Map,PROTECTED_TAIL_ENTRIES=8,DOWNSCALE_DIM_LADDER=[1024,768,512,384],MAX_SHED_IMAGES=64;
 const isObj4=x=>!!x&&typeof x==='object'&&!Array.isArray(x),decodeImageDims=()=>undefined,callNameMap=()=>new Map,isExemptOutput=()=>false,matchesOriginalImageReceipt=()=>false;
 const currentFetchTransport=()=>transport==='http'?undefined:{kind:transport},isWsLaneTransport=t=>t?.kind==='ws',limitsWsOutboundBytes=()=>10000,limitsHttpOutboundBytes=()=>globalBudget,loadConfigFile=()=>settings;
 const refForItemBytes=async(_session,_media,b64)=>restored.get(b64),shedDownscaleImage=async()=>{downscaleCalls++;return'AA==';};
 `+helpers+scopedHttpEgressBudget.toString()+resolveScopedImageRef.toString()+scopedEgressFunction(text,'shedWireImages').text+scopedEgressFunction(text,'shedEgressIfOverBudget').text,context,{timeout:1000});
 return {async run(body,ctx=contextFor(),protocol='openai'){
  context.body=body;context.ctx={...ctx,session:{metadata:{},incomingImageIndex:new Map,state:{messageRefs:{byRef:{},byRaw:{}}}}};context.protocol=protocol;
  const parsed=JSON.parse(body);for(const [i,m]of (parsed.messages||[]).entries())for(const p of m.content||[])if(p.type==='image_url'){
   const b64=p.image_url.url.split(',')[1],ref='m'+String(i).padStart(5,'0'),raw='raw-'+i,file='synthetic-image-'+i,original=Buffer.from(b64,'base64');context.restored.set(b64,ref);imageCache.set(file,original);
   context.ctx.session.incomingImageIndex.set(ref,[{bytes:original.length,mediaType:'image/png',path:file}]);context.ctx.session.state.messageRefs.byRef[ref]=raw;context.ctx.session.state.messageRefs.byRaw[raw]=ref;
  }
  const out=await vm.runInContext('shedEgressIfOverBudget(body,protocol,ctx)',context,{timeout:1000});
  return {out:JSON.parse(JSON.stringify(out)),downscaleCalls:context.downscaleCalls};
 }};
}
function fixture(){
 const messages=Array.from({length:12},(_,i)=>({role:i%2?'assistant':'user',content:[{type:'text',text:'UNCHANGED_TEXT_'+i+' condition=123.456; '.repeat(2)}]}));
 for(const i of [0,1,2,11])messages[i].content.push({type:'image_url',image_url:{url:'data:image/png;base64,'+Buffer.alloc(1536,i+1).toString('base64')}});
 messages[5].tool_calls=[{id:'synthetic-call',type:'function',function:{name:'read_fixture',arguments:'{"exact":123.456}'}}];
 return JSON.stringify({model:'synthetic',messages,tools:[{type:'function',function:{name:'read_fixture',parameters:{type:'object'}}}]});
}
test('scoped rule requires exact private conversation and exact loopback model URL and only lowers a positive global budget',()=>{
 assert.equal(scopedHttpEgressBudget(10000,'openai',contextFor(),[ruleFor()]),7000);
 for(const ctx of [contextFor({sessionId:'other'}),contextFor({upstreamUrl:endpoint.replace('34567','34568')}),contextFor({phase:'utility'}),contextFor({upstreamUrl:'https://example.com/v1/chat/completions'}),contextFor({upstreamUrl:endpoint+'?extra=1'})])assert.equal(scopedHttpEgressBudget(10000,'openai',ctx,[ruleFor()]),undefined);
 assert.equal(scopedHttpEgressBudget(10000,'anthropic',contextFor(),[ruleFor()]),undefined);
 for(const bytes of [0,-1,NaN,10000,20000])assert.equal(scopedHttpEgressBudget(10000,'openai',contextFor(),[ruleFor({bytes})]),undefined);
 assert.equal(scopedHttpEgressBudget(0,'openai',contextFor(),[ruleFor()]),undefined);
 assert.equal(scopedHttpEgressBudget(10000,'openai',contextFor({phase:'loop'}),[ruleFor()]),7000);
});
test('scoped image pointers require exact cached pixels and a live source alias; identical duplicate images resolve deterministically',async()=>{
 const exact=Buffer.from('exact-image-pixels'),different=Buffer.from('other-image-pixel!');assert.equal(exact.length,different.length);
 const session={incomingImageIndex:new Map([['m00001',[{bytes:exact.length,mediaType:'image/png',path:'original'}]]]),state:{messageRefs:{byRef:{m00001:'raw-a'},byRaw:{'raw-a':'m00001'}}}};
 await assert.rejects(resolveScopedImageRef(session,'image/png',exact.toString('base64'),async()=>different),/exact original pixels/);
 await assert.rejects(resolveScopedImageRef(session,'image/png',exact.toString('base64'),async()=>{throw Error('missing cache');}),/exact original pixels/);
 const missingRef=structuredClone(session);missingRef.state.messageRefs.byRaw={};await assert.rejects(resolveScopedImageRef(missingRef,'image/png',exact.toString('base64'),async()=>exact),/source reference/);
 await assert.rejects(resolveScopedImageRef({state:session.state},'image/png',exact.toString('base64'),async()=>exact),/verified original-image cache/);
 session.incomingImageIndex.set('m00002',[{bytes:exact.length,mediaType:'image/png',path:'duplicate'}]);session.state.messageRefs.byRef.m00002='raw-b';session.state.messageRefs.byRaw['raw-b']='m00002';
 assert.equal(await resolveScopedImageRef(session,'image/png',exact.toString('base64'),async()=>exact),'m00001');
});
test('patch is version and exact-source guarded and only adds upstream context at the two known calls',t=>{
 assert.throws(()=>patchBillionScopedEgress('',{version:'unknown'}),/Unsupported/);
 if(!source){t.skip('BILI_KERNEL_FILE required for exact source proof');return;}
 const patched=patchBillionScopedEgress(source,{version:BILI_SCOPED_EGRESS_VERSION});
 assert.throws(()=>patchBillionScopedEgress(patched.source,{version:BILI_SCOPED_EGRESS_VERSION}),/hash mismatch/);
 assert.ok(patched.source.includes('phase:"pre-send",upstreamUrl}'));
 assert.ok(patched.source.includes('phase:"loop",upstreamUrl:requestOptions.url}'));
 // The hard outbound body limit and final provider-forward code are untouched.
 const hard='try{checkOutboundBody(wireBody)}';assert.equal(patched.source.split(hard).length,source.split(hard).length);
 const tail=source.indexOf(hard);assert.ok(tail>0);assert.equal(patched.source.slice(patched.source.indexOf(hard)),source.slice(tail));
});
test('scoped image archive retains all source bytes, text, tool arguments and protected eight wire entries without downscaling',async t=>{
 if(!source){t.skip('BILI_KERNEL_FILE required for exact image shedding proof');return;}
 const body=fixture(),before=JSON.parse(body),result=await runtime(true).run(body),after=JSON.parse(result.out.body);
 assert.ok(result.out.stats.originalBytes>7000);assert.ok(result.out.stats.finalBytes<=7000);assert.ok(result.out.stats.archived>0);assert.equal(result.downscaleCalls,0);assert.equal(result.out.stats.downscaled,0);
 assert.deepEqual(after.messages.slice(-8),before.messages.slice(-8));assert.deepEqual(after.tools,before.tools);
 for(let i=0;i<before.messages.length;i++){
  assert.equal(after.messages[i].content[0].text,before.messages[i].content[0].text);
  assert.deepEqual(after.messages[i].tool_calls,before.messages[i].tool_calls);
 }
 assert.equal(sha(body),sha(fixture()),'the original source string remains unchanged');
 for(const [i,m]of after.messages.entries())for(const p of m.content||[])if(p.type==='text'&&p.text.startsWith('[image:')){
  assert.ok(p.text.includes('m'+String(i).padStart(5,'0')));assert.ok(before.messages[i].content.some(x=>x.type==='image_url'));
 }
 writeTestResult({synthetic:true,kind:'exact-scoped-http-image-shedding',realModelCalls:0,qqSends:0,sourceSha256:sha(body),originalBytes:result.out.stats.originalBytes,finalBytes:result.out.stats.finalBytes,archived:result.out.stats.archived,downscaled:result.out.stats.downscaled,originalSourcesRetained:true,textAndToolArgumentsRetained:true,protectedEightWireEntriesRetained:true});
});
test('other sessions, endpoints, protocols, WS and absent local rules preserve exact original output and stats',async t=>{
 if(!source){t.skip('BILI_KERNEL_FILE required for exact differential proof');return;}
 const body=fixture();
 for(const mode of ['no-rule','other-session','other-url','ws','managed']){
  const options={rules:mode==='no-rule'?[]:[ruleFor()],transport:mode==='ws'?'ws':mode==='managed'?'managed':'http'};
  const ctx=contextFor(mode==='other-session'?{sessionId:'other'}:mode==='other-url'?{upstreamUrl:endpoint.replace('34567','34568')}:{});
  const original=await runtime(false,options).run(body,ctx),patched=await runtime(true,options).run(body,ctx);
  assert.deepEqual(patched,original,mode);
 }
 const original=await runtime(false).run(body,contextFor(),'anthropic'),patched=await runtime(true).run(body,contextFor(),'anthropic');assert.deepEqual(patched,original);
});
test('scoped path refuses before forward when only recent images remain; unscoped resizing policy stays unchanged',async t=>{
 if(!source){t.skip('BILI_KERNEL_FILE required for exact archive-only proof');return;}
 const body=JSON.stringify({messages:[{role:'user',content:[{type:'text',text:'CURRENT_EXACT_IMAGE_TASK'},{type:'image_url',image_url:{url:'data:image/png;base64,'+Buffer.alloc(1536,7).toString('base64')}}]}]});
 await assert.rejects(runtime(true,{globalBudget:1500,rules:[ruleFor({bytes:1000})]}).run(body),/retaining recent image pixels/);
 const original=await runtime(false,{globalBudget:1500,rules:[]}).run(body),patched=await runtime(true,{globalBudget:1500,rules:[]}).run(body);
 assert.ok(original.downscaleCalls>0);assert.deepEqual(patched,original);
});
