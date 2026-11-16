// Isolated synthetic benchmark. Never reads Aurabot, user databases, or model credentials.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { V5Runtime } from '../core/v5-runtime.js';

const count = Number(process.env.THINKSTAR_BENCH_RECORDS ?? 5000);
assert.ok(Number.isSafeInteger(count) && count >= 100 && count <= 20000);
const folder = mkdtempSync(join(tmpdir(), 'thinkstar-benchmark-'));
const runtime = new V5Runtime({ file: join(folder, 'synthetic.sqlite') });
const result = { synthetic: true, records: count, node: process.version, logical_cpus: cpus().length, operations: {} };
function measure(name, iterations, action) {
  const times = [], cpu = process.cpuUsage(), start = performance.now();
  for (let i = 0; i < iterations; i++) { const at = performance.now(); action(i); times.push(performance.now() - at); }
  const elapsed = performance.now() - start, used = process.cpuUsage(cpu);
  times.sort((a, b) => a - b);
  result.operations[name] = { iterations, wall_ms: +elapsed.toFixed(2), cpu_ms: +((used.user + used.system) / 1000).toFixed(2), p50_ms: +times[Math.floor(times.length * .5)].toFixed(3), p95_ms: +times[Math.min(times.length - 1, Math.floor(times.length * .95))].toFixed(3) };
}
try {
  const context = { persona_id: 'synthetic-benchmark', scope: 'private:synthetic-benchmark' };
  const scope = runtime.addScope(context).id, now = Date.now();
  measure('seed', 1, () => runtime.importPartitions([{ context, sources: Array.from({ length: count }, (_, i) => ({ id: `benchmark:${i}`, chat_id: context.scope, speaker_id: 'synthetic', role: 'user', sequence: i + 1, text: `合成材料编号${i}，普通聊天细节与精确数字${100000 + i}。`, occurred_at: now - i * 60000, time_precision: 'instant', provenance: { system: 'synthetic-benchmark' } })), memories: [], relations: [] }]));
  const protectedInput = runtime.ingest({ scope, text: '务必记住：合成预算为314159万元，不能改成其它数字。', process: true });
  // The baseline intentionally uses the previous heartbeat fallback when queuePending is absent.
  measure('heartbeat_pending', 1000, () => runtime.store.queuePending?.() ?? runtime.store.stats().pending);
  measure('overview', 12, () => runtime.overview());
  measure('graph', 12, () => runtime.graph({ scope }));
  measure('recall', 12, () => {
    const recall = runtime.query({ scope, query: '314159万元', use: false });
    assert.ok(recall.context.some(item => item.text.includes('314159')));
  });
  measure('ingest_and_handoff', 12, i => runtime.ingest({ scope, text: `合成追加记录${i}，保持原文和六阶段交接。`, process: true }));
  assert.match(runtime.body(runtime.memory(protectedInput.memory_id)), /314159/);
  const idleCpu = process.cpuUsage(), idleStart = performance.now();
  await new Promise(resolve => setTimeout(resolve, 5000));
  const idleUsed = process.cpuUsage(idleCpu), idleMs = performance.now() - idleStart;
  result.idle = { seconds: +(idleMs / 1000).toFixed(2), cpu_ms: +((idleUsed.user + idleUsed.system) / 1000).toFixed(2), note: 'Core with no work; excludes host timers, browser, and other plugins.' };
  result.memory = { rss_mib: +(process.memoryUsage().rss / 1048576).toFixed(1), peak_rss_mib: +(process.resourceUsage().maxRSS / 1024).toFixed(1), database_mib: +(runtime.store.stats().bytes / 1048576).toFixed(1) };
  result.integrity = 'protected original and exact retrieval preserved';
  console.log(JSON.stringify(result, null, 2));
} finally {
  runtime.close();
  assert.equal(dirname(resolve(folder)),resolve(tmpdir()));
  assert.ok(folder.split(/[\\/]/).at(-1).startsWith('thinkstar-benchmark-'));
  rmSync(folder, { recursive: true, force: true });
}
