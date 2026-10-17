import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphStyle, MemoryGraph } from '@shared/types/memory'

import { GraphView, slotColor } from '@/features/memory/components/GraphView'

/** A 2D context that records every call with its arguments. */
type Call = { fn: string; args: unknown[] }
let calls: Call[] = []
const W = 400
const H = 300

beforeEach(() => {
  calls = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      new Proxy(
        {},
        {
          get: (_t, key) => (...args: unknown[]) => calls.push({ fn: String(key), args }),
          set: () => true
        }
      ) as never
  )
  ;(HTMLCanvasElement.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = vi.fn()
  ;(globalThis as { matchMediaMatches: Record<string, boolean> }).matchMediaMatches['(prefers-reduced-motion: reduce)'] = true
})
afterEach(() => {
  document.documentElement.style.cssText = ''
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true })
})

const sized = (w = W, h = H) =>
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: w, height: h, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}) })

const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())))

/** Screen position of every node in the latest frame (from the recorded arcs). */
function screenPositions(graph: MemoryGraph) {
  const last = calls.map((c) => c.fn).lastIndexOf('translate')
  const [tx, ty] = calls[last].args as number[]
  const [k] = calls[last + 1].args as number[]
  const arcs = calls.slice(last).filter((c) => c.fn === 'arc')
  const r = (i: number) => (graph.nodes[i].ghost ? 3 : 4) + Math.sqrt(graph.nodes[i].degree) * 1.7
  const pos = new Map<string, { x: number; y: number }>()
  let i = 0
  for (const a of arcs) {
    if (i >= graph.nodes.length) break
    const [x, y, radius] = a.args as number[]
    if (Math.abs(radius - r(i)) > 1e-9) continue // the active-note ring
    pos.set(graph.nodes[i].id, { x: tx + x * k, y: ty + y * k })
    i += 1
  }
  return { pos, k }
}

const pointer = (type: string, init: Record<string, number>) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { pointerId: 1, movementX: 0, movementY: 0, ...init })

const graph: MemoryGraph = {
  nodes: [
    { id: 'A.md', title: 'A', folder: 'Ideen', ghost: false, degree: 2 },
    { id: 'B.md', title: 'B', folder: '', ghost: false, degree: 1 },
    { id: 'ghost:G', title: 'G', folder: '', ghost: true, degree: 1 },
    { id: 'C.md', title: 'C', folder: 'Other', ghost: false, degree: 0 }
  ],
  edges: [
    { source: 'A.md', target: 'B.md' },
    { source: 'A.md', target: 'ghost:G' },
    { source: 'A.md', target: 'missing' }, // dangling edge (no node) is dropped from links
    { source: 'missing', target: 'B.md' } // and one into a note linked already
  ]
}
const colorful: GraphStyle = { mode: 'colorful', color: 'cyan' }

describe('slotColor', () => {
  it('wraps around the palette', () => {
    expect(slotColor(0)).toBe('rgb(var(--graph-cyan))')
    expect(slotColor(9)).toBe('rgb(var(--graph-blue))')
  })
})

describe('GraphView', () => {
  it('empty graph: hint, no legend, fit is a no-op', async () => {
    sized()
    render(<GraphView graph={{ nodes: [], edges: [] }} style={colorful} folderSlots={new Map()} onOpen={vi.fn()} onOpenGhost={vi.fn()} />)
    expect(screen.getByText(/No notes yet/)).toBeInTheDocument()
    expect(screen.getByText('0 notes · 0 links')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Fit to view'))
    await nextFrame()
  })

  it('draws, legends only folders that have notes, and opens notes / ghosts on click', async () => {
    sized()
    document.documentElement.style.setProperty('--glow', '0.5')
    const onOpen = vi.fn()
    const onOpenGhost = vi.fn()
    const slots = new Map([
      ['Ideen', 1],
      ['Empty', 2],
      ['', 0]
    ])
    render(<GraphView graph={graph} style={colorful} folderSlots={slots} activeId="B.md" onOpen={onOpen} onOpenGhost={onOpenGhost} />)
    await nextFrame()
    expect(screen.getByText('3 notes · 4 links')).toBeInTheDocument()
    expect(screen.getByText('Ideen')).toBeInTheDocument()
    expect(screen.getByText('Vault root')).toBeInTheDocument()
    expect(screen.queryByText('Empty')).toBeNull()

    const canvas = document.querySelector('canvas')!
    expect(canvas.width).toBe(W)
    const { pos } = screenPositions(graph)

    // click (no movement) on a note → open; on a ghost → create
    const a = pos.get('A.md')!
    act(() => {
      canvas.dispatchEvent(pointer('pointerdown', { clientX: a.x, clientY: a.y }))
      canvas.dispatchEvent(pointer('pointerup', {}))
    })
    expect(onOpen).toHaveBeenCalledWith('A.md')
    const g = pos.get('ghost:G')!
    act(() => {
      canvas.dispatchEvent(pointer('pointerdown', { clientX: g.x, clientY: g.y }))
      canvas.dispatchEvent(pointer('pointerup', {}))
    })
    expect(onOpenGhost).toHaveBeenCalledWith('G')
    // a hand that shakes a little (3 px) still clicks
    act(() => {
      canvas.dispatchEvent(pointer('pointerdown', { clientX: a.x, clientY: a.y }))
      canvas.dispatchEvent(pointer('pointermove', { clientX: a.x + 2, clientY: a.y + 2 }))
      canvas.dispatchEvent(pointer('pointerup', {}))
    })
    expect(onOpen).toHaveBeenCalledTimes(2)

    // dragging a node moves it instead of opening
    act(() => {
      canvas.dispatchEvent(pointer('pointerdown', { clientX: a.x, clientY: a.y }))
      canvas.dispatchEvent(pointer('pointermove', { clientX: a.x + 40, clientY: a.y + 40 }))
      canvas.dispatchEvent(pointer('pointercancel', {}))
    })
    expect(onOpen).toHaveBeenCalledTimes(2)
    act(() => canvas.dispatchEvent(pointer('pointerup', {}))) // no drag in progress → ignored
  })

  it('hover highlights neighbours; panning, zooming and leaving repaint', async () => {
    sized()
    Object.defineProperty(window, 'devicePixelRatio', { value: 0, configurable: true }) // falls back to 1
    render(<GraphView graph={graph} style={colorful} folderSlots={new Map()} onOpen={vi.fn()} onOpenGhost={vi.fn()} />)
    await nextFrame()
    const canvas = document.querySelector('canvas')!
    const { pos } = screenPositions(graph)
    const a = pos.get('A.md')!
    const c = pos.get('C.md')!

    act(() => canvas.dispatchEvent(pointer('pointermove', { clientX: a.x, clientY: a.y })))
    expect(canvas.style.cursor).toBe('pointer')
    act(() => canvas.dispatchEvent(pointer('pointermove', { clientX: a.x, clientY: a.y }))) // same node → no repaint
    await nextFrame()
    act(() => canvas.dispatchEvent(pointer('pointermove', { clientX: c.x, clientY: c.y }))) // isolated node
    await nextFrame()
    act(() => canvas.dispatchEvent(pointer('pointermove', { clientX: -500, clientY: -500 })))
    expect(canvas.style.cursor).toBe('grab')

    // pan the background
    const before = calls.filter((x) => x.fn === 'translate').length
    act(() => {
      canvas.dispatchEvent(pointer('pointerdown', { clientX: -500, clientY: -500 }))
      canvas.dispatchEvent(pointer('pointermove', { clientX: -400, clientY: -500, movementX: 100 }))
    })
    expect(canvas.style.cursor).toBe('grabbing')
    act(() => canvas.dispatchEvent(pointer('pointerleave', {}))) // ignored while dragging
    act(() => canvas.dispatchEvent(pointer('pointerup', {})))
    expect(canvas.style.cursor).toBe('grab')
    await nextFrame()
    expect(calls.filter((x) => x.fn === 'translate').length).toBeGreaterThan(before)

    // a hovered node keeps the pointer cursor after a drag ends
    act(() => {
      canvas.dispatchEvent(pointer('pointermove', { clientX: c.x - 100, clientY: c.y }))
    })
    const now = screenPositions(graph).pos.get('C.md')!
    act(() => {
      canvas.dispatchEvent(pointer('pointermove', { clientX: now.x, clientY: now.y }))
      canvas.dispatchEvent(pointer('pointerdown', { clientX: -900, clientY: -900 }))
      canvas.dispatchEvent(pointer('pointerup', {}))
    })
    expect(canvas.style.cursor).toBe('pointer')

    // wheel zooms (clamped) and leaving clears the hover
    act(() => {
      canvas.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { deltaY: -100000, clientX: 10, clientY: 10 }))
      canvas.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { deltaY: 100000, clientX: 10, clientY: 10 }))
      canvas.dispatchEvent(pointer('pointerleave', {}))
    })
    await nextFrame()
    const scales = calls.filter((x) => x.fn === 'scale').map((x) => x.args[0])
    expect(Math.min(...(scales as number[]))).toBeCloseTo(0.15)
  })

  it('without a size: no camera yet — draws and handles input with the identity view', async () => {
    sized(0, 0)
    const onOpen = vi.fn()
    render(<GraphView graph={graph} style={{ mode: 'single', color: 'pink' }} folderSlots={new Map()} onOpen={onOpen} onOpenGhost={vi.fn()} />)
    await nextFrame()
    expect(screen.queryByText('Vault root')).toBeNull() // single mode → no legend
    const canvas = document.querySelector('canvas')!
    expect(canvas.width).toBe(1)
    act(() => {
      canvas.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { deltaY: 10 })) // no camera → ignored
      canvas.dispatchEvent(pointer('pointermove', { clientX: 0, clientY: 0 }))
      canvas.dispatchEvent(pointer('pointerdown', { clientX: 5000, clientY: 5000 }))
      canvas.dispatchEvent(pointer('pointermove', { clientX: 5100, clientY: 5000, movementX: 100 })) // no camera → no pan
      canvas.dispatchEvent(pointer('pointerup', {}))
    })
    await nextFrame()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('style, active note and theme changes repaint; fit re-centres; positions survive refreshes', async () => {
    sized()
    const props = { folderSlots: new Map<string, number>(), onOpen: vi.fn(), onOpenGhost: vi.fn() }
    const { rerender, unmount } = render(<GraphView graph={graph} style={{ mode: 'single', color: 'bogus' as never }} {...props} />)
    await nextFrame()
    const frames = () => calls.filter((c) => c.fn === 'clearRect').length
    const first = frames()

    rerender(<GraphView graph={graph} style={colorful} activeId="A.md" {...props} />)
    await nextFrame()
    document.documentElement.setAttribute('data-theme', 'light')
    await act(async () => {})
    await nextFrame()
    fireEvent.click(screen.getByTitle('Fit to view'))
    await nextFrame()
    expect(frames()).toBeGreaterThan(first + 2)
    ;(globalThis as unknown as { FakeResizeObserver: { instances: { trigger(): void }[] } }).FakeResizeObserver.instances[0].trigger()
    await nextFrame()

    // a refreshed graph keeps known positions and starts from a low alpha
    const before = screenPositions(graph).pos.get('B.md')!
    const refreshed: MemoryGraph = { nodes: graph.nodes.map((n) => ({ ...n })), edges: graph.edges }
    rerender(<GraphView graph={refreshed} style={colorful} {...props} />)
    await nextFrame()
    const after = screenPositions(refreshed).pos.get('B.md')!
    expect(after.x).toBeCloseTo(before.x, 0)
    unmount()
  })

  it('animates with motion enabled (ticks update positions and repaint)', async () => {
    ;(globalThis as { matchMediaMatches: Record<string, boolean> }).matchMediaMatches = {}
    sized()
    const onOpen = vi.fn()
    render(<GraphView graph={graph} style={colorful} folderSlots={new Map()} onOpen={onOpen} onOpenGhost={vi.fn()} />)
    await act(() => new Promise((r) => setTimeout(r, 60)))
    await nextFrame()
    const canvas = document.querySelector('canvas')!
    const a = screenPositions(graph).pos.get('A.md')!
    act(() => {
      canvas.dispatchEvent(pointer('pointerdown', { clientX: a.x, clientY: a.y }))
      canvas.dispatchEvent(pointer('pointerup', {}))
    })
    expect(onOpen).toHaveBeenCalledWith('A.md')
  })
})
