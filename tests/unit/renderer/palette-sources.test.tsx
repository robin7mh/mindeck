import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge, settle } from './bridge'
import { link, library, folder } from './browserLibraryFixtures'
import { state, tab } from './browserFixtures'
import { DEFAULT_TERMINAL_SETTINGS } from '@shared/types/terminal'
import type { AgentSession } from '@shared/types/agents'
import type { NoteMeta } from '@shared/types/memory'
import { en } from '@/lib/i18n/en'
import { useLocale } from '@/lib/i18n'
import { useAppearance } from '@/lib/theme'
import { useWorkspace } from '@/features/workspace/store'
import { useProjects } from '@/features/projects/store'
import { useEditor } from '@/features/editor/store'
import { useAgents } from '@/features/agents/sessions'
import { useBrowser } from '@/features/browser/store'
import { useMemory } from '@/features/memory/store'
import { useTerminals } from '@/features/terminal/store'
import { useTerminalSettings } from '@/features/terminal/settings'
import { useOnboarding } from '@/features/onboarding/store'
import { allCommands, prepareCommands, subscribeCommands } from '@/features/palette/registry'
import { registerBuiltinCommands } from '@/features/palette/sources'
import { useRecentFiles } from '@/features/palette/recentFiles'
import { usePalette } from '@/features/palette/store'

const initial = {
  workspace: useWorkspace.getState(),
  projects: useProjects.getState(),
  editor: useEditor.getState(),
  agents: useAgents.getState(),
  browser: useBrowser.getState(),
  memory: useMemory.getState(),
  terminals: useTerminals.getState(),
  terminalSettings: useTerminalSettings.getState()
}
const project = (id: string, name: string) => ({ id, name, path: `/code/${name}`, addedAt: '', lastSeenAt: '' })
const session = (id: string, title: string) => ({ id, title, projectName: 'shop' }) as AgentSession
const note = (path: string, extra: Partial<NoteMeta> = {}) => ({ path, title: path.replace(/\.md$/, '').split('/').pop()!, folder: '', tags: [], modifiedAt: '', ...extra }) as NoteMeta
const find = (id: string) => allCommands(en).find((c) => c.id === id)
const ids = () => allCommands(en).map((c) => c.id)
const run = async (id: string) => {
  await act(async () => void (await find(id)!.run()))
}
const shown = () => useWorkspace.getState().layout.panes.map((p) => p.module)

let off: () => void
beforeEach(() => {
  useWorkspace.setState(initial.workspace, true)
  useProjects.setState(initial.projects, true)
  useEditor.setState(initial.editor, true)
  useAgents.setState(initial.agents, true)
  useBrowser.setState(initial.browser, true)
  useMemory.setState(initial.memory, true)
  useTerminals.setState(initial.terminals, true)
  useTerminalSettings.setState(initial.terminalSettings, true)
  useRecentFiles.setState({ files: [] })
  off = registerBuiltinCommands()
})
afterEach(() => off())

describe('the palette’s own commands', () => {
  it('every module: in the focused pane, or in a new one beside it', async () => {
    const open = find('module.agents')!
    expect(open).toMatchObject({ label: 'Agents', group: 'Open' })
    expect(find('module.account')!.label).toBe('Profile')
    await run('module.agents')
    expect(shown()).toEqual(['agents'])
    expect(find('module.browser.beside')).toMatchObject({ label: 'Browser in a new pane', group: 'Workspace' })
    await run('module.browser.beside')
    expect(shown()).toEqual(['agents', 'browser'])
  })

  it('the workspace’s, and they follow its layout', () => {
    expect(ids()).toContain('workspace.split')
    expect(ids()).not.toContain('workspace.close')
    const changed = vi.fn()
    const stop = subscribeCommands(changed)
    act(() => useWorkspace.getState().split())
    expect(changed).toHaveBeenCalled()
    expect(ids()).toContain('workspace.close')
    stop()
  })

  it('Settings’ sections — those of the desktop app only there', async () => {
    const titles = () => allCommands(en).filter((c) => c.group === 'Settings').map((c) => c.label)
    expect(titles()).toContain('Appearance')
    expect(titles()).toContain('Move over from VS Code / Cursor')
    expect(titles()).not.toContain('Setup')
    installBridge()
    expect(titles()).toContain('Setup')
    expect(titles()).toContain(en.stability.card)
    document.body.innerHTML = '<section data-card="Appearance"></section>'
    await run('settings.appearance')
    expect(shown()).toEqual(['settings'])
    await act(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    expect(document.querySelector('section')).toHaveAttribute('data-flash')
    document.body.innerHTML = ''
  })

  it('projects: open one in the editor, or a terminal there — fetched once the palette opens', async () => {
    const bridge = installBridge({ 'projects:list': () => [project('p1', 'shop')], 'projects:githubDesktop': () => null, 'files:list': () => [], 'terminal:list': () => [], 'terminal:create': (r: { projectId?: string }) => ({ id: 't1', title: 'zsh', cwd: '/', cwdLabel: '~', shell: 'zsh', createdAt: '', projectId: r.projectId }) })
    expect(ids().some((id) => id.startsWith('project.'))).toBe(false)
    const changed = vi.fn()
    const stop = subscribeCommands(changed)
    prepareCommands()
    await act(settle)
    expect(changed).toHaveBeenCalled()
    expect(find('project.p1')).toMatchObject({ label: 'shop', detail: '/code/shop', group: 'Projects' })
    await run('project.p1')
    expect(shown()).toEqual(['editor'])
    expect(useEditor.getState().projectId).toBe('p1')
    expect(find('project.p1.terminal')!.label).toBe('New terminal in shop')
    await run('project.p1.terminal')
    expect(shown()).toEqual(['terminal'])
    expect(bridge.invoke).toHaveBeenCalledWith('terminal:create', { projectId: 'p1' })
    expect(useTerminals.getState().tabs).toHaveLength(1) // no extra shell in Home
    prepareCommands() // there already: not fetched again
    expect(bridge.invoke.mock.calls.filter(([c]) => c === 'projects:list')).toHaveLength(1)
    stop()
  })

  it('the files last shown in the editor — of projects still there', async () => {
    installBridge({ 'files:list': () => [], 'files:read': () => ({ content: 'x', mtimeMs: 1, size: 1 }) })
    useProjects.setState({ projects: [project('p1', 'shop')] })
    act(() => useRecentFiles.setState({ files: [{ projectId: 'p1', path: 'src/app/main.ts' }, { projectId: 'p1', path: 'README.md' }, { projectId: 'gone', path: 'x.ts' }] }))
    const files = allCommands(en).filter((c) => c.group === 'Recent files')
    expect(files.map((c) => [c.label, c.detail])).toEqual([
      ['main.ts', 'shop › src › app'],
      ['README.md', 'shop']
    ])
    const open = vi.spyOn(useEditor.getState(), 'open').mockResolvedValue()
    await run('file.p1:src/app/main.ts')
    expect(shown()).toEqual(['editor'])
    expect(useEditor.getState().projectId).toBe('p1')
    expect(open).toHaveBeenCalledWith('src/app/main.ts')
  })

  it('agent sessions: a new one, the assistant, and the sessions — the five latest without a search', async () => {
    const openDialog = vi.spyOn(useAgents.getState(), 'openDialog').mockImplementation(() => {})
    const openSession = vi.spyOn(useAgents.getState(), 'open').mockResolvedValue()
    useAgents.setState({ sessions: Array.from({ length: 6 }, (_, i) => session(`s${i}`, `Task ${i}`)) })
    await run('agents.new')
    expect(shown()).toEqual(['agents'])
    expect(openDialog).toHaveBeenCalled()
    await run('agents.assistant')
    expect(useAgents.getState().view).toBe('assistant')
    expect(find('agent.s0')).toMatchObject({ label: 'Task 0', detail: 'shop', searchOnly: false })
    expect(find('agent.s5')!.searchOnly).toBe(true)
    await run('agent.s5')
    expect(openSession).toHaveBeenCalledWith('s5')
  })

  it('the browser, where the core has it: a new tab, the open ones, the bookmarks (for a search)', async () => {
    const bridge = installBridge({ 'browser:open': () => tab('n', ''), 'browser:activate': () => undefined })
    expect(ids().some((id) => id.startsWith('browser.'))).toBe(false)
    act(() =>
      useBrowser.setState({
        state: state([tab('a', 'https://a.dev/', { title: 'A dev' }), tab('b', '')]),
        bookmarks: library([link('k1', 'Docs', 'https://docs.dev/'), folder('f', 'Work', [link('k2', '', 'https://w.dev/')])])
      })
    )
    expect(find('browser.newTab')!.keys).toBe('⌘T')
    expect(find('browser.tab.a')).toMatchObject({ label: 'A dev', detail: 'https://a.dev/' })
    expect(find('browser.tab.b')!.label).toBe('New tab')
    expect(find('bookmark.k1')).toMatchObject({ label: 'Docs', searchOnly: true, group: 'Bookmarks' })
    expect(find('bookmark.k2')!.label).toBe('https://w.dev/')
    expect(find('bookmark.f')).toBeUndefined()
    await run('browser.newTab')
    expect(shown()).toEqual(['browser'])
    await run('browser.tab.a')
    expect(bridge.invoke).toHaveBeenCalledWith('browser:activate', { id: 'a' })
    const show = vi.spyOn(useBrowser.getState(), 'show').mockResolvedValue()
    await run('bookmark.k1')
    expect(show).toHaveBeenCalledWith('https://docs.dev/')
  })

  it('notes: today’s, the graph, and every note for a search — read from the vault if Memory hasn’t yet', async () => {
    let answer: unknown = [note('Ideas/plan.md', { folder: 'Ideas', tags: ['work'] }), note('inbox.md')]
    installBridge({ 'memory:list': () => answer })
    prepareCommands()
    await act(settle)
    expect(find('note.Ideas/plan.md')).toMatchObject({ label: 'plan', detail: 'Ideas', keywords: 'work', searchOnly: true, group: 'Notes' })
    expect(find('note.inbox.md')!.detail).toBeUndefined()
    const open = vi.spyOn(useMemory.getState(), 'open').mockResolvedValue()
    const daily = vi.spyOn(useMemory.getState(), 'openDaily').mockResolvedValue()
    await run('note.inbox.md')
    expect(shown()).toEqual(['memory'])
    expect(open).toHaveBeenCalledWith('inbox.md')
    await run('memory.daily')
    expect(daily).toHaveBeenCalled()
    await run('memory.graph')
    expect(useMemory.getState().view).toBe('graph')

    // Notes there: nothing to read. An answer that isn't a list, or one that comes after Memory read them, changes nothing.
    answer = 'nope'
    prepareCommands()
    act(() => useMemory.setState({ notes: [] }))
    prepareCommands()
    await act(settle)
    expect(useMemory.getState().notes).toEqual([])
    answer = [note('late.md')]
    prepareCommands()
    act(() => useMemory.setState({ notes: [note('first.md')] }))
    await act(settle)
    expect(useMemory.getState().notes.map((n) => n.path)).toEqual(['first.md'])
    installBridge({
      'memory:list': () => {
        throw new Error('no vault')
      }
    })
    act(() => useMemory.setState({ notes: [] }))
    prepareCommands()
    await act(settle)
    expect(useMemory.getState().notes).toEqual([])
  })

  it('terminals: a new one, one per shell and profile, and the terminal’s layouts', async () => {
    const bridge = installBridge({
      'terminal:settings': () => ({ ...DEFAULT_TERMINAL_SETTINGS, profiles: [{ id: 'custom-1', name: 'Python', command: 'python3', args: [], env: {} }] }),
      'terminal:shells': () => [{ id: 'zsh', name: 'zsh', file: '/bin/zsh', args: [] }],
      'terminal:list': () => [],
      'terminal:create': () => ({ id: 't1', title: 'zsh', cwd: '/', cwdLabel: '~', shell: 'zsh', createdAt: '' })
    })
    prepareCommands()
    await act(settle)
    expect(allCommands(en).filter((c) => c.id.startsWith('terminal.profile.')).map((c) => c.label)).toEqual(['New terminal with zsh', 'New terminal with Python'])
    await run('terminal.profile.custom-1')
    expect(shown()).toEqual(['terminal'])
    expect(bridge.invoke).toHaveBeenCalledWith('terminal:create', { projectId: undefined, profileId: 'custom-1' })
    await run('terminal.new')
    expect(useTerminals.getState().tabs).toHaveLength(2)
    expect(find('terminal.layout.cols')!.label).toBe('Terminal layout: Side by side')
    await run('terminal.layout.grid')
    expect(useTerminals.getState().layout).toBe('grid')
  })

  it('the look, the language, and help', async () => {
    await run('theme.light')
    expect(useAppearance.getState().appearance.mode).toBe('light')
    expect(find('theme.dark')!.label).toBe('Theme: Dark')
    await run('language.de')
    expect(useLocale.getState().locale).toBe('de')
    act(() => useLocale.getState().setLocale('en'))
    expect(find('help.shortcuts')!.keys).toBe('Ctrl+/ / ?') // in a browser on Linux
    await run('help.shortcuts')
    expect(usePalette.getState().view).toBe('shortcuts')
    expect(find('help.setup')).toBeUndefined()
    installBridge()
    await run('help.setup')
    expect(useOnboarding.getState().open).toBe(true)
    act(() => useOnboarding.getState().finish())
  })

  it('takes them all back', () => {
    off()
    expect(allCommands(en)).toEqual([])
    off = () => {}
  })
})
