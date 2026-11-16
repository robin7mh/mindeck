import type { BrowserState, BrowserTab, BrowserTabGroup, TabGroupColor } from '@shared/types/browser'

/** What a tab being dragged carries (its id). */
export const TAB_DRAG = 'application/x-mindeck-tab'

/** A group's color as classes (tokens only; written out so Tailwind keeps them). */
export const GROUP_STYLES: Record<TabGroupColor, { dot: string; text: string; line: string; soft: string; border: string }> = {
  cyan: { dot: 'bg-cyan', text: 'text-cyan', line: 'shadow-[inset_0_-2px_0_0_rgb(var(--accent-cyan))]', soft: 'bg-cyan/10', border: 'border-cyan/60' },
  blue: { dot: 'bg-blue', text: 'text-blue', line: 'shadow-[inset_0_-2px_0_0_rgb(var(--accent-blue))]', soft: 'bg-blue/10', border: 'border-blue/60' },
  purple: { dot: 'bg-purple', text: 'text-purple', line: 'shadow-[inset_0_-2px_0_0_rgb(var(--accent-purple))]', soft: 'bg-purple/10', border: 'border-purple/60' },
  green: { dot: 'bg-green', text: 'text-green', line: 'shadow-[inset_0_-2px_0_0_rgb(var(--accent-green))]', soft: 'bg-green/10', border: 'border-green/60' },
  amber: { dot: 'bg-amber', text: 'text-amber', line: 'shadow-[inset_0_-2px_0_0_rgb(var(--accent-amber))]', soft: 'bg-amber/10', border: 'border-amber/60' },
  danger: { dot: 'bg-danger', text: 'text-danger', line: 'shadow-[inset_0_-2px_0_0_rgb(var(--accent-danger))]', soft: 'bg-danger/10', border: 'border-danger/60' }
}

/** One thing in a tab list: a tab of its own, or a group with its tabs. */
export type TabItem = { kind: 'tab'; tab: BrowserTab } | { kind: 'group'; group: BrowserTabGroup; tabs: BrowserTab[] }

/** The unpinned tabs as a list, each group's tabs under it (the core keeps a group's tabs together). */
export function tabItems(state: BrowserState): TabItem[] {
  const groups = new Map(state.groups.map((g) => [g.id, g]))
  const items: TabItem[] = []
  for (const tab of state.tabs) {
    if (tab.pinned) continue
    const group = tab.groupId ? groups.get(tab.groupId) : undefined
    const last = items[items.length - 1]
    if (!group) items.push({ kind: 'tab', tab })
    else if (last?.kind === 'group' && last.group.id === group.id) last.tabs.push(tab)
    else items.push({ kind: 'group', group, tabs: [tab] })
  }
  return items
}

/** A move for `browser:move`, and whether the tab is pinned or unpinned first. */
export interface Drop {
  index: number
  groupId: string | null
  pin?: boolean
}

const isPrivate = (t: BrowserTab) => t.profile === 'private'

/** May `tab` join `group`? Private tabs and others never share a group. */
export function fits(tab: BrowserTab, group: BrowserTabGroup | undefined): boolean {
  return !!group && !!group.private === isPrivate(tab)
}

/**
 * Dropping tab `id` on tab `target`: it takes the target's place — among the
 * pinned tabs or not, in the target's group (if it may join it) or none.
 */
export function dropOnTab(state: BrowserState, id: string, target: BrowserTab): Drop | null {
  const tab = state.tabs.find((t) => t.id === id)
  if (!tab || tab.id === target.id) return null
  const group = state.groups.find((g) => g.id === target.groupId)
  return {
    index: state.tabs.indexOf(target),
    groupId: fits(tab, group) ? group!.id : null,
    ...(tab.pinned !== target.pinned ? { pin: target.pinned } : {})
  }
}

/** Dropping tab `id` on a group's chip: it becomes the group's first tab (a pinned one is unpinned by joining). */
export function dropOnGroup(state: BrowserState, id: string, group: BrowserTabGroup): Drop | null {
  const tab = state.tabs.find((t) => t.id === id)
  if (!tab || !fits(tab, group)) return null
  const first = state.tabs.findIndex((t) => t.groupId === group.id)
  const from = state.tabs.indexOf(tab)
  return { index: from < first ? first - 1 : first, groupId: group.id }
}

/** Dropping tab `id` after every tab: last, in no group. */
export function dropAtEnd(state: BrowserState, id: string): Drop | null {
  const tab = state.tabs.find((t) => t.id === id)
  return tab ? { index: state.tabs.length, groupId: null, ...(tab.pinned ? { pin: false } : {}) } : null
}
