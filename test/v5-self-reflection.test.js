import {testRuntimeRoot} from '../scripts/lib/test-workspace.js';
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {backup} from 'node:sqlite';
import {V5Runtime} from '../core/v5-runtime.js';
import {selfReflectionWindow} from '../core/v5-self-reflection.js';
import {hostSelfActions} from '../adapters/aurabot/module/lib/host-self-actions.js';

function fixture(t){let now=Date.parse('2026-11-17T01:05:00+08:00'),on=true,calls=0,actions=0;const r=new V5Runtime({clock:()=>now}),scope=r.addScope({persona_id:'self-test',scope:'private:owner'}).id;t.after(()=>r.close());const source=r.ingest({scope,text:'合成日常：今天学到星云与恒星形成有关，想了解更多。',occurred_at:Date.parse('2026-11-16T18:00:00+08:00'),provenance:{speaker_id:'owner'},process:true});
 const client={model:'fixture',status:()=>({configured:true}),json:async()=>{calls++;return {value:{questions:[{question:'想看什么',answer:'想看看星云的科普',source_ids:[source.source_id]}],actions:[{type:'read',title:'读一篇星云科普',query:'星云 恒星形成 科普',source_ids:[source.source_id]}],lessons:[{text:'想继续了解恒星形成',source_ids:[source.source_id]}]}};}},execute=async()=>{actions++;return {status:'completed',observation:'合成工具回执：星云是星际气体和尘埃云。',tool_receipts:[{tool:'web',status:'result_observed'}]};};
 return {r,scope,source,options:{scope,client,execute,maintenance_complete:true,enabled:()=>on},setOn:value=>on=value,setTime:value=>now=value,counts:()=>({calls,actions})};}
test('night inquiry waits for completed maintenance and reuses its round before the next due time',async t=>{const f=fixture(t);assert.equal((await f.r.selfReflection.run({...f.options,maintenance_complete:false})).status,'deferred');assert.deepEqual(f.counts(),{calls:0,actions:0});const result=await f.r.selfReflection.run(f.options);assert.equal(result.status,'completed');const item=f.r.selfReflection.list({scope:f.scope}).items[0];assert.equal(item.day,'2026-11-16');assert.equal(item.actions[0].status,'completed');assert.ok(f.r.store.getSource(item.actions[0].source_id).provenance.kind==='self_learning_result');assert.equal((await f.r.selfReflection.run(f.options)).reused,true);assert.deepEqual(f.counts(),{calls:1,actions:1});});
test('master/feature off and daytime do not run model or actions',async t=>{const f=fixture(t);f.setOn(false);assert.equal((await f.r.selfReflection.run(f.options)).status,'deferred');f.setOn(true);f.setTime(Date.parse('2026-11-17T12:00:00+08:00'));assert.equal((await f.r.selfReflection.run(f.options)).status,'deferred');assert.deepEqual(f.counts(),{calls:0,actions:0});});
test('no observed tool result means no claim of reading completion or learning memory',async t=>{const f=fixture(t);await f.r.selfReflection.run({...f.options,execute:async()=>({status:'no_evidence',observation:'我想好了，没有实际打开资料',tool_receipts:[]})});const row=f.r.selfReflection.list({scope:f.scope}).items[0];assert.equal(row.status,'review_required');assert.equal(row.actions[0].memory_id,undefined);});
test('privacy erasure removes self reflection and dependent learning documents',async t=>{const f=fixture(t);await f.r.selfReflection.run(f.options);const action=f.r.selfReflection.list({scope:f.scope}).items[0].actions[0];f.r.eraseSources([f.source.source_id]);assert.equal(f.r.selfReflection.list({scope:f.scope}).items.length,0);assert.equal(f.r.store.getSource(action.source_id),null);});
test('turning off while the question request is in flight prevents actions',async t=>{const f=fixture(t),original=f.options.client.json;f.options.client.json=async(...a)=>{const result=await original(...a);f.setOn(false);return result;};assert.equal((await f.r.selfReflection.run(f.options)).status,'cancelled');assert.equal(f.counts().actions,0);});
test('self action requires read-only tool receipts and rejects external messages and write requests',async()=>{const listeners=new Map(),session={id:'owned'},api={id:'thinkstar-memory',config:()=>({}),core:{hub:{isOwnedSession:id=>id==='owned',chatOfSession:()=> 'system:ext-thinkstar-memory:one'}},dsh:{on:(n,f)=>{listeners.set(n,f);return()=>listeners.delete(n);}},think:async()=>{
 const pre=listeners.get('tools/pre-execute');assert.throws(()=>pre({name:'qq_send',callId:'x',agent:{session}},()=>{}),/只开放/);assert.throws(()=>pre({name:'fetch',arguments:'{"method":"POST"}',callId:'x',agent:{session}},()=>{}),/只开放/);pre({name:'web',arguments:{action:'search',query:'星云'},callId:'a',agent:{session}},()=>{});listeners.get('session/event')(session,{type:'tool/result',data:{callId:'a',message:{content:[{type:'text',text:'{"ok":true,"text":"public knowledge"}'}]}}});return '已阅读并记下要点';}};const runner=hostSelfActions(api,{active:()=>true}),result=await runner.execute({id:'a',type:'read',title:'星云阅读',query:'星云'});assert.equal(result.status,'completed');assert.equal(result.tool_receipts.length,1);assert.match(result.observation,/public knowledge/);runner.stop();assert.equal(listeners.size,0);});

const at=hhmm=>Date.parse('2026-11-17T'+hhmm+':00+08:00');
test('daily readiness waits for the current previous-day archive, including late-arriving material',async t=>{
 const f=fixture(t);assert.equal(f.r.selfReflection.dailyReady(f.scope),false);await f.r.archive.build({scope:f.scope,period:'2026-11-16'});assert.equal(f.r.selfReflection.dailyReady(f.scope),true);f.r.ingest({scope:f.scope,text:'合成迟到原话：刚刚补充昨天的重要约定。',occurred_at:Date.parse('2026-11-16T23:40:00+08:00'),process:true});assert.equal(f.r.selfReflection.dailyReady(f.scope),false);assert.equal((await f.r.selfReflection.run({...f.options,maintenance_complete:f.r.selfReflection.dailyReady(f.scope)})).status,'deferred');await f.r.archive.build({scope:f.scope,period:'2026-11-16'});assert.equal(f.r.selfReflection.dailyReady(f.scope),true);assert.deepEqual(f.counts(),{calls:0,actions:0});
});
test('self learning window is Beijing 01:00 inclusive to 05:00 exclusive',()=>{
 for(const [time,allowed]of [['00:59',false],['01:00',true],['04:59',true],['05:00',false],['23:00',false]])assert.equal(selfReflectionWindow(at(time)).allowed,allowed,time);
 assert.equal(selfReflectionWindow(at('02:00'),{self_start_hour:5,self_end_hour:1}).valid,false);
});
test('five independent rounds run twenty minutes apart, then the daily budget stops further calls',async t=>{
 const f=fixture(t),base=at('01:05');let calls=0;
 f.options.client.json=async(_system,payload)=>{calls++;return {value:{questions:[{question:'继续探索什么',answer:'根据上一轮继续',source_ids:[]}],actions:[{type:'read',title:'第'+payload.round+'个问题',query:'星云形成科普问题'+payload.round,source_ids:[]}]}};};
 for(let i=0;i<5;i++){
  f.setTime(base+i*20*60000);f.r.processJobs();const result=await f.r.selfReflection.run(f.options);assert.equal(result.status,'completed');const row=f.r.selfReflection.get(result.id);assert.equal(row.round,i+1);
  f.setTime(base+i*20*60000+19*60000+59000);f.r.processJobs();const blocked=await f.r.selfReflection.run(f.options);assert.ok(['waiting_interval','daily_limit'].includes(blocked.status));assert.equal(calls,i+1);
 }
 f.setTime(at('04:59'));f.r.processJobs();assert.equal((await f.r.selfReflection.run(f.options)).status,'daily_limit');assert.equal(calls,5);assert.equal(f.counts().actions,5);assert.equal(f.r.selfReflection.list({scope:f.scope}).items.length,5);
});
test('late consolidation starts one round, and the window end prevents compressed catch-up',async t=>{
 const f=fixture(t);f.setTime(at('04:50'));assert.equal((await f.r.selfReflection.run({...f.options,maintenance_complete:false})).status,'deferred');assert.equal((await f.r.selfReflection.run(f.options)).status,'completed');f.r.processJobs();f.setTime(at('04:59'));assert.equal((await f.r.selfReflection.run(f.options)).status,'window_full');f.setTime(at('05:00'));assert.equal((await f.r.selfReflection.run(f.options)).status,'outside_window');assert.deepEqual(f.counts(),{calls:1,actions:1});
});
test('restart retains completed round, interval and daily ledger without rerunning the first question',async t=>{
 const f=fixture(t);await f.r.selfReflection.run(f.options);f.r.processJobs();const root=testRuntimeRoot(fileURLToPath(new URL('../runtime-data/',import.meta.url)));fs.mkdirSync(root,{recursive:true});const folder=fs.mkdtempSync(path.join(root,'schedule-restart-'));let restarted;t.after(()=>{restarted?.close();if(!path.resolve(folder).startsWith(path.resolve(root)+path.sep))throw Error('Unsafe test path');fs.rmSync(folder,{recursive:true,force:true});});const file=path.join(folder,'memory.sqlite');await backup(f.r.store.db,file);
 let clock=at('01:24');restarted=new V5Runtime({file,clock:()=>clock});assert.equal((await restarted.selfReflection.run(f.options)).status,'waiting_interval');assert.equal(f.counts().calls,1);clock=at('01:25');const result=await restarted.selfReflection.run(f.options);assert.equal(result.status,'completed');assert.equal(restarted.selfReflection.get(result.id).round,2);assert.equal(f.counts().calls,2);
});
test('failure counts as an attempt and waits a full twenty minutes after finishing',async t=>{
 const f=fixture(t);f.options.client.json=async()=>{f.setTime(at('01:07'));throw Error('synthetic failure');};await assert.rejects(f.r.selfReflection.run(f.options),/synthetic/);f.setTime(at('01:26'));assert.equal(f.r.selfReflection.schedule(f.scope).status,'waiting_interval');f.setTime(at('01:27'));const plan=f.r.selfReflection.schedule(f.scope);assert.equal(plan.ready,true);assert.equal(plan.round,2);
});
test('suspension never starts several overdue rounds at once',async t=>{
 const f=fixture(t);await f.r.selfReflection.run(f.options);f.r.processJobs();f.setTime(at('03:00'));const next=await f.r.selfReflection.run(f.options);assert.equal(next.status,'completed');f.r.processJobs();assert.equal((await f.r.selfReflection.run(f.options)).status,'waiting_interval');assert.equal(f.counts().calls,2);
});
test('same-query proposals are recorded as skipped rather than read repeatedly',async t=>{
 const f=fixture(t);await f.r.selfReflection.run(f.options);f.r.processJobs();f.setTime(at('01:25'));const result=await f.r.selfReflection.run(f.options);assert.equal(f.r.selfReflection.get(result.id).actions[0].status,'skipped_duplicate');assert.equal(f.counts().actions,1);
});
test('a task crossing 05:00 loses permission for subsequent tools and cannot store a completed reading',async t=>{
 const f=fixture(t);f.setTime(at('04:59'));const result=await f.r.selfReflection.run({...f.options,execute:async(_action,opts)=>{f.setTime(at('05:00'));assert.equal(opts.active(),false);return {status:'completed',observation:'not accepted after deadline',tool_receipts:[]};}});assert.equal(result.status,'paused');const row=f.r.selfReflection.list({scope:f.scope}).items[0];assert.equal(row.status,'paused');assert.equal(row.finished_at,at('05:00'));assert.equal(row.actions[0].memory_id,undefined);
});

function historicalReading(f,id,{observation='✓',receipts,type='read',status='completed',extra={}}={}){
 return {id,type,status,title:'合成历史阅读 '+id,query:'恒星形成 科普',reason:'保留原始行动理由',observation:'保留原始模型总结',source_ids:[f.source.source_id],tool_receipts:receipts??[{tool:'web',status:'result_observed',observation}],...extra};
}
function historicalRound(f,id,actions,{status='completed',created=at('01:00')}={}){
 const row={id,scope:f.scope,day:'2026-11-16',created_at:created,finished_at:created+1000,status,round:1,source_refs:[f.source.source_id],
   questions:[{question:'合成原始问题',answer:'保留原始回答',source_ids:[f.source.source_id]}],lessons:[{text:'保留原始暂定认识',status:'tentative_self_reflection'}],actions};
 f.r.selfReflection.save(row);return row;
}
const durableOriginals=r=>({sources:r.store.sql('SELECT id,json,packed FROM sources ORDER BY id').all(),memories:r.store.sql('SELECT id,json FROM memories ORDER BY id').all(),versions:r.store.sql('SELECT id,revision,json FROM versions ORDER BY id,revision').all()});
const changeCount=r=>Number(r.store.sql('SELECT total_changes() n').get().n);

test('historical read review changes only completion labels and preserves questions, text, sources and memories',t=>{
 const f=fixture(t),learned=f.r.ingest({scope:f.scope,role:'document',text:'合成历史学习文档：原先的观察和总结必须完整保留。',provenance:{kind:'self_learning_result'},process:true});
 const bad=historicalReading(f,'old-read',{extra:{source_id:learned.source_id,memory_id:learned.memory_id}}),good=historicalReading(f,'real-read',{observation:'星云中的气体在引力作用下逐渐聚集形成恒星。'});
 const original=historicalRound(f,'history-mixed',[bad,good]),before=durableOriginals(f.r);
 const result=f.r.selfReflection.reviewReadEvidence();assert.equal(result.updated_rows,1);assert.equal(result.updated_actions,1);assert.equal(result.conflicts,0);
 const row=f.r.selfReflection.get(original.id),action=row.actions[0];assert.equal(row.status,'review_required');assert.equal(action.status,'no_evidence');
 assert.equal(action.evidence_review.previous_status,'completed');assert.equal(action.evidence_review.previous_parent_status,'completed');assert.match(action.evidence_review.reason,/原始内容与来源均保留/);
 const {status,evidence_review,...preserved}=action,{status:oldStatus,...expected}=bad;assert.deepEqual(preserved,expected);
 assert.deepEqual(row.actions[1],good);assert.deepEqual(row.questions,original.questions);assert.deepEqual(row.lessons,original.lessons);assert.deepEqual(row.source_refs,original.source_refs);
 assert.deepEqual(durableOriginals(f.r),before);assert.equal(f.r.dialogue.list({scope:f.scope,category:'learning'}).items.filter(item=>item.id==='self-reading-review:'+original.id).length,1);
 const changes=changeCount(f.r);assert.equal(f.r.selfReflection.reviewReadEvidence().updated_rows,0);assert.equal(changeCount(f.r),changes,'repeated review does not write even an audit');
});

test('historical read review recognizes only explicit empty, acknowledgement and business-failure receipts',t=>{
 const f=fixture(t),known=['',' \n ','✓','✔。','OK!','success','完成。','✗ 当前资料不可用','× 未读到','Error: synthetic failure','没成功：合成失败','未读取到正文','未读到公开资料','未完成本次阅读','{"ok":false,"message":"合成业务失败"}','{"read_evidence":false,"text":"只有占位"}'];
 for(const [index,observation] of known.entries())historicalRound(f,'known-'+index,[historicalReading(f,'action-'+index,{observation})],{created:at('01:00')+index});
 const result=f.r.selfReflection.reviewReadEvidence();assert.equal(result.updated_rows,known.length);
 for(let index=0;index<known.length;index++)assert.equal(f.r.selfReflection.get('known-'+index).actions[0].status,'no_evidence');
});

test('historical read review preserves normal reads, unknown payloads, practice, missing receipts and pending work',t=>{
 const f=fixture(t),samples=[
   historicalReading(f,'normal',{observation:'已取得可用的公开来源正文以及明确的研究结论。'}),
   historicalReading(f,'unknown-json',{observation:'{"ok":true}'}),
   historicalReading(f,'unknown-text',{observation:'legacy opaque output'}),
   historicalReading(f,'practice',{type:'practice'}),historicalReading(f,'note',{type:'note'}),
   historicalReading(f,'empty-receipts',{receipts:[]}),historicalReading(f,'missing-observation',{receipts:[{tool:'web',status:'result_observed'}]}),
   historicalReading(f,'failed',{status:'failed'}),
   historicalReading(f,'mixed-receipts',{receipts:[{tool:'web',status:'result_observed',observation:'✓'},{tool:'fetch',status:'result_observed',observation:'已读到恒星形成机制的公开来源全文。'}]}),
   historicalReading(f,'previous-review',{extra:{evidence_review:{version:99,reason:'保留未知版本审核'}}}),
 ];
 for(const action of samples)historicalRound(f,'preserve-'+action.id,[action]);
 const noReceipts=historicalReading(f,'no-receipts');delete noReceipts.tool_receipts;historicalRound(f,'preserve-no-receipts',[noReceipts]);
 const noId=historicalReading(f,'missing-id');delete noId.id;historicalRound(f,'preserve-missing-id',[noId]);historicalRound(f,'preserve-unknown-action',['opaque legacy action']);
 historicalRound(f,'preserve-paused',[historicalReading(f,'done-in-paused'),historicalReading(f,'pending',{status:'pending'})],{status:'paused'});
 const before=f.r.store.sql('SELECT id,json FROM self_reflections ORDER BY id').all(),changes=changeCount(f.r);
 assert.equal(f.r.selfReflection.reviewReadEvidence().updated_rows,0);assert.equal(changeCount(f.r),changes);assert.deepEqual(f.r.store.sql('SELECT id,json FROM self_reflections ORDER BY id').all(),before);
});

test('historical read review is bounded, retains prior review-required status and defers while busy',t=>{
 const f=fixture(t);historicalRound(f,'older',[historicalReading(f,'older-action')],{created:at('01:00'),status:'review_required'});historicalRound(f,'newer',[historicalReading(f,'newer-action')],{created:at('01:01')});
 f.r.selfReflection.busy=true;const before=changeCount(f.r);assert.equal(f.r.selfReflection.reviewReadEvidence().status,'deferred');assert.equal(changeCount(f.r),before);f.r.selfReflection.busy=false;
 const first=f.r.selfReflection.reviewReadEvidence({limit:1});assert.equal(first.scanned,1);assert.equal(first.updated_rows,1);assert.equal(first.has_more,true);assert.equal(f.r.selfReflection.get('older').actions[0].status,'completed');
 const second=f.r.selfReflection.reviewReadEvidence({limit:1});assert.equal(second.updated_rows,1);assert.equal(second.has_more,false);assert.equal(f.r.selfReflection.get('older').actions[0].evidence_review.previous_parent_status,'review_required');
});

test('historical read review CAS preserves a parallel edit and emits no false repair audit',t=>{
 const f=fixture(t),original=historicalRound(f,'cas-conflict',[historicalReading(f,'cas-action')]),tx=f.r.store.tx.bind(f.r.store);let injected=false;
 f.r.store.tx=callback=>{if(!injected){injected=true;f.r.selfReflection.save({...original,parallel_edit:'保留并行更新'});}return tx(callback);};
 const result=f.r.selfReflection.reviewReadEvidence();assert.equal(result.updated_rows,0);assert.equal(result.conflicts,1);
 const row=f.r.selfReflection.get(original.id);assert.equal(row.parallel_edit,'保留并行更新');assert.equal(row.actions[0].status,'completed');assert.equal(row.actions[0].evidence_review,undefined);
 assert.equal(f.r.dialogue.list({scope:f.scope,category:'learning'}).items.filter(item=>item.id==='self-reading-review:'+original.id).length,0);
});

test('historical read label changes and their audit roll back together on storage failure',t=>{
 const f=fixture(t),original=historicalRound(f,'rollback-review',[historicalReading(f,'rollback-action')]),activity=f.r.dialogue.activity.bind(f.r.dialogue);
 f.r.dialogue.activity=()=>{throw Error('synthetic audit write failure');};
 assert.throws(()=>f.r.selfReflection.reviewReadEvidence(),/synthetic audit/);f.r.dialogue.activity=activity;
 assert.deepEqual(f.r.selfReflection.get(original.id),original);assert.equal(f.r.selfReflection.reviewReadEvidence().updated_rows,1);
});

function planMaterialAction(f,{type='note',sourceIds=[f.source.source_id],query='整理已提供的日常资料',questions,lessons=[]}={}){
 f.options.client.json=async()=>({value:{questions:questions??[{question:'这一天有什么依据',answer:'只依据提供的局部资料整理',source_ids:sourceIds}],actions:[{type,title:'合成有依据的行动',query,source_ids:sourceIds}],lessons}});
}
const citedNote=material=>({status:'completed',observation:'合成笔记[资料1]，这些只是当前提供的部分资料。',based_on_sources:[material.sources[0].id],tool_receipts:[]});

test('note execution receives explicit previous-day partial material and records model citations separately from facts',async t=>{
 const f=fixture(t);planMaterialAction(f,{lessons:[{text:'合成暂定认识',source_ids:[f.source.source_id]}]});let received;
 const result=await f.r.selfReflection.run({...f.options,execute:async(action,options)=>{received={action:structuredClone(action),material:structuredClone(options.material)};return citedNote(options.material);}});
 assert.equal(result.status,'completed');assert.equal(received.material.day,'2026-11-16');assert.equal(received.material.scope,f.scope);assert.equal(received.material.is_partial,true);
 assert.deepEqual(received.material.sources,[{id:f.source.source_id,text:f.r.store.getSource(f.source.source_id).text,occurred_at:Date.parse('2026-11-16T18:00:00+08:00')}]);
 assert.equal(received.material.questions[0].status,'tentative_self_reflection');assert.equal(received.material.lessons[0].status,'tentative_self_reflection');
 const action=f.r.selfReflection.get(result.id).actions[0];assert.equal(action.material_version,1);assert.deepEqual(action.provided_source_ids,[f.source.source_id]);assert.deepEqual(action.based_on_sources,[f.source.source_id]);assert.equal(action.based_on_sources_kind,'model_cited_sources');
 assert.deepEqual(f.r.store.getSource(action.source_id).provenance.model_cited_sources,[f.source.source_id]);assert.equal(f.r.store.getSource(action.source_id).provenance.factual_status,'generated_practice_note');
});

test('action material prioritizes action references and bounds sources, text and tentative planning output',async t=>{
 const f=fixture(t),sources=[];
 for(let i=0;i<12;i++)sources.push(f.r.ingest({scope:f.scope,text:'合成私密标记'+i+'：'+'局部来源资料'.repeat(90),occurred_at:Date.parse('2026-11-16T18:00:00+08:00')+i*60000,process:true}));
 const primary=sources[0].source_id,questions=Array.from({length:6},(_,i)=>({question:'合成问题'+i,answer:'暂定回答'.repeat(120),source_ids:[primary]})),lessons=Array.from({length:3},(_,i)=>({text:'合成认识'+i+'局部'.repeat(150),source_ids:[primary]}));
 planMaterialAction(f,{sourceIds:[primary],query:'整理局部原始资料',questions,lessons});let material;
 await f.r.selfReflection.run({...f.options,execute:async(action,options)=>{material=options.material;assert.equal(action.query,'整理局部原始资料');assert.doesNotMatch(action.query,/合成私密标记/);return citedNote(material);}});
 assert.equal(material.sources.length,8);assert.equal(material.sources[0].id,primary);assert.ok(material.sources.every(source=>source.text.length<=350));assert.equal(material.questions.length,3);assert.ok(material.questions.every(q=>q.answer.length<=350));assert.equal(material.lessons.length,2);assert.ok(material.lessons.every(lesson=>lesson.text.length<=220));assert.equal(material.is_partial,true);
});

test('material date checks keep Beijing previous-day boundaries and exclude changed day, role and foreign scope',async t=>{
 const f=fixture(t),from=Date.parse('2026-11-16T00:00:00+08:00'),inside=f.r.ingest({scope:f.scope,text:'合成日界线当天零点资料',occurred_at:from,process:true}),last=f.r.ingest({scope:f.scope,text:'合成日界线最后一毫秒资料',occurred_at:from+86400000-1,process:true}),foreignScope=f.r.addScope({persona_id:'foreign',scope:'private:other'}).id;
 const changed=f.r.ingest({scope:f.scope,text:'不应交出的异域资料',occurred_at:from+1000,process:true}),outside=f.r.ingest({scope:f.scope,text:'不应交出的跨期资料',occurred_at:from+2000,process:true});
 planMaterialAction(f,{sourceIds:[inside.source_id,last.source_id,changed.source_id,outside.source_id,f.source.source_id]});const question=f.options.client.json;
 f.options.client.json=async(...args)=>{const result=await question(...args);f.r.store.updateSourceMetadata(changed.source_id,{scope:foreignScope});f.r.store.updateSourceMetadata(outside.source_id,{occurred_at:from+86400000});f.r.store.updateSourceMetadata(f.source.source_id,{role:'assistant'});return result;};let material;
 await f.r.selfReflection.run({...f.options,execute:async(_action,options)=>{material=options.material;return citedNote(material);}});
 assert.deepEqual(material.sources.map(source=>source.id),[inside.source_id,last.source_id]);assert.ok(material.sources.every(source=>source.occurred_at>=from&&source.occurred_at<from+86400000));
});

test('missing current authorized note material does not start execution or create a learning memory',async t=>{
 const f=fixture(t);planMaterialAction(f);const question=f.options.client.json;f.options.client.json=async(...args)=>{const result=await question(...args);f.r.store.updateSourceMetadata(f.source.source_id,{role:'assistant'});return result;};let calls=0;
 const before=f.r.store.sql('SELECT count(*) n FROM sources').get().n,result=await f.r.selfReflection.run({...f.options,execute:async()=>{calls++;return {status:'completed',observation:'不应执行的模板'};}}),action=f.r.selfReflection.get(result.id).actions[0];
 assert.equal(result.status,'review_required');assert.equal(calls,0);assert.equal(action.status,'no_evidence');assert.equal(action.memory_id,undefined);assert.equal(action.started_at,undefined);assert.deepEqual(action.provided_source_ids,[]);assert.match(action.observation,/未启动笔记整理/);assert.equal(f.r.store.sql('SELECT count(*) n FROM sources').get().n,before);
});

test('note completion requires an authorized material citation and discards unrelated claimed source IDs',async t=>{
 const f=fixture(t);planMaterialAction(f);const result=await f.r.selfReflection.run({...f.options,execute:async()=>({status:'completed',observation:'无依据的模板',based_on_sources:['foreign-source'],tool_receipts:[]})}),action=f.r.selfReflection.get(result.id).actions[0];
 assert.equal(result.status,'review_required');assert.equal(action.status,'no_evidence');assert.deepEqual(action.based_on_sources,[]);assert.equal(action.memory_id,undefined);
});

test('retired or privacy-erased planning sources are never handed to an action executor',async t=>{
 for(const mode of ['retired','erased']){
  const f=fixture(t);planMaterialAction(f);const question=f.options.client.json,groupLifecycle=f.r.groupLifecycle.bind(f.r);let executions=0;
  f.options.client.json=async(...args)=>{const result=await question(...args);if(mode==='erased')f.r.eraseSources([f.source.source_id]);else f.r.groupLifecycle=(...options)=>{const lifecycle=groupLifecycle(...options),retired=lifecycle.retiredSource.bind(lifecycle);lifecycle.retiredSource=id=>id===f.source.source_id||retired(id);return lifecycle;};return result;};
  const result=await f.r.selfReflection.run({...f.options,execute:async()=>{executions++;return {status:'completed',observation:'不可发生'};}});assert.equal(result.status,'cancelled',mode);assert.equal(executions,0,mode);
 }
});

test('read execution retains its public query and may proceed without personal material',async t=>{
 const f=fixture(t);planMaterialAction(f,{type:'read',query:'星云形成 公开科普'});const question=f.options.client.json;f.options.client.json=async(...args)=>{const result=await question(...args);f.r.store.updateSourceMetadata(f.source.source_id,{role:'assistant'});return result;};let executed=false;
 await f.r.selfReflection.run({...f.options,execute:async(action,options)=>{executed=true;assert.equal(action.query,'星云形成 公开科普');assert.equal(options.material,undefined);assert.equal(Object.hasOwn(options,'material'),false);return {status:'no_evidence',observation:'合成公开阅读未取到结果',tool_receipts:[]};}});assert.equal(executed,true);
});

test('public read executor receives no private material even when valid private sources exist',async t=>{
 const f=fixture(t),privateText='合成私密标记：我向主人承诺的私聊细节，不得进入公开阅读执行器。';f.r.store.updateSourceMetadata(f.source.source_id,{text:privateText});planMaterialAction(f,{type:'read',query:'星云形成 公开科普'});let executed=false;
 const result=await f.r.selfReflection.run({...f.options,execute:async(action,options)=>{executed=true;assert.equal(f.r.store.getSource(f.source.source_id).role,'user');assert.equal(action.query,'星云形成 公开科普');assert.equal(Object.hasOwn(options,'material'),false);assert.equal(options.material,undefined);assert.doesNotMatch(JSON.stringify(options),/合成私密标记/);return {status:'no_evidence',observation:'合成公开资料尚未取得',tool_receipts:[]};}});
 assert.equal(executed,true);const action=f.r.selfReflection.get(result.id).actions[0];assert.deepEqual(action.provided_source_ids,[]);assert.equal(action.material_version,undefined);
});

test('restart and resume rebuild material from current allowed sources rather than saved source text',async t=>{
 const f=fixture(t),id=f.r.selfReflection.schedule(f.scope).id;historicalRound(f,id,[historicalReading(f,id+':action:0',{type:'note',status:'pending',extra:{source_ids:[f.source.source_id]}})],{status:'paused'});
 const root=testRuntimeRoot(fileURLToPath(new URL('../runtime-data/',import.meta.url))),folder=fs.mkdtempSync(path.join(root,'material-resume-')),file=path.join(folder,'memory.sqlite');await backup(f.r.store.db,file);
 const restarted=new V5Runtime({file,clock:()=>at('01:05')});t.after(()=>restarted.close());restarted.store.updateSourceMetadata(f.source.source_id,{text:'合成恢复后重新取到的当前原文'});let material,questionCalls=0;
 const result=await restarted.selfReflection.run({...f.options,client:{...f.options.client,json:async()=>{questionCalls++;throw Error('resume must not replan');}},execute:async(_action,options)=>{material=options.material;return citedNote(material);}});
 assert.equal(result.status,'completed');assert.equal(questionCalls,0);assert.equal(material.day,'2026-11-16');assert.equal(material.sources[0].text,'合成恢复后重新取到的当前原文');assert.equal(restarted.selfReflection.get(id).actions[0].provided_source_ids[0],f.source.source_id);
});

const missingNoteText='想看的 today 记录没拿到：world_now 返回「此自主学习回合只开放查询与阅读」，working_directory 同样被拦。所以今天聊了什么、答应了谁什么、有没有待办，我手上没有依据，不编。\n今天的对话细节一条都没有，所以「待办候选」这栏现在是空的，只有模板。\n结论：模板可用，内容缺料，等能读记录时再填。';
test('historical note review corrects explicit missing-material template completion while preserving every original',t=>{
 const f=fixture(t),document=f.r.ingest({scope:f.scope,role:'document',text:'合成旧笔记原文：'+missingNoteText,process:true}),note=historicalReading(f,'old-note',{type:'note',extra:{observation:missingNoteText,memory_id:document.memory_id,source_id:document.source_id}}),original=historicalRound(f,'old-note-round',[note]),before=durableOriginals(f.r);
 const result=f.r.selfReflection.reviewMissingNoteEvidence();assert.equal(result.updated_rows,1);assert.equal(result.updated_actions,1);
 const row=f.r.selfReflection.get(original.id),action=row.actions[0];assert.equal(row.status,'review_required');assert.equal(action.status,'no_evidence');assert.equal(action.evidence_review.previous_status,'completed');assert.equal(action.evidence_review.previous_parent_status,'completed');
 const {status,evidence_review,...preserved}=action,{status:oldStatus,...expected}=note;assert.deepEqual(preserved,expected);assert.deepEqual(row.questions,original.questions);assert.deepEqual(row.lessons,original.lessons);assert.deepEqual(durableOriginals(f.r),before);
 const changes=changeCount(f.r);assert.equal(f.r.selfReflection.reviewMissingNoteEvidence().updated_rows,0);assert.equal(changeCount(f.r),changes);
});

test('historical note review requires both signals and skips normal, modern, unknown and unfinished records',t=>{
 const f=fixture(t),cases=[
   historicalReading(f,'normal-note',{type:'note',extra:{observation:'这是根据合成资料整理的笔记，没有旧版本引用字段。'}}),
   historicalReading(f,'only-missing',{type:'note',extra:{observation:'今天记录没拿到，但已有公开来源的整理结果。'}}),
   historicalReading(f,'only-template',{type:'note',extra:{observation:'只有模板，这本身就是本轮要求产出的可复用表格。'}}),
   historicalReading(f,'negated-template',{type:'note',extra:{observation:'今天记录没拿到，不是只有模板，而是有另外取得的资料。'}}),
   historicalReading(f,'new-provided',{type:'note',extra:{observation:missingNoteText,provided_source_ids:[]}}),
   historicalReading(f,'new-based',{type:'note',extra:{observation:missingNoteText,based_on_sources:[]}}),
   historicalReading(f,'new-version',{type:'note',extra:{observation:missingNoteText,material_version:1}}),
   historicalReading(f,'practice-template',{type:'practice',extra:{observation:missingNoteText}}),
   historicalReading(f,'pending-note',{type:'note',status:'pending',extra:{observation:missingNoteText}}),
 ];for(const note of cases)historicalRound(f,'preserve-'+note.id,[note]);historicalRound(f,'preserve-paused-note',[historicalReading(f,'paused-note',{type:'note',extra:{observation:missingNoteText}})],{status:'paused'});
 const before=f.r.store.sql('SELECT id,json FROM self_reflections ORDER BY id').all(),changes=changeCount(f.r);assert.equal(f.r.selfReflection.reviewMissingNoteEvidence().updated_rows,0);assert.equal(changeCount(f.r),changes);assert.deepEqual(f.r.store.sql('SELECT id,json FROM self_reflections ORDER BY id').all(),before);
});

test('historical note review is bounded, defers while busy and preserves concurrent edits with CAS',t=>{
 const f=fixture(t);for(let i=0;i<2;i++)historicalRound(f,'bounded-note-'+i,[historicalReading(f,'bounded-action-'+i,{type:'note',extra:{observation:missingNoteText}})],{created:at('01:00')+i});
 f.r.selfReflection.busy=true;const before=changeCount(f.r);assert.equal(f.r.selfReflection.reviewMissingNoteEvidence().status,'deferred');assert.equal(changeCount(f.r),before);f.r.selfReflection.busy=false;
 const first=f.r.selfReflection.reviewMissingNoteEvidence({limit:1});assert.equal(first.scanned,1);assert.equal(first.updated_rows,1);assert.equal(first.has_more,true);
 const original=f.r.selfReflection.get('bounded-note-0'),tx=f.r.store.tx.bind(f.r.store);f.r.store.tx=callback=>{f.r.selfReflection.save({...original,parallel_edit:'保留并行更新'});return tx(callback);};
 const conflict=f.r.selfReflection.reviewMissingNoteEvidence({limit:1});assert.equal(conflict.conflicts,1);assert.equal(conflict.updated_rows,0);assert.equal(f.r.selfReflection.get(original.id).parallel_edit,'保留并行更新');assert.equal(f.r.selfReflection.get(original.id).actions[0].status,'completed');
});

test('historical note review rolls label changes back if its audit cannot be stored',t=>{
 const f=fixture(t),original=historicalRound(f,'rollback-note-review',[historicalReading(f,'rollback-note-action',{type:'note',extra:{observation:missingNoteText}})]),activity=f.r.dialogue.activity.bind(f.r.dialogue);
 f.r.dialogue.activity=()=>{throw Error('synthetic note audit failure');};assert.throws(()=>f.r.selfReflection.reviewMissingNoteEvidence(),/synthetic note audit/);f.r.dialogue.activity=activity;
 assert.deepEqual(f.r.selfReflection.get(original.id),original);assert.equal(f.r.selfReflection.reviewMissingNoteEvidence().updated_rows,1);
});
