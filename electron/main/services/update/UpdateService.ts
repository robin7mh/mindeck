import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateStatus } from '@shared/types/server'

/** The part of electron-updater's autoUpdater this service uses (tests pass a fake). */
export interface Updater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each event has its own payload (as in EventEmitter)
  on(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 4 * 3_600_000

/** Where releases are published (electron-builder.yml → publish). */
export const RELEASES_URL = 'https://github.com/robin7mh/mindeck/releases'

/**
 * The release file to download by hand on installs that can't update
 * themselves: Linux .deb packages (electron-builder marks them in
 * resources/package-type). AppImages, macOS and Windows update on their own.
 */
export function manualUpdateFile(
  platform: NodeJS.Platform,
  arch: string,
  resourcesPath: string,
  env: Record<string, string | undefined> = process.env,
  read: (file: string) => string = (file) => readFileSync(file, 'utf8')
): string | undefined {
  if (platform !== 'linux' || env.APPIMAGE) return undefined
  let type = ''
  try {
    type = read(join(resourcesPath, 'package-type')).trim()
  } catch {
    /* not a package: no marker */
  }
  if (type !== 'deb') return undefined
  return arch === 'x64' ? 'Mindeck.deb' : `Mindeck-${arch}.deb`
}

/**
 * Keeps the packaged desktop app current (GitHub Releases, see
 * electron-builder.yml → publish). Downloads in the background; the user
 * restarts when it suits them, or the update applies on the next quit.
 * Installs that can't replace themselves (`manualDownload`: a .deb) only
 * check, and offer the new version's download (`available`).
 * Without an updater (dev runs) it reports `disabled` and does nothing.
 */
export class UpdateService {
  private current: UpdateStatus
  private firstCheck?: ReturnType<typeof setTimeout>
  private interval?: ReturnType<typeof setInterval>

  constructor(
    private readonly opts: {
      updater: Updater | null
      currentVersion: string
      onStatus: (status: UpdateStatus) => void
      /** The release file to download by hand (manualUpdateFile) — no download, no install. */
      manualDownload?: string
    }
  ) {
    this.current = { state: opts.updater ? 'idle' : 'disabled', currentVersion: opts.currentVersion }
  }

  start(): void {
    const u = this.opts.updater
    if (!u) return
    const manual = this.opts.manualDownload
    u.autoDownload = !manual
    u.autoInstallOnAppQuit = !manual
    u.on('checking-for-update', () => this.set({ state: 'checking' }))
    u.on('update-not-available', () => this.set({ state: 'idle' }))
    u.on('update-available', (info: { version: string }) =>
      this.set(
        manual
          ? { state: 'available', version: info.version, downloadUrl: `${RELEASES_URL}/download/v${info.version}/${manual}` }
          : { state: 'downloading', version: info.version, progress: 0 }
      )
    )
    u.on('download-progress', (p: { percent: number }) => this.set({ ...this.current, state: 'downloading', progress: Math.round(p.percent) }))
    u.on('update-downloaded', (info: { version: string }) => this.set({ state: 'ready', version: info.version }))
    u.on('error', (err: Error) => this.set({ state: 'error', error: err.message }))
    this.firstCheck = setTimeout(() => void this.check(), FIRST_CHECK_MS)
    this.interval = setInterval(() => void this.check(), CHECK_EVERY_MS)
    this.firstCheck.unref()
    this.interval.unref()
  }

  status(): UpdateStatus {
    return this.current
  }

  async check(): Promise<UpdateStatus> {
    const u = this.opts.updater
    // Never interrupt a download, never re-check what is already waiting.
    if (!u || this.current.state === 'downloading' || this.current.state === 'ready') return this.current
    try {
      await u.checkForUpdates()
    } catch (err) {
      this.set({ state: 'error', error: (err as Error).message })
    }
    return this.current
  }

  /** Restart into the downloaded version. */
  install(): void {
    if (this.current.state !== 'ready') {
      throw Object.assign(new Error('No update is ready to install'), { code: 'no-update' })
    }
    this.opts.updater!.quitAndInstall(false, true)
  }

  dispose(): void {
    clearTimeout(this.firstCheck)
    clearInterval(this.interval)
  }

  private set(next: Omit<UpdateStatus, 'currentVersion'>): void {
    this.current = { ...next, currentVersion: this.opts.currentVersion }
    this.opts.onStatus(this.current)
  }
}
