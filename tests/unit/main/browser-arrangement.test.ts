import { describe, expect, it, vi } from 'vitest'
import { arrange, clampRatio, savedGroups, savedSplits, TabArrangement, type Arrangeable } from '../../../electron/main/services/browser/arrangement'
import { arrangeMenu, type ArrangeActions } from '../../../electron/main/services/browser/arrangeMenu'
import { labels } from '../../../electron/main/services/browser/labels'
import type { MenuEntry } from '../../../electron/main/services/browser/types'
import type { BrowserTabGroup } from '@shared/types/browser'

const tab = (id: string, extra: Partial<Arrangeable> = {}): Arrangeable => ({ id, pinned: false, ...extra })
const group = (id: string, extra: Partial<BrowserTabGroup> = {}): BrowserTabGroup => ({ id, title: '', color: 'cyan', collapsed: false, ...extra })

/** An arrangement over a plain list of tabs. */
function setup(tabs: Arrangeable[]) {
  const list = { tabs }
  const a = new TabArrangement<Arrangeable>(
    () => list.tabs,
    (next) => (list.tabs = next)
  )
  const ids = () => list.tabs.map((t) => t.id)
  const byId = (id: string) => list.tabs.find((t) => t.id === id)!
  return { a, list, ids, byId }
}

describe('arranging tabs', () => {
  it('keeps pinned tabs first and each group’s tabs together, where its first tab is', () => {
    const tabs = [tab('a', { groupId: 'g' }), tab('b'), tab('p', { pinned: true, groupId: 'g' }), tab('c', { groupId: 'g' }), tab('d', { groupId: 'gone' })]
    const out = arrange(tabs, [group('g')])
    expect(out.map((t) => t.id)).toEqual(['p', 'a', 'c', 'b', 'd'])
    // a pinned tab and a tab of a group that is gone are in no group
    expect(out.map((t) => t.groupId)).toEqual([undefined, 'g', 'g', undefined, undefined])
  })

  it('reads saved groups and splits, leaving out what is not one', () => {
    expect(savedGroups('nope')).toEqual([])
    expect(
      savedGroups([
        { id: 'g1', title: 'Work', color: 'green', collapsed: true },
        { id: 'g1', title: 'Twice' },
        { id: 'g2', title: 42, color: '#ff0000' },
        { id: 'g3', title: 'x'.repeat(150), color: 'amber', private: true },
        null,
        { title: 'no id' }
      ])
    ).toEqual([group('g1', { title: 'Work', color: 'green', collapsed: true }), group('g2'), group('g3', { title: 'x'.repeat(100), color: 'amber' })])
    const ids = new Set(['a', 'b', 'c', 'd'])
    expect(savedSplits({}, ids)).toEqual([])
    expect(
      savedSplits(
        [
          { id: 's1', tabs: ['a', 'b'], ratio: 0.95, vertical: true },
          { id: 's2', tabs: ['b', 'c'] }, // b is in a split already
          { id: 's3', tabs: ['c', 'c'] },
          { id: 's4', tabs: ['c', 'zz'] },
          { id: 's5', tabs: 'c,d' },
          { tabs: ['c', 'd'] },
          { id: 's6', tabs: ['c', 'd'], ratio: Number.NaN }
        ],
        ids
      )
    ).toEqual([
      { id: 's1', tabs: ['a', 'b'], ratio: 0.9, vertical: true },
      { id: 's6', tabs: ['c', 'd'], ratio: 0.5 }
    ])
    expect([clampRatio(0), clampRatio(0.3), clampRatio(1)]).toEqual([0.1, 0.3, 0.9])
  })
})

describe('tab groups', () => {
  it('makes a group of tabs where the first of them is — unpinning pinned ones, in a color not taken yet', () => {
    const { a, ids, byId } = setup([tab('p', { pinned: true }), tab('a'), tab('b'), tab('c'), tab('d')])
    const g1 = a.create([byId('c'), byId('a')], { title: '  Research  ' })
    expect(g1).toMatchObject({ title: 'Research', color: 'cyan', collapsed: false })
    expect(g1.private).toBeUndefined()
    expect(ids()).toEqual(['p', 'a', 'c', 'b', 'd'])
    expect(a.members(g1.id).map((t) => t.id)).toEqual(['a', 'c'])
    // a pinned tab alone: unpinned, first after the pinned tabs
    const g2 = a.create([byId('p')], { color: 'amber' })
    expect(g2.color).toBe('amber')
    expect(byId('p')).toMatchObject({ pinned: false, groupId: g2.id })
    expect(ids()).toEqual(['p', 'a', 'c', 'b', 'd'])
    // taking a group's last tab away ends it
    const g3 = a.create([byId('p'), byId('d')])
    expect(g3.color).toBe('blue')
    expect(a.groups.map((g) => g.id)).toEqual([g1.id, g3.id])
    expect(ids()).toEqual(['p', 'd', 'a', 'c', 'b'])
    expect(() => a.group(g2.id)).toThrow(expect.objectContaining({ code: 'not-found' }))
  })

  it('never mixes private tabs with others, and cycles colors once all are taken', () => {
    const { a, byId } = setup([tab('a'), tab('x', { profile: 'private' }), tab('b'), tab('c'), tab('d'), tab('e'), tab('f'), tab('h')])
    expect(() => a.create([byId('a'), byId('x')])).toThrow(expect.objectContaining({ code: 'mixed-profiles' }))
    const priv = a.create([byId('x')])
    expect(priv.private).toBe(true)
    expect(a.fits(byId('a'), priv.id)).toBe(false)
    expect(a.fits(byId('x'), priv.id)).toBe(true)
    for (const id of ['a', 'b', 'c', 'd', 'e']) a.create([byId(id)])
    expect(a.groups.map((g) => g.color)).toEqual(['cyan', 'blue', 'purple', 'green', 'amber', 'danger'])
    expect(a.create([byId('f')]).color).toBe('cyan') // 6 groups: around again
  })

  it('renames, recolors, folds and dissolves groups', () => {
    const { a, byId } = setup([tab('a'), tab('b')])
    const g = a.create([byId('a'), byId('b')])
    a.update(g.id, { title: ' Docs ', color: 'purple', collapsed: true })
    expect(a.group(g.id)).toMatchObject({ title: 'Docs', color: 'purple', collapsed: true })
    a.update(g.id, {})
    expect(a.group(g.id)).toMatchObject({ title: 'Docs', color: 'purple', collapsed: true })
    a.ungroup(g.id)
    expect(a.groups).toEqual([])
    expect(byId('a').groupId).toBeUndefined()
    expect(() => a.ungroup(g.id)).toThrow(expect.objectContaining({ code: 'not-found' }))
    expect(() => a.update('nope', {})).toThrow(expect.objectContaining({ code: 'not-found' }))
  })

  it('moves tabs into, within and out of groups — never into the middle of another group', () => {
    const { a, ids, byId } = setup([tab('p', { pinned: true }), tab('a'), tab('b'), tab('c'), tab('d'), tab('x', { profile: 'private' })])
    const g = a.create([byId('b'), byId('c')])
    expect(ids()).toEqual(['p', 'a', 'b', 'c', 'd', 'x'])
    // joining: inside the group's run, wherever it was asked to go
    a.place(byId('d'), 0, g.id)
    expect(ids()).toEqual(['p', 'a', 'd', 'b', 'c', 'x'])
    a.place(byId('a'), 99, g.id)
    expect(ids()).toEqual(['p', 'd', 'b', 'c', 'a', 'x'])
    // a pinned tab joining is unpinned
    a.place(byId('p'), 2, g.id)
    expect(byId('p')).toMatchObject({ pinned: false, groupId: g.id })
    expect(ids()).toEqual(['d', 'b', 'p', 'c', 'a', 'x'])
    // leaving: not between two tabs of the group — after it
    a.place(byId('b'), 2, null)
    expect(byId('b').groupId).toBeUndefined()
    expect(ids()).toEqual(['d', 'p', 'c', 'a', 'b', 'x'])
    // as it is (undefined): a grouped tab stays in its run, an ungrouped one stays out of runs
    a.place(byId('d'), 5)
    expect(ids()).toEqual(['p', 'c', 'a', 'd', 'b', 'x'])
    a.place(byId('x'), 1)
    expect(ids()).toEqual(['p', 'c', 'a', 'd', 'x', 'b'])
    a.place(byId('x'), 0)
    expect(ids()).toEqual(['x', 'p', 'c', 'a', 'd', 'b'])
    // a private tab can't join an ordinary group
    expect(() => a.place(byId('x'), 2, g.id)).toThrow(expect.objectContaining({ code: 'mixed-profiles' }))
    expect(() => a.place(byId('x'), 2, 'nope')).toThrow(expect.objectContaining({ code: 'not-found' }))
    // pinned tabs move among the pinned ones only
    byId('b').pinned = true
    a.prune()
    a.place(byId('b'), 5)
    expect(ids()[0]).toBe('b')
    // the only tab of its group goes wherever it is asked to (after the pinned ones)
    a.create([byId('a')])
    a.place(byId('a'), 0)
    expect(ids()[1]).toBe('a')
  })
})

describe('split views', () => {
  it('pairs two tabs (each in one pair at most), moves the divider, stacks, swaps and ends', () => {
    const { a, byId, list } = setup([tab('a'), tab('b'), tab('c')])
    expect(() => a.pair(byId('a'), byId('a'))).toThrow(expect.objectContaining({ code: 'same-tab' }))
    const s1 = a.pair(byId('a'), byId('b'))
    expect(s1).toMatchObject({ tabs: ['a', 'b'], ratio: 0.5 })
    expect(s1.vertical).toBeUndefined()
    expect(a.splitOf('b')).toBe(s1)
    expect([a.partner('a'), a.partner('b'), a.partner('c'), a.partner(undefined)]).toEqual(['b', 'a', undefined, undefined])
    // b in a new pair: the old one ends
    const s2 = a.pair(byId('c'), byId('b'), true)
    expect(a.splits).toEqual([s2])
    expect(s2.vertical).toBe(true)
    a.updateSplit(s2.id, { ratio: 0.3 })
    a.updateSplit(s2.id, { swap: true })
    expect(a.split(s2.id)).toMatchObject({ tabs: ['b', 'c'], ratio: 0.7 })
    a.updateSplit(s2.id, { vertical: false, ratio: 5 })
    expect(a.split(s2.id).vertical).toBeUndefined()
    expect(a.split(s2.id).ratio).toBe(0.9)
    a.updateSplit(s2.id, { vertical: true })
    expect(a.split(s2.id).vertical).toBe(true)
    // a tab of the pair closes: the pair ends
    list.tabs = list.tabs.filter((t) => t.id !== 'c')
    a.prune()
    expect(a.splits).toEqual([])
    const s3 = a.pair(byId('a'), byId('b'))
    a.unsplit(s3.id)
    expect(a.splits).toEqual([])
    expect(() => a.unsplit(s3.id)).toThrow(expect.objectContaining({ code: 'not-found' }))
    expect(() => a.updateSplit('nope', {})).toThrow(expect.objectContaining({ code: 'not-found' }))
  })

  it('restores groups and splits for the tabs that came back, and keeps those of saved tabs', () => {
    const { a, ids, byId, list } = setup([tab('a', { groupId: 'g1' }), tab('b'), tab('c', { groupId: 'g1' }), tab('x', { profile: 'private', groupId: 'gx' })])
    a.restore(
      [group('g1', { title: 'Work' }), group('g2'), group('gx')],
      [
        { id: 's', tabs: ['a', 'b'], ratio: 0.4 },
        { id: 't', tabs: ['c', 'gone'] }
      ]
    )
    // a group without tabs is not kept; a group's tabs are together
    expect(a.groups.map((g) => g.id)).toEqual(['g1', 'gx'])
    expect(ids()).toEqual(['a', 'c', 'b', 'x'])
    expect(a.splits).toEqual([{ id: 's', tabs: ['a', 'b'], ratio: 0.4 }])
    // what the session keeps: groups and splits of the tabs it saves (never a private group, and no `private` mark)
    a.groups.find((g) => g.id === 'g1')!.private = true
    const kept = list.tabs.filter((t) => t.id !== 'x')
    expect(a.saved(kept)).toEqual({ groups: [group('g1', { title: 'Work' })], splits: [{ id: 's', tabs: ['a', 'b'], ratio: 0.4 }] })
    expect(a.saved([byId('c')])).toEqual({ groups: [group('g1', { title: 'Work' })], splits: [] })
  })
})

describe('the tab menu’s groups and split view', () => {
  const l = labels('en')
  const actions = (): { [K in keyof ArrangeActions]: ReturnType<typeof vi.fn> } => ({
    newGroup: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
    splitNew: vi.fn(),
    splitBeside: vi.fn(),
    updateSplit: vi.fn(),
    unsplit: vi.fn()
  })
  const names = (m: MenuEntry[]) => m.map((e) => ('label' in e ? e.label : '—'))
  const find = (m: MenuEntry[], label: string) => m.find((e) => 'label' in e && e.label === label) as Exclude<MenuEntry, { separator: true }>

  it('offers a new group, the other groups, leaving the group — and a split with a new tab or beside the tab on screen', () => {
    const a = actions()
    const m = arrangeMenu({ grouped: true, groups: [group('g1', { title: 'Work' }), group('g2', { color: 'danger' })], active: 'other' }, a as unknown as ArrangeActions, l)
    expect(names(m)).toEqual(['Add Tab to New Group', 'Add Tab to Group', 'Remove from Group', '—', 'Split with New Tab', 'Open Beside Current Tab'])
    find(m, 'Add Tab to New Group').run()
    find(m, 'Add Tab to Group').run() // opens its submenu; does nothing itself
    const sub = find(m, 'Add Tab to Group').submenu!
    expect(names(sub)).toEqual(['Work', 'Unnamed Group (Red)'])
    find(sub, 'Unnamed Group (Red)').run()
    find(m, 'Remove from Group').run()
    find(m, 'Split with New Tab').run()
    find(m, 'Open Beside Current Tab').run()
    expect(a.newGroup).toHaveBeenCalled()
    expect(a.join).toHaveBeenCalledWith('g2')
    expect(a.leave).toHaveBeenCalled()
    expect(a.splitNew).toHaveBeenCalled()
    expect(a.splitBeside).toHaveBeenCalledWith('other')
    // the tab on screen itself, no other groups: no submenu, nothing to open beside
    expect(names(arrangeMenu({ grouped: false, groups: [] }, a as unknown as ArrangeActions, labels('de')))).toEqual(['Zu neuer Gruppe hinzufügen', '—', 'Mit neuem Tab teilen'])
    const de = arrangeMenu({ grouped: false, groups: [group('g', { color: 'green' })] }, a as unknown as ArrangeActions, labels('de'))
    expect(names(find(de, 'Zu Gruppe hinzufügen').submenu!)).toEqual(['Unbenannte Gruppe (Grün)'])
  })

  it('in a split: swap the sides, stack or unstack, end it', () => {
    const a = actions()
    const split = { id: 's', tabs: ['a', 'b'] as [string, string], ratio: 0.5 }
    let m = arrangeMenu({ grouped: false, groups: [], split }, a as unknown as ArrangeActions, l)
    expect(names(m)).toEqual(['Add Tab to New Group', '—', 'Swap Sides', 'Stack Top and Bottom', 'Close Split View'])
    find(m, 'Swap Sides').run()
    find(m, 'Stack Top and Bottom').run()
    find(m, 'Close Split View').run()
    expect(a.updateSplit.mock.calls).toEqual([
      [split, { swap: true }],
      [split, { vertical: true }]
    ])
    expect(a.unsplit).toHaveBeenCalledWith(split)
    m = arrangeMenu({ grouped: false, groups: [], split: { ...split, vertical: true } }, a as unknown as ArrangeActions, l)
    find(m, 'Side by Side').run()
    expect(a.updateSplit).toHaveBeenLastCalledWith({ ...split, vertical: true }, { vertical: false })
  })
})
