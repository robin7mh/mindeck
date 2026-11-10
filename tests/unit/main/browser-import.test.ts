import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'
import { bplist } from './bplist-writer'
import { chromiumBookmarks, chromiumHistory, chromiumSearchEngine, chromiumTime, engineOf } from '../../../electron/main/services/browser/import/chromium'
import { firefoxBookmarks, firefoxHistory, parseProfilesIni } from '../../../electron/main/services/browser/import/firefox'
import { safariBookmarks, safariHistory } from '../../../electron/main/services/browser/import/safari'
import { BrowserImporter } from '../../../electron/main/services/browser/import'
import { findSources } from '../../../electron/main/services/browser/import/sources'
import { num, querySqliteCopy, str } from '../../../electron/main/services/browser/import/sqlite'
import { isFolder, type BookmarkNode } from '@shared/types/browserData'

/** µs since 1601 for a moment in ms since 1970, as Chromium stores it. */
const chromeUs = (ms: number) => (BigInt(ms) + 11_644_473_600_000n) * 1000n
const titles = (nodes: BookmarkNode[]): unknown[] => nodes.map((n) => (isFolder(n) ? { [n.title]: titles(n.children) } : n.title))

async function file(path: string, content: string) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

function db(path: string, sql: string) {
  const d = new DatabaseSync(path)
  d.exec(sql)
  d.close()
}

/** A Chromium profile folder: Bookmarks, History (SQLite), Preferences. */
async function chromiumProfile(dir: string, opts: { prefs?: unknown; history?: boolean; bookmarks?: unknown } = {}) {
  await mkdir(dir, { recursive: true })
  if (opts.bookmarks !== undefined) await file(join(dir, 'Bookmarks'), JSON.stringify(opts.bookmarks))
  if (opts.prefs !== undefined) await file(join(dir, 'Preferences'), JSON.stringify(opts.prefs))
  if (opts.history) {
    db(
      join(dir, 'History'),
      `CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
       INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES
         ('https://new.dev/', 'New', 3, 1, ${chromeUs(2_000_000)}, 0),
         ('https://old.dev/', 'Old', 1, 0, ${chromeUs(1_000_000)}, 0),
         ('https://hidden.dev/', 'Hidden', 1, 0, ${chromeUs(3_000_000)}, 1),
         ('https://never.dev/', NULL, 0, 0, 0, 0)`
    )
  }
}

async function firefoxProfile(dir: string) {
  await mkdir(dir, { recursive: true })
  db(
    join(dir, 'places.sqlite'),
    `CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, hidden INTEGER, last_visit_date INTEGER);
     CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT, dateAdded INTEGER, guid TEXT);
     INSERT INTO moz_places VALUES (1, 'https://mdn.dev/', 'MDN', 4, 0, 5000000), (2, 'https://tb.dev/', 'Toolbar page', 1, 0, 4000000),
       (3, 'place:sort=8', 'Recent', 0, 0, NULL), (4, 'https://hidden.dev/', 'H', 2, 1, 6000000);
     INSERT INTO moz_bookmarks VALUES
       (1, 2, NULL, 0, 0, '', 0, 'root________'),
       (2, 2, NULL, 1, 0, 'menu', 0, 'menu________'),
       (3, 2, NULL, 1, 1, 'toolbar', 0, 'toolbar_____'),
       (4, 2, NULL, 1, 2, 'tags', 0, 'tags________'),
       (5, 2, NULL, 1, 3, 'unfiled', 0, 'unfiled_____'),
       (10, 1, 2, 3, 0, 'TB', 7000, 'a'),
       (11, 2, NULL, 2, 0, 'Docs', 8000, 'b'),
       (12, 1, 1, 11, 0, 'MDN', 9000, 'c'),
       (13, 3, NULL, 11, 1, '', 0, 'd'),
       (14, 1, 3, 2, 1, 'Smart', 0, 'e'),
       (15, 1, 1, 5, 0, 'Unsorted MDN', 0, 'f'),
       (16, 1, 1, 4, 0, 'tagged', 0, 'g'),
       (17, 2, NULL, 3, 1, 'Empty', 0, 'h');`
  )
}

/** Safari's library: Bookmarks.plist (binary) and History.db, as Safari keeps them. */
async function safariLibrary(dir: string, opts: { bookmarks?: unknown; history?: boolean } = {}) {
  await mkdir(dir, { recursive: true })
  if (opts.bookmarks !== undefined) await writeFile(join(dir, 'Bookmarks.plist'), bplist(opts.bookmarks))
  if (opts.history) {
    db(
      join(dir, 'History.db'),
      `CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT, domain_expansion TEXT, visit_count INTEGER);
       CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT, load_successful BOOLEAN NOT NULL DEFAULT 1);
       INSERT INTO history_items VALUES (1, 'https://new.dev/', NULL, 3), (2, 'https://old.dev/', NULL, 1), (3, 'https://failed.dev/', NULL, 1);
       INSERT INTO history_visits VALUES (1, 1, 100.5, 'New, then', 1), (2, 1, 200, 'New', 1), (3, 2, 50, 'Old', 1), (4, 3, 300, 'Failed', 0);`
    )
  }
}

const leaf = (url: string, title?: string, extra: object = {}) => ({ WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: url, URIDictionary: title === undefined ? {} : { title }, ...extra })
const list = (Title: string, Children: unknown[]) => ({ WebBookmarkType: 'WebBookmarkTypeList', Title, Children })

/** Not readable for this process (what macOS does to Safari's folder without Full Disk Access). */
const shut = (path: string) => chmod(path, 0o000)
const open = (path: string) => chmod(path, 0o700)

afterEach(() => vi.restoreAllMocks())

describe('reading other browsers', () => {
  it('Chromium: bookmarks with the bar, Other and Mobile; times converted; junk left out', async () => {
    const dir = await tempDir()
    await chromiumProfile(dir, {
      bookmarks: {
        roots: {
          bookmark_bar: {
            children: [
              { type: 'url', name: 'A', url: 'https://a.dev/', date_added: String(chromeUs(1_700_000_000_000)) },
              { type: 'folder', name: 'Dev', children: [{ type: 'url', name: 'MDN', url: 'https://mdn.dev/' }, { type: 'url', name: 'no url' }, null], date_added: '0' }
            ]
          },
          other: { children: [{ type: 'url', url: 'https://o.dev/' }] },
          synced: { name: 'Mobile bookmarks', children: [{ type: 'url', name: 'Phone', url: 'https://phone.dev/' }] }
        }
      }
    })
    const set = await chromiumBookmarks(dir)
    expect(titles(set.bar)).toEqual(['A', { Dev: ['MDN'] }])
    expect(set.bar[0]).toMatchObject({ url: 'https://a.dev/', added: 1_700_000_000_000 })
    expect(titles(set.other)).toEqual(['', { 'Mobile bookmarks': ['Phone'] }])

    await chromiumProfile(dir, { bookmarks: { roots: { synced: { children: [{ type: 'url', url: 'https://m.dev/' }] }, bookmark_bar: { children: 'x' } } } })
    expect(titles((await chromiumBookmarks(dir)).other)).toEqual([{ Mobile: [''] }])
    await chromiumProfile(dir, { bookmarks: {} })
    expect(await chromiumBookmarks(dir)).toEqual({ bar: [], other: [] })
    expect(chromiumTime('x')).toBe(0)
  })

  it('Chromium: the newest visible pages from a copy of the locked History database', async () => {
    const dir = await tempDir()
    await chromiumProfile(dir, { history: true })
    // a journal next to it is copied along
    await writeFile(join(dir, 'History-journal'), '')
    expect(await chromiumHistory(dir)).toEqual([
      { url: 'https://new.dev/', title: 'New', visits: 3, last: 2_000_000 },
      { url: 'https://old.dev/', title: 'Old', visits: 1, last: 1_000_000 }
    ])
  })

  it('Chrome: the search engine from Preferences, else Chrome’s own default', async () => {
    const dir = await tempDir()
    await chromiumProfile(dir, { prefs: { default_search_provider_data: { template_url_data: { url: 'https://duckduckgo.com/?q={searchTerms}' } } } })
    expect(await chromiumSearchEngine(dir)).toBe('duckduckgo')
    await chromiumProfile(dir, { prefs: {} })
    expect(await chromiumSearchEngine(dir)).toBe('google')
    await chromiumProfile(dir, { prefs: { default_search_provider_data: { template_url_data: { url: 'https://yandex.ru/search?text={searchTerms}' } } } })
    expect(await chromiumSearchEngine(dir)).toBeUndefined() // one Mindeck doesn't offer
    expect(engineOf('https://www.google.de/search?q={searchTerms}')).toBe('google')
    expect(engineOf('https://www.bing.com/search?q=x')).toBe('bing')
    expect(engineOf('https://www.ecosia.org/search?q=x')).toBe('ecosia')
    expect(engineOf('https://search.brave.com/search?q=x')).toBe('brave')
    expect(engineOf('https://kagi.com/search?q=x')).toBe('kagi')
    expect(engineOf('https://yandex.ru/search?text=x')).toBeUndefined()
    expect(engineOf('not a url')).toBeUndefined()
  })

  it('Firefox: profiles.ini, bookmarks by root (toolbar = bar) and visited history', async () => {
    expect(
      parseProfilesIni(
        '[General]\nStartWithLastProfile=1\n\n[Profile1]\nName=dev-edition\nIsRelative=0\nPath=/abs/dev\n\r\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\nDefault=1\n[Profile2]\nIsRelative=1\nPath=Profiles/noname\n[Profile3]\nName=no path\nbroken line\n[Install123]\nDefault=Profiles/abc',
        '/root'
      )
    ).toEqual([
      { name: 'dev-edition', dir: '/abs/dev' },
      { name: 'default-release', dir: join('/root', 'Profiles/abc.default-release') },
      { name: 'Profiles/noname', dir: join('/root', 'Profiles/noname') }
    ])
    const dir = await tempDir()
    await firefoxProfile(dir)
    const set = await firefoxBookmarks(dir)
    expect(titles(set.bar)).toEqual(['TB', { Empty: [] }])
    expect(titles(set.other)).toEqual([{ Docs: ['MDN'] }, 'Unsorted MDN'])
    expect(set.other[0]).toMatchObject({ added: 8 })
    expect(await firefoxHistory(dir)).toEqual([
      { url: 'https://mdn.dev/', title: 'MDN', visits: 4, last: 5000 },
      { url: 'https://tb.dev/', title: 'Toolbar page', visits: 1, last: 4000 }
    ])

    const bare = await tempDir()
    db(join(bare, 'places.sqlite'), 'CREATE TABLE moz_places (id INTEGER, url TEXT); CREATE TABLE moz_bookmarks (id INTEGER, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT, dateAdded INTEGER, guid TEXT);')
    expect(await firefoxBookmarks(bare)).toEqual({ bar: [], other: [] })
  })

  it('Safari: the Favorites are the bar; the menu and the Reading List (a folder) go to Other; the history proxy stays out', async () => {
    const dir = await tempDir()
    await safariLibrary(dir, {
      bookmarks: {
        WebBookmarkFileVersion: 1,
        WebBookmarkType: 'WebBookmarkTypeList',
        Children: [
          { WebBookmarkType: 'WebBookmarkTypeProxy', Title: 'History' },
          list('BookmarksBar', [leaf('https://apple.com/', 'Apple'), list('Café ☕ Dev', [leaf('https://untitled.dev/'), { WebBookmarkType: 'WebBookmarkTypeLeaf' }, 'junk'])]),
          list('BookmarksMenu', [leaf('https://mdn.dev/', 'MDN')]),
          list('com.apple.ReadingList', [leaf('https://later.dev/', 'Later', { ReadingList: { DateAdded: new Date('2026-11-01T10:00:00Z'), PreviewText: '…' } })]),
          leaf('https://loose.dev/', 'Loose'),
          { WebBookmarkType: 'WebBookmarkTypeProxy', Title: 'Stray' }
        ],
        Sync: { Data: Buffer.from([0, 1, 2]) }
      }
    })
    const set = await safariBookmarks(dir, 'Reading List')
    expect(titles(set.bar)).toEqual(['Apple', { 'Café ☕ Dev': ['https://untitled.dev/'] }])
    expect(titles(set.other)).toEqual(['MDN', { 'Reading List': ['Later'] }, 'Loose'])
    expect((set.other[1] as { children: BookmarkNode[] }).children[0]).toMatchObject({ url: 'https://later.dev/', added: Date.parse('2026-11-01T10:00:00Z') })
    expect(set.bar[0]).toMatchObject({ url: 'https://apple.com/', added: 0 })

    // An empty Reading List leaves no folder; a library that isn't a dict, nothing.
    await safariLibrary(dir, { bookmarks: { Children: [list('com.apple.ReadingList', [])] } })
    expect(await safariBookmarks(dir, 'Leseliste')).toEqual({ bar: [], other: [] })
    await safariLibrary(dir, { bookmarks: ['not', 'a', 'dict'] })
    expect(await safariBookmarks(dir, 'Leseliste')).toEqual({ bar: [], other: [] })
  })

  it('Safari: the newest pages that loaded, with the title of the last visit, from a copy of History.db', async () => {
    const dir = await tempDir()
    await safariLibrary(dir, { history: true })
    expect(await safariHistory(dir)).toEqual([
      { url: 'https://new.dev/', title: 'New', visits: 3, last: (200 + 978_307_200) * 1000 },
      { url: 'https://old.dev/', title: 'Old', visits: 1, last: (50 + 978_307_200) * 1000 }
    ])
  })

  it('SQLite: copies are removed, and a runtime without SQLite says so', async () => {
    expect([str(5), str('x'), num('5'), num(Infinity), num(3)]).toEqual(['', 'x', 0, 0, 3])
    const dir = await tempDir()
    await expect(querySqliteCopy(join(dir, 'missing.db'), () => 1)).rejects.toThrow()
    db(join(dir, 'a.db'), 'CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1)')
    await expect(
      querySqliteCopy(join(dir, 'a.db'), () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    await expect(querySqliteCopy(join(dir, 'a.db'), (q) => q('SELECT x FROM t'))).resolves.toEqual([{ x: 1 }])

    const original = process.getBuiltinModule
    try {
      ;(process as { getBuiltinModule?: unknown }).getBuiltinModule = undefined
      await expect(querySqliteCopy(join(dir, 'a.db'), () => 1)).rejects.toMatchObject({ code: 'no-sqlite' })
      ;(process as { getBuiltinModule?: unknown }).getBuiltinModule = () => undefined
      await expect(querySqliteCopy(join(dir, 'a.db'), () => 1)).rejects.toMatchObject({ code: 'no-sqlite' })
    } finally {
      process.getBuiltinModule = original
    }
  })
})

describe('finding other browsers', () => {
  it('macOS: Chrome with its named profiles, Safari’s library, Firefox from profiles.ini', async () => {
    const home = await tempDir()
    const base = join(home, 'Library', 'Application Support')
    const chrome = join(base, 'Google', 'Chrome')
    await file(join(chrome, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Robin' }, 'Profile 2': { name: '' }, 'Profile 9': null } } }))
    await chromiumProfile(join(chrome, 'Default'), { bookmarks: {}, history: true, prefs: {} })
    await chromiumProfile(join(chrome, 'Profile 2'), { prefs: {} })
    const safari = join(home, 'Library', 'Safari')
    await safariLibrary(safari, { bookmarks: {}, history: true })
    const ff = join(base, 'Firefox')
    await file(join(ff, 'profiles.ini'), '[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/x\n[Profile1]\nName=gone\nIsRelative=1\nPath=Profiles/gone')
    await firefoxProfile(join(ff, 'Profiles', 'x'))

    expect(await findSources({ home, platform: 'darwin', env: {} })).toEqual([
      { id: `chrome:${join(chrome, 'Default')}`, browser: 'chrome', profile: 'Robin', kinds: ['bookmarks', 'history', 'settings'], dir: join(chrome, 'Default') },
      { id: `chrome:${join(chrome, 'Profile 2')}`, browser: 'chrome', profile: 'Profile 2', kinds: ['settings'], dir: join(chrome, 'Profile 2') },
      { id: `safari:${safari}`, browser: 'safari', profile: '', kinds: ['bookmarks', 'history'], dir: safari },
      { id: `firefox:${join(ff, 'Profiles', 'x')}`, browser: 'firefox', profile: 'default-release', kinds: ['bookmarks', 'history'], dir: join(ff, 'Profiles', 'x') }
    ])

    // Chrome without a readable Local State: its profile folders count. Safari with nothing in it: nothing.
    const other = await tempDir()
    const chrome2 = join(other, 'Library', 'Application Support', 'Google', 'Chrome')
    await chromiumProfile(join(chrome2, 'Default'), { bookmarks: {} })
    await chromiumProfile(join(chrome2, 'Profile 1'), { history: true })
    await mkdir(join(chrome2, 'System Profile'), { recursive: true })
    await file(join(chrome2, 'Local State'), 'not json')
    await mkdir(join(other, 'Library', 'Safari'), { recursive: true })
    expect((await findSources({ home: other, platform: 'darwin', env: {} })).map((f) => `${f.browser}:${f.profile}:${f.kinds.join('+')}`)).toEqual([
      'chrome:Default:bookmarks',
      'chrome:Profile 1:history'
    ])
    // None of the three: nothing
    expect(await findSources({ home: await tempDir(), platform: 'darwin', env: {} })).toEqual([])
  })

  it('a browser the system won’t let Mindeck read is there — locked, not left out', async () => {
    const home = await tempDir()
    const chrome = join(home, 'Library', 'Application Support', 'Google', 'Chrome')
    await chromiumProfile(join(chrome, 'Default'), { bookmarks: {} })
    const safari = join(home, 'Library', 'Safari')
    await safariLibrary(safari, { bookmarks: {} })
    const ini = join(home, 'Library', 'Application Support', 'Firefox', 'profiles.ini')
    await file(ini, '[Profile0]\nName=x\nIsRelative=1\nPath=x')
    await Promise.all([shut(chrome), shut(safari), shut(ini)])
    try {
      expect(await findSources({ home, platform: 'darwin', env: {} })).toEqual([
        { id: `chrome:${chrome}`, browser: 'chrome', profile: '', kinds: [], dir: chrome, locked: true },
        { id: `safari:${safari}`, browser: 'safari', profile: '', kinds: [], dir: safari, locked: true },
        { id: `firefox:${join(ini, '..')}`, browser: 'firefox', profile: '', kinds: [], dir: join(ini, '..'), locked: true }
      ])
    } finally {
      await Promise.all([open(chrome), open(safari), open(ini)])
    }
  })

  it('Windows and Linux: LocalAppData, .config and snaps — with and without the variables; Safari only on macOS', async () => {
    const home = await tempDir()
    const local = join(home, 'Local')
    await chromiumProfile(join(local, 'Google', 'Chrome', 'User Data', 'Default'), { bookmarks: {} })
    await firefoxProfile(join(home, 'Roaming', 'Mozilla', 'Firefox', 'Profiles', 'w'))
    await file(join(home, 'Roaming', 'Mozilla', 'Firefox', 'profiles.ini'), '[Profile0]\nName=win\nIsRelative=1\nPath=Profiles/w')
    await safariLibrary(join(home, 'Library', 'Safari'), { bookmarks: {} })
    const win = await findSources({ home, platform: 'win32', env: { LOCALAPPDATA: local, APPDATA: join(home, 'Roaming') } })
    expect(win.map((f) => `${f.browser}:${f.profile}:${f.kinds.join('+')}`)).toEqual(['chrome:Default:bookmarks', 'firefox:win:bookmarks+history'])
    // without the variables: the default folders under the home (a Local State without profiles: the folders count)
    await chromiumProfile(join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default'), { history: true })
    await file(join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Local State'), '{}')
    await file(join(home, 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'profiles.ini'), '')
    expect((await findSources({ home, platform: 'win32', env: {} })).map((f) => `${f.browser}:${f.kinds.join('+')}`)).toEqual(['chrome:history'])

    const linux = await tempDir()
    await chromiumProfile(join(linux, '.config', 'google-chrome', 'Default'), { bookmarks: {} })
    await firefoxProfile(join(linux, 'snap', 'firefox', 'common', '.mozilla', 'firefox', 'p'))
    await file(join(linux, 'snap', 'firefox', 'common', '.mozilla', 'firefox', 'profiles.ini'), '[Profile0]\nName=p\nIsRelative=1\nPath=p')
    expect((await findSources({ home: linux, platform: 'linux', env: {} })).map((f) => f.browser)).toEqual(['chrome', 'firefox'])
    const xdg = join(linux, 'xdg')
    await chromiumProfile(join(xdg, 'google-chrome', 'Profile 3'), { history: true })
    expect((await findSources({ home: linux, platform: 'linux', env: { XDG_CONFIG_HOME: xdg } })).map((f) => `${f.browser}:${f.profile}`)).toEqual(['chrome:Profile 3', 'firefox:p'])
  })

  it('the importer reads per kind and profile — Chrome, Safari, Firefox — and refuses what is not there or locked', async () => {
    const home = await tempDir()
    const base = join(home, 'Library', 'Application Support')
    await chromiumProfile(join(base, 'Google', 'Chrome', 'Default'), { bookmarks: { roots: { bookmark_bar: { children: [{ type: 'url', name: 'A', url: 'https://a.dev/' }] } } }, history: true, prefs: {} })
    await safariLibrary(join(home, 'Library', 'Safari'), { bookmarks: { Children: [list('BookmarksBar', [leaf('https://s.dev/', 'S')]), list('com.apple.ReadingList', [leaf('https://r.dev/', 'R')])] }, history: true })
    const ff = join(base, 'Firefox')
    await file(join(ff, 'profiles.ini'), '[Profile0]\nName=x\nIsRelative=1\nPath=x')
    await firefoxProfile(join(ff, 'x'))

    const importer = new BrowserImporter({ home, platform: 'darwin', env: {} })
    const chromeId = `chrome:${join(base, 'Google', 'Chrome', 'Default')}`
    // no scan yet: the first read scans
    expect(titles((await importer.bookmarks(chromeId, 'Reading List')).bar)).toEqual(['A'])
    const sources = await importer.sources()
    expect(sources.map((s) => s.browser)).toEqual(['chrome', 'safari', 'firefox'])
    expect(sources[0]).toEqual({ id: chromeId, browser: 'chrome', profile: 'Default', kinds: ['bookmarks', 'history', 'settings'] })
    expect(sources[1]).toEqual({ id: `safari:${join(home, 'Library', 'Safari')}`, browser: 'safari', profile: '', kinds: ['bookmarks', 'history'] })
    expect(await importer.history(chromeId)).toHaveLength(2)
    expect(await importer.searchEngine(chromeId)).toBe('google')
    const safari = await importer.bookmarks(sources[1].id, 'Leseliste')
    expect([titles(safari.bar), titles(safari.other)]).toEqual([['S'], [{ Leseliste: ['R'] }]])
    expect(await importer.history(sources[1].id)).toHaveLength(2)
    await expect(importer.searchEngine(sources[1].id)).rejects.toMatchObject({ code: 'unsupported' })
    expect(titles((await importer.bookmarks(sources[2].id, 'Reading List')).bar)).toEqual(['TB', { Empty: [] }])
    expect(await importer.history(sources[2].id)).toHaveLength(2)
    await expect(importer.searchEngine(sources[2].id)).rejects.toMatchObject({ code: 'unsupported' })
    await expect(importer.history('chrome:/nowhere')).rejects.toMatchObject({ code: 'not-found' })

    // Safari locked: listed as such, nothing to read from it
    const library = join(home, 'Library', 'Safari')
    await shut(library)
    try {
      const locked = (await importer.sources()).find((s) => s.browser === 'safari')!
      expect(locked).toEqual({ id: `safari:${library}`, browser: 'safari', profile: '', kinds: [], locked: true })
      await expect(importer.bookmarks(locked.id, 'Reading List')).rejects.toMatchObject({ code: 'unsupported' })
    } finally {
      await open(library)
    }
  })
})
