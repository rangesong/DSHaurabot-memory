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
