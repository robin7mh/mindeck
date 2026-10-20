import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  windows: [] as unknown[],
  openExternal: vi.fn(async () => {}),
  dark: true,
  failLoad: false,
  sessions: new Map<string, Record<string, unknown>>()
}))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class FakeWindow extends Emitter {
    loaded: string[] = []
    scripts: string[] = []
    destroyed = false
    openHandler?: (d: { url: string }) => unknown
    navigate?: (e: { preventDefault: () => void }, url: string) => void
    webContents = {
      setWindowOpenHandler: (fn: (d: { url: string }) => unknown) => (this.openHandler = fn),
      on: (_event: 'will-navigate', fn: (e: { preventDefault: () => void }, url: string) => void) => (this.navigate = fn),
      executeJavaScript: async (code: string) => void this.scripts.push(code)
    }
    constructor(public opts: Record<string, unknown>) {
      super()
      h.windows.push(this)
    }
    async loadURL(url: string) {
      if (h.failLoad) throw new Error('ERR_CONNECTION_REFUSED')
      this.loaded.push(url)
    }
    isDestroyed() {
      return this.destroyed
    }
    close() {
      this.destroyed = true
      this.emit('closed')
    }
  }
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  return {
    app: { getApplicationNameForProtocol: () => '', getPath: () => join(tmpdir(), `mindeck-remote-window-${process.pid}`) },
    BrowserWindow: FakeWindow,
    clipboard: {},
    ClipboardItem: class {},
    dialog: {},
    nativeTheme: {
      get shouldUseDarkColors() {
        return h.dark
      }
    },
    safeStorage: { isEncryptionAvailable: () => false },
    session: {
      fromPartition: (name: string) => {
        if (!h.sessions.has(name)) {
          const ses: Record<string, unknown> = {}
          for (const k of ['setPermissionRequestHandler', 'setPermissionCheckHandler', 'setDisplayMediaRequestHandler', 'setDevicePermissionHandler']) ses[k] = (fn: unknown) => (ses[k] = fn)
          h.sessions.set(name, ses)
        }
        return h.sessions.get(name)
      }
    },
    shell: { openExternal: h.openExternal }
  }
})

import { electronPlatform, REMOTE_PARTITION, safeExternal } from '../../../electron/main/platform/electron'

type Win = EventEmitter & {
  opts: Record<string, unknown>
  loaded: string[]
  scripts: string[]
  destroyed: boolean
  openHandler: (d: { url: string }) => unknown
  navigate: (e: { preventDefault: () => void }, url: string) => void
  close: () => void
}

describe('remote windows', () => {
  it('a window on the remote core’s web UI, signed in as this desktop; links go to the browser; closing resolves', async () => {
    // An earlier version's profile on disk, the remote core's token in its localStorage: it goes.
    const legacy = join(tmpdir(), `mindeck-remote-window-${process.pid}`, 'Partitions', 'mindeck-remote')
    mkdirSync(join(legacy, 'Local Storage'), { recursive: true })
    writeFileSync(join(legacy, 'Local Storage', '000003.log'), 'mindeck.token')
    const remote = electronPlatform.openRemoteWindow!({ title: 'SSH: box', url: 'http://127.0.0.1:5000', token: 'tok', deviceId: 'dev' })
    const win = h.windows.at(-1) as Win
    expect(win.opts).toMatchObject({
      title: 'SSH: box',
      backgroundColor: '#04060b',
      // Its own profile: the Mindeck UI's session serves mindeck-file:// (local files).
      webPreferences: { partition: expect.stringMatching(/^mindeck-remote-\d+$/), sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    expect(win.opts.webPreferences).not.toHaveProperty('preload')
    // The profile lives in memory: the token it is given never lands on disk.
    const partition = (win.opts.webPreferences as { partition: string }).partition
    expect(partition.startsWith('persist:')).toBe(false)
    expect(partition.startsWith(REMOTE_PARTITION)).toBe(true)
    // Its page asks for nothing it gets: no microphone, no camera, not this machine's clipboard.
    const ses = h.sessions.get(partition)!
    const check = ses.setPermissionCheckHandler as (c: unknown, p: string, o: string, d: { requestingUrl: string; isMainFrame: boolean }) => boolean
    expect(check(null, 'clipboard-read', 'http://127.0.0.1:5000', { requestingUrl: 'http://127.0.0.1:5000/', isMainFrame: true })).toBe(false)
    expect(check(null, 'media', 'http://127.0.0.1:5000', { requestingUrl: 'http://127.0.0.1:5000/', isMainFrame: true })).toBe(false)
    expect(check(null, 'clipboard-sanitized-write', 'http://127.0.0.1:5000', { requestingUrl: 'http://127.0.0.1:5000/', isMainFrame: true })).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(win.loaded).toEqual(['http://127.0.0.1:5000/api/health', 'http://127.0.0.1:5000'])
    await vi.waitFor(() => expect(existsSync(legacy)).toBe(false))
    rmSync(join(tmpdir(), `mindeck-remote-window-${process.pid}`), { recursive: true, force: true })
    expect(win.scripts[0]).toBe(`localStorage.setItem('mindeck.token', "tok"); localStorage.setItem('mindeck.deviceId', "dev")`)
    // The page can't rename the window.
    const title = { preventDefault: vi.fn() }
    win.emit('page-title-updated', title)
    expect(title.preventDefault).toHaveBeenCalled()
    expect(win.openHandler({ url: 'https://docs' })).toEqual({ action: 'deny' })
    expect(h.openExternal).toHaveBeenCalledWith('https://docs')
    // Another machine's page never hands the OS a file, a share or another app's link.
    h.openExternal.mockClear()
    for (const link of ['file:///C:/Windows/System32/calc.exe', 'smb://evil/share/x.exe', 'ms-msdt:/id', 'javascript:alert(1)']) {
      expect(win.openHandler({ url: link })).toEqual({ action: 'deny' })
    }
    expect(h.openExternal).not.toHaveBeenCalled()
    // It stays on its core: its own pages load, web links elsewhere go to the system browser, the rest nowhere.
    const nav = (url: string) => {
      const e = { preventDefault: vi.fn() }
      win.navigate(e, url)
      return e.preventDefault.mock.calls.length > 0
    }
    expect(nav('http://127.0.0.1:5000/projects')).toBe(false)
    expect(nav('http://127.0.0.1:50001/')).toBe(true)
    expect(nav('mailto:a@b.c')).toBe(true)
    expect(nav('file:///etc/passwd')).toBe(true)
    expect(h.openExternal.mock.calls).toEqual([['http://127.0.0.1:50001/'], ['mailto:a@b.c']])
    remote.close()
    await remote.closed
    remote.close() // already gone
    expect(win.destroyed).toBe(true)
    // The next window (another remote core, maybe on the same 127.0.0.1) gets a profile — and cookies — of its own.
    electronPlatform.openRemoteWindow!({ title: 'SSH: other', url: 'http://127.0.0.1:5001', token: 't2', deviceId: 'd2' }).close()
    expect((h.windows.at(-1) as Win).opts.webPreferences).toMatchObject({ partition: expect.not.stringMatching(new RegExp(`^${partition}$`)) })
  })

  it('only web and mail links leave for the OS', () => {
    expect(safeExternal('https://mindeck.de')).toBe(true)
    expect(safeExternal('HTTP://x')).toBe(true)
    expect(safeExternal('mailto:a@b.c')).toBe(true)
    expect(safeExternal('file:///etc/passwd')).toBe(false)
    expect(safeExternal('\\\\evil\\share')).toBe(false)
    expect(safeExternal('vscode://x')).toBe(false)
  })

  it('light mode; a core that doesn’t answer leaves the window as it is; an old profile that can’t go stays', async () => {
    h.dark = false
    h.failLoad = true
    // Not a folder where the profiles would be: removing the old one fails, quietly.
    const userData = join(tmpdir(), `mindeck-remote-window-${process.pid}`)
    writeFileSync(userData, '')
    electronPlatform.openRemoteWindow!({ title: 't', url: 'http://x', token: 't', deviceId: 'd' })
    await new Promise((r) => setTimeout(r, 10))
    rmSync(userData, { force: true })
    const win = h.windows.at(-1) as Win
    expect(win.opts.backgroundColor).toBe('#eef2f7')
    expect(win.loaded).toEqual([])
  })
})
