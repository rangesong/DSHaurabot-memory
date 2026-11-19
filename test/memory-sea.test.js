import {testRuntimeRoot} from '../scripts/lib/test-workspace.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { contextKey } from '../core/model.js';
import { prepareSource, prepareMemory, prepareRelation } from '../core/memory-service.js';
import { AurabotViewProvider } from '../adapters/aurabot/view-provider.js';
import { createMemorySeaServer } from '../scripts/serve-memory-sea.js';
import { Camera } from '../apps/memory-sea/src/camera.js';
import { StarLayout } from '../apps/memory-sea/src/layout.js';

const runtime = testRuntimeRoot(fileURLToPath(new URL('../runtime-data/', import.meta.url)));
const revision = 'a'.repeat(64), importDirectory = `imports/${revision.slice(0, 24)}-12345678`;
const keyFor = (context) => createHash('sha256').update(contextKey(context)).digest('hex').slice(0, 24);
function fixture(t) {
  mkdirSync(runtime, { recursive: true }); const output = mkdtempSync(join(runtime, 'sea-test-')); const directory = join(output, importDirectory);
  mkdirSync(join(directory, 'details'), { recursive: true });
  t.after(() => { assert.equal(dirname(output), resolve(runtime)); assert.ok(basename(output).startsWith('sea-test-')); rmSync(output, { recursive: true, force: true }); });
  const write = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value));
  const contexts = ['private:alpha', 'group:beta'].map((scope) => ({ persona_id: 'fixture', scope }));
  const snapshots = contexts.map((context, index) => {
    const sources = Array.from({ length: 25 }, (_, i) => prepareSource(context, { id: `source:${i}`, chat_id: context.scope, speaker_id: 'fixture', role: 'user', sequence: i + 1,
      text: `${index ? 'SECOND_SCOPE' : 'FIRST_SCOPE'} 原话 ${i === 24 ? '隐藏在末页的关键词' : i}`, occurred_at: 100 + i }, 1000));
    const memories = [prepareMemory(context, { id: 'shared-id', kind: 'conversation', label: '测试对话', body: '这不是实际用户内容', source_refs: sources.map((s) => s.id), occurred_at: 100 }, 1000),
      prepareMemory(context, { id: 'unknown-time', kind: 'person', label: '合成人物', body: '时间未知', source_refs: ['source:0'] }, 1000),
      prepareMemory(context, { id: 'historical', kind: 'claim', label: '历史适用', body: '必须带状态浏览', source_refs: ['source:1'], occurred_at: 500, validity: 'historical' }, 1000)];
    const relations = [prepareRelation(context, { id: 'link', from_id: 'shared-id', to_id: 'unknown-time', relation_type: 'mentions', source_refs: ['source:0'] }, 1000)];
    const snapshot = { context, sequence: 1, recorded_at: 1000, sources, memories, relations }; write(`details/${keyFor(context)}.json`, snapshot); return snapshot;
  });
  write('index.json', { import_fingerprint: revision, imported_at: 1000, contexts: contexts.map((context) => ({ context, details: `details/${keyFor(context)}.json`, counts: { available_objects: 3 } })), observations: 'observations.json' });
  write('report.json', { import_fingerprint: revision, mapping: { source_records: 50, memory_objects: 6, contexts: 2, relations: 2, issues: [] } });
  write('observations.json', { observations: contexts.map((context, i) => ({ id: `recall:${i}`, kind: 'legacy_recall', scope: context.scope, occurred_at: 100 + i, candidates: [], actual_use: 'unknown' })) });
  writeFileSync(join(output, 'current.json'), JSON.stringify({ dataset_kind: 'aurabot', import_directory: importDirectory, import_fingerprint: revision }));
  return { output, directory, contexts, snapshots, keys: contexts.map(keyFor), provider: new AurabotViewProvider(output) };
}

test('viewer namespaces identical IDs, preserves historical badges, and never creates cross-scope edges', (t) => {
  const f = fixture(t); const before = readFileSync(join(f.directory, 'details', `${f.keys[0]}.json`), 'utf8');
  assert.equal(f.provider.overview().stats.memory_objects, 6);
  const graph = f.provider.graph(); const nodes = graph.nodes.filter((n) => n.node_type === 'memory');
  assert.equal(nodes.length, 6); assert.equal(new Set(nodes.map((n) => n.id)).size, 6);
  assert.equal(nodes.filter((n) => n.badges.some((b) => b.label === '历史适用')).length, 2);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const edge of graph.edges.filter((e) => e.layer === 'content')) assert.equal(byId.get(edge.from).context_key, byId.get(edge.to).context_key);
  assert.ok(nodes.every((n) => n.activation === null));
  assert.equal(graph.regions.find((r) => r.id === 'M5').count, 0);
  f.provider.detail({ scope: f.keys[0], id: 'shared-id' }); f.provider.recalls();
  assert.equal(readFileSync(join(f.directory, 'details', `${f.keys[0]}.json`), 'utf8'), before);
});

test('viewer searches all source pages and filters region/time while retaining unknown timestamps', (t) => {
  const f = fixture(t), p = f.provider;
  assert.equal(p.graph({ q: '隐藏在末页的关键词' }).counts.matching, 2);
  assert.equal(p.graph({ scope: f.keys[0], q: 'SECOND_SCOPE' }).counts.matching, 0);
  assert.equal(p.graph({ region: 'M1' }).counts.matching, 2);
  assert.equal(p.graph({ until: 99 }).counts.matching, 2);
  assert.equal(p.graph({ until: 99 }).counts.unknown_time, 2);
  assert.equal(p.graph({ limit: 0 }).nodes.filter((n) => n.node_type === 'memory').length, 0);
  const focused = p.graph({ limit: 1, focus_context: f.keys[1], focus_id: 'unknown-time' }).nodes.find((n) => n.node_type === 'memory');
  assert.equal(focused.canonical_id, 'unknown-time'); assert.equal(focused.context_key, f.keys[1]);
  assert.throws(() => p.graph({ scope: 'foreign' }), { code: 'NOT_FOUND' });
  assert.throws(() => p.graph({ limit: 501 }), { code: 'INVALID_QUERY' });
});

test('detail and source pages require matching scope/revision and return exact ordered text', (t) => {
  const f = fixture(t), p = f.provider;
  const detail = p.detail({ scope: f.keys[0], id: 'shared-id', revision });
  assert.equal(detail.source_page.sources.length, 20); assert.equal(detail.source_page.total, 25);
  const page = p.sources({ scope: f.keys[0], id: 'shared-id', revision, offset: 20 });
  assert.deepEqual(page.sources.map((s) => s.text), f.snapshots[0].sources.slice(20).map((s) => s.text));
  assert.equal(page.has_more, false); assert.equal(page.next_offset, 25);
  assert.equal(p.sources({ scope: f.keys[0], id: 'shared-id', until: 103 }).total, 4);
  assert.equal(p.detail({ scope: f.keys[1], id: 'shared-id' }).source_page.sources[0].text.startsWith('SECOND_SCOPE'), true);
  assert.throws(() => p.detail({ scope: f.keys[0], id: 'shared-id', revision: 'stale' }), { code: 'IMPORT_CHANGED' });
  assert.throws(() => p.detail({ scope: f.keys[0], id: 'missing' }), { code: 'NOT_FOUND' });
  assert.equal(p.recalls({ scope: f.keys[0] }).observations.length, 1);
  assert.equal(p.recalls({ scope: f.keys[0] }).observations[0].actual_use, 'unknown');
});

test('local server exposes only read endpoints and allowlisted app files', async (t) => {
  const f = fixture(t), server = createMemorySeaServer({ provider: f.provider });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const app = await fetch(base); assert.equal(app.status, 200); assert.match(await app.text(), /sea-canvas/);
  assert.match(app.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const file of ['/src/main.js', '/src/renderer.js', '/styles.css']) assert.equal((await fetch(base + file)).status, 200);
  for (const file of ['/runtime-data/aurabot/current.json', '/adapters/aurabot/reader.js', '/src/../package.json']) assert.equal((await fetch(base + file)).status, 404);
  assert.equal((await fetch(base + '/api/overview', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/api/overview', { headers: { origin: 'https://foreign.test' } })).status, 403);
  assert.equal((await fetch(base + '/api/overview', { headers: { host: 'foreign.test', 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(base + '/api/graph?scope=foreign')).status, 404);
  assert.equal((await fetch(base + '/api/graph?limit=NaN')).status, 400);
  assert.equal((await fetch(`${base}/api/detail?scope=${f.keys[0]}&id=shared-id&revision=stale`)).status, 409);
  const graph = await (await fetch(base + '/api/graph')).json(); assert.equal(graph.counts.visible, 6);
});

test('layouts and camera preserve canonical graph data through rotation, focus and mode changes', (t) => {
  const f = fixture(t), graph = f.provider.graph(), before = structuredClone(graph), layout = new StarLayout();
  layout.update(graph); for (let i = 0; i < 50; i++) layout.step();
  const memory = layout.points.find((n) => n.node_type === 'memory'); assert.ok([memory.x, memory.y, memory.z].every(Number.isFinite));
  const camera = new Camera(), a = camera.project(memory, 900, 700); camera.rotate(100, 70); const b = camera.project(memory, 900, 700); assert.notEqual(a.x, b.x);
  camera.focus(memory); for (let i = 0; i < 150; i++) camera.tick(); const center = camera.project(memory, 900, 700); assert.ok(Math.abs(center.x - 450) < 2);
  camera.scale(100); assert.ok(camera.zoom <= 4.5); camera.scale(.0001); assert.ok(camera.zoom >= .35);
  layout.update(graph, 'galaxy'); assert.equal(layout.points.filter((n) => !n.fixed).length, 6); assert.deepEqual(graph, before);
});
