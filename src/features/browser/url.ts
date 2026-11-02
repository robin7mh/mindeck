import type { BrowserSuggestion, SearchEngine } from '@shared/types/browser'

/** How the search engines are called in the UI. */
export const ENGINE_LABELS: Record<SearchEngine, string> = { google: 'Google', duckduckgo: 'DuckDuckGo', bing: 'Bing', ecosia: 'Ecosia', brave: 'Brave Search', kagi: 'Kagi' }

/** The address as the bar shows it when not editing: no scheme, no lone trailing slash; file paths as paths. */
export function displayUrl(url: string): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    if (u.protocol === 'http:' || u.protocol === 'https:') return `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname)
  } catch {
    // not a URL: show it as it is
  }
  return url
}

/** What the lock spot in front of the address says. */
export type Security = 'secure' | 'insecure' | 'local' | 'file' | 'none'

const LOCAL = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$|\.localhost$/i

export function security(url: string): Security {
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return 'file'
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'none'
    if (LOCAL.test(u.hostname)) return 'local'
    return u.protocol === 'https:' ? 'secure' : 'insecure'
  } catch {
    return 'none'
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** One letter for a site without a favicon: the first of its name (www. aside). */
export function initial(url: string, title = ''): string {
  const host = hostOf(url).replace(/^www\./, '')
  return (host || title || '?').charAt(0).toUpperCase()
}

const bare = (url: string) => url.replace(/^[a-z]+:\/\//i, '').replace(/^www\./i, '')

/**
 * Chrome's inline completion: when a visited or saved page's address starts with what
 * was typed, the bar completes it — to the host while the typing is within
 * it, else to the whole address. Null when nothing fits.
 */
export function inlineCompletion(text: string, suggestions: BrowserSuggestion[]): { value: string; url: string } | null {
  const typed = text.toLowerCase()
  if (!typed || /\s/.test(typed)) return null
  for (const s of suggestions) {
    if (s.kind !== 'history' && s.kind !== 'tab' && s.kind !== 'bookmark') continue
    const address = bare(s.url).replace(/\/$/, '')
    if (!address.toLowerCase().startsWith(typed)) continue
    const host = address.split('/')[0]
    if (typed.length <= host.length) return { value: text + host.slice(text.length), url: `${new URL(s.url).origin}/` }
    return { value: text + address.slice(text.length), url: s.url }
  }
  return null
}

/** The search engine's suggestions below the first line (go there / search), without doubles, at most ten lines. */
export function withSuggestions(list: BrowserSuggestion[], extra: BrowserSuggestion[]): BrowserSuggestion[] {
  const seen = new Set(list.map((s) => s.url))
  const fresh = extra.filter((s) => !seen.has(s.url))
  return [...list.slice(0, 1), ...fresh, ...list.slice(1)].slice(0, 10)
}
