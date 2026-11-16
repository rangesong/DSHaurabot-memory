/** Source access is filesystem reads only. SQLite is opened exclusively on local copies. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { MemoryError, requireThat } from '../../core/model.js';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export function fingerprintCapture(capture) {
  return sha256(JSON.stringify({ chatlogs: capture.chatlogs, diary: capture.diary, mood: capture.mood, recalls: capture.recalls,
    memory: capture.memory, vault: capture.vault, issues: capture.issues,
    coverage: capture.manifest.map(({ name, status, complete }) => ({ name, status, complete: complete ?? null })) }));
}
const inside = (root, target) => { const path = relative(root, target); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };

function separateOutput(root, directory) {
  let ancestor = resolve(directory);
  while (!existsSync(ancestor)) { const parent = resolve(ancestor, '..'); requireThat(parent !== ancestor, 'INVALID_OUTPUT', 'Cannot resolve output parent'); ancestor = parent; }
  const actual = resolve(realpathSync(ancestor), relative(ancestor, resolve(directory)));
  requireThat(!inside(root, actual) && !inside(actual, root), 'OUTPUT_OVERLAP', 'Output must be separate from the Aurabot source directory');
  return actual;
}

function sourcePath(root, name) {
  const file = resolve(root, name);
  requireThat(inside(root, file), 'SOURCE_PATH_ESCAPE', 'Source path left the Aurabot root');
  try { requireThat(inside(root, realpathSync(file)), 'SOURCE_PATH_ESCAPE', 'Source symlink left the Aurabot root'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return file;
}

function optionalBytes(file) {
  try { requireThat(lstatSync(file).isFile(), 'INVALID_SOURCE', 'Expected a regular file'); return readFileSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function captureDatabase(root, name) {
  const file = sourcePath(root, name);
  const database = optionalBytes(file);
  const wal = optionalBytes(sourcePath(root, name + '-wal'));
  const journal = optionalBytes(sourcePath(root, name + '-journal'));
  requireThat(!journal?.length, 'JOURNAL_PRESENT', 'Rollback journal present; skip rather than open the source database');
  return { database, wal, fingerprint: sha256(JSON.stringify([database && sha256(database), wal && sha256(wal)])) };
}

export async function readSqliteCopy({ root, name, snapshotDirectory, attempts = 3, betweenCaptures = () => {} }, read) {
  root = realpathSync(resolve(root));
  snapshotDirectory = separateOutput(root, snapshotDirectory);
  requireThat(Number.isSafeInteger(attempts) && attempts > 0, 'INVALID_DATA', 'Capture attempts must be a positive integer');
  let capture;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const first = captureDatabase(root, name);
    if (!first.database) return { status: 'missing', name };
    await betweenCaptures(attempt);
    const second = captureDatabase(root, name);
    if (first.fingerprint === second.fingerprint) { capture = first; break; }
  }
  requireThat(capture, 'SOURCE_BUSY', 'Database/WAL changed during capture; no partial snapshot was accepted', { name });
  mkdirSync(snapshotDirectory, { recursive: true });
  const copyRoot = mkdtempSync(join(snapshotDirectory, 'sqlite-'));
  const copy = join(copyRoot, 'snapshot.sqlite');
  writeFileSync(copy, capture.database);
  if (capture.wal !== null) writeFileSync(copy + '-wal', capture.wal);
  // SHM is transient. SQLite may rebuild it in the Thinkstar copy directory.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(copy, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; BEGIN');
    const check = db.prepare('PRAGMA integrity_check(1)').get();
    requireThat(check.integrity_check === 'ok', 'INVALID_SQLITE_COPY', 'Copied database failed integrity verification', { name });
    const data = read(db);
    db.exec('COMMIT');
    return { status: 'read', name, data, fingerprint: capture.fingerprint,
      bytes: capture.database.length, wal_bytes: capture.wal?.length ?? 0,
      snapshot_method: 'matching-db-wal-captures+copy-integrity-check', copy_path: copy };
  } finally { db.close(); }
}

function tables(db) { return new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name)); }

function readMemory(db) {
  const available = tables(db);
  requireThat(available.has('items') && available.has('kv'), 'UNSUPPORTED_SCHEMA', 'Expected Aurabot items and kv tables');
  const parseRows = (table) => available.has(table) ? db.prepare(`SELECT id, json FROM ${table} ORDER BY rowid`).all().map((row) => ({ native_id: row.id, value: JSON.parse(row.json) })) : [];
  const kv = Object.fromEntries(db.prepare('SELECT key, json FROM kv ORDER BY key').all().map((row) => [row.key, JSON.parse(row.json)]));
  return { items: parseRows('items'), gists: parseRows('gists'), kv };
}

function readVault(db) {
  const available = tables(db);
  requireThat(available.has('vault_lines'), 'UNSUPPORTED_SCHEMA', 'Expected history-vault tables');
  return {
    lines: db.prepare('SELECT id, t, chatId, day, dir, who, uid, text FROM vault_lines ORDER BY id').all().map((row) => ({ ...row })),
    days: available.has('vault_days') ? db.prepare('SELECT chatId, day, abstract, digest, updatedAt FROM vault_days ORDER BY chatId, day').all().map((row) => ({ ...row })) : [],
    months: available.has('vault_months') ? db.prepare('SELECT chatId, month, abstract, digest, updatedAt FROM vault_months ORDER BY chatId, month').all().map((row) => ({ ...row })) : [],
  };
}

/** Explicit allowlist: no config, credentials, auth files, module execution or remote calls. */
export async function readAurabot({ root, snapshotDirectory, includeDatabases = true, databaseAttempts = 3 } = {}) {
  requireThat(typeof root === 'string' && typeof snapshotDirectory === 'string', 'INVALID_DATA', 'Explicit source and snapshot directories are required');
  root = realpathSync(resolve(root)); snapshotDirectory = resolve(snapshotDirectory);
  snapshotDirectory = separateOutput(root, snapshotDirectory);
  const result = { dataset_kind: 'aurabot', captured_at: Date.now(), source_root: root, chatlogs: [], diary: null, mood: null, recalls: null,
    memory: null, vault: null, manifest: [], issues: [] };
  const note = (name, code, details = {}) => result.issues.push({ file: name, code, ...details });
  const chatDirectory = sourcePath(root, 'chatlog');
  const names = existsSync(chatDirectory) ? readdirSync(chatDirectory).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort() : [];
  for (const basename of names) {
    const name = `chatlog/${basename}`;
    const bytes = optionalBytes(sourcePath(root, name));
    if (!bytes) { note(name, 'DISAPPEARED_DURING_READ'); continue; }
    const lines = bytes.toString('utf8').replace(/^\uFEFF/, '').split('\n');
    const records = [];
    let partial = false;
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      // A live append without its newline is not yet a committed journal record.
      if (index === lines.length - 1) { partial = true; note(name, 'UNCOMMITTED_TAIL', { line: index + 1 }); return; }
      try { records.push({ line: index + 1, value: JSON.parse(line) }); }
      catch { partial = true; note(name, 'INVALID_JSON_LINE', { line: index + 1 }); }
    });
    result.chatlogs.push({ name, records });
    result.manifest.push({ name, status: 'read', bytes: bytes.length, sha256: sha256(bytes), records: records.length, complete: !partial });
  }
  for (const [name, field] of [['diary.json', 'diary'], ['mood.json', 'mood'], ['recall-log.json', 'recalls']]) {
    const bytes = optionalBytes(sourcePath(root, name));
    if (bytes === null) { result.manifest.push({ name, status: 'missing' }); continue; }
    try {
      result[field] = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
      result.manifest.push({ name, status: 'read', bytes: bytes.length, sha256: sha256(bytes), complete: true });
    } catch { note(name, 'INVALID_JSON'); result.manifest.push({ name, status: 'invalid', complete: false }); }
  }
  for (const [name, field, read] of [['memory.sqlite', 'memory', readMemory], ['modules-data/history-vault/vault.sqlite', 'vault', readVault]]) {
    if (!includeDatabases) { result.manifest.push({ name, status: 'not_requested' }); continue; }
    try {
      const snapshot = await readSqliteCopy({ root, name, snapshotDirectory, attempts: databaseAttempts }, read);
      const { data, ...metadata } = snapshot;
      result.manifest.push(metadata);
      if (snapshot.status === 'read') result[field] = data;
    } catch (error) {
      note(name, error.code ?? 'SQLITE_READ_FAILED');
      result.manifest.push({ name, status: 'unavailable', error_code: error.code ?? 'SQLITE_READ_FAILED', complete: false });
    }
  }
  // Hash captured logical data; WAL checkpoint churn does not invent new content.
  result.fingerprint = fingerprintCapture(result);
  return result;
}
