import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { installBridge, installRemote, settle } from './bridge'
import type { LanguageStatus } from '@shared/types/languages'
import type { MigrationSource } from '@shared/types/migrate'
import { LanguagesSection, kindOf } from '@/features/settings/components/sections/LanguagesSection'
import { MigrateSection } from '@/features/settings/components/sections/MigrateSection'
import { MigrateCard } from '@/features/settings/components/MigrateCard'
import { useLanguages } from '@/features/editor/languages'
import { useEditorPrefs } from '@/features/editor/prefs'

const status = (over: Partial<Record<string, LanguageStatus>> = {}): LanguageStatus[] => [
  { id: 'python', name: 'Python', server: { name: 'Pyright', state: 'missing', requires: 'npm', command: 'npm install pyright' }, debugger: { name: 'debugpy', state: 'ready' }, ...over.python },
  { id: 'go', name: 'Go', server: { name: 'gopls', state: 'toolchain', requires: 'go' }, debugger: { name: 'Delve', state: 'toolchain', requires: 'go' }, ...over.go },
  { id: 'swift', name: 'Swift', server: { name: 'SourceKit-LSP', state: 'manual' }, ...over.swift }
]

beforeEach(() => {
  useLanguages.setState({ files: {}, toolsVersion: 0 })
})

/** A language's row: its name, its tools and what to do — with the install output and errors under it. */
const row = (name: string) => screen.getByText(name, { selector: 'p' }).parentElement!.parentElement!
/** The group (a titled card) a heading starts. */
const group = (title: string) => screen.getByRole('heading', { name: title }).closest('section')!

describe('Settings → Languages', () => {
  it('sorts each language by what it needs', () => {
    const [python, go, swift] = status()
    expect([python, go, swift].map(kindOf)).toEqual(['install', 'needs', 'needs'])
    expect(kindOf({ ...python, server: { name: 'Pyright', state: 'ready' } })).toBe('ready')
    expect(kindOf({ ...go, server: { name: 'gopls', state: 'ready' } })).toBe('ready') // the debugger still needs Go
    expect(kindOf({ ...go, server: { name: 'gopls', state: 'ready' }, debugger: { name: 'Delve', state: 'missing' } })).toBe('install')
  })

  it('lists every language with its server and debugger; installs on request with live output', async () => {
    let release!: () => void
    const bridge = installBridge({
      'tools:status': () => status(),
      'tools:install': () =>
        new Promise((r) => (release = () => r({ ...status()[0], server: { name: 'Pyright', state: 'ready' } })))
    })
    render(<LanguagesSection />)
    expect(screen.getByLabelText('Loading…')).toBeInTheDocument()
    await act(settle)
    expect(screen.queryByRole('heading', { name: /^Ready/ })).toBeNull()
    expect(within(group('One click to install · 1')).getByText('Python')).toBeInTheDocument()
    const needs = group('Needs the language itself first · 2')
    expect(within(needs).getByText('Go')).toBeInTheDocument()
    expect(within(needs).getByText('Swift')).toBeInTheDocument()
    const python = row('Python')
    expect(python).toHaveTextContent('Pyright')
    expect(python).toHaveTextContent('debugpy')
    expect(within(python).getByText('Pyright')).toHaveAttribute('title', 'npm install pyright') // what will run
    expect(row('Go')).toHaveTextContent('goplsDelve')
    expect(row('Go')).toHaveTextContent('Install go first')
    expect(within(row('Go')).getByRole('link', { name: 'Guide' })).toHaveAttribute('href', 'https://go.dev/dl/')
    expect(row('Swift')).toHaveTextContent('comes with its toolchain')
    expect(within(row('Swift')).queryByRole('link')).toBeNull() // nothing to point at
    expect(screen.getAllByRole('button', { name: /^Install/ })).toHaveLength(1) // one button per language

    fireEvent.click(within(python).getByRole('button', { name: 'Install Python' }))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('tools:install', { id: 'python', part: 'server' })
    expect(within(python).getByRole('button', { name: 'Install Python' })).toBeDisabled()
    act(() => {
      bridge.emit('tools:progress', { id: 'python', part: 'server', line: '$ npm install pyright' })
      bridge.emit('tools:progress', { id: 'python', part: 'server', line: 'added 1 package' })
    })
    expect(within(python).getByLabelText('Install output')).toHaveTextContent('$ npm install pyright added 1 package')
    act(() => {
      bridge.emit('tools:progress', { id: 'go', part: 'server', line: 'other log' })
      bridge.emit('tools:progress', { id: 'python', part: 'server', line: 'back again' })
    })
    expect(within(python).getByLabelText('Install output')).toHaveTextContent('back again')
    expect(within(python).getByLabelText('Install output')).not.toHaveTextContent('other log')
    await act(async () => {
      release()
      await settle()
    })
    expect(bridge.invoke.mock.calls.filter(([c]) => c === 'tools:install')).toHaveLength(1) // the debugger was there already
    expect(within(group('Ready · 1')).getByText('Python')).toBeInTheDocument()
    expect(row('Python')).toHaveTextContent(/Pyright\s*debugpy\s*Ready/)
    expect(screen.queryByRole('heading', { name: /^One click to install/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Install Python' })).toBeNull()
    expect(screen.queryByLabelText('Install output')).toBeNull()
    expect(useLanguages.getState().toolsVersion).toBe(1) // open files pick their server up
  })

  it('a failed install shows why, under its language; checking again reloads the list', async () => {
    const bridge = installBridge({ 'tools:status': () => status(), 'tools:install': () => Promise.reject(new Error('npm ERR! network')) })
    render(<LanguagesSection />)
    await act(settle)
    fireEvent.click(screen.getByRole('button', { name: 'Install Python' }))
    await act(settle)
    expect(within(row('Python')).getByRole('alert')).toHaveTextContent('npm ERR! network')
    expect(within(row('Go')).queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Install Python' })).toBeEnabled() // ready to try again
    expect(useLanguages.getState().toolsVersion).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await act(settle)
    expect(bridge.invoke.mock.calls.filter(([c]) => c === 'tools:status')).toHaveLength(2)
  })

  it('a debugger to install; both parts missing go one after the other; a core that can’t tell', async () => {
    const bridge = installBridge({
      'tools:status': () => status({ python: { id: 'python', name: 'Python', server: { name: 'Pyright', state: 'ready' }, debugger: { name: 'debugpy', state: 'missing', requires: 'python3' } } }),
      'tools:install': () => status()[0]
    })
    const { unmount } = render(<LanguagesSection />)
    await act(settle)
    fireEvent.click(screen.getByRole('button', { name: 'Install Python' }))
    await act(settle)
    expect(bridge.invoke.mock.calls.filter(([c]) => c === 'tools:install').map(([, p]) => p)).toEqual([{ id: 'python', part: 'debugger' }])
    unmount()

    useLanguages.setState({ toolsVersion: 0 })
    const python = status()[0]
    const both = installBridge({
      'tools:status': () => status({ python: { ...python, debugger: { name: 'debugpy', state: 'missing', requires: 'python3' } } }),
      'tools:install': ({ part }: { part: string }) =>
        part === 'server'
          ? { ...python, server: { name: 'Pyright', state: 'ready' }, debugger: { name: 'debugpy', state: 'missing' } }
          : { ...python, server: { name: 'Pyright', state: 'ready' }, debugger: { name: 'debugpy', state: 'ready' } }
    })
    const second = render(<LanguagesSection />)
    await act(settle)
    fireEvent.click(screen.getByRole('button', { name: 'Install Python' }))
    await act(settle)
    expect(both.invoke.mock.calls.filter(([c]) => c === 'tools:install').map(([, p]) => p)).toEqual([
      { id: 'python', part: 'server' },
      { id: 'python', part: 'debugger' }
    ])
    expect(within(group('Ready · 1')).getByText('Python')).toBeInTheDocument()
    expect(useLanguages.getState().toolsVersion).toBe(2) // after each part that came
    second.unmount()

    // the server comes, the debugger fails: open files still pick up the server
    useLanguages.setState({ toolsVersion: 0 })
    installBridge({
      'tools:status': () => status({ python: { ...python, debugger: { name: 'debugpy', state: 'missing', requires: 'python3' } } }),
      'tools:install': ({ part }: { part: string }) =>
        part === 'server' ? { ...python, server: { name: 'Pyright', state: 'ready' }, debugger: { name: 'debugpy', state: 'missing' } } : Promise.reject(new Error('pip failed'))
    })
    const third = render(<LanguagesSection />)
    await act(settle)
    fireEvent.click(screen.getByRole('button', { name: 'Install Python' }))
    await act(settle)
    expect(within(row('Python')).getByRole('alert')).toHaveTextContent('pip failed')
    expect(useLanguages.getState().toolsVersion).toBe(1)
    third.unmount()

    installBridge({ 'tools:status': () => Promise.reject(new Error('remote shells are off')) })
    const { container } = render(<LanguagesSection />)
    await act(settle)
    expect(container).toHaveTextContent('remote shells are off')
    expect(screen.queryByLabelText('Loading…')).toBeNull()
  })

  it('a language whose server is there but not its debugger says what is missing', async () => {
    installBridge({ 'tools:status': () => status({ go: { id: 'go', name: 'Go', server: { name: 'gopls', state: 'ready' }, debugger: { name: 'Delve', state: 'toolchain', requires: 'go' } } }) })
    render(<LanguagesSection />)
    await act(settle)
    expect(within(group('Ready · 1')).getByText('Go')).toBeInTheDocument()
    expect(row('Go')).toHaveTextContent('Partly — Delve needs go')
    expect(within(row('Go')).queryByRole('button')).toBeNull()
  })
})

describe('Settings → moving over from VS Code / Cursor', () => {
  const source = (over: Partial<MigrationSource> = {}): MigrationSource => ({
    app: 'Code',
    name: 'Visual Studio Code',
    settings: 3,
    keybindings: 2,
    snippets: 455,
    extensions: [
      { id: 'mhutchie.git-graph', name: 'Git Graph', fate: 'built-in' },
      { id: 'ms-python.python', name: 'Python', fate: 'language', language: 'python' },
      { id: 'ms-python.debugpy', name: 'Python Debugger', fate: 'language', language: 'python' },
      { id: 'x.lang', name: 'Odd', fate: 'language', language: 'cobol' },
      { id: 'dsznajder.es7', name: 'ES7 snippets', fate: 'snippets' },
      { id: 'zhuangtongfa.theme', name: 'One Dark Pro', fate: 'theme' },
      { id: 'random.tool', name: 'Live Server', fate: 'unsupported' }
    ],
    ...over
  })

  it('shows each app with what comes along and what becomes of its extensions; takes it over', async () => {
    let loaded = 0
    useEditorPrefs.setState({ load: async () => void (loaded += 1) })
    const bridge = installBridge({
      'migrate:scan': () => [source(), source({ app: 'Cursor', name: 'Cursor', settings: 0, keybindings: 0, snippets: 0, extensions: [{ id: 'a.b', name: 'Remote SSH', fate: 'unsupported' }] })],
      'migrate:apply': ({ app }: { app: string }) => (app === 'Cursor' ? Promise.reject(new Error('nothing to take')) : { settings: 3, keybindings: 2, snippets: 455 })
    })
    render(<MigrateCard />)
    await act(settle)
    const code = screen.getByText('Visual Studio Code').closest('li')!
    expect(code).toHaveTextContent('3 editor settings · 2 keybindings · 455 snippets')
    expect(code).toHaveTextContent('Already built into MindeckGit Graph')
    expect(code).toHaveTextContent('Python · Python Debugger · Odd → install under Languages: Python, cobol')
    expect(code).toHaveTextContent('Snippets come alongES7 snippets')
    expect(code).toHaveTextContent('Themes — Mindeck keeps its designOne Dark Pro')
    expect(code).toHaveTextContent('Not in Mindeck yetLive Server')

    fireEvent.click(within(code).getByRole('button', { name: /Take over/ }))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('migrate:apply', { app: 'Code' })
    expect(within(code).getByRole('status')).toHaveTextContent('Taken over: 3 settings, 2 keybindings, 455 snippets')
    expect(loaded).toBe(1) // the editor applies them right away

    const cursor = screen.getByText('Cursor').closest('li')!
    expect(cursor).not.toHaveTextContent('Languages')
    fireEvent.click(within(cursor).getByRole('button', { name: /Take over/ }))
    await act(settle)
    expect(within(cursor).getByRole('alert')).toHaveTextContent('nothing to take')
  })

  it('nothing installed; a scan that fails; outside the desktop app', async () => {
    installBridge({ 'migrate:scan': () => [] })
    const { unmount } = render(<MigrateCard />)
    expect(screen.getByLabelText('Loading…')).toBeInTheDocument()
    await act(settle)
    expect(screen.getByText('No VS Code, Cursor, VSCodium or Windsurf found on this computer.')).toBeInTheDocument()
    unmount()

    installBridge({ 'migrate:scan': () => Promise.reject(new Error('no access')) })
    const second = render(<MigrateCard />)
    await act(settle)
    expect(screen.getByText('no access')).toBeInTheDocument()
    second.unmount()

    delete (window as { mindeck?: unknown }).mindeck
    installRemote({})
    render(<MigrateCard />)
    expect(screen.getByText('Moving over works in the Mindeck desktop app.')).toBeInTheDocument()
  })

  it('the settings section: each app with its extensions folded away; nothing to take over, nothing to click', async () => {
    let loaded = 0
    useEditorPrefs.setState({ load: async () => void (loaded += 1) })
    const bridge = installBridge({
      'migrate:scan': () => [source(), source({ app: 'Cursor', name: 'Cursor', settings: 0, keybindings: 0, snippets: 0, extensions: [{ id: 'a.b', name: 'Remote SSH', fate: 'unsupported' }] })],
      'migrate:apply': () => ({ settings: 3, keybindings: 2, snippets: 455 })
    })
    render(<MigrateSection />)
    expect(screen.getByLabelText('Loading…')).toBeInTheDocument()
    await act(settle)
    const app = (name: string) => screen.getByText(name).closest('section')!
    const code = app('Visual Studio Code')
    expect(code).toHaveTextContent('3 editor settings · 2 keybindings · 455 snippets')
    expect([...code.querySelectorAll('summary')].map((s) => s.textContent)).toEqual([
      'Already built into Mindeck · 1',
      'Languages · 3',
      'Snippets come along · 1',
      'Themes — Mindeck keeps its design · 1',
      'Not in Mindeck yet · 1'
    ])
    expect(code).toHaveTextContent('Languages · 3PythonPython DebuggerOdd')
    expect(code).toHaveTextContent('→ install under Languages: Python, cobol')

    fireEvent.click(within(code).getByRole('button', { name: /Take over/ }))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('migrate:apply', { app: 'Code' })
    expect(within(code).getByRole('status')).toHaveTextContent('Taken over: 3 settings, 2 keybindings, 455 snippets')
    expect(loaded).toBe(1)

    const cursor = app('Cursor')
    expect(cursor).toHaveTextContent('0 editor settings · 0 keybindings · 0 snippets')
    expect(cursor).not.toHaveTextContent('Languages')
    expect(within(cursor).getByRole('button', { name: /Take over/ })).toBeDisabled()
  })

  it('the settings section: nothing installed; a scan that fails; a take-over that fails', async () => {
    installBridge({ 'migrate:scan': () => [] })
    const { unmount } = render(<MigrateSection />)
    await act(settle)
    expect(screen.getByText('No VS Code, Cursor, VSCodium or Windsurf found on this computer.')).toBeInTheDocument()
    unmount()

    installBridge({ 'migrate:scan': () => Promise.reject(new Error('no access')) })
    const second = render(<MigrateSection />)
    await act(settle)
    expect(screen.getByText('no access')).toBeInTheDocument()
    expect(screen.queryByLabelText('Loading…')).toBeNull()
    second.unmount()

    installBridge({ 'migrate:scan': () => [source({ extensions: [] })], 'migrate:apply': () => Promise.reject(new Error('settings.json is locked')) })
    render(<MigrateSection />)
    await act(settle)
    fireEvent.click(screen.getByRole('button', { name: /Take over/ }))
    await act(settle)
    expect(screen.getByRole('alert')).toHaveTextContent('settings.json is locked')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: /Take over/ })).toBeEnabled()
  })
})
