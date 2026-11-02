import { useEffect } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, installBridge, installRemote, settle, choose } from './bridge'
import type { Project } from '@shared/types/project'
import type { CursorInfo } from '@/features/editor/components/CodeEditor'
import type { EditorTab } from '@/features/editor/store'

// Monaco itself is covered in editor.test.tsx — here a stand-in shows what it was given.
const flags = vi.hoisted(() => ({ mac: false }))
vi.mock('@/lib/platform', () => ({
  get isMac() {
    return flags.mac
  }
}))
vi.mock('@/features/editor/components/CodeEditor', () => ({
  default: ({ tab, readOnly, onCursor }: { tab?: EditorTab; readOnly: boolean; onCursor: (c: CursorInfo) => void }) => {
    useEffect(() => {
      if (tab && !tab.path.endsWith('.txt')) onCursor({ line: 4, col: 2, language: 'TypeScript' })
    }, [tab?.id])
    return <div data-testid="monaco">{`${tab?.id ?? 'none'}${readOnly ? ' (read-only)' : ''}`}</div>
  }
}))

vi.mock('@/features/editor/components/NotebookView', () => ({
  default: ({ tab, readOnly, onRaw }: { tab: EditorTab; readOnly: boolean; onRaw: () => void }) => (
    <button type="button" onClick={onRaw}>{`notebook ${tab.path}${readOnly ? ' (read-only)' : ''}`}</button>
  )
}))

import { EditorView } from '@/features/editor/components/EditorView'
import { FileTree, fileIcon } from '@/features/editor/components/FileTree'
import { EditorTabs } from '@/features/editor/components/EditorTabs'
import { tabKey, useEditor } from '@/features/editor/store'
import { useProjects } from '@/features/projects/store'
import { useSession } from '@/features/session/store'
import { useDebug } from '@/features/editor/debug'

const initialEditor = useEditor.getState()
const initialProjects = useProjects.getState()
const e = () => useEditor.getState()

const project = (id: string, name = `Project ${id}`): Project => ({ id, name, path: `/x/${id}`, addedAt: '', lastSeenAt: '' })
const entry = (path: string, kind: 'file' | 'dir' = 'file', ignored = false) => ({ name: path.split('/').pop()!, path, kind, ignored })
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

beforeEach(() => {
  useEditor.setState(initialEditor, true)
  useProjects.setState(initialProjects, true)
  useSession.setState({ info: undefined })
  flags.mac = false
})

describe('fileIcon', () => {
  it('groups files into a few calm families', () => {
    expect(['a.json', 'b.md', 'c.png', 'd.tsx', 'e.lock'].map((n) => fileIcon(n).tint)).toEqual([
      'text-amber/80',
      'text-green/80',
      'text-purple/80',
      'text-blue/80',
      'text-text-muted'
    ])
  })
})

describe('FileTree', () => {
  it('shows errors, loading and empty folders', () => {
    const { rerender } = render(<FileTree projectId="p" />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    act(() => useEditor.setState({ tree: { 'p:': [] } }))
    rerender(<FileTree projectId="p" />)
    expect(screen.getByText('This folder is empty.')).toBeInTheDocument()
    act(() => useEditor.setState({ treeError: 'gone' }))
    expect(screen.getByText('gone')).toBeInTheDocument()
  })

  it('expands folders lazily, dims ignored entries, opens files and marks the active one', async () => {
    const bridge = installBridge({
      'files:list': ({ dir }: { dir: string }) => (dir === 'src' ? [entry('src/App.tsx')] : []),
      'files:read': ({ path }: { path: string }) => ({ path, mtimeMs: 1, size: 1, content: 'x' })
    })
    useEditor.setState({
      projectId: 'p',
      tree: { 'p:': [entry('src', 'dir'), entry('node_modules', 'dir', true), entry('debug.log', 'file', true)] },
      expanded: { 'p:node_modules': true } // open, but its listing hasn't arrived yet
    })
    render(<FileTree projectId="p" />)
    const nodeModules = screen.getByRole('treeitem', { name: 'node_modules' })
    expect(nodeModules).toHaveAttribute('aria-expanded', 'true')
    expect(nodeModules.className).toContain('opacity-50')
    expect(screen.getByRole('treeitem', { name: 'debug.log' }).className).toContain('opacity-50')

    fireEvent.click(screen.getByRole('treeitem', { name: 'src' }))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('files:list', { projectId: 'p', dir: 'src' })
    const app = screen.getByRole('treeitem', { name: 'App.tsx' })
    expect(app).toHaveStyle({ paddingLeft: '32px' }) // one level deeper
    fireEvent.click(app)
    await act(settle)
    expect(e().activeId).toBe('p:src/App.tsx')
    expect(screen.getByRole('treeitem', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('treeitem', { name: 'src' })) // fold
    expect(screen.queryByRole('treeitem', { name: 'App.tsx' })).toBeNull()
  })
})

describe('EditorTabs', () => {
  const names = new Map([['p', 'Alpha']])

  it('labels, hints for same-named files, dirty dots and the active marker', () => {
    useEditor.setState({
      tabs: [
        tab('src/index.ts', { dirty: true }),
        tab('lib/index.ts', { deleted: true }),
        tab('README.md'),
        { ...tab('README.md'), id: 'q:README.md', projectId: 'q' },
        { ...tab('README.md'), id: 'r:README.md', projectId: 'r' }
      ],
      activeId: 'p:lib/index.ts'
    })
    render(<EditorTabs projectNames={new Map([...names, ['q', 'Beta']])} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['index.tssrc', 'index.tslib', 'README.mdAlpha', 'README.mdBeta', 'README.md'])
    expect(tabs[4]).toHaveAttribute('title', 'r · README.md') // unknown project: its id
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('index.ts', { selector: '.line-through' })).toBeInTheDocument()
    expect(screen.getAllByLabelText('Unsaved')).toHaveLength(1)
  })

  it('click activates; × and middle-click ask to close (dirty) or close (clean)', () => {
    useEditor.setState({ tabs: [tab('a.ts', { dirty: true }), tab('b.ts'), tab('c.ts')], activeId: 'p:a.ts' })
    render(<EditorTabs projectNames={names} />)
    fireEvent.click(screen.getByText('b.ts'))
    expect(e().activeId).toBe('p:b.ts')
    fireEvent.click(screen.getByLabelText('Close a.ts'))
    expect(e().closing).toBe('p:a.ts')
    expect(e().activeId).toBe('p:b.ts') // the × doesn't activate the tab
    fireEvent.mouseDown(screen.getByText('c.ts'), { button: 0 })
    expect(e().tabs).toHaveLength(3)
    fireEvent.mouseDown(screen.getByText('c.ts'), { button: 1 })
    expect(e().tabs.map((t) => t.name)).toEqual(['a.ts', 'b.ts'])
  })
})

describe('EditorView', () => {
  const view = (active = true, onNavigate = vi.fn()) => <EditorView active={active} onNavigate={onNavigate} />

  it('without projects: nothing until the list arrived, then a way to add one', async () => {
    let release!: () => void
    installBridge({ 'projects:list': () => new Promise((r) => (release = () => r([]))) })
    const onNavigate = vi.fn()
    render(view(true, onNavigate))
    expect(screen.queryByText('No projects yet')).toBeNull()
    await act(async () => {
      await settle(1)
      release()
      await settle()
    })
    fireEvent.click(screen.getByText('Add a project'))
    expect(onNavigate).toHaveBeenCalledWith('projects')
  })

  it('opens the project selected in Projects (else the first); the select and refresh drive the tree', async () => {
    const bridge = installBridge({
      'projects:list': () => [project('p', 'Alpha'), project('q', 'Beta')],
      'files:list': ({ projectId }: { projectId: string }) => [entry(`${projectId}-file.ts`)],
      'files:stat': () => []
    })
    useProjects.setState({ projects: [project('p', 'Alpha'), project('q', 'Beta')], selectedId: 'q' })
    render(view())
    await act(settle)
    expect(e().projectId).toBe('q')
    expect(screen.getByRole('treeitem', { name: 'q-file.ts' })).toBeInTheDocument()

    choose('Project', /^Alpha/)
    await act(settle)
    expect(screen.getByRole('treeitem', { name: 'p-file.ts' })).toBeInTheDocument()
    bridge.invoke.mockClear()
    fireEvent.click(screen.getByLabelText('Refresh files'))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('files:list', { projectId: 'p', dir: '' })

    // a project removed elsewhere: the editor moves to one that exists
    act(() => useProjects.setState({ projects: [project('q', 'Beta')], selectedId: 'gone' }))
    await act(settle)
    expect(e().projectId).toBe('q')
  })

  it('placeholders: welcome, loading, binary / too large (with VS Code), errors with retry', async () => {
    const bridge = installBridge({
      'projects:list': () => [project('p')],
      'files:list': () => [],
      'files:stat': () => [],
      'files:read': () => fail('EACCES'),
      'projects:openFile': () => fail('no code')
    })
    useProjects.setState({ projects: [project('p')] })
    render(view())
    await act(settle)
    expect(screen.getByText('Open a file from the explorer')).toBeInTheDocument()
    expect(screen.getByText(/Ctrl\+S save/)).toBeInTheDocument()
    expect(screen.getByTestId('monaco')).toHaveTextContent('none')

    act(() => useEditor.setState({ tabs: [tab('a.ts', { loading: true, content: undefined })], activeId: 'p:a.ts' }))
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    act(() => useEditor.setState({ tabs: [tab('a.png', { content: undefined, unsupported: 'binary' })], activeId: 'p:a.png' }))
    expect(screen.getByText('Binary file')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Open in VS Code'))
    await act(settle) // its failure is swallowed
    expect(bridge.invoke).toHaveBeenCalledWith('projects:openFile', { id: 'p', file: 'a.png', line: 4 })
    act(() => useEditor.setState({ tabs: [tab('big.log', { content: undefined, unsupported: 'too-large' })], activeId: 'p:big.log' }))
    expect(screen.getByText('Larger than 5 MB')).toBeInTheDocument()
    act(() => useEditor.setState({ tabs: [tab('bad.ts', { content: undefined, error: 'EACCES' })], activeId: 'p:bad.ts' }))
    expect(screen.getByText("Couldn't open this file")).toBeInTheDocument()
    fireEvent.click(screen.getByText('Try again'))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('files:read', { projectId: 'p', path: 'bad.ts' })
  })

  it('on macOS the hints use ⌘; VS Code opens the project when no file is open', async () => {
    flags.mac = true
    const bridge = installBridge({ 'projects:list': () => [project('p')], 'files:list': () => [], 'files:stat': () => [] })
    useProjects.setState({ projects: [project('p')] })
    render(view())
    await act(settle)
    expect(screen.getByText(/⌘S save/)).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Open in VS Code'))
    expect(bridge.invoke).toHaveBeenCalledWith('projects:openInEditor', { id: 'p' })
  })

  it('banners: save before closing, conflicts, deleted files, save errors; status bar states', async () => {
    const bridge = installBridge({ 'projects:list': () => [project('p', 'Alpha')], 'files:list': () => [], 'files:stat': () => [] })
    useProjects.setState({ projects: [project('p', 'Alpha')] })
    const save = vi.fn(async () => true)
    const reload = vi.fn(async () => {})
    const saveAndClose = vi.fn(async () => {})
    render(view())
    await act(settle)
    useEditor.setState({ save, reload, saveAndClose })

    act(() => useEditor.setState({ tabs: [tab('src/a.ts', { dirty: true }), tab('b.txt')], activeId: 'p:src/a.ts', closing: 'p:b.txt' }))
    expect(screen.getByText('Save changes to b.txt before closing?')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Save'))
    expect(saveAndClose).toHaveBeenCalledWith('p:b.txt')
    fireEvent.click(screen.getByText('Cancel'))
    expect(e().closing).toBeUndefined()
    act(() => useEditor.setState({ closing: 'p:b.txt' }))
    fireEvent.click(screen.getByText("Don't save"))
    expect(e().tabs.map((t) => t.name)).toEqual(['a.ts'])

    expect(screen.getByText('Alpha › src › a.ts')).toBeInTheDocument()
    expect(screen.getByText('Ln 4, Col 2')).toBeInTheDocument()
    expect(screen.getByText('TypeScript')).toBeInTheDocument()
    expect(screen.getByText('Unsaved')).toHaveClass('text-amber')

    act(() => useEditor.setState({ tabs: [tab('src/a.ts', { dirty: true, conflict: true })] }))
    expect(screen.getByText('a.ts changed on disk while you were editing.')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Load disk version'))
    expect(reload).toHaveBeenCalledWith('p:src/a.ts')
    fireEvent.click(screen.getByText('Keep mine'))
    expect(save).toHaveBeenCalledWith('p:src/a.ts', { force: true })

    act(() => useEditor.setState({ tabs: [tab('src/a.ts', { deleted: true, saving: true })] }))
    expect(screen.getByText('a.ts was deleted on disk — saving creates it again.')).toBeInTheDocument()
    expect(screen.getByText('Saving…')).toBeInTheDocument()
    act(() => useEditor.setState({ tabs: [tab('src/a.ts', { error: 'EROFS: read-only file system' })] }))
    expect(screen.getByText('EROFS: read-only file system')).toBeInTheDocument()
    expect(screen.getByText('Saved')).toBeInTheDocument()
    expect(bridge.invoke).not.toHaveBeenCalledWith('files:write', expect.anything())
  })

  it('notebooks show as notebooks over their file (both sides of a split), or as JSON', async () => {
    installBridge({ 'projects:list': () => [project('p')], 'files:list': () => [], 'files:stat': () => [] })
    useProjects.setState({ projects: [project('p')] })
    useEditor.setState({ tabs: [tab('a.ipynb'), tab('b.IPYNB'), tab('c.ipynb', { content: undefined, loading: true })], activeId: 'p:a.ipynb', splitId: 'p:b.IPYNB' })
    render(view())
    await act(settle)
    expect(await screen.findByText('notebook a.ipynb')).toBeInTheDocument()
    expect(await screen.findByText('notebook b.IPYNB')).toBeInTheDocument()
    fireEvent.click(screen.getByText('notebook a.ipynb'))
    expect(screen.queryByText('notebook a.ipynb')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show as notebook' }))
    expect(await screen.findByText('notebook a.ipynb')).toBeInTheDocument()
    // Still loading: no notebook yet.
    act(() => useEditor.setState({ activeId: 'p:c.ipynb', splitId: undefined }))
    expect(screen.queryByText(/^notebook/)).toBeNull()
  })

  it('a file without cursor info yet shows only its path and state', async () => {
    installBridge({ 'projects:list': () => [project('p')], 'files:list': () => [], 'files:stat': () => [] })
    useProjects.setState({ projects: [project('p')] })
    useEditor.setState({ tabs: [tab('notes.txt')], activeId: 'p:notes.txt' })
    render(view())
    await act(settle)
    expect(screen.getByText('Saved')).toBeInTheDocument()
    expect(screen.queryByText(/^Ln /)).toBeNull()
  })

  it('F9 sets the breakpoint on the cursor line; the cursor goes with the view', async () => {
    installBridge({ 'projects:list': () => [project('p')], 'files:list': () => [], 'files:stat': () => [] })
    useProjects.setState({ projects: [project('p')] })
    useDebug.setState({ breakpoints: {} })
    useEditor.setState({ tabs: [tab('a.ts')], activeId: 'p:a.ts' })
    const { unmount } = render(view())
    await act(settle)
    expect(screen.getByText('Ln 4, Col 2')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'F9' })
    expect(useDebug.getState().breakpoints.p).toEqual([{ path: 'a.ts', line: 4 }])
    unmount()

    // A new view on a file that reported no cursor yet: not the old line 4, the first line.
    useEditor.setState({ tabs: [tab('notes.txt')], activeId: 'p:notes.txt' })
    render(view())
    await act(settle)
    fireEvent.keyDown(window, { key: 'F9' })
    expect(useDebug.getState().breakpoints.p).toEqual([
      { path: 'a.ts', line: 4 },
      { path: 'notes.txt', line: 1 }
    ])
  })

  it('while visible: follows the disk (now, every 3 s, on focus) and saves on ⌘S / Ctrl+S', async () => {
    vi.useFakeTimers()
    installBridge({ 'projects:list': () => [project('p')], 'files:list': () => [] })
    useProjects.setState({ projects: [project('p')] })
    const checkDisk = vi.fn(async () => {})
    const save = vi.fn(async () => true)
    useEditor.setState({ checkDisk, save })
    const { rerender } = render(view(true))
    expect(checkDisk).toHaveBeenCalledTimes(1)
    // Still in flight: a focus doesn't start a second check on top of it.
    fireEvent.focus(window)
    expect(checkDisk).toHaveBeenCalledTimes(1)
    await act(async () => {})
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(checkDisk).toHaveBeenCalledTimes(2)
    await act(async () => {})
    fireEvent.focus(window)
    expect(checkDisk).toHaveBeenCalledTimes(3)
    await act(async () => {})

    fireEvent.keyDown(window, { key: 's', metaKey: true })
    fireEvent.keyDown(window, { key: 'S', ctrlKey: true })
    fireEvent.keyDown(window, { key: 's' })
    fireEvent.keyDown(window, { key: 'x', metaKey: true })
    expect(save).toHaveBeenCalledTimes(2)

    rerender(view(false)) // hidden: no polling, no shortcut
    act(() => {
      vi.advanceTimersByTime(9000)
    })
    fireEvent.focus(window)
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    expect(checkDisk).toHaveBeenCalledTimes(3)
    expect(save).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('unsaved edits veto closing the window', async () => {
    installBridge({ 'projects:list': () => [] })
    const { unmount } = render(view(false))
    await act(settle)
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)
    act(() => useEditor.setState({ tabs: [tab('a.ts', { dirty: true })] }))
    const dirty = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    window.dispatchEvent(dirty)
    expect(dirty.defaultPrevented).toBe(true)
    unmount()
    const after = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })

  it('in a browser: no VS Code; read-only when the core does not allow remote edits', async () => {
    installRemote({ 'projects:list': () => [project('p')], 'files:list': () => [], 'files:stat': () => [] })
    useSession.setState({ info: { mode: 'server', version: '1', platform: 'linux', hostname: 'nas', remoteTerminal: false } })
    useProjects.setState({ projects: [project('p')] })
    useEditor.setState({
      tabs: [tab('a.ts', { conflict: true, dirty: true }), tab('b.png', { content: undefined, unsupported: 'binary' })],
      activeId: 'p:a.ts'
    })
    render(view())
    await act(settle)
    expect(screen.queryByTitle('Open in VS Code')).toBeNull()
    expect(screen.getByTestId('monaco')).toHaveTextContent('p:a.ts (read-only)')
    expect(screen.getByText('Read-only')).toBeInTheDocument()
    expect(screen.getByText('Keep mine')).toBeDisabled()
    // Read-only: the palette has nothing that writes or runs code.
    fireEvent.keyDown(window, { key: 'P', metaKey: true, shiftKey: true })
    const labels = screen.getAllByRole('option').map((o) => o.textContent)
    expect(labels.some((l) => l!.startsWith('Debug:'))).toBe(false)
    expect(labels).not.toContain('File: Save⌘S')
    fireEvent.keyDown(screen.getByRole('dialog').querySelector('input')!, { key: 'Escape' })
    act(() => useEditor.setState({ activeId: 'p:b.png' }))
    expect(screen.getByText('Binary file')).toBeInTheDocument()
    expect(screen.queryByText('Open in VS Code')).toBeNull()

    act(() => useSession.setState({ info: { mode: 'server', version: '1', platform: 'linux', hostname: 'nas', remoteTerminal: true } }))
    act(() => useEditor.setState({ activeId: 'p:a.ts' }))
    expect(screen.getByTestId('monaco')).toHaveTextContent(/^p:a\.ts$/)
  })
})
