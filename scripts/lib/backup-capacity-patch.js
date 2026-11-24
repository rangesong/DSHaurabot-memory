import { createHash } from 'node:crypto';

export const BACKUP_CAPACITY_MARKER = 'thinkstar-backup-capacity-v1';
// Exact previously deployed helper accepted for a reviewed forward replacement.
export const BACKUP_CAPACITY_PREVIOUS_HELPER_SHA256 = '353cc053366a91dbb9ecad8f8e97ca408a94eae4ca7b70674446f0d31c9483c7';
export const BACKUP_CAPACITY_BASELINES = Object.freeze({
  'src/core/backup.js': '4552424eefd9af29c9d843c282239b6027e0eb82ad4b1a73493eace3044ec3d5',
  'src/core/backup-push.js': 'd8de12ae9e30f612d8df0bf5822ddc020fd70454662e2ad95d313fb2050696ab',
  'src/host.js': '7f929016b24bf838e0510ff2067bf6095f8bf8ad26ea3793041fe3ddcc005ec6',
});
// Only these exact outputs qualify as already applied. Filled from the audited
// baseline transformation, not from a marker substring in arbitrary source.
const previousHashes = Object.freeze({
  'src/core/backup.js': '8756f2d02d6fcb205f2d9ff3b653042fd2b263f14c8344264616288c56fe20e8',
  'src/core/backup-push.js': '3bda4ef4ef14b2ac493e4cd756d8cfcf25ef6fbc5a38fd8af99eec6eee808a05',
  'src/host.js': '2527d749c2febbb088e04d289af0db277e4995a42d7c9713adecd846494e4fbe',
});
const patchedHashes = Object.freeze({
  'src/core/backup.js': '8f7f0dccc4a7b0e04278d2438a5e8e1985dfa92a520f7fd6a734f24a1c57fe51',
  'src/core/backup-push.js': '556194ae25b03de74f7c26cb42dc928aec29f7f520c523198354ac2200dff287',
  // The host's streaming entry points do not contain capacity limits.
  'src/host.js': previousHashes['src/host.js'],
});
const hash = value => createHash('sha256').update(value).digest('hex');
function replaceOnce(source, before, after) {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0) throw Error('Backup patch context mismatch');
  return source.slice(0, at) + after + source.slice(at + before.length);
}

function patchBackup(source) {
  let result = source;
  result = replaceOnce(result, 'lstatSync, mkdirSync, readFileSync', 'lstatSync, linkSync, mkdirSync, readFileSync');
  result = replaceOnce(result, "const MAX_ZIP = 0xfffffff0 // 没做 zip64：超过 4GB 明确报错，不生成坏文件", "const MAX_ZIP = 9 * 1024 ** 3 // ZIP64 container cap; expanded data remains capped at 8 GiB");
  result = replaceOnce(result, "import { captureMemoryBackup, MEMORY_FILES } from '../features/memory-store.js'", "import { captureMemoryBackup, MEMORY_FILES } from '../features/memory-store.js'\nimport { withZip64Offset, backupZipEnd, backupZipDirectory, backupEntryOffset, boundedBackupChunks } from './backup-zip64.js'");
  result = replaceOnce(result, 'h.writeUInt32LE(entry.offset, 42)', 'h.writeUInt32LE(Math.min(entry.offset, 0xffffffff), 42)');
  result = replaceOnce(result, 'return Buffer.concat([h, name])\n}\n\n/** 打包数据目录', 'return withZip64Offset(Buffer.concat([h, name]), entry.offset)\n}\n\n/** 打包数据目录');
  result = replaceOnce(result, "throw new Error('数据超过 4GB，一个备份放不下')", "throw new Error('备份 ZIP64 文件大小超过限制')");
  const footerStart = result.indexOf('    const directorySize = entries.reduce(');
  const footerEnd = result.indexOf('    await fh.close()', footerStart);
  if (footerStart < 0 || footerEnd < footerStart) throw Error('Backup footer context mismatch');
  result = result.slice(0, footerStart) + `    const central = Buffer.concat(entries.map(centralHeader))
    const end = backupZipEnd(entries.length, central.length, offset)
    if (central.length > MAX_DIRECTORY || offset + central.length + end.length > MAX_ZIP) throw new Error('备份目录或文件过大')
    await fh.write(Buffer.concat([central, end]))
` + result.slice(footerEnd);
  const readerStart = result.indexOf('/** 只支持 Aurabot 使用的单卷 ZIP32；');
  const readerEnd = result.indexOf('  const dir = await readExact(fh, dirSize, dirOffset)', readerStart);
  if (readerStart < 0 || readerEnd < readerStart) throw Error('Backup reader context mismatch');
  result = result.slice(0, readerStart) + `/** Bounded single-volume ZIP32/ZIP64; old per-entry and restore checks remain below. */
async function readEntries(fh, size) {
  const { count, dirSize, dirOffset } = await backupZipDirectory(fh, size, readExact, { maxZip: MAX_ZIP, maxDirectory: MAX_DIRECTORY })
` + result.slice(readerEnd);
  result = replaceOnce(result, 'offset: dir.readUInt32LE(p + 42)', 'offset: backupEntryOffset(dir, p, nameLen, MAX_ZIP)');
  result = replaceOnce(result, "if (!Buffer.isBuffer(buf) || !buf.length || buf.length > MAX_ZIP) throw new Error('备份文件大小无效')", "if (Buffer.isBuffer(buf) && (!buf.length || buf.length > MAX_ZIP)) throw new Error('备份文件大小无效')");
  result = replaceOnce(result, '        await file.writeFile(buf)\n        await file.sync()', '        for await (const chunk of boundedBackupChunks(buf, MAX_ZIP)) await file.writeFile(chunk)\n        await file.sync()');
  result = replaceOnce(result, 'async function stageBackup(path, received) {', 'async function stageBackup(path, received, beforePublish) {');
  result = replaceOnce(result, '    publishStage(data, job)\n    return { ok: true, files, createdAt', '    await beforePublish?.()\n    publishStage(data, job)\n    return { ok: true, files, createdAt');
  result = replaceOnce(result, `    const rel = 'backups/' + name
    const target = checkPath(data, rel)
    const temporary = 'backups/.receive-' + randomUUID() + '.tmp'`, `    let publishedName = name
    const temporary = 'backups/.receive-' + randomUUID() + '.tmp'`);
  result = replaceOnce(result, `      const source = verifyFile(data, { rel: temporary, key })
      if (checkPath(data, rel).key !== target.key) throw unsafePath(rel)
      renameSync(source.path, target.path)
      const published = checkPath(data, rel)
      if (!published.info || !sameRenamedFile(source.info, published.info)) throw unsafePath(rel)
      return await stageBackup(published.path, { data, rel, key: published.key })`, `      const source = verifyFile(data, { rel: temporary, key })
      const result = await stageBackup(source.path, { data, rel: temporary, key }, () => {
        // This callback runs only after every entry and CRC has been validated.
        // linkSync is exclusive: a racing writer cannot make us replace a backup.
        for (let attempt = 0; attempt < 8; attempt++) {
          const rel = 'backups/' + publishedName
          const target = checkPath(data, rel)
          if (!target.info) {
            verifyFile(data, { rel: temporary, key })
            try { linkSync(source.path, target.path) }
            catch (error) { if (error.code !== 'EEXIST') throw error; publishedName = 'received-' + randomUUID() + '-' + name; continue }
            const published = checkPath(data, rel)
            if (!published.info || !sameRenamedFile(source.info, published.info)) throw unsafePath(rel)
            return
          }
          publishedName = 'received-' + randomUUID() + '-' + name
        }
        throw new Error('无法分配不覆盖现有备份的导入文件名')
      })
      return { ...result, backupName: publishedName, receivedBytes: Number(source.info.size) }`);
  return result;
}

function patchPush(source) {
  let result = replaceOnce(source, "import { dataDir } from './store.js'", "import { dataDir } from './store.js'\nimport { createReadStream } from 'node:fs'\nimport { splitBackupFile, boundedBackupChunks } from './backup-zip64.js'");
  result = replaceOnce(result, "export async function downloadWebdavBackup(r, name)", "export async function downloadWebdavBackup(r, name, { stream = false } = {})");
  result = replaceOnce(result, '  let buf\n  try { buf = Buffer.from(await res.arrayBuffer()) }', `  if (stream) {
    if (!res.body) throw new Error('WebDAV 下载到的文件是空的')
    return { name: file, buffer: boundedBackupChunks(res.body, 9 * 1024 ** 3) }
  }
  let buf
  try { buf = Buffer.from(await res.arrayBuffer()) }`);
  result = replaceOnce(result, 'headers, body, redirect:', "headers, body, ...(body && !Buffer.isBuffer(body) && typeof body[Symbol.asyncIterator] === 'function' ? { duplex: 'half' } : {}), redirect:");
  const before = `  let buf
  try { buf = await readFile(full) } catch (error) { throw new Error('读不了最新备份文件：' + redact(error.message, password)) }
  onLog({ out: \`上传 \${name}（\${Math.round(buf.length / 1024)} KB）到 WebDAV…\` })
  const put = await webdavFetch(folder + encodeURIComponent(name), {
    method: 'PUT',
    headers: { authorization: auth, 'content-type': 'application/zip' },
    body: buf,
    timeout: 30 * 60 * 1000,
    password,
  })`;
  const after = `  const size = statSync(full).size
  if (!Number.isSafeInteger(size) || size <= 0 || size > 9 * 1024 ** 3) throw new Error('备份文件大小无效')
  onLog({ out: \`上传 \${name}（\${Math.round(size / 1024)} KB）到 WebDAV…\` })
  const input = createReadStream(full, { highWaterMark: 1024 * 1024 })
  let put
  try {
    put = await webdavFetch(folder + encodeURIComponent(name), {
      method: 'PUT',
      headers: { authorization: auth, 'content-type': 'application/zip', 'content-length': String(size) },
      body: boundedBackupChunks(input, 9 * 1024 ** 3, size),
      timeout: 30 * 60 * 1000,
      password,
    })
  } finally { input.destroy() }`;
  result = replaceOnce(result, before, after);
  const splitBefore = `    const data = await readFile(join(dir, name))
    const count = Math.ceil(size / splitMax)
    for (let i = 0; i < count; i++) {
      const part = \`\${name}.part\${String(i + 1).padStart(2, '0')}\`
      await writeFile(join(outDir, part), data.subarray(i * splitMax, Math.min(size, (i + 1) * splitMax)))
      pushed.push(part)
    }`;
  result = replaceOnce(result, splitBefore, `    const parts = await splitBackupFile(join(dir, name), outDir, name, splitMax)
    for (const part of parts) pushed.push(part.name)`);
  return result;
}

function patchHost(source) {
  let result = replaceOnce(source, `    const buf = await readRaw(req, 2 * 1024 * 1024 * 1024 - 1)
    if (!buf.length) return { ok: false, message: '文件是空的' }
    try { return await stageReceivedBackup(buf) }`, `    try { return await stageReceivedBackup(req) }`);
  result = replaceOnce(result, 'await downloadWebdavBackup(r, name)', 'await downloadWebdavBackup(r, name, { stream: true })');
  result = replaceOnce(result, '${got.buffer.length} 字节', '${result.receivedBytes} 字节');
  return result;
}

function forwardCapacity(source, file) {
  // Keep the existing marker: only exact reviewed v1 hashes reach this point.
  if (file === 'src/core/backup.js') {
    let result = replaceOnce(source,
      'const MAX_ZIP = 9 * 1024 ** 3 // ZIP64 container cap; expanded data remains capped at 8 GiB',
      'const MAX_ZIP = 18 * 1024 ** 3 // ZIP64 container cap; expanded data remains capped at 16 GiB');
    return replaceOnce(result, 'const MAX_EXPANDED = 8 * 1024 ** 3', 'const MAX_EXPANDED = 16 * 1024 ** 3');
  }
  if (file === 'src/core/backup-push.js') {
    if (source.split('9 * 1024 ** 3').length !== 4) throw Error('Backup capacity forward context mismatch');
    return source.replaceAll('9 * 1024 ** 3', '18 * 1024 ** 3');
  }
  return source;
}

export function patchBackupCapacity(source, { file = 'src/core/backup.js', version = '1.3.0-beta.1' } = {}) {
  source = Buffer.isBuffer(source) ? source.toString('utf8') : source;
  if (typeof source !== 'string' || version !== '1.3.0-beta.1' || !Object.hasOwn(BACKUP_CAPACITY_BASELINES, file)) throw Error('Unsupported backup patch baseline');
  const before = hash(source);
  if (patchedHashes[file] === before) return { source, changed: false, file, before, after: before, marker: BACKUP_CAPACITY_MARKER };
  const transform = file === 'src/core/backup.js' ? patchBackup : file === 'src/core/backup-push.js' ? patchPush : patchHost;
  let output;
  if (before === previousHashes[file]) output = forwardCapacity(source, file);
  else if (before === BACKUP_CAPACITY_BASELINES[file]) output = forwardCapacity('// ' + BACKUP_CAPACITY_MARKER + '\n' + transform(source), file);
  else throw Error('Backup code differs from the verified baseline: ' + file);
  if (hash(output) !== patchedHashes[file]) throw Error('Backup patched output differs from the reviewed result: ' + file);
  return { source: output, changed: true, file, before, after: hash(output), marker: BACKUP_CAPACITY_MARKER };
}
