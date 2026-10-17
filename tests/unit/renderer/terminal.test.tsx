import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, installBridge, installRemote, settle } from './bridge'
import type { TerminalInfo } from '@shared/types/terminal'

// --- xterm.js and its addons as fakes (jsdom has no canvas/WebGL/layout) -----
vi.mock('@xterm/xterm', async () => (await import('./xtermFake')).xtermModule)
vi.mock('@xterm/addon-fit', async () => (await import('./xtermFake')).fitModule)
vi.mock('@xterm/addon-web-links', async () => (await import('./xtermFake')).webLinksModule)
vi.mock('@xterm/addon-search', async () => (await import('./xtermFake')).searchModule)
vi.mock('@xterm/addon-serialize', async () => (await import('./xtermFake')).serializeModule)
vi.mock('@xterm/addon-unicode11', async () => (await import('./xtermFake')).unicodeModule)
vi.mock('@xterm/addon-webgl', async () => (await import('./xtermFake')).webglModule)

// The platform's keys: Windows/Linux unless a test says Mac.
const flags = vi.hoisted(() => ({ mac: false }))
vi.mock('@/lib/platform', async (original) => ({
  ...(await original<object>()),
  get isMac() {
    return flags.mac
  }
}))

import { xt as x } from './xtermFake'
import { TerminalView } from '@/features/terminal/components/TerminalView'
import { XtermPane } from '@/features/terminal/components/XtermPane'
import { useTerminals } from '@/features/terminal/store'
import { useTerminalSettings } from '@/features/terminal/settings'
import { serializers } from '@/features/terminal/store'
import { FIT_SETTLE_MS, plainText } from '@/features/terminal/useXterm'
import { useEditor } from '@/features/editor/store'
import { DEFAULT_TERMINAL_SETTINGS } from '@shared/types/terminal'
import { resetProjectCache } from '@/features/terminal/links'
import { useBrowser } from '@/features/browser/store'
import { state } from './browserFixtures'

const initial = useTerminals.getState()
const initialSettings = useTerminalSettings.getState()
let n = 0
const info = (extra: Partial<TerminalInfo> = {}): TerminalInfo => {
  n += 1
  return {
    id: `t${n}`,
    title: '~',
    cwd: '/home/u',
    cwdLabel: '~',
    shell: 'zsh',
    createdAt: `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`,
    ...extra
  }
}
const pending = () => new Promise<never>(() => {})

beforeEach(() => {
  useTerminals.setState(initial, true)
  useTerminalSettings.setState(initialSettings, true)
  x.reset()
  n = 0
})

/** Make host elements measurable (jsdom reports 0×0). */
const sized = (w: number, h: number) => {
  const wSpy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(w)
  const hSpy = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(h)
  return () => {
    wSpy.mockRestore()
    hSpy.mockRestore()
  }
}

describe('TerminalView', () => {
  it('offers the dev servers its shell started: one click shows them in the browser', async () => {
    const created = info({ title: 'shop', cwdLabel: '~/shop' })
    installBridge({ 'terminal:list': () => [created], 'terminal:attach': pending })
    const initialBrowser = useBrowser.getState()
    const show = vi.fn(async () => {})
    const server = (terminalId: string, port: number) => ({ terminalId, url: `http://localhost:${port}/`, label: `localhost:${port}`, detectedAt: '' })
    useBrowser.setState({ show, state: state([], { devServers: [server(created.id, 5173), server('other', 3000)] }) })
    render(<TerminalView />)
    await act(settle)
    expect(screen.queryByTitle('Open localhost:3000')).toBeNull() // another shell's
    fireEvent.click(screen.getByTitle('Open localhost:5173'))
    expect(show).toHaveBeenCalledWith('http://localhost:5173/')
    useBrowser.setState(initialBrowser, true)
  })

  it('opens one shell on first mount, shows its header and the layout picker', async () => {
    const created = info({ title: 'demo', cwdLabel: '~/demo' })
    installBridge({ 'terminal:list': () => [], 'terminal:create': () => created, 'terminal:attach': pending })
    render(<TerminalView />)
    await act(settle)
    expect(screen.getByText('zsh · ~/demo')).toBeInTheDocument()
    expect(screen.getByLabelText('Layout: Single')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByLabelText('Layout: 2 × 2'))
    expect(screen.getByLabelText('Layout: 2 × 2')).toHaveAttribute('aria-pressed', 'true')
    // 1 tab in a 4-pane grid → 3 empty panes offering a new terminal
    expect(screen.getAllByText('New terminal')).toHaveLength(3)
  })

  it('empty single layout offers "Open terminal"; errors show; tabs switch and close', async () => {
    const a = info()
    const b = info()
    const bridge = installBridge({ 'terminal:list': () => fail('no pty'), 'terminal:create': () => a, 'terminal:attach': pending, 'terminal:kill': () => undefined })
    render(<TerminalView />)
    await act(settle)
    expect(screen.getByText('no pty')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Open terminal'))
    await act(settle)
    expect(screen.queryByText('Open terminal')).toBeNull()

    // Two shells in single layout: both on the page (framed), one per screen.
    act(() => useTerminals.setState({ tabs: [a, { ...b, exitCode: 1 }], activeId: a.id }))
    expect(screen.getAllByLabelText('Close ~ 2')[0].className).toContain('opacity-0') // tab strip first
    expect(document.querySelectorAll('[data-terminal]')).toHaveLength(2)
    fireEvent.click(screen.getAllByText('~ 2')[0])
    expect(useTerminals.getState().activeId).toBe(b.id)
    fireEvent.click(screen.getAllByLabelText('Close ~')[0])
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('terminal:kill', { id: a.id })
    expect(useTerminals.getState().tabs.map((t) => t.id)).toEqual([b.id])
  })

  it('every layout shows all shells, fills the last row with new-terminal panes and scrolls the active one into sight', async () => {
    const tabs = [info(), info(), info()]
    const bridge = installBridge({
      'terminal:list': () => tabs,
      'terminal:attach': pending,
      'terminal:create': ({ projectId }: { projectId?: string }) => info({ projectId }),
      'projects:list': () => [{ id: 'p1', name: 'Demo', path: '/d', addedAt: '', lastSeenAt: '' }]
    })
    render(<TerminalView />)
    await act(settle)
    const panes = () => document.querySelectorAll('[data-terminal]').length
    const scrolled = vi.mocked(Element.prototype.scrollIntoView)
    expect(panes()).toBe(3) // single: one per screen, the rest below

    fireEvent.click(screen.getByLabelText('Layout: Side by side'))
    const strip = (label: string) => screen.getByText(label, { selector: 'span.font-mono.text-\\[11\\.5px\\]' }).closest('div')!
    expect(strip('~ 3').className).toContain('border-hud/50')
    expect([panes(), screen.getAllByText('New terminal').length]).toEqual([3, 1]) // 2 + 1, second row completed
    scrolled.mockClear()
    fireEvent.click(strip('~ 3').querySelector('button')!)
    expect(scrolled.mock.contexts[0]).toBe(document.querySelector(`[data-terminal="${tabs[2].id}"]`))

    fireEvent.click(screen.getByLabelText('Layout: Stacked'))
    expect(screen.queryByText('New terminal')).toBeNull() // 3 rows, nothing to complete
    fireEvent.click(screen.getByLabelText('Layout: 2 × 2'))
    // empty pane → menu with Home and projects
    fireEvent.click(screen.getAllByText('New terminal')[0])
    await act(settle)
    expect(screen.getByText('Projects')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Demo'))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('terminal:create', { projectId: 'p1' })

    // "+" menu: Home
    fireEvent.click(screen.getByLabelText('New terminal'))
    await act(settle)
    fireEvent.click(screen.getByText('Home'))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('terminal:create', { projectId: undefined })
  })

  it('the menu closes on outside click and Escape, and survives a failing project list', async () => {
    installBridge({ 'terminal:list': () => [info()], 'terminal:attach': pending, 'projects:list': () => fail('x') })
    render(<TerminalView />)
    await act(settle)
    const plus = screen.getByLabelText('New terminal')
    fireEvent.click(plus)
    await act(settle)
    expect(plus).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByText('Projects')).toBeNull()
    fireEvent.mouseDown(screen.getByText('Home')) // inside → stays open
    expect(plus).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(document, { key: 'a' })
    expect(plus).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(plus).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(plus)
    fireEvent.mouseDown(document.body)
    expect(plus).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(plus)
    fireEvent.click(plus) // toggles closed
    expect(plus).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('TerminalView: profiles', () => {
  it('"New terminal with profile": the shells found and the user’s own, the default marked', async () => {
    const bridge = installBridge({
      'terminal:list': () => [info()],
      'terminal:attach': pending,
      'projects:list': () => [],
      'terminal:shells': () => [{ id: 'zsh', name: 'zsh', file: '/bin/zsh', args: ['-l'] }],
      'terminal:settings': () => ({
        ...DEFAULT_TERMINAL_SETTINGS,
        defaultProfile: 'custom-a',
        profiles: [{ id: 'custom-a', name: 'Server', command: 'ssh', args: [], env: {} }]
      }),
      'terminal:create': () => info()
    })
    render(<TerminalView />)
    await act(settle)
    fireEvent.click(screen.getByLabelText('New terminal'))
    await act(settle)
    expect(screen.getByText('New terminal with profile')).toBeInTheDocument()
    expect(screen.getByText('Server').parentElement).toHaveTextContent('Serverdefault')
    fireEvent.click(screen.getByText('zsh'))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('terminal:create', { projectId: undefined, profileId: 'zsh' })
  })
})

describe('XtermPane', () => {
  it('attaches to the scrollback, de-duplicates queued and live output', async () => {
    const tab = info()
    let resolveAttach: (v: unknown) => void = () => {}
    const bridge = installBridge({ 'terminal:attach': () => new Promise((r) => (resolveAttach = r)), 'terminal:write': () => undefined })
    render(<XtermPane tab={tab} label="~" active={false} framed={false} />)
    const term = x.terms[0]
    act(() => bridge.emit('terminal:data', { id: tab.id, data: 'abc', end: 3 })) // queued, covered by buffer
    act(() => bridge.emit('terminal:data', { id: tab.id, data: 'cdef', end: 6 })) // queued, overlaps
    act(() => bridge.emit('terminal:data', { id: 'other', data: 'zzz', end: 3 }))
    await act(async () => resolveAttach({ buffer: 'abcd', end: 4, info: tab }))
    expect(term.written).toEqual(['abcd', 'ef'])
    act(() => bridge.emit('terminal:data', { id: tab.id, data: 'gh', end: 8 }))
    expect(term.written.at(-1)).toBe('gh')

    term.type('ls\r')
    expect(bridge.invoke).toHaveBeenCalledWith('terminal:write', { id: tab.id, data: 'ls\r' })
    term.resize(80, 24)
    expect(bridge.invoke).toHaveBeenCalledWith('terminal:resize', { id: tab.id, cols: 80, rows: 24 })

    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    x.links[0]({}, 'https://example.com')
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
    // OSC 8 hyperlinks take the same way out — web addresses only.
    const osc = term.options.linkHandler as { activate: (e: unknown, uri: string) => void; allowNonHttpProtocols: boolean }
    expect(osc.allowNonHttpProtocols).toBe(false)
    osc.activate({}, 'https://osc.dev/x')
    osc.activate({}, 'file:///etc/passwd')
    expect(open).toHaveBeenLastCalledWith('https://osc.dev/x', '_blank', 'noopener,noreferrer')
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('a gap in the output (events lost while the push channel was down) is fetched from the scrollback', async () => {
    const tab = info()
    // The core's scrollback: everything so far, as a ring buffer of the last 6 characters.
    let output = 'abcd'
    const scrollback = () => ({ buffer: output.slice(-6), end: output.length, info: tab })
    const remote = installRemote({ 'terminal:attach': () => scrollback() })
    render(<XtermPane tab={tab} label="~" active={false} framed={false} />)
    await act(settle)
    const term = x.terms[0]
    expect(term.written).toEqual(['abcd'])
    // "ef" never arrived; "gh" does: the view asks for what it missed instead of writing past the hole.
    output = 'abcdefgh'
    await act(async () => {
      remote.emit('terminal:data', { id: tab.id, data: 'gh', end: 8 })
      await settle()
    })
    expect(term.written).toEqual(['abcd', 'efgh'])
    // Live output during the re-attach is queued and not written twice.
    output = 'abcdefghij'
    await act(async () => {
      remote.emit('terminal:data', { id: tab.id, data: 'j', end: 10 }) // gap again (i is missing)
      remote.emit('terminal:data', { id: tab.id, data: 'ij', end: 10 })
      await settle()
    })
    expect(term.written).toEqual(['abcd', 'efgh', 'ij'])

    // The socket is back: what came meanwhile is fetched — also when no new chunk shows the gap.
    output = 'abcdefghijkl'
    await act(async () => {
      remote.resync()
      await settle()
    })
    expect(term.written.at(-1)).toBe('kl')
    // Nothing new: nothing is written.
    await act(async () => {
      remote.resync()
      await settle()
    })
    expect(term.written).toHaveLength(4)
    // More was lost than the scrollback keeps: what is still there.
    output = 'abcdefghijklmnopqrstu'
    await act(async () => {
      remote.resync()
      await settle()
    })
    expect(term.written.at(-1)).toBe('pqrstu')
    // The session is gone: a gap is then written as it is, without asking again and again.
    remote.routes['terminal:attach'] = () => fail('no session')
    await act(async () => {
      remote.emit('terminal:data', { id: tab.id, data: 'yz', end: 26 })
      await settle()
    })
    expect(term.written.at(-1)).toBe('yz')
    expect(remote.invoke.mock.calls.filter((c) => c[0] === 'terminal:attach')).toHaveLength(7)
  })

  it('back online while still attaching: no second fetch', async () => {
    const tab = info()
    const remote = installRemote({ 'terminal:attach': pending })
    render(<XtermPane tab={tab} label="~" active={false} framed={false} />)
    await act(async () => {
      remote.resync()
      await settle()
    })
    expect(remote.invoke.mock.calls.filter((c) => c[0] === 'terminal:attach')).toHaveLength(1)
  })

  it('a failed attach still flushes live output; exit marks the tab and Enter restarts', async () => {
    const tab = info()
    const fresh = info()
    useTerminals.setState({ tabs: [tab], activeId: tab.id })
    const bridge = installBridge({
      'terminal:attach': () => fail('gone'),
      'terminal:write': () => fail('closed'),
      'terminal:resize': () => fail('closed'),
      'terminal:create': () => fresh
    })
    render(<XtermPane tab={tab} label="~" active framed={false} />)
    const term = x.terms[0]
    act(() => bridge.emit('terminal:data', { id: tab.id, data: 'hi', end: 2 }))
    await act(settle)
    expect(term.written).toEqual(['hi'])
    term.type('x') // write fails quietly
    term.resize(10, 10)
    await act(settle)

    act(() => bridge.emit('terminal:exit', { id: 'other', exitCode: 0 }))
    act(() => bridge.emit('terminal:exit', { id: tab.id, exitCode: 3 }))
    expect(term.written.at(-1)).toContain('exited with code 3')
    expect(useTerminals.getState().tabs[0].exitCode).toBe(3)
    const writes = bridge.invoke.mock.calls.filter(([c]) => c === 'terminal:write').length
    term.type('q') // ignored after exit
    term.resize(20, 20) // no resize after exit
    term.type('\r')
    await act(settle)
    expect(bridge.invoke.mock.calls.filter(([c]) => c === 'terminal:write')).toHaveLength(writes)
    expect(useTerminals.getState().tabs[0].id).toBe(fresh.id)
  })

  it('fits when measurable, on resize and theme changes; focuses when active; cleans up', async () => {
    const restore = sized(800, 400)
    installBridge({ 'terminal:attach': pending })
    const tab = info()
    useTerminals.setState({ tabs: [tab, info()], activeId: 'nope' })
    const { rerender, unmount, container } = render(<XtermPane tab={tab} label="~" active={false} framed={false} />)
    const term = x.terms[0]
    const fit = x.fits[0].fit
    expect(fit).toHaveBeenCalledTimes(1)
    expect(container.firstElementChild).toHaveAttribute('data-terminal', tab.id)

    x.fitThrows = true
    act(() => (globalThis as unknown as { FakeResizeObserver: { instances: { trigger(): void }[] } }).FakeResizeObserver.instances[0].trigger())
    x.fitThrows = false

    document.documentElement.setAttribute('data-theme', 'light')
    await act(settle)
    expect(term.options.theme).toBeDefined()

    // focus on mouse down activates the pane
    fireEvent.mouseDown(container.firstElementChild!)
    expect(useTerminals.getState().activeId).toBe(tab.id)
    expect(term.focus).toHaveBeenCalled()

    rerender(<XtermPane tab={tab} label="~" active framed={false} />)
    await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))))
    expect(fit.mock.calls.length).toBeGreaterThan(1)
    fireEvent.mouseDown(container.firstElementChild!) // already active → just focus

    x.fitThrows = true
    rerender(<XtermPane tab={tab} label="~" active={false} framed={false} />)
    rerender(<XtermPane tab={tab} label="~" active framed={false} />)
    await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))))

    // deactivating before the frame cancels it
    rerender(<XtermPane tab={tab} label="~" active={false} framed={false} />)
    rerender(<XtermPane tab={tab} label="~" active framed={false} />)
    rerender(<XtermPane tab={tab} label="~" active={false} framed={false} />)

    unmount()
    expect(term.disposed).toBe(true)
    restore()
  })

  it('a size that keeps changing (a divider dragged) is taken once it holds still — the first real size at once', () => {
    const observers = (globalThis as unknown as { FakeResizeObserver: { instances: { trigger(): void }[] } }).FakeResizeObserver.instances
    const before = observers.length
    let restore = sized(0, 0) // hidden: nothing to fit
    installBridge({ 'terminal:attach': pending })
    const { unmount } = render(<XtermPane tab={info()} label="~" active={false} framed={false} />)
    const resize = () => act(() => observers.slice(before).forEach((o) => o.trigger()))
    const fit = x.fits[0].fit
    expect(fit).not.toHaveBeenCalled()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    restore()
    restore = sized(800, 400)
    resize() // shown: fitted at once
    expect(fit).toHaveBeenCalledTimes(1)
    resize()
    resize()
    act(() => vi.advanceTimersByTime(FIT_SETTLE_MS - 1))
    expect(fit).toHaveBeenCalledTimes(1) // still moving: the shell is left alone
    x.fitThrows = true
    act(() => vi.advanceTimersByTime(1)) // settled (a renderer not ready yet is no error)
    expect(fit).toHaveBeenCalledTimes(2)
    x.fitThrows = false
    resize()
    unmount() // a pending fit dies with the view
    act(() => vi.advanceTimersByTime(FIT_SETTLE_MS))
    expect(fit).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
    restore()
  })

  it('unmeasurable hosts are not fitted', () => {
    const restore = sized(800, 0)
    installBridge({ 'terminal:attach': pending })
    render(<XtermPane tab={info()} label="~" active={false} framed={false} />)
    expect(x.fits[0].fit).not.toHaveBeenCalled()
    restore()
  })

  it('framed panes show a header with state, folder and close', async () => {
    const tab = info({ title: 'demo', cwdLabel: '~/demo' })
    const bridge = installBridge({ 'terminal:attach': pending, 'terminal:kill': () => undefined })
    useTerminals.setState({ tabs: [tab], activeId: tab.id })
    const { rerender, container } = render(
      <XtermPane tab={tab} label="demo" active framed />
    )
    expect(container.querySelector('.border-cyan\\/50')).not.toBeNull()
    expect(container.querySelector('.bg-green')).not.toBeNull()
    expect(screen.getByText('~/demo')).toBeInTheDocument()
    expect(container.firstElementChild!.className).toContain('p-1')

    rerender(<XtermPane tab={{ ...tab, exitCode: 0, cwdLabel: 'demo' }} label="demo" active={false} framed />)
    expect(container.querySelector('.border-hud\\/50')).not.toBeNull()
    expect(container.querySelector('.bg-text-muted')).not.toBeNull()
    expect(screen.queryByText('~/demo')).toBeNull()

    rerender(<XtermPane tab={tab} label="demo" active framed />)
    fireEvent.mouseDown(screen.getByLabelText('Close demo'))
    fireEvent.click(screen.getByLabelText('Close demo'))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('terminal:kill', { id: tab.id })
  })
})

/** A clipboard the page can use (jsdom has none). */
function clipboard(text = '') {
  const board = { writeText: vi.fn(async () => {}), readText: vi.fn(async () => text) }
  Object.defineProperty(navigator, 'clipboard', { value: board, configurable: true })
  return board
}

describe('useXterm extras', () => {
  it('Unicode 11 widths, WebGL with a DOM fallback, settings applied live', async () => {
    installBridge({ 'terminal:attach': pending })
    useTerminalSettings.setState({ settings: { ...DEFAULT_TERMINAL_SETTINGS, fontSize: 15, cursorStyle: 'block' } })
    const { unmount } = render(<XtermPane tab={info()} label="~" active={false} framed={false} />)
    const term = x.terms[0]
    expect(term.unicode.activeVersion).toBe('11')
    expect(term.options).toMatchObject({ allowProposedApi: true, fontSize: 15, cursorStyle: 'block', scrollback: 5000 })
    expect(x.webgls).toHaveLength(1)

    // the GPU takes the context back: the DOM renderer draws; switching it on again loads a new one
    x.webgls[0].loseContext()
    expect(x.webgls[0].disposed).toBe(true)
    act(() => useTerminalSettings.setState({ settings: { ...DEFAULT_TERMINAL_SETTINGS, fontSize: 18 } }))
    expect(term.options.fontSize).toBe(18)
    expect(x.webgls).toHaveLength(2)
    act(() => useTerminalSettings.setState({ settings: { ...DEFAULT_TERMINAL_SETTINGS, gpu: false } }))
    expect(x.webgls[1].disposed).toBe(true)
    act(() => useTerminalSettings.setState({ settings: { ...DEFAULT_TERMINAL_SETTINGS, gpu: false } })) // off stays off
    act(() => useTerminalSettings.setState({ shells: [] })) // other state: nothing to apply
    unmount()

    // no WebGL2 at all
    x.webglThrows = true
    useTerminalSettings.setState({ settings: DEFAULT_TERMINAL_SETTINGS })
    render(<XtermPane tab={info()} label="~" active={false} framed={false} />)
    expect(x.webgls).toHaveLength(2)
  })

  it('copy on select, the Terminal’s own keys, clipboard actions', async () => {
    const board = clipboard('pasted')
    installBridge({ 'terminal:attach': pending })
    render(<XtermPane tab={info()} label="~" active={false} framed={false} />)
    const term = x.terms[0]
    term.select('abc')
    expect(board.writeText).not.toHaveBeenCalled() // off by default
    act(() => useTerminalSettings.setState({ settings: { ...DEFAULT_TERMINAL_SETTINGS, copyOnSelect: true } }))
    term.select('abc')
    expect(board.writeText).toHaveBeenCalledWith('abc')
    term.select('')
    expect(board.writeText).toHaveBeenCalledTimes(1)

    expect(term.key({ key: 'a', ctrlKey: true }).handled).toBe(false) // the shell's
    const k = term.key({ key: 'K', ctrlKey: true, shiftKey: true })
    expect([k.handled, k.e.preventDefault]).toEqual([true, expect.any(Function)])
    expect(term.clear).toHaveBeenCalled()
    term.key({ key: 'ArrowUp', ctrlKey: true, shiftKey: true })
    expect(term.scrollToTop).toHaveBeenCalled() // no commands yet
    term.key({ key: 'ArrowDown', ctrlKey: true, shiftKey: true })
    expect(term.scrollToBottom).toHaveBeenCalled()
    // copy and paste (Windows/Linux): Ctrl+Shift+C/V and Ctrl+Insert / Shift+Insert — never the shell's Ctrl+C
    term.select('')
    expect(term.key({ key: 'C', ctrlKey: true, shiftKey: true }).handled).toBe(true) // nothing selected: still not ^C
    term.select('xyz')
    term.key({ key: 'C', ctrlKey: true, shiftKey: true })
    expect(board.writeText).toHaveBeenLastCalledWith('xyz')
    board.writeText.mockClear()
    term.key({ key: 'Insert', ctrlKey: true })
    expect(board.writeText).toHaveBeenCalledWith('xyz')
    await act(async () => void term.key({ key: 'V', ctrlKey: true, shiftKey: true }))
    await act(async () => void term.key({ key: 'Insert', shiftKey: true }))
    expect(term.paste.mock.calls).toEqual([['pasted'], ['pasted']])
    board.readText.mockRejectedValueOnce(new Error('not allowed')) // the browser says no: nothing pasted
    await act(async () => void term.key({ key: 'V', ctrlKey: true, shiftKey: true }))
    expect(term.paste).toHaveBeenCalledTimes(2)
    act(() => void term.key({ key: 'f', ctrlKey: true, shiftKey: true }))
    expect(screen.getByRole('search')).toBeInTheDocument()
  })

  it('macOS: ⌘W closes the terminal tab; an agent’s terminal leaves it to the workspace', async () => {
    flags.mac = true
    const kill = vi.fn()
    installBridge({ 'terminal:attach': pending, 'terminal:kill': kill })
    const tab = info()
    useTerminals.setState({ tabs: [tab], activeId: tab.id })
    render(<XtermPane tab={tab} label="~" active={false} framed={false} />)
    const k = x.terms[0].key({ key: 'w', metaKey: true })
    expect(k.handled).toBe(true)
    await act(settle)
    expect(kill).toHaveBeenCalledWith({ id: tab.id })
    expect(useTerminals.getState().tabs).toEqual([])
    const { SessionTerminalProbe } = await import('./terminalProbe')
    render(<SessionTerminalProbe id="a2" />)
    expect(x.terms.at(-1)!.key({ key: 'w', metaKey: true }).handled).toBe(false)
    flags.mac = false
  })

  it('agents’ terminals: find goes to the program, no file links, nothing saved', async () => {
    const bridge = installBridge({ 'terminal:attach': () => ({ buffer: '', end: 0, info: info() }) })
    const { SessionTerminalProbe } = await import('./terminalProbe')
    render(<SessionTerminalProbe id="a1" />)
    await act(settle)
    const term = x.terms[0]
    expect(term.key({ key: 'f', ctrlKey: true, shiftKey: true }).handled).toBe(false)
    expect(term.linkProviders).toHaveLength(0)
    expect(serializers.has('a1')).toBe(false)
    // its output shows (and is not kept); its end is the session's to tell, not the terminal's
    act(() => bridge.emit('terminal:data', { id: 'a1', data: 'working', end: 7 }))
    act(() => bridge.emit('terminal:exit', { id: 'a1', exitCode: 0 }))
    expect(term.written.at(-1)).toBe('working')
  })

  it('restored output shows greyed above; the tab’s output is kept for the next start', async () => {
    const bridge = installBridge({ 'terminal:attach': () => ({ buffer: 'new$ ', end: 5, info: info() }) })
    const tab = { ...info(), restored: { scrollback: 'old 1\nold 2', savedAt: '2026-10-15T08:00:00.000Z' } }
    const { unmount } = render(<XtermPane tab={tab} label="~" active={false} framed={false} />)
    await act(settle)
    const term = x.terms[0]
    expect(term.written[0]).toMatch(/^\x1b\[0;90mold 1\r\nold 2\x1b\[0m\r\n\x1b\[90m── Restored · .+ ──\x1b\[0m\r\n$/)
    expect(term.written[1]).toBe('new$ ')
    x.serialized = '\x1b[32mgreen\x1b[0m\x1b[3Cgap\x1b]0;title\x07\x1b(B  \r\n\r\n'
    expect(serializers.get(tab.id)!()).toBe('green   gap')
    act(() => bridge.emit('terminal:data', { id: tab.id, data: 'more', end: 9 }))
    expect(term.written.at(-1)).toBe('more')
    unmount()
    expect(serializers.has(tab.id)).toBe(false)
  })

  it('plain text drops colors, moves and titles', () => {
    expect(plainText('a\x1b[Cb\x1b[1;2Hc\x1b]2;t\x1b\\d')).toBe('a bcd')
  })

  it('file references open in the editor on their line', async () => {
    resetProjectCache()
    installBridge({
      'terminal:attach': pending,
      'projects:list': () => [{ id: 'p1', name: 'P', path: '/code/p1', addedAt: '', lastSeenAt: '' }],
      'files:stat': () => [{ mtimeMs: 1, size: 1 }],
      'files:list': () => [],
      'files:read': () => ({ path: 'src/a.ts', content: '', mtimeMs: 1, size: 0 })
    })
    const navigate = vi.fn()
    const tab = info({ cwd: '/code/p1', cwdLabel: '/code/p1' })
    render(<XtermPane tab={tab} label="~" active={false} framed={false} onNavigate={navigate} />)
    const term = x.terms[0]
    term.lines = [{ text: 'src/a.ts:7' }]
    const links = await new Promise<{ activate: () => void }[]>((r) => term.linkProviders[0].provideLinks(1, r as never))
    links[0].activate()
    await act(settle)
    expect(navigate).toHaveBeenCalledWith('editor')
    expect(useEditor.getState()).toMatchObject({ projectId: 'p1', reveal: { line: 7 } })

    // without a way to switch modules it still opens there
    render(<XtermPane tab={info({ cwd: '/code/p1' })} label="~" active={false} framed={false} />)
    x.terms[1].lines = [{ text: 'src/a.ts:2' }]
    const more = await new Promise<{ activate: () => void }[]>((r) => x.terms[1].linkProviders[0].provideLinks(1, r as never))
    more[0].activate()
    await act(settle)
    expect(useEditor.getState().reveal).toMatchObject({ line: 2 })
  })
})

describe('XtermPane: find and the context menu', () => {
  it('finds with options, steps through matches, counts them and closes on Escape', async () => {
    installBridge({ 'terminal:attach': pending })
    render(<XtermPane tab={info()} label="~" active={false} framed={false} />)
    const term = x.terms[0]
    act(() => void term.key({ key: 'f', ctrlKey: true, shiftKey: true }))
    const search = x.searches[0]
    const field = screen.getByLabelText('Find')
    expect(field).toHaveFocus()
    fireEvent.change(field, { target: { value: 'err' } })
    expect(search.findNext).toHaveBeenLastCalledWith('err', expect.objectContaining({ caseSensitive: false, regex: false, decorations: expect.any(Object) }))
    act(() => search.results(1, 4))
    expect(screen.getByText('2 of 4')).toBeInTheDocument()
    act(() => search.results(-1, 1000))
    expect(screen.getByText('1000+')).toBeInTheDocument()
    act(() => search.results(-1, 0))
    expect(screen.getByText('No results')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Match case'))
    expect(screen.getByLabelText('Match case')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByLabelText('Regular expression'))
    expect(search.findNext).toHaveBeenLastCalledWith('err', expect.objectContaining({ caseSensitive: true, regex: true }))
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })
    expect(search.findPrevious).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.click(screen.getByLabelText('Next match'))
    fireEvent.click(screen.getByLabelText('Previous match'))
    expect(search.findPrevious).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(field, { key: 'a' }) // typing goes on

    fireEvent.change(field, { target: { value: '' } })
    expect(search.clearDecorations).toHaveBeenCalled()
    expect(screen.getByLabelText('Next match')).toBeDisabled()
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByRole('search')).toBeNull()
    expect(term.focus).toHaveBeenCalled()

    // reopened from the menu; the close button closes too
    fireEvent.contextMenu(document.querySelector('[data-terminal]')!)
    fireEvent.click(screen.getByRole('menuitem', { name: /^Find/ }))
    fireEvent.mouseDown(screen.getByRole('search')) // clicks in the bar stay there
    fireEvent.click(screen.getByLabelText('Close'))
    expect(screen.queryByRole('search')).toBeNull()
  })

  it('copy, paste, select all, clear and split; with integration the commands too', async () => {
    const board = clipboard('from clipboard')
    const fresh = info()
    const bridge = installBridge({ 'terminal:attach': pending, 'terminal:create': () => fresh })
    const tab = info({ integration: true })
    useTerminals.setState({ tabs: [tab], activeId: tab.id, layout: 'single' })
    const { rerender } = render(<XtermPane tab={tab} label="~" active framed={false} />)
    const term = x.terms[0]
    const pane = document.querySelector('[data-terminal]')!
    const menu = () => {
      fireEvent.contextMenu(pane, { clientX: 5, clientY: 5 })
      return (name: RegExp) => screen.getByRole('menuitem', { name })
    }

    expect(menu()(/^Copy \(Ctrl\+Shift\+C\)$/)).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    term.selection = 'sel'
    fireEvent.click(menu()(/^Copy \(Ctrl\+Shift\+C\)$/))
    expect(board.writeText).toHaveBeenCalledWith('sel')
    fireEvent.click(menu()(/^Paste \(Ctrl\+Shift\+V\)$/))
    await act(settle)
    expect(term.paste).toHaveBeenCalledWith('from clipboard')
    fireEvent.click(menu()(/Select all/))
    expect(term.selectAll).toHaveBeenCalled()
    fireEvent.click(menu()(/^Clear/))
    expect(term.clear).toHaveBeenCalled()

    // the last command's output (shell integration)
    expect(menu()(/Copy output/)).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    term.lines = [{ text: '$ echo hi' }, { text: 'hi' }, { text: '$ ' }]
    for (const [y, seq] of [[0, 'A'], [1, 'C'], [2, 'D;0']] as const) {
      term.cursor = { x: 0, y }
      term.osc(133, seq)
    }
    fireEvent.click(menu()(/Copy output/))
    expect(board.writeText).toHaveBeenLastCalledWith('hi')
    term.buffer.active.baseY = 2
    term.buffer.active.viewportY = 2
    fireEvent.click(menu()(/Previous command/))
    expect(term.scrollToLine).toHaveBeenCalledWith(0)
    fireEvent.click(menu()(/Next command/))
    expect(term.scrollToBottom).toHaveBeenCalled()

    fireEvent.click(menu()(/^Split$/))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('terminal:create', { projectId: undefined, cwd: tab.cwd, profileId: undefined })
    expect(useTerminals.getState().layout).toBe('cols')

    // without integration: no command items; an exited shell can't be split; an empty clipboard pastes nothing
    rerender(<XtermPane tab={{ ...tab, integration: undefined, exitCode: 0 }} label="~" active framed={false} />)
    const pick = menu()
    expect(screen.queryByRole('menuitem', { name: /Copy output/ })).toBeNull()
    expect(pick(/^Split$/)).toBeDisabled()
    board.readText.mockResolvedValueOnce('')
    fireEvent.click(pick(/^Paste \(Ctrl\+Shift\+V\)$/))
    await act(settle)
    expect(term.paste).toHaveBeenCalledTimes(1)
    term.selection = ''
    const copy = menu()(/^Copy \(Ctrl\+Shift\+C\)$/)
    expect(copy).toBeDisabled()
  })

  it('the view’s actions do nothing once it is gone; copy needs a selection', async () => {
    clipboard()
    installBridge({ 'terminal:attach': pending })
    const probe = await import('./terminalProbe')
    const { unmount } = render(<probe.ApiProbe id="z" />)
    const api = probe.lastApi!
    x.terms[0].selection = ''
    api.copy()
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    expect(api.find('', {})).toBe(false)
    unmount()
    expect(api.find('x', {})).toBe(false)
    expect(api.lastOutput()).toBeUndefined()
    expect(api.hasSelection()).toBe(false)
    api.onFindResults(() => {}).dispose()
    api.clearFind()
    api.previousCommand()
    api.nextCommand()
    api.copy()
    api.clear()
    api.selectAll()
    api.focus()
    await api.paste()
  })
})
