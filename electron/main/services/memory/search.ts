import type { NotePath, SearchHit } from '@shared/types/memory'

/**
 * Full-text search over the vault's notes: words (accents and case folded,
 * every query word also matches as a prefix — "proj" finds "Projekte"),
 * ranked with BM25 plus a boost for titles and tags, and a snippet around
 * the best stretch of the note with the matches marked. Obsidian's operators
 * work too: "exact phrase", -exclude, tag:#idee (or just #idee), path:Projekte.
 * Pure and in memory — rebuilt from the files like the rest of MemoryIndex.
 */

const K1 = 1.2
const B = 0.75
/** A prefix ("proj" → "projekte") counts less than the whole word. */
const PREFIX_WEIGHT = 0.5
const MAX_EXPANSIONS = 64
const TITLE_BOOST = 4
const EXACT_TITLE_BOOST = 12
const TAG_BOOST = 2
const SNIPPET = 180
const LEAD = 50

const WORD = /[\p{L}\p{N}_]+/gu
const WORD_CHAR = /[\p{L}\p{N}_]/u

/** Lower case without accents, as long as the input — so positions carry over. */
export function fold(text: string): string {
  const whole = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  if (whole.length === text.length) return whole
  // Rare: decomposed input or letters whose lower case is longer — fold one by one.
  let out = ''
  for (const c of text) {
    const f = c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    out += f.length === c.length ? f : c
  }
  return out
}

/** The words of a (folded) text. */
export function words(folded: string): string[] {
  return folded.match(WORD) ?? []
}

export interface ParsedQuery {
  /** Every word must match (in the text, the title, a tag or the path). */
  terms: string[]
  /** "quoted" stretches the note must contain as written (folded). */
  phrases: string[]
  /** -word: notes with it are left out. */
  exclude: string[]
  /** tag:x / #x: notes must carry the tag (or one below it: #projekt/mindeck). */
  tags: string[]
  /** path:x / file:x: the note's path must contain it. */
  paths: string[]
}

export function parseQuery(query: string): ParsedQuery {
  const q: ParsedQuery = { terms: [], phrases: [], exclude: [], tags: [], paths: [] }
  for (const m of query.matchAll(/(-?)"([^"]*)"?|(\S+)/g)) {
    if (m[2] !== undefined) {
      const phrase = fold(m[2]).replace(/\s+/g, ' ').trim()
      if (!phrase) continue
      if (m[1]) q.exclude.push(...words(phrase))
      else {
        q.phrases.push(phrase)
        q.terms.push(...words(phrase))
      }
      continue
    }
    const token = m[3]
    const op = /^(tag|path|file):(.*)$/i.exec(token)
    if (op) {
      const value = op[2].replace(/^#/, '')
      if (!value) continue
      if (op[1].toLowerCase() === 'tag') q.tags.push(value.toLowerCase())
      else q.paths.push(fold(value))
    } else if (/^#[\p{L}\p{N}_\-/]+$/u.test(token)) {
      q.tags.push(token.slice(1).toLowerCase())
    } else if (token.startsWith('-') && token.length > 1) {
      q.exclude.push(...words(fold(token.slice(1))))
    } else {
      q.terms.push(...words(fold(token)))
    }
  }
  return q
}

interface Doc {
  path: NotePath
  title: string
  body: string
  tags: string[]
  /** Folded copies, for matching and positions. */
  foldedBody: string
  foldedTitle: string
  foldedPath: string
  /** Word → count in the body. */
  tf: Map<string, number>
  titleWords: string[]
  length: number
}

export interface Searchable {
  path: NotePath
  title: string
  body: string
  tags: string[]
}

/** The inverted bookkeeping BM25 needs, kept up to date per note (no rebuild per change). */
export class SearchIndex {
  private docs = new Map<NotePath, Doc>()
  /** Word → in how many notes. */
  private df = new Map<string, number>()
  private totalLength = 0

  clear(): void {
    this.docs.clear()
    this.df.clear()
    this.totalLength = 0
  }

  set(note: Searchable): void {
    this.remove(note.path)
    const foldedBody = fold(note.body)
    const tf = new Map<string, number>()
    let length = 0
    for (const w of words(foldedBody)) {
      tf.set(w, (tf.get(w) ?? 0) + 1)
      length += 1
    }
    const foldedTitle = fold(note.title)
    const doc: Doc = {
      ...note,
      foldedBody,
      foldedTitle,
      foldedPath: fold(note.path),
      tf,
      titleWords: words(foldedTitle),
      length
    }
    this.docs.set(note.path, doc)
    for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1)
    this.totalLength += length
  }

  remove(path: NotePath): void {
    const doc = this.docs.get(path)
    if (!doc) return
    this.docs.delete(path)
    for (const w of doc.tf.keys()) {
      const n = this.df.get(w)! - 1
      if (n) this.df.set(w, n)
      else this.df.delete(w)
    }
    this.totalLength -= doc.length
  }

  search(query: string, limit = 50): SearchHit[] {
    const q = parseQuery(query)
    if (!q.terms.length && !q.tags.length && !q.paths.length && !q.phrases.length) return []
    const n = this.docs.size
    const avg = n ? this.totalLength / n : 0
    // Each query word with the vocabulary words it stands for (itself, or longer ones it starts).
    // A short prefix stands for many words: the most common ones are enough to rank.
    const expansions = q.terms.map((t) => {
      const out: [string, number][] = []
      for (const w of this.df.keys()) if (w.startsWith(t)) out.push([w, w === t ? 1 : PREFIX_WEIGHT])
      return out.sort((a, b) => b[1] - a[1] || this.df.get(b[0])! - this.df.get(a[0])!).slice(0, MAX_EXPANSIONS)
    })
    const idf = (w: string) => {
      const df = this.df.get(w)!
      return Math.log(1 + (n - df + 0.5) / (df + 0.5))
    }
    const whole = q.terms.join(' ')

    const hits: (SearchHit & { score: number })[] = []
    for (const doc of this.docs.values()) {
      if (q.paths.some((p) => !doc.foldedPath.includes(p))) continue
      if (q.tags.some((t) => !doc.tags.some((tag) => tag === t || tag.startsWith(`${t}/`)))) continue
      if (q.phrases.some((p) => !doc.foldedBody.replace(/\s+/g, ' ').includes(p) && !doc.foldedTitle.includes(p))) continue
      if (q.exclude.some((x) => doc.tf.has(x) || doc.titleWords.includes(x))) continue

      let score = 0
      let all = true
      q.terms.forEach((t, i) => {
        // The best word the query word stands for counts — many "proj…" words don't add up.
        let best = 0
        for (const [w, weight] of expansions[i]) {
          const f = doc.tf.get(w)
          if (f) best = Math.max(best, weight * idf(w) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / avg))))
        }
        let found = best > 0
        score += best
        if (doc.titleWords.some((w) => w.startsWith(t))) {
          found = true
          score += TITLE_BOOST
        }
        if (doc.tags.some((tag) => fold(tag).split('/').some((part) => part.startsWith(t)))) {
          found = true
          score += TAG_BOOST
        }
        if (!found && !doc.foldedPath.includes(t)) all = false
      })
      if (!all) continue
      if (whole && doc.foldedTitle === whole) score += EXACT_TITLE_BOOST

      hits.push({ path: doc.path, title: doc.title, ...snippetOf(doc, q), titleMatches: rangesIn(doc.foldedTitle, q), score })
    }
    return hits
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.path.localeCompare(b.path))
      .slice(0, limit)
      .map(({ score: _score, ...hit }) => hit)
  }
}

/** Where the query's words (as word starts) and phrases occur in a folded text — sorted, merged. */
export function rangesIn(folded: string, q: Pick<ParsedQuery, 'terms' | 'phrases'>): [number, number][] {
  const found: [number, number][] = []
  for (const t of new Set(q.terms)) {
    let at = folded.indexOf(t)
    while (at !== -1) {
      if (at === 0 || !WORD_CHAR.test(folded[at - 1])) {
        // Mark the whole word ("Projekte" for "proj").
        let end = at + t.length
        while (end < folded.length && WORD_CHAR.test(folded[end])) end += 1
        found.push([at, end])
      }
      at = folded.indexOf(t, at + t.length)
    }
  }
  for (const p of q.phrases) {
    for (let at = folded.indexOf(p); at !== -1; at = folded.indexOf(p, at + p.length)) found.push([at, at + p.length])
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const merged: [number, number][] = []
  for (const r of found) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  return merged
}

/** The stretch of the body with the most different query words, whitespace collapsed, matches marked. */
function snippetOf(doc: Doc, q: ParsedQuery): { snippet: string; matches: [number, number][] } {
  const ranges = rangesIn(doc.foldedBody, q)
  let start = 0
  if (ranges.length) {
    let best = -1
    for (const [from] of ranges) {
      const inside = ranges.filter(([a, b]) => a >= from && b <= from + SNIPPET)
      const distinct = new Set(inside.map(([a, b]) => doc.foldedBody.slice(a, b))).size
      const score = distinct * 1000 + inside.length
      if (score > best) {
        best = score
        start = from
      }
    }
    start = Math.max(0, start - LEAD)
    // Begin at a word, not in the middle of one.
    while (start > 0 && WORD_CHAR.test(doc.body[start - 1])) start -= 1
  }
  const end = Math.min(doc.body.length, start + SNIPPET)
  // Collapse whitespace while carrying the match positions along.
  let snippet = start > 0 ? '…' : ''
  const map = new Map<number, number>()
  for (let i = start; i < end; i += 1) {
    map.set(i, snippet.length)
    const c = doc.body[i]
    if (/\s/.test(c)) {
      if (!snippet.endsWith(' ') && snippet !== '…' && snippet !== '') snippet += ' '
    } else snippet += c
  }
  map.set(end, snippet.length)
  const trimmed = snippet.trimEnd()
  const matches = ranges
    .filter(([a, b]) => a >= start && b <= end)
    .map(([a, b]): [number, number] => [map.get(a)!, Math.min(map.get(b)!, trimmed.length)])
  return { snippet: end < doc.body.length ? `${trimmed}…` : trimmed, matches }
}
