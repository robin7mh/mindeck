import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/** An extension unpacked is a few MB; anything near this is no extension. */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

export interface ZipEntry {
  /** Relative path with forward slashes. */
  name: string
  data: Buffer
}

function bad(message: string): Error {
  return Object.assign(new Error(message), { code: 'bad-archive' })
}

/** A safe relative path inside the archive, or null for a directory entry. Escaping paths throw. */
export function entryPath(raw: string): string | null {
  const name = raw.replace(/\\/g, '/')
  if (name.endsWith('/')) return null
  const clean = posix.normalize(name)
  if (!clean || clean === '.' || clean.startsWith('/') || /^[a-z]:/i.test(clean) || clean === '..' || clean.startsWith('../') || clean.includes('\0')) {
    throw bad(`Unsafe path in the archive: ${raw}`)
  }
  return clean
}

/**
 * The files of a ZIP archive (stored or deflated — what Chrome's packer
 * writes). Reads the central directory, so data descriptors and junk before
 * the archive do not matter; ZIP64 and encryption are refused.
 */
export function readZip(buf: Buffer): ZipEntry[] {
  // The end-of-central-directory record sits in the last 22 + 65535 bytes (its comment).
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw bad('Not a ZIP archive')
  const count = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || at === 0xffffffff) throw bad('ZIP64 archives are not supported')
  const entries: ZipEntry[] = []
  let total = 0
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw bad('Broken ZIP directory')
    const flags = buf.readUInt16LE(at + 8)
    const method = buf.readUInt16LE(at + 10)
    const compressed = buf.readUInt32LE(at + 20)
    const size = buf.readUInt32LE(at + 24)
    const nameLength = buf.readUInt16LE(at + 28)
    const extraLength = buf.readUInt16LE(at + 30)
    const commentLength = buf.readUInt16LE(at + 32)
    const local = buf.readUInt32LE(at + 42)
    const name = entryPath(buf.toString(flags & 0x800 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength
    if (name === null) continue
    if (flags & 0x1) throw bad('Encrypted archives are not supported')
    total += size
    if (total > MAX_TOTAL_BYTES) throw bad('The archive is too large')
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL_SIGNATURE) throw bad('Broken ZIP entry')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + compressed)
    if (raw.length !== compressed) throw bad('Truncated ZIP entry')
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) })
    else throw bad(`Unsupported ZIP compression (${method})`)
    if (data.length !== size) throw bad('Corrupt ZIP entry')
    entries.push({ name, data })
  }
  return entries
}

/** Writes the archive's files under `dir`. */
export async function extractZip(buf: Buffer, dir: string): Promise<void> {
  const entries = readZip(buf)
  await mkdir(dir, { recursive: true })
  for (const entry of entries) {
    const target = join(dir, ...entry.name.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, entry.data)
  }
}
