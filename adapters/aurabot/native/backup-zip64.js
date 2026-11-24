// Aurabot's bounded, single-volume ZIP64 extension. Individual entries retain the
// existing ZIP32 sizes/CRC/encoding; only directory offsets and the end record grow.
// No file data is buffered by these helpers. The caller retains path, CRC,
// expanded-size and entry-size checks before it publishes a restore.
import { createHash, randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const U32 = 0xffffffff
const U16 = 0xffff
const invalid = () => new Error('备份 ZIP64 目录范围无效或超过限制')
const integer = (value, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw invalid()
  return value
}
const u64 = (bytes, offset, maximum) => {
  const value = bytes.readBigUInt64LE(offset)
  if (value > BigInt(maximum)) throw invalid()
  return Number(value)
}

export function withZip64Offset(header, offset) {
  integer(offset)
  if (offset < U32) return header
  if (header.length < 46 || header.readUInt32LE(0) !== 0x02014b50 || header.readUInt16LE(30)) throw invalid()
  const extra = Buffer.alloc(12)
  extra.writeUInt16LE(1, 0)
  extra.writeUInt16LE(8, 2)
  extra.writeBigUInt64LE(BigInt(offset), 4)
  header.writeUInt16LE(45, 4)
  header.writeUInt16LE(45, 6)
  header.writeUInt16LE(extra.length, 30)
  header.writeUInt32LE(U32, 42)
  return Buffer.concat([header, extra])
}

export function backupZipEnd(count, directorySize, directoryOffset) {
  integer(count, U16)
  integer(directorySize, U32 - 1)
  integer(directoryOffset)
  const extended = count >= U16 || directoryOffset >= U32
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(directorySize, 12)
  end.writeUInt32LE(Math.min(directoryOffset, U32), 16)
  if (!extended) return end
  const record = Buffer.alloc(56)
  record.writeUInt32LE(0x06064b50, 0)
  record.writeBigUInt64LE(44n, 4)
  record.writeUInt16LE(45, 12)
  record.writeUInt16LE(45, 14)
  record.writeBigUInt64LE(BigInt(count), 24)
  record.writeBigUInt64LE(BigInt(count), 32)
  record.writeBigUInt64LE(BigInt(directorySize), 40)
  record.writeBigUInt64LE(BigInt(directoryOffset), 48)
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  locator.writeBigUInt64LE(BigInt(directoryOffset + directorySize), 8)
  locator.writeUInt32LE(1, 16)
  return Buffer.concat([record, locator, end])
}

export async function backupZipDirectory(fh, size, readExact, { maxZip, maxDirectory }) {
  integer(size, maxZip)
  if (size < 22) throw invalid()
  const tailLength = Math.min(size, 22 + U16)
  const tail = await readExact(fh, tailLength, size - tailLength)
  let end = tailLength - 22
  while (end >= 0 && (tail.readUInt32LE(end) !== 0x06054b50 || end + 22 + tail.readUInt16LE(end + 20) !== tailLength)) end--
  if (end < 0 || tail.readUInt32LE(end + 4)) throw invalid()
  let count = tail.readUInt16LE(end + 10)
  let directorySize = tail.readUInt32LE(end + 12)
  let directoryOffset = tail.readUInt32LE(end + 16)
  let directoryEnd = size - tailLength + end
  if (tail.readUInt16LE(end + 8) !== count) throw invalid()
  const locatorAt = directoryEnd - 20
  const locator = locatorAt >= 0 ? await readExact(fh, 20, locatorAt) : null
  if (locator?.readUInt32LE(0) === 0x07064b50) {
    if (locator.readUInt32LE(4) || locator.readUInt32LE(16) !== 1) throw invalid()
    const recordAt = u64(locator, 8, maxZip)
    if (recordAt + 56 !== locatorAt) throw invalid()
    const record = await readExact(fh, 56, recordAt)
    if (record.readUInt32LE(0) !== 0x06064b50 || record.readBigUInt64LE(4) !== 44n
        || record.readUInt16LE(14) !== 45 || record.readUInt32LE(16) || record.readUInt32LE(20)) throw invalid()
    const total = u64(record, 32, U16)
    const bytes = u64(record, 40, maxDirectory)
    const offset = u64(record, 48, maxZip)
    if (u64(record, 24, U16) !== total || count !== total
        || directorySize !== bytes || directoryOffset !== Math.min(offset, U32)) throw invalid()
    count = total
    directorySize = bytes
    directoryOffset = offset
    directoryEnd = recordAt
  } else if (directoryOffset === U32 || directorySize === U32) throw invalid()
  if (!count || directorySize < count * 46 || directorySize > maxDirectory
      || directoryOffset + directorySize !== directoryEnd) throw invalid()
  return { count, dirSize: directorySize, dirOffset: directoryOffset }
}

// ZIP64 sizes are deliberately unsupported: existing per-file and inflater
// budgets remain unchanged. The only accepted ZIP64 extra payload is an offset.
export function backupEntryOffset(directory, position, nameLength, maxZip) {
  const original = directory.readUInt32LE(position + 42)
  const extraLength = directory.readUInt16LE(position + 30)
  let cursor = position + 46 + nameLength
  const end = cursor + extraLength
  if (end > directory.length) throw invalid()
  let offset = original
  let found = false
  while (cursor < end) {
    if (cursor + 4 > end) throw invalid()
    const tag = directory.readUInt16LE(cursor)
    const length = directory.readUInt16LE(cursor + 2)
    cursor += 4
    if (cursor + length > end) throw invalid()
    if (tag === 1) {
      if (found || original !== U32 || length !== 8
          || directory.readUInt32LE(position + 20) === U32 || directory.readUInt32LE(position + 24) === U32) throw invalid()
      found = true
      offset = u64(directory, cursor, maxZip)
      if (offset < U32) throw invalid()
    }
    cursor += length
  }
  if (original === U32 && !found) throw invalid()
  return offset
}

// Used by streamed imports and uploads. Buffers retain the old API, while an
// async iterable can carry a multi-GB file with bounded memory and backpressure.
export async function* boundedBackupChunks(input, maximum, expectedBytes) {
  integer(maximum)
  if (expectedBytes !== undefined) integer(expectedBytes, maximum)
  if (Buffer.isBuffer(input)) input = [input]
  if (!input || (!input[Symbol.asyncIterator] && !input[Symbol.iterator])) throw new Error('备份输入流无效')
  let bytes = 0
  for await (const raw of input) {
    if (!(raw instanceof Uint8Array)) throw new Error('备份输入流无效')
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
    bytes += chunk.length
    if (!Number.isSafeInteger(bytes) || bytes > maximum) throw new Error('备份文件大小超过限制')
    if (chunk.length) yield chunk
  }
  if (!bytes) throw new Error('备份文件是空的')
  if (expectedBytes !== undefined && bytes !== expectedBytes) throw new Error('备份文件读取不完整或已变化')
}

export async function splitBackupFile(source, destination, name, partSize, { openFile = open, publish = rename, remove = unlink } = {}) {
  integer(partSize, 100 * 1024 * 1024)
  if (!partSize || !/^aurabot-(?:backup|config)-\d{8}-\d{4}\.zip$/.test(name)) throw new Error('备份分卷参数无效')
  const file = await openFile(source, 'r')
  const written = []
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.size <= 0n || before.size > 18n * 1024n ** 3n) throw new Error('备份文件大小无效')
    const size = Number(before.size)
    const partWidth = Math.max(2, String(Math.ceil(size / partSize)).length)
    const block = Buffer.allocUnsafe(Math.min(1024 * 1024, partSize))
    for (let start = 0, index = 1; start < size; start += partSize, index++) {
      const part = `${name}.part${String(index).padStart(partWidth, '0')}`
      const temporary = join(destination, part + '.' + randomUUID() + '.tmp')
      const output = await openFile(temporary, 'wx', 0o600)
      const hash = createHash('sha256')
      const end = Math.min(size, start + partSize)
      try {
        try {
        for (let position = start; position < end;) {
          const length = Math.min(block.length, end - position)
          const { bytesRead } = await file.read(block, 0, length, position)
          if (!bytesRead) throw new Error('备份文件读取不完整')
          const data = block.subarray(0, bytesRead)
          hash.update(data)
          await output.writeFile(data)
          position += bytesRead
        }
        } finally { await output.close() }
        await publish(temporary, join(destination, part))
      } finally { await remove(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
      written.push({ name: part, bytes: end - start, sha256: hash.digest('hex') })
    }
    const after = await file.stat({ bigint: true })
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('备份文件在分卷期间已变化')
    return written
  } finally { await file.close() }
}
