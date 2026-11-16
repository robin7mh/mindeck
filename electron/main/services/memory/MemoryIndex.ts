import type { GraphNode, MemoryGraph, NoteMeta, NotePath, SearchHit } from '@shared/types/memory'
import { linkKey, parseNote, type ParsedNote } from './parse'
import { SearchIndex } from './search'

interface Entry extends ParsedNote {
  path: NotePath
  title: string
  folder: string
  raw: string
  modifiedAt: string
}

/**
 * In-memory read model over the vault: parsed notes, wikilink resolution,
 * backlinks, graph, and ranked full-text search (`search.ts`). Rebuildable from the files at any
 * time, so it is never persisted. Resolution follows Obsidian: a link matches
 * a note by filename (case-insensitive), or by path suffix when it contains a
 * folder; ties go to the shortest path.
 */
export class MemoryIndex {
  private entries = new Map<NotePath, Entry>()
  private readonly text = new SearchIndex()
  private derived?: {
    byName: Map<string, NotePath[]>
    outgoing: Map<NotePath, Set<NotePath>>
    incoming: Map<NotePath, Set<NotePath>>
  }

  clear(): void {
    this.entries.clear()
    this.text.clear()
    this.derived = undefined
  }

  get size(): number {
    return this.entries.size
  }

  has(path: NotePath): boolean {
    return this.entries.has(path)
  }

  /** Cheap raw-text lookup (no link computation) for change detection. */
  rawOf(path: NotePath): string | undefined {
    return this.entries.get(path)?.raw
  }

  upsert(path: NotePath, raw: string, modifiedAt: Date): void {
    const slash = path.indexOf('/')
    const entry: Entry = {
      ...parseNote(raw),
      path,
      title: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, ''),
      folder: slash === -1 ? '' : path.slice(0, slash),
      raw,
      modifiedAt: modifiedAt.toISOString()
    }
    this.entries.set(path, entry)
    this.text.set(entry)
    this.derived = undefined
  }

  /** Removes a note, or every note under a folder prefix. */
  remove(path: NotePath): boolean {
    let removed = this.entries.delete(path)
    this.text.remove(path)
    const prefix = path.endsWith('/') ? path : `${path}/`
    for (const key of [...this.entries.keys()]) {
      if (!key.startsWith(prefix)) continue
      this.entries.delete(key)
      this.text.remove(key)
      removed = true
    }
    if (removed) this.derived = undefined
    return removed
  }

  get(
    path: NotePath
  ): (Entry & { meta: NoteMeta; backlinks: NoteMeta[]; resolved: Record<string, NotePath | null> }) | undefined {
    const e = this.entries.get(path)
    if (!e) return undefined
    const { incoming } = this.compute()
    const backlinks = [...(incoming.get(path) ?? [])]
      .map((p) => this.meta(this.entries.get(p)!))
      .sort((a, b) => a.title.localeCompare(b.title))
    const resolved: Record<string, NotePath | null> = {}
    for (const raw of e.links) resolved[raw] = this.resolve(raw) ?? null
    return { ...e, meta: this.meta(e), backlinks, resolved }
  }

  list(): NoteMeta[] {
    return [...this.entries.values()].map((e) => this.meta(e)).sort((a, b) => a.path.localeCompare(b.path))
  }

  /** Resolve a raw link target to a note path (undefined = unresolved). */
  resolve(target: string): NotePath | undefined {
    const key = linkKey(target)
    if (!key) return undefined
    const { byName } = this.compute()
    const name = key.slice(key.lastIndexOf('/') + 1)
    const candidates = (byName.get(name) ?? []).filter(
      (p) => !key.includes('/') || linkKey(p) === key || linkKey(p).endsWith(`/${key}`)
    )
    return candidates.sort((a, b) => a.length - b.length || a.localeCompare(b))[0]
  }

  graph(): MemoryGraph {
    const { outgoing } = this.compute()
    const nodes = new Map<string, GraphNode>()
    for (const e of this.entries.values()) {
      nodes.set(e.path, { id: e.path, title: e.title, folder: e.folder, ghost: false, degree: 0 })
    }

    const edges = new Map<string, { source: string; target: string }>()
    // Never a self-edge: outgoing excludes the note itself and ghost ids differ.
    const addEdge = (a: string, b: string) => {
      const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
      if (edges.has(key)) return
      edges.set(key, { source: a, target: b })
      nodes.get(a)!.degree += 1
      nodes.get(b)!.degree += 1
    }

    for (const e of this.entries.values()) {
      for (const target of outgoing.get(e.path)!) addEdge(e.path, target)
      for (const raw of e.links) {
        if (this.resolve(raw)) continue
        const key = linkKey(raw)
        const id = `ghost:${key}`
        if (!nodes.has(id)) {
          nodes.set(id, { id, title: raw.slice(raw.lastIndexOf('/') + 1).replace(/\.md$/i, ''), folder: '', ghost: true, degree: 0 })
        }
        addEdge(e.path, id)
      }
    }
    return { nodes: [...nodes.values()], edges: [...edges.values()] }
  }

  search(query: string, limit = 50): SearchHit[] {
    return this.text.search(query, limit)
  }

  private meta(e: Entry): NoteMeta {
    const { outgoing, incoming } = this.compute()
    const linked = new Set([...(outgoing.get(e.path)!), ...(incoming.get(e.path) ?? [])])
    linked.delete(e.path)
    const type = typeof e.frontmatter.type === 'string' ? e.frontmatter.type : undefined
    return {
      path: e.path,
      title: e.title,
      folder: e.folder,
      tags: e.tags,
      type,
      modifiedAt: e.modifiedAt,
      linkCount: linked.size
    }
  }

  private compute() {
    if (this.derived) return this.derived
    const byName = new Map<string, NotePath[]>()
    for (const p of this.entries.keys()) {
      const key = linkKey(p)
      const name = key.slice(key.lastIndexOf('/') + 1)
      byName.set(name, [...(byName.get(name) ?? []), p])
    }
    // Partial state so resolve() works while outgoing/incoming are built.
    this.derived = { byName, outgoing: new Map(), incoming: new Map() }
    const { outgoing, incoming } = this.derived
    for (const e of this.entries.values()) {
      const out = new Set<NotePath>()
      for (const raw of e.links) {
        const target = this.resolve(raw)
        if (target && target !== e.path) out.add(target)
      }
      outgoing.set(e.path, out)
      for (const t of out) {
        if (!incoming.has(t)) incoming.set(t, new Set())
        incoming.get(t)!.add(e.path)
      }
    }
    return this.derived
  }
}
