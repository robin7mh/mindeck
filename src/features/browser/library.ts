import { internalPage, isFolder, type BookmarkFolder, type BookmarkItem, type BookmarkNode, type InternalPage } from '@shared/types/browserData'
import type { HistoryEntry } from '@shared/types/browser'

/** The first bookmark of `url`. */
export function findByUrl(tree: BookmarkFolder[], url: string): BookmarkItem | undefined {
  for (const { node } of walk(tree)) if (!isFolder(node) && node.url === url) return node
  return undefined
}

/** A bookmark or folder by id, with the folder it is in (none for the two roots). */
export function findNode(tree: BookmarkFolder[], id: string): { node: BookmarkNode; parent?: BookmarkFolder } | undefined {
  const root = tree.find((r) => r.id === id)
  if (root) return { node: root }
  return walk(tree).find((w) => w.node.id === id)
}

/** Every bookmark and folder below the roots, depth first, with its folder and the folder names on the way. */
export function walk(tree: BookmarkFolder[]): { node: BookmarkNode; parent: BookmarkFolder; path: string[] }[] {
  const out: { node: BookmarkNode; parent: BookmarkFolder; path: string[] }[] = []
  const visit = (folder: BookmarkFolder, path: string[]) => {
    for (const node of folder.children) {
      out.push({ node, parent: folder, path })
      if (isFolder(node)) visit(node, [...path, node.title])
    }
  }
  for (const root of tree) visit(root, [])
  return out
}

/** Every folder for a picker: the roots by their names, the rest indented below. `except`: a folder and what is inside it. */
export function folderChoices(tree: BookmarkFolder[], rootName: (id: string) => string, except?: string): { id: string; label: string; depth: number }[] {
  const out: { id: string; label: string; depth: number }[] = []
  const visit = (folder: BookmarkFolder, depth: number) => {
    if (folder.id === except) return
    out.push({ id: folder.id, label: depth ? folder.title : rootName(folder.id), depth })
    for (const c of folder.children) if (isFolder(c)) visit(c, depth + 1)
  }
  for (const root of tree) visit(root, 0)
  return out
}

/** Bookmarks whose title or address holds every word of `query`, with the folders they are in. */
export function searchBookmarks(tree: BookmarkFolder[], query: string, limit = 200): (BookmarkItem & { path: string[] })[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const hits: (BookmarkItem & { path: string[] })[] = []
  for (const { node, path } of walk(tree)) {
    if (isFolder(node)) continue
    const hay = `${node.title} ${node.url}`.toLowerCase()
    if (words.every((w) => hay.includes(w))) hits.push({ ...node, path })
    if (hits.length >= limit) break
  }
  return hits
}

/** Midnight (local time) of the day `ms` is in. */
export function dayStart(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** History entries (newest first) in groups by the day of their last visit. */
export function byDay(entries: HistoryEntry[]): { day: number; entries: HistoryEntry[] }[] {
  const groups: { day: number; entries: HistoryEntry[] }[] = []
  for (const e of entries) {
    const day = dayStart(Date.parse(e.lastVisit))
    const last = groups[groups.length - 1]
    if (last?.day === day) last.entries.push(e)
    else groups.push({ day, entries: [e] })
  }
  return groups
}

/** What a tab is called: Mindeck's own pages by their names, else the page's title or address ('' for the new-tab page). */
export function tabLabel(tab: { url: string; title: string }, pages: Record<InternalPage, string>): string {
  const page = internalPage(tab.url)
  return page ? pages[page] : tab.title || tab.url
}

/** A bookmark's or folder's name as shown: an untitled bookmark by its address. */
export function nodeName(node: BookmarkNode, address: (url: string) => string = (u) => u): string {
  return node.title || (isFolder(node) ? '' : address(node.url))
}
