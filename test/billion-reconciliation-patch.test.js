import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {patchBillionReconciliation,reconciliationFunction,BILI_RECONCILIATION_VERSION,BILI_RECONCILIATION_MARKER} from '../scripts/lib/billion-reconciliation-patch.js';
import {writeTestResult} from '../scripts/lib/test-workspace.js';

const kernelFile=process.env.BILI_KERNEL_FILE;
const source=kernelFile?fs.readFileSync(kernelFile,'utf8'):null;
const extract=(text,name)=>{const start=text.indexOf('function '+name+'('),end=text.indexOf('function ',start+10);if(start<0||end<start)throw Error('Missing pure helper '+name);return text.slice(start,end);};
function runtime(patched=false){
 const input=patched?patchBillionReconciliation(source,{version:BILI_RECONCILIATION_VERSION}).source:source;
 const names=['normalizeMessageText','normalizedIdentity','normalizedIdentityNoToolCallId','identityWithText','turnKeyOf','turnKeyOfSeamless','extractThinkingMerge','turnContexts','canonicalJson2','canonicalTextOf','wordBagDigest','wordHash','positionalFingerprint','anchorFrom','defaultCountTokens','fnv1a32','simhashHex','hammingHex','hexToU32','popcount'];
 const constants=`var normalizedIdentityWork=0,positionalFingerprintWork=0,digestCalls=0,simhashCalls=0;var MAX_FEATURES=256,SHAPE_MASS_MIN=4,MIN_RESYNC_RUN=3,MAX_RESYNC_GAPS=8,GAP_SIMHASH_MAX_HAMMING=8,USER_IMAGE_PLACEHOLDER='(image omitted: model does not support images)';var FORMS2=${source.slice(source.indexOf('FORMS2=')+7,source.indexOf(';',source.indexOf('FORMS2=')))};`;
 const helpers=names.map(name=>extract(source,name)).join('').replace('function wordBagDigest(text2){','function wordBagDigest(text2){digestCalls++;').replace('function simhashHex(canonical2){','function simhashHex(canonical2){simhashCalls++;');
 const context=vm.createContext({createHash16:createHash,performance});
 vm.runInContext(constants+helpers+reconciliationFunction(input).text,context,{timeout:1800});
 return {run(code){return vm.runInContext(code,context,{timeout:1800});},context};
}
function normalizedPlan(plan){return JSON.stringify({...plan,claims:[...plan.claims]});}
test('patch refuses unknown version, absent function and changed upstream bytes',()=>{
 assert.throws(()=>patchBillionReconciliation('',{version:'unknown'}),/Unsupported/);
 assert.throws(()=>patchBillionReconciliation('',{version:BILI_RECONCILIATION_VERSION}),/boundary/);
 assert.throws(()=>patchBillionReconciliation('function planReconciliation(){}function rewriteBlocks(){}',{version:BILI_RECONCILIATION_VERSION}),/hash mismatch/);
});
test('exact installed patch changes only guarded function and keeps all other bytes',t=>{
 if(!source){t.skip('BILI_KERNEL_FILE required for exact installed proof');return;}
 const original=reconciliationFunction(source),result=patchBillionReconciliation(source,{version:BILI_RECONCILIATION_VERSION}),after=reconciliationFunction(result.source);
 assert.equal(result.source.slice(0,original.start),source.slice(0,original.start));
 assert.equal(result.source.slice(after.end),source.slice(original.end));
 assert.equal(result.source.split(BILI_RECONCILIATION_MARKER).length-1,1);
 assert.notEqual(result.receipt.sourceSha256,result.receipt.patchedSha256);
 assert.throws(()=>patchBillionReconciliation(result.source,{version:BILI_RECONCILIATION_VERSION}),/hash mismatch/);
 assert.throws(()=>patchBillionReconciliation(source.slice(0,original.start)+original.text.replace('const plan=','const plan =')+source.slice(original.end),{version:BILI_RECONCILIATION_VERSION}),/hash mismatch/);
});
test('differential: unchanged, tool IDs, duplicates, positional resync, merged thinking and shape churn',t=>{
 if(!source){t.skip('BILI_KERNEL_FILE required for differential proof');return;}
 const base=runtime(),patched=runtime(true);
 const fixture=`
 function message(id,role,type,text,extra={}){return {id,role,contentType:type,text,...extra}}
 function trial(old,messages,options={}){const ctx=turnContexts(old);const anchors=Object.fromEntries(old.map(m=>[m.id,anchorFrom(m,ctx.get(m.id))]));if(options.forceShape)for(const a of Object.values(anchors)){delete a.n;delete a.p;delete a.p2}const order=old.map(m=>m.id),positions=options.positions?{ids:order,canon:old.map(positionalFingerprint)}:undefined;return planReconciliation(order,anchors,messages,new Set(order),positions,options.expected)}
 const same=[message('a','user','text','original exact words'),message('b','assistant','text','original answer')];
 const results=[trial(same,same),trial(same,same.map(m=>({...m,id:'new'+m.id})),{positions:true})];
 const tools=[message('t','assistant','tool-call','{"x":1,"y":2}',{toolName:'read',toolCallId:'tc1'}),message('r','tool','tool-result','successful exact result',{toolName:'read',toolCallId:'tc1'})];
 results.push(trial(tools,tools.map(m=>({...m,id:'new'+m.id}))),trial(tools,tools.map(m=>({...m,id:'new'+m.id,toolCallId:'tc2'}))));
 const dup=Array.from({length:8},(_,i)=>message('dup'+i,'tool','tool-result','same repeated result',{toolCallId:'call'+i,toolName:'read'}));results.push(trial(dup,dup.map((m,i)=>({...m,id:'newdup'+i,toolCallId:'newcall'+i}))));
 const thinking=[message('q','user','text','question'),message('thought','assistant','reasoning','reasoning words'),message('answer','assistant','text','answer words')];results.push(trial(thinking,[thinking[0],message('merged','assistant','text','<think>\\nreasoning words\\n</think>\\nanswer words')]));
 const old=Array.from({length:12},(_,i)=>message('old'+i,i%2?'assistant':'user','text','word '+i+' alpha beta gamma\\n delta'));
 results.push(trial(old,old.map((m,i)=>({...m,id:'new'+i,text:m.text.replace(/\\n/g,' ')})),{forceShape:true}));
 results.push(trial(old,old.map((m,i)=>({...m,id:'new'+i,text:'all new unrelated words '+i})),{forceShape:true}));
 results.push(trial(old,[...old.slice(0,3),message('insert','user','text','inserted'),...old.slice(3).map((m,i)=>({...m,id:i>5?'new'+i:m.id}))],{positions:true}));
 const multi=old.map(m=>({...m,text:'{"b":2,"a":1}'}));results.push(trial(multi,multi.map((m,i)=>({...m,id:'json'+i,text:'{ "a":1, "b":2 }'})),{forceShape:true}));
 results.push(trial(old,old.slice(4),{expected:new Set(old.slice(0,4).map(m=>m.id))}));
 results;
 `;
 const a=base.run(fixture),b=patched.run(fixture);
 assert.equal(a.length,11);
 for(let i=0;i<a.length;i++)assert.equal(normalizedPlan(b[i]),normalizedPlan(a[i]),'case '+i);
 assert.ok(a.some(p=>p.byShape>0),'exercise shape adoption');
 assert.ok(a.some(p=>p.byTwin>0),'exercise repeated tool identity');
 assert.ok(a.some(p=>p.byTurn>0),'exercise reasoning merge');
});
test('differential randomized messages preserve complete matching result and never mutate inputs',t=>{
 if(!source){t.skip('BILI_KERNEL_FILE required for differential proof');return;}
 const a=runtime(),b=runtime(true);
 const program=`let seed=71931;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};const trials=[];for(let round=0;round<40;round++){const old=Array.from({length:16},(_,i)=>({id:'old'+i,role:['user','assistant','tool'][rand(3)],contentType:'text',text:['alpha beta gamma','delta 中文词语','{ "a":1,"b":2 }','repeat repeat repeat'][rand(4)]+(rand(2)?i:'')}));const msgs=old.filter(()=>rand(5)>0).map(m=>({...m,id:rand(3)?'new'+m.id:m.id,text:rand(6)===0?m.text+' extra':m.text}));const context=turnContexts(old),anchors=Object.fromEntries(old.map(m=>[m.id,anchorFrom(m,context.get(m.id))]));if(round%2)for(const a of Object.values(anchors)){delete a.n;delete a.p;delete a.p2}const before=JSON.stringify({old,msgs,anchors});const p=planReconciliation(old.map(m=>m.id),anchors,msgs,new Set(old.map(m=>m.id)));trials.push({p,unchanged:before===JSON.stringify({old,msgs,anchors})})}trials;`;
 const x=a.run(program),y=b.run(program);assert.equal(x.length,40);for(let i=0;i<x.length;i++){assert.equal(normalizedPlan(y[i].p),normalizedPlan(x[i].p),'seeded case '+i);assert.equal(y[i].unchanged,true);assert.equal(x[i].unchanged,true);}
});
test('single-line user shape adoption is equivalent and memo never survives an invocation',t=>{
 if(!source){t.skip('BILI_KERNEL_FILE required for differential proof');return;}
 const a=runtime(),b=runtime(true);
 const program=`const old=Array.from({length:8},(_,i)=>({id:'old'+i,role:'user',contentType:'text',text:'alpha beta gamma delta '+i}));const msgs=old.map((m,i)=>({...m,id:'new'+i,text:m.text.replace('alpha beta','alpha\\nbeta')}));const anchors=Object.fromEntries(old.map(m=>[m.id,anchorFrom(m)]));const order=old.map(m=>m.id),covered=new Set(order);const first=planReconciliation(order,anchors,msgs,covered);for(const m of msgs)m.text='unrelated changed contents '+m.id;const second=planReconciliation(order,anchors,msgs,covered);({first,second});`;
 const x=a.run(program),y=b.run(program);assert.equal(normalizedPlan(y.first),normalizedPlan(x.first));assert.equal(normalizedPlan(y.second),normalizedPlan(x.second));assert.ok(y.first.byShape>0);assert.equal(y.second.claims.size,0);
});
test('shape mismatch digest work becomes linear with identical plan',t=>{
 if(!source){t.skip('BILI_KERNEL_FILE required for bounded performance proof');return;}
 const before=runtime(),after=runtime(true),count=80;
 const fixture=`const n=${count};const text='synthetic candidate '+('alpha beta gamma delta '.repeat(12));const msgs=Array.from({length:n},(_,i)=>({id:'new'+i,role:'tool',contentType:'tool-result',text}));const old=Array.from({length:n},(_,i)=>'old'+i);const anchors=Object.fromEntries(old.map(id=>[id,{r:'tool',c:'tool-result',b:text.length,wh:0,sh:'0000000000000000'}]));digestCalls=0;const start=performance.now();const plan=planReconciliation(old,anchors,msgs,new Set(old));({plan,calls:digestCalls,ms:performance.now()-start});`;
 const original=before.run(fixture),optimized=after.run(fixture);
 assert.equal(normalizedPlan(optimized.plan),normalizedPlan(original.plan));
 assert.equal(original.calls,2*count*count);assert.equal(optimized.calls,count);
 writeTestResult({kind:'bounded-synthetic-reconciliation-differential',synthetic:true,privateDataRead:false,modelCalls:0,qqSends:0,messages:count,before:{digestCalls:original.calls,ms:original.ms},after:{digestCalls:optimized.calls,ms:optimized.ms},matchingResultIdentical:true,limitation:'Candidate comparisons remain quadratic; repeated text normalization/hash work is memoized. This is not a real-host throughput measurement.'});
});
