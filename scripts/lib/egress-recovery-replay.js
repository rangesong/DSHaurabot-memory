import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {installedKernel} from './isolated-context-kernel.js';
function extract(source,name){
 const a=source.indexOf('function '+name+'('),b=source.indexOf('function ',a+15);
 if(a<0||b<0)throw Error('Missing pure helper '+name);
 return source.slice(source.slice(a-6,a)==='async '?a-6:a,b).replace(/async\s*$/,'');
}
export async function replayEgressRecovery({kernelFile,patched=true,mode='success',fixtureFactory,transport,wireOverhead=20000,imageReserve=0}={}){
 const raw=fs.readFileSync(kernelFile,'utf8');
 const patch=await import('./billion-egress-recovery-patch.js');
 assert.ok(Number.isInteger(patch.BILI_EGRESS_RECOVERY_MAX_ATTEMPTS)&&patch.BILI_EGRESS_RECOVERY_MAX_ATTEMPTS>0&&patch.BILI_EGRESS_RECOVERY_MAX_ATTEMPTS<=4,'Explicit bounded recovery policy required');
 const source=patched&&!raw.includes(patch.BILI_EGRESS_RECOVERY_MARKER)?patch.patchBillionEgressRecovery(raw,{version:'0.1.216'}).source:raw;
 const k=installedKernel(kernelFile),f=fixtureFactory(k),original=JSON.stringify(f.messages),oldBlocks=f.state.blocks.filter(b=>b.active).map(b=>JSON.parse(JSON.stringify(b)));
 const receipt=block=>{const {survivedCount,generation,...stable}=block;return JSON.stringify(stable);};
 const start=source.indexOf('var MAX_PREFLIGHT_ROUNDS='),end=source.indexOf('var SELF_HEAL_WINDOW=',start);
 assert.ok(start>0&&end>start);
 const calls=[],logs=[],commits=[];
 const session=f.session??{id:'synthetic-egress-recovery',state:f.state,metadata:{},stats:{lastInputTokens:150753,lastInputTokensSource:'usage',compressCreditTokens:0}};
 const sandbox={Buffer,TextEncoder,TextDecoder,URL,AbortController,createHash,createHash17:createHash,TLS_TRUST_CODES:[],BLOCKED_REF:'BLOCKED',SUMMARY_ID_PREFIX:'acp_summary_',
  UpstreamHttpError:class extends Error{constructor(status,body,attempts){super('HTTP '+status);Object.assign(this,{status,body,attempts});}},
  epochConfirmPending:()=>false,currentCalibrationFactor:()=>undefined,applyEstimateCalibration:x=>x,
  configuredSummaryPlan:()=>undefined,contentStoreOf:()=>undefined,adoptContentStore(){},
  ccrLoopConfig:(_s,c)=>c,applyAbsorbView:ms=>ms,deadSkipKeys:()=>[],filterDeadRanges:(_s,rs)=>rs,
  viableRanges:rs=>rs.filter(r=>r.tokens>=100),yieldToEventLoop:async()=>{},safePrefix:(s,n)=>s.slice(0,n),
  imagePlaceholdersForSummary:()=>[],IMAGE_PLACEHOLDER:'[image]',
  parseStructuralEmptyVerdict:()=>null,recordDeadRange(){},newExternalCallId:()=>{throw Error('No external summary');},
  parseCompressInput:v=>({ranges:v.content.map(r=>({startRef:r.startId,endRef:r.endId,summary:r.summary,topic:r.topic}))}),
  applyRanges:(fold,ctx)=>{const out=ctx.core.applyCompression({messages:ctx.messages,state:ctx.session.state,config:ctx.config,ranges:fold.ranges});if(out.result.blocksCreated){commits.push(...out.state.blocks.filter(b=>!ctx.session.state.blocks.some(o=>o.blockId===b.blockId)));ctx.session.state=out.state;ctx.session.stats.compressCreditTokens+=out.result.tokensCompressed;return {outcome:'applied',text:'synthetic kernel receipt'};}return {outcome:'refused',text:JSON.stringify(out.result)};},
  buildCompressSystemPrompt:()=> 'Summarize synthetic evidence, preserve exact values and open constraints.',messageTimestampSections:()=>[],summaryLengthBudgetClause:()=>'',
  replayMaxAttempts2:()=>5,replayBackoffMs:()=>0,sleep:async()=>{},proxyDispatcher:()=>undefined,
  summaryHeaders:()=>({}),isTransientUpstreamError:status=>status>=500,
  dumpSummaryRejection(){},lastCompressSuffix:()=>'',isTlsTrustCode:()=>false,tlsTrustRemediation:()=>'',
  estimateCjkTokens:text=>{const cjk=(text.match(/[\u3400-\u9fff]/g)||[]).length;return Math.ceil(cjk*.6+(text.length-cjk)/4);},
  summaryOutputTokens:()=>8192,windowClampedOutput:()=>8192,
  isCodexClient:()=>false,
  fetchWithTimeout:async(url,{body},_options,signal)=>{const payload=JSON.parse(body),content=payload.messages.at(-1).content;calls.push({content,bytes:Buffer.byteLength(body),tokens:context.estimateRawBodyBreakdown(payload).total,model:payload.model});assert.equal(payload.messages.length,2);assert.ok(!content.includes('HARD_PROTECTED_TOOL_RESULT'));assert.ok(!content.includes('RECENT_USER_TURN_'));if(transport)return {clearTimer(){},response:await transport(url,{body,payload,signal})};return {clearTimer(){},response:{status:mode==='rate-limit'?429:mode==='transient'?503:200,ok:mode==='success',text:async()=>mode==='success'?JSON.stringify({choices:[{message:{content:'Synthetic verified summary: exact_value=123.456; conditions and original source references remain preserved. '.repeat(20)},finish_reason:'stop'}]}):mode==='rate-limit'?'{"type":"rate_limit_error","message":"Error"}':'synthetic unavailable'}};},
 };
 const context=vm.createContext(sandbox);
 const baseHelpers=['defaultCountTokens','estimateTextTokens','estimateCjkTokens','countMessageTokens','thinkingTokenValue','mergeBatch','rangeChars','coreToOpenai','stringContent','isPlainStringOrTextParts','isSummaryMessageId'].filter(n=>source.includes('function '+n+'(')).map(n=>extract(source,n)).join('');
 try{vm.runInContext(baseHelpers+source.slice(start,end),context,{timeout:3000});}catch(e){throw Error('Replay setup: '+e.message);}
 context.summaryOutputTokens=()=>8192;context.windowClampedOutput=()=>8192;context.summaryHeaders=()=>({});
 // These adapters implement host persistence only; all range decisions remain exact source.
 context.deps={core:f.core,session,config:f.config,protocol:'openai',model:'synthetic-model',url:'https://synthetic.invalid/v1/chat/completions',headers:{},prompts:{},surface:{},log:(...v)=>logs.push(v.join(' ')),signal:new AbortController().signal,upstreamOrigin:'https://synthetic.invalid',wireOverhead,imageReserve,unknownBaseline:false,egressRecovery:true,egressRecoveryBudget:{remaining:patch.BILI_EGRESS_RECOVERY_MAX_ATTEMPTS}};
 context.messages=f.messages;
 let result;try{result=await vm.runInContext('preflightCompress(deps,messages)',context,{timeout:3000});}catch(e){throw Error('Replay helper failure: '+e.message+'; last='+logs.slice(-2).join(' | '),{cause:e});}
 assert.equal(JSON.stringify(f.messages),original,'all original source bytes retained');
 for(const old of oldBlocks)assert.equal(receipt(session.state.blocks.find(b=>b.blockId===old.blockId)),receipt(old),'existing block and receipt retained');
 assert.ok(commits.every(b=>b.effectiveMessageIds.every(id=>!f.protectedIds.includes(id))),'hard protected pairs and eight recent turns excluded');
 const rebuilt=f.core.processTurn({messages:f.messages,state:session.state,config:f.config,tokenCount:session.stats.lastInputTokens,renderTags:'none'});
 context.rebuilt=rebuilt.messages;let measured;try{measured=vm.runInContext('estimateRawBodyBreakdown({messages:coreToOpenai(rebuilt),tools:[],model:"synthetic-model"}).total',context,{timeout:1500});}catch(e){throw Error('Replay meter: '+e.message);}
 return {result,calls,logs,commits,measured,sourceSha256:createHash('sha256').update(original).digest('hex'),initialChars:f.messages.reduce((n,m)=>n+m.text.length,0)};
}
