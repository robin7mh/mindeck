import type { BrowserSplit, BrowserTabGroup } from '@shared/types/browser'
import type { Labels } from './labels'
import type { MenuEntry } from './types'

/** What the tab menu's group and split entries are about. */
export interface ArrangeTarget {
  /** The tab is in a group. */
  grouped: boolean
  /** Groups it could join: of its kind (private or not), not its own. */
  groups: BrowserTabGroup[]
  /** The split it is in. */
  split?: BrowserSplit
  /** The tab on screen, when it is another one and not beside this one already. */
  active?: string
}

export interface ArrangeActions {
  newGroup(): void
  join(groupId: string): void
  leave(): void
  /** A split with a new tab beside this one. */
  splitNew(): void
  /** This tab beside the one on screen. */
  splitBeside(active: string): void
  updateSplit(split: BrowserSplit, patch: { swap?: boolean; vertical?: boolean }): void
  unsplit(split: BrowserSplit): void
}

/** The tab menu's entries for groups and split view (like Chrome's and Edge's). */
export function arrangeMenu(target: ArrangeTarget, a: ArrangeActions, l: Labels): MenuEntry[] {
  const noop = () => {}
  const groups: MenuEntry[] = [{ label: l.addToNewGroup, run: a.newGroup }]
  if (target.groups.length) {
    groups.push({
      label: l.addToGroup,
      run: noop,
      submenu: target.groups.map((g): MenuEntry => ({ label: g.title || l.unnamedGroup(l.colors[g.color]), run: () => a.join(g.id) }))
    })
  }
  if (target.grouped) groups.push({ label: l.removeFromGroup, run: a.leave })
  const { split, active } = target
  const splits: MenuEntry[] = split
    ? [
        { label: l.swapSides, run: () => a.updateSplit(split, { swap: true }) },
        { label: split.vertical ? l.sideBySide : l.stacked, run: () => a.updateSplit(split, { vertical: !split.vertical }) },
        { label: l.closeSplit, run: () => a.unsplit(split) }
      ]
    : [{ label: l.splitWithNewTab, run: a.splitNew }, ...(active ? [{ label: l.openBeside, run: () => a.splitBeside(active) }] : [])]
  return [...groups, { separator: true }, ...splits]
}
