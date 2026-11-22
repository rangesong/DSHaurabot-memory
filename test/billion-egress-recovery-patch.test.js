import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {patchBillionEgressRecovery,recoveryFunction,egressRecoveryProtectedStart,egressRecoveryRanges,BILI_EGRESS_RECOVERY_VERSION,BILI_EGRESS_RECOVERY_MAX_ATTEMPTS} from '../scripts/lib/billion-egress-recovery-patch.js';
import {writeTestResult} from '../scripts/lib/test-workspace.js';
const source=process.env.BILI_KERNEL_FILE?fs.readFileSync(process.env.BILI_KERNEL_FILE,'utf8'):null;
const extract=name=>recoveryFunction(source,name).text;
function meterSource(){
 const at=source.indexOf('var NON_TEXT_BODY_KEYS=');assert.ok(at>=0);
 return source.slice(at,source.indexOf(';',at)+1)+extract('defaultCountTokens')+extract('estimateRawBodyBreakdown')+extract('measuredOutbound');
}
function outerRuntime(patched){
 const text=patched?patchBillionEgressRecovery(source,{version:BILI_EGRESS_RECOVERY_VERSION}).source:source;
 const context=vm.createContext({AbortController,Date,Math,JSON,Set,Map,Number,setTimeout:()=>({unref(){}}),clearTimeout(){}});
 vm.runInContext(`
 var MIN_ASSUMED_WINDOW_TOKENS=1000000,CODEX_COMPACT_HEALTH_RATIO=.8,AUTO_FOLD_TARGET_MIN=20000,AUTO_FOLD_MIN_BENEFIT_TOKENS=1,DOOMED_PROBE_ABSOLUTE_BYTES=1e9,DOOMED_PROBE_BYTES_PER_TOKEN=4,armJudgingWallLogged=new Set,defaultPrompts={};
 var folds=0,receivedDeps,logs=[],rebuild;
 const autoFoldEngaged=()=>false,normalizeUpstreamOrigin=x=>x,currentCalibrationFactor=()=>undefined,applyEstimateCalibration=n=>n,limitsMaxMessages=()=>0,localRefusalCovers=()=>false;
 const outboundPayloadBreakdown=p=>({textEstimate:p.projectedTokens,overheadEstimate:0,imageTokens:0});
 const estimateCoreMessages=ms=>ms.reduce((n,m)=>n+defaultCountTokens(m.text||''),0),estimateCoreMessagesUpper=estimateCoreMessages,estimateCoreMessagesUpperBytes=()=>0;
 const buildForwardTarget=()=>({upstreamUrl:'https://new.example/v1/chat/completions',headers:{}}),registerRequestAbort=()=>{},preflightHoldGraceMs2=()=>0,beginPreflightHold=()=>()=>{},resolveCompress=()=>({}),inboundResignCredential=()=>undefined,externalQueueDroppedAll=()=>false,imageReserveFor=()=>0,setPostRebuildAnchor=()=>{};
 const maskUrlForLog=x=>x;
 async function preflightCompress(deps){folds++;receivedDeps=deps;return{compressedRanges:1,savedTokens:600000,payloadEstimate:300000,rangesRemaining:0,fitsWindow:true,hadFoldableCandidates:true};}
 `+meterSource()+recoveryFunction(text,'preflightCompressIfNeeded').text,context,{timeout:1000});
 return {context,async run(rawTokens,{nativeWindow=1000000,projectedTokens=900000,declaredMissing=false}={}){
  context.rawTokens=rawTokens;context.nativeWindow=nativeWindow;context.projectedTokens=projectedTokens;context.declaredMissing=declaredMissing;
  return await vm.runInContext(`(async()=>{
   const session={id:'synthetic',state:{blocks:[{blockId:'old-block',active:true}]},metadata:{effectiveContextLimit:nativeWindow},stats:{lastInputTokens:150753,lastInputTokensSource:'usage',lastInputTokensOrigin:'https://old.example'}};
   if(declaredMissing)delete session.metadata.effectiveContextLimit;
   const message={id:'synthetic-source',role:'user',text:'中'.repeat(projectedTokens)};
   const prepared={session,protocol:'openai',projectedTokens,originalMessages:[message],processedMessages:[message],prompts:{},body:JSON.stringify({model:'synthetic',messages:[{role:'user',content:'中'.repeat(rawTokens)}]})};
   rebuild={...prepared,projectedTokens:300000,processedMessages:[{...message,text:'中'.repeat(300000)}],body:JSON.stringify({model:'synthetic',messages:[{role:'user',content:'中'.repeat(300000)}]})};
   const output=await preflightCompressIfNeeded(prepared,async()=>rebuild,{headers:{},url:'/v1/chat/completions'},'',{on(){},writableEnded:false},{routes:{},debug:false},{},{modelContextLimit:750000},750000,'synthetic',nativeWindow,undefined,{upstream:'https://new.example'},undefined,false,()=>{},'fixture');
   return {same:output===prepared,folds,input:measuredOutbound(prepared).tokens,output:measuredOutbound(output).tokens,budget:receivedDeps?.egressRecoveryBudget?.remaining,recovery:receivedDeps?.egressRecovery,originalBlock:session.state.blocks[0]};
  })()`,context,{timeout:1500});
 }};
}
function requestRuntime(patched){
 const text=patched?patchBillionEgressRecovery(source,{version:BILI_EGRESS_RECOVERY_VERSION}).source:source;
 const context=vm.createContext({Date,Math,JSON,Set,Map,Number,URL});
 vm.runInContext(`var sends=0,MIN_CHUNK_TOKENS=2000,CHUNK_FRACTION=.6;
 class UpstreamHttpError extends Error{constructor(status,body,attempts){super('HTTP '+status);Object.assign(this,{status,body,attempts})}}
 class SummaryTransportError extends Error{constructor(stage,error){super(error.message);this.retryable=false}}
 const replayMaxAttempts2=()=>5,summaryHeaders=()=>({}),proxyDispatcher=()=>undefined,isCredentialShapeRejection=()=>false,isTransientUpstreamError=()=>true,dumpSummaryRejection=()=>{},replayBackoffMs=()=>0,sleep=async()=>{},lastCompressSuffix=()=>'';
 const fetchWithTimeout=async()=>{sends++;return{clearTimer(){},response:{ok:false,status:429,text:async()=>'synthetic rate limit'}}};
 `+meterSource()+recoveryFunction(text,'requestSummaryBody').text,context,{timeout:1000});
 return {async run({bounded=true,tokens=1000}={}){
  context.bounded=bounded;context.tokens=tokens;
  return await vm.runInContext(`(async()=>{const budget=bounded?{remaining:${BILI_EGRESS_RECOVERY_MAX_ATTEMPTS}}:undefined;const deps={config:{modelContextLimit:750000},url:'https://synthetic.example',headers:{},protocol:'openai',streamSummaryOff:true,session:{id:'synthetic'},log(){},egressRecoveryBudget:budget};try{await requestSummaryBody(deps,JSON.stringify({messages:[{role:'user',content:'中'.repeat(tokens)}]}),false)}catch(error){return{sends,remaining:budget?.remaining,error:error.message}}})()`,context,{timeout:1500});
 }};
}
test('egress patch refuses unknown versions, changed functions and duplicate application',t=>{
 assert.throws(()=>patchBillionEgressRecovery('',{version:'unknown'}),/Unsupported/);
 if(!source){t.skip('BILI_KERNEL_FILE required for exact installed proof');return;}
 const result=patchBillionEgressRecovery(source,{version:BILI_EGRESS_RECOVERY_VERSION});
 assert.throws(()=>patchBillionEgressRecovery(result.source,{version:BILI_EGRESS_RECOVERY_VERSION}),/hash mismatch/);
 const span=recoveryFunction(source,'requestSummaryBody');
 assert.throws(()=>patchBillionEgressRecovery(source.slice(0,span.start)+span.text.replace('const maxAttempts=','const maxAttempts =')+source.slice(span.end),{version:BILI_EGRESS_RECOVERY_VERSION}),/hash mismatch/);
 // Unchanged suffix contains all final forward-fuse code; guard bytes are not patched.
 const last=recoveryFunction(source,'preflightCompressIfNeeded'),after=recoveryFunction(result.source,'preflightCompressIfNeeded');
 assert.equal(result.source.slice(after.end),source.slice(last.end));
});
test('same complete egress meter skips futile first evidence send only when final full-window fuse already rejects',async t=>{
 if(!source){t.skip('BILI_KERNEL_FILE required for exact installed proof');return;}
 const before=await outerRuntime(false).run(1140000),after=await outerRuntime(true).run(1140000);
 assert.equal(before.folds,0);assert.equal(before.same,true);assert.ok(before.output>1000000,'unchanged final fuse rejects old workflow');
 assert.equal(after.folds,1);assert.equal(after.same,false);assert.equal(after.recovery,true);assert.equal(after.budget,BILI_EGRESS_RECOVERY_MAX_ATTEMPTS);assert.ok(after.output<750000);
 assert.equal(after.originalBlock.blockId,'old-block');
 for(const tokens of [950000,999996]){const a=await outerRuntime(false).run(tokens),b=await outerRuntime(true).run(tokens);assert.ok(b.input<=1000000);assert.equal(b.same,a.same);assert.equal(b.folds,0);}
 const wider=await outerRuntime(true).run(1140000,{nativeWindow:2000000});assert.equal(wider.folds,0,'do not reinterpret declared larger window');
 for(const value of [undefined,0,-1,NaN]){
  const options={nativeWindow:value,declaredMissing:value===undefined},a=await outerRuntime(false).run(1140000,options),b=await outerRuntime(true).run(1140000,options);
  assert.equal(b.same,a.same);assert.equal(b.folds,0,'recovery requires the same positive declared-window gate as the final fuse: '+String(value));
 }
 writeTestResult({kind:'synthetic-exact-preflight-entry-decision',synthetic:true,privateDataRead:false,liveModelCalls:0,qqSends:0,before:{input:before.input,output:before.output,folds:before.folds},after:{input:after.input,output:after.output,folds:after.folds},limitation:'This test exercises the exact entry decision with a simulated successful fold; the companion replay exercises real kernel fold decisions.'});
});
test('recovery caps actual HTTP429 attempts, prevents oversized summary sources and preserves ordinary retry policy',async t=>{
 if(!source){t.skip('BILI_KERNEL_FILE required for exact installed proof');return;}
 const old=await requestRuntime(false).run(),bounded=await requestRuntime(true).run(),ordinary=await requestRuntime(true).run({bounded:false}),oversized=await requestRuntime(true).run({tokens:450001});
 assert.equal(old.sends,5);assert.equal(bounded.sends,BILI_EGRESS_RECOVERY_MAX_ATTEMPTS);assert.equal(bounded.remaining,0);assert.match(bounded.error,/4-send/);
 assert.equal(ordinary.sends,5);assert.equal(oversized.sends,0);assert.equal(oversized.remaining,BILI_EGRESS_RECOVERY_MAX_ATTEMPTS);assert.match(oversized.error,/bounded source window/);
});
test('recovery grouping never crosses index gaps, explicit boundaries, budgets or conservative recent protection',()=>{
 const messages=Array.from({length:300},(_,i)=>({role:i%2?'assistant':'user',wireIndex:i}));assert.equal(egressRecoveryProtectedStart(messages),172);
 assert.equal(egressRecoveryProtectedStart(messages.slice(-10)),0);
 const sparse=Array.from({length:400},(_,i)=>({role:i%20===0?'user':'assistant',wireIndex:i}));assert.equal(egressRecoveryProtectedStart(sparse),220,'nine user groups may extend beyond the 128-message floor');
 const merge=rs=>({...rs[0],endIndex:rs.at(-1).endIndex,endRef:rs.at(-1).endRef,tokens:rs.reduce((n,r)=>n+r.tokens,0)});
 const range=(start,end,tokens,extra={})=>({startIndex:start,endIndex:end,startRef:'m'+start,endRef:'m'+end,tokens,...extra});
 const grouped=egressRecoveryRanges([range(0,1,2),range(2,3,2),range(4,5,2,{noMergeBefore:true}),range(7,8,2),range(9,10,5),range(11,12,1),{tokens:1}],4,12,merge);
 assert.deepEqual(grouped.map(r=>[r.startIndex,r.endIndex,r.tokens]),[[0,3,4],[4,5,2],[7,8,2]]);
});
