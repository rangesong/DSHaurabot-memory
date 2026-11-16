import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { fingerprintCapture, readAurabot, readSqliteCopy, sha256 } from '../adapters/aurabot/reader.js';
import { createImportStore, mapAurabot } from '../adapters/aurabot/mapper.js';
import { importAurabot } from '../scripts/import-aurabot.js';
import { MemoryService } from '../core/memory-service.js';
import { projectGraph } from '../core/graph-projector.js';

const runtime = fileURLToPath(new URL('../runtime-data/', import.meta.url));
const at = 1794362400000;
const row = (extra = {}) => ({ t: at, chatId: 'private:100', who: '合成用户', uid: '100', text: '只存在于测试夹具的原话', ...extra });
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value), 'utf8'); };

function fixture(t) {
  mkdirSync(runtime, { recursive: true });
  const directory = resolve(mkdtempSync(join(runtime, 'aurabot-test-')));
  const source = join(directory, 'source'); const output = join(directory, 'output'); const closers = [];
  mkdirSync(source); mkdirSync(join(source, 'chatlog'));
  t.after(() => {
    for (const db of closers) db.close();
    assert.equal(dirname(directory), resolve(runtime)); assert.ok(basename(directory).startsWith('aurabot-test-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, source, output, copies: join(output, 'copies'), closers };
}

function treeHashes(directory) {
  const result = {};
  const walk = (root, prefix = '') => {
    for (const item of readdirSync(root, { withFileTypes: true })) {
      const name = prefix + item.name;
      if (item.isDirectory()) walk(join(root, item.name), name + '/');
      else result[name] = sha256(readFileSync(join(root, item.name)));
    }
  };
  walk(directory); return result;
}

function memoryDatabase(f, { keepOpen = false } = {}) {
  const db = new DatabaseSync(join(f.source, 'memory.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE items(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE gists(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE kv(key TEXT PRIMARY KEY,json TEXT NOT NULL)');
  const item = db.prepare('INSERT INTO items VALUES (?,?)');
  item.run('legacy-1', JSON.stringify({ id: 'legacy-1', text: '只在测试中的旧记忆', about: '100', aboutName: '合成用户', chatId: 'private:100', at, source: 'auto', tier: 0, related: ['legacy-3'] }));
  item.run('legacy-3', JSON.stringify({ id: 'legacy-3', text: '不同范围的旧经历', chatId: 'group:200', at, source: 'event' }));
  item.run('excluded', JSON.stringify({ id: 'excluded', text: 'EXCLUDED_MEMORY_SENTINEL', about: '999', chatId: 'private:999', at }));
  const kv = db.prepare('INSERT INTO kv VALUES (?,?)');
  kv.run('profiles', JSON.stringify({ 100: { name: '合成用户', text: '机器人生成的测试档案', at }, 999: { noMemory: true, text: 'EXCLUDED_PROFILE_SENTINEL' } }));
  kv.run('insights', JSON.stringify({ 'qq:100': [{ text: '合成情境下的交流经验', at }], 'qq:999': [{ text: 'EXCLUDED_PATTERN_SENTINEL' }] }));
  kv.run('styles', JSON.stringify({ self: ['合成说话习惯'] }));
  if (keepOpen) f.closers.push(db); else db.close();
  return db;
}

function dailyFiles(f) {
  const rows = [row(), row({ who: 'bot', uid: '', t: at + 1, text: '合成助手回复' }), row({ t: at + 2, text: 'x'.repeat(500) }),
    row({ t: at + 3, text: '' }), row({ t: at + 4, who: '系统', uid: '', text: '合成系统通知' }),
    row({ t: at + 5, forgottenAt: at + 6, text: 'FORGOTTEN_TEXT_SENTINEL' }), row({ uid: '999', text: 'EXCLUDED_CHAT_SENTINEL' })];
  writeFileSync(join(f.source, 'chatlog', '2026-11-11.jsonl'), rows.map((value) => JSON.stringify(value)).join('\n') + '\n', 'utf8');
  write(join(f.source, 'diary.json'), { plan: { day: '2026-11-11', times: ['12:00'], done: ['12:00'] }, history: [
    { at, text: '这是一篇试运行日记', ok: true, dryRun: true, tid: '', visibility: 'all' },
    { at: at + 1, text: '发布状态仍需真实回执确认', ok: true, dryRun: false, tid: 'native-tid' },
  ] });
  write(join(f.source, 'mood.json'), { value: 1, at, reason: '合成角色表达', history: [{ at, from: 0, to: 1, reason: '合成状态理由' }] });
  write(join(f.source, 'recall-log.json'), [
    { at, where: 'private:100（翻记忆）', query: '合成查询', shown: ['legacy-1'], hits: [{ id: 'legacy-1', text: '只在测试中的旧记忆', score: 4.2, why: ['合成词'] }, { id: 'legacy-3', text: 'CROSS_SCOPE_TEXT_SENTINEL', score: 0.9 }] },
    { at: at + 1, where: 'private:100', query: '没有 shown 的合成查询', hits: [{ id: 'legacy-1', text: '只在测试中的旧记忆', score: 0.5 }] },
  ]);
  write(join(f.source, 'config.json'), { apiKey: 'CREDENTIAL_SENTINEL_MUST_NOT_BE_READ' });
}

test('reader preserves the source tree including live WAL/SHM and never includes config credentials', async (t) => {
  const f = fixture(t); dailyFiles(f); memoryDatabase(f, { keepOpen: true });
  assert.ok(existsSync(join(f.source, 'memory.sqlite-wal')));
  const before = treeHashes(f.source);
  const capture = await readAurabot({ root: f.source, snapshotDirectory: f.copies });
  assert.deepEqual(treeHashes(f.source), before);
  assert.equal(capture.memory.items.length, 3);
  assert.ok(capture.manifest.find((entry) => entry.name === 'memory.sqlite').wal_bytes > 0);
  assert.ok(!JSON.stringify(capture).includes('CREDENTIAL_SENTINEL'));
  assert.equal(capture.fingerprint, fingerprintCapture(capture));
});

test('database capture retries a changed DB/WAL and includes the later committed transaction', async (t) => {
  const f = fixture(t); const db = memoryDatabase(f, { keepOpen: true }); let calls = 0;
  const result = await readSqliteCopy({ root: f.source, name: 'memory.sqlite', snapshotDirectory: f.copies,
    betweenCaptures: () => { if (calls++ === 0) db.prepare('INSERT INTO items VALUES (?,?)').run('new', JSON.stringify({ id: 'new', text: '稍后提交的测试条目' })); } },
  (copy) => copy.prepare('SELECT count(*) AS count FROM items').get().count);
  assert.equal(result.data, 4); assert.equal(calls, 2);
});

test('continually changing capture fails explicitly without accepting a mismatched database/WAL pair', async (t) => {
  const f = fixture(t); const db = memoryDatabase(f, { keepOpen: true });
  await assert.rejects(() => readSqliteCopy({ root: f.source, name: 'memory.sqlite', snapshotDirectory: f.copies, attempts: 2,
    betweenCaptures: (index) => db.prepare('INSERT INTO items VALUES (?,?)').run(`race-${index}`, '{}') }, () => null), { code: 'SOURCE_BUSY' });
  assert.equal(existsSync(f.copies), false);
});

test('reader rejects output overlap and path traversal before creating source-side files', async (t) => {
  const f = fixture(t); dailyFiles(f); const before = treeHashes(f.source);
  await assert.rejects(() => readAurabot({ root: f.source, snapshotDirectory: join(f.source, 'forbidden') }), { code: 'OUTPUT_OVERLAP' });
  await assert.rejects(() => readSqliteCopy({ root: f.source, name: '../elsewhere.sqlite', snapshotDirectory: f.copies }, () => null), { code: 'SOURCE_PATH_ESCAPE' });
  assert.deepEqual(treeHashes(f.source), before);
});

test('partial JSONL tails and invalid lines are reported without inventing committed messages', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'chatlog', '2026-11-11.jsonl'), JSON.stringify(row()) + '\nBROKEN\n' + JSON.stringify(row({ t: at + 1 })), 'utf8');
  const capture = await readAurabot({ root: f.source, snapshotDirectory: f.copies, includeDatabases: false });
  assert.equal(capture.chatlogs[0].records.length, 1);
  assert.deepEqual(capture.issues.map((issue) => issue.code), ['INVALID_JSON_LINE', 'UNCOMMITTED_TAIL']);
  assert.equal(capture.manifest[0].complete, false);
});

test('real-source mapping preserves raw fidelity and uncertainty instead of turning every row into a fact', async (t) => {
  const f = fixture(t); dailyFiles(f); memoryDatabase(f);
  const mapped = mapAurabot(await readAurabot({ root: f.source, snapshotDirectory: f.copies }));
  const serialized = JSON.stringify(mapped);
  for (const sentinel of ['FORGOTTEN_TEXT_SENTINEL', 'EXCLUDED_CHAT_SENTINEL', 'EXCLUDED_MEMORY_SENTINEL', 'EXCLUDED_PROFILE_SENTINEL', 'EXCLUDED_PATTERN_SENTINEL', 'CROSS_SCOPE_TEXT_SENTINEL']) assert.ok(!serialized.includes(sentinel), sentinel);
  assert.equal(mapped.report.chat_messages, 5);
  assert.equal(mapped.report.empty_text_records, 1);
  assert.equal(mapped.report.possible_truncation, 1);
  assert.equal(mapped.report.legacy_memories, 2);
  const store = createImportStore(mapped, { recordedAt: at + 1000 });
  const context = { persona_id: 'aurabot:persona-unattributed', scope: 'private:100' };
  const snapshot = store.readSnapshot(context);
  const long = snapshot.sources.find((entry) => entry.provenance.possible_truncation);
  assert.equal(long.text.length, 500);
  const empty = snapshot.sources.find((entry) => entry.provenance.text_is_placeholder);
  assert.equal(empty.provenance.original_text, ''); assert.equal(empty.provenance.content_state, 'no_text_in_source');
  assert.equal(snapshot.sources.find((entry) => entry.provenance.speaker_label === '系统').role, 'unknown');
  const legacy = snapshot.memories.find((entry) => entry.attributes.native_id === 'legacy-1');
  assert.equal(legacy.protection, 'P0'); assert.equal(legacy.review_status, 'needs_review'); assert.equal(legacy.evidence_status, 'inferred');
  const details = new MemoryService(store).getDetails(context, legacy.id);
  assert.equal(details.sources[0].provenance.relative_path, 'memory.sqlite');
  assert.equal(snapshot.relations.some((entry) => entry.from_id === legacy.id || entry.to_id === legacy.id), false);
});

test('dry-run diary, role mood, and recall assembly keep their original meanings', async (t) => {
  const f = fixture(t); dailyFiles(f); memoryDatabase(f);
  const mapped = mapAurabot(await readAurabot({ root: f.source, snapshotDirectory: f.copies }));
  const diaries = mapped.partitions.find((entry) => entry.context.scope === 'aurabot:diary');
  assert.equal(diaries.memories[0].attributes.delivery_status, 'simulated');
  assert.equal(diaries.memories[1].attributes.delivery_status, 'unknown');
  assert.ok(diaries.memories.every((entry) => entry.attributes.published_confirmed === false));
  assert.equal(mapped.partitions.find((entry) => entry.context.scope === 'aurabot:role-state').memories[0].attributes.proves_user_emotion, false);
  const recalls = mapped.observations.filter((entry) => entry.kind === 'legacy_recall');
  assert.equal(recalls[0].candidates[0].assembly, 'legacy_shown');
  assert.equal(recalls[0].candidates[1].canonical_id, null); assert.equal(recalls[0].candidates[1].text, null);
  assert.equal(recalls[1].candidates[0].assembly, 'unknown');
  assert.ok(recalls.every((entry) => entry.request_inclusion === 'unknown' && entry.actual_use === 'unknown'));
});

test('same captured data maps to stable IDs and honest per-scope graph counts', async (t) => {
  const f = fixture(t); dailyFiles(f); memoryDatabase(f);
  const first = await readAurabot({ root: f.source, snapshotDirectory: f.copies });
  const second = await readAurabot({ root: f.source, snapshotDirectory: f.copies });
  assert.equal(first.fingerprint, second.fingerprint);
  const a = mapAurabot(first); const b = mapAurabot(second);
  assert.deepEqual(a, b);
  const store = createImportStore(a, { recordedAt: at + 1000 });
  for (const partition of a.partitions) {
    const graph = projectGraph(store.readSnapshot(partition.context), { limit: 10000 });
    assert.equal(graph.counts.unique_objects, partition.memories.length);
    const ids = new Set(graph.nodes.map((entry) => entry.id));
    assert.equal(ids.size, graph.nodes.length);
    assert.ok(graph.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to)));
    assert.ok(store.readSnapshot(partition.context, { as_of: at }).memories.length === 0, 'Import time must not impersonate original historical knowledge');
  }
});

test('import publishes a complete local bundle, and replay reuses it without duplication or source access', async (t) => {
  const f = fixture(t); dailyFiles(f); memoryDatabase(f);
  const before = treeHashes(f.source);
  const initial = await importAurabot({ root: f.source, output: f.output, graphLimit: 100 });
  assert.equal(initial.reused, false);
  assert.equal(initial.report.source_coverage_complete_for_requested_files, true);
  assert.deepEqual(treeHashes(f.source), before);
  const pointerText = readFileSync(initial.pointer_path, 'utf8');
  // This path deliberately does not exist; replay must use its private captured input.
  const replay = await importAurabot({ root: join(f.directory, 'not-a-source'), output: f.output, replay: true, graphLimit: 100 });
  assert.equal(replay.reused, true);
  assert.equal(replay.report.mapping.memory_objects, initial.report.mapping.memory_objects);
  assert.equal(readFileSync(initial.pointer_path, 'utf8'), pointerText);
  const index = JSON.parse(readFileSync(join(f.output, initial.pointer.index), 'utf8'));
  assert.ok(index.contexts.length > 1);
  const graph = JSON.parse(readFileSync(join(f.output, initial.pointer.import_directory, index.contexts[0].graph), 'utf8'));
  assert.equal(graph.dataset_kind, 'aurabot'); assert.equal(graph.coverage.original_object_history_reconstructed, false);
});

test('damaged derived output is rebuilt; empty input does not replace a valid current import', async (t) => {
  const f = fixture(t); dailyFiles(f);
  const initial = await importAurabot({ root: f.source, output: f.output, includeDatabases: false });
  writeFileSync(join(f.output, initial.pointer.import_directory, 'store.json'), 'BROKEN', 'utf8');
  const rebuilt = await importAurabot({ output: f.output, replay: true });
  assert.equal(rebuilt.reused, false);
  assert.notEqual(rebuilt.pointer.import_directory, initial.pointer.import_directory);
  const pointer = readFileSync(rebuilt.pointer_path, 'utf8');
  const empty = join(f.directory, 'empty-source'); mkdirSync(empty);
  await assert.rejects(() => importAurabot({ root: empty, output: f.output, includeDatabases: false }), { code: 'NO_DATA' });
  assert.equal(readFileSync(rebuilt.pointer_path, 'utf8'), pointer);
});

test('tampering with captured input is detected, and failed replay preserves the current pointer', async (t) => {
  const f = fixture(t); dailyFiles(f);
  const initial = await importAurabot({ root: f.source, output: f.output, includeDatabases: false });
  const captureFile = join(f.output, initial.pointer.import_directory, 'captured-input.json');
  const captured = JSON.parse(readFileSync(captureFile, 'utf8'));
  captured.chatlogs[0].records[0].value.text = '篡改测试夹具'; write(captureFile, captured);
  const pointer = readFileSync(initial.pointer_path, 'utf8');
  await assert.rejects(() => importAurabot({ output: f.output, replay: true }), { code: 'CAPTURE_CHANGED' });
  assert.equal(readFileSync(initial.pointer_path, 'utf8'), pointer);
});
