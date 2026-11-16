import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { openJsonFileStore } from '../adapters/json-file-store.js';
import { MemoryService } from '../core/memory-service.js';

const C = { persona_id: 'test', scope: 'test:file-store' };
const source = (id = 'src:one') => ({ command_id: `ingest:${id}`, record: { id, chat_id: 'test:chat', speaker_id: 'fictional-user', role: 'user', sequence: 1, text: '文件恢复测试的合成原话' } });

function temporary(t) {
  const parent = resolve(tmpdir()); const root = resolve(mkdtempSync(join(parent, 'thinkstar-test-')));
  t.after(() => {
    // Verify the exact generated target before any recursive cleanup on Windows.
    assert.equal(dirname(root), parent); assert.ok(basename(root).startsWith('thinkstar-test-'));
    rmSync(root, { recursive: true, force: true });
  });
  return join(root, 'memory.json');
}

test('file persistence survives reopening and preserves idempotency receipts', (t) => {
  const file = temporary(t); const store = openJsonFileStore(file, { clock: () => 100 }); const service = new MemoryService(store);
  service.ingestSource(C, source());
  const reopened = openJsonFileStore(file, { clock: () => 0 }); const restored = new MemoryService(reopened);
  assert.deepEqual(reopened.readSnapshot(C), store.readSnapshot(C));
  assert.equal(restored.ingestSource(C, source()).replayed, true);
  assert.equal(reopened.readSnapshot(C).sequence, 1);
  assert.equal(existsSync(file + '.lock'), false);
});

test('a stale file-store instance cannot overwrite a newer writer', (t) => {
  const file = temporary(t);
  const first = openJsonFileStore(file, { clock: () => 100 }); const stale = openJsonFileStore(file, { clock: () => 100 });
  new MemoryService(first).ingestSource(C, source()); const committed = readFileSync(file, 'utf8');
  assert.throws(() => new MemoryService(stale).ingestSource(C, source('src:stale')), { code: 'STORE_CONFLICT' });
  assert.equal(stale.readSnapshot(C).sequence, 0);
  assert.equal(readFileSync(file, 'utf8'), committed);
  assert.equal(existsSync(file + '.lock'), false);
});

test('corrupt files are preserved and are never silently reset', (t) => {
  const file = temporary(t); const corrupt = '{"schema_version": 1, "transactions": [BROKEN';
  writeFileSync(file, corrupt, 'utf8');
  assert.throws(() => openJsonFileStore(file), { code: 'INVALID_STORE' });
  assert.equal(readFileSync(file, 'utf8'), corrupt);
});

test('read-only file stores can inspect existing data but cannot create or revise it', (t) => {
  const file = temporary(t); const writable = new MemoryService(openJsonFileStore(file, { clock: () => 100 }));
  writable.ingestSource(C, source()); const committed = readFileSync(file, 'utf8');
  const readOnly = openJsonFileStore(file, { readOnly: true, clock: () => 101 });
  assert.equal(readOnly.readSnapshot(C).sources.length, 1);
  assert.throws(() => new MemoryService(readOnly).createMemory(C, { command_id: 'readonly-write', memory: {
    id: 'mem:one', kind: 'claim', label: '只读不能新增', body: '合成结论', source_refs: ['src:one'],
  } }), { code: 'READ_ONLY' });
  assert.equal(readOnly.readSnapshot(C).memories.length, 0);
  assert.equal(readFileSync(file, 'utf8'), committed);
});

test('an existing lock blocks writes without removing someone else’s lock or resetting the data', (t) => {
  const file = temporary(t); const store = openJsonFileStore(file, { clock: () => 100 });
  writeFileSync(file + '.lock', 'test-owned lock', 'utf8');
  assert.throws(() => new MemoryService(store).ingestSource(C, source()), { code: 'STORE_BUSY' });
  assert.equal(store.readSnapshot(C).sequence, 0);
  assert.equal(existsSync(file), false);
  assert.equal(readFileSync(file + '.lock', 'utf8'), 'test-owned lock');
});
