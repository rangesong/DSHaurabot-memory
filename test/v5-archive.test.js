import test from 'node:test';
import {createServer} from 'node:http';
import {createMemorySeaHandler} from '../server/memory-sea-handler.js';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join,dirname,resolve } from 'node:path';
import { V5Runtime } from '../core/v5-runtime.js';
import { archiveDay } from '../core/v5-archive.js';

const DAY=86400000,at=Date.parse('2026-10-02T12:00:00+08:00');
function fixture(t,{disk=false}={}){
  const root=fileURLToPath(new URL('../runtime-data/',import.meta.url));mkdirSync(root,{recursive:true});
  const dir=disk?mkdtempSync(join(root,'archive-test-')):null,file=dir?join(dir,'memory.sqlite'):':memory:';
  let now=at+400*DAY,r=new V5Runtime({file,clock:()=>now});
  const scope=r.addScope({persona_id:'synthetic',scope:'private:100'}).id;
  t.after(()=>{r.close();if(dir){assert.equal(dirname(resolve(dir)),resolve(root));rmSync(dir,{recursive:true,force:true});}});
  return {get r(){return r;},scope,advance(days){now+=days*DAY;},reopen(){r.close();r=new V5Runtime({file,clock:()=>now});},add(text,extra={}){return r.ingest({scope,text,occurred_at:at,...extra});}};
}
function fakeModel(answer='导航摘要'){
  let calls=0;return {model:'synthetic-v1',status:()=>({configured:true}),get calls(){return calls;},async json(){calls++;return {value:{text:answer}};}};
}

test('L0 keeps every row beyond 400, survives session reset and reopen, and L2 navigates back to exact L0',async t=>{
  const h=fixture(t,{disk:true}),originals=[];
  for(let i=0;i<405;i++)originals.push(h.add(`合成记录${i}：不是成功；预算${i+10}元，条件不满足。`));
  const day=archiveDay(at),first=await h.r.archive.build({scope:h.scope,period:day});
  assert.equal(first.chunk_count>1,true);assert.equal(h.r.archive.index({scope:h.scope}).l0,405);
  await h.r.archive.build({scope:h.scope,level:2,period:day.slice(0,7)});
  h.r.store.saveState({...h.r.store.state(h.scope),source_refs:[],choices:[],open_loop_ids:[]});h.reopen();
  assert.ok(h.r.archive.read({scope:h.scope,level:2}).items[0].summary);
  assert.ok(h.r.archive.read({scope:h.scope,level:1,day}).items[0].summary);
  const pages=[];for(let offset=0;offset<405;offset+=80)pages.push(...h.r.archive.read({scope:h.scope,day,offset,limit:80}).items);
  assert.equal(pages.length,405);assert.equal(new Set(pages.map(row=>row.source_id)).size,405);
  assert.equal(pages.at(-1).text,'合成记录404：不是成功；预算414元，条件不满足。');
  assert.equal(h.r.store.getSource(originals[0].source_id).text,pages[0].text);
});

test('model and empty results use persistent input fingerprints; late input and changed model invalidate cache',async t=>{
  const h=fixture(t,{disk:true}),client=fakeModel('');h.add('合成输入：没有形成结论。');
  const args={scope:h.scope,period:archiveDay(at),use_model:true,client};
  assert.equal((await h.r.archive.build(args)).status,'empty');assert.equal(client.calls,1);
  h.reopen();assert.equal((await h.r.archive.build(args)).cached,true);assert.equal(client.calls,1);
  h.add('合成补充：预算改为31元。');assert.equal(h.r.archive.index({scope:h.scope}).days[0].status,'pending');
  assert.equal((await h.r.archive.build(args)).cached,false);assert.equal(client.calls,2);
  client.model='synthetic-v2';await h.r.archive.build(args);assert.equal(client.calls,3);
});

test('quota and uncertain requests persist; no silent retry charges after failure or restart',async t=>{
  const h=fixture(t,{disk:true});h.add('合成待整理原文。');h.r.config.W5.archive_daily_calls=1;
  const client=fakeModel();client.json=async()=>{throw new Error('synthetic transport lost');};
  const args={scope:h.scope,period:archiveDay(at),use_model:true,client};
  await assert.rejects(h.r.archive.build(args),/transport lost/);h.reopen();h.r.config.W5.archive_daily_calls=1;
  assert.equal((await h.r.archive.build(args)).status,'uncertain');
  assert.equal((await h.r.archive.build({...args,retry_uncertain:true})).status,'budget_exhausted');
  assert.equal(h.r.archive.index({scope:h.scope}).model_calls_today,1);
  assert.equal(h.r.archive.read({scope:h.scope}).items[0].text,'合成待整理原文。');
});

test('normal forgetting retires active stars but retains lossless L0 and does not fake a total-erasure meteor',t=>{
  const h=fixture(t),row=h.add('你好',{process:true});h.advance(400);
  const plan=h.r.retentionPlan({scope:h.scope}),result=h.r.applyRetention({plan_id:plan.id});
  assert.equal(h.r.memory(row.memory_id).layer,'forgotten');assert.equal(h.r.memory(row.memory_id).storage,'archive_only');
  assert.equal(h.r.store.getSource(row.source_id).text,'你好');
  assert.equal(h.r.archive.read({scope:h.scope}).items[0].text,'你好');
  assert.ok(h.r.trace(result.run_id).events.some(event=>event.archive_retired));
  assert.ok(!h.r.trace(result.run_id).events.some(event=>event.meteor));
});

test('privacy filters hide mixed summaries, and explicit erasure invalidates all archive and current-state derivatives',async t=>{
  const h=fixture(t),a=h.add('先用隐私合成方案；预算31元',{provenance:{speaker_id:'100'}}),b=h.add('合成群友的普通消息',{provenance:{speaker_id:'200'},process:true});
  const day=archiveDay(at);await h.r.archive.build({scope:h.scope,period:day});await h.r.archive.build({scope:h.scope,period:day.slice(0,7),level:2});
  const filter=source=>source.speaker_id!=='100';
  assert.equal(h.r.archive.read({scope:h.scope,filter}).items.length,1);
  assert.equal(h.r.archive.read({scope:h.scope,filter,level:1}).items[0].summary,'');assert.equal(h.r.archive.memo(h.scope,{filter}),'');
  h.r.eraseSources([a.source_id]);assert.equal(h.r.store.getSource(a.source_id),null);assert.equal(h.r.store.getSource(b.source_id).text,'合成群友的普通消息');
  assert.equal(h.r.store.state(h.scope).choices.length,0);assert.equal(h.r.archive.memo(h.scope),'');
  const snapshots=h.r.store.sql('SELECT json FROM versions').all();assert.ok(snapshots.every(row=>!row.json.includes('隐私合成方案')));
  assert.equal(h.r.archive.index({scope:h.scope}).days[0].status,'pending');
});

test('erasure during an in-flight archive call prevents old output from being committed',async t=>{
  const h=fixture(t),row=h.add('合成需要删除的原文');let finish;
  const client={model:'synthetic',status:()=>({configured:true}),json:()=>new Promise(resolve=>{finish=resolve;})};
  const running=h.r.archive.build({scope:h.scope,period:archiveDay(at),use_model:true,client});
  h.r.eraseSources([row.source_id]);finish({value:{text:'不应提交的过期摘要'}});
  await assert.rejects(running,{code:'REVISION_CONFLICT'});assert.equal(h.r.archive.stats().l1,0);
  assert.equal(h.r.archive.read({scope:h.scope}).items.length,0);
});

test('archive pagination is scope-bound and rejects invalid requests; metadata updates persist when packed',t=>{
  const h=fixture(t),row=h.add('合成助手观察',{role:'assistant'});h.r.store.packSource(row.source_id);h.r.store.updateSourceMetadata(row.source_id,{delivery_status:'prepared_at_send_hook'});
  assert.equal(h.r.store.getSource(row.source_id).delivery_status,'prepared_at_send_hook');
  assert.throws(()=>h.r.archive.read({scope:h.scope,limit:1000}));assert.throws(()=>h.r.archive.read({scope:h.scope,day:'x'}));
  const other=h.r.addScope({persona_id:'other',scope:'private:100'}).id;assert.equal(h.r.archive.read({scope:other}).total,0);
});


test('readable export is scoped and contains full originals, identities and integrity metadata without model caches',t=>{
  const h=fixture(t),source=h.add('合成可迁移原文，不是摘要。'),other=h.r.addScope({persona_id:'other',scope:'private:200'}).id;
  h.r.ingest({scope:other,text:'另一范围不应进入导出'});h.r.store.setMeta('semantic:synthetic',{secret_example:'model checkpoint omitted'});
  const bundle=h.r.archive.export({scope:h.scope});assert.equal(bundle.schema,'thinkstar-readable-export/1');assert.equal(bundle.sources.length,1);assert.equal(bundle.sources[0].id,source.source_id);assert.equal(bundle.sources[0].text,'合成可迁移原文，不是摘要。');assert.equal(bundle.content_sha256.length,64);assert.ok(!JSON.stringify(bundle).includes('model checkpoint omitted'));
});


test('archive HTTP routes expose progressive reads, local build, private export and invalid pagination status',async t=>{
  const h=fixture(t);h.add('合成HTTP原话：精确数字31元');
  const server=createServer(createMemorySeaHandler({runtime:h.r}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port+'/api/v5/',params='?scope='+h.scope;
  assert.equal((await (await fetch(base+'archive-index'+params)).json()).l0,1);
  const build=await fetch(base+'archive-build',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scope:h.scope,period:archiveDay(at)})});assert.equal(build.status,200);
  assert.equal((await (await fetch(base+'archive-read'+params+'&level=0')).json()).items[0].text,'合成HTTP原话：精确数字31元');
  assert.equal((await (await fetch(base+'archive-export'+params)).json()).sources.length,1);
  assert.equal((await fetch(base+'archive-read'+params+'&limit=1000')).status,400);
});


test('late arrivals invalidate visible navigation immediately and arrivals during model work prevent stale commit',async t=>{
  const h=fixture(t);h.add('合成旧记录：预算30元');const unit=await h.r.archive.build({scope:h.scope,period:archiveDay(at)});
  h.add('合成新更正：预算31元');assert.equal(h.r.memory(unit.memory_id).validity,'superseded');assert.ok(!h.r.graph({scope:h.scope}).nodes.some(node=>node.id===unit.memory_id));assert.equal(h.r.archive.memo(h.scope),'');
  let finish;const client={model:'synthetic',status:()=>({configured:true}),json:()=>new Promise(resolve=>{finish=resolve;})};
  const running=h.r.archive.build({scope:h.scope,period:archiveDay(at),use_model:true,client});h.add('合成在途追加：预算32元');finish({value:{text:'不含新输入的旧结果'}});await assert.rejects(running,{code:'REVISION_CONFLICT'});assert.equal(h.r.archive.index({scope:h.scope}).days[0].status,'pending');
});
