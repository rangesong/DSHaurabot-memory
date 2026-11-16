import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MemoryError, contextKey, requireThat, stableStringify } from '../core/model.js';
import { projectGraph } from '../core/graph-projector.js';
import { fingerprintCapture, readAurabot, sha256 } from '../adapters/aurabot/reader.js';
import { createImportStore, mapAurabot, MAPPING_VERSION } from '../adapters/aurabot/mapper.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const runtimeRoot = join(projectRoot, 'runtime-data');
const inside = (root, target) => { const path = relative(root, target); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };
const json = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function localPath(root, name) {
  const file = resolve(root, name);
  requireThat(inside(root, file), 'OUTPUT_ESCAPE', 'Artifact path escaped the output directory');
  if (existsSync(file)) requireThat(inside(realpathSync(root), realpathSync(file)), 'OUTPUT_ESCAPE', 'Artifact symlink escaped the output directory');
  return file;
}

function writeJson(file, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  mkdirSync(dirname(file), { recursive: true });
  const handle = openSync(file, 'wx');
  try { writeFileSync(handle, bytes); fsyncSync(handle); } finally { closeSync(handle); }
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

function currentCache(output, fingerprint) {
  const pointerPath = join(output, 'current.json');
  if (!existsSync(pointerPath)) return null;
  try {
    const pointer = json(pointerPath);
    if (pointer.import_fingerprint !== fingerprint) return null;
    const directory = localPath(output, pointer.import_directory);
    const report = json(localPath(directory, 'report.json'));
    if (report.import_fingerprint !== fingerprint) return null;
    for (const artifact of report.artifacts) {
      const bytes = readFileSync(localPath(directory, artifact.name));
      if (sha256(bytes) !== artifact.sha256) return null;
    }
    return { pointer, report };
  } catch { return null; }
}

/** Publish a new immutable import, then atomically switch a tiny current pointer. */
export async function importAurabot({ root = 'D:/DSH/plugins-data/aurabot', output = join(runtimeRoot, 'aurabot'), graphLimit = 300, replay = false, includeDatabases = true } = {}) {
  output = resolve(output);
  requireThat(inside(runtimeRoot, output) && output !== runtimeRoot, 'INVALID_OUTPUT', 'Aurabot imports must stay in a dedicated project runtime-data directory');
  requireThat(Number.isSafeInteger(graphLimit) && graphLimit >= 0, 'INVALID_LIMIT', 'graphLimit must be a non-negative integer');
  // Resolve parent symlinks and reject overlap before creating any source-side directory.
  let ancestor = output;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actualOutput = resolve(realpathSync(ancestor), relative(ancestor, output));
  const actualRuntime = existsSync(runtimeRoot) ? realpathSync(runtimeRoot) : resolve(realpathSync(projectRoot), 'runtime-data');
  requireThat(inside(realpathSync(projectRoot), actualRuntime), 'INVALID_OUTPUT', 'runtime-data must resolve inside the project');
  requireThat(inside(actualRuntime, actualOutput), 'INVALID_OUTPUT', 'Output symlink left runtime-data');
  output = actualOutput;
  if (!replay) {
    const actualSource = realpathSync(resolve(root));
    requireThat(!inside(actualSource, output) && !inside(output, actualSource), 'OUTPUT_OVERLAP', 'Source and output directories must be separate');
  }
  mkdirSync(output, { recursive: true });
  const lockPath = join(output, '.import.lock');
  let lock;
  try { lock = openSync(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new MemoryError('IMPORT_BUSY', 'Another importer owns the output lock'); throw error; }
  try {
    let capture;
    if (replay) {
      const pointer = json(join(output, 'current.json'));
      capture = json(localPath(localPath(output, pointer.import_directory), 'captured-input.json'));
    } else capture = await readAurabot({ root, snapshotDirectory: join(output, 'database-copies'), includeDatabases });
    requireThat(capture.dataset_kind === 'aurabot' && typeof capture.fingerprint === 'string', 'INVALID_CAPTURE', 'Capture is not an Aurabot dataset');
    requireThat(capture.fingerprint === fingerprintCapture(capture), 'CAPTURE_CHANGED', 'Captured logical data no longer matches its fingerprint');
    const importFingerprint = sha256(stableStringify({ mapping_version: MAPPING_VERSION, capture_fingerprint: capture.fingerprint, graph_limit: graphLimit }));
    const cached = currentCache(output, importFingerprint);
    if (cached) return { ...cached, reused: true, pointer_path: join(output, 'current.json') };
    const mapped = mapAurabot(capture);
    requireThat(mapped.report.source_records > 0, 'NO_DATA', 'No usable Aurabot records; existing import was preserved');
    const recordedAt = Date.now();
    const store = createImportStore(mapped, { recordedAt });
    const buildName = `.building-${randomUUID()}`;
    const staging = join(output, 'imports', buildName);
    mkdirSync(staging, { recursive: true });
    const artifacts = [];
    const write = (name, value) => artifacts.push({ name, ...writeJson(localPath(staging, name), value) });
    write('captured-input.json', capture);
    write('store.json', store.exportData());
    write('observations.json', { dataset_kind: 'aurabot', recorded_at: recordedAt, observations: mapped.observations, coverage: 'retained native observation snapshots; not proof of actual model use' });
    const contexts = [];
    for (const partition of mapped.partitions) {
      if (!partition.sources.length && !partition.memories.length) continue;
      const key = sha256(contextKey(partition.context)).slice(0, 24);
      const snapshot = store.readSnapshot(partition.context);
      const graph = projectGraph(snapshot, { limit: graphLimit });
      graph.coverage = { kind: 'imported_current_snapshot', original_object_history_reconstructed: false, occurred_time_available: true, source_coverage_complete: capture.issues.length === 0,
        imported_at: recordedAt, source_fingerprint: capture.fingerprint };
      write(`graphs/${key}.json`, { dataset_kind: 'aurabot', ...graph });
      write(`details/${key}.json`, { dataset_kind: 'aurabot', ...snapshot });
      contexts.push({ context: partition.context, graph: `graphs/${key}.json`, details: `details/${key}.json`, counts: graph.counts,
        complete: graph.complete, omitted_count: graph.omitted_count });
    }
    write('index.json', { schema_version: 1, dataset_kind: 'aurabot', mapping_version: MAPPING_VERSION, imported_at: recordedAt, import_fingerprint: importFingerprint,
      context_policy: 'Contexts remain separate; this local owner import is not a public API or authentication layer.', contexts,
      source_coverage_complete: capture.issues.length === 0, observations: 'observations.json', store: 'store.json' });
    const report = { schema_version: 1, dataset_kind: 'aurabot', mapping_version: MAPPING_VERSION, imported_at: recordedAt, import_fingerprint: importFingerprint,
      captured_at: capture.captured_at, source_root: capture.source_root, source_access: 'filesystem reads only; SQLite opened on Thinkstar copies',
      source_manifest: capture.manifest, source_issues: capture.issues, mapping: mapped.report,
      coverage_definition: 'Available allowlisted sources read without capture/parse errors. Optional missing files remain in the manifest; this is not proof of complete historical coverage.',
      source_coverage_complete_for_requested_files: capture.issues.length === 0, artifacts };
    writeJson(join(staging, 'report.json'), report);
    const directoryName = `${importFingerprint.slice(0, 24)}-${randomUUID().slice(0, 8)}`;
    const finalDirectory = join(output, 'imports', directoryName);
    renameSync(staging, finalDirectory);
    const pointer = { schema_version: 1, dataset_kind: 'aurabot', import_fingerprint: importFingerprint,
      import_directory: `imports/${directoryName}`, index: `imports/${directoryName}/index.json`, report: `imports/${directoryName}/report.json` };
    const temporary = join(output, `current-${randomUUID()}.tmp`);
    writeJson(temporary, pointer); renameSync(temporary, join(output, 'current.json'));
    return { pointer, report, reused: false, pointer_path: join(output, 'current.json') };
  } finally {
    // Preserve a known publication outcome; a leftover lock is reported as busy next time.
    for (const clean of [() => closeSync(lock), () => unlinkSync(lockPath)]) { try { clean(); } catch { /* Do not mask the original result. */ } }
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--replay') options.replay = true;
    else if (argument === '--skip-databases') options.includeDatabases = false;
    else if (['--root', '--output', '--graph-limit'].includes(argument)) {
      requireThat(argv[i + 1] !== undefined, 'INVALID_ARGUMENT', `${argument} requires a value`);
      const value = argv[++i];
      if (argument === '--root') options.root = value;
      if (argument === '--output') options.output = value;
      if (argument === '--graph-limit') options.graphLimit = Number(value);
    } else throw new MemoryError('INVALID_ARGUMENT', `Unknown argument: ${argument}`);
  }
  return options;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await importAurabot(parseArgs(process.argv.slice(2)));
    const stats = result.report.mapping;
    console.log(`Aurabot 只读导入${result.reused ? '：复用已校验快照，无重复创建' : '完成'}`);
    console.log(`聊天流水 ${stats.chat_messages} 条；历史档案 ${stats.vault_messages} 条；旧记忆 ${stats.legacy_memories} 条`);
    console.log(`日记 ${stats.diary_entries} 条（试运行 ${stats.simulated_diaries} 条）；角色状态 ${stats.mood_entries} 条；回忆记录 ${stats.recall_entries} 条`);
    console.log(`${stats.contexts} 个独立范围；${stats.source_records} 条来源；${stats.memory_objects} 个记忆对象；${stats.relations} 条关系`);
    console.log(`可能截断 ${stats.possible_truncation} 条；采集问题 ${result.report.source_issues.length} 项；映射问题 ${stats.issues.length} 项`);
    console.log(`入口：${result.pointer_path}`);
  } catch (error) { console.error(`${error.code ?? 'IMPORT_FAILED'}: ${error.message}`); process.exitCode = 1; }
}
