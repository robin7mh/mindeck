import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, powerMonitor, shell } from 'electron'
import { join } from 'node:path'
import { migrateLegacyData, mindeckPaths } from './main/lib/paths'
import { electronCipher, electronPlatform } from './main/platform/electron'
import { createCore, type Core } from './main/core/createCore'
import { bindIpc } from './ipc/registry'
import { autoUpdater } from 'electron-updater'
import { cloudConfig } from './main/services/cloud/config'
import { UpdateService } from './main/services/update/UpdateService'

/** After this long without keyboard or mouse, the trial clock pauses. */
const IDLE_SECONDS = 5 * 60

// main/preload are bundled as CommonJS (Electron's well-supported default), so
// __dirname is natively available — no import.meta shim needed.

// electron-vite injects the dev server URL in development.
const DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL']

let mainWindow: BrowserWindow | null = null
let core: Core | null = null
let updates: UpdateService | null = null

/** Broadcast a push event to every live renderer. */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * Web and mail links go to the OS; anything else (file:, smb:, custom app
 * schemes from a note or a terminal) could launch programs, so it is ignored.
 */
function openLink(url: string): void {
  let protocol = ''
  try {
    protocol = new URL(url).protocol
  } catch {
    return
  }
  if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') void shell.openExternal(url).catch(() => {})
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

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    // No shell outlives its window (on macOS the app itself keeps running).
    core?.terminal.killAll()
    if (mainWindow === win) mainWindow = null
  })

  // Emit maximize state changes so the renderer can swap the maximize/restore icon.
  const emitMaxState = () => win.webContents.send('window:maximized-changed', win.isMaximized())
  win.on('maximize', emitMaxState)
  win.on('unmaximize', emitMaxState)

  // macOS hides the traffic lights in fullscreen; the top bar drops their gap.
  const emitFullScreen = () => win.webContents.send('window:fullscreen-changed', win.isFullScreen())
  win.on('enter-full-screen', emitFullScreen)
  win.on('leave-full-screen', emitFullScreen)

  // Pause telemetry sampling while the window is hidden/minimized (save energy).
  win.on('minimize', () => core?.system.setPaused(true))
  win.on('restore', () => core?.system.setPaused(false))
  win.on('hide', () => core?.system.setPaused(true))
  win.on('show', () => core?.system.setPaused(false))

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
  })

  // Open external links in the OS browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openLink(url)
    return { action: 'deny' }
  })
  // The window keeps the privileged bridge (window.mindeck): it never navigates
  // away from the app — not by a link, not by a file dropped onto it.
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openLink(url)
  })

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// --- Window control IPC (invoked from preload bridge) ---
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow) return
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
})
ipcMain.on('window:close', () => mainWindow?.close())
ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false)
ipcMain.handle('window:is-fullscreen', () => mainWindow?.isFullScreen() ?? false)

/** An agent needs the user: tell them — unless they are looking at Mindeck already. */
function notify(title: string, body: string): void {
  if (!Notification.isSupported() || BrowserWindow.getFocusedWindow()) return
  const n = new Notification({ title, body })
  n.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
  n.show()
}

async function startCore(): Promise<void> {
  // ~/Mindeck/{data,vault} holds everything — every location derives from paths.ts.
  const paths = mindeckPaths()
  const legacyDir = join(app.getPath('userData'), 'mindeck')
  try {
    if (migrateLegacyData(paths, legacyDir)) console.log(`[data] copied ${legacyDir} → ${paths.dataDir}`)
  } catch (err) {
    console.error('[data] migration from the old data folder failed — starting fresh\n', err)
  }

  core = await createCore({
    mode: 'desktop',
    version: app.getVersion(),
    paths,
    platform: electronPlatform,
    cipher: electronCipher(),
    // The embedded network API (opt-in) serves the packaged renderer as web UI.
    webRoot: join(__dirname, '../renderer'),
    notify,
    // The packaged app needs a license; `npm run dev` only with MINDECK_LICENSE=required.
    cloud: cloudConfig(app.isPackaged),
    isUserActive: () => powerMonitor.getSystemIdleTime() < IDLE_SECONDS
  })
  core.hub.subscribe(broadcast)

  // Self-update only where it can work: the packaged app (GitHub Releases).
  updates = new UpdateService({
    updater: app.isPackaged ? autoUpdater : null,
    currentVersion: app.getVersion(),
    onStatus: (status) => broadcast('update:status', status)
  })
  const u = updates
  core.router.register('update:status', () => u.status())
  core.router.register('update:check', () => u.check())
  core.router.register('update:install', () => u.install())
  u.start()

  bindIpc(core.router)
  await core.server.start()
}

app.whenReady().then(async () => {
  await startCore()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((err: unknown) => {
  // Without a core there is no window: say why and quit instead of idling invisibly.
  console.error('[core] startup failed\n', err)
  dialog.showErrorBox('Mindeck could not start', String((err as Error)?.message ?? err))
  app.quit()
})

// will-quit, not before-quit: closing the windows can still be cancelled (unsaved
// editor changes), and the core must survive that.
app.on('will-quit', () => {
  const running = core
  core = null
  updates?.dispose()
  void running?.dispose().catch(() => {})
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
