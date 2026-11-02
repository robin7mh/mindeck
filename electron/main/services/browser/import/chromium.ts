import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SearchEngine } from '@shared/types/browser'
import type { BookmarkNode } from '@shared/types/browserData'
import type { BookmarkSet } from '../bookmarks'
import { num, querySqliteCopy, str } from './sqlite'

/** A page from another browser's history. */
export interface ImportedPage {
  url: string
  title: string
  visits: number
  /** Last visit, ms since 1970. */
  last: number
}

/** Pages taken from a history at most (the newest). */
export const MAX_IMPORTED_PAGES = 20_000

/** Chromium counts time in µs since 1601 — ms since 1970 here. */
const EPOCH_DELTA_MS = 11_644_473_600_000

export function chromiumTime(value: unknown): number {
  const us = Number(value)
  return Number.isFinite(us) && us > 0 ? Math.round(us / 1000 - EPOCH_DELTA_MS) : 0
}

export async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'))
}

/** A Chromium bookmark node (`Bookmarks` file): `type` url or folder. */
function node(raw: unknown): BookmarkNode | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const added = chromiumTime(r.date_added)
  if (r.type === 'folder') return { id: '', title: str(r.name), children: nodes(r.children), added }
  return r.type === 'url' && typeof r.url === 'string' ? { id: '', title: str(r.name), url: r.url, added } : null
}

function nodes(raw: unknown): BookmarkNode[] {
  return Array.isArray(raw) ? raw.map(node).filter((n): n is BookmarkNode => !!n) : []
}

/** The profile's `Bookmarks` file: the bar, then Other and Mobile bookmarks. */
export async function chromiumBookmarks(profile: string): Promise<BookmarkSet> {
  const data = (await readJson(join(profile, 'Bookmarks'))) as { roots?: Record<string, { children?: unknown; name?: unknown }> }
  const roots = data?.roots ?? {}
  const mobile = nodes(roots.synced?.children)
  return {
    bar: nodes(roots.bookmark_bar?.children),
    other: [...nodes(roots.other?.children), ...(mobile.length ? [{ id: '', title: str(roots.synced?.name) || 'Mobile', children: mobile, added: 0 }] : [])]
  }
}

/** The profile's `History` database: the newest visible pages. */
export function chromiumHistory(profile: string): Promise<ImportedPage[]> {
  return querySqliteCopy(join(profile, 'History'), (query) =>
    query(
      // The time is converted in SQL: in µs since 1601 it is past what a JS number holds exactly.
      `SELECT url, title, visit_count AS visits, last_visit_time / 1000 - ${EPOCH_DELTA_MS} AS last FROM urls
       WHERE hidden = 0 AND last_visit_time > 0 ORDER BY last_visit_time DESC LIMIT ${MAX_IMPORTED_PAGES}`
    ).map((r) => ({ url: str(r.url), title: str(r.title), visits: num(r.visits), last: num(r.last) }))
  )
}

/** The engine a search URL belongs to, if Mindeck offers it. */
export function engineOf(url: string): SearchEngine | undefined {
  let host = ''
  try {
    host = new URL(url.replace(/\{[^}]*\}/g, 'x')).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
  if (/(^|\.)google\.[a-z.]+$/.test(host)) return 'google'
  if (host === 'duckduckgo.com') return 'duckduckgo'
  if (host === 'bing.com') return 'bing'
  if (host === 'ecosia.org') return 'ecosia'
  if (host === 'search.brave.com') return 'brave'
  if (host === 'kagi.com') return 'kagi'
  return undefined
}

/** What each browser searches with until the user picks another engine. */
const DEFAULT_ENGINE: Partial<Record<string, SearchEngine>> = { chrome: 'google', chromium: 'google', arc: 'google', brave: 'brave', edge: 'bing' }

/** The search engine the profile uses (from `Preferences`), else the browser's own default. */
export async function chromiumSearchEngine(profile: string, browser: string): Promise<SearchEngine | undefined> {
  const prefs = (await readJson(join(profile, 'Preferences'))) as { default_search_provider_data?: { template_url_data?: { url?: unknown } } }
  const url = prefs?.default_search_provider_data?.template_url_data?.url
  return typeof url === 'string' ? engineOf(url) : DEFAULT_ENGINE[browser]
}
