import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {V5Runtime} from '../core/v5-runtime.js';
import {trashMonth} from '../core/v5-trash.js';
const DAY=86400000,at=Date.parse('2026-11-15T02:00:00+08:00');
function fixture(t){const root=resolve('runtime-data');mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'trash-test-')),file=join(dir,'memory.sqlite');let now=at,r=new V5Runtime({file,clock:()=>now});t.after(()=>{r.close();assert.equal(dirname(dir),root);rmSync(dir,{recursive:true,force:true});});return {dir,get r(){return r;},advance(days){now+=days*DAY;},reopen(){r.close();r=new V5Runtime({file,clock:()=>now});},add(text){return r.ingest({text,process:true});}};}

test('explicit discard leaves the active query, durably preserves exact originals and restores layers after restart',t=>{
  const h=fixture(t),a=h.add('必须记住：合成星桥实验的完整条件是雨天取消，预算57元。'),before=structuredClone(h.r.memory(a.memory_id));
  h.r.discardMemory({scope:a.scope,id:a.memory_id,expected_revision:before.revision,reason:'合成废弃'});assert.equal(h.r.query({scope:a.scope,query:'星桥实验'}).context.length,0);
  h.reopen();const list=h.r.trashList({scope:a.scope}),entry=list.items.find(item=>item.memory_id===a.memory_id);assert.ok(entry);assert.equal(list.auto_recall,false);const detail=h.r.trash.detail({scope:a.scope,id:entry.id});assert.equal(detail.sources[0].text,'必须记住：合成星桥实验的完整条件是雨天取消，预算57元。');
  const other=h.r.addScope({persona_id:'other',scope:'private:other'}).id;assert.throws(()=>h.r.restoreTrash({...entry,scope:other}),{code:'TRASH_RECOVERY_BLOCKED'});
  const restored=h.r.restoreTrash({...entry});const m=h.r.memory(restored.memory_id);assert.equal(m.layer,before.layer);assert.equal(h.r.body(m),detail.sources[0].text);assert.ok(m.revision>before.revision);assert.equal(h.r.trashList({scope:a.scope}).items.some(item=>item.id===entry.id),false);assert.throws(()=>h.r.restoreTrash(entry),{code:'TRASH_RECOVERY_BLOCKED'});
  assert.ok(h.r.query({scope:a.scope,query:'星桥实验'}).context.some(item=>item.text.includes('雨天取消')));
});

test('automatic forgetting with L0 disabled remains recoverable and reimport cannot revive it',t=>{
  const h=fixture(t),a=h.add('你好');h.r.config.W5.keep_raw_archive=0;h.advance(500);const result=h.r.applyRetention({plan_id:h.r.retentionPlan({scope:a.scope}).id});assert.ok(result.forgotten.length);assert.equal(h.r.store.getSource(a.source_id),null);h.reopen();const entry=h.r.trashList({scope:a.scope}).items.find(item=>item.memory_id===a.memory_id);assert.ok(entry);h.r.restoreTrash(entry);assert.equal(h.r.store.getSource(a.source_id).text,'你好');assert.equal(h.r.body(h.r.memory(a.memory_id)),'你好');
});

test('lossy compression followed by forgetting still carries the full precompression original',t=>{
  const h=fixture(t),text='合成普通记录的完整细节。'.repeat(80),a=h.add(text);h.r.config.W5.keep_raw_archive=0;h.advance(70);h.r.applyRetention({plan_id:h.r.retentionPlan({scope:a.scope}).id});assert.equal(h.r.store.getSource(a.source_id),null);assert.ok(h.r.memory(a.memory_id).attributes.precision_backup_id);
  h.advance(500);h.r.applyRetention({plan_id:h.r.retentionPlan({scope:a.scope}).id});h.reopen();const entry=h.r.trashList({scope:a.scope}).items.find(item=>item.memory_id===a.memory_id);assert.ok(entry);const saved=h.r.trash.readEntry(entry.id),refs=[saved.namespace,saved.memory,saved.lookup,...Object.values(saved.sources),...saved.versions,...saved.relations];assert.ok(refs.every(ref=>ref.startsWith(entry.id.slice(0,7)+':')));assert.equal(h.r.trash.loadObject(saved.namespace).id,a.scope);assert.equal(h.r.trash.detail({scope:a.scope,id:entry.id}).sources[0].text,text);h.r.restoreTrash(entry);assert.equal(h.r.store.getSource(a.source_id).text,text);assert.equal(h.r.detail({scope:a.scope,id:a.memory_id}).source_page.sources[0].text,text);assert.equal(h.r.memory(a.memory_id).attributes.precision_backup_id,undefined);
});

test('trash persistence failure prevents retirement and permanent privacy erasure purges trash recovery',t=>{
  const h=fixture(t),a=h.add('合成不可误删原话');const m=h.r.memory(a.memory_id),stash=h.r.trash.stash;h.r.trash.stash=()=>{throw Error('synthetic disk failure');};assert.throws(()=>h.r.discardMemory({scope:a.scope,id:m.id,expected_revision:m.revision,reason:'合成'}),/disk failure/);assert.equal(h.r.body(h.r.memory(m.id)),'合成不可误删原话');h.r.trash.stash=stash;
  h.r.discardMemory({scope:a.scope,id:m.id,expected_revision:m.revision,reason:'合成'});const entry=h.r.trashList({scope:a.scope}).items.find(item=>item.memory_id===m.id),ref=h.r.trash.readEntry(entry.id).sources[a.source_id];h.r.eraseSources([a.source_id]);assert.equal(h.r.trashList({scope:a.scope}).total,0);assert.throws(()=>h.r.restoreTrash(entry));assert.throws(()=>h.r.trash.loadObject(ref));h.reopen();assert.equal(h.r.store.getSource(a.source_id),null);
});

test('retirement month uses China time, groups by year and names each self-contained file YYYY-MM',t=>{
  assert.equal(trashMonth(Date.parse('2026-12-31T16:00:00Z')),'2027-01');assert.equal(trashMonth(Date.parse('2026-12-31T15:59:59Z')),'2026-12');
  const h=fixture(t),a=h.add('合成跨年遗忘副本');const first=h.r.memory(a.memory_id);h.r.discardMemory({scope:a.scope,id:first.id,expected_revision:first.revision,reason:'十一月废弃'});assert.ok(existsSync(join(h.dir,'rubbishmemory','2026','2026-11.sqlite')));
  h.r.restoreTrash(h.r.trashList({scope:a.scope}).items.find(item=>item.memory_id===a.memory_id));h.advance(70);const current=h.r.memory(a.memory_id);h.r.discardMemory({scope:a.scope,id:current.id,expected_revision:current.revision,reason:'次年一月废弃'});assert.ok(existsSync(join(h.dir,'rubbishmemory','2027','2027-01.sqlite')));h.reopen();const entry=h.r.trashList({scope:a.scope}).items.find(item=>item.memory_id===a.memory_id);assert.ok(entry.id.startsWith('2027-01--'));assert.equal(h.r.trash.detail({scope:a.scope,id:entry.id}).sources[0].occurred_at,at);
});

test('one retirement stays in its initial month even when source reads cross midnight',t=>{
  const h=fixture(t),a=h.add('合成月界原话'),memory=h.r.memory(a.memory_id),before=Date.parse('2026-12-31T15:59:59.999Z');let now=before;h.r.clock=()=>now;const get=h.r.store.getSource.bind(h.r.store);h.r.store.getSource=id=>{now=before+1;return get(id);};
  const entry=h.r.trash.stash(memory,{reason:'跨年时刻退役'});assert.ok(entry.id.startsWith('2026-12--'));assert.equal(entry.at,before);assert.ok(Object.values(entry.sources).every(ref=>ref.startsWith('2026-12:')));assert.ok(existsSync(join(h.dir,'rubbishmemory','2026','2026-12.sqlite')));assert.equal(existsSync(join(h.dir,'rubbishmemory','2027','2027-01.sqlite')),false);
});

test('restoring an older confirmed fact cannot override a later confirmed fact',t=>{
  const h=fixture(t),a=h.add('合成起床时间为七点'),first=h.r.writeFact({scope:a.scope,source_id:a.source_id,quote:'起床时间为七点',field:'schedule.wake',reason:'合成确认'}).memory;
  h.r.discardMemory({scope:a.scope,id:first.id,expected_revision:first.revision,reason:'合成废弃'});const b=h.add('合成起床时间改为八点'),old=h.r.memory(first.id),second=h.r.writeFact({scope:a.scope,source_id:b.source_id,quote:'起床时间改为八点',field:'schedule.wake',expected_id:first.id,expected_revision:old.revision,reason:'合成更正'}).memory;
  const entry=h.r.trashList({scope:a.scope}).items.find(item=>item.memory_id===first.id);h.r.restoreTrash(entry);assert.equal(h.r.memory(first.id).validity,'superseded');assert.equal(h.r.factIndex({scope:a.scope}).items[0].id,second.id);assert.equal(h.r.memory(second.id).body,'起床时间改为八点');
});
