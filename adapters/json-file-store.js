/** Optional Node-only adapter. The four core modules remain usable in a browser. */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { MemoryStore } from '../core/store.js';
import { MemoryError, requireThat } from '../core/model.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A small full-log JSON backend; not the future SQLite/large-volume store. */
export function openJsonFileStore(filePath, { clock = Date.now, readOnly = false } = {}) {
  const file = resolve(filePath);
  let bytes = null;
  try { bytes = readFileSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let data;
  try { data = bytes === null ? { schema_version: 1, transactions: [] } : JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch (error) { throw new MemoryError('INVALID_STORE', 'Stored JSON is malformed; file was preserved', { file, reason: error.message }); }
  let expectedDigest = bytes === null ? null : digest(bytes);
  const persist = (next) => {
    requireThat(!readOnly, 'READ_ONLY', 'This store was opened read-only');
    mkdirSync(dirname(file), { recursive: true });
    const lockPath = file + '.lock';
    let lock;
    try { lock = openSync(lockPath, 'wx'); }
    catch (error) {
      if (error.code === 'EEXIST') throw new MemoryError('STORE_BUSY', 'Store is locked; no change applied', { file });
      throw error;
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      let current = null;
      try { current = readFileSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      requireThat((current === null ? null : digest(current)) === expectedDigest, 'STORE_CONFLICT', 'Store changed externally; reopen before writing', { file });
      const serialized = JSON.stringify(next, null, 2) + '\n';
      const handle = openSync(temporary, 'wx');
      try { writeFileSync(handle, serialized, 'utf8'); fsyncSync(handle); } finally { closeSync(handle); }
      renameSync(temporary, file);
      expectedDigest = digest(Buffer.from(serialized, 'utf8'));
    } finally {
      // Cleanup must not turn a successful publication into a failed in-memory commit.
      // A leftover lock causes STORE_BUSY on the next write; it is never auto-deleted.
      for (const clean of [() => { if (existsSync(temporary)) unlinkSync(temporary); }, () => closeSync(lock), () => unlinkSync(lockPath)]) {
        try { clean(); } catch { /* Preserve the original outcome, including committed writes. */ }
      }
    }
  };
  return new MemoryStore({ data, clock, persist });
}
