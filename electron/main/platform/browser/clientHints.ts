import type { Session } from 'electron'

/** One entry of a client-hints brand list. */
export interface Brand {
  brand: string
  version: string
}

/**
 * Chrome's brand list for a Chrome version, as Chrome itself builds it
 * (components/embedder_support/user_agent_utils.cc): Chromium, Google Chrome
 * and a "GREASE" brand, in an order and spelling that follow the major
 * version. Electron is an unbranded Chromium and leaves "Google Chrome" out —
 * which sign-in pages hold against a browser whose user agent says Chrome.
 */
export function chromeBrands(fullVersion: string, full: boolean): Brand[] {
  const major = Math.max(0, parseInt(fullVersion, 10) || 0)
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_']
  const greased = ['8', '99', '24'][major % 3]
  const version = full ? fullVersion : String(major)
  const list: Brand[] = [
    { brand: `Not${chars[major % 11]}A${chars[(major + 1) % 11]}Brand`, version: full ? `${greased}.0.0.0` : greased },
    { brand: 'Chromium', version },
    { brand: 'Google Chrome', version }
  ]
  const order = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0]
  ][major % 6]
  const out: Brand[] = []
  list.forEach((b, i) => (out[order[i]] = b))
  return out
}

/** A brand list as a structured header: `"Chromium";v="140", "Google Chrome";v="140", …`. */
export function brandHeader(brands: Brand[]): string {
  return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ')
}

/** What Chrome reports as its platform. */
export function uaPlatform(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux'
}

/** Sign-in pages that check the browser closely: they get the full version list even before asking for it. */
const SIGN_IN_HOST = /(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|idmsa\.apple\.com|github\.com)$/i

/** The hints Mindeck sets itself (any spelling Chromium sent is replaced). */
const OURS = new Set(['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-ch-ua-full-version-list', 'sec-ch-ua-full-version'])

/**
 * A request's headers with client hints that match Chrome's user agent:
 * `Sec-CH-UA` with Google Chrome among the brands, mobile and platform —
 * and the full-version hints where the page asked for them (Accept-CH) or
 * is a sign-in page. Everything else stays as Chromium sent it.
 */
export function withClientHints(url: string, headers: Record<string, string>, hints: { fullVersion: string; platform: string }): Record<string, string> {
  const host = /^[a-z]+:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(url)?.[1] ?? ''
  const out: Record<string, string> = {}
  const asked = new Set<string>()
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (OURS.has(lower)) asked.add(lower)
    else out[name] = value // the other high-entropy hints (platform version, architecture, …) are Chromium's own and true
  }
  out['sec-ch-ua'] = brandHeader(chromeBrands(hints.fullVersion, false))
  out['sec-ch-ua-mobile'] = '?0'
  out['sec-ch-ua-platform'] = `"${hints.platform}"`
  if (asked.has('sec-ch-ua-full-version-list') || SIGN_IN_HOST.test(host)) out['sec-ch-ua-full-version-list'] = brandHeader(chromeBrands(hints.fullVersion, true))
  if (asked.has('sec-ch-ua-full-version')) out['sec-ch-ua-full-version'] = `"${hints.fullVersion}"`
  return out
}

/** Every https request of the browser profile carries Chrome's client hints. */
export function configureClientHints(ses: Session, fullVersion: string, platform: string): void {
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) =>
    callback({ requestHeaders: withClientHints(details.url, details.requestHeaders, { fullVersion, platform }) })
  )
}

/**
 * Runs inside the page (serialized into its main world, so it uses nothing
 * from outside): `navigator.userAgentData` reports the same brands as the
 * headers. Its other answers (platform version, architecture, …) stay Chromium's.
 */
export function patchUserAgentData(brands: Brand[], fullVersionList: Brand[], fullVersion: string): void {
  type UaData = { getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>>; toJSON(): Record<string, unknown> }
  const data = (navigator as Navigator & { userAgentData?: UaData }).userAgentData
  if (!data) return
  const proto = Object.getPrototypeOf(data) as UaData
  const list = (l: Brand[]) => Object.freeze(l.map((b) => Object.freeze({ brand: b.brand, version: b.version })))
  const high = proto.getHighEntropyValues
  const json = proto.toJSON
  Object.defineProperty(proto, 'brands', { configurable: true, enumerable: true, get: () => list(brands) })
  Object.defineProperty(proto, 'getHighEntropyValues', {
    configurable: true,
    writable: true,
    value(this: UaData, hints: string[]) {
      return high.call(this, hints).then((v) => ({
        ...v,
        brands: list(brands),
        ...('fullVersionList' in v ? { fullVersionList: list(fullVersionList) } : {}),
        ...('uaFullVersion' in v ? { uaFullVersion: fullVersion } : {})
      }))
    }
  })
  Object.defineProperty(proto, 'toJSON', {
    configurable: true,
    writable: true,
    value(this: UaData) {
      return { ...json.call(this), brands: list(brands) }
    }
  })
}
