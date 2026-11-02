import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { onCleanup, tempDir, tick } from './helpers'
import { BrowserBookmarks } from '../../../electron/main/services/browser/bookmarks'
import { parseNetscape, toNetscape } from '../../../electron/main/services/browser/netscape'
import { isFolder, type BookmarkFolder, type BookmarkNode } from '@shared/types/browserData'

async function setup(content?: string) {
  const dir = await tempDir()
  const file = join(dir, 'bookmarks.json')
  if (content !== undefined) await writeFile(file, content)
  const onChange = vi.fn()
  let now = 1000
  const b = new BrowserBookmarks(file, onChange, () => now)
  await b.load()
  onCleanup(() => b.flush())
  return { b, dir, file, onChange, setNow: (n: number) => (now = n) }
}

const titles = (nodes: BookmarkNode[]): unknown[] => nodes.map((n) => (isFolder(n) ? { [n.title]: titles(n.children) } : n.title))
const link = (title: string, url: string): BookmarkNode => ({ id: '', title, url, added: 5 })
const folder = (title: string, children: BookmarkNode[]): BookmarkNode => ({ id: '', title, children, added: 5 })

describe('bookmarks', () => {
  it('start empty with the bar and Other bookmarks, and save atomically a moment after a change', async () => {
    const { b, file, onChange } = await setup()
    expect(b.tree()).toEqual([
      { id: 'bar', title: '', children: [], added: 0 },
      { id: 'other', title: '', children: [], added: 0 }
    ])
    const docs = b.add({ title: 'Docs', url: ' https://docs.dev/ ' })
    expect(docs).toMatchObject({ title: 'Docs', url: 'https://docs.dev/', added: 1000 })
    expect(onChange).toHaveBeenCalledTimes(1)
    const work = b.add({ parentId: 'other', title: 'Work' })
    expect(work).toMatchObject({ title: 'Work', children: [] })
    b.add({ parentId: work.id, title: 'Board', url: 'https://board.dev/' })
    b.add({ title: 'First', url: 'https://first.dev/', index: 0 })
    b.add({ title: 'x'.repeat(600), url: 'https://long.dev/', index: 99 })
    expect(titles(b.tree()[0].children)).toEqual(['First', 'Docs', 'x'.repeat(500)])
    await tick(450)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    expect(saved.version).toBe(1)
    expect(titles(saved.roots.other.children)).toEqual([{ Work: ['Board'] }])
    // the tree handed out is a copy
    b.tree()[0].children.length = 0
    expect(b.tree()[0].children).toHaveLength(3)
  })

  it('find, rename, re-address, move and remove — never the two root folders', async () => {
    const { b } = await setup()
    const a = b.add({ title: 'A', url: 'https://a.dev/' })
    const f = b.add({ title: 'F' })
    const inner = b.add({ parentId: f.id, title: 'Inner' })
    expect(b.find('https://a.dev/')).toMatchObject({ id: a.id, title: 'A' })
    expect(b.find('https://none.dev/')).toBeUndefined()

    b.update(a.id, { title: 'Alpha', url: 'https://alpha.dev/' })
    b.update(f.id, { url: 'https://ignored.dev/' }) // a folder has no address
    b.update(f.id, { title: 'Folder' })
    expect(b.find('https://alpha.dev/')).toMatchObject({ title: 'Alpha' })
    expect(() => b.update(a.id, { url: 'javascript:alert(1)' })).toThrow(expect.objectContaining({ code: 'bad-url' }))
    expect(() => b.update('bar', { title: 'x' })).toThrow(expect.objectContaining({ code: 'bad-target' }))
    expect(() => b.update('gone', { title: 'x' })).toThrow(expect.objectContaining({ code: 'not-found' }))
    expect(() => b.add({ title: 'bad', url: '   ' })).toThrow(expect.objectContaining({ code: 'bad-url' }))
    expect(() => b.add({ parentId: a.id, title: 'into a link' })).toThrow(expect.objectContaining({ code: 'not-found' }))

    // reorder within a folder (down and up), into another, never into itself
    const c = b.add({ title: 'C', url: 'https://c.dev/' })
    expect(titles(b.tree()[0].children)).toEqual(['Alpha', { Folder: [{ Inner: [] }] }, 'C'])
    b.move(a.id, 'bar', 3)
    expect(titles(b.tree()[0].children)).toEqual([{ Folder: [{ Inner: [] }] }, 'C', 'Alpha'])
    b.move(a.id, 'bar', 0)
    expect(titles(b.tree()[0].children)).toEqual(['Alpha', { Folder: [{ Inner: [] }] }, 'C'])
    b.move(c.id, inner.id, 0)
    b.move(a.id, 'other', 0)
    expect(titles(b.tree()[1].children)).toEqual(['Alpha'])
    expect(() => b.move(f.id, inner.id, 0)).toThrow(expect.objectContaining({ code: 'bad-move' }))
    expect(() => b.move(f.id, f.id, 0)).toThrow(expect.objectContaining({ code: 'bad-move' }))
    const deeper = b.add({ parentId: inner.id, title: 'Deeper' })
    expect(() => b.move(f.id, deeper.id, 0)).toThrow(expect.objectContaining({ code: 'bad-move' }))
    expect(() => b.move('other', 'bar', 0)).toThrow(expect.objectContaining({ code: 'bad-target' }))

    expect(b.remove(['bar', 'gone'])).toBe(0)
    expect(b.remove([f.id, a.id])).toBe(2)
    expect(b.tree().map((r) => r.children)).toEqual([[], []])
  })

  it('suggest addresses that start with the text first, then titles and addresses that hold it', async () => {
    const { b } = await setup()
    b.add({ title: 'Git docs', url: 'https://docs.dev/git' })
    b.add({ title: 'Hub', url: 'https://www.github.com/' })
    const f = b.add({ title: 'F' })
    b.add({ parentId: f.id, title: 'Gitlab', url: 'https://gitlab.com/' })
    b.add({ title: 'Unrelated', url: 'https://other.dev/' })
    expect(b.suggest('  ')).toEqual([])
    expect(b.suggest('git').map((x) => x.title)).toEqual(['Hub', 'Gitlab', 'Git docs'])
    expect(b.suggest('GIT', 1).map((x) => x.title)).toEqual(['Hub'])
  })

  it('merge imports without duplicates: the bar while empty, else into a named folder', async () => {
    const { b, onChange, setNow } = await setup()
    const chrome = { bar: [link('A', 'https://a.dev/'), folder('Dev', [link('MDN', 'https://mdn.dev/'), folder('Empty', [])])], other: [link('O', 'https://o.dev/')] }
    expect(b.merge(chrome, 'From Chrome')).toBe(3)
    expect(titles(b.tree()[0].children)).toEqual(['A', { Dev: ['MDN'] }])
    expect(titles(b.tree()[1].children)).toEqual([{ 'From Chrome': ['O'] }])
    // again: nothing new, nothing changes
    onChange.mockClear()
    expect(b.merge(chrome, 'From Chrome')).toBe(0)
    expect(onChange).not.toHaveBeenCalled()
    expect(titles(b.tree()[1].children)).toEqual([{ 'From Chrome': ['O'] }])
    // a second browser: the bar is taken, so its bar goes into a folder; same addresses are skipped
    setNow(2000)
    expect(b.merge({ bar: [link('B', 'https://b.dev/'), link('A again', 'https://a.dev/')], other: [] }, 'From Firefox')).toBe(1)
    expect(titles(b.tree()[0].children)).toEqual(['A', { Dev: ['MDN'] }, { 'From Firefox': ['B'] }])
    expect(b.merge({ bar: [], other: [] }, 'Nothing')).toBe(0)
    // junk from an import is dropped
    expect(b.merge({ bar: [{ id: '', title: 'no url', url: '', added: 1 } as BookmarkNode, null as unknown as BookmarkNode], other: [] }, 'Junk')).toBe(0)
  })

  it('load a saved file, keep what fits, and set a broken file aside', async () => {
    const good = await setup(
      JSON.stringify({
        roots: {
          bar: { children: [{ id: 'k', title: 'Kept', url: 'https://k.dev/', added: 7 }, { title: 5, url: 'https://untitled.dev/' }, { url: 'x'.repeat(9000) }, 'junk', { title: 'F', children: [] }] },
          other: { title: 'not a folder', url: 'https://x.dev/' }
        }
      })
    )
    const [bar, other] = good.b.tree()
    expect(bar.children[0]).toEqual({ id: 'k', title: 'Kept', url: 'https://k.dev/', added: 7 })
    expect(bar.children[1]).toMatchObject({ title: '', url: 'https://untitled.dev/', added: 1000 })
    expect(bar.children[2]).toMatchObject({ title: 'F', children: [] })
    expect(bar.children).toHaveLength(3)
    expect(other.children).toEqual([])

    const noRoots = await setup('{}')
    expect(noRoots.b.tree()[0].children).toEqual([])

    expect((await setup('null')).b.tree()[0].children).toEqual([])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = await setup('{ not json')
    expect(broken.b.tree()[0].children).toEqual([])
    expect((await readdir(broken.dir)).some((f) => f.startsWith('bookmarks.corrupt-'))).toBe(true)
  })

  it('stop at the limit, and log a save that fails', async () => {
    const { b } = await setup()
    const many = Array.from({ length: 50_010 }, (_, i) => link(`L${i}`, `https://l${i}.dev/`))
    expect(b.merge({ bar: many, other: [] }, 'Many')).toBe(50_000)
    expect(() => b.add({ title: 'one more', url: 'https://more.dev/' })).toThrow(expect.objectContaining({ code: 'too-many' }))

    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = await tempDir()
    await mkdir(join(dir, 'bookmarks.json'))
    const blocked = new BrowserBookmarks(join(dir, 'bookmarks.json'))
    blocked.add({ title: 'A', url: 'https://a.dev/' })
    await blocked.flush()
    await blocked.flush() // nothing left to write
    expect(err).toHaveBeenCalledWith('[browser] saving bookmarks failed', expect.anything())
  })
})

describe('Netscape bookmark files', () => {
  it('read what browsers export: the toolbar folder is the bar, the rest goes to Other bookmarks', () => {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3 ADD_DATE="1700000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
  <DL><p>
    <DT><A HREF="https://a.dev/?x=1&amp;y=2" ADD_DATE="1700000001">A &amp; B &#8211; &#x263A; &bogus; &#0;</A>
    <DT><A HREF='javascript:alert(1)'>Bookmarklet</A>
    <DT><A>No address</A>
    <DT><H3>Sub</H3>
    <DL><p>
      <DT><A HREF=https://sub.dev/ ADD_DATE="nope"></A>
    </DL><p>
  </DL><p>
  <DT><A HREF="file:///Users/me/notes.html">Notes</A>
  <DT><H3>Lonely</H3>
  </DL><p>
</DL><p>
<DT><A HREF="https://unclosed.dev/">Unclosed <b>bold</b>`
    const set = parseNetscape(html, 42)
    expect(set.bar).toEqual([
      { id: '', title: 'A & B – ☺ &bogus; &#0;', url: 'https://a.dev/?x=1&y=2', added: 1_700_000_001_000 },
      { id: '', title: 'Sub', added: 42, children: [{ id: '', title: 'https://sub.dev/', url: 'https://sub.dev/', added: 42 }] }
    ])
    expect(set.other).toEqual([
      { id: '', title: 'Notes', url: 'file:///Users/me/notes.html', added: 42 },
      { id: '', title: 'Lonely', children: [], added: 42 },
      { id: '', title: 'Unclosed', url: 'https://unclosed.dev/', added: 42 }
    ])
    // a text that never closes runs to the end
    expect(parseNetscape('<DT><A HREF="https://end.dev/">End').other).toEqual([expect.objectContaining({ title: 'End' })])
  })

  it('find a toolbar folder nested deeper, and take only the first one', () => {
    const html = `<DL><p><DT><A HREF="https://top.dev/">Top</A><DT><H3>Menu</H3><DL><p>
      <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Toolbar</H3><DL><p><DT><A HREF="https://t.dev/">T</A></DL><p>
      <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Second</H3><DL><p><DT><A HREF="https://s.dev/">S</A></DL><p>
    </DL><p></DL><p>`
    const set = parseNetscape(html)
    expect(set.bar.map((n) => n.title)).toEqual(['T'])
    expect(titles(set.other)).toEqual(['Top', { Menu: [{ Second: ['S'] }] }])
  })

  it('write a file every browser reads — and read it back the same', () => {
    const bar: BookmarkFolder = { id: 'bar', title: '', added: 1_700_000_000_000, children: [link('A "quoted" <tag>', 'https://a.dev/?q=1&r=2'), folder('Dev', [link('MDN', 'https://mdn.dev/')])] }
    const other: BookmarkFolder = { id: 'other', title: '', added: 0, children: [link('O', 'https://o.dev/')] }
    const html = toNetscape({ bar, other }, 'Bookmarks bar')
    expect(html).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>')
    expect(html).toContain('<DT><H3 ADD_DATE="1700000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>')
    expect(html).toContain('<DT><A HREF="https://a.dev/?q=1&amp;r=2" ADD_DATE="0">A &quot;quoted&quot; &lt;tag&gt;</A>')
    const back = parseNetscape(html, 1)
    expect(titles(back.bar)).toEqual(['A "quoted" <tag>', { Dev: ['MDN'] }])
    expect(back.bar[0]).toMatchObject({ url: 'https://a.dev/?q=1&r=2' })
    expect(titles(back.other)).toEqual(['O'])
  })
})
