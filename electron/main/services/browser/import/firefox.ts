import { join } from 'node:path'
import type { BookmarkFolder, BookmarkNode } from '@shared/types/browserData'
import type { BookmarkSet } from '../bookmarks'
import { MAX_IMPORTED_PAGES, type ImportedPage } from './chromium'
import { num, querySqliteCopy, str } from './sqlite'

/** A profile listed in Firefox's `profiles.ini`. */
export interface FirefoxProfile {
  name: string
  /** Absolute folder. */
  dir: string
}

/** The profiles in a `profiles.ini` (`[ProfileN]` sections with Name, Path, IsRelative). */
export function parseProfilesIni(text: string, root: string): FirefoxProfile[] {
  const out: FirefoxProfile[] = []
  let section: Record<string, string> | null = null
  const flush = () => {
    if (section?.path) out.push({ name: section.name || section.path, dir: section.isrelative === '0' ? section.path : join(root, section.path) })
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      flush()
      section = /^\[Profile\d+\]$/i.test(line) ? {} : null
    } else if (section) {
      const eq = line.indexOf('=')
      if (eq > 0) section[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim()
    }
  }
  flush()
  return out
}

/** Firefox's root folders by guid: the toolbar is the bar, menu, unsorted and mobile the rest. */
const BAR_ROOT = 'toolbar_____'
const OTHER_ROOTS = ['menu________', 'unfiled_____', 'mobile______']

/** Bookmarks from `places.sqlite` (type 1 = bookmark, 2 = folder; separators and tags left out). */
export function firefoxBookmarks(profile: string): Promise<BookmarkSet> {
  return querySqliteCopy(join(profile, 'places.sqlite'), (query) => {
    const rows = query(
      `SELECT b.id, b.type, b.parent, b.title, b.dateAdded / 1000 AS added, b.guid, p.url FROM moz_bookmarks b
       LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position`
    )
    const byParent = new Map<number, typeof rows>()
    for (const r of rows) {
      const list = byParent.get(num(r.parent)) ?? []
      list.push(r)
      byParent.set(num(r.parent), list)
    }
    const children = (id: number): BookmarkNode[] =>
      (byParent.get(id) ?? []).flatMap((r): BookmarkNode[] => {
        if (r.type === 2) return [{ id: '', title: str(r.title), children: children(num(r.id)), added: num(r.added) } satisfies BookmarkFolder]
        return r.type === 1 && /^(https?|file):/i.test(str(r.url)) ? [{ id: '', title: str(r.title), url: str(r.url), added: num(r.added) }] : []
      })
    const root = (guid: string) => rows.find((r) => r.guid === guid)
    const of = (guid: string) => {
      const r = root(guid)
      return r ? children(num(r.id)) : []
    }
    return { bar: of(BAR_ROOT), other: OTHER_ROOTS.flatMap(of) }
  })
}

/** History from `places.sqlite`: the newest pages that were visited. */
export function firefoxHistory(profile: string): Promise<ImportedPage[]> {
  return querySqliteCopy(join(profile, 'places.sqlite'), (query) =>
    query(
      `SELECT url, title, visit_count AS visits, last_visit_date / 1000 AS last FROM moz_places
       WHERE hidden = 0 AND visit_count > 0 AND last_visit_date IS NOT NULL ORDER BY last_visit_date DESC LIMIT ${MAX_IMPORTED_PAGES}`
    ).map((r) => ({ url: str(r.url), title: str(r.title), visits: num(r.visits), last: num(r.last) }))
  )
}
