import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { adsAndTrackingLists, fetchLists, fetchResources, FiltersEngine, Request, type Fetch } from '@ghostery/adblocker'
import { readJson } from '../../lib/jsonFile'
import { writeAtomic } from '../../lib/writeAtomic'
import type { FetchResponse } from './extensions/ExtensionService'
import { hostOf, isLoopbackHost } from './url'

/** Filter lists are fetched again after this long. */
const STALE_MS = 24 * 60 * 60 * 1000
/** How often to look whether they are stale. */
const CHECK_EVERY_MS = 60 * 60 * 1000
/** The first look after start — not while the window comes up. */
const FIRST_CHECK_MS = 15_000

/**
 * Malware sites (URLhaus via malware-filter, CC0) in adblock syntax; the
 * same list on two hosts, the second used when the first fails.
 */
export const MALWARE_LISTS = [
  'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt',
  'https://curbengh.github.io/malware-filter/urlhaus-filter-online.txt'
]

/** What a request gets: go on, cancelled, or answered with a harmless stand-in (`redirectURL`). */
export interface RequestVerdict {
  cancel?: true
  redirectURL?: string
  /** Cancelled because the address is on the malware list. */
  danger?: true
}

export interface WebRequestInfo {
  url: string
  /** Electron's resource type ('mainFrame', 'script', 'image', …). */
  type: string
  /** The page that asked (the referrer). */
  sourceUrl: string
  /** The page the tab shows — whose site's choice applies. */
  page: string
}

/** Which protections the user wants (the browser settings). */
export interface Protections {
  ads: boolean
  malware: boolean
}

type ListName = 'ads' | 'malware'

export interface AdblockDeps {
  /** ~/Mindeck/data/browser — the engines are cached under `adblock/`. */
  dir: string
  fetch: (url: string) => Promise<FetchResponse>
  wanted: () => Protections
  now?: () => number
}

const NETWORK = /^(https?|wss?):/i

/**
 * Ad, tracker and malware blocking for every browser profile (architecture
 * §12.9), with Ghostery's engine over EasyList, EasyPrivacy and uBlock's
 * lists. The engines are cached in the data folder, so blocking works from
 * the first request after a start; the lists are fetched again once a day.
 * The user turns blocking off per site; the malware warning can be passed
 * per site until Mindeck quits.
 */
export class AdblockService {
  private readonly engines: Partial<Record<ListName, FiltersEngine>> = {}
  private updated: Partial<Record<ListName, number>> = {}
  /** Sites (hostnames) where ads are not blocked. */
  private off = new Set<string>()
  /** Sites opened despite the malware warning, for this run. */
  private readonly trusted = new Set<string>()
  private timer?: NodeJS.Timeout
  private first?: NodeJS.Timeout
  private updating?: Promise<void>

  constructor(private readonly deps: AdblockDeps) {}

  /** The cached engines and the sites the user exempted. */
  async init(): Promise<void> {
    // A damaged file is set aside (readJson) — the sites the user exempted may still be rescued from it.
    const state = await readJson<{ off?: unknown; updated?: Partial<Record<ListName, unknown>> } | null>(this.file('state.json'))
    this.off = new Set(Array.isArray(state?.off) ? state.off.filter((h): h is string => typeof h === 'string') : [])
    for (const name of ['ads', 'malware'] as const) {
      const at = state?.updated?.[name]
      try {
        this.engines[name] = FiltersEngine.deserialize(await readFile(this.file(`${name}.bin`)))
        if (typeof at === 'number') this.updated[name] = at
      } catch {
        // missing, or written by another engine version: fetched again
      }
    }
  }

  /** Keeps the lists fresh: a first look shortly after start, then every hour. */
  start(): void {
    this.stop()
    this.first = setTimeout(() => void this.update(), FIRST_CHECK_MS)
    this.timer = setInterval(() => void this.update(), CHECK_EVERY_MS)
  }

  stop(): void {
    clearTimeout(this.first)
    clearInterval(this.timer)
  }

  /** Fetches the lists that are wanted and stale (or missing) and swaps their engines in. Never throws. */
  update(force = false): Promise<void> {
    this.updating ??= this.refresh(force).finally(() => (this.updating = undefined))
    return this.updating
  }

  /** What happens to a request of a page. */
  check(req: WebRequestInfo): RequestVerdict {
    if (!NETWORK.test(req.url)) return {}
    const wanted = this.deps.wanted()
    const request = () => Request.fromRawDetails({ url: req.url, type: req.type as never, sourceUrl: req.sourceUrl || req.page })
    const malware = this.engines.malware
    if (wanted.malware && malware && !this.trusted.has(hostOf(req.url)) && malware.match(request()).match) {
      return req.type === 'mainFrame' ? { cancel: true, danger: true } : { cancel: true }
    }
    const ads = this.engines.ads
    // Pages themselves always load (like every blocker); nor is anything blocked on this machine's dev pages.
    if (!wanted.ads || !ads || req.type === 'mainFrame' || !this.siteOn(req.page)) return {}
    const { match, redirect } = ads.match(request())
    if (redirect) return { redirectURL: redirect.dataUrl }
    return match ? { cancel: true } : {}
  }

  /** CSS that hides ads on `url` (element hiding rules); '' when there is nothing to hide. */
  cosmetics(url: string): string {
    const ads = this.engines.ads
    if (!ads || !this.deps.wanted().ads || !/^https?:/i.test(url) || !this.siteOn(url)) return ''
    const { hostname, domain } = Request.fromRawDetails({ url, type: 'mainFrame' })
    const { styles } = ads.getCosmeticsFilters({
      url,
      hostname,
      domain: domain || hostname,
      getBaseRules: true,
      getInjectionRules: false,
      getExtendedRules: false,
      getRulesFromHostname: true,
      getRulesFromDOM: false
    })
    return styles
  }

  /** Blocking applies on the page's site (not on local dev pages, not where the user turned it off). */
  siteOn(page: string): boolean {
    const host = hostOf(page)
    return !host || (!isLoopbackHost(host) && !this.off.has(host))
  }

  /** Ads and trackers blocked on the site of `page`, or not. */
  async setSite(page: string, on: boolean): Promise<void> {
    const host = hostOf(page)
    if (!host) return
    if (on) this.off.delete(host)
    else this.off.add(host)
    await this.saveState()
  }

  /** The user opens a site on the malware list anyway (until Mindeck quits). */
  trust(url: string): void {
    const host = hostOf(url)
    if (host) this.trusted.add(host)
  }

  dispose(): void {
    this.stop()
  }

  // --- internals ------------------------------------------------------------------

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private file(name: string): string {
    return join(this.deps.dir, 'adblock', name)
  }

  private async saveState(): Promise<void> {
    await writeAtomic(this.file('state.json'), JSON.stringify({ version: 1, updated: this.updated, off: [...this.off].sort() }, null, 2))
  }

  /** Lists as text — a failed answer is an error, not a list. */
  private readonly fetchText: Fetch = async (url) => {
    const res = await this.deps.fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    const text = await res.text()
    // The engine only ever reads lists as text.
    return { text: async () => text } as Awaited<ReturnType<Fetch>>
  }

  private async refresh(force: boolean): Promise<void> {
    const wanted = this.deps.wanted()
    const stale = (name: ListName) => force || !this.engines[name] || this.now() - (this.updated[name] ?? 0) > STALE_MS
    for (const name of ['ads', 'malware'] as const) {
      if (!wanted[name] || !stale(name)) continue
      try {
        const engine = name === 'ads' ? await this.buildAds() : await this.buildMalware()
        this.engines[name] = engine
        this.updated[name] = this.now()
        // Written whole or not at all: a half engine would not load.
        await mkdir(join(this.deps.dir, 'adblock'), { recursive: true })
        await writeFile(this.file(`${name}.bin.tmp`), engine.serialize())
        await rename(this.file(`${name}.bin.tmp`), this.file(`${name}.bin`))
        await this.saveState()
      } catch (err) {
        // Offline or a list host down: the cached engine keeps working; the next look tries again.
        console.error(`[browser] updating the ${name} filter lists failed`, err)
      }
    }
  }

  private async buildAds(): Promise<FiltersEngine> {
    const [lists, resources] = await Promise.all([fetchLists(this.fetchText, adsAndTrackingLists), fetchResources(this.fetchText)])
    const engine = FiltersEngine.parse(lists.join('\n'), { loadCosmeticFilters: true, loadNetworkFilters: true, loadExtendedSelectors: false })
    engine.updateResources(resources, `${resources.length}`)
    return engine
  }

  private async buildMalware(): Promise<FiltersEngine> {
    let lastError: unknown
    for (const url of MALWARE_LISTS) {
      try {
        const text = await (await this.fetchText(url)).text()
        return FiltersEngine.parse(text, { loadCosmeticFilters: false, loadNetworkFilters: true })
      } catch (err) {
        lastError = err
      }
    }
    throw lastError
  }
}
