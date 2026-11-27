import {extractRuntime} from './helpers/extract-host-runtime.js';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {LifeEngine,worldNames} from '../extensions/aurabot/fish-world/life.mjs';
import {newLife} from '../extensions/aurabot/fish-world/state.mjs';
import {chooseWindow,windowOwns,windowPrompt,carryForward,completedWindowRound,safeBoundary} from '../extensions/aurabot/fish-world/world-window.mjs';
import {prepareRequest} from '../extensions/aurabot/fish-world/host-runtime.mjs';
import {admission,estimateTokens} from '../extensions/aurabot/fish-world/governance.mjs';
import {planContextGovernance,installMemoContextDedup} from '../extensions/aurabot/history-vault/context-dedup.mjs';
const now=1795132800000;
function engine(settings={}){const data={fishId:'fixture-fish',at:{state:now,now},now:'现场原文',state:{where:{kind:'place',id:'fixture-home'},figure:{asleep:false}},life:newLife(now)};const bridge={data,change(fn){const old=structuredClone(data);try{return fn(data);}catch(e){Object.assign(data,old);throw e;}}};return new LifeEngine({bridge,clock:()=>now,settings:()=>({backgroundContextEnabled:true,...settings}),host:{remember:async()=>null,cancel:async()=>{},idle:async()=>true},identity:()=>({owner:'10001',persona:'fixture'})});}
function finish(e,id){e.l.round={id,status:'running',observation:'真实回执',events:[],receipts:[],report:{events:[],plans:[],summary:'完成',facts:[],share:'',importance:'routine'},kind:'idle'};e.end(true);}
test('world window counts completed life rounds, never calls, retries or duplicate settlement',()=>{
 const e=engine(),base='identity-fixture',k=chooseWindow(e,base,{nonce:()=> 'one'});assert.equal(k.length,31);
 for(let i=0;i<16;i++){for(let j=0;j<7;j++)assert.equal(chooseWindow(e,base),k);finish(e,'round-'+i);}
 assert.equal(e.l.contextWindow.completed,16);e.end(true);assert.equal(e.l.contextWindow.completed,16);
 const next=chooseWindow(e,base,{nonce:()=> 'two'});assert.notEqual(next,k);assert.equal(e.l.contextWindow.completed,0);
 assert.equal(windowOwns(e.l,base,k),false);assert.equal(windowOwns(e.l,base,next),true);assert.equal(windowOwns(e.l,base,'cw:forged'),false);
});
test('in-flight, unresolved, recovery and delivery block rollover without resetting ledgers',()=>{
 for(const type of ['lock','deliveryBusy','externalPending','recovery','uncertain-event','executing','sending','queued']){
  const e=engine();chooseWindow(e,'fixture');e.l.contextWindow.completed=16;e.l.days['fixture']={spend:88,calls:22};const before=JSON.stringify(e.l.days),key=e.l.contextWindow.key;
  if(type==='lock')e.lock={callId:'old-call'};if(type==='deliveryBusy')e.deliveryBusy=true;if(type==='externalPending')e.l.externalPending={callId:'old-call'};if(type==='recovery')e.l.recovery=true;if(type==='uncertain-event')e.l.queue.push({id:'old-event',status:'uncertain'});if(type==='executing')e.l.journal.push({id:'old-call',status:'executing'});if(['sending','queued'].includes(type))e.l.outbox.push({id:'same-delivery',state:type});
  assert.equal(chooseWindow(e,'fixture'),key,type);assert.equal(JSON.stringify(e.l.days),before,type);
 }
});

test('a static uncertain share permits bounded forced rollover without changing or resending its evidence',async t=>{
 const e=engine(),base='fixture-stalled-share',oldKey=chooseWindow(e,base,{nonce:()=> 'old-window'});e.bind('session-old-world',worldNames);
 Object.assign(e.l,{owner:'10001',persona:'fixture'});e.l.contextWindow.completed=1;
 e.l.outbox.push({id:'old-partial-share',at:now-3*86400000,state:'uncertain',importance:'important',text:'合成旧生活分享',owner:'10001',persona:'fixture',attempts:1,receipt:'partial-receipt',receipts:['partial-receipt'],deliveryId:'original-delivery',facts:['old-tool-receipt'],reason:'合成部分投递，保留原回执'});
 e.l.journal.push({id:'old-tool-receipt',tool:'mcp__fish-world__world_history',status:'confirmed',args:'{"fish":"#321"}',result:'合成历史回执完整原文',sessionId:'session-old-world'});
 e.l.days['fixture-day']={work:2,idle:3,social:4,share:1,spend:17,calls:9};
 const preserved=()=>structuredClone({outbox:e.l.outbox,journal:e.l.journal,days:e.l.days,plans:e.l.plans,queue:e.l.queue,ownerInstructions:e.l.ownerInstructions,sessionId:e.l.sessionId});
 const before=preserved(),oldWindows=structuredClone(e.l.contextWindow.windows),epoch=e.l.contextWindow.epoch;
 assert.equal(safeBoundary(e),true);assert.equal(chooseWindow(e,base),oldKey,'a static share does not itself request a rollover');
 const round={id:'new-round-fixture',events:[],planIds:[],kind:'idle',readOnly:false},prompt=e.prompt([],round);
 const messages=[{role:'user',content:[{type:'text',text:'h'.repeat(94000)}]}],schemas=[{name:'synthetic-world-schema',description:'schema'.repeat(2600)}];
 const visibleTokens=estimateTokens(messages),oldRequestTokens=estimateTokens(prompt)+visibleTokens+estimateTokens(schemas)+16000;
 assert.ok(visibleTokens<e.cfg.visibleContextEstimatedTokenLimit);assert.ok(oldRequestTokens>e.cfg.requestAdmissionEstimatedTokenLimit,'the complete old request, rather than the round counter, forces rotation');
 assert.ok(oldRequestTokens>70000&&oldRequestTokens<85000,'synthetic old request reproduces the approximately 75k stall');
 const old={session:{id:'session-old-world',deriveMessages:()=>messages}},folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'uncertain-share-window-'));
 const restoreWorldScope=agent=>{assert.equal(agent,old);assert.equal(agent.session.id,e.l.sessionId);assert.ok(e.l.contextWindow.windows.some(window=>window.sessionId===agent.session.id));return [...worldNames];};
 const prepared=await prepareRequest(e,{dataDir:(...parts)=>path.join(folder,...parts),dsh:{get:name=>name==='tools'?{schemas:()=>schemas}:null}},{scope:()=>base,findAgent:()=>old,identity:()=>({owner:'10001',persona:'fixture'}),restoreWorldScope},prompt,round);
 assert.notEqual(prepared.windowKey,oldKey);assert.equal(e.l.contextWindow.epoch,epoch+1);assert.equal(e.l.contextWindow.completed,0);
 assert.deepEqual(e.l.contextWindow.windows.slice(0,-1),oldWindows);assert.equal(e.l.contextWindow.windows.at(-1).sessionId,null);
 assert.equal(prepared.estimate.visibleContextTokens,0);assert.ok(prepared.estimate.requestTokens<e.cfg.requestAdmissionEstimatedTokenLimit);
 assert.equal(admission(e.l,{id:'synthetic-idle',kind:'idle',bucket:'idle',priority:4},e.cfg,{now,estimate:prepared.estimate}).allowed,true);
 assert.deepEqual(preserved(),before,'rotation changes only its context-window state');
 assert.equal(chooseWindow(e,base,{force:true}),prepared.windowKey,'an unbound new window is reused rather than repeatedly rotated');
 let sends=0,statusQueries=0;e.host.send=async()=>{sends++;assert.fail('An uncertain delivery must never be resent');};e.host.deliveryStatus=async()=>{statusQueries++;assert.fail('Static uncertain delivery does not poll an old receipt');};
 await e.deliver();await e.deliver();assert.equal(sends,0);assert.equal(statusQueries,0);assert.deepEqual(preserved(),before);
 t.diagnostic(JSON.stringify({kind:'synthetic-static-share-window-rollover',oldRequestTokens,newRequestTokens:prepared.estimate.requestTokens,oldVisibleTokens:visibleTokens,newVisibleTokens:prepared.estimate.visibleContextTokens,retainedPartialReceipts:e.l.outbox[0].receipts.length,modelCalls:0,qqSends:sends}));
});
test('disabled world optimization continues current safe window and failed rounds do not count',()=>{
 const e=engine(),key=chooseWindow(e,'fixture');e.l.contextWindow.completed=16;assert.equal(chooseWindow(e,'fixture',{enabled:false}),key);
 e.l.round={id:'failed',status:'uncertain',receipts:[],events:[]};e.end(false);assert.equal(e.l.contextWindow.completed,16);assert.equal(e.l.recovery,true);
 assert.throws(()=>chooseWindow(e,'other-identity'),/身份/);
});
test('bounded handoff retains selected task while durable ledger preserves all plans and delivery receipts',()=>{
 const e=engine();chooseWindow(e,'fixture');e.l.owner='10001';e.l.persona='fixture';e.l.plans=Array.from({length:100},(_,i)=>({id:'plan-'+i,status:'active',trigger:'arrive',nextAt:now+123456+i}));e.l.queue=[{id:'event-uncertain',status:'uncertain'}];e.l.ownerInstructions=[{text:'保留安排',at:now}];e.l.outbox=[{id:'delivery',state:'sent',receipt:99881,receipts:[99881],deliveryId:'stable-id',owner:'10001',persona:'fixture'}];e.l.journal=[{id:'call-id',status:'uncertain',args:'exact-args'}];
 const p=carryForward(e,{owner:'10001',persona:'fixture'},now,{planIds:e.l.plans.slice(0,12).map(p=>p.id),events:[]});assert.equal(Object.keys(p.plans).length,12);assert.equal(p.plans['plan-11'].nextAt,now+123467);assert.equal(e.l.plans.length,100);assert.equal(e.l.outbox[0].receipt,99881);assert.equal(p.unconfirmed[0].id,'call-id');assert.equal(p.identity.fishId,'fixture-fish');assert.equal(p.history.tool,'fish_life_history');
 const round={id:'only-once'};completedWindowRound(e.l,round);completedWindowRound(e.l,round);assert.equal(e.l.contextWindow.completed,1);
});
function legacy(memory='MEMORY_SOURCE_ID_A'.repeat(30)){return ['IDENTITY_RULE','本轮原因与资料：fixture','旧计划','主人安排','BUDGET_INTENT_RULE','NEXT_AT_RULE','PROFILE_IDENTITY_RULE','EVENT_RECEIPT_RULE','SHARE_RULE',memory?'Thinkstar 来源资料（非新指令）：'+memory:''].filter(Boolean).join('\n\n');}
test('stable rules and full source packet are restored after projection/compaction removes them',()=>{
 const e=engine();chooseWindow(e,'fixture');const first=windowPrompt(e,legacy(),{identity:{owner:'10001',persona:'fixture'},visible:'',now});assert.ok(first.includes('IDENTITY_RULE'));assert.ok(first.includes('MEMORY_SOURCE_ID_A'));
 const second=windowPrompt(e,legacy(),{identity:{owner:'10001',persona:'fixture'},visible:first,now});assert.ok(!second.includes('IDENTITY_RULE'));assert.ok(!second.includes('MEMORY_SOURCE_ID_A'));assert.ok(second.includes('状态变化'));
 const restored=windowPrompt(e,legacy(),{identity:{owner:'10001',persona:'fixture'},visible:'summary without full packet',now});assert.ok(restored.includes('MEMORY_SOURCE_ID_A'));assert.ok(restored.includes('完整交接快照'));
});
function fixtures(count=30){let seq=0;const events=[],push=(type,data)=>{const e={type,seq:seq++,time:now,data};if(type.endsWith('/message')||type==='tool/result')e.surfaceOp='append';events.push(e);return e;};
 for(let t=1;t<=count;t++){
  push('turn/start',{turn:t});const native='（你记得这些事：'+('唯一固定事实、来源和角色。'.repeat(100))+'）';
  push('user/message',{id:'snapshot-'+t,role:'user',source:{kind:'runtime-context',form:'snapshot',sections:[{name:'aurabot-context',text:native+'\nSTATE-'+t}]},content:[{type:'text',text:'<system-reminder>'+native+'\nSTATE-'+t+'</system-reminder>'}]});
  push('user/message',{id:'user-'+t,role:'user',source:{kind:'aurabot',speaker:{role:'owner',chat:'private'}},content:[{type:'text',text:'【私聊】[12:00] 测试(10001)：自然聊天 '+t},{type:'image',attachment:{attachmentId:'sha256:fixture-image',mediaType:'image/png',width:1200,height:800}},{type:'text',text:'【历史备忘 · private:10001】更早的细节可用 recall_history 工具查询：'+('同一份真实归档来源摘要。'.repeat(60))},{type:'text',text:'【当前本机时间】2026-11-20 星期五 上午 12:00（以此判断时段，不以图片为准）。'}]});
  push('assistant/message',{turn:t,step:1,message:{id:'call-message-'+t,role:'assistant',source:{kind:'model',provider:'mock',model:'mock'},content:[{type:'tool-call',id:'call-'+t,name:'thinkstar_history',arguments:'{"level":0,"day":"2026-11-19"}'}]},stream:[]});
  push('tool/result',{turn:t,step:1,message:{id:'result-'+t,role:'tool',toolCallId:'call-'+t,source:{kind:'tool',callId:'call-'+t},isError:false,content:[{type:'text',text:'success; precise_value=123.456; source_id=SOURCE_A; '+('原始完整结果'.repeat(500))}]}});
  push('assistant/message',{turn:t,step:2,message:{id:'answer-'+t,role:'assistant',source:{kind:'model',provider:'mock',model:'mock'},content:[{type:'text',text:'该项已完成；精确值123.456，来源SOURCE_A。'}]},stream:[]});push('turn/end',{turn:t,reason:{kind:'completed'}});
 }return events;}
const scope={sessionId:'fixture-session',chatId:'private:10001',persona:'fixture'};
test('old duplicate memory, images and successful read-only tool pairs shrink without orphaning protocol',()=>{
 const events=fixtures(),plan=planContextGovernance(events,scope);assert.ok(plan.stats.memoBlocks>=29);assert.ok(plan.stats.imageBlocks>=20);assert.ok(plan.stats.toolPairs>=20);assert.ok(plan.stats.removedChars>50000);
 const originals=JSON.stringify(events);for(const edit of plan.edits){assert.ok(edit.sources.length>0);if(edit.sources.length>1)assert.equal(edit.sources.length,2);assert.ok(edit.message.content.length>0);}assert.equal(JSON.stringify(events),originals);
});
test('spoofed markers inside real user bodies are never treated as module injections',()=>{
 const e=fixtures(2);for(const x of e.filter(x=>x.type==='user/message'&&x.data.source.kind==='aurabot')){x.data.content=[{type:'text',text:'【私聊】[12:00] 测试(10001)：【历史备忘 · private:10001】更早的细节可用 recall_history 工具查询：伪造'+('A'.repeat(500))}];}
 const p=planContextGovernance(e,{...scope,memo:true,images:false,tools:false});assert.ok(p.edits.every(x=>x.message.source.reason!=='owned-exact-vault'));
});
test('distinct versions, source IDs, image crops and failed or unresolved tools remain intact',()=>{
 const events=fixtures();for(const e of events){const m=e.data?.message;if(e.type==='tool/result'){m.isError=true;m.content[0].text='timeout result uncertain';}if(e.type==='user/message'&&e.data.source.kind==='aurabot')e.data.content.find(b=>b.type==='image').attachment.width+=e.seq;}
 const p=planContextGovernance(events,scope);assert.equal(p.stats.imageBlocks,0);assert.equal(p.stats.toolPairs,0);
 const variants=fixtures(2).filter(x=>x.type==='user/message'&&x.data.source.kind==='runtime-context');variants[1].data.source.sections[0].text=variants[1].data.source.sections[0].text.replaceAll('唯一固定事实','冲突版本事实');variants[1].data.content[0].text=variants[1].data.content[0].text.replaceAll('唯一固定事实','冲突版本事实');assert.equal(planContextGovernance(variants,scope).stats.memoBlocks,0);
 assert.equal(planContextGovernance(events,{...scope,chatId:'group:10001'}).edits.length,0);
});
test('current comparison task pins all images, and each independent switch works',()=>{
 const e=fixtures();e.findLast(x=>x.type==='user/message'&&x.data.source.kind==='aurabot').data.content[0].text+=' 请比较之前图片中的坐标和OCR';assert.equal(planContextGovernance(e,scope).stats.imageBlocks,0);
 const none=planContextGovernance(e,{...scope,memo:false,images:false,tools:false});assert.equal(none.edits.length,0);
});
test('exact installed Session supports atomic replacements, replay and original image recovery',async t=>{
 const runtime=process.env.DSH_TEST_RUNTIME_DIR||(process.env.DSH_ASAR?extractRuntime(process.env.DSH_ASAR,process.env.THINKSTAR_TEST_TMP):null);if(!runtime){t.skip('Exact host SDK proof requires managed integration runner');return;}
 const {Session}=await import(pathToFileURL(path.join(runtime,'node_modules/@deepseek-ai/dsh-session/lib/index.js')).href);
 const source=fixtures(),session=Session.create('fixture-session',source),plan=planContextGovernance(source,scope);
 session.append(plan.edits.map(e=>[e.type,e.data,{surfaceOp:{op:'replace',startSeq:e.start,endSeq:e.end},sourceEventSeqs:e.sources}]));
 const full=session.snapshotEvents(),replayed=Session.create('fixture-session',full);assert.deepEqual(replayed.deriveMessages(),session.deriveMessages());assert.deepEqual(full.slice(0,source.length),source);
 const wire=session.deriveMessages(),calls=new Set(wire.flatMap(m=>m.content.filter(b=>b.type==='tool-call').map(b=>b.id)));for(const m of wire.filter(m=>m.role==='tool'))assert.ok(calls.has(m.toolCallId));
 const originalImage=full.find(e=>e.type==='user/message'&&e.data.id==='user-2').data.content.find(b=>b.type==='image');assert.equal(originalImage.attachment.attachmentId,'sha256:fixture-image');
 assert.ok(JSON.stringify(wire).length<JSON.stringify(Session.create('before',source).deriveMessages()).length*.6);
});
test('registered hook acts before request build and does not touch non-owner or workbench sessions',async()=>{
 const hooks=new Map(),cfg={contextDedupEnabled:false},routes=[],api={config:()=>({ownerQQ:'10001',persona:{current:'fixture'}}),dataDir:n=>path.join(process.env.THINKSTAR_TEST_TMP,n),core:{hub:{chatOfSession:()=> 'system:autotelic-workbench'}},dsh:{get:()=>null,on:(n,fn)=>{hooks.set(n,fn);return()=>{};}},route:(...a)=>routes.push(a),tool(){},onDispose(){},log:{warn(){}}};
 const governance=installMemoContextDedup(api,()=>cfg);assert.equal((await governance.prepare({session:{id:'no-owner'}})).held,'disabled-or-not-owner');let called=0;await hooks.get('agent/request')({agent:{session:{id:'test'}}},()=>{called++;});assert.equal(called,1);assert.equal(governance.status().prepared,0);assert.equal(routes.length,3);
});
test('16-round synthetic cost comparison includes cold rebuild and a frequent-window negative control',()=>{
 function sim(window){let total=0,fresh=0,cached=0;for(let round=0;round<80;round++){const within=window?round%window:round,history=(window?0:120000)+within*4200,prefix=30000,packet=within===0?4000:600;for(let step=0;step<4;step++){const input=prefix+history+packet+step*800;const cold=within===0&&step===0?input:step===0?4800:800;total+=input;fresh+=cold;cached+=input-cold;}}return {total,fresh,cached,cost:fresh*2+cached*.04};}
 const before=sim(0),after=sim(16);assert.ok(after.total<before.total*.4);assert.ok(after.cost<before.cost);const warm=30000*.04*4,cold=30000*2*4;assert.ok(cold>warm);
 const report=process.env.THINKSTAR_TEST_TMP&&path.join(path.dirname(path.dirname(process.env.THINKSTAR_TEST_TMP)),'unused');
 if(process.env.THINKSTAR_TEST_TMP){const marker=JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.THINKSTAR_TEST_TMP),'.thinkstar-test-run.json'))),root=marker.project;fs.writeFileSync(path.join(root,'runtime-data/test-reports',marker.id,'context-cost-fixture.json'),JSON.stringify({kind:'synthetic-only',modelCalls:0,before,after,inputReduction:1-after.total/before.total,realBillingProven:false,negativeControl:{warm,cold}},null,2));}
});


test('partial compaction containing only a state marker never suppresses complete handoff',()=>{
 const e=engine();chooseWindow(e,'fixture');windowPrompt(e,legacy(),{identity:{owner:'10001',persona:'fixture'},visible:'',now});const marker=e.l.contextWindow.packet.mark;
 const next=windowPrompt(e,legacy(),{identity:{owner:'10001',persona:'fixture'},visible:marker,now});assert.ok(next.includes('完整交接快照'));assert.ok(next.includes('MEMORY_SOURCE_ID_A'));
 e.l.plans=Array.from({length:100},(_,i)=>({id:'unfinished-'+i,status:'active',nextAt:now+100000,trigger:'done'}));finish(e,'keep-all');assert.equal(e.l.plans.filter(p=>p.status==='active').length,100);
});
test('full fish module loader admits only current owned route and exposes bounded source retrieval',async()=>{
 const {createHash}=await import('node:crypto'),{default:module}=await import('../extensions/aurabot/fish-world/index.mjs');
 const folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'world-loader-')),id={owner:'10001',persona:'fixture'},base=createHash('sha256').update(JSON.stringify(['fixture-fish',id])).digest('hex').slice(0,24),e=engine();
 Object.assign(e.l,{owner:id.owner,persona:id.persona});const route=chooseWindow(e,base);e.l.round={id:'fixture-round',sessionId:'fixture-session',status:'running',events:[],startedAt:Date.now(),receipts:[]};
 fs.writeFileSync(path.join(folder,'runtime.json'),JSON.stringify({version:3,keyId:'',fishId:'fixture-fish',cursor:'',recent:[],skipped:0,state:{stage:'alive',fish:'fixture-fish'},now:'fixture',at:{state:Date.now()},errors:{},life:e.l}));
 const builders=[],disposers=[],agent={cancel(){},whenIdle:async()=>{},session:{id:'fixture-session'},ctx:{tools:{restrict:()=>()=>{}}},status:'idle'},queried=[],names=['now','history','find','profile','go','do','say','friends','update','guide'].map(n=>'mcp__fish-world__world_'+n);
 const cfg={enabled:true,ownerQQ:id.owner,persona:{current:id.persona}},api={settings:()=>({backgroundContextEnabled:true,backgroundContextRounds:16}),config:()=>cfg,dataDir:(...parts)=>path.join(folder,...parts),log:{warn(){},info(){}},dsh:{get:n=>n==='tools'?{guard:()=>()=>{},schemas:()=>names.map(name=>({name}))}:n==='agents'?{get:()=>agent,list:()=>[agent]}:n==='sessionQuery'?{readEvent:async args=>{queried.push(args);return {events:[]};}}:null,on:()=>()=>{}},core:{hub:{chatOfSession:()=> 'system:ext-fish-world:'+route,turnSendersAllOwner:()=>true},http:{body:async r=>r.body}},use:()=>null,think:async()=>{throw Error('No model calls in loader test');},on(){},context(){},tool:fn=>builders.push(fn),rule(){},command(){},route(){},every(){},later(){},onDispose:fn=>disposers.push(fn),defineTool:v=>v};
 await module.setup(api);const tools=builders[0]({chat:{kind:'system',chatId:'system:ext-fish-world:'+route},level:'full',sessionId:'fixture-session'});assert.deepEqual(tools.map(t=>t.name),['fish_life_history','fish_life_intent','fish_life_finish']);assert.equal(tools.some(t=>t.name==='fish_life_task'),false);assert.equal(builders[0]({chat:{kind:'system',chatId:'system:ext-fish-world:'+base},level:'full',sessionId:'fixture-session'}).length,0);
 const history=tools.find(t=>t.name==='fish_life_history'),exec={agent};const listing=await history.execute({list:true},exec);assert.ok(listing.message.includes('fixture-session'));await history.execute({sessionId:'fixture-session',seq:12,after:2},exec);assert.equal(queried[0].seq,12);await assert.rejects(()=>history.execute({sessionId:'someone-else',seq:0},exec),/不是当前身份/);for(const off of disposers.reverse())await off();
});
test('extension updater verifies public download and extraction before mutation; cleanup is owned',async()=>{
 const {buildContextModule,updateContextModule,cleanupContextBackup,checkedPath}=await import('../scripts/lib/context-module-updater.js');
 const root=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'update-fixture-')),data=path.join(root,'data'),source=path.join(root,'extensions/aurabot/fish-world'),target=path.join(data,'modules/fish-world');fs.mkdirSync(path.dirname(source),{recursive:true});fs.cpSync(new URL('../extensions/aurabot/fish-world/',import.meta.url),source,{recursive:true});fs.mkdirSync(path.dirname(target),{recursive:true});fs.cpSync(source,target,{recursive:true});
 const old=JSON.parse(fs.readFileSync(path.join(target,'module.json')));old.version='0.9.0';fs.writeFileSync(path.join(target,'module.json'),JSON.stringify(old));fs.mkdirSync(path.join(root,'release'));fs.writeFileSync(path.join(root,'release/backup-policy.json'),JSON.stringify({repository:'fixture/repo',include_private_data:false,verify_public_download:true,verify_disk_restoration:true}));buildContextModule(root,'fish-world');
 const assets=[],bytes=new Map();let publicReads=0;const client={repository:'fixture/repo',release:async()=>({id:1,html_url:'https://example.invalid/verified-code'}),assets:async()=>assets,upload:async(_r,name,value)=>{const a={id:assets.length+1,name};assets.push(a);bytes.set(a.id,value);return a;},publish:async r=>r,download:async(a,o)=>{if(o?.publicOnly)publicReads++;return bytes.get(a.id);}};
 let hostChecks=0;
 await assert.rejects(updateContextModule({root,data,id:'fish-world',apply:true,client,validateHost:async()=>{if(++hostChecks===2)throw Error('synthetic host became busy after restoration');}}),/host became busy/);
 assert.equal(hostChecks,2);assert.equal(JSON.parse(fs.readFileSync(path.join(target,'module.json'))).version,'0.9.0');
 publicReads=0;hostChecks=0;
 const receipt=await updateContextModule({root,data,id:'fish-world',apply:true,client,validateHost:async()=>{hostChecks++;}});assert.equal(hostChecks,2);assert.equal(publicReads,2);assert.equal(receipt.backup.code_restoration_verified,true);assert.ok(fs.existsSync(receipt.localBackup));
 fs.writeFileSync(path.join(receipt.localBackup,'unowned-private-data.bin'),'do not delete');assert.throws(()=>cleanupContextBackup(root,data,'fish-world'));assert.ok(fs.existsSync(receipt.localBackup));fs.unlinkSync(path.join(receipt.localBackup,'unowned-private-data.bin'));const clean=cleanupContextBackup(root,data,'fish-world');assert.equal(clean.cleanup,'removed-after-cloud-restore-and-host-validation');assert.ok(clean.cleanedFiles>0);assert.throws(()=>checkedPath(data,path.join(root,'outside')));
});

test('tool-result image content-only replacement replays without altering tool identity or text',async t=>{
 const {extractRuntime}=await import('./helpers/extract-host-runtime.js');const runtime=process.env.DSH_ASAR?extractRuntime(process.env.DSH_ASAR,process.env.THINKSTAR_TEST_TMP):null;if(!runtime){t.skip('Exact SDK integration requires DSH_ASAR');return;}
 const {Session}=await import(pathToFileURL(path.join(runtime,'node_modules/@deepseek-ai/dsh-session/lib/index.js')).href),events=fixtures();
 for(const e of events.filter(e=>e.type==='tool/result')){e.data.message.content.push({type:'image',attachment:{attachmentId:'sha256:tool-picture',width:1600,height:900,mediaType:'image/png',name:'display-name-'+e.seq}});}
 const plan=planContextGovernance(events,{...scope,memo:false,tools:false,images:true}),toolEdits=plan.edits.filter(e=>e.type==='tool/result');assert.ok(toolEdits.length>=20);
 const s=Session.create('fixture-session',events);s.append(plan.edits.map(e=>[e.type,e.data,{surfaceOp:{op:'replace',startSeq:e.start,endSeq:e.end},sourceEventSeqs:e.sources}]));
 for(const e of toolEdits){const original=events[e.start];assert.equal(e.data.message.toolCallId,original.data.message.toolCallId);assert.deepEqual(e.data.message.source,original.data.message.source);assert.equal(e.data.message.content[0].text,original.data.message.content[0].text);}
 assert.deepEqual(Session.create('fixture-session',s.snapshotEvents()).deriveMessages(),s.deriveMessages());
});
test('existing-engine adapter refuses paid summaries and foreign scope before any compression',async()=>{
 const {applyExistingPlan}=await import('../extensions/aurabot/history-vault/existing-engine.mjs'),folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'engine-guard-')),api={dataDir:n=>path.join(folder,n)},plan={kind:'verified-existing-engine-plan',scope,backupReceipt:{verified:true},ranges:[{kind:'memo',proof:[],startRef:'m00001',endRef:'m00001',summary:'保留完整事实和关键精确值。'.repeat(10)}]};fs.writeFileSync(api.dataDir('context-governance-plan.json'),JSON.stringify(plan));
 let calls=0;const fetcher=async()=>{calls++;return{ok:true,json:async()=>({compress:{externalSummary:{enabled:true}}})};};
 await assert.rejects(()=>applyExistingPlan(api,()=>({contextCompressionOrigin:'http://127.0.0.1:9999'}),{...scope,fetcher}),/付费摘要/);assert.equal(calls,1);
 await assert.rejects(()=>applyExistingPlan(api,()=>({}),{...scope,persona:'foreign',fetcher}),/范围/);assert.equal(calls,1);
});
test('installed compression kernel preserves existing blocks when only unassigned image cells change',async t=>{
 if(!process.env.BILI_KERNEL_FILE){t.skip('Exact installed kernel integration requires BILI_KERNEL_FILE');return;}
 const {installedKernel}=await import('../scripts/lib/isolated-context-kernel.js'),k=installedKernel(process.env.BILI_KERNEL_FILE),core=k.createCore(),state=k.createInitialState(),messages=[];
 for(let i=0;i<20;i++){messages.push({id:'m-text-'+i,role:'user',contentType:'text',text:('固定来源精确值123.456-'+i+'。').repeat(100),wireIndex:i});messages.push({id:'image-'+i,role:'user',contentType:'text',text:'[image]',imagePart:true,rawAnthropicBlock:{type:'image',source:{type:'file',file_id:'exact-original-variant'}},wireIndex:i});}
 const config=k.defaultConfig(1000000),first=core.processTurn({messages,state,config,tokenCount:50000,renderTags:'none'}),refs=first.state.messageRefs.byRaw;
 assert.ok(messages.filter(m=>m.imagePart).every(m=>refs[m.id]==='BLOCKED'));
 const folded=core.applyCompression({messages,state:first.state,config,ranges:[{startRef:refs['m-text-0'],endRef:refs['m-text-5'],summary:'已完成事实；精确值123.456、固定来源、历史状态。'.repeat(20)}]});assert.ok(folded.result.blocksCreated>0);
 const after=core.processTurn({messages:messages.filter(m=>!m.imagePart),state:folded.state,config,tokenCount:30000,renderTags:'none'});assert.ok(folded.state.blocks.filter(b=>b.active).every(b=>after.state.blocks.some(a=>a.blockId===b.blockId&&a.active&&a.summary===b.summary)));
});

test('automatic text folds reject marginal gains that cannot repay a full cache rebuild',async()=>{
 const {autoBenefit}=await import('../extensions/aurabot/history-vault/existing-engine.mjs');const small=autoBenefit({beforeTokens:400000,savedTokens:20000,freshToCachedRatio:50,expectedReuse:128});assert.equal(small.allowed,false);assert.ok(small.paybackRequests>128);const large=autoBenefit({beforeTokens:500000,savedTokens:200000,freshToCachedRatio:50,expectedReuse:128});assert.equal(large.allowed,true);assert.equal(autoBenefit({beforeTokens:100000,savedTokens:0}).allowed,false);
});
test('automatic batching is disabled by its own switch and waits for completed turns without network calls',async()=>{
 const {maybeAutoTextPlan}=await import('../extensions/aurabot/history-vault/existing-engine.mjs'),folder=fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP,'auto-text-')),api={dataDir:n=>path.join(folder,n)},sourceEvents=fixtures(10),plan={kind:'verified-existing-engine-plan',scope,backupReceipt:{verified:true},ranges:[]};fs.writeFileSync(api.dataDir('context-governance-plan.json'),JSON.stringify(plan));let calls=0;const fetcher=async()=>{calls++;throw Error('unexpected network');};
 let r=await maybeAutoTextPlan(api,()=>({contextTextBatchEnabled:false}),{scope,sourceEvents,fetcher});assert.equal(r.held,'batch-switch-off');assert.equal(calls,0);
 r=await maybeAutoTextPlan(api,()=>({}),{scope,sourceEvents,fetcher,now});assert.equal(r.held,'initialized-batch-boundary');r=await maybeAutoTextPlan(api,()=>({}),{scope,sourceEvents,fetcher,now:now+3600000});assert.equal(r.held,'waiting-batch-boundary');assert.equal(calls,0);
});
