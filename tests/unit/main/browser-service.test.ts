import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { onCleanup, tempDir, tick } from './helpers'
import { BrowserService, zoomStep, type BrowserDeps } from '../../../electron/main/services/browser/BrowserService'
import type { AutomationTarget, BrowserHost, MenuEntry, TabNavigation } from '../../../electron/main/services/browser/types'
import type { AppSettings } from '@shared/types/settings'
import type { BrowserDownload, BrowserState } from '@shared/types/browser'

/** The web views, as the core sees them: every call recorded. */
function fakeHost() {
  const automation = { cdp: vi.fn(async () => ({})), capture: vi.fn(async () => ({ png: 'png', width: 1, height: 1 })) }
  const host = {
    create: vi.fn(),
    destroy: vi.fn(),
    navigation: vi.fn((_id: string): TabNavigation | undefined => undefined),
    load: vi.fn(),
    go: vi.fn(),
    show: vi.fn(),
    setBounds: vi.fn(),
    freeze: vi.fn(async (): Promise<Record<string, string> | null> => ({ t: 'data:image/jpeg;base64,x' })),
    unfreeze: vi.fn(),
    find: vi.fn(),
    stopFind: vi.fn(),
    setZoom: vi.fn(),
    setMuted: vi.fn(),
    devtools: vi.fn(),
    print: vi.fn(),
    popup: vi.fn(),
    focusUi: vi.fn(),
    setTheme: vi.fn(),
    automation: vi.fn(() => automation as unknown as AutomationTarget),
    dispose: vi.fn(),
    clearPrivate: vi.fn(),
    loadExtension: vi.fn(async (path: string) => ({ id: `id:${path}` })),
    unloadExtension: vi.fn(),
    openPopup: vi.fn()
  } satisfies BrowserHost
  return Object.assign(host, { target: automation })
}

function settingsStore(initial: AppSettings = {}) {
  let current = initial
  return {
    get: () => current,
    update: vi.fn(async (patch: Partial<AppSettings>) => (current = { ...current, ...patch }))
  }
}

async function setup(opts: { session?: unknown; sites?: unknown; deps?: Partial<BrowserDeps>; dir?: string } = {}) {
  const dir = opts.dir ?? (await tempDir())
  if (opts.session !== undefined) await writeFile(join(dir, 'session.json'), JSON.stringify(opts.session))
  if (opts.sites !== undefined) await writeFile(join(dir, 'sites.json'), JSON.stringify(opts.sites))
  const published: { channel: string; payload: unknown }[] = []
  const deps: BrowserDeps = {
    dir,
    settings: settingsStore(),
    publish: (channel, payload) => published.push({ channel, payload }),
    publishDelayMs: 0,
    openExternal: vi.fn(async () => {}),
    appForUrl: vi.fn(() => 'Arc'),
    openPath: vi.fn(async () => {}),
    revealPath: vi.fn(),
    ...opts.deps
  }
  const b = new BrowserService(deps)
  await b.init()
  const host = fakeHost()
  onCleanup(() => b.dispose())
  const states = () => published.filter((p) => p.channel === 'browser:state').map((p) => p.payload as BrowserState)
  const ids = () => b.state().tabs.map((t) => t.id)
  return { b, dir, deps, host, published, states, ids, events: b.hostEvents() }
}

const menu = (host: ReturnType<typeof fakeHost>) => host.popup.mock.calls[host.popup.mock.calls.length - 1][0] as MenuEntry[]
const entry = (entries: MenuEntry[], label: string) => entries.find((e) => 'label' in e && e.label === label) as Exclude<MenuEntry, { separator: true }>

describe('BrowserService · tabs and the session', () => {
  it('starts with a new-tab page: the last session waits in the closed tabs — after a crash, to be restored (pinned first, junk skipped)', async () => {
    const fresh = await setup()
    expect(fresh.b.state()).toMatchObject({ available: false, closed: 0, downloads: [], permissions: [], devServers: [] })
    expect(fresh.b.state().tabs).toEqual([expect.objectContaining({ url: '', title: '', shared: false, loading: false })])

    const session = {
      activeId: 'b',
      tabs: [
        { id: 'a', url: 'https://a.dev/', title: 'A', favicon: 'data:image/png;base64,x', share: { on: true, origin: 'https://a.dev' } },
        { id: 'p', url: 'https://p.dev/', title: 5, pinned: true, muted: true, openedBy: 'Claude Code' },
        { id: 3 },
        { url: 'https://x.dev/' },
        null,
        { id: 'b', url: 'https://b.dev/', share: { on: 'yes' } }
      ]
    }
    const sites = { sites: { 'https://a.dev': { zoom: 1.25 } } }

    // Quit cleanly: a new tab, nothing of before open — ⌘⇧T brings the pages back, the last one first.
    const clean = await setup({ session: { ...session, exit: 'clean' }, sites })
    expect(clean.b.state().tabs).toEqual([expect.objectContaining({ url: '' })])
    expect(clean.b.state()).toMatchObject({ closed: 3, activeId: clean.b.state().tabs[0].id })
    expect(clean.b.state()).not.toHaveProperty('restorable')
    expect(clean.b.reopen()).toMatchObject({ url: 'https://b.dev/', pinned: false })
    expect(clean.b.reopen()).toMatchObject({ url: 'https://a.dev/', title: 'A', zoom: 1.25 })
    expect(clean.b.reopen()).toMatchObject({ url: 'https://p.dev/', title: '', pinned: true })
    expect(clean.b.reopen()).toBeNull()

    // A crash: the same pages wait to be restored, and come back as they were.
    const crashed = await setup({ session: { ...session, exit: 'running' }, sites })
    expect(crashed.b.state().tabs).toHaveLength(1)
    expect(crashed.b.state().restorable).toBe(3)
    crashed.b.restoreSession(true)
    const tabs = crashed.b.state().tabs
    expect(tabs.map((t) => t.id)).toEqual(['p', 'a', 'b'])
    expect(tabs[0]).toMatchObject({ title: '', pinned: true, muted: true, openedBy: 'Claude Code', shared: true })
    expect(tabs[1]).toMatchObject({ title: 'A', favicon: 'data:image/png;base64,x', zoom: 1.25, shared: true })
    expect(tabs[2]).toMatchObject({ shared: false })
    expect(crashed.b.state().activeId).toBe('b')

    const odd = await setup({ session: { tabs: 'nope', activeId: 'gone' }, sites: { sites: 5 } })
    expect(odd.b.state().tabs).toHaveLength(1)
    expect(odd.b.state().activeId).toBe(odd.b.state().tabs[0].id)
  })

  it('creates views once the browser is on screen, and the window closing frees everything', async () => {
    const { b, host, events, states } = await setup({ session: { exit: 'running', activeId: 'b', tabs: [{ id: 'b', url: 'https://b.dev/' }] } })
    b.restoreSession(true) // after a crash, brought back
    b.attach(host)
    expect(host.setTheme).toHaveBeenCalledWith('system')
    await tick()
    expect(states().at(-1)!.available).toBe(true)
    expect(host.create).not.toHaveBeenCalled() // restored tabs load when first shown

    b.setView({ x: 1, y: 2, width: 300, height: 200 })
    expect(host.setBounds).toHaveBeenCalledWith({ x: 1, y: 2, width: 300, height: 200 }, true)
    expect(host.create).toHaveBeenCalledWith('b', 'https://b.dev/', { agent: false, zoom: 1, muted: false })
    expect(host.show).toHaveBeenLastCalledWith('b')
    b.setView({ x: 1, y: 2, width: 300, height: 200 }) // already loaded: no second view
    expect(host.create).toHaveBeenCalledTimes(1)
    b.setView(null)
    expect(host.setBounds).toHaveBeenLastCalledWith(null, true)
    b.setView({ x: 1, y: 2, width: 300, height: 200 }, false) // its pane lost the focus: the UI keeps its keys
    expect(host.setBounds).toHaveBeenLastCalledWith({ x: 1, y: 2, width: 300, height: 200 }, false)

    // a request and a waiting agent die with the window
    const answer = vi.fn()
    events.permission({ tabId: 'b', origin: 'https://b.dev', kind: 'camera' }, answer)
    const waiting = b.waitForLoad('b')
    b.detach()
    await waiting
    expect(answer).toHaveBeenCalledWith(false)
    expect(b.state()).toMatchObject({ available: false, permissions: [] })
    await expect(b.freeze()).resolves.toBeNull()
    b.unfreeze() // nothing to unfreeze without a window
    b.setView({ x: 0, y: 0, width: 1, height: 1 }) // no host: nothing to show
  })

  it('opens, closes, reopens and orders tabs like Chrome', async () => {
    const { b, host, deps, ids } = await setup()
    b.attach(host)
    const ntp = b.state().tabs[0].id
    const ex = b.open({ url: 'example.com' })
    expect(ex).toMatchObject({ url: 'https://example.com/', loading: true, shared: false })
    expect(host.create).toHaveBeenLastCalledWith(ex.id, 'https://example.com/', { agent: false, zoom: 1, muted: false })
    expect(b.state().activeId).toBe(ex.id)

    const dev = b.open({ url: 'localhost:3000', background: true })
    expect(dev).toMatchObject({ url: 'http://localhost:3000/', shared: true })
    expect(b.state().activeId).toBe(ex.id)
    expect(b.open().url).toBe('')
    expect(b.open({ url: 'javascript:alert(1)' }).url).toBe('') // never runs as an address

    // a link for another app opens there, not in a tab — once the user said yes (a bookmark, the history, typed)
    const before = ids().length
    expect(b.open({ url: 'mailto:robin@example.com' }).id).toBe(b.state().activeId)
    expect(deps.openExternal).not.toHaveBeenCalled()
    expect(b.state().permissions).toEqual([{ id: expect.any(String), origin: 'mailto:', kind: 'external', target: 'mailto:robin@example.com', app: 'Arc' }])
    b.permission(b.state().permissions[0].id, true)
    expect(deps.openExternal).toHaveBeenCalledWith('mailto:robin@example.com')
    expect(ids()).toHaveLength(before)

    // links open right after the tab they came from
    const child = b.open({ url: 'https://a.dev/', opener: ntp, background: true })
    expect(ids().indexOf(child.id)).toBe(ids().indexOf(ntp) + 1)

    // pinned tabs stay first, reordering stays within its group
    b.update(dev.id, { pinned: true })
    expect(ids()[0]).toBe(dev.id)
    b.update(dev.id, { pinned: true }) // no change
    b.move(dev.id, 4)
    expect(ids()[0]).toBe(dev.id)
    b.move(ex.id, 0)
    expect(ids()[1]).toBe(ex.id)
    const duplicate = b.duplicate(ex.id)
    expect(duplicate.url).toBe('https://example.com/')
    expect(ids().indexOf(duplicate.id)).toBe(ids().indexOf(ex.id) + 1)
    // unpinned, it comes right after the pinned tabs (none left: first)
    b.update(dev.id, { pinned: false })
    expect(ids()[0]).toBe(dev.id)

    // closing the active tab shows its right neighbour; ⌘⇧T brings it back at its place
    b.activate(ex.id)
    const at = ids().indexOf(ex.id)
    b.close(ex.id)
    expect(host.destroy).toHaveBeenCalledWith(ex.id)
    expect(b.state().activeId).toBe(ids()[at])
    expect(b.state().closed).toBe(1)
    const back = b.reopen()!
    expect(back).toMatchObject({ url: 'https://example.com/' })
    expect(ids().indexOf(back.id)).toBe(at)
    expect(b.state().activeId).toBe(back.id)
    expect(b.reopen()).toBeNull()

    // a pinned tab comes back pinned; an unloaded tab closes without a view; the last tab leaves a new-tab page
    b.update(back.id, { pinned: true })
    b.close(back.id)
    expect(b.reopen()!.pinned).toBe(true)
    for (const id of ids()) b.close(id)
    expect(b.state().tabs).toEqual([expect.objectContaining({ url: '' })])
    expect(() => b.close('nope')).toThrow('Tab not found')
  })

  it('keeps at most 25 closed tabs and closes the last one on the left when nothing is to the right', async () => {
    const { b, ids } = await setup()
    for (let i = 0; i < 27; i += 1) b.open({ url: `https://t${i}.dev/` })
    const last = ids().at(-1)!
    b.activate(last)
    b.close(last)
    expect(b.state().activeId).toBe(ids().at(-1))
    for (const id of ids().slice(1)) b.close(id)
    expect(b.state().closed).toBe(25)
  })

  it('navigates what was typed, takes agent tabs over, and goes back, forward, reload and stop', async () => {
    const { b, host, deps, events } = await setup()
    const ntp = b.state().tabs[0].id
    b.navigate(ntp, 'example.com') // no window yet: the address is kept, nothing loads
    expect(b.state().tabs[0]).toMatchObject({ url: 'https://example.com/', loading: false })
    b.attach(host)
    b.navigate(ntp, 'example.org')
    expect(host.create).toHaveBeenCalledWith(ntp, 'https://example.org/', expect.any(Object))
    b.navigate(ntp, 'example.net')
    expect(host.load).toHaveBeenCalledWith(ntp, 'https://example.net/')
    b.navigate(ntp, '  ')
    b.navigate(ntp, 'javascript:alert(1)')
    expect(host.load).toHaveBeenCalledTimes(1)
    // another app's link: asked in this tab; no → nothing; yes, remembered → the next one opens without asking
    vi.mocked(deps.openExternal!).mockClear()
    b.navigate(ntp, 'zoommtg://zoom.us/join')
    expect(b.state().permissions).toEqual([{ id: expect.any(String), tabId: ntp, origin: 'zoommtg:', kind: 'external', target: 'zoommtg://zoom.us/join', app: 'Arc' }])
    b.permission(b.state().permissions[0].id, false)
    expect(deps.openExternal).not.toHaveBeenCalled()
    b.navigate(ntp, 'zoommtg://zoom.us/join')
    vi.mocked(deps.openExternal!).mockRejectedValueOnce(new Error('the app did not start')) // nothing to report
    b.permission(b.state().permissions[0].id, true, true)
    expect(deps.openExternal).toHaveBeenCalledWith('zoommtg://zoom.us/join')
    b.navigate(ntp, 'ZOOMMTG://zoom.us/join?confno=2')
    expect(b.state().permissions).toEqual([])
    expect(deps.openExternal).toHaveBeenLastCalledWith('ZOOMMTG://zoom.us/join?confno=2')
    // Shares and Windows' risky handlers (e.g. from imported bookmarks) never reach the OS; nor a link no app takes.
    vi.mocked(deps.openExternal!).mockClear()
    for (const link of ['ms-msdt:/id%20PCWDiagnostic', 'search-ms:query=x&crumb=location:\\\\evil\\share', 'smb://evil/share/x.exe', 'MS-OFFICECMD:{}', 'search:query=x']) {
      b.navigate(ntp, link)
      b.open({ url: link })
    }
    vi.mocked(deps.appForUrl!).mockReturnValueOnce('')
    b.navigate(ntp, 'unknown-app:x')
    expect(b.state().permissions).toEqual([])
    expect(deps.openExternal).not.toHaveBeenCalled()

    // an agent's tab: typing an address takes it over
    const agentTab = await (async () => {
      const opening = b.agentOpen('https://agent.dev/', 'Claude Code')
      events.loading(b.state().tabs.at(-1)!.id, false)
      return opening
    })()
    b.update(agentTab.id, { shared: false })
    b.navigate(agentTab.id, 'mine.dev')
    expect(b.state().tabs.find((t) => t.id === agentTab.id)).toMatchObject({ openedBy: undefined, agent: undefined, shared: false })

    // back and forward only load when there is somewhere to go
    const t = (id: string) => b.state().tabs.find((x) => x.id === id)!
    events.loading(ntp, false)
    b.go(ntp, 'back')
    expect(t(ntp).loading).toBe(false)
    events.navigated(ntp, { url: 'https://example.net/', canGoBack: true, canGoForward: true })
    b.go(ntp, 'back')
    expect(t(ntp).loading).toBe(true)
    b.go(ntp, 'stop')
    expect(t(ntp).loading).toBe(false)
    b.go(ntp, 'forward')
    expect(t(ntp).loading).toBe(true)
    events.loading(ntp, false)
    b.go(ntp, 'hardReload')
    expect(host.go).toHaveBeenCalledWith(ntp, 'hardReload')
    events.navigated(ntp, { url: 'https://example.net/', canGoBack: false, canGoForward: false })
    b.go(ntp, 'forward')
    expect(host.go).toHaveBeenLastCalledWith(ntp, 'forward')

    // a failed page reloads its own address, its error page staying until the new page is there
    events.failed(ntp, { code: -102, description: 'ERR_CONNECTION_REFUSED', url: 'http://localhost:9/' })
    expect(host.show).toHaveBeenLastCalledWith(undefined)
    b.go(ntp, 'reload')
    expect(host.load).toHaveBeenLastCalledWith(ntp, 'http://localhost:9/')
    expect(t(ntp)).toMatchObject({ loading: true, error: expect.objectContaining({ code: -102 }) })

    // a tab without a page has nothing to go to; an unloaded one loads on reload only
    const empty = b.open()
    b.go(empty.id, 'reload')
    expect(host.go).not.toHaveBeenCalledWith(empty.id, expect.anything())
    const later = b.open({ url: 'https://later.dev/', background: true })
    b.detach()
    b.attach(host)
    host.create.mockClear()
    b.go(later.id, 'back')
    expect(host.create).not.toHaveBeenCalled()
    b.go(later.id, 'reload')
    expect(host.create).toHaveBeenCalledWith(later.id, 'https://later.dev/', expect.any(Object))
  })

  it('follows the page: navigation, titles, favicons, loading, failures, crashes and sound', async () => {
    const { b, host, events } = await setup({ sites: { sites: { 'https://zoomed.dev': { zoom: 1.5 } } } })
    b.attach(host)
    const tab = b.open({ url: 'https://a.dev/' })
    const t = () => b.state().tabs.find((x) => x.id === tab.id)!
    events.title(tab.id, 'A')
    events.favicon(tab.id, 'data:image/png;base64,a')
    events.navigated(tab.id, { url: 'https://a.dev/next', canGoBack: true, canGoForward: false })
    expect(t()).toMatchObject({ title: '', favicon: 'data:image/png;base64,a', canGoBack: true }) // same site keeps its icon
    events.title(tab.id, 'Next')
    events.navigated(tab.id, { url: 'https://a.dev/next#part', canGoBack: true, canGoForward: false, inPage: true })
    expect(t().title).toBe('Next') // a jump within the page keeps the title
    events.navigated(tab.id, { url: 'https://zoomed.dev/', canGoBack: true, canGoForward: false })
    expect(t()).toMatchObject({ favicon: undefined, zoom: 1.5 })
    expect(host.setZoom).toHaveBeenCalledWith(tab.id, 1.5)
    expect(b.historyEntries('next').map((h) => h.title)).toEqual(['Next', 'Next'])

    events.loading(tab.id, true)
    const waiting = b.waitForLoad(tab.id)
    events.loading(tab.id, false)
    await waiting
    events.failed(tab.id, { code: -105, description: 'NAME_NOT_RESOLVED', url: 'https://nope.dev/' })
    expect(t()).toMatchObject({ loading: false, error: { code: -105, description: 'NAME_NOT_RESOLVED', url: 'https://nope.dev/' } })
    events.navigated(tab.id, { url: 'https://ok.dev/', canGoBack: true, canGoForward: false })
    expect(t().error).toBeUndefined()
    events.crashed(tab.id)
    expect(t().crashed).toBe(true)
    expect(host.show).toHaveBeenLastCalledWith(undefined)
    events.audible(tab.id, true)
    expect(t().audible).toBe(true)
    b.update(tab.id, { muted: true })
    expect(host.setMuted).toHaveBeenCalledWith(tab.id, true)
    // a tab without a page (the new-tab page) keeps the setting for when it has one
    host.setMuted.mockClear()
    const asleep = b.open({ background: true })
    b.update(asleep.id, { muted: true })
    expect(host.setMuted).not.toHaveBeenCalled()
    expect(b.state().tabs.find((x) => x.id === asleep.id)!.muted).toBe(true)

    // events of tabs that are gone change nothing
    for (const call of [
      () => events.navigated('gone', { url: 'https://x.dev/', canGoBack: false, canGoForward: false }),
      () => events.title('gone', 'x'),
      () => events.loading('gone', false),
      () => events.failed('gone', { code: -2, description: 'x', url: 'x' }),
      () => events.zoomed('gone', 'in'),
      () => events.command('gone', 'sendToAgent')
    ])
      expect(call).not.toThrow()
  })

  it('zooms in steps, remembered per site', async () => {
    const { b, host, events, dir } = await setup()
    b.attach(host)
    const tab = b.open({ url: 'https://a.dev/' })
    expect(b.zoom(tab.id, 'in')).toBe(1.1)
    expect(host.setZoom).toHaveBeenCalledWith(tab.id, 1.1)
    events.zoomed(tab.id, 'in')
    expect(b.state().tabs.find((t) => t.id === tab.id)!.zoom).toBe(1.25)
    await b.dispose()
    expect(JSON.parse(await readFile(join(dir, 'sites.json'), 'utf8')).sites['https://a.dev']).toEqual({ zoom: 1.25 })
    expect(b.zoom(tab.id, 'reset')).toBe(1)
    await b.dispose()
    expect(JSON.parse(await readFile(join(dir, 'sites.json'), 'utf8')).sites['https://a.dev']).toEqual({})
    // the new-tab page has no site to remember a zoom for
    const ntp = b.open()
    expect(b.zoom(ntp.id, 'out')).toBe(0.9)
    expect(zoomStep(5, 'in')).toBe(5)
    expect(zoomStep(0.25, 'out')).toBe(0.25)
    expect(zoomStep(1.3, 'out')).toBe(1.25)
  })
})

describe('BrowserService · tools, menus and suggestions', () => {
  it('finds in the page and opens DevTools, print and the system browser for real pages only', async () => {
    const { b, host, deps } = await setup()
    b.attach(host)
    const tab = b.open({ url: 'https://a.dev/' })
    b.find(tab.id, 'needle')
    expect(host.find).toHaveBeenCalledWith(tab.id, 'needle', { forward: true, next: false })
    b.find(tab.id, 'needle', false, true)
    expect(host.find).toHaveBeenLastCalledWith(tab.id, 'needle', { forward: false, next: true })
    b.find(tab.id, '')
    expect(host.stopFind).toHaveBeenCalledWith(tab.id)
    b.tool(tab.id, 'devtools')
    b.tool(tab.id, 'print')
    b.tool(tab.id, 'handoff')
    expect(host.devtools).toHaveBeenCalledWith(tab.id)
    expect(host.print).toHaveBeenCalledWith(tab.id)
    expect(deps.openExternal).toHaveBeenCalledWith('https://a.dev/')
    const ntp = b.open()
    b.tool(ntp.id, 'handoff')
    b.tool(ntp.id, 'devtools')
    expect(deps.openExternal).toHaveBeenCalledTimes(1)
    expect(host.devtools).toHaveBeenCalledTimes(1)
  })

  it('draws the tab menu and the page menu in the UI language, each entry doing what it says', async () => {
    const { b, host, published } = await setup({ deps: { appForUrl: undefined } })
    b.attach(host)
    b.setUi({ theme: 'dark', locale: 'de' })
    expect(host.setTheme).toHaveBeenLastCalledWith('dark')
    const tab = b.open({ url: 'https://a.dev/' })
    const other = b.open({ url: 'https://b.dev/', background: true })
    b.tool(tab.id, 'tabMenu')
    let m = menu(host)
    expect(m.map((e) => ('label' in e ? e.label : '—'))).toEqual([
      'Neu laden',
      'Duplizieren',
      'Tab anheften',
      'Ton aus',
      'Für Agents freigeben',
      'Im System-Browser öffnen',
      '—',
      'Zu neuer Gruppe hinzufügen',
      '—',
      'Mit neuem Tab teilen',
      '—',
      'Vertikale Tabs',
      '—',
      'Tab schließen',
      'Andere Tabs schließen'
    ])
    entry(m, 'Neu laden').run()
    expect(host.go).toHaveBeenCalledWith(tab.id, 'reload')
    entry(m, 'Duplizieren').run()
    entry(m, 'Tab anheften').run()
    entry(m, 'Ton aus').run()
    entry(m, 'Für Agents freigeben').run()
    expect(b.state().tabs.find((t) => t.id === tab.id)).toMatchObject({ pinned: true, muted: true, shared: true })
    entry(m, 'Im System-Browser öffnen').run()
    b.tool(tab.id, 'tabMenu')
    m = menu(host)
    expect(m.map((e) => ('label' in e ? e.label : '—'))).toContain('Freigabe für Agents beenden')
    entry(m, 'Tab lösen').run()
    entry(m, 'Ton an').run()
    entry(m, 'Freigabe für Agents beenden').run()
    entry(m, 'Andere Tabs schließen').run()
    expect(b.state().tabs.map((t) => t.id)).toEqual([tab.id])
    expect(b.state().tabs.some((t) => t.id === other.id)).toBe(false)
    entry(m, 'Tab schließen').run()
    expect(b.state().tabs).toHaveLength(1)

    // the page menu (the "…" button)
    b.setUi({ theme: 'light', locale: 'en' })
    const page = b.open({ url: 'https://c.dev/' })
    b.tool(page.id, 'pageMenu')
    m = menu(host)
    expect(m.filter((e) => 'label' in e).map((e) => [(e as { label: string }).label, (e as { enabled?: boolean }).enabled ?? true])).toEqual([
      ['New Tab', true],
      ['New Private Tab', true],
      ['Reopen Closed Tab', true],
      ['Search Tabs…', true],
      ['Bookmark This Page…', true],
      ['Show Bookmarks Bar', true],
      ['Bookmark Manager', true],
      ['History', true],
      ['Import Bookmarks and History…', false],
      ['Find…', true],
      ['Zoom In', true],
      ['Zoom Out', true],
      ['Actual Size (100 %)', false],
      ['Print…', true],
      ['Developer Tools', true],
      ['Open in System Browser', true],
      ['Send to Agent…', true],
      ['Browser Settings', true]
    ])
    for (const label of ['Zoom In', 'Zoom Out', 'Find…', 'Print…', 'Developer Tools', 'Open in System Browser', 'Send to Agent…', 'Browser Settings', 'Reopen Closed Tab', 'New Tab']) entry(m, label).run()
    b.tool(page.id, 'pageMenu')
    entry(menu(host), 'Zoom In').run()
    b.tool(page.id, 'pageMenu')
    entry(menu(host), 'Actual Size (110 %)').run()
    await tick()
    const commands = published.filter((p) => p.channel === 'browser:command').map((p) => (p.payload as { command: string }).command)
    expect(commands).toEqual(['find', 'sendToAgent', 'settings', 'focusOmnibox'])
    expect(host.focusUi).toHaveBeenCalledTimes(2)
  })

  it('suggests an address or a search first, then open tabs and visited pages', async () => {
    const { b, host, events } = await setup()
    b.attach(host)
    const docs = b.open({ url: 'https://docs.example.com/' })
    events.navigated(docs.id, { url: 'https://docs.example.com/', canGoBack: false, canGoForward: false })
    events.title(docs.id, 'Example Docs')
    b.open({ url: 'https://example.com/', background: true })
    b.open() // the new-tab page has nothing to suggest
    expect(b.suggest('  ')).toEqual([])
    const typedAddress = b.suggest('example.com')
    expect(typedAddress[0]).toEqual({ kind: 'navigate', url: 'https://example.com/', title: 'https://example.com/' })
    expect(typedAddress.at(-1)).toEqual({ kind: 'search', url: 'https://www.google.com/search?q=example.com', title: 'example.com' })
    expect(typedAddress.filter((s) => s.kind === 'tab').map((s) => s.title)).toEqual(['Example Docs', 'https://example.com/'])
    const words = b.suggest('docs')
    expect(words[0].kind).toBe('search')
    // the open tab stands for the page — no second entry from the history
    expect(words.map((s) => s.kind)).toEqual(['search', 'tab'])
    expect(b.historyEntries('docs').map((h) => h.url)).toEqual(['https://docs.example.com/'])
    expect(b.historyEntries().map((h) => h.url)).toEqual(['https://docs.example.com/'])
    await b.clearHistory()
    expect(b.historyEntries()).toEqual([])
  })
})

describe('BrowserService · downloads and page requests', () => {
  const download = (id: string, state: BrowserDownload['state'] = 'progressing'): BrowserDownload => ({
    id,
    filename: `${id}.zip`,
    path: `/Downloads/${id}.zip`,
    url: `https://a.dev/${id}.zip`,
    state,
    received: 0,
    total: 100,
    startedAt: '2026-10-15T00:00:00.000Z'
  })

  it('lists downloads with their progress, opens, reveals, cancels and removes them', async () => {
    const { b, deps, events } = await setup()
    const cancel = vi.fn()
    events.download(download('d1'), { cancel })
    events.downloadUpdated({ ...download('d1'), received: 50 })
    expect(b.state().downloads[0].received).toBe(50)
    b.download('d1', 'cancel')
    expect(cancel).toHaveBeenCalled()
    events.downloadUpdated({ ...download('d1', 'completed'), received: 100 })
    b.download('d1', 'cancel') // finished: nothing to cancel
    expect(cancel).toHaveBeenCalledTimes(1)
    b.download('d1', 'open')
    b.download('d1', 'reveal')
    expect(deps.openPath).toHaveBeenCalledWith('/Downloads/d1.zip')
    expect(deps.revealPath).toHaveBeenCalledWith('/Downloads/d1.zip')
    b.download('d1', 'remove')
    expect(b.state().downloads).toEqual([])
    expect(() => b.download('d1', 'open')).toThrow('Download not found')
    for (let i = 0; i < 32; i += 1) events.download(download(`x${i}`), { cancel })
    expect(b.state().downloads).toHaveLength(30)

    const bare = await setup({ deps: { openPath: undefined, revealPath: undefined } })
    bare.events.download(download('d2', 'completed'), { cancel })
    expect(() => bare.b.download('d2', 'open')).not.toThrow()
    expect(() => bare.b.download('d2', 'reveal')).not.toThrow()
  })

  it('asks the user once, merges repeats, remembers per site — and per app for links to other apps', async () => {
    const { b, host, events, dir } = await setup()
    b.attach(host)
    const tab = b.open({ url: 'https://meet.dev/' })
    const first = vi.fn()
    const second = vi.fn()
    events.permission({ tabId: tab.id, origin: 'https://meet.dev', kind: 'media' }, first)
    events.permission({ tabId: tab.id, origin: 'https://meet.dev', kind: 'media' }, second)
    expect(b.state().permissions).toHaveLength(1)
    expect(events.permissionCheck('https://meet.dev', 'media')).toBe(false)
    b.permission(b.state().permissions[0].id, true, true)
    expect(first).toHaveBeenCalledWith(true)
    expect(second).toHaveBeenCalledWith(true)
    const again = vi.fn()
    events.permission({ tabId: tab.id, origin: 'https://meet.dev', kind: 'media' }, again)
    expect(again).toHaveBeenCalledWith(true) // remembered
    expect(events.permissionCheck('https://meet.dev', 'media')).toBe(true)

    // another app: remembered per scheme
    const mail = vi.fn()
    events.permission({ tabId: tab.id, origin: 'https://meet.dev', kind: 'external', target: 'mailto:x@y.z', app: 'Mail' }, mail)
    b.permission(b.state().permissions[0].id, false, true)
    expect(mail).toHaveBeenCalledWith(false)
    const zoom = vi.fn()
    events.permission({ tabId: tab.id, origin: 'https://meet.dev', kind: 'external', target: 'zoommtg://join', app: 'zoom.us' }, zoom)
    expect(zoom).not.toHaveBeenCalled()
    b.permission(b.state().permissions[0].id, true) // once, not remembered
    expect(zoom).toHaveBeenCalledWith(true)
    const noTarget = vi.fn()
    events.permission({ origin: 'https://meet.dev', kind: 'external' }, noTarget)
    b.permission(b.state().permissions[0].id, false, true)
    await b.dispose()
    expect(JSON.parse(await readFile(join(dir, 'sites.json'), 'utf8')).sites['https://meet.dev'].permissions).toEqual({
      media: true,
      'external:mailto': false,
      'external:': false
    })
    expect(() => b.permission('gone', true)).toThrow('no longer pending')

    // a page that navigates or closes takes its open requests along
    const nav = vi.fn()
    events.permission({ tabId: tab.id, origin: 'https://meet.dev', kind: 'notifications' }, nav)
    events.navigated(tab.id, { url: 'https://meet.dev/room', canGoBack: true, canGoForward: false })
    expect(nav).toHaveBeenCalledWith(false)
    const closing = vi.fn()
    events.permission({ tabId: tab.id, origin: 'https://meet.dev', kind: 'geolocation' }, closing)
    b.close(tab.id)
    expect(closing).toHaveBeenCalledWith(false)
  })
})

describe('BrowserService · keys, commands and links from Mindeck', () => {
  it('handles the browser keys, even while a page has the focus', async () => {
    const { b, host, events, published, ids } = await setup()
    b.attach(host)
    const a = b.open({ url: 'https://a.dev/' })
    const c = b.open({ url: 'https://c.dev/' })
    const active = () => b.state().activeId
    events.focused('x') // a click into a page: the UI moves its focus to the browser's pane
    expect(published.at(-1)).toEqual({ channel: 'browser:command', payload: { command: 'focused' } })
    const wsKey = { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }
    events.workspaceKey(wsKey) // a pane key pressed in a page: the UI's workspace acts on it
    expect(published.at(-1)).toEqual({ channel: 'browser:command', payload: { command: 'workspaceKey', key: wsKey } })
    events.shortcut('newTab')
    expect(b.state().tabs.at(-1)!.url).toBe('')
    expect(host.focusUi).toHaveBeenCalled()
    events.shortcut('closeTab')
    events.shortcut('reopenTab') // the new-tab page was never remembered: nothing comes back
    expect(b.state().tabs.at(-1)!.url).toBe('https://c.dev/')
    b.activate(a.id)
    events.shortcut('focusOmnibox')
    events.shortcut('find')
    events.shortcut('reload')
    expect(host.go).toHaveBeenCalledWith(a.id, 'reload')
    events.shortcut('zoomIn')
    events.shortcut('zoomOut')
    events.shortcut('zoomIn')
    events.shortcut('zoomReset')
    expect(b.state().tabs.find((t) => t.id === a.id)!.zoom).toBe(1)
    events.shortcut('nextTab')
    expect(active()).toBe(ids()[ids().indexOf(a.id) + 1])
    events.shortcut('lastTab')
    expect(active()).toBe(ids().at(-1))
    events.shortcut('nextTab') // wraps around
    expect(active()).toBe(ids()[0])
    events.shortcut('prevTab')
    expect(active()).toBe(ids().at(-1))
    events.shortcut('tab2')
    expect(active()).toBe(ids()[1])
    events.shortcut('tab8') // no eighth tab: nothing
    expect(active()).toBe(ids()[1])
    b.activate(c.id)
    events.shortcut('devtools')
    events.shortcut('print')
    expect(host.devtools).toHaveBeenCalledWith(c.id)
    events.shortcut('back')
    events.shortcut('forward')
    events.shortcut('hardReload')
    await tick()
    const commands = published.filter((p) => p.channel === 'browser:command').map((p) => (p.payload as { command: string }).command)
    expect(commands).toEqual(['focused', 'workspaceKey', 'focusOmnibox', 'focusOmnibox', 'find'])
  })

  it('answers the page: search for a selection, send to an agent, find results, console', async () => {
    const { b, host, events, published } = await setup()
    b.attach(host)
    const tab = b.open({ url: 'https://a.dev/' })
    events.command(tab.id, 'search', 'mindeck browser')
    expect(b.state().tabs.at(-1)!.url).toBe('https://www.google.com/search?q=mindeck%20browser')
    const count = b.state().tabs.length
    events.command(tab.id, 'search')
    expect(b.state().tabs).toHaveLength(count)
    events.command(tab.id, 'sendToAgent')
    expect(b.state().tabs.find((t) => t.id === tab.id)!.shared).toBe(true)
    events.found({ tabId: tab.id, active: 1, matches: 3 })
    await tick()
    expect(published).toEqual(expect.arrayContaining([{ channel: 'browser:command', payload: { command: 'sendToAgent' } }, { channel: 'browser:find', payload: { tabId: tab.id, active: 1, matches: 3 } }]))
    for (let i = 0; i < 305; i += 1) events.console(tab.id, { level: 'error', message: `e${i}`, at: 'x' })
    expect(b.consoleOf(tab.id)).toHaveLength(300)
    expect(b.consoleOf(tab.id)[0].message).toBe('e5')
    expect(b.consoleOf('other')).toEqual([])
    expect(events.locale()).toBe('en')
    expect(events.searchLabel()).toBe('Google')
  })

  it('opens links from chats and notes here — unless the user prefers the system browser', async () => {
    const { b, host, published } = await setup()
    expect(b.openFromApp('https://a.dev/')).toBe(false) // no window
    b.attach(host)
    expect(b.openFromApp('mailto:x@y.z')).toBe(false)
    expect(b.openFromApp('https://a.dev/')).toBe(true)
    await tick()
    expect(published).toContainEqual({ channel: 'browser:reveal', payload: { tabId: b.state().activeId } })
    expect(b.settings()).toMatchObject({ searchEngine: 'google', openLinksInMindeck: true, searchSuggestions: true, bookmarksBar: true })
    expect(await b.configure({ openLinksInMindeck: false, searchEngine: 'kagi' })).toMatchObject({ searchEngine: 'kagi', openLinksInMindeck: false, searchSuggestions: true, bookmarksBar: true })
    expect(b.openFromApp('https://b.dev/')).toBe(false)
  })
})

describe('BrowserService · agents', () => {
  it('shows agents only shared tabs, and the right one when they do not say which', async () => {
    const { b, host, events } = await setup()
    expect(() => b.agentTab()).toThrow('only available in the Mindeck desktop app')
    b.attach(host)
    const priv = b.open({ url: 'https://bank.example/' })
    expect(() => b.agentTab()).toThrow('No tab is shared with agents')
    const local = b.open({ url: 'localhost:5173', background: true })
    expect(b.agentTabs().map((t) => t.id)).toEqual([local.id])
    expect(b.agentTab().id).toBe(local.id) // the active tab is private: the first shared one
    expect(() => b.agentTab(priv.id)).toThrow(`Tab ${priv.id} is not open or not shared`)
    // the user shares a tab — for the site it shows; elsewhere it is private again
    b.update(priv.id, { shared: true })
    expect(b.agentTab().id).toBe(priv.id)
    events.navigated(priv.id, { url: 'https://other.example/', canGoBack: true, canGoForward: false })
    expect(b.agentTabs().map((t) => t.id)).toEqual([local.id])
    // turning sharing off for a local page hides it too
    b.update(local.id, { shared: false })
    expect(b.agentTabs()).toEqual([])
    b.update(local.id, { shared: true })
    // the tab an agent used last wins over others when the active one is private
    const second = b.open({ url: 'localhost:3000', background: true })
    b.noteAgent(second.id, 'Codex', 'click', 'Save')
    expect(b.agentTab().id).toBe(second.id)
    await tick(5)
    b.noteAgent(local.id, 'Claude Code', 'read')
    expect(b.agentTab().id).toBe(local.id) // used later
    await tick(5)
    expect(b.state().tabs.find((t) => t.id === second.id)!.agent).toMatchObject({ name: 'Codex', action: 'click', detail: 'Save' })
    b.noteAgent(second.id, 'Codex', 'read')
    expect(b.state().tabs.find((t) => t.id === second.id)!.agent).not.toHaveProperty('detail')
  })

  it('lets agents open, navigate and act on tabs — loading pages first, waiting for them', async () => {
    const { b, host, events } = await setup()
    b.attach(host)
    await expect(b.agentOpen('file:///etc/passwd', 'Claude Code')).rejects.toThrow('http and https addresses only')
    const opening = b.agentOpen('https://agent.dev/', 'Claude Code')
    const id = b.state().tabs.at(-1)!.id
    expect(host.create).toHaveBeenLastCalledWith(id, 'https://agent.dev/', { agent: true, zoom: 1, muted: false, profile: 'agents' })
    events.loading(id, false)
    expect(await opening).toMatchObject({ url: 'https://agent.dev/', openedBy: 'Claude Code', shared: true, agent: { name: 'Claude Code', action: 'open' } })
    expect(b.state().activeId).not.toBe(id) // in the background

    await expect(b.agentNavigate(id, { url: 'ftp://x' }, 'Claude Code')).rejects.toThrow('http and https')
    const going = b.agentNavigate(id, { url: 'https://agent.dev/next' }, 'Claude Code')
    expect(host.load).toHaveBeenLastCalledWith(id, 'https://agent.dev/next')
    events.loading(id, false)
    await going
    const reloading = b.agentNavigate(id, {}, 'Claude Code')
    expect(host.go).toHaveBeenLastCalledWith(id, 'reload')
    events.loading(id, false)
    await reloading
    await b.agentNavigate(id, { action: 'back' }, 'Claude Code') // nowhere to go: nothing to wait for
    expect(host.go).toHaveBeenLastCalledWith(id, 'back')

    // a restored, never shown tab gets its view first
    const local = b.open({ url: 'localhost:4000', background: true })
    b.detach()
    b.attach(host)
    host.create.mockClear()
    const automation = b.automation(local.id)
    expect(host.create).toHaveBeenCalledWith(local.id, 'http://localhost:4000/', expect.any(Object))
    events.loading(local.id, false)
    expect(await automation).toBe(host.target)
    expect(await b.automation(local.id)).toBe(host.target) // loaded now: straight through
  })

  it('stops waiting after its timeout, and lets the others keep waiting', async () => {
    const { b, host } = await setup()
    b.attach(host)
    const tab = b.open({ url: 'https://slow.dev/' })
    const long = b.waitForLoad(tab.id, 10_000)
    await b.waitForLoad(tab.id, 5)
    let done = false
    void long.then(() => (done = true))
    await tick(10)
    expect(done).toBe(false)
    b.close(tab.id)
    await long
    await b.waitForLoad('gone') // no such tab: nothing to wait for
  })
})

describe('BrowserService · saving', () => {
  it('saves the session and site choices shortly after changes, and at the latest on quit', async () => {
    const { b, host, dir, events } = await setup()
    b.attach(host)
    const tab = b.open({ url: 'https://a.dev/' })
    events.favicon(tab.id, 'data:image/png;base64,small')
    const big = b.open({ url: 'https://b.dev/' })
    events.favicon(big.id, `data:image/png;base64,${'x'.repeat(9000)}`)
    b.update(tab.id, { pinned: true, muted: true, shared: false })
    const agent = b.open({ url: 'https://c.dev/', openedBy: 'Codex' })
    b.zoom(tab.id, 'in')
    await tick(450)
    const session = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'))
    expect(session.version).toBe(1)
    expect(session.activeId).toBe(agent.id)
    expect(session.tabs).toEqual(
      expect.arrayContaining([
        { id: tab.id, url: 'https://a.dev/', title: '', favicon: 'data:image/png;base64,small', pinned: true, muted: true, share: { on: false, origin: 'https://a.dev' } },
        { id: big.id, url: 'https://b.dev/', title: '' },
        { id: agent.id, url: 'https://c.dev/', title: '', openedBy: 'Codex', profile: 'agents' }
      ])
    )
    expect(JSON.parse(await readFile(join(dir, 'sites.json'), 'utf8')).sites).toEqual({ 'https://a.dev': { zoom: 1.1 } })
  })

  it('writes nothing when nothing changed, and logs a save that fails', async () => {
    const clean = await setup()
    await clean.b.dispose()
    await expect(readFile(join(clean.dir, 'session.json'))).rejects.toThrow()

    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = await tempDir()
    await mkdir(join(dir, 'session.json'))
    await mkdir(join(dir, 'sites.json'))
    const broken = await setup({ dir })
    const tab = broken.b.open({ url: 'https://a.dev/' })
    broken.b.zoom(tab.id, 'in')
    await broken.b.dispose()
    expect(err.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['[browser] saving the session failed', '[browser] saving site settings failed']))
  })
})

describe('BrowserService · the rest of the way', () => {
  it('freezes the visible page for menus, opens links in new tabs, and shows a tab it is asked to', async () => {
    const { b, host, events, ids } = await setup()
    b.attach(host)
    await expect(b.freeze()).resolves.toEqual({ t: 'data:image/jpeg;base64,x' })
    b.unfreeze()
    expect(host.unfreeze).toHaveBeenCalled()
    const first = b.open({ url: 'https://a.dev/' })
    events.openTab('https://linked.dev/', { background: true, opener: first.id })
    expect(ids()[ids().indexOf(first.id) + 1]).toBe(b.state().tabs.find((t) => t.url === 'https://linked.dev/')!.id)
    // activated while on screen: its page loads now
    const later = b.open({ url: 'https://later.dev/', background: true })
    b.detach()
    b.attach(host)
    b.setView({ x: 0, y: 0, width: 10, height: 10 })
    host.create.mockClear()
    b.activate(later.id)
    expect(host.create).toHaveBeenCalledWith(later.id, 'https://later.dev/', expect.any(Object))
    // a stale active id falls back to the first tab
    ;(b as unknown as { activeId: string }).activeId = 'gone'
    events.shortcut('zoomIn')
    expect(b.state().tabs[0].zoom).toBe(1.1)
  })

  it('updates the right download, suggests untitled pages by address, and names the system browser in menus', async () => {
    const { b, host, events } = await setup()
    b.attach(host)
    const d = (id: string): BrowserDownload => ({ id, filename: id, path: `/d/${id}`, url: 'https://a.dev/', state: 'progressing', received: 0, total: 0, startedAt: 'x' })
    events.download(d('one'), { cancel: vi.fn() })
    events.download(d('two'), { cancel: vi.fn() })
    events.downloadUpdated({ ...d('one'), received: 7 })
    expect(b.state().downloads.map((x) => x.received)).toEqual([0, 7])

    const tab = b.open({ url: 'https://untitled.dev/' })
    events.navigated(tab.id, { url: 'https://untitled.dev/', canGoBack: false, canGoForward: false })
    b.close(tab.id)
    expect(b.suggest('untitled')).toContainEqual({ kind: 'history', url: 'https://untitled.dev/', title: 'https://untitled.dev/' })

    const page = b.open({ url: 'https://c.dev/' })
    b.tool(page.id, 'tabMenu')
    expect(menu(host).map((e) => ('label' in e ? e.label : ''))).toContain('Open in Arc')
    b.tool(page.id, 'pageMenu')
    expect(menu(host).map((e) => ('label' in e ? e.label : ''))).toContain('Open in Arc')
  })

  it('stops a lone waiter after its timeout, and pushes state on its own schedule by default', async () => {
    const dir = await tempDir()
    const published: string[] = []
    const b = new BrowserService({ dir, settings: settingsStore(), publish: (channel) => published.push(channel) })
    await b.init()
    onCleanup(() => b.dispose())
    const host = fakeHost()
    b.attach(host)
    const tab = b.open({ url: 'https://slow.dev/' })
    await b.waitForLoad(tab.id, 5)
    await tick(50)
    expect(published).toContain('browser:state')
  })
})
