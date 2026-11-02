import { create } from 'zustand'

/**
 * A merge conflict in a file, as git writes it (1-based line numbers):
 *
 *     <<<<<<< HEAD            start
 *     current (ours)
 *     ||||||| base            base (diff3 / zdiff3 only)
 *     common ancestor
 *     =======                 separator
 *     incoming (theirs)
 *     >>>>>>> feature         end
 */
export interface ConflictBlock {
  start: number
  base?: number
  separator: number
  end: number
  /** What git named the sides: `HEAD`, a branch, a commit. */
  currentLabel: string
  incomingLabel: string
}

export type ConflictChoice = 'current' | 'incoming' | 'both'

const marker = (line: string, char: string) => line.startsWith(char.repeat(7)) && (line.length === 7 || line[7] === ' ' || line[7] === '\r')
const label = (line: string) => line.slice(8).trim()

/** Every complete conflict block of a file's lines; stray or unfinished markers are ignored. */
export function parseConflicts(lines: string[]): ConflictBlock[] {
  const blocks: ConflictBlock[] = []
  let open: Partial<ConflictBlock> | undefined
  lines.forEach((line, i) => {
    const n = i + 1
    if (marker(line, '<')) open = { start: n, currentLabel: label(line) }
    else if (!open) return
    else if (marker(line, '|') && open.separator === undefined) open.base = n
    else if (marker(line, '=') && line.trimEnd().length === 7 && open.separator === undefined) open.separator = n
    else if (marker(line, '>') && open.separator !== undefined) {
      blocks.push({ ...(open as ConflictBlock), end: n, incomingLabel: label(line) })
      open = undefined
    }
  })
  return blocks
}

/** The lines of each side of a block (without the markers). */
export function conflictSides(lines: string[], b: ConflictBlock): { current: string[]; base?: string[]; incoming: string[] } {
  const currentEnd = b.base ?? b.separator
  return {
    current: lines.slice(b.start, currentEnd - 1),
    ...(b.base !== undefined ? { base: lines.slice(b.base, b.separator - 1) } : {}),
    incoming: lines.slice(b.separator, b.end - 1)
  }
}

/** What a resolved block becomes: one side, or both (current first, like VS Code). */
export function resolveConflict(lines: string[], b: ConflictBlock, choice: ConflictChoice): string[] {
  const { current, incoming } = conflictSides(lines, b)
  return choice === 'current' ? current : choice === 'incoming' ? incoming : [...current, ...incoming]
}

/** The next block below the cursor line (`back`: the one above it), wrapping around at the end. */
export function nearestConflict(blocks: ConflictBlock[], line: number, back = false): ConflictBlock | undefined {
  if (back) return [...blocks].reverse().find((b) => b.end < line) ?? blocks[blocks.length - 1]
  return blocks.find((b) => b.start > line) ?? blocks[0]
}

interface ConflictsState {
  /** Conflict blocks per open tab id, as the editor last counted them. */
  counts: Record<string, number>
  setCount: (id: string, count: number) => void
}

/** How many conflicts each open file has — the editor's conflict bar shows it. */
export const useConflicts = create<ConflictsState>((set, get) => ({
  counts: {},
  setCount: (id, count) => {
    if (get().counts[id] !== count) set((s) => ({ counts: { ...s.counts, [id]: count } }))
  }
}))
