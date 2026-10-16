import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { BrowserHostEvents, MenuEntry } from '../../../electron/main/services/browser/types'
import type { SessionTarget } from '../../../electron/main/platform/browser/session'

// --- electron double -------------------------------------------------------------
type Fn = (...a: never[]) => unknown

class FakeImage {
  constructor(
    public width = 1280,
    public height = 800,
    public empty = false
  ) {}
  isEmpty = () => this.empty
  toJPEG = (q: number) => Buffer.from(`jpeg${q}`)
  toPNG = () => Buffer.from(`png${this.width}`)
  getSize = () => ({ width: this.width, height: this.height })
  resize = ({ width }: { width: number }) => new FakeImage(width, Math.round((this.height * width) / this.width))
}

class FakeContents {
  handlers = new Map<string, Fn>()
  destroyed = false
  openHandler?: (d: unknown) => unknown
  zoom = 1
  devtoolsOpen = false
  image = new FakeImage()
  canBack = false
  canForward = false
  session = { addWordToSpellCheckerDictionary: vi.fn(() => true) }
  debugger = {
    attached: false,
    isAttached: () => this.debugger.attached,
    attach: vi.fn(() => (this.debugger.attached = true)),
    detach: vi.fn(() => (this.debugger.attached = false)),
    sendCommand: vi.fn(async (method: string) => ({ method }))
  }
  url = ''
  entries: { url: string; title: string; pageState?: string }[] = []
  activeIndex = -1
  /** How `navigationHistory.restore` goes for every contents (a test may change it). */
  static restoreWith: (c: FakeContents) => Promise<void> = () => Promise.resolve()
  navigationHistory = {
    canGoBack: () => this.canBack,
    canGoForward: () => this.canForward,
    goBack: vi.fn(),
    goForward: vi.fn(),
    getAllEntries: () => this.entries,
    getActiveIndex: () => this.activeIndex,
    getEntryAtIndex: (index: number) => this.entries[index] as { url: string; title: string } | undefined,
    restore: vi.fn(() => FakeContents.restoreWith(this))
  }
  getURL = () => this.url
  loadURL = vi.fn(async (url: string) => (url.includes('fail') ? Promise.reject(new Error('ERR_ABORTED')) : undefined))
  reload = vi.fn()
  reloadIgnoringCache = vi.fn()
  stop = vi.fn()
  findInPage = vi.fn()
  stopFindInPage = vi.fn()
  setZoomFactor = vi.fn((z: number) => (this.zoom = z))
  getZoomFactor = () => this.zoom
  setAudioMuted = vi.fn()
  isDevToolsOpened = () => this.devtoolsOpen
  openDevTools = vi.fn(() => (this.devtoolsOpen = true))
  closeDevTools = vi.fn(() => (this.devtoolsOpen = false))
  print = vi.fn()
  capturePage = vi.fn(async () => this.image)
  close = vi.fn(() => (this.destroyed = true))
  isDestroyed = () => this.destroyed
  focus = vi.fn()
  downloadURL = vi.fn()
  copyImageAt = vi.fn()
  cut = vi.fn()
  copy = vi.fn()
  paste = vi.fn()
  selectAll = vi.fn()
  replaceMisspelling = vi.fn()
  inspectElement = vi.fn()
  setWindowOpenHandler = (fn: (d: unknown) => unknown) => (this.openHandler = fn)
  on(event: string, fn: Fn) {
    this.handlers.set(event, fn)
    return this
  }
  removeListener = vi.fn((event: string) => this.handlers.delete(event))
  emit(event: string, ...args: unknown[]) {
    return (this.handlers.get(event) as (...a: unknown[]) => unknown)(...args)
  }
}

class FakeView {
  static all: FakeView[] = []
  webContents = new FakeContents()
  visible = true
  bounds?: unknown
  constructor(public opts: { webPreferences: Record<string, unknown> }) {
    FakeView.all.push(this)
  }
  setVisible = vi.fn((v: boolean) => (this.visible = v))
  setBounds = vi.fn((b: unknown) => (this.bounds = b))
}

const h = vi.hoisted(() => ({
  session: null as null | Record<string, unknown>,
  menus: [] as { template: unknown[]; popup: ReturnType<typeof vi.fn> }[],
  clipboard: vi.fn(),
  openExternal: vi.fn(),
  theme: { themeSource: 'system' },
  appName: 'Arc',
  fetch: vi.fn(),
  partitions: [] as string[],
  uaSets: 0,
  permissionHandler: undefined as undefined | ((...a: unknown[]) => void),
  exec: vi.fn()
}))
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:child_process')>()), execFile: (...a: unknown[]) => h.exec(...a) }))

function fakeSession() {
  const s = {
    ua: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) mindeck/0.1.0 Chrome/140.0.7339.41 Electron/44.7.2 Safari/537.36',
    getUserAgent: () => s.ua,
    setUserAgent: (ua: string) => {
      h.uaSets += 1
      s.ua = ua
    },
    setPermissionRequestHandler: (fn: (...a: unknown[]) => void) => (h.permissionHandler = fn),
    setPermissionCheckHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    setCertificateVerifyProc: vi.fn(),
    on: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn(), onBeforeSendHeaders: vi.fn() },
    registerPreloadScript: vi.fn(),
    fetch: (...a: unknown[]) => h.fetch(...a)
  }
  return s
}

vi.mock('electron', () => ({
  app: { getApplicationNameForProtocol: () => h.appName, getPath: () => '/Downloads' },
  BrowserWindow: class {},
  clipboard: { writeText: (t: string) => h.clipboard(t) },
  Menu: {
    buildFromTemplate: (template: unknown[]) => {
      const menu = { template, popup: vi.fn() }
      h.menus.push(menu)
      return menu
    }
  },
  nativeTheme: h.theme,
  session: {
    fromPartition: (name: string) => {
      h.partitions.push(name)
      return (h.session ??= fakeSession())
    }
  },
  shell: { openExternal: (u: string) => h.openExternal(u) },
  WebContentsView: FakeView,
  desktopCapturer: { getSources: vi.fn() },
  systemPreferences: { askForMediaAccess: vi.fn() }
}))

// Loaded after the doubles above exist (vi.mock factories run on first import).
type HostModule = typeof import('../../../electron/main/platform/browser/host')
type ElectronBrowserHost = InstanceType<HostModule['ElectronBrowserHost']>
let createBrowserHost: HostModule['createBrowserHost']
let menuTemplate: HostModule['menuTemplate']
let popupSize: HostModule['popupSize']
beforeAll(async () => {
  ;({ createBrowserHost, menuTemplate, popupSize } = await import('../../../electron/main/platform/browser/host'))
})

function fakeWindow() {
  const win = {
    destroyed: false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: new FakeContents(),
    isDestroyed: () => win.destroyed,
    on: vi.fn(),
    removeListener: vi.fn(),
    getContentBounds: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    fullScreen: false,
    isFullScreen: () => win.fullScreen,
    setFullScreen: vi.fn((v: boolean) => (win.fullScreen = v))
  }
  return win
}

function events(): { [K in keyof BrowserHostEvents]: Mock<BrowserHostEvents[K]> } {
  return {
    navigated: vi.fn(),
    title: vi.fn(),
    favicon: vi.fn(),
    loading: vi.fn(),
    failed: vi.fn(),
    crashed: vi.fn(),
    audible: vi.fn(),
    zoomed: vi.fn(),
    openTab: vi.fn(),
    found: vi.fn(),
    console: vi.fn(),
    shortcut: vi.fn(),
    focused: vi.fn(),
    workspaceKey: vi.fn(),
    command: vi.fn(),
    permission: vi.fn(),
    permissionCheck: vi.fn(() => false),
    download: vi.fn(),
    downloadUpdated: vi.fn(),
    locale: vi.fn(() => 'en' as const),
    searchLabel: vi.fn(() => 'Google'),
    downloadPrefs: vi.fn(() => ({ ask: false, dir: '' })),
    request: vi.fn(() => ({})),
    cosmetics: vi.fn(() => ''),
    media: vi.fn(),
    login: vi.fn()
  }
}

function setup() {
  const win = fakeWindow()
  const ev = events()
  const host = createBrowserHost(win as never, ev)
  const open = (id = 't1', url = 'https://a.dev/', opts?: Parameters<ElectronBrowserHost['create']>[2]) => {
    host.create(id, url, opts)
    return FakeView.all[FakeView.all.length - 1]
  }
  return { win, ev, host, open }
}

const key = (k: string, mods: Partial<Record<'meta' | 'control' | 'alt' | 'shift', boolean>> = {}) => ({ type: 'keyDown', key: k, meta: false, control: false, alt: false, shift: false, ...mods })

beforeEach(() => {
  FakeView.all = []
  h.menus = []
  h.fetch.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('the browser host · views', () => {
  it('creates a sandboxed view per tab in the browser profile, hidden until shown', () => {
    const { win, open } = setup()
    const view = open('t1', 'https://a.dev/', { zoom: 1.25, muted: true })
    expect(view.opts.webPreferences).toEqual({
      partition: 'persist:mindeck-browser',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      safeDialogs: true,
      backgroundThrottling: true
    })
    expect(win.contentView.addChildView).toHaveBeenCalledWith(view)
    expect(view.visible).toBe(false)
    expect(view.webContents.setAudioMuted).toHaveBeenCalledWith(true)
    expect(view.webContents.loadURL).toHaveBeenCalledWith('https://a.dev/')
    // an agent's tab keeps running in the background
    expect(open('t2', 'https://b.dev/', { agent: true }).opts.webPreferences.backgroundThrottling).toBe(false)
    open('t3', 'https://fail.dev/') // a failed load is reported by events, not thrown
    open('t4', 'https://d.dev/')
  })

  it('brings a tab’s back/forward list back after a restart, and reports it for the next one', async () => {
    const { host, open } = setup()
    const history = { entries: [{ url: 'https://a.dev/1', title: '1' }, { url: 'https://a.dev/2', title: '2' }], index: 1 }
    const view = open('r', 'https://a.dev/2', { history })
    expect(view.webContents.navigationHistory.restore).toHaveBeenCalledWith(history)
    expect(view.webContents.loadURL).not.toHaveBeenCalled()
    view.webContents.entries = [{ url: 'https://a.dev/1', title: '1', pageState: 'x' }, { url: 'https://a.dev/2', title: '2' }]
    view.webContents.activeIndex = 1
    expect(host.navigation('r')).toEqual(history)
    expect(host.navigation('nope')).toBeUndefined()

    // the list did not come back: just the page, unless something loaded already or the tab is gone
    const preps = [(c: FakeContents) => c, (c: FakeContents) => (c.url = 'https://a.dev/1'), (c: FakeContents) => (c.destroyed = true)]
    try {
      for (const [i, prep] of preps.entries()) {
        FakeContents.restoreWith = (c) => {
          prep(c)
          return Promise.reject(new Error('restore failed'))
        }
        open(`f${i}`, 'https://a.dev/2', { history })
      }
    } finally {
      FakeContents.restoreWith = () => Promise.resolve()
    }
    const [plain, loaded, gone] = FakeView.all.slice(-3).map((v) => v.webContents)
    await vi.waitFor(() => expect(plain.loadURL).toHaveBeenCalledWith('https://a.dev/2'))
    expect(loaded.loadURL).not.toHaveBeenCalled()
    expect(gone.loadURL).not.toHaveBeenCalled()
  })

  it('places views where the UI says — scaled by the UI zoom — and shows only the shown one', () => {
    const { win, host, open } = setup()
    const a = open('a')
    const b = open('b')
    expect(a.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 800 }) // not on screen yet: a default size
    host.show('a')
    expect(a.visible).toBe(false) // no place yet
    win.webContents.zoom = 1.5
    host.setBounds({ x: 10, y: 20, width: 100.4, height: 50 })
    expect(a.bounds).toEqual({ x: 15, y: 30, width: 151, height: 75 })
    expect([a.visible, b.visible]).toEqual([true, false])
    host.show(undefined)
    expect(a.visible).toBe(false)
    host.show('b')
    host.setBounds(null)
    expect(b.visible).toBe(false)
  })

  it('freezes the visible page as a picture for UI menus — and an unfreeze during the shot wins', async () => {
    const { host, open } = setup()
    const a = open('a')
    expect(await host.freeze()).toBeNull() // nothing on screen
    host.setBounds({ x: 0, y: 0, width: 10, height: 10 })
    host.show('a')
    expect(await host.freeze()).toEqual({ a: `data:image/jpeg;base64,${Buffer.from('jpeg85').toString('base64')}` })
    expect(a.visible).toBe(false)
    expect(await host.freeze()).toBeNull() // already frozen
    host.unfreeze()
    expect(a.visible).toBe(true)
    const shot = host.freeze()
    host.unfreeze()
    expect(await shot).toBeNull()
    expect(a.visible).toBe(true)
    a.webContents.image = new FakeImage(0, 0, true)
    expect(await host.freeze()).toBeNull()
  })

  it('navigates, finds, zooms, mutes, opens DevTools, prints — and ignores tabs it does not have', () => {
    const { host, open } = setup()
    const c = open('a').webContents
    host.load('a', 'https://next.dev/')
    host.load('a', 'https://fail.dev/')
    expect(c.loadURL).toHaveBeenLastCalledWith('https://fail.dev/')
    for (const action of ['back', 'forward', 'reload', 'hardReload', 'stop'] as const) host.go('a', action)
    expect(c.navigationHistory.goBack).toHaveBeenCalled()
    expect(c.navigationHistory.goForward).toHaveBeenCalled()
    expect(c.reload).toHaveBeenCalled()
    expect(c.reloadIgnoringCache).toHaveBeenCalled()
    expect(c.stop).toHaveBeenCalled()
    host.find('a', 'needle', { forward: true, next: false })
    expect(c.findInPage).toHaveBeenLastCalledWith('needle', { forward: true, findNext: true })
    host.find('a', 'needle', { forward: false, next: true })
    expect(c.findInPage).toHaveBeenLastCalledWith('needle', { forward: false, findNext: false })
    host.stopFind('a')
    expect(c.stopFindInPage).toHaveBeenCalledWith('clearSelection')
    host.setZoom('a', 1.5)
    expect(c.zoom).toBe(1.5)
    host.setMuted('a', true)
    host.devtools('a')
    expect(c.openDevTools).toHaveBeenCalledWith({ mode: 'detach' })
    host.devtools('a')
    expect(c.closeDevTools).toHaveBeenCalled()
    host.print('a')
    expect(c.print).toHaveBeenCalled()
    for (const call of [
      () => host.load('x', 'u'),
      () => host.go('x', 'back'),
      () => host.find('x', 't', { forward: true, next: false }),
      () => host.stopFind('x'),
      () => host.setZoom('x', 2),
      () => host.setMuted('x', true),
      () => host.devtools('x'),
      () => host.print('x'),
      () => host.destroy('x')
    ])
      expect(call).not.toThrow()
  })

  it('shows native menus, gives the keyboard back to the UI and follows the light/dark mode', () => {
    const { host, win } = setup()
    const run = vi.fn()
    host.popup([{ label: 'One', run }, { separator: true }, { label: 'Two', enabled: false, run }, { label: 'Three', checked: true, run }])
    expect(h.menus[0].template).toEqual([
      { label: 'One', enabled: true, click: expect.any(Function) },
      { type: 'separator' },
      { label: 'Two', enabled: false, click: expect.any(Function) },
      { label: 'Three', enabled: true, click: expect.any(Function), type: 'checkbox', checked: true }
    ])
    ;(h.menus[0].template[0] as { click: () => void }).click()
    expect(run).toHaveBeenCalled()
    expect(h.menus[0].popup).toHaveBeenCalledWith({ window: win })
    host.focusUi()
    expect(win.webContents.focus).toHaveBeenCalled()
    host.setTheme('dark')
    expect(h.theme.themeSource).toBe('dark')
  })

  it('lets agents drive a tab over CDP, attaching on demand and letting go when idle', async () => {
    vi.useFakeTimers()
    const { host, open } = setup()
    expect(() => host.automation('none')).toThrow('The tab has no page loaded')
    const c = open('a').webContents
    const target = host.automation('a')
    expect(await target.cdp('DOM.getDocument', { depth: 0 })).toEqual({ method: 'DOM.getDocument' })
    expect(c.debugger.attach).toHaveBeenCalledWith('1.3')
    await target.cdp('Page.enable')
    expect(c.debugger.attach).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(c.debugger.detach).toHaveBeenCalled()
    // already detached (DevTools took over, …) or closed: nothing to let go of
    await target.cdp('Page.enable')
    c.debugger.attached = false
    vi.advanceTimersByTime(60_000)
    await target.cdp('Page.enable')
    c.destroyed = true
    vi.advanceTimersByTime(60_000)
    expect(c.debugger.detach).toHaveBeenCalledTimes(1)
    c.destroyed = false

    expect(await target.capture()).toEqual({ png: Buffer.from('png1280').toString('base64'), width: 1280, height: 800 })
    expect(c.capturePage).toHaveBeenCalledWith(undefined, { stayHidden: true })
    c.image = new FakeImage(3200, 2000)
    expect(await target.capture()).toMatchObject({ width: 1600, height: 1000 })
    // A picture for a phone: JPEG, narrowed to what it asks for (never widened).
    expect(await target.preview(900, 70)).toEqual({ jpeg: Buffer.from('jpeg70').toString('base64'), width: 900, height: 563 })
    c.image = new FakeImage(640, 400)
    expect(await target.preview(900, 60)).toEqual({ jpeg: Buffer.from('jpeg60').toString('base64'), width: 640, height: 400 })
  })

  it('closes views with their tabs — also after the window is gone — and lets go of everything on dispose', () => {
    vi.useFakeTimers()
    const { win, host, open } = setup()
    const a = open('a')
    void host.automation('a').cdp('Page.enable')
    host.destroy('a')
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(a)
    expect(a.webContents.close).toHaveBeenCalled()
    const b = open('b')
    const c = open('c')
    c.webContents.destroyed = true
    win.destroyed = true
    host.dispose()
    expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1)
    expect(b.webContents.close).toHaveBeenCalled()
    expect(c.webContents.close).not.toHaveBeenCalled()
    expect(win.webContents.removeListener).not.toHaveBeenCalled()

    const again = setup()
    again.host.dispose()
    expect(again.win.webContents.removeListener).toHaveBeenCalledWith('before-input-event', expect.any(Function))
  })
})

describe('the browser host · what pages report', () => {
  it('forwards loading, navigation, titles, failures, crashes, sound, zoom, find and console', () => {
    const { ev, host, open } = setup()
    const c = open('a').webContents
    c.emit('did-start-loading')
    c.emit('did-stop-loading')
    expect(ev.loading.mock.calls).toEqual([['a', true], ['a', false]])
    c.canBack = true
    c.emit('did-navigate', {}, 'https://a.dev/next')
    expect(ev.navigated).toHaveBeenLastCalledWith('a', { url: 'https://a.dev/next', canGoBack: true, canGoForward: false })
    host.setZoom('a', 1.25)
    c.zoom = 1
    c.emit('did-navigate', {}, 'https://a.dev/other')
    expect(c.zoom).toBe(1.25) // the user's zoom stays with the tab
    c.emit('did-navigate-in-page', {}, 'https://a.dev/other#x', true)
    expect(ev.navigated).toHaveBeenLastCalledWith('a', { url: 'https://a.dev/other#x', canGoBack: true, canGoForward: false, inPage: true })
    c.emit('did-navigate-in-page', {}, 'https://ads.dev/frame#y', false)
    expect(ev.navigated).toHaveBeenCalledTimes(3)
    c.emit('page-title-updated', {}, 'Other')
    expect(ev.title).toHaveBeenCalledWith('a', 'Other')
    expect(ev.title).toHaveBeenCalledTimes(1) // a new entry has no title of its own yet
    // a page that comes back (restored, reloaded) with the title it had: Chromium reports none — its entry has it
    c.entries = [{ url: 'https://a.dev/next', title: 'Next' }]
    c.activeIndex = 0
    c.emit('did-navigate', {}, 'https://a.dev/next')
    expect(ev.title).toHaveBeenLastCalledWith('a', 'Next')
    c.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://x.dev/', true)
    c.emit('did-fail-load', {}, -3, 'ABORTED', 'https://x.dev/', true)
    c.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://ads.dev/', false)
    expect(ev.failed.mock.calls).toEqual([['a', { code: -105, description: 'NAME_NOT_RESOLVED', url: 'https://x.dev/' }]])
    c.emit('render-process-gone')
    expect(ev.crashed).toHaveBeenCalledWith('a')
    c.emit('audio-state-changed', { audible: true })
    expect(ev.audible).toHaveBeenCalledWith('a', true)
    c.emit('zoom-changed', {}, 'in')
    expect(ev.zoomed).toHaveBeenCalledWith('a', 'in')
    c.emit('found-in-page', {}, { activeMatchOrdinal: 2, matches: 5 })
    expect(ev.found).toHaveBeenCalledWith({ tabId: 'a', active: 2, matches: 5 })
    c.emit('console-message', { level: 'error', message: 'boom', sourceId: 'http://a.dev/app.js', lineNumber: 3 })
    c.emit('console-message', { level: 'info', message: 'hi', sourceId: '', lineNumber: 0 })
    expect(ev.console.mock.calls.map(([, e]) => e)).toEqual([
      { level: 'error', message: 'boom', source: 'http://a.dev/app.js', line: 3, at: expect.any(String) },
      { level: 'info', message: 'hi', at: expect.any(String) }
    ])
  })

  it('carries favicons as small pictures fetched in the page profile — never HTML, never huge', async () => {
    const { ev, open } = setup()
    const c = open('a').webContents
    const last = () => ev.favicon.mock.calls.at(-1)
    c.emit('page-favicon-updated', {}, [])
    expect(last()).toEqual(['a', undefined])
    c.emit('page-favicon-updated', {}, ['data:image/png;base64,abc'])
    expect(last()).toEqual(['a', 'data:image/png;base64,abc'])
    c.emit('page-favicon-updated', {}, [`data:image/png;base64,${'x'.repeat(50_000)}`])
    expect(last()).toEqual(['a', undefined])

    const response = (body: string, type: string | null, ok = true) => ({ ok, headers: { get: () => type }, arrayBuffer: async () => new TextEncoder().encode(body).buffer })
    h.fetch.mockResolvedValueOnce(response('ICON', 'image/png; charset=binary'))
    c.emit('page-favicon-updated', {}, ['https://a.dev/favicon.png'])
    await vi.waitFor(() => expect(last()).toEqual(['a', `data:image/png;base64,${Buffer.from('ICON').toString('base64')}`]))
    const before = ev.favicon.mock.calls.length
    h.fetch.mockResolvedValueOnce(response('<html>', 'text/html'))
    c.emit('page-favicon-updated', {}, ['https://a.dev/favicon.ico'])
    h.fetch.mockResolvedValueOnce(response('', null)) // no type: an icon; no bytes: nothing
    c.emit('page-favicon-updated', {}, ['https://a.dev/empty.ico'])
    h.fetch.mockResolvedValueOnce(response('x'.repeat(40_000), 'image/x-icon'))
    c.emit('page-favicon-updated', {}, ['https://a.dev/huge.ico'])
    h.fetch.mockResolvedValueOnce(response('ICON', 'image/png', false))
    c.emit('page-favicon-updated', {}, ['https://a.dev/404.png'])
    h.fetch.mockRejectedValueOnce(new Error('offline'))
    c.emit('page-favicon-updated', {}, ['https://a.dev/offline.png'])
    await new Promise((r) => setTimeout(r, 10))
    expect(ev.favicon.mock.calls.length).toBe(before)
  })

  it('keeps sign-in popups as real windows and makes every other new window a tab', () => {
    const { ev, open } = setup()
    const c = open('a').webContents
    expect(c.openHandler!({ url: 'https://accounts.google.com/o/oauth2', disposition: 'new-window', features: 'width=500,height=600' })).toEqual({
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        width: 500,
        height: 600,
        autoHideMenuBar: true,
        webPreferences: { partition: 'persist:mindeck-browser', sandbox: true, contextIsolation: true, nodeIntegration: false }
      }
    })
    expect(c.openHandler!({ url: 'about:blank', disposition: 'new-window', features: 'popup' })).toMatchObject({ action: 'allow' })
    expect(c.openHandler!({ url: 'https://b.dev/', disposition: 'foreground-tab', features: '' })).toEqual({ action: 'deny' })
    expect(c.openHandler!({ url: 'https://c.dev/', disposition: 'background-tab', features: '' })).toEqual({ action: 'deny' })
    expect(c.openHandler!({ url: 'file:///etc/passwd', disposition: 'new-window', features: '' })).toEqual({ action: 'deny' })
    expect(ev.openTab.mock.calls).toEqual([
      ['https://b.dev/', { background: false, opener: 'a' }],
      ['https://c.dev/', { background: true, opener: 'a' }]
    ])
    // what the popup opens itself becomes a tab
    const child = { webContents: new FakeContents() }
    c.emit('did-create-window', child)
    expect(child.webContents.openHandler!({ url: 'https://docs.dev/' })).toEqual({ action: 'deny' })
    expect(child.webContents.openHandler!({ url: 'javascript:1' })).toEqual({ action: 'deny' })
    expect(ev.openTab).toHaveBeenLastCalledWith('https://docs.dev/', { background: false })
    expect(ev.openTab).toHaveBeenCalledTimes(3)
  })

  it('takes the browser keys from the page and from the UI while the browser is on screen', () => {
    const { win, ev, host, open } = setup()
    const c = open('a').webContents
    const reload = { preventDefault: vi.fn() }
    c.emit('before-input-event', reload, key('r', { meta: process.platform === 'darwin', control: process.platform !== 'darwin' }))
    expect(reload.preventDefault).toHaveBeenCalled()
    expect(ev.shortcut).toHaveBeenLastCalledWith('reload', 'a')
    const typing = { preventDefault: vi.fn() }
    c.emit('before-input-event', typing, key('a'))
    expect(typing.preventDefault).not.toHaveBeenCalled()

    const fromUi = { preventDefault: vi.fn() }
    win.webContents.emit('before-input-event', fromUi, key('F5'))
    expect(fromUi.preventDefault).not.toHaveBeenCalled() // the browser is not on screen: Mindeck's keys stay Mindeck's
    host.setBounds({ x: 0, y: 0, width: 1, height: 1 })
    win.webContents.emit('before-input-event', fromUi, key('F5'))
    expect(fromUi.preventDefault).toHaveBeenCalled()
    expect(ev.shortcut).toHaveBeenLastCalledWith('reload')
    win.webContents.emit('before-input-event', typing, key('x'))
    expect(typing.preventDefault).not.toHaveBeenCalled()

    // Next to another module: the browser's keys only while its pane has the focus
    const elsewhere = { preventDefault: vi.fn() }
    host.setBounds({ x: 0, y: 0, width: 1, height: 1 }, false)
    win.webContents.emit('before-input-event', elsewhere, key('F5'))
    expect(elsewhere.preventDefault).not.toHaveBeenCalled()
    c.emit('before-input-event', elsewhere, key('F5')) // the page itself has the keyboard: its keys
    expect(elsewhere.preventDefault).toHaveBeenCalled()

    c.emit('focus') // a click into the page
    expect(ev.focused).toHaveBeenCalledWith('a')

    // full screen from a page, exactly once (the menu does not see the key)
    const full = { preventDefault: vi.fn() }
    c.emit('before-input-event', full, process.platform === 'darwin' ? key('f', { meta: true, control: true }) : key('F11'))
    expect(full.preventDefault).toHaveBeenCalled()
    expect(win.setFullScreen).toHaveBeenLastCalledWith(true)
    c.emit('before-input-event', full, process.platform === 'darwin' ? key('f', { meta: true, control: true }) : key('F11'))
    expect(win.setFullScreen).toHaveBeenLastCalledWith(false)
    expect(ev.shortcut).not.toHaveBeenCalledWith('find', 'a')
  })

  it('hands the workspace’s keys from a page to the Mindeck UI (a page would swallow them)', () => {
    const { win, ev, open } = setup()
    const c = open('a').webContents
    const mac = process.platform === 'darwin'
    const pane = { preventDefault: vi.fn() }
    c.emit('before-input-event', pane, { ...key('ArrowLeft', { meta: mac, control: !mac, alt: true }), code: 'ArrowLeft' })
    expect(pane.preventDefault).toHaveBeenCalled()
    expect(win.webContents.focus).toHaveBeenCalled()
    expect(ev.workspaceKey).toHaveBeenCalledWith({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: mac, ctrlKey: !mac, altKey: true, shiftKey: false })
    expect(ev.shortcut).not.toHaveBeenCalled() // not the browser's previous tab any more
  })

  it('builds the page context menu and does what each entry says', () => {
    const { ev, open } = setup()
    const c = open('a').webContents
    c.canBack = true
    const params = {
      x: 5,
      y: 6,
      linkURL: 'https://link.dev/',
      srcURL: 'https://img.dev/a.png',
      mediaType: 'image',
      selectionText: '',
      isEditable: true,
      misspelledWord: 'teh',
      dictionarySuggestions: ['the'],
      editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
    }
    c.emit('context-menu', {}, params)
    const template = h.menus.at(-1)!.template as { label?: string; click?: () => void }[]
    const click = (label: string) => template.find((t) => t.label === label)!.click!()
    for (const label of ['the', 'Add to Dictionary', 'Open Link in New Tab', 'Open in Arc', 'Copy Link Address', 'Open Image in New Tab', 'Save Image', 'Copy Image', 'Copy Image Address', 'Cut', 'Copy', 'Paste', 'Select All', 'Send to Agent…', 'Inspect'])
      click(label)
    expect(c.replaceMisspelling).toHaveBeenCalledWith('the')
    expect(c.session.addWordToSpellCheckerDictionary).toHaveBeenCalledWith('teh')
    expect(ev.openTab.mock.calls).toEqual([
      ['https://link.dev/', { background: true, opener: 'a' }],
      ['https://img.dev/a.png', { background: true, opener: 'a' }]
    ])
    expect(h.openExternal).toHaveBeenCalledWith('https://link.dev/')
    expect(h.clipboard.mock.calls).toEqual([['https://link.dev/'], ['https://img.dev/a.png']])
    expect(c.downloadURL).toHaveBeenCalledWith('https://img.dev/a.png')
    expect(c.copyImageAt).toHaveBeenCalledWith(5, 6)
    for (const m of ['cut', 'copy', 'paste', 'selectAll'] as const) expect(c[m]).toHaveBeenCalled()
    expect(ev.command).toHaveBeenCalledWith('a', 'sendToAgent')
    expect(c.inspectElement).toHaveBeenCalledWith(5, 6)

    // on the page itself: back, forward, reload; a selection: search for it
    c.emit('context-menu', {}, { ...params, linkURL: '', srcURL: '', mediaType: 'none', isEditable: false, misspelledWord: '' })
    const page = h.menus.at(-1)!.template as { label?: string; click?: () => void; enabled?: boolean }[]
    for (const label of ['Back', 'Forward', 'Reload']) page.find((t) => t.label === label)!.click!()
    expect(c.navigationHistory.goBack).toHaveBeenCalled()
    expect(c.navigationHistory.goForward).toHaveBeenCalled()
    expect(c.reload).toHaveBeenCalled()
    expect(page.find((t) => t.label === 'Forward')!.enabled).toBe(false)
    c.emit('context-menu', {}, { ...params, linkURL: '', srcURL: '', mediaType: 'none', isEditable: false, misspelledWord: '', selectionText: 'mindeck' })
    const selection = h.menus.at(-1)!.template as { label?: string; click?: () => void }[]
    selection.find((t) => t.label === 'Search Google for “mindeck”')!.click!()
    expect(ev.command).toHaveBeenLastCalledWith('a', 'search', 'mindeck')
    selection.find((t) => t.label === 'Copy')!.click!()
    expect(c.copy).toHaveBeenCalledTimes(2)
  })
})

describe('the browser host · helpers', () => {
  it('sizes popups from window.open features, within reason', () => {
    expect(popupSize('width=500,height=600')).toEqual({ width: 500, height: 600 })
    expect(popupSize('popup, Height = 9000')).toEqual({ width: 520, height: 1600 })
    expect(popupSize('width=10')).toEqual({ width: 320, height: 680 })
    expect(popupSize('')).toEqual({ width: 520, height: 680 })
  })

  it('turns the core’s menu entries into native items', () => {
    const entries: MenuEntry[] = [{ separator: true }]
    expect(menuTemplate(entries)).toEqual([{ type: 'separator' }])
  })

  it('configures the browser profile once, however many windows come and go — and asks the current one', () => {
    const first = setup()
    const { ev, open } = setup()
    first.host.dispose() // an older window going away leaves the current one asked
    expect(h.uaSets).toBe(1)
    expect(h.partitions.every((p) => p === 'persist:mindeck-browser')).toBe(true)
    // the profile's questions go to the window open now, naming the tab they come from
    const view = open('a')
    h.permissionHandler!(view.webContents, 'notifications', vi.fn(), { requestingUrl: 'https://a.dev/x' })
    h.permissionHandler!({ other: true }, 'notifications', vi.fn(), { requestingUrl: 'https://popup.dev/' })
    expect(ev.permission.mock.calls.map(([ask]) => ask)).toEqual([
      { tabId: 'a', origin: 'https://a.dev', kind: 'notifications' },
      { tabId: undefined, origin: 'https://popup.dev', kind: 'notifications' }
    ])
  })
})

describe('the browser profile (session)', () => {
  type SessionModule = typeof import('../../../electron/main/platform/browser/session')
  let s: SessionModule
  let electron: typeof import('electron')
  const realPlatform = process.platform
  beforeAll(async () => {
    s = await import('../../../electron/main/platform/browser/session')
    electron = await import('electron')
    // Electron's Chromium version (Node has none)
    ;(process.versions as Record<string, string>).chrome = '141.0.7390.54'
  })
  afterAll(() => delete (process.versions as Record<string, string | undefined>).chrome)
  afterEach(() => Object.defineProperty(process, 'platform', { value: realPlatform }))

  /** A session that keeps the handlers Mindeck installs. */
  function profile() {
    const p = {
      ua: 'Mozilla/5.0 (X11) AppleWebKit/537.36 (KHTML, like Gecko) Mindeck/1.0.0 Chrome/141.0.1.2 Electron/44.0.0 Safari/537.36',
      sets: 0,
      request: undefined as undefined | ((...a: unknown[]) => void),
      check: undefined as undefined | ((...a: unknown[]) => boolean),
      display: undefined as undefined | ((...a: unknown[]) => void),
      displayOpts: undefined as unknown,
      download: undefined as undefined | ((...a: unknown[]) => void),
      verify: undefined as undefined | ((request: { hostname: string }, cb: (n: number) => void) => void),
      getUserAgent: () => p.ua,
      setUserAgent: (ua: string) => {
        p.sets += 1
        p.ua = ua
      },
      setPermissionRequestHandler: (fn: (...a: unknown[]) => void) => (p.request = fn),
      setPermissionCheckHandler: (fn: (...a: unknown[]) => boolean) => (p.check = fn),
      setDisplayMediaRequestHandler: (fn: (...a: unknown[]) => void, opts: unknown) => ((p.display = fn), (p.displayOpts = opts)),
      on: (_event: string, fn: (...a: unknown[]) => void) => (p.download = fn),
      persistent: true,
      isPersistent: () => p.persistent,
      setCertificateVerifyProc: (fn: (request: { hostname: string }, cb: (n: number) => void) => void) => (p.verify = fn),
      headers: undefined as undefined | ((details: { url: string; requestHeaders: Record<string, string> }, cb: (r: unknown) => void) => void),
      headerFilter: undefined as unknown,
      webRequest: {
        onBeforeRequest: vi.fn(),
        onBeforeSendHeaders: (filter: unknown, fn: (details: { url: string; requestHeaders: Record<string, string> }, cb: (r: unknown) => void) => void) => ((p.headerFilter = filter), (p.headers = fn))
      },
      preloads: [] as unknown[],
      registerPreloadScript: (script: unknown) => p.preloads.push(script)
    }
    return p
  }

  it('passes as Chrome: no Electron, no app token, a reduced version', () => {
    expect(s.chromeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) mindeck/0.1.0 Chrome/140.0.7339.41 Electron/44.7.2 Safari/537.36')).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    )
  })

  it('decides what a page may do on its own, and what the user is asked', () => {
    for (const p of ['fullscreen', 'automatic-fullscreen', 'pointerLock', 'keyboardLock', 'clipboard-sanitized-write', 'persistent-storage']) expect(s.decide(p)).toBe(true)
    expect(s.decide('media', ['video'])).toBe('camera')
    expect(s.decide('media', ['audio'])).toBe('microphone')
    expect(s.decide('media', ['video', 'audio'])).toBe('media')
    expect(s.decide('media')).toBe('media')
    expect(s.decide('notifications')).toBe('notifications')
    expect(s.decide('geolocation')).toBe('geolocation')
    expect(s.decide('geolocation-approximate')).toBe('geolocation')
    expect(s.decide('clipboard-read')).toBe('clipboard')
    expect(s.decide('display-capture')).toBe('screen')
    expect(s.decide('openExternal')).toBe('external')
    expect(s.decide('usb')).toBe(false)
  })

  it('names downloads like Finder and marks them for Gatekeeper on macOS', async () => {
    const { tempDir } = await import('./helpers')
    const { writeFile } = await import('node:fs/promises')
    const dir = await tempDir()
    expect(s.freeDownloadPath(dir, 'a.zip')).toBe(`${dir}/a.zip`)
    await writeFile(`${dir}/a.zip`, '')
    await writeFile(`${dir}/a 2.zip`, '')
    expect(s.freeDownloadPath(dir, 'a.zip')).toBe(`${dir}/a 3.zip`)
    expect(s.freeDownloadPath(dir, '')).toBe(`${dir}/download`)
    expect(s.freeDownloadPath(dir, '../../evil.sh')).toBe(`${dir}/evil.sh`)

    const run = vi.fn()
    Object.defineProperty(process, 'platform', { value: 'linux' })
    s.quarantine('/d/a.zip', 'https://a.dev/a.zip', run as never)
    expect(run).not.toHaveBeenCalled()
    // Windows: the Mark of the Web (SmartScreen, Protected View) — the web address without credentials, else the internet zone.
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const write = vi.fn(async () => {})
    s.quarantine('C:\\D\\a.exe', 'https://user:pw@a.dev/dl/a.exe?v=1#x', run as never, write)
    s.quarantine('C:\\D\\b.exe', 'blob:https://a.dev/1234', run as never, write)
    s.quarantine('C:\\D\\c.exe', 'not a url', run as never, write)
    expect(write.mock.calls).toEqual([
      ['C:\\D\\a.exe:Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://a.dev/dl/a.exe?v=1\r\n'],
      ['C:\\D\\b.exe:Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=about:internet\r\n'],
      ['C:\\D\\c.exe:Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=about:internet\r\n']
    ])
    expect(run).not.toHaveBeenCalled()
    // A disk without streams refuses: nothing breaks.
    s.quarantine('C:\\D\\d.exe', 'https://a.dev/', run as never, async () => Promise.reject(new Error('EINVAL')))
    // The real file system (here: a file whose name ends in the stream's).
    s.quarantine(`${dir}/e.exe`, 'https://a.dev/e.exe')
    await vi.waitFor(async () => expect((await import('node:fs')).existsSync(`${dir}/e.exe:Zone.Identifier`)).toBe(true))
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    s.quarantine('/d/a.zip', 'https://a.dev/a.zip', run as never)
    expect(run).toHaveBeenLastCalledWith('xattr', ['-p', 'com.apple.quarantine', '/d/a.zip'], expect.any(Function))
    ;(run.mock.calls[0][2] as (err: Error | null) => void)(new Error('no such xattr'))
    expect(run).toHaveBeenLastCalledWith('xattr', ['-w', 'com.apple.quarantine', expect.stringMatching(/^0081;[0-9a-f]+;Mindeck;[0-9A-F-]{36}$/), '/d/a.zip'], expect.any(Function))
    ;(run.mock.calls[1][2] as () => void)()
    run.mockClear()
    s.quarantine('/d/b.zip', 'https://a.dev/b.zip', run as never)
    ;(run.mock.calls[0][2] as (err: Error | null) => void)(null) // Chromium marked it already
    expect(run).toHaveBeenCalledTimes(1)
    s.quarantine('/d/c.zip', 'https://a.dev/c.zip') // the real execFile (mocked here)
    expect(h.exec).toHaveBeenCalledWith('xattr', ['-p', 'com.apple.quarantine', '/d/c.zip'], expect.any(Function))
  })

  it('asks the user for what is sensitive — and macOS for camera and microphone', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const p = profile()
    const ev = events()
    let current: SessionTarget | null = { events: ev, tabOf: () => 'tab', takeSaveAs: () => false }
    s.configureBrowserSession(p as never, () => current)
    s.configureBrowserSession(p as never, () => current)
    expect(p.sets).toBe(1)
    expect(p.ua).toBe('Mozilla/5.0 (X11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36')
    // Chrome's client hints on every https request, and the page preload that makes navigator.userAgentData agree
    expect(p.headerFilter).toEqual({ urls: ['https://*/*'] })
    const sent = vi.fn()
    p.headers!({ url: 'https://accounts.google.com/signin', requestHeaders: { Accept: '*/*', 'sec-ch-ua': '"Chromium";v="1"' } }, sent)
    const headers = (sent.mock.calls[0][0] as { requestHeaders: Record<string, string> }).requestHeaders
    expect(headers).toMatchObject({ Accept: '*/*', 'sec-ch-ua-platform': '"macOS"', 'sec-ch-ua-mobile': '?0' })
    expect(headers['sec-ch-ua']).toContain('"Google Chrome"')
    expect(headers['sec-ch-ua-full-version-list']).toContain('"Google Chrome";v="141.0.7390.54"')
    expect(p.preloads).toEqual([{ id: 'mindeck-browser-page', type: 'frame', filePath: expect.stringMatching(/preload[\\/]browserPage\.js$/) }])

    const cb = vi.fn()
    p.request!({}, 'fullscreen', cb, { requestingUrl: 'https://a.dev/' })
    p.request!({}, 'usb', cb, { requestingUrl: 'https://a.dev/' })
    expect(cb.mock.calls).toEqual([[true], [false]])

    const ask = async (permission: string, details: Record<string, unknown>, allow: boolean) => {
      const answer = vi.fn()
      p.request!({}, permission, answer, details)
      const respond = ev.permission.mock.calls.at(-1)![1] as (allow: boolean) => void
      respond(allow)
      await vi.waitFor(() => expect(answer).toHaveBeenCalled())
      return answer.mock.calls[0][0]
    }
    expect(await ask('notifications', { requestingUrl: 'https://a.dev/x' }, false)).toBe(false)
    expect(ev.permission.mock.calls.at(-1)![0]).toEqual({ tabId: 'tab', origin: 'https://a.dev', kind: 'notifications' })
    expect(await ask('notifications', { requestingUrl: 'https://a.dev/x' }, true)).toBe(true)

    const media = vi.mocked(electron.systemPreferences.askForMediaAccess)
    media.mockResolvedValue(true)
    expect(await ask('media', { requestingUrl: 'https://meet.dev/', securityOrigin: 'https://meet.dev/', mediaTypes: ['video', 'audio'] }, true)).toBe(true)
    expect(media.mock.calls).toEqual([['camera'], ['microphone']])
    expect(ev.permission.mock.calls.at(-1)![0]).toMatchObject({ origin: 'https://meet.dev', kind: 'media' })
    media.mockResolvedValueOnce(false)
    expect(await ask('media', { requestingUrl: 'https://meet.dev/', mediaTypes: ['video'] }, true)).toBe(false)
    media.mockResolvedValueOnce(true)
    expect(await ask('media', { requestingUrl: 'https://meet.dev/', mediaTypes: ['audio'] }, true)).toBe(true)
    expect(media).toHaveBeenLastCalledWith('microphone')
    media.mockRejectedValueOnce(new Error('TCC'))
    expect(await ask('media', { requestingUrl: 'https://meet.dev/', mediaTypes: ['audio'] }, true)).toBe(false)
    Object.defineProperty(process, 'platform', { value: 'linux' })
    media.mockClear()
    expect(await ask('media', { requestingUrl: 'https://meet.dev/', mediaTypes: ['video'] }, true)).toBe(true)
    expect(media).not.toHaveBeenCalled()

    // links for other apps: only when something here opens them
    const external = vi.fn()
    p.request!({}, 'openExternal', external, { requestingUrl: 'https://a.dev/' })
    p.request!({}, 'openExternal', external, { requestingUrl: 'https://a.dev/', externalURL: undefined })
    h.appName = ''
    p.request!({}, 'openExternal', external, { requestingUrl: 'https://a.dev/', externalURL: 'unknown://x' })
    expect(external.mock.calls).toEqual([[false], [false], [false]])
    h.appName = 'zoom.us'
    p.request!({}, 'openExternal', external, { requestingUrl: 'https://a.dev/', externalURL: 'zoommtg://join' })
    expect(ev.permission.mock.calls.at(-1)![0]).toEqual({ tabId: 'tab', origin: 'https://a.dev', kind: 'external', target: 'zoommtg://join', app: 'zoom.us' })
    h.appName = 'Arc'

    // no window: nothing to ask, so no
    current = null
    const none = vi.fn()
    p.request!({}, 'notifications', none, { requestingUrl: 'https://a.dev/' })
    expect(none).toHaveBeenCalledWith(false)
  })

  it('answers Chromium’s quick checks from what was remembered', () => {
    const p = profile()
    const ev = events()
    let current: SessionTarget | null = { events: ev, tabOf: () => 'tab', takeSaveAs: () => false }
    s.configureBrowserSession(p as never, () => current)
    expect(p.check!(null, 'fullscreen', 'https://a.dev', {})).toBe(true)
    expect(p.check!(null, 'usb', 'https://a.dev', {})).toBe(false)
    ev.permissionCheck.mockReturnValue(true)
    expect(p.check!(null, 'media', 'https://a.dev/', { mediaType: 'video' })).toBe(true)
    expect(ev.permissionCheck).toHaveBeenLastCalledWith('https://a.dev', 'camera')
    expect(p.check!(null, 'notifications', 'https://a.dev', {})).toBe(true)
    current = null
    expect(p.check!(null, 'notifications', 'https://a.dev', {})).toBe(false)
  })

  it('shares the screen with the system picker, or the whole screen after asking', async () => {
    const p = profile()
    const ev = events()
    let current: SessionTarget | null = { events: ev, tabOf: () => 'tab', takeSaveAs: () => false }
    s.configureBrowserSession(p as never, () => current)
    expect(p.displayOpts).toEqual({ useSystemPicker: true })
    const share = async (allow: boolean) => {
      const cb = vi.fn()
      p.display!({ securityOrigin: 'https://meet.dev/' }, cb)
      ;(ev.permission.mock.calls.at(-1)![1] as (a: boolean) => void)(allow)
      await vi.waitFor(() => expect(cb).toHaveBeenCalled())
      return cb.mock.calls[0][0]
    }
    const sources = vi.mocked(electron.desktopCapturer.getSources)
    expect(await share(false)).toBeNull()
    sources.mockResolvedValueOnce([{ id: 'screen:1' } as never])
    expect(await share(true)).toEqual({ video: { id: 'screen:1' } })
    expect(ev.permission.mock.calls.at(-1)![0]).toEqual({ origin: 'https://meet.dev', kind: 'screen' })
    sources.mockResolvedValueOnce([])
    expect(await share(true)).toBeNull()
    sources.mockRejectedValueOnce(new Error('no screen recording permission'))
    expect(await share(true)).toBeNull()
    current = null
    const cb = vi.fn()
    p.display!({ securityOrigin: 'https://meet.dev/' }, cb)
    expect(cb).toHaveBeenCalledWith(null)
  })

  it('saves downloads under free names, reports progress a few times a second, and quarantines finished ones', () => {
    vi.useFakeTimers()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const p = profile()
    const ev = events()
    let current: SessionTarget | null = { events: ev, tabOf: () => 'tab', takeSaveAs: () => false }
    s.configureBrowserSession(p as never, () => current)
    const item = () => {
      const handlers: Record<string, (...a: unknown[]) => void> = {}
      return {
        handlers,
        received: 0,
        getFilename: () => 'report.pdf',
        setSavePath: vi.fn(),
        getSavePath: () => '/Downloads/report.pdf',
        getURL: () => 'https://a.dev/report.pdf',
        getTotalBytes: () => 100,
        getReceivedBytes() {
          return this.received
        },
        on: (event: string, fn: (...a: unknown[]) => void) => (handlers[event] = fn),
        once: (event: string, fn: (...a: unknown[]) => void) => (handlers[event] = fn),
        cancel: vi.fn()
      }
    }
    vi.setSystemTime(10_000)
    const d = item()
    p.download!({}, d, {})
    expect(d.setSavePath).toHaveBeenCalledWith('/Downloads/report.pdf')
    const [started, control] = ev.download.mock.calls[0]
    expect(started).toMatchObject({ filename: 'report.pdf', path: '/Downloads/report.pdf', url: 'https://a.dev/report.pdf', state: 'progressing', received: 0, total: 100 })
    control.cancel()
    expect(d.cancel).toHaveBeenCalled()
    d.received = 10
    d.handlers.updated({}, 'progressing')
    d.received = 20
    d.handlers.updated({}, 'progressing') // within 250 ms: skipped
    d.handlers.updated({}, 'interrupted') // always reported
    vi.setSystemTime(10_400)
    d.handlers.updated({}, 'progressing')
    expect(ev.downloadUpdated.mock.calls.map(([x]) => `${x.state}:${x.received}`)).toEqual(['progressing:10', 'interrupted:20', 'progressing:20'])
    d.received = 100
    d.handlers.done({}, 'completed')
    expect(ev.downloadUpdated).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'completed', received: 100 }))
    expect(h.exec).toHaveBeenCalledWith('xattr', ['-p', 'com.apple.quarantine', '/Downloads/report.pdf'], expect.any(Function))
    const cancelled = item()
    p.download!({}, cancelled, {})
    h.exec.mockClear()
    cancelled.handlers.done({}, 'cancelled')
    expect(h.exec).not.toHaveBeenCalled()
    expect(started).not.toHaveProperty('private')
    // a private tab's profile (in memory): its downloads say so — they are never written down
    const priv = profile()
    priv.persistent = false
    s.configureBrowserSession(priv as never, () => current)
    priv.download!({}, item(), {})
    expect(ev.download.mock.calls.at(-1)![0]).toMatchObject({ filename: 'report.pdf', private: true })
    // the window went away mid-download: nothing to tell
    current = null
    const orphan = item()
    p.download!({}, orphan, {})
    orphan.handlers.updated({}, 'interrupted')
    orphan.handlers.done({}, 'cancelled')
  })

  it('trusts local dev certificates only', () => {
    const p = profile()
    s.configureBrowserSession(p as never, () => null)
    const cb = vi.fn()
    p.verify!({ hostname: 'localhost' }, cb)
    p.verify!({ hostname: 'shop.localhost' }, cb)
    p.verify!({ hostname: 'example.com' }, cb)
    expect(cb.mock.calls).toEqual([[0], [0], [-3]])
  })
})

describe('the browser keys', () => {
  let match: typeof import('../../../electron/main/platform/browser/shortcuts').matchShortcut
  let fullScreen: typeof import('../../../electron/main/platform/browser/shortcuts').isFullScreenKey
  beforeAll(async () => {
    ;({ matchShortcut: match, isFullScreenKey: fullScreen } = await import('../../../electron/main/platform/browser/shortcuts'))
  })
  const k = (keyName: string, mods: Partial<Record<'meta' | 'control' | 'alt' | 'shift', boolean>> = {}, type = 'keyDown') => ({ ...key(keyName, mods), type })

  it('full screen is ⌃⌘F on macOS and F11 elsewhere', () => {
    expect(fullScreen(k('f', { meta: true, control: true }), true)).toBe(true)
    expect(fullScreen(k('F', { meta: true, control: true }), true)).toBe(true)
    expect(fullScreen(k('f', { meta: true }), true)).toBe(false) // find
    expect(fullScreen(k('f', { control: true }), true)).toBe(false)
    expect(fullScreen(k('F11'), true)).toBe(false)
    expect(fullScreen(k('F11'), false)).toBe(true)
    expect(fullScreen(k('F11', { control: true }), false)).toBe(false)
    expect(fullScreen(k('F11', { meta: true }), false)).toBe(false)
    expect(fullScreen(k('F11', { shift: true }), false)).toBe(false)
    expect(fullScreen(k('F11', { alt: true }), false)).toBe(false)
    expect(fullScreen(k('F11', {}, 'keyUp'), false)).toBe(false)
    expect(fullScreen(k('F10'), false)).toBe(false)
  })

  it('are Chrome’s keys with ⌘ on macOS', () => {
    const cmd = { meta: true }
    const table: [ReturnType<typeof k> & { code?: string }, string | null][] = [
      [k('t', cmd), 'newTab'],
      [k('W', cmd), 'closeTab'],
      [k('l', cmd), 'focusOmnibox'],
      [k('r', cmd), 'reload'],
      [k('f', cmd), 'find'],
      [k('p', cmd), 'print'],
      [k('[', cmd), 'back'],
      [k(']', cmd), 'forward'],
      [k('=', cmd), 'zoomIn'],
      [k('+', cmd), 'zoomIn'],
      [k('-', cmd), 'zoomOut'],
      [k('0', cmd), 'zoomReset'],
      [k('9', cmd), 'lastTab'],
      [k('3', cmd), 'tab3'],
      [k('x', cmd), null],
      [k('t', { meta: true, shift: true }), 'reopenTab'],
      [k('r', { meta: true, shift: true }), 'hardReload'],
      [k('+', { meta: true, shift: true }), 'zoomIn'],
      [k('=', { meta: true, shift: true }), 'zoomIn'],
      [k('}', { meta: true, shift: true }), 'nextTab'],
      [k(']', { meta: true, shift: true }), 'nextTab'],
      [k('{', { meta: true, shift: true }), 'prevTab'],
      [k('[', { meta: true, shift: true }), 'prevTab'],
      [k('i', { meta: true, shift: true }), null],
      [k('q', { meta: true, shift: true }), null],
      // ⌘⌥←/→ move between the workspace's panes
      [k('ArrowRight', { meta: true, alt: true }), null],
      [k('ArrowLeft', { meta: true, alt: true }), null],
      [k('i', { meta: true, alt: true }), 'devtools'],
      [k('ˆ', { meta: true, alt: true }), 'devtools'],
      [k('x', { meta: true, alt: true }), null],
      [k('d', cmd), 'bookmark'],
      [k('y', cmd), 'history'],
      [k('h', cmd), null],
      [k('A', { meta: true, shift: true }), 'tabSearch'],
      [k('P', { meta: true, shift: true }), 'palette'],
      [k('B', { meta: true, shift: true }), 'bookmarksBar'],
      [k('o', { meta: true, shift: true }), null],
      [k('G', { meta: true, shift: true }), 'newGroup'],
      [k('D', { meta: true, shift: true }), 'split'],
      [k('<', { meta: true, shift: true }), 'verticalTabs'],
      [k(',', { meta: true, shift: true }), 'verticalTabs'],
      [{ ...k(';', { meta: true, shift: true }), code: 'Comma' }, 'verticalTabs'],
      [k(';', { meta: true, shift: true }), null],
      [k('b', { meta: true, alt: true }), 'bookmarkManager'],
      [k('∫', { meta: true, alt: true }), 'bookmarkManager'],
      [k('Tab', { control: true }), 'nextTab'],
      [k('Tab', { control: true, shift: true }), 'prevTab'],
      [k('F5'), 'reload'],
      [k('F5', { shift: true }), 'hardReload'],
      [k('F5', cmd), 'hardReload'],
      [k('t', { meta: true, control: true }), null],
      [k('ArrowLeft', { alt: true }), null], // macOS: ⌥← moves by word
      [k('t'), null],
      [k('t', cmd, 'keyUp'), null]
    ]
    for (const [input, action] of table) expect(match(input, true), JSON.stringify(input)).toBe(action)
  })

  it('are Chrome’s keys with Ctrl on Windows and Linux', () => {
    const ctrl = { control: true }
    expect(match(k('t', ctrl), false)).toBe('newTab')
    expect(match(k('t', { meta: true }), false)).toBeNull()
    expect(match(k('i', { control: true, shift: true }), false)).toBe('devtools')
    expect(match(k('i', { control: true, alt: true }), false)).toBeNull()
    expect(match(k('ArrowLeft', { alt: true }), false)).toBe('back')
    expect(match(k('ArrowRight', { alt: true }), false)).toBe('forward')
    expect(match(k('ArrowUp', { alt: true }), false)).toBeNull()
    expect(match(k('ArrowLeft', { alt: true, control: true }), false)).toBeNull() // the workspace's pane focus
    expect(match(k('ArrowLeft', { alt: true, meta: true }), false)).toBeNull()
    expect(match(k('h', ctrl), false)).toBe('history')
    expect(match(k('y', ctrl), false)).toBeNull()
    expect(match(k('O', { control: true, shift: true }), false)).toBe('bookmarkManager')
    expect(match(k('b', { control: true, alt: true }), false)).toBeNull()
    expect(match(k('a', { control: true, shift: true }), false)).toBe('tabSearch')
    expect(match(k('G', { control: true, shift: true }), false)).toBe('newGroup')
    expect(match({ ...k('<', { control: true, shift: true }), code: 'Comma' }, false)).toBe('verticalTabs')
    expect(match(k('P', { control: true, shift: true }), false)).toBe('palette')
  })
})

describe('the browser host · split view', () => {
  const area = { x: 0, y: 40, width: 1000, height: 600 }
  const panes = [
    { id: 'a', bounds: { x: 0, y: 40, width: 497, height: 600 } },
    { id: 'b', bounds: { x: 503, y: 40, width: 497, height: 600 } }
  ]

  it('shows two pages side by side, each in its pane — the second only once its pane is known', () => {
    const { host, open } = setup()
    const a = open('a')
    const b = open('b')
    const c = open('c')
    host.setBounds(area)
    host.show('a', 'b')
    // the UI has not told where the panes are yet: the focused page fills the place, the other waits
    expect([a.visible, b.visible, c.visible]).toEqual([true, false, false])
    expect(a.bounds).toEqual({ x: 0, y: 40, width: 1000, height: 600 })
    host.setBounds(area, true, panes)
    expect([a.visible, b.visible, c.visible]).toEqual([true, true, false])
    expect(a.bounds).toEqual(panes[0].bounds)
    expect(b.bounds).toEqual(panes[1].bounds)
    expect(c.bounds).toEqual({ x: 0, y: 40, width: 1000, height: 600 }) // hidden ones keep the whole place
    // the focused side has no page (a new-tab page): only the other one shows
    host.show(undefined, 'b')
    expect([a.visible, b.visible]).toEqual([false, true])
    // back to one page: it fills the place again once the UI says so
    host.show('a')
    host.setBounds(area)
    expect([a.visible, b.visible]).toEqual([true, false])
    expect(a.bounds).toEqual({ x: 0, y: 40, width: 1000, height: 600 })
    // a pane for a tab without a view changes nothing; the module hidden hides both
    host.setBounds(area, true, [{ id: 'gone', bounds: panes[0].bounds }, panes[1]])
    host.show('a', 'b')
    expect([a.visible, b.visible]).toEqual([true, true])
    host.setBounds(null, true, panes)
    expect([a.visible, b.visible]).toEqual([false, false])
  })

  it('freezes both pages of a split as pictures, by tab', async () => {
    const { host, open } = setup()
    const a = open('a')
    const b = open('b')
    host.setBounds(area, true, panes)
    host.show('a', 'b')
    const shot = `data:image/jpeg;base64,${Buffer.from('jpeg85').toString('base64')}`
    expect(await host.freeze()).toEqual({ a: shot, b: shot })
    expect([a.visible, b.visible]).toEqual([false, false])
    host.unfreeze()
    expect([a.visible, b.visible]).toEqual([true, true])
    // one page has no picture (still painting): the other's still comes
    b.webContents.image = new FakeImage(0, 0, true)
    expect(await host.freeze()).toEqual({ a: shot })
  })

  it('turns submenus of the core’s menu entries into native submenus', () => {
    const run = vi.fn()
    const entries: MenuEntry[] = [{ label: 'Add Tab to Group', run: () => {}, submenu: [{ label: 'Work', run }] }]
    const [item] = menuTemplate(entries)
    expect(item).toMatchObject({ label: 'Add Tab to Group', enabled: true })
    expect(item.click).toBeUndefined()
    const [work] = item.submenu as Electron.MenuItemConstructorOptions[]
    work.click!(undefined as never, undefined as never, undefined as never)
    expect(run).toHaveBeenCalled()
  })
})

describe('the workspace keys a page hands on', () => {
  let wsKey: typeof import('../../../electron/main/platform/browser/shortcuts').workspaceKey
  let match: typeof import('../../../electron/main/platform/browser/shortcuts').matchShortcut
  beforeAll(async () => {
    ;({ workspaceKey: wsKey, matchShortcut: match } = await import('../../../electron/main/platform/browser/shortcuts'))
  })
  type Mods = Partial<Record<'meta' | 'control' | 'alt' | 'shift', boolean>>
  const k = (keyName: string, mods: Mods = {}, code?: string, type = 'keyDown') => ({ ...key(keyName, mods), type, ...(code ? { code } : {}) })

  it('are ⌘ with ⌥ arrows and digits, ⌥Z, ⇧W, ⇧↵ and \\ on macOS — by the key’s place where ⌥ changes it', () => {
    const yes = [
      k('ArrowUp', { meta: true, alt: true }),
      k('¡', { meta: true, alt: true }, 'Digit1'),
      k('Ω', { meta: true, alt: true }, 'KeyZ'),
      k('W', { meta: true, shift: true }, 'KeyW'),
      k('Enter', { meta: true, shift: true }),
      k('\\', { meta: true })
    ]
    for (const input of yes) {
      expect(wsKey(input, true), JSON.stringify(input)).toMatchObject({ key: input.key, metaKey: true })
      // never a browser key as well
      expect(match(input, true), JSON.stringify(input)).toBeNull()
    }
    const no = [
      k('ArrowUp', { meta: true, alt: true }, undefined, 'keyUp'),
      k('ArrowUp', { meta: true, control: true, alt: true }),
      k('ArrowUp', { control: true, alt: true }),
      k('¡', { meta: true, alt: true }),
      k('0', { meta: true, alt: true }, 'Digit0'),
      k('z', { meta: true, alt: true }),
      k('x', { meta: true, alt: true }, 'KeyX'),
      k('w', { meta: true, shift: true }),
      k('q', { meta: true, shift: true }, 'KeyQ'),
      k('Enter', { meta: true, shift: true, alt: true }),
      k('\\', { meta: true, shift: true, alt: true }),
      k('t', { meta: true })
    ]
    for (const input of no) expect(wsKey(input, true), JSON.stringify(input)).toBeNull()
  })

  it('are Ctrl combinations by the key itself on Windows and Linux', () => {
    expect(wsKey(k('ArrowRight', { control: true, alt: true }), false)).toEqual({ key: 'ArrowRight', code: '', metaKey: false, ctrlKey: true, altKey: true, shiftKey: false })
    expect(wsKey(k('3', { control: true, alt: true }, 'Digit3'), false)).toMatchObject({ key: '3', code: 'Digit3' })
    expect(wsKey(k('Z', { control: true, alt: true }), false)).toMatchObject({ key: 'Z' })
    expect(wsKey(k('w', { control: true, shift: true }), false)).toMatchObject({ key: 'w', shiftKey: true })
    expect(wsKey(k('\\', { control: true }), false)).toMatchObject({ key: '\\' })
    // AltGr (Ctrl+Alt) types characters: those are text
    expect(wsKey(k('@', { control: true, alt: true }, 'KeyQ'), false)).toBeNull()
    expect(wsKey(k('\\', { meta: true }), false)).toBeNull()
    expect(wsKey(k('\\', { control: true, meta: true }), false)).toBeNull()
  })
})
