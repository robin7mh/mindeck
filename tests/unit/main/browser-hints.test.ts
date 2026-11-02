import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandHeader, chromeBrands, configureClientHints, patchUserAgentData, uaPlatform, withClientHints } from '../../../electron/main/platform/browser/clientHints'

const h = vi.hoisted(() => ({ executeInMainWorld: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { executeInMainWorld: h.executeInMainWorld } }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('client hints like Chrome’s', () => {
  it('build Chrome’s brand list for each version — the same order and GREASE Chrome sends', () => {
    // as real Chrome versions send them
    expect(brandHeader(chromeBrands('120.0.6099.71', false))).toBe('"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"')
    expect(brandHeader(chromeBrands('124.0.6367.60', false))).toBe('"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"')
    expect(brandHeader(chromeBrands('131.0.6778.86', false))).toBe('"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"')
    expect(brandHeader(chromeBrands('138.0.7204.50', false))).toBe('"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"')
    expect(brandHeader(chromeBrands('124.0.6367.60', true))).toBe('"Chromium";v="124.0.6367.60", "Google Chrome";v="124.0.6367.60", "Not-A.Brand";v="99.0.0.0"')
    expect(chromeBrands('garbage', false).map((b) => b.brand)).toEqual(['Not A(Brand', 'Chromium', 'Google Chrome'])
    expect(['darwin', 'win32', 'linux', 'freebsd'].map((p) => uaPlatform(p as NodeJS.Platform))).toEqual(['macOS', 'Windows', 'Linux', 'Linux'])
  })

  it('set the low-entropy hints on every request, the full version where asked for or signing in', () => {
    const hints = { fullVersion: '140.0.7339.41', platform: 'macOS' }
    const plain = withClientHints('https://example.com/a', { Accept: 'text/html', 'Sec-CH-UA': '"Chromium";v="140"', 'Sec-CH-UA-Mobile': '?1', 'sec-ch-ua-arch': '"arm"' }, hints)
    expect(plain).toEqual({
      Accept: 'text/html',
      'sec-ch-ua-arch': '"arm"',
      'sec-ch-ua': brandHeader(chromeBrands('140.0.7339.41', false)),
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"'
    })
    const asked = withClientHints('https://example.com/', { 'sec-ch-ua-full-version-list': 'x', 'sec-ch-ua-full-version': '"140.0.0.0"' }, hints)
    expect(asked['sec-ch-ua-full-version-list']).toBe('"Chromium";v="140.0.7339.41", "Not=A?Brand";v="24.0.0.0", "Google Chrome";v="140.0.7339.41"')
    expect(asked['sec-ch-ua-full-version']).toBe('"140.0.7339.41"')
    for (const url of ['https://accounts.google.com/v3/signin', 'https://login.microsoftonline.com/', 'https://appleid.apple.com/auth', 'https://user:pw@github.com/login']) {
      expect(withClientHints(url, {}, hints)['sec-ch-ua-full-version-list'], url).toBeDefined()
    }
    expect(withClientHints('https://notgithub.com/', {}, hints)['sec-ch-ua-full-version-list']).toBeUndefined()
    expect(withClientHints('not a url', {}, hints)['sec-ch-ua-full-version-list']).toBeUndefined()
  })

  it('rewrite the headers of the profile’s https requests', () => {
    let listener: ((d: { url: string; requestHeaders: Record<string, string> }, cb: (r: unknown) => void) => void) | undefined
    const ses = { webRequest: { onBeforeSendHeaders: vi.fn((_f: unknown, fn: typeof listener) => (listener = fn)) } }
    configureClientHints(ses as never, '140.0.1.2', 'Windows')
    expect(ses.webRequest.onBeforeSendHeaders).toHaveBeenCalledWith({ urls: ['https://*/*'] }, expect.any(Function))
    const cb = vi.fn()
    listener!({ url: 'https://a.dev/', requestHeaders: {} }, cb)
    expect(cb).toHaveBeenCalledWith({ requestHeaders: expect.objectContaining({ 'sec-ch-ua-platform': '"Windows"' }) })
  })
})

describe('navigator.userAgentData in the page', () => {
  /** Chromium's NavigatorUAData, reduced to what the patch touches. */
  function uaData() {
    class NavigatorUAData {
      get brands() {
        return [{ brand: 'Chromium', version: '140' }]
      }
      getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>> {
        const v: Record<string, unknown> = { brands: this.brands, platform: 'macOS' }
        if (hints.includes('fullVersionList')) v.fullVersionList = [{ brand: 'Chromium', version: '140.0.1.2' }]
        if (hints.includes('uaFullVersion')) v.uaFullVersion = '140.0.1.2'
        if (hints.includes('architecture')) v.architecture = 'arm'
        return Promise.resolve(v)
      }
      toJSON() {
        return { brands: this.brands, mobile: false, platform: 'macOS' }
      }
    }
    return new NavigatorUAData()
  }

  it('reports Chrome’s brands, keeping Chromium’s other answers', async () => {
    const data = uaData()
    vi.stubGlobal('navigator', { userAgentData: data })
    patchUserAgentData(chromeBrands('140.0.1.2', false), chromeBrands('140.0.1.2', true), '140.0.1.2')
    expect(data.brands.map((b) => b.brand)).toEqual(['Chromium', 'Not=A?Brand', 'Google Chrome'])
    expect(Object.isFrozen(data.brands)).toBe(true)
    expect(data.toJSON()).toEqual({ brands: data.brands, mobile: false, platform: 'macOS' })
    const high = await data.getHighEntropyValues(['fullVersionList', 'uaFullVersion', 'architecture'])
    expect(high).toMatchObject({ platform: 'macOS', architecture: 'arm', uaFullVersion: '140.0.1.2' })
    expect((high.fullVersionList as { brand: string; version: string }[]).find((b) => b.brand === 'Google Chrome')!.version).toBe('140.0.1.2')
    const low = await data.getHighEntropyValues([])
    expect(low).not.toHaveProperty('fullVersionList')
    expect(low).not.toHaveProperty('uaFullVersion')
  })

  it('leaves a page without userAgentData alone', () => {
    vi.stubGlobal('navigator', {})
    expect(() => patchUserAgentData([], [], '1')).not.toThrow()
  })

  it('is what the browser tabs’ own preload runs in the page’s world', async () => {
    ;(process.versions as Record<string, string>).chrome = '140.0.1.2'
    try {
      await import('../../../electron/browserPage')
      expect(h.executeInMainWorld).toHaveBeenCalledWith({ func: expect.any(Function), args: [chromeBrands('140.0.1.2', false), chromeBrands('140.0.1.2', true), '140.0.1.2'] })
      expect(h.executeInMainWorld.mock.calls[0][0].func.name).toBe('patchUserAgentData')
    } finally {
      delete (process.versions as Record<string, string | undefined>).chrome
    }
  })
})
