import { useEffect } from 'react'
import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge, settle } from './bridge'
import type { EditorTab } from '@/features/editor/store'
import type { CursorInfo } from '@/features/editor/components/CodeEditor'

const flags = vi.hoisted(() => ({ mac: false }))
vi.mock('@/lib/platform', () => ({
  get isMac() {
    return flags.mac
  }
}))
vi.mock('@/features/editor/components/CodeEditor', () => ({
  default: ({ tab, group, onCursor }: { tab?: EditorTab; group: string; onCursor: (c: CursorInfo) => void }) => {
    useEffect(() => {
      if (tab) onCursor({ line: group === 'g1' ? 1 : 2, col: 5, language: 'TypeScript' })
    }, [tab?.id])
    return <div data-testid={`editor-${group}`}>{tab?.id ?? 'none'}</div>
  }
}))
vi.mock('@/features/editor/components/DiffView', () => ({ default: () => <div data-testid="diff" /> }))

import { oneGroup, tabKey, useEditor } from '@/features/editor/store'
import { leaf, type GridNode } from '@/features/editor/groups'
import { useScm } from '@/features/editor/scm'
import { useEditorPrefs } from '@/features/editor/prefs'
import { buildCommands } from '@/features/editor/commands'
import { EditorView } from '@/features/editor/components/EditorView'
import { EditorTabs, TAB_MIME, draggedTab } from '@/features/editor/components/EditorTabs'
import { dropZone } from '@/features/editor/components/EditorGroup'
import { useProjects } from '@/features/projects/store'
import { en } from '@/lib/i18n/en'

const initial = useEditor.getState()
const e = () => useEditor.getState()
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
const row = (children: GridNode[]): GridNode => ({ orientation: 'row', children, sizes: children.map(() => 1 / children.length) })
const groups = () => e().groups.map((g) => `${g.id}:${g.tabs.map((t) => t.slice(2)).join(',')}`)
const routes = () =>
  installBridge({
    'projects:list': () => [{ id: 'p', name: 'Demo', path: '/x/p', addedAt: '', lastSeenAt: '' }],
    'files:list': () => [],
    'files:stat': () => [],
    'files:read': ({ path }: { path: string }) => ({ path, mtimeMs: 1, size: 1, content: 'x' }),
    'scm:status': () => ({ repo: false, ahead: 0, behind: 0, merging: false, files: [] }),
    'debug:session': () => null,
    'liveServer:status': () => []
  })
const show = () => {
  useProjects.setState({ projects: [{ id: 'p', name: 'Demo', path: '/x/p', addedAt: '', lastSeenAt: '' }] })
  return render(<EditorView active onNavigate={vi.fn()} />)
}
/** Three groups: a and b side by side, c below b. */
const three = () =>
  useEditor.setState({
    projectId: 'p',
    tabs: [tab('a.ts'), tab('b.ts'), tab('c.ts', { dirty: true })],
    groups: [
      { id: 'g1', tabs: ['p:a.ts'], activeId: 'p:a.ts' },
      { id: 'g2', tabs: ['p:b.ts', 'p:a.ts'], activeId: 'p:b.ts' },
      { id: 'g3', tabs: ['p:c.ts'], activeId: 'p:c.ts' }
    ],
    grid: row([leaf('g1'), { orientation: 'column', children: [leaf('g2'), leaf('g3')], sizes: [0.5, 0.5] }]),
    activeGroup: 'g1',
    activeId: 'p:a.ts'
  })

/** A fake drag's data (jsdom has no DataTransfer). */
function transfer(from?: { id: string; group: string }) {
  const data: Record<string, string> = from ? { [TAB_MIME]: JSON.stringify(from) } : { 'text/plain': 'x' }
  return { types: Object.keys(data), getData: (type: string) => data[type] ?? '', setData: (type: string, value: string) => (data[type] = value), dropEffect: '', effectAllowed: '' }
}
/** A drag event at a place (jsdom has no DragEvent: the coordinates and keys are set by hand). */
function drag(type: 'dragOver' | 'drop' | 'dragStart', el: Element, dataTransfer: ReturnType<typeof transfer>, at: { x?: number; y?: number; alt?: boolean; ctrl?: boolean } = {}) {
  const event = createEvent[type](el, { dataTransfer })
  for (const [key, value] of Object.entries({ clientX: at.x ?? 0, clientY: at.y ?? 0, altKey: !!at.alt, ctrlKey: !!at.ctrl })) Object.defineProperty(event, key, { value })
  fireEvent(el, event)
  return event
}
const box = (el: Element, width = 100, height = 100) =>
  ((el as HTMLElement).getBoundingClientRect = () => ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect)

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
  useEditor.setState(initial, true)
  useScm.setState({ diff: undefined, pane: 'files' })
  flags.mac = false
})

describe('editor groups: the view', () => {
  it('three groups in a grid; each shows its file; a click focuses one; the status bar follows the focus', async () => {
    routes()
    three()
    show()
    await act(settle)
    expect(screen.getByTestId('editor-g1')).toHaveTextContent('p:a.ts')
    expect(screen.getByTestId('editor-g2')).toHaveTextContent('p:b.ts')
    expect(screen.getByTestId('editor-g3')).toHaveTextContent('p:c.ts')
    const second = screen.getByRole('region', { name: 'Editor group 2' })
    expect(second.parentElement).toHaveStyle({ left: '50%', top: '0%', width: '50%', height: '50%' })
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Demo › a.ts')
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Ln 1, Col 5')
    fireEvent.mouseDown(screen.getByTestId('editor-g2'))
    expect(e().activeGroup).toBe('g2')
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Demo › b.ts')
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Ln 2, Col 5')
    // Tabs of a group: a click shows the file there.
    fireEvent.click(within(second).getByRole('tab', { name: /a\.ts/ }))
    expect(e().groups[1].activeId).toBe('p:a.ts')
    // The tab bar's buttons: split right, close the group.
    fireEvent.click(within(screen.getByRole('region', { name: 'Editor group 3' })).getByRole('button', { name: 'Split Right' }))
    expect(groups()).toEqual(['g1:a.ts', 'g2:b.ts,a.ts', 'g3:c.ts', 'g4:c.ts'])
    fireEvent.click(within(screen.getByRole('region', { name: 'Editor group 4' })).getByRole('button', { name: 'Close Group' }))
    expect(e().groups).toHaveLength(3)
  })

  it('keys: ⌘\\ splits right, ⌘1…⌘9 focus a group (⌘K ⌘\\ goes through the AI prompt: inline-ai.test.ts)', async () => {
    routes()
    useEditor.setState({ projectId: 'p', tabs: [tab('a.ts')], ...oneGroup(['p:a.ts']) })
    show()
    await act(settle)
    fireEvent.keyDown(window, { key: '\\', metaKey: true })
    expect(groups()).toEqual(['g1:a.ts', 'g2:a.ts'])
    act(() => e().split('down'))
    expect(e().grid).toEqual(row([leaf('g1'), { orientation: 'column', children: [leaf('g2'), leaf('g3')], sizes: [0.5, 0.5] }]))
    fireEvent.keyDown(window, { key: '1', ctrlKey: true }) // by the key, when the place isn't told
    expect(e().activeGroup).toBe('g1')
    fireEvent.keyDown(window, { key: '3', code: 'Digit3', metaKey: true })
    expect(e().activeGroup).toBe('g3')
    fireEvent.keyDown(window, { key: '§', code: 'Digit2', metaKey: true }) // by its place on the keyboard
    expect(e().activeGroup).toBe('g2')
    fireEvent.keyDown(window, { key: '9', code: 'Digit9', metaKey: true }) // no such group
    fireEvent.keyDown(window, { key: '!', code: 'Digit1', metaKey: true, shiftKey: true }) // ⇧ isn't it
    expect(e().activeGroup).toBe('g2')
    fireEvent.keyDown(window, { key: 'x' }) // no modifier: not the editor's
    fireEvent.keyDown(window, { key: '\\', metaKey: true })
    expect(e().groups).toHaveLength(4)
    expect(e().grid).toMatchObject({ children: [leaf('g1'), { orientation: 'column', children: [{ orientation: 'row' }, leaf('g3')] }] })
  })

  it('tabs drag within a bar, to another group’s bar, and onto editors (the middle joins, an edge splits)', async () => {
    routes()
    three()
    show()
    await act(settle)
    const bar = (n: number) => within(screen.getByRole('region', { name: `Editor group ${n}` })).getByRole('tablist')
    const tabIn = (n: number, name: string) => within(bar(n)).getByRole('tab', { name: new RegExp(name) })

    // Dragging starts with the tab's file and group.
    const started = transfer()
    drag('dragStart', tabIn(2, 'b.ts'), started)
    expect(draggedTab({ dataTransfer: started as never })).toEqual({ id: 'p:b.ts', group: 'g2' })
    expect(started.effectAllowed).toBe('copyMove')

    // Over the right half of a tab: the drop goes after it.
    const target = tabIn(2, 'a.ts')
    box(target)
    const over = drag('dragOver', target, transfer({ id: 'p:b.ts', group: 'g2' }), { x: 80 })
    expect(over.defaultPrevented).toBe(true)
    expect(bar(2).querySelector('.right-0')).not.toBeNull()
    drag('drop', target, transfer({ id: 'p:b.ts', group: 'g2' }), { x: 80 })
    expect(groups()[1]).toBe('g2:a.ts,b.ts')
    // Over its left half: before it; with Ctrl (not on a Mac) a copy.
    drag('dragOver', tabIn(1, 'a.ts'), transfer({ id: 'p:b.ts', group: 'g2' }), { x: 10, ctrl: true })
    expect(bar(1).querySelector('.left-0')).not.toBeNull()
    fireEvent.dragLeave(bar(1))
    expect(bar(1).querySelector('.left-0')).toBeNull()
    drag('drop', tabIn(1, 'a.ts'), transfer({ id: 'p:b.ts', group: 'g2' }), { x: 10, ctrl: true })
    expect(groups().slice(0, 2)).toEqual(['g1:b.ts,a.ts', 'g2:a.ts,b.ts'])
    // On the bar's free space: at the end.
    drag('dragOver', bar(3), transfer({ id: 'p:a.ts', group: 'g1' }))
    drag('drop', bar(3), transfer({ id: 'p:a.ts', group: 'g1' }))
    expect(groups()).toEqual(['g1:b.ts', 'g2:a.ts,b.ts', 'g3:c.ts,a.ts'])
    // Anything else dragged (text, files) isn't a tab: no drop here.
    expect(drag('dragOver', bar(3), transfer()).defaultPrevented).toBe(false)
    drag('drop', bar(3), transfer())
    expect(e().groups[2].tabs).toHaveLength(2)

    // Onto an editor: the middle moves the tab into the group …
    const area = screen.getByTestId('editor-g1').parentElement!
    box(area)
    drag('dragOver', area, transfer({ id: 'p:c.ts', group: 'g3' }), { x: 50, y: 50 })
    expect(area.querySelector('[data-zone="center"]')).not.toBeNull()
    fireEvent.dragLeave(area)
    expect(area.querySelector('[data-zone]')).toBeNull()
    drag('drop', area, transfer({ id: 'p:c.ts', group: 'g3' }), { x: 50, y: 50 })
    expect(groups()).toEqual(['g1:b.ts,c.ts', 'g2:a.ts,b.ts', 'g3:a.ts'])
    // … an edge opens a new group on that side (⌘-free copy with Ctrl).
    drag('dragOver', area, transfer({ id: 'p:b.ts', group: 'g1' }), { x: 50, y: 95, ctrl: true })
    expect(area.querySelector('[data-zone="down"]')).not.toBeNull()
    drag('drop', area, transfer({ id: 'p:b.ts', group: 'g1' }), { x: 50, y: 95, ctrl: true })
    expect(groups()).toEqual(['g1:b.ts,c.ts', 'g2:a.ts,b.ts', 'g3:a.ts', 'g4:b.ts'])
    expect(e().activeGroup).toBe('g4')
    expect(drag('dragOver', area, transfer()).defaultPrevented).toBe(false)
    drag('drop', area, transfer())
    expect(e().groups).toHaveLength(4)
  })

  it('on a Mac ⌥ copies a dragged tab; the menu shows ⌘ keys', () => {
    flags.mac = true
    useEditor.setState({ tabs: [tab('a.ts'), tab('b.ts')], ...oneGroup(['p:a.ts', 'p:b.ts']) })
    useEditor.getState().split('right', 'p:b.ts')
    render(<EditorTabs group="g1" projectNames={new Map()} />)
    const bar = screen.getByRole('tablist')
    drag('drop', bar, transfer({ id: 'p:b.ts', group: 'g2' }), { alt: true })
    expect(groups()).toEqual(['g1:a.ts,b.ts', 'g2:b.ts'])
    fireEvent.contextMenu(screen.getByRole('tab', { name: /a\.ts/ }), { clientX: 5, clientY: 6 })
    expect(screen.getByRole('menuitem', { name: /Split Right/ })).toHaveTextContent('⌘\\')
    expect(screen.getByTitle('Split Right (⌘\\)')).toBeInTheDocument()
  })

  it('a tab’s menu: close, close others, split right / down, close the group, copy the path', async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    useEditor.setState({ projectId: 'p', tabs: [tab('a.ts'), tab('b.ts'), tab('c.ts')], ...oneGroup(['p:a.ts', 'p:b.ts', 'p:c.ts']) })
    render(<EditorTabs group="g1" projectNames={new Map()} />)
    const menu = (name: string) => {
      fireEvent.contextMenu(screen.getByRole('tab', { name: new RegExp(name) }), { clientX: 5, clientY: 6 })
      return screen.getByRole('menu', { name: 'Tab actions' })
    }
    expect(within(menu('a.ts')).queryByRole('menuitem', { name: /Close Group/ })).toBeNull() // one group
    expect(within(menu('a.ts')).getByRole('menuitem', { name: /Split Down/ })).toHaveTextContent('Ctrl+K Ctrl+\\')
    fireEvent.click(within(menu('a.ts')).getByRole('menuitem', { name: /Copy Relative Path/ }))
    expect(writeText).toHaveBeenCalledWith('a.ts')
    fireEvent.click(within(menu('b.ts')).getByRole('menuitem', { name: /Split Right/ }))
    expect(groups()).toEqual(['g1:a.ts,b.ts,c.ts', 'g2:b.ts'])
    fireEvent.click(within(menu('c.ts')).getByRole('menuitem', { name: /Split Down/ }))
    expect(groups()).toEqual(['g1:a.ts,b.ts,c.ts', 'g2:b.ts', 'g3:c.ts'])
    expect(e().grid).toEqual(row([{ orientation: 'column', children: [leaf('g1'), leaf('g3')], sizes: [0.5, 0.5] }, leaf('g2')]))
    fireEvent.click(within(menu('a.ts')).getByRole('menuitem', { name: /Close Others/ }))
    expect(groups()).toEqual(['g1:a.ts', 'g2:b.ts', 'g3:c.ts']) // b and c are still open elsewhere
    fireEvent.click(within(menu('a.ts')).getByRole('menuitem', { name: /^Close$/ }))
    expect(e().groups.map((g) => g.id)).toEqual(['g2', 'g3'])
    // Escape or a click elsewhere closes the menu.
    act(() => useEditor.setState({ tabs: [...e().tabs, tab('a.ts')], groups: [{ id: 'g1', tabs: ['p:a.ts'], activeId: 'p:a.ts' }, ...e().groups], grid: row([leaf('g1'), e().grid]) }))
    menu('a.ts')
    fireEvent.keyDown(window, { key: 'x' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    const open = menu('a.ts')
    fireEvent.mouseDown(open)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(within(menu('a.ts')).getByRole('menuitem', { name: /Close Group/ }))
    expect(e().groups.map((g) => g.id)).toEqual(['g2', 'g3'])
  })

  it('sashes: drag (not below the minimum), arrow keys, double-click for equal sizes', async () => {
    routes()
    Object.assign(Element.prototype, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
    three()
    show()
    await act(settle)
    const [columns, rows] = screen.getAllByRole('separator', { name: 'Resize the editor groups' })
    expect(columns).toHaveAttribute('aria-orientation', 'vertical')
    expect(rows).toHaveAttribute('aria-orientation', 'horizontal')
    const sizes = () => (e().grid as { sizes: number[] }).sizes
    fireEvent.pointerMove(columns, { clientX: 300 }) // not dragging
    expect(sizes()).toEqual([0.5, 0.5])
    fireEvent.pointerDown(columns, { clientX: 500, pointerId: 2 })
    fireEvent.pointerMove(columns, { clientX: 300, buttons: 1 })
    expect(sizes()).toEqual([0.3, 0.7])
    fireEvent.pointerMove(columns, { clientX: 10, buttons: 1 })
    expect(sizes()[0]).toBeCloseTo(0.12) // 120 px at least
    fireEvent.pointerUp(columns, { pointerId: 2 })
    fireEvent.pointerUp(columns) // already up
    fireEvent.pointerMove(columns, { clientX: 500 })
    expect(sizes()[0]).toBeCloseTo(0.12)
    fireEvent.doubleClick(columns)
    expect(sizes()).toEqual([0.5, 0.5])
    fireEvent.keyDown(columns, { key: 'ArrowRight' })
    expect(sizes()[0]).toBeCloseTo(0.52)
    fireEvent.keyDown(columns, { key: 'ArrowUp' }) // the other axis
    expect(sizes()[0]).toBeCloseTo(0.52)
    const inner = () => (e().grid as { children: { sizes: number[] }[] }).children[1].sizes
    fireEvent.keyDown(rows, { key: 'ArrowDown' })
    expect(inner()[0]).toBeCloseTo(0.52)
    fireEvent.pointerDown(rows, { clientY: 300, pointerId: 3 })
    fireEvent.pointerMove(rows, { clientY: 150, buttons: 1 })
    expect(inner()[0]).toBeCloseTo(0.25)
    fireEvent.pointerCancel(rows, { pointerId: 3 })
  })

  it('a stage without a size: sashes keep still', async () => {
    routes()
    Object.assign(Element.prototype, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() })
    three()
    show()
    await act(settle)
    const [columns] = screen.getAllByRole('separator')
    fireEvent.pointerDown(columns, { clientX: 500 })
    fireEvent.pointerMove(columns, { clientX: 300, buttons: 1 })
    fireEvent.keyDown(columns, { key: 'ArrowLeft' })
    expect((e().grid as { sizes: number[] }).sizes[0]).toBeCloseTo(0.48)
  })

  it('a diff takes the place of the focused group; the others keep their files; a closed host hands it to the focused one', async () => {
    routes()
    three()
    show()
    await act(settle)
    act(() => e().focusGroup('g2'))
    act(() => useScm.setState({ diff: { path: 'b.ts', original: 'a', modified: 'b', title: 'b.ts (Working Tree)' } }))
    const second = screen.getByRole('region', { name: 'Editor group 2' })
    expect(await within(second).findByTestId('diff')).toBeInTheDocument()
    expect(within(second).getByRole('tablist').closest('.hidden')).not.toBeNull()
    expect(screen.getByTestId('editor-g1')).toHaveTextContent('p:a.ts')
    act(() => e().focusGroup('g1')) // the diff stays where it opened
    expect(within(second).getByTestId('diff')).toBeInTheDocument()
    act(() => e().closeGroup('g2'))
    expect(within(screen.getByRole('region', { name: 'Editor group 1' })).getByTestId('diff')).toBeInTheDocument()
    act(() => useScm.getState().closeDiff())
    expect(screen.queryByTestId('diff')).toBeNull()
    // The outline is a sidebar pane.
    act(() => useScm.getState().setPane('outline'))
    expect(screen.getByPlaceholderText('Filter symbols')).toBeInTheDocument()
  })

  it('“save before closing?” shows in the group it was asked in', async () => {
    routes()
    three()
    useEditor.setState((s) => ({ groups: s.groups.map((g) => (g.id === 'g1' ? { ...g, tabs: ['p:a.ts', 'p:c.ts'] } : g)) }))
    show()
    await act(settle)
    act(() => e().requestClose('p:c.ts', 'g3')) // in g3 — and in g1, so g3 just lets go
    expect(groups()).toEqual(['g1:a.ts,c.ts', 'g2:b.ts,a.ts'])
    act(() => e().requestClose('p:c.ts', 'g1'))
    expect(within(screen.getByRole('region', { name: 'Editor group 1' })).getByText('Save changes to c.ts before closing?')).toBeInTheDocument()
    act(() => e().focusGroup('g2')) // not in the focused group: in the one that has it
    expect(within(screen.getByRole('region', { name: 'Editor group 1' })).getByText('Save changes to c.ts before closing?')).toBeInTheDocument()
    act(() => useEditor.setState({ closing: 'p:gone.ts' })) // nowhere on screen: the focused group asks
    expect(within(screen.getByRole('region', { name: 'Editor group 2' })).queryByText(/before closing/)).toBeNull()
  })

  it('the palette: split right / down, close the group, focus groups, minimap and sticky scroll', async () => {
    const update = vi.fn(async (patch: object) => useEditorPrefs.setState((s) => ({ settings: { ...s.settings, ...patch } })))
    useEditorPrefs.setState({ settings: {}, update })
    useEditor.setState({ tabs: [tab('a.ts')], ...oneGroup(['p:a.ts']) })
    const commands = () => buildCommands(en, { readOnly: false })
    const run = (id: string) => act(() => void commands().find((c) => c.id === id)!.run())
    expect(commands().find((c) => c.id === 'view.split')).toMatchObject({ label: 'View: Split Editor Right', keys: 'Ctrl+\\' })
    expect(commands().find((c) => c.id === 'view.closeGroup')).toBeUndefined()
    expect(commands().filter((c) => c.id.startsWith('view.focusGroup')).map((c) => c.keys)).toEqual(['Ctrl+1', 'Ctrl+2'])
    run('view.split')
    run('view.splitDown')
    expect(e().groups).toHaveLength(3)
    run('view.focusGroup1')
    expect(e().activeGroup).toBe('g1')
    run('view.closeGroup')
    expect(e().groups).toHaveLength(2)
    run('view.minimap')
    expect(update).toHaveBeenLastCalledWith({ minimap: false })
    run('view.minimap')
    expect(update).toHaveBeenLastCalledWith({ minimap: true })
    run('view.stickyScroll')
    expect(update).toHaveBeenLastCalledWith({ stickyScroll: false })
    run('view.outline')
    expect(useScm.getState().pane).toBe('outline')
    useEditor.setState({ groups: Array.from({ length: 9 }, (_, i) => ({ id: `g${i + 1}`, tabs: [] })) })
    expect(commands().filter((c) => c.id.startsWith('view.focusGroup'))).toHaveLength(9)
  })
})

describe('where a dragged tab lands', () => {
  it('within a quarter of an edge: that side; else the middle (and without a size)', () => {
    const b = { left: 0, top: 0, width: 200, height: 100 }
    expect(dropZone({ clientX: 100, clientY: 50 }, b)).toBe('center')
    expect(dropZone({ clientX: 10, clientY: 50 }, b)).toBe('left')
    expect(dropZone({ clientX: 190, clientY: 50 }, b)).toBe('right')
    expect(dropZone({ clientX: 100, clientY: 5 }, b)).toBe('up')
    expect(dropZone({ clientX: 100, clientY: 95 }, b)).toBe('down')
    expect(dropZone({ clientX: 10, clientY: 10 }, { left: 0, top: 0, width: 0, height: 0 })).toBe('center')
  })

  it('a drag that isn’t a tab is none', () => {
    expect(draggedTab({ dataTransfer: transfer() as never })).toBeUndefined()
    const odd = { types: [TAB_MIME], getData: () => JSON.stringify({ id: 1 }) }
    expect(draggedTab({ dataTransfer: odd as never })).toBeUndefined()
  })
})
