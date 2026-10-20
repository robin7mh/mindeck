import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { installBridge, settle } from './bridge'
import { state, tab } from './browserFixtures'
import { splitOf, useBrowser } from '@/features/browser/store'
import { dropAtEnd, dropOnGroup, dropOnTab, fits, tabItems } from '@/features/browser/tabs'
import { TabStrip } from '@/features/browser/components/TabStrip'
import { VerticalTabs } from '@/features/browser/components/VerticalTabs'
import { GroupEditor } from '@/features/browser/components/GroupEditor'
import { applyDrop, useDragEnd } from '@/features/browser/components/TabParts'
import { useOverlays } from '@/lib/overlay'
import { DEFAULT_BROWSER_SETTINGS, type BrowserSettings, type BrowserState, type BrowserTabGroup } from '@shared/types/browser'

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

/** The desktop bridge, answering browser channels and recording every call. */
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

const group = (id: string, extra: Partial<BrowserTabGroup> = {}): BrowserTabGroup => ({ id, title: '', color: 'cyan', collapsed: false, ...extra })

/** p pinned · a, b in "Work" · c alone · x private in a private group. */
const sample = (extra: Partial<BrowserState> = {}) =>
  state(
    [
      tab('p', 'https://pinned.dev/', { pinned: true, title: 'Pinned' }),
      tab('a', 'https://a.dev/', { title: 'A', groupId: 'g' }),
      tab('b', 'https://b.dev/', { title: 'B', groupId: 'g' }),
      tab('c', 'https://c.dev/', { title: 'C' }),
      tab('x', '', { profile: 'private', groupId: 'h' })
    ],
    { activeId: 'a', groups: [group('g', { title: 'Work', color: 'green' }), group('h', { private: true, color: 'purple' })], ...extra }
  )

/** A drag's dataTransfer: what it carries, and that it is a tab. */
function transfer() {
  const store: Record<string, string> = {}
  return { setData: (k: string, v: string) => (store[k] = v), getData: (k: string) => store[k] ?? '', types: ['application/x-mindeck-tab'], effectAllowed: '' }
}

beforeEach(() => {
  useBrowser.setState(initial, true)
  useOverlays.setState({ count: 0 })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('tab lists and drops', () => {
  it('lists tabs with each group’s tabs under it, pinned ones left out', () => {
    const s = sample()
    expect(tabItems(s).map((i) => (i.kind === 'tab' ? i.tab.id : `${i.group.id}:${i.tabs.map((t) => t.id).join(',')}`))).toEqual(['g:a,b', 'c', 'h:x'])
    // a tab whose group is unknown counts as on its own
    expect(tabItems(state([tab('a', '', { groupId: 'gone' })])).map((i) => i.kind)).toEqual(['tab'])
  })

  it('plans drops: onto a tab (its place, its group if it may join, pinned or not), onto a group, after all tabs', () => {
    const s = sample()
    const [p, a, , c, x] = s.tabs
    expect(fits(c, s.groups[0])).toBe(true)
    expect(fits(c, s.groups[1])).toBe(false)
    expect(fits(c, undefined)).toBe(false)
    expect(dropOnTab(s, 'c', a)).toEqual({ index: 1, groupId: 'g' })
    expect(dropOnTab(s, 'x', a)).toEqual({ index: 1, groupId: null }) // private: not into an ordinary group
    expect(dropOnTab(s, 'c', p)).toEqual({ index: 0, groupId: null, pin: true })
    expect(dropOnTab(s, 'p', c)).toEqual({ index: 3, groupId: null, pin: false })
    expect(dropOnTab(s, 'c', c)).toBeNull()
    expect(dropOnTab(s, 'nope', c)).toBeNull()
    expect(dropOnGroup(s, 'c', s.groups[0])).toEqual({ index: 1, groupId: 'g' }) // after the group: its first place
    expect(dropOnGroup(s, 'p', s.groups[0])).toEqual({ index: 0, groupId: 'g' }) // before it: one less
    expect(dropOnGroup(s, 'c', s.groups[1])).toBeNull()
    expect(dropOnGroup(s, 'nope', s.groups[0])).toBeNull()
    expect(dropOnGroup(s, 'x', s.groups[1])).toEqual({ index: 4, groupId: 'h' })
    expect(dropAtEnd(s, 'c')).toEqual({ index: 5, groupId: null })
    expect(dropAtEnd(s, 'p')).toEqual({ index: 5, groupId: null, pin: false })
    expect(dropAtEnd(s, 'nope')).toBeNull()
    void x
  })

  it('carries a drop out: pinned or unpinned first, then moved', async () => {
    const { sent } = bridge()
    await applyDrop('c', { index: 0, groupId: null, pin: true })
    await applyDrop('a', { index: 2, groupId: 'g' })
    expect(sent('browser:update')).toEqual([{ id: 'c', pinned: true }])
    expect(sent('browser:move')).toEqual([
      { id: 'c', index: 0, groupId: null },
      { id: 'a', index: 2, groupId: 'g' }
    ])
  })

  it('the store: split views, the group editor, vertical tabs from a key or menu, the tab being dragged', async () => {
    const settings: BrowserSettings = { ...DEFAULT_BROWSER_SETTINGS }
    const { b, sent } = bridge({ 'browser:configure': (p: Partial<BrowserSettings>) => Object.assign(settings, p) })
    const s = sample({ splits: [{ id: 's', tabs: ['a', 'c'], ratio: 0.5 }] })
    expect(splitOf(s, 'c')?.id).toBe('s')
    expect(splitOf(s, 'b')).toBeUndefined()
    const off = useBrowser.getState().connect({ reveal: vi.fn(), sendToAgent: vi.fn(), settings: vi.fn() })
    act(() => b.emit('browser:command', { command: 'verticalTabs' }))
    await settle()
    expect(sent('browser:configure')).toEqual([{ verticalTabs: true }])
    expect(useBrowser.getState().settings.verticalTabs).toBe(true)
    act(() => b.emit('browser:command', { command: 'editGroup', id: 'g' }))
    expect(useBrowser.getState().groupEditor).toEqual({ id: 'g' })
    act(() => b.emit('browser:command', { command: 'editGroup' }))
    expect(useBrowser.getState().groupEditor).toBeUndefined()
    useBrowser.getState().editGroup('g', { x: 1, y: 2 })
    expect(useBrowser.getState().groupEditor).toEqual({ id: 'g', at: { x: 1, y: 2 } })
    useBrowser.getState().editGroup()
    expect(useBrowser.getState().groupEditor).toBeUndefined()
    useBrowser.getState().setDragging('a')
    expect(useBrowser.getState().dragging).toBe('a')
    off()
  })

  it('a drag that ends anywhere ends — after the drop’s own handlers', () => {
    vi.useFakeTimers()
    function Probe() {
      useDragEnd()
      return null
    }
    const { unmount } = render(<Probe />)
    act(() => useBrowser.getState().setDragging('a'))
    act(() => void window.dispatchEvent(new Event('drop')))
    expect(useBrowser.getState().dragging).toBe('a')
    act(() => void vi.runAllTimers())
    expect(useBrowser.getState().dragging).toBeUndefined()
    act(() => useBrowser.getState().setDragging('b'))
    act(() => void window.dispatchEvent(new Event('dragend')))
    act(() => void vi.runAllTimers())
    expect(useBrowser.getState().dragging).toBeUndefined()
    unmount()
  })
})

describe('TabStrip · groups and split view', () => {
  it('shows groups as chips with their tabs underlined; a chip folds, edits and takes dropped tabs', async () => {
    const { sent } = bridge()
    useBrowser.setState({ state: sample({ splits: [{ id: 's', tabs: ['a', 'c'], ratio: 0.5 }] }) })
    render(<TabStrip />)
    const chip = screen.getByRole('button', { name: 'Fold Work' })
    expect(chip).toHaveAttribute('title', 'Work — 2 tabs · Click to fold or unfold · right-click to edit')
    expect(screen.getByRole('group', { name: 'Work' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fold Unnamed group' })).toBeInTheDocument()
    const tabs = screen.getAllByRole('tab')
    expect(tabs[1].className).toContain('accent-green') // underlined in the group's color
    // in a split: both marked, the one beside the active one lit too
    expect(screen.getAllByLabelText('In split view')).toHaveLength(2)
    expect(tabs[3].className).toContain('bg-surface/50')
    fireEvent.click(chip)
    await settle()
    expect(sent('browser:groupUpdate')).toEqual([{ id: 'g', collapsed: true }])
    fireEvent.contextMenu(chip)
    expect(useBrowser.getState().groupEditor).toEqual({ id: 'g', at: { x: 0, y: 0 } })
    useBrowser.getState().editGroup()
    fireEvent.doubleClick(chip)
    expect(useBrowser.getState().groupEditor?.id).toBe('g')

    // c dragged onto the chip: it joins; the private tab may not (no mark, no drop)
    const dt = transfer()
    fireEvent.dragStart(tabs[3], { dataTransfer: dt })
    expect(useBrowser.getState().dragging).toBe('c')
    fireEvent.dragOver(chip, { dataTransfer: dt })
    expect(chip.className).toContain('border-green/60')
    fireEvent.dragLeave(chip, { dataTransfer: dt })
    fireEvent.drop(chip, { dataTransfer: dt })
    await settle()
    expect(sent('browser:move')).toEqual([{ id: 'c', index: 1, groupId: 'g' }])
    fireEvent.dragEnd(tabs[3], { dataTransfer: dt })
    expect(useBrowser.getState().dragging).toBeUndefined()
    const priv = transfer()
    fireEvent.dragStart(tabs[4], { dataTransfer: priv })
    fireEvent.dragOver(chip, { dataTransfer: priv })
    expect(chip.className).not.toContain('border-green/60')
    fireEvent.drop(chip, { dataTransfer: priv })
    // a drop without a tab id does nothing
    fireEvent.drop(chip, { dataTransfer: { getData: () => '', types: ['application/x-mindeck-tab'] } })
    await settle()
    expect(sent('browser:move')).toHaveLength(1)

    // dropped on the strip after the tabs: last, out of any group (a pinned one unpinned)
    const pin = transfer()
    fireEvent.dragStart(tabs[0], { dataTransfer: pin })
    const strip = screen.getByRole('tablist').parentElement!
    fireEvent.dragOver(strip, { dataTransfer: pin })
    fireEvent.drop(strip, { dataTransfer: pin })
    await settle()
    expect(sent('browser:update')).toEqual([{ id: 'p', pinned: false }])
    expect(sent('browser:move').at(-1)).toEqual({ id: 'p', index: 5, groupId: null })
  })

  it('a folded group shows its chip with the number of its tabs, and none of them', () => {
    bridge()
    useBrowser.setState({ state: sample({ groups: [group('g', { title: 'Work', collapsed: true }), group('h', { private: true })], activeId: 'c' }) })
    render(<TabStrip />)
    const chip = screen.getByRole('button', { name: 'Unfold Work' })
    expect(chip).toHaveTextContent('Work2')
    expect(screen.queryByRole('tab', { name: /^A/ })).toBeNull()
    expect(screen.getAllByRole('tab')).toHaveLength(3)
  })
})

describe('VerticalTabs', () => {
  const settings = (patch: Partial<BrowserSettings> = {}) => useBrowser.setState({ settings: { ...DEFAULT_BROWSER_SETTINGS, verticalTabs: true, ...patch } })

  it('lists pinned tabs as icons on top, then tabs and groups with their titles — clicks, closes, menus', async () => {
    const { sent } = bridge()
    settings()
    useBrowser.setState({
      state: sample({ splits: [{ id: 's', tabs: ['a', 'c'], ratio: 0.5 }], activeId: 'a' }),
      setTabSearch: vi.fn()
    })
    const newTab = vi.fn(async () => {})
    useBrowser.setState({ newTab })
    render(<VerticalTabs />)
    const aside = screen.getByRole('complementary', { name: 'Tabs' })
    expect(aside).toHaveStyle({ width: '240px' })
    expect(screen.getByRole('group', { name: 'Pinned tabs' })).toBeInTheDocument()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false', 'false', 'false'])
    expect(tabs[0]).toHaveAttribute('title', 'Pinned')
    expect(tabs[3].className).toContain('bg-elevated/50') // beside the active tab in a split
    expect(screen.getAllByLabelText('In split view')).toHaveLength(2)
    expect(screen.getByLabelText('Private tab')).toBeInTheDocument()
    fireEvent.click(tabs[1]) // already on screen
    fireEvent.click(tabs[2])
    fireEvent(tabs[3], new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    fireEvent(tabs[3], new MouseEvent('auxclick', { bubbles: true, button: 0 }))
    fireEvent.contextMenu(tabs[2])
    fireEvent.click(screen.getByRole('button', { name: 'Close B' }))
    await settle()
    expect(sent('browser:activate')).toEqual([{ id: 'b' }])
    expect(sent('browser:close')).toEqual([{ id: 'c' }, { id: 'b' }])
    expect(sent('browser:tool')).toEqual([{ id: 'b', tool: 'tabMenu' }])

    // groups: fold, edit
    const head = screen.getByRole('button', { name: 'Fold Work' })
    expect(head).toHaveTextContent('Work2')
    fireEvent.click(head)
    fireEvent.contextMenu(head)
    expect(useBrowser.getState().groupEditor?.id).toBe('g')
    fireEvent.doubleClick(head)
    await settle()
    expect(sent('browser:groupUpdate')).toEqual([{ id: 'g', collapsed: true }])

    // search, new tabs (the button, a double-click on the empty rest)
    fireEvent.click(screen.getByRole('button', { name: 'Search tabs (⌘⇧A)' }))
    expect(useBrowser.getState().setTabSearch).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    fireEvent.doubleClick(screen.getByRole('button', { name: 'New tab' }).nextElementSibling!)
    expect(newTab).toHaveBeenCalledTimes(2)
  })

  it('takes dragged tabs: onto a tab, a group, the end — showing where they land', async () => {
    const { sent } = bridge()
    settings()
    useBrowser.setState({ state: sample() })
    render(<VerticalTabs />)
    const tabs = screen.getAllByRole('tab')
    const dt = transfer()
    fireEvent.dragStart(tabs[3], { dataTransfer: dt })
    fireEvent.dragOver(tabs[1], { dataTransfer: dt })
    expect(tabs[1].className).toContain('accent-cyan')
    fireEvent.drop(tabs[1], { dataTransfer: dt })
    const head = screen.getByRole('button', { name: 'Fold Work' })
    fireEvent.dragOver(head, { dataTransfer: dt })
    expect(head.className).toContain('border-green/60')
    fireEvent.drop(head, { dataTransfer: dt })
    const end = screen.getByRole('button', { name: 'New tab' })
    fireEvent.dragOver(end, { dataTransfer: dt })
    expect(end.className).toContain('accent-cyan')
    fireEvent.drop(end, { dataTransfer: dt })
    fireEvent.dragOver(end.nextElementSibling!, { dataTransfer: dt })
    fireEvent.drop(end.nextElementSibling!, { dataTransfer: dt })
    // onto the pinned icons: pinned
    fireEvent.dragOver(tabs[0], { dataTransfer: dt })
    fireEvent.drop(tabs[0], { dataTransfer: dt })
    await settle()
    expect(sent('browser:move')).toEqual([
      { id: 'c', index: 1, groupId: 'g' },
      { id: 'c', index: 1, groupId: 'g' },
      { id: 'c', index: 5, groupId: null },
      { id: 'c', index: 5, groupId: null },
      { id: 'c', index: 0, groupId: null }
    ])
    expect(sent('browser:update')).toEqual([{ id: 'c', pinned: true }])
    // something else than a tab: not taken
    fireEvent.dragOver(tabs[1], { dataTransfer: { types: ['Files'] } })
  })

  it('names agents’ tabs and untitled pinned tabs, and folded groups by their chevron', () => {
    bridge()
    settings()
    useBrowser.setState({
      state: state(
        [tab('p', '', { pinned: true }), tab('a', 'https://a.dev/', { title: 'A', openedBy: 'Codex', groupId: 'g' }), tab('c', 'https://c.dev/', { title: 'C', openedBy: 'Codex' })],
        { activeId: 'c', groups: [group('g', { title: 'Work', collapsed: true })] }
      )
    })
    render(<VerticalTabs />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]).toHaveAttribute('title', 'New tab')
    expect(tabs[1]).toHaveAttribute('title', 'C — Opened by Codex')
    expect(screen.getByRole('button', { name: 'Unfold Work' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('folds to its icons and unfolds; its edge is dragged (the pages frozen meanwhile), keyed or reset — and remembered', async () => {
    const capture = { set: vi.fn(), release: vi.fn() }
    Object.assign(HTMLElement.prototype, { setPointerCapture: capture.set, releasePointerCapture: capture.release })
    onTestFinished(() => {
      Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture')
      Reflect.deleteProperty(HTMLElement.prototype, 'releasePointerCapture')
    })
    const { sent } = bridge({ 'browser:configure': (p: Partial<BrowserSettings>) => ({ ...DEFAULT_BROWSER_SETTINGS, verticalTabs: true, ...p }) })
    settings({ verticalTabsWidth: 300 })
    useBrowser.setState({ state: sample({ activeId: 'p' }) })
    const { rerender } = render(<VerticalTabs />)
    const edge = screen.getByRole('separator', { name: /resize the sidebar/ })
    expect(edge).toHaveAttribute('aria-valuenow', '300')
    fireEvent.pointerDown(edge, { clientX: 300, pointerId: 1 })
    expect(useOverlays.getState().count).toBe(1)
    expect(screen.getByTestId('sidebar-drag-shield')).toBeInTheDocument()
    fireEvent.pointerMove(edge, { clientX: 360, pointerId: 1, buttons: 1 })
    expect(screen.getByRole('complementary')).toHaveStyle({ width: '360px' })
    fireEvent.pointerMove(edge, { clientX: 1000, pointerId: 1, buttons: 1 })
    expect(screen.getByRole('complementary')).toHaveStyle({ width: '480px' }) // at most
    fireEvent.pointerUp(edge, { clientX: 0, pointerId: 1 })
    expect(useOverlays.getState().count).toBe(0)
    expect(capture.set).toHaveBeenCalledWith(1)
    expect(capture.release).toHaveBeenCalledWith(1)
    fireEvent.pointerUp(edge, { clientX: 0, pointerId: 1 }) // not dragging: nothing
    fireEvent.pointerMove(edge, { clientX: 10, pointerId: 1 })
    fireEvent.keyDown(edge, { key: 'ArrowRight' })
    fireEvent.keyDown(edge, { key: 'ArrowLeft' })
    fireEvent.keyDown(edge, { key: 'a' })
    fireEvent.doubleClick(edge)
    await settle()
    expect(sent('browser:configure')).toEqual([{ verticalTabsWidth: 160 }, { verticalTabsWidth: 316 }, { verticalTabsWidth: 284 }, { verticalTabsWidth: 240 }])

    // folded: icons only — no titles, no edge
    fireEvent.click(screen.getByRole('button', { name: 'Fold the sidebar to icons' }))
    await settle()
    expect(sent('browser:configure').at(-1)).toEqual({ verticalTabsCollapsed: true })
    settings({ verticalTabsCollapsed: true })
    rerender(<VerticalTabs />)
    expect(screen.getByRole('complementary')).toHaveStyle({ width: '48px' })
    expect(screen.queryByRole('separator')).toBeNull()
    expect(screen.queryByText('A')).toBeNull()
    expect(screen.getAllByRole('tab')).toHaveLength(5)
    expect(screen.getByRole('button', { name: 'Fold Work' })).not.toHaveTextContent('Work')
    fireEvent.click(screen.getByRole('button', { name: 'Unfold the sidebar' }))
    await settle()
    expect(sent('browser:configure').at(-1)).toEqual({ verticalTabsCollapsed: false })
  })
})

describe('GroupEditor', () => {
  it('renames on Enter, recolors at once, and opens a tab in the group, ungroups or closes it', async () => {
    let opened = 0
    const { sent } = bridge({ 'browser:open': () => ({ ...tab(`n${++opened}`, ''), title: '' }) })
    useBrowser.setState({ state: sample(), groupEditor: { id: 'g', at: { x: 5000, y: 20 } } })
    const { rerender } = render(<GroupEditor />)
    const dialog = screen.getByRole('dialog', { name: 'Edit group' })
    expect(dialog).toHaveStyle({ top: '26px' })
    expect(useOverlays.getState().count).toBe(1)
    const name = screen.getByRole('textbox', { name: 'Group name' })
    expect(name).toHaveValue('Work')
    expect(screen.getByRole('radio', { name: 'Green' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Red' }))
    fireEvent.change(name, { target: { value: 'Docs' } })
    fireEvent.keyDown(name, { key: 'a' })
    fireEvent.keyDown(name, { key: 'Enter' })
    await settle()
    expect(sent('browser:groupUpdate')).toEqual([
      { id: 'g', color: 'danger' },
      { id: 'g', title: 'Docs' }
    ])
    expect(useBrowser.getState().groupEditor).toBeUndefined()
    rerender(<GroupEditor />)
    expect(screen.queryByRole('dialog')).toBeNull()

    // without a place to start from: at the top; Escape or a click outside closes without renaming
    act(() => useBrowser.getState().editGroup('g'))
    rerender(<GroupEditor />)
    expect(screen.getByRole('dialog')).toHaveStyle({ top: '12vh' })
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(useBrowser.getState().groupEditor).toBeDefined()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    act(() => useBrowser.getState().editGroup('g'))
    rerender(<GroupEditor />)
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)
    await settle()
    expect(sent('browser:groupUpdate')).toHaveLength(2)

    // a new tab in the group: opened, moved in, the address bar ready
    const tick = useBrowser.getState().focusTick
    act(() => useBrowser.getState().editGroup('g'))
    rerender(<GroupEditor />)
    fireEvent.click(screen.getByRole('button', { name: 'New tab in group' }))
    await settle()
    expect(sent('browser:open')).toEqual([{}])
    expect(sent('browser:move')).toEqual([{ id: 'n1', index: 5, groupId: 'g' }])
    expect(useBrowser.getState().focusTick).toBe(tick + 1)
    // a private group gets a private tab
    act(() => useBrowser.getState().editGroup('h'))
    rerender(<GroupEditor />)
    fireEvent.click(screen.getByRole('button', { name: 'New tab in group' }))
    await settle()
    expect(sent('browser:open').at(-1)).toEqual({ private: true })
    act(() => useBrowser.getState().editGroup('g'))
    rerender(<GroupEditor />)
    fireEvent.click(screen.getByRole('button', { name: 'Ungroup' }))
    act(() => useBrowser.getState().editGroup('g'))
    rerender(<GroupEditor />)
    fireEvent.click(screen.getByRole('button', { name: 'Close group' }))
    await settle()
    expect(sent('browser:ungroup')).toEqual([{ id: 'g' }])
    expect(sent('browser:groupClose')).toEqual([{ id: 'g' }])
  })

  it('shows nothing for a group that is gone, and opens no tab when opening failed', async () => {
    const { sent } = bridge({
      'browser:open': () => {
        throw new Error('no window')
      }
    })
    useBrowser.setState({ state: sample(), groupEditor: { id: 'gone' } })
    const { rerender } = render(<GroupEditor />)
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => useBrowser.getState().editGroup('g'))
    rerender(<GroupEditor />)
    fireEvent.click(screen.getByRole('button', { name: 'New tab in group' }))
    await settle()
    expect(sent('browser:move')).toEqual([])
    expect(useBrowser.getState().error).toBe('no window')
  })
})
