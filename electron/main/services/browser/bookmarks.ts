import { randomUUID } from 'node:crypto'
import { BOOKMARK_ROOTS, isFolder, type BookmarkFolder, type BookmarkItem, type BookmarkNode, type BookmarkRoot } from '@shared/types/browserData'
import { readJsonFile } from '../../lib/jsonFile'
import { writeAtomic } from '../../lib/writeAtomic'
import { bareUrl } from './history'

const MAX_TITLE = 500
const MAX_URL = 8192
/** Bookmarks and folders in all (an import past this stops adding). */
const MAX_NODES = 50_000
const SAVE_DELAY_MS = 400

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** What an import brings: the bar's contents and everything else. */
export interface BookmarkSet {
  bar: BookmarkNode[]
  other: BookmarkNode[]
}

/** A bookmark or folder as an import or the file has it — anything that does not fit is dropped. */
function sanitize(raw: unknown, now: number, budget: { left: number }): BookmarkNode | null {
  if (!raw || typeof raw !== 'object' || budget.left <= 0) return null
  const r = raw as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.slice(0, MAX_TITLE) : ''
  const added = typeof r.added === 'number' && Number.isFinite(r.added) ? r.added : now
  const id = typeof r.id === 'string' && r.id ? r.id : randomUUID()
  if (Array.isArray(r.children)) {
    budget.left -= 1
    const children = r.children.map((c) => sanitize(c, now, budget)).filter((c): c is BookmarkNode => !!c)
    return { id, title, children, added }
  }
  if (typeof r.url !== 'string' || !r.url || r.url.length > MAX_URL) return null
  budget.left -= 1
  return { id, title, url: r.url, added }
}

/**
 * The user's bookmarks: two folders — the bar under the toolbar and "Other
 * bookmarks" — each holding bookmarks and folders, in `bookmarks.json`,
 * written atomically a moment after each change (architecture §11.5: files,
 * no database).
 */
export class BrowserBookmarks {
  private roots: Record<BookmarkRoot, BookmarkFolder>
  private timer?: NodeJS.Timeout
  private dirty = false
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly onChange: () => void = () => {},
    private readonly now: () => number = Date.now
  ) {
    this.roots = this.empty()
  }

  /** Reads `bookmarks.json`; a damaged file is set aside (and the library starts empty), never overwritten. */
  async load(): Promise<void> {
    const read = await readJsonFile<{ roots?: Record<string, unknown> } | null>(this.file)
    if (read.status !== 'ok') return
    const budget = { left: MAX_NODES }
    for (const key of BOOKMARK_ROOTS) {
      const node = sanitize(read.value?.roots?.[key], this.now(), budget)
      if (node && isFolder(node)) this.roots[key].children = node.children
    }
  }

  /** Both folders, the bar first — a copy, safe to hand out. */
  tree(): BookmarkFolder[] {
    return structuredClone(BOOKMARK_ROOTS.map((k) => this.roots[k]))
  }

  /** The first bookmark of `url`. */
  find(url: string): BookmarkItem | undefined {
    for (const node of this.walk()) if (!isFolder(node.node) && node.node.url === url) return { ...node.node }
    return undefined
  }

  /** A bookmark (with `url`) or a folder, into `parentId` at `index` (default: the end). */
  add(req: { parentId?: string; index?: number; title: string; url?: string }): BookmarkNode {
    const parent = this.folder(req.parentId ?? 'bar')
    if (this.count() >= MAX_NODES) throw coded('too-many', 'Too many bookmarks')
    const title = req.title.slice(0, MAX_TITLE)
    const node: BookmarkNode = req.url ? { id: randomUUID(), title, url: checkUrl(req.url), added: this.now() } : { id: randomUUID(), title, children: [], added: this.now() }
    parent.children.splice(clampIndex(req.index, parent.children.length), 0, node)
    this.changed()
    return structuredClone(node)
  }

  update(id: string, patch: { title?: string; url?: string }): void {
    const { node } = this.locate(id)
    if (patch.title !== undefined) node.title = patch.title.slice(0, MAX_TITLE)
    if (patch.url !== undefined && !isFolder(node)) node.url = checkUrl(patch.url)
    this.changed()
  }

  /** Into another folder (or elsewhere in its own) — never into itself. */
  move(id: string, parentId: string, index: number): void {
    const { node, parent } = this.locate(id)
    const target = this.folder(parentId)
    if (isFolder(node) && (node === target || this.contains(node, target))) throw coded('bad-move', 'A folder cannot go into itself')
    const from = parent.children.indexOf(node)
    parent.children.splice(from, 1)
    // Moving down within the same folder: the index counted the node itself.
    const at = parent === target && index > from ? index - 1 : index
    target.children.splice(clampIndex(at, target.children.length), 0, node)
    this.changed()
  }

  /** Bookmarks and folders (with all inside) — the two root folders stay. */
  remove(ids: string[]): number {
    let removed = 0
    for (const id of ids) {
      if (isRoot(id)) continue
      const hit = this.walk().find((w) => w.node.id === id)
      if (!hit) continue
      hit.parent.children.splice(hit.parent.children.indexOf(hit.node), 1)
      removed += 1
    }
    if (removed) this.changed()
    return removed
  }

  /** Address-bar matches: addresses that start with the text first, then any title or address holding it. */
  suggest(text: string, limit = 3): BookmarkItem[] {
    const q = text.trim().toLowerCase()
    if (!q) return []
    const prefix: BookmarkItem[] = []
    const rest: BookmarkItem[] = []
    for (const { node } of this.walk()) {
      if (isFolder(node)) continue
      const bare = bareUrl(node.url).toLowerCase()
      if (bare.startsWith(q)) prefix.push({ ...node })
      else if (bare.includes(q) || node.title.toLowerCase().includes(q)) rest.push({ ...node })
    }
    return [...prefix, ...rest].slice(0, limit)
  }

  /**
   * Bookmarks from elsewhere (another browser, an HTML file). The bar's go to
   * the bar while it is empty, else into a folder `label` on it; the rest into
   * a folder `label` in Other bookmarks. Importing the same again adds nothing:
   * folders merge by name, and an address saved anywhere already is skipped.
   * Returns how many bookmarks were added.
   */
  merge(set: BookmarkSet, label: string): number {
    const budget = { left: MAX_NODES - this.count() }
    const clean = (nodes: BookmarkNode[]) => nodes.map((n) => sanitize({ ...n, id: undefined }, this.now(), budget)).filter((n): n is BookmarkNode => !!n)
    const seen = new Set(this.walk().flatMap(({ node }) => (isFolder(node) ? [] : [node.url])))
    const bar = this.roots.bar
    const into = (root: BookmarkFolder, nodes: BookmarkNode[], direct: boolean) =>
      direct ? this.mergeInto(root, clean(nodes), seen) : this.mergeInto(root, [{ id: '', title: label, children: clean(nodes), added: this.now() }], seen)
    const added = (set.bar.length ? into(bar, set.bar, !bar.children.length) : 0) + (set.other.length ? into(this.roots.other, set.other, false) : 0)
    if (added) this.changed()
    return added
  }

  /** Every write so far has reached the disk. */
  async flush(): Promise<void> {
    if (this.dirty) await this.save()
    await this.writing
  }

  // --- internals ------------------------------------------------------------------

  private empty(): Record<BookmarkRoot, BookmarkFolder> {
    return { bar: { id: 'bar', title: '', children: [], added: 0 }, other: { id: 'other', title: '', children: [], added: 0 } }
  }

  /** Every bookmark and folder, depth first, with the folder it is in. */
  private walk(): { node: BookmarkNode; parent: BookmarkFolder }[] {
    const out: { node: BookmarkNode; parent: BookmarkFolder }[] = []
    const visit = (folder: BookmarkFolder) => {
      for (const node of folder.children) {
        out.push({ node, parent: folder })
        if (isFolder(node)) visit(node)
      }
    }
    for (const key of BOOKMARK_ROOTS) visit(this.roots[key])
    return out
  }

  private count(): number {
    return this.walk().length
  }

  private locate(id: string): { node: BookmarkNode; parent: BookmarkFolder } {
    if (isRoot(id)) throw coded('bad-target', 'The root folders cannot change')
    const hit = this.walk().find((w) => w.node.id === id)
    if (!hit) throw coded('not-found', 'Bookmark not found')
    return hit
  }

  private folder(id: string): BookmarkFolder {
    if (isRoot(id)) return this.roots[id]
    const node = this.walk().find((w) => w.node.id === id)?.node
    if (!node || !isFolder(node)) throw coded('not-found', 'Folder not found')
    return node
  }

  private contains(folder: BookmarkFolder, target: BookmarkFolder): boolean {
    return folder.children.some((c) => isFolder(c) && (c === target || this.contains(c, target)))
  }

  /** `nodes` into `target`: a folder joins the one of the same name there (new folders that stay empty are dropped). */
  private mergeInto(target: BookmarkFolder, nodes: BookmarkNode[], seen: Set<string>): number {
    let added = 0
    for (const node of nodes) {
      if (isFolder(node)) {
        const found = target.children.find((c): c is BookmarkFolder => isFolder(c) && c.title === node.title)
        const into = found ?? { id: randomUUID(), title: node.title, children: [], added: node.added }
        const n = this.mergeInto(into, node.children, seen)
        if (!found && n) target.children.push(into)
        added += n
      } else if (!seen.has(node.url)) {
        seen.add(node.url)
        target.children.push(node)
        added += 1
      }
    }
    return added
  }

  private changed(): void {
    this.dirty = true
    this.onChange()
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.save(), SAVE_DELAY_MS)
  }

  private save(): Promise<void> {
    clearTimeout(this.timer)
    this.dirty = false
    const data = JSON.stringify({ version: 1, roots: this.roots })
    this.writing = this.writing.then(() =>
      writeAtomic(this.file, data, 0o600).catch((err) => console.error('[browser] saving bookmarks failed', err))
    )
    return this.writing
  }
}

function isRoot(id: string): id is BookmarkRoot {
  return (BOOKMARK_ROOTS as readonly string[]).includes(id)
}

function clampIndex(index: number | undefined, length: number): number {
  return index === undefined ? length : Math.max(0, Math.min(length, index))
}

/** Bookmarks keep web, file and data-free addresses — never scripts. */
function checkUrl(url: string): string {
  const u = url.trim()
  if (!u || u.length > MAX_URL || /^(javascript|vbscript|data):/i.test(u)) throw coded('bad-url', 'Not an address a bookmark can keep')
  return u
}
