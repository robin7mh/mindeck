import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAvailability } from '@shared/types/agents'
import type { RuntimeInfo } from '@shared/types/languages'
import type { Project } from '@shared/types/project'
import type { TerminalInfo } from '@shared/types/terminal'
import { IPC_CHANNELS } from '@shared/ipc/contract'
import { fail, installBridge, installRemote, settle } from './bridge'

// The terminal view itself is xterm.js — tested with the terminal; here its tab is enough.
vi.mock('@/features/terminal/components/XtermPane', () => ({
  XtermPane: ({ tab }: { tab: TerminalInfo }) => <div data-testid="xterm">{tab.id}</div>
}))

import { Onboarding } from '@/features/onboarding/components/Onboarding'
import { OnboardingCard } from '@/features/onboarding/components/OnboardingCard'
import { loadOnboarding, useOnboarding } from '@/features/onboarding/store'
import { BROWSER_IMPORT_CHANNEL, browserImportStep, fillBrowserImportSlot, type StepProps } from '@/features/onboarding/slots'
import { guides } from '@/features/onboarding/guides'
import { useAgents } from '@/features/agents/sessions'
import { useProjects } from '@/features/projects/store'
import { useSession } from '@/features/session/store'
import { useTerminals } from '@/features/terminal/store'
import { useLocale } from '@/lib/i18n'

const KEY = 'mindeck.onboarding'

const agents = (over: Partial<Record<'claude' | 'codex' | 'gemini', Partial<AgentAvailability>>> = {}): AgentAvailability[] => [
  { kind: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.0', signedIn: true, account: 'Max plan', ready: true, ...over.claude },
  { kind: 'codex', name: 'Codex', installed: true, version: '0.98.0', signedIn: false, ready: true, ...over.codex },
  { kind: 'gemini', name: 'Gemini CLI', installed: false, ready: false, ...over.gemini }
]
const runtimes = (node: Partial<RuntimeInfo> = {}): RuntimeInfo[] => [
  { name: 'node', found: false, ...node },
  { name: 'npm', found: false },
  { name: 'git', found: true, version: '2.45.0' }
]
const project = (name: string): Project => ({ id: name, name, path: `/code/${name}` }) as Project
const tab: TerminalInfo = { id: 't-run', title: '~', cwd: '/h', cwdLabel: '~', shell: 'zsh', createdAt: '2026-01-01T00:00:00Z' }

const initial = { onboarding: useOnboarding.getState(), agents: useAgents.getState(), projects: useProjects.getState(), terminals: useTerminals.getState() }

beforeEach(() => {
  localStorage.clear()
  act(() => useLocale.setState({ locale: 'en' }))
  useOnboarding.setState({ ...initial.onboarding, open: true, done: false, step: 'welcome', known: true })
  useAgents.setState(initial.agents, true)
  useProjects.setState(initial.projects, true)
  useTerminals.setState(initial.terminals, true)
  useSession.setState({ info: { mode: 'desktop', version: '1.0.0', platform: 'darwin', hostname: 'mac', remoteTerminal: false } })
})

afterEach(() => {
  vi.useRealTimers()
  fillBrowserImportSlot(undefined)
})

const next = () => fireEvent.click(screen.getByRole('button', { name: /^Next/ }))
const current = () => screen.getByRole('listitem', { current: 'step' })

describe('onboarding store', () => {
  it('remembers per device whether it was finished, and where it stopped', () => {
    expect(loadOnboarding()).toEqual({ done: false, step: 'welcome', known: false })
    localStorage.setItem(KEY, JSON.stringify({ done: true, step: 'project' }))
    expect(loadOnboarding()).toEqual({ done: true, step: 'project', known: true })
    localStorage.setItem(KEY, JSON.stringify({ done: 'yes', step: 'nowhere' }))
    expect(loadOnboarding()).toEqual({ done: false, step: 'welcome', known: true })
    localStorage.setItem(KEY, '{ broken')
    expect(loadOnboarding()).toEqual({ done: false, step: 'welcome', known: false })

    useOnboarding.getState().go('agents')
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ done: false, step: 'agents' })
    useOnboarding.getState().finish()
    expect(useOnboarding.getState()).toMatchObject({ open: false, done: true, step: 'welcome' })
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ done: true, step: 'welcome' })
    useOnboarding.getState().restart()
    expect(useOnboarding.getState()).toMatchObject({ open: true, done: true, step: 'welcome' })

    // Storage unavailable: it still works for this run.
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    useOnboarding.getState().go('done')
    expect(useOnboarding.getState().step).toBe('done')
    set.mockRestore()
  })
})

describe('a real first start', () => {
  const fresh = () => useOnboarding.setState({ open: false, done: false, step: 'welcome', known: false })

  it('opens when this core has no projects, agent sessions or chats', async () => {
    installBridge({ 'projects:list': () => [], 'agents:list': () => undefined, 'ai:conversations': () => fail('no assistant') })
    fresh()
    await useOnboarding.getState().firstStart()
    expect(useOnboarding.getState()).toMatchObject({ open: true, known: true, done: false })
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ done: false, step: 'welcome' })
  })

  it('someone who used Mindeck before gets it marked done, silently', async () => {
    for (const routes of [{ 'projects:list': () => [project('api')] }, { 'agents:list': () => [{ id: 's1' }] }, { 'ai:conversations': () => [{ id: 'c1' }] }]) {
      localStorage.clear()
      installBridge({ 'projects:list': () => [], 'agents:list': () => [], 'ai:conversations': () => [], ...routes })
      fresh()
      await useOnboarding.getState().firstStart()
      expect(useOnboarding.getState()).toMatchObject({ open: false, done: true, known: true })
      expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ done: true, step: 'welcome' })
    }
  })

  it('asks nothing once decided — also when Settings starts it meanwhile', async () => {
    const bridge = installBridge()
    await useOnboarding.getState().firstStart() // known already
    expect(bridge.invoke).not.toHaveBeenCalled()
    let answer!: (projects: Project[]) => void
    installBridge({ 'projects:list': () => new Promise<Project[]>((r) => (answer = r)), 'agents:list': () => [], 'ai:conversations': () => [] })
    fresh()
    const deciding = useOnboarding.getState().firstStart()
    await settle()
    useOnboarding.getState().restart()
    answer([project('api')])
    await deciding
    expect(useOnboarding.getState()).toMatchObject({ open: true, done: false })
  })

  it('the desktop window decides on mount; a browser doesn’t', async () => {
    installRemote()
    fresh()
    const { unmount } = render(<Onboarding />)
    await settle()
    expect(useOnboarding.getState().known).toBe(false)
    unmount()
    installBridge({ 'projects:list': () => [], 'agents:list': () => [], 'ai:conversations': () => [] })
    render(<Onboarding />)
    await settle()
    expect(screen.getByRole('dialog', { name: 'Set up Mindeck' })).toBeInTheDocument()
  })
})

describe('the browser-import slot', () => {
  it("the browser's import panel by default; only when the core has its channel", async () => {
    vi.resetModules()
    const fresh = await import('@/features/onboarding/slots')
    const { ImportStep } = await import('@/features/browser/components/ImportDialog')
    expect(fresh.browserImportStep()).toBe(ImportStep) // this core has the channel
    expect(fresh.browserImportStep(['x'])).toBeUndefined()
    const Step = (_: StepProps) => null
    fillBrowserImportSlot(Step)
    expect(browserImportStep(['x', BROWSER_IMPORT_CHANNEL])).toBe(Step)
  })
})

describe('install guides', () => {
  it('each platform its own commands', () => {
    const by = (platform: string) => Object.fromEntries(guides(platform).map((g) => [g.id, g]))
    expect(by('win32')['claude-code'].install).toBe('irm https://claude.ai/install.ps1 | iex')
    expect(by('darwin')['claude-code'].install).toBe('curl -fsSL https://claude.ai/install.sh | bash')
    expect(by('win32').node.install).toBe('winget install --id OpenJS.NodeJS.LTS --exact')
    expect(by('darwin').node.install).toBe('brew install node')
    expect(by('linux').node.install).toBeUndefined()
    expect(by('linux').codex).toMatchObject({ install: 'npm install -g @openai/codex', signIn: 'codex login', npm: true })
  })
})

describe('Onboarding', () => {
  it('nothing outside the desktop window, nothing once closed', () => {
    installRemote()
    const { container, rerender } = render(<Onboarding />)
    expect(container).toBeEmptyDOMElement()
    installBridge()
    act(() => useOnboarding.setState({ open: false }))
    rerender(<Onboarding />)
    expect(container).toBeEmptyDOMElement()
  })

  it('walks through welcome, agents, project, import and done — and remembers it is done', async () => {
    const bridge = installBridge({
      'agents:detect': () => agents(),
      'tools:runtimes': () => runtimes(),
      'projects:list': () => [],
      'projects:pickFolder': () => ({ path: '/code/shop' }),
      'projects:add': () => project('shop'),
      'migrate:scan': () => []
    })
    render(<Onboarding />)
    const dialog = screen.getByRole('dialog', { name: 'Set up Mindeck' })
    expect(within(dialog).getByText('Step 1 of 5')).toBeInTheDocument()
    expect(current()).toHaveTextContent('Welcome')
    expect(screen.getByText('Welcome to Mindeck')).toBeInTheDocument()
    // Language and look right here.
    fireEvent.click(screen.getByRole('radio', { name: 'Deutsch' }))
    expect(screen.getByText('Willkommen bei Mindeck')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'English' }))
    expect(screen.getByRole('radiogroup', { name: 'Mode' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Back/ })).not.toBeInTheDocument()

    next()
    expect(current()).toHaveTextContent('Coding agents')
    expect(screen.getByText('Checking …')).toBeInTheDocument()
    await settle()
    expect(screen.getByText('Installed · v2.1.0 · Signed in · Max plan')).toBeInTheDocument()
    expect(screen.getByText('Installed · v0.98.0 · Not signed in yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run in terminal: codex login' })).toBeInTheDocument()
    expect(screen.getByText('Not installed · needs Node.js first')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy: npm install -g @google/gemini-cli' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy: brew install node' })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ done: false, step: 'agents' })

    next()
    expect(current()).toHaveTextContent('First project')
    await settle()
    expect(screen.getByText(/No project yet/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder …' }))
    await settle()
    expect(screen.getByText('shop')).toBeInTheDocument()
    expect(screen.getByText('/code/shop')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(current()).toHaveTextContent('Coding agents')
    next()
    next()
    expect(current()).toHaveTextContent('VS Code / Cursor')
    await settle()
    expect(bridge.invoke).toHaveBeenCalledWith('migrate:scan', undefined)

    next()
    expect(current()).toHaveTextContent('Done')
    expect(screen.getByText('Split screen')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Animation: one module, then a second one next to it' })).toBeInTheDocument()
    expect(screen.getByText('Command palette')).toBeInTheDocument()
    expect(screen.getByText('Agents')).toBeInTheDocument()
    expect(screen.getByText('Command Deck')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Skip setup' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Start working/ }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ done: true, step: 'welcome' })
  })

  it('agents: copy a command, run it in a terminal here, check again', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const written: unknown[] = []
    const bridge = installBridge({
      'agents:detect': () => agents({ gemini: { installed: true, signedIn: true, version: undefined } }),
      'tools:runtimes': () => runtimes({ found: true, version: '22.11.0' }),
      'terminal:list': () => [],
      'terminal:create': () => tab,
      'terminal:write': (p: unknown) => void written.push(p)
    })
    act(() => useOnboarding.setState({ step: 'agents' }))
    render(<Onboarding />)
    await settle()
    expect(screen.getByText('Installed · v22.11.0')).toBeInTheDocument()
    expect(screen.getByText('Installed · Signed in')).toBeInTheDocument() // Gemini: no version, no account shown
    expect(screen.queryByRole('button', { name: /Copy: brew install node/ })).not.toBeInTheDocument()

    vi.useFakeTimers()
    const copy = screen.getByRole('button', { name: 'Copy: codex login' })
    fireEvent.click(copy)
    await act(async () => {})
    expect(writeText).toHaveBeenCalledWith('codex login')
    expect(copy).toHaveAttribute('title', 'Copied')
    act(() => vi.advanceTimersByTime(1500))
    expect(copy).not.toHaveAttribute('title')
    vi.useRealTimers()
    writeText.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(copy)
    await settle()
    expect(copy).not.toHaveAttribute('title')

    fireEvent.click(screen.getByRole('button', { name: 'Run in terminal: codex login' }))
    await settle()
    expect(written).toEqual([{ id: 't-run', data: 'codex login\r' }])
    expect(screen.getByTestId('xterm')).toHaveTextContent('t-run')
    expect(screen.getByText(/Runs in a terminal/)).toBeInTheDocument()

    const detects = () => bridge.invoke.mock.calls.filter(([c]) => c === 'agents:detect').length
    expect(detects()).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: /Check again/ }))
    await settle()
    expect(detects()).toBe(2)
  })

  it('agents: Windows commands; nothing to run for Node.js on Linux; a terminal that can’t open; checks that fail', async () => {
    useSession.setState({ info: undefined })
    installBridge({
      'agents:detect': () => agents({ claude: { installed: false } }),
      'tools:runtimes': () => fail('no'),
      'terminal:list': () => [],
      'terminal:create': () => fail('remote shells are off')
    })
    act(() => useOnboarding.setState({ step: 'agents' }))
    const { unmount } = render(<Onboarding />)
    await settle()
    // Unknown platform: the POSIX installer; Node.js only through its website.
    expect(screen.getByRole('button', { name: 'Copy: curl -fsSL https://claude.ai/install.sh | bash' })).toBeInTheDocument()
    expect(screen.getByText(/Not installed — Codex and Gemini CLI install with npm/)).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /Instructions/ })[3]).toHaveAttribute('href', 'https://nodejs.org/en/download')
    fireEvent.click(screen.getByRole('button', { name: 'Run in terminal: curl -fsSL https://claude.ai/install.sh | bash' }))
    await settle()
    expect(screen.getByText('remote shells are off')).toBeInTheDocument()
    expect(screen.queryByTestId('xterm')).not.toBeInTheDocument()
    unmount()

    useSession.setState({ info: { mode: 'desktop', version: '1.0.0', platform: 'win32', hostname: 'pc', remoteTerminal: false } })
    installBridge({ 'agents:detect': () => agents({ claude: { installed: false } }), 'tools:runtimes': () => runtimes() })
    render(<Onboarding />)
    await settle()
    expect(screen.getByRole('button', { name: 'Copy: irm https://claude.ai/install.ps1 | iex' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy: winget install --id OpenJS.NodeJS.LTS --exact' })).toBeInTheDocument()
  })

  it('a project that can’t be added says why; skipping and closing end the setup', async () => {
    installBridge({ 'projects:list': () => [project('api')], 'projects:pickFolder': () => fail('dialog failed') })
    act(() => useOnboarding.setState({ step: 'project' }))
    const { unmount } = render(<Onboarding />)
    await settle()
    expect(screen.getByText('api')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder …' }))
    await settle()
    expect(screen.getByText('dialog failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }))
    expect(useOnboarding.getState()).toMatchObject({ open: false, done: true })
    unmount()

    act(() => useOnboarding.getState().restart())
    render(<Onboarding />)
    expect(current()).toHaveTextContent('Welcome')
    fireEvent.click(screen.getByRole('button', { name: 'Close setup' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('the browser package’s step, between moving over and done, when the core can import browser data', async () => {
    installBridge({ 'migrate:scan': () => [] })
    const channels = IPC_CHANNELS as unknown as string[]
    channels.push(BROWSER_IMPORT_CHANNEL)
    try {
      fillBrowserImportSlot(({ next: done }: StepProps) => (
        <button type="button" onClick={done}>
          Import bookmarks
        </button>
      ))
      act(() => useOnboarding.setState({ step: 'import' }))
      render(<Onboarding />)
      expect(screen.getByText('Step 4 of 6')).toBeInTheDocument()
      next()
      expect(current()).toHaveTextContent('Browser data')
      fireEvent.click(screen.getByRole('button', { name: 'Import bookmarks' }))
      expect(current()).toHaveTextContent('Done')
    } finally {
      channels.pop()
    }
  })

  it('a remembered step that isn’t there any more starts from the beginning', () => {
    installBridge()
    act(() => useOnboarding.setState({ step: 'browserImport' }))
    render(<Onboarding />)
    expect(current()).toHaveTextContent('Welcome')
  })
})

describe('Settings → Setup', () => {
  it('starts the setup again (desktop window only)', () => {
    installBridge()
    act(() => useOnboarding.setState({ open: false, done: true, step: 'done' }))
    const { unmount } = render(<OnboardingCard />)
    fireEvent.click(screen.getByRole('button', { name: /Run the setup again/ }))
    expect(useOnboarding.getState()).toMatchObject({ open: true, step: 'welcome' })
    unmount()
    delete (window as { mindeck?: unknown }).mindeck
    installRemote()
    const { container } = render(<OnboardingCard />)
    expect(container).toBeEmptyDOMElement()
  })
})
