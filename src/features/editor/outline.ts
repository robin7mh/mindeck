import { create } from 'zustand'

/** A range in a file: 1-based lines and columns, like Monaco's. */
export interface SymbolRange {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

/** A symbol of a file (class, function, heading …) — what the outline and breadcrumbs show. */
export interface OutlineSymbol {
  name: string
  detail?: string
  /** Monaco's / LSP's symbol kind, 0-based (0 file … 25 type parameter). */
  kind: number
  /** All of it (where the cursor counts as "in" it). */
  range: SymbolRange
  /** Its name (where a click takes the cursor). */
  selection: SymbolRange
  children: OutlineSymbol[]
}

export interface CursorPosition {
  line: number
  column: number
}

const contains = (r: SymbolRange, p: CursorPosition) =>
  (p.line > r.startLine || (p.line === r.startLine && p.column >= r.startColumn)) && (p.line < r.endLine || (p.line === r.endLine && p.column <= r.endColumn))

/** The symbols around a position, outermost first — the breadcrumbs' trail. */
export function symbolPath(symbols: OutlineSymbol[], at: CursorPosition): OutlineSymbol[] {
  const path: OutlineSymbol[] = []
  let level = symbols
  for (;;) {
    const inside = level.find((s) => contains(s.range, at))
    if (!inside) return path
    path.push(inside)
    level = inside.children
  }
}

/** The symbols whose name contains `query` (any case), with the symbols around them; all of them without a query. */
export function filterSymbols(symbols: OutlineSymbol[], query: string): OutlineSymbol[] {
  const q = query.trim().toLowerCase()
  if (!q) return symbols
  return symbols.flatMap((s) => {
    const children = filterSymbols(s.children, q)
    return s.name.toLowerCase().includes(q) || children.length ? [{ ...s, children }] : []
  })
}

/** Symbols sorted by where they start (servers don't always send them in order), children too. */
export function sortSymbols(symbols: OutlineSymbol[]): OutlineSymbol[] {
  return [...symbols]
    .sort((a, b) => a.range.startLine - b.range.startLine || a.range.startColumn - b.range.startColumn)
    .map((s) => ({ ...s, children: sortSymbols(s.children) }))
}

/** The cursor's place for the reveal of a symbol: its name selected when it is on one line. */
export function revealOf(symbol: OutlineSymbol): { line: number; match?: { column: number; length: number } } {
  const r = symbol.selection
  return r.startLine === r.endLine && r.endColumn > r.startColumn
    ? { line: r.startLine, match: { column: r.startColumn - 1, length: r.endColumn - r.startColumn } }
    : { line: r.startLine }
}

interface OutlineState {
  /** Symbols per open file (tab id), as the language services last reported them. */
  symbols: Record<string, OutlineSymbol[]>
  /** The cursor of each editor group. */
  cursors: Record<string, CursorPosition>
  setSymbols: (id: string, symbols: OutlineSymbol[]) => void
  forget: (id: string) => void
  setCursor: (group: string, at: CursorPosition) => void
}

/**
 * What the outline and the breadcrumbs follow: each file's symbols (the
 * Monaco side reports them) and each group's cursor — kept apart from the
 * editor store, so a cursor move re-renders only what shows it.
 */
export const useOutline = create<OutlineState>((set, get) => ({
  symbols: {},
  cursors: {},
  setSymbols: (id, symbols) => set((s) => ({ symbols: { ...s.symbols, [id]: symbols } })),
  forget: (id) => {
    if (!(id in get().symbols)) return
    set((s) => {
      const { [id]: _gone, ...symbols } = s.symbols
      return { symbols }
    })
  },
  setCursor: (group, at) => {
    const now = get().cursors[group]
    if (now?.line === at.line && now.column === at.column) return
    set((s) => ({ cursors: { ...s.cursors, [group]: at } }))
  }
}))
