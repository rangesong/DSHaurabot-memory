import {createHash} from 'node:crypto';

// Exact supported upstream function; no bundled third-party source or private history.
export const BILI_RECONCILIATION_VERSION='0.1.216';
export const BILI_RECONCILIATION_ORIGINAL_SHA256='4754a6e2b3a089caadd2aa665f31eac617ffe242f0df8a1ff2fd408cdcc68e54';
export const BILI_RECONCILIATION_MARKER='thinkstar-reconciliation-cache-v1';
const sha=value=>createHash('sha256').update(value).digest('hex');
export function reconciliationFunction(source){
 const start=source.indexOf('function planReconciliation('),end=source.indexOf('function rewriteBlocks(',start);
 if(start<0||end<=start||source.indexOf('function planReconciliation(',start+1)>=0)throw Error('Unrecognized reconciliation function boundary');
 return {start,end,text:source.slice(start,end)};
}
const prefix='function planReconciliation(oldOrder,anchors,msgs,covered,positions,expectedAbsent){';
const cache=`/*${BILI_RECONCILIATION_MARKER}*/const reconciliationMemo=new Map;const memoValue=(message,key,calculate)=>{let row=reconciliationMemo.get(message);if(row===void 0){row=new Map;reconciliationMemo.set(message,row)}if(!row.has(key))row.set(key,calculate());return row.get(key)};const canonicalOfMessage=message=>memoValue(message,"canonical",()=>canonicalTextOf(message.text??""));const wordBagOfMessage=message=>memoValue(message,"wordBag",()=>wordBagDigest(canonicalOfMessage(message)));const simhashOfMessage=message=>memoValue(message,"simhash",()=>simhashHex(canonicalOfMessage(message)));const singleLineIdentity=message=>memoValue(message,"singleLine",()=>normalizedIdentity({...message,text:(message.text??"").replace(/\\r?\\n/g," ")}));`;
function replaceExact(source,before,after,count){
 if(source.split(before).length-1!==count)throw Error('Upstream reconciliation expression changed');
 return source.replaceAll(before,after);
}
export function patchBillionReconciliation(source,{version}={}){
 if(version!==BILI_RECONCILIATION_VERSION)throw Error('Unsupported billion-context version');
 const original=reconciliationFunction(source);
 if(sha(original.text)!==BILI_RECONCILIATION_ORIGINAL_SHA256)throw Error('Upstream reconciliation hash mismatch; preserve installed source');
 let text=replaceExact(original.text,prefix,prefix+cache,1);
 for(const name of ['message','m2','c.message']){
  text=replaceExact(text,`wordBagDigest(canonicalTextOf(${name}.text??""))`,`wordBagOfMessage(${name})`,1);
  text=replaceExact(text,`simhashHex(canonicalTextOf(${name}.text??""))`,`simhashOfMessage(${name})`,1);
 }
 text=replaceExact(text,'const unwrapped={...m2,text:(m2.text??"").replace(/\\r?\\n/g," ")};return normalizedIdentity(unwrapped)===anchor.n','return singleLineIdentity(m2)===anchor.n',1);
 const patched=source.slice(0,original.start)+text+source.slice(original.end);
 return {source:patched,receipt:{schema:1,patch:BILI_RECONCILIATION_MARKER,version,sourceSha256:sha(source),patchedSha256:sha(patched),originalFunctionSha256:sha(original.text),patchedFunctionSha256:sha(text),functionStart:original.start,functionEnd:original.end,scope:'per-invocation pure value memoization; no matching, order, claims or evidence policy changed'}};
}
