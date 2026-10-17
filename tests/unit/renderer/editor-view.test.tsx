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
import { oneGroup, tabKey, useEditor, type EditorTab as Tab } from '@/features/editor/store'
import { useProjects } from '@/features/projects/store'
import { useSession } from '@/features/session/store'
import { PaneContext } from '@/features/workspace/pane'
import { allCommands } from '@/features/palette/registry'
import { en } from '@/lib/i18n/en'

const initialEditor = useEditor.getState()
/** Open files, all in one group, `active` shown. */
const seed = (tabs: Tab[], active = tabs[0]?.id) => ({ tabs, ...oneGroup(tabs.map((t) => t.id), active) })
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
    useEditor.setState(
      seed(
        [
          tab('src/index.ts', { dirty: true }),
          tab('lib/index.ts', { deleted: true }),
          tab('README.md'),
          { ...tab('README.md'), id: 'q:README.md', projectId: 'q' },
          { ...tab('README.md'), id: 'r:README.md', projectId: 'r' }
        ],
        'p:lib/index.ts'
      )
    )
    render(<EditorTabs group="g1" projectNames={new Map([...names, ['q', 'Beta']])} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['index.tssrc', 'index.tslib', 'README.mdAlpha', 'README.mdBeta', 'README.md'])
    expect(tabs[4]).toHaveAttribute('title', 'r · README.md') // unknown project: its id
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('index.ts', { selector: '.line-through' })).toBeInTheDocument()
    expect(screen.getAllByLabelText('Unsaved')).toHaveLength(1)
  })

  it('click activates; × and middle-click ask to close (dirty) or close (clean)', () => {
    useEditor.setState(seed([tab('a.ts', { dirty: true }), tab('b.ts'), tab('c.ts')]))
    render(<EditorTabs group="g1" projectNames={names} />)
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

  it('placeholders: welcome, loading, binary / too large (no VS Code), errors with retry', async () => {
    const bridge = installBridge({
      'projects:list': () => [project('p')],
      'files:list': () => [],
      'files:stat': () => [],
      'files:read': () => fail('EACCES')
    })
    useProjects.setState({ projects: [project('p')] })
    render(view())
    await act(settle)
    expect(screen.getByText('Open a file from the explorer')).toBeInTheDocument()
    expect(screen.getByText(/Ctrl\+S save/)).toBeInTheDocument()
    expect(screen.getByTestId('monaco')).toHaveTextContent('none')

    act(() => useEditor.setState(seed([tab('a.ts', { loading: true, content: undefined })])))
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    act(() => useEditor.setState(seed([tab('a.png', { content: undefined, unsupported: 'binary' })])))
    expect(screen.getByText('Binary file')).toBeInTheDocument()
    expect(screen.queryByText(/VS Code/)).toBeNull()
    act(() => useEditor.setState(seed([tab('big.log', { content: undefined, unsupported: 'too-large' })])))
    expect(screen.getByText('Larger than 5 MB')).toBeInTheDocument()
    act(() => useEditor.setState(seed([tab('bad.ts', { content: undefined, error: 'EACCES' })])))
    expect(screen.getByText("Couldn't open this file")).toBeInTheDocument()
    fireEvent.click(screen.getByText('Try again'))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('files:read', { projectId: 'p', path: 'bad.ts' })
  })

  it('on macOS the hints use ⌘; no VS Code button in the header', async () => {
    flags.mac = true
    installBridge({ 'projects:list': () => [project('p')], 'files:list': () => [], 'files:stat': () => [] })
    useProjects.setState({ projects: [project('p')] })
    render(view())
    await act(settle)
    expect(screen.getByText(/⌘S save/)).toBeInTheDocument()
    expect(screen.queryByText('VS Code')).toBeNull()
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

    act(() => useEditor.setState({ ...seed([tab('src/a.ts', { dirty: true }), tab('b.txt')]), closing: 'p:b.txt' }))
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
    useEditor.setState({
      ...seed([tab('a.ipynb'), tab('b.IPYNB'), tab('c.ipynb', { content: undefined, loading: true })]),
      groups: [
        { id: 'g1', tabs: ['p:a.ipynb', 'p:c.ipynb'], activeId: 'p:a.ipynb' },
        { id: 'g2', tabs: ['p:b.IPYNB'], activeId: 'p:b.IPYNB' }
      ],
      grid: { orientation: 'row', children: [{ group: 'g1' }, { group: 'g2' }], sizes: [0.5, 0.5] }
    })
    render(view())
    await act(settle)
    expect(await screen.findByText('notebook a.ipynb')).toBeInTheDocument()
    expect(await screen.findByText('notebook b.IPYNB')).toBeInTheDocument()
    fireEvent.click(screen.getByText('notebook a.ipynb'))
    expect(screen.queryByText('notebook a.ipynb')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show as notebook' }))
    expect(await screen.findByText('notebook a.ipynb')).toBeInTheDocument()
    // Still loading: no notebook yet.
    act(() => e().closeGroup('g2'))
    act(() => e().setActive('p:c.ipynb'))
    expect(screen.queryByText(/^notebook/)).toBeNull()
  })

  it('a file without cursor info yet shows only its path and state', async () => {
    installBridge({ 'projects:list': () => [project('p')], 'files:list': () => [], 'files:stat': () => [] })
    useProjects.setState({ projects: [project('p')] })
    useEditor.setState(seed([tab('notes.txt')]))
    render(view())
    await act(settle)
    expect(screen.getByText('Saved')).toBeInTheDocument()
    expect(screen.queryByText(/^Ln /)).toBeNull()
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
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(checkDisk).toHaveBeenCalledTimes(2)
    fireEvent.focus(window)
    expect(checkDisk).toHaveBeenCalledTimes(3)

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

    // next to another module, without the focus: it follows the disk, the keys are the other module's
    rerender(<PaneContext.Provider value={{ focused: false }}>{view(true)}</PaneContext.Provider>)
    const polls = checkDisk.mock.calls.length
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(checkDisk.mock.calls.length).toBeGreaterThan(polls)
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    expect(save).toHaveBeenCalledTimes(2)

    // the window hidden, Mindeck running in the background: no disk and git polling for hours
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const idle = checkDisk.mock.calls.length
    act(() => {
      vi.advanceTimersByTime(9000)
    })
    expect(checkDisk).toHaveBeenCalledTimes(idle)
    hidden.mockReturnValue(false)
    fireEvent.focus(window) // back on screen: it looks again
    expect(checkDisk).toHaveBeenCalledTimes(idle + 1)
    vi.useRealTimers()
  })

  it('disk and git polling follow the window: hidden pauses, unfocused slows down, coming back looks once', async () => {
    vi.useFakeTimers()
    installBridge({ 'projects:list': () => [project('p')], 'files:list': () => [] })
    useProjects.setState({ projects: [project('p')] })
    const checkDisk = vi.fn(async () => {})
    useEditor.setState({ checkDisk })
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const visibility = () => fireEvent(document, new Event('visibilitychange'))
    const { unmount } = render(view(true))
    act(() => {
      vi.advanceTimersByTime(9000)
    })
    visibility() // still hidden
    expect(checkDisk).not.toHaveBeenCalled()

    hidden.mockReturnValue(false)
    visibility() // shown again: right away…
    fireEvent.focus(window) // …once, though the focus comes with it
    expect(checkDisk).toHaveBeenCalledTimes(1)

    fireEvent.blur(window) // on screen, without the focus: every 15 s instead of every 3 s
    act(() => {
      vi.advanceTimersByTime(12_000)
    })
    expect(checkDisk).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(checkDisk).toHaveBeenCalledTimes(2)
    fireEvent.focus(window) // in front again: now, and every 3 s
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(checkDisk).toHaveBeenCalledTimes(4)

    unmount()
    visibility()
    fireEvent.focus(window)
    expect(checkDisk).toHaveBeenCalledTimes(4)
    vi.useRealTimers()
  })

  it('⌘W / Ctrl+W closes the editor’s tab (asking when it has edits) — without one the key is the workspace’s', async () => {
    installBridge({ 'projects:list': () => [project('p')], 'files:list': () => [] })
    useProjects.setState({ projects: [project('p')] })
    const requestClose = vi.fn()
    useEditor.setState({ ...seed([tab('a.ts')]), requestClose })
    render(view(true))
    await act(settle)
    const press = (init: KeyboardEventInit) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      window.dispatchEvent(e)
      return e.defaultPrevented
    }
    expect(press({ key: 'w', metaKey: true })).toBe(true)
    expect(requestClose).toHaveBeenCalledWith('p:a.ts')
    expect(press({ key: 'w', ctrlKey: true, altKey: true })).toBe(false)
    act(() => useEditor.setState({ activeId: undefined }))
    expect(press({ key: 'w', ctrlKey: true })).toBe(false) // nothing open: the pane closes
    expect(requestClose).toHaveBeenCalledTimes(1)
    // An empty group next to others closes itself (like VS Code).
    act(() => e().split('right', 'p:none'))
    expect(press({ key: 'w', metaKey: true })).toBe(true)
    expect(e().groups).toHaveLength(1)
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
    useEditor.setState(seed([tab('a.ts', { conflict: true, dirty: true }), tab('b.png', { content: undefined, unsupported: 'binary' })]))
    render(view())
    await act(settle)
    expect(screen.queryByTitle('Open in VS Code')).toBeNull()
    expect(screen.getByTestId('monaco')).toHaveTextContent('p:a.ts (read-only)')
    expect(screen.getByText('Read-only')).toBeInTheDocument()
    expect(screen.getByText('Keep mine')).toBeDisabled()
    // Read-only: the palette has nothing that writes or runs code.
    const labels = allCommands(en).map((c) => c.label)
    expect(labels.some((l) => l.startsWith('Debug:'))).toBe(false)
    expect(labels).not.toContain('File: Save')
    expect(labels).toContain('File: Close Editor')
    act(() => e().setActive('p:b.png'))
    expect(screen.getByText('Binary file')).toBeInTheDocument()
    expect(screen.queryByText('Open in VS Code')).toBeNull()

    act(() => useSession.setState({ info: { mode: 'server', version: '1', platform: 'linux', hostname: 'nas', remoteTerminal: true } }))
    act(() => e().setActive('p:a.ts'))
    expect(screen.getByTestId('monaco')).toHaveTextContent(/^p:a\.ts$/)
  })
})
