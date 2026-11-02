import { afterEach, describe, expect, it, vi } from 'vitest'
import { installBridge, settle } from './bridge'
import { entryKind, baseName, fileHref, fileUrl, formatBytes, formatModified, thumbUrl } from '@/features/files/kinds'
import { extOf, fileType, type FinderEntry, type FinderListing } from '@shared/types/finder'

const entry = (path: string, extra: Partial<FinderEntry> = {}): FinderEntry => ({
  name: path.split('/').pop()!,
  path,
  kind: 'file',
  size: 0,
  mtimeMs: 0,
  hidden: false,
  ...extra
})

const listing = (path: string, entries: FinderEntry[], extra: Partial<FinderListing> = {}): FinderListing => ({ path, parent: path === '/' ? null : '/', entries, total: entries.length, offset: 0, ...extra })

/** A disk the store can browse: folders by path, recording every call. */
function disk(folders: Record<string, FinderEntry[]>, routes: Record<string, (p: never) => unknown> = {}) {
  const calls: [string, unknown][] = []
  const bridge = installBridge({
    'finder:places': () => ({ home: '/home', places: [{ id: 'home', path: '/home' }], volumes: [] }),
    'finder:list': ({ path }: { path: string }) => {
      if (!folders[path]) throw Object.assign(new Error(`Folder not found: ${path}`), { code: 'not-found' })
      return listing(path, folders[path])
    },
    'finder:preview': ({ path }: { path: string }) => ({ entry: entry(path), type: 'text', text: 'x' }),
    ...routes
  })
  const invoke = bridge.invoke.getMockImplementation()!
  bridge.invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    calls.push([channel, payload])
    return invoke(channel, payload)
  })
  const sent = (channel: string) => calls.filter(([c]) => c === channel).map(([, p]) => p)
  return { bridge, sent }
}

/** A fresh store module (it reads its preferences when loaded). */
async function store() {
  vi.resetModules()
  return (await import('@/features/files/store')).useFiles
}

afterEach(() => localStorage.clear())

describe('files helpers', () => {
  it('know what a file is by its name', () => {
    expect(extOf('a.TXT')).toBe('txt')
    expect(extOf('.env')).toBe('env')
    expect(extOf('Makefile')).toBe('')
    expect(fileType('photo.HEIC')).toBe('image')
    expect(fileType('clip.mov')).toBe('video')
    expect(fileType('song.flac')).toBe('audio')
    expect(fileType('paper.pdf')).toBe('pdf')
    expect(fileType('App.tsx')).toBe('text')
    expect(fileType('README')).toBe('text')
    expect(fileType('.gitignore')).toBe('text')
    expect(fileType('archive.zip')).toBe('binary')
    expect(entryKind(entry('/a/Tools.app', { kind: 'dir', bundle: true }))).toBe('bundle')
    expect(entryKind(entry('/a/src', { kind: 'dir' }))).toBe('dir')
    expect(entryKind(entry('/a/x.png'))).toBe('image')
  })

  it('show sizes and dates like Finder, and build preview addresses', () => {
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1500)).toBe('1.5 KB')
    expect(formatBytes(25_000)).toBe('25 KB')
    expect(formatBytes(3_200_000)).toBe('3.2 MB')
    expect(formatBytes(5e15)).toBe('5,000 TB')
    const now = new Date(2026, 9, 15, 14, 3).getTime()
    expect(formatModified(new Date(2026, 9, 15, 9, 5).getTime(), now)).toBe('09:05 AM')
    expect(formatModified(new Date(2026, 9, 1, 9, 5).getTime(), now)).toBe('Oct 01 09:05 AM')
    expect(formatModified(new Date(2025, 0, 2, 9, 5).getTime(), now)).toBe('Jan 02, 2025 09:05 AM')
    expect(formatModified(Date.now())).toMatch(/\d/)
    expect(fileUrl('/Users/me/a b#1.png')).toBe('mindeck-file://local/Users/me/a%20b%231.png')
    expect(thumbUrl('/x/doc.pdf')).toBe('mindeck-file://thumb/x/doc.pdf?size=256')
    expect(thumbUrl('C:\\Users\\me\\a.png', 64)).toBe('mindeck-file://thumb/C%3A/Users/me/a.png?size=64')
    expect(fileHref('/Users/me/page.html')).toBe('file:///Users/me/page.html')
    expect(baseName('/Users/me/')).toBe('me')
    expect(baseName('/')).toBe('/')
    expect(baseName('C:\\x\\y')).toBe('y')
  })
})

describe('files store', () => {
  it('starts at Home — or where it was last, unless that folder is gone', async () => {
    let useFiles = await store()
    await useFiles.getState().init() // no desktop: nothing
    expect(useFiles.getState().places).toBeUndefined()

    const { sent } = disk({ '/home': [entry('/home/a.txt')], '/work': [] })
    await useFiles.getState().init()
    expect(useFiles.getState().listing!.path).toBe('/home')
    await useFiles.getState().init() // once only
    expect(sent('finder:places')).toHaveLength(1)

    localStorage.setItem('mindeck.files', JSON.stringify({ path: '/work', view: 'grid', sort: { key: 'size', desc: true }, hidden: true, showPreview: false }))
    useFiles = await store()
    expect(useFiles.getState()).toMatchObject({ view: 'grid', sort: { key: 'size', desc: true }, hidden: true, showPreview: false })
    await useFiles.getState().init()
    expect(useFiles.getState().listing!.path).toBe('/work')

    localStorage.setItem('mindeck.files', JSON.stringify({ path: '/gone', sort: { key: 'nope' } }))
    useFiles = await store()
    expect(useFiles.getState().sort).toEqual({ key: 'name', desc: false })
    await useFiles.getState().init()
    expect(useFiles.getState()).toMatchObject({ listing: { path: '/home' }, error: undefined })

    localStorage.setItem('mindeck.files', '{broken')
    useFiles = await store()
    expect(useFiles.getState().view).toBe('list')
    installBridge({
      'finder:places': () => {
        throw new Error('no core')
      }
    })
    await useFiles.getState().init()
    expect(useFiles.getState().error).toBe('no core')
  })

  it('goes into folders, back, forward and up, and remembers its preferences', async () => {
    const useFiles = await store()
    disk({ '/': [entry('/home', { kind: 'dir' })], '/home': [entry('/home/docs', { kind: 'dir' })], '/home/docs': [entry('/home/docs/a.md')] })
    const s = () => useFiles.getState()
    await s().open('/home')
    await s().goBack() // nothing behind yet
    await s().goForward() // nothing ahead
    await s().open('/home/docs')
    await s().open('/home/docs') // the same folder again: no history step
    expect(s().back).toEqual(['/home'])
    await s().goBack()
    expect(s().listing!.path).toBe('/home')
    expect(s().forward).toEqual(['/home/docs'])
    await s().goForward()
    expect(s()).toMatchObject({ listing: { path: '/home/docs' }, back: ['/home'], forward: [] })
    await s().goUp()
    expect(s().listing!.path).toBe('/')
    await s().goUp() // the root has no parent
    expect(s().listing!.path).toBe('/')
    s().setView('grid')
    s().setSort('size')
    expect(s().sort).toEqual({ key: 'size', desc: true })
    s().setSort('size')
    expect(s().sort).toEqual({ key: 'size', desc: false })
    s().setSort('name')
    expect(s().sort).toEqual({ key: 'name', desc: false })
    expect(JSON.parse(localStorage.getItem('mindeck.files')!)).toEqual({ view: 'grid', sort: { key: 'name', desc: false }, hidden: false, showPreview: true, favorites: [], path: '/' })
    await s().open('/nope')
    expect(s().error).toBe('Folder not found: /nope')
    s().clearError()
    expect(s().error).toBeUndefined()
  })

  it('selects like Finder: one, ⌘ adds and removes, ⇧ takes the range — previews a single pick', async () => {
    const useFiles = await store()
    const { sent } = disk({ '/d': ['a', 'b', 'c', 'd'].map((n) => entry(`/d/${n}.txt`)) })
    const s = () => useFiles.getState()
    await s().open('/d')
    s().select('/d/b.txt')
    await settle()
    expect(s().preview).toMatchObject({ type: 'text' })
    s().select('/d/d.txt', 'range')
    expect(s().selected).toEqual(['/d/b.txt', '/d/c.txt', '/d/d.txt'])
    expect(s().preview).toBeUndefined()
    s().select('/d/c.txt', 'toggle')
    expect(s().selected).toEqual(['/d/b.txt', '/d/d.txt'])
    s().select('/d/a.txt', 'toggle')
    s().select('/d/gone.txt', 'range') // the anchor exists, the target does not: just it
    expect(s().selected).toEqual(['/d/gone.txt'])
    s().clearSelection()
    s().select('/d/c.txt', 'range') // no anchor: a single pick
    expect(s().selected).toEqual(['/d/c.txt'])
    s().selectAll()
    expect(s().selected).toHaveLength(4)
    // hiding and showing the preview
    s().select('/d/a.txt')
    s().togglePreview()
    s().select('/d/b.txt')
    expect(s().preview).toBeUndefined()
    s().togglePreview()
    await settle()
    expect(sent('finder:preview').at(-1)).toEqual({ path: '/d/b.txt' })
    s().select('/d/a.txt', 'toggle')
    s().togglePreview()
    s().togglePreview() // two picked: nothing to preview
    // a preview that arrives for an old pick is dropped; a failing one clears
    installBridge({
      'finder:preview': ({ path }: { path: string }) => {
        if (path.endsWith('c.txt')) throw new Error('gone')
        return { entry: entry(path), type: 'text' }
      }
    })
    s().select('/d/b.txt')
    s().select('/d/d.txt')
    await settle()
    expect(s().preview!.entry.path).toBe('/d/d.txt')
    s().select('/d/c.txt')
    await settle()
    expect(s().preview).toBeUndefined()
  })

  it('searches the folder — late answers lose to newer ones — and shows hidden files on request', async () => {
    const useFiles = await store()
    let answer: (v: unknown) => void = () => {}
    const { sent } = disk({ '/d': [entry('/d/a.txt'), entry('/d/.env', { hidden: true })] }, { 'finder:search': ({ query }: { query: string }) => (query === 'slow' ? new Promise((r) => (answer = r)) : [entry(`/d/${query}.md`)]) })
    const s = () => useFiles.getState()
    await s().search('x') // no folder yet: nothing
    expect(sent('finder:search')).toEqual([])
    await s().open('/d')
    const slow = s().search('slow')
    await s().search('fast')
    answer([entry('/d/slow.md')])
    await slow
    expect(s().results!.map((e) => e.name)).toEqual(['fast.md'])
    expect(s().searching).toBe(false)
    await s().search('  ')
    expect(s()).toMatchObject({ query: '', results: undefined })
    installBridge({
      'finder:list': () => listing('/d', []),
      'finder:search': () => {
        throw new Error('search broke')
      }
    })
    await s().search('y')
    expect(s().error).toBe('search broke')
    let late: (v: unknown) => void = () => {}
    installBridge({ 'finder:list': () => listing('/d', []), 'finder:search': () => new Promise((_r, reject) => (late = reject)) })
    const failing = s().search('z')
    s().clearSearch()
    late(new Error('too late'))
    await failing
    expect(s().error).toBeUndefined() // the new search cleared the old error; the late failure did not land

    disk({ '/d': [entry('/d/a.txt'), entry('/d/.env', { hidden: true })] })
    s().clearError()
    s().select('/d/a.txt')
    await s().toggleHidden()
    expect(s().hidden).toBe(true)
    expect(s().selected).toEqual(['/d/a.txt']) // still there after the refresh
    await s().toggleHidden()
  })

  it('creates, renames, trashes, moves and copies — then refreshes, picking the result', async () => {
    const useFiles = await store()
    const folder = [entry('/d/a.txt'), entry('/d/b.txt')]
    const { sent } = disk(
      { '/d': folder },
      {
        'finder:mkdir': ({ name }: { name: string }) => `/d/${name}`,
        'finder:rename': ({ name }: { name: string }) => `/d/${name}`,
        'finder:trash': () => [],
        'finder:conflicts': () => [],
        'finder:transfer': ({ paths, dest }: { paths: string[]; dest: string }) => ({ items: paths.map((p) => ({ from: p, to: `${dest}/x` })), replaced: [], skipped: [] }),
        'finder:open': () => undefined,
        'finder:reveal': () => undefined,
        'finder:search': () => [entry('/d/b.txt'), entry('/d/sub/deep.md')]
      }
    )
    const s = () => useFiles.getState()
    await s().mkdir('nowhere') // no folder: nothing
    await s().reload() // nothing shown yet: nothing to refresh
    await s().rename('/elsewhere/x.txt', 'y.txt') // renaming from elsewhere before any folder is shown
    await s().open('/d')
    s().startCreate()
    expect(s().creating).toBe(true)
    s().cancelCreate()
    s().startCreate()
    await s().mkdir('  ')
    expect(s().creating).toBe(false)
    await s().mkdir('New')
    expect(s().selected).toEqual(['/d/New'])

    s().startRename('/d/a.txt')
    expect(s().renaming).toBe('/d/a.txt')
    s().cancelRename()
    await s().rename('/d/a.txt', 'a.txt') // unchanged
    await s().rename('/d/a.txt', ' ')
    await s().rename('/d/a.txt', 'c.txt')
    expect(sent('finder:rename')).toEqual([
      { path: '/elsewhere/x.txt', name: 'y.txt' },
      { path: '/d/a.txt', name: 'c.txt' }
    ])
    await s().rename('/d/unknown.txt', 'u.txt') // not listed: renamed all the same
    await s().search('b')
    await s().rename('/d/b.txt', 'bee.txt') // while searching: the search refreshes
    expect(sent('finder:search')).toHaveLength(2)
    await s().rename('/d/b.txt', 'b.txt') // a hit's current name: unchanged
    await s().rename('/d/sub/deep.md', 'deep.md') // a hit from a subfolder, found among the results: unchanged

    await s().trash([]) // nothing picked
    await s().trash(['/d/b.txt'])
    expect(s().notice).toEqual({ key: 'trashed', count: 1 })
    s().setNotice(undefined)
    s().clearSearch()
    s().select('/d/a.txt')
    await s().trash()
    expect(sent('finder:trash').at(-1)).toEqual({ paths: ['/d/a.txt'] })
    expect(s().selected).toEqual([])

    await s().move([], '/x')
    await s().move(['/d/a.txt'], '/x')
    await s().move(['/d/a.txt'], '/d', true)
    expect(sent('finder:transfer').map((p) => (({ id: _id, ...rest }) => rest)(p as { id: string }))).toEqual([
      { paths: ['/d/a.txt'], dest: '/x', mode: 'move', choices: {} },
      { paths: ['/d/a.txt'], dest: '/d', mode: 'copy', choices: {} }
    ])
    expect(s().selected).toEqual(['/d/x']) // copied into the folder shown: picked
    await s().openWithApp('/d/a.txt')
    await s().reveal('/d/a.txt')
    expect(sent('finder:open')).toEqual([{ path: '/d/a.txt' }])
    expect(sent('finder:reveal')).toEqual([{ path: '/d/a.txt' }])
  })

  it('reports what the disk refused', async () => {
    const useFiles = await store()
    const no = (message: string) => () => {
      throw new Error(message)
    }
    disk({ '/d': [entry('/d/a.txt')] }, { 'finder:mkdir': no('exists'), 'finder:rename': no('taken'), 'finder:trash': no('read-only'), 'finder:conflicts': () => [], 'finder:transfer': no('busy'), 'finder:open': no('no app'), 'finder:reveal': no('no finder') })
    const s = () => useFiles.getState()
    await s().open('/d')
    for (const [run, message] of [
      [() => s().mkdir('x'), 'exists'],
      [() => s().rename('/d/a.txt', 'b'), 'taken'],
      [() => s().trash(['/d/a.txt']), 'read-only'],
      [() => s().move(['/d/a.txt'], '/x'), 'busy'],
      [() => s().openWithApp('/d/a.txt'), 'no app'],
      [() => s().reveal('/d/a.txt'), 'no finder']
    ] as const) {
      await run()
      expect(s().error).toBe(message)
    }
  })
})

describe('sorting files', () => {
  it('puts folders first, then sorts by the chosen column — names naturally', async () => {
    const { sortEntries, visibleEntries } = await import('@/features/files/store')
    const list = [
      entry('/d/b 10.txt', { size: 3, mtimeMs: 1 }),
      entry('/d/b 2.txt', { size: 3, mtimeMs: 3 }),
      entry('/d/zeta', { kind: 'dir' }),
      entry('/d/App.app', { kind: 'dir', bundle: true, mtimeMs: 2 }),
      entry('/d/a.png', { size: 9, mtimeMs: 2 })
    ]
    const names = (sort: Parameters<typeof sortEntries>[1]) => sortEntries(list, sort).map((e) => e.name)
    expect(names({ key: 'name', desc: false })).toEqual(['zeta', 'a.png', 'App.app', 'b 2.txt', 'b 10.txt'])
    expect(names({ key: 'name', desc: true })).toEqual(['zeta', 'b 10.txt', 'b 2.txt', 'App.app', 'a.png'])
    expect(names({ key: 'size', desc: true })).toEqual(['zeta', 'a.png', 'b 10.txt', 'b 2.txt', 'App.app'])
    expect(names({ key: 'modified', desc: false })).toEqual(['zeta', 'b 10.txt', 'a.png', 'App.app', 'b 2.txt'])
    expect(names({ key: 'kind', desc: false })).toEqual(['zeta', 'App.app', 'a.png', 'b 2.txt', 'b 10.txt'])
    expect(visibleEntries({ results: undefined, listing: undefined, sort: { key: 'name', desc: false } })).toEqual([])
  })
})

describe('preferences without storage', () => {
  it('keeps working when the browser refuses storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const useFiles = await store()
    expect(() => useFiles.getState().setView('grid')).not.toThrow()
    setItem.mockRestore()
  })
})
