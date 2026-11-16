// Isolated synthetic storage/retrieval check, not a production latency benchmark.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { V5Runtime } from '../core/v5-runtime.js';

const count = Number(process.env.THINKSTAR_SCALE_RECORDS ?? 100000);
assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 100000);
const runtime = new V5Runtime();
try {
  const context = { persona_id: 'synthetic-scale', scope: 'group:synthetic-scale' };
  const protectedInput = runtime.ingest({ context, text: '预算为 314159 万元，不能用另一数字替换。', process: true });
  const started = performance.now();
  const sources = Array.from({ length: count }, (_, i) => ({ id: `ordinary:${i}`, chat_id: context.scope, speaker_id: 'synthetic-other', role: 'user', sequence: i + 1, text: `普通合成材料编号 ${i}`, occurred_at: Date.now() + i, time_precision: 'instant', provenance: { system: 'synthetic-scale' } }));
  runtime.importPartitions([{ context, sources, memories: [], relations: [] }]);
  const queryStarted = performance.now();
  const result = runtime.query({ scope: protectedInput.scope, query: '314159 万元', use: false });
  const queryMs = performance.now()-queryStarted;
  assert.ok(result.candidates.some(c => runtime.memory(c.id).source_refs.includes(protectedInput.source_id)));
  assert.ok(result.context.some(c => c.text.includes('314159 万元')));
  assert.match(runtime.body(runtime.memory(protectedInput.memory_id)), /314159 万元/);
  assert.equal(runtime.memory(protectedInput.memory_id).protection, 'P1');
  const directory = runtime.store.catalogs(protectedInput.scope, 'M2');
  assert.ok(directory.some(c => (c.semantic_refs ?? []).some(id => runtime.memory(id).protection === 'P1')));
  console.log(JSON.stringify({ passed: true, ordinary_records: count, protected_original: 'byte-preserved', exact_retrieval: 'hit', duration_ms: Math.round(performance.now() - started), bytes: runtime.store.stats().bytes, query_ms: Math.round(queryMs), rss_mib: +(process.memoryUsage().rss/1048576).toFixed(1), peak_rss_mib: +(process.resourceUsage().maxRSS/1024).toFixed(1), ambiguous_model_answer_quality: 'not_measured' }));
} finally {
  runtime.close();
}
