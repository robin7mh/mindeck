import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { tempDir, tick } from './helpers'
import { lastMenu, menuEntry, setupBrowser } from './browserServiceFixtures'
import { cleanNav } from '../../../electron/main/services/browser/BrowserService'
import type { BookmarkFolder } from '@shared/types/browserData'
import type { BrowserDownload } from '@shared/types/browser'

const nav = (urls: string[], index = urls.length - 1) => ({ entries: urls.map((url) => ({ url, title: url })), index })

describe('BrowserService · Mindeck’s own pages', () => {
  it('open history and bookmarks as tabs without a web view — once each, never for agents', async () => {
    const { b, host } = await setupBrowser()
    b.attach(host)
    b.setView({ x: 0, y: 0, width: 10, height: 10 })
    const history = b.open({ url: 'mindeck://history' })
    expect(history).toMatchObject({ url: 'mindeck://history', shared: false, loading: false })
    expect(host.create).not.toHaveBeenCalled()
    expect(host.show).toHaveBeenLastCalledWith(undefined)
    // asked again: the open one comes to the front
    const page = b.open({ url: 'https://a.dev/' })
    expect(b.open({ url: 'MINDECK://history/' }).id).toBe(history.id)
    expect(b.state().activeId).toBe(history.id)
    // reload, back: nothing to do; sharing never applies
    b.go(history.id, 'reload')
    b.update(history.id, { shared: true })
    expect(b.state().tabs.find((t) => t.id === history.id)!.shared).toBe(false)
    expect(b.agentTabs().map((t) => t.id)).not.toContain(history.id)

    // typed into a tab with a page: the page goes, the internal page shows
    b.navigate(page.id, 'mindeck://bookmarks')
    expect(host.destroy).toHaveBeenCalledWith(page.id)
    expect(b.state().tabs.find((t) => t.id === page.id)).toMatchObject({ url: 'mindeck://bookmarks', title: '', canGoBack: false })
    // and back to the web: a view again
    b.navigate(page.id, 'b.dev')
    expect(host.create).toHaveBeenLastCalledWith(page.id, 'https://b.dev/', expect.any(Object))
    // an unloaded tab turns internal without a view to destroy
    const ntp = b.open()
    host.destroy.mockClear()
    b.navigate(ntp.id, 'mindeck://bookmarks')
    expect(host.destroy).not.toHaveBeenCalled()

    // closed and reopened: still no view
    b.close(history.id)
    host.create.mockClear()
    expect(b.reopen()).toMatchObject({ url: 'mindeck://history' })
    expect(host.create).not.toHaveBeenCalled()
    b.activate(b.state().tabs.find((t) => t.url === 'mindeck://history')!.id)
    expect(host.create).not.toHaveBeenCalled()
  })
})

describe('BrowserService · bookmarks', () => {
  it('keeps bookmarks, pushes every change, and suggests them in the address bar', async () => {
    const { b, sent } = await setupBrowser()
    const a = b.addBookmark({ title: 'Docs', url: 'https://docs.dev/' })
    const folder = b.addBookmark({ parentId: 'other', title: 'Work' })
    b.updateBookmark(a.id, { title: 'The docs' })
    b.moveBookmark(a.id, folder.id, 0)
    expect(b.bookmarkTree()[1].children).toEqual([expect.objectContaining({ title: 'Work', children: [expect.objectContaining({ title: 'The docs' })] })])
    expect(b.suggest('docs')).toContainEqual({ kind: 'bookmark', url: 'https://docs.dev/', title: 'The docs' })
    b.addBookmark({ title: '', url: 'https://untitled.dev/' })
    expect(b.suggest('untitled')).toContainEqual({ kind: 'bookmark', url: 'https://untitled.dev/', title: 'https://untitled.dev/' })
    expect(b.removeBookmarks([folder.id])).toBe(1)
    const pushes = sent('browser:bookmarks') as BookmarkFolder[][]
    expect(pushes).toHaveLength(6)
    expect(pushes.at(-1)![1].children).toEqual([])
  })

  it('export and import bookmark files, named in the UI language', async () => {
    const { b } = await setupBrowser()
    b.setUi({ theme: 'system', locale: 'de' })
    b.addBookmark({ title: 'A', url: 'https://a.dev/' })
    const html = b.exportBookmarks()
    expect(html).toContain('PERSONAL_TOOLBAR_FOLDER="true">Lesezeichenleiste</H3>')
    expect(b.importBookmarksHtml(html)).toBe(0) // all there already
    expect(b.importBookmarksHtml('<DL><p><DT><A HREF="https://new.dev/">New</A></DL>')).toBe(1)
    expect(b.bookmarkTree()[1].children).toEqual([expect.objectContaining({ title: 'Importiert' })])
  })
})

describe('BrowserService · history page and search suggestions', () => {
  it('lists and forgets history', async () => {
    const { b, host, events } = await setupBrowser()
    b.attach(host)
    const t = b.open({ url: 'https://a.dev/' })
    events.navigated(t.id, { url: 'https://a.dev/', canGoBack: false, canGoForward: false })
    expect(b.historyList({ query: 'a.dev' }).map((e) => e.url)).toEqual(['https://a.dev/'])
    expect(await b.deleteHistory({ urls: ['https://a.dev/'] })).toBe(1)
    expect(b.historyList({})).toEqual([])
  })

  it('asks the search engine only when the user allows it', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ['re', ['react', 'redux']] }))
    const { b } = await setupBrowser({ deps: { fetch } })
    expect(await b.searchSuggestions('re')).toEqual([
      { kind: 'suggestion', url: 'https://www.google.com/search?q=react', title: 'react' },
      { kind: 'suggestion', url: 'https://www.google.com/search?q=redux', title: 'redux' }
    ])
    await b.configure({ searchSuggestions: false })
    expect(await b.searchSuggestions('red')).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('BrowserService · importing from other browsers', () => {
  async function chromeHome() {
    const home = await tempDir()
    const profile = join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { children: [{ type: 'url', name: 'A', url: 'https://a.dev/' }] }, other: { children: [{ type: 'url', name: 'O', url: 'https://o.dev/' }] } } }))
    await writeFile(join(profile, 'Preferences'), JSON.stringify({ default_search_provider_data: { template_url_data: { url: 'https://duckduckgo.com/?q={searchTerms}' } } }))
    const db = new DatabaseSync(join(profile, 'History'))
    db.exec(`CREATE TABLE urls (url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
      INSERT INTO urls VALUES ('https://h.dev/', 'H', 2, 13300000000000000, 0)`)
    db.close()
    return { home, profile, id: `chrome:${profile}` }
  }

  it('takes bookmarks, history and the search engine over, reporting each step', async () => {
    const { home, profile, id } = await chromeHome()
    const { b, sent } = await setupBrowser({ deps: { importEnv: { home, platform: 'darwin', env: {} } } })
    expect(await b.importSources()).toEqual([{ id, browser: 'chrome', profile: 'Default', kinds: ['bookmarks', 'history', 'settings'] }])
    const result = await b.importFrom({ sourceId: id, kinds: ['settings', 'bookmarks', 'history'] })
    expect(result).toEqual({ sourceId: id, bookmarks: 2, history: 1, searchEngine: 'duckduckgo', errors: [] })
    expect(sent('browser:import')).toEqual([
      { sourceId: id, kind: 'bookmarks' },
      { sourceId: id, kind: 'history' },
      { sourceId: id, kind: 'settings' }
    ])
    expect(b.settings().searchEngine).toBe('duckduckgo')
    const [bar, other] = b.bookmarkTree()
    expect(bar.children.map((n) => n.title)).toEqual(['A'])
    expect(other.children.map((n) => n.title)).toEqual(['Imported from Google Chrome'])
    expect(b.historyList({}).map((e) => e.url)).toEqual(['https://h.dev/'])

    // a kind that fails is reported, the others still come; an engine Mindeck lacks changes nothing
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await writeFile(join(profile, 'Bookmarks'), 'broken')
    await writeFile(join(profile, 'Preferences'), JSON.stringify({ default_search_provider_data: { template_url_data: { url: 'https://yandex.ru/?q={searchTerms}' } } }))
    const again = await b.importFrom({ sourceId: id, kinds: ['bookmarks', 'settings', 'history'] })
    expect(again).toMatchObject({ bookmarks: 0, history: 1, errors: [{ kind: 'bookmarks', message: expect.any(String) }] })
    expect(again.searchEngine).toBeUndefined()
    expect(err).toHaveBeenCalledWith('[browser] importing bookmarks failed', expect.anything())
    // a thrown non-error is reported too
    const importer = (b as unknown as { importer: { history: () => Promise<never> } }).importer
    vi.spyOn(importer, 'history').mockRejectedValueOnce('locked')
    expect((await b.importFrom({ sourceId: id, kinds: ['history'] })).errors).toEqual([{ kind: 'history', message: 'locked' }])
    await expect(b.importFrom({ sourceId: 'chrome:/gone', kinds: ['history'] })).rejects.toMatchObject({ code: 'not-found' })
  })

  it('has nothing to import on a core that cannot see the user’s files', async () => {
    const { b, host } = await setupBrowser()
    expect(await b.importSources()).toEqual([])
    await expect(b.importFrom({ sourceId: 'x', kinds: ['history'] })).rejects.toMatchObject({ code: 'desktop-only' })
    b.attach(host)
    b.tool(b.state().tabs[0].id, 'pageMenu')
    expect(menuEntry(lastMenu(host), 'Import Bookmarks and History…').enabled).toBe(false)
  })
})

describe('BrowserService · the session across restarts', () => {
  it('keeps each tab’s back/forward list, closed tabs and downloads — and says how it ended', async () => {
    const { b, host, dir, events } = await setupBrowser()
    b.attach(host)
    const a = b.open({ url: 'https://a.dev/' })
    const unloaded = b.open({ url: 'https://u.dev/', background: true })
    host.create.mockClear()
    host.navigation.mockImplementation((id: string) => (id === a.id ? nav(['https://a.dev/', 'https://a.dev/2']) : undefined))
    const closing = b.open({ url: 'https://c.dev/' })
    host.navigation.mockImplementation((id: string) => (id === closing.id ? nav(['https://c.dev/', 'https://c.dev/2'], 0) : id === a.id ? nav(['https://a.dev/', 'https://a.dev/2']) : undefined))
    b.close(closing.id)
    const d: BrowserDownload = { id: 'd1', filename: 'f.zip', path: '/d/f.zip', url: 'https://a.dev/f.zip', state: 'progressing', received: 1, total: 9, startedAt: 'now' }
    events.download(d, { cancel: vi.fn() })
    events.downloadUpdated({ ...d, received: 5 }) // progress alone is not saved at once
    events.downloadUpdated({ ...d, id: 'd0', state: 'completed' })
    await tick(450)
    let saved = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'))
    expect(saved.exit).toBe('running')
    expect(saved.tabs.find((t: { id: string }) => t.id === a.id).nav).toEqual(nav(['https://a.dev/', 'https://a.dev/2']))
    expect(saved.tabs.find((t: { id: string }) => t.id === unloaded.id).nav).toBeUndefined()
    expect(saved.closed).toEqual([{ url: 'https://c.dev/', title: '', index: 3, pinned: false, nav: nav(['https://c.dev/', 'https://c.dev/2'], 0) }])
    expect(saved.downloads).toEqual([{ ...d, received: 5 }])
    await b.dispose()
    saved = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'))
    expect(saved.exit).toBe('clean')

    // the next start: a new tab; the pages wait in the closed tabs with their lists, a running download is interrupted now
    const next = await setupBrowser({ dir })
    expect(next.state().restorable).toBeUndefined()
    expect(next.state().downloads).toEqual([{ ...d, state: 'interrupted', received: 5 }])
    expect(next.state().tabs).toEqual([expect.objectContaining({ url: '' })])
    expect(next.state().closed).toBe(3) // u and a — then c, closed before the quit
    next.b.attach(next.host)
    next.b.setView({ x: 0, y: 0, width: 10, height: 10 })
    expect(next.b.reopen()).toMatchObject({ url: 'https://u.dev/' })
    const back = next.b.reopen()!
    expect(next.host.create).toHaveBeenLastCalledWith(back.id, 'https://a.dev/', { agent: false, zoom: 1, muted: false, history: nav(['https://a.dev/', 'https://a.dev/2']) })
    const reopened = next.b.reopen()!
    expect(next.host.create).toHaveBeenLastCalledWith(reopened.id, 'https://c.dev/', expect.objectContaining({ history: nav(['https://c.dev/', 'https://c.dev/2'], 0) }))
  })

  it('the window closes before the quit: each tab keeps its back/forward list for the session', async () => {
    const { b, host, dir } = await setupBrowser()
    b.attach(host)
    const a = b.open({ url: 'https://a.dev/' })
    const unloaded = b.open({ url: 'https://u.dev/', background: true })
    host.navigation.mockImplementation((id: string) => (id === a.id ? nav(['https://a.dev/', 'https://a.dev/2']) : undefined))
    b.detach() // the views go with the window
    host.navigation.mockReturnValue(undefined)
    await b.dispose()
    const saved = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'))
    expect(saved.exit).toBe('clean')
    expect(saved.tabs.find((t: { id: string }) => t.id === a.id).nav).toEqual(nav(['https://a.dev/', 'https://a.dev/2']))
    expect(saved.tabs.find((t: { id: string }) => t.id === unloaded.id).nav).toBeUndefined()
  })

  it('after a crash: starts with a new tab and offers the last session — restored or let go', async () => {
    const session = {
      exit: 'running',
      activeId: 'b',
      tabs: [
        { id: 'a', url: 'https://a.dev/', title: 'A', nav: nav(['https://a.dev/0', 'https://a.dev/']) },
        { id: 'b', url: 'https://b.dev/', title: 'B', pinned: true }
      ],
      closed: [{ url: 'https://x.dev/', index: 0 }, { url: '', index: 1 }, { url: 'https://y.dev/' }, null],
      downloads: [{ id: 'k', filename: 'k', path: '/k', state: 'completed' }, { id: 'bad', path: '/x', filename: 'x', state: 'weird' }, null, { id: 1 }]
    }
    const { b, dir, host, published } = await setupBrowser({ session })
    expect(b.state().tabs).toEqual([expect.objectContaining({ url: '' })])
    expect(b.state().restorable).toBe(2)
    expect(b.state().closed).toBe(1)
    expect(b.state().downloads).toEqual([{ id: 'k', filename: 'k', path: '/k', url: '', state: 'completed', received: 0, total: 0, startedAt: '' }])
    // saving while they wait keeps them
    b.open({ url: 'https://new.dev/' })
    await tick(450)
    const saved = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'))
    expect(saved.tabs.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining(['a', 'b']))
    expect(saved.tabs).toHaveLength(4)

    b.attach(host)
    b.restoreSession(true)
    expect(b.state().restorable).toBeUndefined()
    expect(b.state().tabs.map((t) => t.url)).toEqual(['https://b.dev/', '', 'https://new.dev/', 'https://a.dev/'])
    expect(b.state().activeId).toBe('b')
    b.restoreSession(true) // nothing left to restore
    await tick()
    expect((published.filter((p) => p.channel === 'browser:state').at(-1)!.payload as { restorable?: number }).restorable).toBeUndefined()

    // let go: they are gone for good
    const other = await setupBrowser({ session })
    other.b.restoreSession(false)
    expect(other.state().restorable).toBeUndefined()
    expect(other.state().tabs).toHaveLength(1)
    // restored onto a lone new tab: it makes way; no active tab saved → the first one
    const lone = await setupBrowser({ session: { ...session, activeId: undefined } })
    lone.b.restoreSession(true)
    expect(lone.state().tabs.map((t) => t.id)).toEqual(['b', 'a'])
    expect(lone.state().activeId).toBe('b')
    // a crash with only new-tab pages: nothing to offer
    const empty = await setupBrowser({ session: { exit: 'running', tabs: [{ id: 'n', url: '' }] } })
    expect(empty.state().restorable).toBeUndefined()
  })

  it('takes only sane back/forward lists — web pages, the current one among them, at most 50', () => {
    expect(cleanNav(undefined)).toBeUndefined()
    expect(cleanNav({ entries: 'x', index: 0 })).toBeUndefined()
    expect(cleanNav({ entries: [{ url: 'https://a.dev/' }], index: 'x' })).toBeUndefined()
    expect(cleanNav({ entries: [{ url: 'https://a.dev/' }], index: 3 })).toBeUndefined()
    expect(cleanNav({ entries: [{ url: 'https://a.dev/' }], index: 0 })).toBeUndefined() // one page is no list
    expect(cleanNav({ entries: [{ url: 'https://a.dev/' }, { url: 'about:blank' }], index: 1 })).toBeUndefined()
    expect(cleanNav({ entries: [{ url: 'about:blank' }, { url: 'https://a.dev/', title: 5 }, null, { url: 'https://b.dev/', title: 'B' }], index: 3 })).toEqual({
      entries: [
        { url: 'https://a.dev/', title: '' },
        { url: 'https://b.dev/', title: 'B' }
      ],
      index: 1
    })
    const long = nav(Array.from({ length: 120 }, (_, i) => `https://p${i}.dev/`), 100)
    const kept = cleanNav(long)!
    expect(kept.entries).toHaveLength(50)
    expect(kept.entries[kept.index].url).toBe('https://p100.dev/')
    expect(cleanNav(nav(Array.from({ length: 120 }, (_, i) => `https://p${i}.dev/`), 119))!.index).toBe(49)
    expect(cleanNav(nav(Array.from({ length: 120 }, (_, i) => `https://p${i}.dev/`), 0))!.index).toBe(0)
  })
})

describe('BrowserService · keys and menu for the library', () => {
  it('⌘D, ⌘⇧A, ⌘⇧B, ⌘Y and the bookmark manager — from a key or the page menu', async () => {
    const { b, host, events, sent } = await setupBrowser({ deps: { importEnv: { home: await tempDir(), platform: 'linux', env: {} } } })
    b.attach(host)
    b.open({ url: 'https://a.dev/' })
    events.shortcut('bookmark')
    events.shortcut('tabSearch')
    expect(host.focusUi).toHaveBeenCalledTimes(2)
    events.shortcut('bookmarksBar') // the UI shows or hides the bar (and remembers it)
    expect(host.focusUi).toHaveBeenCalledTimes(2)
    events.shortcut('palette') // Mindeck's command palette takes the keyboard from the page
    expect(host.focusUi).toHaveBeenCalledTimes(3)
    await b.configure({ bookmarksBar: false })
    events.shortcut('history')
    expect(b.state().tabs.find((t) => t.id === b.state().activeId)!.url).toBe('mindeck://history')
    events.shortcut('bookmarkManager')
    expect(b.state().tabs.find((t) => t.id === b.state().activeId)!.url).toBe('mindeck://bookmarks')

    const page = b.open({ url: 'https://p.dev/' })
    b.tool(page.id, 'pageMenu')
    const m = lastMenu(host)
    expect(menuEntry(m, 'Show Bookmarks Bar').checked).toBe(false)
    for (const label of ['Search Tabs…', 'Bookmark This Page…', 'Show Bookmarks Bar', 'Import Bookmarks and History…', 'History', 'Bookmark Manager']) menuEntry(m, label).run()
    await tick()
    expect((sent('browser:command') as { command: string }[]).map((c) => c.command)).toEqual(['bookmark', 'tabSearch', 'bookmarksBar', 'palette', 'tabSearch', 'bookmark', 'bookmarksBar', 'import'])
    // on an internal page there is nothing to bookmark
    b.tool(b.state().activeId!, 'pageMenu')
    expect(menuEntry(lastMenu(host), 'Bookmark This Page…').enabled).toBe(false)
  })
})
