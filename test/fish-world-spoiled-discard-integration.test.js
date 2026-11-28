import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {LifeEngine} from '../extensions/aurabot/fish-world/life.mjs';
import {executeSequencedAction,noteActionSessionEvent,noteActionGuardRejected} from '../extensions/aurabot/fish-world/action-sequence.mjs';
import {renderLifeTool} from '../extensions/aurabot/fish-world/tool-output.mjs';

const W='mcp__fish-world__world_',NOW=Date.parse('2026-11-28T08:00:00+08:00');
const INVENTORY='你的食材（做饭用）：鸡蛋 egg 6 个（不新鲜了）、葱 scallion 1 把（用了一些，还剩 4 份）（坏了）、大米 rice 1 袋（用了一些，还剩 1 份）';
const VIEW=['11-28 周六 08:00 · 晴 6°C','你在：家 · 厨房','你的家（合成住处）· 不要的东西 world_do 填 throw- 加 id 扔掉，count 是扔几件 · 摆着的换房间填 put- 加它的 home- 编号，name 填房间',INVENTORY].join('\n');

function extractNative(asar,scratch){
 assert.ok(scratch,'Use the managed test runner');
 const fd=fs.openSync(asar,'r'),head=Buffer.alloc(16);fs.readSync(fd,head,0,16,0);const hs=head.readUInt32LE(4),raw=Buffer.alloc(head.readUInt32LE(12));fs.readSync(fd,raw,0,raw.length,16);
 const tree=JSON.parse(raw),target=path.join(scratch,'spoiled-discard-native-sdk'),queue=['@deepseek-ai/dsh-tool-executor-native'],seen=new Set(),find=p=>p.split('/').reduce((n,k)=>n?.files?.[k],tree);
 fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'package.json'),'{"type":"module"}');
 try{while(queue.length){const pkg=queue.shift();if(seen.has(pkg))continue;seen.add(pkg);const prefix=['dsh/node_modules/'+pkg,'node_modules/'+pkg].find(p=>find(p));assert.ok(prefix,'Missing installed runtime '+pkg);
  const copy=(node,relative='')=>{for(const[name,entry]of Object.entries(node.files||{})){const rel=relative?relative+'/'+name:name;if(entry.files){copy(entry,rel);continue;}if(!/\.(js|mjs|cjs|json)$/.test(name))continue;let bytes;if(entry.unpacked)bytes=fs.readFileSync(asar+'.unpacked/'+prefix+'/'+rel);else{bytes=Buffer.alloc(entry.size);fs.readSync(fd,bytes,0,bytes.length,8+hs+Number(entry.offset));}const file=path.join(target,'node_modules',pkg,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);if(/\.(js|mjs|cjs)$/.test(name))for(const match of bytes.toString().matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)){const spec=match[1];if(spec.startsWith('.')||spec.startsWith('node:'))continue;const dep=spec.startsWith('@')?spec.split('/').slice(0,2).join('/'):spec.split('/')[0];if(!['fs','path','crypto','os','url','util','stream','events','buffer','assert','async_hooks','module'].includes(dep))queue.push(dep);}}};copy(find(prefix));
 }}finally{fs.closeSync(fd);}return target;
}

test('actual native registry keeps spoiled-template discard inside intent, guards, journal and request-id deduplication',async t=>{
 if(!process.env.DSH_ASAR||!process.env.AURABOT_SOURCE){t.skip('Set DSH_ASAR and AURABOT_SOURCE for installed native spoiled-discard integration');return;}
 const root=extractNative(process.env.DSH_ASAR,process.env.THINKSTAR_TEST_TMP),[{NativeToolExecutor},{defineTool}]=await Promise.all([
  import(pathToFileURL(path.join(root,'node_modules/@deepseek-ai/dsh-tool-executor-native/lib/index.js')).href),
  import(pathToFileURL(path.join(process.env.AURABOT_SOURCE,'src/tools/tools.js')).href)
 ]);
 let clock=NOW,seq=0,qqSends=0;const identity={owner:'synthetic-owner',persona:'synthetic-persona'},data={fishId:'synthetic-fish#1',state:{where:{kind:'home'},doing:null},at:{state:NOW},life:{...newLife(NOW),...identity}};
 const engine=new LifeEngine({bridge:{data,change:fn=>fn(data)},clock:()=>clock,identity:()=>identity,settings:()=>({maxCalls:6}),host:{send:async()=>{qqSends++;assert.fail('No QQ sends');}}}),signal=new AbortController().signal,toolSet={synthetic:'spoiled-discard'},agent={session:{id:'session-synthetic-spoiled-discard',append:()=>assert.fail('No orphan session surface')}};
 const round=engine.l.round={id:'synthetic-spoiled-discard-round',kind:'idle',sessionId:agent.session.id,status:'running',revision:engine.l.revision,startedAt:NOW,receipts:[],calls:0,events:[],planIds:[],observation:'',intent:null},bodies=[],guarded=[],observed=[],intents=[],nested=[];
 const originalIntent=engine.intent.bind(engine);engine.intent=input=>{intents.push(structuredClone(input));return originalIntent(input);};
 let official;
 const definitions=['now','profile','say','do'].map(name=>defineTool({name:W+name,properties:{},execute:async args=>{
  bodies.push({name:W+name,args:structuredClone(args)});clock+=10;
  if(name==='do'){assert.equal(args.id,'throw-scallion');assert.equal(args.count,1);assert.equal(typeof args.request_id,'string');assert.ok(args.request_id.length>0);}
  return {ok:true,message:name==='now'?VIEW:name==='profile'?'synthetic-fish#1\n合成本鱼身份':'好的，扔掉了合成坏原料。'};
 }}));
 definitions.push(defineTool({name:'fish_life_action',render:renderLifeTool,execute:(args,exec)=>executeSequencedAction({engine,tools:official,exec},args)}));
 const registry={executable:name=>definitions.find(def=>def.name===name),checkGuards(exec){guarded.push(exec.name);const reason=engine.guard(exec,true,false);if(reason)noteActionGuardRejected(engine,exec,reason);return reason?{reason}:undefined;}};
 const context={tools:registry,waterfall:async(...args)=>args.at(-1)(),get:()=>undefined,logger:{warn:message=>assert.fail(message)},events:{dispatch:()=>[(exec,result)=>{observed.push(exec.name);engine.result(exec,result);}]}};
 const executor=new NativeToolExecutor(context,()=>1);official={definitions:()=>definitions,selectExecutor:()=>executor,execute:batch=>{assert.equal(batch.log,undefined);assert.equal(batch.agent,agent);assert.equal(batch.signal,signal);assert.equal(batch.toolSet,toolSet);assert.equal(batch.maxParallelToolCalls,1);if(batch.calls[0].id.startsWith('fishseq-'))nested.push(batch.calls[0].name);return executor.execute(batch);}};
 const invoke=async(name,args)=>{const id='synthetic-discard-parent-'+(++seq);if(name==='fish_life_action')noteActionSessionEvent(engine,agent.session,{type:'tool/call',seq,data:{turn:1,step:seq,callId:id,name,arguments:JSON.stringify(args)}});const batch=await official.execute({calls:[{type:'tool-call',id,name,arguments:JSON.stringify(args)}],agent,signal,toolSet,maxParallelToolCalls:1});const result=batch.results[0].result;assert.equal(result.isError,false);return name==='fish_life_action'?JSON.parse(result.content[0].text):result;};
 await invoke(W+'now',{});
 const input={tool:W+'do',arguments:'{"id":"throw-scallion","count":1}',category:'daily',cost:0,evidence:INVENTORY},done=await invoke('fish_life_action',input);
 assert.equal(done.ok,true,done.message);assert.equal(done.status,'confirmed');assert.deepEqual(nested,[W+'profile',W+'do']);assert.equal(intents.length,1);assert.equal(intents[0].evidence,INVENTORY,'intent keeps the exact original inventory line, never fabricated server text');
 assert.deepEqual(observed.filter(name=>name.startsWith(W)),guarded.filter(name=>name.startsWith(W)));assert.equal(bodies.filter(row=>row.name===W+'do').length,1);assert.equal(engine.l.journal.find(row=>row.id===done.receiptId).status,'confirmed');assert.equal(round.calls,3);assert.ok(round.calls<=6);
 const again=await invoke('fish_life_action',{...input,arguments:'{"id":"throw-scallion","count":1,"request_id":"model-changed"}'});assert.equal(again.reused,true);assert.equal(again.receiptId,done.receiptId);assert.equal(bodies.filter(row=>row.name===W+'do').length,1);assert.equal(intents.length,1);assert.equal(round.calls,3);
 assert.equal(engine.l.recovery,false);assert.equal(engine.l.outbox.length,0);assert.equal(qqSends,0);
 t.diagnostic(JSON.stringify({actualNativeToolExecutor:true,actualAurabotDefineTool:true,originalEvidence:true,guardedDiscard:1,worldCalls:round.calls,limit:6,requestIdDeduplicated:true,modelCalls:0,realWorldCalls:0,qqSends}));
});
