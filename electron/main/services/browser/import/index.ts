import type { SearchEngine } from '@shared/types/browser'
import type { ImportKind, ImportSource } from '@shared/types/browserData'
import type { BookmarkSet } from '../bookmarks'
import { chromiumBookmarks, chromiumHistory, chromiumSearchEngine, type ImportedPage } from './chromium'
import { firefoxBookmarks, firefoxHistory } from './firefox'
import { safariBookmarks, safariHistory } from './safari'
import { findSources, type FoundProfile, type ImportEnv } from './sources'

export type { ImportedPage } from './chromium'
export type { ImportEnv } from './sources'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Bookmarks and history from Chrome, Safari and Firefox on this machine (and
 * Chrome's search engine). Read-only: their files are read (databases from a
 * temp copy), never changed. Cookies and passwords stay where they are — the
 * browsers encrypt them.
 */
export class BrowserImporter {
  private found = new Map<string, FoundProfile>()

  constructor(private readonly env: ImportEnv) {}

  /** The profiles there are, as the UI lists them (a locked browser as one entry that says so). */
  async sources(): Promise<ImportSource[]> {
    const list = await findSources(this.env)
    this.found = new Map(list.map((p) => [p.id, p]))
    return list.map(({ id, browser, profile, kinds, locked }) => ({ id, browser, profile, kinds, ...(locked ? { locked } : {}) }))
  }

  /** `readingList`: the folder Safari's Reading List lands in. */
  bookmarks(sourceId: string, readingList: string): Promise<BookmarkSet> {
    return this.read(sourceId, 'bookmarks', (p) =>
      p.browser === 'firefox' ? firefoxBookmarks(p.dir) : p.browser === 'safari' ? safariBookmarks(p.dir, readingList) : chromiumBookmarks(p.dir)
    )
  }

  history(sourceId: string): Promise<ImportedPage[]> {
    return this.read(sourceId, 'history', (p) => (p.browser === 'firefox' ? firefoxHistory(p.dir) : p.browser === 'safari' ? safariHistory(p.dir) : chromiumHistory(p.dir)))
  }

  /** Chrome's (the one browser of the three whose engine is readable). */
  searchEngine(sourceId: string): Promise<SearchEngine | undefined> {
    return this.read(sourceId, 'settings', (p) => chromiumSearchEngine(p.dir))
  }

  private async read<T>(sourceId: string, kind: ImportKind, run: (p: FoundProfile) => Promise<T>): Promise<T> {
    if (!this.found.has(sourceId)) await this.sources()
    const profile = this.found.get(sourceId)
    if (!profile) throw coded('not-found', 'That browser profile is gone')
    if (!profile.kinds.includes(kind)) throw coded('unsupported', `Nothing of that kind (${kind}) to import there`)
    return run(profile)
  }
}
