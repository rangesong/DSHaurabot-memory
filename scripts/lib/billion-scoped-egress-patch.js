import {createHash} from 'node:crypto';

export const BILI_SCOPED_EGRESS_VERSION='0.1.216';
export const BILI_SCOPED_EGRESS_MARKER='thinkstar-scoped-http-images-v1';
const sha=value=>createHash('sha256').update(value).digest('hex');
const originals={shedEgressIfOverBudget:'744ec1b002f09537e75cfc25c5bc8d3fc57d4892b07afd87de9ce4689b1e4099',shedWireImages:'d734310a003fd39a3ad90751e8af6f579412ae908c85ca16f00386633eccef28'};
export function scopedEgressFunction(source,name){
 const signature='function '+name+'(';let start=source.indexOf(signature);
 if(start<0||source.indexOf(signature,start+signature.length)>=0)throw Error('Unrecognized scoped-egress function: '+name);
 if(source.slice(start-6,start)==='async ')start-=6;
 let end=source.indexOf('function ',start+('async '+signature).length);
 if(end<0)throw Error('Unrecognized scoped-egress function end: '+name);
 if(source.slice(end-6,end)==='async ')end-=6;
 return {name,start,end,text:source.slice(start,end)};
}

// Local configuration carries private conversation IDs and ephemeral shim URLs.
// Never broaden an existing limit or apply a scoped rule to a different lane.
export function scopedHttpEgressBudget(globalBytes,protocol,ctx,rules){
 if(protocol!=='openai'||!['pre-send','loop'].includes(ctx?.phase)||typeof ctx.sessionId!=='string'||!Array.isArray(rules)||!Number.isFinite(globalBytes)||globalBytes<=0)return undefined;
 let target;try{target=new URL(ctx.upstreamUrl);}catch{return undefined;}
 if(target.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(target.hostname)||!target.port||target.username||target.password||target.search||target.hash||target.pathname!=='/v1/chat/completions')return undefined;
 let budget;
 for(const rule of rules){
  if(!rule||typeof rule!=='object'||rule.conversationId!==ctx.sessionId||typeof rule.upstream!=='string'||!Number.isSafeInteger(rule.bytes)||rule.bytes<=0||rule.bytes>=globalBytes)continue;
  let configured;try{configured=new URL(rule.upstream);}catch{continue;}
  if(configured.href!==target.href)continue;
  budget=budget===undefined?rule.bytes:Math.min(budget,rule.bytes);
 }
 return budget;
}
// A scoped archive must retain a working, same-session original-image pointer.
// Size and MIME only select candidates; exact cached bytes decide the match.
export async function resolveScopedImageRef(session,mediaType,b64,read){
 const index=session?.incomingImageIndex,refs=session?.state?.messageRefs;
 if(!index||typeof index.entries!=='function'||!refs?.byRef||!refs?.byRaw||typeof read!=='function')throw new Error('Scoped image archive requires a verified original-image cache and source reference; no request was forwarded.');
 const bytes=Buffer.from(b64,'base64').length;
 for(const [ref,entries]of index.entries()){
  const raw=refs.byRef[ref];
  if(typeof ref!=='string'||!/^m\d+$/.test(ref)||typeof raw!=='string'||refs.byRaw[raw]!==ref||!Array.isArray(entries))continue;
  for(const entry of entries){
   if(entry?.bytes!==bytes||entry.mediaType!==mediaType||typeof entry.path!=='string'||!entry.path)continue;
   try{const original=await read(entry.path);if(original.toString('base64')===b64)return ref;}catch{}
  }
 }
 throw new Error('Scoped image archive could not verify the exact original pixels and source reference; no request was forwarded.');
}
const mainCall='shedEgressIfOverBudget(wireBody,prepared.protocol,{sessionId:prepared.session.id,session:prepared.session,log:log2,phase:"pre-send"})';
const loopCall='shedEgressIfOverBudget(wireBodyStr,ctx.protocol,{sessionId:ctx.session.id,session:ctx.session,log:(level,msg)=>log(level,`[acp-loop] ${msg}`),phase:"loop"})';
function replaceExact(source,before,after){if(source.split(before).length-1!==1)throw Error('Upstream scoped-egress expression changed');return source.replace(before,after);}
export function patchBillionScopedEgress(source,{version}={}){
 if(version!==BILI_SCOPED_EGRESS_VERSION)throw Error('Unsupported billion-context version');
 const functions=Object.keys(originals).map(name=>scopedEgressFunction(source,name));
 for(const fn of functions)if(sha(fn.text)!==originals[fn.name])throw Error('Upstream scoped-egress hash mismatch: '+fn.name);
 const changed=functions.map(fn=>{
  let text=fn.text;
  if(fn.name==='shedEgressIfOverBudget'){
   text=replaceExact(text,'let lane;','let lane;let scopedBudget;');
   text=replaceExact(text,'budget=limitsHttpOutboundBytes();lane="http"',`budget=limitsHttpOutboundBytes();scopedBudget=scopedHttpEgressBudget(budget,protocol,ctx,loadConfigFile().network?.httpScopedBudgets);if(scopedBudget!==void 0)budget=scopedBudget;lane="http"`);
   text=replaceExact(text,'{resolveRef:ctx.session?(mt2,b64)=>refForItemBytes(ctx.session,mt2,b64):void 0}','{resolveRef:scopedBudget!==void 0?(mt2,b64)=>resolveScopedImageRef(ctx.session,mt2,b64,readFile6):ctx.session?(mt2,b64)=>refForItemBytes(ctx.session,mt2,b64):void 0,archiveOnly:scopedBudget!==void 0}');
   text=replaceExact(text,'if(!stats.changed){','if(scopedBudget!==void 0&&stats.finalBytes>budget)throw new Error("The scoped HTTP image budget cannot be met while retaining recent image pixels; no request was forwarded and source records are retained.");if(!stats.changed){');
   text=`/*${BILI_SCOPED_EGRESS_MARKER}*/`+scopedHttpEgressBudget.toString()+resolveScopedImageRef.toString()+text;
  }else text=replaceExact(text,'if(est>targetBytes){const work=','if(est>targetBytes&&opts.archiveOnly!==true){const work=');
  return {...fn,patched:text};
 });
 let patched=source;
 for(const fn of [...changed].sort((a,b)=>b.start-a.start))patched=patched.slice(0,fn.start)+fn.patched+patched.slice(fn.end);
 patched=replaceExact(patched,mainCall,mainCall.replace('phase:"pre-send"','phase:"pre-send",upstreamUrl'));
 patched=replaceExact(patched,loopCall,loopCall.replace('phase:"loop"','phase:"loop",upstreamUrl:requestOptions.url'));
 return{source:patched,receipt:{schema:1,patch:BILI_SCOPED_EGRESS_MARKER,version,sourceSha256:sha(source),patchedSha256:sha(patched),functions:changed.map(fn=>({name:fn.name,originalSha256:sha(fn.text),patchedSha256:sha(fn.patched)})),callSites:['pre-send:upstreamUrl','loop:requestOptions.url'],scope:'Optional exact conversation and loopback upstream HTTP image-only budget; archive outside the existing eight-entry image tail, never downscale on the scoped path; retain ordinary and final-fuse behavior elsewhere.'}};
}
