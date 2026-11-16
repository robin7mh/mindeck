import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, installBridge } from './bridge'
import { evenSizes, gridSashes, groupOrder, groupRects, leaf, moveSash, neighbour, parseGrid, removeGroup, splitGroup, type GridNode } from '@/features/editor/groups'
import { filterSymbols, revealOf, sortSymbols, symbolPath, useOutline, type OutlineSymbol } from '@/features/editor/outline'
import { loadSession, oneGroup, setBufferHost, tabKey, useEditor, type EditorTab } from '@/features/editor/store'

const row = (children: GridNode[], sizes = children.map(() => 1 / children.length)): GridNode => ({ orientation: 'row', children, sizes })
const column = (children: GridNode[], sizes = children.map(() => 1 / children.length)): GridNode => ({ orientation: 'column', children, sizes })

describe('the grid of editor groups', () => {
  it('splits next to a group: a new row or column, or a place in the one it is in', () => {
    const right = splitGroup(leaf('g1'), 'g1', 'g2', 'right')
    expect(right).toEqual(row([leaf('g1'), leaf('g2')]))
    const left = splitGroup(right, 'g2', 'g3', 'left') // same direction: a third column, g2's half halved
    expect(left).toEqual({ orientation: 'row', children: [leaf('g1'), leaf('g3'), leaf('g2')], sizes: [0.5, 0.25, 0.25] })
    const down = splitGroup(left, 'g1', 'g4', 'down') // across: g1 becomes a column
    expect(down).toEqual({ orientation: 'row', children: [column([leaf('g4'), leaf('g1')].reverse()), leaf('g3'), leaf('g2')], sizes: [0.5, 0.25, 0.25] })
    expect(splitGroup(down, 'g4', 'g5', 'up')).toEqual({
      orientation: 'row',
      children: [{ orientation: 'column', children: [leaf('g1'), leaf('g5'), leaf('g4')], sizes: [0.5, 0.25, 0.25] }, leaf('g3'), leaf('g2')],
      sizes: [0.5, 0.25, 0.25]
    })
    expect(groupOrder(down)).toEqual(['g1', 'g4', 'g3', 'g2'])
    expect(splitGroup(leaf('g1'), 'nope', 'g2', 'right')).toEqual(leaf('g1'))
    expect(splitGroup(leaf('g1'), 'g1', 'g2', 'left')).toEqual(row([leaf('g2'), leaf('g1')]))
  })

  it('removes a group: its room goes to its siblings, single children and same-direction branches fold in', () => {
    const grid: GridNode = { orientation: 'row', children: [column([leaf('a'), row([leaf('b'), leaf('c')])]), leaf('d')], sizes: [0.5, 0.5] }
    // Without a: b and c are a row inside the row — they join it.
    expect(removeGroup(grid, 'a')).toEqual({ orientation: 'row', children: [leaf('b'), leaf('c'), leaf('d')], sizes: [0.25, 0.25, 0.5] })
    expect(removeGroup(grid, 'd')).toEqual(column([leaf('a'), row([leaf('b'), leaf('c')])]))
    expect(removeGroup(leaf('a'), 'a')).toBeNull()
    expect(removeGroup(leaf('a'), 'b')).toEqual(leaf('a'))
    expect(removeGroup(row([leaf('a'), leaf('b')]), 'a')).toEqual(leaf('b'))
  })

  it('boxes, sashes, moving them (never below the minimum) and equal sizes', () => {
    const grid: GridNode = { orientation: 'row', children: [leaf('a'), { orientation: 'column', children: [leaf('b'), leaf('c')], sizes: [0.25, 0.75] }], sizes: [0.6, 0.4] }
    const rects = groupRects(grid)
    expect(rects.get('a')).toEqual({ x0: 0, y0: 0, x1: 0.6, y1: 1 })
    expect(rects.get('b')).toEqual({ x0: 0.6, y0: 0, x1: 1, y1: 0.25 })
    expect(rects.get('c')).toEqual({ x0: 0.6, y0: 0.25, x1: 1, y1: 1 })
    const sashes = gridSashes(grid)
    expect(sashes).toEqual([
      { path: [], index: 1, orientation: 'row', at: 0.6, from: 0, to: 1 },
      { path: [1], index: 1, orientation: 'column', at: 0.25, from: 0.6, to: 1 }
    ])
    expect(gridSashes(leaf('a'))).toEqual([])

    const moved = moveSash(grid, sashes[0], 0.3, 0.1)
    expect((moved as { sizes: number[] }).sizes).toEqual([0.3, 0.7])
    expect((moveSash(grid, sashes[0], 0.99, 0.1) as { sizes: number[] }).sizes.map((n) => +n.toFixed(6))).toEqual([0.9, 0.1]) // clamped
    expect((moveSash(grid, sashes[1], 0.5, 0.1) as { children: { sizes: number[] }[] }).children[1].sizes).toEqual([0.5, 0.5])
    expect(moveSash(grid, sashes[1], 0.5, 0.6)).toBe(grid) // too small to move at all
    expect((evenSizes(grid, [1]) as { children: { sizes: number[] }[] }).children[1].sizes).toEqual([0.5, 0.5])
    expect((evenSizes(grid, []) as { sizes: number[] }).sizes).toEqual([0.5, 0.5])
    // A row inside a column: its sash moves along x, within its own box.
    const stacked: GridNode = column([leaf('a'), row([leaf('b'), leaf('c')])], [0.5, 0.5])
    const [, inner] = gridSashes(stacked)
    expect(inner).toEqual({ path: [1], index: 1, orientation: 'row', at: 0.5, from: 0.5, to: 1 })
    expect((moveSash(stacked, inner, 0.2, 0.1) as { children: { sizes: number[] }[] }).children[1].sizes).toEqual([0.2, 0.8])
  })

  it('finds the neighbour on a side (sharing an edge; the nearest, then the one sharing most)', () => {
    const grid: GridNode = { orientation: 'row', children: [leaf('a'), { orientation: 'column', children: [leaf('b'), leaf('c')], sizes: [0.7, 0.3] }, leaf('d')], sizes: [1 / 3, 1 / 3, 1 / 3] }
    expect(neighbour(grid, 'a', 'right')).toBe('b') // b shares more of a's edge than c
    expect(neighbour(grid, 'b', 'down')).toBe('c')
    expect(neighbour(grid, 'c', 'up')).toBe('b')
    expect(neighbour(grid, 'c', 'left')).toBe('a')
    expect(neighbour(grid, 'c', 'right')).toBe('d') // d, not a farther one
    expect(neighbour(grid, 'd', 'right')).toBeUndefined()
    expect(neighbour(grid, 'a', 'up')).toBeUndefined()
    expect(neighbour(grid, 'nope', 'left')).toBeUndefined()
    const tie: GridNode = row([leaf('a'), column([leaf('b'), leaf('c')])])
    expect(neighbour(tie, 'a', 'right')).toBe('b') // equal share: the first
  })

  it('reads a stored grid back — or nothing when it is not one', () => {
    const grid = row([leaf('a'), column([leaf('b'), leaf('c')])])
    expect(parseGrid(JSON.parse(JSON.stringify(grid)))).toEqual(grid)
    expect(parseGrid({ orientation: 'row', children: [leaf('a'), row([leaf('b'), leaf('c')])], sizes: [2, 2] })).toEqual({
      orientation: 'row',
      children: [leaf('a'), leaf('b'), leaf('c')],
      sizes: [0.5, 0.25, 0.25]
    })
    for (const bad of [
      null,
      'x',
      { group: '' },
      row([leaf('a'), leaf('a')]),
      { orientation: 'diagonal', children: [leaf('a'), leaf('b')], sizes: [1, 1] },
      { orientation: 'row', children: 'x', sizes: [1] },
      { orientation: 'row', children: [leaf('a')], sizes: [1] },
      { orientation: 'row', children: [leaf('a'), leaf('b')], sizes: [1] },
      { orientation: 'row', children: [leaf('a'), leaf('b')], sizes: [1, -1] },
      { orientation: 'row', children: [leaf('a'), leaf('b')], sizes: [1, 'x'] },
      { orientation: 'row', children: [leaf('a'), 7], sizes: [1, 1] }
    ])
      expect(parseGrid(bad)).toBeNull()
    let deep: GridNode = leaf('z')
    for (let i = 0; i < 17; i += 1) deep = row([deep, leaf(`n${i}`)])
    // Seventeen levels of the same direction are no deeper than one once folded — but a stored tree that deep isn't read.
    expect(parseGrid(deep)).toBeNull()
  })
})

describe('outline helpers', () => {
  const r = (startLine: number, startColumn: number, endLine: number, endColumn: number) => ({ startLine, startColumn, endLine, endColumn })
  const sym = (name: string, range: ReturnType<typeof r>, children: OutlineSymbol[] = [], selection = range): OutlineSymbol => ({ name, kind: 11, range, selection, children })
  const method = sym('run', r(3, 3, 5, 4))
  const klass = sym('Server', r(2, 1, 8, 2), [method, sym('stop', r(6, 3, 7, 4))])
  const symbols = [sym('main', r(10, 1, 12, 2)), klass]

  it('the trail around a position, filtering with the way there, order by place, where a click goes', () => {
    expect(symbolPath(symbols, { line: 4, column: 1 }).map((s) => s.name)).toEqual(['Server', 'run'])
    expect(symbolPath(symbols, { line: 2, column: 1 }).map((s) => s.name)).toEqual(['Server'])
    expect(symbolPath(symbols, { line: 8, column: 2 }).map((s) => s.name)).toEqual(['Server'])
    expect(symbolPath(symbols, { line: 8, column: 3 })).toEqual([])
    expect(symbolPath(symbols, { line: 1, column: 1 })).toEqual([])
    expect(symbolPath(symbols, { line: 2, column: 0 })).toEqual([])

    expect(filterSymbols(symbols, '')).toBe(symbols)
    expect(filterSymbols(symbols, ' RUN ')).toEqual([{ ...klass, children: [method] }])
    expect(filterSymbols(symbols, 'zzz')).toEqual([])

    expect(sortSymbols(symbols).map((s) => s.name)).toEqual(['Server', 'main'])
    expect(sortSymbols([sym('b', r(1, 5, 1, 6)), sym('a', r(1, 2, 1, 3))]).map((s) => s.name)).toEqual(['a', 'b'])

    expect(revealOf(sym('x', r(1, 1, 3, 1), [], r(1, 7, 1, 10)))).toEqual({ line: 1, match: { column: 6, length: 3 } })
    expect(revealOf(sym('x', r(1, 1, 3, 1), [], r(2, 1, 3, 1)))).toEqual({ line: 2 })
    expect(revealOf(sym('x', r(1, 1, 3, 1), [], r(4, 2, 4, 2)))).toEqual({ line: 4 })
  })

  it('the store: symbols per file, a cursor per group (no update when nothing moved)', () => {
    const o = () => useOutline.getState()
    o().setSymbols('p:a.ts', symbols)
    expect(o().symbols['p:a.ts']).toBe(symbols)
    o().forget('p:a.ts')
    const before = o().symbols
    o().forget('p:a.ts')
    expect(o().symbols).toBe(before)
    o().setCursor('g1', { line: 1, column: 2 })
    const cursors = o().cursors
    o().setCursor('g1', { line: 1, column: 2 })
    expect(o().cursors).toBe(cursors)
    o().setCursor('g1', { line: 1, column: 3 })
    expect(o().cursors.g1).toEqual({ line: 1, column: 3 })
  })
})

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
const host = () => ({ snapshot: vi.fn(() => ({ text: 't', version: 2 })), markClean: vi.fn(), drop: vi.fn(), rekey: vi.fn() })
const groups = () => e().groups.map((g) => `${g.id}:${g.tabs.map((t) => t.slice(2)).join(',')}${g.activeId ? `>${g.activeId.slice(2)}` : ''}`)
const routes = () =>
  installBridge({
    'files:list': () => [],
    'files:read': ({ path }: { path: string }) => (path.startsWith('gone') ? fail('ENOENT') : { path, mtimeMs: 1, size: 1, content: `<${path}>` }),
    'files:write': () => ({ mtimeMs: 2, size: 1 })
  })

beforeEach(() => {
  useEditor.setState(initial, true)
  useEditor.setState({ projectId: 'p' })
  setBufferHost(null)
})

describe('editor groups: the store', () => {
  it('splits right and down with the focused file (or empty); files open in the focused group, next to its active tab', async () => {
    routes()
    e().split() // nothing open: an empty group, like VS Code
    expect(groups()).toEqual(['g1:', 'g2:'])
    expect(e().activeGroup).toBe('g2')
    e().closeGroup()
    await e().open('a.ts')
    await e().open('b.ts')
    e().setActive('p:a.ts')
    await e().open('c.ts') // right after the active tab
    expect(groups()).toEqual(['g1:a.ts,c.ts,b.ts>c.ts'])
    e().split('right')
    expect(groups()).toEqual(['g1:a.ts,c.ts,b.ts>c.ts', 'g2:c.ts>c.ts'])
    expect(e()).toMatchObject({ activeGroup: 'g2', activeId: 'p:c.ts' })
    expect(e().focusedId()).toBe('p:c.ts')
    await e().open('a.ts') // opens in the focused group; the file's buffer is the same
    expect(groups()[1]).toBe('g2:c.ts,a.ts>a.ts')
    expect(e().tabs).toHaveLength(3)
    e().split('down', 'p:nope') // not an open file: an empty group
    expect(groups()[2]).toBe('g3:')
    expect(e().grid).toEqual({ orientation: 'row', children: [{ group: 'g1' }, { orientation: 'column', children: [{ group: 'g2' }, { group: 'g3' }], sizes: [0.5, 0.5] }], sizes: [0.5, 0.5] })
    e().setActive('p:b.ts', 'nope') // an unknown group: the focused one
    expect(groups()[2]).toBe('g3:b.ts>b.ts')
    await e().open('b.ts', { group: 'g1' })
    expect(e()).toMatchObject({ activeGroup: 'g1', activeId: 'p:b.ts' })
    await e().openAt('c.ts', 3)
    expect(e().reveal).toEqual({ id: 'p:c.ts', line: 3, match: undefined, group: 'g1' })
  })

  it('open to the side: the group to the right (made when missing); an empty focused group takes it itself', async () => {
    routes()
    await e().openToSide('a.ts')
    expect(groups()).toEqual(['g1:a.ts>a.ts'])
    await e().openToSide('b.ts')
    expect(groups()).toEqual(['g1:a.ts>a.ts', 'g2:b.ts>b.ts'])
    e().focusGroup('g1')
    await e().openToSide('c.ts')
    expect(groups()).toEqual(['g1:a.ts>a.ts', 'g2:b.ts,c.ts>c.ts'])
  })

  it('⌘1…⌘9: focus a group by its place; one past the last splits it with its file; further does nothing', async () => {
    routes()
    await e().open('a.ts')
    e().focusGroupAt(1)
    expect(groups()).toEqual(['g1:a.ts>a.ts', 'g2:a.ts>a.ts'])
    e().focusGroupAt(0)
    expect(e().activeGroup).toBe('g1')
    e().focusGroupAt(5)
    expect(e().groups).toHaveLength(2)
    const before = e()
    e().focusGroup('g1') // already: nothing changes
    e().focusGroup('nope')
    expect(e()).toBe(before)
    e().focusGroup('g2')
    e().split('right', 'p:nope') // an empty third group, the last one
    e().focusGroupAt(3) // the last one is empty: the new one is too
    expect(groups()).toEqual(['g1:a.ts>a.ts', 'g2:a.ts>a.ts', 'g3:', 'g4:'])
  })

  it('closing a group: its own clean files close, files shown elsewhere stay, unsaved ones move to the neighbour', async () => {
    routes()
    const h = host()
    setBufferHost(h)
    useEditor.setState({
      tabs: [tab('a.ts'), tab('b.ts', { dirty: true }), tab('c.ts'), tab('d.ts')],
      groups: [
        { id: 'g1', tabs: ['p:a.ts'], activeId: 'p:a.ts' },
        { id: 'g2', tabs: ['p:a.ts', 'p:b.ts', 'p:c.ts'], activeId: 'p:b.ts' },
        { id: 'g3', tabs: ['p:d.ts'], activeId: 'p:d.ts' }
      ],
      grid: row([leaf('g1'), leaf('g2'), leaf('g3')]),
      activeGroup: 'g2',
      activeId: 'p:b.ts'
    })
    e().closeGroup('nope')
    e().closeGroup()
    expect(groups()).toEqual(['g1:a.ts,b.ts>b.ts', 'g3:d.ts>d.ts'])
    expect(e()).toMatchObject({ activeGroup: 'g1', activeId: 'p:b.ts' })
    expect(h.drop).toHaveBeenCalledWith('p:c.ts')
    expect(e().tabs.map((t) => t.name)).toEqual(['a.ts', 'b.ts', 'd.ts'])
    // An unsaved file that wasn't the active one: the first of them comes to the front.
    useEditor.setState((s) => ({ tabs: s.tabs.map((t) => ({ ...t, dirty: t.name === 'd.ts' })), groups: s.groups.map((g) => (g.id === 'g3' ? { ...g, tabs: ['p:a.ts', 'p:d.ts'], activeId: 'p:a.ts' } : g)) }))
    e().closeGroup('g3')
    expect(groups()).toEqual(['g1:a.ts,b.ts,d.ts>d.ts'])
    e().closeGroup() // the last group stays
    expect(e().groups).toHaveLength(1)
  })

  it('a closed group hands the focus to its nearest neighbour: left, else above, right, below', () => {
    const at = (grid: GridNode, close: string) => {
      const ids = groupOrder(grid)
      useEditor.setState({ tabs: [tab('a.ts')], groups: ids.map((id) => ({ id, tabs: ['p:a.ts'], activeId: 'p:a.ts' })), grid, activeGroup: close })
      e().closeGroup()
      return e().activeGroup
    }
    expect(at(row([leaf('g1'), leaf('g2')]), 'g2')).toBe('g1')
    expect(at(column([leaf('g1'), leaf('g2')]), 'g2')).toBe('g1')
    expect(at(row([leaf('g1'), leaf('g2')]), 'g1')).toBe('g2')
    expect(at(column([leaf('g1'), leaf('g2')]), 'g1')).toBe('g2')
  })

  it('moving tabs: to another group (at a place), copying, reordering; an emptied group closes', async () => {
    useEditor.setState({
      tabs: [tab('a.ts'), tab('b.ts'), tab('c.ts')],
      groups: [
        { id: 'g1', tabs: ['p:a.ts', 'p:b.ts', 'p:c.ts'], activeId: 'p:a.ts' },
        { id: 'g2', tabs: ['p:a.ts'], activeId: 'p:a.ts' }
      ],
      grid: row([leaf('g1'), leaf('g2')]),
      activeGroup: 'g1'
    })
    e().moveTab('p:a.ts', 'g1', 'g1', { index: 3 }) // to the end of its own bar
    expect(groups()[0]).toBe('g1:b.ts,c.ts,a.ts>a.ts')
    e().moveTab('p:a.ts', 'g1', 'g1', { index: 0 })
    expect(groups()[0]).toBe('g1:a.ts,b.ts,c.ts>a.ts')
    e().moveTab('p:c.ts', 'g1', 'g2', { index: 0 })
    expect(groups()).toEqual(['g1:a.ts,b.ts>a.ts', 'g2:c.ts,a.ts>c.ts'])
    expect(e().activeGroup).toBe('g2')
    e().moveTab('p:b.ts', 'g1', 'g2', { copy: true }) // after the active tab, still in g1
    expect(groups()).toEqual(['g1:a.ts,b.ts>a.ts', 'g2:c.ts,b.ts,a.ts>b.ts'])
    e().moveTab('p:a.ts', 'g1', 'g2', { index: 9 }) // already there: moves within, g1 keeps b
    expect(groups()).toEqual(['g1:b.ts>b.ts', 'g2:c.ts,b.ts,a.ts>a.ts'])
    e().moveTab('p:b.ts', 'g1', 'g2') // g1's last tab: g1 closes; g2 has it already, where it stays
    expect(groups()).toEqual(['g2:c.ts,b.ts,a.ts>b.ts'])
    expect(e().grid).toEqual(leaf('g2'))
    const before = e()
    e().moveTab('p:b.ts', 'g2', 'nope')
    e().moveTab('p:zzz', 'g2', 'g2')
    expect(e()).toBe(before)
  })

  it('dropping a tab on an edge opens a new group there (copying with ⌥); its own only tab on its own edge stays', () => {
    useEditor.setState({ tabs: [tab('a.ts'), tab('b.ts')], ...oneGroup(['p:a.ts', 'p:b.ts'], 'p:a.ts') })
    e().dropTab('p:b.ts', 'g1', 'g1', 'right')
    expect(groups()).toEqual(['g1:a.ts>a.ts', 'g2:b.ts>b.ts'])
    expect(e().activeGroup).toBe('g2')
    e().dropTab('p:a.ts', 'g1', 'g2', 'down', { copy: true })
    expect(groups()).toEqual(['g1:a.ts>a.ts', 'g2:b.ts>b.ts', 'g3:a.ts>a.ts'])
    expect(e().grid).toEqual(row([leaf('g1'), column([leaf('g2'), leaf('g3')])]))
    e().dropTab('p:a.ts', 'g1', 'g2', 'up') // g1 empties: it closes
    expect(groups()).toEqual(['g2:b.ts>b.ts', 'g3:a.ts>a.ts', 'g4:a.ts>a.ts'])
    expect(groupOrder(e().grid)).toEqual(['g4', 'g2', 'g3'])
    const before = e()
    e().dropTab('p:a.ts', 'g4', 'g4', 'left') // its only tab
    e().dropTab('p:b.ts', 'g4', 'g2', 'left') // not in g4
    e().dropTab('p:a.ts', 'g4', 'nope', 'left')
    expect(e()).toBe(before)
  })

  it('closing in one group lets go there only while another shows the file; close others asks at unsaved ones', () => {
    const h = host()
    setBufferHost(h)
    useEditor.setState({
      tabs: [tab('a.ts'), tab('b.ts', { dirty: true }), tab('c.ts')],
      groups: [
        { id: 'g1', tabs: ['p:a.ts', 'p:b.ts', 'p:c.ts'], activeId: 'p:a.ts' },
        { id: 'g2', tabs: ['p:a.ts'], activeId: 'p:a.ts' }
      ],
      grid: row([leaf('g1'), leaf('g2')]),
      activeGroup: 'g2',
      sessions: { q: { grid: leaf('g1'), groups: [{ id: 'g1', tabs: ['p:c.ts', 'q:x'], activeId: 'p:c.ts' }, { id: 'g2', tabs: ['q:y', 'p:c.ts'], activeId: 'q:y' }], activeGroup: 'g1' } }
    })
    e().requestClose('p:a.ts') // in g2, still in g1
    expect(groups()).toEqual(['g1:a.ts,b.ts,c.ts>a.ts'])
    expect(h.drop).not.toHaveBeenCalled()
    e().closeOthers('p:a.ts', 'g1') // b is unsaved: it asks, c waits
    expect(e().closing).toBe('p:b.ts')
    expect(groups()).toEqual(['g1:a.ts,b.ts,c.ts>a.ts'])
    e().cancelClose()
    e().closeOthers('p:b.ts', 'g1')
    expect(groups()).toEqual(['g1:b.ts>b.ts'])
    // Closed files leave other projects' layouts too.
    expect(e().sessions.q.groups).toEqual([
      { id: 'g1', tabs: ['q:x'], activeId: 'q:x' },
      { id: 'g2', tabs: ['q:y'], activeId: 'q:y' }
    ])
    expect(e().closeOthers('p:b.ts', 'nope')).toBeUndefined()
  })

  it('sashes resize the grid; equal sizes on demand', () => {
    useEditor.setState({ tabs: [tab('a.ts')], ...oneGroup(['p:a.ts']) })
    e().split('right')
    const grid = e().grid
    e().resizeGrid({ path: [], index: 1 }, 0.5, 0.6) // too small to move: nothing changes
    expect(e().grid).toBe(grid)
    e().resizeGrid({ path: [], index: 1 }, 0.25, 0.1)
    expect((e().grid as { sizes: number[] }).sizes).toEqual([0.25, 0.75])
    e().evenGrid([])
    expect((e().grid as { sizes: number[] }).sizes).toEqual([0.5, 0.5])
  })

  it('a renamed file follows in every group (empty groups too)', async () => {
    installBridge({ 'files:rename': () => undefined, 'files:list': () => [] })
    useEditor.setState({
      tabs: [tab('a.ts'), tab('b.ts')],
      groups: [
        { id: 'g1', tabs: ['p:a.ts', 'p:b.ts'], activeId: 'p:b.ts' },
        { id: 'g2', tabs: ['p:a.ts'], activeId: 'p:a.ts' },
        { id: 'g3', tabs: [] }
      ],
      grid: row([leaf('g1'), leaf('g2'), leaf('g3')]),
      activeGroup: 'g2',
      naming: { mode: 'rename', dir: '', path: 'a.ts' },
      selection: { path: 'a.ts', kind: 'file' }
    })
    await e().submitName('z.ts')
    expect(groups()).toEqual(['g1:z.ts,b.ts>b.ts', 'g2:z.ts>z.ts', 'g3:'])
    expect(e().activeId).toBe('p:z.ts')
  })
})

describe('editor groups: a layout per project', () => {
  const stored = () => JSON.parse(localStorage.getItem('mindeck.editor.layouts')!) as Record<string, unknown>

  it('switching projects puts the layout aside and brings the other project’s back (from this device, after a restart)', async () => {
    const bridge = routes()
    useEditor.setState(initial, true)
    localStorage.setItem(
      'mindeck.editor.layouts',
      JSON.stringify({
        q: {
          grid: row([leaf('g1'), leaf('g2')], [0.3, 0.7]),
          groups: [
            { id: 'g1', tabs: ['x.ts', 'gone.ts', 'x.ts', 7], active: 'gone.ts' },
            { id: 'g2', tabs: ['gone2.ts'] },
            { id: 'g9', tabs: ['y.ts'] }
          ],
          active: 'g2'
        }
      })
    )
    await e().selectProject('p')
    expect(groups()).toEqual(['g1:'])
    await e().open('a.ts')
    e().split('right')
    expect(stored().p).toEqual({ grid: row([leaf('g1'), leaf('g2')]), groups: [{ id: 'g1', tabs: ['a.ts'], active: 'a.ts' }, { id: 'g2', tabs: ['a.ts'], active: 'a.ts' }], active: 'g2' })

    await e().selectProject('q')
    // Gone files dropped out (and with them g2); the layout's sizes came back.
    expect(e().groups.map((g) => g.id)).toEqual(['g1'])
    expect(groups()).toEqual(['g1:x.ts>x.ts'])
    expect(e().tabs.map((t) => t.id)).toEqual(['p:a.ts', 'q:x.ts'])
    expect(e().tabs[1]).toMatchObject({ content: '<x.ts>', loading: false })
    expect(e().sessions.p.groups).toHaveLength(2)

    bridge.invoke.mockClear()
    await e().selectProject('p') // from memory: open files aren't read again
    expect(groups()).toEqual(['g1:a.ts>a.ts', 'g2:a.ts>a.ts'])
    expect(e().activeGroup).toBe('g2')
    expect(bridge.invoke.mock.calls.filter(([c]) => c === 'files:read')).toEqual([])
    expect(Object.keys(e().sessions)).toEqual(['q'])
  })

  it('a stored layout that is broken is no layout; one without a project file isn’t written; storage may fail', () => {
    localStorage.setItem('mindeck.editor.layouts', '{oops')
    expect(loadSession('p')).toBeUndefined()
    localStorage.setItem('mindeck.editor.layouts', '[1]')
    expect(loadSession('p')).toBeUndefined()
    localStorage.setItem('mindeck.editor.layouts', JSON.stringify({ p: { grid: { group: 'g1' } } }))
    expect(loadSession('p')).toEqual({ grid: leaf('g1'), groups: [{ id: 'g1', tabs: [], activeId: undefined }], activeGroup: 'g1' })
    localStorage.setItem('mindeck.editor.layouts', JSON.stringify({ p: { grid: 5 } }))
    expect(loadSession('p')).toBeUndefined()
    localStorage.clear()
    expect(loadSession('p')).toBeUndefined()

    // Another project's files in the layout aren't the project's: they aren't stored with it.
    useEditor.setState({ tabs: [tab('a.ts')], ...oneGroup(['p:a.ts', 'q:b.ts'], 'q:b.ts') })
    expect(stored().p).toEqual({ grid: leaf('g1'), groups: [{ id: 'g1', tabs: ['a.ts'] }], active: 'g1' })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    expect(() => e().split()).not.toThrow()
    setItem.mockRestore()
    // Without a project nothing is stored.
    useEditor.setState({ projectId: undefined })
    localStorage.clear()
    e().split()
    expect(localStorage.getItem('mindeck.editor.layouts')).toBeNull()
  })

  it('a stored focus on a group that isn’t there falls back to the first group', async () => {
    routes()
    useEditor.setState({ projectId: undefined })
    localStorage.setItem('mindeck.editor.layouts', JSON.stringify({ p: { grid: row([leaf('g1'), leaf('g2')]), groups: [], active: 'g7' } }))
    await e().selectProject('p')
    expect(e().activeGroup).toBe('g1')
    expect(groups()).toEqual(['g1:', 'g2:'])
  })

  it('the first project of a start keeps files already on screen', async () => {
    routes()
    useEditor.setState({ projectId: undefined, tabs: [tab('a.ts')], ...oneGroup(['p:a.ts']) })
    localStorage.setItem('mindeck.editor.layouts', JSON.stringify({ p: { grid: leaf('g1'), groups: [{ id: 'g1', tabs: ['other.ts'] }], active: 'g1' } }))
    await e().selectProject('p')
    expect(groups()).toEqual(['g1:a.ts>a.ts'])
  })
})
