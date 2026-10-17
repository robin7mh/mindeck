import { app, BrowserWindow, clipboard, ClipboardItem, dialog, nativeTheme, safeStorage, session, shell, utilityProcess } from 'electron'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { utilityNode } from '../lib/nodeProcess'
import type { Cipher } from '../services/ai/SecretStore'
import { fileClipboard } from './fileClipboard'
import { guardSession } from './sessionGuard'
import { desktopTrash } from './trash'
import type { Platform } from './types'

/**
 * The remote core's web UI gets a profile of its own: the Mindeck UI's
 * session serves `mindeck-file://` (any local file), which a page from
 * another machine must never reach. It lives in memory only: the page holds
 * the remote core's device token (shells on that host) in a cookie, which
 * must not stay in a profile on disk — and each tunnel gets a new port (a
 * new origin) anyway. One per window: cookies go by host, not by port, so
 * two remote cores behind `127.0.0.1` tunnels would otherwise be sent each
 * other's.
 */
export const REMOTE_PARTITION = 'mindeck-remote'
let remoteWindows = 0

/** Where earlier versions kept that profile on disk (`persist:mindeck-remote`), tokens included. */
const legacyRemoteProfile = () => join(app.getPath('userData'), 'Partitions', 'mindeck-remote')

/** Links the OS may open for a page: web addresses and mail — never `file:`, `smb:` or another app's scheme. */
export function safeExternal(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url)
}

/** The OS trash (Finder's, the Recycle Bin, the desktop's). */
async function osTrash(path: string): Promise<void> {
  await shell.trashItem(path)
}

/** Desktop host: native dialogs, the OS file manager, its link handlers and the OS trash. */
export const electronPlatform: Platform = {
  kind: 'desktop',
  async pickFolder(title) {
    const res = await dialog.showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  },
  async openPath(path) {
    const err = await shell.openPath(path)
    if (err) throw Object.assign(new Error(err), { code: 'open-failed' })
  },
  revealPath(path) {
    shell.showItemInFolder(path)
  },
  async openExternal(url) {
    await shell.openExternal(url)
  },
  appForUrl: (url) => app.getApplicationNameForProtocol(url),
  trashItem: osTrash,
  restorableTrash: desktopTrash({ platform: process.platform, env: process.env, home: homedir(), trashItem: osTrash }),
  fileClipboard: fileClipboard(clipboard, (data) => new ClipboardItem(data), process.platform),
  // Next to the main bundle: out/main/nodeHost.js (electron.vite.config.ts).
  node: utilityNode((modulePath, args, options) => utilityProcess.fork(modulePath, args, options), join(__dirname, 'nodeHost.js')),
  openRemoteWindow({ title, url, token, deviceId }) {
    // Another machine's page asks for nothing: no microphone, camera, location, screen — nor this machine's clipboard.
    remoteWindows += 1
    const partition = `${REMOTE_PARTITION}-${remoteWindows}`
    guardSession(session.fromPartition(partition), () => false)
    void rm(legacyRemoteProfile(), { recursive: true, force: true }).catch(() => {})
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 640,
      title,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#04060b' : '#eef2f7',
      autoHideMenuBar: true,
      // The remote core's own web UI: no bridge into this machine, nor its files.
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    win.on('page-title-updated', (e) => e.preventDefault())
    // Another machine's page: it opens web links in the system browser — no other scheme, and the window stays on its core.
    const origin = new URL(url).origin
    win.webContents.setWindowOpenHandler(({ url: link }) => {
      if (safeExternal(link)) void shell.openExternal(link)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (event, link) => {
      if (link.startsWith(`${origin}/`)) return
      event.preventDefault()
      if (safeExternal(link)) void shell.openExternal(link)
    })
    const closed = new Promise<void>((resolve) => win.on('closed', () => resolve()))
    // Signed in as this desktop's paired device before the UI first loads (the page hands the token to the core for its cookie).
    void (async () => {
      await win.loadURL(`${url}/api/health`)
      await win.webContents.executeJavaScript(`localStorage.setItem('mindeck.token', ${JSON.stringify(token)}); localStorage.setItem('mindeck.deviceId', ${JSON.stringify(deviceId)})`)
      await win.loadURL(url)
    })().catch(() => {})
    return { closed, close: () => !win.isDestroyed() && win.close() }
  }
}

/**
 * Whether stored secrets are really protected by the OS keychain. On Linux
 * without a keyring (no Secret Service, no KWallet) Electron falls back to a
 * fixed built-in key (`basic_text`) — as good as plain text — or offers no
 * encryption at all. Settings warns about that instead of keeping quiet.
 */
export function secretsProtected(platform: NodeJS.Platform = process.platform): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (platform !== 'linux') return true
  const backend = safeStorage.getSelectedStorageBackend()
  return backend !== 'basic_text' && backend !== 'unknown'
}

/** OS-keychain encryption for stored secrets, when the OS offers it. */
export function electronCipher(): Cipher | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  return {
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (stored) => safeStorage.decryptString(Buffer.from(stored, 'base64'))
  }
}
