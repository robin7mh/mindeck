import type { Command } from './registry'

/** Characters a word starts after. */
const BOUNDARY = /[\s:/\\._\-›(]/

/**
 * How well `query` fits `text` (both compared in lower case; higher is
 * better), null when it doesn't: every word of the query in the text — as a
 * piece (best at the start of a word, early on) or, failing that and when
 * `scattered`, its letters in order with gaps between.
 */
export function scoreText(text: string, query: string, scattered = true): number | null {
  const hay = text.toLowerCase()
  let total = 0
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const at = hay.indexOf(word)
    if (at >= 0) {
      total += 100 - Math.min(at, 50) + (at === 0 || BOUNDARY.test(hay[at - 1]) ? 40 : 0)
      continue
    }
    if (!scattered) return null
    let pos = -1
    let gaps = 0
    for (const ch of word) {
      const next = hay.indexOf(ch, pos + 1)
      if (next < 0) return null
      if (pos >= 0) gaps += next - pos - 1
      pos = next
    }
    total += Math.max(1, 30 - gaps)
  }
  return total
}

/**
 * A command's fit: its label first, then everything else it carries (group,
 * detail, keywords) at a discount — there only whole pieces count, scattered
 * letters would find anything in so much text.
 */
function scoreCommand(c: Command, query: string): number | null {
  const label = scoreText(c.label, query)
  const rest = scoreText(`${c.label} ${c.group} ${c.detail ?? ''} ${c.keywords ?? ''}`, query, false)
  if (label === null && rest === null) return null
  return Math.max(label ?? 0, (rest ?? 0) * 0.6)
}

export interface PaletteList {
  /** Recently used ones — only without a query. */
  recent: Command[]
  results: Command[]
}

/**
 * What the palette lists. Without a query: the recently used commands, then
 * everything that is listed without a search. With one: the matches, best
 * first — recently used ones a little ahead.
 */
export function searchCommands(commands: Command[], query: string, recentIds: string[], limit = 80): PaletteList {
  const byId = new Map(commands.map((c) => [c.id, c]))
  if (!query.trim()) {
    const recent = recentIds.map((id) => byId.get(id)).filter((c): c is Command => !!c)
    const shown = new Set(recent)
    return { recent, results: commands.filter((c) => !c.searchOnly && !shown.has(c)).slice(0, limit) }
  }
  const boost = new Map(recentIds.map((id, i) => [id, 30 - i * 2]))
  const results = commands
    .map((c) => ({ c, score: scoreCommand(c, query) }))
    .filter((h): h is { c: Command; score: number } => h.score !== null)
    .map((h) => ({ c: h.c, score: h.score + (boost.get(h.c.id) ?? 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((h) => h.c)
  return { recent: [], results }
}
