import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge } from './bridge'
import type { ModuleId } from '@/types'
import { en } from '@/lib/i18n/en'
import { useOverlays, coversNativeView } from '@/lib/overlay'
import { onRelayout } from '@/lib/relayout'
import { makeLayout, singleLayout } from '@/features/workspace/layout'
import { useWorkspace } from '@/features/workspace/store'
import { Workspace, boxStyle } from '@/features/workspace/components/Workspace'
import { WorkspaceMenu } from '@/features/workspace/components/WorkspaceMenu'
import { ZenBar } from '@/features/workspace/components/ZenBar'

const w = en.workspace
const initial = useWorkspace.getState()
const s = () => useWorkspace.getState()
const draw = (id: ModuleId, visible: boolean) => (
  <div data-testid={`m-${id}`}>
    {id}:{String(visible)}
  </div>
)
const modules = () => s().layout.panes.map((p) => p.module)
const frame = () => act(async () => void (await new Promise((r) => setTimeout(r, 40))))

// jsdom has no PointerEvent: without one, pointer events carry no coordinates.
class FakePointerEvent extends MouseEvent {
  pointerId: number
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 1
  }
}
beforeAll(() => {
  ;(window as unknown as { PointerEvent: unknown }).PointerEvent = FakePointerEvent
})
afterAll(() => {
  Reflect.deleteProperty(window, 'PointerEvent')
})

beforeEach(() => {
  useWorkspace.setState(initial, true)
  useOverlays.setState({ count: 0 })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Workspace', () => {
  it('draws one pane without a head, brings modules into it and keeps the kept ones mounted', () => {
    const moved = vi.fn()
    const off = onRelayout(moved)
    render(<Workspace render={draw} keep={['terminal']} />)
    expect(screen.getByTestId('m-core')).toHaveTextContent('core:true')
    expect(screen.queryByTestId('pane-head-core')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
    expect(moved).toHaveBeenCalled() // native views measure again after every layout
    act(() => s().show('terminal'))
    expect(screen.queryByTestId('m-core')).toBeNull() // not kept: unmounted
    act(() => s().show('files'))
    expect(screen.getByTestId('m-terminal')).toHaveTextContent('terminal:false')
    expect(screen.getByTestId('m-terminal').parentElement!.className).toBe('hidden')
    act(() => s().show('terminal'))
    expect(screen.getByTestId('m-terminal').parentElement!.className).toContain('absolute')
    off()
  })

  it('gives panes heads: switch the module, maximize, restore, split and close', () => {
    useWorkspace.setState({ layout: makeLayout('columns', ['core', 'editor']) })
    render(<Workspace render={draw} keep={[]} />)
    const core = screen.getByTestId('pane-head-core')
    expect(screen.getByTestId('pane-head-editor')).toBeInTheDocument()
    expect(screen.getAllByRole('separator')).toHaveLength(1)

    fireEvent.pointerDown(screen.getByTestId('pane-head-editor'))
    expect(s().layout.focus).toBe('p2')
    fireEvent.pointerDown(screen.getByTestId('m-core')) // pressing into a module focuses its pane
    expect(s().layout.focus).toBe('p1')
    act(() => s().focus('p2'))
    fireEvent.focus(screen.getByTestId('m-core').parentElement!) // so does the keyboard
    expect(s().layout.focus).toBe('p1')

    // the module menu: another module here, or swap with the pane that has it
    const switcher = within(core).getByRole('button', { name: w.switchModule('Core') })
    fireEvent.click(switcher)
    const menu = screen.getByRole('menu', { name: w.modules })
    expect(useOverlays.getState().count).toBe(1) // over a page, the page steps back
    expect(within(menu).getByRole('menuitemradio', { name: /Core/ })).toHaveAttribute('aria-checked', 'true')
    expect(within(menu).getByRole('menuitemradio', { name: /Editor/ })).toHaveTextContent(w.inOtherPane)
    fireEvent.mouseDown(menu) // inside: stays open
    fireEvent.keyDown(document, { key: 'a' })
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Editor/ }))
    expect(modules()).toEqual(['editor', 'core'])
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: w.switchModule('Editor') }))
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: w.switchModule('Editor') }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: w.switchModule('Editor') }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Memory/ }))
    expect(modules()).toEqual(['memory', 'core'])

    // maximize one, restore
    fireEvent.click(within(screen.getByTestId('pane-head-core')).getByRole('button', { name: w.maximize }))
    expect(s().layout.maximized).toBe('p2')
    expect(screen.queryByTestId('pane-head-memory')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
    expect(screen.queryByRole('button', { name: w.split })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: w.restore }))
    expect(s().layout.maximized).toBeUndefined()

    // split from a pane's head: next to that pane
    fireEvent.click(within(screen.getByTestId('pane-head-memory')).getByRole('button', { name: w.split }))
    expect(modules()).toEqual(['memory', 'terminal', 'core'])
    fireEvent.click(within(screen.getByTestId('pane-head-terminal')).getByRole('button', { name: w.split }))
    expect(screen.queryByRole('button', { name: w.split })).toBeNull() // four: no more
    fireEvent.click(within(screen.getByTestId('pane-head-core')).getByRole('button', { name: w.closePane }))
    expect(modules()).toEqual(['memory', 'terminal', 'browser'])

    // zen mode: even a single pane shows its head, with the way out
    act(() => s().setPreset('single'))
    expect(screen.queryByTestId('pane-head-terminal')).toBeNull()
    act(() => s().setZen(true))
    expect(screen.queryByRole('button', { name: w.closePane })).toBeNull()
    expect(screen.queryByRole('button', { name: w.maximize })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: w.exitZen }))
    expect(s().zen).toBe(false)
  })

  it('places panes with gaps, and tells each module how wide its pane is', () => {
    expect(boxStyle({ x0: 0, y0: 0, x1: 1, y1: 1 })).toEqual({ left: 'calc(0% + 0px)', top: 'calc(0% + 0px)', width: 'calc(100% - 0px)', height: 'calc(100% - 0px)' })
    expect(boxStyle({ x0: 0.5, y0: 0.5, x1: 1, y1: 1 }, 30)).toEqual({ left: 'calc(50% + 4px)', top: 'calc(50% + 34px)', width: 'calc(50% - 4px)', height: 'calc(50% - 34px)' })
    expect(boxStyle({ x0: 0, y0: 0, x1: 0.5, y1: 0.5 })).toMatchObject({ width: 'calc(50% - 4px)', height: 'calc(50% - 4px)' })

    useWorkspace.setState({ layout: makeLayout('columns', ['agents', 'editor']) })
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(2000)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800)
    render(<Workspace render={draw} keep={[]} />)
    expect(screen.getByTestId('m-agents').parentElement).toHaveAttribute('data-pane', 'sm md lg')
    width.mockReturnValue(1000)
    act(() => (globalThis as unknown as { FakeResizeObserver: { instances: { trigger(): void }[] } }).FakeResizeObserver.instances[0].trigger())
    expect(screen.getByTestId('m-agents').parentElement).toHaveAttribute('data-pane', '')
    act(() => s().toggleMaximize('p1'))
    expect(screen.getByTestId('m-agents').parentElement).toHaveAttribute('data-pane', 'sm md lg')
    expect(screen.queryByTestId('m-editor')).toBeNull() // hidden, and not one to keep
  })

  it('takes its keys first — on a Mac — but leaves the editor its ⌘\\ and Monaco its ⇧⌘↵', async () => {
    const bridge = installBridge({}, 'darwin') as ReturnType<typeof installBridge> & { toggleFullScreen: () => void }
    bridge.toggleFullScreen = vi.fn()
    render(
      <>
        <Workspace render={draw} keep={[]} />
        <div className="monaco-editor">
          <textarea data-testid="monaco" />
        </div>
      </>
    )
    const key = (init: KeyboardEventInit, target: EventTarget = document.body) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      target.dispatchEvent(e)
      return e
    }
    expect(key({ key: '\\', metaKey: true }).defaultPrevented).toBe(true)
    expect(modules()).toEqual(['core', 'terminal'])
    key({ key: 'ArrowLeft', metaKey: true, altKey: true })
    expect(s().layout.focus).toBe('p1')
    await frame()
    expect(document.activeElement).toBe(screen.getByTestId('m-core').parentElement)
    key({ key: 'Enter', metaKey: true, shiftKey: true })
    expect(s().layout.maximized).toBe('p1')
    key({ key: 'Enter', metaKey: true, shiftKey: true }, screen.getByTestId('monaco')) // a line above, in the code editor
    expect(s().layout.maximized).toBe('p1')
    key({ key: 'Enter', metaKey: true, shiftKey: true }, window)
    expect(s().layout.maximized).toBeUndefined()
    key({ key: 'Ω', code: 'KeyZ', metaKey: true, altKey: true })
    expect(s().zen).toBe(true)
    key({ key: 'f', code: 'KeyF', metaKey: true, ctrlKey: true }) // the main process has it before the UI
    expect(bridge.toggleFullScreen).not.toHaveBeenCalled()
    key({ key: '™', code: 'Digit2', metaKey: true, altKey: true })
    expect(s().current).toBe('w2')
    expect(s().layout.preset).toBe('columns')
    key({ key: 'W', code: 'KeyW', metaKey: true, shiftKey: true })
    expect(s().layout.panes).toHaveLength(1)
    act(() => s().show('editor'))
    const typed = key({ key: '\\', metaKey: true }) // the editor splits itself
    expect(typed.defaultPrevented).toBe(false)
    expect(s().layout.panes).toHaveLength(1)
    expect(key({ key: 'a', metaKey: true }).defaultPrevented).toBe(false)
    key({ key: 'Ω', code: 'KeyZ', metaKey: true, altKey: true, isComposing: true }) // typing in an input method
    expect(s().zen).toBe(true)
  })

  it('⌘W / Ctrl+W closes the pane — unless the module in it closed something of its own', async () => {
    installBridge({}, 'linux')
    useWorkspace.setState({ layout: makeLayout('columns', ['core', 'terminal']) })
    render(
      <>
        <Workspace render={draw} keep={[]} />
        <input data-testid="own" onKeyDown={(e) => e.preventDefault()} />
      </>
    )
    const close = async (init: KeyboardEventInit, target: Element = document.body) => {
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
      await act(() => new Promise((r) => setTimeout(r)))
    }
    expect(s().layout.panes).toHaveLength(2)
    await close({ key: 'w', ctrlKey: true }, screen.getByTestId('own')) // the module's own tab
    expect(s().layout.panes).toHaveLength(2)
    await close({ key: 'w', ctrlKey: true, altKey: true })
    await close({ key: 'w', metaKey: true })
    await close({ key: 'w', ctrlKey: true, isComposing: true })
    expect(s().layout.panes).toHaveLength(2)
    await close({ key: 'W', ctrlKey: true })
    expect(s().layout.panes).toHaveLength(1)
  })

  it('elsewhere leaves Ctrl+\\ to a terminal (SIGQUIT)', () => {
    installBridge({}, 'linux')
    render(
      <>
        <Workspace render={draw} keep={[]} />
        <div className="xterm">
          <textarea data-testid="xterm" />
        </div>
      </>
    )
    const split = (target: Element) => target.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', ctrlKey: true, bubbles: true, cancelable: true }))
    split(screen.getByTestId('xterm'))
    expect(s().layout.panes).toHaveLength(1)
    split(document.body)
    expect(s().layout.panes).toHaveLength(2)
  })
})

describe('dividers', () => {
  const stage = () => vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)

  it('resize by dragging (not below the minimum), double-click and arrow keys', () => {
    const capture = vi.fn()
    const release = vi.fn()
    Object.assign(Element.prototype, { setPointerCapture: capture, releasePointerCapture: release })
    stage()
    useWorkspace.setState({ layout: makeLayout('columns', ['agents', 'browser']) })
    render(<Workspace render={draw} keep={[]} />)
    const divider = screen.getByRole('separator', { name: w.dividerColumns })
    expect(divider).toHaveAttribute('aria-valuenow', '50')
    fireEvent.pointerMove(divider, { clientX: 300 }) // not dragging: nothing
    expect(s().layout.sizes.x).toBe(0.5)
    fireEvent.pointerDown(divider, { clientX: 500, pointerId: 4 })
    expect(capture).toHaveBeenCalledWith(4)
    expect(screen.getByTestId('drag-shield').className).toContain('cursor-col-resize')
    expect(useOverlays.getState().count).toBe(1) // the page steps back while the divider crosses it
    fireEvent.pointerMove(divider, { clientX: 300, buttons: 1 })
    expect(s().layout.sizes.x).toBe(0.3)
    fireEvent.pointerMove(divider, { clientX: 20, buttons: 1 })
    expect(s().layout.sizes.x).toBe(0.24) // 240 px at least
    fireEvent.pointerUp(divider, { pointerId: 4 })
    expect(release).toHaveBeenCalledWith(4)
    expect(screen.queryByTestId('drag-shield')).toBeNull()
    expect(useOverlays.getState().count).toBe(0)
    fireEvent.pointerUp(divider) // already up
    expect(release).toHaveBeenCalledTimes(1)

    fireEvent.doubleClick(divider)
    expect(s().layout.sizes.x).toBe(0.5)
    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    expect(s().layout.sizes.x).toBeCloseTo(0.52)
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    expect(s().layout.sizes.x).toBeCloseTo(0.48)
    fireEvent.keyDown(divider, { key: 'ArrowDown' }) // the other axis
    expect(s().layout.sizes.x).toBeCloseTo(0.48)
    fireEvent.keyDown(divider, { key: 'Enter' })
    expect(s().layout.sizes.x).toBe(0.5)
    Reflect.deleteProperty(Element.prototype, 'setPointerCapture')
    Reflect.deleteProperty(Element.prototype, 'releasePointerCapture')
  })

  it('rows move up and down; a workspace of unknown size keeps the divider where it is', () => {
    stage()
    useWorkspace.setState({ layout: makeLayout('main', ['editor', 'terminal', 'browser']) })
    const { unmount } = render(<Workspace render={draw} keep={[]} />)
    const rows = screen.getByRole('separator', { name: w.dividerRows })
    fireEvent.pointerDown(rows, { clientY: 300 })
    expect(screen.getByTestId('drag-shield').className).toContain('cursor-row-resize')
    fireEvent.pointerMove(rows, { clientY: 450, buttons: 1 })
    expect(s().layout.sizes.y).toBe(0.75)
    fireEvent.pointerCancel(rows)
    expect(screen.queryByTestId('drag-shield')).toBeNull()
    fireEvent.keyDown(rows, { key: 'ArrowUp' })
    expect(s().layout.sizes.y).toBeCloseTo(0.73)
    fireEvent.keyDown(rows, { key: 'ArrowDown' })
    fireEvent.keyDown(rows, { key: 'ArrowRight' })
    expect(s().layout.sizes.y).toBeCloseTo(0.75)
    unmount()

    vi.restoreAllMocks()
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
    render(<Workspace render={draw} keep={[]} />)
    const columns = screen.getByRole('separator', { name: w.dividerColumns })
    fireEvent.pointerDown(columns, { clientX: 10 })
    fireEvent.pointerMove(columns, { clientX: 999, buttons: 1 })
    expect(s().layout.sizes.x).toBe(0.6)
  })
})

describe('dialogs over the browser', () => {
  const place = (map: Record<string, Partial<DOMRect>>) =>
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const r = map[(this as HTMLElement).dataset?.place ?? ''] ?? {}
      const left = r.left ?? 0
      const top = r.top ?? 0
      const width = r.width ?? 0
      const height = r.height ?? 0
      return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect
    })

  it('finds menus and dialogs lying over a native view', () => {
    place({ view: { left: 500, top: 0, width: 500, height: 500 }, over: { left: 400, top: 100, width: 200, height: 100 }, beside: { left: 0, top: 0, width: 300, height: 300 } })
    document.body.innerHTML = '<div data-native-view data-place="view"><div role="listbox" data-place="over"></div></div><div role="menu" data-place="beside"></div><div role="dialog"></div>'
    expect(coversNativeView()).toBe(false) // inside the view, beside it, or not drawn
    document.body.insertAdjacentHTML('beforeend', '<div role="alertdialog" data-place="over"></div>')
    expect(coversNativeView()).toBe(true)
    document.body.innerHTML = '<div role="dialog" data-place="over"></div>'
    expect(coversNativeView()).toBe(false) // no native view at all
    document.body.innerHTML = ''
  })

  it('freezes the page while a dialog of another pane covers it', async () => {
    installBridge()
    place({ view: { left: 500, top: 0, width: 500, height: 500 }, over: { left: 0, top: 0, width: 1000, height: 1000 } })
    useWorkspace.setState({ layout: makeLayout('columns', ['agents', 'browser']) })
    const drawWithView = (id: ModuleId, visible: boolean) => (id === 'browser' ? <div data-native-view data-place="view" /> : draw(id, visible))
    const { unmount } = render(<Workspace render={drawWithView} keep={[]} />)
    await frame()
    expect(useOverlays.getState().count).toBe(0)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.dataset.place = 'over'
    act(() => void document.body.appendChild(dialog))
    await frame()
    expect(useOverlays.getState().count).toBe(1)
    act(() => dialog.remove())
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize')) // one look per frame
    await frame()
    expect(useOverlays.getState().count).toBe(0)
    act(() => void document.body.appendChild(dialog))
    await frame()
    act(() => s().place('p2', 'files')) // the browser leaves the screen: nothing to watch
    await frame()
    expect(useOverlays.getState().count).toBe(0)
    unmount()
    dialog.remove()
  })
})

describe('WorkspaceMenu', () => {
  it('switches the layout, saves and manages workspaces, zen mode and full screen', () => {
    const bridge = installBridge({}, 'darwin') as ReturnType<typeof installBridge> & { toggleFullScreen: () => void }
    bridge.toggleFullScreen = vi.fn()
    render(<WorkspaceMenu />)
    const button = screen.getByRole('button', { name: w.menu })
    fireEvent.click(button)
    const menu = screen.getByRole('dialog', { name: w.menu })
    expect(useOverlays.getState().count).toBe(1)
    expect(within(menu).getByRole('button', { name: w.presets.single })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(menu).getByRole('button', { name: w.presets.grid }))
    expect(s().layout.preset).toBe('grid')
    expect(within(menu).getByText('⌥⌘1')).toBeInTheDocument()

    // switch: the menu closes, the name shows on the button
    fireEvent.click(within(menu).getByRole('button', { name: w.open('Review') }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(s().layout.preset).toBe('columns')
    expect(button).toHaveTextContent('Review')

    fireEvent.click(button)
    fireEvent.mouseDown(screen.getByRole('dialog')) // inside: stays
    act(() => void window.dispatchEvent(new Event('resize'))) // the window changed size: still open, under its button
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: w.presets.rows }))
    fireEvent.click(screen.getByRole('button', { name: w.update('Coding') }))
    expect(s().saved[0].layout.preset).toBe('rows')
    expect(button).toHaveTextContent('Coding')

    // rename: Enter keeps it, Escape drops it
    fireEvent.click(screen.getByRole('button', { name: w.rename('Coding') }))
    const field = screen.getByRole('textbox', { name: w.rename('Coding') })
    fireEvent.change(field, { target: { value: 'Build' } })
    fireEvent.keyDown(field, { key: 'a' })
    fireEvent.submit(field)
    expect(s().saved[0].name).toBe('Build')
    fireEvent.click(screen.getByRole('button', { name: w.rename('Build') }))
    fireEvent.change(screen.getByRole('textbox', { name: w.rename('Build') }), { target: { value: 'Nope' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: w.rename('Build') }), { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeInTheDocument() // Escape left the field, not the menu
    expect(s().saved[0].name).toBe('Build')
    fireEvent.click(screen.getByRole('button', { name: w.rename('Build') }))
    expect(screen.getByRole('textbox', { name: w.rename('Build') })).toHaveValue('Build')
    fireEvent.click(screen.getByRole('button', { name: w.save }))

    // save the layout on screen under a new name
    const name = screen.getByRole('textbox', { name: w.name })
    expect(screen.getByRole('button', { name: w.saveAs })).toBeDisabled()
    fireEvent.change(name, { target: { value: 'Docs' } })
    fireEvent.click(screen.getByRole('button', { name: w.saveAs }))
    expect(s().saved.map((x) => x.name)).toEqual(['Build', 'Review', 'Docs'])
    expect(name).toHaveValue('')

    for (const n of ['Build', 'Review', 'Docs']) fireEvent.click(screen.getByRole('button', { name: w.remove(n) }))
    expect(screen.getByText(w.noneSaved)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: new RegExp(w.zen) }))
    expect(s().zen).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(button)
    expect(screen.getByRole('button', { name: new RegExp(w.zen) })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(w.fullScreen) }))
    expect(bridge.toggleFullScreen).toHaveBeenCalled()

    fireEvent.click(button)
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(button)
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(button)
    fireEvent.click(button)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useOverlays.getState().count).toBe(0)
  })
})

describe('ZenBar', () => {
  it('keeps a strip to drag the window by, the controls, and the way out — none in full screen', async () => {
    const bridge = installBridge({}, 'linux')
    useWorkspace.setState({ zen: true, layout: singleLayout('core') })
    const { unmount } = render(<ZenBar />)
    expect(screen.getByRole('button', { name: en.topbar.minimize })).toBeInTheDocument() // frameless: the window controls
    fireEvent.click(screen.getByRole('button', { name: new RegExp(w.exitZen) }))
    expect(s().zen).toBe(false)
    act(() => bridge.setFullScreen(true))
    expect(screen.queryByRole('button', { name: new RegExp(w.exitZen) })).toBeNull()
    unmount()
    Reflect.deleteProperty(window, 'mindeck')
    const web = render(<ZenBar />) // in a browser: no window controls
    expect(screen.queryByRole('button', { name: en.topbar.minimize })).toBeNull()
    expect(screen.getByRole('button', { name: new RegExp(w.exitZen) })).toBeInTheDocument()
    web.unmount()

    // macOS: room for the traffic lights instead of drawn controls
    installBridge({}, 'darwin')
    vi.resetModules()
    const mac = await import('@/features/workspace/components/ZenBar')
    const { container } = render(<mac.ZenBar />)
    expect(container.firstElementChild!.className).toContain('pl-[88px]')
    expect(screen.queryByRole('button', { name: en.topbar.minimize })).toBeNull()
  })
})
