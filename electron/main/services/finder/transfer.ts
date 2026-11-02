import { constants, createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readlink, symlink, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FinderProgress } from '@shared/types/finder'

/**
 * Copying with progress — what Finder shows in its copy window: bytes done of
 * bytes in total, the file at hand, and a Stop button (`cancelled`). Small
 * files go through `copyFile` (a clone on APFS and btrfs, so instant); big
 * ones are streamed, so the bar moves inside a file too.
 */

/** Files above this are streamed (progress within the file). */
const STREAM_ABOVE = 32 * 1024 * 1024
/** At most this often a progress event. */
const REPORT_MS = 100

export class Cancelled extends Error {
  readonly code = 'cancelled'
  constructor() {
    super('Cancelled')
  }
}

/** One running operation: progress to report, and a flag the Stop button sets. */
export class Job {
  cancelled = false
  done = 0
  total = 0
  private last = 0

  constructor(
    readonly id: string,
    readonly kind: FinderProgress['kind'],
    private readonly emit: (p: FinderProgress) => void
  ) {}

  /** Bytes moved on (throttled). */
  report(file: string): void {
    const now = Date.now()
    if (now - this.last < REPORT_MS) return
    this.last = now
    this.emit({ id: this.id, kind: this.kind, done: this.done, total: this.total, file })
  }

  check(): void {
    if (this.cancelled) throw new Cancelled()
  }

  finish(): void {
    this.emit({ id: this.id, kind: this.kind, done: this.done, total: this.total, finished: true })
  }
}

/** Bytes, files and folders under `paths` (links count as themselves, never followed). */
export async function measure(paths: string[], job?: Job, deadline = Infinity): Promise<{ bytes: number; files: number; dirs: number; partial: boolean }> {
  const out = { bytes: 0, files: 0, dirs: 0, partial: false }
  const queue = [...paths]
  while (queue.length) {
    job?.check()
    if (Date.now() > deadline) {
      out.partial = true
      break
    }
    const path = queue.shift()!
    const st = await lstat(path).catch(() => null)
    if (!st) continue
    if (st.isDirectory()) {
      out.dirs += 1
      for (const name of await readdir(path).catch(() => [] as string[])) queue.push(join(path, name))
    } else {
      out.files += 1
      out.bytes += st.size
      if (job) {
        job.done = out.bytes
        job.report(path)
      }
    }
  }
  return out
}

/** Counts bytes as they stream past, and stops when the job is cancelled. */
function counter(job: Job, file: string): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      if (job.cancelled) return done(new Cancelled())
      job.done += chunk.length
      job.report(file)
      done(null, chunk)
    }
  })
}

/**
 * `src` → `dst` (which must not exist): folders recursively, links as links,
 * permissions and modification times kept. Sockets and devices are skipped.
 */
export async function copyTree(src: string, dst: string, job: Job): Promise<void> {
  job.check()
  const st = await lstat(src)
  if (st.isSymbolicLink()) {
    await symlink(await readlink(src), dst)
  } else if (st.isDirectory()) {
    await mkdir(dst)
    for (const name of await readdir(src)) await copyTree(join(src, name), join(dst, name), job)
    await chmod(dst, st.mode & 0o7777)
    await utimes(dst, st.atime, st.mtime)
  } else if (st.isFile()) {
    if (st.size > STREAM_ABOVE) {
      await pipeline(createReadStream(src), counter(job, src), createWriteStream(dst, { flags: 'wx', mode: st.mode & 0o7777 }))
    } else {
      await copyFile(src, dst, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
      job.done += st.size
      job.report(src)
    }
    await utimes(dst, st.atime, st.mtime)
  }
}
