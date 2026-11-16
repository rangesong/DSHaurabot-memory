import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { MemoryService } from '../core/memory-service.js';
import { projectGraph } from '../core/graph-projector.js';
import { applyDemo, BEFORE_CORRECTION, CORRECTION_TIME, DEMO_CONTEXT, DEMO_STEPS } from '../fixtures/memory-sea-demo.js';

const C = Object.freeze({ persona_id: 'test-persona', scope: 'private:test' });

function harness(options = {}) {
  let at = 1000;
  const store = new MemoryStore({ clock: () => at, ...options });
  return { store, service: new MemoryService(store), setTime: (value) => { at = value; } };
}

function ingest(h, { id = 'src:one', sequence = 1, role = 'user', text = '原始选择：300 个节点', context = C } = {}) {
  return h.service.ingestSource(context, { command_id: `ingest:${id}`, record: { id, chat_id: 'private:test', speaker_id: 'test-speaker', role, sequence, text } });
}

function claim(h, { id = 'mem:choice', source_refs = ['src:one'], context = C, ...extra } = {}) {
  return h.service.createMemory(context, { command_id: `create:${id}`, memory: { id, kind: 'claim', label: '初始节点选择', body: '先显示 300 个节点', source_refs, ...extra } });
}

function demo() {
  const h = harness();
  applyDemo(h.service, { beforeStep: (step) => h.setTime(step.at) });
  return h;
}

const errorCode = (code) => ({ code });

test('correction changes the current choice while preserving exact original sources and historical evidence', () => {
  const h = demo();
  const current = h.service.getDetails(DEMO_CONTEXT, 'mem:node-budget');
  assert.equal(current.memory.attributes.node_budget, 200);
  assert.equal(current.memory.revision, 2);
  assert.deepEqual(current.sources.map((item) => item.id), ['src:correction']);
  assert.deepEqual(current.history.map((item) => item.value.source_refs), [['src:initial'], ['src:correction']]);
  const old = h.service.getDetails(DEMO_CONTEXT, 'mem:node-budget', { as_of: BEFORE_CORRECTION });
  assert.equal(old.memory.attributes.node_budget, 300);
  assert.equal(old.history.length, 1);
  assert.ok(h.store.readSnapshot(DEMO_CONTEXT).sources.find((item) => item.id === 'src:initial').text.includes('300'));
  assert.equal(h.service.getMemory(DEMO_CONTEXT, 'mem:budget-note').review_status, 'needs_review');
});

test('reusing the same command after other commits returns its original receipt without rewriting history', () => {
  const h = demo(); const before = h.store.exportData();
  const correction = DEMO_STEPS.find((step) => step.id === 'correct-decision');
  const replay = h.service.reviseMemory(DEMO_CONTEXT, { command_id: `demo:${correction.id}`, ...structuredClone(correction.input) });
  assert.equal(replay.replayed, true);
  assert.equal(replay.sequence, 9);
  assert.deepEqual(h.store.exportData(), before);
});

test('command ID reuse with different content is rejected even if the original expected version is old', () => {
  const h = demo(); const before = h.store.exportData();
  const correction = structuredClone(DEMO_STEPS.find((step) => step.id === 'correct-decision').input);
  correction.patch.label = '把原命令改成另一个意思';
  assert.throws(() => h.service.reviseMemory(DEMO_CONTEXT, { command_id: 'demo:correct-decision', ...correction }), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(h.store.exportData(), before);
});

test('a stale background/user revision cannot overwrite the latest correction or its dependents', () => {
  const h = demo(); const before = h.store.exportData(); h.setTime(CORRECTION_TIME + 999_999_999);
  assert.throws(() => h.service.reviseMemory(DEMO_CONTEXT, { command_id: 'stale-edit', id: 'mem:node-budget', expected_revision: 1,
    patch: { body: '错误地写回 300' }, evidence_source_refs: ['src:initial'] }), errorCode('REVISION_CONFLICT'));
  assert.deepEqual(h.store.exportData(), before);
});

test('invalid references roll back an entire multi-object transaction', () => {
  const h = harness(); ingest(h); claim(h); const before = h.store.exportData();
  assert.throws(() => h.store.transact({ context: C, command_id: 'broken-batch', request: { operation: 'test-batch' } }, (snapshot, at) => [
    { entity_type: 'source', expected_revision: null, value: { ...snapshot.sources[0], id: 'src:new', sequence: 2, recorded_at: at, updated_at: at } },
    { entity_type: 'memory', expected_revision: null, value: { ...snapshot.memories[0], id: 'mem:new', source_refs: ['src:absent'], recorded_at: at, updated_at: at } },
  ]), errorCode('MISSING_SOURCE'));
  assert.deepEqual(h.store.exportData(), before);
  assert.equal(h.store.readSnapshot(C).sources.length, 1);
});

test('failed durable persistence publishes neither state nor command receipt, and a retry can succeed', () => {
  let fail = true; let persisted;
  const h = harness({ persist: (data) => { if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); persisted = data; } });
  assert.throws(() => ingest(h), errorCode('ENOSPC'));
  assert.equal(h.store.readSnapshot(C).sequence, 0);
  assert.equal(h.store.exportData().transactions.length, 0);
  fail = false;
  const receipt = ingest(h);
  assert.equal(receipt.replayed, false);
  assert.equal(receipt.sequence, 1);
  assert.equal(persisted.transactions.length, 1);
});

test('export/import preserves revisions, scope-local order, old snapshots, and command idempotency', () => {
  const h = demo();
  const backup = JSON.parse(JSON.stringify(h.store.exportData()));
  const restored = harness({ data: backup });
  assert.deepEqual(restored.store.readSnapshot(DEMO_CONTEXT), h.store.readSnapshot(DEMO_CONTEXT));
  assert.equal(restored.service.getMemory(DEMO_CONTEXT, 'mem:node-budget', { as_of: BEFORE_CORRECTION }).attributes.node_budget, 300);
  const receipts = applyDemo(restored.service);
  assert.ok(receipts.every((item) => item.replayed));
  assert.equal(restored.store.exportData().transactions.length, DEMO_STEPS.length);
});

test('corrupt transaction history is rejected instead of loading a plausible partial/empty state', () => {
  const h = demo(); const backup = h.store.exportData();
  backup.transactions[1].changes[0].value.revision = 7;
  assert.throws(() => new MemoryStore({ data: backup }), errorCode('INVALID_REVISION'));
  const reordered = h.store.exportData(); [reordered.transactions[0], reordered.transactions[1]] = [reordered.transactions[1], reordered.transactions[0]];
  assert.throws(() => new MemoryStore({ data: reordered }), errorCode('INVALID_STORE'));
});

test('separate scopes/personas may use the same local IDs without exposing other content or sequence counts', () => {
  const h = harness(); const other = { ...C, scope: 'private:other' }; const persona = { ...C, persona_id: 'other-persona' };
  ingest(h); claim(h);
  ingest(h, { context: other, text: '另一个空间的私人内容' }); claim(h, { context: other, body: '另一个空间的结论' });
  ingest(h, { context: persona, text: '另一个人格的内容' });
  assert.equal(h.store.readSnapshot(C).sequence, 2);
  assert.equal(h.store.readSnapshot(other).sequence, 2);
  assert.equal(h.store.readSnapshot(persona).sequence, 1);
  assert.equal(h.service.getDetails(C, 'mem:choice').sources[0].text, '原始选择：300 个节点');
  const graph = projectGraph(h.store.readSnapshot(C), { include_sources: true });
  assert.equal(graph.counts.unique_objects, 1);
  assert.ok(!JSON.stringify(graph).includes('另一个空间'));
  assert.equal(h.store.getChanges(C).changes.length, 2);
});

test('objects cannot link to evidence or relation endpoints that exist only in another scope', () => {
  const h = harness(); ingest(h); claim(h);
  const other = { ...C, scope: 'private:other' };
  assert.throws(() => claim(h, { context: other }), errorCode('MISSING_SOURCE'));
  ingest(h, { context: other, id: 'src:other' });
  assert.throws(() => h.service.createRelation(other, { command_id: 'cross-scope-relation', relation: {
    id: 'rel:cross', from_id: 'mem:choice', to_id: 'mem:absent', relation_type: 'related_to', source_refs: ['src:other'],
  } }), errorCode('MISSING_ENDPOINT'));
  assert.throws(() => h.store.readSnapshot({}), errorCode('INVALID_DATA'));
});

test('original source text is append-only, with no silent shortening of long text or critical tail conditions', () => {
  const h = harness(); const long = '背景'.repeat(8000) + '；末尾关键条件：不是 300，而是 200。';
  ingest(h, { text: long }); claim(h);
  assert.equal(h.service.getDetails(C, 'mem:choice').sources[0].text, long);
  assert.throws(() => h.store.transact({ context: C, command_id: 'rewrite-raw', request: { operation: 'rewrite-source' } }, (snapshot, at) => [
    { entity_type: 'source', expected_revision: 1, value: { ...snapshot.sources[0], revision: 2, updated_at: at, text: '改写原话' } },
  ]), errorCode('IMMUTABLE_SOURCE'));
  assert.equal(h.store.readSnapshot(C).sources[0].text, long);
});

test('assistant output alone cannot become reported fact or a verified execution outcome', () => {
  const h = harness(); ingest(h, { role: 'assistant', text: '我猜测任务成功了' });
  assert.throws(() => claim(h), errorCode('UNSUPPORTED_EVIDENCE'));
  claim(h, { evidence_status: 'inferred' });
  assert.equal(h.service.getMemory(C, 'mem:choice').evidence_status, 'inferred');
  assert.throws(() => h.service.createMemory(C, { command_id: 'bad-method', memory: {
    id: 'mem:method', kind: 'method', label: '假定成功的方法', body: '未经真实结果确认', source_refs: ['src:one'], evidence_status: 'inferred',
    attributes: { verification: 'verified', environment: '某环境', success_criteria: '有真实成功结果', outcome_source_refs: ['src:one'] },
  } }), errorCode('UNSUPPORTED_OUTCOME'));
});

test('verified methods require conditions, criteria, and an explicitly referenced result', () => {
  const h = harness(); ingest(h);
  assert.throws(() => h.service.createMemory(C, { command_id: 'missing-result', memory: {
    id: 'mem:method', kind: 'method', label: '方法', body: '待验证方法', source_refs: ['src:one'], attributes: { verification: 'verified' },
  } }), errorCode('INVALID_DATA'));
  const d = demo(); const method = d.service.getMemory(DEMO_CONTEXT, 'mem:cache-method');
  assert.equal(method.attributes.verification, 'verified');
  assert.ok(method.attributes.environment.includes('200'));
  assert.deepEqual(method.attributes.untested_conditions, ['300 节点']);
  assert.equal(d.service.listOpenLoops(DEMO_CONTEXT)[0].attributes.status, 'waiting');
});

test('open loops retain unknown due dates and cannot be completed without result evidence', () => {
  const h = harness(); ingest(h);
  h.service.createMemory(C, { command_id: 'pending', memory: { id: 'mem:loop', kind: 'open_loop', label: '验证规模', body: '仍待验证', source_refs: ['src:one'], attributes: { status: 'waiting', due_at: null } } });
  assert.equal(h.service.listOpenLoops(C)[0].attributes.due_at, null);
  assert.throws(() => h.service.reviseMemory(C, { command_id: 'premature-complete', id: 'mem:loop', expected_revision: 1,
    patch: { attributes: { status: 'completed', due_at: null } }, evidence_source_refs: ['src:one'] }), errorCode('INVALID_DATA'));
  ingest(h, { id: 'src:done', sequence: 2, text: '用户明确报告测试已完成' });
  h.service.reviseMemory(C, { command_id: 'finish', id: 'mem:loop', expected_revision: 1,
    patch: { attributes: { status: 'completed', outcome_source_refs: ['src:done'], due_at: null } }, evidence_source_refs: ['src:done'] });
  assert.equal(h.service.listOpenLoops(C).length, 0);
});

test('a correction flags transitive derivations, but does not rewrite merely related memories', () => {
  const h = harness(); ingest(h); claim(h);
  h.service.createMemory(C, { command_id: 'derived', memory: { id: 'mem:derived', kind: 'knowledge', label: '阶段结论', body: '依赖旧选择的概括', source_refs: ['src:one'], basis_refs: [{ id: 'mem:choice', revision: 1 }], evidence_status: 'inferred' } });
  h.service.createMemory(C, { command_id: 'method', memory: { id: 'mem:method', kind: 'method', label: '基于阶段结论的方法', body: '待尝试', source_refs: ['src:one'], basis_refs: [{ id: 'mem:derived', revision: 1 }], attributes: { verification: 'untested' } } });
  claim(h, { id: 'mem:unrelated', body: '只有相似关系，不是派生结论' });
  h.service.createRelation(C, { command_id: 'similar', relation: { id: 'rel:similar', from_id: 'mem:choice', to_id: 'mem:unrelated', relation_type: 'related_to', source_refs: ['src:one'] } });
  ingest(h, { id: 'src:new', sequence: 2, text: '改成 200' });
  const result = h.service.reviseMemory(C, { command_id: 'correct', id: 'mem:choice', expected_revision: 1, patch: { body: '改成 200' }, evidence_source_refs: ['src:new'] });
  assert.equal(result.changes.length, 3);
  assert.equal(h.service.getMemory(C, 'mem:derived').review_status, 'needs_review');
  assert.equal(h.service.getMemory(C, 'mem:method').review_status, 'needs_review');
  assert.equal(h.service.getMemory(C, 'mem:unrelated').revision, 1);
  assert.equal(h.service.getMemory(C, 'mem:derived').body, '依赖旧选择的概括');
});

test('cyclic derivations and unreviewed stale dependencies are rejected atomically', () => {
  const h = harness(); ingest(h); claim(h);
  h.service.createMemory(C, { command_id: 'child', memory: { id: 'mem:child', kind: 'knowledge', label: '子结论', body: '依赖初始选择', source_refs: ['src:one'], basis_refs: [{ id: 'mem:choice', revision: 1 }] } });
  const before = h.store.exportData();
  assert.throws(() => h.service.reviseMemory(C, { command_id: 'cycle', id: 'mem:choice', expected_revision: 1,
    patch: { basis_refs: [{ id: 'mem:child', revision: 1 }], review_status: 'needs_review' }, evidence_source_refs: ['src:one'] }), errorCode('DEPENDENCY_CYCLE'));
  assert.deepEqual(h.store.exportData(), before);
  h.service.reviseMemory(C, { command_id: 'new-choice', id: 'mem:choice', expected_revision: 1, patch: { body: '新选择' }, evidence_source_refs: ['src:one'] });
  assert.throws(() => h.service.createMemory(C, { command_id: 'stale-child', memory: { id: 'mem:stale', kind: 'knowledge', label: '旧结论', body: '未复核', source_refs: ['src:one'], basis_refs: [{ id: 'mem:choice', revision: 1 }] } }), errorCode('STALE_BASIS'));
});

test('IDs and per-conversation source order cannot silently collide', () => {
  const h = harness(); ingest(h);
  assert.throws(() => ingest(h, { id: 'src:duplicate-order' }), errorCode('DUPLICATE_SEQUENCE'));
  assert.throws(() => claim(h, { id: 'src:one' }), errorCode('ALREADY_EXISTS'));
  assert.equal(h.store.readSnapshot(C).sequence, 1);
});

test('graph projection does not mutate input/store, counts canonical objects once, and has no dangling edges', () => {
  const h = demo(); const before = h.store.exportData(); const snapshot = h.store.readSnapshot(DEMO_CONTEXT); const copy = structuredClone(snapshot);
  const graph = projectGraph(snapshot, { include_sources: true });
  assert.equal(graph.counts.unique_objects, 6);
  assert.equal(graph.counts.region_anchors, 10);
  assert.equal(graph.counts.store_anchors, 1);
  assert.ok(graph.counts.projections > 0);
  const ids = new Set(graph.nodes.map((item) => item.id));
  assert.equal(ids.size, graph.nodes.length);
  assert.equal(new Set(graph.edges.map((item) => item.id)).size, graph.edges.length);
  assert.ok(graph.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to)));
  for (const projection of graph.nodes.filter((item) => item.node_type === 'projection')) {
    const main = graph.nodes.find((item) => item.id === projection.projection_of);
    assert.equal(main.canonical_id, projection.canonical_id); assert.equal(main.revision, projection.revision);
  }
  assert.deepEqual(projectGraph(snapshot, { include_sources: true }), graph);
  assert.deepEqual(snapshot, copy);
  assert.deepEqual(h.store.exportData(), before);
  assert.ok(graph.nodes.filter((item) => item.node_type === 'memory').every((item) => item.activation === null));
});

test('zero display budget and zero relation strength stay zero, with explicit omissions', () => {
  const h = demo(); const graph = projectGraph(h.store.readSnapshot(DEMO_CONTEXT), { limit: 0 });
  assert.equal(graph.counts.unique_objects, 0);
  assert.equal(graph.nodes.length, 11);
  assert.equal(graph.complete, false);
  assert.equal(graph.omitted_count, 6);
  assert.equal(graph.omitted_reason, 'display_limit');
  const all = projectGraph(h.store.readSnapshot(DEMO_CONTEXT));
  assert.equal(all.edges.find((item) => item.canonical_id === 'rel:canvas-experience').strength, 0);
});

test('evidence edge identities remain distinct when imported object IDs contain separators', () => {
  const h = harness();
  ingest(h, { id: 's:t', sequence: 1 }); ingest(h, { id: 't', sequence: 2 });
  claim(h, { id: 'm', source_refs: ['s:t'] }); claim(h, { id: 'm:s', source_refs: ['t'] });
  const graph = projectGraph(h.store.readSnapshot(C), { include_sources: true });
  const evidence = graph.edges.filter((item) => item.layer === 'evidence');
  assert.equal(evidence.length, 2);
  assert.equal(new Set(evidence.map((item) => item.id)).size, 2);
});

test('graph time snapshots do not show future corrections, methods, sources, or dependency warnings', () => {
  const h = demo();
  const graph = projectGraph(h.store.readSnapshot(DEMO_CONTEXT, { as_of: BEFORE_CORRECTION }), { include_sources: true });
  const choice = graph.nodes.find((item) => item.canonical_id === 'mem:node-budget');
  assert.equal(choice.revision, 1); assert.ok(choice.label.includes('300'));
  assert.ok(!graph.nodes.some((item) => item.canonical_id === 'mem:cache-method' || item.canonical_id === 'src:correction'));
  assert.ok(!graph.nodes.some((item) => item.badges?.some((badge) => badge.kind === 'review')));
  assert.equal(h.service.getMemory(DEMO_CONTEXT, 'mem:node-budget').revision, 2);
});

test('read snapshots and backups cannot be mutated to alter the store', () => {
  const h = harness(); ingest(h); claim(h);
  h.store.readSnapshot(C).memories[0].body = '外部篡改';
  h.store.exportData().transactions[0].changes[0].value.text = '外部篡改';
  const details = h.service.getDetails(C, 'mem:choice'); details.sources[0].text = '外部篡改';
  assert.equal(h.service.getMemory(C, 'mem:choice').body, '先显示 300 个节点');
  assert.equal(h.store.readSnapshot(C).sources[0].text, '原始选择：300 个节点');
});

test('change pagination respects scope, zero budget, and resumable cursors', () => {
  const h = demo();
  const zero = h.store.getChanges(DEMO_CONTEXT, { limit: 0 });
  assert.equal(zero.changes.length, 0); assert.equal(zero.complete, false); assert.equal(zero.next_after_sequence, 0);
  const first = h.store.getChanges(DEMO_CONTEXT, { limit: 3 });
  const rest = h.store.getChanges(DEMO_CONTEXT, { after_sequence: first.next_after_sequence });
  assert.equal(first.complete, false); assert.equal(rest.complete, true);
  assert.equal(first.changes.length + rest.changes.length, DEMO_STEPS.length);
  assert.throws(() => h.store.getChanges(DEMO_CONTEXT, { after_sequence: 999 }), errorCode('INVALID_CURSOR'));
});

test('timestamp zero and unknown occurrence are valid; clock regression cannot create a false past', () => {
  const h = harness(); h.setTime(0); ingest(h); claim(h);
  assert.equal(h.store.readSnapshot(C).recorded_at, 0);
  assert.equal(h.store.readSnapshot(C).sources[0].occurred_at, null);
  assert.equal(h.store.readSnapshot(C).sources[0].time_precision, 'unknown');
  h.setTime(10); ingest(h, { id: 'src:two', sequence: 2 });
  const before = h.store.exportData(); h.setTime(9);
  assert.throws(() => ingest(h, { id: 'src:three', sequence: 3 }), errorCode('CLOCK_REGRESSION'));
  assert.deepEqual(h.store.exportData(), before);
});

test('same-millisecond commits can be replayed separately by their atomic sequence', () => {
  const h = harness(); ingest(h); claim(h);
  assert.equal(h.store.readSnapshot(C, { through_sequence: 1 }).memories.length, 0);
  assert.equal(h.store.readSnapshot(C, { through_sequence: 2 }).memories.length, 1);
  assert.equal(h.store.readSnapshot(C, { as_of: 1000 }).sequence, 2);
});

test('imported source streams have independent sequence spaces and do not interleave daily records', () => {
  const h = harness();
  for (const [id, stream_id, sequence] of [['src:day1-2', '2026-11-11', 2], ['src:day2-1', '2026-11-12', 1], ['src:day1-1', '2026-11-11', 1]]) {
    h.service.ingestSource(C, { command_id: `stream:${id}`, record: { id, stream_id, sequence, chat_id: 'private:test', speaker_id: 'unknown', role: 'unknown', text: '来源身份未知的合成记录' } });
  }
  assert.deepEqual(h.service.listTimeline(C).map((entry) => entry.id), ['src:day1-1', 'src:day1-2', 'src:day2-1']);
  assert.throws(() => claim(h, { source_refs: ['src:day1-1'] }), { code: 'UNSUPPORTED_EVIDENCE' });
  claim(h, { source_refs: ['src:day1-1'], evidence_status: 'inferred' });
});
