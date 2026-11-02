/**
 * The editor area as VS Code lays it out: editor groups in a grid of rows
 * and columns, nested as deep as the user splits. Pure functions over an
 * immutable tree — the store keeps the tree, the view draws it.
 */

/** Children side by side (`row`) or stacked (`column`). */
export type Orientation = 'row' | 'column'
/** Where a new group goes, next to an existing one. */
export type Side = 'left' | 'right' | 'up' | 'down'

export interface GridLeaf {
  group: string
}
export interface GridBranch {
  orientation: Orientation
  children: GridNode[]
  /** Each child's share of the branch (fractions that add up to 1). */
  sizes: number[]
}
export type GridNode = GridLeaf | GridBranch

/** A box in fractions of the whole editor area (0…1). */
export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** A draggable line between two children of a branch. */
export interface Sash {
  /** Child indices from the root to the branch. */
  path: number[]
  /** Between child `index - 1` and child `index`. */
  index: number
  orientation: Orientation
  /** Where it is along the branch's axis, in fractions of the whole area. */
  at: number
  /** Its extent across the axis. */
  from: number
  to: number
}

export const isLeaf = (node: GridNode): node is GridLeaf => 'group' in node
export const leaf = (group: string): GridLeaf => ({ group })

const orientationOf = (side: Side): Orientation => (side === 'left' || side === 'right' ? 'row' : 'column')
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

/** The groups in grid order (left to right, top to bottom) — ⌘1…⌘9 count in it. */
export function groupOrder(node: GridNode): string[] {
  return isLeaf(node) ? [node.group] : node.children.flatMap(groupOrder)
}

/** A branch without single children or same-direction children: those merge into it. */
function normalize(node: GridBranch): GridNode {
  const children: GridNode[] = []
  const sizes: number[] = []
  const total = sum(node.sizes)
  node.children.forEach((child, i) => {
    const share = node.sizes[i] / total
    if (!isLeaf(child) && child.orientation === node.orientation) {
      child.children.forEach((c, j) => {
        children.push(c)
        sizes.push(share * child.sizes[j])
      })
    } else {
      children.push(child)
      sizes.push(share)
    }
  })
  return children.length === 1 ? children[0] : { orientation: node.orientation, children, sizes }
}

/** Put group `id` next to group `target`, taking half of its room. */
export function splitGroup(node: GridNode, target: string, id: string, side: Side): GridNode {
  const orientation = orientationOf(side)
  const before = side === 'left' || side === 'up'
  const walk = (n: GridNode): GridNode => {
    if (isLeaf(n)) return n.group === target ? { orientation, children: before ? [leaf(id), n] : [n, leaf(id)], sizes: [0.5, 0.5] } : n
    const i = n.children.findIndex((c) => isLeaf(c) && c.group === target)
    if (i >= 0 && n.orientation === orientation) {
      const half = n.sizes[i] / 2
      const at = before ? i : i + 1
      const children = [...n.children]
      const sizes = [...n.sizes]
      sizes[i] = half
      children.splice(at, 0, leaf(id))
      sizes.splice(at, 0, half)
      return { orientation, children, sizes }
    }
    return { ...n, children: n.children.map(walk) }
  }
  return walk(node)
}

/** The grid without group `id` (its room goes to its siblings); null when it was the only one. */
export function removeGroup(node: GridNode, id: string): GridNode | null {
  if (isLeaf(node)) return node.group === id ? null : node
  const children: GridNode[] = []
  const sizes: number[] = []
  node.children.forEach((child, i) => {
    const kept = removeGroup(child, id)
    if (kept) {
      children.push(kept)
      sizes.push(node.sizes[i])
    }
  })
  // Ids are unique: at most one child went, a branch keeps at least one.
  return normalize({ orientation: node.orientation, children, sizes })
}

/** Every group's box. */
export function groupRects(node: GridNode, box: Rect = { x0: 0, y0: 0, x1: 1, y1: 1 }, out = new Map<string, Rect>()): Map<string, Rect> {
  if (isLeaf(node)) return out.set(node.group, box)
  let start = node.orientation === 'row' ? box.x0 : box.y0
  const length = node.orientation === 'row' ? box.x1 - box.x0 : box.y1 - box.y0
  node.children.forEach((child, i) => {
    const end = start + node.sizes[i] * length
    groupRects(child, node.orientation === 'row' ? { ...box, x0: start, x1: end } : { ...box, y0: start, y1: end }, out)
    start = end
  })
  return out
}

/** Every sash of the grid. */
export function gridSashes(node: GridNode, box: Rect = { x0: 0, y0: 0, x1: 1, y1: 1 }, path: number[] = []): Sash[] {
  if (isLeaf(node)) return []
  const row = node.orientation === 'row'
  let start = row ? box.x0 : box.y0
  const length = row ? box.x1 - box.x0 : box.y1 - box.y0
  const out: Sash[] = []
  node.children.forEach((child, i) => {
    if (i > 0) out.push({ path, index: i, orientation: node.orientation, at: start, from: row ? box.y0 : box.x0, to: row ? box.y1 : box.x1 })
    const end = start + node.sizes[i] * length
    out.push(...gridSashes(child, row ? { ...box, x0: start, x1: end } : { ...box, y0: start, y1: end }, [...path, i]))
    start = end
  })
  return out
}

/** The branch at `path`, with its box. */
function branchAt(node: GridNode, path: number[]): { branch: GridBranch; box: Rect } {
  let box: Rect = { x0: 0, y0: 0, x1: 1, y1: 1 }
  let at = node as GridBranch
  for (const i of path) {
    const row = at.orientation === 'row'
    const length = row ? box.x1 - box.x0 : box.y1 - box.y0
    const start = (row ? box.x0 : box.y0) + sum(at.sizes.slice(0, i)) * length
    const end = start + at.sizes[i] * length
    box = row ? { ...box, x0: start, x1: end } : { ...box, y0: start, y1: end }
    at = at.children[i] as GridBranch
  }
  return { branch: at, box }
}

/** A copy of the grid with the branch at `path` replaced. */
function replaceAt(node: GridNode, path: number[], next: GridBranch): GridNode {
  if (!path.length) return next
  const branch = node as GridBranch
  const [i, ...rest] = path
  return { ...branch, children: branch.children.map((c, j) => (j === i ? replaceAt(c, rest, next) : c)) }
}

/**
 * Move a sash to `at` (fractions of the whole area) — no group gets smaller
 * than `min` (also a fraction of the whole area, along the sash's axis).
 */
export function moveSash(node: GridNode, sash: Pick<Sash, 'path' | 'index'>, at: number, min: number): GridNode {
  const { branch, box } = branchAt(node, sash.path)
  const row = branch.orientation === 'row'
  const length = row ? box.x1 - box.x0 : box.y1 - box.y0
  const start = (row ? box.x0 : box.y0) + sum(branch.sizes.slice(0, sash.index - 1)) * length
  const pair = (branch.sizes[sash.index - 1] + branch.sizes[sash.index]) * length
  if (pair < 2 * min) return node
  const clamped = Math.min(Math.max(at, start + min), start + pair - min)
  const sizes = [...branch.sizes]
  sizes[sash.index - 1] = (clamped - start) / length
  sizes[sash.index] = (start + pair - clamped) / length
  return replaceAt(node, sash.path, { ...branch, sizes })
}

/** Equal room for every child of the branch at `path` (double-click on a sash). */
export function evenSizes(node: GridNode, path: number[]): GridNode {
  const { branch } = branchAt(node, path)
  return replaceAt(node, path, { ...branch, sizes: branch.children.map(() => 1 / branch.children.length) })
}

/** The nearest group on one side of group `id` (sharing some of its edge); undefined at the border. */
export function neighbour(node: GridNode, id: string, side: Side): string | undefined {
  const rects = groupRects(node)
  const from = rects.get(id)
  if (!from) return undefined
  const eps = 1e-9
  let best: { id: string; distance: number; overlap: number } | undefined
  for (const [other, r] of rects) {
    if (other === id) continue
    const distance = side === 'right' ? r.x0 - from.x1 : side === 'left' ? from.x0 - r.x1 : side === 'down' ? r.y0 - from.y1 : from.y0 - r.y1
    const overlap = orientationOf(side) === 'row' ? Math.min(r.y1, from.y1) - Math.max(r.y0, from.y0) : Math.min(r.x1, from.x1) - Math.max(r.x0, from.x0)
    if (distance < -eps || overlap <= eps) continue
    if (!best || distance < best.distance - eps || (Math.abs(distance - best.distance) <= eps && overlap > best.overlap)) best = { id: other, distance, overlap }
  }
  return best?.id
}

/** A grid read back from storage; null when it isn't one (or names a group twice). */
export function parseGrid(raw: unknown): GridNode | null {
  const seen = new Set<string>()
  const parse = (n: unknown, depth: number): GridNode | null => {
    if (!n || typeof n !== 'object' || depth > 16) return null
    const o = n as Record<string, unknown>
    if (typeof o.group === 'string') {
      if (!o.group || seen.has(o.group)) return null
      seen.add(o.group)
      return leaf(o.group)
    }
    if ((o.orientation !== 'row' && o.orientation !== 'column') || !Array.isArray(o.children) || !Array.isArray(o.sizes)) return null
    if (o.children.length < 2 || o.sizes.length !== o.children.length) return null
    if (!o.sizes.every((s) => typeof s === 'number' && Number.isFinite(s) && s > 0)) return null
    const children = o.children.map((c) => parse(c, depth + 1))
    if (children.some((c) => !c)) return null
    return normalize({ orientation: o.orientation, children: children as GridNode[], sizes: o.sizes as number[] })
  }
  return parse(raw, 0)
}
