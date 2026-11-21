import test from 'node:test';
import assert from 'node:assert/strict';
import {V5Runtime} from '../core/v5-runtime.js';
import {HANDOFF} from '../core/v5-config.js';
import {retrievalTokens} from '../core/v5-retrieval.js';

test('ingestion capacity warnings and low-value backlog decisions avoid full statistics',t=>{
  const r=new V5Runtime();t.after(()=>r.close());
  assert.equal(r.store.storageBytes(),r.store.stats().bytes);
  r.store.stats=()=>{throw Error('unexpected full statistics');};
  r.config.W5.capacity_mb=0;r.config.W1.pending_limit=0;r.config.W5.batch_size=1;
  const receipt=r.ingest({text:'你好'});
  r.ingest({scope:receipt.scope,text:'你好呀'});
  assert.equal(r.memory(receipt.memory_id).protection,'P3');
  assert.equal(r.store.queuePending(),2);
  const result=r.processJobs();
  assert.equal(result.processed,1);assert.equal(result.pending,1);
  assert.equal(r.memory(receipt.memory_id).handoff,HANDOFF[5]);
  assert.equal(r.store.getSource(receipt.source_id).text,'你好');
  assert.equal(r.store.all(receipt.scope).filter(m=>m.kind==='experience').length,0);
  assert.ok(r.store.sql("SELECT json FROM module_activity WHERE id='capacity-warning'").get());
});

test('catalog handoff errors stop retrying at the attempt limit and finish their failed trace',t=>{
  const r=new V5Runtime();t.after(()=>r.close());
  const text='合成来源：目录交接异常后仍须逐字保留。',receipt=r.ingest({text}),rebuild=r.rebuildCatalogs.bind(r);
  r.rebuildCatalogs=()=>{throw Error('synthetic catalog handoff failure');};
  for(let attempts=1;attempts<=4;attempts++){
    const result=r.processJobs(),job=r.store.sql('SELECT status,attempts FROM jobs WHERE memory_id=?').get(receipt.memory_id);
    assert.equal(job.attempts,attempts);assert.equal(job.status,attempts<4?'retry':'failed');
    assert.equal(result.pending,attempts<4?1:0);assert.equal(result.processed,0);
    assert.equal(r.trace(receipt.run_id).run.status,'failed');
    assert.equal(r.store.getSource(receipt.source_id).text,text);
  }
  r.rebuildCatalogs=rebuild;
  assert.deepEqual(r.processJobs(),{processed:0,pending:0});
  assert.equal(r.store.stats().failed,1);
});

test('a transient catalog failure still retries successfully without changing its original',t=>{
  const r=new V5Runtime();t.after(()=>r.close());
  const text='合成来源：一次目录异常后应正常交接。',receipt=r.ingest({text}),rebuild=r.rebuildCatalogs.bind(r);
  r.rebuildCatalogs=()=>{throw Error('synthetic transient failure');};
  assert.equal(r.processJobs().pending,1);
  r.rebuildCatalogs=rebuild;
  assert.deepEqual(r.processJobs(),{processed:1,pending:0});
  assert.equal(r.memory(receipt.memory_id).handoff,HANDOFF[5]);
  assert.equal(r.trace(receipt.run_id).run.status,'success');
  assert.equal(r.store.getSource(receipt.source_id).text,text);
});

test('CJK tokenization preserves normalized text and Unicode code point boundaries',()=>{
  assert.deepEqual(retrievalTokens('猫 你好 𠀀𠀁𠀂 ひらがな カタカナ ＢＭ２５ Ｃａｆé'),['猫','你好','𠀀𠀁','𠀁𠀂','ひら','らが','がな','カタ','タカ','カナ','bm25','café']);
  const text='你好世界'.repeat(2000),tokens=retrievalTokens(text);
  assert.equal(tokens.length,text.length-1);
  assert.deepEqual(tokens.slice(0,4),['你好','好世','世界','界你']);
  assert.equal(tokens.at(-1),'世界');
});
