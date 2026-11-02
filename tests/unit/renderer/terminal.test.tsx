import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, installBridge, settle } from './bridge'
import type { TerminalInfo } from '@shared/types/terminal'

// --- xterm.js fakes (jsdom has no canvas/layout) -------------------------------
type Listener<T> = (v: T) => void
const x = vi.hoisted(() => ({
  terms: [] as FakeTerminal[],
  fits: [] as { fit: ReturnType<typeof vi.fn> }[],
  links: [] as ((e: unknown, uri: string) => void)[],
  fitThrows: false
}))
interface FakeTerminal {
  options: Record<string, unknown>
  written: string[]
  focus: ReturnType<typeof vi.fn>
  disposed: boolean
  type: (d: string) => void
  resize: (cols: number, rows: number) => void
}
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>
    written: string[] = []
    focus = vi.fn()
    disposed = false
    private dataCb: Listener<string> = () => {}
    private resizeCb: Listener<{ cols: number; rows: number }> = () => {}
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts }
      x.terms.push(this as unknown as FakeTerminal)
    }
    loadAddon() {}
    open() {}
    write(d: string) {
      this.written.push(d)
    }
    onData(cb: Listener<string>) {
      this.dataCb = cb
      return { dispose: vi.fn() }
    }
    onResize(cb: Listener<{ cols: number; rows: number }>) {
      this.resizeCb = cb
      return { dispose: vi.fn() }
    }
    type(d: string) {
      this.dataCb(d)
    }
    resize(cols: number, rows: number) {
      this.resizeCb({ cols, rows })
    }
    dispose() {
      this.disposed = true
    }
  }
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn(() => {
      if (x.fitThrows) throw new Error('not ready')
    })
    constructor() {
      x.fits.push(this)
    }
  }
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(cb: (e: unknown, uri: string) => void) {
      x.links.push(cb)
    }
  }
}))

import { TerminalView } from '@/features/terminal/components/TerminalView'
import { XtermPane } from '@/features/terminal/components/XtermPane'
import { useTerminals } from '@/features/terminal/store'

const initial = useTerminals.getState()
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
  x.terms.length = 0
  x.fits.length = 0
  x.links.length = 0
  x.fitThrows = false
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
