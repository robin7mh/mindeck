import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { choose, fail, installBridge, settle } from './bridge'
import type { ScmCommit, ScmStatus } from '@shared/types/scm'
import type { EditorTab } from '@/features/editor/store'

// Monaco is covered in editor.test.tsx — stand-ins show what they were given.
vi.mock('@/features/editor/components/CodeEditor', () => ({ default: ({ tab }: { tab?: EditorTab }) => <div data-testid="monaco">{tab?.id ?? 'none'}</div> }))
vi.mock('@/features/editor/components/DiffView', () => ({
  default: ({ path, original, modified }: { path: string; original: string; modified: string }) => <div data-testid="diff">{`${path}: ${original} → ${modified}`}</div>
}))

import { useScm } from '@/features/editor/scm'
import { useEditor } from '@/features/editor/store'
import { useProjects } from '@/features/projects/store'
import { DiffHeader, ScmPanel } from '@/features/editor/components/ScmPanel'
import { fuzzyScore, QuickOpen } from '@/features/editor/components/QuickOpen'
import { GitGraph, layoutGraph } from '@/features/editor/components/GitGraph'
import { EditorView } from '@/features/editor/components/EditorView'

useEditor.setState({ projectId: 'p' })
const initialEditor = useEditor.getState()
const initialScm = useScm.getState()
const s = () => useScm.getState()

const status = (over: Partial<ScmStatus> = {}): ScmStatus => ({
  repo: true,
  branch: 'main',
  head: 'abc1234',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  merging: false,
  files: [],
  ...over
})
const commit = (hash: string, parents: string[], over: Partial<ScmCommit> = {}): ScmCommit => ({
  hash,
  parents,
  author: 'Ada',
  date: Date.UTC(2026, 9, 1),
  subject: `commit ${hash}`,
  refs: [],
  ...over
})

beforeEach(() => {
  useEditor.setState(initialEditor, true)
  useScm.setState(initialScm, true)
})

describe('scm store', () => {
  it('refreshes status and branches; every operation runs once, then refreshes; failures become the error', async () => {
    let st = status({ files: [{ path: 'a.ts', unstaged: 'modified' }] })
    const bridge = installBridge({
      'scm:status': () => st,
      'scm:branches': () => [{ name: 'main', remote: false, current: true }],
      'scm:push': () => fail('rejected: fetch first')
    })
    await s().refresh()
    expect(s()).toMatchObject({ status: st, branches: [{ name: 'main' }] })

    await s().stage(['a.ts'])
    await s().unstage(['a.ts'])
    await s().discard(['a.ts'])
    await s().fetch()
    await s().pull()
    await s().checkout('main')
    await s().createBranch('x')
    await s().init()
    const calls = bridge.invoke.mock.calls.map(([c]) => c).filter((c) => !['scm:status', 'scm:branches', 'scm:stashes'].includes(c))
    expect(calls).toEqual(['scm:stage', 'scm:unstage', 'scm:discard', 'scm:fetch', 'scm:pull', 'scm:checkout', 'scm:createBranch', 'scm:init'])

    await s().push()
    expect(s()).toMatchObject({ error: 'rejected: fetch first', busy: undefined })
    s().clearError()
    expect(s().error).toBeUndefined()

    // smart commit: nothing staged → everything; the box empties after a commit
    s().setMessage('fix it')
    s().setAmend(true)
    await s().commit()
    expect(bridge.invoke).toHaveBeenCalledWith('scm:commit', { projectId: 'p', message: 'fix it', amend: true, all: true })
    expect(s()).toMatchObject({ message: '', amend: false })
    st = status({ files: [{ path: 'a.ts', staged: 'modified' }] })
    await s().refresh()
    s().setMessage('only staged')
    await s().commit()
    expect(bridge.invoke).toHaveBeenCalledWith('scm:commit', { projectId: 'p', message: 'only staged', amend: false, all: false })
    // a commit that fails keeps the message for another try
    s().setMessage('again')
    bridge.invoke.mockRejectedValueOnce(new Error('hook failed'))
    await s().commit()
    expect(s()).toMatchObject({ message: 'again', error: 'hook failed' })
    s().clearError()

    await s().sync()
    expect(bridge.invoke).toHaveBeenCalledWith('scm:pull', { projectId: 'p' })
    s().clearError()

    // one at a time; nothing without a project
    useScm.setState({ busy: 'push' })
    bridge.invoke.mockClear()
    await s().fetch()
    expect(bridge.invoke).not.toHaveBeenCalledWith('scm:fetch', expect.anything())
    useScm.setState({ busy: undefined })
    useEditor.setState({ projectId: undefined })
    await s().fetch()
    await s().refresh()
    await s().openDiff({ path: 'a' }, { kind: 'staged' }, 'a')
    await s().loadLog()
    await s().select('abcd')
    s().setQuickOpen(true)
    expect(bridge.invoke).not.toHaveBeenCalledWith(expect.stringMatching(/^scm:/), expect.anything())
  })

  it('a failing status, branches only for repos', async () => {
    installBridge({ 'scm:status': () => fail('git broke') })
    await s().refresh()
    expect(s().error).toBe('git broke')
    const bridge = installBridge({ 'scm:status': () => status({ repo: false }) })
    await s().refresh()
    expect(bridge.invoke).not.toHaveBeenCalledWith('scm:branches', expect.anything())
    expect(s().branches).toEqual([])
  })

  it('diffs, the log (selecting the newest), commit details, quick open files', async () => {
    let failing = false
    const bridge = installBridge({
      'scm:status': () => status(),
      'scm:branches': () => [],
      'scm:diff': ({ path }: { path: string }) => (failing ? fail('no diff') : { path, original: 'a', modified: 'b' }),
      'scm:log': () => (failing ? fail('no log') : [commit('c2', ['c1']), commit('c1', [])]),
      'scm:show': ({ hash }: { hash: string }) => (failing ? fail('no commit') : { hash, author: 'Ada', email: 'a@a', date: 0, message: 'm', files: [] }),
      'scm:files': () => (failing ? fail('no files') : ['src/a.ts'])
    })
    await s().openDiff({ path: 'new.ts', from: 'old.ts' }, { kind: 'commit', hash: 'abcd' }, 'new.ts (abcd)')
    expect(bridge.invoke).toHaveBeenCalledWith('scm:diff', { projectId: 'p', path: 'new.ts', target: { kind: 'commit', hash: 'abcd', from: 'old.ts' } })
    expect(s().diff).toEqual({ path: 'new.ts', original: 'a', modified: 'b', title: 'new.ts (abcd)' })
    await s().openDiff({ path: 'a.ts' }, { kind: 'commit', hash: 'abcd' }, 'a.ts')
    expect(bridge.invoke).toHaveBeenLastCalledWith('scm:diff', { projectId: 'p', path: 'a.ts', target: { kind: 'commit', hash: 'abcd' } })
    s().closeDiff()
    expect(s().diff).toBeUndefined()

    s().setPane('graph')
    await act(settle)
    expect(s()).toMatchObject({ pane: 'graph', selected: 'c2', detail: { hash: 'c2' } })
    await s().loadLog() // something selected already: stays
    expect(s().selected).toBe('c2')
    s().setPane('scm')
    s().setPane('files')
    expect(s().pane).toBe('files')

    s().setQuickOpen(true)
    await act(settle)
    expect(s()).toMatchObject({ quickOpen: true, files: ['src/a.ts'] })
    s().setQuickOpen(false)

    failing = true
    await s().openDiff({ path: 'a' }, { kind: 'unstaged' }, 'a')
    expect(s().error).toBe('no diff')
    await s().loadLog()
    expect(s().error).toBe('no log')
    await s().select('c1')
    expect(s().error).toBe('no commit')
    s().setQuickOpen(true)
    await act(settle)
    expect(s().error).toBe('no files')
  })

  it('switching projects starts over; opening at a line remembers where to scroll', async () => {
    const bridge = installBridge({ 'scm:status': () => status(), 'scm:branches': () => [], 'files:read': () => ({ path: 'a.ts', content: 'x', mtimeMs: 1, size: 1 }) })
    useScm.setState({ diff: { path: 'a', original: '', modified: '', title: 'a' }, log: [commit('c', [])], error: 'old' })
    useEditor.setState({ projectId: 'q' })
    expect(s()).toMatchObject({ diff: undefined, log: [], error: undefined })
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('scm:status', { projectId: 'q' })
    useEditor.setState({ tree: {} }) // same project: nothing resets
    useEditor.setState({ projectId: 'p' })
    await act(settle)

    await useEditor.getState().openAt('a.ts', 12)
    expect(useEditor.getState()).toMatchObject({ activeId: 'p:a.ts', reveal: { id: 'p:a.ts', line: 12 } })
  })
})

describe('ScmPanel', () => {
  const panel = (st: ScmStatus | undefined, extra: Partial<ReturnType<typeof useScm.getState>> = {}) => {
    useScm.setState({ status: st, ...extra })
    return render(<ScmPanel />)
  }

  it('loading, and a folder that is no repository yet', () => {
    const init = vi.fn(async () => {})
    useScm.setState({ init })
    const { rerender } = panel(undefined)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    act(() => useScm.setState({ status: status({ repo: false }) }))
    rerender(<ScmPanel />)
    fireEvent.click(screen.getByText('Initialize repository'))
    expect(init).toHaveBeenCalled()
  })

  it('changes by section with stage, unstage, discard (asking first), open and diff', async () => {
    const stage = vi.fn(async () => {})
    const unstage = vi.fn(async () => {})
    const discard = vi.fn(async () => {})
    const openDiff = vi.fn(async () => {})
    const files = [
      { path: 'src/staged.ts', staged: 'modified' as const },
      { path: 'both.ts', staged: 'added' as const, unstaged: 'modified' as const },
      { path: 'src/new.ts', unstaged: 'untracked' as const },
      { path: 'clash.ts', unstaged: 'conflicted' as const }
    ]
    installBridge({ 'files:read': () => ({ path: 'src/new.ts', content: 'x', mtimeMs: 1, size: 1 }) })
    panel(status({ files, merging: true, operation: { kind: 'merge' } }), { stage, unstage, discard, openDiff, diff: { path: 'x', original: '', modified: '', title: 'x' } })
    expect(screen.getByText('Merging')).toBeInTheDocument()
    expect(screen.getByText('Merge conflicts')).toBeInTheDocument()
    expect(screen.getAllByText(/^[MAU!]$/).map((n) => n.textContent)).toEqual(['!', 'M', 'A', 'M', 'U'])

    fireEvent.click(screen.getByText('staged.ts'))
    expect(openDiff).toHaveBeenCalledWith(files[0], { kind: 'staged' }, 'staged.ts (Index)')
    fireEvent.click(screen.getByText('new.ts'))
    expect(openDiff).toHaveBeenLastCalledWith(files[2], { kind: 'unstaged' }, 'new.ts (Working Tree)')

    fireEvent.click(screen.getByLabelText('Unstage: src/staged.ts'))
    expect(unstage).toHaveBeenCalledWith(['src/staged.ts'])
    fireEvent.click(screen.getByLabelText('Stage: src/new.ts'))
    expect(stage).toHaveBeenCalledWith(['src/new.ts'])
    fireEvent.click(screen.getByLabelText('Unstage all'))
    expect(unstage).toHaveBeenLastCalledWith(['src/staged.ts', 'both.ts'])
    fireEvent.click(screen.getByLabelText('Stage all'))
    expect(stage).toHaveBeenLastCalledWith(['both.ts', 'src/new.ts'])

    fireEvent.click(screen.getByLabelText('Discard changes: src/new.ts'))
    expect(screen.getByRole('alertdialog')).toHaveTextContent("Discard new.ts? This can't be undone.")
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(screen.getByLabelText('Discard all changes'))
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(discard).toHaveBeenCalledWith(['both.ts', 'src/new.ts'])

    fireEvent.click(screen.getByLabelText('Open file: src/new.ts'))
    await act(settle)
    expect(useScm.getState().diff).toBeUndefined()
    expect(useEditor.getState().activeId).toBe('p:src/new.ts')
  })

  it('branches: switch, remote ones, a new branch; pull, push or publish, fetch; busy spinners', async () => {
    const checkout = vi.fn(async () => {})
    const createBranch = vi.fn(async () => {})
    const pull = vi.fn(async () => {})
    const push = vi.fn(async () => {})
    const fetch = vi.fn(async () => {})
    const branches = [
      { name: 'main', remote: false, current: true, upstream: 'origin/main' },
      { name: 'origin/main', remote: true, current: false },
      { name: 'origin/feature', remote: true, current: false }
    ]
    const { rerender } = panel(status({ ahead: 2, behind: 3 }), { branches, checkout, createBranch, pull, push, fetch })
    expect(screen.getByText('No changes. The working tree is clean.')).toBeInTheDocument()
    choose('Branch', /^origin\/feature/)
    expect(checkout).toHaveBeenCalledWith('origin/feature')
    expect(screen.getByRole('button', { name: /Pull\s*3/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Pull/ }))
    fireEvent.click(screen.getByRole('button', { name: /Push\s*2/ }))
    fireEvent.click(screen.getByLabelText('Fetch'))
    expect([pull, push, fetch].map((f) => f.mock.calls.length)).toEqual([1, 1, 1])

    fireEvent.click(screen.getByLabelText('New branch'))
    const name = screen.getByLabelText('Name of the new branch')
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    fireEvent.keyDown(name, { key: 'Enter' }) // empty: nothing
    fireEvent.change(name, { target: { value: ' feature/y ' } })
    fireEvent.keyDown(name, { key: 'a' })
    fireEvent.keyDown(name, { key: 'Enter' })
    expect(createBranch).toHaveBeenCalledWith('feature/y')
    fireEvent.click(screen.getByLabelText('New branch'))
    fireEvent.change(screen.getByLabelText('Name of the new branch'), { target: { value: 'z' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(createBranch).toHaveBeenLastCalledWith('z')
    fireEvent.click(screen.getByLabelText('New branch'))
    fireEvent.keyDown(screen.getByLabelText('Name of the new branch'), { key: 'Escape' })
    expect(screen.queryByLabelText('Name of the new branch')).toBeNull()

    for (const busy of ['pull', 'push', 'fetch', 'commit'] as const) {
      act(() => useScm.setState({ busy, status: status({ upstream: undefined, branch: undefined, head: undefined }) }))
      rerender(<ScmPanel />)
      expect(screen.getByRole('button', { name: /Publish branch/ })).toBeDisabled()
    }
    expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveTextContent('detached')
    act(() => useScm.setState({ busy: undefined, status: status({ branch: undefined, head: 'abc1234' }) }))
    rerender(<ScmPanel />)
    expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveTextContent('abc1234 (detached)')
  })

  it('the commit box: message, ⌘Enter, amend, smart commit label', () => {
    const commit = vi.fn(async () => {})
    const { rerender } = panel(status({ files: [{ path: 'a.ts', unstaged: 'modified' }] }), { commit })
    const box = screen.getByLabelText('Message (⌘Enter to commit)')
    expect(screen.getByRole('button', { name: 'Commit all' })).toBeDisabled() // no message yet
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true }) // nothing to commit with
    fireEvent.change(box, { target: { value: 'fix' } })
    fireEvent.keyDown(box, { key: 'Enter' }) // a new line, no commit
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    expect(commit).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Commit all' }))
    expect(commit).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByLabelText('Amend last commit'))
    expect(useScm.getState().amend).toBe(true)
    act(() => useScm.setState({ message: '', status: status() }))
    rerender(<ScmPanel />)
    expect(screen.getByRole('button', { name: 'Commit' })).toBeEnabled() // amend: no message or change needed
  })

  it('DiffHeader closes', () => {
    const onClose = vi.fn()
    render(<DiffHeader title="a.ts (Index)" onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('Close diff'))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('quick open', () => {
  it('fuzzy scores: in order, file names first, misses', () => {
    expect(fuzzyScore('src/app.ts', '')).toBe(0)
    expect(fuzzyScore('src/app.ts', 'zz')).toBeNull()
    expect(fuzzyScore('src/app.ts', 'app')!).toBeLessThan(fuzzyScore('apps/x/p.ts', 'app')!)
    expect(fuzzyScore('src/app.ts', 's a')).not.toBeNull()
  })

  it('⌘P: type, move, open with Enter or a click; Escape and outside clicks close', async () => {
    installBridge({ 'scm:files': () => ['src/app.ts', 'src/util/apply.ts', 'README.md'], 'files:read': () => ({ path: 'x', content: 'x', mtimeMs: 1, size: 1 }) })
    useScm.setState({ files: ['src/app.ts', 'src/util/apply.ts', 'README.md'], quickOpen: true })
    const { rerender } = render(<QuickOpen />)
    const input = screen.getByLabelText('Go to file by name…', { selector: 'input' })
    fireEvent.change(input, { target: { value: 'ap' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['app.tssrc/', 'apply.tssrc/util/'])
    fireEvent.keyDown(input, { key: 'ArrowUp' }) // already first
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // already last
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input, { key: 'x' })
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(settle)
    expect(useEditor.getState().activeId).toBe('p:src/util/apply.ts')
    expect(useScm.getState().quickOpen).toBe(false)

    rerender(<QuickOpen />)
    fireEvent.change(screen.getByLabelText('Go to file by name…', { selector: 'input' }), { target: { value: '' } })
    fireEvent.mouseEnter(screen.getAllByRole('option')[2])
    fireEvent.click(screen.getAllByRole('option')[2])
    await act(settle)
    expect(useEditor.getState().activeId).toBe('p:README.md')

    act(() => useScm.setState({ quickOpen: true }))
    rerender(<QuickOpen />)
    fireEvent.change(screen.getByLabelText('Go to file by name…', { selector: 'input' }), { target: { value: 'zzz' } })
    expect(screen.getByText('No matching files')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByLabelText('Go to file by name…', { selector: 'input' }), { key: 'Enter' }) // nothing to open
    fireEvent.mouseDown(screen.getByLabelText('Go to file by name…', { selector: 'input' })) // inside: stays
    expect(useScm.getState().quickOpen).toBe(true)
    fireEvent.keyDown(screen.getByLabelText('Go to file by name…', { selector: 'input' }), { key: 'Escape' })
    expect(useScm.getState().quickOpen).toBe(false)
    act(() => useScm.setState({ quickOpen: true }))
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(useScm.getState().quickOpen).toBe(false)
  })
})

describe('git graph', () => {
  it('lays out lanes: a branch that joins back, a merge, a new lane after a gap', () => {
    // m merges b into a; b and a both come from r
    const rows = layoutGraph([commit('m', ['a', 'b']), commit('b', ['r']), commit('a', ['r']), commit('r', []), commit('x', [])])
    expect(rows.map((r) => [r.commit.hash, r.lane, r.merges])).toEqual([
      ['m', 0, [1]],
      ['b', 1, []],
      ['a', 0, []],
      ['r', 0, []],
      ['x', 0, []]
    ])
    expect(rows[1].after).toEqual(['a', 'r'])
    expect(rows[2].after).toEqual(['r', 'r'])
    expect(rows[3].after).toEqual([]) // both lanes ended in the root
    // a merge into a parent that already has a lane
    expect(layoutGraph([commit('m', ['a', 'b']), commit('n', ['c', 'b'])])[1].merges).toEqual([1])
    // a lane freed in the middle is reused by the next new branch
    const reuse = layoutGraph([commit('x1', ['p1']), commit('x2', ['p2']), commit('x3', ['p3']), commit('p2', []), commit('y', ['q'])])
    expect(reuse.map((r) => r.lane)).toEqual([0, 1, 2, 1, 1])
  })

  it('empty, rows with refs, selecting, details with files and their diffs', () => {
    const select = vi.fn(async () => {})
    const openDiff = vi.fn(async () => {})
    const { rerender } = render(<GitGraph />)
    expect(screen.getByText('No commits yet.')).toBeInTheDocument()
    const wide = Array.from({ length: 20 }, (_, i) => commit(`w${i}`, ['root']))
    act(() =>
      useScm.setState({
        select,
        openDiff,
        log: [commit('m', ['a', 'b'], { refs: ['HEAD -> main', 'origin/main', 'tag: v1'] }), commit('b', ['a']), commit('a', []), ...wide],
        selected: 'm',
        detail: { hash: 'm'.repeat(40), author: 'Ada', email: 'a@a', date: 0, message: 'merge it', files: [{ path: 'src/x.ts', change: 'modified' }, { path: 'y.ts', from: 'old.ts', change: 'renamed' }] }
      })
    )
    rerender(<GitGraph />)
    expect(screen.getByText('main')).toHaveClass('text-cyan')
    expect(screen.getByText('v1')).toHaveClass('text-amber')
    expect(screen.getByText('origin/main')).toBeInTheDocument()
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByText('commit b'))
    expect(select).toHaveBeenCalledWith('b')
    expect(screen.getByText('2 files changed')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('old.ts → y.ts'))
    expect(openDiff).toHaveBeenCalledWith({ path: 'y.ts', from: 'old.ts', change: 'renamed' }, { kind: 'commit', hash: 'm'.repeat(40) }, 'y.ts (mmmmmmm)')
    fireEvent.click(screen.getByTitle('src/x.ts'))
    expect(openDiff).toHaveBeenCalledTimes(2)
    // a lane that ended between two that go on leaves a gap, drawn as none
    act(() => useScm.setState({ log: [commit('x1', ['p1']), commit('x2', ['p2']), commit('x3', ['p3']), commit('p2', []), commit('p1', [])], detail: undefined }))
    rerender(<GitGraph />)
    expect(screen.getAllByRole('option')).toHaveLength(5)
  })
})

describe('EditorView with source control', () => {
  const routes = (over: Record<string, (p: never) => unknown> = {}) =>
    installBridge({
      'projects:list': () => [{ id: 'p', name: 'Demo', path: '/x/p', addedAt: '', lastSeenAt: '' }],
      'files:list': () => [],
      'files:stat': () => [],
      'scm:status': () => status({ ahead: 1, behind: 2, files: Array.from({ length: 100 }, (_, i) => ({ path: `f${i}.ts`, unstaged: 'modified' as const })) }),
      'scm:branches': () => [],
      'scm:log': () => [commit('c1', [])],
      'scm:show': () => ({ hash: 'c1', author: 'Ada', email: 'a@a', date: 0, message: 'first', files: [] }),
      'scm:files': () => ['a.ts'],
      'scm:stashes': () => [],
      ...over
    })

  it('activity bar, panes, shortcuts, diff and graph in place of the editor, status bar sync', { timeout: 20_000 }, async () => {
    const bridge = routes()
    useProjects.setState({ projects: [{ id: 'p', name: 'Demo', path: '/x/p', addedAt: '', lastSeenAt: '' }] })
    const { rerender } = render(<EditorView active onNavigate={vi.fn()} />)
    await act(settle)
    expect(screen.getByText('99+')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Explorer' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.keyDown(window, { key: 'p', metaKey: true })
    await act(settle)
    expect(screen.getByRole('dialog', { name: 'Go to file by name…' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByLabelText('Go to file by name…', { selector: 'input' }), { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'F', metaKey: true, shiftKey: true })
    expect(screen.getByRole('textbox', { name: 'Search' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'g', ctrlKey: true, shiftKey: true })
    expect(screen.getByRole('button', { name: 'Source Control' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.keyDown(window, { key: 'x', metaKey: true }) // not ours
    fireEvent.keyDown(window, { key: 'p' }) // no modifier

    fireEvent.click(screen.getByRole('button', { name: 'Git Graph' }))
    await act(settle)
    expect(screen.getByText('commit c1')).toBeInTheDocument()
    expect(screen.getByTestId('monaco').closest('.hidden')).not.toBeNull() // the editor stays mounted, hidden

    act(() => void useScm.setState({ diff: { path: 'a.ts', original: 'old', modified: 'new', title: 'a.ts (Index)' } }))
    rerender(<EditorView active onNavigate={vi.fn()} />)
    expect(await screen.findByTestId('diff')).toHaveTextContent('a.ts: old → new')
    fireEvent.click(screen.getByLabelText('Close diff'))
    fireEvent.click(screen.getByRole('button', { name: 'Explorer' }))

    // status bar: branch → source control; sync = pull + push
    fireEvent.click(within(document.querySelector('footer')!).getByTitle('Source Control'))
    expect(useScm.getState().pane).toBe('scm')
    fireEvent.click(screen.getByLabelText('Sync: pull 2, push 1'))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('scm:pull', { projectId: 'p' })
    expect(bridge.invoke).toHaveBeenCalledWith('scm:push', { projectId: 'p' })

    // errors show above the editor and can be dismissed
    act(() => useScm.setState({ error: 'fatal: no upstream' }))
    expect(screen.getByText('fatal: no upstream')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByText('fatal: no upstream')).toBeNull()
  })

  it('a branch without upstream offers publishing; a detached HEAD shows its commit; a small change count', async () => {
    const bridge = routes({ 'scm:status': () => status({ upstream: undefined, branch: undefined, head: 'abc1234', files: [{ path: 'a.ts', unstaged: 'modified' }] }) })
    useProjects.setState({ projects: [{ id: 'p', name: 'Demo', path: '/x/p', addedAt: '', lastSeenAt: '' }] })
    render(<EditorView active onNavigate={vi.fn()} />)
    await act(settle)
    expect(screen.getByText('abc1234 (detached)')).toBeInTheDocument()
    expect(screen.queryByText('99+')).toBeNull()
    expect(screen.getByRole('button', { name: 'Source Control' })).toHaveTextContent('1') // the change count
    fireEvent.click(screen.getByLabelText('Publish branch'))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('scm:push', { projectId: 'p' })
  })
})
