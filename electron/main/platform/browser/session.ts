import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { app, desktopCapturer, systemPreferences, type DownloadItem, type Session, type WebContents } from 'electron'
import type { BrowserDownload, BrowserPermissionKind } from '@shared/types/browser'
import type { BrowserHostEvents } from '../../services/browser/types'
import { isLoopbackHost, originOf } from '../../services/browser/url'
import { configureClientHints, uaPlatform } from './clientHints'

/** Web pages' own profile: cookies, cache and logins, apart from the Mindeck UI's. */
export const BROWSER_PARTITION = 'persist:mindeck-browser'

/** Who answers the session's questions: the browser host of the window that is open now. */
export interface SessionTarget {
  events: BrowserHostEvents
  /** The tab a page belongs to (undefined: a popup window). */
  tabOf(contents: WebContents | null | undefined): string | undefined
  /** "Save … As" was picked for this address: ask where (once). */
  takeSaveAs(url: string): boolean
}

/**
 * Chrome's user agent: Electron's minus its own and the app's token, the
 * Chrome version reduced the way Chrome itself does. Some sites refuse
 * anything that says "Electron" — Google's sign-in among them.
 */
export function chromeUserAgent(ua: string): string {
  return ua.replace(/ (?!(?:Mozilla|AppleWebKit|Chrome|Safari|Version|Mobile)\/)[A-Za-z][\w.-]*\/\S+/g, '').replace(/Chrome\/(\d+)[\d.]*/, 'Chrome/$1.0.0.0')
}

/** How Mindeck answers a permission: allowed, refused, or asked as one of the user-facing kinds. */
export function decide(permission: string, mediaTypes: string[] = []): boolean | BrowserPermissionKind {
  switch (permission) {
    case 'fullscreen':
    case 'automatic-fullscreen':
    case 'pointerLock':
    case 'keyboardLock':
    case 'clipboard-sanitized-write':
    case 'persistent-storage':
      return true
    case 'media': {
      const video = mediaTypes.includes('video')
      const audio = mediaTypes.includes('audio')
      return video && !audio ? 'camera' : audio && !video ? 'microphone' : 'media'
    }
    case 'notifications':
      return 'notifications'
    case 'geolocation':
    case 'geolocation-approximate':
      return 'geolocation'
    case 'clipboard-read':
      return 'clipboard'
    case 'display-capture':
      return 'screen'
    case 'openExternal':
      return 'external'
    default:
      return false
  }
}

/** `name 2.ext`, `name 3.ext`, … — the first free name in `dir` (synchronous: Chromium needs the path at once). */
export function freeDownloadPath(dir: string, filename: string): string {
  const name = basename(filename) || 'download'
  let path = join(dir, name)
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 2; existsSync(path); i += 1) path = join(dir, `${stem} ${i}${ext}`)
  return path
}

/**
 * Marks a download as coming from the internet (Electron leaves that to the app): on macOS
 * Gatekeeper checks it before it runs, on Windows the Mark of the Web makes SmartScreen and
 * Office's Protected View do so.
 */
export function quarantine(path: string, url: string, run: typeof execFile = execFile, write = (file: string, data: string) => writeFile(file, data)): void {
  if (process.platform === 'win32') {
    // Like Chrome: the address only when it is a web one, never its user name or password.
    let host = 'about:internet'
    try {
      const u = new URL(url)
      if (u.protocol === 'http:' || u.protocol === 'https:') host = `${u.origin}${u.pathname}${u.search}`
    } catch {
      // not an address: the internet zone, without one
    }
    // A disk without streams (FAT, exFAT) can't take the mark: nothing to do then.
    void write(`${path}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${host}\r\n`).catch(() => {})
    return
  }
  if (process.platform !== 'darwin') return
  run('xattr', ['-p', 'com.apple.quarantine', path], (missing) => {
    if (!missing) return // Chromium marked it already
    const value = `0081;${Math.floor(Date.now() / 1000).toString(16)};Mindeck;${randomUUID().toUpperCase()}`
    run('xattr', ['-w', 'com.apple.quarantine', value, path], () => {})
  })
}

/** Camera and microphone also need macOS's own consent (System Settings → Privacy). */
async function osAllows(kind: BrowserPermissionKind): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  const media: ('camera' | 'microphone')[] = kind === 'camera' ? ['camera'] : kind === 'microphone' ? ['microphone'] : kind === 'media' ? ['camera', 'microphone'] : []
  for (const m of media) if (!(await systemPreferences.askForMediaAccess(m))) return false
  return true
}

const configured = new WeakSet<Session>()

/**
 * Sets a browser profile up once per run: Chrome's user agent, a question
 * to the user for everything sensitive (camera, notifications, screen,
 * another app), downloads (into the downloads folder, or asked), ad and
 * malware blocking, and trust for local dev certificates. Every answer comes
 * from whichever window's host is current.
 */
export function configureBrowserSession(ses: Session, current: () => SessionTarget | null): void {
  if (configured.has(ses)) return
  configured.add(ses)
  ses.setUserAgent(chromeUserAgent(ses.getUserAgent()))
  // Google, Microsoft, Apple and GitHub sign-ins check that the client hints and navigator.userAgentData agree with it.
  configureClientHints(ses, process.versions.chrome, uaPlatform(process.platform))
  ses.registerPreloadScript({ id: 'mindeck-browser-page', type: 'frame', filePath: join(__dirname, '../preload/browserPage.js') })

  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const target = current()
    const kind = decide(permission, 'mediaTypes' in details ? details.mediaTypes : [])
    if (typeof kind === 'boolean' || !target) return callback(kind === true)
    const securityOrigin = 'securityOrigin' in details ? details.securityOrigin : undefined
    const origin = originOf(securityOrigin || details.requestingUrl)
    let extra: { target?: string; app?: string } = {}
    if (kind === 'external') {
      const url = 'externalURL' in details ? (details.externalURL ?? '') : ''
      const handler = app.getApplicationNameForProtocol(url)
      // Nothing on this machine opens it: nothing to ask.
      if (!url || !handler) return callback(false)
      extra = { target: url, app: handler }
    }
    target.events.permission({ tabId: target.tabOf(contents), origin, kind, ...extra }, (allow) => {
      if (!allow) return callback(false)
      void osAllows(kind).then(callback, () => callback(false))
    })
  })

  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    const kind = decide(permission, details.mediaType ? [details.mediaType] : [])
    if (typeof kind === 'boolean') return kind
    return current()?.events.permissionCheck(originOf(requestingOrigin), kind) ?? false
  })

  // Sharing the screen (Meet, Zoom, Loom): macOS's own picker where there is one, else the whole screen after asking.
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      const target = current()
      if (!target) return callback(null)
      target.events.permission({ origin: originOf(request.securityOrigin), kind: 'screen' }, (allow) => {
        if (!allow) return callback(null)
        void desktopCapturer.getSources({ types: ['screen'] }).then(
          (sources) => callback(sources[0] ? { video: sources[0] } : null),
          () => callback(null)
        )
      })
    },
    { useSystemPicker: true }
  )

  // A private tab's profile lives in memory: its downloads are listed, never written down.
  ses.on('will-download', (_event, item) => track(item, current, !ses.isPersistent()))

  // Ads, trackers and malware: every request asks the blocker (pages and their frames; a popup counts for no tab).
  ses.webRequest.onBeforeRequest((details, callback) => {
    const target = current()
    if (!target) return callback({})
    const { cancel, redirectURL } = target.events.request(target.tabOf(details.webContents), {
      url: details.url,
      type: details.resourceType,
      referrer: details.referrer
    })
    callback(redirectURL ? { redirectURL } : { cancel: !!cancel })
  })

  // Local dev servers often use self-signed certificates (mkcert, Vite's basic-ssl): trust them on this machine only.
  ses.setCertificateVerifyProc((request, callback) => callback(isLoopbackHost(request.hostname) ? 0 : -3))
}

/**
 * A download: saved under a free name in the downloads folder — or, when the
 * user wants to be asked (or picked "Save … As"), where the save dialog says.
 * Its progress is reported at most ~4× a second.
 */
function track(item: DownloadItem, current: () => SessionTarget | null, inMemory: boolean): void {
  const target = current()
  const prefs = target?.events.downloadPrefs() ?? { ask: false, dir: '' }
  const dir = prefs.dir && existsSync(prefs.dir) ? prefs.dir : app.getPath('downloads')
  const ask = target?.takeSaveAs(item.getURL()) || prefs.ask
  let path = ''
  // Without a save path Chromium shows its save dialog (and cancels the download when the user does).
  if (ask) item.setSaveDialogOptions({ defaultPath: join(dir, basename(item.getFilename()) || 'download') })
  else item.setSavePath((path = freeDownloadPath(dir, item.getFilename())))
  const base: BrowserDownload = {
    id: randomUUID(),
    filename: basename(path || item.getFilename()),
    path,
    url: item.getURL(),
    state: 'progressing',
    received: 0,
    total: item.getTotalBytes(),
    startedAt: new Date().toISOString(),
    ...(inMemory ? { private: true } : {})
  }
  target?.events.download(base, { cancel: () => item.cancel() })
  // Where it went: known once the save dialog closed.
  const where = () => {
    const saved = item.getSavePath()
    return saved ? { path: saved, filename: basename(saved) } : {}
  }
  let last = 0
  item.on('updated', (_event, state) => {
    const now = Date.now()
    if (state === 'progressing' && now - last < 250) return
    last = now
    current()?.events.downloadUpdated({ ...base, ...where(), state, received: item.getReceivedBytes(), total: item.getTotalBytes() })
  })
  item.once('done', (_event, state) => {
    const done = { ...base, ...where(), state, received: item.getReceivedBytes(), total: item.getTotalBytes() }
    current()?.events.downloadUpdated(done)
    if (state === 'completed') quarantine(done.path, base.url)
  })
}
