import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { onCleanup, tempDir } from './helpers'
import { BrowserHistory } from '../../../electron/main/services/browser/history'
import { parseSuggestions, SearchSuggestions, suggestible, type Fetch } from '../../../electron/main/services/browser/suggestions'
import { labels } from '../../../electron/main/services/browser/labels'
import { BOOKMARK_ROOTS, BROWSER_NAMES, IMPORT_BROWSERS, internalPage, INTERNAL_PAGES, isFolder } from '@shared/types/browserData'

const DAY = 86_400_000

async function history() {
  const file = join(await tempDir(), 'history.jsonl')
  let now = 100 * DAY
  const h = new BrowserHistory(file, () => now)
  onCleanup(() => h.flush())
  return { h, file, at: (t: number) => (now = t) }
}

describe('the history page', () => {
  it('lists pages newest first, page by page, and by search words', async () => {
    const { h, at } = await history()
    at(1 * DAY)
    h.visit('https://old.dev/', 'Old docs')
    at(2 * DAY)
    h.visit('https://mid.dev/', 'Middle')
    at(3 * DAY)
    h.visit('https://new.dev/', 'New docs')
    expect(h.list().map((e) => e.url)).toEqual(['https://new.dev/', 'https://mid.dev/', 'https://old.dev/'])
    expect(h.list({ before: 3 * DAY, limit: 1 }).map((e) => e.url)).toEqual(['https://mid.dev/'])
    expect(h.list({ query: 'DOCS' }).map((e) => e.url)).toEqual(['https://new.dev/', 'https://old.dev/'])
    expect(h.list({ query: 'docs old' }).map((e) => e.url)).toEqual(['https://old.dev/'])
  })

  it('forgets single pages and whole time spans — on disk too', async () => {
    const { h, file, at } = await history()
    for (const [i, url] of ['https://a.dev/', 'https://b.dev/', 'https://c.dev/', 'https://d.dev/'].entries()) {
      at((i + 1) * DAY)
      h.visit(url, url)
    }
    expect(await h.remove({ urls: ['https://a.dev/', 'https://none.dev/'] })).toBe(1)
    expect(await h.remove({ from: 2 * DAY, to: 3 * DAY })).toBe(1) // b only: the span ends before c
    expect(await h.remove({ from: 4 * DAY })).toBe(1)
    expect(await h.remove({})).toBe(0)
    expect(h.list().map((e) => e.url)).toEqual(['https://c.dev/'])
    await h.flush()
    const again = new BrowserHistory(file)
    await again.load()
    expect(again.list().map((e) => e.url)).toEqual(['https://c.dev/'])
    // the last page gone: no file is left
    expect(await h.remove({ to: Infinity })).toBe(1)
    await h.flush()
    await expect(readFile(file)).rejects.toThrow()
  })

  it('merges imported pages idempotently — more visits and the later visit win', async () => {
    const { h, file } = await history()
    h.visit('https://mine.dev/', '')
    const pages = [
      { url: 'https://mine.dev/', title: 'Mine', visits: 5, last: 50 * DAY },
      { url: 'https://new.dev/', title: 'New', visits: 0, last: 120 * DAY },
      { url: 'https://neg.dev/', title: '', visits: -3, last: 10 * DAY },
      { url: 'chrome://settings', title: 'no', visits: 1, last: 1 },
      { url: 'https://nan.dev/', title: 'no', visits: 1, last: NaN }
    ]
    expect(await h.merge(pages)).toBe(3)
    expect(await h.merge(pages)).toBe(3)
    expect(await h.merge([])).toBe(0)
    const all = h.list()
    expect(all.find((e) => e.url === 'https://mine.dev/')).toMatchObject({ title: 'Mine', visits: 5, lastVisit: new Date(100 * DAY).toISOString() })
    expect(all.find((e) => e.url === 'https://new.dev/')).toMatchObject({ title: 'New', visits: 1 })
    expect(all.find((e) => e.url === 'https://neg.dev/')).toMatchObject({ title: '', visits: 1 })
    // an older visit with a title fills in a page that had none
    await h.merge([{ url: 'https://neg.dev/', title: 'Named later', visits: 1, last: 1 }])
    expect(h.list().find((e) => e.url === 'https://neg.dev/')!.title).toBe('Named later')
    await h.flush()
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(3)
  })
})

describe('search suggestions', () => {
  const answer = (body: unknown, ok = true) => ({ ok, json: async () => body })

  it('only send words — not addresses, local pages, paths or pasted text', () => {
    expect(suggestible('react hooks')).toBe(true)
    expect(suggestible('github.com')).toBe(true)
    expect(suggestible('  ')).toBe(false)
    expect(suggestible('x'.repeat(121))).toBe(false)
    expect(suggestible('https://a.dev/')).toBe(false)
    expect(suggestible('mailto:me@x.dev')).toBe(true)
    expect(suggestible('/Users/me')).toBe(false)
    expect(suggestible('localhost:3000/x')).toBe(false)
    expect(suggestible('127.0.0.1')).toBe(false)
  })

  it('read OpenSearch answers: text only, not the query itself, no doubles, at most five', () => {
    expect(parseSuggestions(null, 'q')).toEqual([])
    expect(parseSuggestions(['q', 'nope'], 'q')).toEqual([])
    expect(parseSuggestions(['q', ['Q', 'a', 5, ' ', 'a', 'b', 'c', 'd', 'e', 'f', 'x'.repeat(300)]], 'q ')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(parseSuggestions(['q', ['x'.repeat(300)]], 'q')).toEqual(['x'.repeat(200)])
  })

  it('ask the chosen engine, cache answers, and give up quietly', async () => {
    const fetcher = vi.fn<Fetch>(async () => answer(['react', ['react hooks', 'react router']]))
    const s = new SearchSuggestions(fetcher)
    expect(await s.get('google', 'react')).toEqual(['react hooks', 'react router'])
    expect(await s.get('google', 'React ')).toEqual(['react hooks', 'react router']) // cached
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe('https://suggestqueries.google.com/complete/search?client=firefox&q=react')
    for (const [engine, url] of [
      ['duckduckgo', 'https://duckduckgo.com/ac/?type=list&q=a%20b'],
      ['bing', 'https://api.bing.com/osjson.aspx?query=a%20b'],
      ['ecosia', 'https://ac.ecosia.org/autocomplete?type=list&q=a%20b'],
      ['brave', 'https://search.brave.com/api/suggest?q=a%20b']
    ] as const) {
      await s.get(engine, 'a b')
      expect(fetcher.mock.calls.at(-1)![0]).toBe(url)
    }
    expect(await s.get('kagi', 'react')).toEqual([]) // no endpoint without a session
    expect(await s.get('google', 'https://a.dev/')).toEqual([])

    fetcher.mockResolvedValueOnce(answer([], false))
    expect(await s.get('google', 'bad status')).toEqual([])
    fetcher.mockRejectedValueOnce(new Error('offline'))
    expect(await s.get('google', 'offline')).toEqual([])

    // the cache keeps the newest 64
    for (let i = 0; i < 70; i += 1) await s.get('bing', `q${i}`)
    const before = fetcher.mock.calls.length
    await s.get('bing', 'q0')
    expect(fetcher.mock.calls.length).toBe(before + 1)
  })

  it('abort the question before when the next keystroke comes, and time out slow answers', async () => {
    vi.useFakeTimers()
    try {
      const signals: AbortSignal[] = []
      const s = new SearchSuggestions(
        (_url, init) =>
          new Promise((_, reject) => {
            signals.push(init.signal)
            init.signal.addEventListener('abort', () => reject(new Error('aborted')))
          })
      )
      const first = s.get('google', 'rea')
      const second = s.get('google', 'reac')
      expect(signals[0].aborted).toBe(true)
      await expect(first).resolves.toEqual([])
      vi.advanceTimersByTime(1500)
      await expect(second).resolves.toEqual([])
      expect(signals[1].aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('use the global fetch by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(['x', ['xy']])))
    expect(await new SearchSuggestions().get('google', 'x')).toEqual(['xy'])
    expect(spy).toHaveBeenCalled()
  })
})

describe('the library types', () => {
  it('name the internal pages, the roots and the browsers', () => {
    expect(BOOKMARK_ROOTS).toEqual(['bar', 'other'])
    expect(isFolder({ id: 'f', title: '', children: [], added: 0 })).toBe(true)
    expect(isFolder({ id: 'b', title: '', url: 'https://a.dev/', added: 0 })).toBe(false)
    expect(internalPage(INTERNAL_PAGES.history)).toBe('history')
    expect(internalPage(' MINDECK://Bookmarks/ ')).toBe('bookmarks')
    expect(internalPage('mindeck://settings')).toBeUndefined()
    expect(internalPage('https://history.dev/')).toBeUndefined()
    expect(IMPORT_BROWSERS.every((b) => BROWSER_NAMES[b])).toBe(true)
    expect([labels('de').importedFrom('Arc'), labels('en').importedFrom('Arc')]).toEqual(['Importiert aus Arc', 'Imported from Arc'])
  })
})
