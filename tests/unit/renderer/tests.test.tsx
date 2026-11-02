import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, installBridge, settle } from './bridge'
import type { TestItem, TestRunState } from '@shared/types/tests'

vi.mock('@/features/editor/components/CodeEditor', () => ({ default: () => <div data-testid="monaco" /> }))
vi.mock('@/features/editor/components/DiffView', () => ({ default: () => <div data-testid="diff" /> }))
vi.mock('@/features/editor/monaco/setup', () => ({ THEME: 'mindeck', applyMonacoTheme: vi.fn(), monaco: {} }))

import { stateOf, summary, useTests } from '@/features/editor/tests'
import { TestsPanel } from '@/features/editor/components/TestsPanel'
import { EditorView } from '@/features/editor/components/EditorView'
import { tabKey, useEditor } from '@/features/editor/store'
import { useDebug } from '@/features/editor/debug'
import { useScm } from '@/features/editor/scm'
import { allCommands } from '@/features/palette/registry'
import { en } from '@/lib/i18n/en'
import { useProjects } from '@/features/projects/store'

const initial = useTests.getState()
const initialEditor = useEditor.getState()
const s = () => useTests.getState()

const ITEMS: TestItem[] = [
  {
    id: 'a.test.ts',
    name: 'a.test.ts',
    kind: 'file',
    framework: 'vitest',
    path: 'a.test.ts',
    children: [
      {
        id: 'a.test.ts::math',
        name: 'math',
        kind: 'suite',
        framework: 'vitest',
        path: 'a.test.ts',
        line: 1,
        children: [
          { id: 'a.test.ts::math > adds', name: 'adds', kind: 'test', framework: 'vitest', path: 'a.test.ts', line: 2 },
          { id: 'a.test.ts::math > fails', name: 'fails', kind: 'test', framework: 'vitest', path: 'a.test.ts', line: 3 }
        ]
      },
      { id: 'a.test.ts::later', name: 'later', kind: 'test', framework: 'vitest', path: 'a.test.ts', line: 5 }
    ]
  },
  { id: 'test_b.py', name: 'test_b.py', kind: 'file', framework: 'pytest', path: 'test_b.py', children: [{ id: 'test_b.py::test_b', name: 'test_b', kind: 'test', framework: 'pytest', path: 'test_b.py', line: 1 }] }
]

const RAN: TestRunState = {
  projectId: 'p',
  running: false,
  results: {
    'a.test.ts::math > adds': { state: 'passed', durationMs: 1.4 },
    'a.test.ts::math > fails': { state: 'failed', durationMs: 3, message: 'expected 6 to be 7' },
    'a.test.ts::later': { state: 'skipped' },
    'test_b.py::test_b': { state: 'running' }
  },
  output: '$ vitest run\nok\n'
}

function bridge(over: Record<string, (p: never) => unknown> = {}) {
  return installBridge({
    'tests:discover': () => ITEMS,
    'tests:state': () => ({ projectId: 'p', running: false, results: {}, output: '' }),
    'tests:run': ({ id }: { id?: string }) => ({ ...RAN, results: id ? { [id]: { state: 'passed' } } : RAN.results }),
    'tests:cancel': () => undefined,
    'tests:debug': () => ({ id: 's', projectId: 'p', program: 'x', status: 'starting', frames: [] }),
    ...over
  })
}

beforeEach(() => {
  useTests.setState(initial, true)
  useEditor.setState({ ...initialEditor, projectId: 'p' }, true)
})

describe('test results', () => {
  it('files and suites sum up their tests', () => {
    const [file, py] = ITEMS
    const suite = file.children![0]
    expect(stateOf(file, {})).toBeUndefined()
    expect(stateOf(file, RAN.results)).toBe('failed')
    expect(stateOf(py, RAN.results)).toBe('running')
    expect(stateOf(suite, { 'a.test.ts::math > adds': { state: 'passed' }, 'a.test.ts::math > fails': { state: 'skipped' } })).toBe('passed')
    expect(stateOf(suite, { 'a.test.ts::math > adds': { state: 'skipped' }, 'a.test.ts::math > fails': { state: 'skipped' } })).toBe('skipped')
    // Only some ran: no verdict for the suite yet.
    expect(stateOf(suite, { 'a.test.ts::math > adds': { state: 'passed' } })).toBeUndefined()
    // A file that failed to load.
    expect(stateOf(file, { 'a.test.ts': { state: 'failed' } })).toBe('failed')
    expect(stateOf({ ...suite, children: [] }, {})).toBeUndefined()
    expect(summary(ITEMS, RAN.results)).toEqual({ passed: 1, failed: 1, skipped: 1, total: 4 })
  })
})

describe('test explorer store', () => {
  it('finds tests (files open), runs, cancels, debugs; follows the core’s runs of this project', async () => {
    const b = bridge()
    await s().discover()
    expect(s()).toMatchObject({ items: ITEMS, loaded: true, loading: false, expanded: { 'a.test.ts': true, 'test_b.py': true } })
    // Rows the user closed stay closed when found again.
    s().toggle('a.test.ts')
    await s().discover()
    expect(s().expanded['a.test.ts']).toBe(false)

    await s().runTests()
    expect(s().run).toEqual(RAN)
    await s().runTests('a.test.ts::later')
    expect(b.invoke).toHaveBeenCalledWith('tests:run', { projectId: 'p', id: 'a.test.ts::later' })
    await s().cancel()
    expect(b.invoke).toHaveBeenCalledWith('tests:cancel', { projectId: 'p' })

    useDebug.setState({ breakpoints: { p: [{ path: 'a.test.ts', line: 2 }] } })
    await s().debugTest('a.test.ts::math > adds')
    expect(b.invoke).toHaveBeenCalledWith('tests:debug', { projectId: 'p', id: 'a.test.ts::math > adds', breakpoints: [{ path: 'a.test.ts', line: 2 }] })
    expect(useScm.getState().pane).toBe('debug')
    expect(useDebug.getState().consoleOpen).toBe(true)
    useDebug.setState({ breakpoints: {} })
    await s().debugTest('test_b.py::test_b')
    expect(b.invoke).toHaveBeenLastCalledWith('tests:debug', { projectId: 'p', id: 'test_b.py::test_b', breakpoints: [] })

    const off = s().connect()
    b.emit('tests:changed', { ...RAN, projectId: 'other', output: 'theirs' })
    expect(s().run?.output).not.toBe('theirs')
    b.emit('tests:changed', { ...RAN, output: 'mine' })
    expect(s().run?.output).toBe('mine')
    off()

    s().toggleDetails('x')
    s().setFailedOnly(true)
    s().setShowOutput(true)
    expect(s()).toMatchObject({ details: { x: true }, failedOnly: true, showOutput: true })
    useScm.getState().setPane('files')
  })

  it('opens a test where it is defined; errors show and clear; another project starts over', async () => {
    const openAt = vi.fn(async () => {})
    const open = vi.fn(async () => {})
    useEditor.setState({ openAt, open })
    s().reveal(ITEMS[0].children![1])
    s().reveal(ITEMS[0])
    expect(openAt).toHaveBeenCalledWith('a.test.ts', 5)
    expect(open).toHaveBeenCalledWith('a.test.ts')

    bridge({ 'tests:run': () => fail('Tests are running already', 'busy') })
    await s().runTests()
    expect(s().error).toBe('Tests are running already')
    s().clearError()
    expect(s().error).toBeUndefined()

    bridge({ 'tests:discover': () => fail('gone') })
    await s().discover()
    expect(s()).toMatchObject({ error: 'gone', loading: false, loaded: false })

    // The project changed while its tests were being found: they're dropped.
    let resolve!: (items: TestItem[]) => void
    bridge({ 'tests:discover': () => new Promise<TestItem[]>((r) => (resolve = r)) })
    const finding = s().discover()
    await settle()
    useEditor.setState({ projectId: 'q' })
    resolve(ITEMS)
    await finding
    expect(s().items).toEqual([])

    useTests.setState({ items: ITEMS, loaded: true, run: RAN, details: { x: true } })
    useEditor.setState({ projectId: 'q' })
    expect(s().items).toEqual(ITEMS)
    useEditor.setState({ projectId: 'r' })
    expect(s()).toMatchObject({ items: [], loaded: false, run: null, details: {} })

    // No project: nothing to ask.
    const b = bridge()
    useEditor.setState({ projectId: undefined })
    await s().runTests()
    expect(b.invoke).not.toHaveBeenCalled()
  })
})

describe('TestsPanel', () => {
  it('a tree with states and times; run, debug and open per row; why it failed; only failures; output', async () => {
    const b = bridge()
    const openAt = vi.fn(async () => {})
    useEditor.setState({ openAt })
    render(<TestsPanel />)
    await act(settle)
    const tree = screen.getByRole('tree', { name: 'Tests' })
    expect(within(tree).getAllByLabelText('not run yet').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Open math' }))
    expect(screen.getByRole('button', { name: 'adds' })).toBeInTheDocument()

    act(() => useTests.setState({ run: RAN }))
    expect(screen.getByText('1 passed')).toBeInTheDocument()
    expect(screen.getByText('1 failed')).toBeInTheDocument()
    expect(screen.getByText('1 skipped')).toBeInTheDocument()
    expect(screen.getByText('of 4')).toBeInTheDocument()
    expect(screen.getByText('1 ms')).toBeInTheDocument()
    for (const label of ['passed', 'failed', 'skipped', 'running']) expect(within(tree).getAllByLabelText(label).length).toBeGreaterThan(0)

    // A failed test: a click shows why, a double click opens it.
    fireEvent.click(screen.getByRole('button', { name: 'fails' }))
    expect(screen.getByRole('note')).toHaveTextContent('expected 6 to be 7')
    fireEvent.doubleClick(screen.getByRole('button', { name: 'fails' }))
    expect(openAt).toHaveBeenCalledWith('a.test.ts', 3)
    // Any other row: a click opens it.
    fireEvent.click(screen.getByRole('button', { name: 'adds' }))
    expect(openAt).toHaveBeenLastCalledWith('a.test.ts', 2)
    expect(screen.getByRole('button', { name: 'adds' })).toHaveAttribute('title', 'a.test.ts:2')
    expect(screen.getByRole('button', { name: 'a.test.ts' })).toHaveAttribute('title', 'a.test.ts')

    fireEvent.click(screen.getByRole('button', { name: 'Run adds' }))
    await act(settle)
    expect(b.invoke).toHaveBeenCalledWith('tests:run', { projectId: 'p', id: 'a.test.ts::math > adds' })
    fireEvent.click(screen.getByRole('button', { name: 'Debug later' }))
    await act(settle)
    expect(b.invoke).toHaveBeenCalledWith('tests:debug', expect.objectContaining({ id: 'a.test.ts::later' }))
    act(() => useScm.getState().setPane('files'))

    act(() => useTests.setState({ run: RAN }))
    fireEvent.click(screen.getByRole('button', { name: 'Failed only' }))
    expect(screen.queryByRole('button', { name: 'adds' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'test_b.py' })).toBeNull()
    expect(screen.getByRole('button', { name: 'fails' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Failed only' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close math' }))
    expect(screen.queryByRole('button', { name: 'fails' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Output of the last run' }))
    expect(screen.getByLabelText('Output of the last run', { selector: 'pre' })).toHaveTextContent('$ vitest run')
    act(() => useTests.setState({ run: null }))
    expect(screen.getByLabelText('Output of the last run', { selector: 'pre' })).toHaveTextContent('Nothing run yet.')

    // While running: stop instead of run; rows can't start another.
    act(() => useTests.setState({ run: { ...RAN, running: true } }))
    expect(screen.getByRole('button', { name: 'Run test_b' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop the run' }))
    await act(settle)
    expect(b.invoke).toHaveBeenCalledWith('tests:cancel', { projectId: 'p' })
    act(() => useTests.setState({ run: RAN }))
    fireEvent.click(screen.getByRole('button', { name: 'Run all tests' }))
    await act(settle)
    expect(b.invoke).toHaveBeenCalledWith('tests:run', { projectId: 'p', id: undefined })

    act(() => useTests.setState({ error: 'busy' }))
    expect(screen.getByRole('alert')).toHaveTextContent('busy')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Find tests again' }))
    await act(settle)
    expect(b.invoke.mock.calls.filter(([c]) => c === 'tests:discover')).toHaveLength(2)
  })

  it('nothing found says which runners it knows; found tests are not looked for again', async () => {
    const b = bridge({ 'tests:discover': () => [] })
    const { unmount } = render(<TestsPanel />)
    await act(settle)
    expect(screen.getByText(/No tests found/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run all tests' })).toBeDisabled()
    unmount()
    render(<TestsPanel />)
    await act(settle)
    expect(b.invoke.mock.calls.filter(([c]) => c === 'tests:discover')).toHaveLength(1)
  })
})

describe('the Testing pane in the editor', () => {
  it('shows in the activity bar; the palette runs all tests or the open file’s', async () => {
    const b = bridge({
      'files:list': () => [],
      'files:stat': () => [],
      'scm:status': () => ({ repo: false, ahead: 0, behind: 0, merging: false, files: [] }),
      'debug:session': () => null,
      'liveServer:status': () => []
    })
    useProjects.setState({ projects: [{ id: 'p', name: 'Demo', path: '/x/p', addedAt: '', lastSeenAt: '' }] })
    const { unmount } = render(<EditorView active onNavigate={vi.fn()} />)
    await act(settle)
    const nav = screen.getByRole('navigation', { name: 'Editor' })
    fireEvent.click(within(nav).getByRole('button', { name: 'Testing' }))
    await act(settle)
    expect(screen.getByRole('tree', { name: 'Tests' })).toBeInTheDocument()
    // Runs reported by the core reach the pane.
    act(() => b.emit('tests:changed', { ...RAN, output: 'live' }))
    expect(s().run?.output).toBe('live')

    act(() => useScm.getState().setPane('files'))
    const palette = async (label: string) => {
      // The editor's commands, as the palette (⇧⌘P) lists and runs them.
      await act(async () => void (await allCommands(en).find((c) => c.label.startsWith(label))!.run()))
      await act(settle)
    }
    await palette('Test: Run all tests')
    expect(useScm.getState().pane).toBe('tests')
    expect(b.invoke).toHaveBeenCalledWith('tests:run', { projectId: 'p', id: undefined })
    // No file open: nothing to run.
    b.invoke.mockClear()
    await palette('Test: Run tests in this file')
    expect(b.invoke.mock.calls.filter(([c]) => c === 'tests:run')).toEqual([])
    act(() =>
      useEditor.setState({
        tabs: [{ id: tabKey('p', 'a.test.ts'), projectId: 'p', path: 'a.test.ts', name: 'a.test.ts', loading: false, content: 'x', mtimeMs: 1, revision: 1, dirty: false, saving: false, conflict: false, deleted: false }],
        activeId: tabKey('p', 'a.test.ts')
      })
    )
    await palette('Test: Run tests in this file')
    expect(b.invoke).toHaveBeenCalledWith('tests:run', { projectId: 'p', id: 'a.test.ts' })
    unmount()
    expect(b.listenerCount('tests:changed')).toBe(0)
    useScm.getState().setPane('files')
  })
})
