import { useEffect, useRef } from 'react'
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from 'd3-force'
import { Maximize2 } from 'lucide-react'
import { GRAPH_COLORS, type GraphNode, type GraphStyle, type MemoryGraph } from '@shared/types/memory'
import { useT } from '@/lib/i18n'
import { APPEARANCE_ATTRIBUTES } from '@/lib/theme'
import { TechLabel } from '@/components/ui/TechLabel'

interface SimNode extends SimulationNodeDatum, GraphNode {
  r: number
}
type SimLink = SimulationLinkDatum<SimNode>

interface Props {
  graph: MemoryGraph
  style: GraphStyle
  /** folder → palette slot (shared with the note list). */
  folderSlots: Map<string, number>
  activeId?: string
  onOpen: (path: string) => void
  onOpenGhost: (title: string) => void
}

const cssRgb = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Slot → CSS color for legends/lists (keeps DOM and canvas colors identical). */
export function slotColor(slot: number): string {
  return `rgb(var(--graph-${GRAPH_COLORS[slot % GRAPH_COLORS.length]}))`
}

/** Until the canvas is set up there is nothing to draw or fit. */
const noop = () => {}

/**
 * Obsidian-style force-directed graph on a canvas. Nodes are notes (ghosts =
 * unresolved links), edges are wikilinks. Wheel zooms around the cursor, drag
 * pans or moves a node, hover highlights neighbors, click opens. Positions
 * survive graph refreshes so saving a note doesn't reshuffle the layout.
 */
export function GraphView({ graph, style, folderSlots, activeId, onOpen, onOpenGhost }: Props) {
  const t = useT()
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const positions = useRef(new Map<string, { x: number; y: number }>())
  const camera = useRef<{ x: number; y: number; k: number } | null>(null)
  const props = useRef({ style, folderSlots, activeId, onOpen, onOpenGhost })
  const redraw = useRef<() => void>(noop)
  const fit = useRef<() => void>(noop)

  props.current = { style, folderSlots, activeId, onOpen, onOpenGhost }
  useEffect(() => redraw.current(), [style, folderSlots, activeId])

  useEffect(() => {
    const canvas = canvasRef.current!
    const wrap = wrapRef.current!
    const ctx = canvas.getContext('2d')!

    const nodes: SimNode[] = graph.nodes.map((n) => {
      const prev = positions.current.get(n.id)
      return { ...n, r: (n.ghost ? 3 : 4) + Math.sqrt(n.degree) * 1.7, x: prev?.x, y: prev?.y }
    })
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const links: SimLink[] = graph.edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }))
    const neighbors = new Map<string, Set<string>>()
    for (const e of graph.edges) {
      if (!neighbors.has(e.source)) neighbors.set(e.source, new Set())
      if (!neighbors.has(e.target)) neighbors.set(e.target, new Set())
      neighbors.get(e.source)!.add(e.target)
      neighbors.get(e.target)!.add(e.source)
    }

    // Checked before forceSimulation(), which assigns every missing position.
    const fresh = nodes.some((n) => n.x === undefined)
    const sim: Simulation<SimNode, SimLink> = forceSimulation(nodes)
      .force('link', forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(85).strength(0.5))
      .force('charge', forceManyBody().strength(-170))
      .force('x', forceX(0).strength(0.05))
      .force('y', forceY(0).strength(0.05))
      .force('collide', forceCollide<SimNode>((d) => d.r + 6))
      .stop()

    sim.alpha(fresh ? 1 : 0.15)
    if (fresh) sim.tick(reducedMotion() ? 300 : 120) // open already laid out

    let width = 0
    let height = 0
    let hovered: SimNode | null = null
    let palette: string[] = []
    let muted = ''
    let edge = ''
    let label = ''
    let labelStrong = ''
    let glow = 1
    const readColors = () => {
      palette = GRAPH_COLORS.map((c) => cssRgb(`--graph-${c}`))
      muted = cssRgb('--text-muted')
      edge = cssRgb('--border-hud-strong')
      label = cssRgb('--text-secondary')
      labelStrong = cssRgb('--text-primary')
      glow = Number.parseFloat(cssRgb('--glow')) || 0
    }
    readColors()

    const colorOf = (n: SimNode) => {
      if (n.ghost) return muted
      const { style: s, folderSlots: slots } = props.current
      if (s.mode === 'single') return palette[GRAPH_COLORS.indexOf(s.color)] ?? palette[0]
      return palette[(slots.get(n.folder) ?? 0) % palette.length]
    }

    const doFit = () => {
      if (!nodes.length || !width) return
      const xs = nodes.map((n) => n.x!)
      const ys = nodes.map((n) => n.y!)
      const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
      const k = Math.min(width / (maxX - minX + 160), height / (maxY - minY + 160), 2.2)
      camera.current = { k, x: -((minX + maxX) / 2) * k, y: -((minY + maxY) / 2) * k }
      requestDraw()
    }

    const draw = () => {
      const cam = camera.current ?? { x: 0, y: 0, k: 1 }
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.translate(width / 2 + cam.x, height / 2 + cam.y)
      ctx.scale(cam.k, cam.k)

      const focus = hovered
      const near = focus ? neighbors.get(focus.id) : undefined
      const lit = (n: SimNode) => !focus || n === focus || !!near?.has(n.id)

      ctx.lineWidth = 1 / cam.k
      for (const l of links) {
        const s = l.source as SimNode
        const t = l.target as SimNode
        const on = focus && (s === focus || t === focus)
        ctx.strokeStyle = on ? `rgb(${colorOf(focus!)} / 0.85)` : `rgb(${edge} / ${focus ? 0.12 : 0.45})`
        ctx.beginPath()
        ctx.moveTo(s.x!, s.y!)
        ctx.lineTo(t.x!, t.y!)
        ctx.stroke()
      }

      const { activeId: active } = props.current
      for (const n of nodes) {
        const c = colorOf(n)
        ctx.globalAlpha = lit(n) ? 1 : 0.18
        ctx.beginPath()
        ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2)
        if (n.ghost) {
          ctx.strokeStyle = `rgb(${c})`
          ctx.lineWidth = 1.2 / cam.k
          ctx.stroke()
        } else {
          ctx.shadowColor = `rgb(${c} / 0.7)`
          ctx.shadowBlur = (n === focus ? 18 : 6) * glow
          ctx.fillStyle = `rgb(${c})`
          ctx.fill()
          ctx.shadowBlur = 0
        }
        if (n.id === active) {
          ctx.beginPath()
          ctx.arc(n.x!, n.y!, n.r + 4 / cam.k + 2, 0, Math.PI * 2)
          ctx.strokeStyle = `rgb(${c} / 0.9)`
          ctx.lineWidth = 1.5 / cam.k
          ctx.stroke()
        }
      }

      // Labels fade in with zoom; focus, neighbors and the open note always show.
      const zoomAlpha = Math.max(0, Math.min(1, (cam.k - 0.6) / 0.5))
      ctx.font = `${11 / Math.max(cam.k, 0.6)}px Inter Variable, Inter, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      for (const n of nodes) {
        const forced = n === focus || near?.has(n.id) || n.id === active
        const a = forced ? 1 : focus ? 0 : zoomAlpha
        if (a <= 0.02) continue
        ctx.globalAlpha = a
        ctx.fillStyle = `rgb(${n === focus ? labelStrong : label})`
        ctx.fillText(n.title, n.x!, n.y! + n.r + 4 / cam.k)
      }
      ctx.globalAlpha = 1
    }

    let frame = 0
    const requestDraw = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        draw()
      })
    }
    redraw.current = requestDraw
    fit.current = doFit

    const resize = () => {
      const rect = wrap.getBoundingClientRect()
      width = rect.width
      height = rect.height
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      if (!camera.current) doFit()
      requestDraw()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)
    resize()

    sim.on('tick', () => {
      for (const n of nodes) positions.current.set(n.id, { x: n.x!, y: n.y! })
      requestDraw()
    })
    if (!reducedMotion()) sim.restart()
    for (const n of nodes) positions.current.set(n.id, { x: n.x!, y: n.y! })

    // Repaint when the theme (and with it the CSS palette) changes.
    const mo = new MutationObserver(() => {
      readColors()
      requestDraw()
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: APPEARANCE_ATTRIBUTES })

    // --- interaction -------------------------------------------------------
    const toWorld = (ev: PointerEvent | WheelEvent) => {
      const cam = camera.current ?? { x: 0, y: 0, k: 1 }
      const rect = canvas.getBoundingClientRect()
      return {
        x: (ev.clientX - rect.left - width / 2 - cam.x) / cam.k,
        y: (ev.clientY - rect.top - height / 2 - cam.y) / cam.k
      }
    }
    const hit = (ev: PointerEvent) => {
      const p = toWorld(ev)
      const k = camera.current?.k ?? 1
      let best: SimNode | null = null
      let bestD = Infinity
      for (const n of nodes) {
        const d = Math.hypot(n.x! - p.x, n.y! - p.y)
        if (d < n.r + 5 / k && d < bestD) {
          best = n
          bestD = d
        }
      }
      return best
    }

    let drag: { node: SimNode | null; sx: number; sy: number; moved: boolean } | null = null

    const onDown = (ev: PointerEvent) => {
      canvas.setPointerCapture(ev.pointerId)
      const node = hit(ev)
      drag = { node, sx: ev.clientX, sy: ev.clientY, moved: false }
      if (node) {
        node.fx = node.x
        node.fy = node.y
        sim.alphaTarget(0.25).restart()
      }
    }
    const onMove = (ev: PointerEvent) => {
      if (!drag) {
        const h = hit(ev)
        if (h !== hovered) {
          hovered = h
          canvas.style.cursor = h ? 'pointer' : 'grab'
          requestDraw()
        }
        return
      }
      if (Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) > 3) drag.moved = true
      if (drag.node) {
        const p = toWorld(ev)
        drag.node.fx = p.x
        drag.node.fy = p.y
      } else if (camera.current) {
        camera.current.x += ev.movementX
        camera.current.y += ev.movementY
        canvas.style.cursor = 'grabbing'
        requestDraw()
      }
    }
    const onUp = () => {
      if (!drag) return
      const { node, moved } = drag
      drag = null
      canvas.style.cursor = hovered ? 'pointer' : 'grab'
      if (node) {
        node.fx = null
        node.fy = null
        sim.alphaTarget(0)
        if (reducedMotion()) sim.stop()
        if (!moved) {
          if (node.ghost) props.current.onOpenGhost(node.title)
          else props.current.onOpen(node.id)
        }
      }
    }
    const onLeave = () => {
      if (drag) return
      hovered = null
      requestDraw()
    }
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const cam = camera.current
      if (!cam) return
      const p = toWorld(ev)
      const k = Math.max(0.15, Math.min(4, cam.k * Math.exp(-ev.deltaY * 0.0015)))
      cam.x += p.x * (cam.k - k)
      cam.y += p.y * (cam.k - k)
      cam.k = k
      requestDraw()
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.style.cursor = 'grab'

    return () => {
      sim.stop()
      ro.disconnect()
      mo.disconnect()
      cancelAnimationFrame(frame)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [graph])

  const legend =
    style.mode === 'colorful'
      ? [...folderSlots.entries()].filter(([folder]) => graph.nodes.some((n) => !n.ghost && n.folder === folder))
      : []

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 touch-none" />

      {graph.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="font-mono text-[12px] text-text-muted">{t.memory.noNotes}</p>
        </div>
      )}

      {legend.length > 0 && (
        <div className="pointer-events-none absolute bottom-3 left-3 space-y-1 rounded-md border border-hud/50 bg-surface/70 px-2.5 py-2 backdrop-blur-xs">
          {legend.map(([folder, slot]) => (
            <div key={folder || '.'} className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ background: slotColor(slot) }} />
              <span className="font-mono text-[10px] text-text-secondary">{folder || t.memory.vaultRoot}</span>
            </div>
          ))}
        </div>
      )}

      <div className="absolute bottom-3 right-3 flex items-center gap-2">
        <TechLabel className="hidden text-text-muted sm:inline">
          {t.memory.graphStats(graph.nodes.filter((n) => !n.ghost).length, graph.edges.length)}
        </TechLabel>
        <button
          type="button"
          title={t.memory.fit}
          onClick={() => fit.current()}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-hud/60 bg-surface/70 text-text-muted transition-colors hover:border-cyan/50 hover:text-cyan"
        >
          <Maximize2 size={13} />
        </button>
      </div>
    </div>
  )
}
