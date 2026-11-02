import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { adsAndTrackingLists } from '@ghostery/adblocker'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'
import { AdblockService, MALWARE_LISTS, type Protections } from '../../../electron/main/services/browser/adblock'
import { drmFailure, needsDrm } from '../../../electron/main/services/browser/drm'
import type { FetchResponse } from '../../../electron/main/services/browser/extensions/ExtensionService'

const ADS = ['@@||quiet.dev^$elemhide', '||ads.dev^', '||tracker.dev/t.js$script,redirect=noop.js', 'news.dev##.ad-banner', '192.168.1.20##.lan-ad'].join('\n')
const RESOURCES = JSON.stringify({ redirects: [{ name: 'noop.js', aliases: [], body: '(function(){})()', contentType: 'application/javascript' }], scriptlets: [] })
const MALWARE = '||evil.dev^\n||bad.dev/payload.exe'
const DAY = 24 * 60 * 60 * 1000

const ok = (text: string): FetchResponse => ({ ok: true, status: 200, text: async () => text, arrayBuffer: async () => new ArrayBuffer(0) })
const fail = (status: number): FetchResponse => ({ ok: false, status, text: async () => 'error page', arrayBuffer: async () => new ArrayBuffer(0) })

function setup(dir: string, opts: { wanted?: Protections; now?: () => number; fetch?: (url: string) => Promise<FetchResponse> } = {}) {
  const wanted = { ads: true, malware: true, ...opts.wanted }
  const fetch = vi.fn(
    opts.fetch ??
      (async (url: string) => {
        if (url.endsWith('resources.json')) return ok(RESOURCES)
        if (url === MALWARE_LISTS[0]) return ok(MALWARE)
        if (adsAndTrackingLists.includes(url)) return ok(url === adsAndTrackingLists[0] ? ADS : '! nothing')
        return fail(404)
      })
  )
  const blocker = new AdblockService({ dir, fetch, wanted: () => wanted, now: opts.now })
  return { blocker, fetch, wanted }
}

const req = (url: string, type = 'script', page = 'https://news.dev/article') => ({ url, type, sourceUrl: page, page })

afterEach(() => vi.useRealTimers())

describe('the ad and malware blocker', () => {
  it('fetches the lists, blocks ads and trackers on pages — never the page itself — and caches the engines', async () => {
    const dir = await tempDir()
    let now = 1_000_000
    const { blocker, fetch, wanted } = setup(dir, { now: () => now })
    await blocker.init()
    expect(blocker.check(req('https://ads.dev/banner.js'))).toEqual({}) // nothing loaded yet
    await blocker.update()
    expect(blocker.check(req('https://ads.dev/banner.js'))).toEqual({ cancel: true })
    expect(blocker.check(req('https://ads.dev/', 'mainFrame', 'https://ads.dev/'))).toEqual({})
    expect(blocker.check(req('https://cdn.dev/app.js'))).toEqual({})
    expect(blocker.check(req('https://tracker.dev/t.js')).redirectURL).toMatch(/^data:application\/javascript/)
    expect(blocker.check(req('chrome-extension://abc/x.js'))).toEqual({})
    // malware: the page itself stops, with the reason; a download from it too
    expect(blocker.check(req('https://evil.dev/', 'mainFrame', ''))).toEqual({ cancel: true, danger: true })
    expect(blocker.check(req('https://bad.dev/payload.exe', 'other'))).toEqual({ cancel: true })
    expect(JSON.parse(await readFile(join(dir, 'adblock', 'state.json'), 'utf8')).updated).toEqual({ ads: now, malware: now })

    // element hiding: the site's rules and the generic ones
    expect(blocker.cosmetics('https://news.dev/a')).toContain('.ad-banner')
    expect(blocker.cosmetics('https://other.dev/')).not.toContain('.ad-banner')
    expect(blocker.cosmetics('file:///x.html')).toBe('')
    expect(blocker.cosmetics('https://quiet.dev/')).toBe('') // the lists say: hide nothing here
    expect(blocker.cosmetics('https://192.168.1.20/')).toContain('.lan-ad') // an address without a domain

    // a second start reads the cache (no network)
    fetch.mockClear()
    const again = setup(dir, { now: () => now })
    await again.blocker.init()
    expect(again.blocker.check(req('https://ads.dev/banner.js'))).toEqual({ cancel: true })
    await again.blocker.update()
    expect(again.fetch).not.toHaveBeenCalled() // fresh enough
    now += DAY + 1
    await again.blocker.update()
    expect(again.fetch).toHaveBeenCalled()
    // engines cached, but no word on when: fetched again
    await writeFile(join(dir, 'adblock', 'state.json'), '{}')
    const unknown = setup(dir, { now: () => now })
    await unknown.blocker.init()
    await unknown.blocker.update()
    expect(unknown.fetch).toHaveBeenCalled()

    // turned off in the settings: no blocking, no hiding, no downloads
    wanted.ads = false
    wanted.malware = false
    expect(blocker.check(req('https://ads.dev/banner.js'))).toEqual({})
    expect(blocker.check(req('https://evil.dev/', 'mainFrame', ''))).toEqual({})
    expect(blocker.cosmetics('https://news.dev/a')).toBe('')
    fetch.mockClear()
    await blocker.update(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('leaves sites the user exempted — and this computer’s dev pages — alone, remembered across starts', async () => {
    const dir = await tempDir()
    const { blocker } = setup(dir)
    await blocker.init()
    await blocker.update()
    await blocker.setSite('https://news.dev/article', false)
    expect(blocker.siteOn('https://news.dev/other')).toBe(false)
    expect(blocker.check(req('https://ads.dev/banner.js'))).toEqual({})
    expect(blocker.cosmetics('https://news.dev/')).toBe('')
    expect(blocker.check(req('https://ads.dev/banner.js', 'script', 'http://localhost:5173/'))).toEqual({})
    expect(blocker.siteOn('')).toBe(true) // no page (a popup): blocking applies
    await blocker.setSite('not a url', false)
    const again = setup(dir).blocker
    await again.init()
    expect(again.siteOn('https://news.dev/')).toBe(false)
    await again.setSite('https://news.dev/', true)
    expect(again.siteOn('https://news.dev/')).toBe(true)
    expect(JSON.parse(await readFile(join(dir, 'adblock', 'state.json'), 'utf8')).off).toEqual([])
  })

  it('opens a malware site the user insists on, until Mindeck quits', async () => {
    const { blocker } = setup(await tempDir())
    await blocker.init()
    await blocker.update()
    blocker.trust('https://evil.dev/start')
    blocker.trust('nonsense')
    expect(blocker.check(req('https://evil.dev/', 'mainFrame', ''))).toEqual({})
  })

  it('sets a damaged state file aside — the exempted sites may still be rescued from it', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'adblock'))
    await writeFile(join(dir, 'adblock', 'state.json'), '{"off":["a.dev"')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { blocker } = setup(dir)
    await blocker.init()
    expect(blocker.siteOn('https://a.dev/')).toBe(true)
    expect((await readdir(join(dir, 'adblock'))).some((name) => name.startsWith('state.corrupt-'))).toBe(true)
  })

  it('keeps the old engine when a list host is down, tries the mirror, and reads damaged caches as none', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'adblock'))
    await writeFile(join(dir, 'adblock', 'ads.bin'), 'not an engine')
    await writeFile(join(dir, 'adblock', 'state.json'), JSON.stringify({ off: ['a.dev', 7], updated: { ads: 5, malware: 'x' } }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true, advanceTimeDelta: 200 })
    const { blocker, fetch } = setup(dir, {
      fetch: async (url) => {
        if (url === MALWARE_LISTS[0]) throw new Error('offline')
        if (url === MALWARE_LISTS[1]) return ok(MALWARE)
        return fail(503)
      }
    })
    await blocker.init()
    expect(blocker.siteOn('https://a.dev/')).toBe(false)
    expect(blocker.check(req('https://a.dev/x.js', 'script', 'https://b.dev/'))).toEqual({}) // the damaged engine was not taken
    expect(await readdir(join(dir, 'adblock'))).not.toContainEqual(expect.stringContaining('corrupt'))
    // two looks at once share one update
    await Promise.all([blocker.update(), blocker.update()])
    expect(errors).toHaveBeenCalledWith('[browser] updating the ads filter lists failed', expect.any(Error))
    expect(blocker.check(req('https://evil.dev/', 'mainFrame', ''))).toEqual({ cancel: true, danger: true })
    expect(fetch).toHaveBeenCalledWith(MALWARE_LISTS[1])
    // both hosts down: the reason is logged, the engine stays
    const down = setup(await tempDir(), { wanted: { ads: false, malware: true }, fetch: async () => fail(500) })
    await down.blocker.update()
    expect(errors).toHaveBeenLastCalledWith('[browser] updating the malware filter lists failed', expect.objectContaining({ message: expect.stringContaining('HTTP 500') }))
  })

  it('looks for fresh lists shortly after start and then every hour, until stopped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const { blocker } = setup(await tempDir())
    const update = vi.spyOn(blocker, 'update').mockResolvedValue()
    blocker.start()
    blocker.start()
    vi.advanceTimersByTime(15_000)
    expect(update).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(update).toHaveBeenCalledTimes(2)
    blocker.dispose()
    vi.advanceTimersByTime(10 * 60 * 60 * 1000)
    expect(update).toHaveBeenCalledTimes(2)
  })
})

describe('DRM', () => {
  it('knows streaming sites that need it', () => {
    for (const url of ['https://www.netflix.com/watch/1', 'https://open.spotify.com/', 'https://www.disneyplus.com/', 'https://www.amazon.de/gp/video/detail/x', 'https://play.max.com/']) {
      expect(needsDrm(url), url).toBe(true)
    }
    for (const url of ['https://spotify.com/', 'https://www.amazon.de/dp/123', 'https://notnetflix.com/', 'file:///netflix.com', 'nonsense']) expect(needsDrm(url), url).toBe(false)
  })

  it('reads players’ complaints in the console', () => {
    expect(drmFailure('error', 'Failed to execute requestMediaKeySystemAccess: Unsupported keySystem')).toBe(true)
    expect(drmFailure('warning', 'Shaka Error DRM.REQUESTED_KEY_SYSTEM_CONFIG_UNAVAILABLE')).toBe(true)
    expect(drmFailure('info', 'com.widevine.alpha')).toBe(false)
    expect(drmFailure('error', 'TypeError: x is undefined')).toBe(false)
  })
})
