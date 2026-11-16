import { randomUUID } from 'node:crypto'
import { TAB_GROUP_COLORS, type BrowserProfile, type BrowserSplit, type BrowserTabGroup, type TabGroupColor } from '@shared/types/browser'

/** What arranging needs of a tab. */
export interface Arrangeable {
  id: string
  pinned: boolean
  groupId?: string
  profile?: BrowserProfile
}

/** A split's first side takes at least this share of the space, and at most 1 minus it. */
export const MIN_RATIO = 0.1
const MAX_TITLE = 100

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

const isPrivate = (t: Arrangeable) => t.profile === 'private'

export const clampRatio = (ratio: number) => Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio))

/**
 * The tab order the browser keeps: pinned tabs first (never in a group), and
 * every group's tabs in one run, where its first tab is. Tabs that point at a
 * group that is gone, or are pinned, leave their group.
 */
export function arrange<T extends Arrangeable>(tabs: T[], groups: readonly BrowserTabGroup[]): T[] {
  const known = new Set(groups.map((g) => g.id))
  for (const t of tabs) if (t.groupId && (t.pinned || !known.has(t.groupId))) t.groupId = undefined
  const rest = tabs.filter((t) => !t.pinned)
  const out = tabs.filter((t) => t.pinned)
  const placed = new Set<string>()
  for (const t of rest) {
    if (!t.groupId) out.push(t)
    else if (!placed.has(t.groupId)) {
      placed.add(t.groupId)
      out.push(...rest.filter((x) => x.groupId === t.groupId))
    }
  }
  return out
}

/** Saved groups, if they are groups (colors only from the palette). */
export function savedGroups(raw: unknown): BrowserTabGroup[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: BrowserTabGroup[] = []
  for (const g of raw as Partial<BrowserTabGroup>[]) {
    if (typeof g?.id !== 'string' || seen.has(g.id)) continue
    seen.add(g.id)
    out.push({
      id: g.id,
      title: typeof g.title === 'string' ? g.title.slice(0, MAX_TITLE) : '',
      color: TAB_GROUP_COLORS.includes(g.color as TabGroupColor) ? (g.color as TabGroupColor) : TAB_GROUP_COLORS[0],
      collapsed: g.collapsed === true
    })
  }
  return out
}

/** Saved splits, if they are splits of two different tabs among `ids`. */
export function savedSplits(raw: unknown, ids: Set<string>): BrowserSplit[] {
  if (!Array.isArray(raw)) return []
  const used = new Set<string>()
  const out: BrowserSplit[] = []
  for (const s of raw as Partial<BrowserSplit>[]) {
    const [a, b] = (Array.isArray(s?.tabs) ? s.tabs : []) as string[]
    if (typeof s?.id !== 'string' || !ids.has(a) || !ids.has(b) || a === b || used.has(a) || used.has(b)) continue
    used.add(a).add(b)
    out.push({ id: s.id, tabs: [a, b], ratio: typeof s.ratio === 'number' && Number.isFinite(s.ratio) ? clampRatio(s.ratio) : 0.5, ...(s.vertical === true ? { vertical: true } : {}) })
  }
  return out
}

/**
 * Tab groups and split views over the browser's tabs (the tab list itself
 * stays the BrowserService's: `list` reads it, `replace` sets a new order).
 * A group is one run of tabs of one kind — private tabs never share a group
 * with others; a split pairs two tabs, each tab in at most one pair.
 */
export class TabArrangement<T extends Arrangeable> {
  groups: BrowserTabGroup[] = []
  splits: BrowserSplit[] = []

  constructor(
    private readonly list: () => T[],
    private readonly replace: (tabs: T[]) => void
  ) {}

  // --- groups -------------------------------------------------------------------

  group(id: string): BrowserTabGroup {
    const group = this.groups.find((g) => g.id === id)
    if (!group) throw coded('not-found', 'Tab group not found')
    return group
  }

  members(groupId: string): T[] {
    return this.list().filter((t) => t.groupId === groupId)
  }

  /**
   * A new group of `tabs` (pinned ones are unpinned), in one run where the
   * first of them is. Private and other tabs can't be grouped together.
   */
  create(tabs: T[], opts: { title?: string; color?: TabGroupColor } = {}): BrowserTabGroup {
    const priv = isPrivate(tabs[0])
    if (tabs.some((t) => isPrivate(t) !== priv)) throw coded('mixed-profiles', 'Private tabs and other tabs cannot share a group')
    const used = new Set(this.groups.map((g) => g.color))
    const group: BrowserTabGroup = {
      id: randomUUID(),
      title: (opts.title ?? '').trim().slice(0, MAX_TITLE),
      color: opts.color ?? TAB_GROUP_COLORS.find((c) => !used.has(c)) ?? TAB_GROUP_COLORS[this.groups.length % TAB_GROUP_COLORS.length],
      collapsed: false,
      ...(priv ? { private: true } : {})
    }
    this.groups.push(group)
    const order = this.list()
    const chosen = order.filter((t) => tabs.includes(t))
    const first = chosen.find((t) => !t.pinned) ?? chosen[0]
    const rest = order.filter((t) => !chosen.includes(t) || t === first)
    for (const t of chosen) {
      t.pinned = false
      t.groupId = group.id
    }
    // The first tab keeps its place (a pinned one goes to the first place after the pinned tabs).
    const at = rest.indexOf(first)
    rest.splice(at, 1, ...chosen)
    this.settle(rest)
    return group
  }

  update(id: string, patch: { title?: string; color?: TabGroupColor; collapsed?: boolean }): BrowserTabGroup {
    const group = this.group(id)
    if (patch.title !== undefined) group.title = patch.title.trim().slice(0, MAX_TITLE)
    if (patch.color) group.color = patch.color
    if (patch.collapsed !== undefined) group.collapsed = patch.collapsed
    return group
  }

  /** The group goes; its tabs stay where they are. */
  ungroup(id: string): void {
    this.group(id)
    for (const t of this.members(id)) t.groupId = undefined
    this.groups = this.groups.filter((g) => g.id !== id)
  }

  /** Can `tab` join `groupId`? Only a group of its own kind (private or not). */
  fits(tab: T, groupId: string): boolean {
    return !!this.group(groupId).private === isPrivate(tab)
  }

  /**
   * Puts `tab` at `index` (pinned tabs stay among the pinned ones). `group`:
   * the group it joins there (null: none; undefined: its own) — it lands inside
   * that group's run, and a tab without a group never lands inside one.
   */
  place(tab: T, index: number, group?: string | null): void {
    if (group) {
      if (!this.fits(tab, group)) throw coded('mixed-profiles', 'Private tabs and other tabs cannot share a group')
      tab.pinned = false
      tab.groupId = group
    } else if (group === null) tab.groupId = undefined
    const tabs = this.list().filter((t) => t !== tab)
    const pinned = tabs.filter((t) => t.pinned).length
    const [min, max] = tab.pinned ? [0, pinned] : [pinned, tabs.length]
    let at = Math.max(min, Math.min(max, index))
    const run = (id: string) => tabs.flatMap((t, i) => (t.groupId === id ? [i] : []))
    if (tab.groupId) {
      const own = run(tab.groupId)
      if (own.length) at = Math.max(own[0], Math.min(own[own.length - 1] + 1, at))
    } else if (!tab.pinned) {
      const before = tabs[at - 1]?.groupId
      if (before && before === tabs[at]?.groupId) at = run(before).pop()! + 1
    }
    tabs.splice(at, 0, tab)
    this.settle(tabs)
  }

  // --- split view ------------------------------------------------------------------

  splitOf(tabId: string | undefined): BrowserSplit | undefined {
    return this.splits.find((s) => s.tabs.includes(tabId as string))
  }

  split(id: string): BrowserSplit {
    const split = this.splits.find((s) => s.id === id)
    if (!split) throw coded('not-found', 'Split view not found')
    return split
  }

  /** The tab beside `tabId` in its split. */
  partner(tabId: string | undefined): string | undefined {
    const split = this.splitOf(tabId)
    return split && split.tabs[split.tabs[0] === tabId ? 1 : 0]
  }

  /** `first` and `second` side by side; the pairs either was in end. */
  pair(first: T, second: T, vertical = false): BrowserSplit {
    if (first === second) throw coded('same-tab', 'A tab cannot be split with itself')
    this.splits = this.splits.filter((s) => !s.tabs.includes(first.id) && !s.tabs.includes(second.id))
    const split: BrowserSplit = { id: randomUUID(), tabs: [first.id, second.id], ratio: 0.5, ...(vertical ? { vertical: true } : {}) }
    this.splits.push(split)
    return split
  }

  updateSplit(id: string, patch: { ratio?: number; vertical?: boolean; swap?: boolean }): BrowserSplit {
    const split = this.split(id)
    if (patch.ratio !== undefined) split.ratio = clampRatio(patch.ratio)
    if (patch.vertical !== undefined) {
      if (patch.vertical) split.vertical = true
      else delete split.vertical
    }
    if (patch.swap) {
      split.tabs = [split.tabs[1], split.tabs[0]]
      split.ratio = clampRatio(1 - split.ratio)
    }
    return split
  }

  unsplit(id: string): void {
    this.split(id)
    this.splits = this.splits.filter((s) => s.id !== id)
  }

  // --- upkeep ----------------------------------------------------------------------

  /** After tabs closed or changed: groups without tabs and splits missing a tab go, the order is kept tidy. */
  prune(): void {
    this.settle(this.list())
  }

  /** Groups and splits from the last session, for the tabs that came back. */
  restore(groups: unknown, splits: unknown): void {
    this.groups = savedGroups(groups)
    this.splits = savedSplits(splits, new Set(this.list().map((t) => t.id)))
    this.prune()
  }

  /** What the session keeps: groups and splits of the tabs that are saved. */
  saved(kept: T[]): { groups: BrowserTabGroup[]; splits: BrowserSplit[] } {
    const ids = new Set(kept.map((t) => t.id))
    const used = new Set(kept.map((t) => t.groupId))
    return {
      groups: this.groups.filter((g) => used.has(g.id)).map(({ private: _private, ...g }) => g),
      splits: this.splits.filter((s) => ids.has(s.tabs[0]) && ids.has(s.tabs[1]))
    }
  }

  private settle(tabs: T[]): void {
    const order = arrange(tabs, this.groups)
    const used = new Set(order.map((t) => t.groupId))
    const ids = new Set(order.map((t) => t.id))
    this.groups = this.groups.filter((g) => used.has(g.id))
    this.splits = this.splits.filter((s) => ids.has(s.tabs[0]) && ids.has(s.tabs[1]))
    this.replace(order)
  }
}
