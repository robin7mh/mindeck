import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- electron double -----------------------------------------------------------
type Handler = (...a: unknown[]) => unknown
class FakeWindow {
  static all: FakeWindow[] = []
  static getAllWindows = () => FakeWindow.all
  static getFocusedWindow = () => h.focused
  handlers = new Map<string, Handler>()
  opts: Record<string, unknown>
  destroyed = false
  maximized = false
  fullScreen = false
  visible = true
  minimized = false
  focused = true
  openHandler?: (d: { url: string }) => unknown
  contentsHandlers = new Map<string, Handler>()
  webContents = {
    send: vi.fn(),
    on: (event: string, fn: Handler) => this.contentsHandlers.set(event, fn),
    isDestroyed: () => this.destroyed,
    setWindowOpenHandler: (fn: (d: { url: string }) => unknown) => (this.openHandler = fn)
  }
  show = vi.fn(() => (this.visible = true))
  hide = vi.fn(() => (this.visible = false))
  restore = vi.fn(() => (this.minimized = false))
  focus = vi.fn()
  minimize = vi.fn()
  maximize = vi.fn()
  unmaximize = vi.fn()
  close = vi.fn()
  loadURL = vi.fn(async () => {})
  loadFile = vi.fn(async (_file: string) => {})
  isMaximized = () => this.maximized
  isFullScreen = () => this.fullScreen
  setFullScreen = vi.fn((v: boolean) => (this.fullScreen = v))
  isVisible = () => this.visible
  isMinimized = () => this.minimized
  isFocused = () => this.focused
  isDestroyed = () => this.destroyed
  constructor(opts: Record<string, unknown>) {
    this.opts = opts
    FakeWindow.all.push(this)
  }
  on(event: string, fn: Handler) {
    this.handlers.set(event, fn)
    return this
  }
  emit(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.(...args)
  }
}

const h = vi.hoisted(() => ({
  ready: undefined as undefined | (() => void),
  appHandlers: new Map<string, (...a: unknown[]) => unknown>(),
  ipcOn: new Map<string, (...a: unknown[]) => unknown>(),
  ipcHandle: new Map<string, (...a: unknown[]) => unknown>(),
  quit: vi.fn(),
  exit: vi.fn(),
  errorBox: vi.fn(),
  openExternal: vi.fn(async () => {}),
  openPath: vi.fn(async (_path: string) => ''),
  messageBox: vi.fn((): number => 1),
  /** Answers to dialog.showMessageBox, in order (default: its cancel button). */
  answers: [] as { response: number; checkboxChecked?: boolean }[],
  asked: [] as { parent: unknown; options: { message: string; buttons: string[]; cancelId: number } }[],
  singleInstance: true,
  setPath: vi.fn(),
  crashStart: vi.fn(),
  trays: [] as { image: unknown; tooltip?: string; menu?: { label?: string; type?: string; click?: () => void }[]; click?: () => void; destroy: ReturnType<typeof vi.fn> }[],
  log: { captured: vi.fn(), crashes: vi.fn(), recent: vi.fn(() => [] as unknown[]), error: vi.fn(), warn: vi.fn() },
  notifications: [] as { opts: { title: string; body: string }; click?: () => void; show: ReturnType<typeof vi.fn> }[],
  notifySupported: true,
  focused: null as unknown,
  idleSeconds: 0,
  updater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    listeners: new Map<string, (...a: unknown[]) => void>(),
    on(event: string, fn: (...a: unknown[]) => void) {
      h.updater.listeners.set(event, fn)
    },
    checkForUpdates: vi.fn(async () => undefined),
    quitAndInstall: vi.fn()
  },
  packaged: false,
  appMenu: undefined as unknown,
  dark: true,
  fileIconFails: false,
  migrate: vi.fn((_legacy?: string): boolean => false),
  coreOpts: undefined as undefined | Record<string, unknown>,
  hubListener: undefined as undefined | ((channel: string, payload: unknown) => void),
  bound: vi.fn(),
  guard: vi.fn(),
  defaultSession: { id: 'default-session' },
  schemes: vi.fn(),
  protocolHandler: undefined as undefined | ((request: unknown) => unknown),
  serveFile: vi.fn(async (_request: unknown, deps: { thumbnail: (path: string, size: number) => Promise<unknown> }) => deps),
  thumbnail: { empty: false },
  host: { dispose: vi.fn() },
  createHost: vi.fn(),
  running: { agents: 0, terminals: 0 },
  /** Signal handlers main.ts installs (kept off the test process). */
  signals: new Map<string, () => void>(),
  settings: {} as Record<string, unknown>,
  core: {
    system: { setPaused: vi.fn() },
    // A shell waiting at its prompt is always there; it never counts as running.
    terminal: { killAll: vi.fn(), list: () => [{ id: 'idle' }, ...Array.from({ length: h.running.terminals }, (_, i) => ({ id: `t${i}`, running: 'node' }))] },
    agents: { list: () => Array.from({ length: h.running.agents + 1 }, (_, i) => ({ id: `a${i}`, live: i < h.running.agents })) },
    settings: { get: () => h.settings, update: vi.fn(async (patch: Record<string, unknown>) => (h.settings = { ...h.settings, ...patch })) },
    cloud: { status: () => ({ state: 'active' }) },
    server: { start: vi.fn(async () => {}) },
    dispose: vi.fn(async () => {}),
    router: { id: 'router', register: vi.fn() },
    browser: { hostEvents: vi.fn(() => ({ events: true, locale: () => 'en' as const })), attach: vi.fn(), detach: vi.fn(), openFromApp: vi.fn((): boolean => true) }
  }
}))
vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise<void>((r) => (h.ready = r)),
    on: (event: string, fn: (...a: unknown[]) => unknown) => h.appHandlers.set(event, fn),
    getVersion: () => '0.1.0',
    get isPackaged() {
      return h.packaged
    },
    getPath: (name: string) => (name === 'home' ? '/Users/me' : '/userData'),
    getLocale: () => 'de-DE',
    setPath: h.setPath,
    requestSingleInstanceLock: () => h.singleInstance,
    quit: h.quit,
    exit: h.exit,
    getFileIcon: async (path: string) => {
      if (h.fileIconFails) throw new Error('no icon')
      return `icon:${path}`
    }
  },
  crashReporter: { start: h.crashStart },
  Menu: { buildFromTemplate: (items: unknown) => items, setApplicationMenu: (menu: unknown) => (h.appMenu = menu) },
  Tray: class {
    tooltip?: string
    menu?: { label?: string; click?: () => void }[]
    click?: () => void
    destroy = vi.fn()
    constructor(public image: unknown) {
      h.trays.push(this)
    }
    setToolTip(t: string) {
      this.tooltip = t
    }
    setContextMenu(m: { label?: string; click?: () => void }[]) {
      this.menu = m
    }
    on(_event: string, fn: () => void) {
      this.click = fn
    }
  },
  BrowserWindow: FakeWindow,
  ipcMain: {
    on: (ch: string, fn: (...a: unknown[]) => unknown) => h.ipcOn.set(ch, fn),
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => h.ipcHandle.set(ch, fn)
  },
  nativeTheme: {
    get shouldUseDarkColors() {
      return h.dark
    }
  },
  shell: { openExternal: h.openExternal, openPath: h.openPath },
  session: { defaultSession: h.defaultSession },
  protocol: {
    registerSchemesAsPrivileged: (schemes: unknown) => h.schemes(schemes),
    handle: (_scheme: string, fn: (request: unknown) => unknown) => (h.protocolHandler = fn)
  },
  nativeImage: {
    createFromDataURL: (url: string) => `image:${url.slice(0, 22)}`,
    createFromPath: (path: string) => ({ resize: (size: { width: number }) => ({ path, size: size.width }) }),
    createThumbnailFromPath: async (path: string, size: { width: number }) => ({
      isEmpty: () => h.thumbnail.empty,
      toPNG: () => `png:${path}:${size.width}`
    })
  },
  powerMonitor: { getSystemIdleTime: () => h.idleSeconds },
  dialog: {
    showErrorBox: (...a: unknown[]) => h.errorBox(...a),
    showMessageBoxSync: (...a: unknown[]) => h.messageBox(...(a as [])),
    showMessageBox: async (...a: unknown[]) => {
      const options = (a.length > 1 ? a[1] : a[0]) as { message: string; buttons: string[]; cancelId: number }
      h.asked.push({ parent: a.length > 1 ? a[0] : null, options })
      const answer = h.answers.shift() ?? { response: options.cancelId }
      return { response: answer.response, checkboxChecked: !!answer.checkboxChecked }
    }
  },
  Notification: class {
    static isSupported = () => h.notifySupported
    show = vi.fn()
    click?: () => void
    constructor(public opts: { title: string; body: string }) {
      h.notifications.push(this)
    }
    on(_event: string, fn: () => void) {
      this.click = fn
    }
  }
}))
vi.mock('electron-updater', () => ({ autoUpdater: h.updater }))
vi.mock('../../../electron/main/lib/log', () => ({
  Logger: class {
    dir: string
    constructor(opts: { dir: string }) {
      this.dir = opts.dir
    }
    recent = () => h.log.recent()
    error = h.log.error
    warn = h.log.warn
  },
  captureConsole: h.log.captured,
  catchCrashes: h.log.crashes,
  redact: (text: string) => text,
  rendererErrors: (logger: { error: (...a: unknown[]) => void }) => (r: { message: string }) => logger.error('renderer', r.message)
}))
// The logs folder is real (opening it creates it): a temp folder, not one at the root.
vi.mock('../../../electron/main/lib/paths', async () => {
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  return {
    mindeckPaths: () => ({ homeDir: '/h', dataDir: '/h/data', logsDir: join(tmpdir(), 'mindeck-main-test', 'logs') }),
    migrateLegacyData: (_paths: unknown, legacy: string) => h.migrate(legacy)
  }
})
vi.mock('../../../electron/main/platform/electron', () => ({
  electronPlatform: { kind: 'desktop' },
  electronCipher: () => ({ kind: 'cipher' }),
  secretsProtected: () => true
}))
vi.mock('../../../electron/ipc/registry', () => ({ bindIpc: h.bound }))
vi.mock('../../../electron/main/platform/sessionGuard', () => ({ guardSession: h.guard }))
vi.mock('../../../electron/main/platform/browser/host', () => ({ createBrowserHost: (...a: unknown[]) => (h.createHost(...a), h.host) }))
vi.mock('../../../electron/main/platform/fileProtocol', () => ({ FILE_SCHEME: 'mindeck-file', serveFile: h.serveFile }))
vi.mock('../../../electron/main/core/createCore', () => ({
  createCore: vi.fn(async (opts: Record<string, unknown>) => {
    h.coreOpts = opts
    return {
      ...h.core,
      hub: {
        subscribe: (fn: (channel: string, payload: unknown) => void) => {
          h.hubListener = fn
          return () => {}
        }
      }
    }
  })
}))

const realPlatform = process.platform
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

/** Fresh module instance (main.ts runs its top-level wiring on import). */
async function boot(opts: { platform?: NodeJS.Platform; devUrl?: string; ready?: boolean } = {}) {
  Object.defineProperty(process, 'platform', { value: opts.platform ?? 'darwin' })
  if (opts.devUrl) process.env.ELECTRON_RENDERER_URL = opts.devUrl
  else delete process.env.ELECTRON_RENDERER_URL
  const on = process.on.bind(process)
  vi.spyOn(process, 'on').mockImplementation(((event: string, fn: () => void) => {
    if (event.startsWith('SIG')) h.signals.set(event, fn)
    else on(event, fn)
    return process
  }) as typeof process.on)
  vi.resetModules()
  await import('../../../electron/main')
  if (opts.ready !== false) {
    h.ready!()
    await flush()
  }
  return FakeWindow.all[0]
}

beforeEach(() => {
  FakeWindow.all = []
  h.appHandlers.clear()
  h.ipcOn.clear()
  h.signals.clear()
  h.ipcHandle.clear()
  h.dark = true
  h.coreOpts = undefined
  h.hubListener = undefined
  h.bound.mockReset()
  h.migrate.mockReset().mockReturnValue(false)
  h.core.system.setPaused.mockReset()
  h.core.terminal.killAll.mockReset()
  h.core.server.start.mockReset().mockResolvedValue(undefined)
  h.core.dispose.mockReset().mockResolvedValue(undefined)
  h.core.browser.attach.mockReset()
  h.core.browser.detach.mockReset()
  h.core.browser.openFromApp.mockReset().mockReturnValue(true)
  h.host.dispose.mockReset()
  h.createHost.mockReset()
  h.openExternal.mockClear()
  h.quit.mockReset()
  h.exit.mockReset()
  h.errorBox.mockReset()
  h.answers = []
  h.asked = []
  h.trays = []
  h.singleInstance = true
  h.running = { agents: 0, terminals: 0 }
  h.settings = {}
  h.packaged = false
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
  delete process.env.ELECTRON_RENDERER_URL
})

describe('main process boot', () => {
  it('builds the desktop core, binds its router to IPC, starts the embedded server, then opens the window (dev, macOS, dark)', async () => {
    const win = await boot({ devUrl: 'http://localhost:5173' })
    expect(h.coreOpts).toMatchObject({ mode: 'desktop', version: '0.1.0', platform: { kind: 'desktop' }, cipher: { kind: 'cipher' } })
    expect(String(h.coreOpts!.webRoot)).toMatch(/renderer$/)
    expect(h.bound).toHaveBeenCalledWith(h.core.router, expect.any(Function))
    // IPC answers Mindeck's own page only
    const trusted = h.bound.mock.calls[0][1] as (url: string) => boolean
    expect(trusted('http://localhost:5173/')).toBe(true)
    expect(trusted('https://evil.example/')).toBe(false)
    // The window's session answers the web's permission questions: only Mindeck's page reads the clipboard.
    expect(h.guard).toHaveBeenCalledWith(h.defaultSession, expect.any(Function))
    const clipboardFor = h.guard.mock.calls.at(-1)![1] as (url: string) => boolean
    expect(clipboardFor('http://localhost:5173/')).toBe(true)
    expect(clipboardFor('https://evil.example/')).toBe(false)
    expect(h.core.server.start).toHaveBeenCalled()
    // the browser's web views live in this window
    expect(h.createHost).toHaveBeenCalledWith(win, expect.objectContaining({ events: true }))
    expect(h.core.browser.attach).toHaveBeenCalledWith(h.host)
    expect(win.opts).toMatchObject({ titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 17 }, backgroundColor: '#04060b' })
    expect(win.opts).not.toHaveProperty('frame')
    expect(win.loadURL).toHaveBeenCalledWith('http://localhost:5173')
    // its own application menu: no reload on ⌘R, no window closing on ⌘W (development keeps reload and DevTools)
    const roles = JSON.stringify(h.appMenu)
    expect(roles).toContain('"editMenu"')
    expect(roles).toContain('"toggleDevTools"')
    expect(roles).not.toContain('"close"')
  })

  it('a core that fails to start: the reason (and where the log is), then Mindeck really ends — no window-less process holding the lock', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const failure of [Object.assign(new Error('EACCES: permission denied, mkdir /h/data'), { code: 'EACCES' }), 'disk full']) {
      h.core.server.start.mockReset().mockRejectedValue(failure)
      h.errorBox.mockReset()
      h.exit.mockReset()
      FakeWindow.all = []
      await boot()
      expect(h.errorBox).toHaveBeenCalledTimes(1)
      const [title, detail] = h.errorBox.mock.calls[0] as [string, string]
      expect(title).toBe('Mindeck could not start')
      expect(detail).toContain(typeof failure === 'string' ? failure : 'EACCES: permission denied')
      expect(detail).toContain(join(tmpdir(), 'mindeck-main-test', 'logs'))
      expect(h.exit).toHaveBeenCalledWith(1)
      expect(FakeWindow.all).toHaveLength(0)
      expect(h.appHandlers.has('second-instance')).toBe(false)
    }
    expect(err).toHaveBeenCalledWith('[app] the core failed to start', 'disk full')
  })

  it('updates itself only when packaged, through desktop channels on the core router', async () => {
    const handlers = () =>
      new Map(h.core.router.register.mock.calls.map(([channel, fn]) => [channel as string, fn as () => unknown]))
    h.core.router.register.mockClear()
    await boot()
    expect(handlers().get('update:status')!()).toEqual({ state: 'disabled', currentVersion: '0.1.0' })
    expect(h.updater.listeners.size).toBe(0)

    h.core.router.register.mockClear()
    h.packaged = true
    const win = await boot()
    h.packaged = false
    const on = handlers()
    expect(on.get('update:status')!()).toMatchObject({ state: 'idle' })
    await on.get('update:check')!()
    expect(h.updater.checkForUpdates).toHaveBeenCalled()
    expect(() => on.get('update:install')!()).toThrow('No update is ready')
    h.updater.listeners.get('update-downloaded')!({ version: '0.2.0' })
    expect(win.webContents.send).toHaveBeenCalledWith('update:status', expect.objectContaining({ state: 'ready', version: '0.2.0' }))
    on.get('update:install')!()
    expect(h.updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('needs a license only when packaged, and counts the trial only while someone is at the computer, looking at Mindeck', async () => {
    const win = await boot()
    expect(h.coreOpts!.cloud).toMatchObject({ enforced: false })
    const active = h.coreOpts!.isUserActive as () => boolean
    h.idleSeconds = 30
    expect(active()).toBe(true)
    h.idleSeconds = 301
    expect(active()).toBe(false)
    h.idleSeconds = 30
    // switched to another app a moment ago: still counts; in the background: not
    win.focused = false
    win.emit('blur')
    expect(active()).toBe(true)
    win.visible = false
    expect(active()).toBe(false)
    win.visible = true
    win.focused = true
    h.packaged = true
    await boot()
    expect(h.coreOpts!.cloud).toMatchObject({ enforced: true })
    h.packaged = false
  })

  it('agents needing the user notify only while Mindeck is in the background; a click brings it up', async () => {
    const win = await boot()
    const notify = h.coreOpts!.notify as (title: string, body: string) => void
    const isFocused = h.coreOpts!.isFocused as () => boolean
    h.notifications.length = 0
    h.focused = win
    notify('Claude Code · fix', 'Waiting for your approval')
    expect(h.notifications).toHaveLength(0) // looking at Mindeck already
    expect(isFocused()).toBe(true) // no push to the phone either
    h.focused = null
    expect(isFocused()).toBe(false)
    h.notifySupported = false
    notify('x', 'y')
    expect(h.notifications).toHaveLength(0)
    h.notifySupported = true
    notify('Claude Code · fix', 'Waiting for your approval')
    expect(h.notifications[0].opts).toEqual({ title: 'Claude Code · fix', body: 'Waiting for your approval' })
    expect(h.notifications[0].show).toHaveBeenCalled()
    h.notifications[0].click!()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    win.emit('closed')
    h.notifications[0].click!() // no window anymore: harmless
  })

  it('packaged on Linux in light mode: frameless window, file URL', async () => {
    h.dark = false
    const win = await boot({ platform: 'linux' })
    expect(win.opts).toMatchObject({ frame: false, backgroundColor: '#eef2f7' })
    expect(win.loadFile).toHaveBeenCalledWith(expect.stringMatching(/renderer[\\/]index\.html$/))
    // packaged: only the bundled index.html is Mindeck's page
    const trusted = h.bound.mock.calls[0][1] as (url: string) => boolean
    expect(trusted(String(win.loadFile.mock.calls[0][0]).replace(/^/, 'file://').replace(/\\/g, '/'))).toBe(true)
    expect(trusted('file:///etc/passwd')).toBe(false)
  })

  it('logs a successful legacy-data copy and survives a failing one', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    h.migrate.mockReturnValueOnce(true)
    await boot()
    expect(h.migrate).toHaveBeenCalledWith(expect.stringMatching(/userData[\\/]mindeck$/))
    expect(log.mock.calls[0][0]).toMatch(/^\[data\] copied .*mindeck → \/h\/data$/)

    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.migrate.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    await boot()
    expect(err.mock.calls[0][0]).toContain('migration from the old data folder failed')
  })
})

describe('window wiring', () => {
  it('forwards window state, pauses telemetry, routes links outside, cleans up on close', async () => {
    const win = await boot()
    const system = h.core.system

    win.emit('ready-to-show')
    expect(win.show).toHaveBeenCalled()
    win.maximized = true
    win.emit('maximize')
    win.emit('unmaximize')
    expect(win.webContents.send).toHaveBeenCalledWith('window:maximized-changed', true)
    win.fullScreen = true
    win.emit('enter-full-screen')
    win.emit('leave-full-screen')
    expect(win.webContents.send).toHaveBeenCalledWith('window:fullscreen-changed', true)

    for (const [event, paused] of [['minimize', true], ['restore', false], ['hide', true], ['show', false]] as const) {
      win.emit(event)
      expect(system.setPaused).toHaveBeenLastCalledWith(paused)
    }

    // links never open in this window: web pages go to Mindeck's browser …
    expect(win.openHandler!({ url: 'https://example.com' })).toEqual({ action: 'deny' })
    expect(h.core.browser.openFromApp).toHaveBeenCalledWith('https://example.com')
    expect(h.openExternal).not.toHaveBeenCalled()
    // … or the system's when the user prefers it; mail goes to the mail app; anything else nowhere
    h.core.browser.openFromApp.mockReturnValueOnce(false)
    win.openHandler!({ url: 'http://example.com/a' })
    expect(h.openExternal).toHaveBeenCalledWith('http://example.com/a')
    win.openHandler!({ url: 'mailto:robin@example.com' })
    expect(h.openExternal).toHaveBeenCalledWith('mailto:robin@example.com')
    win.openHandler!({ url: 'file:///etc/passwd' })
    win.openHandler!({ url: 'smb://server/share' })
    expect(h.openExternal).toHaveBeenCalledTimes(2)

    // and the window itself never navigates away from Mindeck
    const navigate = win.contentsHandlers.get('will-navigate')!
    const away = { preventDefault: vi.fn() }
    navigate(away, 'https://evil.example/')
    expect(away.preventDefault).toHaveBeenCalled()
    expect(h.core.browser.openFromApp).toHaveBeenLastCalledWith('https://evil.example/')
    const reload = { preventDefault: vi.fn() }
    navigate(reload, String(win.loadFile.mock.calls[0][0]).replace(/^/, 'file://'))
    expect(reload.preventDefault).not.toHaveBeenCalled()

    win.emit('closed')
    expect(h.core.terminal.killAll).toHaveBeenCalled()
    expect(h.core.browser.detach).toHaveBeenCalled()
    expect(h.host.dispose).toHaveBeenCalled()
  })

  it('serves local files to the Files module through its own scheme, with OS thumbnails', async () => {
    await boot()
    expect(h.schemes).toHaveBeenCalledWith([{ scheme: 'mindeck-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
    const deps = (await h.protocolHandler!({ url: 'mindeck-file://local/x' })) as { thumbnail: (path: string, size: number) => Promise<unknown> }
    expect(h.serveFile).toHaveBeenCalledWith({ url: 'mindeck-file://local/x' }, expect.any(Object))
    expect(await deps.thumbnail('/a.pdf', 256)).toBe('png:/a.pdf:256')
    h.thumbnail.empty = true
    expect(await deps.thumbnail('/a.bin', 64)).toBeNull()
    h.thumbnail.empty = false
  })

  it('asks before an unload the editor vetoed: Cancel keeps the window, Discard closes it', async () => {
    const win = await boot()
    const veto = win.contentsHandlers.get('will-prevent-unload')!
    const cancel = { preventDefault: vi.fn() }
    veto(cancel)
    expect(h.messageBox).toHaveBeenCalledWith(win, expect.objectContaining({ message: 'You have unsaved changes in the editor.' }))
    expect(cancel.preventDefault).not.toHaveBeenCalled() // the veto stands
    h.messageBox.mockReturnValueOnce(0)
    const discard = { preventDefault: vi.fn() }
    veto(discard)
    expect(discard.preventDefault).toHaveBeenCalled() // ignore the veto → close
  })

  it('drags files out as an OS drag with their icon — only from Mindeck’s page, only real absolute paths', async () => {
    await boot({ devUrl: 'http://localhost:5173' })
    const startDrag = vi.fn()
    const drag = (paths: unknown, frame: { url: string } | null = { url: 'http://localhost:5173/' }) =>
      h.ipcOn.get('files:start-drag')!({ senderFrame: frame, sender: { startDrag } }, paths)
    const file = join(process.cwd(), 'package.json')
    drag([file, 'relative', '/no/such/file', 42])
    await flush()
    expect(startDrag).toHaveBeenLastCalledWith({ file, files: [file], icon: `icon:${file}` })
    h.fileIconFails = true
    drag([file])
    await flush()
    expect(startDrag).toHaveBeenLastCalledWith({ file, files: [file], icon: 'image:data:image/png;base64,' })
    h.fileIconFails = false
    drag([file], { url: 'https://evil.example/' })
    drag([file], null)
    drag('not a list')
    drag(['/no/such/file'])
    await flush()
    expect(startDrag).toHaveBeenCalledTimes(2)
  })

  it('window-control IPC acts on the current window, and is safe without one', async () => {
    await boot({ ready: false })
    // before any window exists
    h.ipcOn.get('window:minimize')!()
    h.ipcOn.get('window:toggle-maximize')!()
    h.ipcOn.get('window:close')!()
    h.ipcOn.get('window:toggle-fullscreen')!()
    expect(h.ipcHandle.get('window:is-maximized')!()).toBe(false)
    expect(h.ipcHandle.get('window:is-fullscreen')!()).toBe(false)

    h.ready!()
    await flush()
    const win = FakeWindow.all[0]
    h.ipcOn.get('window:minimize')!()
    h.ipcOn.get('window:toggle-maximize')!()
    expect(win.maximize).toHaveBeenCalled()
    win.maximized = true
    h.ipcOn.get('window:toggle-maximize')!()
    expect(win.unmaximize).toHaveBeenCalled()
    expect(h.ipcHandle.get('window:is-maximized')!()).toBe(true)
    h.ipcOn.get('window:toggle-fullscreen')!()
    expect(win.setFullScreen).toHaveBeenLastCalledWith(true)
    expect(h.ipcHandle.get('window:is-fullscreen')!()).toBe(true)
    h.ipcOn.get('window:toggle-fullscreen')!()
    expect(win.setFullScreen).toHaveBeenLastCalledWith(false)
    // ⌃⌘F on macOS: full screen before the page and the menu see the key
    const keys = win.contentsHandlers.get('before-input-event')!
    const typed = { preventDefault: vi.fn() }
    keys(typed, { type: 'keyDown', key: 'f', meta: true, control: false, alt: false, shift: false })
    expect(typed.preventDefault).not.toHaveBeenCalled()
    keys(typed, { type: 'keyDown', key: 'f', meta: true, control: true, alt: false, shift: false })
    expect(typed.preventDefault).toHaveBeenCalled()
    expect(win.setFullScreen).toHaveBeenLastCalledWith(true)
    win.fullScreen = true
    h.ipcOn.get('window:close')!()
    expect(win.minimize).toHaveBeenCalled()
    expect(win.close).toHaveBeenCalled()

    // after the window closed, a second window from "activate" becomes current
    win.emit('closed')
    expect(h.ipcHandle.get('window:is-maximized')!()).toBe(false)
    FakeWindow.all = []
    h.appHandlers.get('activate')!()
    expect(FakeWindow.all).toHaveLength(1)
    const second = FakeWindow.all[0]
    win.emit('closed') // a stale window closing must not clear the new one
    second.maximized = true
    expect(h.ipcHandle.get('window:is-maximized')!()).toBe(true)
    h.appHandlers.get('activate')!() // windows exist → no new one
    expect(FakeWindow.all).toHaveLength(1)
  })
})

describe('stability', () => {
  it('logs to ~/Mindeck/logs, catches stray crashes and keeps native crash reports local', async () => {
    await boot()
    expect(h.log.captured).toHaveBeenCalled()
    expect(h.log.crashes).toHaveBeenCalled()
    expect(h.setPath).toHaveBeenCalledWith('crashDumps', join(tmpdir(), 'mindeck-main-test', 'logs', 'crashes'))
    expect(h.crashStart).toHaveBeenCalledWith({ uploadToServer: false })
  })

  it('runs once: a second start quits and brings the running one up', async () => {
    h.singleInstance = false
    await boot()
    expect(h.quit).toHaveBeenCalled()
    expect(FakeWindow.all).toHaveLength(0)
    h.singleInstance = true
    h.quit.mockReset()
    const win = await boot()
    win.visible = false
    h.appHandlers.get('second-instance')!()
    expect(win.show).toHaveBeenCalled()
    expect(h.quit).not.toHaveBeenCalled()
  })

  it('macOS: closing the window with agents running keeps them — the Dock brings it back', async () => {
    const win = await boot()
    h.running = { agents: 1, terminals: 2 }
    const close = { preventDefault: vi.fn() }
    win.emit('close', close)
    expect(close.preventDefault).toHaveBeenCalled()
    expect(win.hide).toHaveBeenCalled()
    expect(h.core.terminal.killAll).not.toHaveBeenCalled()
    h.appHandlers.get('activate')!()
    expect(win.show).toHaveBeenCalled()
    expect(FakeWindow.all).toHaveLength(1)
    // ⌘Q asks while they run
    const quit = { preventDefault: vi.fn() }
    h.answers.push({ response: 0 })
    h.appHandlers.get('before-quit')!(quit)
    expect(quit.preventDefault).toHaveBeenCalled()
    await flush()
    expect(h.asked[0].options).toMatchObject({ message: '1 agent session and 2 terminals are still running', buttons: ['Quit Mindeck', 'Cancel'] })
    expect(h.asked[0].parent).toBe(win) // the window is on screen: the dialog belongs to it
    expect(h.quit).toHaveBeenCalled()
    // now quitting: the window closes, its shells end
    const final = { preventDefault: vi.fn() }
    win.emit('close', final)
    expect(final.preventDefault).not.toHaveBeenCalled()
    win.emit('closed')
    expect(h.core.terminal.killAll).toHaveBeenCalled()
  })

  it('Windows/Linux: closing asks; in the background a tray icon shows it again or quits; the choice can be remembered', async () => {
    const win = await boot({ platform: 'linux' })
    h.running = { agents: 2, terminals: 0 }
    h.answers.push({ response: 0, checkboxChecked: true })
    win.emit('close', { preventDefault: vi.fn() })
    await flush()
    expect(h.asked[0].options.buttons).toEqual(['Keep running in background', 'Quit Mindeck', 'Cancel'])
    expect(win.hide).toHaveBeenCalled()
    expect(h.settings).toEqual({ closeBehavior: 'background' })
    const tray = h.trays[0]
    expect(tray.image).toEqual({ path: expect.stringMatching(/build[\\/]icon\.png$/), size: 22 })
    expect(tray.tooltip).toContain('background')
    expect(tray.menu!.map((m) => m.label ?? m.type)).toEqual(['Show Mindeck', 'separator', 'Quit Mindeck'])
    tray.click!()
    expect(win.show).toHaveBeenCalled()
    expect(tray.destroy).toHaveBeenCalled()

    // remembered: straight to the background, no dialog; a hidden window gets a parentless dialog on quit
    win.emit('close', { preventDefault: vi.fn() })
    expect(h.asked).toHaveLength(1)
    h.trays[1].menu![2].click!()
    expect(h.quit).toHaveBeenCalled()
    h.appHandlers.get('before-quit')!({ preventDefault: vi.fn() })
    await flush()
    expect(h.asked[1].parent).toBeNull()

    // packaged on Windows: the icon from the app's resources, at tray size
    h.packaged = true
    Object.defineProperty(process, 'resourcesPath', { value: '/opt/Mindeck/resources', configurable: true })
    await boot({ platform: 'win32' })
    h.settings = { closeBehavior: 'background' }
    FakeWindow.all.at(-1)!.emit('close', { preventDefault: vi.fn() })
    expect(h.trays.at(-1)!.image).toEqual({ path: expect.stringMatching(/resources[\\/]tray\.png$/), size: 16 })
    delete (process as { resourcesPath?: string }).resourcesPath
  })

  it('shells at their prompt do not hold the window or a quit; Ctrl+C where Mindeck was started quits without asking', async () => {
    const win = await boot()
    const close = { preventDefault: vi.fn() }
    win.emit('close', close) // only an idle shell: the window just closes
    expect(close.preventDefault).not.toHaveBeenCalled()
    expect(h.asked).toHaveLength(0)

    await boot()
    expect([...h.signals.keys()]).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP'])
    h.running = { agents: 1, terminals: 2 }
    h.signals.get('SIGINT')!()
    expect(h.quit).toHaveBeenCalled()
    const quit = { preventDefault: vi.fn() }
    h.appHandlers.get('before-quit')!(quit) // the quit it started goes through
    expect(quit.preventDefault).not.toHaveBeenCalled()
    expect(h.asked).toHaveLength(0)
  })

  it('the editor keeping its window open cancels a quit', async () => {
    const win = await boot({ platform: 'linux' })
    h.appHandlers.get('before-quit')!({ preventDefault: vi.fn() }) // nothing runs: quitting
    win.contentsHandlers.get('will-prevent-unload')!({ preventDefault: vi.fn() }) // Cancel: the window stays
    h.running = { agents: 1, terminals: 0 }
    const close = { preventDefault: vi.fn() }
    win.emit('close', close)
    expect(close.preventDefault).toHaveBeenCalled() // not quitting anymore: asks again
  })

  it('reloads a crashed window and offers to reload a hanging one; logs helper processes that died', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const win = await boot({ devUrl: 'http://localhost:5173' })
    win.loadURL.mockClear()
    win.contentsHandlers.get('render-process-gone')!({}, { reason: 'crashed', exitCode: 11 })
    await flush()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('renderer is gone (crashed, exit code 11)'))
    expect(win.loadURL).toHaveBeenCalledWith('http://localhost:5173')

    h.answers.push({ response: 1 })
    win.emit('unresponsive')
    await flush()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not responding'))
    expect(h.asked[0].options.buttons).toEqual(['Wait', 'Reload'])
    expect(win.loadURL).toHaveBeenCalledTimes(2)
    win.emit('responsive')

    // crashing twice in a row asks (in English once the core is gone)
    h.appHandlers.get('will-quit')!({ preventDefault: vi.fn() })
    win.contentsHandlers.get('render-process-gone')!({}, { reason: 'crashed', exitCode: 11 })
    await flush()
    expect(h.asked[1].options.message).toBe('Mindeck’s window crashed again')
    expect(win.loadURL).toHaveBeenCalledTimes(3) // "Reload" is the default answer

    // a destroyed window is not reloaded
    win.destroyed = true
    win.contentsHandlers.get('render-process-gone')!({}, { reason: 'oom', exitCode: 0 })
    await flush()
    expect(win.loadURL).toHaveBeenCalledTimes(3)

    h.appHandlers.get('child-process-gone')!({}, { type: 'GPU', reason: 'crashed', exitCode: 1 })
    h.appHandlers.get('child-process-gone')!({}, { type: 'Utility', name: 'Network Service', reason: 'killed', exitCode: 9 })
    h.appHandlers.get('child-process-gone')!({}, { type: 'Utility', reason: 'clean-exit', exitCode: 0 })
    expect(warn.mock.calls.slice(1).map((c) => c[0])).toEqual([
      '[app] GPU process gone: crashed, exit code 1',
      '[app] Utility (Network Service) process gone: killed, exit code 9'
    ])
    // Quitting ends Mindeck's own helpers: not worth a warning — a crash still is.
    h.appHandlers.get('before-quit')!({ preventDefault: vi.fn() })
    h.appHandlers.get('child-process-gone')!({}, { type: 'Utility', name: 'TypeScript', reason: 'killed', exitCode: 2 })
    h.appHandlers.get('child-process-gone')!({}, { type: 'GPU', reason: 'crashed', exitCode: 1 })
    expect(warn.mock.calls.slice(3).map((c) => c[0])).toEqual(['[app] GPU process gone: crashed, exit code 1'])
  })

  it('a redirect never takes the window away from Mindeck', async () => {
    const win = await boot({ devUrl: 'http://localhost:5173' })
    const redirect = win.contentsHandlers.get('will-redirect')!
    const away = { preventDefault: vi.fn() }
    redirect(away, 'https://evil.example/')
    expect(away.preventDefault).toHaveBeenCalled()
    const home = { preventDefault: vi.fn() }
    redirect(home, 'http://localhost:5173/#x')
    expect(home.preventDefault).not.toHaveBeenCalled()
  })

  it('serves the desktop channels: status, diagnostics, error reports', async () => {
    h.core.router.register.mockClear()
    await boot()
    const on = new Map(h.core.router.register.mock.calls.map(([channel, fn]) => [channel as string, fn as (req?: unknown) => unknown]))
    const logsDir = join(tmpdir(), 'mindeck-main-test', 'logs')
    expect(on.get('desktop:status')!()).toMatchObject({ logsDir, secretsEncrypted: true, closeBehavior: 'ask' })
    // the logs folder goes to the system's file manager, looked up when asked (tests swap it in a running app)
    await on.get('desktop:openLogs')!()
    expect(h.openPath).toHaveBeenCalledWith(logsDir)
    const text = on.get('desktop:diagnostics')!() as string
    expect(text).toContain('Mindeck 0.1.0 (dev)')
    expect(text).toContain('Locale: de-DE')
    expect(text).toContain('License: active')
    on.get('desktop:reportError')!({ kind: 'app', message: 'boom' })
    expect(h.log.error).toHaveBeenCalledWith('renderer', 'boom')
  })
})

describe('core push events', () => {
  it('forwards every hub event to each live window', async () => {
    const win = await boot()
    const dead = new FakeWindow({})
    dead.destroyed = true
    h.hubListener!('system:tick', { cpu: 1 })
    expect(win.webContents.send).toHaveBeenCalledWith('system:tick', { cpu: 1 })
    expect(dead.webContents.send).not.toHaveBeenCalled()
  })
})

describe('app lifecycle', () => {
  it('waits for the core to save and stop, then quits — once', async () => {
    await boot()
    let finish!: () => void
    h.core.dispose.mockImplementation(() => new Promise<void>((done) => (finish = done)))
    const quit = { preventDefault: vi.fn() }
    h.appHandlers.get('will-quit')!(quit)
    expect(quit.preventDefault).toHaveBeenCalled() // held until the core is down
    expect(h.core.dispose).toHaveBeenCalledTimes(1)
    await flush()
    expect(h.quit).not.toHaveBeenCalled()
    finish()
    await flush()
    expect(h.quit).not.toHaveBeenCalled() // not inside this will-quit: Electron would ignore it
    await new Promise((done) => setImmediate(done))
    expect(h.quit).toHaveBeenCalledTimes(1)
    const again = { preventDefault: vi.fn() }
    h.appHandlers.get('will-quit')!(again) // the quit goes on: core already released
    expect(again.preventDefault).not.toHaveBeenCalled()
    expect(h.core.dispose).toHaveBeenCalledTimes(1)
  })

  it('a core that does not stop in time does not keep Mindeck from quitting', async () => {
    await boot()
    vi.useFakeTimers()
    try {
      h.core.dispose.mockImplementation(() => new Promise<void>(() => {}))
      h.appHandlers.get('will-quit')!({ preventDefault: vi.fn() })
      await vi.advanceTimersByTimeAsync(4999)
      expect(h.quit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await vi.runOnlyPendingTimersAsync() // the quit's own next task
      expect(h.quit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('quit before anything started is harmless; a failing dispose is logged and the quit goes on', async () => {
    await boot({ ready: false })
    const early = { preventDefault: vi.fn() }
    h.appHandlers.get('before-quit')!(early) // nothing runs yet
    expect(early.preventDefault).not.toHaveBeenCalled()
    const nothing = { preventDefault: vi.fn() }
    h.appHandlers.get('will-quit')!(nothing)
    expect(nothing.preventDefault).not.toHaveBeenCalled()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.core.dispose.mockRejectedValue(new Error('pool gone'))
    await boot()
    h.appHandlers.get('will-quit')!({ preventDefault: vi.fn() })
    await flush()
    await new Promise((done) => setImmediate(done))
    expect(error).toHaveBeenCalledWith('[app] shutting the core down failed', expect.any(Error))
    expect(h.quit).toHaveBeenCalledTimes(1)
  })

  it('quits when all windows close, except on macOS', async () => {
    await boot({ ready: false })
    h.appHandlers.get('window-all-closed')!()
    expect(h.quit).not.toHaveBeenCalled()
    await boot({ platform: 'win32', ready: false })
    h.appHandlers.get('window-all-closed')!()
    expect(h.quit).toHaveBeenCalled()
  })
})
