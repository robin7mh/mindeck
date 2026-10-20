import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge, settle } from './bridge'
import type { DebugFrame, DebugSession } from '@shared/types/debug'
import type { EditorTab } from '@/features/editor/store'

vi.mock('@/features/editor/components/CodeEditor', () => ({ default: ({ tab }: { tab?: EditorTab }) => <div data-testid="monaco">{tab?.id ?? 'none'}</div> }))
vi.mock('@/features/editor/components/DiffView', () => ({ default: () => <div data-testid="diff" /> }))

import { en } from '@/lib/i18n/en'
import { de } from '@/lib/i18n/de'
import { setBufferHost, tabKey, useEditor } from '@/features/editor/store'
import { useScm, type PickItem } from '@/features/editor/scm'
import { buildCommands } from '@/features/editor/commands'
import { editorActions, setEditorActions } from '@/features/editor/actions'
import { projectProblems, useProblems } from '@/features/editor/problems'
import { runnerOf, splitArgs, useDebug } from '@/features/editor/debug'
import { useEditorPrefs } from '@/features/editor/prefs'
import { useLanguages } from '@/features/editor/languages'
import { isSassFile, useLive } from '@/features/editor/live'
import { useGitHub } from '@/features/editor/github'
import { onSaved } from '@/features/editor/store'
import { QuickOpen } from '@/features/editor/components/QuickOpen'
import { useLocale } from '@/lib/i18n'
import { DebugConsole, DebugPanel } from '@/features/editor/components/DebugPanel'
import { EditorView } from '@/features/editor/components/EditorView'
import { useProjects } from '@/features/projects/store'
import { usePalette } from '@/features/palette/store'
import { allCommands } from '@/features/palette/registry'
import { CommandPalette } from '@/features/palette/components/CommandPalette'

/** The global palette, as the app shows it (PaletteHost) — here without its keys and built-in commands. */
function Palette() {
  return usePalette((s) => s.view) === 'commands' ? <CommandPalette /> : null
}

const initialEditor = useEditor.getState()
const initialScm = useScm.getState()
const initialDebug = useDebug.getState()
const d = () => useDebug.getState()

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
/** A buffer host whose snapshot is the tab's text (saving works without Monaco). */
function setBufferHostFor(path: string) {
  setBufferHost({ snapshot: () => ({ text: `<${path}>`, version: 2 }), markClean: () => {}, drop: () => {}, rekey: () => {} })
}

const frame = (over: Partial<DebugFrame> = {}): DebugFrame => ({ id: 'f0', name: 'add', path: 'src/a.js', url: 'file:///x/p/src/a.js', line: 2, column: 1, scopes: [{ type: 'local', name: 'add', objectId: 'L' }, { type: 'global', objectId: 'G' }], ...over })
const session = (over: Partial<DebugSession> = {}): DebugSession => ({ id: 's1', projectId: 'p', program: 'src/a.js', status: 'paused', reason: 'breakpoint', frames: [frame()], ...over })

beforeEach(() => {
  useEditor.setState(initialEditor, true)
  useScm.setState(initialScm, true)
  useDebug.setState({ ...initialDebug, breakpoints: {}, program: {}, args: {}, build: {}, watches: [] }, true)
  useProblems.setState({ byFile: {} })
  useEditor.setState({ projectId: 'p' })
  setEditorActions(null)
  localStorage.clear()
})

describe('command palette: commands', () => {
  const labels = (items: PickItem[]) => items.map((i) => i.label)

  it('files and views always (the modules are the palette’s own); git by the repo’s state; writing ones only when editable', () => {
    const plain = labels(buildCommands(en, { readOnly: false }))
    expect(plain).toContain('File: New File')
    expect(plain).toContain('Go: Go to line')
    expect(plain.some((l) => l.startsWith('Open:'))).toBe(false)
    expect(plain.some((l) => l.startsWith('Git:'))).toBe(false) // status unknown

    useScm.setState({ status: { repo: false, ahead: 0, behind: 0, merging: false, files: [] } })
    expect(labels(buildCommands(en, { readOnly: false })).filter((l) => l.startsWith('Git'))).toEqual(['Git: Initialize repository'])
    expect(labels(buildCommands(en, { readOnly: true })).filter((l) => l.startsWith('Git'))).toEqual([])

    useScm.setState({ status: { repo: true, branch: 'main', ahead: 0, behind: 0, merging: false, files: [] } })
    expect(labels(buildCommands(en, { readOnly: false })).filter((l) => l.startsWith('Git'))).toEqual([
      'Git: Commit',
      'Git: Pull',
      'Git: Push',
      'Git: Fetch',
      'Git: Sync (pull, then push)',
      'Git: Checkout to…',
      'Git: Create Branch…',
      'Git: Stash Changes…',
      'Git: Stash Changes (Include Untracked)…',
      'GitHub: Create pull request',
      'Git: Toggle File Blame',
      'Git: Toggle Inline Blame'
    ])
    const readOnly = labels(buildCommands(en, { readOnly: true }))
    expect(readOnly).not.toContain('File: Save')
    expect(readOnly).not.toContain('GitHub: Create pull request')
    expect(readOnly).toContain('View: Git Graph')
    expect(readOnly).toContain('View: Pull requests')
    expect(labels(buildCommands(en, { readOnly: false, extra: [{ id: 'x', label: 'Debug: X', run: () => {} }] }))).toContain('Debug: X')
  })

  it('Monaco’s actions: ours under their names (only when supported), the rest as they come, its palette hidden', () => {
    const ran: string[] = []
    setEditorActions({
      list: () => [
        { id: 'editor.action.formatDocument', label: 'Format Document' },
        { id: 'mindeck.formatDocument', label: 'Format Document' },
        { id: 'editor.action.quickCommand', label: 'Command Palette' },
        { id: 'editor.action.gotoLine', label: 'Go to Line' },
        { id: 'editor.action.transformToUppercase', label: 'Transform to Uppercase' }
      ],
      run: (id) => void ran.push(id)
    })
    const items = buildCommands(en, { readOnly: false })
    const editor = items.filter((i) => i.label.startsWith('Editor:'))
    expect(editor.map((i) => `${i.label}${i.keys ? ` [${i.keys}]` : ''}`)).toEqual(['Editor: Format Document [⇧⌥F]', 'Editor: Transform to Uppercase'])
    editor.forEach((i) => void i.run())
    expect(ran).toEqual(['mindeck.formatDocument', 'editor.action.transformToUppercase'])
    expect(editorActions()).not.toBeNull()
  })

  it('each command does its thing', async () => {
    installBridge({ 'scm:pull': () => undefined, 'scm:push': () => undefined, 'scm:fetch': () => undefined, 'scm:status': () => ({ repo: true, ahead: 0, behind: 0, merging: false, files: [] }), 'scm:branches': () => [], 'scm:init': () => ({}), 'scm:checkout': () => undefined, 'scm:createBranch': () => undefined, 'scm:files': () => [] })
    useScm.setState({ status: { repo: true, branch: 'main', ahead: 0, behind: 0, merging: false, files: [] }, branches: [{ name: 'main', remote: false, current: true }, { name: 'origin/x', remote: true, current: false }, { name: 'dev', remote: false, current: false }] })
    useEditor.setState({ tabs: [tab('a.ts', { dirty: true })], activeId: 'p:a.ts' })
    const save = vi.spyOn(useEditor.getState(), 'save').mockResolvedValue(true)
    const saveAll = vi.spyOn(useEditor.getState(), 'saveAll').mockResolvedValue()
    const requestClose = vi.spyOn(useEditor.getState(), 'requestClose').mockImplementation(() => {})
    const startNaming = vi.spyOn(useEditor.getState(), 'startNaming').mockResolvedValue()
    const pull = vi.spyOn(useScm.getState(), 'pull').mockResolvedValue()
    const push = vi.spyOn(useScm.getState(), 'push').mockResolvedValue()
    const fetch = vi.spyOn(useScm.getState(), 'fetch').mockResolvedValue()
    const sync = vi.spyOn(useScm.getState(), 'sync').mockResolvedValue()
    const checkout = vi.spyOn(useScm.getState(), 'checkout').mockResolvedValue()
    const createBranch = vi.spyOn(useScm.getState(), 'createBranch').mockResolvedValue()
    const items = buildCommands(en, { readOnly: false })
    const run = (id: string) => act(() => void items.find((i) => i.id === id)!.run())

    run('file.new')
    expect(startNaming).toHaveBeenLastCalledWith('file')
    expect(useScm.getState().pane).toBe('files')
    run('file.newFolder')
    expect(startNaming).toHaveBeenLastCalledWith('dir')
    run('file.save')
    expect(save).toHaveBeenCalled()
    run('file.saveAll')
    expect(saveAll).toHaveBeenCalled()
    run('file.close')
    expect(requestClose).toHaveBeenCalledWith('p:a.ts')
    useEditor.setState({ activeId: undefined })
    run('file.close') // nothing open
    expect(requestClose).toHaveBeenCalledTimes(1)
    run('go.file')
    expect(useScm.getState()).toMatchObject({ quickOpen: true, quickQuery: '' })
    run('go.line')
    expect(useScm.getState().quickQuery).toBe(':')
    run('view.search')
    expect(useScm.getState().pane).toBe('search')

    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => (cb(0), 0))
    render(<textarea aria-label="Message (⌘Enter to commit)" />)
    run('git.commit')
    expect(useScm.getState().pane).toBe('scm')
    expect(screen.getByLabelText('Message (⌘Enter to commit)')).toHaveFocus()
    raf.mockRestore()
    run('git.pull')
    run('git.push')
    run('git.fetch')
    run('git.sync')
    expect([pull, push, fetch, sync].every((f) => f.mock.calls.length === 1)).toBe(true)

    run('git.checkout')
    const pick = useScm.getState().pick!
    expect(pick.items.map((i) => `${i.label}|${i.detail ?? ''}`)).toEqual(['main|current', 'origin/x|remote', 'dev|'])
    await pick.items[2].run()
    expect(checkout).toHaveBeenCalledWith('dev')
    run('git.branch')
    await useScm.getState().pick!.onText!('feature/x')
    expect(createBranch).toHaveBeenCalledWith('feature/x')
    run('github.create')
    expect(useScm.getState().pane).toBe('prs')
    expect(useGitHub.getState().creating).toBe(true)
    useGitHub.setState({ creating: false })

    const init = vi.spyOn(useScm.getState(), 'init').mockResolvedValue()
    useScm.setState({ status: { repo: false, ahead: 0, behind: 0, merging: false, files: [] } })
    act(() => void buildCommands(en, { readOnly: false }).find((i) => i.id === 'git.init')!.run())
    expect(init).toHaveBeenCalled()
  })
})

describe('quick open modes', () => {
  const open = (query: string) => {
    useScm.setState({ quickOpen: true, quickQuery: query })
    return render(<QuickOpen />)
  }
  const input = () => screen.getByRole('dialog').querySelector('input')!

  it('“>” hands over to the command palette, with what follows', () => {
    usePalette.setState({ view: undefined })
    open('')
    fireEvent.change(input(), { target: { value: '> save' } })
    expect(useScm.getState().quickOpen).toBe(false)
    expect(usePalette.getState()).toMatchObject({ view: 'commands', query: 'save' })
    usePalette.setState({ view: undefined })
  })

  it('a pick list takes “>” as text', () => {
    useScm.getState().openPick({ placeholder: 'Name of the new branch', items: [], onText: vi.fn() })
    render(<QuickOpen />)
    fireEvent.change(input(), { target: { value: '>x' } })
    expect(useScm.getState().quickOpen).toBe(true)
    expect(usePalette.getState().view).toBeUndefined()
  })

  it('“:” goes to a line of the file on screen', () => {
    open(':')
    expect(screen.getByText('Open a file first')).toBeInTheDocument()
    act(() => useEditor.setState({ activeId: 'p:a.ts' }))
    expect(screen.getByText('Type a line number')).toBeInTheDocument()
    fireEvent.change(input(), { target: { value: ':x' } })
    expect(screen.getByText('Type a line number')).toBeInTheDocument()
    fireEvent.change(input(), { target: { value: ':42' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(useEditor.getState().reveal).toEqual({ id: 'p:a.ts', line: 42 })
  })

  it('the line entry follows a language switch while open', () => {
    act(() => useEditor.setState({ activeId: 'p:a.ts' }))
    open(':7')
    expect(screen.getByRole('option')).toHaveTextContent('Go to line 7')
    act(() => useLocale.getState().setLocale('de'))
    expect(screen.getByRole('option')).toHaveTextContent('Gehe zu Zeile 7')
    act(() => useLocale.getState().setLocale('en'))
  })

  it('a pick list: choose an item, or type free text when the pick takes it', () => {
    const chosen = vi.fn()
    useScm.getState().openPick({ placeholder: 'Select a branch', items: [{ id: 'main', label: 'main', detail: 'current', keys: '⌘1', run: chosen }] })
    const { unmount } = render(<QuickOpen />)
    expect(screen.getByRole('dialog', { name: 'Select a branch' })).toBeInTheDocument()
    expect(screen.getByRole('option')).toHaveTextContent('maincurrent⌘1') // an item's key, right-aligned
    fireEvent.change(input(), { target: { value: 'nope' } })
    expect(screen.getByText('Nothing matches')).toBeInTheDocument()
    fireEvent.keyDown(input(), { key: 'Enter' }) // nothing to choose, no free text
    fireEvent.change(input(), { target: { value: 'ma' } })
    fireEvent.click(screen.getByRole('option'))
    expect(chosen).toHaveBeenCalled()
    unmount()

    const onText = vi.fn()
    useScm.getState().openPick({ placeholder: 'Name of the new branch', items: [], onText })
    render(<QuickOpen />)
    expect(screen.queryByRole('option')).toBeNull()
    fireEvent.keyDown(input(), { key: 'Enter' }) // empty: nothing
    expect(onText).not.toHaveBeenCalled()
    fireEvent.change(input(), { target: { value: ' feature/x ' } })
    expect(screen.getByText('feature/x')).toBeInTheDocument()
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onText).toHaveBeenCalledWith('feature/x')
    expect(useScm.getState().quickOpen).toBe(false)
  })
})

describe('debug texts', () => {
  it('say how a run ended, in both languages', () => {
    expect([de.debug.exited(null), de.debug.exited(1), en.debug.exited(null)]).toEqual(['Beendet', 'Beendet mit Code 1', 'Stopped'])
  })
})

describe('Live Server and the Sass watcher', () => {
  const status = { projectId: 'p', url: 'http://127.0.0.1:5500', port: 5500, root: '' }
  beforeEach(() => useLive.setState({ servers: [], sassWatching: {}, sass: undefined, error: undefined }))

  it('follows the core, compiles Sass on save when watched, reports problems', async () => {
    const bridge = installBridge({
      'liveServer:status': () => [status],
      'sass:compile': ({ path }: { path: string }) => (path === 'bad.scss' ? Promise.reject(new Error('sass crashed')) : { written: ['a.css'], errors: { 'a.scss': [] } })
    })
    const stop = useLive.getState().connect()
    await settle()
    expect(useLive.getState().servers).toEqual([status])
    act(() => bridge.emit('liveServer:changed', []))
    expect(useLive.getState().servers).toEqual([])

    // A listener that unsubscribed hears nothing.
    const heard: string[] = []
    onSaved((file) => heard.push(file.path))()
    // Not watched: nothing compiles.
    useEditor.setState({ tabs: [tab('a.scss', { dirty: true })], activeId: 'p:a.scss' })
    setBufferHostFor('a.scss')
    installBridge({ ...bridge.routes, 'files:write': () => ({ mtimeMs: 2, size: 1 }) } as never)
    await useEditor.getState().save('p:a.scss')
    expect(bridge.invoke).not.toHaveBeenCalledWith('sass:compile', expect.anything())
    expect(heard).toEqual([])
    stop()

    // A core that can't say which servers run: none shown.
    useLive.setState({ servers: [] })
    installBridge({ 'liveServer:status': () => Promise.reject(new Error('offline')) })
    const again = useLive.getState().connect()
    await settle()
    expect(useLive.getState().servers).toEqual([])
    again()
  })

  it('saving all writes the changed files only', async () => {
    const written: string[] = []
    installBridge({ 'liveServer:status': () => [], 'files:write': ({ path }: { path: string }) => (written.push(path), { mtimeMs: 2, size: 1 }) })
    useEditor.setState({ tabs: [tab('a.ts', { dirty: true }), tab('b.ts'), tab('c.ts', { dirty: true })] })
    setBufferHostFor('any')
    await act(() => useEditor.getState().saveAll())
    expect(written.sort()).toEqual(['a.ts', 'c.ts'])
  })

  it('compiles on save when watched; other files and other projects are left alone', async () => {
    const compiled: string[] = []
    installBridge({
      'liveServer:status': () => [],
      'files:write': () => ({ mtimeMs: 2, size: 1 }),
      'sass:compile': ({ path }: { path: string }) => (compiled.push(path), path === 'bad.scss' ? Promise.reject(new Error('sass crashed')) : { written: ['a.css'], errors: { 'a.scss': [] } })
    })
    const stop = useLive.getState().connect()
    useLive.setState({ sassWatching: { p: true } })
    for (const path of ['a.scss', 'b.ts', 'bad.scss']) {
      useEditor.setState({ tabs: [tab(path, { dirty: true })], activeId: `p:${path}` })
      setBufferHostFor(path)
      await act(() => useEditor.getState().save(`p:${path}`))
      await act(settle)
    }
    expect(compiled).toEqual(['a.scss', 'bad.scss'])
    expect(useLive.getState()).toMatchObject({ sass: { projectId: 'p', written: ['a.css'] }, error: 'sass crashed' })
    stop()
  })

  it('start and stop the server, toggle the watcher (a full compile first)', async () => {
    const bridge = installBridge({
      'liveServer:start': ({ page }: { page?: string }) => (page === 'boom.html' ? Promise.reject(new Error('port taken')) : status),
      'liveServer:stop': () => undefined,
      'sass:compileAll': () => ({ written: ['main.css'], errors: { 'broken.scss': [{ range: { start: { line: 1, offset: 1 }, end: { line: 1, offset: 2 } }, message: 'oops', severity: 'error' }] } })
    })
    useEditor.setState({ projectId: undefined })
    await useLive.getState().start()
    await useLive.getState().stop()
    await useLive.getState().toggleSass()
    expect(bridge.invoke).not.toHaveBeenCalled()
    useEditor.setState({ projectId: 'p' })
    const other = { ...status, projectId: 'q', port: 5501 }
    useLive.setState({ servers: [other] }) // another project's server stays listed
    await useLive.getState().start('index.html')
    expect(bridge.invoke).toHaveBeenCalledWith('liveServer:start', { projectId: 'p', page: 'index.html' })
    expect(useLive.getState().servers).toEqual([other, status])
    useLive.setState({ servers: [status] })
    await useLive.getState().start('boom.html')
    expect(useLive.getState().error).toBe('port taken')
    useLive.getState().clearError()
    bridge.invoke.mockRejectedValueOnce(new Error('already stopped'))
    await useLive.getState().stop() // gone already: off the list all the same
    expect(useLive.getState().servers).toEqual([])

    await useLive.getState().toggleSass()
    expect(useLive.getState().sassWatching).toEqual({ p: true })
    expect(JSON.parse(localStorage.getItem('mindeck.sassWatch')!)).toEqual({ p: true })
    expect(useProblems.getState().byFile['p:broken.scss'][0].message).toBe('oops')
    await useLive.getState().toggleSass()
    expect(useLive.getState().sassWatching).toEqual({ p: false })

    installBridge({ 'sass:compileAll': () => Promise.reject(new Error('no sass')) })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    await useLive.getState().toggleSass()
    expect(useLive.getState().error).toBe('no sass')
    set.mockRestore()
    expect(isSassFile('a.SASS')).toBe(true)
  })

  it('remembers watched projects; broken storage watches none', async () => {
    localStorage.setItem('mindeck.sassWatch', JSON.stringify({ p: true }))
    vi.resetModules()
    expect((await import('@/features/editor/live')).useLive.getState().sassWatching).toEqual({ p: true })
    localStorage.setItem('mindeck.sassWatch', '{broken')
    vi.resetModules()
    expect((await import('@/features/editor/live')).useLive.getState().sassWatching).toEqual({})
  })
})

describe('problems', () => {
  it('keeps errors and warnings per file, sorted errors first; closed files leave', () => {
    const r = (l: number, severity: 'error' | 'warning' | 'suggestion') => ({ range: { start: { line: l, offset: 2 }, end: { line: l, offset: 3 } }, message: `${severity}${l}`, severity, code: 1 })
    useProblems.getState().report('p', { 'b.ts': [r(5, 'warning'), r(1, 'suggestion'), r(9, 'error')], 'a.ts': [r(3, 'error'), r(1, 'error')] })
    useProblems.getState().report('q', { 'z.ts': [r(1, 'error')] })
    expect(projectProblems(useProblems.getState().byFile, 'p').map((p) => `${p.path}:${p.line} ${p.severity}`)).toEqual(['a.ts:1 error', 'a.ts:3 error', 'b.ts:9 error', 'b.ts:5 warning'])
    useProblems.getState().forget('p', 'a.ts')
    expect(projectProblems(useProblems.getState().byFile, 'p')).toHaveLength(2)
  })
})

describe('debug store', () => {
  it('names what runs a program', () => {
    expect(['a.py', 'cmd/main.go', 'a.ts', 'build/app', 'main.c', 'src/main.rs', 'index.php', 'App.java', 'Main.kt', 'run.sh'].map(runnerOf)).toEqual(['python', 'go run', 'node', 'lldb', 'lldb', 'lldb', 'php', 'java', 'kotlin', 'shell'])
  })

  it('splits arguments like a shell', () => {
    expect(splitArgs(`--port 3000 "a b" 'c d' e`)).toEqual(['--port', '3000', 'a b', 'c d', 'e'])
    expect(splitArgs('   ')).toEqual([])
  })

  it('breakpoints per project: toggled, removed, cleared — remembered and sent to a running session', async () => {
    const bridge = installBridge({ 'debug:setBreakpoints': () => undefined })
    d().toggleBreakpoint('p', 'a.js', 3)
    d().toggleBreakpoint('p', 'a.js', 5)
    expect(d().breakpoints.p).toEqual([{ path: 'a.js', line: 3 }, { path: 'a.js', line: 5 }])
    expect(JSON.parse(localStorage.getItem('mindeck.debug')!).breakpoints.p).toHaveLength(2)
    expect(bridge.invoke).not.toHaveBeenCalled() // nothing running

    useDebug.setState({ session: session({ status: 'running', frames: [] }) })
    d().removeBreakpoint('p', { path: 'a.js', line: 3 })
    expect(bridge.invoke).toHaveBeenLastCalledWith('debug:setBreakpoints', { projectId: 'p', breakpoints: [{ path: 'a.js', line: 5 }] })
    d().toggleBreakpoint('q', 'b.js', 1) // another project's session: not sent
    expect(bridge.invoke).toHaveBeenCalledTimes(1)
    d().clearBreakpoints('p')
    expect(d().breakpoints.p).toEqual([])
    expect(bridge.invoke).toHaveBeenCalledTimes(2)
    useDebug.setState({ session: session({ status: 'exited' }) })
    d().clearBreakpoints('p')
    expect(bridge.invoke).toHaveBeenCalledTimes(2)
    // A failed sync is not fatal.
    installBridge({ 'debug:setBreakpoints': () => Promise.reject(new Error('x')) })
    useDebug.setState({ session: session({ status: 'running' }) })
    d().toggleBreakpoint('p', 'a.js', 1)
    await settle()
  })

  it('remembers program, arguments and watches; survives storage that refuses', async () => {
    d().setProgram('p', 'src/main.ts')
    d().setArgs('p', '--x 1')
    d().setBuild('p', 'make')
    d().setStopOnEntry(true)
    expect(JSON.parse(localStorage.getItem('mindeck.debug')!)).toMatchObject({ program: { p: 'src/main.ts' }, args: { p: '--x 1' }, build: { p: 'make' } })
    vi.resetModules()
    const fresh = (await import('@/features/editor/debug')).useDebug.getState()
    expect(fresh).toMatchObject({ program: { p: 'src/main.ts' }, args: { p: '--x 1' }, breakpoints: {} })

    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.resetModules()
    const blocked = (await import('@/features/editor/debug')).useDebug
    expect(blocked.getState().program).toEqual({})
    blocked.getState().addWatch('x') // kept for this run
    expect(blocked.getState().watches).toEqual(['x'])
    get.mockRestore()
    set.mockRestore()
  })

  it('start: the chosen program, else the file on screen; saves first; says when there is nothing to run', async () => {
    const bridge = installBridge({ 'debug:start': (req: { program: string }) => session({ status: 'starting', program: req.program, frames: [] }), 'files:write': () => ({ mtimeMs: 2, size: 1 }) })
    useEditor.setState({ projectId: undefined })
    await d().start() // no project
    useEditor.setState({ projectId: 'p' })
    await d().start()
    expect(d().error).toBe('no-program')
    d().clearError()

    const saveAll = vi.spyOn(useEditor.getState(), 'saveAll').mockResolvedValue()
    useEditor.setState({ tabs: [tab('src/main.ts')], activeId: 'p:src/main.ts' })
    d().toggleBreakpoint('p', 'src/main.ts', 4)
    d().setArgs('p', '--a "b c"')
    d().setStopOnEntry(true)
    await d().start()
    expect(saveAll).toHaveBeenCalled()
    expect(bridge.invoke).toHaveBeenCalledWith('debug:start', { projectId: 'p', program: 'src/main.ts', args: ['--a', 'b c'], stopOnEntry: true, breakpoints: [{ path: 'src/main.ts', line: 4 }] })
    expect(d()).toMatchObject({ consoleOpen: true, session: { status: 'starting' } })
    expect(d().console[0].text).toContain('▶ node src/main.ts --a "b c"')

    d().setProgram('p', '  server.js ')
    useEditor.setState({ tabs: [] })
    await d().start()
    expect(bridge.invoke).toHaveBeenLastCalledWith('debug:start', expect.objectContaining({ program: 'server.js' }))
    d().setBuild('p', ' make ')
    await d().start()
    expect(bridge.invoke).toHaveBeenLastCalledWith('debug:start', expect.objectContaining({ build: 'make' }))
    d().setBuild('p', '')
    d().setArgs('p', '')
    useDebug.setState({ args: {} })
    await d().start()
    expect(d().console[0].text).toBe('▶ node server.js \n')

    installBridge({ 'debug:start': () => Promise.reject(new Error('no node')) })
    await d().start()
    expect(d().error).toBe('no node')
  })

  it('follows the core’s session: pausing reveals the line, refreshes watches; output of the session only', async () => {
    const bridge = installBridge({
      'debug:session': () => null,
      'debug:evaluate': ({ expression }: { expression: string }) => (expression === 'bad' ? Promise.reject(new Error('nope')) : { name: expression, value: '42', type: 'number' })
    })
    const openAt = vi.spyOn(useEditor.getState(), 'openAt').mockResolvedValue()
    const stop = d().connect()
    await settle()
    expect(d().session).toBeNull()
    d().addWatch('n')
    d().addWatch('n') // already there
    d().addWatch('  ') // empty
    d().addWatch('bad')
    expect(d().watches).toEqual(['n', 'bad'])
    expect(bridge.invoke).not.toHaveBeenCalledWith('debug:evaluate', expect.anything()) // not paused

    act(() => bridge.emit('debug:output', { sessionId: 'any', stream: 'stdout', text: 'before\n' })) // no session yet: shown
    act(() => bridge.emit('debug:session', session({ status: 'running', frames: [] })))
    expect(d().consoleOpen).toBe(true)
    act(() => bridge.emit('debug:output', { sessionId: 's1', stream: 'stdout', text: 'hi\n' }))
    act(() => bridge.emit('debug:output', { sessionId: 'old', stream: 'stdout', text: 'stale\n' }))
    expect(d().console.map((l) => l.text)).toEqual(['before\n', 'hi\n'])

    act(() => bridge.emit('debug:session', session({ frames: [frame({ path: undefined }), frame({ id: 'f1', path: 'src/a.js', line: 7 })] })))
    await act(settle)
    expect(openAt).toHaveBeenCalledWith('src/a.js', 7)
    expect(d().watchValues).toEqual({ n: { name: 'n', value: '42', type: 'number' }, bad: { name: 'bad', value: 'nope', type: 'error' } })
    expect(bridge.invoke).toHaveBeenCalledWith('debug:evaluate', { expression: 'n', frameId: 'f0' })

    // Another project's session doesn't move the editor; an error is shown once.
    openAt.mockClear()
    act(() => bridge.emit('debug:session', session({ id: 's2', projectId: 'q', error: 'spawn node ENOENT', status: 'exited', frames: [] })))
    expect(d().error).toBe('spawn node ENOENT')
    d().clearError()
    act(() => bridge.emit('debug:session', session({ id: 's2', projectId: 'q', error: 'spawn node ENOENT', status: 'exited', frames: [] })))
    expect(d().error).toBeUndefined()
    act(() => bridge.emit('debug:session', session({ id: 's3', projectId: 'q', frames: [frame()] })))
    await act(settle)
    expect(openAt).not.toHaveBeenCalled()
    d().removeWatch('bad')
    expect(d().watches).toEqual(['n'])
    stop()
    act(() => bridge.emit('debug:output', { sessionId: 's3', stream: 'stdout', text: 'after\n' }))
    expect(d().console.map((l) => l.text)).not.toContain('after\n')

    // A session already running when the editor opens is picked up.
    installBridge({ 'debug:session': () => session({ id: 's9', status: 'running', frames: [] }) })
    const again = d().connect()
    await settle()
    expect(d().session?.id).toBe('s9')
    again()
    installBridge({ 'debug:session': () => Promise.reject(new Error('remote shells off')) })
    d().connect()()
    await settle()
  })

  it('controls, frames, variables and the console', async () => {
    const bridge = installBridge({
      'debug:control': ({ action }: { action: string }) => (action === 'pause' ? Promise.reject(new Error('not running')) : undefined),
      'debug:stop': () => undefined,
      'debug:start': () => session({ status: 'starting', frames: [] }),
      'debug:variables': ({ objectId }: { objectId: string }) => (objectId === 'X' ? Promise.reject(new Error('gone')) : [{ name: 'a', value: '1', type: 'number' }]),
      'debug:evaluate': ({ expression, frameId }: { expression: string; frameId?: string }) =>
        expression === 'throw' ? Promise.reject(new Error('lost')) : { name: expression, value: frameId ?? 'global', type: expression === 'oops' ? 'error' : 'string' }
    })
    await d().control('stepOver')
    expect(bridge.invoke).toHaveBeenCalledWith('debug:control', { action: 'stepOver' })
    await d().control('pause')
    expect(d().error).toBe('not running')
    await d().stop()
    expect(bridge.invoke).toHaveBeenCalledWith('debug:stop', undefined)
    bridge.invoke.mockRejectedValueOnce(new Error('already over'))
    await expect(d().stop()).resolves.toBeUndefined()
    useEditor.setState({ tabs: [tab('src/a.js')], activeId: 'p:src/a.js' })
    await d().restart()
    expect(bridge.invoke).toHaveBeenCalledWith('debug:start', expect.anything())

    d().clearConsole()
    await d().evaluate('x') // not paused: the global scope
    useDebug.setState({ session: session({ frames: [frame(), frame({ id: 'f1', path: undefined }), frame({ id: 'f2', path: 'src/b.js', line: 9 })] }) })
    const openAt = vi.spyOn(useEditor.getState(), 'openAt').mockResolvedValue()
    d().selectFrame(5) // no such frame
    d().selectFrame(1) // Node internals: nothing to open
    expect(openAt).not.toHaveBeenCalled()
    d().selectFrame(2)
    expect(openAt).toHaveBeenCalledWith('src/b.js', 9)
    expect(d().frame).toBe(2)
    await d().evaluate('  y ')
    await d().evaluate('oops')
    await d().evaluate('throw')
    await d().evaluate('   ')
    expect(d().console.map((l) => `${l.kind}:${l.text}`)).toEqual(['input:x', 'result:global', 'input:y', 'result:f2', 'input:oops', 'error:f2', 'input:throw', 'error:lost'])
    useDebug.setState({ session: session({ projectId: 'q', frames: [frame(), frame({ id: 'f9', path: 'src/c.js' })] }) })
    d().selectFrame(1) // another project's file: not opened here
    expect(openAt).toHaveBeenCalledTimes(1)

    await d().toggleVariable('0:0', 'L')
    expect(d().vars.L).toEqual([{ name: 'a', value: '1', type: 'number' }])
    await d().toggleVariable('0:0', 'L') // fold
    expect(d().expanded).toEqual({})
    await d().toggleVariable('0:0', 'L') // open again: cached
    expect(bridge.invoke.mock.calls.filter(([c]) => c === 'debug:variables')).toHaveLength(1)
    await d().toggleVariable('x', 'X')
    expect(d().vars.X).toEqual([])

    d().clearConsole()
    expect(d().console).toEqual([])
    d().setConsoleOpen(false)
    expect(d().consoleOpen).toBe(false)
  })
})

describe('debug panel', () => {
  beforeEach(() => {
    installBridge({
      'debug:start': () => session({ status: 'starting', frames: [] }),
      'debug:control': () => undefined,
      'debug:stop': () => undefined,
      'debug:variables': ({ objectId }: { objectId: string }) =>
        objectId === 'L' ? [{ name: 'user', value: 'Object', type: 'object', objectId: 'U' }, { name: 's', value: '"hi"', type: 'string' }] : [{ name: 'name', value: '"Ada"', type: 'string' }],
      'debug:evaluate': ({ expression }: { expression: string }) => ({ name: expression, value: expression === 'boom' ? 'ReferenceError' : '7', type: expression === 'boom' ? 'error' : 'number' })
    })
  })

  it('before a run: program, current file, arguments, stop on entry, start', async () => {
    const start = vi.spyOn(useDebug.getState(), 'start').mockResolvedValue()
    useEditor.setState({ tabs: [tab('src/a.js')], activeId: 'p:src/a.js' })
    render(<DebugPanel />)
    expect(screen.getByLabelText('Program')).toHaveAttribute('placeholder', 'src/a.js')
    fireEvent.click(screen.getByRole('button', { name: 'Use the current file' }))
    expect(d().program.p).toBe('src/a.js')
    fireEvent.change(screen.getByLabelText('Program'), { target: { value: 'server.js' } })
    fireEvent.change(screen.getByLabelText('Arguments'), { target: { value: '--x' } })
    expect(screen.getByLabelText('Build command')).toHaveAttribute('placeholder', 'e.g. make — runs before every start')
    fireEvent.change(screen.getByLabelText('Build command'), { target: { value: 'make' } })
    fireEvent.click(screen.getByLabelText('Stop on the first line'))
    expect(d()).toMatchObject({ program: { p: 'server.js' }, args: { p: '--x' }, build: { p: 'make' }, stopOnEntry: true })
    fireEvent.click(screen.getByRole('button', { name: /Start Debugging/ }))
    expect(start).toHaveBeenCalled()
    expect(screen.getByText('Click left of a line number to set one.')).toBeInTheDocument()

    act(() => useEditor.setState({ activeId: undefined }))
    expect(screen.getByLabelText('Program')).toHaveAttribute('placeholder', 'e.g. src/index.ts')
    expect(screen.getByRole('button', { name: 'Use the current file' })).toBeDisabled()

    act(() => useDebug.setState({ error: 'no-program' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a program to debug — or open a file.')
    act(() => useDebug.setState({ error: 'spawn node ENOENT' }))
    expect(screen.getByRole('alert')).toHaveTextContent('spawn node ENOENT')
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button'))
    expect(d().error).toBeUndefined()

    act(() => useDebug.setState({ session: session({ status: 'exited', exitCode: 0, frames: [] }) }))
    expect(screen.getByRole('status')).toHaveTextContent('Exited with code 0')
    act(() => useDebug.setState({ session: session({ status: 'exited', exitCode: null, frames: [] }) }))
    expect(screen.getByRole('status')).toHaveTextContent('Stopped')
    act(() => useDebug.setState({ session: session({ projectId: 'q', status: 'running', frames: [] }) }))
    expect(screen.queryByRole('status')).toBeNull() // another project's run
  })

  it('running: pause (not while starting), stop, restart; steps wait for a pause', () => {
    useDebug.setState({ session: session({ status: 'starting', frames: [] }) })
    render(<DebugPanel />)
    expect(screen.getByRole('status')).toHaveTextContent('Starting …')
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled()
    act(() => useDebug.setState({ session: session({ status: 'running', frames: [] }) }))
    expect(screen.getByRole('status')).toHaveTextContent('Running')
    const control = vi.spyOn(useDebug.getState(), 'control').mockResolvedValue()
    const stop = vi.spyOn(useDebug.getState(), 'stop').mockResolvedValue()
    const restart = vi.spyOn(useDebug.getState(), 'restart').mockResolvedValue()
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(control).toHaveBeenCalledWith('pause')
    expect(screen.getByRole('button', { name: 'Step Over' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    expect(stop).toHaveBeenCalled()
    expect(restart).toHaveBeenCalled()
  })

  it('paused: steps, variables (innermost scope open), call stack with Node frames folded, the exception', async () => {
    const control = vi.spyOn(useDebug.getState(), 'control').mockResolvedValue()
    const openAt = vi.spyOn(useEditor.getState(), 'openAt').mockResolvedValue()
    useDebug.setState({
      session: session({
        reason: 'exception',
        exception: 'Error: boom',
        frames: [frame(), frame({ id: 'f1', name: 'node:x', path: undefined, scopes: [] }), frame({ id: 'f2', name: 'main', path: 'src/main.js', line: 12, scopes: [{ type: 'module', objectId: 'M' }] })]
      })
    })
    render(<DebugPanel />)
    await act(settle)
    expect(screen.getByRole('status')).toHaveTextContent('Paused on exception')
    expect(screen.getByText('Error: boom')).toBeInTheDocument()
    for (const [name, action] of [['Continue', 'continue'], ['Step Over', 'stepOver'], ['Step Into', 'stepInto'], ['Step Out', 'stepOut']] as const) {
      fireEvent.click(screen.getByRole('button', { name }))
      expect(control).toHaveBeenLastCalledWith(action)
    }

    // The innermost scope opened by itself; objects expand into their properties.
    expect(screen.getByRole('button', { name: /Local: add/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('"hi"')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /user/ }))
    await act(settle)
    expect(screen.getByText('"Ada"')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^s/ })).toBeDisabled() // a plain value
    fireEvent.click(screen.getByRole('button', { name: /Local: add/ })) // fold by hand: stays folded
    await act(settle)
    expect(screen.queryByText('"hi"')).toBeNull()
    expect(screen.getByRole('button', { name: 'Global' })).toBeInTheDocument()

    // Call stack: project frames, Node's own folded behind a toggle.
    expect(screen.queryByText('node:x')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 Node frames' }))
    expect(screen.getByText('node:x')).toBeInTheDocument()
    expect(screen.getByText('Node internals')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hide Node frames' }))
    fireEvent.click(screen.getByRole('button', { name: /main/ }))
    expect(openAt).toHaveBeenCalledWith('src/main.js', 12)
    await act(settle)
    expect(screen.getByRole('button', { name: 'Module' })).toHaveAttribute('aria-expanded', 'true')

    act(() => useDebug.setState({ session: session({ reason: 'mystery', frames: [frame()] }), frame: 0 }))
    expect(screen.getByRole('status')).toHaveTextContent('Paused on mystery')
    // a stop elsewhere whose innermost scope is open already: left open, not toggled shut
    act(() => useDebug.setState({ expanded: { '0:0': true }, session: session({ frames: [frame({ id: 'f8' })] }), frame: 0 }))
    expect(useDebug.getState().expanded['0:0']).toBe(true)
    act(() => useDebug.setState({ session: session({ reason: undefined, frames: [frame({ scopes: [] })] }) }))
    expect(screen.getByRole('status')).toHaveTextContent('Paused on')
  })

  it('watch expressions and the breakpoint list', async () => {
    const openAt = vi.spyOn(useEditor.getState(), 'openAt').mockResolvedValue()
    useDebug.setState({ breakpoints: { p: [{ path: 'src/a.js', line: 2 }, { path: 'b.js', line: 7 }] } })
    render(<DebugPanel />)
    const add = screen.getByLabelText('Add expression')
    fireEvent.change(add, { target: { value: 'total' } })
    fireEvent.submit(add.closest('form')!)
    expect(d().watches).toEqual(['total'])
    expect(screen.getByText('not paused')).toBeInTheDocument()
    act(() => useDebug.setState({ session: session() }))
    await act(settle)
    expect(screen.getByText('7')).toBeInTheDocument()
    act(() => useDebug.setState({ watchValues: {} }))
    expect(screen.getByText('…')).toBeInTheDocument()
    act(() => useDebug.setState({ watchValues: { total: { name: 'total', value: 'ReferenceError', type: 'error' } } }))
    expect(screen.getByText('ReferenceError').className).toContain('text-danger')
    fireEvent.click(screen.getByRole('button', { name: 'Remove total' }))
    expect(d().watches).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: /^b\.js/ }))
    expect(openAt).toHaveBeenCalledWith('b.js', 7)
    fireEvent.click(screen.getByRole('button', { name: 'Remove src/a.js:2' }))
    expect(d().breakpoints.p).toEqual([{ path: 'b.js', line: 7 }])
    fireEvent.click(screen.getByRole('button', { name: 'Remove all breakpoints' }))
    expect(d().breakpoints.p).toEqual([])
  })

  it('the debug console: output by kind, evaluation, clear, close', async () => {
    useDebug.setState({
      console: [
        { id: 1, kind: 'info', text: '▶ node a.js\n' },
        { id: 2, kind: 'stdout', text: 'hi\n' },
        { id: 3, kind: 'stderr', text: 'warn\n' },
        { id: 4, kind: 'input', text: 'a' },
        { id: 5, kind: 'result', text: '1' },
        { id: 6, kind: 'error', text: 'boom' }
      ]
    })
    Element.prototype.scrollIntoView = vi.fn()
    render(<DebugConsole />)
    const log = screen.getByRole('log')
    expect([...log.querySelectorAll('pre')].map((p) => p.textContent)).toEqual(['▶ node a.js\n', 'hi\n', 'warn\n', '› a', '1', 'boom'])
    expect(screen.getByText('boom').className).toContain('text-danger')
    const input = screen.getByLabelText('Evaluate an expression')
    fireEvent.change(input, { target: { value: '6 + 1' } })
    fireEvent.submit(input.closest('form')!)
    await act(settle)
    expect(d().console.at(-1)).toMatchObject({ kind: 'result', text: '7' })
    expect(input).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Clear console' }))
    expect(d().console).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(d().consoleOpen).toBe(false)
  })
})

describe('EditorView: palette, problems, debugging', () => {
  const routes = (over: Record<string, (p: never) => unknown> = {}) =>
    installBridge({
      'projects:list': () => [{ id: 'p', name: 'Demo', path: '/x/p', addedAt: '', lastSeenAt: '' }],
      'files:list': () => [],
      'files:stat': () => [],
      'files:read': ({ path }: { path: string }) => ({ path, mtimeMs: 1, size: 1, content: 'x' }),
      'scm:status': () => ({ repo: true, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, merging: false, files: [] }),
      'scm:branches': () => [],
      'scm:files': () => ['a.ts'],
      'debug:session': () => null,
      'debug:control': () => undefined,
      'debug:stop': () => undefined,
      'debug:start': () => session({ status: 'starting', frames: [] }),
      'liveServer:status': () => [],
      ...over
    })
  const show = () => {
    useProjects.setState({ projects: [{ id: 'p', name: 'Demo', path: '/x/p', addedAt: '', lastSeenAt: '' }] })
    return render(
      <>
        <EditorView active onNavigate={vi.fn()} />
        <Palette />
      </>
    )
  }
  const key = (k: string, mods: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(window, { key: k, ...mods })

  it('⇧⌘P, F1 and ⌃G open the palette; ⌥⌘S saves everything; commands include the debugger', async () => {
    routes()
    show()
    await act(settle)
    const saveAll = vi.spyOn(useEditor.getState(), 'saveAll').mockResolvedValue()
    // The editor's commands are in the palette while it is mounted.
    expect(allCommands(en).find((c) => c.id === 'file.save')).toMatchObject({ group: 'Editor', keys: '⌘S' })
    key('P', { metaKey: true, shiftKey: true })
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Command palette' }), { target: { value: 'start debugging' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('Debug: Start DebuggingEditorF5')
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Command palette' }), { key: 'Escape' })
    key('F1')
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Command palette' }), { key: 'Escape' })
    key('p', { metaKey: true })
    expect(useScm.getState()).toMatchObject({ quickOpen: true, quickQuery: '' })
    fireEvent.keyDown(screen.getByRole('dialog').querySelector('input')!, { key: 'Escape' })
    key('g', { ctrlKey: true })
    expect(screen.getByRole('dialog', { name: 'Go to line' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('dialog').querySelector('input')!, { key: 'Escape' })
    key('s', { metaKey: true, altKey: true })
    expect(saveAll).toHaveBeenCalled()

    // Every debug command runs its action.
    const debug = useDebug.getState()
    const spies = {
      start: vi.spyOn(debug, 'start').mockResolvedValue(),
      stop: vi.spyOn(debug, 'stop').mockResolvedValue(),
      restart: vi.spyOn(debug, 'restart').mockResolvedValue(),
      control: vi.spyOn(debug, 'control').mockResolvedValue()
    }
    const runCommand = (label: string) => {
      key('p', { metaKey: true, shiftKey: true })
      fireEvent.change(screen.getByRole('combobox', { name: 'Command palette' }), { target: { value: label } })
      fireEvent.click(screen.getAllByRole('option')[0])
    }
    for (const label of ['Debug: Start Debugging', 'Debug: Stop', 'Debug: Restart', 'Debug: Continue', 'Debug: Step Over', 'Debug: Step Into', 'Debug: Step Out', 'Debug: Debug Console']) runCommand(label)
    expect(spies.start).toHaveBeenCalled()
    expect(spies.stop).toHaveBeenCalled()
    expect(spies.restart).toHaveBeenCalled()
    expect(spies.control.mock.calls.map(([a]) => a)).toEqual(['continue', 'stepOver', 'stepInto', 'stepOut'])
    expect(d().consoleOpen).toBe(true)
    runCommand('Debug: Run and Debug')
    expect(useScm.getState().pane).toBe('debug')
    useEditor.setState({ tabs: [tab('src/a.js')], activeId: 'p:src/a.js' })
    runCommand('Debug: Toggle Breakpoint')
    expect(d().breakpoints.p).toEqual([{ path: 'src/a.js', line: 1 }])
  })

  it('debug keys follow the session; F9 toggles at the cursor; the status bar shows the run', async () => {
    routes()
    useEditor.setState({ tabs: [tab('src/a.js')], activeId: 'p:src/a.js' })
    show()
    await act(settle)
    const debug = useDebug.getState()
    const start = vi.spyOn(debug, 'start').mockResolvedValue()
    const stop = vi.spyOn(debug, 'stop').mockResolvedValue()
    const restart = vi.spyOn(debug, 'restart').mockResolvedValue()
    const control = vi.spyOn(debug, 'control').mockResolvedValue()

    key('F5')
    expect(start).toHaveBeenCalledTimes(1)
    key('F10') // not paused: nothing
    key('F6') // not running: nothing
    expect(control).not.toHaveBeenCalled()
    act(() => useDebug.setState({ session: session({ status: 'running', frames: [] }) }))
    key('F5') // running: nothing to start
    expect(start).toHaveBeenCalledTimes(1)
    key('F6')
    expect(control).toHaveBeenLastCalledWith('pause')
    act(() => useDebug.setState({ session: session() }))
    key('F5')
    key('F10')
    key('F11')
    key('F11', { shiftKey: true })
    expect(control.mock.calls.map(([a]) => a)).toEqual(['pause', 'continue', 'stepOver', 'stepInto', 'stepOut'])
    key('F5', { shiftKey: true })
    expect(stop).toHaveBeenCalled()
    key('F5', { shiftKey: true, metaKey: true })
    expect(restart).toHaveBeenCalled()
    key('F9')
    expect(d().breakpoints.p).toEqual([{ path: 'src/a.js', line: 1 }])
    useEditor.setState({ activeId: undefined })
    key('F9') // no file on screen
    expect(d().breakpoints.p).toHaveLength(1)

    const chip = within(document.querySelector('footer')!).getByRole('button', { name: /Debugging: Paused on breakpoint/ })
    act(() => useDebug.setState({ consoleOpen: false }))
    fireEvent.click(chip)
    expect(useScm.getState().pane).toBe('debug')
    expect(d().consoleOpen).toBe(true)
    expect(screen.getByRole('log', { name: 'Debug Console' })).toBeInTheDocument()
    expect(screen.getByText('Run and Debug')).toBeInTheDocument()
    act(() => useDebug.setState({ session: session({ status: 'running', frames: [] }) }))
    expect(within(document.querySelector('footer')!).getByRole('button', { name: /Debugging: Running/ })).toBeInTheDocument()
    act(() => useDebug.setState({ session: session({ status: 'paused', reason: 'odd', frames: [frame()] }) }))
    expect(within(document.querySelector('footer')!).getByRole('button', { name: /Paused on odd/ })).toBeInTheDocument()
    act(() => useDebug.setState({ session: session({ status: 'paused', reason: undefined, frames: [frame()] }) }))
    act(() => useDebug.setState({ session: session({ status: 'exited', frames: [] }) }))
    expect(within(document.querySelector('footer')!).queryByRole('button', { name: /Debugging/ })).toBeNull()
  })

  it('problems: counted in the status bar, listed in the palette, a pick opens the line', async () => {
    routes()
    show()
    await act(settle)
    const r = (l: number, severity: 'error' | 'warning', code?: number) => ({ range: { start: { line: l, offset: 1 }, end: { line: l, offset: 2 } }, message: `${severity} ${l}`, severity, code })
    act(() => useProblems.getState().report('p', { 'a.ts': [r(3, 'error', 2322), r(5, 'warning')] }))
    const footer = within(document.querySelector('footer')!)
    const button = footer.getByRole('button', { name: /1\s*1/ })
    fireEvent.click(button)
    expect(screen.getByRole('dialog', { name: 'Problems' })).toBeInTheDocument()
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['⛔ error 3a.ts:3 · TS2322', '⚠️ warning 5a.ts:5'])
    const openAt = vi.spyOn(useEditor.getState(), 'openAt').mockResolvedValue()
    fireEvent.click(screen.getAllByRole('option')[1])
    expect(openAt).toHaveBeenCalledWith('a.ts', 5)

    act(() => useProblems.getState().report('p', { 'a.ts': [r(5, 'warning')] }))
    expect(footer.getByRole('button', { name: /0\s*1/ })).toBeInTheDocument()
    act(() => useProblems.getState().report('p', { 'a.ts': [r(3, 'error')] }))
    expect(footer.getByRole('button', { name: /1\s*0/ })).toBeInTheDocument()
    act(() => useProblems.getState().report('p', { 'a.ts': [] }))
    expect(footer.queryByRole('button', { name: /Problems/ })).toBeNull()
  })

  it('without a project selected there are no problems to count', () => {
    routes({ 'projects:list': () => [] })
    useEditor.setState({ projectId: undefined })
    useProjects.setState({ projects: [{ id: 'p', name: 'Demo', path: '/x/p', addedAt: '', lastSeenAt: '' }] })
    useProblems.getState().report('p', { 'a.ts': [{ range: { start: { line: 1, offset: 1 }, end: { line: 1, offset: 1 } }, message: 'x', severity: 'error' }] })
    // The first render has no project yet (the view picks one right after).
    const { unmount } = render(<EditorView active onNavigate={vi.fn()} />)
    unmount()
  })

  it('the user’s own keybindings (from VS Code) run Mindeck commands; chords and editor commands are Monaco’s', async () => {
    routes({ 'editor:settings': () => ({ settings: {}, snippets: [] }) })
    show()
    await act(settle)
    act(() =>
      useEditorPrefs.setState({
        settings: {
          keybindings: [
            { key: 'cmd+shift+o', command: 'workbench.action.quickOpen' },
            { key: 'cmd+alt+p', command: 'workbench.action.showCommands' },
            { key: 'ctrl+alt+u', command: 'git.push' },
            { key: 'cmd+k cmd+s', command: 'workbench.action.files.save' },
            { key: 'cmd+e', command: 'editor.action.x' }
          ]
        }
      })
    )
    const push = vi.spyOn(useScm.getState(), 'push').mockResolvedValue()
    useScm.setState({ status: { repo: true, branch: 'main', ahead: 0, behind: 0, merging: false, files: [] } })
    key('O', { metaKey: true, shiftKey: true, code: 'KeyO' } as KeyboardEventInit)
    expect(useScm.getState()).toMatchObject({ quickOpen: true, quickQuery: '' })
    act(() => useScm.getState().setQuickOpen(false))
    key('π', { metaKey: true, altKey: true, code: 'KeyP' } as KeyboardEventInit)
    expect(usePalette.getState().view).toBe('commands')
    act(() => usePalette.getState().close())
    key('u', { ctrlKey: true, altKey: true, code: 'KeyU' } as KeyboardEventInit)
    expect(push).toHaveBeenCalled()
    key('e', { metaKey: true, code: 'KeyE' } as KeyboardEventInit) // Monaco's to handle
    expect(useScm.getState().quickOpen).toBe(false)
    act(() => useEditorPrefs.setState({ settings: {} }))
    key('O', { metaKey: true, shiftKey: true, code: 'KeyO' } as KeyboardEventInit) // gone again
    expect(useScm.getState().quickOpen).toBe(false)
  })

  it('a file whose language server is missing says so in the status bar — a click leads to Settings', async () => {
    routes()
    const onNavigate = vi.fn()
    useProjects.setState({ projects: [{ id: 'p', name: 'Demo', path: '/x/p', addedAt: '', lastSeenAt: '' }] })
    useEditor.setState({ tabs: [tab('app.py'), tab('a.ts')], activeId: 'p:app.py' })
    render(<EditorView active onNavigate={onNavigate} />)
    await act(settle)
    const footer = within(document.querySelector('footer')!)
    expect(footer.queryByText(/no language server/)).toBeNull() // not known yet
    act(() => useLanguages.getState().report('p:app.py', { language: 'python', available: false }))
    fireEvent.click(footer.getByRole('button', { name: 'Python · no language server' }))
    expect(onNavigate).toHaveBeenCalledWith('settings')
    act(() => useLanguages.getState().report('p:app.py', { language: 'python', available: true }))
    expect(footer.queryByText(/no language server/)).toBeNull()
    act(() => useLanguages.getState().report('p:a.ts', { language: 'typescript', available: false }))
    act(() => useEditor.setState({ activeId: 'p:a.ts' }))
    expect(footer.queryByText(/no language server/)).toBeNull() // TypeScript has no install button
    act(() => useLanguages.getState().report('p:a.ts', { language: undefined, available: false }))
    expect(footer.queryByText(/no language server/)).toBeNull()
  })

  it('problems of language servers name their tool and rule', async () => {
    routes()
    show()
    await act(settle)
    act(() =>
      useProblems.getState().report('p', {
        'app.py': [{ range: { start: { line: 3, offset: 1 }, end: { line: 3, offset: 2 } }, message: 'bad type', severity: 'error', code: 'reportX', source: 'Pyright' }]
      })
    )
    fireEvent.click(within(document.querySelector('footer')!).getByRole('button', { name: /1\s*0/ }))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['⛔ bad typeapp.py:3 · Pyright reportX'])
  })


  it('the status bar: Go Live on an HTML file, the port while it runs; the Sass watcher; their errors', async () => {
    routes({ 'liveServer:status': () => [], 'liveServer:start': () => ({ projectId: 'p', url: 'http://127.0.0.1:5500', port: 5500, root: '' }), 'liveServer:stop': () => undefined, 'sass:compileAll': () => ({ written: ['main.css'], errors: {} }) })
    useEditor.setState({ tabs: [tab('index.html'), tab('main.scss'), tab('a.ts')], activeId: 'p:index.html' })
    show()
    await act(settle)
    const footer = within(document.querySelector('footer')!)
    fireEvent.click(footer.getByRole('button', { name: /Go Live/ }))
    await act(settle)
    fireEvent.click(footer.getByRole('button', { name: /Port 5500/ }))
    await act(settle)
    expect(useLive.getState().servers).toEqual([])
    expect(footer.queryByRole('button', { name: /Watch Sass/ })).toBeNull()

    act(() => useEditor.setState({ activeId: 'p:main.scss' }))
    expect(footer.queryByRole('button', { name: /Go Live/ })).toBeNull()
    fireEvent.click(footer.getByRole('button', { name: /Watch Sass/ }))
    await act(settle)
    const watching = footer.getByRole('button', { name: /Watching Sass/ })
    expect(watching).toHaveAttribute('title', 'Compiled: main.css')
    act(() => useEditor.setState({ activeId: 'p:a.ts' }))
    expect(footer.getByRole('button', { name: /Watching Sass/ })).toHaveAttribute('title', 'Compiled: main.css') // stays while on
    act(() => useLive.setState({ sass: undefined }))
    expect(footer.getByRole('button', { name: /Watching Sass/ })).toHaveAttribute('title', 'Compile .scss / .sass to CSS on every save')

    act(() => useLive.setState({ error: 'port taken' }))
    expect(screen.getByText('port taken')).toBeInTheDocument()
    fireEvent.click(screen.getAllByLabelText('Dismiss')[0])
    expect(useLive.getState().error).toBeUndefined()
  })

  it('palette: Live Server and Sass commands', async () => {
    routes({ 'liveServer:status': () => [] })
    useEditor.setState({ tabs: [tab('index.html'), tab('a.ts')], activeId: 'p:index.html' })
    show()
    await act(settle)
    const live = useLive.getState()
    const start = vi.spyOn(live, 'start').mockResolvedValue()
    const stop = vi.spyOn(live, 'stop').mockResolvedValue()
    const toggle = vi.spyOn(live, 'toggleSass').mockResolvedValue()
    const run = (label: string) => {
      fireEvent.keyDown(window, { key: 'p', metaKey: true, shiftKey: true })
      fireEvent.change(screen.getByRole('combobox', { name: 'Command palette' }), { target: { value: label } })
      fireEvent.click(screen.getAllByRole('option')[0])
    }
    run('Live Server: Go Live')
    expect(start).toHaveBeenLastCalledWith('index.html')
    act(() => useEditor.setState({ activeId: 'p:a.ts' }))
    run('Live Server: Go Live')
    expect(start).toHaveBeenLastCalledWith(undefined)
    run('Live Server: Stop')
    run('Sass: Watch')
    expect(stop).toHaveBeenCalled()
    expect(toggle).toHaveBeenCalled()
  })

})
