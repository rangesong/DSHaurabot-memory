import {testRuntimeRoot} from '../scripts/lib/test-workspace.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {V5Runtime} from '../core/v5-runtime.js';
import {V5Store} from '../core/v5-store.js';
import {CURRENT_VERSION_JSON} from '../core/v5-storage-codec.js';
import {archiveDay} from '../core/v5-archive.js';

function fixture(t){const root=resolve(testRuntimeRoot('runtime-data'));mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'storage-v2-test-')),file=join(dir,'memory.sqlite');let r=new V5Runtime({file});t.after(()=>{r.close();assert.equal(dirname(dir),root);rmSync(dir,{recursive:true,force:true});});return {file,dir,get r(){return r;},reopen(){r.close();r=new V5Runtime({file});return r;}};}
function asV1(store){const memories=store.all('all',{includeForgotten:true}),versions=store.sql('SELECT id,revision,json FROM versions').all().map(row=>store.decodeVersion(row)),catalogs=store.catalogs();for(const m of memories)store.sql('UPDATE memories SET json=? WHERE id=?').run(JSON.stringify(m),m.id);for(const v of versions)store.sql('UPDATE versions SET json=? WHERE id=? AND revision=?').run(JSON.stringify(v),v.id,v.revision);for(const c of catalogs)store.sql('UPDATE catalogs SET json=? WHERE id=?').run(JSON.stringify(c),c.id);store.sql('DELETE FROM reference_sets').run();store.setMeta('thinkstar_storage_schema',1);return {memories,versions,catalogs};}

test('v1 migration preserves every logical object, version, catalog, original and creates a usable rollback backup',t=>{
  const h=fixture(t),items=[];for(let i=0;i<120;i++)items.push(h.r.ingest({text:`合成原话${i}：不是成功，约束和更正需完整保留。`,process:false}));
  const base=h.r.memory(items[0].memory_id),refs=items.map(item=>item.source_id);
  for(let i=0;i<30;i++)h.r.store.putMemory({...structuredClone(base),id:'synthetic-archive:'+i,kind:'archive_chunk',source_refs:refs,source_roots:refs,body:'合成摘要'});
  h.r.rebuildCatalogs();const before=asV1(h.r.store),originals=items.map(item=>h.r.store.getSource(item.source_id));const size=h.r.store.stats().bytes;
  h.reopen();assert.equal(h.r.store.meta('thinkstar_storage_schema'),2);
  assert.deepEqual(h.r.store.all('all',{includeForgotten:true}),before.memories);
  assert.deepEqual(h.r.store.sql('SELECT id,revision,json FROM versions').all().map(row=>h.r.store.decodeVersion(row)),before.versions);
  assert.deepEqual(h.r.store.catalogs(),before.catalogs);assert.deepEqual(items.map(item=>h.r.store.getSource(item.source_id)),originals);
  assert.ok(h.r.store.stats().bytes<size*.8);const migration=h.r.store.meta('storage_v2_migration');assert.ok(existsSync(migration.backup));const backup=new DatabaseSync(migration.backup,{readOnly:true});assert.equal(JSON.parse(backup.prepare("SELECT json FROM meta WHERE key='thinkstar_storage_schema'").get().json),1);assert.equal(backup.prepare('SELECT count(*) n FROM sources').get().n,120);backup.close();
  const saved=readFileSync(migration.backup);h.reopen();assert.equal(h.r.store.meta('storage_v2_migration').backup,migration.backup);assert.deepEqual(readFileSync(migration.backup),saved);
});

test('new snapshots share current payload and materialize historical content before all kinds of updates',t=>{
  const h=fixture(t),receipt=h.r.ingest({text:'合成初始原话',process:false});let m=h.r.memory(receipt.memory_id);m.body='初始对象';h.r.store.putMemory(m);
  assert.equal(h.r.store.sql('SELECT json FROM versions WHERE id=?').get(m.id).json,CURRENT_VERSION_JSON);
  m.revision++;m.body='新版本';h.r.store.putMemory(m);assert.deepEqual(h.r.store.versions(m.id).map(v=>v.body),['新版本','初始对象']);
  m.body='同版元数据变化';h.r.store.putMemory(m,null,{history:false});assert.deepEqual(h.r.store.versions(m.id).map(v=>v.body),['新版本','初始对象']);
  h.r.store.putMemory(m);assert.equal(h.r.store.versions(m.id)[0].body,'同版元数据变化');h.reopen();assert.equal(h.r.detail({scope:m.scope,id:m.id}).versions[1].body,'初始对象');
});

test('shared reference sets retain order and independence through revisions, pruning and reopen',t=>{
  const h=fixture(t),receipt=h.r.ingest({text:'合成引用载体',process:false}),m=h.r.memory(receipt.memory_id);m.source_refs=Array.from({length:300},(_,i)=>'synthetic-ref-'+i);m.source_roots=m.source_refs.slice();h.r.store.putMemory(m);
  const before=structuredClone(m);m.revision++;m.source_refs.reverse();h.r.store.putMemory(m);h.r.store.tx(()=>h.r.store.codec.prune());h.reopen();assert.deepEqual(h.r.store.getMemory(m.id).source_refs,m.source_refs);assert.deepEqual(h.r.store.versions(m.id)[1],before);
  const loaded=h.r.store.getMemory(m.id);loaded.source_roots.push('uncommitted');assert.equal(h.r.store.getMemory(m.id).source_roots.length,300);
  assert.ok(h.r.store.sql('SELECT count(*) n FROM reference_sets').get().n<=2);
});

test('new archive chunks reference only their own input and unchanged archive calls remain cached after migration',async t=>{
  const h=fixture(t),at=Date.parse('2026-10-02T12:00:00+08:00');let scope;
  for(let i=0;i<90;i++)scope=h.r.ingest({scope,text:`合成记录${i}：${'保留完整的分块归档内容。'.repeat(20)}`,occurred_at:at,process:false}).scope;
  const client={model:'synthetic',calls:0,status:()=>({configured:true}),async json(){this.calls++;return {value:{text:'合成导航摘要'}};}};
  const args={scope,period:archiveDay(at),use_model:true,client};await h.r.archive.build(args);const chunks=h.r.store.all(scope).filter(m=>m.kind==='archive_chunk');assert.ok(chunks.length>1);assert.equal(new Set(chunks.flatMap(m=>m.source_refs)).size,90);assert.ok(chunks.every(m=>m.source_refs.length<90));assert.ok(chunks.reduce((sum,m)=>sum+m.source_refs.length,0)<=90+chunks.length);
  const calls=client.calls;asV1(h.r.store);h.reopen();assert.equal((await h.r.archive.build(args)).cached,true);assert.equal(client.calls,calls);assert.equal(h.r.archive.read({scope,level:0}).total,90);
});

test('future storage schema is rejected before writes',t=>{const h=fixture(t);h.r.store.setMeta('thinkstar_storage_schema',999);h.r.close();assert.throws(()=>new V5Store(h.file),{code:'STORAGE_SCHEMA_UNSUPPORTED'});const db=new DatabaseSync(h.file);db.prepare("UPDATE meta SET json='2' WHERE key='thinkstar_storage_schema'").run();db.close();h.reopen();});
