import type { LucideIcon } from 'lucide-react'
import type { Dict } from '@/lib/i18n/en'

/** One entry of the command palette. */
export interface Command {
  /** Stable across starts: the palette remembers recently used commands by it, keybindings name it. */
  id: string
  label: string
  /** Shown dimmed after the label (a path, a project). */
  detail?: string
  /** Where it belongs ("Workspace", "Settings") — shown at the right, and searched too. */
  group: string
  icon?: LucideIcon
  /** Its shortcut, as this platform writes it. */
  keys?: string
  /** More words to find it by (synonyms, the other language's word). */
  keywords?: string
  /** Listed only for a search — there are too many to list them all (notes, bookmarks). */
  searchOnly?: boolean
  run: () => unknown
}

/** What a module contributes: its commands of the moment, and a way to fetch what they list. */
export interface CommandSource {
  /** Asked each time the palette opens or the language changes. */
  commands: (t: Dict) => Command[]
  /** The palette opens: load what the commands list (projects, notes, …) if it isn't there yet. */
  prepare?: () => void
  /** Tell when the commands changed (what `prepare` fetched has arrived) — an open palette lists them anew. */
  subscribe?: (changed: () => void) => () => void
}

const sources = new Map<string, CommandSource>()

/**
 * Contribute commands to the palette under `id` — a later call with the same
 * id replaces the earlier one. Modules call it for as long as they want their
 * commands listed (the editor while it is mounted). Returns the way to take
 * them back.
 */
export function registerCommands(id: string, source: CommandSource | CommandSource['commands']): () => void {
  const entry = typeof source === 'function' ? { commands: source } : source
  sources.set(id, entry)
  return () => {
    if (sources.get(id) === entry) sources.delete(id)
  }
}

/** The palette opens. */
export function prepareCommands(): void {
  for (const source of sources.values()) {
    try {
      source.prepare?.()
    } catch {
      /* a source that can't fetch keeps what it has */
    }
  }
}

/** Hear of changes to the commands of every source registered now. Returns: stop. */
export function subscribeCommands(changed: () => void): () => void {
  const offs = [...sources.values()].flatMap((s) => (s.subscribe ? [s.subscribe(changed)] : []))
  return () => offs.forEach((off) => off())
}

/** Every command, in the order the sources registered; the first of an id wins. A source that fails is left out. */
export function allCommands(t: Dict): Command[] {
  const seen = new Set<string>()
  const list: Command[] = []
  for (const source of sources.values()) {
    let commands: Command[]
    try {
      commands = source.commands(t)
    } catch {
      continue
    }
    for (const c of commands) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      list.push(c)
    }
  }
  return list
}
