import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, installBridge, settle } from './bridge'
import type { ScmStatus } from '@shared/types/scm'
import type { FileMatches, SearchProgress, TextMatch } from '@shared/types/search'
import type { EditorTab } from '@/features/editor/store'

vi.mock('@/features/editor/components/CodeEditor', () => ({ default: ({ tab }: { tab?: EditorTab }) => <div data-testid="monaco">{tab?.id ?? 'none'}</div> }))
vi.mock('@/features/editor/components/DiffView', () => ({ default: () => <div data-testid="diff" /> }))

import { useSearch } from '@/features/editor/search'
import { useScm } from '@/features/editor/scm'
import { setBufferHost, tabKey, useEditor, type BufferHost } from '@/features/editor/store'
import { useProjects } from '@/features/projects/store'
import { useConflicts } from '@/features/editor/conflicts'
import { useBlame } from '@/features/editor/blame'
import { useEditorPrefs } from '@/features/editor/prefs'
import { setEditorActions } from '@/features/editor/actions'
import { buildCommands } from '@/features/editor/commands'
import { SearchPanel } from '@/features/editor/components/SearchPanel'
import { ScmPanel } from '@/features/editor/components/ScmPanel'
import { ConflictBar } from '@/features/editor/components/ConflictBar'
import { EditorView } from '@/features/editor/components/EditorView'
import { en } from '@/lib/i18n/en'
import { de } from '@/lib/i18n/de'

useEditor.setState({ projectId: 'p' })
const initialEditor = useEditor.getState()
const initialScm = useScm.getState()
const initialSearch = useSearch.getState()
const q = () => useSearch.getState()

const match = (line: number, column: number, text: string, before = '', after = ''): TextMatch => ({ line, column, length: text.length, before, text, after })
const status = (over: Partial<ScmStatus> = {}): ScmStatus => ({ repo: true, branch: 'main', head: 'abc1234', ahead: 0, behind: 0, merging: false, files: [], ...over })
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

/** Open buffers by tab id; `edit` records and applies edits (or is missing, like an older host). */
function buffers(texts: Record<string, string>, withEdit = true) {
  const edits: [string, unknown][] = []
  const host: BufferHost = {
    snapshot: (id) => (id in texts ? { text: texts[id], version: 1 } : undefined),
    markClean: () => {},
    drop: () => {},
    rekey: () => {},
    ...(withEdit ? { edit: (id: string, e: unknown) => void edits.push([id, e]) } : {})
  }
  setBufferHost(host)
  return edits
}

beforeEach(() => {
  useEditor.setState(initialEditor, true)
  useScm.setState(initialScm, true)
  useSearch.setState(initialSearch, true)
  useConflicts.setState({ counts: {} })
  useBlame.setState({ shown: {} })
  useEditorPrefs.setState({ settings: {} })
  setBufferHost(null)
  setEditorActions(null)
})
afterEach(() => vi.useRealTimers())

/** The id the store made for its search (from the search:start call). */
const startedId = (bridge: ReturnType<typeof installBridge>, n = -1) => (bridge.invoke.mock.calls.filter(([c]) => c === 'search:start').at(n)![1] as { id: string }).id
const progress = (bridge: ReturnType<typeof installBridge>, p: Partial<SearchProgress> & { id: string }) => act(() => bridge.emit('search:progress', { files: [], done: false, ...p }))

describe('search store', () => {
  it('nothing to search: no project, no pattern, a bad regex', async () => {
    const bridge = installBridge()
    useSearch.setState({ results: [{ path: 'a', matches: [] }] })
    useEditor.setState({ projectId: undefined })
    q().set({ pattern: 'x' })
    await q().run()
    expect(q().results).toEqual([])
    useEditor.setState({ projectId: 'p' })
    q().set({ pattern: '' })
    await q().run()
    q().set({ pattern: '(', regex: true })
    await q().run()
    expect(q().error).toMatch(/Invalid regular expression/)
    q().clearError()
    expect(q().error).toBeUndefined()
    expect(bridge.invoke).not.toHaveBeenCalledWith('search:start', expect.anything())
  })

  it('searches open files with unsaved edits here, the rest in the core; streams batches; ignores old searches', async () => {
    const bridge = installBridge({ 'search:start': () => ({ engine: 'ripgrep' }), 'search:cancel': () => fail('gone') })
    const off = q().connect()
    useEditor.setState({
      tabs: [tab('src/dirty.ts', { dirty: true }), tab('docs/skip.md', { dirty: true }), tab('src/clean.ts'), tab('src/nobuf.ts', { dirty: true }), tab('src/loading.ts', { dirty: true, content: undefined }), { ...tab('src/other.ts', { dirty: true }), projectId: 'q', id: 'q:src/other.ts' }]
    })
    buffers({ 'p:src/dirty.ts': 'a needle\nneedle', 'p:docs/skip.md': 'needle' })
    q().set({ pattern: 'needle', include: 'src, docs', exclude: '*.md' })
    await q().run()
    const id = startedId(bridge)
    expect(bridge.invoke).toHaveBeenCalledWith('search:start', {
      id,
      projectId: 'p',
      query: { pattern: 'needle', regex: false, caseSensitive: false, wholeWord: false, include: ['src', 'docs'], exclude: ['*.md'], skip: ['src/dirty.ts', 'docs/skip.md', 'src/nobuf.ts'] }
    })
    expect(q()).toMatchObject({ searching: true, engine: 'ripgrep', results: [{ path: 'src/dirty.ts', matches: [{ line: 1, column: 2 }, { line: 2, column: 0 }] }] })

    progress(bridge, { id: 'old', files: [{ path: 'zzz', matches: [match(1, 0, 'needle')] }] })
    progress(bridge, { id, files: [{ path: 'src/b.ts', matches: [match(3, 1, 'needle')] }] })
    progress(bridge, { id })
    expect(q().results.map((f) => f.path)).toEqual(['src/dirty.ts', 'src/b.ts'])
    progress(bridge, { id, done: true, truncated: true })
    expect(q()).toMatchObject({ searching: false, truncated: true })
    progress(bridge, { id, files: [{ path: 'late', matches: [] }] }) // after done: ignored
    expect(q().results).toHaveLength(2)

    // Another search cancels the running one (a failing cancel is fine).
    await q().run()
    const second = startedId(bridge)
    await q().run()
    expect(bridge.invoke).toHaveBeenCalledWith('search:cancel', { id: second })
    progress(bridge, { id: startedId(bridge), done: true, error: 'The search pattern takes too long' })
    expect(q().error).toBe('The search pattern takes too long')
    // another project: the running search is cancelled (a failing cancel is fine), the results go
    await q().run()
    const running = startedId(bridge)
    bridge.invoke.mockClear()
    act(() => useEditor.setState({ projectId: 'q' }))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('search:cancel', { id: running })
    expect(q().results).toEqual([])
    off()
  })

  it('a failing start, and answers that arrive after a newer search began', async () => {
    let answer: () => unknown = () => fail('no such project')
    const bridge = installBridge({ 'search:start': () => answer() })
    q().set({ pattern: 'x' })
    await q().run()
    expect(q()).toMatchObject({ searching: false, error: 'no such project' })

    let release!: (v: unknown) => void
    answer = () => new Promise((r) => (release = r))
    const first = q().run()
    await act(settle)
    const releaseFirst = release
    answer = () => ({ engine: 'builtin' })
    await q().run()
    releaseFirst({ engine: 'ripgrep' })
    await first
    expect(q().engine).toBe('builtin')

    answer = () => new Promise((_, reject) => (release = reject))
    const failing = q().run()
    await act(settle)
    const rejectFirst = release
    answer = () => ({ engine: 'builtin' })
    await q().run()
    rejectFirst(new Error('late failure'))
    await failing
    expect(q().error).toBeUndefined()
    expect(bridge.invoke).toHaveBeenCalledWith('search:cancel', expect.anything())
  })

  it('folds files, dismisses matches and files, opens a match selected', async () => {
    installBridge({ 'files:read': () => ({ path: 'a.ts', content: 'x', mtimeMs: 1, size: 1 }) })
    const m1 = match(1, 0, 'x')
    const m2 = match(2, 0, 'x')
    useSearch.setState({ results: [{ path: 'a.ts', matches: [m1, m2] }, { path: 'b.ts', matches: [match(1, 0, 'x')] }] })
    q().toggle('a.ts')
    expect(q().collapsed).toEqual({ 'a.ts': true })
    q().toggle('a.ts')
    expect(q().collapsed).toEqual({})
    q().dismiss('a.ts', m1)
    expect(q().results[0].matches).toEqual([m2])
    q().dismiss('a.ts', m2)
    q().dismiss('b.ts')
    expect(q().results).toEqual([])

    useScm.setState({ diff: { path: 'x', original: '', modified: '', title: 'x' } })
    await q().open('a.ts', match(4, 2, 'abc'))
    expect(useScm.getState().diff).toBeUndefined()
    expect(useEditor.getState().reveal).toEqual({ id: 'p:a.ts', line: 4, match: { column: 2, length: 3 }, group: 'g1' })
  })

  /** A finished search for `(n)eedle` → `$1EEDLE!` over a buffer and two files on disk. */
  async function searched(routes: Record<string, (p: never) => unknown>, withEdit = true) {
    const bridge = installBridge({ 'search:start': () => ({ engine: 'builtin' }), ...routes })
    q().connect()
    useEditor.setState({ tabs: [tab('open.ts', { dirty: true })] })
    const edits = buffers({ 'p:open.ts': 'needle needle' }, withEdit)
    q().set({ pattern: '(n)eedle', regex: true, replace: '$1EEDLE!' })
    await q().run()
    progress(bridge, {
      id: startedId(bridge),
      done: true,
      files: [
        { path: 'disk.ts', matches: [match(1, 0, 'needle'), match(2, 3, 'needle')] },
        { path: 'gone.ts', matches: [match(1, 0, 'needle')] }
      ]
    })
    return { bridge, edits }
  }

  it('replaces: buffers as one undoable edit, files on disk guarded by their mtime; undo puts them back', async () => {
    const disk: Record<string, string> = { 'disk.ts': 'needle\nab needle', 'gone.ts': 'changed since' }
    const writes: unknown[] = []
    const { bridge, edits } = await searched({
      'files:read': ({ path }: { path: string }) => ({ path, content: disk[path], mtimeMs: 5, size: 1 }),
      'files:write': (req: { path: string; content: string; expectedMtime?: number }) => {
        writes.push(req)
        disk[req.path] = req.content
        return { mtimeMs: 9, size: 1 }
      }
    })
    expect(q().results.map((f) => f.path)).toEqual(['open.ts', 'disk.ts', 'gone.ts'])

    await q().replaceMatch('open.ts', q().results[0].matches[1])
    expect(edits).toEqual([['p:open.ts', [{ line: 1, column: 7, length: 6, text: 'nEEDLE!' }]]])
    expect(q().results[0].matches).toHaveLength(1)

    await q().replaceAll()
    expect(edits).toHaveLength(2)
    expect(writes).toEqual([{ projectId: 'p', path: 'disk.ts', content: 'nEEDLE!\nab nEEDLE!', expectedMtime: 5 }]) // gone.ts: its match isn't there any more
    expect(q().results).toEqual([])
    expect(q().undo).toEqual({ projectId: 'p', files: [{ path: 'disk.ts', before: 'needle\nab needle', mtimeMs: 9 }] })

    await q().undoReplace()
    expect(disk['disk.ts']).toBe('needle\nab needle')
    expect(q().undo).toBeUndefined()
    expect(bridge.invoke).toHaveBeenLastCalledWith('search:start', expect.anything()) // searched again
    await q().undoReplace() // nothing to undo
  })

  it('replace failures: a file changed on disk, binary files, undo conflicts; guards', async () => {
    let conflict = true
    await searched(
      {
        'files:read': ({ path }: { path: string }) => (path === 'gone.ts' ? { path, mtimeMs: 1, size: 1, unsupported: 'binary' } : { path, content: 'needle\nab needle', mtimeMs: 5, size: 1 }),
        'files:write': () => (conflict ? fail('disk.ts changed on disk since it was opened', 'conflict') : { mtimeMs: 7, size: 1 })
      },
      false
    )
    await q().replaceFile('disk.ts')
    expect(q().error).toBe('Some files were not replaced:\ndisk.ts: disk.ts changed on disk since it was opened')
    expect(q().results.find((f) => f.path === 'disk.ts')).toBeDefined() // still listed
    conflict = false
    await q().replaceFile('gone.ts') // binary now: nothing written
    expect(q().undo).toBeUndefined()
    // An open buffer without an editor that edits: the file on disk is replaced instead.
    await q().replaceFile('open.ts')
    expect(q().undo?.files.map((f) => f.path)).toEqual(['open.ts'])
    conflict = true
    await q().undoReplace()
    expect(q().error).toBe('Some files could not be restored:\nopen.ts: disk.ts changed on disk since it was opened')

    // Guards: replacing already, nothing searched, no project, nothing to replace.
    useSearch.setState({ replacing: true })
    await q().replaceAll()
    useSearch.setState({ replacing: false })
    await q().replaceFile('nope.ts')
    useEditor.setState({ projectId: undefined })
    await q().replaceAll()
    await q().preview('disk.ts')
  })

  it('previews a replacement as a diff — from the buffer or the disk', async () => {
    let broken = false
    await searched({ 'files:read': ({ path }: { path: string }) => (broken ? fail('EACCES') : path === 'gone.ts' ? { path, mtimeMs: 1, size: 1, unsupported: 'binary' } : { path, content: 'needle\nab needle', mtimeMs: 5, size: 1 }) })
    await q().preview('open.ts')
    expect(useScm.getState().diff).toEqual({ path: 'open.ts', original: 'needle needle', modified: 'nEEDLE! nEEDLE!', title: 'open.ts (replace preview)' })
    await q().preview('disk.ts')
    expect(useScm.getState().diff).toMatchObject({ original: 'needle\nab needle', modified: 'nEEDLE!\nab nEEDLE!' })
    await q().preview('gone.ts')
    expect(useScm.getState().diff).toMatchObject({ original: '', modified: '' })
    await q().preview('not-listed.ts')
    broken = true
    await q().preview('disk.ts')
    expect(q().error).toBe('EACCES')
  })

  it('another project: results go, the running search is cancelled', async () => {
    const bridge = installBridge({ 'search:start': () => ({ engine: 'builtin' }) })
    q().set({ pattern: 'x' })
    await q().run()
    useSearch.setState({ undo: { projectId: 'p', files: [] } })
    useEditor.setState({ projectId: 'q' })
    expect(bridge.invoke).toHaveBeenCalledWith('search:cancel', { id: startedId(bridge) })
    expect(q()).toMatchObject({ results: [], searching: false, undo: undefined })
    useEditor.setState({ projectId: 'q', tree: {} }) // same project: nothing happens
    useEditor.setState({ projectId: 'r' }) // nothing running: nothing to cancel
    await q().preview('x') // nothing searched in this project
  })
})

describe('SearchPanel', () => {
  it('searches as you type (debounced), with every option; Enter searches at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const run = vi.fn(async () => {})
    useSearch.setState({ run })
    render(<SearchPanel />)
    await act(() => vi.advanceTimersByTimeAsync(300))
    expect(run).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: 'needle' } })
    fireEvent.click(screen.getByLabelText('Match case'))
    fireEvent.click(screen.getByLabelText('Match whole word'))
    fireEvent.click(screen.getByLabelText('Use regular expression'))
    fireEvent.click(screen.getByLabelText('Toggle search details'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Files to include' }), { target: { value: 'src' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Files to exclude' }), { target: { value: '*.md' } })
    await act(() => vi.advanceTimersByTimeAsync(300))
    expect(run).toHaveBeenCalledTimes(2)
    expect(q()).toMatchObject({ pattern: 'needle', caseSensitive: true, wholeWord: true, regex: true, include: 'src', exclude: '*.md', showDetails: true })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search' }), { key: 'Enter' })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search' }), { key: 'a' })
    expect(run).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByLabelText('Toggle search details'))
    expect(screen.queryByRole('textbox', { name: 'Files to include' })).toBeNull()
  })

  it('results by file (sorted), states, errors, folding, opening, dismissing', async () => {
    const run = vi.fn(async () => {})
    const open = vi.fn(async () => {})
    const m = match(2, 4, 'needle', 'a = ', ' + 1')
    useSearch.setState({ run, open, pattern: 'needle', searching: true, results: [{ path: 'src/z.ts', matches: [m] }, { path: 'top.md', matches: [match(1, 0, 'needle'), match(3, 0, 'needle')] }] })
    const { rerender } = render(<SearchPanel />)
    expect(run).not.toHaveBeenCalled() // came back with results: no new search
    expect(screen.getByText('3 results in 2 files')).toBeInTheDocument()
    expect([en.search.results(1, 1), de.search.results(1, 1), de.search.results(3, 2)]).toEqual(['1 result in 1 file', '1 Treffer in 1 Datei', '3 Treffer in 2 Dateien'])
    expect(screen.getAllByRole('button', { expanded: true }).map((b) => b.title)).toEqual(['src/z.ts', 'top.md'])
    expect(screen.getAllByText('needle', { selector: 'mark' })).toHaveLength(3)
    fireEvent.click(screen.getByText(' + 1', { exact: false }))
    expect(open).toHaveBeenCalledWith('src/z.ts', m)
    fireEvent.click(screen.getByTitle('top.md'))
    expect(q().collapsed).toEqual({ 'top.md': true })
    fireEvent.click(screen.getByLabelText('Dismiss: src/z.ts:2'))
    fireEvent.click(screen.getByLabelText('Dismiss: top.md'))
    expect(q().results).toEqual([])

    act(() => useSearch.setState({ results: [], searching: true }))
    expect(screen.getByText('Searching…')).toBeInTheDocument()
    act(() => useSearch.setState({ searching: false, truncated: true }))
    expect(screen.getByText('No results.')).toBeInTheDocument()
    expect(screen.getByText(/More results than shown/)).toBeInTheDocument()
    act(() => useSearch.setState({ error: 'bad pattern' }))
    expect(screen.getByRole('alert')).toHaveTextContent('bad pattern')
    fireEvent.click(within(screen.getByRole('alert')).getByLabelText('Dismiss'))
    expect(q().error).toBeUndefined()
    act(() => useSearch.setState({ pattern: '', searching: false }))
    rerender(<SearchPanel />)
    expect(screen.queryByText('No results.')).toBeNull()
  })

  it('replace: the field, previews per match (groups expanded), per file, all, undo', async () => {
    const replaceMatch = vi.fn(async () => {})
    const replaceFile = vi.fn(async () => {})
    const replaceAll = vi.fn(async () => {})
    const preview = vi.fn(async () => {})
    const undoReplace = vi.fn(async () => {})
    const m = match(1, 4, 'foo', 'let ', '()')
    useSearch.setState({ run: vi.fn(async () => {}), replaceMatch, replaceFile, replaceAll, preview, undoReplace, pattern: '(f)oo', regex: true, results: [{ path: 'a.ts', matches: [m] }] })
    render(<SearchPanel />)
    fireEvent.click(screen.getByLabelText('Toggle replace'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Replace' }), { target: { value: '$1u' } })
    expect(screen.getByText('fu', { selector: 'ins' })).toBeInTheDocument()
    expect(screen.getByText('foo', { selector: 'del' })).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Replace: a.ts:1'))
    expect(replaceMatch).toHaveBeenCalledWith('a.ts', m)
    fireEvent.click(screen.getByLabelText('Replace all in this file: a.ts'))
    expect(replaceFile).toHaveBeenCalledWith('a.ts')
    fireEvent.click(screen.getByLabelText('Preview the replacement: a.ts'))
    expect(preview).toHaveBeenCalledWith('a.ts')
    fireEvent.click(screen.getByLabelText('Replace all'))
    expect(replaceAll).toHaveBeenCalled()

    // A pattern that doesn't match the visible line, or isn't valid any more: the raw replacement.
    act(() => useSearch.setState({ pattern: 'zzz' }))
    expect(screen.getByText('$1u', { selector: 'ins' })).toBeInTheDocument()
    act(() => useSearch.setState({ pattern: '(' }))
    expect(screen.getByText('$1u', { selector: 'ins' })).toBeInTheDocument()
    act(() => useSearch.setState({ regex: false, pattern: 'foo' }))
    expect(screen.getByText('$1u', { selector: 'ins' })).toBeInTheDocument()

    act(() => useSearch.setState({ replacing: true, undo: { projectId: 'p', files: [{ path: 'a.ts', before: '', mtimeMs: 1 }] } }))
    fireEvent.click(screen.getByText('Undo the replace in 1 file'))
    expect(undoReplace).toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Toggle replace'))
    expect(screen.queryByRole('textbox', { name: 'Replace' })).toBeNull()
  })

  it('read-only: no replacing; big result lists render in pages', { timeout: 20_000 }, () => {
    const many: FileMatches = { path: 'big.ts', matches: Array.from({ length: 250 }, (_, i) => match(i + 1, 0, 'x')) }
    useSearch.setState({ run: vi.fn(async () => {}), pattern: 'x', showReplace: true, undo: { projectId: 'p', files: [] }, results: [many, { path: 'next.ts', matches: [match(1, 0, 'x')] }] })
    render(<SearchPanel readOnly />)
    expect(screen.queryByLabelText('Toggle replace')).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Replace' })).toBeNull()
    expect(screen.queryByText(/Undo the replace/)).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(200)
    expect(screen.queryByTitle('next.ts')).toBeNull()
    fireEvent.click(screen.getByText('Show more results'))
    expect(screen.getAllByRole('listitem')).toHaveLength(251)
    expect(screen.queryByText('Show more results')).toBeNull()
  })
})

describe('source control: operations, conflicts, stashes', () => {
  const A = 'a'.repeat(40)
  const B = 'b'.repeat(40)

  it('store: abort, continue, stash, apply, pop, drop; stash files open and close', async () => {
    let broken = false
    const bridge = installBridge({
      'scm:status': () => status(),
      'scm:branches': () => [],
      'scm:stashes': () => [{ hash: A, index: 0, message: 'On main: wip', date: 0 }],
      'scm:stash': () => (broken ? fail('There are no local changes to stash') : undefined),
      'scm:stashFiles': () => (broken ? fail('Not a stash') : [{ path: 'a.ts', change: 'modified' }])
    })
    const s = () => useScm.getState()
    await s().abortOperation()
    await s().continueOperation()
    expect(await s().stash('msg', true)).toBe(true)
    await s().applyStash(A, false)
    await s().applyStash(A, true)
    await s().dropStash(A)
    const calls = bridge.invoke.mock.calls.filter(([c]) => !['scm:status', 'scm:branches', 'scm:stashes'].includes(c))
    expect(calls).toEqual([
      ['scm:abort', { projectId: 'p' }],
      ['scm:continue', { projectId: 'p' }],
      ['scm:stash', { projectId: 'p', message: 'msg', untracked: true }],
      ['scm:applyStash', { projectId: 'p', hash: A, pop: false }],
      ['scm:applyStash', { projectId: 'p', hash: A, pop: true }],
      ['scm:dropStash', { projectId: 'p', hash: A }]
    ])
    expect(s().stashes).toHaveLength(1)

    await s().toggleStash(A)
    expect(s().stashFiles).toEqual({ [A]: [{ path: 'a.ts', change: 'modified' }] })
    await s().toggleStash(A)
    expect(s().stashFiles).toEqual({})
    broken = true
    expect(await s().stash('', false)).toBe(false)
    expect(s().error).toBe('There are no local changes to stash')
    await s().toggleStash(B)
    expect(s().error).toBe('Not a stash')
    useEditor.setState({ projectId: undefined })
    await s().toggleStash(A)
  })

  it('the operation banner: what stopped, abort (asking first), continue once resolved', () => {
    const abortOperation = vi.fn(async () => {})
    const continueOperation = vi.fn(async () => {})
    useScm.setState({ abortOperation, continueOperation, stashes: [], status: status({ operation: { kind: 'rebase', step: 2, total: 5 }, files: [{ path: 'c.ts', unstaged: 'conflicted' }] }) })
    const { rerender } = render(<ScmPanel />)
    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('Rebasing 2/5 · 1 file with conflicts')
    expect(within(banner).getByRole('button', { name: /Continue/ })).toBeDisabled()
    fireEvent.click(within(banner).getByRole('button', { name: /Abort/ }))
    expect(banner).toHaveTextContent('Abort and go back to where it started?')
    fireEvent.click(within(banner).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(banner).getByRole('button', { name: /Abort/ }))
    fireEvent.click(within(banner).getByRole('button', { name: 'Abort' }))
    expect(abortOperation).toHaveBeenCalled()

    act(() => useScm.setState({ status: status({ operation: { kind: 'rebase' }, files: [] }) }))
    expect(screen.getByRole('status')).toHaveTextContent('Rebasing · conflicts resolved: continue when ready')
    act(() => useScm.setState({ status: status({ operation: { kind: 'cherry-pick' }, files: [{ path: 'a.ts', unstaged: 'conflicted' }, { path: 'b.ts', unstaged: 'conflicted' }] }) }))
    expect(screen.getByRole('status')).toHaveTextContent('Cherry-picking · 2 files with conflicts')
    act(() => useScm.setState({ status: status({ operation: { kind: 'merge' }, files: [] }) }))
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    expect(continueOperation).toHaveBeenCalled()
    act(() => useScm.setState({ busy: 'continue' }))
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled()

    rerender(<ScmPanel readOnly />)
    expect(within(screen.getByRole('status')).queryByRole('button')).toBeNull()
  })

  it('conflicted files open in the editor; "Mark as resolved" stages them', async () => {
    installBridge({ 'files:read': () => ({ path: 'c.ts', content: 'x', mtimeMs: 1, size: 1 }) })
    const stage = vi.fn(async () => {})
    useScm.setState({ stage, stashes: [], diff: { path: 'x', original: '', modified: '', title: 'x' }, status: status({ operation: { kind: 'merge' }, merging: true, files: [{ path: 'src/c.ts', unstaged: 'conflicted' }] }) })
    render(<ScmPanel />)
    fireEvent.click(screen.getByLabelText('Mark as resolved: src/c.ts'))
    expect(stage).toHaveBeenCalledWith(['src/c.ts'])
    fireEvent.click(screen.getByTitle('src/c.ts · Conflict'))
    await act(settle)
    expect(useEditor.getState().activeId).toBe('p:src/c.ts')
    expect(useScm.getState().diff).toBeUndefined()
  })

  it('stashes: list, files with diffs, apply / pop / drop (asking first); stash with a message and untracked files', async () => {
    const applyStash = vi.fn(async () => {})
    const dropStash = vi.fn(async () => {})
    const toggleStash = vi.fn(async () => {})
    const openDiff = vi.fn(async () => {})
    let stashed = false
    const stash = vi.fn(async () => stashed)
    useScm.setState({
      applyStash,
      dropStash,
      toggleStash,
      openDiff,
      stash,
      status: status({ files: [{ path: 'a.ts', unstaged: 'modified' }] }),
      stashes: [
        { hash: A, index: 0, message: 'On main: first try', date: Date.now() },
        { hash: B, index: 1, message: 'WIP on main: abc init', date: Date.now() }
      ],
      stashFiles: { [A]: [{ path: 'src/a.ts', change: 'modified' }, { path: 'new.ts', change: 'untracked' }, { path: 'b.ts', from: 'old.ts', change: 'renamed' }] }
    })
    const { rerender } = render(<ScmPanel />)
    expect(screen.getByText('first try')).toBeInTheDocument()
    expect(screen.getByText('WIP on main: abc init')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('WIP on main: abc init'))
    expect(toggleStash).toHaveBeenCalledWith(B)
    fireEvent.click(screen.getByTitle('src/a.ts'))
    expect(openDiff).toHaveBeenLastCalledWith({ path: 'src/a.ts', change: 'modified' }, { kind: 'stash', hash: A, from: undefined, untracked: false }, 'a.ts (Stashes: first try)')
    fireEvent.click(screen.getByTitle('new.ts'))
    expect(openDiff).toHaveBeenLastCalledWith(expect.anything(), { kind: 'stash', hash: A, from: undefined, untracked: true }, expect.anything())
    fireEvent.click(screen.getByTitle('old.ts → b.ts'))
    expect(openDiff).toHaveBeenLastCalledWith(expect.anything(), { kind: 'stash', hash: A, from: 'old.ts', untracked: false }, expect.anything())

    fireEvent.click(screen.getByLabelText('Apply: On main: first try'))
    expect(applyStash).toHaveBeenLastCalledWith(A, false)
    fireEvent.click(screen.getByLabelText('Pop (apply, then drop): On main: first try'))
    expect(applyStash).toHaveBeenLastCalledWith(A, true)
    fireEvent.click(screen.getByLabelText('Drop: WIP on main: abc init'))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('Drop the stash "WIP on main: abc init"?')
    fireEvent.click(within(dialog).getByText('Cancel'))
    expect(dropStash).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Drop: WIP on main: abc init'))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Drop'))
    expect(dropStash).toHaveBeenCalledWith(B)

    // Stashing: a message, untracked files too; a failure keeps the form open.
    fireEvent.click(screen.getByLabelText('Stash changes'))
    fireEvent.change(screen.getByLabelText('Message (optional)'), { target: { value: 'later' } })
    fireEvent.click(screen.getByLabelText('Include untracked files'))
    fireEvent.click(screen.getByRole('button', { name: 'Stash' }))
    await act(settle)
    expect(stash).toHaveBeenLastCalledWith('later', true)
    expect(screen.getByLabelText('Message (optional)')).toBeInTheDocument()
    stashed = true
    fireEvent.keyDown(screen.getByLabelText('Message (optional)'), { key: 'Enter' })
    await act(settle)
    expect(screen.queryByLabelText('Message (optional)')).toBeNull()
    fireEvent.click(screen.getByLabelText('Stash changes'))
    fireEvent.keyDown(screen.getByLabelText('Message (optional)'), { key: 'x' })
    fireEvent.keyDown(screen.getByLabelText('Message (optional)'), { key: 'Escape' })
    expect(screen.queryByLabelText('Message (optional)')).toBeNull()
    fireEvent.click(screen.getByLabelText('Stash changes'))
    act(() => useScm.setState({ busy: 'stash' }))
    expect(screen.getByRole('button', { name: 'Stash' })).toBeDisabled()

    act(() => useScm.setState({ busy: undefined, stashes: [] }))
    rerender(<ScmPanel readOnly />)
    expect(screen.getByText('No stashes.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Stash changes')).toBeNull()
  })
})

describe('ConflictBar', () => {
  it('counts, navigates, accepts all; "Mark as resolved" saves and stages once none are left', async () => {
    const ran: string[] = []
    setEditorActions({ list: () => [], run: (id) => void ran.push(id) })
    const stage = vi.fn(async () => {})
    const save = vi.spyOn(useEditor.getState(), 'save')
    useScm.setState({ stage, status: status({ files: [{ path: 'c.ts', unstaged: 'conflicted' }] }) })
    const t = tab('c.ts', { dirty: true })
    useEditor.setState({ tabs: [t] })
    act(() => useConflicts.getState().setCount(t.id, 2))
    const { rerender, container } = render(<ConflictBar tab={t} readOnly={false} />)
    expect(screen.getByRole('status')).toHaveTextContent('2 merge conflicts')
    fireEvent.click(screen.getByLabelText('Previous conflict'))
    fireEvent.click(screen.getByLabelText('Next conflict'))
    fireEvent.click(screen.getByText('All current'))
    fireEvent.click(screen.getByText('All incoming'))
    expect(ran).toEqual(['mindeck.conflict.previous', 'mindeck.conflict.next', 'mindeck.conflict.acceptAllCurrent', 'mindeck.conflict.acceptAllIncoming'])
    expect(screen.getByRole('button', { name: /Mark as resolved/ })).toBeDisabled()

    act(() => useConflicts.getState().setCount(t.id, 0))
    expect(screen.getByRole('status')).toHaveTextContent('No conflicts left in this file.')
    save.mockResolvedValueOnce(false) // the save failed: not staged
    fireEvent.click(screen.getByRole('button', { name: /Mark as resolved/ }))
    await act(settle)
    expect(stage).not.toHaveBeenCalled()
    save.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: /Mark as resolved/ }))
    await act(settle)
    expect(stage).toHaveBeenCalledWith(['c.ts'])
    rerender(<ConflictBar tab={{ ...t, dirty: false }} readOnly={false} />)
    fireEvent.click(screen.getByRole('button', { name: /Mark as resolved/ }))
    await act(settle)
    expect(save).toHaveBeenCalledTimes(2)

    // Read-only: looking and moving only; without an editor the buttons do nothing.
    setEditorActions(null)
    act(() => useConflicts.getState().setCount(t.id, 1))
    rerender(<ConflictBar tab={t} readOnly />)
    fireEvent.click(screen.getByLabelText('Next conflict'))
    expect(screen.queryByText('All current')).toBeNull()
    expect(screen.queryByRole('button', { name: /Mark as resolved/ })).toBeNull()

    // Nothing to show: no conflicts, or a tab of another project.
    act(() => useConflicts.getState().setCount(t.id, 0))
    rerender(<ConflictBar tab={{ ...t, path: 'other.ts' }} readOnly={false} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<ConflictBar tab={{ ...t, projectId: 'q', id: 'q:c.ts' }} readOnly={false} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('palette and editor view', () => {
  it('git commands: stash (with a message), file blame, inline blame', async () => {
    const stash = vi.fn(async () => true)
    const update = vi.fn(async () => {})
    useScm.setState({ stash, status: status() })
    useEditorPrefs.setState({ update })
    const items = buildCommands(en, { readOnly: false })
    const run = (id: string) => items.find((i) => i.id === id)!.run()
    run('git.stash')
    await useScm.getState().pick!.onText!('one')
    run('git.stashUntracked')
    await useScm.getState().pick!.onText!('two')
    expect(stash.mock.calls).toEqual([
      ['one', false],
      ['two', true]
    ])
    run('git.blame') // no file open: nothing
    expect(useBlame.getState().shown).toEqual({})
    useEditor.setState({ tabs: [tab('a.ts')], activeId: 'p:a.ts' })
    run('git.blame')
    expect(useBlame.getState().shown).toEqual({ 'p:a.ts': true })
    run('git.inlineBlame')
    expect(update).toHaveBeenLastCalledWith({ inlineBlame: false })
    useEditorPrefs.setState({ settings: { inlineBlame: false } })
    run('git.inlineBlame')
    expect(update).toHaveBeenLastCalledWith({ inlineBlame: true })
  })

  it('⇧⌘H opens search & replace; the status bar toggles blame; the conflict bar sits above the editor', async () => {
    installBridge({
      'projects:list': () => [{ id: 'p', name: 'Demo', path: '/x/p', addedAt: '', lastSeenAt: '' }],
      'files:list': () => [],
      'files:stat': () => [],
      'files:read': () => ({ path: 'c.ts', content: '<<<<<<<', mtimeMs: 1, size: 1 }),
      'scm:status': () => status({ files: [{ path: 'c.ts', unstaged: 'conflicted' }] }),
      'scm:branches': () => [],
      'scm:stashes': () => [],
      'search:start': () => ({ engine: 'builtin' })
    })
    useProjects.setState({ projects: [{ id: 'p', name: 'Demo', path: '/x/p', addedAt: '', lastSeenAt: '' }] })
    render(<EditorView active onNavigate={vi.fn()} />)
    await act(settle)
    fireEvent.keyDown(window, { key: 'H', metaKey: true, shiftKey: true })
    expect(screen.getByRole('textbox', { name: 'Replace' })).toBeInTheDocument()

    await act(() => useEditor.getState().open('c.ts'))
    await act(settle)
    expect(screen.getByText('No conflicts left in this file.')).toBeInTheDocument()
    const blame = within(document.querySelector('footer')!).getByTitle('Toggle File Blame')
    expect(blame).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(blame)
    expect(blame).toHaveAttribute('aria-pressed', 'true')
    expect(useBlame.getState().shown).toEqual({ 'p:c.ts': true })
  })
})
