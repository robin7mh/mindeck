import { create } from 'zustand'
import { UNCOMMITTED, type BlameCommit } from '@shared/types/scm'
import { getT, intlLocale } from '@/lib/i18n'
import { relativeTime } from '@/features/agents/format'

/** Characters of the blame view's column (hash, author, date) — monospace, so the code lines up. */
export const BLAME_WIDTH = 34
const AUTHOR = 14

/** Non-breaking spaces: Monaco keeps them in injected text. */
const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - text.length))
const fit = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : pad(text, width))
const day = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** After the cursor's line: "Ada Lovelace, 2 h ago • Fix the parser" ('' when the line has no blame yet). */
export function inlineLabel(commit: BlameCommit | undefined, now = Date.now()): string {
  if (!commit) return ''
  if (commit.hash === UNCOMMITTED) return getT().blame.uncommitted
  return `${commit.author}, ${relativeTime(new Date(commit.date).toISOString(), now)} • ${commit.summary}`
}

/** The blame view's column for the first line of a hunk: "1a2b3c4 Ada Lovelace   2026-10-01". */
export function gutterLabel(commit: BlameCommit | undefined): string {
  if (!commit) return pad('', BLAME_WIDTH)
  if (commit.hash === UNCOMMITTED) return fit(getT().blame.uncommittedShort, BLAME_WIDTH)
  return pad(`${commit.hash.slice(0, 7)} ${fit(commit.author, AUTHOR)} ${day(commit.date)}`, BLAME_WIDTH)
}

/** The rest of a hunk's lines: blank, the same width. */
export const BLAME_BLANK = pad('', BLAME_WIDTH)

/** The hover over a blame: the commit in full. */
export function blameHover(commit: BlameCommit): string {
  if (commit.hash === UNCOMMITTED) return getT().blame.uncommitted
  return `**${commit.summary}**\n\n${commit.author} <${commit.email}> · ${new Date(commit.date).toLocaleString(intlLocale())}\n\n\`${commit.hash.slice(0, 10)}\``
}

interface BlameState {
  /** Tabs showing the blame view (who changed each line, in front of it). */
  shown: Record<string, boolean>
  toggle: (id: string) => void
}

/** Which files show the blame view — toggled per tab, like GitLens' file blame. */
export const useBlame = create<BlameState>((set) => ({
  shown: {},
  toggle: (id) =>
    set((s) => {
      const { [id]: on, ...rest } = s.shown
      return { shown: on ? rest : { ...rest, [id]: true } }
    })
}))
