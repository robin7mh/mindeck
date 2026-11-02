// The Mindeck browser's library (architecture §12.9): bookmarks, the history
// page, imports from other browsers, and the pages Mindeck draws itself.
// Pure module (no DOM/Node/Electron) so it compiles under both tsconfigs.

import type { SearchEngine } from './browser'

/** A saved page. */
export interface BookmarkItem {
  id: string
  title: string
  url: string
  /** When it was saved (ms since 1970). */
  added: number
}

/** A folder of bookmarks and folders. */
export interface BookmarkFolder {
  id: string
  title: string
  children: BookmarkNode[]
  added: number
}

export type BookmarkNode = BookmarkItem | BookmarkFolder

/** The two folders every library has: the bar under the toolbar, and everything else. */
export const BOOKMARK_ROOTS = ['bar', 'other'] as const
export type BookmarkRoot = (typeof BOOKMARK_ROOTS)[number]

export function isFolder(node: BookmarkNode): node is BookmarkFolder {
  return 'children' in node
}

/** Pages Mindeck draws itself in a tab (no web page behind them). */
export const INTERNAL_PAGES = { history: 'mindeck://history', bookmarks: 'mindeck://bookmarks' } as const
export type InternalPage = keyof typeof INTERNAL_PAGES

/** The internal page `url` names, if it is one. */
export function internalPage(url: string): InternalPage | undefined {
  const key = /^mindeck:\/\/([a-z]+)\/?$/i.exec(url.trim())?.[1].toLowerCase()
  return key === 'history' || key === 'bookmarks' ? key : undefined
}

/** Browsers Mindeck takes bookmarks and history over from. */
export const IMPORT_BROWSERS = ['chrome', 'brave', 'edge', 'arc', 'vivaldi', 'chromium', 'firefox'] as const
export type ImportBrowser = (typeof IMPORT_BROWSERS)[number]

/** How the browsers call themselves. */
export const BROWSER_NAMES: Record<ImportBrowser, string> = {
  chrome: 'Google Chrome',
  brave: 'Brave',
  edge: 'Microsoft Edge',
  arc: 'Arc',
  vivaldi: 'Vivaldi',
  chromium: 'Chromium',
  firefox: 'Firefox'
}

export type ImportKind = 'bookmarks' | 'history' | 'settings'

/** A profile of another browser on this machine. */
export interface ImportSource {
  /** `<browser>:<profile folder>` — stable between scans. */
  id: string
  browser: ImportBrowser
  /** The profile as that browser names it ("Person 1", "Work", "default-release"). */
  profile: string
  /** What there is to take over. */
  kinds: ImportKind[]
}

export interface ImportRequest {
  sourceId: string
  kinds: ImportKind[]
}

/** How an import went — per kind, so one failing never hides what worked. */
export interface ImportResult {
  sourceId: string
  bookmarks: number
  history: number
  /** The search engine taken over (only one Mindeck offers too). */
  searchEngine?: SearchEngine
  /** What failed, by kind (the reason in English, for the log). */
  errors: { kind: ImportKind; message: string }[]
}

/** Pushed while an import runs: the kind it is at now. */
export interface ImportProgress {
  sourceId: string
  kind: ImportKind
}
