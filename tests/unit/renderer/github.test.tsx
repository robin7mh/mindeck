import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { choose, fail, installBridge, settle } from './bridge'
import type { GitHubStatus, PullDetail as Detail, PullSummary } from '@shared/types/github'
import type { ScmStatus } from '@shared/types/scm'

vi.mock('@/features/editor/components/CodeEditor', () => ({ default: () => <div data-testid="monaco" /> }))
vi.mock('@/features/editor/components/DiffView', () => ({ default: ({ path }: { path: string }) => <div data-testid="diff">{path}</div> }))

import { useEditor } from '@/features/editor/store'
import { needsPublish, useScm } from '@/features/editor/scm'
import { useGitHub } from '@/features/editor/github'
import { PullsPanel } from '@/features/editor/components/PullsPanel'
import { PullDetail } from '@/features/editor/components/PullDetail'
import { ScmPanel } from '@/features/editor/components/ScmPanel'
import { EditorView } from '@/features/editor/components/EditorView'
import { useProjects } from '@/features/projects/store'
import { de } from '@/lib/i18n/de'

const initialEditor = useEditor.getState()
const initialScm = useScm.getState()
const initialGh = useGitHub.getState()
const g = () => useGitHub.getState()

const READY: GitHubStatus = { installed: true, user: 'robin', repo: { nameWithOwner: 'o/r', url: 'https://github.com/o/r', defaultBranch: 'main' } }
const pull = (over: Partial<PullSummary> = {}): PullSummary => ({
  number: 8,
  title: 'Add login',
  author: 'robin',
  head: 'feature/login',
  base: 'main',
  draft: false,
  state: 'OPEN',
  updatedAt: '2026-10-10T00:00:00Z',
  url: 'https://github.com/o/r/pull/8',
  additions: 3,
  deletions: 1,
  ...over
})
const detail = (over: Partial<Detail> = {}): Detail => ({
  ...pull(),
  body: '## Why\nBecause **login**',
  createdAt: '2026-10-09T00:00:00Z',
  mergeable: 'MERGEABLE',
  labels: ['feature'],
  checks: [
    { name: 'Tests', state: 'success', url: 'https://ci/1' },
    { name: 'Lint', state: 'failure' }
  ],
  changedFiles: 1,
  files: [{ path: 'src/login.ts', change: 'modified', additions: 3, deletions: 1 }],
  events: [
    { author: 'ann', body: 'Nice', at: '2026-10-09T01:00:00Z', kind: 'comment' },
    { author: 'bob', body: '', at: '2026-10-09T02:00:00Z', kind: 'approved' }
  ],
  commits: [{ oid: 'abc1234def', headline: 'feat: login', author: 'robin', at: '2026-10-09T00:00:00Z' }],
  ...over
})

function github(over: Record<string, (p: never) => unknown> = {}) {
  return installBridge({
    'github:status': () => READY,
    'github:list': ({ filter }: { filter: string }) => (filter === 'review' ? [] : [pull(), pull({ number: 9, title: 'WIP', draft: true, review: 'REVIEW_REQUIRED' }), pull({ number: 7, state: 'MERGED', review: 'APPROVED' }), pull({ number: 6, state: 'CLOSED', review: 'CHANGES_REQUESTED' })]),
    'github:view': ({ number }: { number: number }) => detail({ number }),
    'github:fileDiff': ({ path }: { path: string }) => ({ path, original: 'a', modified: 'b' }),
    'github:checkout': () => undefined,
    'github:merge': () => undefined,
    'github:comment': () => undefined,
    'github:review': () => undefined,
    'github:create': () => ({ number: 12, url: 'https://github.com/o/r/pull/12' }),
    'scm:push': () => undefined,
    'scm:status': () => ({ repo: true, branch: 'feature/login', upstream: 'origin/feature/login', ahead: 0, behind: 0, merging: false, files: [] }),
    'scm:branches': () => [],
    'files:list': () => [],
    ...over
  })
}

beforeEach(() => {
  useEditor.setState(initialEditor, true)
  useScm.setState(initialScm, true)
  useGitHub.setState(initialGh, true)
  useEditor.setState({ projectId: 'p' })
})

describe('GitHub store', () => {
  it('loads gh’s state and the pull requests; filters and states reload; errors show', async () => {
    useEditor.setState({ projectId: undefined })
    const bridge = github()
    await g().load()
    await g().list()
    await g().open(1)
    expect(bridge.invoke).not.toHaveBeenCalled()
    useEditor.setState({ projectId: 'p' })
    await g().load()
    expect(g().status).toEqual(READY)
    expect(g().pulls.map((p) => p.number)).toEqual([8, 9, 7, 6])
    g().setFilter('review')
    await settle()
    expect(g().pulls).toEqual([])
    g().setState('merged')
    await settle()
    expect(bridge.invoke).toHaveBeenLastCalledWith('github:list', { projectId: 'p', filter: 'review', state: 'merged' })

    // Signed out: no list asked for.
    const out = github({ 'github:status': () => ({ installed: true }) })
    await g().load()
    expect(out.invoke).not.toHaveBeenCalledWith('github:list', expect.anything())
    github({ 'github:status': () => fail('boom') })
    await g().load()
    expect(g().error).toBe('boom')
    g().clearError()
    github({ 'github:list': () => fail('rate limited') })
    await g().list()
    expect(g()).toMatchObject({ error: 'rate limited', loading: false })
  })

  it('a slow answer for a project the editor left is dropped', async () => {
    let answer!: (s: GitHubStatus) => void
    github({ 'github:status': () => new Promise((r) => (answer = r)), 'github:list': () => [pull()] })
    const loading = g().load()
    useEditor.setState({ projectId: 'q' })
    answer(READY)
    await loading
    expect(g().status).toBeUndefined()

    let list!: (p: PullSummary[]) => void
    github({ 'github:list': () => new Promise((r) => (list = r)) })
    const listing = g().list()
    useEditor.setState({ projectId: 'p' })
    list([pull()])
    await listing
    expect(g().pulls).toEqual([])
  })

  it('a new project: its pull requests once loaded; the form and the detail close', async () => {
    const bridge = github()
    useGitHub.setState({ creating: true, detail: detail() })
    act(() => useEditor.setState({ projectId: 'q' }))
    expect(g()).toMatchObject({ creating: false, detail: undefined })
    expect(bridge.invoke).not.toHaveBeenCalledWith('github:status', expect.anything())
    useGitHub.setState({ status: READY })
    act(() => useEditor.setState({ projectId: 'p' }))
    await settle()
    expect(bridge.invoke).toHaveBeenCalledWith('github:status', { projectId: 'p' })
  })

  it('opens a pull request and its files as diffs; actions reload it; one at a time; failures show', async () => {
    const bridge = github()
    const refresh = vi.spyOn(useScm.getState(), 'refresh').mockResolvedValue()
    const refreshTree = vi.spyOn(useEditor.getState(), 'refreshTree').mockResolvedValue()
    // Nothing open: nothing to act on.
    await g().openFile('a.ts')
    await g().checkout()
    await g().merge('merge', false)
    expect(await g().comment('x')).toBe(false)
    expect(await g().review('approve', '')).toBe(false)
    expect(bridge.invoke).not.toHaveBeenCalled()

    useScm.setState({ diff: { path: 'old', original: '', modified: '', title: 'old' } })
    await g().open(8)
    expect(g().detail?.number).toBe(8)
    expect(useScm.getState().diff).toBeUndefined()
    await g().openFile('src/login.ts')
    expect(useScm.getState().diff).toEqual({ path: 'src/login.ts', original: 'a', modified: 'b', title: 'src/login.ts (#8)' })

    await g().checkout()
    expect(refresh).toHaveBeenCalled()
    expect(refreshTree).toHaveBeenCalled()
    await g().merge('squash', true)
    expect(bridge.invoke).toHaveBeenCalledWith('github:merge', { projectId: 'p', number: 8, method: 'squash', deleteBranch: true })
    expect(await g().comment('LGTM')).toBe(true)
    expect(await g().review('request-changes', 'Fix')).toBe(true)
    expect(bridge.invoke).toHaveBeenCalledWith('github:review', { projectId: 'p', number: 8, action: 'request-changes', body: 'Fix' })

    useGitHub.setState({ busy: 'merge' })
    expect(await g().comment('again')).toBe(false)
    useGitHub.setState({ busy: undefined })

    github({
      'github:checkout': () => fail('local changes would be overwritten'),
      'github:merge': () => fail('not mergeable'),
      'github:comment': () => fail('locked'),
      'github:review': () => fail('locked'),
      'github:view': () => fail('not found'),
      'github:fileDiff': () => fail('HTTP 502'),
      'github:list': () => []
    })
    await g().checkout()
    expect(g().error).toBe('local changes would be overwritten')
    refresh.mockClear()
    await g().merge('merge', false)
    expect(g().error).toBe('not mergeable')
    expect(refresh).not.toHaveBeenCalled() // nothing merged: nothing to reload
    expect(await g().comment('x')).toBe(false)
    expect(g().error).toBe('locked')
    expect(await g().review('approve', '')).toBe(false)
    await g().openFile('x')
    expect(g().error).toBe('HTTP 502')
    await g().open(99)
    expect(g()).toMatchObject({ error: 'not found', opening: undefined })
    // Without a project nothing happens.
    useEditor.setState({ projectId: undefined })
    await g().openFile('x')
    expect(await g().comment('x')).toBe(false)
    g().close()
    expect(g().detail).toBeUndefined()
  })

  it('creates a pull request: pushes a branch GitHub doesn’t have (or is behind), then opens it', async () => {
    const bridge = github()
    vi.spyOn(useScm.getState(), 'refresh').mockResolvedValue()
    useGitHub.setState({ creating: true })
    useScm.setState({ status: { repo: true, branch: 'feature/login', ahead: 0, behind: 0, merging: false, files: [] } })
    await g().create({ title: 'Add login', body: 'Why', base: 'main', draft: false })
    expect(bridge.invoke.mock.calls.map((c) => c[0]).slice(0, 2)).toEqual(['scm:push', 'github:create'])
    expect(g()).toMatchObject({ creating: false, detail: { number: 12 } })

    bridge.invoke.mockClear()
    useScm.setState({ status: { repo: true, branch: 'feature/login', upstream: 'origin/feature/login', ahead: 2, behind: 0, merging: false, files: [] } })
    await g().create({ title: 'Again', body: '' })
    expect(bridge.invoke).toHaveBeenCalledWith('scm:push', { projectId: 'p' })
    bridge.invoke.mockClear()
    useScm.setState({ status: { repo: true, branch: 'feature/login', upstream: 'origin/feature/login', ahead: 0, behind: 0, merging: false, files: [] } })
    await g().create({ title: 'Pushed', body: '' })
    expect(bridge.invoke).not.toHaveBeenCalledWith('scm:push', expect.anything())

    useGitHub.setState({ creating: true })
    github({ 'github:create': () => fail('a pull request for branch "feature/login" already exists') })
    await g().create({ title: 'Dup', body: '' })
    expect(g()).toMatchObject({ creating: true, error: 'a pull request for branch "feature/login" already exists' })
  })
})

describe('pull requests pane', () => {
  it('tells how to install gh, how to sign in, that there is no repository', async () => {
    github({ 'github:status': () => ({ installed: false }) })
    const { unmount } = render(<PullsPanel />)
    expect(screen.getByLabelText('Loading…')).toBeInTheDocument()
    await act(settle)
    expect(screen.getByText('The GitHub CLI (gh) is not installed.')).toBeInTheDocument()
    expect(screen.getByText('brew install gh')).toBeInTheDocument()
    unmount()
    useGitHub.setState({ status: { installed: true } })
    const second = render(<PullsPanel />)
    expect(screen.getByText('Not signed in to GitHub.')).toBeInTheDocument()
    expect(screen.getByText('gh auth login')).toBeInTheDocument()
    second.unmount()
    useGitHub.setState({ status: { installed: true, user: 'robin', error: 'no git remotes found' } })
    const third = render(<PullsPanel />)
    expect(screen.getByText('This project has no GitHub repository.')).toBeInTheDocument()
    expect(screen.getByText('no git remotes found')).toBeInTheDocument()
    third.unmount()
    useGitHub.setState({ status: { installed: true, user: 'robin' } })
    render(<PullsPanel />)
    expect(screen.queryByText('no git remotes found')).toBeNull()
  })

  it('lists, filters, opens; shows drafts, reviews, states', async () => {
    const bridge = github()
    render(<PullsPanel />)
    await act(settle)
    expect(screen.getByText('o/r')).toHaveAttribute('title', 'Signed in as robin')
    const list = screen.getByRole('list', { name: 'Pull requests' })
    expect(within(list).getAllByRole('button')).toHaveLength(4)
    expect(within(list).getByText('Draft')).toBeInTheDocument()
    expect(within(list).getByText('Review required')).toBeInTheDocument()
    expect(within(list).getByText('Approved')).toBeInTheDocument()
    expect(within(list).getByText('Changes requested')).toBeInTheDocument()
    fireEvent.click(within(list).getByRole('button', { name: '#8 Add login' }))
    expect(g().opening).toBe(8)
    await act(settle)
    expect(within(list).getByRole('button', { name: '#8 Add login' })).toHaveAttribute('aria-current', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'To review' }))
    await act(settle)
    expect(screen.getByText('No pull requests.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'To review' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('combobox', { name: 'State' }))
    fireEvent.click(screen.getByRole('option', { name: 'Merged' }))
    await act(settle)
    expect(bridge.invoke).toHaveBeenLastCalledWith('github:list', { projectId: 'p', filter: 'review', state: 'merged' })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await act(settle)
    expect(bridge.invoke.mock.calls.filter((c) => c[0] === 'github:list')).toHaveLength(4)
  })

  it('creates a pull request from the current branch (title from it; not into itself)', async () => {
    const create = vi.spyOn(useGitHub.getState(), 'create').mockResolvedValue()
    github()
    useScm.setState({ status: { repo: true, branch: 'feature/user-login', ahead: 0, behind: 0, merging: false, files: [] } })
    render(<PullsPanel />)
    await act(settle)
    fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }))
    const form = screen.getByRole('form', { name: 'Create pull request' })
    expect(within(form).getByText('From feature/user-login')).toBeInTheDocument()
    expect(within(form).getByLabelText('Title')).toHaveValue('user login')
    fireEvent.change(within(form).getByLabelText('Description (Markdown)'), { target: { value: 'Adds login' } })
    fireEvent.click(within(form).getByLabelText('As draft'))
    fireEvent.change(within(form).getByLabelText('Into branch'), { target: { value: 'feature/user-login' } })
    expect(within(form).getByText(/Switch to a feature branch first/)).toBeInTheDocument()
    expect(within(form).getByRole('button', { name: 'Create' })).toBeDisabled()
    fireEvent.change(within(form).getByLabelText('Into branch'), { target: { value: ' develop ' } })
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: ' Add login ' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }))
    expect(create).toHaveBeenCalledWith({ title: 'Add login', body: 'Adds login', base: 'develop', draft: true })
    act(() => useGitHub.setState({ busy: 'create' }))
    expect(within(form).getByRole('button', { name: 'Create' })).toBeDisabled()
    act(() => useGitHub.setState({ busy: undefined }))
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form')).toBeNull()
  })

  it('the form without a branch or a default branch', async () => {
    useGitHub.setState({ status: { installed: true, user: 'robin', repo: { nameWithOwner: 'o/r', url: 'u' } }, creating: true })
    render(<PullsPanel />)
    const form = screen.getByRole('form', { name: 'Create pull request' })
    expect(within(form).getByText('From ?')).toBeInTheDocument()
    expect(within(form).getByLabelText('Into branch')).toHaveValue('main')
    expect(within(form).getByLabelText('Title')).toHaveValue('')
  })
})

describe('pull request detail', () => {
  it('shows description, labels, checks, files, commits and activity; opens files; checks out', async () => {
    github()
    const openFile = vi.spyOn(useGitHub.getState(), 'openFile').mockResolvedValue()
    const checkout = vi.spyOn(useGitHub.getState(), 'checkout').mockResolvedValue()
    useGitHub.setState({ detail: detail() })
    render(<PullDetail />)
    expect(screen.getByRole('heading', { name: /Add login/ })).toHaveTextContent('#8')
    expect(screen.getByText('feature')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Why' })).toBeInTheDocument()
    const checks = screen.getByRole('region', { name: 'Checks' })
    expect(within(checks).getByRole('link', { name: 'Tests' })).toHaveAttribute('href', 'https://ci/1')
    expect(within(checks).getByText('Lint')).toBeInTheDocument()
    expect(within(checks).getByLabelText('failed')).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('region', { name: 'Files (1)' })).getByRole('button', { name: /src\/login\.ts/ }))
    expect(openFile).toHaveBeenCalledWith('src/login.ts')
    expect(within(screen.getByRole('region', { name: 'Commits (1)' })).getByText('abc1234 · robin')).toBeInTheDocument()
    const activity = screen.getByRole('region', { name: 'Activity' })
    expect(within(activity).getByText('Nice')).toBeInTheDocument()
    expect(within(activity).getByText(/approved/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute('href', 'https://github.com/o/r/pull/8')
    fireEvent.click(screen.getByRole('button', { name: 'Check out' }))
    expect(checkout).toHaveBeenCalled()
    act(() => useGitHub.setState({ busy: 'checkout' }))
    expect(screen.getByRole('button', { name: 'Check out' })).toBeDisabled()
    act(() => useGitHub.setState({ busy: undefined }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(g().detail).toBeUndefined()
  })

  it('comment, approve, request changes (text needed where GitHub needs it); the box empties when sent', async () => {
    const comment = vi.spyOn(useGitHub.getState(), 'comment').mockResolvedValue(true)
    const review = vi.spyOn(useGitHub.getState(), 'review').mockResolvedValueOnce(false).mockResolvedValue(true)
    useGitHub.setState({ detail: detail() })
    render(<PullDetail />)
    const box = screen.getByRole('textbox', { name: 'Comment' })
    expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(review).toHaveBeenCalledWith('approve', '')
    fireEvent.change(box, { target: { value: 'Fix the name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))
    await act(settle)
    expect(review).toHaveBeenLastCalledWith('request-changes', 'Fix the name')
    expect(box).toHaveValue('')
    fireEvent.change(box, { target: { value: 'Thanks' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    await act(settle)
    expect(comment).toHaveBeenCalledWith('Thanks')
    act(() => useGitHub.setState({ busy: 'comment' }))
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
  })

  it('merges with the chosen method (not with conflicts); finished or draft ones only show', async () => {
    const merge = vi.spyOn(useGitHub.getState(), 'merge').mockResolvedValue()
    useGitHub.setState({ detail: detail() })
    const { unmount } = render(<PullDetail />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Merge' }))
    fireEvent.click(screen.getByRole('option', { name: 'Squash and merge' }))
    fireEvent.click(screen.getByLabelText('Delete branch afterwards'))
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))
    expect(merge).toHaveBeenCalledWith('squash', true)
    act(() => useGitHub.setState({ busy: 'merge' }))
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled()
    act(() => useGitHub.setState({ busy: undefined, detail: detail({ mergeable: 'CONFLICTING' }) }))
    expect(screen.getByText('This branch has conflicts that must be resolved first.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled()
    unmount()

    // gh lists the first 100 files; the rest are on GitHub.
    useGitHub.setState({ detail: detail({ changedFiles: 144 }) })
    const many = render(<PullDetail />)
    expect(screen.getByRole('region', { name: 'Files (144)' })).toHaveTextContent('The first 1 are listed here — Open on GitHub')
    expect(within(screen.getByRole('region', { name: 'Files (144)' })).getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute('href', 'https://github.com/o/r/pull/8/files')
    many.unmount()
    useGitHub.setState({ detail: detail({ draft: true, body: ' ', checks: [] }) })
    const draft = render(<PullDetail />)
    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull()
    expect(screen.getByText('No description.')).toBeInTheDocument()
    expect(screen.queryByText(/The first/)).toBeNull()
    expect(screen.queryByRole('region', { name: 'Checks' })).toBeNull()
    expect(screen.getAllByText('Draft').length).toBeGreaterThan(0)
    draft.unmount()
    for (const state of ['MERGED', 'CLOSED'] as const) {
      useGitHub.setState({ detail: detail({ state }) })
      const view = render(<PullDetail />)
      expect(screen.queryByRole('button', { name: 'Check out' })).toBeNull()
      expect(screen.queryByRole('textbox', { name: 'Comment' })).toBeNull()
      expect(screen.getByText(state === 'MERGED' ? 'Merged' : 'Closed')).toBeInTheDocument()
      view.unmount()
    }
  })

  it('speaks German', () => {
    expect([de.github.signedInAs('r'), de.github.into('a', 'b'), de.github.files(2), de.github.commits(1), de.github.fromBranch('x'), de.github.firstFiles(100)]).toEqual(['Angemeldet als r', 'a → b', 'Dateien (2)', 'Commits (1)', 'Von x', 'Hier stehen die ersten 100 —'])
  })
})

describe('pull requests in the editor', () => {
  const show = () => {
    useProjects.setState({ projects: [{ id: 'p', name: 'Demo', path: '/x/p', addedAt: '', lastSeenAt: '' }] })
    return render(<EditorView active onNavigate={vi.fn()} />)
  }
  const routes = (repo: boolean) =>
    github({
      'scm:status': () => ({ repo, branch: 'feature/login', upstream: 'origin/feature/login', ahead: 0, behind: 0, merging: false, files: [] }),
      'files:stat': () => [],
      'debug:session': () => null,
      'liveServer:status': () => []
    })

  it('the pane (git repositories only) shows a pull request in the editor area, its files as diffs; errors show', async () => {
    routes(true)
    show()
    await act(settle)
    const nav = screen.getByRole('navigation', { name: 'Editor' })
    fireEvent.click(within(nav).getByRole('button', { name: 'Pull requests' }))
    await act(settle)
    fireEvent.click(screen.getByRole('button', { name: '#8 Add login' }))
    await act(settle)
    expect(screen.getByRole('heading', { name: /Add login/ })).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('region', { name: 'Files (1)' })).getByRole('button', { name: /src\/login\.ts/ }))
    await act(settle)
    expect(await screen.findByTestId('diff')).toHaveTextContent('src/login.ts')
    act(() => useScm.getState().closeDiff())
    expect(screen.getByRole('heading', { name: /Add login/ })).toBeInTheDocument()
    // Another pane: the editor again.
    fireEvent.click(within(nav).getByRole('button', { name: 'Explorer' }))
    expect(screen.queryByRole('heading', { name: /Add login/ })).toBeNull()

    act(() => useGitHub.setState({ error: 'gh: HTTP 401' }))
    expect(screen.getByText('gh: HTTP 401')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0])
    expect(screen.queryByText('gh: HTTP 401')).toBeNull()
  })

  it('no repository: no pane', async () => {
    routes(false)
    show()
    await act(settle)
    expect(within(screen.getByRole('navigation', { name: 'Editor' })).queryByRole('button', { name: 'Pull requests' })).toBeNull()
  })

  it('source control opens the “create pull request” form', async () => {
    routes(true)
    useScm.setState({ status: { repo: true, branch: 'feature/login', ahead: 0, behind: 0, merging: false, files: [] } })
    const { unmount } = render(<ScmPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }))
    expect(useScm.getState().pane).toBe('prs')
    expect(g().creating).toBe(true)
    unmount()
    useScm.setState({ status: { repo: true, head: 'abc1234', ahead: 0, behind: 0, merging: false, files: [] } })
    render(<ScmPanel />)
    expect(screen.queryByRole('button', { name: 'Create pull request' })).toBeNull()
  })
})

describe('publish to GitHub', () => {
  const OWNERS = { user: 'robin', orgs: ['acme'] }
  const made = { nameWithOwner: 'acme/My-App', url: 'https://github.com/acme/My-App' }
  /** A repository that GitHub doesn't know yet: no upstream, no remote. */
  const fresh = (over: Partial<ScmStatus> = {}): ScmStatus => ({ repo: true, branch: 'master', remotes: [], ahead: 0, behind: 0, merging: false, files: [], ...over })
  const panel = (st: ScmStatus, over: Record<string, (p: never) => unknown> = {}) => {
    const bridge = github({ 'github:owners': () => OWNERS, 'github:publish': () => made, 'scm:commit': () => undefined, 'files:write': () => ({}), 'scm:status': () => st, 'scm:stashes': () => [], ...over })
    useProjects.setState({ projects: [{ id: 'p', name: 'My App', path: '/x/My App', addedAt: '', lastSeenAt: '' }] })
    useScm.setState({ status: st })
    return { bridge, ...render(<ScmPanel />) }
  }
  const publishForm = () => screen.getByRole('form', { name: 'Publish to GitHub' })

  it('is needed for a repository without upstream and without origin (an older core that lists no remotes: no)', () => {
    expect(needsPublish(undefined)).toBe(false)
    expect(needsPublish(fresh({ repo: false }))).toBe(false)
    expect(needsPublish(fresh({ upstream: 'origin/master' }))).toBe(false)
    expect(needsPublish(fresh({ remotes: undefined }))).toBe(false)
    expect(needsPublish(fresh({ remotes: ['origin'] }))).toBe(false)
    expect(needsPublish(fresh({ remotes: ['upstream'] }))).toBe(true)
    expect(needsPublish(fresh())).toBe(true)
  })

  it('store: the first commit (an empty folder gets a README first), then publish; reloads; failures show', async () => {
    const bridge = github({ 'github:publish': () => made, 'files:write': () => ({}), 'scm:commit': () => undefined })
    const refresh = vi.spyOn(useScm.getState(), 'refresh').mockResolvedValue()
    const tree = vi.spyOn(useEditor.getState(), 'refreshTree').mockResolvedValue()
    const load = vi.spyOn(g(), 'load').mockResolvedValue()
    useGitHub.setState({ status: READY })
    const channels = () => bridge.invoke.mock.calls.map((c) => c[0])

    expect(await g().publish({ name: 'My-App', owner: 'acme', private: true }, { message: 'Initial commit', readme: '# My-App\n' })).toEqual(made)
    expect(channels()).toEqual(['files:write', 'scm:commit', 'github:publish'])
    expect(bridge.invoke).toHaveBeenCalledWith('files:write', { projectId: 'p', path: 'README.md', content: '# My-App\n' })
    expect(bridge.invoke).toHaveBeenCalledWith('scm:commit', { projectId: 'p', message: 'Initial commit', all: true })
    expect(bridge.invoke).toHaveBeenCalledWith('github:publish', { projectId: 'p', name: 'My-App', owner: 'acme', private: true })
    expect(refresh).toHaveBeenCalled()
    expect(tree).toHaveBeenCalled()
    expect(load).toHaveBeenCalledTimes(1)

    // Files but no commit: no README. The pull requests were never loaded: nothing to reload.
    bridge.invoke.mockClear()
    useGitHub.setState({ status: undefined })
    await g().publish({ name: 'x', private: false }, { message: 'm' })
    expect(channels()).toEqual(['scm:commit', 'github:publish'])
    // Committed already: only publish.
    bridge.invoke.mockClear()
    await g().publish({ name: 'x', private: false })
    expect(channels()).toEqual(['github:publish'])
    expect(load).toHaveBeenCalledTimes(1)

    // A failure shows — and the status reloads anyway: a first commit may have landed.
    github({ 'github:publish': () => fail('GraphQL: Name already exists on this account (createRepository)', 'gh') })
    refresh.mockClear()
    expect(await g().publish({ name: 'x', private: true })).toBeUndefined()
    expect(g().error).toBe('GraphQL: Name already exists on this account (createRepository)')
    expect(refresh).toHaveBeenCalled()

    // Another project closes the form.
    useGitHub.setState({ publishing: true })
    act(() => useEditor.setState({ projectId: 'q' }))
    expect(g().publishing).toBe(false)
  })

  it('source control: the button opens the form — account or organization, name, description, private or public', async () => {
    const { bridge } = panel(fresh({ head: 'abc1234' }))
    expect(screen.queryByRole('button', { name: /Publish branch/ })).toBeNull()
    const open = screen.getByRole('button', { name: 'Publish to GitHub' })
    expect(open).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(open)
    expect(open).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('Loading…')).toBeInTheDocument()
    await act(settle)
    const f = publishForm()
    expect(within(f).getByLabelText('Repository name')).toHaveValue('My-App')
    expect(screen.getByRole('combobox', { name: 'Account' })).toHaveTextContent('robin')
    choose('Account', /^acme/)
    fireEvent.change(within(f).getByLabelText('Description (optional)'), { target: { value: '  A demo  ' } })
    expect(within(f).getByRole('radio', { name: /Private/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(f).getByRole('radio', { name: /Public/ }))
    expect(within(f).getByRole('radio', { name: /Public/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(f).getByRole('radio', { name: /Private/ }))
    fireEvent.click(within(f).getByRole('radio', { name: /Public/ }))
    // Committed already: nothing about a first commit.
    expect(within(f).queryByLabelText('First commit message')).toBeNull()
    fireEvent.click(within(f).getByRole('button', { name: 'Publish' }))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('github:publish', { projectId: 'p', name: 'My-App', owner: 'acme', private: false, description: 'A demo' })
    expect(screen.getByRole('status')).toHaveTextContent('Published: acme/My-App')
    expect(screen.getByRole('link', { name: /Open on GitHub/ })).toHaveAttribute('href', made.url)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(g().publishing).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
    // The button closes it as well.
    fireEvent.click(open)
    await act(settle)
    fireEvent.click(open)
    expect(screen.queryByRole('form', { name: 'Publish to GitHub' })).toBeNull()
  })

  it('before the first commit: the branch shows by its name; files go into the first commit, an empty folder gets a README', async () => {
    const { bridge, unmount } = panel(fresh({ files: [{ path: 'a.ts', unstaged: 'untracked' }] }))
    // No commit yet: git lists no branch, but HEAD is on master — not "detached".
    expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveTextContent('master')
    expect(screen.getByRole('combobox', { name: 'Branch' })).not.toHaveTextContent('detached')
    fireEvent.click(screen.getByRole('button', { name: 'Publish to GitHub' }))
    await act(settle)
    expect(within(publishForm()).getByText(/No commit yet/)).toBeInTheDocument()
    const message = screen.getByLabelText('First commit message')
    expect(message).toHaveValue('Initial commit')
    fireEvent.change(message, { target: { value: '   ' } }) // empty: the default message
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('scm:commit', { projectId: 'p', message: 'Initial commit', all: true })
    expect(bridge.invoke).not.toHaveBeenCalledWith('files:write', expect.anything())
    unmount()

    useGitHub.setState({ publishing: false })
    const empty = panel(fresh(), { 'github:publish': () => fail('HTTP 502', 'gh') })
    fireEvent.click(screen.getByRole('button', { name: 'Publish to GitHub' }))
    await act(settle)
    const f = publishForm()
    expect(within(f).getByText(/The folder is empty/)).toBeInTheDocument()
    expect(within(f).queryByLabelText('First commit message')).toBeNull()
    const name = within(f).getByLabelText('Repository name')
    // Names GitHub refuses: said, and nothing to send.
    for (const bad of ['bad name!', '.', '..']) {
      fireEvent.change(name, { target: { value: bad } })
      expect(within(f).getByText(/Letters, digits/)).toBeInTheDocument()
      expect(within(f).getByRole('button', { name: 'Publish' })).toBeDisabled()
    }
    fireEvent.change(name, { target: { value: '' } })
    expect(within(f).queryByText(/Letters, digits/)).toBeNull()
    expect(within(f).getByRole('button', { name: 'Publish' })).toBeDisabled()
    fireEvent.change(name, { target: { value: 'site' } })
    // It fails: the form stays for another try (the error shows above the editor).
    fireEvent.click(within(f).getByRole('button', { name: 'Publish' }))
    await act(settle)
    expect(empty.bridge.invoke).toHaveBeenCalledWith('files:write', { projectId: 'p', path: 'README.md', content: '# site\n' })
    expect(g().error).toBe('HTTP 502')
    expect(publishForm()).toBeInTheDocument()
    // With a description, the README carries it too.
    empty.bridge.routes['github:publish'] = () => made
    fireEvent.change(within(f).getByLabelText('Description (optional)'), { target: { value: 'About it' } })
    fireEvent.click(within(f).getByRole('button', { name: 'Publish' }))
    await act(settle)
    expect(empty.bridge.invoke).toHaveBeenCalledWith('files:write', { projectId: 'p', path: 'README.md', content: '# site\n\nAbout it\n' })
    expect(empty.bridge.invoke).toHaveBeenCalledWith('github:publish', { projectId: 'p', name: 'site', owner: 'robin', private: true, description: 'About it' })
  })

  it('busy, cancel, a project the list doesn’t know (no name to suggest)', async () => {
    panel(fresh({ head: 'abc1234' }))
    act(() => useProjects.setState({ projects: [] }))
    act(() => useGitHub.getState().setPublishing(true))
    await act(settle)
    expect(within(publishForm()).getByLabelText('Repository name')).toHaveValue('')
    fireEvent.change(within(publishForm()).getByLabelText('Repository name'), { target: { value: 'ok' } })
    act(() => useGitHub.setState({ busy: 'publish' }))
    expect(within(publishForm()).getByRole('button', { name: 'Publish' })).toBeDisabled()
    act(() => useGitHub.setState({ busy: undefined }))
    fireEvent.click(within(publishForm()).getByRole('button', { name: 'Cancel' }))
    expect(g().publishing).toBe(false)
  })

  it('without gh, signed out, or another failure: says what to do', async () => {
    const cases: [string, RegExp][] = [
      ['gh-missing', /not installed/],
      ['gh-auth', /Not signed in/],
      ['gh', /HTTP 401/]
    ]
    for (const [code, text] of cases) {
      const { unmount } = panel(fresh({ head: 'abc1234' }), { 'github:owners': () => fail(code === 'gh' ? 'HTTP 401' : code, code) })
      act(() => useGitHub.getState().setPublishing(true))
      await act(settle)
      expect(screen.getByText(text)).toBeInTheDocument()
      expect(screen.queryByRole('form', { name: 'Publish to GitHub' })).toBeNull()
      unmount()
    }
  })

  it('the status bar offers it too: source control opens with the form', async () => {
    github({ 'scm:status': () => fresh(), 'scm:stashes': () => [], 'github:owners': () => OWNERS, 'files:stat': () => [], 'debug:session': () => null, 'liveServer:status': () => [] })
    useProjects.setState({ projects: [{ id: 'p', name: 'Demo', path: '/x/p', addedAt: '', lastSeenAt: '' }] })
    render(<EditorView active onNavigate={vi.fn()} />)
    await act(settle)
    expect(screen.queryByLabelText('Publish branch')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Publish to GitHub' }))
    await act(settle)
    expect(useScm.getState().pane).toBe('scm')
    expect(g().publishing).toBe(true)
    expect(publishForm()).toBeInTheDocument()
  })

  it('speaks German', () => {
    expect([de.github.published('o/r'), de.scm.publishGitHub, de.scm.unborn]).toEqual(['Veröffentlicht: o/r', 'Auf GitHub veröffentlichen', 'noch kein Commit'])
  })
})
