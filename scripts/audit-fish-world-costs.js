import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {zstdDecompressSync,zstdCompressSync} from 'node:zlib';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {managedScript,writeTestResult} from './lib/test-workspace.js';

const root=fileURLToPath(new URL('../',import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex');
const day=at=>new Date(at+28800000).toISOString().slice(0,10);
function check(ok,message){if(!ok)throw Error(message);}
function noLinks(base,target){
 base=fs.realpathSync(base);target=path.resolve(target);
 const relative=path.relative(base,target);check(!relative.startsWith('..')&&!path.isAbsolute(relative),'Path outside owned root');
 for(let p=target;;p=path.dirname(p)){if(fs.existsSync(p))check(!fs.lstatSync(p).isSymbolicLink(),'Refusing symlink or junction');if(p===base)break;}
 return target;
}
function readSource(file){file=path.resolve(file);const bytes=fs.readFileSync(file);return {file,sha256:hash(bytes),bytes,text:bytes.toString('utf8')};}

/**
 * Reuses the installed host's exact source in an isolated pure-calculation VM.
 * Store imports are removed, not imported. Their stubs cannot access disk/network/timers.
 * initUsage reads only a supplied empty virtual store and applies the host's own override merge.
 */
export function pricingSandbox({usageFile,offpeakFile,configFile}){
 const usage=readSource(usageFile),offpeak=readSource(offpeakFile),config=readSource(configFile),cfg=JSON.parse(config.text);
 const imports=usage.text.match(/^import .*$/gm)||[];
 check(imports.length===2&&imports.every(line=>/from '\.\/(store|offpeak)\.js'/.test(line)),'Unexpected installed pricing imports; review before running');
 check(!/^import /m.test(offpeak.text),'Unexpected offpeak dependencies');
 const strip=text=>text.replace(/^import .*$/gm,'').replace(/\bexport\s+/g,'');
 const denied=()=>{throw Error('Audit pricing sandbox forbids side effects');};
 const sandbox=vm.createContext({__input:{override:cfg.usage?.pricing||{},holidays:cfg.cost?.offPeakHolidays||[]},
   __fail:denied,__read:()=>({}),__virtualPath:()=> 'virtual-read-only-usage.json'},
   {codeGeneration:{strings:false,wasm:false}});
 const source=`const {beijingDayKey,isPeak}=(()=>{\n${strip(offpeak.text)}\nreturn {beijingDayKey,isPeak};})();\n`+
   'const dataDir=__virtualPath,readJson=__read,writeJson=__fail,setTimeout=__fail;\n'+strip(usage.text)+
   '\ninitUsage(__input.override,__input.holidays);globalThis.__pricing={costOf,priceOf};';
 new vm.Script(source,{filename:'installed-host-pricing-readonly.vm.js'}).runInContext(sandbox,{timeout:1000});
 return {costOf:row=>{
   check(row.model&&typeof row.model==='string','Missing model must remain unknown');
   sandbox.__row=structuredClone(row);
   return JSON.parse(new vm.Script('JSON.stringify(__pricing.costOf(__row))').runInContext(sandbox,{timeout:1000}));
 },metadata:{mode:'exact-installed-source-isolated-vm',storeImported:false,network:false,diskWrites:false,
   sources:[{path:usage.file,sha256:usage.sha256},{path:offpeak.file,sha256:offpeak.sha256},{path:config.file,sha256:config.sha256}],
   pricingSettingsSha256:hash(JSON.stringify({pricing:cfg.usage?.pricing||{},holidays:cfg.cost?.offPeakHolidays||[]})),
   currency:'CNY',invoice:false}};
}
export function extractUsage(event){
 return event.data?.usage??[...(event.data?.stream||[])].reverse().find(item=>item.type==='chunk'&&item.chunk?.type==='usage')?.chunk.usage??null;
}
function timeOf(value){const n=typeof value==='number'?value:Date.parse(value);return Number.isFinite(n)?n:null;}
function counts(usage){
 if(!usage||!['inputTokens','outputTokens'].every(k=>usage[k]!==null&&usage[k]!==undefined&&Number.isFinite(Number(usage[k]))&&Number(usage[k])>=0))return null;
 const number=k=>usage[k]===undefined?0:Number(usage[k]);
 if(!['cacheReadTokens','cacheWriteTokens'].every(k=>Number.isFinite(number(k))&&number(k)>=0))return null;
 return {freshInput:Number(usage.inputTokens),cachedInput:number('cacheReadTokens'),cacheWrite:number('cacheWriteTokens'),output:Number(usage.outputTokens)};
}
export function auditSession(bytes,{sessionId,windowKeys,cutoffAt,pricing,journal=[]}){
 const lines=zstdDecompressSync(bytes).toString('utf8').split('\n').filter(Boolean).map(JSON.parse),header=lines[0];
 check(header?.type==='session'&&header.id===sessionId,'Source session header does not match owned window');
 const inherited=header.inheritedEventCount??header.seededEventCount??header.seed?.inheritedEventCount;
 if(header.isSeeded&&!Number.isSafeInteger(inherited))return {requests:[],source:{sessionId,windowKeys,sha256:hash(bytes),isSeeded:true,status:'unknown-inherited-boundary',cutoffSeq:null,skippedSeedEvents:null},duplicates:0,conflicts:0};
 const boundary=Number.isSafeInteger(inherited)?inherited:0,events=new Map();let duplicates=0,conflicts=0;
 for(const event of lines.slice(1)){
  if(!Number.isSafeInteger(event.seq)||event.seq<boundary)continue;
  const at=timeOf(event.time);if(at!==null&&at>cutoffAt)continue;
  const prior=events.get(event.seq);
  if(prior){duplicates++;if(JSON.stringify(prior)!==JSON.stringify(event))conflicts++;if(!extractUsage(prior)&&extractUsage(event))events.set(event.seq,event);}
  else events.set(event.seq,event);
 }
 const sorted=[...events.values()].sort((a,b)=>a.seq-b.seq),requests=[],byTurnRound=new Map();
 const roundsByCall=new Map(journal.filter(j=>j.tool&&j.round).map(j=>[j.id,j.round]));
 for(const event of sorted){
  if(event.type==='tool/result'){
   const callId=event.data?.message?.callId||event.data?.message?.toolCallId||event.data?.callId;
   const round=roundsByCall.get(callId),turn=event.data?.turn;
   if(round){const set=byTurnRound.get(turn)||new Set();set.add(round);byTurnRound.set(turn,set);}
  }
 }
 let model='',provider='';
 for(const event of sorted){
  if(event.type==='model/selection'){model=typeof event.data?.model==='string'?event.data.model:'';provider=typeof event.data?.provider==='string'?event.data.provider:'';}
  if(!['assistant/message','assistant/attempt'].includes(event.type))continue;
  if(event.type==='assistant/message'&&event.surfaceOp!=='append')continue;
  if(event.type==='assistant/attempt'&&event.surfaceOp&&event.surfaceOp!=='append')continue;
  const source=event.data?.message?.source||{},usage=counts(extractUsage(event)),at=timeOf(event.time);
  const selectedModel=typeof source.model==='string'?source.model:model,selectedProvider=typeof source.provider==='string'?source.provider:provider;
  const roundIds=[...(byTurnRound.get(event.data?.turn)||[])];
  const row={key:sessionId+':'+event.seq,sessionId,windowKeys,seq:event.seq,turn:event.data?.turn??null,step:event.data?.step??null,
   roundId:roundIds.length===1?roundIds[0]:null,roundAttribution:roundIds.length===1?'exact-tool-call-receipt':'not-proven-from-retained-ledger',
   kind:event.type,at,day:at===null?null:day(at),model:selectedModel,provider:selectedProvider,
   freshInput:usage?.freshInput??null,cachedInput:usage?.cachedInput??null,cacheWrite:usage?.cacheWrite??null,output:usage?.output??null,
   status:'unknown',reason:'usage-missing',estimatedCny:null,knownComponentCny:null,peak:null};
  if(usage){
   row.reason=!selectedModel?'model-missing':at===null?'timestamp-missing':usage.cacheWrite?'cache-write-price-not-covered':'price-unavailable';
   if(selectedModel&&at!==null)try{
    const price=pricing.costOf({model:selectedModel,in:usage.freshInput,cached:usage.cachedInput,out:usage.output,at});
    if(price&&!price.unpriced&&Number.isFinite(price.cost)&&price.cost>=0){
     row.knownComponentCny=price.cost;row.peak=!!price.peak;
     if(!usage.cacheWrite){row.status='priced';row.reason='host-configured-cny-estimate';row.estimatedCny=price.cost;}
    }
   }catch{}
  }
  requests.push(row);
 }
 return {requests,duplicates,conflicts,source:{sessionId,windowKeys,sha256:hash(bytes),compressedBytes:bytes.length,isSeeded:!!header.isSeeded,
  inheritedEventBoundary:boundary,status:'read',cutoffAt,cutoffSeq:sorted.at(-1)?.seq??null,firstSeq:sorted[0]?.seq??null,eventsRead:sorted.length,skippedSeedEvents:boundary}};
}
function totals(rows){
 const result={modelRequests:rows.length,messages:0,attempts:0,pricedRequests:0,unknownRequests:0,
  freshInput:0,cachedInput:0,cacheWrite:0,output:0,estimatedCny:0,knownComponentCny:0,complete:true};
 for(const row of rows){result[row.kind==='assistant/attempt'?'attempts':'messages']++;result[row.status==='priced'?'pricedRequests':'unknownRequests']++;
  for(const key of ['freshInput','cachedInput','cacheWrite','output','estimatedCny','knownComponentCny'])if(row[key]!==null)result[key]+=row[key];}
 result.complete=!result.unknownRequests;return result;
}
function grouped(rows,keyOf){
 const groups=new Map();for(const row of rows){const key=keyOf(row);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
 return [...groups].map(([key,rows])=>({key,...totals(rows)}));
}
export function auditOwned({runtimeFile,sessionsDir,pricing,asarFile,cutoffAt=Date.now()}){
 const before=readSource(runtimeFile),runtime=JSON.parse(before.text),windows=runtime.life?.contextWindow?.windows;
 check(Array.isArray(windows),'Owned world window index missing');
 const owned=new Map();for(const window of windows){if(!window.sessionId)continue;check(/^session-[A-Za-z0-9-]+$/.test(window.sessionId),'Invalid owned session ID');
  if(!owned.has(window.sessionId))owned.set(window.sessionId,new Set());owned.get(window.sessionId).add(window.key);}
 const requests=[],sources=[];let duplicateEvents=0,conflictingDuplicateEvents=0;
 for(const [sessionId,keys]of owned){
  const file=noLinks(sessionsDir,path.join(sessionsDir,sessionId,'session.v4.jsonl.zstd'));
  if(!fs.existsSync(file)){sources.push({sessionId,windowKeys:[...keys],path:file,status:'missing'});continue;}
  const result=auditSession(fs.readFileSync(file),{sessionId,windowKeys:[...keys],cutoffAt,pricing,journal:runtime.life.journal||[]});
  requests.push(...result.requests);sources.push({...result.source,path:file});duplicateEvents+=result.duplicates;conflictingDuplicateEvents+=result.conflicts;
 }
 const after=readSource(runtimeFile),asar=asarFile?readSource(asarFile):null;
 return {schema:1,kind:'read-only-owned-world-cost-audit',synthetic:false,createdAt:new Date().toISOString(),cutoffAt,
  sourceRuntime:{path:before.file,sha256:before.sha256,sha256After:after.sha256,stable:before.sha256===after.sha256,schema:runtime.version,lifeSchema:runtime.life.version},
  hostRuntime:asar&&{path:asar.file,sha256:asar.sha256},pricing:pricing.metadata,
  scope:{ownedWindows:windows.length,ownedSessions:owned.size,sessionSourcesOnlyFromOwnedIndex:true,modelCalls:0,qqSends:0,worldMutations:0,realSourceWrites:0,rawChatCopied:false},
  settlement:{uniqueKey:'sessionId:event.seq',assistantMessages:'surfaceOp append only',attempts:'all distinct attempts, including missing usage',
   inheritedSeeds:'skip proven inherited prefix; unproven seeded boundary excludes session and marks incomplete',lateUsage:'same seq richer usage replaces missing receipt',
   duplicateEvents,conflictingDuplicateEvents,invoice:false,
   inputDefinition:'inputTokens is fresh/uncached; total input=freshInput+cachedInput; cacheWrite separate',
   limitations:['Configured host prices estimate CNY; this is not a provider invoice.','Missing usage, unknown model, unknown price or unsupported cache-write price remains unknown.','Round attribution requires exact retained tool-call receipt; historical journal retention can leave it unproven.','No savings ratio is inferred from differing natural activity days.']},
  complete:sources.every(s=>s.status==='read')&&requests.every(r=>r.status==='priced')&&before.sha256===after.sha256&&conflictingDuplicateEvents===0,
  totals:totals(requests),byDay:grouped(requests,r=>r.day||'unknown'),byWindow:grouped(requests,r=>r.sessionId),
  byTurn:grouped(requests,r=>r.sessionId+':'+r.turn),sources,requests};
}
async function selfTest(options){
 await managedScript(import.meta.url,async()=>{
  const pricing=pricingSandbox(options),sid='session-fixture',at=Date.parse('2026-11-21T12:00:00+08:00');
  const message={type:'assistant/message',surfaceOp:'append',seq:2,time:at,data:{turn:1,step:1,message:{source:{model:'deepseek-flash',provider:'fixture'}},usage:{inputTokens:1000,cacheReadTokens:2000,outputTokens:30}}};
  const attempt={type:'assistant/attempt',seq:3,time:at,data:{turn:1,step:2,stream:[]}},seed={type:'session',id:sid,isSeeded:false};
  const rows=[seed,{type:'model/selection',seq:0,time:at,data:{model:'deepseek-flash',provider:'fixture'}},message,message,attempt];
  const bytes=zstdCompressSync(Buffer.from(rows.map(x=>JSON.stringify(x)).join('\n'))),r=auditSession(bytes,{sessionId:sid,windowKeys:['fixture'],cutoffAt:at+1,pricing});
  assert.equal(r.requests.length,2);assert.equal(r.duplicates,1);assert.equal(r.requests[0].status,'priced');assert.equal(r.requests[1].status,'unknown');assert.equal(r.requests[0].freshInput,1000);assert.equal(r.requests[0].cachedInput,2000);
  const missing={...message,data:{...message.data,usage:undefined}},late=auditSession(zstdCompressSync(Buffer.from([seed,missing,message].map(x=>JSON.stringify(x)).join('\n'))),{sessionId:sid,windowKeys:['fixture'],cutoffAt:at+1,pricing});
  assert.equal(late.requests.length,1);assert.equal(late.requests[0].status,'priced');
  const unknownSeed=auditSession(zstdCompressSync(Buffer.from(JSON.stringify({...seed,isSeeded:true}))),{sessionId:sid,windowKeys:['fixture'],cutoffAt:at+1,pricing});
  assert.equal(unknownSeed.source.status,'unknown-inherited-boundary');
  fs.writeFileSync(path.join(process.env.THINKSTAR_TEST_TMP,'synthetic-roundtrip.zstd'),bytes);
  writeTestResult({synthetic:true,passed:true,checks:['append-once','attempt-unknown','fresh-cache-separated','late-usage-once','seed-boundary-refusal','installed-pricing-isolated-no-store'],requests:2});
  console.log('Six read-only audit checks passed; synthetic scratch will be cleaned.');
 });
}
const main=process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(main){
 const args=process.argv.slice(2);
 if(args.includes('--help'))console.log('Read-only owned fish-world cost audit. Required: --host-usage <absolute usage.js> --host-offpeak <absolute offpeak.js> --host-config <absolute config.json>. Audit also requires --runtime <absolute runtime.json> --sessions-dir <absolute owned sessions group>. Optional --host-asar <absolute app.asar>. --self-test runs managed synthetic validation only. Private audit reports go only to runtime-data/test-reports/fish-world-cost-audit-*. No model, QQ or real-source writes.');
 else{
  const option=(name,optional=false)=>{const i=args.indexOf('--'+name);if(i<0&&optional)return undefined;check(i>=0&&args[i+1]&&!args[i+1].startsWith('--'),'Missing --'+name);check(path.isAbsolute(args[i+1]),'Absolute path required: '+name);return path.resolve(args[i+1]);};
  const options={usageFile:option('host-usage'),offpeakFile:option('host-offpeak'),configFile:option('host-config')};
  if(args.includes('--self-test'))await selfTest(options);
  else{
   const report=auditOwned({runtimeFile:option('runtime'),sessionsDir:option('sessions-dir'),asarFile:option('host-asar',true),pricing:pricingSandbox(options)});
   const name='fish-world-cost-audit-'+new Date().toISOString().replace(/[-:.]/g,'')+'-'+randomUUID().slice(0,8),folder=noLinks(root,path.join(root,'runtime-data/test-reports',name));
   fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'audit.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
   const summary={report:folder,cutoffAt:report.cutoffAt,complete:report.complete,totals:report.totals,byDay:report.byDay,sourceStable:report.sourceRuntime.stable,synthetic:false};
   fs.writeFileSync(path.join(folder,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
   fs.writeFileSync(path.join(folder,'cleanup-receipt.json'),JSON.stringify({synthetic:false,createdTemporaryData:false,cleanup:'not-required',preserved:['audit.json','summary.json','source real ledgers'],realSourcesModified:false},null,2)+'\n',{flag:'wx'});
   console.log(JSON.stringify(summary,null,2));
  }
 }
}
