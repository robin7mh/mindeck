import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IMarker, Terminal } from '@xterm/xterm'
import { fail, installBridge, installRemote } from './bridge'
import { FakeTerminal, xt, type FakeMarker } from './xtermFake'
import { DEFAULT_TERMINAL_SETTINGS, type TerminalInfo, type TerminalSnapshot } from '@shared/types/terminal'
import { terminalAction, shortcutLabel } from '@/features/terminal/keys'
import { CommandTracker } from '@/features/terminal/commands'
import { fileLinkProvider, findPaths, homeOf, projectFile, resetProjectCache, resolvePath, rowText } from '@/features/terminal/links'
import { useTerminalSettings } from '@/features/terminal/settings'
import { SAVE_MS, SAVED_SCROLLBACK, saveNow, scheduleSave, serializers, snapshot, useTerminals } from '@/features/terminal/store'

const initial = useTerminals.getState()
const initialSettings = useTerminalSettings.getState()
let n = 0
const info = (extra: Partial<TerminalInfo> = {}): TerminalInfo => {
  n += 1
  return { id: `t${n}`, title: '~', cwd: '/h', cwdLabel: '~', shell: 'zsh', createdAt: `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`, ...extra }
}

beforeEach(() => {
  useTerminals.setState(initial, true)
  useTerminalSettings.setState(initialSettings, true)
  serializers.clear()
  xt.reset()
  resetProjectCache()
  n = 0
})
afterEach(() => {
  vi.useRealTimers()
})

describe('terminal shortcuts', () => {
  it('macOS: ⌘F, ⌘K, ⌘↑/↓; elsewhere the same on Ctrl+Shift', () => {
    const k = (init: Partial<KeyboardEvent>) => ({ type: 'keydown', key: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init })
    expect(terminalAction(k({ key: 'f', metaKey: true }), true)).toBe('find')
    expect(terminalAction(k({ key: 'K', metaKey: true }), true)).toBe('clear')
    expect(terminalAction(k({ key: 'ArrowUp', metaKey: true }), true)).toBe('prevCommand')
    expect(terminalAction(k({ key: 'ArrowDown', metaKey: true }), true)).toBe('nextCommand')
    expect(terminalAction(k({ key: 'x', metaKey: true }), true)).toBeUndefined()
    expect(terminalAction(k({ key: 'f', metaKey: true, shiftKey: true }), true)).toBeUndefined()
    expect(terminalAction(k({ key: 'f', ctrlKey: true }), true)).toBeUndefined()
    expect(terminalAction(k({ key: 'f', metaKey: true, type: 'keyup' }), true)).toBeUndefined()
    expect(terminalAction(k({ key: 'f', metaKey: true, altKey: true }), true)).toBeUndefined()

    expect(terminalAction(k({ key: 'F', ctrlKey: true, shiftKey: true }), false)).toBe('find')
    expect(terminalAction(k({ key: 'f', ctrlKey: true }), false)).toBeUndefined() // readline's forward-char
    expect(terminalAction(k({ key: 'f', ctrlKey: true, shiftKey: true, metaKey: true }), false)).toBeUndefined()
    expect(terminalAction(k({ key: 'f', ctrlKey: true, shiftKey: true }))).toBe('find') // this platform (not a Mac here)

    // copy and paste: the Edit menu's ⌘C/⌘V on a Mac; Ctrl+Shift+C/V and Ctrl/Shift+Insert elsewhere
    expect(terminalAction(k({ key: 'c', metaKey: true }), true)).toBeUndefined()
    expect(terminalAction(k({ key: 'Insert', shiftKey: true }), true)).toBeUndefined()
    expect(terminalAction(k({ key: 'C', ctrlKey: true, shiftKey: true }), false)).toBe('copy')
    expect(terminalAction(k({ key: 'V', ctrlKey: true, shiftKey: true }), false)).toBe('paste')
    expect(terminalAction(k({ key: 'c', ctrlKey: true }), false)).toBeUndefined() // the shell's interrupt
    expect(terminalAction(k({ key: 'Insert', ctrlKey: true }), false)).toBe('copy')
    expect(terminalAction(k({ key: 'Insert', shiftKey: true }), false)).toBe('paste')
    expect(terminalAction(k({ key: 'Insert', ctrlKey: true, shiftKey: true }), false)).toBeUndefined()
    expect(terminalAction(k({ key: 'Insert' }), false)).toBeUndefined()
    expect(terminalAction(k({ key: 'Insert', ctrlKey: true, metaKey: true }), false)).toBeUndefined()
    // ⌘W closes the tab on a Mac; Ctrl+W deletes a word in the shell elsewhere
    expect(terminalAction(k({ key: 'w', metaKey: true }), true)).toBe('close')
    expect(terminalAction(k({ key: 'w', ctrlKey: true }), false)).toBeUndefined()
    expect(terminalAction(k({ key: 'W', ctrlKey: true, shiftKey: true }), false)).toBeUndefined() // the workspace's pane key
    expect(shortcutLabel('close', true)).toBe('⌘W')
    expect(shortcutLabel('copy', true)).toBe('⌘C')
    expect(shortcutLabel('paste', false)).toBe('Ctrl+Shift+V')

    expect(shortcutLabel('find', true)).toBe('⌘F')
    expect(shortcutLabel('prevCommand', false)).toBe('Ctrl+Shift+↑')
    expect(shortcutLabel('nextCommand')).toBe('Ctrl+Shift+↓')
    expect(shortcutLabel('clear')).toBe('Ctrl+Shift+K')
  })
})

describe('CommandTracker (OSC 133)', () => {
  /** The fake behind a marker the tracker holds (its line can be moved). */
  const fake = (m?: IMarker) => m as unknown as FakeMarker

  const setup = () => {
    const term = new FakeTerminal({})
    term.lines = [{ text: '$ ls' }, { text: 'a.txt' }, { text: 'b.txt', wrapped: true }, { text: '$ false' }, { text: '$ printf x' }, { text: 'x$ ' }]
    const tracker = new CommandTracker(term as unknown as Terminal, (code) => `exit ${code}`)
    const at = (y: number, x = 0) => (term.cursor = { x, y })
    return { term, tracker, at }
  }

  it('marks finished commands at the margin and copies the last output', () => {
    const { term, tracker, at } = setup()
    expect(tracker.lastOutput()).toBeUndefined()
    expect(term.osc(133, 'C')).toBe(true) // nothing to start yet
    term.osc(133, 'D;0')
    at(0)
    term.osc(133, 'A')
    term.osc(133, 'B')
    term.osc(133, 'D;0') // no output began: the user is still typing
    at(1)
    term.osc(133, 'C')
    term.osc(133, 'C') // twice: the first one counts
    at(3)
    term.osc(133, 'D;0')
    term.osc(133, 'D;5') // already ended
    expect(tracker.commands[0]).toMatchObject({ exitCode: 0, endCol: 0 })
    expect(term.decorations[0].el.className).toBe('mindeck-command-mark is-ok')
    expect(term.decorations[0].el.title).toBe('exit 0')
    expect(tracker.lastOutput()).toBe('a.txtb.txt') // a wrapped row continues the one above

    term.osc(133, 'A')
    at(4)
    term.osc(133, 'C')
    term.osc(133, 'D;1')
    expect(term.decorations[1].el.className).toBe('mindeck-command-mark is-error')
    expect(tracker.lastOutput()).toBe('')

    term.osc(133, 'A')
    at(5)
    term.osc(133, 'C')
    at(5, 1)
    term.osc(133, 'D') // no code
    expect(term.decorations[2].el.className).toBe('mindeck-command-mark is-ok')
    expect(term.decorations[2].el.title).toBe('')
    expect(tracker.lastOutput()).toBe('x') // printed without a newline: only what came before the end
    term.osc(133, 'E;x') // something else: ignored

    term.markers.find((m) => m === tracker.commands[2].output)!.line = -1 // scrolled out of the buffer
    expect(tracker.lastOutput()).toBeUndefined()
    fake(tracker.commands[2].output).line = 5
    fake(tracker.commands[2].end).line = -1
    expect(tracker.lastOutput()).toBeUndefined()

    tracker.dispose()
    expect(term.osc(133, 'A')).toBe(false)
    expect(term.decorations.every((d) => d.disposed)).toBe(true)
    expect(tracker.commands).toEqual([])
  })

  it('jumps between prompts, going on from the last jump while it is on screen', () => {
    const { term, tracker, at } = setup()
    term.lines = Array.from({ length: 10 }, () => ({ text: '' }))
    term.rows = 3
    for (const y of [0, 4, 8]) {
      at(y)
      term.osc(133, 'A')
    }
    tracker.commands[0].output = term.registerMarker() as never
    tracker.commands[1].output = term.registerMarker() as never
    const view = term.buffer.active
    view.baseY = 7
    view.viewportY = 7 // at the bottom: from the prompt being typed at (8)
    expect(tracker.previous()).toBe(true)
    expect(term.scrollToLine).toHaveBeenLastCalledWith(4)
    expect(tracker.previous()).toBe(true)
    expect(term.scrollToLine).toHaveBeenLastCalledWith(0)
    expect(tracker.previous()).toBe(false)
    expect(term.scrollToTop).toHaveBeenCalled()
    expect(tracker.next()).toBe(true)
    expect(term.scrollToLine).toHaveBeenLastCalledWith(4)
    expect(tracker.next()).toBe(true)
    expect(term.scrollToLine).toHaveBeenLastCalledWith(8)
    expect(tracker.next()).toBe(false)
    expect(term.scrollToBottom).toHaveBeenCalled()

    // scrolled away by hand: from the view's top again
    tracker.previous()
    view.viewportY = 0
    expect(tracker.previous()).toBe(false)
    // a new prompt forgets the last jump; a prompt gone from the buffer counts as none
    view.viewportY = 7
    tracker.previous()
    at(9)
    term.osc(133, 'A')
    view.viewportY = 7
    expect(tracker.previous()).toBe(true)
    expect(term.scrollToLine).toHaveBeenLastCalledWith(8)
    view.viewportY = 7
    fake(tracker.commands[3].prompt).line = -1
    fake(tracker.commands[2].prompt).line = -1
    tracker.previous()
    expect(term.scrollToLine).toHaveBeenLastCalledWith(4)
  })

  it('keeps the latest commands; skips what xterm can’t place', () => {
    const { term, tracker } = setup()
    term.noMarkers = true
    term.osc(133, 'A')
    expect(tracker.commands).toEqual([])
    term.noMarkers = false
    term.noDecorations = true
    term.osc(133, 'A')
    term.osc(133, 'C')
    term.osc(133, 'D;0')
    expect(tracker.commands[0].mark).toBeUndefined()
    const first = tracker.commands[0].prompt
    for (let i = 0; i < 500; i += 1) term.osc(133, 'A')
    expect(tracker.commands).toHaveLength(500)
    expect(first.isDisposed).toBe(true)
  })
})

describe('file links', () => {
  it('finds file references with line numbers in several styles', () => {
    const found = (text: string) => findPaths(text).map(({ index, text: t, path, line }) => [index, t, path, line])
    expect(found('error in src/app.ts:12:5 here')).toEqual([[9, 'src/app.ts:12:5', 'src/app.ts', 12]])
    expect(found('./b.py:3 and ../c/d.go(7,2) and /abs/e.rs')).toEqual([
      [0, './b.py:3', './b.py', 3],
      [13, '../c/d.go(7,2)', '../c/d.go', 7],
      [32, '/abs/e.rs', '/abs/e.rs', undefined]
    ])
    expect(found('~/notes/todo.md C:\\x\\y.ts:4')).toEqual([
      [0, '~/notes/todo.md', '~/notes/todo.md', undefined],
      [16, 'C:\\x\\y.ts:4', 'C:\\x\\y.ts', 4]
    ])
    expect(found('version 1.5, see https://example.com/a.js or foo')).toEqual([])
  })

  it('resolves against the folder, Home and parent references', () => {
    expect(resolvePath('/p', 'src/../lib/./a.ts')).toBe('/p/lib/a.ts')
    expect(resolvePath('/p', '/etc/x.conf')).toBe('/etc/x.conf')
    expect(resolvePath('/p', '~/a.md', '/home/u')).toBe('/home/u/a.md')
    expect(resolvePath('/p', '~/a.md')).toBeUndefined()
    expect(resolvePath('C:\\p', 'src\\a.ts')).toBe('C:\\p\\src\\a.ts')
    expect(resolvePath('/p', 'D:/x/../y.ts')).toBe('D:\\y.ts')
    expect(homeOf('/home/u', '~')).toBe('/home/u')
    expect(homeOf('/home/u/code/x', '~/code/x')).toBe('/home/u')
    expect(homeOf('/srv/x', '/srv/x')).toBeUndefined()
  })

  it('maps characters to cells (wide ones take two)', () => {
    const term = new FakeTerminal({})
    term.lines = [{ text: '日本 a.ts' }]
    const row = rowText(term.buffer.active.getLine(0)! as never)
    expect(row.text).toBe('日本 a.ts')
    expect(row.cols).toEqual([0, 2, 4, 5, 6, 7, 8])
    term.lines = [{ text: '' }]
    expect(rowText(term.buffer.active.getLine(0)! as never)).toEqual({ text: '', cols: [] })
    // a cell never written to has no characters: a space
    expect(rowText({ length: 2, getCell: (x: number) => ({ getChars: () => (x ? 'a' : ''), getWidth: () => 1 }) } as never)).toEqual({ text: ' a', cols: [0, 1] })
  })

  it('finds the project of a path (the deepest), caching the project list for a while', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const bridge = installBridge({
      'projects:list': () => [
        { id: 'outer', name: 'O', path: '/code/', addedAt: '', lastSeenAt: '' },
        { id: 'inner', name: 'I', path: '/code/app', addedAt: '', lastSeenAt: '' },
        { id: 'win', name: 'W', path: 'C:\\w', addedAt: '', lastSeenAt: '' }
      ]
    })
    expect(await projectFile('/code/app/src/a.ts')).toEqual({ projectId: 'inner', path: 'src/a.ts' })
    expect(await projectFile('/code/b.ts')).toEqual({ projectId: 'outer', path: 'b.ts' })
    expect(await projectFile('C:\\w\\x\\y.ts')).toEqual({ projectId: 'win', path: 'x/y.ts' })
    expect(await projectFile('/elsewhere/c.ts')).toBeUndefined()
    expect(bridge.invoke.mock.calls.filter(([c]) => c === 'projects:list')).toHaveLength(1)
    now.mockReturnValue(20_000)
    await projectFile('/code/b.ts')
    expect(bridge.invoke.mock.calls.filter(([c]) => c === 'projects:list')).toHaveLength(2)
    now.mockRestore()

    resetProjectCache()
    installBridge({ 'projects:list': () => fail('offline') })
    expect(await projectFile('/code/b.ts')).toBeUndefined()
  })

  it('links only files that exist in a project; a click opens them on their line', async () => {
    installBridge({
      'projects:list': () => [{ id: 'p', name: 'P', path: '/code/p', addedAt: '', lastSeenAt: '' }],
      'files:stat': ({ paths }: { paths: string[] }) => (paths[0] === 'gone.ts' ? [null] : paths[0] === 'err.ts' ? fail('x') : [{ mtimeMs: 1, size: 1 }])
    })
    const term = new FakeTerminal({})
    term.lines = [{ text: '日 src/a.ts:3 gone.ts:1 err.ts /tmp/x.ts ~/q.ts b.ts' }, { text: 'nothing here' }]
    const open = vi.fn()
    let where = { cwd: '/code/p', cwdLabel: '~/code/p' }
    const provider = fileLinkProvider(term as unknown as Terminal, () => where, open)
    const links = (y: number) => new Promise<{ text: string; range: unknown; activate: () => void }[] | undefined>((r) => provider.provideLinks(y, r as never))

    expect(await links(2)).toBeUndefined() // no references
    expect(await links(9)).toBeUndefined() // no such row
    const found = (await links(1))!
    expect(found.map((l) => l.text)).toEqual(['src/a.ts:3', 'b.ts'])
    expect(found[0].range).toEqual({ start: { x: 4, y: 1 }, end: { x: 13, y: 1 } })
    found[0].activate()
    found[1].activate()
    expect(open.mock.calls).toEqual([
      [{ projectId: 'p', path: 'src/a.ts' }, 3],
      [{ projectId: 'p', path: 'b.ts' }, 1]
    ])

    // Home is known from the label: ~/q.ts lies in the project when Home is the project's parent
    where = { cwd: '/code', cwdLabel: '~' }
    term.lines = [{ text: '~/p/q.ts' }]
    expect((await links(1))!.map((l) => l.text)).toEqual(['~/p/q.ts'])
    term.lines = [{ text: 'gone.ts' }]
    where = { cwd: '/code/p', cwdLabel: '/code/p' }
    expect(await links(1)).toBeUndefined()
  })
})

describe('terminal settings store', () => {
  it('loads once (again when asked), with defaults when the core can’t say; configure saves', async () => {
    const bridge = installBridge({
      'terminal:settings': () => ({ ...DEFAULT_TERMINAL_SETTINGS, fontSize: 15 }),
      'terminal:shells': () => [{ id: 'zsh', name: 'zsh', file: '/bin/zsh', args: ['-l'] }],
      'terminal:configure': (patch: object) => ({ ...DEFAULT_TERMINAL_SETTINGS, fontSize: 15, ...patch })
    })
    const s = () => useTerminalSettings.getState()
    await s().load()
    expect(s().settings.fontSize).toBe(15)
    expect(s().shells).toHaveLength(1)
    await s().load()
    expect(bridge.invoke.mock.calls.filter(([c]) => c === 'terminal:settings')).toHaveLength(1)
    await s().configure({ gpu: false })
    expect(s().settings).toMatchObject({ gpu: false, fontSize: 15 })

    installBridge({ 'terminal:settings': () => fail('x'), 'terminal:shells': () => fail('x'), 'terminal:configure': () => fail('denied') })
    await s().load(true)
    expect(s().settings.fontSize).toBe(15) // kept
    expect(s().shells).toEqual([])
    await s().configure({ gpu: true })
    expect(s().error).toBe('denied')
  })
})

describe('terminal store: restore, split, follow, save', () => {
  const saved = (tabs: TerminalSnapshot['tabs'], extra: Partial<TerminalSnapshot> = {}): TerminalSnapshot => ({ layout: 'grid', active: 1, tabs, savedAt: '2026-10-15T08:00:00.000Z', ...extra })

  // First: the module saves from the first desktop init on.
  it('the web UI neither restores nor saves', async () => {
    const created = info()
    const restore = vi.fn(() => saved([{ title: 'a', cwd: '/a', scrollback: '' }]))
    const persist = vi.fn()
    installRemote({ 'terminal:list': () => [], 'terminal:restore': restore, 'terminal:create': () => created, 'terminal:persist': persist })
    await useTerminals.getState().init()
    expect(restore).not.toHaveBeenCalled()
    expect(useTerminals.getState().tabs).toEqual([created])
    scheduleSave()
    await saveNow()
    expect(persist).not.toHaveBeenCalled()
  })

  it('brings back the last run: folders, profiles, layout and output; a gone folder opens Home', async () => {
    const created: unknown[] = []
    installBridge({
      'terminal:list': () => [],
      'terminal:restore': () =>
        saved([
          { title: 'api', cwd: '/code/api', projectId: 'p1', profileId: 'zsh', scrollback: 'old output' },
          { title: 'gone', cwd: '/gone', scrollback: '  ' },
          { title: 'x', cwd: '/x', scrollback: '' }
        ]),
      'terminal:create': (req: { cwd?: string }) => {
        created.push(req)
        if (req.cwd === '/gone') throw new Error('not found')
        if (req.cwd === '/x') throw new Error('no pty')
        return info({ cwd: req.cwd ?? '/h' })
      }
    })
    await useTerminals.getState().init()
    const s = useTerminals.getState()
    expect(created).toEqual([
      { cwd: '/code/api', projectId: 'p1', profileId: 'zsh' },
      { cwd: '/gone', projectId: undefined, profileId: undefined },
      {}, // Home instead
      { cwd: '/x', projectId: undefined, profileId: undefined },
      {}
    ])
    expect(s.tabs.map((t) => [t.cwd, t.restored])).toEqual([
      ['/code/api', { scrollback: 'old output', savedAt: '2026-10-15T08:00:00.000Z' }],
      ['/h', undefined],
      ['/h', undefined]
    ])
    expect(s.layout).toBe('grid')
    expect(s.activeId).toBe(s.tabs[1].id)
  })

  it('nothing to restore (or nothing could start): Home as before', async () => {
    const created = info()
    installBridge({ 'terminal:list': () => [], 'terminal:restore': () => saved([], { active: 0 }), 'terminal:create': () => created })
    await useTerminals.getState().init()
    expect(useTerminals.getState().tabs).toEqual([created])

    useTerminals.setState(initial, true)
    installBridge({ 'terminal:list': () => [], 'terminal:restore': () => saved([{ title: 'a', cwd: '/a', scrollback: '' }]), 'terminal:create': () => fail('limit') })
    await useTerminals.getState().init(false)
    expect(useTerminals.getState().tabs).toEqual([])

    // `active` out of range: the first tab
    useTerminals.setState(initial, true)
    installBridge({ 'terminal:list': () => [], 'terminal:restore': () => saved([{ title: 'a', cwd: '/a', scrollback: '' }], { active: 3 }), 'terminal:create': () => created })
    await useTerminals.getState().init()
    expect(useTerminals.getState().activeId).toBe(created.id)

    // the saved tabs can't be read: Home as before
    useTerminals.setState(initial, true)
    installBridge({ 'terminal:list': () => [], 'terminal:restore': () => fail('corrupt'), 'terminal:create': () => created })
    await useTerminals.getState().init()
    expect(useTerminals.getState().tabs).toEqual([created])
  })

  it('splits next to a shell (single → side by side), follows reported folders, restarts in the last folder', async () => {
    const a = info({ profileId: 'fish', projectId: 'p1', cwd: '/code/p1/src' })
    const b = info()
    const queue = [info(), info()]
    const bridge = installBridge({ 'terminal:list': () => [a, b], 'terminal:create': () => queue.shift() ?? fail('limit') })
    const s = () => useTerminals.getState()
    await s().init()
    await s().split(a.id)
    expect(bridge.invoke).toHaveBeenCalledWith('terminal:create', { projectId: 'p1', cwd: '/code/p1/src', profileId: 'fish' })
    expect(s().tabs.map((t) => t.id)).toEqual([a.id, 't3', b.id])
    expect([s().activeId, s().layout]).toEqual(['t3', 'cols'])
    s().setLayout('grid')
    await s().split(b.id)
    expect(s().tabs.map((t) => t.id)).toEqual([a.id, 't3', b.id, 't4'])
    expect(s().layout).toBe('grid')
    await s().split(b.id)
    expect(s().error).toBe('limit')
    await s().split('ghost')

    act(() => bridge.emit('terminal:info', { ...a, cwd: '/tmp', cwdLabel: '/tmp', title: 'tmp' }))
    expect(s().tabs[0]).toMatchObject({ cwd: '/tmp', cwdLabel: '/tmp', title: 'tmp', profileId: 'fish' })

    queue.push(info())
    await s().restart(a.id)
    expect(bridge.invoke).toHaveBeenLastCalledWith('terminal:create', { projectId: 'p1', cwd: '/tmp', profileId: 'fish' })
  })

  it('saves tabs, layout and output a little after a change, and when the window closes', async () => {
    vi.useFakeTimers()
    const persist = vi.fn()
    const a = info({ projectId: 'p1', profileId: 'zsh' })
    installBridge({ 'terminal:list': () => [a, info()], 'terminal:persist': persist })
    await useTerminals.getState().init()
    await saveNow() // what earlier tests left pending
    persist.mockClear()
    serializers.set(a.id, () => 'x'.repeat(SAVED_SCROLLBACK + 5))
    useTerminals.getState().setActive('t2')
    useTerminals.getState().setLayout('rows')
    await vi.advanceTimersByTimeAsync(SAVE_MS)
    expect(persist).toHaveBeenCalledTimes(1)
    const snap = persist.mock.calls[0][0] as TerminalSnapshot
    expect(snap).toMatchObject({ layout: 'rows', active: 1 })
    expect(snap.tabs[0]).toMatchObject({ projectId: 'p1', profileId: 'zsh' })
    expect(snap.tabs[0].scrollback).toHaveLength(SAVED_SCROLLBACK)
    expect(snap.tabs[1]).toEqual({ title: '~', cwd: '/h', scrollback: '' })

    window.dispatchEvent(new Event('beforeunload'))
    await vi.advanceTimersByTimeAsync(0)
    expect(persist).toHaveBeenCalledTimes(2)
    persist.mockRejectedValueOnce(new Error('disk full')) // closing anyway: no error
    await expect(saveNow()).resolves.toBeUndefined()
    expect(persist).toHaveBeenCalledTimes(3)

    // restoring switched off: nothing is sent
    useTerminalSettings.setState({ settings: { ...DEFAULT_TERMINAL_SETTINGS, restore: false } })
    await saveNow()
    expect(persist).toHaveBeenCalledTimes(3)
    expect(snapshot().active).toBe(1)
    useTerminals.setState({ activeId: undefined })
    expect(snapshot().active).toBe(0)
  })
})
