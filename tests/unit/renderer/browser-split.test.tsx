import { createRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { installBridge, settle } from './bridge'
import { state, tab } from './browserFixtures'
import { useBrowser } from '@/features/browser/store'
import { useOverlays } from '@/lib/overlay'
import { DropZones, MIN_PANE, SplitDivider, SplitTools, splitRatio } from '@/features/browser/components/SplitView'
import { Viewport } from '@/features/browser/components/Viewport'
import { BrowserView } from '@/features/browser/components/BrowserView'
import { BrowserCard } from '@/features/settings/components/BrowserCard'
import { DEFAULT_BROWSER_SETTINGS, type BrowserSettings, type BrowserSplit } from '@shared/types/browser'

const initial = useBrowser.getState()

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

function bridge(routes: Record<string, (p: never) => unknown> = {}) {
  const calls: [string, unknown][] = []
  const b = installBridge(routes)
  const invoke = b.invoke.getMockImplementation()!
  b.invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    calls.push([channel, payload])
    return invoke(channel, payload)
  })
  return { b, sent: (channel: string) => calls.filter(([c]) => c === channel).map(([, p]) => p) }
}

const split = (extra: Partial<BrowserSplit> = {}): BrowserSplit => ({ id: 's', tabs: ['a', 'b'], ratio: 0.5, ...extra })
const transfer = (types = ['application/x-mindeck-tab']) => ({ types, getData: () => '', setData: () => {} })
/** Every element measures as this box (jsdom lays nothing out). */
const box = (r: { left: number; top: number; width: number; height: number }) =>
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect)

beforeEach(() => {
  useBrowser.setState(initial, true)
  useOverlays.setState({ count: 0 })
})
afterEach(() => vi.restoreAllMocks())

describe('split view parts', () => {
  it('turns a divider position into the first page’s share — each page at least its minimum', () => {
    expect(splitRatio(503, 1006)).toBe(0.5)
    expect(splitRatio(100, 1006)).toBe(MIN_PANE / 1000)
    expect(splitRatio(1000, 1006)).toBe(0.8)
    expect(splitRatio(200, 300)).toBe(0.5) // no room for two minimums: half and half
  })

  it('the divider: dragged (pages frozen, the pointer shielded), double-clicked, keyed', async () => {
    const capture = { set: vi.fn(), release: vi.fn() }
    Object.assign(HTMLElement.prototype, { setPointerCapture: capture.set, releasePointerCapture: capture.release })
    onTestFinished(() => {
      Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture')
      Reflect.deleteProperty(HTMLElement.prototype, 'releasePointerCapture')
    })
    const { sent } = bridge()
    box({ left: 0, top: 0, width: 1006, height: 806 })
    const area = createRef<HTMLDivElement>()
    const onRatio = vi.fn()
    const { rerender } = render(
      <div ref={area}>
        <SplitDivider split={split()} area={area} onRatio={onRatio} />
      </div>
    )
    const divider = screen.getByRole('separator', { name: /resize the split view/ })
    expect(divider).toHaveAttribute('aria-orientation', 'vertical')
    fireEvent.pointerMove(divider, { clientX: 300 }) // not dragging: nothing
    fireEvent.pointerUp(divider, { clientX: 300 })
    fireEvent.pointerDown(divider, { clientX: 503 })
    expect(useOverlays.getState().count).toBe(1)
    expect(screen.getByTestId('split-drag-shield')).toBeInTheDocument()
    fireEvent.pointerMove(divider, { clientX: 403, buttons: 1 })
    expect(onRatio).toHaveBeenLastCalledWith(0.4)
    fireEvent.pointerUp(divider, { clientX: 303 })
    expect(onRatio).toHaveBeenLastCalledWith(null)
    expect(useOverlays.getState().count).toBe(0)
    expect(capture.set).toHaveBeenCalledWith(1)
    expect(capture.release).toHaveBeenCalledWith(1)
    fireEvent.doubleClick(divider)
    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    fireEvent.keyDown(divider, { key: 'ArrowUp' }) // not this divider's direction
    fireEvent.keyDown(divider, { key: 'Enter' })
    await settle()
    expect(sent('browser:splitUpdate')).toEqual([
      { id: 's', ratio: 0.3 },
      { id: 's', ratio: 0.5 },
      { id: 's', ratio: 0.52 },
      { id: 's', ratio: 0.5 }
    ])
    // stacked: the divider runs across, follows the pointer up and down
    rerender(
      <div ref={area}>
        <SplitDivider split={split({ vertical: true, ratio: 0.6 })} area={area} onRatio={onRatio} />
      </div>
    )
    expect(divider).toHaveAttribute('aria-orientation', 'horizontal')
    fireEvent.pointerDown(divider, { clientY: 403 })
    fireEvent.pointerMove(divider, { clientY: 303, buttons: 1 })
    expect(onRatio).toHaveBeenLastCalledWith(0.375)
    fireEvent.pointerCancel(divider, { clientY: 303 })
    fireEvent.keyDown(divider, { key: 'ArrowUp' })
    await settle()
    expect(sent('browser:splitUpdate').slice(-2)).toEqual([
      { id: 's', ratio: 0.375 },
      { id: 's', ratio: 0.58 }
    ])
  })

  it('drop zones: a tab dropped on an edge opens on that side of the tab on screen', async () => {
    const { sent } = bridge()
    render(<DropZones dragged="d" active="a" />)
    expect(useOverlays.getState().count).toBe(1)
    const zone = (side: string) => screen.getByTestId(`split-drop-${side}`)
    fireEvent.dragOver(zone('left'), { dataTransfer: transfer(['Files']) }) // not a tab
    expect(document.querySelector('.border-cyan\\/70')).toBeNull()
    fireEvent.dragOver(zone('left'), { dataTransfer: transfer() })
    expect(document.querySelector('.border-cyan\\/70')).not.toBeNull()
    fireEvent.dragLeave(zone('right'))
    expect(document.querySelector('.border-cyan\\/70')).not.toBeNull()
    fireEvent.dragLeave(zone('left'))
    expect(document.querySelector('.border-cyan\\/70')).toBeNull()
    for (const side of ['left', 'right', 'top', 'bottom']) {
      fireEvent.dragOver(zone(side), { dataTransfer: transfer() })
      fireEvent.drop(zone(side), { dataTransfer: transfer() })
    }
    await settle()
    expect(sent('browser:split')).toEqual([
      { id: 'd', with: 'a' },
      { id: 'a', with: 'd' },
      { id: 'd', with: 'a', vertical: true },
      { id: 'a', with: 'd', vertical: true }
    ])
  })

  it('the toolbar: split with a new tab — in a split, swap, stack and end it', async () => {
    const { sent } = bridge()
    useBrowser.setState({ state: state([tab('a', 'https://a.dev/'), tab('b', '')]) })
    const { rerender } = render(<SplitTools tabId="a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Split with a new tab (⌘⇧D)' }))
    rerender(<SplitTools tabId="" />)
    expect(screen.getByRole('button', { name: 'Split with a new tab (⌘⇧D)' })).toBeDisabled()
    act(() => useBrowser.setState({ state: state([tab('a', 'https://a.dev/'), tab('b', '')], { splits: [split()] }) }))
    rerender(<SplitTools tabId="a" />)
    expect(screen.getByRole('group', { name: 'Split view' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Swap sides' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stack top and bottom' }))
    act(() => useBrowser.setState({ state: state([tab('a', 'https://a.dev/'), tab('b', '')], { splits: [split({ vertical: true })] }) }))
    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close split view' }))
    await settle()
    expect(sent('browser:split')).toEqual([{ id: 'a' }])
    expect(sent('browser:splitUpdate')).toEqual([
      { id: 's', swap: true },
      { id: 's', vertical: true },
      { id: 's', vertical: false }
    ])
    expect(sent('browser:unsplit')).toEqual([{ id: 's' }])
  })
})

describe('Viewport · split view', () => {
  it('shows both tabs in framed panes, reports each pane’s place, and moves the focus to the side clicked', async () => {
    const { sent } = bridge({ 'browser:history': () => [] })
    box({ left: 10, top: 20, width: 400, height: 300 })
    useBrowser.setState({ state: state([tab('a', 'https://a.dev/'), tab('b', '')], { activeId: 'a', splits: [split({ ratio: 0.3 })] }) })
    render(<Viewport active />)
    await settle()
    const panes = screen.getAllByTestId('browser-pane')
    expect(panes).toHaveLength(2)
    expect(panes[0]).toHaveAttribute('aria-current', 'true')
    expect(panes[0].className).toContain('border-cyan/50')
    expect(panes[1].className).toContain('border-hud/30')
    expect(panes[0].style.flexBasis).toBe('calc(0.3 * (100% - 6px))')
    expect(screen.getByText('Search the web or type an address')).toBeInTheDocument() // b: the new-tab page
    const rect = { x: 10, y: 20, width: 400, height: 300 }
    expect(sent('browser:view').at(-1)).toEqual({ bounds: rect, focused: true, panes: [{ id: 'a', bounds: rect }, { id: 'b', bounds: rect }] })
    // a click into the other side: focused at once (what is typed goes there), and told to the core
    fireEvent.pointerDown(panes[1])
    expect(useBrowser.getState().state.activeId).toBe('b')
    fireEvent.pointerDown(panes[1]) // already focused
    await settle()
    expect(sent('browser:activate')).toEqual([{ id: 'b' }])
    // the divider dragged: the panes follow at once
    fireEvent.pointerDown(screen.getByRole('separator'), { clientX: 10 + 203 })
    fireEvent.pointerMove(screen.getByRole('separator'), { clientX: 10 + 203, buttons: 1 })
    expect(panes[0].style.flexBasis).toBe('calc(0.5 * (100% - 6px))')
    fireEvent.pointerUp(screen.getByRole('separator'), { clientX: 10 + 203 })
    // stacked
    act(() => useBrowser.setState({ state: state([tab('a', 'https://a.dev/'), tab('b', '')], { activeId: 'a', splits: [split({ vertical: true })] }) }))
    expect(screen.getByTestId('browser-viewport').className).toContain('flex-col')
    // a split whose tab is gone (a moment before the core says so): just the one there is
    act(() => useBrowser.setState({ state: state([tab('a', 'https://a.dev/')], { activeId: 'a', splits: [split()] }) }))
    expect(screen.getAllByTestId('browser-pane')).toHaveLength(1)
  })

  it('freezes both pages as their own pictures, and offers its edges to a tab being dragged', async () => {
    bridge({ 'browser:freeze': () => ({ a: 'data:a', b: 'data:b' }) })
    useBrowser.setState({ state: state([tab('a', 'https://a.dev/'), tab('b', 'https://b.dev/'), tab('c', 'https://c.dev/')], { activeId: 'a', splits: [split()] }) })
    render(<Viewport active />)
    act(() => useOverlays.setState({ count: 1 }))
    await settle()
    expect([...document.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual(['data:a', 'data:b'])
    act(() => useOverlays.setState({ count: 0 }))
    await settle()
    // dragging the tab on screen itself: no zones; another one: the zones (and the pages frozen)
    act(() => useBrowser.getState().setDragging('a'))
    expect(screen.queryByTestId('split-drop-left')).toBeNull()
    act(() => useBrowser.getState().setDragging('c'))
    expect(screen.getByTestId('split-drop-left')).toBeInTheDocument()
    expect(useOverlays.getState().count).toBe(1)
    act(() => useBrowser.getState().setDragging(undefined))
    expect(screen.queryByTestId('split-drop-left')).toBeNull()
  })
})

describe('BrowserView · vertical tabs and the split tools', () => {
  it('puts the tabs in a sidebar when vertical tabs are on, the toolbar beside them', async () => {
    bridge()
    useBrowser.setState({
      settings: { ...DEFAULT_BROWSER_SETTINGS, verticalTabs: true },
      state: state([tab('a', 'https://a.dev/', { title: 'A' })], { groups: [{ id: 'g', title: 'G', color: 'cyan', collapsed: false }] }),
      groupEditor: { id: 'g' }
    })
    render(<BrowserView active />)
    await settle()
    expect(screen.getByRole('complementary', { name: 'Tabs' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Split with a new tab (⌘⇧D)' })).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Edit group' })).toBeInTheDocument()
    act(() => useBrowser.setState({ settings: DEFAULT_BROWSER_SETTINGS }))
    expect(screen.queryByRole('complementary', { name: 'Tabs' })).toBeNull()
  })

  it('Settings turns vertical tabs on', async () => {
    const settings: BrowserSettings = { ...DEFAULT_BROWSER_SETTINGS }
    const { sent } = bridge({ 'browser:settings': () => settings, 'browser:configure': (p: Partial<BrowserSettings>) => ({ ...settings, ...p }) })
    render(<BrowserCard />)
    await settle()
    fireEvent.click(screen.getByRole('switch', { name: /Vertical tabs/ }))
    await settle()
    expect(sent('browser:configure')).toEqual([{ verticalTabs: true }])
    expect(useBrowser.getState().settings.verticalTabs).toBe(true)
  })
})
