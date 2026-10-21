import { describe, expect, it } from 'vitest'
import * as L from '@/features/workspace/layout'
import { isCloseKey, matchWorkspaceKey, keyLabel, workspaceKey, macKeys, type KeyLike } from '@/features/workspace/keys'
import { PANE_STEPS, paneSteps } from '@/features/workspace/steps'

const modules = (l: L.Layout) => l.panes.map((p) => p.module)

describe('workspace layout', () => {
  it('places every preset’s panes and dividers', () => {
    const s = { x: 0.3, y: 0.6 }
    expect(L.slotRects('single', s)).toEqual([{ x0: 0, y0: 0, x1: 1, y1: 1 }])
    expect(L.slotRects('columns', s)).toEqual([
      { x0: 0, y0: 0, x1: 0.3, y1: 1 },
      { x0: 0.3, y0: 0, x1: 1, y1: 1 }
    ])
    expect(L.slotRects('rows', s)[1]).toEqual({ x0: 0, y0: 0.6, x1: 1, y1: 1 })
    expect(L.slotRects('main', s)).toEqual([
      { x0: 0, y0: 0, x1: 0.3, y1: 1 },
      { x0: 0.3, y0: 0, x1: 1, y1: 0.6 },
      { x0: 0.3, y0: 0.6, x1: 1, y1: 1 }
    ])
    expect(L.slotRects('grid', s)).toHaveLength(4)
    expect(L.slotRects('grid', s)[3]).toEqual({ x0: 0.3, y0: 0.6, x1: 1, y1: 1 })
    for (const p of L.PRESETS) expect(L.slotRects(p, s)).toHaveLength(L.SLOTS[p])

    expect(L.dividers('single', s)).toEqual([])
    expect(L.dividers('columns', s)).toEqual([{ key: 'x', at: 0.3, from: 0, to: 1 }])
    expect(L.dividers('rows', s)).toEqual([{ key: 'y', at: 0.6, from: 0, to: 1 }])
    expect(L.dividers('main', s)).toEqual([
      { key: 'x', at: 0.3, from: 0, to: 1 },
      { key: 'y', at: 0.6, from: 0.3, to: 1 } // only across the right column
    ])
    expect(L.dividers('grid', s)).toEqual([
      { key: 'x', at: 0.3, from: 0, to: 1 },
      { key: 'y', at: 0.6, from: 0, to: 1 }
    ])
  })

  it('keeps every pane at its minimum size', () => {
    expect(L.clampFraction(0.05, 1000, 240)).toBe(0.24)
    expect(L.clampFraction(0.99, 1000, 240)).toBe(0.76)
    expect(L.clampFraction(0.4, 1000, 240)).toBe(0.4)
    expect(L.clampFraction(0.2, 400, 240)).toBe(0.5) // no room for two: the middle
    expect(L.clampFraction(0.01, 0, 240)).toBe(0.1) // size unknown: within reason
    expect(L.clampFraction(0.99, 0, 240)).toBe(0.9)
    expect(L.fitSizes({ x: 0.1, y: 0.95 }, 1200, 700)).toEqual({ x: 0.2, y: 0.8 })
  })

  it('makes layouts: one module, or a preset filled with free modules', () => {
    expect(L.singleLayout('agents')).toEqual({ preset: 'single', panes: [{ id: 'p1', module: 'agents' }], sizes: L.DEFAULT_SIZES.single, focus: 'p1' })
    const main = L.makeLayout('main', ['editor'])
    expect(modules(main)).toEqual(['editor', 'terminal', 'browser'])
    expect(main.panes.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
    expect(main.sizes).toEqual({ x: 0.6, y: 0.5 })
    expect(modules(L.makeLayout('columns', ['agents', 'browser', 'files']))).toEqual(['agents', 'browser'])
  })

  it('shows a module once: focuses its pane, fills the focused pane, swaps when needed', () => {
    let l = L.makeLayout('columns', ['agents', 'browser'])
    expect(L.focusedPane(l).module).toBe('agents')
    l = L.show(l, 'browser') // on screen: its pane gets the focus
    expect(l.focus).toBe('p2')
    expect(modules(l)).toEqual(['agents', 'browser'])
    l = L.show(l, 'editor') // not on screen: the focused pane shows it
    expect(modules(l)).toEqual(['agents', 'editor'])
    l = L.place(l, 'p2', 'agents') // already in p1: the panes swap
    expect(modules(l)).toEqual(['editor', 'agents'])
    expect(l.focus).toBe('p2')
    expect(L.place(l, 'nope', 'core')).toBe(l)
    expect(L.place(l, 'p2', 'agents').panes).toEqual(l.panes) // already there

    // maximized: the module comes into the maximized pane
    l = L.toggleMaximize(l, 'p1')
    expect(L.visiblePanes(l).map((p) => p.id)).toEqual(['p1'])
    l = L.show(l, 'agents')
    expect(modules(l)).toEqual(['agents', 'editor'])
    expect(l.maximized).toBe('p1')
  })

  it('focuses panes; a maximized workspace flips along', () => {
    let l = L.makeLayout('columns', ['agents', 'browser'])
    expect(L.focus(l, 'p1')).toBe(l) // already
    expect(L.focus(l, 'zz')).toBe(l) // unknown
    l = L.focus(l, 'p2')
    expect(l.focus).toBe('p2')
    l = L.toggleMaximize(l)
    expect(l.maximized).toBe('p2')
    l = L.focus(l, 'p1')
    expect(l).toMatchObject({ focus: 'p1', maximized: 'p1' })
    expect(L.focusedPane({ ...l, focus: 'gone' }).id).toBe('p1')
  })

  it('splits up to four panes and closes down to one', () => {
    let l = L.singleLayout('core')
    l = L.split(l)
    expect(l.preset).toBe('columns')
    expect(modules(l)).toEqual(['core', 'terminal'])
    expect(l.focus).toBe('p2')
    l = L.focus(l, 'p1')
    l = L.split(l) // next to the focused pane
    expect(l.preset).toBe('main')
    expect(modules(l)).toEqual(['core', 'browser', 'terminal'])
    l = L.split(l)
    expect(l.preset).toBe('grid')
    expect(modules(l)).toEqual(['core', 'browser', 'editor', 'terminal'])
    expect(L.split(l)).toBe(l) // four at most

    const max = L.toggleMaximize(l, 'p4')
    l = L.close(max, 'p4') // the maximized one: the rest come back
    expect(l.preset).toBe('main')
    expect(l.maximized).toBeUndefined()
    expect(l.focus).toBe('p3') // its neighbour
    l = L.close(l, 'p1') // not the focused one: the focus stays
    expect(l).toMatchObject({ preset: 'columns', focus: 'p3' })
    expect(modules(l)).toEqual(['browser', 'terminal'])
    l = L.close(l, 'p2')
    expect(l.focus).toBe('p3')
    l = L.close(l)
    expect(l).toMatchObject({ preset: 'single', focus: 'p3' })
    expect(L.close(l)).toBe(l) // the last pane stays
    expect(L.close(L.makeLayout('rows', ['core']), 'nope').preset).toBe('rows')
    expect(L.close(L.makeLayout('rows', ['core']), 'p1')).toMatchObject({ preset: 'single', focus: 'p2' })
  })

  it('switches presets, keeping the focused pane', () => {
    let l = L.makeLayout('grid', ['core', 'editor', 'terminal', 'browser'])
    l = L.focus(l, 'p4')
    const two = L.setPreset(l, 'rows')
    expect(two.panes.map((p) => p.id)).toEqual(['p1', 'p4'])
    expect(two.focus).toBe('p4')
    expect(two.sizes).toEqual(L.DEFAULT_SIZES.rows)
    const one = L.setPreset(two, 'single')
    expect(modules(one)).toEqual(['browser'])
    const grown = L.setPreset(one, 'grid')
    expect(modules(grown)).toEqual(['browser', 'terminal', 'editor', 'agents'])
    const resized = L.resize(grown, 'x', 0.7)
    expect(L.setPreset(resized, 'grid').sizes.x).toBe(0.7) // the same preset keeps its sizes
    expect(L.resize(grown, 'y', 2).sizes.y).toBe(0.9)
    expect(L.resize(grown, 'y', -1).sizes.y).toBe(0.1)
  })

  it('maximizes and restores', () => {
    const one = L.singleLayout('core')
    expect(L.toggleMaximize(one)).toBe(one) // nothing to maximize
    const two = L.makeLayout('columns', ['core', 'editor'])
    expect(L.toggleMaximize(two, 'nope')).toBe(two)
    const max = L.toggleMaximize(two, 'p2')
    expect(max).toMatchObject({ maximized: 'p2', focus: 'p2' })
    expect(L.toggleMaximize(max).maximized).toBeUndefined()
  })

  it('moves the focus to the nearest pane in a direction', () => {
    const grid = L.makeLayout('grid', ['core', 'editor', 'terminal', 'browser'])
    const at = (l: L.Layout) => L.focusedPane(l).module
    expect(at(L.moveFocus(grid, 'right'))).toBe('editor')
    expect(at(L.moveFocus(grid, 'down'))).toBe('terminal')
    expect(L.moveFocus(grid, 'left')).toBe(grid) // nothing there
    expect(L.moveFocus(grid, 'up')).toBe(grid)
    const br = L.focus(grid, 'p4')
    expect(at(L.moveFocus(br, 'left'))).toBe('terminal')
    expect(at(L.moveFocus(br, 'up'))).toBe('editor')

    const main = L.makeLayout('main', ['editor', 'terminal', 'browser'])
    expect(at(L.moveFocus(main, 'right'))).toBe('terminal') // a tie: the first
    const bottom = L.focus(main, 'p3')
    expect(at(L.moveFocus(bottom, 'left'))).toBe('editor')
    expect(at(L.moveFocus(bottom, 'up'))).toBe('terminal')
    expect(at(L.moveFocus(L.makeLayout('rows', ['core', 'files']), 'down'))).toBe('files')
  })

  it('reads stored layouts — and only valid ones', () => {
    const good = L.makeLayout('columns', ['agents', 'browser'])
    expect(L.parseLayout(JSON.parse(JSON.stringify(good)))).toEqual(good)
    expect(L.parseLayout({ ...good, focus: 'p2', maximized: 'p2', extra: 1 })).toEqual({ ...good, focus: 'p2', maximized: 'p2' })
    expect(L.parseLayout({ ...good, maximized: 'p2', focus: 'p1' })).toMatchObject({ focus: 'p2' }) // the maximized pane has the focus
    expect(L.parseLayout({ ...good, focus: 'gone', maximized: 'gone' })).toEqual({ ...good, focus: 'p1' })
    expect(L.parseLayout({ ...good, sizes: { x: 0.01, y: 0.5 } })!.sizes).toEqual(L.DEFAULT_SIZES.columns)
    expect(L.parseLayout({ ...good, sizes: 'big' })!.sizes).toEqual(L.DEFAULT_SIZES.columns)
    expect(L.parseLayout({ ...good, sizes: { x: 0.3, y: 'a' } })!.sizes).toEqual(L.DEFAULT_SIZES.columns)
    expect(L.parseLayout({ ...L.singleLayout('core'), maximized: 'p1' })!.maximized).toBeUndefined() // one pane: nothing to maximize
    for (const bad of [
      null,
      'x',
      [],
      { ...good, preset: 'triple' },
      { ...good, panes: 'x' },
      { ...good, panes: [good.panes[0]] },
      { ...good, panes: [good.panes[0], { id: 'p2', module: 'nope' }] },
      { ...good, panes: [good.panes[0], { id: '', module: 'files' }] },
      { ...good, panes: [good.panes[0], { id: 'x'.repeat(41), module: 'files' }] },
      { ...good, panes: [good.panes[0], { id: 7, module: 'files' }] },
      { ...good, panes: [good.panes[0], null] },
      { ...good, panes: [good.panes[0], { id: 'p1', module: 'files' }] },
      { ...good, panes: [good.panes[0], { id: 'p2', module: 'agents' }] }
    ])
      expect(L.parseLayout(bad)).toBeNull()
  })
})

describe('opening beside a pane', () => {
  const single = L.singleLayout('agents')

  it('knows the edges a new pane can open on — where a layout draws that split', () => {
    expect(L.dropSides(single, 'p1')).toEqual(['left', 'right', 'top', 'bottom'])
    expect(L.dropSides(single, 'nope')).toEqual([])
    const columns = L.makeLayout('columns', ['agents', 'browser'])
    expect(L.dropSides(columns, 'p1')).toEqual([]) // no mirrored "one large, two small"
    expect(L.dropSides(columns, 'p2')).toEqual(['top', 'bottom'])
    expect(L.dropSides(L.makeLayout('rows', ['agents', 'browser']), 'p1')).toEqual([])
    const main = L.makeLayout('main', ['agents', 'browser', 'editor'])
    expect(L.dropSides(main, 'p1')).toEqual(['top', 'bottom'])
    expect(L.dropSides(main, 'p2')).toEqual([])
    expect(L.dropSides(L.makeLayout('grid', []), 'p1')).toEqual([])
    expect(L.dropSides(L.toggleMaximize(columns, 'p2'), 'p2')).toEqual([]) // maximized: only into the pane
  })

  it('opens a module on any side of a single pane, focused', () => {
    const at = (side: L.Side) => L.dropBeside(single, 'p1', side, 'browser')
    expect(at('left')).toMatchObject({ preset: 'columns', panes: [{ id: 'p2', module: 'browser' }, { id: 'p1', module: 'agents' }], focus: 'p2' })
    expect(modules(at('right'))).toEqual(['agents', 'browser'])
    expect(at('top')).toMatchObject({ preset: 'rows' })
    expect(modules(at('top'))).toEqual(['browser', 'agents'])
    expect(modules(at('bottom'))).toEqual(['agents', 'browser'])
    expect(at('bottom').sizes).toEqual(L.DEFAULT_SIZES.rows)
  })

  it('stacks into the right column, then into the large pane — the left column keeps its width', () => {
    const columns = { ...L.makeLayout('columns', ['agents', 'browser']), sizes: { x: 0.4, y: 0.5 } }
    const top = L.dropBeside(columns, 'p2', 'top', 'editor')
    expect(top).toMatchObject({ preset: 'main', sizes: { x: 0.4, y: 0.5 }, focus: 'p3' })
    expect(modules(top)).toEqual(['agents', 'editor', 'browser'])
    expect(modules(L.dropBeside(columns, 'p2', 'bottom', 'editor'))).toEqual(['agents', 'browser', 'editor'])

    const main = L.makeLayout('main', ['agents', 'browser', 'editor'])
    const above = L.dropBeside(main, 'p1', 'top', 'terminal')
    expect(above).toMatchObject({ preset: 'grid', focus: 'p4', sizes: { x: main.sizes.x, y: 0.5 } })
    expect(modules(above)).toEqual(['terminal', 'browser', 'agents', 'editor'])
    expect(modules(L.dropBeside(main, 'p1', 'bottom', 'terminal'))).toEqual(['agents', 'browser', 'terminal', 'editor'])
  })

  it('leaves the layout as it is where that side has no split, or the module is on screen already', () => {
    const columns = L.makeLayout('columns', ['agents', 'browser'])
    expect(L.dropBeside(columns, 'p1', 'top', 'editor')).toBe(columns)
    expect(L.dropBeside(columns, 'p2', 'left', 'editor')).toBe(columns)
    expect(L.dropBeside(single, 'p1', 'left', 'agents')).toBe(single)
  })

  it('opens a module next to the focused pane: right, else below, else as a further pane, else in it', () => {
    expect(modules(L.openBeside(single, 'browser'))).toEqual(['agents', 'browser'])
    expect(L.openBeside(single, 'browser').preset).toBe('columns')
    const columns = L.makeLayout('columns', ['agents', 'browser'])
    const below = L.openBeside(L.focus(columns, 'p2'), 'editor')
    expect(below.preset).toBe('main')
    expect(modules(below)).toEqual(['agents', 'browser', 'editor'])
    // The left pane of two has no split of its own: a further pane, after it.
    const further = L.openBeside(columns, 'editor')
    expect(further).toMatchObject({ preset: 'main', focus: 'p3' })
    expect(modules(further)).toEqual(['agents', 'editor', 'browser'])
    // Four panes: the focused one shows it.
    const grid = L.makeLayout('grid', ['agents', 'browser', 'editor', 'files'])
    expect(modules(L.openBeside(grid, 'memory'))).toEqual(['memory', 'browser', 'editor', 'files'])
  })

  it('focuses a module that is on screen already — a maximized pane steps back first', () => {
    const columns = L.makeLayout('columns', ['agents', 'browser'])
    expect(L.openBeside(columns, 'agents')).toBe(columns)
    expect(L.openBeside(columns, 'browser')).toMatchObject({ focus: 'p2', panes: columns.panes })
    const maximized = L.toggleMaximize(columns, 'p1')
    expect(L.openBeside(maximized, 'browser')).toMatchObject({ focus: 'p2', maximized: undefined })
    expect(L.openBeside(maximized, 'agents')).toMatchObject({ focus: 'p1', maximized: undefined })
    expect(modules(L.openBeside(maximized, 'editor'))).toEqual(['agents', 'editor', 'browser'])
  })

  it('reveals a module without taking the focus: beside the focused pane, else in the last other one', () => {
    const beside = L.reveal(single, 'terminal')
    expect(beside).toMatchObject({ preset: 'columns', focus: 'p1' })
    expect(modules(beside)).toEqual(['agents', 'terminal'])
    const columns = L.makeLayout('columns', ['agents', 'browser'])
    expect(L.reveal(columns, 'browser')).toBe(columns) // on screen: nothing moves, the focus stays
    const three = L.reveal(columns, 'terminal')
    expect(three).toMatchObject({ preset: 'main', focus: 'p1' })
    expect(modules(three)).toEqual(['agents', 'terminal', 'browser'])
    // Four panes: the last one that has no focus shows it.
    const grid = L.makeLayout('grid', ['agents', 'browser', 'editor', 'files'])
    expect(L.reveal(grid, 'terminal')).toMatchObject({ focus: 'p1' })
    expect(modules(L.reveal(grid, 'terminal'))).toEqual(['agents', 'browser', 'editor', 'terminal'])
    expect(modules(L.reveal(L.focus(grid, 'p4'), 'terminal'))).toEqual(['agents', 'browser', 'terminal', 'files'])
    // A maximized pane steps back so the other one is seen; the focus stays.
    const maximized = L.toggleMaximize(L.makeLayout('columns', ['agents', 'terminal']), 'p1')
    expect(L.reveal(maximized, 'terminal')).toMatchObject({ focus: 'p1', maximized: undefined })
    expect(L.reveal(maximized, 'agents')).toBe(maximized)
  })
})

describe('workspace keys', () => {
  const key = (k: Partial<KeyLike>): KeyLike => ({ key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...k })

  it('reads the Mac keys by their place', () => {
    const mac = (k: Partial<KeyLike>) => matchWorkspaceKey(key(k), true)
    expect(mac({ key: 'ArrowLeft', metaKey: true, altKey: true })).toEqual({ type: 'focus', dir: 'left' })
    expect(mac({ key: 'ArrowDown', metaKey: true, altKey: true })).toEqual({ type: 'focus', dir: 'down' })
    expect(mac({ key: '¡', code: 'Digit1', metaKey: true, altKey: true })).toEqual({ type: 'workspace', index: 0 })
    expect(mac({ key: 'ª', code: 'Digit9', metaKey: true, altKey: true })).toEqual({ type: 'workspace', index: 8 })
    expect(mac({ key: 'º', code: 'Digit0', metaKey: true, altKey: true })).toBeNull()
    expect(mac({ key: 'Ω', code: 'KeyZ', metaKey: true, altKey: true })).toEqual({ type: 'zen' })
    expect(mac({ key: 'å', code: 'KeyA', metaKey: true, altKey: true })).toBeNull()
    expect(mac({ key: 'Enter', metaKey: true, shiftKey: true })).toEqual({ type: 'maximize' })
    expect(mac({ key: 'W', code: 'KeyW', metaKey: true, shiftKey: true })).toEqual({ type: 'close' })
    expect(mac({ key: 'T', code: 'KeyT', metaKey: true, shiftKey: true })).toBeNull()
    expect(mac({ key: '\\', code: 'Backslash', metaKey: true })).toEqual({ type: 'split' })
    expect(mac({ key: 'f', code: 'KeyF', metaKey: true, ctrlKey: true })).toBeNull() // full screen: the main process's
    expect(mac({ key: 'f', code: 'KeyF', metaKey: true })).toBeNull() // ⌘F is find
    expect(mac({ key: 'F11' })).toBeNull()
    expect(mac({ key: '\\', ctrlKey: true })).toBeNull() // Ctrl is not ⌘ on a Mac
    expect(mac({ key: '\\', metaKey: true, altKey: true, shiftKey: true })).toBeNull()
  })

  it('elsewhere reads Ctrl, and never a key AltGr types', () => {
    expect(isCloseKey(key({ key: 'w', metaKey: true }), true)).toBe(true)
    expect(isCloseKey(key({ key: 'w', ctrlKey: true }), true)).toBe(false)
    expect(isCloseKey(key({ key: 'W', ctrlKey: true }), false)).toBe(true)
    expect(isCloseKey(key({ key: 'w', ctrlKey: true, shiftKey: true }), false)).toBe(false) // the pane key ⇧
    expect(isCloseKey(key({ key: 'q', ctrlKey: true }), false)).toBe(false)
    const pc = (k: Partial<KeyLike>) => matchWorkspaceKey(key(k), false)
    expect(pc({ key: 'F11' })).toBeNull() // full screen: the main process's, or the browser's
    expect(pc({ key: 'ArrowUp', ctrlKey: true, altKey: true })).toEqual({ type: 'focus', dir: 'up' })
    expect(pc({ key: '3', code: 'Digit3', ctrlKey: true, altKey: true })).toEqual({ type: 'workspace', index: 2 })
    expect(pc({ key: '³', code: 'Digit3', ctrlKey: true, altKey: true })).toBeNull() // a character: AltGr+3
    expect(pc({ key: 'z', ctrlKey: true, altKey: true })).toEqual({ type: 'zen' })
    expect(pc({ key: 'z', ctrlKey: true, altKey: true, getModifierState: (k) => k === 'AltGraph' })).toBeNull()
    expect(pc({ key: 'Enter', ctrlKey: true, shiftKey: true })).toEqual({ type: 'maximize' })
    expect(pc({ key: 'W', ctrlKey: true, shiftKey: true })).toEqual({ type: 'close' })
    expect(pc({ key: '\\', ctrlKey: true })).toEqual({ type: 'split' })
    expect(pc({ key: '\\', metaKey: true })).toBeNull()
    expect(pc({ key: 'x', ctrlKey: true })).toBeNull()
  })

  it('labels the keys for both', () => {
    expect(keyLabel('split', true)).toBe('⌘\\')
    expect(keyLabel('fullscreen', false)).toBe('F11')
    expect(workspaceKey(0, true)).toBe('⌥⌘1')
    expect(workspaceKey(8, false)).toBe('Ctrl+Alt+9')
    expect(workspaceKey(9, true)).toBeUndefined()
    expect(keyLabel('zen')).toBe(macKeys() ? '⌥⌘Z' : 'Ctrl+Alt+Z')
    expect(workspaceKey(1)).toBe(macKeys() ? '⌥⌘2' : 'Ctrl+Alt+2')
  })

  it('knows a Mac by the app’s platform, or the browser’s', () => {
    const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform')!
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    expect(macKeys()).toBe(true)
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
    expect(macKeys()).toBe(false)
    ;(window as unknown as { mindeck: { platform: string } }).mindeck = { platform: 'darwin' }
    expect(macKeys()).toBe(true)
    ;(window as unknown as { mindeck: { platform: string } }).mindeck = { platform: 'linux' }
    expect(macKeys()).toBe(false)
    Reflect.deleteProperty(navigator, 'platform')
    Object.defineProperty(Navigator.prototype, 'platform', platform)
  })
})

describe('pane steps', () => {
  it('names the widths a pane reaches', () => {
    expect(paneSteps(0)).toBe('')
    expect(paneSteps(PANE_STEPS.md)).toBe('sm md')
    expect(paneSteps(5000)).toBe('sm md lg xl 2xl')
  })
})
