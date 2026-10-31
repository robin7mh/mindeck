import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, protocol, session, shell, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { release, type } from 'node:os'
import { pathToFileURL } from 'node:url'
import { migrateLegacyData, mindeckPaths } from './main/lib/paths'
import { captureConsole, catchCrashes, Logger } from './main/lib/log'
import { electronCipher, electronPlatform, secretsProtected } from './main/platform/electron'
import { DesktopLifecycle, usingMindeck, type LifecycleLabels } from './main/platform/lifecycle'
import { registerDesktopIpc } from './ipc/desktop.ipc'
import { createCore, type Core } from './main/core/createCore'
import { bindIpc } from './ipc/registry'
import { autoUpdater } from 'electron-updater'
import { cloudConfig } from './main/services/cloud/config'
import { manualUpdateFile, UpdateService } from './main/services/update/UpdateService'
import { createBrowserHost } from './main/platform/browser/host'
import { isFullScreenKey } from './main/platform/browser/shortcuts'
import { FILE_SCHEME, serveFile } from './main/platform/fileProtocol'
import { appMenuTemplate } from './main/platform/menu'
import { guardSession } from './main/platform/sessionGuard'

/** A 1×1 picture for drags whose file has no icon. */
const DRAG_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** After this long without keyboard or mouse, the trial clock pauses. */
const IDLE_SECONDS = 5 * 60
/** The longest a quit waits for the core to save and stop. */
const DISPOSE_TIMEOUT_MS = 5000

// ~/Mindeck/{data,vault,logs} holds everything — every location derives from paths.ts.
const paths = mindeckPaths()

// Everything the main process says, and every crash it survives, lands in
// ~/Mindeck/logs (rotated); native crashes leave a minidump there — nothing is uploaded.
const logger = new Logger({ dir: paths.logsDir })
captureConsole(logger)
catchCrashes(logger)
app.setPath('crashDumps', join(paths.logsDir, 'crashes'))
crashReporter.start({ uploadToServer: false })

// One Mindeck at a time: a second start (a shortcut, the dock while it runs in the
// background) brings the running one up instead of opening the same data twice.
const primary = app.requestSingleInstanceLock()
if (!primary) app.quit()

// main/preload are bundled as CommonJS (Electron's well-supported default), so
// __dirname is natively available — no import.meta shim needed.

// electron-vite injects the dev server URL in development.
const DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL']

let mainWindow: BrowserWindow | null = null
let core: Core | null = null
let updates: UpdateService | null = null
/** When the window last lost the focus — the trial still counts a short while after. */
let lastFocusAt = 0

/** Loads Mindeck's page into the window (again, after a crash). */
function loadApp(win: BrowserWindow): void {
  if (DEV_SERVER_URL) void win.loadURL(DEV_SERVER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

/** The tray icon while Mindeck runs in the background (Windows/Linux). */
function createTray(l: LifecycleLabels, actions: { show(): void; quit(): void }): Tray {
  const icon = app.isPackaged ? join(process.resourcesPath, 'tray.png') : join(__dirname, '../../build/tray.png')
  const size = process.platform === 'win32' ? 16 : 22
  const tray = new Tray(nativeImage.createFromPath(icon).resize({ width: size, height: size }))
  tray.setToolTip(l.tooltip)
  tray.setContextMenu(Menu.buildFromTemplate([{ label: l.show, click: actions.show }, { type: 'separator' }, { label: l.quit, click: actions.quit }]))
  tray.on('click', actions.show)
  return tray
}

/** The work closing the window would end: live agent sessions, and terminals running a program (a shell at its prompt loses nothing). */
function running() {
  return { agents: core?.agents.list().filter((s) => s.live).length ?? 0, terminals: core?.terminal.list().filter((t) => t.running).length ?? 0 }
}

/** Closing the window, quitting, a crashed window — and the agents and terminals that keep running. */
const lifecycle = new DesktopLifecycle({
  platform: process.platform,
  running,
  closeBehavior: () => core?.settings.get().closeBehavior ?? 'ask',
  remember: async (closeBehavior) => core?.settings.update({ closeBehavior }),
  ask: (options) => {
    const parent = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null
    return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
  },
  locale: () => core?.browser.hostEvents().locale() ?? 'en',
  createTray,
  quit: () => app.quit(),
  reload: () => {
    if (mainWindow && !mainWindow.isDestroyed()) loadApp(mainWindow)
  }
})

// Previews in the Files module (images, video, audio) come from local files through this scheme.
protocol.registerSchemesAsPrivileged([{ scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

/** Mindeck's own page — the only one its window ever shows, and the only one IPC answers. */
function isAppUrl(url: string): boolean {
  return DEV_SERVER_URL ? url.startsWith(DEV_SERVER_URL) : url.startsWith(pathToFileURL(join(__dirname, '../renderer/index.html')).href)
}

/**
 * A link clicked in the UI (an agent's answer, a note): web addresses open in
 * Mindeck's browser (or the system's, as the user prefers), mail in the mail
 * app — and nothing else leaves the app.
 */
function openLink(url: string): void {
  if (/^https?:\/\//i.test(url)) {
    if (!core?.browser.openFromApp(url)) void shell.openExternal(url)
  } else if (/^mailto:/i.test(url)) {
    void shell.openExternal(url)
  }
}

/** Broadcast a push event to every live renderer. */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    // macOS keeps its native traffic lights, centered in the 48px top bar;
    // elsewhere the window is frameless and TopStatusBar draws the controls.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 16, y: 17 } }
      : { frame: false }),
    // Matches --bg-void of the theme the renderer will pick by default (OS appearance).
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#04060b' : '#eef2f7',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = win

  // The browser's web views live in this window (the core starts before any window).
  const browserHost = createBrowserHost(win, core!.browser.hostEvents())
  core!.browser.attach(browserHost)

  win.on('ready-to-show', () => win.show())
  // With agents or terminals running, closing hides the window (or asks) instead.
  win.on('close', (event) => lifecycle.onClose(win, event))
  win.on('closed', () => {
    // It really closed: nothing was running, or Mindeck is quitting.
    core?.terminal.killAll()
    core?.browser.detach()
    browserHost.dispose()
    if (mainWindow === win) mainWindow = null
  })

  // Emit maximize state changes so the renderer can swap the maximize/restore icon.
  const emitMaxState = () => win.webContents.send('window:maximized-changed', win.isMaximized())
  win.on('maximize', emitMaxState)
  win.on('unmaximize', emitMaxState)

  // ⌃⌘F / F11: full screen, before the page and the menu see the key (the pages' own views do the same).
  const mac = process.platform === 'darwin'
  win.webContents.on('before-input-event', (event, input) => {
    if (!isFullScreenKey(input, mac)) return
    event.preventDefault()
    win.setFullScreen(!win.isFullScreen())
  })

  // macOS hides the traffic lights in fullscreen; the top bar drops their gap.
  const emitFullScreen = () => win.webContents.send('window:fullscreen-changed', win.isFullScreen())
  win.on('enter-full-screen', emitFullScreen)
  win.on('leave-full-screen', emitFullScreen)

  // Pause telemetry sampling while the window is hidden/minimized (save energy).
  win.on('minimize', () => core?.system.setPaused(true))
  win.on('restore', () => core?.system.setPaused(false))
  win.on('hide', () => core?.system.setPaused(true))
  win.on('show', () => core?.system.setPaused(false))
  win.on('blur', () => (lastFocusAt = Date.now()))

  // The renderer crashed or hangs: Mindeck's work runs in this process — bring the window back.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[window] the renderer is gone (${details.reason}, exit code ${details.exitCode})`)
    void lifecycle.onRendererGone(details.reason)
  })
  win.on('unresponsive', () => {
    console.warn('[window] the renderer is not responding')
    void lifecycle.onUnresponsive()
  })
  win.on('responsive', () => lifecycle.onResponsive())

  // The editor vetoes unloading while files have unsaved edits — ask the user.
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes in the editor.',
      detail: 'Close anyway and lose them?'
    })
    if (choice === 0) event.preventDefault()
    else lifecycle.cancelQuit() // the window stays: so does Mindeck
  })

  // The window never navigates away from Mindeck: links go to the browser (or their app) instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openLink(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    openLink(url)
  })
  // Nor does a redirect take it elsewhere.
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })

  loadApp(win)
}

// --- Window control IPC (invoked from preload bridge) ---
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow) return
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
})
ipcMain.on('window:close', () => mainWindow?.close())
ipcMain.on('window:toggle-fullscreen', () => mainWindow?.setFullScreen(!mainWindow.isFullScreen()))
ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false)
ipcMain.handle('window:is-fullscreen', () => mainWindow?.isFullScreen() ?? false)

// Files dragged out of the Files module: an OS drag, so Finder, mail or chat apps take them.
ipcMain.on('files:start-drag', (event, paths: unknown) => {
  if (!isAppUrl(event.senderFrame?.url ?? '')) return
  const files = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string' && isAbsolute(p) && existsSync(p)).slice(0, 1000) : []
  if (!files.length) return
  void app
    .getFileIcon(files[0], { size: 'normal' })
    // macOS wants an icon, however small.
    .catch(() => nativeImage.createFromDataURL(DRAG_ICON))
    .then((icon) => event.sender.startDrag({ file: files[0], files, icon }))
})

/** An agent needs the user: tell them — unless they are looking at Mindeck already. */
function notify(title: string, body: string): void {
  if (!Notification.isSupported() || BrowserWindow.getFocusedWindow()) return
  const n = new Notification({ title, body })
  n.on('click', () => {
    if (mainWindow) lifecycle.reveal(mainWindow)
  })
  n.show()
}

async function startCore(): Promise<void> {
  const legacyDir = join(app.getPath('userData'), 'mindeck')
  try {
    if (migrateLegacyData(paths, legacyDir)) console.log(`[data] copied ${legacyDir} → ${paths.dataDir}`)
  } catch (err) {
    console.error('[data] migration from the old data folder failed — starting fresh\n', err)
  }

  const cipher = electronCipher()
  core = await createCore({
    mode: 'desktop',
    version: app.getVersion(),
    paths,
    platform: electronPlatform,
    cipher,
    // The embedded network API (opt-in) serves the packaged renderer as web UI.
    webRoot: join(__dirname, '../renderer'),
    notify,
    isFocused: () => !!BrowserWindow.getFocusedWindow(),
    // The packaged app needs a license; `npm run dev` only with MINDECK_LICENSE=required.
    cloud: cloudConfig(app.isPackaged),
    // The trial counts only while Mindeck is in front of someone — not while it runs in the background.
    isUserActive: () => usingMindeck(mainWindow, lastFocusAt, Date.now(), powerMonitor.getSystemIdleTime() >= IDLE_SECONDS)
  })
  core.hub.subscribe(broadcast)
  const c = core

  // Self-update only where it can work: the packaged app (GitHub Releases).
  updates = new UpdateService({
    updater: app.isPackaged ? autoUpdater : null,
    currentVersion: app.getVersion(),
    onStatus: (status) => broadcast('update:status', status),
    // A .deb can't replace itself: the user downloads the new version.
    manualDownload: manualUpdateFile(process.platform, process.arch, process.resourcesPath)
  })
  const u = updates
  core.router.register('update:status', () => u.status())
  core.router.register('update:check', () => u.check())
  core.router.register('update:install', () => u.install())
  u.start()

  registerDesktopIpc(core.router, {
    logger,
    settings: core.settings,
    secretsEncrypted: !!cipher && secretsProtected(),
    openPath: (path) => shell.openPath(path),
    diagnostics: () => ({
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      os: `${type()} ${release()}`,
      versions: process.versions,
      locale: app.getLocale(),
      packaged: app.isPackaged,
      license: c.cloud.status().state,
      running: running(),
      uptime: process.uptime(),
      home: app.getPath('home')
    })
  })

  bindIpc(core.router, isAppUrl)
  await core.server.start()
}

app.whenReady().then(async () => {
  if (!primary) return
  // Mindeck's page gets full screen and the clipboard (Paste reads it) — no microphone, camera, location or screen.
  guardSession(session.defaultSession, isAppUrl)
  protocol.handle(FILE_SCHEME, (request) =>
    serveFile(request, {
      thumbnail: async (path, size) => {
        const image = await nativeImage.createThumbnailFromPath(path, { width: size, height: size })
        return image.isEmpty() ? null : image.toPNG()
      }
    })
  )
  // Mindeck's own menu: Electron's default one would reload the UI on ⌘R and close the window on ⌘W.
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(process.platform, !app.isPackaged)))
  try {
    await startCore()
  } catch (err) {
    // No window, no tray: a Mindeck left running would only hold the single-instance lock, and
    // every later start would end at once. Say why, then really end.
    console.error('[app] the core failed to start', err)
    dialog.showErrorBox('Mindeck could not start', `${err instanceof Error ? err.message : String(err)}\n\nDetails are in the log: ${paths.logsDir}`)
    app.exit(1)
    return
  }
  createWindow()
  // The Dock (macOS), or a second start: the window back — a new one if it really closed.
  const bringBack = () => (mainWindow ? lifecycle.reveal(mainWindow) : createWindow())
  app.on('activate', bringBack)
  app.on('second-instance', bringBack)
})

// ⌘Q, the tray, the app menu, an update: confirm while agents or terminals run.
app.on('before-quit', (event) => lifecycle.onBeforeQuit(event))

// Ctrl+C where Mindeck was started (npm run dev), `kill`, that terminal closing: quit
// without asking — no one is at the window to answer, and Mindeck must not linger.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => lifecycle.quitNow())

// A helper process (GPU, network, a utility) ended unexpectedly — for the log. While
// quitting, Mindeck ends its own helpers (tsserver, the lint worker): that is no news.
app.on('child-process-gone', (_event, details) => {
  if (details.reason === 'clean-exit' || (details.reason === 'killed' && lifecycle.isQuitting)) return
  console.warn(`[app] ${details.type}${details.name ? ` (${details.name})` : ''} process gone: ${details.reason}, exit code ${details.exitCode}`)
})

// will-quit, not before-quit: closing the windows can still be cancelled (unsaved
// editor changes), and the core must survive that. The quit waits (a while) for the
// core to put its work on disk — the browser's session says it ended well, the
// history and the logs get their last lines — then goes on.
app.on('will-quit', (event) => {
  const stopping = core
  if (!stopping) return
  event.preventDefault()
  core = null
  updates?.dispose()
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<void>((done) => (timer = setTimeout(done, DISPOSE_TIMEOUT_MS)))
  const disposed = stopping.dispose().catch((err) => console.error('[app] shutting the core down failed', err))
  void Promise.race([disposed, deadline]).then(() => {
    clearTimeout(timer)
    // From a later task: Electron takes a new quit only once this will-quit has returned
    // (a core with nothing to save is done before that).
    setImmediate(() => app.quit())
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
