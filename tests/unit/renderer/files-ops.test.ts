import { afterEach, describe, expect, it, vi } from 'vitest'
import { installBridge, settle } from './bridge'
import { formatMode, isArchive, pathChain } from '@/features/files/kinds'
import { de } from '@/lib/i18n/de'
import type { FinderEntry, FinderProgress } from '@shared/types/finder'

const entry = (path: string, extra: Partial<FinderEntry> = {}): FinderEntry => ({
  name: path.split('/').pop()!,
  path,
  kind: 'file',
  size: 0,
  mtimeMs: 0,
  hidden: false,
  ...extra
})

/** A disk behind the bridge: folders in pages of `page`, every call recorded. */
function disk(folders: Record<string, FinderEntry[]>, routes: Record<string, (p: never) => unknown> = {}, page = 1000) {
  const calls: [string, unknown][] = []
  const bridge = installBridge({
    'finder:places': () => ({ home: '/home', places: [{ id: 'home', path: '/home' }], volumes: [] }),
    'finder:list': ({ path, offset = 0 }: { path: string; offset?: number }) => {
      const all = folders[path]
      if (!all) throw Object.assign(new Error(`Folder not found: ${path}`), { code: 'not-found' })
      return { path, parent: '/', entries: all.slice(offset, offset + page), total: all.length, offset }
    },
    'finder:preview': ({ path }: { path: string }) => ({ entry: entry(path), type: 'text', text: 'x' }),
    'finder:info': ({ path }: { path: string }) => ({ entry: entry(path, { kind: path.endsWith('dir') ? 'dir' : 'file' }), createdMs: 1, accessedMs: 2, mode: 0o644, owner: 'me', writable: true }),
    'finder:folderSize': () => ({ bytes: 10, files: 2, folders: 0, partial: false }),
    'finder:cancel': () => undefined,
    'finder:conflicts': () => [],
    'finder:transfer': ({ paths, dest, mode }: { paths: string[]; dest: string; mode: string }) => ({
      items: paths.map((p) => ({ from: p, to: `${dest}/${p.split('/').pop()}` })),
      replaced: [],
      skipped: [],
      ...(mode === 'copy' && paths.includes('/stop/me') ? { cancelled: true } : {})
    }),
    'finder:clipboardWrite': () => undefined,
    'finder:clipboardRead': () => [],
    'finder:trash': ({ paths }: { paths: string[] }) => paths.map((path) => ({ path, restore: `/trash/${path.split('/').pop()}` })),
    'finder:restore': () => undefined,
    'finder:untrash': ({ items }: { items: { path: string }[] }) => ({ items: items.map((i) => ({ path: i.path, to: i.path })), gone: [] }),
    'finder:privacySettings': () => undefined,
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

async function store() {
  vi.resetModules()
  return await import('@/features/files/store')
}

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('files helpers (more)', () => {
  it('shows permissions like ls, chains paths from Home or the root, knows archives', () => {
    expect(formatMode(0o754)).toBe('rwxr-xr--')
    expect(formatMode(0o600)).toBe('rw-------')
    expect(pathChain('/home/a/b', '/home').map((c) => c.name)).toEqual(['~', 'a', 'b'])
    expect(pathChain('/etc/x', '/home').map((c) => c.path)).toEqual(['/', '/etc', '/etc/x'])
    // Windows: the drive's root, never the bare drive (its current folder)
    expect(pathChain('C:\\Users\\me')).toEqual([
      { name: 'C:', path: 'C:\\' },
      { name: 'Users', path: 'C:\\Users' },
      { name: 'me', path: 'C:\\Users\\me' }
    ])
    expect(pathChain('D:\\').map((c) => c.path)).toEqual(['D:\\'])
    expect(pathChain('C:\\Users\\me\\code', 'C:\\Users\\me').map((c) => c.name)).toEqual(['~', 'code'])
    expect(pathChain('rel/x').map((c) => c.path)).toEqual(['/', 'rel', 'rel/x'])
    expect(['a.zip', 'b.TAR.GZ', 'c.tgz', 'd.tar', 'e.rar'].map(isArchive)).toEqual([true, true, true, true, false])
    expect(de.files.folderSize('5 KB', 1, false)).toBe('5 KB · 1 Datei')
    expect(de.files.folderSize('5 KB', 2, true)).toBe('mindestens 5 KB · 2 Dateien')
  })
})

describe('files store: big folders and details', () => {
  it('shows the first page at once and loads the rest; a newer folder stops it', async () => {
    const { useFiles, listAll } = await store()
    const many = Array.from({ length: 5 }, (_, i) => entry(`/big/f${i}`))
    const { sent } = disk({ '/big': many, '/small': [entry('/small/a')] }, {}, 2)
    await useFiles.getState().open('/big')
    expect(useFiles.getState().listing!.entries.map((e) => e.name)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4'])
    expect(sent('finder:list').map((p) => (p as { offset?: number }).offset)).toEqual([undefined, 2, 4])
    expect((await listAll('/big', false)).entries).toHaveLength(5)

    // An empty page (the folder shrank) ends the loading; so does a failing one.
    disk({ '/big': many }, { 'finder:list': ({ offset = 0 }: { offset?: number }) => ({ path: '/big', parent: '/', entries: offset ? [] : many.slice(0, 2), total: 5, offset }) })
    await useFiles.getState().open('/big')
    expect(useFiles.getState().listing!.entries).toHaveLength(2)
    expect((await listAll('/big', true)).entries).toHaveLength(2)
    disk({}, { 'finder:list': ({ offset = 0 }: { offset?: number }) => (offset ? Promise.reject(new Error('gone')) : { path: '/big', parent: '/', entries: many.slice(0, 2), total: 5, offset }) })
    await useFiles.getState().open('/big')
    expect(useFiles.getState().listing!.entries).toHaveLength(2)

    // Opening another folder while pages load: the old pages are dropped.
    let release: () => void = () => {}
    disk({ '/small': [entry('/small/a')] }, {
      'finder:list': ({ path, offset = 0 }: { path: string; offset?: number }) =>
        path === '/small'
          ? { path, parent: '/', entries: [entry('/small/a')], total: 1, offset: 0 }
          : offset
            ? new Promise((r) => (release = () => r({ path, parent: '/', entries: many.slice(2), total: 5, offset })))
            : { path, parent: '/', entries: many.slice(0, 2), total: 5, offset: 0 }
    })
    const slow = useFiles.getState().open('/big')
    await settle()
    const fast = useFiles.getState().open('/small')
    release()
    await Promise.all([slow, fast])
    expect(useFiles.getState().listing!.path).toBe('/small')

    // A late first page loses too.
    let late: (v: unknown) => void = () => {}
    disk({ '/small': [entry('/small/a')] }, { 'finder:list': ({ path }: { path: string }) => (path === '/slow' ? new Promise((r) => (late = r)) : { path, parent: '/', entries: [], total: 0, offset: 0 }) })
    const first = useFiles.getState().open('/slow')
    await useFiles.getState().open('/small')
    late({ path: '/slow', parent: '/', entries: [], total: 0, offset: 0 })
    await first
    expect(useFiles.getState().listing!.path).toBe('/small')
    let failLate: (e: Error) => void = () => {}
    disk({}, { 'finder:list': ({ path }: { path: string }) => (path === '/slow' ? new Promise((_r, j) => (failLate = j)) : { path, parent: '/', entries: [], total: 0, offset: 0 }) })
    const failing = useFiles.getState().open('/slow')
    await useFiles.getState().open('/small')
    failLate(new Error('nope'))
    await failing
    expect(useFiles.getState().error).toBeUndefined()
  })

  it('loads details of a single pick, counts folder sizes (stopping the previous count)', async () => {
    const { useFiles } = await store()
    let finish: (v: unknown) => void = () => {}
    const { sent } = disk({ '/d': [entry('/d/a.txt'), entry('/d/dir', { kind: 'dir' })] }, { 'finder:folderSize': () => new Promise((r) => (finish = r)) })
    const s = () => useFiles.getState()
    await s().open('/d')
    s().select('/d/a.txt')
    await settle()
    expect(s()).toMatchObject({ info: { mode: 0o644, owner: 'me' }, size: undefined })
    s().select('/d/dir')
    await settle()
    expect(s().size).toBe('counting')
    s().select('/d/a.txt') // the count for dir stops
    await settle()
    expect(sent('finder:cancel')).toHaveLength(1)
    finish({ bytes: 1, files: 1, folders: 0, partial: false })
    await settle()
    expect(s().size).toBeUndefined() // the answer came for an old pick
    s().select('/d/dir')
    await settle()
    finish({ bytes: 5, files: 2, folders: 0, partial: false })
    await settle()
    expect(s().size).toMatchObject({ bytes: 5 })
    s().select('/d/a.txt') // the count already finished: nothing to stop
    await settle()
    expect(sent('finder:cancel')).toHaveLength(1)
    // An answer for an older pick is dropped; a failing count leaves no size; failing info none.
    disk({ '/d': [entry('/d/a.txt'), entry('/d/dir', { kind: 'dir' })] }, { 'finder:folderSize': () => Promise.reject(new Error('x')) })
    s().select('/d/dir')
    await settle()
    expect(s().size).toBeUndefined()
    let infoLate: (v: unknown) => void = () => {}
    disk({}, { 'finder:info': () => new Promise((r) => (infoLate = r)) })
    s().select('/d/dir')
    s().togglePreview()
    s().togglePreview() // shown again: loads once more
    infoLate({ entry: entry('/d/dir'), createdMs: 0, accessedMs: 0, mode: 0, owner: null, writable: false })
    await settle()
    disk({}, { 'finder:info': () => Promise.reject(new Error('gone')) })
    s().select('/d/a.txt')
    await settle()
    expect(s().info).toBeUndefined()
    // Stopping a count that can't be stopped (it ended meanwhile) is fine too.
    disk({}, { 'finder:folderSize': () => new Promise(() => {}), 'finder:cancel': () => Promise.reject(new Error('no such job')) })
    s().select('/d/dir')
    await settle()
    s().select('/d/a.txt')
    await settle()
    expect(s().size).toBeUndefined()
  })
})

describe('files store: clipboard, conflicts, undo', () => {
  it('copies and cuts onto both clipboards; pastes ours, or what Finder copied', async () => {
    const { useFiles } = await store()
    let system: string[] = []
    const { sent } = disk({ '/d': [entry('/d/a.txt')], '/e': [] }, { 'finder:clipboardRead': () => system, 'finder:clipboardWrite': () => Promise.reject(new Error('no clipboard')) })
    const s = () => useFiles.getState()
    await s().paste() // no folder: nothing
    await s().open('/d')
    await s().copy([])
    await s().cut([])
    await s().paste() // nothing copied anywhere
    expect(sent('finder:transfer')).toEqual([])
    s().select('/d/a.txt')
    await s().copy()
    expect(s()).toMatchObject({ clipboard: { paths: ['/d/a.txt'], cut: false }, notice: { key: 'clipboard', count: 1, cut: false } })
    await s().paste('/e')
    expect(sent('finder:transfer').at(-1)).toMatchObject({ paths: ['/d/a.txt'], dest: '/e', mode: 'copy' })
    system = ['/d/a.txt'] // the system clipboard has ours too
    await s().cut()
    await s().paste('/e')
    expect(sent('finder:transfer').at(-1)).toMatchObject({ mode: 'move' })
    expect(s().clipboard).toBeUndefined()
    system = ['/finder/x.png'] // copied in Finder since
    await s().copy(['/d/a.txt'])
    await s().paste('/e')
    expect(sent('finder:transfer').at(-1)).toMatchObject({ paths: ['/finder/x.png'], mode: 'copy' })
    disk({ '/d': [] }, { 'finder:clipboardRead': () => Promise.reject(new Error('busy')) })
    await s().paste('/e') // the system clipboard fails: ours
    expect(s().clipboard).toEqual({ paths: ['/d/a.txt'], cut: false })
  })

  it('asks about taken names; a stopped dialog does nothing; remembers how to undo', async () => {
    const { useFiles } = await store()
    const { sent } = disk(
      { '/d': [entry('/d/a.txt')], '/e': [] },
      {
        'finder:conflicts': () => ['a.txt'],
        'finder:transfer': () => ({ items: [{ from: '/d/a.txt', to: '/e/a.txt' }], replaced: [{ path: '/e/a.txt', restore: '/trash/a.txt' }], skipped: [] })
      }
    )
    const s = () => useFiles.getState()
    await s().open('/d')
    const stopped = s().move(['/d/a.txt'], '/e')
    await settle()
    expect(s().conflict).toMatchObject({ names: ['a.txt'], dest: '/e' })
    s().answerConflict(null)
    await stopped
    expect(s().conflict).toBeUndefined()
    expect(sent('finder:transfer')).toEqual([])

    const moving = s().move(['/d/a.txt'], '/e')
    await settle()
    s().answerConflict({ 'a.txt': 'replace' })
    await moving
    expect(sent('finder:transfer')[0]).toMatchObject({ choices: { 'a.txt': 'replace' }, mode: 'move' })
    expect(s().undo.at(-1)).toEqual({ moves: [{ from: '/e/a.txt', to: '/d/a.txt' }], untrash: [{ path: '/e/a.txt', restore: '/trash/a.txt' }] })
    s().answerConflict(null) // no question open: nothing
  })

  it('undoes renames, moves, copies, new folders and trashing (where the system allows)', async () => {
    const { useFiles } = await store()
    const { sent } = disk(
      { '/d': [entry('/d/a.txt'), entry('/d/b.txt')], '/e': [] },
      {
        'finder:rename': () => '/d/c.txt',
        'finder:mkdir': () => '/d/New'
      }
    )
    const s = () => useFiles.getState()
    await s().undoLast() // nothing to undo
    await s().open('/d')
    await s().rename('/d/a.txt', 'c.txt')
    await s().mkdir('New')
    await s().move(['/d/b.txt'], '/e', true) // copy
    await s().trash(['/d/a.txt'])
    expect(s().undo).toEqual([
      { moves: [{ from: '/d/c.txt', to: '/d/a.txt' }] },
      { trash: ['/d/New'] },
      { trash: ['/e/b.txt'] },
      { untrash: [{ path: '/d/a.txt', restore: '/trash/a.txt' }] }
    ])
    await s().undoLast()
    expect(sent('finder:untrash')).toEqual([{ items: [{ path: '/d/a.txt', restore: '/trash/a.txt' }] }])
    expect(s().notice).toEqual({ key: 'undone' })
    await s().undoLast()
    await s().undoLast()
    expect(sent('finder:trash').slice(-2)).toEqual([{ paths: ['/e/b.txt'] }, { paths: ['/d/New'] }])
    await s().undoLast()
    expect(sent('finder:restore')).toEqual([{ moves: [{ from: '/d/c.txt', to: '/d/a.txt' }] }])
    expect(s().undo).toEqual([])
    // Several back into the folder shown: all picked.
    useFiles.setState({ undo: [{ moves: [{ from: '/e/a.txt', to: '/d/a.txt' }, { from: '/e/b.txt', to: '/d/b.txt' }] }] })
    await s().undoLast()
    expect(s().selected).toEqual(['/d/a.txt', '/d/b.txt'])

    // A mixed selection: undo for what can come back, and the status line says what cannot.
    disk({ '/d': [entry('/d/a.txt'), entry('/d/b.txt')] }, { 'finder:trash': () => [{ path: '/d/a.txt', restore: '/trash/a.txt' }, { path: '/d/b.txt' }] })
    await s().trash(['/d/a.txt', '/d/b.txt'])
    expect(s().notice).toEqual({ key: 'trashed', count: 2, noUndo: 1 })
    expect(s().undo.at(-1)).toEqual({ untrash: [{ path: '/d/a.txt', restore: '/trash/a.txt' }] })
    // Back under another name (its own was taken since) — that one is picked; what left the trash is named.
    disk(
      { '/d': [entry('/d/a 2.txt')] },
      { 'finder:untrash': () => ({ items: [{ path: '/d/a.txt', to: '/d/a 2.txt' }], gone: ['/d/c.txt'] }) }
    )
    await s().undoLast()
    expect(s().selected).toEqual(['/d/a 2.txt'])
    expect(s().notice).toEqual({ key: 'undone' })
    expect(s()).toMatchObject({ error: 'c.txt', errorCode: 'trash-gone' })
    // Nothing came back at all: no "Undone".
    s().setNotice(undefined)
    useFiles.setState({ undo: [{ untrash: [{ path: '/d/x.txt', restore: '/trash/x.txt' }, { path: '/d/y.txt', restore: '/trash/y.txt' }] }] })
    disk({ '/d': [] }, { 'finder:untrash': () => ({ items: [], gone: ['/d/x.txt', '/d/y.txt'] }) })
    await s().undoLast()
    expect(s().notice).toBeUndefined()
    expect(s()).toMatchObject({ error: 'x.txt, y.txt', errorCode: 'trash-gone' })
    // macOS wants Full Disk Access: the error keeps its code (the view explains it and links System Settings).
    useFiles.setState({ undo: [{ untrash: [{ path: '/d/x.txt', restore: '/Users/me/.Trash/x.txt' }] }] })
    const fda = disk({ '/d': [] }, { 'finder:untrash': () => Promise.reject(Object.assign(new Error('Full Disk Access'), { code: 'full-disk-access' })) })
    await s().undoLast()
    expect(s()).toMatchObject({ error: 'Full Disk Access', errorCode: 'full-disk-access' })
    await s().privacySettings()
    expect(fda.sent('finder:privacySettings')).toEqual([undefined])
    disk({ '/d': [] }, { 'finder:privacySettings': () => Promise.reject(Object.assign(new Error('desktop only'), { code: 'desktop-only' })) })
    await s().privacySettings()
    expect(s()).toMatchObject({ error: 'desktop only', errorCode: 'desktop-only' })

    // The OS trash without a way back: no undo offered. Nothing moved: nothing to undo.
    disk({ '/d': [entry('/d/a.txt')] }, { 'finder:trash': () => [{ path: '/d/a.txt' }], 'finder:transfer': () => ({ items: [], replaced: [], skipped: ['/d/a.txt'] }) })
    await s().trash(['/d/a.txt'])
    await s().move(['/d/a.txt'], '/e')
    disk({ '/d': [] }, { 'finder:trash': () => [], 'finder:transfer': () => ({ items: [{ from: '/d/x', to: '/e/x' }], replaced: [{ path: '/e/x' }], skipped: [] }) })
    await s().trash(['/d/x'])
    await s().move(['/d/x'], '/e', true)
    expect(s().undo).toEqual([])

    // A failing undo says why; only the last 30 steps are kept.
    disk({ '/d': [] }, { 'finder:restore': () => Promise.reject(new Error('exists')) })
    for (let i = 0; i < 31; i += 1) useFiles.setState((st) => ({ undo: [...st.undo, { moves: [{ from: `/d/${i}`, to: '/d/x' }] }] }))
    await s().rename('/d/q', 'r')
    expect(s().undo).toHaveLength(30)
    await s().undoLast()
    expect(s().error).toBe('exists')
  })
})

describe('files store: jobs, tabs, favorites, drags', () => {
  it('compresses and extracts with progress and Stop; a stopped copy says so', async () => {
    const { useFiles } = await store()
    let progress: ((p: FinderProgress) => void) | undefined
    let finishZip: (v: string) => void = () => {}
    const { sent } = disk(
      { '/d': [entry('/d/a.txt'), entry('/d/a.zip')] },
      {
        'finder:compress': () => new Promise((r) => (finishZip = r)),
        'finder:extract': () => Promise.reject(Object.assign(new Error('Cancelled'), { code: 'cancelled' }))
      }
    )
    const s = () => useFiles.getState()
    await s().open('/d')
    await s().compress([])
    const zipping = s().compress(['/d/a.txt'])
    await settle()
    const id = Object.keys(s().jobs)[0]
    expect(s().jobs[id]).toMatchObject({ kind: 'zip', done: 0 })
    progress = s().onProgress
    progress({ id, kind: 'zip', done: 5, total: 10 })
    progress({ id: 'unknown', kind: 'size', done: 1, total: 0 })
    progress({ id, kind: 'zip', done: 10, total: 10, finished: true })
    expect(s().jobs[id].done).toBe(5)
    expect(Object.keys(s().jobs)).toEqual([id])
    await s().cancelJob(id)
    expect(sent('finder:cancel')).toEqual([{ id }])
    finishZip('/d/a.txt.zip')
    await zipping
    expect(s().jobs).toEqual({})
    expect(s().undo.at(-1)).toEqual({ trash: ['/d/a.txt.zip'] })
    await s().extract('/d/a.zip')
    expect(s().notice).toEqual({ key: 'stopped' })
    disk({ '/d': [] }, { 'finder:extract': () => Promise.reject(new Error('unsafe path')), 'finder:cancel': () => Promise.reject(new Error('x')) })
    await s().extract('/d/a.zip')
    expect(s().error).toBe('unsafe path')
    await s().cancelJob('gone')
    s().clearError()
    disk({ '/d': [], '/e': [] })
    await s().move(['/stop/me'], '/e', true)
    expect(s().notice).toEqual({ key: 'stopped' })
  })

  it('tabs keep their own folder and history', async () => {
    const { useFiles } = await store()
    disk({ '/home': [], '/a': [], '/b': [] })
    const s = () => useFiles.getState()
    await s().newTab() // no folder, no home yet: nothing
    expect(s().tabs).toHaveLength(1)
    await s().init()
    await s().open('/a')
    await s().newTab('/b')
    expect(s().tabs.map((t) => t.path)).toEqual(['/a', '/b'])
    expect(s()).toMatchObject({ back: [], listing: { path: '/b' } })
    await s().open('/home')
    const [first, second] = s().tabs
    await s().switchTab(first.id)
    expect(s()).toMatchObject({ listing: { path: '/a' }, back: ['/home'] })
    await s().switchTab(first.id) // already there
    await s().switchTab('nope')
    await s().switchTab(second.id)
    expect(s()).toMatchObject({ listing: { path: '/home' }, back: ['/b'] })
    await s().newTab()
    expect(s().tabs.at(-1)!.path).toBe('/home')
    await s().closeTab(s().activeTab)
    expect(s().activeTab).toBe(second.id)
    await s().closeTab(first.id) // a tab in the background
    expect(s().tabs.map((t) => t.id)).toEqual([second.id])
    await s().closeTab(second.id) // the last tab stays
    expect(s().tabs).toHaveLength(1)
    useFiles.setState({ listing: undefined })
    await s().newTab() // no folder: Home
    expect(s().listing!.path).toBe('/home')
  })

  it('pins folders to the sidebar (remembered)', async () => {
    let { useFiles } = await store()
    useFiles.getState().toggleFavorite('/work')
    useFiles.getState().toggleFavorite('/play')
    useFiles.getState().toggleFavorite('/work')
    expect(useFiles.getState().favorites).toEqual(['/play'])
    useFiles = (await store()).useFiles
    expect(useFiles.getState().favorites).toEqual(['/play'])
    localStorage.setItem('mindeck.files', JSON.stringify({ favorites: ['/ok', 3], view: 'columns' }))
    useFiles = (await store()).useFiles
    expect(useFiles.getState()).toMatchObject({ favorites: ['/ok'], view: 'columns' })
    localStorage.setItem('mindeck.files', JSON.stringify({ favorites: 'nope' }))
    expect((await store()).useFiles.getState().favorites).toEqual([])
  })

  it('drags out as an OS drag; dropped files come in as copies, our own drag as a move (⌥ copies)', async () => {
    const { useFiles } = await store()
    const { bridge, sent } = disk({ '/d': [], '/e': [] })
    const s = () => useFiles.getState()
    expect(s().startDrag(['/d/a'])).toBe(false) // the bridge cannot drag
    const startDrag = vi.fn()
    const paths: Record<string, string> = {}
    Object.assign(bridge, { startDrag, pathForFile: (f: File) => paths[f.name] ?? '' })
    await s().open('/e')
    expect(s().startDrag(['/d/a'])).toBe(true)
    expect(startDrag).toHaveBeenCalledWith(['/d/a'])
    const a = new File([''], 'a')
    paths.a = '/d/a'
    await s().dropFiles([a], '/e', false)
    expect(sent('finder:transfer').at(-1)).toMatchObject({ paths: ['/d/a'], dest: '/e', mode: 'move' })
    expect(s().dragging).toBeUndefined()
    s().startDrag(['/d/a'])
    await s().dropFiles([a], '/e', true)
    expect(sent('finder:transfer').at(-1)).toMatchObject({ mode: 'copy' })
    const outside = new File([''], 'x')
    paths.x = '/Users/me/x'
    await s().dropFiles([outside], '/e', false)
    expect(sent('finder:transfer').at(-1)).toMatchObject({ paths: ['/Users/me/x'], mode: 'copy' })
    // Our own drag dropped where it came from: nothing.
    s().startDrag(['/e/y'])
    paths.y = '/e/y'
    await s().dropFiles([new File([''], 'y')], '/e', false)
    expect(sent('finder:transfer')).toHaveLength(3)
    await s().dropFiles([new File([''], 'nameless')], '/e', false)
    paths.top = '/top'
    s().startDrag(['/top'])
    await s().dropFiles([new File([''], 'top')], '/', false) // from the disk's root onto it: nothing
    expect(sent('finder:transfer')).toHaveLength(3)
    s().startDrag(['/d/a'])
    s().endDrag()
    expect(s().dragging).toBeUndefined()
    delete (bridge as { pathForFile?: unknown }).pathForFile
    await s().dropFiles([a], '/e', false)
    expect(sent('finder:transfer')).toHaveLength(3)
  })
})
