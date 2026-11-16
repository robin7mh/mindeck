import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BookmarkNode } from '@shared/types/browserData'
import type { BookmarkSet } from '../bookmarks'
import { APPLE_EPOCH_S, parseBplist } from './bplist'
import { MAX_IMPORTED_PAGES, type ImportedPage } from './chromium'
import { num, querySqliteCopy, str } from './sqlite'

type Dict = Record<string, unknown>
const dict = (v: unknown): Dict => (v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Date) ? (v as Dict) : {})
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** A bookmark (`WebBookmarkTypeLeaf`, its title in `URIDictionary`) or a folder (`WebBookmarkTypeList`); the history proxy and the like stay out. */
function node(raw: unknown): BookmarkNode | null {
  const r = dict(raw)
  if (r.WebBookmarkType === 'WebBookmarkTypeList') return { id: '', title: str(r.Title), children: nodes(r.Children), added: 0 }
  if (r.WebBookmarkType !== 'WebBookmarkTypeLeaf' || typeof r.URLString !== 'string') return null
  const added = dict(r.ReadingList).DateAdded
  return { id: '', title: str(dict(r.URIDictionary).title) || r.URLString, url: r.URLString, added: added instanceof Date ? added.getTime() : 0 }
}

function nodes(raw: unknown): BookmarkNode[] {
  return list(raw)
    .map(node)
    .filter((n): n is BookmarkNode => !!n)
}

/**
 * Safari's `Bookmarks.plist`: the Favorites (`BookmarksBar`) are the bar; the
 * bookmarks menu and — as a folder called `readingList` — the Reading List go
 * to Other.
 */
export async function safariBookmarks(dir: string, readingList: string): Promise<BookmarkSet> {
  const root = dict(parseBplist(await readFile(join(dir, 'Bookmarks.plist'))))
  const set: BookmarkSet = { bar: [], other: [] }
  for (const raw of list(root.Children)) {
    const child = dict(raw)
    if (child.Title === 'BookmarksBar') set.bar.push(...nodes(child.Children))
    else if (child.Title === 'BookmarksMenu') set.other.push(...nodes(child.Children))
    else if (child.Title === 'com.apple.ReadingList') {
      const pages = nodes(child.Children)
      if (pages.length) set.other.push({ id: '', title: readingList, children: pages, added: 0 })
    } else {
      const n = node(raw)
      if (n) set.other.push(n)
    }
  }
  return set
}

/** Safari's `History.db`: the newest pages that loaded, each with the title of its last visit. */
export function safariHistory(dir: string): Promise<ImportedPage[]> {
  return querySqliteCopy(join(dir, 'History.db'), (query) =>
    query(
      // A bare column next to MAX() comes from the row with the maximum (SQLite): the newest visit's title.
      `SELECT i.url AS url, v.title AS title, i.visit_count AS visits, CAST((MAX(v.visit_time) + ${APPLE_EPOCH_S}) * 1000 AS INTEGER) AS last
       FROM history_items i JOIN history_visits v ON v.history_item = i.id
       WHERE v.load_successful = 1 GROUP BY i.id ORDER BY last DESC LIMIT ${MAX_IMPORTED_PAGES}`
    ).map((r) => ({ url: str(r.url), title: str(r.title), visits: num(r.visits), last: num(r.last) }))
  )
}
