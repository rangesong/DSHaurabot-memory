import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { crc32 } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { patchBackupCapacity, BACKUP_CAPACITY_BASELINES } from '../scripts/lib/backup-capacity-patch.js';
import { withZip64Offset, backupZipEnd, backupZipDirectory, backupEntryOffset, boundedBackupChunks, splitBackupFile } from '../adapters/aurabot/native/backup-zip64.js';

// Use an explicitly restored, reviewed pre-patch code baseline; never assume a
// developer's live installation is still the original after deploying a repair.
const native = process.env.BACKUP_CAPACITY_HOST_ROOT;
const available = !!native && fs.existsSync(path.join(native, 'src/core/backup.js'));
const maxZip = 9 * 1024 ** 3, maxDirectory = 32 * 1024 ** 2, U32 = 0xffffffff;
const scratch = () => {
  assert.ok(process.env.THINKSTAR_TEST_TMP, 'Use scripts/run-tests.js');
  return fs.mkdtempSync(path.join(process.env.THINKSTAR_TEST_TMP, 'backup-capacity-'));
};
const readSource = file => fs.readFileSync(path.join(native, file), 'utf8');
async function fixture({ patched = true, exportPrivate = false } = {}) {
  const folder = scratch(), data = path.join(folder, 'data'), core = path.join(folder, 'src/core');
  fs.mkdirSync(core, { recursive: true }); fs.mkdirSync(path.join(folder, 'src/features'));
  fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'config.json'), '{"ownerQQ":"synthetic"}');
  fs.writeFileSync(path.join(folder, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(core, 'store.js'), `import {join} from 'node:path';export const dataDir=(...p)=>join(${JSON.stringify(data)},...p);export const dshHome=()=>${JSON.stringify(folder)};`);
  fs.writeFileSync(path.join(folder, 'src/features/memory-store.js'), 'export const MEMORY_FILES=[];export const captureMemoryBackup=()=>new Map();');
  fs.copyFileSync(new URL('../adapters/aurabot/native/backup-zip64.js', import.meta.url), path.join(core, 'backup-zip64.js'));
  for (const file of ['src/core/backup.js', 'src/core/backup-push.js']) {
    let source = readSource(file);
    if (patched) source = patchBackupCapacity(source, { file }).source;
    if (exportPrivate && file.endsWith('/backup.js')) source += '\nexport {readEntries,readExact,centralHeader,localHeader};\n';
    fs.writeFileSync(path.join(folder, file), source);
  }
  return { folder, data, api: await import(pathToFileURL(path.join(core, 'backup.js')).href), push: await import(pathToFileURL(path.join(core, 'backup-push.js')).href) };
}
function logicalArchive(api) {
  const specs = [
    { name: 'data/config.json', body: Buffer.from('{}'), offset: 0 },
    { name: 'data/late.txt', body: Buffer.from('synthetic ZIP64 tail'), offset: U32 + 72 },
  ];
  const segments = [], entries = [];
  for (const item of specs) {
    const entry = { ...item, method: 0, time: 0, date: 33, crc: crc32(item.body), packed: item.body.length, size: item.body.length };
    const head = api.localHeader(entry);
    entries.push(entry); segments.push({ at: item.offset, bytes: Buffer.concat([head, item.body]) });
  }
  const dirOffset = segments.at(-1).at + segments.at(-1).bytes.length;
  const central = Buffer.concat(entries.map(api.centralHeader));
  const footer = backupZipEnd(entries.length, central.length, dirOffset);
  segments.push({ at: dirOffset, bytes: Buffer.concat([central, footer]) });
  const size = dirOffset + central.length + footer.length;
  const read = async (_fh, length, position) => {
    assert.ok(length <= maxDirectory && position >= 0 && position + length <= size);
    const out = Buffer.alloc(length);
    for (const { at, bytes } of segments) {
      const from = Math.max(at, position), to = Math.min(at + bytes.length, position + length);
      if (to > from) bytes.copy(out, from - position, from - at, to - at);
    }
    return out;
  };
  return { specs, segments, size, read, dirOffset, central, footer };
}
function forcedSmallZip64(zip) {
  const at = zip.length - 22, count = zip.readUInt16LE(at + 10), bytes = zip.readUInt32LE(at + 12), offset = zip.readUInt32LE(at + 16);
  const end = backupZipEnd(count, bytes, U32);
  end.writeBigUInt64LE(BigInt(offset), 48);
  end.writeBigUInt64LE(BigInt(offset + bytes), 64);
  end.writeUInt32LE(offset, 92);
  return Buffer.concat([zip.subarray(0, at), end]);
}

test('backup patch fails closed on changed/version-mismatched code and is hash-checked idempotent', { skip: !available }, () => {
  for (const file of Object.keys(BACKUP_CAPACITY_BASELINES)) {
    const input = readSource(file), result = patchBackupCapacity(input, { file });
    assert.equal(result.changed, true);
    assert.deepEqual(patchBackupCapacity(result.source, { file }), { ...result, changed: false, before: result.after });
    assert.throws(() => patchBackupCapacity(input + '\n', { file }), /verified baseline/);
    assert.throws(() => patchBackupCapacity(result.source + '\n', { file }), /verified baseline/);
    assert.throws(() => patchBackupCapacity(input, { file, version: 'future' }), /Unsupported/);
  }
});

test('small ZIP32 output stays byte-identical; ZIP64 streamed import stages, checks and restores real synthetic bytes', { skip: !available }, async () => {
  const f = await fixture({ patched: false });
  fs.writeFileSync(path.join(f.data, 'synthetic.txt'), 'synthetic retained source ✓');
  const now = new Date('2026-11-24T01:01:00Z');
  const original = await f.api.createBackup({ now, version: 'synthetic' });
  const bytes = fs.readFileSync(original.file);
  fs.writeFileSync(path.join(f.folder, 'src/core/backup-patched.js'), patchBackupCapacity(readSource('src/core/backup.js')).source);
  const api = await import(pathToFileURL(path.join(f.folder, 'src/core/backup-patched.js')).href);
  const current = await api.createBackup({ now, version: 'synthetic' });
  assert.deepEqual(fs.readFileSync(current.file), bytes);
  const largeFormat = forcedSmallZip64(bytes);
  async function* chunks() { for (let p = 0; p < largeFormat.length; p += 17) yield largeFormat.subarray(p, p + 17); }
  const staged = await api.stageReceivedBackup(chunks());
  assert.equal(staged.ok, true);
  assert.equal(fs.readFileSync(path.join(f.data, '.restore/synthetic.txt'), 'utf8'), 'synthetic retained source ✓');
  fs.writeFileSync(path.join(f.data, 'synthetic.txt'), 'current data stays until restart');
  assert.equal(api.applyPendingRestore(12345), 2);
  assert.equal(fs.readFileSync(path.join(f.data, 'synthetic.txt'), 'utf8'), 'synthetic retained source ✓');
  assert.equal(fs.readFileSync(path.join(f.data, 'backups/pre-restore-12345/synthetic.txt'), 'utf8'), 'current data stays until restart');
  assert.equal(api.pendingRestore(), null);
});

test('logical >4GiB ZIP writer directory is accepted by patched reader and Python zipfile without a giant file', { skip: !available }, async () => {
  const f = await fixture({ exportPrivate: true });
  const archive = logicalArchive(f.api);
  const meta = await backupZipDirectory(null, archive.size, archive.read, { maxZip, maxDirectory });
  assert.equal(meta.dirOffset, archive.dirOffset);
  const virtual = { read: async (out, offset, length, position) => { const bytes = await archive.read(null, length, position); bytes.copy(out, offset); return { bytesRead: length }; } };
  const entries = await f.api.readEntries(virtual, archive.size);
  assert.equal(entries[1].offset, U32 + 72);
  assert.deepEqual(entries.map(e => e.name), archive.specs.map(e => e.name));
  const script = `import io,json,sys,zipfile,base64
x=json.load(sys.stdin)
class Virtual(io.RawIOBase):
 def __init__(self):self.p=0
 def seekable(self):return True
 def tell(self):return self.p
 def seek(self,n,w=0):self.p=n if w==0 else self.p+n if w==1 else x['size']+n;return self.p
 def read(self,n=-1):
  if n<0:n=x['size']-self.p
  if n>131072:raise RuntimeError('unexpected whole-archive read')
  n=max(0,min(n,x['size']-self.p));out=bytearray(n)
  for s in x['segments']:
   b=base64.b64decode(s['bytes']);a=max(self.p,s['at']);z=min(self.p+n,s['at']+len(b))
   if z>a:out[a-self.p:z-self.p]=b[a-s['at']:z-s['at']]
  self.p+=n;return bytes(out)
with zipfile.ZipFile(Virtual()) as z:print(json.dumps({'names':z.namelist(),'tail':z.read('data/late.txt').decode()}))`;
  const result = spawnSync('python', ['-c', script], { input: JSON.stringify({ size: archive.size, segments: archive.segments.map(s => ({ at: s.at, bytes: s.bytes.toString('base64') })) }), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).tail, 'synthetic ZIP64 tail');
});

test('ZIP64 rejects corrupt locator/range/count/extra fields while preserving entry and expansion limits', { skip: !available }, async () => {
  const f = await fixture({ exportPrivate: true });
  for (const corrupt of [
    end => end.writeUInt32LE(2, 72),
    end => end.writeBigUInt64LE(2n ** 63n, 64),
    end => end.writeBigUInt64LE(65536n, 32),
    end => end.writeBigUInt64LE(43n, 4),
    end => end.writeBigUInt64LE(BigInt(maxDirectory + 1), 40),
  ]) {
    const a = logicalArchive(f.api), damaged = Buffer.from(a.footer); corrupt(damaged);
    a.segments.at(-1).bytes = Buffer.concat([a.central, damaged]);
    await assert.rejects(backupZipDirectory(null, a.size, a.read, { maxZip, maxDirectory }), /ZIP64/);
  }
  const head = Buffer.alloc(46); head.writeUInt32LE(0x02014b50); head.writeUInt32LE(U32, 42);
  const encoded = withZip64Offset(head, U32 + 1);
  assert.equal(backupEntryOffset(encoded, 0, 0, maxZip), U32 + 1);
  for (const mutate of [b => b.writeUInt16LE(9, 48), b => b.writeBigUInt64LE(2n ** 63n, 50), b => b.writeUInt32LE(U32, 20)]) {
    const bad = Buffer.from(encoded); mutate(bad); assert.throws(() => backupEntryOffset(bad, 0, 0, maxZip), /ZIP64/);
  }
  assert.throws(() => backupEntryOffset(encoded.subarray(0, encoded.length - 1), 0, 0, maxZip), /ZIP64/);
  const a = logicalArchive(f.api);
  a.central.writeUInt32LE(2 ** 31, 24);
  a.segments.at(-1).bytes = Buffer.concat([a.central, a.footer]);
  const virtual = { read: async (out, offset, length, position) => { (await a.read(null, length, position)).copy(out, offset); return { bytesRead: length }; } };
  await assert.rejects(f.api.readEntries(virtual, a.size), /资源限制/);
});

test('stream budget handles >4GiB with a reused 1MiB buffer and rejects overrun, truncation and invalid chunks', async () => {
  const block = Buffer.alloc(1024 * 1024); let bytes = 0, chunks = 0;
  async function* input() { for (let i = 0; i < 4097; i++) yield block; }
  for await (const chunk of boundedBackupChunks(input(), maxZip)) { bytes += chunk.length; chunks++; assert.equal(chunk, block); }
  assert.equal(bytes, 4097 * block.length); assert.equal(chunks, 4097);
  await assert.rejects(async () => { for await (const _ of boundedBackupChunks([block, block], block.length)) {} }, /超过限制/);
  await assert.rejects(async () => { for await (const _ of boundedBackupChunks([block], maxZip, block.length + 1)) {} }, /不完整/);
  await assert.rejects(async () => { for await (const _ of boundedBackupChunks([], maxZip)) {} }, /空的/);
  await assert.rejects(async () => { for await (const _ of boundedBackupChunks(['bad'], maxZip)) {} }, /输入流无效/);
});

test('Gitee parts preserve ordering, hashes and bounded writes; interrupted part is closed and cleaned', async () => {
  const folder = scratch(), name = 'aurabot-backup-20261124-0100.zip', input = Buffer.from('0123456789ABCDEF');
  const source = path.join(folder, name), dest = path.join(folder, 'parts'); fs.mkdirSync(dest); fs.writeFileSync(source, input);
  const parts = await splitBackupFile(source, dest, name, 5);
  assert.deepEqual(Buffer.concat(parts.map(p => fs.readFileSync(path.join(dest, p.name)))), input);
  assert.deepEqual(parts.map(p => p.bytes), [5, 5, 5, 1]); assert.ok(parts.every(p => /^[a-f0-9]{64}$/.test(p.sha256)));
  let closed = 0, removed = 0;
  await assert.rejects(splitBackupFile('fake', 'fake', name, 5, {
    openFile: async file => file === 'fake' ? { stat: async () => ({ isFile: () => true, size: 17n, mtimeNs: 1n, ctimeNs: 1n }), read: async () => { throw Error('synthetic read failure'); }, close: async () => { closed++; } } : { writeFile: async () => {}, close: async () => { closed++; } },
    publish: async () => assert.fail('must not publish partial part'), remove: async () => { removed++; },
  }), /synthetic read failure/);
  assert.equal(closed, 2); assert.equal(removed, 1);
  assert.ok(fs.readdirSync(dest).every(n => !n.endsWith('.tmp')));
});

test('Gitee splitter crosses 32-bit source positions with a simulated writer and never allocates or writes a whole archive', async () => {
  const size = 2 ** 32 + 17, partSize = 95 * 1024 * 1024;
  let readBytes = 0, writtenBytes = 0, maximumWrite = 0, published = 0, closed = 0;
  const info = { isFile: () => true, size: BigInt(size), mtimeNs: 1n, ctimeNs: 1n };
  const parts = await splitBackupFile('virtual-source', 'virtual-destination', 'aurabot-backup-20261124-0100.zip', partSize, {
    openFile: async file => file === 'virtual-source' ? {
      stat: async () => info,
      read: async (buffer, offset, length, position) => { assert.equal(position, readBytes); assert.ok(length <= 1024 * 1024); buffer.fill(0, offset, offset + length); readBytes += length; return { bytesRead: length }; },
      close: async () => { closed++; },
    } : {
      writeFile: async data => { writtenBytes += data.length; maximumWrite = Math.max(maximumWrite, data.length); },
      close: async () => { closed++; },
    },
    publish: async () => { published++; }, remove: async () => {},
  });
  assert.equal(readBytes, size); assert.equal(writtenBytes, size); assert.equal(maximumWrite, 1024 * 1024);
  assert.equal(parts.length, Math.ceil(size / partSize)); assert.equal(published, parts.length); assert.equal(closed, parts.length + 1);
  assert.equal(parts.reduce((sum, p) => sum + p.bytes, 0), size);
});

test('WebDAV uploads/downloads use backpressured streams; legacy buffer API and Gitee small parts stay compatible', { skip: !available }, async () => {
  const f = await fixture(), name = 'aurabot-backup-20261124-0100.zip', data = Buffer.alloc(2 * 1024 * 1024 + 13, 17);
  fs.mkdirSync(path.join(f.data, 'backups')); fs.writeFileSync(path.join(f.data, 'backups', name), data);
  let uploaded = 0, maxChunk = 0, calls = 0;
  f.push.pushHooks.fetch = async (_url, init = {}) => {
    calls++;
    if (init.method === 'PUT') {
      assert.equal(init.duplex, 'half'); assert.equal(init.headers['content-length'], String(data.length));
      assert.equal(Buffer.isBuffer(init.body), false);
      for await (const part of init.body) { uploaded += part.length; maxChunk = Math.max(maxChunk, part.length); }
      return { ok: true, status: 201 };
    }
    if (init.method === 'PROPFIND') return { ok: true, text: async () => '<d:multistatus/>' };
    if (init.method === 'MKCOL') return { ok: true };
    return { ok: true, body: (async function* () { yield data.subarray(0, 9); yield data.subarray(9); })(), arrayBuffer: async () => data };
  };
  const remote = { provider: 'webdav', keep: 7, webdav: { url: 'https://synthetic.invalid/dav', username: 'synthetic', password: 'test-only' } };
  assert.equal((await f.push.pushBackup(remote)).ok, true);
  assert.equal(uploaded, data.length); assert.ok(maxChunk <= 1024 * 1024);
  const stream = await f.push.downloadWebdavBackup(remote, name, { stream: true });
  const received = []; for await (const part of stream.buffer) received.push(part);
  assert.deepEqual(Buffer.concat(received), data);
  assert.deepEqual((await f.push.downloadWebdavBackup(remote, name)).buffer, data);
  assert.ok(calls >= 5);
  f.push.pushHooks.splitMax = 1024 * 1024;
  f.push.pushHooks.fetch = async () => ({ ok: true, json: async () => ({ private: true }) });
  f.push.pushHooks.spawn = () => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); queueMicrotask(() => child.emit('close', 0)); return child; };
  const pushed = await f.push.pushBackup({ provider: 'gitee', owner: 'synthetic', repo: 'synthetic', token: 'synthetic', keep: 7 });
  assert.equal(pushed.parts, 3);
  const out = path.join(f.data, 'backups/.gitee', pushed.folder);
  assert.deepEqual(Buffer.concat(fs.readdirSync(out).sort().map(n => fs.readFileSync(path.join(out, n)))), data);
});

test('failed streamed import removes receive scratch and never stages or replaces current data', { skip: !available }, async () => {
  const f = await fixture();
  async function* interrupted() { yield Buffer.from('synthetic-partial-zip'); throw Error('synthetic interrupted download'); }
  await assert.rejects(f.api.stageReceivedBackup(interrupted()), /synthetic interrupted download/);
  assert.equal(fs.readFileSync(path.join(f.data, 'config.json'), 'utf8'), '{"ownerQQ":"synthetic"}');
  assert.equal(f.api.pendingRestore(), null);
  assert.ok(fs.readdirSync(path.join(f.data, 'backups')).every(n => !n.startsWith('.receive-')));
  const created = await f.api.createBackup({ now: new Date('2026-11-24T01:11:00Z') });
  const damaged = forcedSmallZip64(fs.readFileSync(created.file));
  damaged[30 + damaged.readUInt16LE(26)] ^= 255;
  await assert.rejects(f.api.stageReceivedBackup((async function* () { yield damaged; })()), /校验|invalid|incorrect|block|code/i);
  assert.equal(f.api.pendingRestore(), null);
  assert.ok(fs.readdirSync(f.data).every(n => !n.startsWith('.restore-stage-')));
  assert.equal(fs.readFileSync(path.join(f.data, 'config.json'), 'utf8'), '{"ownerQQ":"synthetic"}');
});

test('complete invalid and CRC-corrupt downloads preserve an existing same-name valid ZIP; successful collisions are saved separately', { skip: !available }, async () => {
  const f = await fixture();
  fs.writeFileSync(path.join(f.data, 'retained.txt'), 'first valid recovery point');
  const original = await f.api.createBackup({ now: new Date('2026-11-24T01:15:00Z') });
  const originalBytes = fs.readFileSync(original.file);
  const assertUntouched = () => {
    assert.deepEqual(fs.readFileSync(original.file), originalBytes);
    assert.equal(f.api.pendingRestore(), null);
    assert.equal(fs.readFileSync(path.join(f.data, 'retained.txt'), 'utf8'), 'first valid recovery point');
    assert.ok(fs.readdirSync(path.join(f.data, 'backups')).every(n => !n.startsWith('.receive-')));
    assert.ok(fs.readdirSync(f.data).every(n => !n.startsWith('.restore-stage-')));
  };
  await assert.rejects(f.api.stageReceivedBackup((async function* () { yield Buffer.from('complete invalid remote ZIP'); })(), original.name), /ZIP64|有效|损坏/);
  assertUntouched();
  const corrupted = forcedSmallZip64(originalBytes);
  corrupted[30 + corrupted.readUInt16LE(26) + corrupted.readUInt16LE(28)] ^= 255;
  await assert.rejects(f.api.stageReceivedBackup((async function* () { yield corrupted; })(), original.name), /校验|invalid|incorrect|block|code/i);
  assertUntouched();
  fs.writeFileSync(path.join(f.data, 'additional.txt'), 'second valid recovery point');
  const fresh = await f.api.createBackup({ now: new Date('2026-11-24T01:16:00Z') });
  const freshBytes = fs.readFileSync(fresh.file);
  const result = await f.api.stageReceivedBackup((async function* () { yield freshBytes; })(), original.name);
  assert.equal(result.ok, true);
  assert.match(result.backupName, /^received-[a-f0-9-]+-aurabot-backup-20261124-0115\.zip$/);
  assert.equal(result.receivedBytes, freshBytes.length);
  assert.deepEqual(fs.readFileSync(original.file), originalBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.data, 'backups', result.backupName)), freshBytes);
  assert.ok(f.api.listBackups().some(row => row.name === result.backupName));
  assert.equal(fs.readFileSync(path.join(f.data, '.restore/additional.txt'), 'utf8'), 'second valid recovery point');
  assert.ok(fs.readdirSync(path.join(f.data, 'backups')).every(n => !n.startsWith('.receive-')));
  f.api.cancelRestore();
});
