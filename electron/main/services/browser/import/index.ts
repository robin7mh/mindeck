import type { SearchEngine } from '@shared/types/browser'
import type { ImportKind, ImportSource } from '@shared/types/browserData'
import type { BookmarkSet } from '../bookmarks'
import { arcBookmarks } from './arc'
import { chromiumBookmarks, chromiumHistory, chromiumSearchEngine, readJson, type ImportedPage } from './chromium'
import { firefoxBookmarks, firefoxHistory } from './firefox'
import { findSources, type FoundProfile, type ImportEnv } from './sources'

export type { ImportedPage } from './chromium'
export type { ImportEnv } from './sources'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Bookmarks, history and the search engine from the other browsers on this
 * machine (Chrome, Brave, Edge, Arc, Vivaldi, Chromium, Firefox). Read-only:
 * their files are read (databases from a temp copy), never changed. Cookies
 * and passwords stay where they are — Chromium encrypts them.
 */
export class BrowserImporter {
  private found = new Map<string, FoundProfile>()

  constructor(private readonly env: ImportEnv) {}

  /** The profiles there are, as the UI lists them. */
  async sources(): Promise<ImportSource[]> {
    const list = await findSources(this.env)
    this.found = new Map(list.map((p) => [p.id, p]))
    return list.map(({ id, browser, profile, kinds }) => ({ id, browser, profile, kinds }))
  }

  bookmarks(sourceId: string): Promise<BookmarkSet> {
    return this.read(sourceId, 'bookmarks', async (p) => {
      if (p.browser === 'firefox') return firefoxBookmarks(p.dir)
      if (p.sidebar) return arcBookmarks(await readJson(p.sidebar), p.dir.split(/[\\/]/).pop()!)
      return chromiumBookmarks(p.dir)
    })
  }

  history(sourceId: string): Promise<ImportedPage[]> {
    return this.read(sourceId, 'history', (p) => (p.browser === 'firefox' ? firefoxHistory(p.dir) : chromiumHistory(p.dir)))
  }

  searchEngine(sourceId: string): Promise<SearchEngine | undefined> {
    return this.read(sourceId, 'settings', (p) => chromiumSearchEngine(p.dir, p.browser))
  }

  private async read<T>(sourceId: string, kind: ImportKind, run: (p: FoundProfile) => Promise<T>): Promise<T> {
    if (!this.found.has(sourceId)) await this.sources()
    const profile = this.found.get(sourceId)
    if (!profile) throw coded('not-found', 'That browser profile is gone')
    if (!profile.kinds.includes(kind)) throw coded('unsupported', `Nothing of that kind (${kind}) to import there`)
    return run(profile)
  }
}
