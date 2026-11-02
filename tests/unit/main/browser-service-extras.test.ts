import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onCleanup, tempDir, tick } from './helpers'
import { BrowserService, type BrowserDeps } from '../../../electron/main/services/browser/BrowserService'
import type { AutomationTarget, BrowserHost, MenuEntry } from '../../../electron/main/services/browser/types'
import type { AppSettings } from '@shared/types/settings'
import { Router } from '../../../electron/ipc/router'
import { registerBrowserIpc } from '../../../electron/ipc/browser.ipc'
import { labels } from '../../../electron/main/services/browser/labels'
import { hostOf } from '../../../electron/main/services/browser/url'

function fakeHost() {
  return {
    create: vi.fn(),
    destroy: vi.fn(),
    navigation: vi.fn(() => undefined),
    load: vi.fn(),
    go: vi.fn(),
    show: vi.fn(),
    setBounds: vi.fn(),
    freeze: vi.fn(async () => null),
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
    automation: vi.fn(() => ({}) as AutomationTarget),
    dispose: vi.fn(),
    clearPrivate: vi.fn(),
    loadExtension: vi.fn(async (path: string) => ({ id: `id-${path.length}` })),
    unloadExtension: vi.fn(),
    openPopup: vi.fn()
  } satisfies BrowserHost
}

async function setup(opts: { settings?: AppSettings; session?: unknown; deps?: Partial<BrowserDeps> } = {}) {
  const dir = await tempDir()
  if (opts.session) await writeFile(join(dir, 'session.json'), JSON.stringify(opts.session))
  let current: AppSettings = opts.settings ?? {}
  const published: { channel: string; payload: unknown }[] = []
  const deps: BrowserDeps = {
    dir,
    settings: { get: () => current, update: vi.fn(async (patch: Partial<AppSettings>) => (current = { ...current, ...patch })) },
    publish: (channel, payload) => published.push({ channel, payload }),
    publishDelayMs: 0,
    download: vi.fn(async () => ({ ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) })),
    browserRoots: () => [],
    ...opts.deps
  }
  const b = new BrowserService(deps)
  await b.init()
  onCleanup(() => b.dispose())
  const host = fakeHost()
  const tab = (id: string) => b.state().tabs.find((t) => t.id === id)!
  return { b, dir, deps, host, events: b.hostEvents(), tab, published }
}

const menu = (host: ReturnType<typeof fakeHost>) => host.popup.mock.calls.at(-1)![0] as MenuEntry[]
const item = (entries: MenuEntry[], label: string) => entries.find((e) => 'label' in e && e.label === label) as Exclude<MenuEntry, { separator: true }>

afterEach(() => vi.unstubAllGlobals())

describe('BrowserService · private tabs and the agents’ container', () => {
  it('keeps private tabs out of history, session, closed tabs and agents’ reach — and wipes them with the last one', async () => {
    const { b, host, events, tab, dir } = await setup()
    b.attach(host)
    const priv = b.open({ url: 'https://secret.dev/', private: true })
    expect(priv).toMatchObject({ profile: 'private', shared: false })
    expect(host.create).toHaveBeenLastCalledWith(priv.id, 'https://secret.dev/', { agent: false, zoom: 1, muted: false, profile: 'private' })
    // links from it stay private
    events.openTab('https://secret.dev/next', { background: true, opener: priv.id })
    const child = b.state().tabs.at(-1)!
    expect(child.profile).toBe('private')
    events.navigated(priv.id, { url: 'https://secret.dev/', canGoBack: false, canGoForward: false })
    events.title(priv.id, 'Secret')
    expect(b.historyEntries()).toEqual([])
    b.update(priv.id, { shared: true })
    expect(tab(priv.id).shared).toBe(false)
    expect(b.agentTabs().map((t) => t.id)).not.toContain(priv.id)
    // zoom and remembered permissions are not written down
    b.zoom(priv.id, 'in')
    const answer = vi.fn()
    events.permission({ tabId: priv.id, origin: 'https://secret.dev', kind: 'notifications' }, answer)
    b.permission(b.state().permissions[0].id, true, true)
    expect(answer).toHaveBeenCalledWith(true)
    // its downloads are listed, never written down
    const dl = (id: string, extra = {}) => ({ id, filename: `${id}.pdf`, path: `/dl/${id}.pdf`, url: `https://x.dev/${id}`, state: 'completed' as const, received: 1, total: 1, startedAt: '', ...extra })
    events.download(dl('secret', { private: true }), { cancel: vi.fn() })
    events.download(dl('mine'), { cancel: vi.fn() })
    expect(b.state().downloads.map((d) => d.id)).toEqual(['mine', 'secret'])
    await b.dispose()
    const saved = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'))
    expect(saved.tabs.map((t: { id: string }) => t.id)).not.toContain(priv.id)
    expect(saved.downloads.map((d: { id: string }) => d.id)).toEqual(['mine'])
    await expect(readFile(join(dir, 'sites.json'), 'utf8')).rejects.toThrow()

    b.close(child.id)
    expect(host.clearPrivate).not.toHaveBeenCalled() // one is still open
    expect(b.state().downloads).toHaveLength(2)
    b.close(priv.id)
    expect(host.clearPrivate).toHaveBeenCalledTimes(1)
    expect(b.state().downloads.map((d) => d.id)).toEqual(['mine']) // the last private tab took its downloads along
    expect(b.state().closed).toBe(0)
    // ⌘⇧N and the page menu open one too
    events.shortcut('newPrivateTab')
    expect(b.state().tabs.at(-1)!.profile).toBe('private')
    b.tool(b.state().tabs[0].id, 'pageMenu')
    item(menu(host), 'New Private Tab').run()
    expect(b.state().tabs.filter((t) => t.profile === 'private')).toHaveLength(2)
  })

  it('opens agents’ tabs in their container — unless the user lets agents use the logins — and remembers it', async () => {
    const { b, host, events, dir } = await setup()
    b.attach(host)
    const opening = b.agentOpen('https://vercel.com/', 'Claude Code')
    const agentTab = b.state().tabs.at(-1)!
    events.loading(agentTab.id, false)
    expect(await opening).toMatchObject({ profile: 'agents', shared: true })
    expect(host.create).toHaveBeenLastCalledWith(agentTab.id, 'https://vercel.com/', { agent: true, zoom: 1, muted: false, profile: 'agents' })
    // closed and reopened, it is still the agents'
    b.close(agentTab.id)
    expect(b.reopen()).toMatchObject({ profile: 'agents' })
    await b.dispose()
    expect(JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')).tabs.at(-1).profile).toBe('agents')
    const restored = await setup({ session: { exit: 'running', tabs: [{ id: 'a', url: 'https://x.dev/', profile: 'agents' }, { id: 'p', url: 'https://y.dev/', profile: 'private' }] } })
    restored.b.restoreSession(true) // after a crash
    expect(restored.b.state().tabs.map((t) => t.profile)).toEqual(['agents', undefined])
    // an agent's tab closed before the restart reopens in the container too
    const closed = await setup({
      session: {
        tabs: [],
        closed: [
          { url: 'https://mine.dev/', title: '', index: 0, pinned: false, profile: 'private' },
          { url: 'https://agent.dev/', title: '', index: 0, pinned: false, profile: 'agents' }
        ]
      }
    })
    expect(closed.b.reopen()).not.toHaveProperty('profile') // only the agents' container is kept
    expect(closed.b.reopen()).toMatchObject({ url: 'https://agent.dev/', profile: 'agents' })

    await b.configure({ agentsUseLogins: true })
    const own = b.agentOpen('https://github.com/', 'Codex')
    const ownTab = b.state().tabs.at(-1)!
    events.loading(ownTab.id, false)
    expect(await own).not.toHaveProperty('profile')
  })
})

describe('BrowserService · blocking, malware and DRM', () => {
  it('asks the blocker about every request and counts what it blocked on the page', async () => {
    const { b, host, events, tab } = await setup()
    b.attach(host)
    const t = b.open({ url: 'https://news.dev/' })
    const check = vi.spyOn(b.adblock, 'check')
    check.mockReturnValueOnce({})
    expect(events.request(t.id, { url: 'https://news.dev/', type: 'mainFrame', referrer: '' })).toEqual({})
    expect(check).toHaveBeenLastCalledWith({ url: 'https://news.dev/', type: 'mainFrame', sourceUrl: '', page: 'https://news.dev/' })
    check.mockReturnValueOnce({ cancel: true }).mockReturnValueOnce({ redirectURL: 'data:,' }).mockReturnValueOnce({})
    events.request(t.id, { url: 'https://ads.dev/a.js', type: 'script', referrer: 'https://news.dev/' })
    events.request(t.id, { url: 'https://t.dev/t.js', type: 'script', referrer: 'https://news.dev/' })
    events.request(t.id, { url: 'https://cdn.dev/x.js', type: 'script', referrer: '' })
    expect(check).toHaveBeenLastCalledWith(expect.objectContaining({ page: 'https://news.dev/' }))
    expect(tab(t.id).shield).toEqual({ on: true, blocked: 2 })
    // a popup's request counts for no tab
    check.mockReturnValueOnce({ cancel: true })
    events.request(undefined, { url: 'https://ads.dev/b.js', type: 'script', referrer: 'https://login.dev/' })
    expect(check).toHaveBeenLastCalledWith(expect.objectContaining({ page: 'https://login.dev/' }))
    // the next page starts from zero
    check.mockReturnValueOnce({})
    events.request(t.id, { url: 'https://news.dev/2', type: 'mainFrame', referrer: '' })
    expect(tab(t.id).shield!.blocked).toBe(0)
    // element hiding for open tabs only
    vi.spyOn(b.adblock, 'cosmetics').mockReturnValue('.ad{display:none}')
    expect(events.cosmetics(t.id, 'https://news.dev/')).toBe('.ad{display:none}')
    expect(events.cosmetics('gone', 'https://news.dev/')).toBe('')
    // new-tab pages have no shield
    expect(b.open()).not.toHaveProperty('shield')
  })

  it('shows a malware warning instead of the page, and opens it when the user insists', async () => {
    const { b, host, events, tab } = await setup()
    b.attach(host)
    const t = b.open({ url: 'https://evil.dev/' })
    vi.spyOn(b.adblock, 'check').mockReturnValue({ cancel: true, danger: true })
    events.request(t.id, { url: 'https://evil.dev/', type: 'mainFrame', referrer: '' })
    events.failed(t.id, { code: -20, description: 'ERR_BLOCKED_BY_CLIENT', url: 'https://evil.dev/' })
    expect(tab(t.id).error).toEqual({ code: -20, description: 'ERR_BLOCKED_BY_CLIENT', url: 'https://evil.dev/', danger: 'malware' })
    const trust = vi.spyOn(b.adblock, 'trust')
    b.proceed(t.id)
    expect(trust).toHaveBeenCalledWith('https://evil.dev/')
    expect(host.load).toHaveBeenLastCalledWith(t.id, 'https://evil.dev/')
    // other failures stay failures
    events.failed(t.id, { code: -105, description: 'NAME_NOT_RESOLVED', url: 'https://other.dev/' })
    expect(tab(t.id).error).not.toHaveProperty('danger')
    expect(() => b.proceed(t.id)).toThrow('no blocked page')
  })

  it('turns blocking off and on per site from the shield’s menu, and says when it is off everywhere', async () => {
    const { b, host, tab } = await setup()
    b.attach(host)
    const t = b.open({ url: 'https://news.dev/' })
    b.tool(t.id, 'shield')
    let m = menu(host)
    expect(m.filter((e) => 'label' in e).map((e) => [(e as { label: string }).label, (e as { enabled?: boolean }).enabled ?? true, (e as { checked?: boolean }).checked])).toEqual([
      ['0 ads and trackers blocked on this page', false, undefined],
      ['Block Ads and Trackers on news.dev', true, true],
      ['Browser Settings', true, undefined]
    ])
    item(m, '0 ads and trackers blocked on this page').run() // only information
    item(m, 'Block Ads and Trackers on news.dev').run()
    await vi.waitFor(() => expect(host.go).toHaveBeenLastCalledWith(t.id, 'reload'))
    expect(tab(t.id).shield).toEqual({ on: false, blocked: 0 })
    b.tool(t.id, 'shield')
    expect(item(menu(host), 'Block Ads and Trackers on news.dev').checked).toBe(false)
    item(menu(host), 'Browser Settings').run()

    const local = b.open({ url: 'http://localhost:5173/' })
    b.tool(local.id, 'shield')
    expect(item(menu(host), 'Block Ads and Trackers on localhost').enabled).toBe(false)
    const blank = b.open()
    b.tool(blank.id, 'shield')
    expect(item(menu(host), 'Block Ads and Trackers on ').enabled).toBe(false)

    await b.configure({ adblock: false })
    b.setUi({ theme: 'system', locale: 'de' })
    b.tool(t.id, 'shield')
    m = menu(host)
    expect(item(m, '0 Werbungen und Tracker auf dieser Seite blockiert')).toBeDefined()
    item(m, 'Blockieren ist in den Einstellungen aus').run()
    expect(tab(t.id).shield).toEqual({ on: false, blocked: 0 })
  })

  it('tells when a page needs DRM — by its address or its player’s complaint — until the user closes the bar', async () => {
    const { b, host, events, tab } = await setup()
    b.attach(host)
    const t = b.open({ url: 'https://www.netflix.com/' })
    events.navigated(t.id, { url: 'https://www.netflix.com/browse', canGoBack: false, canGoForward: false })
    expect(tab(t.id).drm).toBe(true)
    b.dismissDrm(t.id)
    expect(tab(t.id)).not.toHaveProperty('drm')
    events.navigated(t.id, { url: 'https://www.netflix.com/watch/1', canGoBack: true, canGoForward: false })
    events.console(t.id, { level: 'error', message: 'requestMediaKeySystemAccess failed', at: '' })
    expect(tab(t.id)).not.toHaveProperty('drm') // closed for this site
    events.navigated(t.id, { url: 'https://video.dev/', canGoBack: true, canGoForward: false })
    events.console(t.id, { level: 'info', message: 'all good', at: '' })
    expect(tab(t.id)).not.toHaveProperty('drm')
    events.console(t.id, { level: 'error', message: 'EME: com.widevine.alpha not supported', at: '' })
    expect(tab(t.id).drm).toBe(true)
    events.console(t.id, { level: 'error', message: 'Widevine again', at: '' }) // already said
    events.console('gone', { level: 'error', message: 'Widevine', at: '' })
    expect(b.consoleOf(t.id)).toHaveLength(4)
  })
})

describe('BrowserService · logins, media, downloads, extensions', () => {
  it('asks the user for a server’s login, passes the answer on, and cancels when the page goes', async () => {
    const { b, host, events, published } = await setup()
    b.attach(host)
    const t = b.open({ url: 'https://intranet.dev/' })
    const respond = vi.fn()
    events.login(t.id, { url: 'https://intranet.dev/', host: 'intranet.dev:443', realm: 'Staff', isProxy: false }, respond)
    const [req] = b.state().auth!
    expect(req).toEqual({ id: expect.any(String), tabId: t.id, host: 'intranet.dev:443', realm: 'Staff', isProxy: false })
    b.answerAuth(req.id, 'robin', 'pw')
    expect(respond).toHaveBeenCalledWith({ username: 'robin', password: 'pw' })
    expect(() => b.answerAuth(req.id)).toThrow('no longer pending')

    const proxy = vi.fn()
    events.login('unknown', { url: 'https://x/', host: 'proxy:8080', realm: '', isProxy: true }, proxy)
    expect(b.state().auth![0]).not.toHaveProperty('tabId')
    b.answerAuth(b.state().auth![0].id, 'me')
    expect(proxy).toHaveBeenCalledWith({ username: 'me', password: '' })
    const cancelled = vi.fn()
    events.login(undefined, { url: 'https://x/', host: 'x:443', realm: '', isProxy: false }, cancelled)
    b.answerAuth(b.state().auth![0].id)
    expect(cancelled).toHaveBeenCalledWith(null)

    // the page moves on or closes: its question goes
    const gone = vi.fn()
    events.login(t.id, { url: 'https://intranet.dev/', host: 'intranet.dev:443', realm: 'Staff', isProxy: false }, gone)
    events.navigated(t.id, { url: 'https://intranet.dev/home', canGoBack: true, canGoForward: false })
    expect(gone).toHaveBeenCalledWith(null)
    const late = vi.fn()
    events.login(undefined, { url: 'https://x/', host: 'x:443', realm: '', isProxy: false }, late)
    const stopLists = vi.spyOn(b.adblock, 'stop')
    b.detach()
    expect(late).toHaveBeenCalledWith(null)
    expect(stopLists).toHaveBeenCalled() // no window, no filter-list downloads
    expect(b.state().auth).toEqual([])
    await tick()
    expect(published.length).toBeGreaterThan(0)
  })

  it('marks tabs playing media, and tells the host where downloads go', async () => {
    const { b, host, events, tab } = await setup({ settings: { browser: { askDownloadLocation: true, downloadDir: '/dl' } } })
    b.attach(host)
    const t = b.open({ url: 'https://video.dev/' })
    events.media(t.id, true)
    expect(tab(t.id).playing).toBe(true)
    events.media(t.id, false)
    expect(tab(t.id).playing).toBe(false)
    expect(events.downloadPrefs()).toEqual({ ask: true, dir: '/dl' })
  })

  it('lets the user pick the downloads folder — where there is a picker', async () => {
    const pickFolder = vi.fn(async () => null as string | null)
    const { b } = await setup({ deps: { pickFolder } })
    expect(await b.pickDownloadDir()).toBeNull()
    pickFolder.mockResolvedValueOnce('/Users/me/Inbox')
    expect(await b.pickDownloadDir()).toMatchObject({ downloadDir: '/Users/me/Inbox' })
    expect(pickFolder).toHaveBeenCalledWith('Choose a downloads folder')
    const headless = await setup()
    await expect(headless.b.pickDownloadDir()).rejects.toMatchObject({ code: 'desktop-only' })
  })

  it('loads the extensions with the window and lists them in the state', async () => {
    const { b, host, dir } = await setup()
    const folder = await tempDir()
    await writeFile(join(folder, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Dev tool', version: '1' }))
    await writeFile(join(dir, 'extensions.json'), JSON.stringify({ extensions: [{ id: 'x', source: 'folder', path: folder }] }))
    const again = await setup({ deps: { dir } })
    again.b.attach(again.host)
    await vi.waitFor(() => expect(again.host.loadExtension).toHaveBeenCalledWith(folder))
    expect(again.b.state().extensions).toEqual([expect.objectContaining({ id: 'x', name: 'Dev tool' })])
    expect(b.state().extensions).toEqual([])
  })

  it('uses the global fetch, this computer’s browsers and a default Chrome version unless told otherwise', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => '' }))
    vi.stubGlobal('fetch', fetch)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { b } = await setup({ deps: { download: undefined, browserRoots: undefined } })
    await b.adblock.update()
    expect(fetch).toHaveBeenCalled()
    expect(errors).toHaveBeenCalled()
    expect(Array.isArray(await b.extensions.profiles())).toBe(true)
    await expect(b.extensions.checkUpdates()).resolves.toEqual({ checked: 0, updated: [], failed: [] })
    const withVersion = await setup({ deps: { chromeVersion: '141.0.0.0' } })
    expect(withVersion.b.extensions).toBeDefined()
  })
})

describe('the browser extras’ words and helpers', () => {
  it('speak German and English, and name hosts', () => {
    expect(labels('en').blocked(1)).toBe('1 ad or tracker blocked on this page')
    expect(labels('de').blocked(1)).toBe('1 Werbung oder Tracker auf dieser Seite blockiert')
    expect(labels('de').blocked(3)).toBe('3 Werbungen und Tracker auf dieser Seite blockiert')
    expect(labels('de').blockOn('a.dev')).toBe('Werbung und Tracker auf a.dev blockieren')
    expect(hostOf('https://Example.COM:8080/a')).toBe('example.com')
    expect(hostOf('nope')).toBe('')
  })
})

describe('the browser extras’ channels', () => {
  const recorder = () =>
    new Proxy({} as Record<string, unknown>, {
      get: (target, key: string) => (target[key] ??= vi.fn((...args: unknown[]) => ({ called: key, args })))
    })

  it('reach the browser and its extensions with validated payloads — from the desktop window only', async () => {
    const router = new Router()
    const browser = recorder()
    browser.extensions = recorder()
    registerBrowserIpc(router, browser as unknown as BrowserService)
    const ipc = { transport: 'ipc' as const }
    const anchor = { x: 1, y: 2, width: 3, height: 4 }
    const calls: [string, unknown, string, unknown[]][] = [
      ['browser:extensions', undefined, 'list', []],
      ['browser:extensions:install', { source: 'store', input: ' abc ' }, 'install', [{ source: 'store', input: 'abc' }]],
      ['browser:extensions:install', { source: 'folder' }, 'install', [{ source: 'folder' }]],
      ['browser:extensions:install', { source: 'profile', path: '/p' }, 'install', [{ source: 'profile', path: '/p' }]],
      ['browser:extensions:profiles', undefined, 'profiles', []],
      ['browser:extensions:update', { id: 'e', enabled: false }, 'setEnabled', ['e', false]],
      ['browser:extensions:remove', { id: 'e' }, 'remove', ['e']],
      ['browser:extensions:checkUpdates', undefined, 'checkUpdates', []],
      ['browser:extensions:popup', { id: 'e', anchor }, 'popup', ['e', anchor]],
      ['browser:auth', { id: 'a', username: 'u', password: 'p' }, 'answerAuth', ['a', 'u', 'p']],
      ['browser:auth', { id: 'a' }, 'answerAuth', ['a', undefined, undefined]],
      ['browser:proceed', { id: 't' }, 'proceed', ['t']],
      ['browser:dismissDrm', { id: 't' }, 'dismissDrm', ['t']],
      ['browser:pickDownloadDir', undefined, 'pickDownloadDir', []],
      ['browser:open', { private: true }, 'open', [{ url: undefined, background: undefined, private: true }]],
      ['browser:tool', { id: 't', tool: 'shield' }, 'tool', ['t', 'shield']],
      ['browser:configure', { adblock: false, downloadDir: '/d' }, 'configure', [{ adblock: false, downloadDir: '/d' }]]
    ]
    for (const [channel, payload, method, args] of calls) {
      expect(await router.dispatch(channel, payload, ipc), channel).toEqual({ ok: true, data: { called: method, args } })
    }
    expect(await router.dispatch('browser:extensions:install', { source: 'ftp', input: 'x' }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('browser:extensions:install', { source: 'store', input: '  ' }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('browser:extensions', undefined, { transport: 'remote' })).toMatchObject({ ok: false, error: { code: 'desktop-only' } })
  })
})
