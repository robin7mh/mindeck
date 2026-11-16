/** Chrome extension ids: 32 letters a–p. */
export const EXTENSION_ID = /^[a-p]{32}$/

const UPDATE_SERVICE = 'https://clients2.google.com/service/update2/crx'

/** The extension id in a Chrome Web Store address (old and new store) or on its own. */
export function storeId(input: string): string | null {
  const text = input.trim()
  if (EXTENSION_ID.test(text.toLowerCase())) return text.toLowerCase()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || (host !== 'chromewebstore.google.com' && host !== 'chrome.google.com')) return null
  const id = url.pathname
    .split('/')
    .map((s) => s.toLowerCase())
    .find((s) => EXTENSION_ID.test(s))
  return id ?? null
}

/**
 * The Web Store's update check for `items` — Chrome's own protocol: one
 * request, an `x` parameter per extension. Version 0.0.0.0 asks for the
 * current release (a fresh install).
 */
export function updateCheckUrl(items: { id: string; version: string }[], chromeVersion: string): string {
  const params = new URLSearchParams({ response: 'updatecheck', acceptformat: 'crx3', prodversion: chromeVersion })
  for (const { id, version } of items) params.append('x', `id=${id}&v=${version}&uc`)
  return `${UPDATE_SERVICE}?${params}`
}

export interface StoreRelease {
  version: string
  /** Where the CRX package is. */
  url: string
  /** SHA-256 of the package (hex), when the store says. */
  sha256?: string
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = m[2].replace(/&amp;/g, '&')
  return out
}

/** The update check's answer: per id, the release on offer (null: none, or none newer). */
export function parseUpdateResponse(xml: string): Map<string, StoreRelease | null> {
  const out = new Map<string, StoreRelease | null>()
  for (const app of xml.matchAll(/<app\b([^>]*)>([\s\S]*?)<\/app>/g)) {
    const id = attributes(app[1]).appid
    if (!id) continue
    const check = /<updatecheck\b([^>]*?)\/?>/.exec(app[2])
    const a = check ? attributes(check[1]) : {}
    out.set(
      id,
      a.status === 'ok' && a.codebase && a.version ? { version: a.version, url: a.codebase, ...(a.hash_sha256 ? { sha256: a.hash_sha256.toLowerCase() } : {}) } : null
    )
  }
  return out
}

/** Compares Chrome extension versions ("1.10.2" > "1.9"): negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}
