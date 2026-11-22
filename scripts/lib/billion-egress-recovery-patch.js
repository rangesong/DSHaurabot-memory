import {createHash} from 'node:crypto';

export const BILI_EGRESS_RECOVERY_VERSION='0.1.216';
export const BILI_EGRESS_RECOVERY_MARKER='thinkstar-egress-recovery-v1';
export const BILI_EGRESS_RECOVERY_MAX_ATTEMPTS=4;
const sha=value=>createHash('sha256').update(value).digest('hex');
const originals={
 preflightCompressIfNeeded:'98f1b2c93badc3560fc0a7b8a4cf079f918190425c84b71665aff56ebf8da627',
 preflightCompress:'b4c2fb18bc92ba59ae5001a87e881d19734357fd709bb5f1425cdd7e5b0391c8',
 requestSummaryBody:'b8add5107f1540f9ea807c3ef53e64bad730dc022b5d16fb345ff47e284ac199'
};
export function recoveryFunction(source,name){
 const signature='function '+name+'(';let start=source.indexOf(signature);
 if(start<0||source.indexOf(signature,start+signature.length)>=0)throw Error('Unrecognized recovery function boundary: '+name);
 if(source.slice(start-6,start)==='async ')start-=6;
 let end=source.indexOf('function ',start+('async '+signature).length);
 if(end<0)throw Error('Unrecognized recovery function end: '+name);
 if(source.slice(end-6,end)==='async ')end-=6;
 return {name,start,end,text:source.slice(start,end)};
}

// Protect at least 128 visible core messages and nine wire user groups.
// These groups can include runtime injections; they are not proven DSH turns.
// Missing indexes merge consecutive user fragments conservatively.
export function egressRecoveryProtectedStart(messages){
 const starts=[];
 for(let i=0;i<messages.length;i++){
  const message=messages[i],prior=messages[i-1];if(message.role!=='user')continue;
  if(prior?.role!=='user'||Number.isInteger(message.wireIndex)&&message.wireIndex!==prior.wireIndex)starts.push(i);
 }
 const groupStart=starts.length>8?starts[starts.length-9]:0;
 return Math.max(0,Math.min(groupStart,messages.length-128));
}

// The kernel remains responsible for protected-tool and protocol eligibility.
// Only adjacent eligible indexes can coalesce, using its original mergeBatch.
export function egressRecoveryRanges(ranges,budget,protectedStart,merge){
 const result=[];let batch=[],tokens=0;
 const close=()=>{if(batch.length)result.push(batch.length===1?batch[0]:merge(batch));batch=[];tokens=0;};
 for(const range of ranges){
  if(!Number.isInteger(range.startIndex)||!Number.isInteger(range.endIndex)||range.startIndex>range.endIndex||range.endIndex>=protectedStart||!Number.isFinite(range.tokens)||range.tokens<=0||range.tokens>budget){close();continue;}
  const prior=batch.at(-1);
  if(prior&&(range.noMergeBefore||range.startIndex!==prior.endIndex+1||tokens+range.tokens>budget))close();
  batch.push(range);tokens+=range.tokens;
 }
 close();return result;
}

function replaceExact(text,before,after,count=1){
 if(text.split(before).length-1!==count)throw Error('Upstream recovery expression changed');
 return text.replaceAll(before,after);
}
export function patchBillionEgressRecovery(source,{version}={}){
 if(version!==BILI_EGRESS_RECOVERY_VERSION)throw Error('Unsupported billion-context version');
 const functions=Object.keys(originals).map(name=>recoveryFunction(source,name));
 for(const fn of functions)if(sha(fn.text)!==originals[fn.name])throw Error('Upstream recovery hash mismatch: '+fn.name);
 const changed=[];
 for(const fn of functions){let text=fn.text;
  if(fn.name==='preflightCompressIfNeeded'){
   text=replaceExact(text,'const autoFoldOn=autoFoldEngaged(config,session);',`/*${BILI_EGRESS_RECOVERY_MARKER}*/const egressMeasurement=measuredOutbound(prepared);const egressDeclaredWindow=typeof session.metadata.effectiveContextLimit==="number"&&session.metadata.effectiveContextLimit>0?session.metadata.effectiveContextLimit:0;const egressFullWindow=Math.max(egressDeclaredWindow,MIN_ASSUMED_WINDOW_TOKENS);const egressRecovery=egressDeclaredWindow>0&&egressMeasurement!==void 0&&egressMeasurement.tokens>egressFullWindow;const autoFoldOn=autoFoldEngaged(config,session);`);
   text=replaceExact(text,'const triggerFires=growthWorthIt&&(imageTokens>=compressionTarget||decisionTrigger>=textBudget);','const triggerFires=egressRecovery||growthWorthIt&&(imageTokens>=compressionTarget||decisionTrigger>=textBudget);');
   text=replaceExact(text,'const localRefusalHere=localRefusalCovers(session.metadata,currentOrigin,model,limit);','const localRefusalHere=egressRecovery||localRefusalCovers(session.metadata,currentOrigin,model,limit);');
   text=replaceExact(text,'const probeForEvidence=!growthArmed&&!unknownBaseline&&','const probeForEvidence=!egressRecovery&&!growthArmed&&!unknownBaseline&&');
   text=replaceExact(text,'const preflightDeps={core,session,config,compressionTarget,',`const preflightDeps={core,session,config,egressRecovery,egressRecoveryBudget:egressRecovery?{remaining:${BILI_EGRESS_RECOVERY_MAX_ATTEMPTS}}:void 0,compressionTarget,`);
  }else if(fn.name==='preflightCompress'){
   text=replaceExact(text,'const summaryBudget=Math.min(MAX_SUMMARY_CALLS_PER_PREFLIGHT*2,',`const summaryBudget=deps.egressRecovery?${BILI_EGRESS_RECOVERY_MAX_ATTEMPTS}:Math.min(MAX_SUMMARY_CALLS_PER_PREFLIGHT*2,`);
   text=replaceExact(text,'const emergencyFold=entryOvershoot>EMERGENCY_FOLD_COVERAGE;','const emergencyFold=!deps.egressRecovery&&entryOvershoot>EMERGENCY_FOLD_COVERAGE;');
   text=replaceExact(text,'const effectiveRoundCap=emergencyFold?EMERGENCY_ROUND_CAP:roundBudget;',`const effectiveRoundCap=deps.egressRecovery?${BILI_EGRESS_RECOVERY_MAX_ATTEMPTS}:emergencyFold?EMERGENCY_ROUND_CAP:roundBudget;`);
   text=replaceExact(text,'if(!tiersEnabled||tierRecoveryAttempted||','if(deps.egressRecovery||!tiersEnabled||tierRecoveryAttempted||');
   text=replaceExact(text,'const viable=viableRanges(turn.nudge?.compressibleRanges??[]);','const rawViable=viableRanges(turn.nudge?.compressibleRanges??[]);const viable=deps.egressRecovery?egressRecoveryRanges(rawViable,Math.max(0,Math.min(budget,450000)-8192),egressRecoveryProtectedStart(turn.messages),mergeBatch):rawViable;');
   text=replaceExact(text,'if(!relaxed){const probe=','if(!deps.egressRecovery&&!relaxed){const probe=');
   text=replaceExact(text,'if(!relaxed&&result.payloadEstimate+viewDeltaCorrection>=limit){','if(!deps.egressRecovery&&!relaxed&&result.payloadEstimate+viewDeltaCorrection>=limit){');
   // Configured external dispatchers have their own retry pools. Do not claim
   // a global recovery-send guarantee for a transport we cannot bound here.
   text=replaceExact(text,'const budget=Math.max(MIN_CHUNK_TOKENS,', 'if(deps.egressRecovery&&deps.externalSummary!==void 0)return{compressedRanges:0,savedTokens:0,payloadEstimate:result.payloadEstimate,rangesRemaining:0,fitsWindow:false,hadFoldableCandidates:false,failure:{kind:"exhausted",deterministic:true,detail:"Oversized egress recovery requires a bounded summary transport; the configured external summary dispatcher was preserved and no recovery request was sent."}};const budget=Math.max(MIN_CHUNK_TOKENS,');
   text=egressRecoveryProtectedStart.toString()+egressRecoveryRanges.toString()+text;
  }else{
   text=replaceExact(text,'for(let attempt=1;;attempt++){deps.signal?.throwIfAborted();',`for(let attempt=1;;attempt++){deps.signal?.throwIfAborted();if(deps.egressRecoveryBudget!==void 0){const sourceLimit=Math.min(450000,Math.max(MIN_CHUNK_TOKENS,Math.floor(deps.config.modelContextLimit*CHUNK_FRACTION)));if(estimateRawBodyBreakdown(JSON.parse(body)).total>sourceLimit)throw new Error("Oversized egress recovery summary body exceeds its bounded source window; no summary request was sent.");if(deps.egressRecoveryBudget.remaining<=0)throw new Error("Oversized egress recovery reached its ${BILI_EGRESS_RECOVERY_MAX_ATTEMPTS}-send limit; sources and the final window fuse are retained.");deps.egressRecoveryBudget.remaining--;}`);
  }
  changed.push({...fn,patched:text});
 }
 let patched=source;
 for(const fn of [...changed].sort((a,b)=>b.start-a.start))patched=patched.slice(0,fn.start)+fn.patched+patched.slice(fn.end);
 return {source:patched,receipt:{schema:1,patch:BILI_EGRESS_RECOVERY_MARKER,version,sourceSha256:sha(source),patchedSha256:sha(patched),functions:changed.map(fn=>({name:fn.name,originalSha256:sha(fn.text),patchedSha256:sha(fn.patched)})),scope:'Use unchanged final egress meter as local refusal evidence; bound recovery summaries and coalesce only eligible contiguous old spans. Final forwarding fuse, source history, matching and epoch policy remain unchanged.'}};
}
