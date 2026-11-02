import { createHash, randomUUID } from 'node:crypto'
import { cp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative } from 'node:path'
import type {
  BrowserExtension,
  ChromiumProfile,
  ExtensionInstall,
  ExtensionSource,
  ExtensionUpdateReport
} from '@shared/types/browserExtensions'
import type { ViewBounds } from '@shared/types/browser'
import { readJson } from '../../../lib/jsonFile'
import { writeAtomic } from '../../../lib/writeAtomic'
import { parseCrx } from './crx'
import { readManifest, type ManifestInfo } from './manifest'
import { findProfiles, inProfile, type BrowserRoot } from './profiles'
import { compareVersions, parseUpdateResponse, storeId, updateCheckUrl, type StoreRelease } from './webstore'
import { extractZip } from './zip'

/** Look for updates this often (Chrome: about every five hours). */
const UPDATE_EVERY_MS = 12 * 60 * 60 * 1000
/** The first look after the browser came up — not during start. */
const FIRST_UPDATE_MS = 2 * 60 * 1000
const MAX_ICON_BYTES = 256 * 1024
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024
const ICON_TYPES: Record<string, string> = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

/** What the desktop app does with extensions (Electron's `session.extensions`, in the user's profile). */
export interface ExtensionHost {
  /** Loads the unpacked extension; resolves with the id Chromium gave it. */
  loadExtension(path: string): Promise<{ id: string }>
  unloadExtension(id: string): void
  /** The popup page under `anchor` (the icon's place in the window, CSS pixels). */
  openPopup(url: string, anchor: ViewBounds): void
}

export interface FetchResponse {
  ok: boolean
  status: number
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface ExtensionDeps {
  /** ~/Mindeck/data/browser — `extensions.json` and the unpacked extensions under `extensions/`. */
  dir: string
  fetch: (url: string) => Promise<FetchResponse>
  /** Chrome's version, as the Web Store wants it ("140.0.7339.41"). */
  chromeVersion: string
  locale: () => 'de' | 'en'
  pickFolder?: (title: string) => Promise<string | null>
  /** Where Chrome, Brave, Edge … keep their profiles. */
  roots: () => BrowserRoot[]
  onChange: () => void
  now?: () => number
}

interface Saved {
  id: string
  source: ExtensionSource
  path: string
  enabled: boolean
  installedAt: string
}

interface Installed extends Saved {
  info: ManifestInfo
  icon?: string
  error?: string
  /** The id Chromium loaded it under (the same unless an unpacked folder has no key). */
  loaded?: string
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Chrome extensions in the Mindeck browser (architecture §12.9): installed
 * from the Chrome Web Store (the signed CRX, checked like Chrome checks it),
 * from a folder (loaded in place, like "Load unpacked") or copied from the
 * profile of Chrome, Brave or Edge. They run in the user's profile only —
 * never in private tabs or the agents' container. Electron loads them anew
 * on every start; this service remembers which, and keeps them up to date.
 */
export class ExtensionService {
  private items: Installed[] = []
  private host: ExtensionHost | null = null
  private lastCheck = 0
  private timer?: NodeJS.Timeout
  private first?: NodeJS.Timeout
  /** Installs, updates and removals one at a time. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ExtensionDeps) {}

  async init(): Promise<void> {
    // A damaged file is set aside (readJson), not overwritten with an empty list by the next save.
    const saved = await readJson<{ extensions?: Saved[]; lastCheck?: number } | null>(this.file())
    this.lastCheck = typeof saved?.lastCheck === 'number' ? saved.lastCheck : 0
    for (const s of Array.isArray(saved?.extensions) ? saved.extensions : []) {
      if (typeof s?.id !== 'string' || typeof s.path !== 'string' || !['store', 'folder', 'profile'].includes(s.source)) continue
      const base: Saved = { id: s.id, source: s.source, path: s.path, enabled: s.enabled !== false, installedAt: typeof s.installedAt === 'string' ? s.installedAt : new Date(this.now()).toISOString() }
      try {
        this.items.push(await this.describe(base))
      } catch (err) {
        // Gone or broken since (a moved folder): keep it listed, so the user sees why and can remove it.
        this.items.push({ ...base, info: { name: s.id, version: '', description: '', permissions: [], unsupported: [], fromStore: false }, error: message(err) })
      }
    }
  }

  /** The window's views are up: load the enabled extensions and look for updates now and then. */
  async attach(host: ExtensionHost): Promise<void> {
    this.host = host
    // Not those whose folder did not read as an extension (no version).
    await Promise.all(this.items.filter((x) => x.enabled && x.info.version).map((x) => this.load(x)))
    this.deps.onChange()
    clearTimeout(this.first)
    clearInterval(this.timer)
    const due = Math.max(FIRST_UPDATE_MS, this.lastCheck + UPDATE_EVERY_MS - this.now())
    this.first = setTimeout(() => void this.checkUpdates().catch(() => {}), due)
    this.timer = setInterval(() => void this.checkUpdates().catch(() => {}), UPDATE_EVERY_MS)
  }

  /** The window closed: its session keeps the extensions, but nobody shows their popups. */
  detach(): void {
    this.host = null
    clearTimeout(this.first)
    clearInterval(this.timer)
  }

  list(): BrowserExtension[] {
    return this.items.map((x) => ({
      id: x.id,
      name: x.info.name,
      version: x.info.version,
      description: x.info.description,
      source: x.source,
      enabled: x.enabled,
      ...(x.icon ? { icon: x.icon } : {}),
      popup: !!x.info.popup,
      permissions: [...x.info.permissions],
      unsupported: [...x.info.unsupported],
      ...(x.error ? { error: x.error } : {}),
      installedAt: x.installedAt
    }))
  }

  /** Every Chrome, Brave, Edge … profile on this computer that has extensions. */
  profiles(): Promise<ChromiumProfile[]> {
    return findProfiles(this.deps.roots(), new Set(this.items.map((x) => x.id)), this.deps.locale())
  }

  install(req: ExtensionInstall): Promise<BrowserExtension | null> {
    return this.serial(async () => {
      if (req.source === 'store') return this.view(await this.fromStore(req.input))
      if (req.source === 'profile') return this.view(await this.fromProfile(req.path))
      return this.fromFolder(req.path)
    })
  }

  setEnabled(id: string, enabled: boolean): Promise<BrowserExtension> {
    return this.serial(async () => {
      const x = this.require(id)
      x.enabled = enabled
      if (enabled) await this.load(x)
      else this.unload(x)
      await this.save()
      return this.view(x)
    })
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const x = this.require(id)
      this.unload(x)
      this.items = this.items.filter((i) => i !== x)
      // A folder the user loaded stays where it is; copies Mindeck made go.
      if (this.owned(x)) await rm(x.path, { recursive: true, force: true })
      await this.save()
    })
  }

  /** Asks the Web Store for newer versions of the extensions that come from it, and installs them. */
  checkUpdates(): Promise<ExtensionUpdateReport> {
    return this.serial(async () => {
      const candidates = this.items.filter((x) => x.source !== 'folder' && x.info.fromStore && x.info.version)
      const report: ExtensionUpdateReport = { checked: candidates.length, updated: [], failed: [] }
      this.lastCheck = this.now()
      if (candidates.length) {
        const releases = await this.releases(candidates.map((x) => ({ id: x.id, version: x.info.version })))
        for (const x of candidates) {
          const release = releases.get(x.id)
          if (!release || compareVersions(release.version, x.info.version) <= 0) continue
          try {
            await this.installRelease(x.id, release, x.source)
            report.updated.push(x.info.name)
          } catch (err) {
            console.error(`[browser] updating the extension ${x.id} failed`, err)
            report.failed.push(x.info.name)
          }
        }
      }
      await this.save()
      return report
    })
  }

  /** The extension's toolbar popup, under its icon. */
  popup(id: string, anchor: ViewBounds): void {
    const x = this.require(id)
    if (!this.host || !x.loaded || !x.info.popup) throw coded('no-popup', `${x.info.name} has no popup to show`)
    this.host.openPopup(`chrome-extension://${x.loaded}/${x.info.popup}`, anchor)
  }

  dispose(): void {
    this.detach()
  }

  // --- internals ------------------------------------------------------------------

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private file(): string {
    return join(this.deps.dir, 'extensions.json')
  }

  private root(): string {
    return join(this.deps.dir, 'extensions')
  }

  /**
   * A copy Mindeck made (store, profile) — deleted with the extension. Only
   * ever inside its own folder: extensions.json may have been edited to
   * point anywhere, and an unpacked folder is the user's own.
   */
  private owned(x: Saved): boolean {
    const rel = relative(this.root(), x.path)
    return x.source !== 'folder' && !!rel && !rel.startsWith('..') && !isAbsolute(rel)
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  private require(id: string): Installed {
    const x = this.items.find((i) => i.id === id)
    if (!x) throw coded('not-found', 'Extension not found')
    return x
  }

  private view(x: Installed): BrowserExtension {
    return this.list().find((e) => e.id === x.id)!
  }

  private async describe(saved: Saved): Promise<Installed> {
    const info = await readManifest(saved.path, this.deps.locale())
    return { ...saved, info, icon: info.icon ? await this.icon(saved.path, info.icon) : undefined }
  }

  private async icon(dir: string, file: string): Promise<string | undefined> {
    const type = ICON_TYPES[extname(file).toLowerCase()]
    if (!type) return undefined
    try {
      const bytes = await readFile(join(dir, file))
      return bytes.length <= MAX_ICON_BYTES ? `data:${type};base64,${bytes.toString('base64')}` : undefined
    } catch {
      return undefined
    }
  }

  private async load(x: Installed): Promise<void> {
    if (!this.host) return
    try {
      x.loaded = (await this.host.loadExtension(x.path)).id
      x.error = undefined
    } catch (err) {
      x.loaded = undefined
      x.error = message(err)
    }
    this.deps.onChange()
  }

  private unload(x: Installed): void {
    if (x.loaded) this.host?.unloadExtension(x.loaded)
    x.loaded = undefined
    this.deps.onChange()
  }

  private async save(): Promise<void> {
    const extensions: Saved[] = this.items.map(({ id, source, path, enabled, installedAt }) => ({ id, source, path, enabled, installedAt }))
    await writeAtomic(this.file(), JSON.stringify({ version: 1, lastCheck: this.lastCheck, extensions }, null, 2))
    this.deps.onChange()
  }

  /** The Web Store's current releases of `items` (null: none on offer). */
  private async releases(items: { id: string; version: string }[]): Promise<Map<string, StoreRelease | null>> {
    const res = await this.deps.fetch(updateCheckUrl(items, this.deps.chromeVersion))
    if (!res.ok) throw coded('store-unavailable', `The Chrome Web Store did not answer (HTTP ${res.status})`)
    return parseUpdateResponse(await res.text())
  }

  private async fromStore(input: string): Promise<Installed> {
    const id = storeId(input)
    if (!id) throw coded('bad-input', 'Not a Chrome Web Store address or extension id')
    const release = (await this.releases([{ id, version: '0.0.0.0' }])).get(id)
    if (!release) throw coded('not-found', 'The Chrome Web Store has no extension with this id (or not for this browser)')
    return this.installRelease(id, release, 'store')
  }

  /** Downloads a release, checks the package and its signature, and installs it in place of an older copy. */
  private async installRelease(id: string, release: StoreRelease, source: ExtensionSource): Promise<Installed> {
    const res = await this.deps.fetch(release.url)
    if (!res.ok) throw coded('store-unavailable', `Downloading the extension failed (HTTP ${res.status})`)
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length > MAX_PACKAGE_BYTES) throw coded('bad-package', 'The extension package is too large')
    if (release.sha256 && createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw coded('bad-package', 'The download is damaged (checksum)')
    const crx = parseCrx(bytes)
    if (crx.id !== id) throw coded('bad-package', 'The package is a different extension')
    return this.commit(id, source, async (stage) => {
      await extractZip(crx.zip, stage)
      // The key keeps the Web Store's id wherever the folder is (Chrome writes it the same way).
      const manifestPath = join(stage, 'manifest.json')
      const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^﻿/, '')) as Record<string, unknown>
      manifest.key = crx.publicKey.toString('base64')
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    })
  }

  private async fromProfile(path: string): Promise<Installed> {
    if (!inProfile(this.deps.roots(), path)) throw coded('bad-input', 'Not an extension folder of a browser profile')
    const id = path.replace(/\\/g, '/').split('/').slice(-2)[0]
    return this.commit(id, 'profile', (stage) => cp(path, stage, { recursive: true }))
  }

  private async fromFolder(path: string | undefined): Promise<BrowserExtension | null> {
    if (!this.host) throw coded('desktop-only', 'Extensions are only available in the Mindeck desktop app')
    let folder = path
    if (!folder) {
      if (!this.deps.pickFolder) throw coded('desktop-only', 'The folder picker is only available in the Mindeck desktop app')
      folder = (await this.deps.pickFolder('Choose an unpacked extension folder')) ?? undefined
      if (!folder) return null
    }
    const info = await readManifest(folder, this.deps.locale())
    const { id } = await this.host.loadExtension(folder)
    const old = this.items.find((x) => x.id === id)
    if (old && old.path !== folder) {
      if (old.loaded) this.host.unloadExtension(old.loaded)
      if (this.owned(old)) await rm(old.path, { recursive: true, force: true })
    }
    const x: Installed = {
      id,
      source: 'folder',
      path: folder,
      enabled: true,
      installedAt: old?.installedAt ?? new Date(this.now()).toISOString(),
      info,
      icon: info.icon ? await this.icon(folder, info.icon) : undefined,
      loaded: id
    }
    this.items = [...this.items.filter((i) => i.id !== id), x]
    await this.save()
    return this.view(x)
  }

  /**
   * Fills a fresh folder (`fill`), checks it reads as an extension, then puts
   * it where the old copy was — unloaded first, loaded again after.
   */
  private async commit(id: string, source: ExtensionSource, fill: (stage: string) => Promise<void>): Promise<Installed> {
    const stage = join(this.root(), `.${id}-${randomUUID()}`)
    const target = join(this.root(), id)
    try {
      await fill(stage)
      // Chrome's own bookkeeping; Chromium refuses to load unpacked folders that have it.
      await rm(join(stage, '_metadata'), { recursive: true, force: true })
      await readManifest(stage, this.deps.locale())
      const old = this.items.find((x) => x.id === id)
      if (old) this.unload(old)
      await rm(target, { recursive: true, force: true })
      await rename(stage, target)
      const x = await this.describe({ id, source, path: target, enabled: old?.enabled ?? true, installedAt: old?.installedAt ?? new Date(this.now()).toISOString() })
      this.items = old ? this.items.map((i) => (i === old ? x : i)) : [...this.items, x]
      if (x.enabled) await this.load(x)
      await this.save()
      return x
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }
}
