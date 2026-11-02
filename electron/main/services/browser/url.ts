import { pathToFileURL } from 'node:url'
import type { SearchEngine } from '@shared/types/browser'

const SEARCH: Record<SearchEngine, string> = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
  ecosia: 'https://www.ecosia.org/search?q=',
  brave: 'https://search.brave.com/search?q=',
  kagi: 'https://kagi.com/search?q='
}

export function searchUrl(engine: SearchEngine, query: string): string {
  return SEARCH[engine] + encodeURIComponent(query)
}

/** Schemes a tab shows itself. Everything else (mailto:, slack:, …) belongs to another app. */
const PAGE_SCHEMES = new Set(['http:', 'https:', 'file:', 'about:', 'data:'])

export function isPageUrl(url: string): boolean {
  try {
    return PAGE_SCHEMES.has(new URL(url).protocol)
  } catch {
    return false
  }
}

/** http(s) only — what agents may open and what the history keeps. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** This machine: localhost, 127.x, ::1 and *.localhost. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h) || h.endsWith('.localhost')
}

/** A local dev page (http or https on this machine). */
export function isLoopback(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && isLoopbackHost(u.hostname)
  } catch {
    return false
  }
}

/** The page's origin (`https://example.com`), '' when it has none. */
export function originOf(url: string): string {
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? '' : origin
  } catch {
    return ''
  }
}

/** The page's host name (`example.com`, lower case), '' when it has none. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Hosts reached over plain http when typed without a scheme: this machine and the local network. */
function plainHttp(host: string): boolean {
  const h = host.toLowerCase()
  return isLoopbackHost(h) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || h.startsWith('[') || /\.(local|lan|internal|test|home\.arpa)$/.test(h)
}

/** `host[:port][/path…]` as typed: localhost, an IP, or a name with a dot and a letter TLD. */
const HOST_INPUT =
  /^(localhost|\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z][a-z0-9-]*[a-z0-9]|[a-z]))(:\d{1,5})?([/?#].*)?$/i

/** "node.js", "config.json": a file or a library rather than a site (when typed alone). */
const CODE_TLDS = new Set(['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'json', 'txt', 'md', 'py', 'rb', 'css', 'scss', 'html', 'yml', 'yaml', 'toml', 'lock', 'log', 'sh'])

/**
 * What the address bar makes of typed text: an address (with https://, or
 * http:// for this machine and the local network), a file path, a URL with
 * its own scheme, or a search with the chosen engine. '' for blank input.
 */
export function resolveInput(input: string, engine: SearchEngine): string {
  const text = input.trim()
  if (!text) return ''
  if (text.startsWith('/')) return pathToFileURL(text).href
  if (!/\s/.test(text)) {
    const host = HOST_INPUT.exec(text)
    if (host) {
      const [, name, tld, port, rest] = host
      const looksLikeFile = !!tld && CODE_TLDS.has(tld.toLowerCase()) && !port && !rest
      if (!looksLikeFile) {
        try {
          return new URL(`${plainHttp(name) ? 'http' : 'https'}://${text}`).href
        } catch {
          // e.g. a port above 65535: not an address after all — search for it
        }
      }
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
      return text
    }
  }
  return searchUrl(engine, text)
}
