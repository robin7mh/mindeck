import type { SearchEngine } from '@shared/types/browser'
import { isLoopback } from './url'

/** The engines' suggestion endpoints (OpenSearch JSON: `[query, [suggestion, …]]`). Kagi needs a signed-in session: none. */
const ENDPOINTS: Partial<Record<SearchEngine, (q: string) => string>> = {
  google: (q) => `https://suggestqueries.google.com/complete/search?client=firefox&q=${q}`,
  duckduckgo: (q) => `https://duckduckgo.com/ac/?type=list&q=${q}`,
  bing: (q) => `https://api.bing.com/osjson.aspx?query=${q}`,
  ecosia: (q) => `https://ac.ecosia.org/autocomplete?type=list&q=${q}`,
  brave: (q) => `https://search.brave.com/api/suggest?q=${q}`
}

const TIMEOUT_MS = 1500
const MAX_QUERY = 120
const MAX_RESULTS = 5
const CACHE_SIZE = 64

export type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>

/** What may go to a search engine: words, not addresses, not local pages, nothing long (pasted text). */
export function suggestible(text: string): boolean {
  const q = text.trim()
  if (!q || q.length > MAX_QUERY) return false
  if (/^[a-z][a-z0-9+.-]*:\/?\//i.test(q) || q.startsWith('/')) return false
  return !isLoopback(`http://${q.split(/[/?#\s]/)[0]}`)
}

/** The suggestions in an OpenSearch answer — the query itself and anything that is not text left out. */
export function parseSuggestions(body: unknown, query: string): string[] {
  if (!Array.isArray(body) || !Array.isArray(body[1])) return []
  const q = query.trim().toLowerCase()
  const out: string[] = []
  for (const s of body[1]) {
    if (typeof s !== 'string' || !s.trim() || s.trim().toLowerCase() === q || out.includes(s)) continue
    out.push(s.slice(0, 200))
    if (out.length >= MAX_RESULTS) break
  }
  return out
}

/**
 * Search suggestions as you type, from the engine the user chose — asked in
 * the main process (the page never sees it), given up after a short timeout,
 * answers cached for a while. A newer query aborts the one before it.
 */
export class SearchSuggestions {
  private readonly cache = new Map<string, string[]>()
  private inflight?: AbortController

  constructor(private readonly fetcher: Fetch = (url, init) => fetch(url, init)) {}

  async get(engine: SearchEngine, text: string): Promise<string[]> {
    const endpoint = ENDPOINTS[engine]
    if (!endpoint || !suggestible(text)) return []
    const query = text.trim()
    const key = `${engine}\n${query.toLowerCase()}`
    const cached = this.cache.get(key)
    if (cached) return cached
    this.inflight?.abort()
    const ctrl = new AbortController()
    this.inflight = ctrl
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    // Offline, timed out, or overtaken by the next keystroke: no suggestions this time.
    const list = await this.ask(endpoint(encodeURIComponent(query)), ctrl.signal, query).catch(() => null)
    clearTimeout(timer)
    if (!list) return []
    this.cache.set(key, list)
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!)
    return list
  }

  private async ask(url: string, signal: AbortSignal, query: string): Promise<string[] | null> {
    const res = await this.fetcher(url, { signal, headers: { accept: 'application/json' } })
    return res.ok ? parseSuggestions(await res.json(), query) : null
  }
}
