import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, posix, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  ATTACHMENTS_FOLDER,
  DEFAULT_DAILY_NOTES,
  DEFAULT_GRAPH_STYLE,
  GRAPH_COLORS,
  IMAGE_EXTS,
  type DailyNotesSettings,
  type GraphStyle,
  type MemoryChanged,
  type MemoryGraph,
  type Note,
  type NoteMeta,
  type NotePath,
  type SearchHit,
  type VaultAttachment,
  type VaultStatus
} from '@shared/types/memory'
import type { SettingsService } from '../settings/SettingsService'
import { MemoryIndex } from './MemoryIndex'
import { frontmatterBlock, sanitizeTitle } from './parse'
import { appendLink, removeLinks, rewriteLinks } from './linkEdit'
import { FOLDER_TYPES, frontmatter, starterNotes } from './starterVault'
import { formatDate, localTime, noteFromTemplate, templateBody } from './template'
import { desktopOnly, type Platform } from '../../platform/types'

const MAX_NOTES = 20_000
const MAX_NOTE_BYTES = 5 * 1024 * 1024
/** Pictures pasted into or shown in notes. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml'
}
const imageExt = (name: string) => {
  const ext = extname(name).slice(1).toLowerCase()
  return (IMAGE_EXTS as readonly string[]).includes(ext) ? ext : null
}
const FLUSH_DELAY_MS = 200

/** `.obsidian`, `.trash`, `.git`, our temp files … and dependency folders. */
const ignoredSegment = (s: string) => s.startsWith('.') || s === 'node_modules'
const isNoteFile = (p: string) => /\.md$/i.test(p)

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

async function isDir(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null))?.isDirectory() ?? false
}

/** All markdown files under `dir`, as POSIX paths relative to it. */
async function scan(dir: string, limit = MAX_NOTES): Promise<string[]> {
  const out: string[] = []
  const stack = ['']
  while (stack.length && out.length < limit) {
    const rel = stack.pop()!
    const entries = await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])
    for (const d of entries) {
      if (ignoredSegment(d.name)) continue
      const child = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) stack.push(child) // symlinked dirs are skipped (no cycles)
      else if (d.isFile() && isNoteFile(d.name)) out.push(child)
      if (out.length >= limit) break
    }
  }
  return out
}

/** Files named `name` (any case) under `dir`, as POSIX paths relative to it. */
async function scanFor(dir: string, name: string): Promise<string[]> {
  const out: string[] = []
  const stack = ['']
  let dirs = 0
  while (stack.length && dirs < MAX_NOTES) {
    const rel = stack.pop()!
    dirs += 1
    for (const d of await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])) {
      if (ignoredSegment(d.name)) continue
      const child = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) stack.push(child)
      else if (d.isFile() && d.name.toLowerCase() === name) out.push(child)
    }
  }
  return out
}

/** All (non-ignored) folders under `dir`, as POSIX paths relative to it. */
async function scanDirs(dir: string): Promise<string[]> {
  const out: string[] = []
  const stack = ['']
  while (stack.length && out.length < MAX_NOTES) {
    const rel = stack.pop()!
    const entries = await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])
    for (const d of entries) {
      if (!d.isDirectory() || ignoredSegment(d.name)) continue
      const child = rel ? `${rel}/${d.name}` : d.name
      out.push(child)
      stack.push(child)
    }
  }
  return out
}

/**
 * The Memory module's backend: an Obsidian-compatible markdown vault
 * (architecture §11.2). Files are the source of truth — the index is rebuilt
 * from them, and external edits (e.g. in Obsidian) are picked up by a
 * recursive watcher and pushed to the renderer via `onChange`. Every path from
 * the renderer is vault-relative and confined to the vault root.
 */
export class VaultService {
  private readonly index = new MemoryIndex()
  private indexedRoot?: string
  private indexing?: Promise<void>
  private watcher?: FSWatcher
  private pending = new Set<string>()
  private fullRescan = false
  private flushTimer?: NodeJS.Timeout
  private flushing: Promise<void> = Promise.resolve()

  constructor(
    private readonly opts: {
      settings: SettingsService
      platform: Platform
      defaultRoot: string
      onChange: (change: MemoryChanged) => void
    }
  ) {}

  async status(): Promise<VaultStatus> {
    await this.ensureIndexed()
    const root = this.root()
    const isDefault = !this.opts.settings.get().vaultRoot
    return {
      root,
      defaultRoot: this.opts.defaultRoot,
      name: isDefault ? 'Mindeck' : basename(root),
      isDefault,
      exists: await isDir(root),
      noteCount: this.index.size,
      graphStyle: this.graphStyle(),
      dailyNotes: this.dailyNotes()
    }
  }

  /** Creates the default vault (with starter notes if it is new) and selects it. */
  async createVault(): Promise<VaultStatus> {
    const root = this.opts.defaultRoot
    await mkdir(root, { recursive: true })
    if ((await scan(root, 1)).length === 0) {
      for (const note of starterNotes()) {
        const abs = join(root, ...note.path.split('/'))
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, note.content, { encoding: 'utf8', flag: 'wx' }).catch(() => {})
      }
    }
    await this.opts.settings.update({ vaultRoot: undefined })
    return this.switched()
  }

  /** Native folder picker — e.g. an existing Obsidian vault. Null on cancel. */
  async pickVault(): Promise<VaultStatus | null> {
    const { pickFolder } = this.opts.platform
    if (!pickFolder) throw desktopOnly('The folder picker')
    const picked = await pickFolder('Choose a vault folder')
    return picked ? this.setVault(picked) : null
  }

  /** Select an existing folder as the vault (the web UI's server-side picker). */
  async setVault(path: string): Promise<VaultStatus> {
    if (!(await isDir(path))) throw coded('not-found', 'That folder does not exist')
    const chosen = await realpath(path)
    // Compare resolved paths: the default may sit behind a symlink (/var → /private/var).
    const defaultReal = await realpath(this.opts.defaultRoot).catch(() => resolve(this.opts.defaultRoot))
    const isDefault = chosen === defaultReal
    await this.opts.settings.update({ vaultRoot: isDefault ? undefined : chosen })
    return this.switched()
  }

  async list(): Promise<NoteMeta[]> {
    await this.ensureIndexed()
    return this.index.list()
  }

  async read(path: string): Promise<Note> {
    await this.ensureIndexed()
    const rel = this.normalize(path)
    if (!this.index.has(rel)) await this.load(this.root(), rel)
    const e = this.index.get(rel)
    if (!e) throw coded('not-found', `Note not found: ${rel}`)
    return {
      ...e.meta,
      raw: e.raw,
      body: e.body,
      frontmatter: e.frontmatter,
      backlinks: e.backlinks,
      links: e.resolved
    }
  }

  async write(path: string, raw: string): Promise<NoteMeta> {
    await this.ensureIndexed()
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_NOTE_BYTES) {
      throw coded('too-large', 'Note exceeds 5 MB')
    }
    const rel = this.normalize(path)
    const abs = await this.confine(rel)
    await this.atomicWrite(abs, raw)
    this.index.upsert(rel, raw, new Date())
    this.opts.onChange({ paths: [rel] })
    return this.index.get(rel)!.meta
  }

  /**
   * New note named after `title` (Obsidian: filename = title), never
   * overwriting — optionally started from a template note, filled in for
   * `now` (the UI's local time).
   */
  async create(title: string, folder = '', template?: string, now?: string): Promise<NoteMeta> {
    await this.ensureIndexed()
    const source = template ? await this.templateText(template) : undefined
    const root = this.root()
    await mkdir(root, { recursive: true })
    const dir = folder
      .split(/[\\/]/)
      .map((s) => s.trim())
      .filter((s) => s && s !== '.' && s !== '..')
      .map(sanitizeTitle)
      .join('/')
    const base = sanitizeTitle(title)
    const top = dir.split('/')[0]

    for (let n = 1; n < 1000; n += 1) {
      const rel = this.normalize(`${dir ? `${dir}/` : ''}${n === 1 ? base : `${base} ${n}`}.md`)
      if (this.index.has(rel)) continue
      const abs = await this.confine(rel, true)
      const type = FOLDER_TYPES[top]
      const raw =
        source === undefined
          ? frontmatter({ type }) // empty body: the editor starts blank
          : noteFromTemplate(source, { title: rel.slice(rel.lastIndexOf('/') + 1, -3), now: localTime(now), type })
      try {
        await writeFile(abs, raw, { encoding: 'utf8', flag: 'wx' })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw err
      }
      this.index.upsert(rel, raw, new Date())
      if (this.indexedRoot !== root) await this.switched()
      else this.opts.onChange({ paths: [rel] })
      return this.index.get(rel)!.meta
    }
    throw coded('exists', `Too many notes named "${base}"`)
  }

  /** Moves the note to the OS trash (recoverable), never a hard delete. */
  async trash(path: string): Promise<void> {
    await this.ensureIndexed()
    const rel = this.normalize(path)
    await this.opts.platform.trashItem(await this.confine(rel), this.root())
    this.index.remove(rel)
    this.opts.onChange({ paths: [rel] })
  }

  async graph(): Promise<MemoryGraph> {
    await this.ensureIndexed()
    return this.index.graph()
  }

  async search(query: string): Promise<SearchHit[]> {
    await this.ensureIndexed()
    return this.index.search(String(query ?? ''))
  }

  async setGraphStyle(style: GraphStyle): Promise<GraphStyle> {
    const valid =
      (style?.mode === 'colorful' || style?.mode === 'single') &&
      (GRAPH_COLORS as readonly string[]).includes(style?.color)
    if (!valid) throw coded('bad-style', 'Invalid graph style')
    await this.opts.settings.update({ graphStyle: { mode: style.mode, color: style.color } })
    return this.graphStyle()
  }

  /** Opens the vault folder in Finder / Explorer. */
  async reveal(): Promise<void> {
    const root = this.root()
    if (!(await isDir(root))) throw coded('not-found', 'The vault folder does not exist yet')
    const { openPath } = this.opts.platform
    if (!openPath) throw desktopOnly('Opening the vault folder')
    await openPath(root)
  }

  /** Every folder in the vault (empty ones too), vault-relative and sorted. */
  async folders(): Promise<string[]> {
    await this.ensureIndexed()
    const root = this.root()
    if (!(await isDir(root))) return []
    return (await scanDirs(root)).sort((a, b) => a.localeCompare(b))
  }

  /**
   * Replace a note's text; its frontmatter block is kept byte-for-byte. With
   * `expectedMtime` (the `modifiedAt` the caller read, in ms) a note that moved
   * on since, or is gone, fails with `conflict` instead of being overwritten.
   */
  async writeBody(path: string, body: string, expectedMtime?: number): Promise<NoteMeta> {
    await this.ensureIndexed()
    if (typeof body !== 'string') throw coded('bad-input', 'Invalid note text')
    const rel = this.normalize(path)
    if (expectedMtime !== undefined) {
      // The disk decides, not the index, which follows it a moment later.
      if (await this.load(this.root(), rel)) this.opts.onChange({ paths: [rel] })
      const known = this.index.get(rel)?.meta.modifiedAt
      if (!known || Date.parse(known) !== expectedMtime) throw coded('conflict', `${rel} changed on disk since it was opened`)
    }
    const raw =
      this.index.rawOf(rel) ??
      (await readFile(await this.confine(rel), 'utf8').catch((err: NodeJS.ErrnoException) => {
        throw err.code === 'ENOENT' ? coded('not-found', `Note not found: ${rel}`) : err
      }))
    return this.write(rel, frontmatterBlock(raw) + body)
  }

  async createFolder(parent: string, name: string): Promise<string> {
    await this.ensureIndexed()
    const base = this.normalizeDir(parent)
    const rel = this.normalizeDir(`${base ? `${base}/` : ''}${sanitizeTitle(name)}`)
    await mkdir(this.root(), { recursive: true })
    const abs = await this.confine(rel)
    if (await stat(abs).catch(() => null)) throw coded('exists', `"${rel}" already exists`)
    await mkdir(abs)
    this.opts.onChange({})
    return rel
  }

  /** Rename a note (its file). Links to it in other notes follow the new name. */
  async rename(path: string, title: string): Promise<NoteMeta> {
    await this.ensureIndexed()
    const rel = this.requireNote(path)
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    const next = this.normalize(`${dir ? `${dir}/` : ''}${sanitizeTitle(title)}.md`)
    if (next !== rel) await this.relocate([[rel, next]])
    return this.index.get(next)!.meta
  }

  /** Move a note into another folder ('' = vault root). */
  async move(path: string, folder: string): Promise<NoteMeta> {
    await this.ensureIndexed()
    const rel = this.requireNote(path)
    const dir = this.normalizeDir(folder)
    const next = this.normalize(`${dir ? `${dir}/` : ''}${rel.slice(rel.lastIndexOf('/') + 1)}`)
    if (next !== rel) await this.relocate([[rel, next]])
    return this.index.get(next)!.meta
  }

  /** Move a folder with everything in it into another folder ('' = vault root). */
  async moveFolder(folder: string, into: string): Promise<string> {
    await this.ensureIndexed()
    const from = this.normalizeDir(folder)
    const target = this.normalizeDir(into)
    if (!from) throw coded('bad-path', 'The vault root cannot be moved')
    if (target === from || target.startsWith(`${from}/`)) throw coded('bad-move', 'A folder cannot move into itself')
    const to = this.normalizeDir(`${target ? `${target}/` : ''}${from.slice(from.lastIndexOf('/') + 1)}`)
    if (to === from) return from
    const moves = this.index
      .list()
      .filter((n) => n.path.startsWith(`${from}/`))
      .map((n): [NotePath, NotePath] => [n.path, `${to}${n.path.slice(from.length)}`])
    await this.relocate(moves, { from, to })
    return to
  }

  /** Link `from` → `to`: adds "[[to]]" under "## Verbindungen" in `from`. */
  async link(from: string, to: string): Promise<NoteMeta> {
    await this.ensureIndexed()
    const a = this.requireNote(from)
    const b = this.requireNote(to)
    if (a === b) throw coded('bad-link', 'A note cannot link to itself')
    const e = this.index.get(a)!
    if (Object.values(e.resolved).includes(b)) return e.meta
    // By name when that is unambiguous (the Obsidian way), else by path.
    const name = b.slice(b.lastIndexOf('/') + 1).replace(/\.md$/i, '')
    const target = this.index.resolve(name) === b ? name : b.replace(/\.md$/i, '')
    return this.write(a, appendLink(e.raw, target))
  }

  /** Remove every link in `from` that points to `to`; inline mentions stay as text. */
  async unlink(from: string, to: string): Promise<NoteMeta> {
    await this.ensureIndexed()
    const a = this.requireNote(from)
    const b = this.requireNote(to)
    const raw = this.index.rawOf(a)!
    const next = removeLinks(raw, (t) => this.index.resolve(t) === b)
    return next === raw ? this.index.get(a)!.meta : this.write(a, next)
  }

  /** Today's daily note (`now` = the UI's local time): opened if it exists, else created from the daily template. */
  async daily(now?: string): Promise<NoteMeta> {
    await this.ensureIndexed()
    const { folder, template } = this.dailyNotes()
    const name = formatDate(localTime(now), 'YYYY-MM-DD')
    const rel = this.normalize(`${folder ? `${folder}/` : ''}${name}.md`)
    if (this.index.has(rel)) return this.index.get(rel)!.meta
    // A missing template file (moved, renamed) must not keep the day from starting.
    const usable = template && this.index.has(template) ? template : undefined
    return this.create(name, folder, usable, now)
  }

  async setDailyNotes(daily: DailyNotesSettings): Promise<DailyNotesSettings> {
    const next = { folder: this.normalizeDir(daily.folder), template: daily.template ? this.normalize(daily.template) : '' }
    await this.opts.settings.update({ dailyNotes: next })
    return this.dailyNotes()
  }

  /** A template's text filled in for the note `title` — what "Insert template" adds at the cursor. */
  async renderTemplate(path: string, title: string, now?: string): Promise<string> {
    await this.ensureIndexed()
    return templateBody(await this.templateText(path), { title, now: localTime(now) })
  }

  /**
   * A picture pasted or dropped into a note: saved under `attachments/`
   * (a taken name gets a number). Returns its path and what goes into
   * `![[…]]` — the file name, which resolves from anywhere in the vault.
   */
  async attach(name: string, base64: string): Promise<{ path: string; link: string }> {
    await this.ensureIndexed()
    const data = Buffer.from(base64, 'base64')
    if (data.length > MAX_ATTACHMENT_BYTES) throw coded('too-large', 'Pictures in notes may be up to 20 MB')
    const ext = imageExt(name)
    if (!ext) throw coded('bad-type', 'Only pictures can be added to notes')
    const stem = sanitizeTitle(basename(name).slice(0, -(ext.length + 1)))
    await mkdir(this.root(), { recursive: true })
    for (let n = 1; n < 1000; n += 1) {
      const file = `${n === 1 ? stem : `${stem} ${n}`}.${ext}`
      const rel = this.normalize(`${ATTACHMENTS_FOLDER}/${file}`, false)
      try {
        await writeFile(await this.confine(rel, true), data, { flag: 'wx' })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw err
      }
      return { path: rel, link: file }
    }
    throw coded('exists', `Too many pictures named "${stem}"`)
  }

  /**
   * A picture a note shows (`![[bild.png]]`, `![](../img/a.png)`), from the
   * vault only: next to the note, by its vault path, in `attachments/`, or —
   * like Obsidian — anywhere by name (shortest path wins).
   */
  async attachment(target: string, from?: string): Promise<VaultAttachment> {
    await this.ensureIndexed()
    const clean = target.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    if (!imageExt(clean)) throw coded('bad-type', 'Not a picture')
    const noteDir = from ? posix.dirname(this.normalize(from)) : '.'
    const candidates = [posix.join(noteDir, clean), clean, `${ATTACHMENTS_FOLDER}/${posix.basename(clean)}`]
    for (const rel of candidates) {
      const hit = await this.readAttachment(rel)
      if (hit) return hit
    }
    const root = this.root()
    const found = (await scanFor(root, posix.basename(clean).toLowerCase())).sort((a, b) => a.length - b.length || a.localeCompare(b))
    const hit = found.length ? await this.readAttachment(found[0]) : null
    if (!hit) throw coded('not-found', `Picture not found: ${target}`)
    return hit
  }

  dispose(): void {
    this.stopWatching()
    if (this.flushTimer) clearTimeout(this.flushTimer)
  }

  // --- internals -----------------------------------------------------------

  private root(): string {
    return this.opts.settings.get().vaultRoot ?? this.opts.defaultRoot
  }

  private requireNote(path: string): NotePath {
    const rel = this.normalize(path)
    if (!this.index.has(rel)) throw coded('not-found', `Note not found: ${rel}`)
    return rel
  }

  /** Vault-relative folder path; '' is the vault root. */
  private normalizeDir(path: string): string {
    const rel = posix
      .normalize(String(path ?? '').replace(/\\/g, '/'))
      .replace(/^\/+|\/+$/g, '')
    if (rel === '.' || rel === '') return ''
    if (
      rel.split('/').some((s) => s === '..' || ignoredSegment(s)) || // posix.normalize already collapsed '//'
      (process.platform === 'win32' && rel.includes(':'))
    ) {
      throw coded('bad-path', `Invalid folder: ${path}`)
    }
    return rel
  }

  /**
   * Rename/move notes (or one folder) on disk and keep links intact: rewrites
   * are planned first, while the old names still resolve. Name-style links
   * only change when the name does; path-style links follow the new path.
   */
  private async relocate(moves: [NotePath, NotePath][], dir?: { from: string; to: string }): Promise<void> {
    const root = this.root()
    const map = new Map(moves)
    const [srcRel, dstRel] = dir ? [dir.from, dir.to] : moves[0]
    const fromAbs = await this.confine(srcRel)
    const toAbs = await this.confine(dstRel, true)
    // A case-only rename ("notiz" → "Notiz") hits the same file on macOS/Windows.
    const caseOnly = srcRel.toLowerCase() === dstRel.toLowerCase()
    if (!caseOnly && (await stat(toAbs).catch(() => null))) {
      throw coded('exists', `"${dstRel.replace(/\.md$/i, '')}" already exists`)
    }

    const rewrites = new Map<NotePath, string>()
    for (const { path } of this.index.list()) {
      const raw = this.index.rawOf(path)!
      const next = rewriteLinks(raw, (target) => {
        const hit = this.index.resolve(target)
        const moved = hit ? map.get(hit) : undefined
        if (!hit || !moved) return null
        const movedNoExt = moved.replace(/\.md$/i, '')
        if (target.includes('/') || /\.md$/i.test(target)) return movedNoExt
        const oldName = hit.slice(hit.lastIndexOf('/') + 1).replace(/\.md$/i, '')
        const newName = movedNoExt.slice(movedNoExt.lastIndexOf('/') + 1)
        return oldName === newName ? null : newName
      })
      if (next !== raw) rewrites.set(map.get(path) ?? path, next)
    }

    await rename(fromAbs, toAbs)
    for (const [from] of moves) this.index.remove(from)
    for (const [, to] of moves) await this.load(root, to)
    for (const [path, raw] of rewrites) {
      await this.atomicWrite(await this.confine(path), raw)
      this.index.upsert(path, raw, new Date())
    }
    this.opts.onChange({})
  }

  private graphStyle(): GraphStyle {
    return this.opts.settings.get().graphStyle ?? DEFAULT_GRAPH_STYLE
  }

  private dailyNotes(): DailyNotesSettings {
    return { ...DEFAULT_DAILY_NOTES, ...this.opts.settings.get().dailyNotes }
  }

  private async templateText(path: string): Promise<string> {
    const rel = this.requireNote(path)
    return this.index.rawOf(rel)!
  }

  /** The picture at a vault path, or null when there is none (or it is not one Mindeck shows). */
  private async readAttachment(path: string): Promise<VaultAttachment | null> {
    let rel: string
    let abs: string
    try {
      rel = this.normalize(path, false)
      abs = await this.confine(rel)
    } catch {
      return null
    }
    const st = await stat(abs).catch(() => null)
    if (!st?.isFile() || st.size > MAX_ATTACHMENT_BYTES) return null
    const mime = IMAGE_TYPES[imageExt(rel)!]
    return { path: rel, mime, dataUrl: `data:${mime};base64,${(await readFile(abs)).toString('base64')}` }
  }

  private async switched(): Promise<VaultStatus> {
    this.indexedRoot = undefined
    await this.ensureIndexed()
    this.opts.onChange({})
    return this.status()
  }

  private ensureIndexed(): Promise<void> {
    const root = this.root()
    if (this.indexedRoot === root && this.indexing) return this.indexing
    this.indexedRoot = root
    this.indexing = this.reindex(root)
    return this.indexing
  }

  private async reindex(root: string): Promise<void> {
    this.stopWatching()
    this.index.clear()
    if (!(await isDir(root))) {
      this.indexedRoot = undefined // vault not created yet — check again next call
      return
    }
    const files = await scan(root)
    for (let i = 0; i < files.length; i += 64) {
      await Promise.all(files.slice(i, i + 64).map((rel) => this.load(root, rel)))
    }
    this.startWatching(root)
  }

  /** (Re)parse one file. Returns true if the index actually changed. */
  private async load(root: string, rel: NotePath): Promise<boolean> {
    try {
      const abs = join(root, ...rel.split('/'))
      // Size first: a huge .md (a log, a dump) is never read into memory.
      const st = await stat(abs)
      if (st.size > MAX_NOTE_BYTES) return this.index.remove(rel)
      const raw = await readFile(abs, 'utf8')
      if (this.index.rawOf(rel) === raw) return false
      this.index.upsert(rel, raw, st.mtime)
      return true
    } catch {
      return this.index.remove(rel)
    }
  }

  /** A vault-relative path: a note's (`.md`), or with `note` false any file's. */
  private normalize(path: string, note = true): NotePath {
    const rel = posix.normalize(String(path ?? '').replace(/\\/g, '/')).replace(/^\/+/, '')
    const segments = rel.split('/')
    if (
      !rel ||
      (note && !isNoteFile(rel)) ||
      segments.some((s) => s === '..' || ignoredSegment(s)) || // posix.normalize already collapsed '//'
      (process.platform === 'win32' && rel.includes(':'))
    ) {
      throw coded('bad-path', `Invalid note path: ${path}`)
    }
    return rel
  }

  /**
   * Absolute path for a normalized path, guaranteed inside the vault. Lexically
   * that is already true (normalize/normalizeDir reject `..`, absolute paths and
   * drive letters); the realpath check catches symlinked folders pointing out.
   */
  private async confine(rel: NotePath, createParent = false): Promise<string> {
    const root = this.root()
    const abs = resolve(root, ...rel.split('/'))
    if (createParent) await mkdir(dirname(abs), { recursive: true })
    const [rootReal, parentReal] = await Promise.all([realpath(root), realpath(dirname(abs))]).catch(() => {
      throw coded('not-found', `Folder not found for ${rel}`)
    })
    if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
      throw coded('bad-path', 'Path escapes the vault')
    }
    return abs
  }

  private async atomicWrite(abs: string, raw: string): Promise<void> {
    const tmp = join(dirname(abs), `.${basename(abs)}.${randomUUID().slice(0, 8)}.tmp`)
    await writeFile(tmp, raw, 'utf8')
    await rename(tmp, abs)
  }

  private startWatching(root: string): void {
    try {
      this.watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (filename == null) this.fullRescan = true
        else this.pending.add(String(filename).split(sep).join('/'))
        if (this.flushTimer) clearTimeout(this.flushTimer)
        this.flushTimer = setTimeout(() => {
          this.flushing = this.flushing.then(() => this.flush(root)).catch(() => {})
        }, FLUSH_DELAY_MS)
      })
      this.watcher.on('error', () => this.stopWatching())
    } catch (err) {
      console.warn('[memory] vault watcher unavailable — external edits need a reopen', err)
    }
  }

  private stopWatching(): void {
    this.watcher?.close()
    this.watcher = undefined
    this.pending.clear()
    this.fullRescan = false
  }

  private async flush(root: string): Promise<void> {
    if (this.indexedRoot !== root) return
    if (this.fullRescan) {
      await this.switched()
      return
    }
    const changed: NotePath[] = []
    const paths = [...this.pending]
    this.pending.clear()
    for (const rel of paths) {
      if (!rel || rel.split('/').some(ignoredSegment)) continue
      const abs = join(root, ...rel.split('/'))
      const st = await stat(abs).catch(() => null)
      if (st?.isDirectory()) {
        for (const f of await scan(abs)) {
          if (await this.load(root, `${rel}/${f}`)) changed.push(`${rel}/${f}`)
        }
      } else if (st?.isFile()) {
        if (isNoteFile(rel) && (await this.load(root, rel))) changed.push(rel)
      } else if (this.index.remove(rel)) {
        changed.push(rel)
      }
    }
    if (changed.length) this.opts.onChange({ paths: changed })
  }
}
