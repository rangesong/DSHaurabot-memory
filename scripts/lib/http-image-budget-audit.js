import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import path from 'node:path';
import {patchBillionScopedEgress,scopedEgressFunction,scopedHttpEgressBudget,resolveScopedImageRef,BILI_SCOPED_EGRESS_VERSION} from './billion-scoped-egress-patch.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const MIB=1024*1024;
export function prepareWorkbuddyProjector(source){
 const start=source.indexOf('const WORKBUDDY_FALLBACK_SYSTEM_PROMPT ='),end=source.indexOf('function declaredTools(',start);
 const refusal=source.match(/const REFUSES_OFF_MODEL_IDS\s*=[\s\S]*?\n\]\);/u);
 if(start<0||end<start||!refusal)throw Error('Unrecognized installed Workbuddy pure projector');
 const context=vm.createContext({URL,Buffer,TextEncoder});
 const pure=refusal[0]+'\nfunction offRefused(modelId){return REFUSES_OFF_MODEL_IDS.has(modelId);}\n'+source.slice(start,end);
 vm.runInContext(pure,context,{timeout:2000});
 return {sourceSha256:sha(pure),prepare(body,options){context.auditBody=body;context.auditOptions=options;return vm.runInContext('prepareChatBody(auditBody,auditOptions)',context,{timeout:2000});}};
}
export function scopedImageAuditRuntime(source,{rules,globalBytes=10*MIB,transport='http'}={}){
 const patched=patchBillionScopedEgress(source,{version:BILI_SCOPED_EGRESS_VERSION});
 const helpers=['asPart','isObj4','parseDataUrl','pngDims','gifDims','bmpDims','webpDims','jpegDims','decodeImageDims','byteLen2','formatMiB2','dataUrl','shedNote','callNameMap','isExemptOutput','matchesOriginalImageReceipt','collectOccurrences'];
 const context=vm.createContext({Buffer,URL,createHash22:createHash,readFile6:async file=>fs.promises.readFile(file),auditRules:rules,auditGlobalBytes:globalBytes,auditTransport:transport});
 vm.runInContext(`var PNG_SIG=[137,80,78,71,13,10,26,10],READ_ORIGINAL_IMAGE_TOOL_NAME='read_original_image',downscaleCalls=0;
 const currentFetchTransport=()=>auditTransport==='http'?undefined:{kind:auditTransport},isWsLaneTransport=t=>t?.kind==='ws',limitsWsOutboundBytes=()=>auditGlobalBytes,limitsHttpOutboundBytes=()=>auditGlobalBytes,loadConfigFile=()=>({network:{httpScopedBudgets:auditRules}});
 const shedDownscaleImage=async()=>{downscaleCalls++;throw Error('Audit forbids resizing');};
 const refForItemBytes=()=>{throw Error('Unscoped resolver is outside this audit');};
 `+helpers.map(name=>scopedEgressFunction(source,name).text).join('\n')+scopedHttpEgressBudget.toString()+resolveScopedImageRef.toString()+scopedEgressFunction(patched.source,'shedWireImages').text+scopedEgressFunction(patched.source,'shedEgressIfOverBudget').text,context,{timeout:2000});
 return {receipt:patched.receipt,async run(body,ctx){context.auditBody=body;context.auditContext=ctx;const result=await vm.runInContext('shedEgressIfOverBudget(auditBody,"openai",auditContext)',context,{timeout:2000});return {body:result.body,stats:JSON.parse(JSON.stringify(result.stats)),downscaleCalls:context.downscaleCalls};}};
}
// Fully valid, deterministic PNG files, kept in the owned synthetic CAS only.
function crc32(buffer){let crc=0xffffffff;for(const value of buffer){crc^=value;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function chunk(name,data){const type=Buffer.from(name),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([size,type,data,crc]);}
function png(seed){
 const width=512,height=512,stride=width*3,raw=Buffer.alloc((stride+1)*height),header=Buffer.alloc(13);let x=seed+1;
 for(let y=0;y<height;y++)for(let i=1;i<=stride;i++){x^=x<<13;x^=x>>>17;x^=x<<5;raw[y*(stride+1)+i]=x&255;}
 header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
export function createCasImageFixture(scratch){
 const root=path.join(scratch,'synthetic-http-image-cas');fs.mkdirSync(root,{recursive:true});
 const messages=[{role:'system',content:'Preserve the exact test facts and function results.'}],session={metadata:{},incomingImageIndex:new Map,state:{messageRefs:{byRef:{},byRaw:{}}}},originals=[];
 function imageAt(index){
  const bytes=png(index),hash=sha(bytes),file=path.join(root,hash),ref='m'+String(index+1).padStart(5,'0'),raw='synthetic-raw-'+index;fs.writeFileSync(file,bytes,{flag:'wx'});
  session.incomingImageIndex.set(ref,[{bytes:bytes.length,mediaType:'image/png',path:file}]);session.state.messageRefs.byRef[ref]=raw;session.state.messageRefs.byRaw[raw]=ref;
  originals.push({file,sha256:hash,bytes:bytes.length,ref});return {type:'image_url',image_url:{url:'data:image/png;base64,'+bytes.toString('base64')}};
 }
 for(let i=0;i<8;i++)messages.push({role:i%2?'assistant':'user',content:[{type:'text',text:'EXACT_OLD_FACT_'+i+' amount=123.456'},imageAt(i)]});
 messages.push({role:'assistant',content:'Calling the original test tool.',tool_calls:[{id:'fixture-call',type:'function',function:{name:'read_fixture',arguments:'{"exact":123.456,"key":"unchanged"}'}}]});
 messages.push({role:'tool',tool_call_id:'fixture-call',content:'{"result":123.456,"same":true}'});
 for(let i=0;i<8;i++)messages.push({role:i%2?'assistant':'user',content:[{type:'text',text:'EXACT_PROTECTED_FACT_'+i},...(i===6?[imageAt(8)]:[])]});
 return {body:JSON.stringify({model:'gpt-6-astra',messages,stream:false,reasoning_effort:'off',tools:[{type:'function',function:{name:'read_fixture',description:'Read fixture',parameters:{type:'object',properties:{exact:{type:'number'},key:{type:'string'}},required:['exact','key']}}}]}),session,originals};
}
export function nonImagePayload(body){
 const parsed=JSON.parse(body);
 for(const message of parsed.messages||[])if(Array.isArray(message.content))message.content=message.content.filter(part=>part.type!=='image_url'&&!(part.type==='text'&&part.text.startsWith('[image:')&&part.text.endsWith('omitted for size limit]')));
 return parsed;
}
export function verifyCasOriginals(originals){return originals.every(item=>{const bytes=fs.readFileSync(item.file);return bytes.length===item.bytes&&sha(bytes)===item.sha256;});}
export const HTTP_IMAGE_AUDIT_MIB=MIB;
