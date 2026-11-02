import { app, BrowserWindow, dialog, nativeTheme, safeStorage, shell } from 'electron'
import type { Cipher } from '../services/ai/SecretStore'
import type { Platform } from './types'

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
  async openExternal(url) {
    await shell.openExternal(url)
  },
  appForUrl: (url) => app.getApplicationNameForProtocol(url),
  async trashItem(path) {
    await shell.trashItem(path)
  },
  openRemoteWindow({ title, url, token, deviceId }) {
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 640,
      title,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#04060b' : '#eef2f7',
      autoHideMenuBar: true,
      // The remote core's own web UI: no bridge into this machine.
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    win.on('page-title-updated', (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(({ url: link }) => {
      // Remote content only gets web links opened — never file:// or other apps' URL schemes on this machine.
      if (/^(https?|mailto):/i.test(link)) void shell.openExternal(link)
      return { action: 'deny' }
    })
    const closed = new Promise<void>((resolve) => win.on('closed', () => resolve()))
    // Signed in as this desktop's paired device before the UI first loads.
    void (async () => {
      await win.loadURL(`${url}/api/health`)
      await win.webContents.executeJavaScript(`localStorage.setItem('mindeck.token', ${JSON.stringify(token)}); localStorage.setItem('mindeck.deviceId', ${JSON.stringify(deviceId)})`)
      await win.loadURL(url)
    })().catch(() => {})
    return { closed, close: () => !win.isDestroyed() && win.close() }
  }
}

/** OS-keychain encryption for stored secrets, when the OS offers it. */
export function electronCipher(): Cipher | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  return {
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (stored) => safeStorage.decryptString(Buffer.from(stored, 'base64'))
  }
}
