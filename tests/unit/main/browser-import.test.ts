import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'
import { arcBookmarks } from '../../../electron/main/services/browser/import/arc'
import { chromiumBookmarks, chromiumHistory, chromiumSearchEngine, chromiumTime, engineOf } from '../../../electron/main/services/browser/import/chromium'
import { firefoxBookmarks, firefoxHistory, parseProfilesIni } from '../../../electron/main/services/browser/import/firefox'
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

  it('Chromium: the search engine from Preferences, else the browser’s own default', async () => {
    const dir = await tempDir()
    await chromiumProfile(dir, { prefs: { default_search_provider_data: { template_url_data: { url: 'https://duckduckgo.com/?q={searchTerms}' } } } })
    expect(await chromiumSearchEngine(dir, 'chrome')).toBe('duckduckgo')
    await chromiumProfile(dir, { prefs: {} })
    expect(await chromiumSearchEngine(dir, 'edge')).toBe('bing')
    expect(await chromiumSearchEngine(dir, 'vivaldi')).toBeUndefined()
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

  it('Arc: each space’s pinned tabs as a folder, favorites on the bar, per profile', () => {
    const sidebar = {
      sidebar: {
        containers: [
          { global: {} },
          {
            spaces: [
              'w',
              { id: 'w', title: 'Work', containerIDs: ['unpinned', 'wu', 'pinned', 'wp'], profile: { default: true } },
              'p',
              { id: 'p', title: '', containerIDs: ['pinned', 'pp'], profile: { custom: { _0: { directoryBasename: 'Profile 1' } } } },
              { id: 'e', title: 'Empty', containerIDs: ['pinned'] },
              { id: 'l', title: 'Leaf', containerIDs: ['pinned', 'leaf'] },
              { id: 'n', containerIDs: 'x' },
              5
            ],
            items: [
              { id: 'wp', childrenIds: ['t1', 'f1', 'gone', 'cycle'] },
              { id: 't1', title: 'Linear', data: { tab: { savedURL: 'https://linear.app/' } } },
              { id: 'f1', title: 'Folder', data: { list: {} }, childrenIds: ['t2', 't3', 5] },
              { id: 't2', title: null, data: { tab: { savedURL: 'https://gh.dev/', savedTitle: 'GitHub' } } },
              { id: 't3', title: '', data: { tab: { savedURL: 'arc://settings' } } },
              { id: 't5', data: { tab: { savedTitle: 7 } } },
              { id: 'cycle', title: 'Cycle', childrenIds: ['wp'] },
              { id: 'pp', childrenIds: ['t4'] },
              { id: 't4', title: 'P1', data: { tab: { savedURL: 'https://p1.dev/', savedTitle: 5 } } },
              { id: 'fav', childrenIds: ['t2', 't5', 't6'] },
              { id: 't6', data: { tab: { savedURL: 'https://untitled.dev/' } } },
              { id: 'leaf', title: 'no children' },
              'junk'
            ],
            topAppsContainerIDs: [{ default: true }, 'fav']
          }
        ]
      }
    }
    const def = arcBookmarks(sidebar, 'Default')
    expect(titles(def.other)).toEqual([{ Work: ['Linear', { Folder: ['GitHub'] }] }])
    expect(titles(def.bar)).toEqual(['GitHub', ''])
    const p1 = arcBookmarks(sidebar, 'Profile 1')
    expect(titles(p1.other)).toEqual([{ Arc: ['P1'] }])
    expect(p1.bar).toEqual([])
    expect(arcBookmarks({ sidebar: { containers: [{ items: [] }] } }, 'Default')).toEqual({ bar: [], other: [] })
    expect(arcBookmarks(null, 'Default')).toEqual({ bar: [], other: [] })
    expect(arcBookmarks({ sidebar: { containers: [{ items: [], spaces: [] }] } }, 'Default')).toEqual({ bar: [], other: [] })
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
  it('macOS: Chromium browsers with their named profiles, Arc with its sidebar, Firefox from profiles.ini', async () => {
    const home = await tempDir()
    const base = join(home, 'Library', 'Application Support')
    const chrome = join(base, 'Google', 'Chrome')
    await file(join(chrome, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Robin' }, 'Profile 2': { name: '' }, 'Profile 9': null } } }))
    await chromiumProfile(join(chrome, 'Default'), { bookmarks: {}, history: true, prefs: {} })
    await chromiumProfile(join(chrome, 'Profile 2'), { prefs: {} })
    // Brave without Local State: its profile folders count
    const brave = join(base, 'BraveSoftware', 'Brave-Browser')
    await chromiumProfile(join(brave, 'Default'), { bookmarks: {} })
    await chromiumProfile(join(brave, 'Profile 1'), { history: true })
    await mkdir(join(brave, 'System Profile'), { recursive: true })
    await file(join(brave, 'Local State'), 'not json')
    // Arc: bookmarks come from the sidebar next to "User Data"
    const arc = join(base, 'Arc', 'User Data')
    await chromiumProfile(join(arc, 'Default'), { history: true })
    await file(join(base, 'Arc', 'StorableSidebar.json'), '{}')
    // Firefox
    const ff = join(base, 'Firefox')
    await file(join(ff, 'profiles.ini'), '[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/x\n[Profile1]\nName=gone\nIsRelative=1\nPath=Profiles/gone')
    await firefoxProfile(join(ff, 'Profiles', 'x'))

    const found = await findSources({ home, platform: 'darwin', env: {} })
    expect(found.map(({ id, browser, profile, kinds }) => ({ id, browser, profile, kinds }))).toEqual([
      { id: `chrome:${join(chrome, 'Default')}`, browser: 'chrome', profile: 'Robin', kinds: ['bookmarks', 'history', 'settings'] },
      { id: `chrome:${join(chrome, 'Profile 2')}`, browser: 'chrome', profile: 'Profile 2', kinds: ['settings'] },
      { id: `brave:${join(brave, 'Default')}`, browser: 'brave', profile: 'Default', kinds: ['bookmarks'] },
      { id: `brave:${join(brave, 'Profile 1')}`, browser: 'brave', profile: 'Profile 1', kinds: ['history'] },
      { id: `arc:${join(arc, 'Default')}`, browser: 'arc', profile: 'Default', kinds: ['bookmarks', 'history'] },
      { id: `firefox:${join(ff, 'Profiles', 'x')}`, browser: 'firefox', profile: 'default-release', kinds: ['bookmarks', 'history'] }
    ])
    expect(found.find((f) => f.browser === 'arc')!.sidebar).toBe(join(arc, '..', 'StorableSidebar.json'))
  })

  it('Windows and Linux: LocalAppData and Store packages, .config and snaps — with and without the variables', async () => {
    const home = await tempDir()
    const local = join(home, 'Local')
    const arcPkg = join(local, 'Packages', 'TheBrowserCompany.Arc_ttt')
    await chromiumProfile(join(arcPkg, 'LocalCache', 'Local', 'Arc', 'User Data', 'Default'), { history: true })
    await file(join(arcPkg, 'LocalCache', 'Roaming', 'Arc', 'StorableSidebar.json'), '{}')
    await chromiumProfile(join(local, 'Microsoft', 'Edge', 'User Data', 'Default'), { bookmarks: {} })
    await firefoxProfile(join(home, 'Roaming', 'Mozilla', 'Firefox', 'Profiles', 'w'))
    await file(join(home, 'Roaming', 'Mozilla', 'Firefox', 'profiles.ini'), '[Profile0]\nName=win\nIsRelative=1\nPath=Profiles/w')
    const win = await findSources({ home, platform: 'win32', env: { LOCALAPPDATA: local, APPDATA: join(home, 'Roaming') } })
    expect(win.map((f) => `${f.browser}:${f.profile}:${f.kinds.join('+')}`)).toEqual(['edge:Default:bookmarks', 'arc:Default:bookmarks+history', 'firefox:win:bookmarks+history'])
    expect(win.find((f) => f.browser === 'arc')!.sidebar).toBe(join(arcPkg, 'LocalCache', 'Local', 'Arc', 'User Data', '..', '..', '..', 'Roaming', 'Arc', 'StorableSidebar.json'))
    // without the variables: the default folders under the home
    await chromiumProfile(join(home, 'AppData', 'Local', 'Vivaldi', 'User Data', 'Default'), { bookmarks: {} })
    await file(join(home, 'AppData', 'Local', 'Vivaldi', 'User Data', 'Local State'), '{}')
    await file(join(home, 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'profiles.ini'), '')
    expect((await findSources({ home, platform: 'win32', env: {} })).map((f) => f.browser)).toEqual(['vivaldi'])

    const linux = await tempDir()
    await chromiumProfile(join(linux, '.config', 'google-chrome', 'Default'), { bookmarks: {} })
    await chromiumProfile(join(linux, 'snap', 'chromium', 'common', 'chromium', 'Default'), { history: true })
    await firefoxProfile(join(linux, '.mozilla', 'firefox', 'p'))
    await file(join(linux, '.mozilla', 'firefox', 'profiles.ini'), '[Profile0]\nName=p\nIsRelative=1\nPath=p')
    expect((await findSources({ home: linux, platform: 'linux', env: {} })).map((f) => f.browser)).toEqual(['chrome', 'chromium', 'firefox'])
    const xdg = join(linux, 'xdg')
    await chromiumProfile(join(xdg, 'microsoft-edge', 'Default'), { bookmarks: {} })
    expect((await findSources({ home: linux, platform: 'linux', env: { XDG_CONFIG_HOME: xdg } })).map((f) => f.browser)).toEqual(['edge', 'chromium', 'firefox'])
  })

  it('the importer reads per kind and profile, and refuses what is not there', async () => {
    const home = await tempDir()
    const base = join(home, 'Library', 'Application Support')
    await chromiumProfile(join(base, 'Google', 'Chrome', 'Default'), { bookmarks: { roots: { bookmark_bar: { children: [{ type: 'url', name: 'A', url: 'https://a.dev/' }] } } }, history: true, prefs: {} })
    await chromiumProfile(join(base, 'Arc', 'User Data', 'Default'), {})
    await file(join(base, 'Arc', 'StorableSidebar.json'), JSON.stringify({ sidebar: { containers: [{ items: [{ id: 'fav', childrenIds: ['t'] }, { id: 't', title: 'T', data: { tab: { savedURL: 'https://t.dev/' } } }], spaces: [], topAppsContainerIDs: ['fav'] }] } }))
    const ff = join(base, 'Firefox')
    await file(join(ff, 'profiles.ini'), '[Profile0]\nName=x\nIsRelative=1\nPath=x')
    await firefoxProfile(join(ff, 'x'))

    const importer = new BrowserImporter({ home, platform: 'darwin', env: {} })
    const chromeId = `chrome:${join(base, 'Google', 'Chrome', 'Default')}`
    // no scan yet: the first read scans
    expect(titles((await importer.bookmarks(chromeId)).bar)).toEqual(['A'])
    const sources = await importer.sources()
    expect(sources.map((s) => s.browser)).toEqual(['chrome', 'arc', 'firefox'])
    expect(sources[0]).toEqual({ id: chromeId, browser: 'chrome', profile: 'Default', kinds: ['bookmarks', 'history', 'settings'] })
    expect(await importer.history(chromeId)).toHaveLength(2)
    expect(await importer.searchEngine(chromeId)).toBe('google')
    expect(titles((await importer.bookmarks(sources[1].id)).bar)).toEqual(['T'])
    expect(titles((await importer.bookmarks(sources[2].id)).bar)).toEqual(['TB', { Empty: [] }])
    expect(await importer.history(sources[2].id)).toHaveLength(2)
    await expect(importer.searchEngine(sources[2].id)).rejects.toMatchObject({ code: 'unsupported' })
    await expect(importer.history('chrome:/nowhere')).rejects.toMatchObject({ code: 'not-found' })
  })
})
