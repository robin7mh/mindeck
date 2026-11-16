import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { appendFile, lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import {
  extOf,
  FINDER_CHUNK,
  fileType,
  type FinderChunk,
  type FinderEntry,
  type FinderInfo,
  type FinderListing,
  type FinderPlaceId,
  type FinderPlaces,
  type FinderPreview,
  type FinderProgress,
  type FolderSize,
  type TransferRequest,
  type TransferResult,
  type TrashedItem,
  type UntrashResult
} from '@shared/types/finder'
import { Cancelled, copyTree, Job, measure } from './transfer'
import { archiveKind, extract, zip } from './archive'

/** Entries per page of a folder: the first page shows at once, the rest follows. */
const PAGE = 1000
/** How long a big folder's names are kept for its next pages. */
const LISTING_TTL_MS = 30_000
/** Counting a folder's size stops after this long (and says so). */
const SIZE_MS = 30_000
const MAX_RESULTS = 300
/** The beginning of a text file the preview shows. */
const PREVIEW_BYTES = 256 * 1024
/** Folders the fallback search walks at most, and how long. */
const SEARCH_DIRS = 20_000
const SEARCH_MS = 4000
const SKIP_DIRS = new Set(['node_modules', '.git', '.Trash', 'Library', '.cache', '.npm', '__pycache__', '.venv'])
/** macOS system partitions that show up in /Volumes — Finder hides them too. */
const SYSTEM_VOLUMES = new Set(['Recovery', 'Preboot', 'VM', 'Update', 'xarts', 'iSCPreboot', 'Hardware'])

/** macOS packages: folders that Finder shows and opens as one file. */
const BUNDLES = new Set(['.app', '.bundle', '.framework', '.plugin', '.kext', '.prefpane', '.photoslibrary', '.musiclibrary', '.xcodeproj', '.xcworkspace', '.pages', '.numbers', '.key', '.rtfd', '.playground'])

const PLACES: { id: Exclude<FinderPlaceId, 'home'>; dir: string; alt?: string }[] = [
  { id: 'desktop', dir: 'Desktop' },
  { id: 'documents', dir: 'Documents' },
  { id: 'downloads', dir: 'Downloads' },
  { id: 'pictures', dir: 'Pictures' },
  { id: 'movies', dir: 'Movies', alt: 'Videos' },
  { id: 'music', dir: 'Music' }
]

export interface FinderDeps {
  home?: string
  /** Where Mindeck may change files (default: Home and external drives). */
  writableRoots?: string[]
  /** Writable too: Mindeck's own folder, wherever MINDECK_HOME puts it. */
  alsoWritable?: string[]
  /** Where external drives are mounted (default per OS). */
  volumeDirs?: string[]
  openPath?: (path: string) => Promise<void>
  revealPath?: (path: string) => void
  /** Hand a link to the system (System Settings' privacy pane on macOS). */
  openExternal?: (url: string) => Promise<void>
  trash: (path: string) => Promise<void>
  /** A trash Mindeck can put things back from (`platform/trash.ts`) — makes trashing undoable. */
  restorableTrash?: { trash(path: string): Promise<string | undefined>; restore(trashed: string, to: string): Promise<void> }
  /** Files on the system clipboard (desktop only). */
  clipboard?: { write(paths: string[], cut: boolean): Promise<void>; read(): Promise<string[]> }
  /** Spotlight: paths under `dir` whose name matches `query`. Absent where there is none. */
  spotlight?: (dir: string, query: string) => Promise<string[]>
  /** Long operations report here (copies, archives, folder sizes). */
  progress?: (p: FinderProgress) => void
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** macOS Spotlight by file name, through `mdfind` (structured arguments, no shell). */
export function macSpotlight(dir: string, query: string): Promise<string[]> {
  return new Promise((resolveSearch, reject) => {
    execFile('mdfind', ['-onlyin', dir, '-name', query], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolveSearch(stdout.split('\n').filter(Boolean))
    })
  })
}

/** Spotlight where the system has it (macOS); elsewhere the walk. */
export function spotlightFor(platform: NodeJS.Platform): typeof macSpotlight | undefined {
  return platform === 'darwin' ? macSpotlight : undefined
}

/** Default places drives show up in. */
function defaultVolumeDirs(home: string): string[] {
  if (process.platform === 'darwin') return ['/Volumes']
  if (process.platform === 'linux') return [join('/media', basename(home)), join('/run/media', basename(home)), '/mnt']
  return []
}

/** A file or folder name the user typed: one name, nothing that walks the tree. */
export function checkName(name: string): string {
  const n = name.trim()
  if (!n || n === '.' || n === '..' || /[/\\\0]/.test(n) || Buffer.byteLength(n) > 255) {
    throw coded('bad-name', `Not a valid name: ${name}`)
  }
  return n
}

/** `name 2.ext`, `name 3.ext`, … — the first that does not exist in `dir`. */
export async function freeName(dir: string, name: string): Promise<string> {
  if (!(await exists(join(dir, name)))) return join(dir, name)
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let i = 2
  while (await exists(join(dir, `${stem} ${i}${ext}`))) i += 1
  return join(dir, `${stem} ${i}${ext}`)
}

/**
 * The machine's files, like Finder (architecture §12.9): folders, places,
 * search, previews, and the everyday changes — new folder, rename, move, copy,
 * trash. Reading works anywhere the user can read; changes only inside Home
 * and on external drives, and deleting only ever moves to the trash.
 */
export class FinderService {
  private readonly home: string
  private readonly roots: string[]
  /** Running operations by id — the Stop button cancels them. */
  private readonly jobs = new Map<string, Job>()
  /** Big folders' sorted names, for their next pages. */
  private listings = new Map<string, { at: number; dirents: Dirent[] }>()

  constructor(private readonly deps: FinderDeps) {
    this.home = deps.home ?? homedir()
    this.roots = [...(deps.writableRoots ?? [this.home, ...defaultVolumeDirs(this.home)]), ...(deps.alsoWritable ?? [])]
  }

  async places(): Promise<FinderPlaces> {
    const places: FinderPlaces['places'] = [{ id: 'home', path: this.home }]
    for (const p of PLACES) {
      for (const dir of [p.dir, p.alt]) {
        const path = dir && join(this.home, dir)
        if (path && (await isDir(path))) {
          places.push({ id: p.id, path })
          break
        }
      }
    }
    const volumes: FinderPlaces['volumes'] = []
    for (const base of this.deps.volumeDirs ?? defaultVolumeDirs(this.home)) {
      const names = await readdir(base).catch(() => [] as string[])
      for (const name of names.filter((n) => !n.startsWith('.') && !SYSTEM_VOLUMES.has(n)).sort((a, b) => a.localeCompare(b))) {
        const path = join(base, name)
        // macOS lists the startup disk too, as a link to "/" — it is not an external drive.
        if ((await realpath(path).catch(() => '/')) !== '/' && (await isDir(path))) volumes.push({ name, path })
      }
    }
    return { home: this.home, places, volumes }
  }

  /**
   * One page of a folder, `offset` on: folders first, then by name (the UI
   * sorts again by its column). The first page reads the folder; for a big
   * one the names are kept a while, so the next pages are quick and stable.
   */
  async list(path?: string, hidden = false, offset = 0): Promise<FinderListing> {
    const dir = this.absolute(path ?? this.home)
    if (!(await isDir(dir))) throw coded('not-found', `Folder not found: ${dir}`)
    const key = `${hidden ? 'h' : 'v'}:${dir}`
    const cached = this.listings.get(key)
    let dirents = offset && cached && Date.now() - cached.at < LISTING_TTL_MS ? cached.dirents : undefined
    if (!dirents) {
      const all = await readdir(dir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
        throw coded(err.code === 'EACCES' || err.code === 'EPERM' ? 'no-access' : 'error', `Cannot read ${dir}: ${err.message}`)
      })
      const shown = all.filter((d) => hidden || !d.name.startsWith('.'))
      // Links to folders sort with the folders: only links need a stat.
      const folders = new Set(shown.filter((d) => d.isDirectory()).map((d) => d.name))
      for (const d of shown.filter((x) => x.isSymbolicLink())) if (await isDir(join(dir, d.name))) folders.add(d.name)
      dirents = shown.sort((a, b) => {
        const fa = folders.has(a.name)
        return fa === folders.has(b.name) ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : fa ? -1 : 1
      })
      if (dirents.length > PAGE) {
        // A few folders at most — the ones being paged through right now.
        this.listings = new Map([...this.listings].filter(([, l]) => Date.now() - l.at < LISTING_TTL_MS).slice(-3))
        this.listings.set(key, { at: Date.now(), dirents })
      }
    }
    const entries = await entriesOf(dir, dirents.slice(offset, offset + PAGE))
    const parent = dirname(dir)
    return { path: dir, parent: parent === dir ? null : parent, entries, total: dirents.length, offset }
  }

  /** Files and folders under `path` whose name contains `query` — Spotlight where there is one, else a bounded walk. */
  async search(path: string, query: string): Promise<FinderEntry[]> {
    const dir = this.absolute(path)
    const q = query.trim().toLowerCase()
    if (!q) return []
    if (this.deps.spotlight) {
      const prefix = dir.endsWith(sep) ? dir : dir + sep
      const found = await this.deps.spotlight(dir, query.trim()).then(
        (paths) => paths.filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).split(sep).some((s) => s.startsWith('.'))),
        () => [] // Spotlight off or indexing
      )
      // Nothing may only mean the folder isn't indexed (excluded from Spotlight, a network drive): walk then.
      if (found.length) return (await Promise.all(found.slice(0, MAX_RESULTS).map((p) => entryAt(p)))).filter((e): e is FinderEntry => !!e)
    }
    return this.walk(dir, q)
  }

  async preview(path: string): Promise<FinderPreview> {
    const abs = this.absolute(path)
    const entry = await entryAt(abs)
    if (!entry) throw coded('not-found', `Not found: ${abs}`)
    if (entry.bundle) return { entry, type: 'binary' }
    if (entry.kind === 'dir') {
      const items = (await readdir(abs).catch(() => [] as string[])).filter((n) => !n.startsWith('.')).length
      return { entry, type: 'dir', items }
    }
    const type = fileType(entry.name)
    if (type !== 'text' && type !== 'binary') return { entry, type }
    const head = await readHead(abs, PREVIEW_BYTES)
    // A NUL byte early on means binary, whatever the name says; an unknown name counts as text when it reads like text.
    if (head.subarray(0, 8192).includes(0) || (type === 'binary' && !looksLikeText(head))) return { entry, type: 'binary' }
    return { entry, type: 'text', text: head.toString('utf8'), truncated: entry.size > PREVIEW_BYTES }
  }

  /** A piece of a file, for another device to show or keep (base64, at most FINDER_CHUNK bytes). */
  async read(path: string, offset = 0, length = FINDER_CHUNK): Promise<FinderChunk> {
    const abs = this.absolute(path)
    const info = await stat(abs).catch(() => null)
    if (!info?.isFile()) throw coded('not-found', `Not a file: ${abs}`)
    const want = Math.max(0, Math.min(length, FINDER_CHUNK, info.size - offset))
    const handle = await open(abs, 'r')
    try {
      const buf = Buffer.alloc(want)
      const { bytesRead } = await handle.read(buf, 0, want, offset)
      return { data: buf.subarray(0, bytesRead).toString('base64'), offset, size: info.size, mime: mimeOf(basename(abs)), eof: offset + bytesRead >= info.size }
    } finally {
      await handle.close()
    }
  }

  /**
   * A piece of a file from another device. Offset 0 makes the file — over one
   * that is there only with `replace`, and that one goes to the trash; a later
   * piece goes on at the end, which must be where `offset` says (no gaps, no
   * overlaps from a retried upload).
   */
  async write(path: string, data: string, offset = 0, replace = false): Promise<{ size: number }> {
    const target = this.absolute(path)
    checkName(basename(target))
    await this.assertWritable(target)
    const bytes = Buffer.from(data, 'base64')
    if (offset === 0) {
      if (await exists(target)) {
        if (!replace) throw coded('exists', `“${basename(target)}” already exists`)
        await this.trashOne(target)
      }
      await writeFile(target, bytes, { flag: 'wx' })
    } else {
      const info = await stat(target).catch(() => null)
      if (!info?.isFile()) throw coded('not-found', `Not a file: ${target}`)
      if (info.size !== offset) throw coded('bad-offset', `The file has ${info.size} bytes, not ${offset}`)
      await appendFile(target, bytes)
    }
    return { size: (await stat(target)).size }
  }

  async mkdir(parent: string, name: string): Promise<string> {
    const target = join(this.absolute(parent), checkName(name))
    await this.assertWritable(target)
    await mkdir(target).catch((err: NodeJS.ErrnoException) => {
      throw coded(err.code === 'EEXIST' ? 'exists' : 'error', err.code === 'EEXIST' ? `“${basename(target)}” already exists` : err.message)
    })
    return target
  }

  async rename(path: string, name: string): Promise<string> {
    const from = this.absolute(path)
    const to = join(dirname(from), checkName(name))
    if (to === from) return from
    await this.assertWritable(from)
    // On case-insensitive disks "a" → "A" finds "a" itself: only a different file blocks.
    if (to.toLowerCase() !== from.toLowerCase() && (await lstat(to).then(() => true, () => false))) {
      throw coded('exists', `“${basename(to)}” already exists`)
    }
    await rename(from, to)
    return to
  }

  /** Into the trash — with where each went when Mindeck can put it back. */
  async trash(paths: string[]): Promise<TrashedItem[]> {
    const targets = paths.map((p) => this.absolute(p))
    for (const t of targets) await this.assertWritable(t)
    const out: TrashedItem[] = []
    for (const t of targets) out.push(await this.trashOne(t))
    return out
  }

  /**
   * Undo for the trash: back to where they were. A name taken there since
   * keeps both (the returning one gets a number, as when copying); what is no
   * longer in the trash is listed in `gone` while the rest comes back.
   */
  async untrash(items: { path: string; restore: string }[]): Promise<UntrashResult> {
    const trash = this.deps.restorableTrash
    if (!trash) throw coded('no-undo', 'This trash cannot be undone from Mindeck')
    const result: UntrashResult = { items: [], gone: [] }
    for (const item of items) {
      const path = this.absolute(item.path)
      await this.assertWritable(path)
      const to = await freeName(dirname(path), basename(path))
      try {
        await trash.restore(this.absolute(item.restore), to)
        result.items.push({ path, to })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'trash-gone') throw err
        result.gone.push(path)
      }
    }
    return result
  }

  /** macOS: System Settings at Full Disk Access — what taking things out of the Trash needs. */
  async privacySettings(): Promise<void> {
    if (!this.deps.openExternal) throw coded('desktop-only', 'System Settings can only be opened from the Mindeck desktop app')
    await this.deps.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
  }

  /** Into `dest`; a name that is taken there gets a number (nothing is replaced). */
  async move(paths: string[], dest: string): Promise<string[]> {
    return (await this.transfer({ id: randomUUID(), paths, dest, mode: 'move' })).items.map((i) => i.to)
  }

  async copy(paths: string[], dest: string): Promise<string[]> {
    return (await this.transfer({ id: randomUUID(), paths, dest, mode: 'copy' })).items.map((i) => i.to)
  }

  /** Names of `paths` that are taken in `dest` already — what the conflict dialog asks about. */
  async conflicts(paths: string[], dest: string): Promise<string[]> {
    const into = this.absolute(dest)
    const out: string[] = []
    for (const p of paths.map((x) => this.absolute(x))) {
      if (dirname(p) !== into && (await exists(join(into, basename(p))))) out.push(basename(p))
    }
    return out
  }

  /**
   * Copy or move into `dest`, with progress and a way to stop. A taken name
   * is decided per entry: keep both (the new one gets a number), skip, or
   * replace — the one in the way goes to the trash, never deleted. Copying
   * into the same folder duplicates; moving there changes nothing.
   */
  async transfer(req: TransferRequest): Promise<TransferResult> {
    const into = await this.destination(req.dest)
    const sources = req.paths.map((p) => this.absolute(p))
    for (const p of sources) {
      if (req.mode === 'move') await this.assertWritable(p)
      this.assertNotInside(into, p)
    }
    const job = this.startJob(req.id, req.mode)
    const result: TransferResult = { items: [], replaced: [], skipped: [] }
    try {
      // Moves on one disk are renames; copies (and moves to another disk) count bytes.
      if (req.mode === 'copy') job.total = (await measure(sources)).bytes
      for (const p of sources) {
        job.check()
        const name = basename(p)
        let target = join(into, name)
        if (dirname(p) === into) {
          if (req.mode === 'move') continue
          target = await freeName(into, name)
        } else if (await exists(target)) {
          const choice = req.choices?.[name] ?? 'keep'
          if (choice === 'skip') {
            result.skipped.push(p)
            continue
          }
          if (choice === 'keep') target = await freeName(into, name)
          else {
            // Replacing the folder that holds what is being moved would throw that away too.
            if (p.startsWith(target + sep)) throw coded('bad-move', `“${name}” cannot replace the folder it is in`)
            result.replaced.push(await this.trashOne(target))
          }
        }
        if (req.mode === 'move') await this.moveOne(p, target, job)
        else await this.copyOne(p, target, job)
        result.items.push({ from: p, to: target })
      }
    } catch (err) {
      if (!(err instanceof Cancelled)) throw err
      result.cancelled = true
    } finally {
      this.endJob(job)
    }
    return result
  }

  /** Stop a running copy, archive or count. */
  cancel(id: string): void {
    const job = this.jobs.get(id)
    if (job) job.cancelled = true
  }

  /** Undo for rename and move: each `from` back to exactly `to` (which must be free). */
  async restore(moves: { from: string; to: string }[]): Promise<void> {
    const job = new Job(randomUUID(), 'move', () => {})
    for (const m of moves) {
      const from = this.absolute(m.from)
      const to = this.absolute(m.to)
      await this.assertWritable(from)
      await this.assertWritable(to)
      await this.assertFree(to)
      await this.moveOne(from, to, job)
    }
  }

  /** The Info panel: dates, permissions, owner — and whether Mindeck may change it. */
  async info(path: string): Promise<FinderInfo> {
    const abs = this.absolute(path)
    const entry = await entryAt(abs)
    if (!entry) throw coded('not-found', `Not found: ${abs}`)
    const st = await stat(abs).catch(() => lstat(abs))
    const me = process.getuid?.()
    return {
      entry,
      createdMs: st.birthtimeMs,
      accessedMs: st.atimeMs,
      mode: st.mode & 0o7777,
      owner: me !== undefined && st.uid === me ? userInfo().username : null,
      writable: await this.assertWritable(abs).then(
        () => true,
        () => false
      )
    }
  }

  /** What a folder holds in all — counted for at most 30 s (then it says it is a minimum). */
  async folderSize(path: string, id: string): Promise<FolderSize> {
    const abs = this.absolute(path)
    const job = this.startJob(id, 'size')
    // Counting skips what it cannot read — only Stop ends it early.
    const m = await measure([abs], job, Date.now() + SIZE_MS)
      .catch(() => null)
      .finally(() => this.endJob(job))
    if (!m) return { bytes: job.done, files: 0, folders: 0, partial: true }
    // The folder itself is not one of its folders.
    return { bytes: m.bytes, files: m.files, folders: Math.max(0, m.dirs - 1), partial: m.partial }
  }

  /** The selection → a ZIP next to it ("name.zip" for one, "Archive.zip" for several). Returns its path. */
  async compress(paths: string[], id: string): Promise<string> {
    const sources = paths.map((p) => this.absolute(p))
    const dir = dirname(sources[0])
    const out = await freeName(dir, sources.length === 1 ? `${basename(sources[0])}.zip` : 'Archive.zip')
    await this.assertWritable(out)
    const job = this.startJob(id, 'zip')
    try {
      await zip(sources, out, job)
      return out
    } finally {
      this.endJob(job)
    }
  }

  /** A .zip, .tar, .tar.gz or .tgz → extracted next to it. Returns what it created. */
  async extract(path: string, id: string): Promise<string> {
    const archive = this.absolute(path)
    if (!archiveKind(archive)) throw coded('not-archive', 'Mindeck extracts .zip, .tar, .tar.gz and .tgz archives')
    await this.assertWritable(join(dirname(archive), '.probe'))
    const job = this.startJob(id, 'unzip')
    try {
      return await extract(archive, job, freeName)
    } finally {
      this.endJob(job)
    }
  }

  /** Paths onto the system clipboard, so Finder / Explorer can paste them. */
  async clipboardWrite(paths: string[], cut: boolean): Promise<void> {
    if (!this.deps.clipboard) throw coded('desktop-only', 'The clipboard is only available in the Mindeck desktop app')
    await this.deps.clipboard.write(paths.map((p) => this.absolute(p)), cut)
  }

  /** Files copied in Finder / Explorer (those that exist). */
  async clipboardRead(): Promise<string[]> {
    const paths = ((await this.deps.clipboard?.read()) ?? []).filter((p) => isAbsolute(p))
    const there = await Promise.all(paths.map((p) => exists(p)))
    return paths.filter((_, i) => there[i])
  }

  async open(path: string): Promise<void> {
    if (!this.deps.openPath) throw coded('desktop-only', 'Opening files is only available in the Mindeck desktop app')
    await this.deps.openPath(this.absolute(path))
  }

  reveal(path: string): void {
    if (!this.deps.revealPath) throw coded('desktop-only', 'Showing files is only available in the Mindeck desktop app')
    this.deps.revealPath(this.absolute(path))
  }

  private async trashOne(path: string): Promise<TrashedItem> {
    const trash = this.deps.restorableTrash
    if (trash) {
      try {
        const restore = await trash.trash(path)
        return restore ? { path, restore } : { path }
      } catch (err) {
        // Another disk: its own trash, through the OS.
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      }
    }
    await this.deps.trash(path)
    return { path }
  }

  private async copyOne(from: string, to: string, job: Job): Promise<void> {
    try {
      await copyTree(from, to, job)
    } catch (err) {
      // Never leave half a copy behind.
      await rm(to, { recursive: true, force: true })
      throw err
    }
  }

  private async moveOne(from: string, to: string, job: Job): Promise<void> {
    await rename(from, to).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EXDEV') throw err
      // Another disk: copy, then remove the original.
      job.total += (await measure([from])).bytes
      await this.copyOne(from, to, job)
      await rm(from, { recursive: true, force: true })
    })
  }

  private startJob(id: string, kind: FinderProgress['kind']): Job {
    const job = new Job(id, kind, (p) => this.deps.progress?.(p))
    this.jobs.set(id, job)
    return job
  }

  private endJob(job: Job): void {
    this.jobs.delete(job.id)
    job.finish()
  }

  private async assertFree(path: string): Promise<void> {
    if (await exists(path)) throw coded('exists', `“${basename(path)}” already exists`)
  }

  private absolute(path: string): string {
    if (!isAbsolute(path)) throw coded('bad-path', 'Path must be absolute')
    return resolve(path)
  }

  /** Only inside Home and on external drives — never the system, never a root itself. */
  private async assertWritable(target: string): Promise<void> {
    const parent = await realpath(dirname(target)).catch(() => {
      throw coded('not-found', `Folder not found: ${dirname(target)}`)
    })
    const roots = await Promise.all(this.roots.map((r) => realpath(r).catch(() => r)))
    const inside = roots.some((r) => parent === r || parent.startsWith(r + sep))
    if (!inside || roots.includes(target)) throw coded('read-only', 'Mindeck only changes files in your home folder and on external drives')
  }

  private assertNotInside(dest: string, source: string): void {
    if (dest === source || dest.startsWith(source + sep)) throw coded('bad-move', 'A folder cannot go into itself')
  }

  private async destination(dest: string): Promise<string> {
    const into = this.absolute(dest)
    if (!(await isDir(into))) throw coded('not-found', `Folder not found: ${into}`)
    await this.assertWritable(join(into, '.probe'))
    return into
  }

  private async walk(root: string, q: string): Promise<FinderEntry[]> {
    const found: FinderEntry[] = []
    const queue = [root]
    const started = Date.now()
    let dirs = 0
    while (queue.length && found.length < MAX_RESULTS && dirs < SEARCH_DIRS && Date.now() - started < SEARCH_MS) {
      const dir = queue.shift()!
      dirs += 1
      const dirents = await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[])
      const hits: Dirent[] = []
      for (const d of dirents) {
        if (d.name.startsWith('.')) continue
        if (d.name.toLowerCase().includes(q)) hits.push(d)
        if (d.isDirectory() && !SKIP_DIRS.has(d.name) && !BUNDLES.has(extname(d.name).toLowerCase())) queue.push(join(dir, d.name))
      }
      found.push(...(await entriesOf(dir, hits)))
    }
    return found.slice(0, MAX_RESULTS)
  }
}

const exists = (p: string) => lstat(p).then(() => true, () => false)

async function isDir(path: string): Promise<boolean> {
  return stat(path).then((s) => s.isDirectory(), () => false)
}

/** Entries for names in `dir`, in batches (thousands of stats at once would stall the disk). */
async function entriesOf(dir: string, dirents: Dirent[]): Promise<FinderEntry[]> {
  const out: FinderEntry[] = []
  for (let i = 0; i < dirents.length; i += 64) {
    const batch = await Promise.all(dirents.slice(i, i + 64).map((d) => entryAt(join(dir, d.name), d.isSymbolicLink())))
    out.push(...batch.filter((e): e is FinderEntry => !!e))
  }
  return out
}

/** One entry; a broken link shows as the (empty) file it is. Null when it vanished. */
async function entryAt(path: string, link?: boolean): Promise<FinderEntry | null> {
  const info = await stat(path).catch(() => lstat(path).catch(() => null))
  if (!info) return null
  const name = basename(path)
  const isLink = link ?? (await lstat(path).then((l) => l.isSymbolicLink(), () => false))
  const dir = info.isDirectory()
  const bundle = dir && BUNDLES.has(extname(name).toLowerCase())
  return {
    name,
    path,
    kind: dir ? 'dir' : 'file',
    size: dir ? 0 : info.size,
    mtimeMs: info.mtimeMs,
    hidden: name.startsWith('.'),
    ...(isLink ? { link: true } : {}),
    ...(bundle ? { bundle: true } : {})
  }
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  zip: 'application/zip',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  csv: 'text/csv',
  md: 'text/markdown'
}

/** A file's media type by its name (text for what the reader shows, else bytes). */
export function mimeOf(name: string): string {
  return MIME[extOf(name)] ?? (fileType(name) === 'text' ? 'text/plain' : 'application/octet-stream')
}

/** Mostly printable UTF-8 — a config file without a known extension, say. */
function looksLikeText(head: Buffer): boolean {
  const sample = head.subarray(0, 4096).toString('utf8')
  if (!sample) return true
  const odd = [...sample].filter((c) => c === '�' || (c < ' ' && !'\n\r\t\f'.includes(c))).length
  return odd / sample.length < 0.02
}
