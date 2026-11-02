import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge, settle } from './bridge'
import { useFiles } from '@/features/files/store'
import { useProjects } from '@/features/projects/store'
import { FilesView } from '@/features/files/components/FilesView'
import { Sidebar } from '@/features/files/components/Sidebar'
import { PreviewPane } from '@/features/files/components/PreviewPane'
import { ConflictDialog, Jobs, Tabs } from '@/features/files/components/Panels'
import { revealItem } from '@/features/files/components/Virtual'
import type { FinderEntry, FinderInfo } from '@shared/types/finder'

const initial = { files: useFiles.getState(), projects: useProjects.getState() }

const entry = (path: string, extra: Partial<FinderEntry> = {}): FinderEntry => ({
  name: path.split('/').pop()!,
  path,
  kind: 'file',
  size: 1200,
  mtimeMs: new Date(2026, 9, 15, 9, 5).getTime(),
  hidden: false,
  ...extra
})

const FOLDERS: Record<string, FinderEntry[]> = {
  '/home': [entry('/home/a', { kind: 'dir' }), entry('/home/top.txt')],
  '/home/a': [entry('/home/a/b', { kind: 'dir' }), entry('/home/a/x.txt'), entry('/home/a/pack.zip')],
  '/home/a/b': [entry('/home/a/b/deep.txt'), entry('/home/a/b/c', { kind: 'dir' })],
  '/home/a/b/c': []
}

function setup(routes: Record<string, (p: never) => unknown> = {}, start = '/home') {
  const calls: [string, unknown][] = []
  const b = installBridge({
    'finder:places': () => ({ home: '/home', places: [{ id: 'home', path: '/home' }], volumes: [] }),
    'finder:list': ({ path }: { path: string }) => {
      const entries = FOLDERS[path] ?? []
      return { path, parent: path === '/home' ? '/' : path.split('/').slice(0, -1).join('/'), entries, total: entries.length, offset: 0 }
    },
    'finder:preview': ({ path }: { path: string }) => ({ entry: entry(path), type: 'binary' }),
    'finder:info': ({ path }: { path: string }) => ({ entry: entry(path), createdMs: 0, accessedMs: 0, mode: 0o644, owner: 'me', writable: true }),
    'finder:conflicts': () => [],
    'finder:transfer': () => ({ items: [], replaced: [], skipped: [] }),
    'finder:clipboardRead': () => [],
    'finder:clipboardWrite': () => undefined,
    'finder:compress': () => '/home/a/x.txt.zip',
    'finder:extract': () => '/home/a/pack',
    'finder:trash': () => [],
    'finder:restore': () => undefined,
    'finder:cancel': () => undefined,
    'memory:status': () => ({ exists: false, root: '' }),
    'projects:list': () => [],
    ...routes
  })
  const invoke = b.invoke.getMockImplementation()!
  b.invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    calls.push([channel, payload])
    return invoke(channel, payload)
  })
  const sent = (channel: string) => calls.filter(([c]) => c === channel).map(([, p]) => p)
  localStorage.setItem('mindeck.files', JSON.stringify({ path: start }))
  useFiles.setState({ path: start })
  const view = render(<FilesView onNavigate={vi.fn()} />)
  return { sent, view, bridge: b }
}

const main = () => screen.getByRole('grid').parentElement!
const row = (name: string) => screen.getByRole('row', { name: new RegExp(`^${name.replace('.', '\\.')}`) })
const key = (el: HTMLElement, k: string, mods: Record<string, boolean> = {}) => fireEvent.keyDown(el, { key: k, ...mods })
const dragEvent = (type: 'dragOver' | 'drop' | 'dragStart', el: HTMLElement, dataTransfer: object, altKey = false) => {
  const event = createEvent[type](el, { dataTransfer })
  Object.defineProperty(event, 'altKey', { value: altKey })
  fireEvent(el, event)
  return event
}

beforeEach(() => {
  useFiles.setState(initial.files, true)
  useProjects.setState(initial.projects, true)
})
afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('Files: keys, menus and the status line', () => {
  it('⌘C ⌘X ⌘V, ⌘Z, ⌘T ⌘W — and says what happened', async () => {
    const { sent } = setup()
    await settle()
    const s = () => useFiles.getState()
    fireEvent.click(row('top.txt'))
    key(main(), 'c', { metaKey: true })
    await settle()
    expect(screen.getByText('1 item copied')).toBeInTheDocument()
    key(main(), 'x', { ctrlKey: true })
    await settle()
    expect(screen.getByText('1 item cut — paste moves them')).toBeInTheDocument()
    key(main(), 'v', { metaKey: true })
    await settle()
    expect(sent('finder:transfer')).toHaveLength(1)
    act(() => useFiles.setState({ undo: [{ trash: ['/home/new'] }] }))
    key(main(), 'z', { metaKey: true })
    await settle()
    expect(screen.getByText('Undone')).toBeInTheDocument()
    act(() => useFiles.setState({ notice: { key: 'stopped' } }))
    expect(screen.getByText('Stopped')).toBeInTheDocument()

    key(main(), 't', { metaKey: true })
    await settle()
    expect(s().tabs).toHaveLength(2)
    expect(screen.getByRole('tablist', { name: 'Tabs' })).toBeInTheDocument()
    key(main(), 'w', { metaKey: true })
    await settle()
    expect(s().tabs).toHaveLength(1)
    key(main(), 'w', { metaKey: true }) // the last tab stays
    expect(s().tabs).toHaveLength(1)
  })

  it('offers copy, paste, compress, extract, tabs and the sidebar in the menus', async () => {
    const { sent } = setup({}, '/home/a')
    await settle()
    const s = () => useFiles.getState()
    const menuOf = (target: HTMLElement) => {
      fireEvent.contextMenu(target, { clientX: 5, clientY: 5 })
      return screen.getByRole('menu', { name: 'File actions' })
    }
    const pick = (target: HTMLElement, label: string) => fireEvent.click(within(menuOf(target)).getByRole('menuitem', { name: label }))

    expect(within(menuOf(main())).getByRole('menuitem', { name: 'Paste' })).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    pick(row('x.txt'), 'Copy')
    await settle()
    expect(s().clipboard).toEqual({ paths: ['/home/a/x.txt'], cut: false })
    pick(main(), 'Paste')
    await settle()
    expect(sent('finder:transfer').at(-1)).toMatchObject({ dest: '/home/a', mode: 'copy' })
    pick(row('b'), 'Paste into “b”')
    await settle()
    expect(sent('finder:transfer').at(-1)).toMatchObject({ dest: '/home/a/b' })
    pick(row('x.txt'), 'Cut')
    await settle()
    expect(s().clipboard!.cut).toBe(true)
    pick(row('x.txt'), 'Compress')
    await settle()
    expect(sent('finder:compress')).toEqual([{ paths: ['/home/a/x.txt'], id: expect.any(String) }])
    expect(within(menuOf(row('x.txt'))).queryByRole('menuitem', { name: 'Extract' })).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    pick(row('pack.zip'), 'Extract')
    await settle()
    expect(sent('finder:extract')).toEqual([{ path: '/home/a/pack.zip', id: expect.any(String) }])
    pick(row('b'), 'Add to sidebar')
    expect(s().favorites).toEqual(['/home/a/b'])
    pick(row('b'), 'Remove from sidebar')
    expect(s().favorites).toEqual([])
    pick(row('b'), 'Open in new tab')
    await settle()
    expect(s().tabs.map((t) => t.path)).toEqual(['/home/a', '/home/a/b'])
    pick(main(), 'New tab')
    await settle()
    expect(s().tabs).toHaveLength(3)
    await act(() => s().switchTab(s().tabs[0].id))
    // Several picked: compressing them all.
    act(() => s().selectAll())
    expect(within(menuOf(row('x.txt'))).getByRole('menuitem', { name: 'Compress 3 items' })).toBeInTheDocument()
  })

  it('takes files dropped from Finder or Explorer into the folder; forgets an OS drag that ended outside', async () => {
    const { bridge } = setup()
    await settle()
    const dropFiles = vi.fn(async () => {})
    act(() => useFiles.setState({ dropFiles }))
    const file = new File([''], 'f.txt')
    const over = { types: ['Files'], dropEffect: '' }
    expect(dragEvent('dragOver', main(), over).defaultPrevented).toBe(true)
    expect(over.dropEffect).toBe('copy')
    act(() => useFiles.setState({ dragging: ['/home/top.txt'] }))
    dragEvent('dragOver', main(), over)
    expect(over.dropEffect).toBe('move')
    dragEvent('dragOver', main(), over, true)
    expect(over.dropEffect).toBe('copy')
    expect(dragEvent('dragOver', main(), { types: ['text/plain'] }).defaultPrevented).toBe(false)
    dragEvent('drop', main(), { types: ['Files'], files: [file] }, true)
    expect(dropFiles).toHaveBeenCalledWith([file], '/home', true)
    dragEvent('drop', main(), { types: ['text/plain'], files: [] })
    expect(dropFiles).toHaveBeenCalledTimes(1)

    const section = screen.getByRole('region', { name: 'Files' })
    const pointer = (buttons: number) => fireEvent(section, new MouseEvent('pointermove', { bubbles: true, buttons }))
    pointer(1)
    expect(useFiles.getState().dragging).toEqual(['/home/top.txt'])
    pointer(0)
    expect(useFiles.getState().dragging).toBeUndefined()
    pointer(0)

    // Rows start an OS drag where the bridge can.
    const startDrag = vi.fn()
    Object.assign(bridge, { startDrag })
    const started = dragEvent('dragStart', row('top.txt'), { setData: vi.fn(), effectAllowed: '' })
    expect(started.defaultPrevented).toBe(true)
    expect(startDrag).toHaveBeenCalledWith(['/home/top.txt'])
  })

  it('shows how far a big folder has loaded and the jobs running', async () => {
    const { bridge } = setup()
    await settle()
    act(() => useFiles.setState({ listing: { path: '/home', parent: '/', entries: [entry('/home/top.txt')], total: 3, offset: 0 } }))
    expect(screen.getByText('Loading… 1 of 3')).toBeInTheDocument()
    expect(screen.getByText('3 items')).toBeInTheDocument()
    act(() => useFiles.setState({ jobs: { j: { id: 'j', kind: 'copy', done: 25, total: 100, file: '/home/x' }, k: { id: 'k', kind: 'unzip', done: 0, total: 0 } } }))
    expect(screen.getByRole('progressbar', { name: 'Copying' })).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getByRole('progressbar', { name: 'Extracting' })).toHaveAttribute('aria-valuenow', '0')
    // the core reports how far a job is
    act(() => bridge.emit('finder:progress', { id: 'j', kind: 'copy', done: 60, total: 100 }))
    expect(screen.getByRole('progressbar', { name: 'Copying' })).toHaveAttribute('aria-valuenow', '60')
    const cancelJob = vi.fn(async () => {})
    useFiles.setState({ cancelJob })
    fireEvent.click(screen.getAllByRole('button', { name: 'Stop' })[0])
    expect(cancelJob).toHaveBeenCalledWith('j')
  })

  it('arrow keys keep the picked row in sight in long lists and grids', async () => {
    const many = Array.from({ length: 300 }, (_, i) => entry(`/home/f${String(i).padStart(3, '0')}`))
    setup({ 'finder:list': () => ({ path: '/home', parent: '/', entries: many, total: 300, offset: 0 }) })
    await settle()
    // Only a window of the rows is in the page.
    expect(screen.getAllByRole('row').length).toBeLessThan(80)
    const el = main()
    Object.defineProperty(el, 'clientHeight', { value: 280, configurable: true })
    fireEvent.click(row('f000'))
    for (let i = 0; i < 20; i += 1) key(el, 'ArrowDown')
    expect(useFiles.getState().selected).toEqual(['/home/f020'])
    expect(el.scrollTop).toBeGreaterThan(0)
    act(() => useFiles.getState().setView('grid'))
    key(el, 'ArrowDown')
    act(() => useFiles.getState().setView('columns'))
  })

  it('arrow keys in an empty folder do nothing', async () => {
    setup({}, '/home/a/b/c')
    await settle()
    const area = screen.getByText('This folder is empty').closest('[tabindex="0"]') as HTMLElement
    key(area, 'ArrowDown')
    expect(useFiles.getState().selected).toEqual([])
  })

  it('reveals rows above and below the visible area, and leaves visible ones alone', () => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'clientHeight', { value: 100 })
    el.scrollTop = 200
    revealItem(el, 2, 28, 1, 0)
    expect(el.scrollTop).toBe(56)
    revealItem(el, 10, 28, 1, 0)
    expect(el.scrollTop).toBe(208)
    revealItem(el, 8, 28, 1, 0)
    expect(el.scrollTop).toBe(208)
  })
})

describe('Files: the column view', () => {
  it('shows a column per folder from Home; clicks open folders, pick files, and work in earlier columns', async () => {
    localStorage.setItem('mindeck.files', JSON.stringify({ view: 'columns' }))
    useFiles.setState({ view: 'columns' })
    setup({ 'finder:list': ({ path }: { path: string }) => {
      if (path === '/home/broken') throw new Error('gone')
      const entries = [...(FOLDERS[path] ?? []), ...(path === '/home/a/b' ? [entry('/home/a/b/.hidden', { hidden: true })] : [])]
      return { path, parent: '/home', entries, total: entries.length, offset: 0 }
    } }, '/home/a/b')
    await settle()
    const s = () => useFiles.getState()
    const columns = () => screen.getAllByRole('listbox')
    expect(columns().map((c) => c.getAttribute('aria-label'))).toEqual(['/home', '/home/a', '/home/a/b'])
    // The folder open in each column is marked in the one before.
    expect(within(columns()[0]).getByRole('option', { name: /^a/ })).toHaveAttribute('aria-selected', 'true')
    expect(within(columns()[2]).getByRole('option', { name: /\.hidden/ }).className).toContain('opacity-60')
    fireEvent.click(within(columns()[2]).getByRole('option', { name: /\.hidden/ }))
    fireEvent.click(within(columns()[2]).getByRole('option', { name: /deep\.txt/ }), { ctrlKey: true })
    expect(s().selected).toEqual(['/home/a/b/.hidden', '/home/a/b/deep.txt'])
    fireEvent.click(within(columns()[2]).getByRole('option', { name: /deep\.txt/ }), { shiftKey: true })
    fireEvent.click(within(columns()[2]).getByRole('option', { name: /deep\.txt/ }))
    expect(s().selected).toEqual(['/home/a/b/deep.txt'])
    fireEvent.click(within(columns()[2]).getByRole('option', { name: /^c/ }))
    await settle()
    expect(s().listing!.path).toBe('/home/a/b/c')
    expect(columns()).toHaveLength(4)
    fireEvent.click(within(columns()[1]).getByRole('option', { name: /x\.txt/ }))
    await settle()
    expect(s()).toMatchObject({ listing: { path: '/home/a' }, selected: ['/home/a/x.txt'] })
    fireEvent.click(within(columns()[1]).getByRole('option', { name: /pack\.zip/ }), { metaKey: true })
    expect(s().selected).toEqual(['/home/a/x.txt', '/home/a/pack.zip'])

    const openWithApp = vi.fn(async () => {})
    act(() => useFiles.setState({ openWithApp }))
    fireEvent.doubleClick(within(columns()[1]).getByRole('option', { name: /x\.txt/ }))
    expect(openWithApp).toHaveBeenCalledWith('/home/a/x.txt')
    fireEvent.contextMenu(within(columns()[1]).getByRole('option', { name: /x\.txt/ }))
    expect(screen.getByRole('menu', { name: 'File actions' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })

    // Dragging from a column: an OS drag where possible, else Mindeck's own.
    const dt = { setData: vi.fn() }
    dragEvent('dragStart', within(columns()[1]).getByRole('option', { name: /x\.txt/ }), dt)
    expect(dt.setData).toHaveBeenCalledWith('application/x-mindeck-files', '["/home/a/x.txt"]')
    const startDrag = vi.fn()
    Object.assign(window.mindeck!, { startDrag })
    expect(dragEvent('dragStart', within(columns()[1]).getByRole('option', { name: /x\.txt/ }), dt).defaultPrevented).toBe(true)
    // Dropping on a column puts it into that folder.
    const move = vi.fn(async () => {})
    act(() => useFiles.setState({ move }))
    const col = columns()[0]
    dragEvent('dragOver', col, { types: ['application/x-mindeck-files'], dropEffect: '' })
    expect(col.className).toContain('bg-cyan')
    dragEvent('drop', col, { types: ['application/x-mindeck-files'], getData: () => '["/home/a/x.txt"]' })
    expect(move).toHaveBeenCalledWith(['/home/a/x.txt'], '/home', false)

    // A column whose folder cannot be read stays empty; hidden files reload the columns.
    act(() => useFiles.setState({ listing: { path: '/home/broken/z', parent: '/home/broken', entries: [], total: 0, offset: 0 } }))
    await settle()
    expect(within(columns()[1]).queryAllByRole('option')).toEqual([])
    // While searching the hits show as a list.
    act(() => useFiles.setState({ results: [entry('/home/a/x.txt')] }))
    expect(screen.queryAllByRole('listbox')).toEqual([])
  })

  it('drops columns whose answer comes after the folder changed', async () => {
    let answer: (v: unknown) => void = () => {}
    useFiles.setState({ view: 'columns' })
    setup({ 'finder:list': ({ path }: { path: string }) => (path === '/home' ? new Promise((r) => (answer = r)) : { path, parent: '/home', entries: FOLDERS[path] ?? [], total: 0, offset: 0 }) }, '/home/a')
    await settle()
    act(() => useFiles.setState({ view: 'list' }))
    answer({ path: '/home', parent: '/', entries: FOLDERS['/home'], total: 2, offset: 0 })
    await settle()
    expect(screen.queryAllByRole('listbox')).toEqual([])
  })
})

describe('Files: tabs, conflicts, sidebar and info', () => {
  it('tabs switch, close and open', async () => {
    const switchTab = vi.fn(async () => {})
    const closeTab = vi.fn(async () => {})
    const newTab = vi.fn(async () => {})
    useFiles.setState({ tabs: [{ id: 'a', path: '/home', back: [], forward: [] }, { id: 'b', path: '/home/work', back: [], forward: [] }], activeTab: 'a', places: { home: '/home', places: [], volumes: [] }, switchTab, closeTab, newTab })
    render(<Tabs />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['~', 'work'])
    expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getAllByRole('tab')[1])
    expect(switchTab).toHaveBeenCalledWith('b')
    fireEvent.click(screen.getAllByRole('button', { name: 'Close tab' })[1])
    expect(closeTab).toHaveBeenCalledWith('b')
    expect(switchTab).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    expect(newTab).toHaveBeenCalled()
  })

  it('asks name by name — keep both, skip, replace, all at once — or stops', () => {
    const answer = vi.fn()
    useFiles.setState({ conflict: { names: ['a.txt', 'b.txt', 'c.txt', 'd.txt'], dest: '/home/x', answer } })
    const { rerender } = render(<ConflictDialog />)
    expect(screen.getByRole('alertdialog', { name: '“a.txt” already exists in “x”' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Keep both' }))
    expect(screen.getByText('“b.txt” already exists in “x”')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Do this for all 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    expect(answer).toHaveBeenCalledWith({ 'a.txt': 'keep', 'b.txt': 'skip', 'c.txt': 'replace', 'd.txt': 'replace' })

    // One name: no "all"; Escape and Stop give up.
    const single = vi.fn()
    act(() => useFiles.setState({ conflict: { names: ['z'], dest: '/', answer: single } }))
    rerender(<ConflictDialog />)
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(single.mock.calls).toEqual([[null], [null]])
    act(() => useFiles.setState({ conflict: undefined }))
    rerender(<ConflictDialog />)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('pinned folders sit with the favorites and can be removed; own OS drags move', () => {
    installBridge({ 'memory:status': () => ({ exists: false, root: '' }), 'projects:list': () => [] })
    const toggleFavorite = vi.fn()
    useFiles.setState({ places: { home: '/home', places: [], volumes: [] }, favorites: ['/home/work'], toggleFavorite, dragging: ['/x'] })
    render(<Sidebar />)
    const work = screen.getByRole('button', { name: 'work' })
    const over = { types: ['Files'], dropEffect: '' }
    dragEvent('dragOver', work, over)
    expect(over.dropEffect).toBe('move')
    fireEvent.click(screen.getByRole('button', { name: 'Remove from sidebar' }))
    expect(toggleFavorite).toHaveBeenCalledWith('/home/work')
  })

  it('the info: created, permissions, owner, folder sizes, and whether Mindeck may change it', () => {
    const dir = entry('/home/a', { kind: 'dir' })
    const info = (over: Partial<FinderInfo> = {}): FinderInfo => ({ entry: dir, createdMs: new Date(2026, 0, 2, 3, 4).getTime(), accessedMs: 0, mode: 0o750, owner: 'robin', writable: true, ...over })
    useFiles.setState({ selected: ['/home/a'], preview: { entry: dir, type: 'dir', items: 2 }, info: info(), size: 'counting' })
    const { rerender } = render(<PreviewPane actions={{ open: vi.fn() }} editable={false} browsable={false} />)
    expect(screen.getByText('rwxr-x---')).toHaveAttribute('title', '750')
    expect(screen.getByText('robin')).toBeInTheDocument()
    expect(screen.getByText('Calculating…')).toBeInTheDocument()
    expect(screen.getByText('Created')).toBeInTheDocument()
    act(() => useFiles.setState({ size: { bytes: 2_500_000, files: 1, folders: 0, partial: false }, info: info({ owner: null, writable: false }) }))
    rerender(<PreviewPane actions={{ open: vi.fn() }} editable={false} browsable={false} />)
    expect(screen.getByText('2.5 MB · 1 file')).toBeInTheDocument()
    expect(screen.getByText('Another user')).toBeInTheDocument()
    expect(screen.getByText(/Mindeck only reads here/)).toBeInTheDocument()
    act(() => useFiles.setState({ size: { bytes: 10, files: 3, folders: 0, partial: true }, info: info({ entry: entry('/other') }) }))
    rerender(<PreviewPane actions={{ open: vi.fn() }} editable={false} browsable={false} />)
    expect(screen.getByText('at least 10 B · 3 files')).toBeInTheDocument()
    expect(screen.queryByText('Created')).toBeNull() // details of another entry are not shown
    act(() => useFiles.setState({ size: undefined }))
    rerender(<PreviewPane actions={{ open: vi.fn() }} editable={false} browsable={false} />)
    expect(screen.queryAllByText('Size')).toHaveLength(0)
  })

  it('the job list is empty without jobs', () => {
    const { container } = render(<Jobs />)
    expect(container.textContent).toBe('')
  })
})
