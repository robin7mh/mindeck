import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, installBridge, settle } from './bridge'
import type { Project } from '@shared/types/project'
import type { NoteMeta } from '@shared/types/memory'
import type { SystemSnapshot } from '@shared/types/system'

import { Dashboard } from '@/features/dashboard/components/Dashboard'
import { ProjectsView } from '@/features/projects/components/ProjectsView'
import { ProjectDetailPanel } from '@/features/projects/components/ProjectDetailPanel'
import { useProjects } from '@/features/projects/store'
import { useTerminals } from '@/features/terminal/store'
import { en } from '@/lib/i18n/en'
const t = en.dashboard

const initialProjects = useProjects.getState()
beforeEach(() => useProjects.setState(initialProjects, true))

const proj = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  name: `Project ${id}`,
  path: `/p/${id}`,
  addedAt: '',
  lastSeenAt: '',
  ...over
})
const pending = () => new Promise<never>(() => {})
const note = (path: string, folder: string): NoteMeta =>
  ({ path, title: path, folder, tags: [], linkCount: 0, modifiedAt: '' }) as unknown as NoteMeta
const snap = (cpu: number, ram: number, disk: number, battery: SystemSnapshot['battery']): SystemSnapshot => ({
  cpu: { total: cpu, cores: [] },
  mem: { usedPct: ram, usedGb: 1, totalGb: 2 },
  disk: { usedPct: disk, mount: '/' },
  net: { rxMbps: 0, txMbps: 0 },
  battery,
  uptimeSec: 1,
  processes: [],
  ts: 1
})

describe('Dashboard ask bar', () => {
  it('with an API key: starts a new assistant chat and opens the Agents module', async () => {
    const { useAssistant } = await import('@/features/agents/store')
    const { useAgents } = await import('@/features/agents/sessions')
    const send = vi.fn(async () => true)
    const newChat = vi.fn()
    useAssistant.setState({ send, newChat, status: { configured: true, model: 'claude-opus-5-5', cloud: null, source: 'stored', settings: { model: 'm', effort: 'high', inline: false, inlineModel: 'claude-opus-5-5', cloudModel: 'claude-haiku-5-5' } } })
    const onNavigate = vi.fn()
    render(<Dashboard onNavigate={onNavigate} />)
    await act(settle)
    const input = screen.getByLabelText('Ask Mindeck')
    fireEvent.submit(input.closest('form')!) // empty: nothing
    expect(send).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '  What is next?  ' } })
    fireEvent.click(screen.getByLabelText('Ask'))
    expect(newChat).toHaveBeenCalledWith('assistant')
    expect(onNavigate).toHaveBeenCalledWith('agents')
    expect(send).toHaveBeenCalledWith('What is next?')
    expect(useAgents.getState().view).toBe('assistant')
    expect(input).toHaveValue('')
  })

  it('without an API key: opens "New chat" with the question, to pick an agent', async () => {
    const { useAssistant } = await import('@/features/agents/store')
    const { useAgents } = await import('@/features/agents/sessions')
    const send = vi.fn(async () => true)
    const openDialog = vi.fn()
    useAssistant.setState({ send, status: undefined })
    useAgents.setState({ openDialog })
    const onNavigate = vi.fn()
    render(<Dashboard onNavigate={onNavigate} />)
    await act(settle)
    fireEvent.change(screen.getByLabelText('Ask Mindeck'), { target: { value: 'Fix the login' } })
    fireEvent.click(screen.getByLabelText('Ask'))
    expect(onNavigate).toHaveBeenCalledWith('agents')
    expect(openDialog).toHaveBeenCalledWith('Fix the login')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('Dashboard', () => {
  it('shows loading tiles and a nameless greeting without a bridge', async () => {
    render(<Dashboard onNavigate={vi.fn()} />)
    await act(settle)
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toContain(',')
    // projects + brain fall back to their empty states, system stays loading
    expect(screen.getByText(new RegExp(t.noProjects))).toBeInTheDocument()
    expect(screen.getByText(new RegExp(t.noVault))).toBeInTheDocument()
    expect(screen.getByText(t.loading)).toBeInTheDocument()
  })

  it('renders live projects, the brain and a system verdict; navigates', async () => {
    const list = [
      proj('a', { git: { isRepo: true, branch: 'main', dirty: true } }),
      proj('b', { git: { isRepo: true, dirty: false } }),
      proj('c'),
      proj('d')
    ]
    installBridge({
      'system:user': () => ({ firstName: 'Robin' }),
      'projects:list': () => list,
      'projects:refresh': ({ id }: { id: string }) => (id === 'b' ? fail('x') : list.find((p) => p.id === id)),
      'memory:status': () => ({ exists: true }),
      'memory:list': () => [note('A/1.md', 'A'), note('A/2.md', 'A'), note('B/1.md', 'B'), note('root.md', '')],
      'memory:graph': () => ({ nodes: [], edges: [{}, {}] }),
      'system:snapshot': () => snap(90, 95, 95, { pct: 10, charging: false, hasBattery: true })
    })
    const onNavigate = vi.fn()
    render(<Dashboard onNavigate={onNavigate} />)
    await act(settle)

    expect(screen.getByText(', Robin')).toBeInTheDocument()
    expect(screen.getByText(`1 ${t.changed}`)).toBeInTheDocument()
    expect(screen.getByText('main')).toBeInTheDocument()
    expect(screen.queryByText('Project d')).toBeNull() // only three listed
    fireEvent.click(screen.getByText('Project a'))
    expect(useProjects.getState().selectedId).toBe('a')
    expect(onNavigate).toHaveBeenLastCalledWith('projects')
    fireEvent.click(screen.getByLabelText(`Open ${t.projects}`))
    expect(onNavigate).toHaveBeenCalledTimes(2)

    expect(screen.getByText(`${t.notes} · 2 ${t.links}`)).toBeInTheDocument()
    expect(screen.getByText('A')).toBeInTheDocument()
    fireEvent.click(screen.getByText(`${t.openGraph} →`))
    fireEvent.click(screen.getByLabelText(`Open ${t.brain}`))
    expect(onNavigate).toHaveBeenLastCalledWith('memory')

    expect(screen.getByText(t.cpuHigh)).toBeInTheDocument()
    expect(screen.getByText([t.ramHigh, t.diskHigh, t.batteryLow].join(' · '))).toBeInTheDocument()
    expect(screen.getByText(t.battery)).toBeInTheDocument()
  })

  it('all clean, all good, charging; empty-state buttons navigate', async () => {
    installBridge({
      'system:user': () => fail('no user'),
      'projects:list': () => [proj('a', { git: { isRepo: true, dirty: false } })],
      'projects:refresh': ({ id }: { id: string }) => proj(id, { git: { isRepo: true, dirty: false } }),
      'memory:status': () => ({ exists: false }),
      'memory:list': () => [],
      'memory:graph': () => ({ nodes: [], edges: [] }),
      'system:snapshot': () => snap(10, 10, 10, { pct: 10, charging: true, hasBattery: true })
    })
    const onNavigate = vi.fn()
    render(<Dashboard onNavigate={onNavigate} />)
    await act(settle)
    expect(screen.getByText(t.allClean)).toBeInTheDocument()
    expect(screen.getByText(t.allGood)).toBeInTheDocument()
    expect(screen.getByText(`${t.battery} ⚡`)).toBeInTheDocument()
    fireEvent.click(screen.getByText(new RegExp(t.noVault)))
    expect(onNavigate).toHaveBeenCalledWith('memory')
  })

  it('no battery; empty project list button; ignores results after unmount', async () => {
    let resolveList: (v: Project[]) => void = () => {}
    let resolveRefresh: (v: Project) => void = () => {}
    let rejectBrain: (e: Error) => void = () => {}
    installBridge({
      'projects:list': () => new Promise((r) => (resolveList = r)),
      'projects:refresh': () => new Promise((r) => (resolveRefresh = r)),
      'memory:status': () => new Promise((_r, j) => (rejectBrain = j)),
      'system:snapshot': () => snap(10, 10, 10, { pct: 0, charging: false, hasBattery: false })
    })
    const first = render(<Dashboard onNavigate={vi.fn()} />)
    await act(settle)
    expect(screen.queryByText(t.battery)).toBeNull()
    await act(async () => resolveList([proj('a')]))
    first.unmount()
    resolveRefresh(proj('a'))
    rejectBrain(new Error('late'))
    await settle()

    // list resolves only after unmount
    installBridge({ 'projects:list': () => new Promise((r) => (resolveList = r)), 'memory:status': pending, 'system:snapshot': pending })
    const second = render(<Dashboard onNavigate={vi.fn()} />)
    second.unmount()
    resolveList([proj('z')])
    await settle()

    // list fails after unmount
    let rejectList: (e: Error) => void = () => {}
    installBridge({ 'projects:list': () => new Promise((_r, j) => (rejectList = j)), 'memory:status': pending, 'system:snapshot': pending })
    const third = render(<Dashboard onNavigate={vi.fn()} />)
    third.unmount()
    rejectList(new Error('late'))
    await settle()

    // brain resolves after unmount
    let resolveStatus: (v: unknown) => void = () => {}
    installBridge({
      'projects:list': () => new Promise(() => {}),
      'memory:status': () => new Promise((r) => (resolveStatus = r)),
      'memory:list': () => [],
      'memory:graph': () => ({ nodes: [], edges: [] }),
      'system:snapshot': pending
    })
    const fourth = render(<Dashboard onNavigate={vi.fn()} />)
    fourth.unmount()
    resolveStatus({ exists: true })
    await settle()

    const onNavigate = vi.fn()
    installBridge({ 'projects:list': () => [], 'memory:status': pending, 'system:snapshot': pending })
    render(<Dashboard onNavigate={onNavigate} />)
    await act(settle)
    fireEvent.click(screen.getByText(new RegExp(t.addProject)))
    expect(onNavigate).toHaveBeenCalledWith('projects')
  })
})

describe('ProjectsView', () => {
  it('loading, empty, error and the selected detail', async () => {
    let resolve: (v: Project[]) => void = () => {}
    installBridge({ 'projects:list': () => new Promise((r) => (resolve = r)) })
    render(<ProjectsView onNavigate={vi.fn()} />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    await act(async () => resolve([]))
    expect(screen.getByText('No projects yet')).toBeInTheDocument()
    expect(screen.getByText('Select a project')).toBeInTheDocument()

    act(() => useProjects.setState({ error: 'boom' }))
    expect(screen.getByText('boom')).toBeInTheDocument()
  })

  it('lists projects (repo / no repo / frameworks), selects, adds', async () => {
    const list = [
      proj('a', { git: { isRepo: true, branch: 'dev', dirty: true }, stack: { languages: [], frameworks: ['React', 'Vite', 'X'], hasReadme: false } }),
      proj('b', { git: { isRepo: true } }),
      proj('c')
    ]
    const bridge = installBridge({ 'projects:list': () => list, 'projects:pickFolder': () => null, 'projects:refresh': () => new Promise(() => {}) })
    render(<ProjectsView onNavigate={vi.fn()} />)
    await act(settle)
    expect(screen.getByText('3 registered')).toBeInTheDocument()
    expect(screen.getByText('•dirty')).toBeInTheDocument()
    expect(screen.getByText('detached')).toBeInTheDocument()
    expect(screen.getByText('no repo')).toBeInTheDocument()
    expect(screen.getAllByText('Vite')).toHaveLength(2) // list item + detail
    expect(screen.getAllByText('X')).toHaveLength(1) // list shows two frameworks, detail all
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Project a')

    fireEvent.click(screen.getByText('Project c'))
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Project c')

    fireEvent.click(screen.getByText('Add project'))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('projects:pickFolder', undefined)
  })
})

describe('ProjectDetailPanel', () => {
  it('a full repo: upstream, last commit, stack, scripts; actions call the store', async () => {
    const shell = { id: 's1', title: 'a', cwd: '/a', cwdLabel: '~/a', shell: 'zsh', createdAt: '' }
    const bridge = installBridge({
      'projects:refresh': () => new Promise(() => {}),
      'projects:openInGitHubDesktop': () => undefined,
      'projects:pull': () => undefined,
      'terminal:list': () => [],
      'terminal:create': () => shell
    })
    useTerminals.setState({ tabs: [], activeId: undefined, initialized: false })
    const onNavigate = vi.fn()
    const p = proj('a', {
      git: { isRepo: true, branch: 'main', ahead: 2, dirty: false, lastCommit: { hash: 'abcdef123', subject: 'feat: x', author: 'Ro', date: '' }, webUrl: 'https://github.com/o/r' },
      stack: {
        languages: ['TypeScript', 'CSS'],
        frameworks: ['React'],
        packageManager: 'npm',
        hasReadme: true,
        packageJson: { scripts: ['dev', 'build', 'a', 'b', 'c', 'd', 'e', 'f', 'g'] }
      }
    })
    useProjects.setState({ projects: [p], githubDesktop: 'GitHub Desktop' })
    render(<ProjectDetailPanel project={p} onNavigate={onNavigate} />)
    expect(bridge.invoke).toHaveBeenCalledWith('projects:refresh', { id: 'a' }) // re-detected when shown
    expect(screen.getByText('clean')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('0')).toBeInTheDocument() // behind ?? 0
    expect(screen.getByText('abcdef1 · Ro')).toBeInTheDocument()
    expect(screen.getByText('TypeScript, CSS')).toBeInTheDocument()
    expect(screen.getByText('npm')).toBeInTheDocument()
    expect(screen.getByText('present')).toBeInTheDocument()
    expect(screen.getByText('f')).toBeInTheDocument()
    expect(screen.queryByText('g')).toBeNull() // max 8 scripts

    expect(screen.queryByText('VS Code')).toBeNull() // the project stays in Mindeck

    // Terminal, no shell in this project yet: opens one in Mindeck's own terminal — no extra Home shell.
    fireEvent.click(screen.getByText('Terminal'))
    await act(settle)
    expect(onNavigate).toHaveBeenCalledWith('terminal')
    expect(bridge.invoke.mock.calls.filter(([c]) => c === 'terminal:create')).toEqual([['terminal:create', { projectId: 'a' }]])
    expect(useTerminals.getState().activeId).toBe('s1')

    // The repo on GitHub (browser) and in GitHub Desktop.
    expect(screen.getByText('GitHub').closest('a')).toHaveAttribute('href', 'https://github.com/o/r')
    fireEvent.click(screen.getByText('GitHub Desktop'))
    expect(bridge.invoke).toHaveBeenCalledWith('projects:openInGitHubDesktop', { id: 'a' })

    expect(screen.getByText('Refreshing…').closest('button')).toBeDisabled()
    expect(screen.getByText('Pull').closest('button')).toBeDisabled() // with an upstream; busy while re-detecting
    expect(screen.getByText('Remove').closest('button')).toBeDisabled()
  })

  it("the terminal menu lists this project's shells — free or busy — and opens a new one on request", async () => {
    const a1 = { id: 'x1', title: 'a', cwd: '/a', cwdLabel: '~/a', shell: 'zsh', projectId: 'a', createdAt: '1' }
    const a2 = { ...a1, id: 'x2', createdAt: '2' }
    const other = { ...a1, id: 'y', projectId: 'b', title: 'b', createdAt: '3' }
    let failList = false
    const bridge = installBridge({
      'projects:refresh': () => new Promise(() => {}),
      'terminal:list': () => (failList ? fail('x') : [a1, { ...a2, running: 'node' }, other]),
      'terminal:create': () => ({ ...a1, id: 'x4', createdAt: '5' })
    })
    useTerminals.setState({ tabs: [a1, a2, other, { ...a1, id: 'x3', createdAt: '4', exitCode: 0 }], activeId: 'y', initialized: true })
    const onNavigate = vi.fn()
    render(<ProjectDetailPanel project={proj('a')} onNavigate={onNavigate} />)
    const button = screen.getByText('Terminal').closest('button')!
    const menuItems = () => [...document.querySelectorAll('.z-30 button')].map((b) => b.textContent)

    fireEvent.click(button)
    await act(settle)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Shells in this project')).toBeInTheDocument()
    expect(menuItems()).toEqual(['afree', 'a 2node', 'New terminal']) // not other projects', not ended ones
    fireEvent.click(screen.getByText('a 2'))
    expect([useTerminals.getState().activeId, button.getAttribute('aria-expanded')]).toEqual(['x2', 'false'])
    expect(onNavigate).toHaveBeenCalledWith('terminal')

    // closes on Escape, an outside click and a second click
    fireEvent.click(button)
    await act(settle)
    fireEvent.keyDown(document, { key: 'a' })
    fireEvent.mouseDown(screen.getByText('free')) // inside
    expect(button).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(button)
    await act(settle)
    fireEvent.mouseDown(document.body)
    expect(button).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(button)
    await act(settle)
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')

    // without the live list the shells still show; "New terminal" opens one more
    failList = true
    fireEvent.click(button)
    await act(settle)
    expect(screen.getAllByText('free')).toHaveLength(2)
    fireEvent.click(screen.getByText('New terminal'))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('terminal:create', { projectId: 'a' })
    expect(useTerminals.getState().activeId).toBe('x4')
  })

  it('dirty repo without upstream, no repo and no stack; remove', async () => {
    const bridge = installBridge({
      'projects:remove': () => undefined,
      'projects:refresh': ({ id }: { id: string }) => proj(id),
      'projects:pull': ({ id }: { id: string }) => proj(id)
    })
    useProjects.setState({ githubDesktop: 'GitHub Desktop' })
    const { rerender } = render(<ProjectDetailPanel project={proj('d', { git: { isRepo: true, behind: 1, dirty: true } })} onNavigate={vi.fn()} />)
    expect(screen.getByText('dirty')).toBeInTheDocument()
    expect(screen.getByText('detached')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    await act(settle)
    fireEvent.click(screen.getByText('Pull'))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('projects:pull', { id: 'd' })

    expect(screen.queryByText('GitHub')).toBeNull() // no origin → no repo link
    rerender(<ProjectDetailPanel project={proj('n', { stack: { languages: [], frameworks: [], hasReadme: false, packageJson: { scripts: [] } } })} onNavigate={vi.fn()} />)
    expect(screen.getByText('no repo')).toBeInTheDocument()
    expect(screen.queryByText('GitHub Desktop')).toBeNull() // not a repo
    expect(screen.queryByText('Pull')).toBeNull() // no upstream
    expect(screen.queryByText('Branch')).toBeNull()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText('none')).toBeInTheDocument()
    expect(screen.queryByText('Frameworks')).toBeNull()
    expect(screen.queryByText('Scripts')).toBeNull()

    rerender(<ProjectDetailPanel project={proj('m')} onNavigate={vi.fn()} />)
    expect(screen.getByText('none')).toBeInTheDocument()
    await act(settle)
    bridge.invoke.mockClear()
    fireEvent.click(screen.getByText('Refresh'))
    expect(bridge.invoke).toHaveBeenCalledWith('projects:refresh', { id: 'm' })
    await act(settle)
    fireEvent.click(screen.getByText('Remove'))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('projects:remove', { id: 'm' })
  })
})

describe('dashboard i18n', () => {
  it('greets by time of day and writes long dates in the UI language', async () => {
    const { greeting, longDate } = await import('@/features/dashboard/i18n')
    const { de } = await import('@/lib/i18n/de')
    const at = (h: number) => greeting(new Date(2026, 0, 1, h), de)
    expect([at(5), at(11), at(18), at(23), at(4)]).toEqual(['Guten Morgen', 'Guten Tag', 'Guten Abend', 'Gute Nacht', 'Gute Nacht'])
    expect(greeting(new Date(2026, 0, 1, 12), en)).toBe('Good afternoon')
    expect(longDate(new Date(2026, 9, 1), 'de-DE')).toBe('Donnerstag, 1. Oktober 2026')
    expect(longDate(new Date(2026, 9, 1))).toBe('Thursday, October 1, 2026')
  })

  it('counts ISO weeks', async () => {
    const { isoWeek } = await import('@/features/dashboard/i18n')
    expect(isoWeek(new Date(2026, 0, 1))).toBe(1) // Thursday
    expect(isoWeek(new Date(2027, 0, 3))).toBe(53) // Sunday → week of 2026
    expect(isoWeek(new Date(2026, 9, 1))).toBe(40)
  })
})
