import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, installBridge, settle } from './bridge'
import { FileTree, flattenTree } from '@/features/editor/components/FileTree'
import { oneGroup, setBufferHost, tabKey, useEditor, type BufferHost, type EditorTab } from '@/features/editor/store'
import { useLive } from '@/features/editor/live'

const flags = vi.hoisted(() => ({ mac: true }))
vi.mock('@/lib/platform', () => ({
  get isMac() {
    return flags.mac
  }
}))

const initial = useEditor.getState()
const e = () => useEditor.getState()
const entry = (path: string, kind: 'file' | 'dir' = 'file') => ({ name: path.split('/').pop()!, path, kind, ignored: false })
const tab = (path: string, over: Partial<EditorTab> = {}): EditorTab => ({
  id: tabKey('p', path),
  projectId: 'p',
  path,
  name: path.split('/').pop()!,
  loading: false,
  content: 'x',
  mtimeMs: 1,
  revision: 1,
  dirty: false,
  saving: false,
  conflict: false,
  deleted: false,
  ...over
})
const host = () => ({
  snapshot: vi.fn<BufferHost['snapshot']>(),
  markClean: vi.fn<BufferHost['markClean']>(),
  drop: vi.fn<BufferHost['drop']>(),
  rekey: vi.fn<BufferHost['rekey']>()
})

/** A project tree the file routes answer from. */
function routes(extra: Record<string, (p: never) => unknown> = {}) {
  return installBridge({
    'files:list': ({ dir }: { dir: string }) => (dir === 'src' ? [entry('src/a.ts')] : [entry('src', 'dir'), entry('README.md')]),
    'files:read': ({ path }: { path: string }) => ({ path, mtimeMs: 1, size: 0, content: '' }),
    'files:create': () => undefined,
    'files:rename': () => undefined,
    'files:delete': () => undefined,
    ...extra
  })
}

beforeEach(() => {
  useEditor.setState(initial, true)
  useEditor.setState({ projectId: 'p' })
  setBufferHost(null)
  flags.mac = true
})

describe('explorer store', () => {
  it('names new entries inside the selected folder, next to a selected file, else at the root', async () => {
    const bridge = routes()
    await e().startNaming('file')
    expect(e().naming).toEqual({ mode: 'file', dir: '' })

    e().select('src', 'dir')
    await e().startNaming('dir')
    expect(e().naming).toEqual({ mode: 'dir', dir: 'src' })
    expect(e().expanded['p:src']).toBe(true) // the folder opens to show the field
    expect(bridge.invoke).toHaveBeenCalledWith('files:list', { projectId: 'p', dir: 'src' })

    await e().startNaming('file', { path: 'src/a.ts', kind: 'file' })
    expect(e().naming).toEqual({ mode: 'file', dir: 'src' }) // already open: no second listing
    expect(bridge.invoke.mock.calls.filter(([c]) => c === 'files:list')).toHaveLength(1)

    e().cancelNaming()
    expect(e().naming).toBeUndefined()
  })

  it('renames the selection (nothing selected → nothing to rename)', async () => {
    await e().startNaming('rename')
    expect(e().naming).toBeUndefined()
    await e().startNaming('rename', { path: 'src/a.ts', kind: 'file' })
    expect(e().naming).toEqual({ mode: 'rename', dir: 'src', path: 'src/a.ts' })
    expect(e().selection).toEqual({ path: 'src/a.ts', kind: 'file' })
  })

  it('submit: refuses bad names, skips unchanged ones, and shows what the core refused', async () => {
    routes({ 'files:create': () => fail('src/x.ts already exists', 'exists') })
    await e().submitName('x') // no field open
    for (const bad of ['', '  ', 'a/../b', './x', 'a//b']) {
      useEditor.setState({ naming: { mode: 'file', dir: 'src' } })
      await e().submitName(bad)
      expect(e().naming?.error).toBe('invalid-name')
    }
    useEditor.setState({ naming: { mode: 'file', dir: 'src' } })
    await e().submitName('x.ts')
    expect(e().naming).toEqual({ mode: 'file', dir: 'src', error: 'src/x.ts already exists' })

    useEditor.setState({ naming: { mode: 'rename', dir: 'src', path: 'src/a.ts' } })
    await e().submitName(' a.ts ')
    expect(e().naming).toBeUndefined()
  })

  it('creates a file (and opens it) or a folder at the root or inside one', async () => {
    const bridge = routes()
    useEditor.setState({ naming: { mode: 'file', dir: '' } })
    await e().submitName('/notes/todo.md/')
    expect(bridge.invoke).toHaveBeenCalledWith('files:create', { projectId: 'p', path: 'notes/todo.md', kind: 'file' })
    expect(e().activeId).toBe('p:notes/todo.md')
    expect(e().selection).toEqual({ path: 'notes/todo.md', kind: 'file' })

    useEditor.setState({ naming: { mode: 'dir', dir: 'src' } })
    await e().submitName('lib')
    expect(bridge.invoke).toHaveBeenCalledWith('files:create', { projectId: 'p', path: 'src/lib', kind: 'dir' })
    expect(e().selection).toEqual({ path: 'src/lib', kind: 'dir' })
    expect(e().tabs).toHaveLength(1)
  })

  it('renaming carries open tabs along — the file itself, everything in a renamed folder, the active one', async () => {
    const bridge = routes()
    const h = host()
    setBufferHost(h)
    useEditor.setState({
      tabs: [tab('src/a.ts', { dirty: true }), tab('src/deep/b.ts'), tab('srcx.ts'), { ...tab('src/a.ts'), id: 'q:src/a.ts', projectId: 'q' }],
      ...oneGroup(['p:src/a.ts', 'p:src/deep/b.ts', 'p:srcx.ts'], 'p:src/deep/b.ts'),
      selection: { path: 'src', kind: 'dir' },
      naming: { mode: 'rename', dir: '', path: 'src' }
    })
    await e().submitName('lib')
    expect(bridge.invoke).toHaveBeenCalledWith('files:rename', { projectId: 'p', from: 'src', to: 'lib' })
    expect(e().tabs.map((t) => `${t.id} ${t.name}${t.dirty ? ' *' : ''}`)).toEqual(['p:lib/a.ts a.ts *', 'p:lib/deep/b.ts b.ts', 'p:srcx.ts srcx.ts', 'q:src/a.ts a.ts'])
    expect(e().activeId).toBe('p:lib/deep/b.ts')
    expect(h.rekey).toHaveBeenCalledWith('p:src/a.ts', { id: 'p:lib/a.ts', projectId: 'p', path: 'lib/a.ts' })
    expect(e().selection).toEqual({ path: 'lib', kind: 'dir' })

    // Without a buffer host (Monaco not loaded yet) the tabs still move.
    setBufferHost(null)
    useEditor.setState({ naming: { mode: 'rename', dir: 'lib', path: 'lib/a.ts' }, selection: { path: 'lib/a.ts', kind: 'file' } })
    await e().submitName('z.ts')
    expect(e().tabs[0].id).toBe('p:lib/z.ts')
    expect(e().activeId).toBe('p:lib/deep/b.ts')
  })

  it('deletes after asking: clean tabs of it close, unsaved ones stay, the selection clears', async () => {
    const bridge = routes()
    useEditor.setState({ tabs: [tab('src/a.ts'), tab('src/b.ts', { dirty: true }), tab('README.md')], selection: { path: 'src/a.ts', kind: 'file' } })
    await e().confirmDelete() // nothing asked
    expect(bridge.invoke).not.toHaveBeenCalledWith('files:delete', expect.anything())

    e().requestDelete('src')
    expect(e().deleting).toBe('src')
    e().cancelDelete()
    expect(e().deleting).toBeUndefined()

    e().requestDelete() // the selection
    expect(e().deleting).toBe('src/a.ts')
    e().requestDelete('src')
    await e().confirmDelete()
    expect(bridge.invoke).toHaveBeenCalledWith('files:delete', { projectId: 'p', path: 'src' })
    expect(e().tabs.map((t) => t.path)).toEqual(['src/b.ts', 'README.md'])
    expect(e().selection).toBeUndefined()

    useEditor.setState({ selection: { path: 'README.md', kind: 'file' } })
    e().requestDelete('src/b.ts')
    await e().confirmDelete()
    expect(e().selection).toEqual({ path: 'README.md', kind: 'file' })
  })

  it('a failed delete shows the error until dismissed; collapse folds only this project', async () => {
    routes({ 'files:delete': () => fail('gone', 'not-found') })
    e().requestDelete('x')
    await e().confirmDelete()
    expect(e().fileError).toBe('gone')
    e().clearFileError()
    expect(e().fileError).toBeUndefined()

    useEditor.setState({ expanded: { 'p:src': true, 'p:src/deep': true, 'q:src': true } })
    e().collapseAll()
    expect(e().expanded).toEqual({ 'q:src': true })
  })
})

describe('explorer view', () => {
  const show = (readOnly = false) => {
    useEditor.setState({ tree: { 'p:': [entry('src', 'dir'), entry('README.md')], 'p:src': [entry('src/a.ts')] }, expanded: { 'p:src': true } })
    return render(<FileTree projectId="p" readOnly={readOnly} />)
  }

  it('toolbar: new file and folder at the selection, collapse all', async () => {
    routes()
    show()
    fireEvent.click(screen.getByRole('treeitem', { name: 'src' }))
    expect(e().selection).toEqual({ path: 'src', kind: 'dir' })
    fireEvent.click(screen.getByRole('treeitem', { name: 'src' })) // open again
    await act(settle)
    fireEvent.click(screen.getByRole('button', { name: 'New File' }))
    await act(settle)
    expect(e().naming).toEqual({ mode: 'file', dir: 'src' })
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'New Folder' }))
    await act(settle)
    expect(e().naming).toEqual({ mode: 'dir', dir: 'src' })

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Folders' }))
    expect(e().expanded).toEqual({})
  })

  it('the name field: Enter creates, a refused name stays open with the error, typing clears it', async () => {
    const bridge = routes({ 'files:create': () => fail('taken', 'exists') })
    show()
    act(() => useEditor.setState({ naming: { mode: 'file', dir: '' } }))
    const input = screen.getByRole('textbox', { name: 'Name' })
    fireEvent.change(input, { target: { value: 'x.ts' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(settle)
    expect(screen.getByRole('alert')).toHaveTextContent('taken')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    fireEvent.blur(input) // an error keeps the field (no second try on blur)
    expect(bridge.invoke.mock.calls.filter(([c]) => c === 'files:create')).toHaveLength(1)

    fireEvent.change(input, { target: { value: 'y.ts' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(input, { target: { value: 'z.ts' } }) // no error to clear
    fireEvent.keyDown(input, { key: 'a' })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input) // leaving while it's being created: not a second try
    await act(settle)
    expect(bridge.invoke).toHaveBeenLastCalledWith('files:create', { projectId: 'p', path: 'z.ts', kind: 'file' })
    expect(bridge.invoke.mock.calls.filter(([c, p]) => c === 'files:create' && (p as { path: string }).path === 'z.ts')).toHaveLength(1)
  })

  it('the name field: bad names explain themselves; Escape cancels; leaving it empty cancels; leaving it applies', async () => {
    const bridge = routes()
    show()
    act(() => useEditor.setState({ naming: { mode: 'dir', dir: 'src' } }))
    let input = screen.getByRole('textbox', { name: 'Name' })
    fireEvent.change(input, { target: { value: '..' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(settle)
    expect(screen.getByRole('alert')).toHaveTextContent('Not a valid file or folder name.')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(e().naming).toBeUndefined()

    act(() => useEditor.setState({ naming: { mode: 'file', dir: '' } }))
    fireEvent.blur(screen.getByRole('textbox', { name: 'Name' }))
    expect(e().naming).toBeUndefined()

    act(() => useEditor.setState({ naming: { mode: 'file', dir: '' } }))
    input = screen.getByRole('textbox', { name: 'Name' })
    fireEvent.change(input, { target: { value: 'new.ts' } })
    fireEvent.blur(input)
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('files:create', { projectId: 'p', path: 'new.ts', kind: 'file' })
  })

  it('renaming in place selects the name without its extension', async () => {
    routes()
    show()
    act(() => useEditor.setState({ naming: { mode: 'rename', dir: '', path: 'README.md' }, selection: { path: 'README.md', kind: 'file' } }))
    const input = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
    expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['README.md', 0, 6])
    expect(screen.queryByRole('treeitem', { name: 'README.md' })).toBeNull()

    act(() => useEditor.setState({ naming: { mode: 'rename', dir: '', path: 'src' }, selection: { path: 'src', kind: 'dir' } }))
    const folder = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
    expect([folder.value, folder.selectionEnd]).toEqual(['src', 3])
  })

  it('context menu: every action on an entry, only "new" on empty space, nothing editable read-only', async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    routes()
    const view = show()
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'a.ts' }))
    expect(e().selection).toEqual({ path: 'src/a.ts', kind: 'file' })
    const menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['New File', 'New Folder', 'RenameF2', 'Copy Relative Path', 'Open to the Side', 'Delete⌘⌫'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy Relative Path' }))
    expect(writeText).toHaveBeenCalledWith('src/a.ts')
    expect(screen.queryByRole('menu')).toBeNull()
    const toSide = vi.spyOn(useEditor.getState(), 'openToSide').mockResolvedValue()
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'a.ts' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open to the Side' }))
    expect(toSide).toHaveBeenCalledWith('src/a.ts')
    // A folder doesn't open to the side.
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'src' }))
    expect(screen.queryByRole('menuitem', { name: 'Open to the Side' })).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'a.ts' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Rename/ }))
    await act(settle)
    expect(e().naming).toEqual({ mode: 'rename', dir: 'src', path: 'src/a.ts' })
    act(() => e().cancelNaming())

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'src' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'New File' }))
    await act(settle)
    expect(e().naming).toEqual({ mode: 'file', dir: 'src' })
    act(() => e().cancelNaming())

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'README.md' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Folder' }))
    await act(settle)
    expect(e().naming).toEqual({ mode: 'dir', dir: '' })
    act(() => e().cancelNaming())

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'README.md' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }))
    expect(e().deleting).toBe('README.md')
    act(() => e().cancelDelete())

    // Empty space: only creating.
    fireEvent.contextMenu(screen.getByRole('tree'))
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['New File', 'New Folder'])
    fireEvent.keyDown(window, { key: 'x' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'a.ts' }))
    fireEvent.mouseDown(screen.getByRole('menu'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()

    view.unmount()
    flags.mac = false
    show(true)
    expect(screen.queryByRole('button', { name: 'New File' })).toBeNull()
    fireEvent.contextMenu(screen.getByRole('tree'))
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'a.ts' }))
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Copy Relative Path', 'Open to the Side'])
  })

  it('keys: F2 renames, Delete / ⌘⌫ ask to delete — only with a selection and when editable', async () => {
    routes()
    const view = show()
    const tree = screen.getByRole('tree')
    fireEvent.keyDown(tree, { key: 'F2' })
    expect(e().naming).toBeUndefined()
    act(() => e().select('README.md', 'file'))
    fireEvent.keyDown(tree, { key: 'Backspace' })
    expect(e().deleting).toBeUndefined()
    fireEvent.keyDown(tree, { key: 'F2' })
    await act(settle)
    expect(e().naming?.mode).toBe('rename')
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Delete' }) // typing in the field stays there
    expect(e().deleting).toBeUndefined()
    act(() => e().cancelNaming())
    fireEvent.keyDown(tree, { key: 'Delete' })
    expect(e().deleting).toBe('README.md')
    act(() => e().cancelDelete())
    fireEvent.keyDown(tree, { key: 'Backspace', metaKey: true })
    expect(e().deleting).toBe('README.md')
    act(() => e().cancelDelete())
    fireEvent.keyDown(tree, { key: 'Backspace', ctrlKey: true })
    expect(e().deleting).toBe('README.md')
    act(() => e().cancelDelete())

    view.unmount()
    show(true)
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Delete' })
    expect(e().deleting).toBeUndefined()
  })

  it('the delete prompt and file errors', async () => {
    const bridge = routes()
    show()
    act(() => useEditor.setState({ deleting: 'src/a.ts' }))
    const prompt = screen.getByRole('alertdialog')
    expect(prompt).toHaveTextContent('Move “a.ts” to the trash?')
    fireEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }))
    expect(e().deleting).toBeUndefined()

    act(() => useEditor.setState({ deleting: 'README.md' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('files:delete', { projectId: 'p', path: 'README.md' })

    act(() => useEditor.setState({ fileError: 'disk full' }))
    expect(screen.getByRole('alert')).toHaveTextContent('disk full')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('an empty project still takes a new file', () => {
    useEditor.setState({ tree: { 'p:': [] } })
    render(<FileTree projectId="p" />)
    expect(screen.getByText('This folder is empty.')).toBeInTheDocument()
    act(() => useEditor.setState({ naming: { mode: 'file', dir: '' } }))
    expect(screen.queryByText('This folder is empty.')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument()
  })

  it('an HTML file opens with Live Server from its menu', () => {
    const start = vi.spyOn(useLive.getState(), 'start').mockResolvedValue()
    useEditor.setState({ tree: { 'p:': [entry('index.html'), entry('a.ts')] } })
    render(<FileTree projectId="p" />)
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'a.ts' }))
    expect(screen.queryByRole('menuitem', { name: 'Open with Live Server' })).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'index.html' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open with Live Server' }))
    expect(start).toHaveBeenCalledWith('index.html')
  })

})

describe('explorer: a windowed tree', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => entry(`f${String(i).padStart(5, '0')}.ts`))
  /** The scroll area as the browser lays it out: `height` px tall, scrolled to `top`. */
  const layout = (height: number, top = 0) => {
    const tree = screen.getByRole('tree')
    Object.defineProperty(tree, 'clientHeight', { value: height, configurable: true })
    tree.scrollTop = top
    fireEvent.scroll(tree)
    return tree
  }
  const names = () => screen.getAllByRole('treeitem').map((i) => i.textContent)
  const gaps = () => [...screen.getByRole('tree').querySelectorAll<HTMLElement>('[aria-hidden]')].map((g) => g.style.height)

  it('flattens open folders into rows: a new name leads its folder, a folder being renamed hides its listing', () => {
    const tree = { 'p:': [entry('src', 'dir'), entry('README.md')], 'p:src': [entry('src/a.ts')] }
    const rows = flattenTree('p', tree, { 'p:src': true }, { mode: 'file', dir: 'src' })
    expect(rows.map((r) => (r.type === 'create' ? `+${r.dir}@${r.depth}` : `${r.entry.path}@${r.depth} ${r.pos}/${r.size}`))).toEqual([
      'src@0 1/2',
      '+src@1',
      'src/a.ts@1 1/1',
      'README.md@0 2/2'
    ])
    expect(flattenTree('p', tree, { 'p:src': true }, { mode: 'rename', dir: '', path: 'src' }).map((r) => r.type === 'entry' && [r.entry.path, r.renaming])).toEqual([
      ['src', true],
      ['README.md', false]
    ])
    // Open, but not listed yet: nothing below it.
    expect(flattenTree('p', { 'p:': tree['p:'] }, { 'p:src': true })).toHaveLength(2)
  })

  it('10 000 entries render only the rows in view — each still says where it sits', () => {
    useEditor.setState({ tree: { 'p:': many(10_000) } })
    render(<FileTree projectId="p" />)
    const first = screen.getAllByRole('treeitem')
    expect(first.length).toBeGreaterThan(30)
    expect(first.length).toBeLessThan(60) // no layout yet: a typical window
    expect(first[0]).toHaveAttribute('aria-level', '1')
    expect(first[0]).toHaveAttribute('aria-setsize', '10000')
    expect(first[0]).toHaveAttribute('aria-posinset', '1')
    expect(first[0]).toHaveAttribute('tabindex', '0') // nothing selected: the first row is the tree's Tab stop
    expect(first[1]).toHaveAttribute('tabindex', '-1')

    layout(240, 5000 * 24) // ten rows tall, scrolled half-way
    const items = screen.getAllByRole('treeitem')
    expect(items.length).toBeLessThan(40)
    expect(names()).toContain('f05000.ts')
    expect(names()).toContain('f04992.ts') // a few above and below, for smooth scrolling
    expect(names()).not.toContain('f04991.ts')
    expect(names()[0]).toBe('f00000.ts') // the Tab stop stays
    expect(screen.getByRole('treeitem', { name: 'f05000.ts' })).toHaveAttribute('aria-posinset', '5001')
    // Spacers stand in for the rows between: the list keeps its full height.
    expect(gaps()).toEqual([`${4991 * 24}px`, `${(10_000 - 5018) * 24}px`])
  })

  it('the selection and a name being typed stay mounted when scrolled away', async () => {
    routes()
    useEditor.setState({ tree: { 'p:': many(10_000) } })
    render(<FileTree projectId="p" />)
    fireEvent.click(screen.getByRole('treeitem', { name: 'f00003.ts' }))
    const selected = screen.getByRole('treeitem', { name: 'f00003.ts' })
    selected.focus()
    expect(selected).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('treeitem', { name: 'f00000.ts' })).toHaveAttribute('tabindex', '-1')
    layout(240, 5000 * 24)
    expect(screen.getByRole('treeitem', { name: 'f00003.ts' })).toBe(selected)
    expect(selected).toHaveFocus()
    expect(screen.queryByRole('treeitem', { name: 'f00000.ts' })).toBeNull()
    expect(gaps()[0]).toBe(`${3 * 24}px`)

    fireEvent.keyDown(screen.getByRole('tree'), { key: 'F2' })
    await act(settle)
    const input = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
    expect(screen.getByRole('tree').scrollTop).toBe(3 * 24) // brought into view
    fireEvent.change(input, { target: { value: 'half' } })
    layout(240, 9000 * 24)
    expect(screen.getByRole('textbox', { name: 'Name' })).toBe(input)
    expect(input.value).toBe('half')
  })

  it('keys: ↑/↓, Home/End move; → opens and steps in, ← folds and steps out; Enter opens — the focus follows, the view scrolls', async () => {
    const bridge = routes()
    useEditor.setState({ tree: { 'p:': [entry('src', 'dir'), entry('README.md')], 'p:src': [entry('src/a.ts')] }, expanded: { 'p:src': true } })
    render(<FileTree projectId="p" readOnly />)
    const tree = layout(48) // two rows tall
    const press = (key: string) => {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      act(() => void (document.activeElement && tree.contains(document.activeElement) ? document.activeElement : tree).dispatchEvent(ev))
      return ev.defaultPrevented
    }
    const at = () => e().selection?.path
    expect(screen.getByRole('treeitem', { name: 'a.ts' })).toHaveAttribute('aria-level', '2')
    expect(screen.getByRole('treeitem', { name: 'README.md' })).toHaveAttribute('aria-posinset', '2')

    expect(press('ArrowDown')).toBe(true) // nothing selected: the first row
    expect(at()).toBe('src')
    expect(screen.getByRole('treeitem', { name: 'src' })).toHaveFocus()
    press('ArrowDown')
    expect(at()).toBe('src/a.ts')
    expect(screen.getByRole('treeitem', { name: 'a.ts' })).toHaveFocus()
    press('End')
    expect(at()).toBe('README.md')
    expect(tree.scrollTop).toBe(24) // the third row brought into view
    expect(press('ArrowDown')).toBe(true) // the last row: stays
    expect(at()).toBe('README.md')
    press('ArrowLeft') // a top-level row: no parent to step out to
    expect(at()).toBe('README.md')
    press('ArrowUp')
    expect(at()).toBe('src/a.ts')
    expect(press('ArrowRight')).toBe(false) // a file: nothing to open
    press('ArrowLeft') // steps out to its folder
    expect(at()).toBe('src')
    expect(screen.getByRole('treeitem', { name: 'src' })).toHaveFocus()
    press('ArrowUp') // the first row: stays
    press('ArrowLeft') // folds
    expect(e().expanded).toEqual({})
    expect(screen.queryByRole('treeitem', { name: 'a.ts' })).toBeNull()
    press('ArrowRight') // opens (and lists)
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('files:list', { projectId: 'p', dir: 'src' })
    expect(e().expanded).toEqual({ 'p:src': true })
    expect(at()).toBe('src')
    press('ArrowRight') // open: steps in
    expect(at()).toBe('src/a.ts')
    press('Home')
    expect(at()).toBe('src')
    press('Enter') // a folder: folds
    expect(e().expanded).toEqual({})
    press('End')
    press('Enter') // a file: opens
    await act(settle)
    expect(e().activeId).toBe('p:README.md')
    expect(press('F2')).toBe(false) // read-only: no renaming
    expect(press('x')).toBe(false)

    act(() => useEditor.setState({ selection: undefined }))
    tree.focus()
    press('ArrowUp') // nothing selected: the first row
    expect(at()).toBe('src')
  })

  it('keys pass over the field naming a new entry', () => {
    useEditor.setState({ tree: { 'p:': [entry('a.ts'), entry('b.ts')] }, naming: { mode: 'file', dir: '' } })
    render(<FileTree projectId="p" />)
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Home' })
    expect(e().selection?.path).toBe('a.ts')
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'ArrowUp' })
    expect(e().selection?.path).toBe('a.ts')
  })

  it('→ on an open, empty folder at the end stays put', () => {
    useEditor.setState({ tree: { 'p:': [entry('empty', 'dir')], 'p:empty': [] }, expanded: { 'p:empty': true }, selection: { path: 'empty', kind: 'dir' } })
    render(<FileTree projectId="p" />)
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'ArrowRight' })
    expect(e().selection?.path).toBe('empty')
    expect(e().expanded).toEqual({ 'p:empty': true })
  })
})
