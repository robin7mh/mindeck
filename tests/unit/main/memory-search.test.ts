import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { fold, parseQuery, rangesIn, SearchIndex, words } from '../../../electron/main/services/memory/search'
import { fillTemplate, formatDate, localTime, noteFromTemplate, templateBody } from '../../../electron/main/services/memory/template'

describe('search · folding and words', () => {
  it('folds case and accents without changing the length', () => {
    expect(fold('Über Ärger')).toBe('uber arger')
    expect(fold('plain ASCII')).toBe('plain ascii')
    // Decomposed input (a + combining diaeresis) folds one character at a time.
    const decomposed = 'Käse'
    expect(fold(decomposed)).toBe('käse')
    expect(fold(decomposed)).toHaveLength(decomposed.length)
  })

  it('splits words on anything that is not a letter, digit or _', () => {
    expect(words('hello, wörld_2 — ok')).toEqual(['hello', 'wörld_2', 'ok'])
    expect(words('  ')).toEqual([])
  })
})

describe('search · query syntax', () => {
  it('reads words, phrases, exclusions, tags and paths', () => {
    expect(parseQuery('Mindeck "Electron Update" -Draft tag:#Idee #todo/heute path:Projekte file:plan -"old stuff"')).toEqual({
      terms: ['mindeck', 'electron', 'update'],
      phrases: ['electron update'],
      exclude: ['draft', 'old', 'stuff'],
      tags: ['idee', 'todo/heute'],
      paths: ['projekte', 'plan']
    })
  })

  it('ignores empty operators and phrases, and lone dashes', () => {
    expect(parseQuery('"" tag: path: - "  "')).toEqual({ terms: [], phrases: [], exclude: [], tags: [], paths: [] })
    expect(parseQuery('"unterminated phrase').phrases).toEqual(['unterminated phrase'])
  })
})

function index() {
  const i = new SearchIndex()
  i.set({ path: 'Projekte/Mindeck.md', title: 'Mindeck', body: 'Das Command Center. Electron Update geplant.\n\nMehr zu Projekten.', tags: ['projekt', 'app/desktop'] })
  i.set({ path: 'Ideen.md', title: 'Ideen', body: 'Mindeck könnte einen Browser haben. Mindeck Mindeck.', tags: ['idee'] })
  i.set({ path: 'Ziele/Ziel 2026.md', title: 'Ziel 2026', body: 'Gesund bleiben, Ärger vermeiden', tags: [] })
  i.set({ path: 'Leer.md', title: 'Leer', body: '', tags: [] })
  return i
}

describe('search · ranking', () => {
  it('finds nothing for an empty query or in an empty index', () => {
    expect(index().search('   ')).toEqual([])
    expect(new SearchIndex().search('mindeck')).toEqual([])
  })

  it('ranks an exact title above notes that only mention it, and marks the matches', () => {
    const hits = index().search('mindeck')
    expect(hits.map((h) => h.path)).toEqual(['Projekte/Mindeck.md', 'Ideen.md'])
    expect(hits[0].titleMatches).toEqual([[0, 7]])
    const ideas = hits[1]
    expect(ideas.matches!.map(([a, b]) => ideas.snippet.slice(a, b))).toEqual(['Mindeck', 'Mindeck', 'Mindeck'])
  })

  it('needs every word (anywhere: text, title, tag or path), matches prefixes and accents', () => {
    const i = index()
    expect(i.search('mindeck browser').map((h) => h.path)).toEqual(['Ideen.md'])
    expect(i.search('aerger')).toEqual([])
    expect(i.search('arger').map((h) => h.path)).toEqual(['Ziele/Ziel 2026.md'])
    expect(i.search('proj').map((h) => h.path)).toEqual(['Projekte/Mindeck.md']) // "Projekten" and the tag
    expect(i.search('ziele gesund').map((h) => h.path)).toEqual(['Ziele/Ziel 2026.md']) // "ziele" only in the path
    expect(i.search('desk').map((h) => h.path)).toEqual(['Projekte/Mindeck.md']) // a tag part
    expect(i.search('nirgends')).toEqual([])
  })

  it('filters by tag (and tags below it), path, phrase and exclusions', () => {
    const i = index()
    expect(i.search('tag:app').map((h) => h.path)).toEqual(['Projekte/Mindeck.md'])
    expect(i.search('#idee').map((h) => h.path)).toEqual(['Ideen.md'])
    expect(i.search('#ide')).toEqual([])
    expect(i.search('mindeck path:projekte').map((h) => h.path)).toEqual(['Projekte/Mindeck.md'])
    expect(i.search('"electron update"').map((h) => h.path)).toEqual(['Projekte/Mindeck.md'])
    expect(i.search('"update electron"')).toEqual([])
    expect(i.search('"ziel 2026"').map((h) => h.path)).toEqual(['Ziele/Ziel 2026.md']) // a phrase in the title
    expect(i.search('mindeck -browser').map((h) => h.path)).toEqual(['Projekte/Mindeck.md'])
    expect(i.search('mindeck -ideen').map((h) => h.path)).toEqual(['Projekte/Mindeck.md']) // excluded by title word
  })

  it('a filter alone lists matching notes with the start of the text', () => {
    const [hit] = index().search('path:leer')
    expect(hit).toMatchObject({ path: 'Leer.md', snippet: '', matches: [], titleMatches: [] })
  })

  it('keeps a stable order for equal scores and honours the limit', () => {
    const i = new SearchIndex()
    i.set({ path: 'b/X.md', title: 'X', body: 'same', tags: [] })
    i.set({ path: 'a/X.md', title: 'X', body: 'same', tags: [] })
    i.set({ path: 'W.md', title: 'W', body: 'same', tags: [] })
    expect(i.search('same').map((h) => h.path)).toEqual(['W.md', 'a/X.md', 'b/X.md'])
    expect(i.search('same', 1)).toHaveLength(1)
  })

  it('updates and forgets notes', () => {
    const i = index()
    i.set({ path: 'Ideen.md', title: 'Ideen', body: 'nichts mehr', tags: [] })
    expect(i.search('browser')).toEqual([])
    i.remove('Ideen.md')
    i.remove('missing.md')
    expect(i.search('nichts')).toEqual([])
    expect(i.search('mindeck').map((h) => h.path)).toEqual(['Projekte/Mindeck.md'])
    i.clear()
    expect(i.search('mindeck')).toEqual([])
  })

  it('keeps short prefixes cheap: only the most common words they start are used', () => {
    const i = new SearchIndex()
    i.set({ path: 'Many.md', title: 'Many', body: Array.from({ length: 100 }, (_, n) => `zz${n}`).join(' '), tags: [] })
    i.set({ path: 'Exact.md', title: 'Exact', body: 'zz', tags: [] })
    expect(i.search('zz').map((h) => h.path)).toEqual(['Exact.md', 'Many.md'])
  })
})

describe('search · snippets', () => {
  it('cuts around the best match at a word start, collapses whitespace and marks the cut', () => {
    const i = new SearchIndex()
    const body = `${'Vorwort '.repeat(20)}\n\n  das   Ziel ist klar ${'und so weiter '.repeat(30)}`
    i.set({ path: 'Long.md', title: 'Long', body, tags: [] })
    const [hit] = i.search('ziel')
    expect(hit.snippet.startsWith('…Vorwort')).toBe(true)
    expect(hit.snippet.endsWith('…')).toBe(true)
    expect(hit.snippet).toContain('das Ziel ist klar')
    expect(hit.matches!.map(([a, b]) => hit.snippet.slice(a, b))).toEqual(['Ziel'])
  })

  it('prefers the stretch with the most different words', () => {
    const i = new SearchIndex()
    const body = `alpha ${'x '.repeat(200)} alpha beta here`
    i.set({ path: 'N.md', title: 'N', body, tags: [] })
    const [hit] = i.search('alpha beta')
    expect(hit.snippet).toContain('alpha beta here')
    expect(hit.snippet.endsWith('…')).toBe(false)
  })

  it('starts at the top when the match is near it, without leading whitespace', () => {
    const i = new SearchIndex()
    i.set({ path: 'N.md', title: 'N', body: '\n  Hallo Welt', tags: [] })
    const [hit] = i.search('welt')
    expect(hit.snippet).toBe('Hallo Welt')
    expect(hit.matches).toEqual([[6, 10]])
  })

  it('finds word starts only, merges overlaps and marks phrases', () => {
    expect(rangesIn('abc xabc abcdef', { terms: ['abc'], phrases: [] })).toEqual([
      [0, 3],
      [9, 15]
    ])
    expect(rangesIn('mind mindeck', { terms: ['mind', 'mindeck'], phrases: ['mind mindeck'] })).toEqual([[0, 12]])
  })
})

describe('templates', () => {
  const now = new Date(2026, 9, 5, 7, 4, 9)

  it('reads the UI clock without a zone; anything else is now', () => {
    expect(localTime('2026-10-05T07:04:09')).toEqual(now)
    expect(localTime('2026-10-05')).toEqual(new Date(2026, 9, 5))
    expect(localTime('2026-10-05T07:04')).toEqual(new Date(2026, 9, 5, 7, 4))
    const before = Date.now()
    expect(localTime('soon').getTime()).toBeGreaterThanOrEqual(before)
    expect(localTime().getTime()).toBeGreaterThanOrEqual(before)
  })

  it('formats dates moment-style, with [literal] text', () => {
    expect(formatDate(now, 'YYYY-MM-DD HH:mm:ss')).toBe('2026-10-05 07:04:09')
    expect(formatDate(now, 'D.M.YY H [Uhr] [YYYY]')).toBe('5.10.26 7 Uhr YYYY')
  })

  it('fills {{title}}, {{date}}, {{time}} and custom formats', () => {
    expect(fillTemplate('# {{title}}\n{{date}} {{time}} {{ DATE:DD.MM.YYYY }} {{time:HH}} {{date:}} {{other}}', { title: 'Plan', now })).toBe(
      '# Plan\n2026-10-05 07:04 05.10.2026 07 2026-10-05 {{other}}'
    )
  })

  it('builds a note: Mindeck fields first, the template’s own frontmatter merged, the body filled', () => {
    const plain = noteFromTemplate('# {{title}}\n', { title: 'Plan', now, type: 'project' })
    const [, yaml, body] = /^---\n([\s\S]*?)---\n([\s\S]*)$/.exec(plain)!
    expect(parseYaml(yaml)).toMatchObject({ type: 'project', created: now.toISOString(), tags: [] })
    expect(parseYaml(yaml).id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body).toBe('# Plan\n')

    const own = noteFromTemplate('---\nid: fixed\ncreated: old\ntype: daily\ntags: [journal]\nmood: {{date:DD}}\n---\nHeute: {{date}}\n', { title: 'X', now })
    const fm = parseYaml(/^---\n([\s\S]*?)---\n/.exec(own)![1])
    expect(fm).toMatchObject({ type: 'daily', tags: ['journal'], mood: 5, created: now.toISOString() })
    expect(fm.id).not.toBe('fixed')
    expect(own.endsWith('---\nHeute: 2026-10-05\n')).toBe(true)
  })

  it('inserts only the filled body', () => {
    expect(templateBody('---\ntags: [x]\n---\n## {{title}} am {{date}}', { title: 'T', now })).toBe('## T am 2026-10-05')
  })
})
