import { describe, expect, it } from 'vitest'
import {
  frontmatterBlock,
  linkKey,
  parseNote,
  sanitizeTitle,
  splitFrontmatter
} from '../../../electron/main/services/memory/parse'
import { appendLink, removeLinks, rewriteLinks } from '../../../electron/main/services/memory/linkEdit'
import { MemoryIndex } from '../../../electron/main/services/memory/MemoryIndex'
import { FOLDER_TYPES, frontmatter, starterNotes } from '../../../electron/main/services/memory/starterVault'

describe('parse', () => {
  it('splits frontmatter (object YAML only) and keeps the raw block', () => {
    expect(splitFrontmatter('no frontmatter')).toEqual({ frontmatter: {}, body: 'no frontmatter' })
    expect(splitFrontmatter('---\ntitle: x\n---\nbody')).toEqual({ frontmatter: { title: 'x' }, body: 'body' })
    expect(splitFrontmatter('---\n- a list\n---\nb').frontmatter).toEqual({})
    expect(splitFrontmatter('---\n: : bad\n  - [\n---\nb')).toEqual({ frontmatter: {}, body: 'b' })
    expect(splitFrontmatter('---\n---\nempty').body).toBe('empty')
    expect(frontmatterBlock('---\na: 1\n---\nbody')).toBe('---\na: 1\n---\n')
    expect(frontmatterBlock('plain')).toBe('')
  })

  it('collects wikilinks, md links and tags, ignoring code and external URLs', () => {
    const note = parseNote(
      [
        '---',
        'tags: [Alpha, "#beta", 7, {x: 1}]',
        'tag: Gamma delta',
        '---',
        'See [[Target#Head|alias]] ![[Embed]] [[ ]] [doc](Folder/Doc%20One.md#x) [web](https://x.md) [bad](%E0%A4%A.md) ![[bild.PNG]] [[plan.pdf]] [[v1.2 Plan]]',
        '`[[InlineCode]]` #inline-tag #123 # heading (#paren)',
        '```',
        '[[InFence]] #fenced',
        '```'
      ].join('\n')
    )
    // Attachments are embedded or linked files, not notes — no links, no ghost nodes.
    expect(note.links).toEqual(['Target', 'Embed', 'v1.2 Plan', 'Folder/Doc One.md', '%E0%A4%A.md'])
    expect(note.tags).toEqual(['7', 'alpha', 'beta', 'delta', 'gamma', 'inline-tag', 'paren'])
  })

  it('handles notes without tags', () => {
    expect(parseNote('just text').tags).toEqual([])
    expect(parseNote('---\ntags: ""\n---\n').tags).toEqual([])
  })

  it('linkKey and sanitizeTitle', () => {
    expect(linkKey(' ./Folder\\Note.MD ')).toBe('folder/note')
    expect(sanitizeTitle('  a/b:c*?"<>|#^[x]  ')).toBe('a b c x')
    expect(sanitizeTitle('...')).toBe('Untitled')
    expect(sanitizeTitle('x'.repeat(200))).toHaveLength(120)
  })
})

describe('linkEdit', () => {
  it('rewriteLinks: wikilinks (anchor/alias kept), md links, null = untouched, code skipped', () => {
    const raw = 'A [[Old#h|al]] [[Keep]] [m](Old.md) [n](%E0%A4%A.md) `[[Old]]`\n```\n[[Old]]\n```\n'
    const out = rewriteLinks(raw, (t) => (t === 'Old' ? 'New' : t === 'Old.md' ? 'Sub/New' : null))
    expect(out).toBe('A [[New#h|al]] [[Keep]] [m](Sub/New.md) [n](%E0%A4%A.md) `[[Old]]`\n```\n[[Old]]\n```\n')
  })

  it('removeLinks: whole link-only lines, inline → text (alias / anchor label), md links, section cleanup', () => {
    const raw = [
      'Intro [[X]] and [[X|the x]] and [[X#Part]] and [doc](X.md) and [other](Y.md) and [[Y]].',
      '- [[X]]',
      '* [x](X.md)',
      '- [[Y]]',
      '',
      '## Verbindungen',
      '- [[X]]',
      ''
    ].join('\n')
    const out = removeLinks(raw, (t) => t === 'X' || t === 'X.md')
    expect(out).toBe('Intro X and the x and X › Part and doc and [other](Y.md) and [[Y]].\n- [[Y]]\n')
  })

  it('removeLinks keeps link-only lines whose target cannot be read', () => {
    const raw = '- [[#Section]]\n- [x](a>b.md)\n'
    expect(removeLinks(raw, (t) => t === '')).toBe('')
    expect(removeLinks(raw, () => false)).toBe(raw)
  })

  it('removeLinks keeps a non-empty Verbindungen section and leaves code alone', () => {
    const raw = 'Text\n\n## Verbindungen\n- [[A]]\n- [[B]]\n\n## Next\n`[[A]]`'
    expect(removeLinks(raw, (t) => t === 'A')).toBe('Text\n\n## Verbindungen\n- [[B]]\n\n## Next\n`[[A]]`')
  })

  it('appendLink: new section, empty body, existing section before another heading or at the end', () => {
    expect(appendLink('Hi\n', 'T')).toBe('Hi\n\n## Verbindungen\n- [[T]]\n')
    expect(appendLink('', 'T')).toBe('## Verbindungen\n- [[T]]\n')
    expect(appendLink('A\n\n## Verbindungen\n- [[X]]\n\n## Notes\nB\n', 'Y')).toBe('A\n\n## Verbindungen\n- [[X]]\n- [[Y]]\n\n## Notes\nB\n')
    expect(appendLink('A\n\n## Verbindungen\n- [[X]]\n', 'Y')).toBe('A\n\n## Verbindungen\n- [[X]]\n- [[Y]]\n')
  })
})

describe('MemoryIndex', () => {
  const idx = () => {
    const i = new MemoryIndex()
    const d = new Date('2026-10-01T00:00:00Z')
    i.upsert('Home.md', '---\ntype: knowledge\n---\nSee [[A]], [[Sub/B]], [[a]], [[Ghost]], [[Folder/Ghost Two.md]], [[.md]]', d)
    i.upsert('A.md', 'Back to [[Home]] and [[A]] (self)', d)
    i.upsert('Sub/B.md', 'search me: needle in the middle of a much longer text that goes on and on', d)
    i.upsert('Other/B.md', 'needle in title? no', d)
    return i
  }

  it('lists metadata with folders, types, tags and link counts', () => {
    const i = idx()
    expect(i.size).toBe(4)
    expect(i.has('A.md')).toBe(true)
    expect(i.rawOf('A.md')).toContain('Back')
    expect(i.rawOf('nope.md')).toBeUndefined()
    const home = i.list().find((n) => n.path === 'Home.md')!
    expect(home).toMatchObject({ title: 'Home', folder: '', type: 'knowledge', linkCount: 2, modifiedAt: '2026-10-01T00:00:00.000Z' })
    expect(i.list().find((n) => n.path === 'A.md')!.type).toBeUndefined()
    expect(i.list().map((n) => n.path)).toEqual(['A.md', 'Home.md', 'Other/B.md', 'Sub/B.md'])
  })

  it('resolves by name (shortest path wins) and by path suffix; empty keys never resolve', () => {
    const i = idx()
    expect(i.resolve('a')).toBe('A.md')
    expect(i.resolve('B')).toBe('Sub/B.md') // shortest path wins
    const tie = new MemoryIndex()
    tie.upsert('Bbb/N.md', '', new Date())
    tie.upsert('Aaa/N.md', '', new Date())
    expect(tie.resolve('N')).toBe('Aaa/N.md') // same length → alphabetical
    expect(i.resolve('Sub/B')).toBe('Sub/B.md')
    expect(i.resolve('sub/b.md')).toBe('Sub/B.md')
    expect(i.resolve('Nope/B')).toBeUndefined()
    expect(i.resolve('.md')).toBeUndefined()
    expect(i.resolve('missing')).toBeUndefined()
  })

  it('get(): backlinks and resolved link map; unknown → undefined', () => {
    const i = idx()
    const a = i.get('A.md')!
    expect(a.backlinks.map((b) => b.path)).toEqual(['Home.md'])
    expect(i.get('Home.md')!.resolved).toEqual({
      A: 'A.md',
      'Sub/B': 'Sub/B.md',
      a: 'A.md',
      Ghost: null,
      'Folder/Ghost Two.md': null,
      '.md': null
    })
    expect(i.get('Sub/B.md')!.backlinks.map((b) => b.title)).toEqual(['Home'])
    expect(i.get('Other/B.md')!.backlinks).toEqual([])
    expect(i.get('missing.md')).toBeUndefined()
  })

  it('graph(): dedupes edges, adds one ghost per unresolved target', () => {
    const g = idx().graph()
    expect(g.edges).toHaveLength(5)
    const ghosts = g.nodes.filter((n) => n.ghost)
    expect(ghosts.map((n) => n.title).sort()).toEqual(['', 'Ghost', 'Ghost Two'])
    expect(g.nodes.find((n) => n.id === 'Home.md')!.degree).toBe(5)
  })

  it('search(): ranked full text with snippets and match ranges; filters; limit, empty query', () => {
    const i = idx()
    expect(i.search('   ')).toEqual([])
    const hits = i.search('needle')
    expect(hits.map((h) => h.path)).toEqual(['Other/B.md', 'Sub/B.md']) // the shorter note ranks higher
    expect(hits[0].snippet.startsWith('needle')).toBe(true)
    expect(hits[0].matches).toEqual([[0, 6]])
    i.upsert('Long.md', `${'x '.repeat(60)} needle at the end`, new Date())
    expect(i.search('needle').find((h) => h.path === 'Long.md')!.snippet.startsWith('…')).toBe(true)
    expect(i.search('home')[0]).toMatchObject({ path: 'Home.md', snippet: expect.stringContaining('See'), titleMatches: [[0, 4]] })
    expect(i.search('needle path:sub').map((h) => h.path)).toEqual(['Sub/B.md'])
    expect(i.search('b', 1)).toHaveLength(1)
    // Removed notes (one, or a whole folder) leave the search too.
    i.remove('Sub')
    expect(i.search('needle').map((h) => h.path)).toEqual(['Other/B.md', 'Long.md'])
    i.clear()
    expect(i.search('needle')).toEqual([])
  })

  it('remove(): single notes and whole folder prefixes; clear()', () => {
    const i = idx()
    expect(i.remove('Sub')).toBe(true)
    expect(i.has('Sub/B.md')).toBe(false)
    expect(i.remove('Other/')).toBe(true)
    expect(i.remove('A.md')).toBe(true)
    expect(i.remove('A.md')).toBe(false)
    i.clear()
    expect(i.size).toBe(0)
  })
})

describe('starterVault', () => {
  it('builds frontmatter with id, optional type, created and tags', () => {
    const fm = frontmatter({ type: 'decision', tags: ['a', 'b'] }, new Date('2026-01-01T00:00:00Z'))
    expect(fm).toMatch(/^---\nid: [0-9a-f-]{36}\ntype: decision\ncreated: 2026-01-01T00:00:00.000Z\ntags: \[a, b\]\n---\n$/)
    expect(frontmatter({})).toMatch(/\ntags: \[\]\n---\n$/)
    expect(frontmatter({})).not.toContain('type:')
  })

  it('ships linked starter notes and folder types', () => {
    const notes = starterNotes()
    expect(notes.map((n) => n.path)).toContain('Willkommen.md')
    expect(notes.every((n) => n.content.startsWith('---\nid: '))).toBe(true)
    expect(FOLDER_TYPES).toMatchObject({ Ich: 'personal', Projekte: 'project' })
  })
})
