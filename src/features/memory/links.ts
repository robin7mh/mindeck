import type { NoteMeta } from '@shared/types/memory'

/** `Target#Heading` / `Target^block` → `Target`. */
export function linkTarget(raw: string): string {
  return raw.replace(/[#^].*$/, '').trim()
}

/**
 * The note a link points to, resolved like Obsidian (and the vault index):
 * by name, or by path when it has a folder; ties go to the shortest path.
 */
export function findNote(raw: string, notes: NoteMeta[]): NoteMeta | undefined {
  const key = linkTarget(raw).replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\.md$/i, '').toLowerCase()
  if (!key) return undefined
  return notes
    .filter((n) => {
      const path = n.path.replace(/\.md$/i, '').toLowerCase()
      return key.includes('/') ? path === key || path.endsWith(`/${key}`) : n.title.toLowerCase() === key
    })
    .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))[0]
}

/** What goes between `[[ ]]` for a note: its name when that is unambiguous, else its path. */
export function linkText(note: NoteMeta, notes: NoteMeta[]): string {
  const same = notes.filter((n) => n.title.toLowerCase() === note.title.toLowerCase())
  return same.length > 1 ? note.path.replace(/\.md$/i, '') : note.title
}

/** Every tag in the vault, the most used first. */
export function allTags(notes: NoteMeta[]): string[] {
  const counts = new Map<string, number>()
  for (const n of notes) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t)
}
