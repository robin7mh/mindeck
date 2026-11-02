import { ipc, isDesktop } from '@shared/ipc/client'
import type { ComposerRef } from '@shared/types/composer'
import { fuzzyScore } from '@/features/editor/components/QuickOpen'

/** Something `@` can point at, as the picker lists it. */
export interface MentionItem extends ComposerRef {
  label: string
  /** A quieter second part: the folder, the vault folder, the URL. */
  detail: string
}

const lastSegment = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const parent = (path: string) => path.slice(0, path.length - lastSegment(path).length)

/** Files and their folders (from the file list: git's view, so .gitignore holds). */
export function fileMentions(files: string[]): MentionItem[] {
  const folders = new Set<string>()
  for (const f of files) {
    for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) folders.add(f.slice(0, i))
  }
  return [
    ...[...folders].sort().map((path) => ({ kind: 'folder' as const, path, label: `${lastSegment(path)}/`, detail: parent(path) })),
    ...files.map((path) => ({ kind: 'file' as const, path, label: lastSegment(path), detail: parent(path) }))
  ]
}

/**
 * What `@` offers in a session: the project's files and folders, notes in the
 * memory vault, and the browser's open tabs (desktop). A source that fails
 * (no vault, no browser) is simply left out.
 */
export async function loadMentions(projectId: string): Promise<MentionItem[]> {
  const [files, notes, browser] = await Promise.all([
    ipc('scm:files', { projectId }).catch(() => [] as string[]),
    ipc('memory:list').catch(() => []),
    isDesktop() ? ipc('browser:state').catch(() => null) : null
  ])
  return [
    ...fileMentions(files),
    ...notes.map((n) => ({ kind: 'note' as const, path: n.path, label: n.title, detail: n.folder })),
    ...(browser?.tabs ?? []).filter((t) => /^https?:/.test(t.url)).map((t) => ({ kind: 'tab' as const, path: t.url, label: t.title || t.url, detail: t.url }))
  ]
}

const LIMIT = 50

/** The best matches for what follows `@` (file names before paths, like quick open). */
export function rankMentions(items: MentionItem[], query: string): MentionItem[] {
  if (!query) return items.slice(0, LIMIT)
  return items
    .map((item) => ({ item, score: fuzzyScore(item.kind === 'file' || item.kind === 'folder' ? item.path : `${item.detail}/${item.label}`, query) }))
    .filter((h): h is { item: MentionItem; score: number } => h.score !== null)
    .sort((a, b) => a.score - b.score)
    .slice(0, LIMIT)
    .map((h) => h.item)
}

/** The `@query` or `/command` being typed right before the caret, if any. */
export function tokenAt(text: string, caret: number): { trigger: '@' | '/'; query: string; start: number } | null {
  const before = text.slice(0, caret)
  const at = /(^|\s)@([^\s@]*)$/.exec(before)
  if (at) return { trigger: '@', query: at[2], start: caret - at[2].length - 1 }
  const slash = /^\/(\S*)$/.exec(before)
  return slash ? { trigger: '/', query: slash[1], start: 0 } : null
}
