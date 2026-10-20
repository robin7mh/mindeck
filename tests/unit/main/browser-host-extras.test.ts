import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { tempDir } from './helpers'
import type { BrowserHostEvents } from '../../../electron/main/services/browser/types'
import type { SessionTarget } from '../../../electron/main/platform/browser/session'
import { labels } from '../../../electron/main/services/browser/labels'

// --- electron double: one session per partition ----------------------------------
type Fn = (...a: never[]) => unknown

class FakeContents {
  handlers = new Map<string, Fn[]>()
  destroyed = false
  zoom = 1
  url = 'https://a.dev/'
  openHandler?: (d: { url: string }) => unknown
  navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() }
  session = { addWordToSpellCheckerDictionary: vi.fn() }
  loadURL = vi.fn(async (url: string) => (url.includes('fail') ? Promise.reject(new Error('ERR_FAILED')) : undefined))
  executeJavaScript = vi.fn(async (_code: string, _gesture?: boolean): Promise<unknown> => undefined)
  insertCSS = vi.fn(async (_css: string, _opts?: unknown): Promise<string> => 'key')
  getURL = () => this.url
  getZoomFactor = () => this.zoom
  setZoomFactor = vi.fn()
  setAudioMuted = vi.fn()
  downloadURL = vi.fn()
  focus = vi.fn()
  close = vi.fn(() => (this.destroyed = true))
  isDestroyed = () => this.destroyed
  setWindowOpenHandler = (fn: (d: { url: string }) => unknown) => (this.openHandler = fn)
  on(event: string, fn: Fn) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn])
    return this
  }
  once(event: string, fn: Fn) {
    return this.on(event, fn)
  }
  removeListener = vi.fn()
  emit(event: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(event) ?? []) (fn as (...a: unknown[]) => unknown)(...args)
  }
}

class FakeView {
  static all: FakeView[] = []
  webContents = new FakeContents()
  visible = true
  bounds?: { x: number; y: number; width: number; height: number }
  constructor(public opts: { webPreferences: Record<string, unknown> }) {
    FakeView.all.push(this)
  }
  setVisible = vi.fn((v: boolean) => (this.visible = v))
  setBounds = vi.fn((b: FakeView['bounds']) => (this.bounds = b))
}

function fakeSession(name: string) {
  const s = {
    name,
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.1.2 Electron/44.7.2 Safari/537.36',
    getUserAgent: () => s.ua,
    setUserAgent: (ua: string) => (s.ua = ua),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    setCertificateVerifyProc: vi.fn(),
    download: undefined as undefined | ((...a: unknown[]) => void),
    on: (_event: string, fn: (...a: unknown[]) => void) => (s.download = fn),
    // like Electron's: partitions without `persist:` live in memory
    isPersistent: () => name.startsWith('persist:'),
    beforeRequest: undefined as undefined | ((details: unknown, cb: (r: unknown) => void) => void),
    webRequest: { onBeforeRequest: (fn: (details: unknown, cb: (r: unknown) => void) => void) => (s.beforeRequest = fn), onBeforeSendHeaders: vi.fn() },
    registerPreloadScript: vi.fn(),
    fetch: vi.fn(async (_url: string) => ({ ok: false, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) })),
    clearStorageData: vi.fn(async () => {}),
    clearCache: vi.fn(async () => {}),
    clearAuthCache: vi.fn(async () => {}),
    loaded: [] as { id: string; path: string }[],
    extensions: {
      getAllExtensions: () => s.loaded,
      getExtension: (id: string) => s.loaded.find((e) => e.id === id) ?? null,
      loadExtension: vi.fn(async (path: string) => {
        const e = { id: `id-${s.loaded.length}`, path }
        s.loaded.push(e)
        return e
      }),
      removeExtension: vi.fn((id: string) => (s.loaded = s.loaded.filter((e) => e.id !== id)))
    }
  }
  return s
}

const h = vi.hoisted(() => ({
  sessions: new Map<string, ReturnType<typeof fakeSession>>(),
  menus: [] as { template: { label?: string; click?: () => void }[] }[],
  downloads: '/Downloads'
}))

vi.mock('electron', () => ({
  app: { getApplicationNameForProtocol: () => 'Arc', getPath: () => h.downloads },
  BrowserWindow: class {},
  clipboard: { writeText: vi.fn() },
  Menu: {
    buildFromTemplate: (template: { label?: string; click?: () => void }[]) => {
      const menu = { template, popup: vi.fn() }
      h.menus.push(menu)
      return menu
    }
  },
  nativeTheme: { themeSource: 'system' },
  session: {
    fromPartition: (name: string) => {
      if (!h.sessions.has(name)) h.sessions.set(name, fakeSession(name))
      return h.sessions.get(name)!
    }
  },
  shell: { openExternal: vi.fn() },
  WebContentsView: FakeView,
  desktopCapturer: { getSources: vi.fn() },
  systemPreferences: { askForMediaAccess: vi.fn() }
}))

type HostModule = typeof import('../../../electron/main/platform/browser/host')
let host$: HostModule
let partitions: typeof import('../../../electron/main/platform/browser/partitions')
let platformExt: typeof import('../../../electron/main/platform/browser/extensions')
let session$: typeof import('../../../electron/main/platform/browser/session')
let menus$: typeof import('../../../electron/main/platform/browser/menus')
let shortcuts$: typeof import('../../../electron/main/platform/browser/shortcuts')
beforeAll(async () => {
  host$ = await import('../../../electron/main/platform/browser/host')
  partitions = await import('../../../electron/main/platform/browser/partitions')
  platformExt = await import('../../../electron/main/platform/browser/extensions')
  session$ = await import('../../../electron/main/platform/browser/session')
  menus$ = await import('../../../electron/main/platform/browser/menus')
  shortcuts$ = await import('../../../electron/main/platform/browser/shortcuts')
})

function fakeWindow() {
  const listeners = new Map<string, () => void>()
  const win = {
    destroyed: false,
    content: { x: 0, y: 0, width: 1440, height: 900 },
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: new FakeContents(),
    isDestroyed: () => win.destroyed,
    on: vi.fn((event: string, fn: () => void) => listeners.set(event, fn)),
    removeListener: vi.fn(),
    getContentBounds: () => win.content,
    fullScreen: false,
    isFullScreen: () => win.fullScreen,
    setFullScreen: vi.fn((v: boolean) => (win.fullScreen = v)),
    fire: (event: string) => listeners.get(event)!()
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
  const host = host$.createBrowserHost(win as never, ev)
  const open = (id: string, url = 'https://a.dev/', opts?: Parameters<typeof host.create>[2]) => {
    host.create(id, url, opts)
    return FakeView.all.at(-1)!
  }
  return { win, ev, host, open }
}

const key = (k: string, type = 'keyDown') => ({ type, key: k, meta: false, control: false, alt: false, shift: false })
const ctx = (over: Partial<import('../../../electron/main/platform/browser/menus').ContextParams> = {}) => ({
  x: 100,
  y: 60,
  linkURL: '',
  srcURL: '',
  mediaType: 'none',
  selectionText: '',
  isEditable: false,
  misspelledWord: '',
  dictionarySuggestions: [],
  editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
  ...over
})
const click = (label: string) => h.menus.at(-1)!.template.find((i) => i.label === label)!.click!()

beforeEach(() => {
  FakeView.all = []
  h.menus = []
  h.sessions.clear()
})
afterEach(() => vi.useRealTimers())

describe('browser profiles (partitions)', () => {
  it('maps profiles to partitions, sets each up once, and wipes the private one', async () => {
    expect(partitions.partitionOf()).toBe('persist:mindeck-browser')
    expect(partitions.partitionOf('private')).toBe('mindeck-private')
    expect(partitions.partitionOf('agents')).toBe('persist:mindeck-agents')
    const ses = partitions.profileSession('agents', () => null)
    expect(ses).toBe(h.sessions.get('persist:mindeck-agents'))
    expect((ses as unknown as { ua: string }).ua).not.toContain('Electron')
    await partitions.clearPrivate()
    const priv = h.sessions.get('mindeck-private')!
    expect(priv.clearStorageData).toHaveBeenCalled()
    expect(priv.clearCache).toHaveBeenCalled()
    expect(priv.clearAuthCache).toHaveBeenCalled()
  })
})

describe('the browser host · profiles, fullscreen, media, logins', () => {
  it('opens private and agent tabs in their own partitions — popups and favicons too', async () => {
    const { host, open, ev } = setup()
    const priv = open('p', 'https://secret.dev/', { profile: 'private' })
    const agent = open('g', 'https://vercel.com/', { profile: 'agents', agent: true })
    const own = open('o')
    expect(priv.opts.webPreferences.partition).toBe('mindeck-private')
    expect(agent.opts.webPreferences.partition).toBe('persist:mindeck-agents')
    expect(own.opts.webPreferences.partition).toBe('persist:mindeck-browser')
    // every profile asks the blocker
    expect(h.sessions.get('mindeck-private')!.beforeRequest).toBeDefined()
    // and asks the window open now — naming the tab
    const [ask] = h.sessions.get('mindeck-private')!.setPermissionRequestHandler.mock.calls[0] as [(...a: unknown[]) => void]
    ask(priv.webContents, 'notifications', vi.fn(), { requestingUrl: 'https://secret.dev/x' })
    expect(ev.permission).toHaveBeenCalledWith({ tabId: 'p', origin: 'https://secret.dev', kind: 'notifications' }, expect.any(Function))
    // a private sign-in popup stays private
    const popup = priv.webContents.openHandler!({ url: 'https://login.dev/', disposition: 'new-window', features: 'width=400' } as never) as {
      overrideBrowserWindowOptions: { webPreferences: { partition: string } }
    }
    expect(popup.overrideBrowserWindowOptions.webPreferences.partition).toBe('mindeck-private')
    // the favicon is fetched in the tab's own profile
    priv.webContents.emit('page-favicon-updated', {}, ['https://secret.dev/favicon.ico'])
    await vi.waitFor(() => expect(h.sessions.get('mindeck-private')!.fetch).toHaveBeenCalledWith('https://secret.dev/favicon.ico'))
    expect(ev.favicon).not.toHaveBeenCalled()
    host.destroy('p')
  })

  it('wipes the private profile on request, logging a failure', async () => {
    const { host } = setup()
    host.clearPrivate()
    await vi.waitFor(() => expect(h.sessions.get('mindeck-private')!.clearStorageData).toHaveBeenCalled())
    h.sessions.get('mindeck-private')!.clearCache.mockRejectedValueOnce(new Error('busy'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    host.clearPrivate()
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith('[browser] clearing the private profile failed', expect.any(Error)))
  })

  it('lets a page in HTML fullscreen cover the whole window until Escape — or another tab comes up', async () => {
    const { host, open, win, ev } = setup()
    const a = open('a')
    const b = open('b')
    host.setBounds({ x: 10, y: 50, width: 800, height: 600 })
    host.show('a')
    a.webContents.emit('enter-html-full-screen')
    expect(a.bounds).toEqual({ x: 0, y: 0, width: 1440, height: 900 })
    expect([a.visible, b.visible]).toEqual([true, false])
    expect(win.contentView.addChildView).toHaveBeenLastCalledWith(a)
    // the window grows (it may go fullscreen itself): the page follows
    win.content = { x: 0, y: 0, width: 1920, height: 1080 }
    win.fire('resize')
    expect(a.bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
    // UI menus do not freeze a fullscreen page, nor does the module hiding it
    host.setBounds(null)
    expect(a.visible).toBe(true)
    // the panes move meanwhile, the browser's pane loses the focus: fullscreen stays, Escape still works
    host.setBounds({ x: 10, y: 50, width: 800, height: 600 }, false)
    expect(a.bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
    // the workspace's keys stay the fullscreen page's (the UI taking the keyboard would strand it on top)
    const paneKey = { preventDefault: vi.fn() }
    a.webContents.emit('before-input-event', paneKey, { ...key('\\'), meta: process.platform === 'darwin', control: process.platform !== 'darwin' })
    expect(paneKey.preventDefault).not.toHaveBeenCalled()
    expect(ev.workspaceKey).not.toHaveBeenCalled()
    // Escape leaves fullscreen — other keys and other tabs' Escape are the page's
    const esc = { preventDefault: vi.fn() }
    a.webContents.emit('before-input-event', esc, key('Escape', 'keyUp'))
    a.webContents.emit('before-input-event', esc, key('a'))
    b.webContents.emit('before-input-event', esc, key('Escape'))
    expect(a.webContents.executeJavaScript).not.toHaveBeenCalled()
    a.webContents.emit('before-input-event', esc, key('Escape'))
    expect(esc.preventDefault).toHaveBeenCalledTimes(1)
    expect(a.webContents.executeJavaScript).toHaveBeenCalledWith('document.fullscreenElement && document.exitFullscreen()', true)
    b.webContents.emit('leave-html-full-screen') // not b's to leave
    expect(a.bounds!.width).toBe(1920)
    a.webContents.emit('leave-html-full-screen')
    expect(a.bounds).toEqual({ x: 10, y: 50, width: 800, height: 600 })
    // F11 / ⌃⌘F still toggles the window's own full screen from the page
    a.webContents.emit('before-input-event', esc, process.platform === 'darwin' ? { ...key('f'), meta: true, control: true } : key('F11'))
    expect(win.setFullScreen).toHaveBeenCalledWith(true)

    // fullscreen again, then another tab: the first leaves fullscreen
    a.webContents.emit('enter-html-full-screen')
    a.webContents.executeJavaScript.mockRejectedValueOnce(new Error('gone'))
    host.show('b')
    expect(a.webContents.executeJavaScript).toHaveBeenCalledTimes(2)
    host.show('a') // the fullscreen tab itself: stays
    expect(a.webContents.executeJavaScript).toHaveBeenCalledTimes(2)
    // the fullscreen tab closes: the others get their place back
    host.destroy('a')
    host.show('b')
    expect(b.visible).toBe(true)
  })

  it('in a split view, puts only the one page in fullscreen — switching sides keeps it there', () => {
    const { host, open } = setup()
    const a = open('a')
    const b = open('b')
    open('c')
    const panes = [
      { id: 'a', bounds: { x: 0, y: 0, width: 400, height: 600 } },
      { id: 'b', bounds: { x: 406, y: 0, width: 400, height: 600 } }
    ]
    host.setBounds({ x: 0, y: 0, width: 806, height: 600 }, true, panes)
    host.show('a', 'b')
    b.webContents.emit('enter-html-full-screen')
    expect(b.bounds).toEqual({ x: 0, y: 0, width: 1440, height: 900 })
    expect([a.visible, b.visible]).toEqual([false, true])
    // the focus moves to the other side of the split: the page stays in fullscreen
    host.show('b', 'a')
    expect(b.webContents.executeJavaScript).not.toHaveBeenCalled()
    // another tab altogether: it leaves fullscreen
    host.show('c')
    expect(b.webContents.executeJavaScript).toHaveBeenCalledWith('document.fullscreenElement && document.exitFullscreen()', true)
    b.webContents.emit('leave-html-full-screen')
    host.show('a', 'b')
    expect(b.bounds).toEqual(panes[1].bounds)
  })

  it('reports media playing, hides ads with a user style sheet, and asks for logins', async () => {
    const { open, ev } = setup()
    const a = open('a')
    a.webContents.emit('media-started-playing')
    a.webContents.emit('media-paused')
    expect(ev.media.mock.calls).toEqual([
      ['a', true],
      ['a', false]
    ])
    a.webContents.emit('dom-ready')
    expect(a.webContents.insertCSS).not.toHaveBeenCalled()
    ev.cosmetics.mockReturnValue('.ad { display: none !important; }')
    a.webContents.emit('dom-ready')
    expect(ev.cosmetics).toHaveBeenLastCalledWith('a', 'https://a.dev/')
    expect(a.webContents.insertCSS).toHaveBeenCalledWith('.ad { display: none !important; }', { cssOrigin: 'user' })
    a.webContents.insertCSS.mockRejectedValueOnce(new Error('navigated away'))
    a.webContents.emit('dom-ready')

    const event = { preventDefault: vi.fn() }
    const callback = vi.fn()
    a.webContents.emit('login', event, { url: 'https://a.dev/admin' }, { host: 'a.dev', port: 443, realm: 'Admin', isProxy: false, scheme: 'basic' }, callback)
    expect(event.preventDefault).toHaveBeenCalled()
    const [tabId, ask, respond] = ev.login.mock.calls[0]
    expect([tabId, ask]).toEqual(['a', { url: 'https://a.dev/admin', host: 'a.dev:443', realm: 'Admin', isProxy: false }])
    respond({ username: 'robin', password: 'pw' })
    expect(callback).toHaveBeenLastCalledWith('robin', 'pw')
    respond(null)
    expect(callback).toHaveBeenLastCalledWith()
  })

  it('opens links in private tabs, saves with a dialog, and puts videos in picture in picture', async () => {
    const { open, ev } = setup()
    const a = open('a')
    a.webContents.zoom = 2
    a.webContents.emit('context-menu', {}, ctx({ linkURL: 'https://b.dev/' }))
    click('Open Link in Private Tab')
    expect(ev.openTab).toHaveBeenCalledWith('https://b.dev/', { background: false, private: true })
    click('Save Link As…')
    expect(a.webContents.downloadURL).toHaveBeenCalledWith('https://b.dev/')
    // the download that follows asks where — once
    const download = () => {
      const item = { getFilename: () => 'b.html', getURL: () => 'https://b.dev/', setSavePath: vi.fn(), setSaveDialogOptions: vi.fn(), getTotalBytes: () => 0, on: vi.fn(), once: vi.fn(), getSavePath: () => '' }
      h.sessions.get('persist:mindeck-browser')!.download!({}, item, {})
      return item
    }
    expect(download().setSaveDialogOptions).toHaveBeenCalled()
    expect(download().setSavePath).toHaveBeenCalled()
    a.webContents.emit('context-menu', {}, ctx({ mediaType: 'video', srcURL: 'https://v.dev/clip.mp4' }))
    click('Picture in Picture')
    expect(a.webContents.executeJavaScript).toHaveBeenCalledWith(host$.pipScript(50, 30), true)
    a.webContents.executeJavaScript.mockRejectedValueOnce(new Error('no video'))
    click('Picture in Picture')
    click('Save Video As…')
    expect(a.webContents.downloadURL).toHaveBeenLastCalledWith('https://v.dev/clip.mp4')
    expect(host$.pipScript(1, 2)).toContain('elementsFromPoint(1, 2)')
  })

  it('loads extensions into the user’s profile once, unloads them, and shows their popups', async () => {
    const { host, win, ev } = setup()
    expect(await host.loadExtension('/ext/a')).toEqual({ id: 'id-0' })
    expect(await host.loadExtension('/ext/a')).toEqual({ id: 'id-0' }) // already loaded (a second window)
    const ses = h.sessions.get('persist:mindeck-browser')!
    expect(ses.extensions.loadExtension).toHaveBeenCalledTimes(1)
    host.unloadExtension('id-0')
    host.unloadExtension('id-0') // gone already
    expect(ses.extensions.removeExtension).toHaveBeenCalledTimes(1)

    host.openPopup('chrome-extension://id-0/popup.html', { x: 1300, y: 40, width: 32, height: 32 })
    const popup = FakeView.all.at(-1)!
    expect(popup.opts.webPreferences).toMatchObject({ partition: 'persist:mindeck-browser', sandbox: true, enablePreferredSizeMode: true })
    expect(popup.webContents.loadURL).toHaveBeenCalledWith('chrome-extension://id-0/popup.html')
    expect(popup.bounds).toEqual({ x: 1012, y: 76, width: 320, height: 240 })
    expect(popup.visible).toBe(false)
    popup.webContents.emit('preferred-size-changed', {}, { width: 2000, height: 10 })
    expect(popup.bounds).toEqual({ x: 532, y: 76, width: 800, height: 25 })
    expect(popup.visible).toBe(true)
    popup.webContents.emit('did-finish-load')
    expect(popup.webContents.focus).toHaveBeenCalled()
    // links it opens become tabs
    expect(popup.webContents.openHandler!({ url: 'https://vault.bitwarden.com/' })).toEqual({ action: 'deny' })
    expect(popup.webContents.openHandler!({ url: 'chrome-extension://id-0/tab.html' })).toEqual({ action: 'deny' })
    expect(ev.openTab).toHaveBeenCalledTimes(1)
    expect(ev.openTab).toHaveBeenCalledWith('https://vault.bitwarden.com/', { background: false })
    // Escape closes it (other keys do not)
    popup.webContents.emit('before-input-event', { preventDefault: vi.fn() }, key('a'))
    popup.webContents.emit('before-input-event', { preventDefault: vi.fn() }, key('Escape', 'keyUp'))
    expect(popup.webContents.close).not.toHaveBeenCalled()
    popup.webContents.emit('before-input-event', { preventDefault: vi.fn() }, key('Escape'))
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(popup)
    expect(popup.webContents.close).toHaveBeenCalled()

    // losing the focus closes it; so does the page closing itself; a newer popup replaces it
    host.openPopup('chrome-extension://id-0/popup.html', { x: 0, y: 0, width: 10, height: 10 })
    const second = FakeView.all.at(-1)!
    expect(second.bounds!.x).toBe(0) // kept inside the window
    second.webContents.emit('blur')
    expect(second.webContents.close).toHaveBeenCalled()
    host.openPopup('chrome-extension://id-0/popup.html', { x: 0, y: 0, width: 10, height: 10 })
    const third = FakeView.all.at(-1)!
    third.webContents.destroyed = true
    third.webContents.emit('destroyed')
    expect(third.webContents.close).not.toHaveBeenCalled()
    host.openPopup('chrome-extension://id-0/a.html', { x: 0, y: 0, width: 10, height: 10 })
    const fourth = FakeView.all.at(-1)!
    host.openPopup('chrome-extension://id-0/b.html', { x: 0, y: 0, width: 10, height: 10 })
    const fifth = FakeView.all.at(-1)!
    expect(fourth.webContents.close).toHaveBeenCalled()
    fourth.webContents.emit('blur') // the old one's late event leaves the new one open
    expect(fifth.webContents.close).not.toHaveBeenCalled()
    // a page that fails to load closes
    host.openPopup('chrome-extension://id-0/fail.html', { x: 0, y: 0, width: 10, height: 10 })
    const failing = FakeView.all.at(-1)!
    await vi.waitFor(() => expect(failing.webContents.close).toHaveBeenCalled())
    // the window going away takes it along
    host.openPopup('chrome-extension://id-0/popup.html', { x: 0, y: 0, width: 10, height: 10 })
    const last = FakeView.all.at(-1)!
    win.destroyed = true
    host.dispose()
    expect(last.webContents.close).toHaveBeenCalled()
    expect(win.removeListener).not.toHaveBeenCalled()
  })

  it('stops listening to the window on dispose', () => {
    const { host, win } = setup()
    host.dispose()
    expect(win.removeListener).toHaveBeenCalledWith('resize', expect.any(Function))
  })
})

describe('the browser profile · blocking and downloads', () => {
  function target(over: Partial<SessionTarget> = {}): SessionTarget {
    return { events: events(), tabOf: (c) => (c ? 'tab' : undefined), takeSaveAs: () => false, ...over }
  }

  it('asks the blocker about each request and passes its verdict to Chromium', () => {
    const ses = h.sessions.get('x') ?? (h.sessions.set('x', fakeSession('x')), h.sessions.get('x')!)
    let current: SessionTarget | null = target()
    session$.configureBrowserSession(ses as never, () => current)
    const ev = current!.events as ReturnType<typeof events>
    const cb = vi.fn()
    const details = { url: 'https://ads.dev/a.js', resourceType: 'script', referrer: 'https://news.dev/', webContents: {} }
    ses.beforeRequest!(details, cb)
    expect(ev.request).toHaveBeenLastCalledWith('tab', { url: 'https://ads.dev/a.js', type: 'script', referrer: 'https://news.dev/' })
    expect(cb).toHaveBeenLastCalledWith({ cancel: false })
    ev.request.mockReturnValueOnce({ cancel: true })
    ses.beforeRequest!(details, cb)
    expect(cb).toHaveBeenLastCalledWith({ cancel: true })
    ev.request.mockReturnValueOnce({ redirectURL: 'data:text/javascript,' })
    ses.beforeRequest!({ ...details, webContents: undefined }, cb)
    expect(ev.request).toHaveBeenLastCalledWith(undefined, expect.anything())
    expect(cb).toHaveBeenLastCalledWith({ redirectURL: 'data:text/javascript,' })
    ev.request.mockReturnValueOnce({ cancel: true, danger: true })
    ses.beforeRequest!(details, cb)
    expect(cb).toHaveBeenLastCalledWith({ cancel: true })
    current = null
    ses.beforeRequest!(details, cb)
    expect(cb).toHaveBeenLastCalledWith({})
  })

  it('saves downloads to the chosen folder — or asks where, when the user wants or picked “Save As”', async () => {
    const chosen = await tempDir()
    const ses = fakeSession('dl')
    const ev = events()
    const saveAs = new Set(['https://a.dev/pick.zip'])
    let current: SessionTarget | null = target({ events: ev, takeSaveAs: (url) => saveAs.delete(url) })
    session$.configureBrowserSession(ses as never, () => current)
    const item = (url: string, filename = 'report.pdf') => {
      const handlers: Record<string, (...a: unknown[]) => void> = {}
      const it = {
        handlers,
        savePath: '',
        getFilename: () => filename,
        getURL: () => url,
        setSavePath: vi.fn((p: string) => (it.savePath = p)),
        getSavePath: () => it.savePath,
        setSaveDialogOptions: vi.fn(),
        getTotalBytes: () => 10,
        getReceivedBytes: () => 10,
        on: (event: string, fn: (...a: unknown[]) => void) => (handlers[event] = fn),
        once: (event: string, fn: (...a: unknown[]) => void) => (handlers[event] = fn),
        cancel: vi.fn()
      }
      return it
    }
    // the chosen folder
    ev.downloadPrefs.mockReturnValue({ ask: false, dir: chosen })
    const a = item('https://a.dev/r.pdf')
    ses.download!({}, a, {})
    expect(a.setSavePath).toHaveBeenCalledWith(join(chosen, 'report.pdf'))
    // a folder that is gone: the system's Downloads
    ev.downloadPrefs.mockReturnValue({ ask: false, dir: join(chosen, 'gone') })
    const b = item('https://a.dev/r.pdf')
    ses.download!({}, b, {})
    expect(b.setSavePath).toHaveBeenCalledWith(join('/Downloads', 'report.pdf'))
    // "Save Link As…": the dialog, in the chosen folder; where it went is known later
    ev.downloadPrefs.mockReturnValue({ ask: false, dir: chosen })
    const c = item('https://a.dev/pick.zip', 'pick.zip')
    ses.download!({}, c, {})
    expect(c.setSavePath).not.toHaveBeenCalled()
    expect(c.setSaveDialogOptions).toHaveBeenCalledWith({ defaultPath: join(chosen, 'pick.zip') })
    expect(ev.download.mock.calls.at(-1)![0]).toMatchObject({ filename: 'pick.zip', path: '' })
    c.handlers.updated({}, 'interrupted')
    expect(ev.downloadUpdated).toHaveBeenLastCalledWith(expect.objectContaining({ path: '' }))
    c.savePath = '/Users/me/Desktop/renamed.zip'
    c.handlers.done({}, 'completed')
    expect(ev.downloadUpdated).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/Users/me/Desktop/renamed.zip', filename: 'renamed.zip', state: 'completed' }))
    // always asking — also for downloads without a name
    ev.downloadPrefs.mockReturnValue({ ask: true, dir: '' })
    const d = item('https://a.dev/x', '')
    ses.download!({}, d, {})
    expect(d.setSaveDialogOptions).toHaveBeenCalledWith({ defaultPath: join('/Downloads', 'download') })
    // no window: the defaults
    current = null
    const e = item('https://a.dev/r.pdf')
    ses.download!({}, e, {})
    expect(e.setSavePath).toHaveBeenCalled()
  })
})

describe('the page menu and keys · extras', () => {
  const actions = () => ({
    openTab: vi.fn(),
    openPrivate: vi.fn(),
    saveAs: vi.fn(),
    pictureInPicture: vi.fn(),
    handoff: vi.fn(),
    copyText: vi.fn(),
    saveImage: vi.fn(),
    copyImage: vi.fn(),
    edit: vi.fn(),
    replaceMisspelling: vi.fn(),
    addToDictionary: vi.fn(),
    search: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
    canGoBack: false,
    canGoForward: false,
    sendToAgent: vi.fn(),
    inspect: vi.fn()
  })
  const labelsOf = (entries: ReturnType<typeof menus$.contextMenu>) => entries.filter((e) => 'label' in e).map((e) => (e as { label: string }).label)
  const run = (entries: ReturnType<typeof menus$.contextMenu>, label: string) => (entries.find((e) => 'label' in e && e.label === label) as { run: () => void }).run()

  it('offers private tabs, “Save As” and picture in picture where they apply', () => {
    const l = labels('en')
    const a = actions()
    const link = menus$.contextMenu(ctx({ linkURL: 'https://b.dev/' }), a, l, 'Google', 'Arc')
    expect(labelsOf(link).slice(0, 5)).toEqual(['Open Link in New Tab', 'Open Link in Private Tab', 'Open in Arc', 'Save Link As…', 'Copy Link Address'])
    run(link, 'Open Link in Private Tab')
    run(link, 'Save Link As…')
    expect(a.openPrivate).toHaveBeenCalledWith('https://b.dev/')
    expect(a.saveAs).toHaveBeenCalledWith('https://b.dev/')
    const image = menus$.contextMenu(ctx({ mediaType: 'image', srcURL: 'https://b.dev/i.png' }), a, l, 'Google', 'Arc')
    run(image, 'Save Image As…')
    expect(a.saveAs).toHaveBeenLastCalledWith('https://b.dev/i.png')
    const video = menus$.contextMenu(ctx({ mediaType: 'video', srcURL: 'https://b.dev/v.mp4' }), a, l, 'Google', 'Arc')
    run(video, 'Picture in Picture')
    expect(a.pictureInPicture).toHaveBeenCalledWith(100, 60)
    run(video, 'Save Video As…')
    const audio = menus$.contextMenu(ctx({ mediaType: 'audio', srcURL: 'blob:https://b.dev/x' }), a, l, 'Google', 'Arc')
    expect(labelsOf(audio)).not.toContain('Picture in Picture')
    expect((audio.find((e) => 'label' in e && e.label === 'Save Audio As…') as { enabled: boolean }).enabled).toBe(false)
    expect(labelsOf(menus$.contextMenu(ctx({ mediaType: 'video' }), a, l, 'Google', 'Arc'))).not.toContain('Picture in Picture')
  })

  it('opens a private tab with ⌘⇧N / Ctrl+Shift+N', () => {
    expect(shortcuts$.matchShortcut({ type: 'keyDown', key: 'N', meta: true, control: false, alt: false, shift: true }, true)).toBe('newPrivateTab')
    expect(shortcuts$.matchShortcut({ type: 'keyDown', key: 'n', meta: false, control: true, alt: false, shift: true }, false)).toBe('newPrivateTab')
  })

  it('loads and removes extensions straight in the session', async () => {
    expect(await platformExt.loadExtension('/x')).toEqual({ id: 'id-0' })
    platformExt.unloadExtension('id-0')
    expect(h.sessions.get('persist:mindeck-browser')!.loaded).toEqual([])
  })
})
