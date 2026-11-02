import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, readdir, readlink, rename, rm, statfs, utimes, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { ZipFile } from 'yazl'
import { openPromise, type Entry } from 'yauzl'
import { Cancelled, type Job } from './transfer'

/**
 * Compress and extract like Finder's Archive Utility, in plain JS: ZIP both
 * ways (yazl / yauzl — ZIP64 for big archives), `.tar` / `.tar.gz` / `.tgz`
 * to extract. Archives are untrusted: every entry must land inside the
 * target folder (no `..`, no absolute paths — "Zip Slip"), links are never
 * created, and a ZIP that needs more space than the disk has is refused
 * before anything is written (a tar as soon as its files add up to more). Results appear atomically: work happens in a
 * hidden folder next to the archive, renamed into place at the end.
 */

const S_IFMT = 0o170000
const S_IFLNK = 0o120000
/** A pax or GNU long-name record is read into memory: real ones are a few hundred bytes. */
export const MAX_TAR_META = 1024 * 1024

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Archives Mindeck extracts, by name. */
export function archiveKind(name: string): 'zip' | 'tar' | 'tgz' | null {
  const n = name.toLowerCase()
  if (n.endsWith('.zip')) return 'zip'
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tgz'
  if (n.endsWith('.tar')) return 'tar'
  return null
}

/** The archive's name without its extension ("Fotos.tar.gz" → "Fotos"). */
function stemOf(name: string): string {
  return name.replace(/(\.tar\.gz|\.tgz|\.tar|\.zip)$/i, '') || name
}

/** Where an entry goes inside `root` ("./" is `root` itself) — refusing names that would leave it. */
export function safeTarget(root: string, name: string): string {
  const clean = name.replace(/\\/g, '/')
  const parts = clean.split('/').filter((p) => p && p !== '.')
  if (clean.startsWith('/') || /^[a-z]:/i.test(clean) || clean.includes('\0') || parts.includes('..')) {
    throw coded('unsafe-archive', `The archive contains an unsafe path: ${name}`)
  }
  return resolve(root, ...parts)
}

/** Counts bytes through a stream, stopping when the job is cancelled. */
function counted(job: Job, file: string): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      if (job.cancelled) return done(new Cancelled())
      job.done += chunk.length
      job.report(file)
      done(null, chunk)
    }
  })
}

/** Every file, folder and link under `src`, with its name inside the archive. */
async function collect(src: string, name: string, out: { path: string; name: string }[]): Promise<void> {
  if (basename(src) === '.DS_Store') return
  out.push({ path: src, name })
  const st = await lstat(src)
  if (st.isDirectory()) for (const child of (await readdir(src)).sort()) await collect(join(src, child), `${name}/${child}`, out)
}

/** `paths` → a new ZIP at `out` (written to a temp name first). */
export async function zip(paths: string[], out: string, job: Job): Promise<void> {
  const items: { path: string; name: string }[] = []
  for (const p of paths) await collect(p, basename(p), items)
  const stats = await Promise.all(items.map((i) => lstat(i.path)))
  job.total = stats.reduce((sum, st) => sum + (st.isFile() ? st.size : 0), 0)
  const tmp = join(dirname(out), `.${basename(out)}.${randomUUID().slice(0, 8)}.part`)
  const archive = new ZipFile()
  try {
    await new Promise<void>((done, fail) => {
      const file = createWriteStream(tmp, { flags: 'wx' })
      archive.on('error', (err) => {
        file.destroy()
        fail(err)
      })
      file.on('error', fail)
      file.on('close', () => done())
      archive.outputStream.pipe(file)
      items.forEach((item, i) => {
        const st = stats[i]
        const opts = { mtime: st.mtime, mode: st.mode }
        if (st.isDirectory()) archive.addEmptyDirectory(item.name, opts)
        else if (st.isSymbolicLink()) {
          // Stored as a link (what `zip -y` and Finder do); never followed.
          archive.addReadStreamLazy(item.name, { ...opts, compress: false }, (cb) =>
            void readlink(item.path).then((target) => cb(null, Readable.from([Buffer.from(target)])), (err) => cb(err, undefined as never))
          )
        } else if (st.isFile()) {
          archive.addReadStreamLazy(item.name, { ...opts, size: st.size }, (cb) => {
            const source = createReadStream(item.path)
            const count = counted(job, item.path)
            source.on('error', (err) => count.destroy(err))
            // yazl does not watch the streams it is given: their errors (and Stop) end the archive here.
            count.on('error', (err) => archive.emit('error', err))
            cb(null, source.pipe(count))
          })
        }
      })
      archive.end()
    })
    await rename(tmp, out)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

/** Moves what was extracted into `work` next to the archive: one item under its own name, several in a folder named like the archive. */
async function settle(work: string, dir: string, stem: string, freeName: (dir: string, name: string) => Promise<string>): Promise<string> {
  const top = await readdir(work)
  // A hidden one goes into the folder: `.zshenv` or `.git` next to the archive would be read as configuration.
  if (top.length === 1 && !top[0].startsWith('.')) {
    const target = await freeName(dir, top[0])
    await rename(join(work, top[0]), target)
    await rm(work, { recursive: true, force: true })
    return target
  }
  // …and that folder is never hidden itself (".git.zip").
  const target = await freeName(dir, stem.replace(/^\.+/, '') || 'Archive')
  await rename(work, target)
  return target
}

/** Extracts `archive` next to itself; returns what it created. */
export async function extract(archive: string, job: Job, freeName: (dir: string, name: string) => Promise<string>): Promise<string> {
  // The service only hands over names archiveKind() knows.
  const kind = archiveKind(archive)!
  const dir = dirname(archive)
  const work = join(dir, `.${basename(archive)}.${randomUUID().slice(0, 8)}.extracting`)
  await mkdir(work)
  try {
    if (kind === 'zip') await unzip(archive, work, job)
    else await untar(archive, kind === 'tgz', work, job)
    return await settle(work, dir, stemOf(basename(archive)), freeName)
  } catch (err) {
    await rm(work, { recursive: true, force: true })
    throw err
  }
}

async function unzip(archive: string, root: string, job: Job): Promise<void> {
  const zipfile = await openPromise(archive, { autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: false })
  try {
    // First the directory (cheap: no data read) — to check every name and the space needed.
    const entries: Entry[] = []
    for await (const entry of zipfile.eachEntry()) {
      if (entry.fileName.startsWith('__MACOSX/')) continue // Finder's resource forks
      if (entry.isEncrypted()) throw coded('encrypted', 'Password-protected archives cannot be extracted here')
      safeTarget(root, entry.fileName)
      entries.push(entry)
    }
    job.total = entries.reduce((sum, e) => sum + e.uncompressedSize, 0)
    const disk = await statfs(root)
    if (job.total > disk.bavail * disk.bsize) throw coded('no-space', 'Not enough free space to extract this archive')

    for (const entry of entries) {
      job.check()
      const target = safeTarget(root, entry.fileName)
      const mode = (entry.externalFileAttributes >>> 16) & 0xffff
      if (entry.fileName.endsWith('/')) {
        await mkdir(target, { recursive: true })
        continue
      }
      if ((mode & S_IFMT) === S_IFLNK) continue // links are never created
      await mkdir(dirname(target), { recursive: true })
      const data = await zipfile.openReadStreamPromise(entry)
      // Archives made on Windows carry no permissions: then the usual rw-r--r--.
      await pipeline(data, counted(job, entry.fileName), createWriteStream(target, { flags: 'wx', mode: mode & 0o777 ? (mode & 0o777) | 0o600 : 0o644 }))
      await utimes(target, entry.getLastModDate(), entry.getLastModDate())
    }
  } finally {
    zipfile.close()
  }
}

/** One tar header's fields (ustar, with GNU base-256 sizes). */
function header(block: Buffer): { name: string; mode: number; size: number; mtime: number; type: string } {
  const text = (from: number, len: number) => block.subarray(from, from + len).toString('utf8').replace(/\0.*$/s, '')
  const octal = (from: number, len: number) => parseInt(text(from, len).trim() || '0', 8)
  let sum = 0
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : block[i]
  if (sum !== octal(148, 8)) throw coded('bad-archive', 'This is not a valid tar archive')
  // Sizes above 8 GB are base-256 (high bit set).
  const size = block[124] & 0x80 ? block.subarray(125, 136).reduce((n, b) => n * 256 + b, 0) : octal(124, 12)
  const prefix = text(257, 6) === 'ustar' ? text(345, 155) : ''
  const name = text(0, 100)
  return { name: prefix ? `${prefix}/${name}` : name, mode: octal(100, 8), size, mtime: octal(136, 12), type: text(156, 1) || '0' }
}

/** pax records: "27 path=a very long name\n". */
function paxPath(data: Buffer): string | undefined {
  for (const line of data.toString('utf8').split('\n')) {
    const m = /^\d+ path=(.*)$/s.exec(line)
    if (m) return m[1]
  }
  return undefined
}

async function untar(archive: string, gzip: boolean, root: string, job: Job): Promise<void> {
  job.total = (await lstat(archive)).size
  // A .tar.gz does not say how big it unpacks: its files may not add up to more than the disk has free.
  const disk = await statfs(root)
  let room = disk.bavail * disk.bsize
  const source = createReadStream(archive)
  // Progress is the archive read so far (a .gz does not say how big it unpacks).
  const progress = counted(job, archive)
  const input = gzip ? source.pipe(progress).pipe(createGunzip()) : source.pipe(progress)
  source.on('error', (err) => input.destroy(err))
  progress.on('error', (err) => input.destroy(err))

  let pending: Buffer = Buffer.alloc(0)
  /** The entry whose data is being read: where it goes, how much is left, the padding to the next block. */
  let body: { left: number; pad: number; write: (chunk: Buffer) => Promise<unknown> | void; end: () => Promise<void> } | null = null
  let nextName: string | undefined
  let handle: FileHandle | undefined

  const start = async (h: ReturnType<typeof header>) => {
    const pad = (512 - (h.size % 512)) % 512
    const collect = (use: (data: Buffer) => void) => {
      const parts: Buffer[] = []
      return { left: h.size, pad, write: (c: Buffer) => void parts.push(c), end: async () => use(Buffer.concat(parts)) }
    }
    const skip = { left: h.size, pad, write: () => {}, end: async () => {} }
    if ((h.type === 'x' || h.type === 'L') && h.size > MAX_TAR_META) throw coded('bad-archive', 'The archive has an oversized header')
    if (h.type === 'x') return collect((data) => (nextName = paxPath(data) ?? nextName))
    if (h.type === 'L') return collect((data) => (nextName = data.toString('utf8').replace(/\0+$/, '')))
    const name = nextName ?? h.name
    nextName = undefined
    if (h.type === '5') {
      await mkdir(safeTarget(root, name), { recursive: true })
      return skip
    }
    // Regular files only: links, devices, global headers … are skipped.
    if (h.type !== '0' && h.type !== '7') return skip
    const target = safeTarget(root, name)
    if ((room -= h.size) < 0) throw coded('no-space', 'Not enough free space to extract this archive')
    await mkdir(dirname(target), { recursive: true })
    handle = await open(target, 'wx', (h.mode & 0o777) | 0o600)
    const file = handle
    return {
      left: h.size,
      pad,
      write: (c: Buffer) => file.write(c),
      end: async () => {
        await file.close()
        handle = undefined
        await utimes(target, h.mtime, h.mtime)
      }
    }
  }

  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      pending = Buffer.concat([pending, chunk])
      for (;;) {
        if (body) {
          const n = Math.min(body.left, pending.length)
          if (n) await body.write(pending.subarray(0, n))
          body.left -= n
          pending = pending.subarray(n)
          if (body.left) break
          const pad = Math.min(body.pad, pending.length)
          pending = pending.subarray(pad)
          body.pad -= pad
          if (body.pad) break
          await body.end()
          body = null
        }
        if (pending.length < 512) break
        const block = pending.subarray(0, 512)
        pending = pending.subarray(512)
        if (block.every((b) => b === 0)) continue // the end: two zero blocks
        job.check()
        body = await start(header(block))
      }
    }
    if (body) throw coded('bad-archive', 'The archive ends in the middle of a file')
  } finally {
    source.destroy()
    await handle?.close()
  }
}
