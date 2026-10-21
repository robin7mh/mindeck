import type { ModuleId } from '@/types'

/**
 * The workspace: one to four panes side by side, each showing a module. Pure
 * functions over a plain `Layout` value — the store keeps it, the components
 * draw it, and nothing here knows about React or the DOM.
 */

/** The arrangements: one pane, two side by side, two stacked, one big + two, 2×2. */
export type Preset = 'single' | 'columns' | 'rows' | 'main' | 'grid'
export const PRESETS: Preset[] = ['single', 'columns', 'rows', 'main', 'grid']
export const SLOTS: Record<Preset, number> = { single: 1, columns: 2, rows: 2, main: 3, grid: 4 }

/** Every module a pane can show. Each one appears at most once: they all hang off app-wide stores. */
export const MODULES: ModuleId[] = ['core', 'editor', 'terminal', 'browser', 'files', 'projects', 'memory', 'agents', 'system', 'settings', 'account']

/** What a new pane shows: the first of these not on screen yet. */
const FILL: ModuleId[] = ['terminal', 'browser', 'editor', 'agents', 'files', 'memory', 'projects', 'core', 'system', 'settings']

export interface Pane {
  id: string
  module: ModuleId
}

/** Where the dividers sit, as fractions of the workspace: `x` the vertical one, `y` the horizontal one. */
export interface Sizes {
  x: number
  y: number
}

export interface Layout {
  preset: Preset
  /** In slot order; exactly `SLOTS[preset]` of them. */
  panes: Pane[]
  sizes: Sizes
  /** The pane the keyboard and the side navigation act on. */
  focus: string
  /** A pane that fills the workspace for now; the others wait hidden. */
  maximized?: string
}

/** A pane's place, as fractions of the workspace. */
export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** A divider: `key` is the size it moves; it runs across `from`…`to` of the other axis. */
export interface Divider {
  key: keyof Sizes
  at: number
  from: number
  to: number
}

export type Direction = 'left' | 'right' | 'up' | 'down'

/** Smallest pane, in CSS pixels — a divider stops there. */
export const MIN_WIDTH = 240
export const MIN_HEIGHT = 140
/** How far a divider may go when the workspace size is not known. */
const MIN_FRACTION = 0.1

export const DEFAULT_SIZES: Record<Preset, Sizes> = {
  single: { x: 0.5, y: 0.5 },
  columns: { x: 0.5, y: 0.5 },
  rows: { x: 0.5, y: 0.5 },
  main: { x: 0.6, y: 0.5 },
  grid: { x: 0.5, y: 0.5 }
}

const RECTS: Record<Preset, (s: Sizes) => Rect[]> = {
  single: () => [{ x0: 0, y0: 0, x1: 1, y1: 1 }],
  columns: ({ x }) => [
    { x0: 0, y0: 0, x1: x, y1: 1 },
    { x0: x, y0: 0, x1: 1, y1: 1 }
  ],
  rows: ({ y }) => [
    { x0: 0, y0: 0, x1: 1, y1: y },
    { x0: 0, y0: y, x1: 1, y1: 1 }
  ],
  main: ({ x, y }) => [
    { x0: 0, y0: 0, x1: x, y1: 1 },
    { x0: x, y0: 0, x1: 1, y1: y },
    { x0: x, y0: y, x1: 1, y1: 1 }
  ],
  grid: ({ x, y }) => [
    { x0: 0, y0: 0, x1: x, y1: y },
    { x0: x, y0: 0, x1: 1, y1: y },
    { x0: 0, y0: y, x1: x, y1: 1 },
    { x0: x, y0: y, x1: 1, y1: 1 }
  ]
}

const DIVIDERS: Record<Preset, (s: Sizes) => Divider[]> = {
  single: () => [],
  columns: ({ x }) => [{ key: 'x', at: x, from: 0, to: 1 }],
  rows: ({ y }) => [{ key: 'y', at: y, from: 0, to: 1 }],
  main: ({ x, y }) => [
    { key: 'x', at: x, from: 0, to: 1 },
    { key: 'y', at: y, from: x, to: 1 }
  ],
  grid: ({ x, y }) => [
    { key: 'x', at: x, from: 0, to: 1 },
    { key: 'y', at: y, from: 0, to: 1 }
  ]
}

/** Where the panes go, in slot order. */
export function slotRects(preset: Preset, sizes: Sizes): Rect[] {
  return RECTS[preset](sizes)
}

export function dividers(preset: Preset, sizes: Sizes): Divider[] {
  return DIVIDERS[preset](sizes)
}

/** A divider position that leaves both sides at least `min` pixels (the middle when there is no room for that). */
export function clampFraction(value: number, total: number, min: number): number {
  if (total <= 0) return Math.min(1 - MIN_FRACTION, Math.max(MIN_FRACTION, value))
  if (total < min * 2) return 0.5
  return Math.min(1 - min / total, Math.max(min / total, value))
}

/** The sizes as drawn in a workspace of `width`×`height`: no pane below its minimum. */
export function fitSizes(sizes: Sizes, width: number, height: number): Sizes {
  return { x: clampFraction(sizes.x, width, MIN_WIDTH), y: clampFraction(sizes.y, height, MIN_HEIGHT) }
}

/** The panes on screen: all of them, or the maximized one. */
export function visiblePanes(layout: Layout): Pane[] {
  return layout.maximized ? layout.panes.filter((p) => p.id === layout.maximized) : layout.panes
}

export function focusedPane(layout: Layout): Pane {
  return layout.panes.find((p) => p.id === layout.focus) ?? layout.panes[0]
}

function nextId(panes: Pane[]): string {
  const taken = new Set(panes.map((p) => p.id))
  let n = 1
  while (taken.has(`p${n}`)) n += 1
  return `p${n}`
}

function freeModule(panes: Pane[]): ModuleId {
  const used = new Set(panes.map((p) => p.module))
  // Four panes never use up the ten modules of FILL.
  return FILL.find((m) => !used.has(m))!
}

/** A layout with one pane showing `module`. */
export function singleLayout(module: ModuleId): Layout {
  return { preset: 'single', panes: [{ id: 'p1', module }], sizes: DEFAULT_SIZES.single, focus: 'p1' }
}

/** A layout of `preset` with these modules, in slot order (missing slots get free modules). */
export function makeLayout(preset: Preset, modules: ModuleId[]): Layout {
  const panes: Pane[] = []
  for (const module of modules.slice(0, SLOTS[preset])) panes.push({ id: nextId(panes), module })
  while (panes.length < SLOTS[preset]) panes.push({ id: nextId(panes), module: freeModule(panes) })
  return { preset, panes, sizes: DEFAULT_SIZES[preset], focus: panes[0].id }
}

/**
 * Put `module` into pane `paneId`. Modules exist once: if another pane shows
 * it, the two panes swap — that pane gets this pane's module.
 */
export function place(layout: Layout, paneId: string, module: ModuleId): Layout {
  const target = layout.panes.find((p) => p.id === paneId)
  if (!target) return layout
  const holder = layout.panes.find((p) => p.module === module)
  const panes = layout.panes.map((p) => (p === target ? { ...p, module } : p === holder ? { ...p, module: target.module } : p))
  return { ...layout, panes, focus: paneId }
}

/** Bring `module` up: focus its pane when it is on screen, else show it in the focused pane. */
export function show(layout: Layout, module: ModuleId): Layout {
  const there = visiblePanes(layout).find((p) => p.module === module)
  if (there) return { ...layout, focus: there.id }
  return place(layout, focusedPane(layout).id, module)
}

export function focus(layout: Layout, paneId: string): Layout {
  if (layout.focus === paneId || !layout.panes.some((p) => p.id === paneId)) return layout
  return { ...layout, focus: paneId, ...(layout.maximized ? { maximized: paneId } : {}) }
}

const GROW: Record<number, Preset> = { 2: 'columns', 3: 'main', 4: 'grid' }
const SHRINK: Record<Preset, Preset> = { single: 'single', columns: 'single', rows: 'single', main: 'columns', grid: 'main' }

/** A new pane next to the focused one, with a module not on screen yet; four at most. */
export function split(layout: Layout): Layout {
  if (layout.panes.length >= SLOTS.grid) return layout
  const pane: Pane = { id: nextId(layout.panes), module: freeModule(layout.panes) }
  const at = layout.panes.indexOf(focusedPane(layout)) + 1
  const panes = [...layout.panes.slice(0, at), pane, ...layout.panes.slice(at)]
  const preset = GROW[panes.length]
  return { preset, panes, sizes: DEFAULT_SIZES[preset], focus: pane.id }
}

/** An edge of a pane, where a module dragged onto it opens in a new pane. */
export type Side = 'left' | 'right' | 'top' | 'bottom'

/**
 * Where a new pane can open beside pane `paneId` — the edges whose split one
 * of the arrangements draws as it looks: a single pane on any side, the right
 * column of two (or of one large and two small) above or below, the large
 * pane of three above or below. None while a pane is maximized.
 */
export function dropSides(layout: Layout, paneId: string): Side[] {
  const index = layout.panes.findIndex((p) => p.id === paneId)
  if (index < 0 || layout.maximized) return []
  if (layout.preset === 'single') return ['left', 'right', 'top', 'bottom']
  if ((layout.preset === 'columns' && index === 1) || (layout.preset === 'main' && index === 0)) return ['top', 'bottom']
  return []
}

/** Slot order of the new layout, by where the new pane `n` goes beside pane `t` (`a`, `b`: the others in their slots). */
const BESIDE: Record<'columns' | 'main', { preset: Preset; order: Partial<Record<Side, string>> }> = {
  columns: { preset: 'main', order: { top: 'ant', bottom: 'atn' } },
  main: { preset: 'grid', order: { top: 'natb', bottom: 'tanb' } }
}

/** Open `module` in a new pane on `side` of pane `paneId` (see `dropSides`); it gets the focus. */
export function dropBeside(layout: Layout, paneId: string, side: Side, module: ModuleId): Layout {
  if (!dropSides(layout, paneId).includes(side) || layout.panes.some((p) => p.module === module)) return layout
  const pane: Pane = { id: nextId(layout.panes), module }
  const target = layout.panes.find((p) => p.id === paneId)!
  if (layout.preset === 'single') {
    const preset: Preset = side === 'left' || side === 'right' ? 'columns' : 'rows'
    const panes = side === 'left' || side === 'top' ? [pane, target] : [target, pane]
    return { preset, panes, sizes: DEFAULT_SIZES[preset], focus: pane.id }
  }
  const { preset, order } = BESIDE[layout.preset as keyof typeof BESIDE]
  const others = layout.panes.filter((p) => p !== target)
  const slot: Record<string, Pane> = { n: pane, t: target, a: others[0], b: others[1] }
  const panes = [...order[side]!].map((c) => slot[c])
  // The left column keeps its width.
  return { preset, panes, sizes: { ...DEFAULT_SIZES[preset], x: layout.sizes.x }, focus: pane.id }
}

/**
 * Open `module` next to the focused pane — on its right where the
 * arrangements allow, else below it, else as a further pane; with four
 * panes, in the focused one. A module already on screen gets the focus.
 */
export function openBeside(layout: Layout, module: ModuleId): Layout {
  const base: Layout = layout.maximized ? { ...layout, maximized: undefined } : layout
  const there = base.panes.find((p) => p.module === module)
  if (there) return there.id === base.focus ? base : { ...base, focus: there.id }
  const target = focusedPane(base).id
  const side = (['right', 'bottom'] as Side[]).find((s) => dropSides(base, target).includes(s))
  if (side) return dropBeside(base, target, side, module)
  const grown = split(base)
  return place(grown, grown.focus, module)
}

/**
 * Show `module` without taking the focus away (an agent's command in a
 * terminal, beside its chat): as it is when on screen, else beside the
 * focused pane (see `openBeside`) — with four panes, in the last of the others.
 */
export function reveal(layout: Layout, module: ModuleId): Layout {
  if (visiblePanes(layout).some((p) => p.module === module)) return layout
  const base: Layout = layout.maximized ? { ...layout, maximized: undefined } : layout
  if (base.panes.some((p) => p.module === module)) return base
  const keep = base.focus
  if (base.panes.length >= SLOTS.grid) return { ...place(base, [...base.panes].reverse().find((p) => p.id !== keep)!.id, module), focus: keep }
  return { ...openBeside(base, module), focus: keep }
}

/** Close a pane (the last one stays); the focus goes to its neighbour. */
export function close(layout: Layout, paneId: string = layout.focus): Layout {
  const index = layout.panes.findIndex((p) => p.id === paneId)
  if (index < 0 || layout.panes.length === 1) return layout
  const panes = layout.panes.filter((p) => p.id !== paneId)
  const preset = SHRINK[layout.preset]
  const next = layout.focus === paneId ? panes[Math.max(0, index - 1)].id : layout.focus
  return { preset, panes, sizes: DEFAULT_SIZES[preset], focus: next }
}

/** Switch the arrangement: extra panes close (never the focused one), missing ones open. */
export function setPreset(layout: Layout, preset: Preset): Layout {
  const n = SLOTS[preset]
  const current = focusedPane(layout)
  let panes = layout.panes
  if (panes.length > n) {
    const keep = new Set([current, ...panes.filter((p) => p !== current).slice(0, n - 1)])
    panes = panes.filter((p) => keep.has(p))
  }
  while (panes.length < n) panes = [...panes, { id: nextId(panes), module: freeModule(panes) }]
  return { preset, panes, sizes: layout.preset === preset ? layout.sizes : DEFAULT_SIZES[preset], focus: current.id }
}

export function resize(layout: Layout, key: keyof Sizes, value: number): Layout {
  const next = Math.min(1 - MIN_FRACTION, Math.max(MIN_FRACTION, value))
  return { ...layout, sizes: { ...layout.sizes, [key]: next } }
}

/** Maximize a pane, or restore when one is maximized. */
export function toggleMaximize(layout: Layout, paneId: string = layout.focus): Layout {
  if (layout.maximized) return { ...layout, maximized: undefined }
  if (layout.panes.length === 1 || !layout.panes.some((p) => p.id === paneId)) return layout
  return { ...layout, maximized: paneId, focus: paneId }
}

const center = (r: Rect) => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 })
const EPS = 1e-6

/** Is `r` beyond `from` in `dir`? */
const BEYOND: Record<Direction, (r: Rect, from: Rect) => boolean> = {
  left: (r, from) => r.x1 <= from.x0 + EPS,
  right: (r, from) => r.x0 >= from.x1 - EPS,
  up: (r, from) => r.y1 <= from.y0 + EPS,
  down: (r, from) => r.y0 >= from.y1 - EPS
}

/** The focus to the nearest pane in `dir` (a maximized workspace flips to that pane). */
export function moveFocus(layout: Layout, dir: Direction): Layout {
  const rects = slotRects(layout.preset, layout.sizes)
  const index = layout.panes.indexOf(focusedPane(layout))
  const from = rects[index]
  const c = center(from)
  const horizontal = dir === 'left' || dir === 'right'
  let best: { id: string; score: number } | undefined
  layout.panes.forEach((p, i) => {
    if (i === index || !BEYOND[dir](rects[i], from)) return
    const o = center(rects[i])
    const along = horizontal ? Math.abs(o.x - c.x) : Math.abs(o.y - c.y)
    const across = horizontal ? Math.abs(o.y - c.y) : Math.abs(o.x - c.x)
    const score = along + 2 * across
    if (!best || score < best.score - EPS) best = { id: p.id, score }
  })
  return best ? focus(layout, best.id) : layout
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isFraction = (v: unknown): v is number => typeof v === 'number' && v >= MIN_FRACTION && v <= 1 - MIN_FRACTION

/** A stored layout, if it is one (storage outlives versions and can be edited by hand). */
export function parseLayout(raw: unknown): Layout | null {
  if (!isRecord(raw) || !PRESETS.includes(raw.preset as Preset)) return null
  const preset = raw.preset as Preset
  const panes = raw.panes
  if (!Array.isArray(panes) || panes.length !== SLOTS[preset]) return null
  const valid = panes.every((p) => isRecord(p) && typeof p.id === 'string' && p.id.length > 0 && p.id.length <= 40 && MODULES.includes(p.module as ModuleId))
  if (!valid) return null
  const clean = (panes as Pane[]).map((p) => ({ id: p.id, module: p.module }))
  if (new Set(clean.map((p) => p.id)).size !== clean.length || new Set(clean.map((p) => p.module)).size !== clean.length) return null
  const sizes = isRecord(raw.sizes) && isFraction(raw.sizes.x) && isFraction(raw.sizes.y) ? { x: raw.sizes.x, y: raw.sizes.y } : DEFAULT_SIZES[preset]
  const ids = clean.map((p) => p.id)
  const focusId = ids.includes(raw.focus as string) ? (raw.focus as string) : ids[0]
  const maximized = ids.includes(raw.maximized as string) && clean.length > 1 ? (raw.maximized as string) : undefined
  return { preset, panes: clean, sizes, focus: maximized ?? focusId, ...(maximized ? { maximized } : {}) }
}
