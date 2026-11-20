import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdtempSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {V5Runtime} from '../core/v5-runtime.js';
import {V5ModelService} from '../core/v5-model-service.js';
import {DAY,HANDOFF} from '../core/v5-config.js';
import {testRuntimeRoot} from '../scripts/lib/test-workspace.js';

const START=Date.parse('2026-11-15T02:10:00+08:00');
const group={persona_id:'fixture:alpha',scope:'group:42'};
const owner={persona_id:'fixture:alpha',scope:'private:1'};
const enabled=(r,values={})=>r.updateConfig({region:'W5',values:{group_policy_enabled:1,...values},expected_version:r.configVersion});
function fixture(t,{disk=false}={}){
  let now=START;
  const clock=()=>now,file=disk?join(mkdtempSync(join(testRuntimeRoot(null),'g-')),'memory.sqlite'):':memory:';
  let r=new V5Runtime({file,clock});
  t.after(()=>r.close());
  const scope=r.addScope(group).id;
  const add=(text,options={})=>r.ingest({scope,text,occurred_at:START,process:true,...options});
  return {get r(){return r;},scope,add,at:value=>{now=value;},restart:()=>{r.close();r=new V5Runtime({file,clock});}};
}
const defaultsText='aurora-note 正在讨论星图。'+('无关景物细节 EXTRA-OLD-MIDDLE。'.repeat(15))+'观测在北侧结束。';

test('group uses elapsed source time at all four boundaries, independent of visits, strength and configuration',t=>{
  const f=fixture(t),{r,scope,add,at}=f;
  const ordinary=add(defaultsText),low=add('收到');
  assert.equal(r.config.W5.group_policy_enabled,0);
  enabled(r,{ordinary_half_life_days:365,low_value_recovery:1});
  r.deepen({scope,id:low.memory_id,reason:'synthetic browsing and strength check'});
  for(const [days,before,after,lowAfter] of [[1,'recent','related','related'],[2,'related','trace','trace'],[3,'trace','trace','expired'],[4,'trace','expired','expired']]){
    at(START+DAY*days-1);
    assert.equal(r.groupLifecycle().resolve(r.memory(ordinary.memory_id)).phase,before);
    at(START+DAY*days);
    const policy=r.groupLifecycle();
    assert.equal(policy.resolve(r.memory(ordinary.memory_id)).phase,after);
    assert.equal(policy.resolve(r.memory(low.memory_id)).phase,lowAfter);
    assert.equal(policy.resolve(r.memory(ordinary.memory_id)).eligible,days<4);
    at(START+DAY*days+1);
    assert.equal(r.groupLifecycle().resolve(r.memory(ordinary.memory_id)).phase,after);
  }
  const exact=r.query({scope,query:ordinary.memory_id,on_demand:true});
  assert.equal(exact.context[0].text,defaultsText);
  assert.equal(r.detail({scope,id:ordinary.memory_id}).source_page.sources[0].text,defaultsText);
  assert.equal(r.memory(low.memory_id).used_count,0);
});

test('automatic paths block lexical, semantic IDs, associations, original backtrace, catalog and continuity',t=>{
  const f=fixture(t),{r,scope,add,at}=f;
  const retired=add(defaultsText,{topic:'cosmic'}),low=add('收到'),protectedRow=add('记住 aurora-note 的重要约定。');
  at(START+DAY*2+600);
  enabled(r);
  const trace=r.query({scope,query:'aurora-note',semantic_ids:[retired.memory_id]});
  const entry=trace.context.find(item=>item.source_refs.includes(retired.source_id));
  assert.equal(entry?.precision,'gist_with_evidence');
  assert.ok(entry.text.length<defaultsText.length);
  assert.equal(entry.lifecycle_phase,'trace');
  assert.ok(!trace.evidence_backtrace.some(link=>link.id===retired.memory_id));
  at(START+DAY*3);
  assert.ok(r.query({scope,query:'收到',semantic_ids:[low.memory_id]}).context.every(row=>!row.source_refs.includes(low.source_id)));
  at(START+DAY*4);
  const recent=add('aurora-note 新一轮讨论',{occurred_at:START+DAY*4,topic:'cosmic'});
  r.store.relation({id:'fixture-link',scope,from_id:recent.memory_id,to_id:retired.memory_id,type:'related',strength:1,source_refs:[]});
  const catalog_id=r.store.catalogs(scope).find(c=>c.refs.includes(retired.memory_id)).id;
  for(const options of [{query:'aurora-note',semantic_ids:[retired.memory_id]},{query:'继续刚才'},{query:'',catalog_id},{query:retired.memory_id}]){
    const result=r.query({scope,...options});
    assert.ok(result.candidates.every(row=>row.id!==retired.memory_id));
    assert.ok(result.context.every(row=>!row.source_refs.includes(retired.source_id)&&!row.text.includes('EXTRA-OLD-MIDDLE')));
  }
  assert.ok(r.query({scope,query:'aurora-note'}).context.some(row=>row.source_refs.includes(protectedRow.source_id)));
  assert.equal(r.archive.read({scope,keyword:'EXTRA-OLD-MIDDLE'}).items[0].text,defaultsText);
});

test('protection, explicit withdrawal, unverified time, and multi-source corrections preserve their distinctions',t=>{
  const f=fixture(t),{r,scope,add,at}=f;
  const required=add('独立证据 relay-old。');
  r.derive(r.memory(required.memory_id),{id:'required',kind:'claim',label:'证据',body:'经核对准确的约定',protection:'P1',attributes:{}});
  const intent=add('约定明天处理保留事项。');
  const old=add('violet-room 原提议。',{topic:'violet'});
  at(START+DAY*5);
  const newer=add('violet-room 补充新地点。',{topic:'violet',occurred_at:START+DAY*5});
  const fallback=add('首次接收时间试验',{occurred_at:null});
  const future=add('异常将来时间试验',{occurred_at:START+DAY*20});
  const pending=add('等待交接的普通资料',{process:false});
  enabled(r);
  const policy=r.groupLifecycle();
  assert.equal(policy.resolve(r.memory(required.memory_id)).reason,'protected_source');
  assert.equal(policy.resolve(r.memory('intent:'+intent.memory_id)).reason,'protected_memory');
  assert.equal(policy.resolve(r.memory(pending.memory_id)).reason,'handoff_pending');
  assert.deepEqual(policy.resolve(r.memory(fallback.memory_id)).fallback_reasons,['missing_original_time']);
  assert.deepEqual(policy.resolve(r.memory(future.memory_id)).fallback_reasons,['untrusted_original_time']);
  const bundle=r.store.all(scope).find(m=>m.kind==='experience'&&m.source_refs.includes(old.source_id)&&m.source_refs.includes(newer.source_id));
  assert.ok(bundle);
  const revised=r.query({scope,query:bundle.id});
  assert.ok(revised.context.flatMap(row=>row.source_refs).includes(newer.source_id));
  assert.ok(revised.context.every(row=>!row.text.includes('原提议')));
  at(START+DAY*21);
  assert.deepEqual(r.groupLifecycle().resolve(r.memory(future.memory_id)).fallback_reasons,['untrusted_original_time']);
  r.eraseSources([old.source_id],{reason:'synthetic explicit privacy deletion'});
  enabled(r,{group_policy_enabled:0});
  assert.ok(!r.query({scope,query:old.memory_id,on_demand:true}).context.length);
  assert.equal(r.store.getSource(old.source_id),null);
});

test('bounded no-loss archive, rollback, stale plans and transactional save survive restart',t=>{
  const f=fixture(t,{disk:true}),{scope,add,at}=f;
  const first=add(defaultsText),second=add('第二条独立资料');
  at(START+DAY*2+100);
  let {r}=f;
  enabled(r,{keep_raw_archive:0,batch_size:1});
  const plan=r.retentionPlan({scope});
  assert.equal(plan.items.filter(i=>i.action==='group_archive').length,1);
  const revision=r.configVersion;
  assert.throws(()=>enabled(r,{group_trace_after_days:2.5}));
  assert.throws(()=>enabled(r,{group_recent_days:3}));
  assert.equal(r.configVersion,revision);
  const setMeta=r.store.setMeta.bind(r.store);
  r.store.setMeta=(key,value)=>{if(key==='config_version')throw Error('simulated write failure');return setMeta(key,value);};
  assert.throws(()=>enabled(r,{group_recent_days:2}),/simulated write failure/);
  r.store.setMeta=setMeta;
  assert.equal(r.configVersion,revision);
  assert.equal(r.store.meta('effective_config').W5.group_recent_days,1);
  enabled(r,{group_recent_days:2});
  assert.throws(()=>r.applyRetention({plan_id:plan.id}),{code:'REVISION_CONFLICT'});
  const next=r.retentionPlan({scope}),candidate=r.memory(next.items[0].id);
  candidate.attributes.model_processing={synthetic:true};
  r.store.putMemory(candidate,null,{history:false});
  assert.throws(()=>r.applyRetention({plan_id:next.id}),{code:'REVISION_CONFLICT'});
  delete candidate.attributes.model_processing;
  r.store.putMemory(candidate,null,{history:false});
  const storagePlan=r.retentionPlan({scope});
  r.applyRetention({plan_id:storagePlan.id});
  assert.ok(r.applyRetention({plan_id:storagePlan.id}).replayed);
  for(const item of r.retentionPlan({scope}).items)assert.notEqual(item.id,candidate.id);
  const cached=r.memory(candidate.id).attributes.group_trace;
  assert.ok(cached.fingerprint);
  f.restart();
  r=f.r;
  assert.deepEqual(r.memory(candidate.id).attributes.group_trace,cached);
  assert.ok(r.store.getSource(first.source_id));
  assert.ok(r.store.getSource(second.source_id));
  assert.equal(r.memory(candidate.id).handoff,HANDOFF.at(-1));
  assert.equal(r.groupLifecycleStatus(scope).pending,1);
  at(START+4*DAY);
  assert.equal(r.groupLifecycle().resolve(r.memory(first.memory_id)).eligible,false);
  enabled(r,{group_policy_enabled:0});
  assert.equal(r.query({scope,query:first.memory_id}).context[0].text,defaultsText);
});

test('the panel model client receives the filtered working history and evidence with no extra calls',async t=>{
  const f=fixture(t),{r,scope,at,add}=f;
  const expired=add(defaultsText),kept=add('记住 aurora-note 受保护的书面说明。');
  const other=r.addScope(owner).id;
  add('aurora-note 私聊精确资料。',{scope:other});
  const own=r.addScope({persona_id:'fixture:alpha',scope:'self:events'}).id;
  const personal=add('aurora-note 自身经历',{scope:own});
  const privateBefore=r.query({scope:other,query:'aurora-note'}).context;
  at(START+DAY*5);
  enabled(r);
  const packets=[];
  const client={model:'synthetic',json:async(_instruction,input)=>{packets.push(input);return {value:{reply:'已核对。',used_memory_ids:[]},usage:{},model:'synthetic'};}};
  const service=new V5ModelService(r,{client});
  await service.chat({scope,query:'之前 aurora-note',semantic_retrieval:true});
  assert.equal(packets.length,1);
  const packet=packets[0],serialized=JSON.stringify(packet);
  assert.ok(!serialized.includes(expired.source_id));
  assert.ok(!serialized.includes('EXTRA-OLD-MIDDLE'));
  assert.ok(serialized.includes(kept.source_id));
  assert.deepEqual(r.query({scope:other,query:'aurora-note'}).context,privateBefore);
  assert.equal(r.groupLifecycle().resolve(r.memory(personal.memory_id)).phase,'inherited');
});

test('explicitly protected or corrected experiences remain protected, including source dependencies',t=>{
  const f=fixture(t),{r,scope,add,at}=f;
  const a=add('bundle-blue 前半段',{topic:'bundle-blue'}),b=add('bundle-blue 后半段',{topic:'bundle-blue'});
  const bundle=r.store.all(scope).find(m=>m.kind==='experience'&&m.source_refs.includes(a.source_id)&&m.source_refs.includes(b.source_id));
  bundle.protection='P0';bundle.protection_reason='explicit operator protection';r.store.putMemory(bundle);
  at(START+8*DAY);enabled(r);
  assert.equal(r.groupLifecycle().resolve(bundle).reason,'protected_memory');
  assert.equal(r.groupLifecycle().resolve(r.memory(a.memory_id)).reason,'protected_source');
  assert.ok(r.query({scope,query:'bundle-blue'}).context.some(item=>item.source_refs.includes(a.source_id)));
  r.revise({scope,id:bundle.id,expected_revision:bundle.revision,text:'bundle-blue 已人工更正的重要经历',reason:'explicit correction'});
  assert.equal(r.groupLifecycle().resolve(r.memory(bundle.id)).reason,'protected_memory');
  assert.equal(r.groupLifecycle().resolve(r.memory(a.memory_id)).reason,'protected_source','historical protected revisions still own their exact evidence');
  assert.ok(!r.retentionPlan({scope}).items.some(item=>item.id===a.memory_id&&item.action==='group_trash'));
});

test('source scope violations cannot be bypassed by P0 or pending protection',t=>{
  const f=fixture(t),{r,scope,add,at}=f,other=r.addScope({...group,scope:'group:other'}).id;
  const own=add('source-boundary own'),foreign=add('source-boundary foreign',{scope:other});
  const broken=r.memory(own.memory_id);broken.source_refs=[foreign.source_id];broken.protection='P0';broken.handoff=HANDOFF[0];r.store.putMemory(broken);
  at(START+5*DAY);enabled(r);
  assert.equal(r.groupLifecycle().resolve(broken).reason,'source_scope_mismatch');
  assert.equal(r.groupLifecycle().resolve(broken).eligible,false);
  assert.ok(!r.query({scope,query:broken.id}).context.length);
});

test('ordinary traffic reuses the protected-source view and a rollback invalidates uncommitted protection',t=>{
  const f=fixture(t),{r,scope,add,at}=f,receipt=add('cache-violet 普通资料');
  at(START+6*DAY);enabled(r);
  const original=r.protectedSources.bind(r);let reads=0;
  r.protectedSources=(...args)=>{reads++;return original(...args);};
  assert.equal(r.groupLifecycle().resolve(r.memory(receipt.memory_id)).phase,'expired');
  const baseline=reads;
  for(let i=0;i<5;i++)add('cache ordinary traffic '+i,{occurred_at:START+6*DAY});
  r.groupLifecycle().resolve(r.memory(receipt.memory_id));assert.equal(reads,baseline);
  assert.throws(()=>r.store.tx(()=>{
    r.derive(r.memory(receipt.memory_id),{id:'temporary-protection',kind:'claim',body:'temporary',label:'temporary',protection:'P1',attributes:{}});
    assert.equal(r.groupLifecycle().resolve(r.memory(receipt.memory_id)).reason,'protected_source');
    throw Error('synthetic transaction rollback');
  }),/synthetic transaction/);
  assert.equal(r.store.getMemory('temporary-protection'),null);
  assert.equal(r.groupLifecycle().resolve(r.memory(receipt.memory_id)).phase,'expired');
});

test('nightly group archive updates trace presentation without deleting sources, and repeated runs do no work',t=>{
  const f=fixture(t,{disk:true}),{r,scope,add,at}=f,item=add(defaultsText);
  at(START+2*DAY);enabled(r,{batch_size:1});
  const first=r.maintenance();assert.ok(first.items.some(row=>row.action==='group_archive'));
  const memory=r.memory(item.memory_id);
  assert.equal(memory.layer,'faint');assert.equal(memory.storage,'lossless_cold');assert.equal(memory.attributes.group_lifecycle.phase,'trace');
  assert.equal(r.graph({scope}).nodes.find(node=>node.id===item.memory_id).layer,'faint');
  assert.equal(r.body(memory),defaultsText);assert.equal(r.store.getSource(item.source_id).text,defaultsText);
  assert.equal(r.maintenance().items.length,0);
  // An unrelated config version does not regenerate every group's existing digest.
  r.updateConfig({region:'W4',values:{detail_level:.6},expected_version:r.configVersion});
  assert.equal(r.retentionPlan({scope}).items.length,0);
  at(START+4*DAY);r.maintenance();
  assert.equal(r.memory(item.memory_id).storage,'trash_only');
  assert.equal(r.archive.read({scope,keyword:'EXTRA-OLD-MIDDLE'}).items.length,0);
  const entry=r.trash.list({scope}).items[0];
  assert.equal(r.trash.detail({scope,id:entry.id}).sources[0].text,defaultsText);
});

test('a failed group archive rolls back source storage, phases, digest and plan together',t=>{
  const f=fixture(t),{r,scope,add,at}=f,item=add(defaultsText);
  at(START+2*DAY);enabled(r);const plan=r.retentionPlan({scope});
  const before=r.memory(item.memory_id),saved=r.store.packSource.bind(r.store);
  r.store.packSource=()=>{throw Error('synthetic disk failure');};
  assert.throws(()=>r.applyRetention({plan_id:plan.id}),/synthetic disk failure/);
  r.store.packSource=saved;
  assert.deepEqual(r.memory(item.memory_id),before);
  assert.equal(r.store.getSource(item.source_id).text,defaultsText);
  assert.ok(!r.store.meta('plan:'+plan.id).applied);
  assert.ok(r.store.sql('SELECT json FROM sources WHERE id=?').get(item.source_id).json);
  r.applyRetention({plan_id:plan.id});assert.equal(r.memory(item.memory_id).layer,'faint');
});

test('group expiry stashes verified monthly originals, survives restart and requires explicit restore',t=>{
  const f=fixture(t,{disk:true}),{scope,add,at}=f;let {r}=f;
  const low=add('收到'),ordinary=add(defaultsText),important=add('记住：重要鲸鱼约定。'),pending=add('未交接的普通来源',{process:false});
  const privateScope=r.addScope(owner).id,privateRow=add('私聊 ordinary 保留',{scope:privateScope});
  enabled(r);at(START+3*DAY);
  let plan=r.retentionPlan({scope});assert.ok(plan.items.some(i=>i.id===low.memory_id&&i.action==='group_trash'));assert.ok(!plan.items.some(i=>i.id===ordinary.memory_id&&i.action==='group_trash'));
  r.applyRetention({plan_id:plan.id});
  assert.equal(r.memory(low.memory_id).storage,'trash_only');assert.equal(r.body(r.memory(low.memory_id)),null);assert.equal(r.archive.read({scope,keyword:'收到'}).items.length,0);
  assert.ok(r.store.getSource(important.source_id));assert.ok(r.store.getSource(pending.source_id));assert.ok(r.store.getSource(privateRow.source_id));
  at(START+4*DAY);plan=r.retentionPlan({scope});r.applyRetention({plan_id:plan.id});
  const entry=r.trash.list({scope}).items.find(i=>i.memory_id===ordinary.memory_id);
  assert.ok(entry);assert.equal(entry.kind,'group_expiry');assert.ok(existsSync(join(r.trash.folder,'2026','2026-11.sqlite')));
  assert.equal(r.trash.detail({scope,id:entry.id}).sources[0].text,defaultsText);
  assert.ok(r.applyRetention({plan_id:plan.id}).replayed);
  assert.throws(()=>r.trash.detail({scope:privateScope,id:entry.id}),{code:'TRASH_RECOVERY_BLOCKED'});
  f.restart();r=f.r;enabled(r,{group_policy_enabled:0});
  assert.equal(r.query({scope,query:ordinary.memory_id,on_demand:true}).context.length,0);
  assert.equal(r.query({scope,query:'EXTRA-OLD-MIDDLE'}).context.length,0);
  assert.equal(r.archive.read({scope,keyword:'EXTRA-OLD-MIDDLE'}).items.length,0);
  r.restoreTrash({scope,id:entry.id,expected_revision:r.memory(ordinary.memory_id).revision});
  assert.equal(r.query({scope,query:ordinary.memory_id,on_demand:true}).context[0].text,defaultsText);
  enabled(r);assert.equal(r.groupLifecycle().resolve(r.memory(ordinary.memory_id)).phase,'expired');
  assert.ok(r.retentionPlan({scope}).items.some(i=>i.id===ordinary.memory_id&&i.action==='group_trash'));
});

test('a content-free grouping scaffold leaves active views once all its ordinary sources retire',t=>{
  const f=fixture(t),{r,scope,add,at}=f;
  add('scaffold-tidy 第一段合成资料',{topic:'scaffold-tidy'});add('scaffold-tidy 第二段合成资料',{topic:'scaffold-tidy'});
  const bundle=r.store.all(scope).find(m=>m.kind==='experience');assert.ok(bundle);
  at(START+5*DAY);enabled(r);
  for(let i=0;i<8;i++){const plan=r.retentionPlan({scope});if(!plan.items.length)break;r.applyRetention({plan_id:plan.id});}
  assert.equal(r.memory(bundle.id).layer,'forgotten');
  assert.ok(!r.graph({scope}).nodes.some(node=>node.id===bundle.id));
  assert.equal(r.associate({scope,id:bundle.id}).items.length,0);
});

test('trash retirement cannot leak old parts of a mixed fresh experience, even after disabling the age policy',async t=>{
  const f=fixture(t),{r,scope,add,at}=f;
  const old=add('shared-orbit OLD-ORBIT-SECRET '+defaultsText,{topic:'shared-orbit'});
  at(START+5*DAY);const fresh=add('shared-orbit NEW-ORBIT-CORRECTION 已改为南侧。',{topic:'shared-orbit',occurred_at:START+5*DAY});enabled(r);
  const bundle=r.store.all(scope).find(m=>m.kind==='experience'&&m.source_refs.includes(old.source_id)&&m.source_refs.includes(fresh.source_id));assert.ok(bundle);
  const plan=r.retentionPlan({scope});r.applyRetention({plan_id:plan.id});
  assert.equal(r.memory(old.memory_id).layer,'forgotten');assert.notEqual(r.memory(fresh.memory_id).layer,'forgotten');
  for(const switchValue of [1,0]){
    enabled(r,{group_policy_enabled:switchValue});
    for(const on_demand of [false,true]){
      const result=r.query({scope,query:bundle.id,on_demand});assert.ok(result.context.some(i=>i.text.includes('NEW-ORBIT-CORRECTION')));assert.ok(result.context.every(i=>!i.text.includes('OLD-ORBIT-SECRET')&&!i.source_refs.includes(old.source_id)));
    }
    assert.equal(r.archive.read({scope,keyword:'OLD-ORBIT-SECRET'}).items.length,0);
    assert.ok(!JSON.stringify(r.personMemory({scope})).includes('OLD-ORBIT-SECRET'));
  }
  const packets=[],service=new V5ModelService(r,{client:{model:'synthetic',json:async(_s,input)=>{packets.push(input);return {value:{reply:'已核对。',used_memory_ids:[]},usage:{},model:'synthetic'};}}});
  await service.chat({scope,query:'shared-orbit 现在改到哪里',semantic_retrieval:false});
  assert.equal(packets.length,1);assert.ok(!JSON.stringify(packets[0]).includes('OLD-ORBIT-SECRET'));
  assert.ok(r.trash.list({scope}).items.some(i=>i.memory_id===old.memory_id));
});

test('failed trash writes and active-database failures retain originals and do not mark a plan applied',t=>{
  const f=fixture(t),{r,scope,add,at}=f,item=add(defaultsText);at(START+4*DAY);enabled(r);
  const plan=r.retentionPlan({scope}),original=r.memory(item.memory_id),stash=r.trash.stash.bind(r.trash);
  r.trash.stash=()=>{throw Error('synthetic trash unavailable');};
  assert.throws(()=>r.applyRetention({plan_id:plan.id}),/trash unavailable/);r.trash.stash=stash;
  assert.deepEqual(r.memory(item.memory_id),original);assert.equal(r.store.getSource(item.source_id).text,defaultsText);
  const put=r.store.putMemory.bind(r.store);r.store.putMemory=(m,...rest)=>{if(m.layer==='forgotten')throw Error('synthetic active database failure');return put(m,...rest);};
  assert.throws(()=>r.applyRetention({plan_id:plan.id}),/active database failure/);r.store.putMemory=put;
  assert.deepEqual(r.memory(item.memory_id),original);assert.equal(r.store.getSource(item.source_id).text,defaultsText);
  assert.ok(!r.store.meta('plan:'+plan.id).applied);assert.equal(r.store.meta('group-trash-present',false),false);assert.equal(r.trash.list({scope}).total,0);
  r.applyRetention({plan_id:plan.id});assert.equal(r.trash.list({scope}).total,1);
});

test('discarded group copies are never read by routine recall, association, archive, maintenance or model preparation',async t=>{
  const f=fixture(t),{r,scope,add,at}=f,item=add(defaultsText);at(START+4*DAY);enabled(r);
  r.applyRetention({plan_id:r.retentionPlan({scope}).id});
  for(let i=0;i<8;i++){const plan=r.retentionPlan({scope});if(!plan.items.length)break;r.applyRetention({plan_id:plan.id});}
  for(const name of ['all','list','detail','loadObject','restore'])r.trash[name]=()=>assert.fail('routine flow read the rubbishmemory: '+name);
  assert.equal(r.query({scope,query:item.memory_id,on_demand:true}).context.length,0);
  assert.equal(r.archive.read({scope,keyword:'EXTRA-OLD-MIDDLE'}).items.length,0);
  assert.equal(r.archive.memo(scope),'');assert.equal(r.personMemory({scope}).length,0);
  assert.equal(r.associate({scope,id:item.memory_id}).items.length,0);
  assert.equal(r.maintenance().items.length,0);
  enabled(r,{group_policy_enabled:0});
  const packets=[],service=new V5ModelService(r,{client:{model:'synthetic',json:async(_s,input)=>{packets.push(input);return {value:{reply:'合成回答。',used_memory_ids:[]},usage:{},model:'synthetic'};}}});
  await service.chat({scope,query:'aurora-note 是什么',semantic_retrieval:true});
  assert.equal(packets.length,1);assert.ok(!JSON.stringify(packets[0]).includes('EXTRA-OLD-MIDDLE'));
});

test('retired evidence kept for a mixed live object is excluded from new vectors and feedback interpretation',async t=>{
  const f=fixture(t),{r,scope,add,at}=f,old=add('discard-vector SECRET-RETIRED-EVIDENCE 旧的闲聊内容。');
  at(START+5*DAY);const fresh=add('discard-vector FRESH-REFERENCE 当前明确的新线索。',{occurred_at:START+5*DAY});
  const mixed=r.derive(r.memory(fresh.memory_id),{id:'mixed-knowledge',kind:'knowledge',label:'discard-vector 混合材料',body:'SECRET-RETIRED-EVIDENCE 与 FRESH-REFERENCE 的旧汇总',protection:'P2',source_refs:[old.source_id,fresh.source_id],attributes:{}});
  enabled(r);r.applyRetention({plan_id:r.retentionPlan({scope}).id});
  assert.equal(r.memory(old.memory_id).storage,'trash_only');assert.ok(r.store.getSource(old.source_id),'live dependent may retain canonical evidence');
  assert.equal(r.dialogue.activeSource(old.source_id),null);assert.ok(r.dialogue.activeSource(fresh.source_id));
  r.store.setMeta('feedback-lexicon:'+scope,{'鱼尾抱抱':{meaning:'approval',source_ref:old.source_id}});
  const interpreted=r.dialogue.interpret('鱼尾抱抱',{scope});assert.notEqual(interpreted.meaning,'approval');
  const texts=[];r.semantic.configure({model:'synthetic-group',embed:async text=>{texts.push(text);return [1,0,0];}});
  await r.semantic.sync({scope,force:true,limit:30});
  assert.ok(texts.some(text=>text.includes('FRESH-REFERENCE')));assert.ok(texts.every(text=>!text.includes('SECRET-RETIRED-EVIDENCE')));
  assert.ok(r.query({scope,query:mixed.id}).context.every(item=>!item.text.includes('SECRET-RETIRED-EVIDENCE')));
});

test('a plan crossing a lifecycle deadline is rejected even without a configuration change',t=>{
  const f=fixture(t),{r,scope,add,at}=f,item=add(defaultsText);
  at(START+DAY);enabled(r);const plan=r.retentionPlan({scope});
  assert.equal(plan.items[0].group_phase,'related');
  at(START+2*DAY);
  assert.throws(()=>r.applyRetention({plan_id:plan.id}),{code:'REVISION_CONFLICT'});
  assert.ok(!r.memory(item.memory_id).attributes.group_lifecycle);
  const replacement=r.retentionPlan({scope});r.applyRetention({plan_id:replacement.id});
  assert.equal(r.memory(item.memory_id).attributes.group_lifecycle.phase,'trace');
});

test('a legacy saved config inherits the original behavior and group words do not change private/system policies',t=>{
  const f=fixture(t,{disk:true}),{r,scope,add,at}=f,item=add(defaultsText);
  const saved=structuredClone(r.config);for(const key of Object.keys(saved.W5).filter(key=>key.startsWith('group_')))delete saved.W5[key];
  r.store.setMeta('effective_config',saved);at(START+5*DAY);const before=r.query({scope,query:item.memory_id}).context;
  f.restart();assert.equal(f.r.config.W5.group_policy_enabled,0);
  assert.deepEqual(f.r.query({scope,query:item.memory_id}).context,before);
  const privateScope=f.r.addScope(owner).id,systemScope=f.r.addScope({persona_id:group.persona_id,scope:'system:night'}).id;
  const a=f.r.ingest({scope:privateScope,text:'私聊里提到了群聊和大家的 ordinary-note',process:true,occurred_at:START}),b=f.r.ingest({scope:systemScope,text:'系统任务提到了群聊 ordinary-note',process:true,occurred_at:START});
  const privateBefore=f.r.query({scope:privateScope,query:a.memory_id}).context,systemBefore=f.r.query({scope:systemScope,query:b.memory_id}).context;
  enabled(f.r);
  assert.deepEqual(f.r.query({scope:privateScope,query:a.memory_id}).context,privateBefore);
  assert.deepEqual(f.r.query({scope:systemScope,query:b.memory_id}).context,systemBefore);
});

test('reimport, cold packing and index rebuilding never refresh missing-time first reception',t=>{
  const f=fixture(t),{r,scope,at}=f;
  const partition={context:group,sources:[{id:'stable-missing-time',chat_id:group.scope,speaker_id:'synthetic',role:'user',sequence:1,text:'import-violet 普通无时间来源',occurred_at:null,time_precision:'unknown',provenance:{system:'synthetic'}}],memories:[],relations:[]};
  r.importPartitions([partition]);enabled(r);
  const id='raw:'+scope+':stable-missing-time',sourceId=scope+':stable-missing-time';
  const first=r.groupLifecycle().resolve(r.memory(id));assert.equal(first.source_time,START);assert.deepEqual(first.fallback_reasons,['missing_original_time']);
  at(START+5*DAY);r.importPartitions([partition]);r.store.packSource(sourceId);r.store.rebuildSearchIndex(500);
  const after=r.groupLifecycle().resolve(r.memory(id));assert.equal(after.source_time,START);assert.equal(after.phase,'expired');
  assert.equal(r.query({scope,query:id}).context.length,0);
  assert.equal(r.query({scope,query:id,on_demand:true}).context[0].text,partition.sources[0].text);
});

test('process termination inside group maintenance leaves no half-applied trace and can resume safely',t=>{
  const file=join(mkdtempSync(join(testRuntimeRoot(null),'interrupt-')),'memory.sqlite'),at=START+2*DAY;
  let runtime=new V5Runtime({file,clock:()=>at});t.after(()=>runtime?.close());
  const scope=runtime.addScope(group).id,items=[];
  for(let i=0;i<2;i++)items.push(runtime.ingest({scope,text:'interrupt-synthetic 合成资料 '+i,occurred_at:START,process:true}));
  enabled(runtime);runtime.close();runtime=null;
  const script=`import {V5Runtime} from ${JSON.stringify(new URL('../core/v5-runtime.js',import.meta.url).href)};const r=new V5Runtime({file:process.argv[1],clock:()=>${at}});const original=r.store.packSource.bind(r.store);r.store.packSource=id=>{original(id);process.exit(23);};const plan=r.retentionPlan();r.applyRetention({plan_id:plan.id});`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script,file],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(child.status,23,child.stderr);
  runtime=new V5Runtime({file,clock:()=>at});
  for(const item of items){assert.ok(!runtime.memory(item.memory_id).attributes.group_lifecycle);assert.ok(runtime.store.sql('SELECT json FROM sources WHERE id=?').get(item.source_id).json);}
  const plan=runtime.retentionPlan({scope});runtime.applyRetention({plan_id:plan.id});
  for(const item of items){assert.equal(runtime.memory(item.memory_id).layer,'faint');assert.ok(runtime.store.getSource(item.source_id).text.includes('interrupt-synthetic'));}
});
