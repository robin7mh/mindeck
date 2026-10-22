import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tick } from './helpers'
import { lastMenu, menuEntry, setupBrowser } from './browserServiceFixtures'

const area = { x: 0, y: 0, width: 1000, height: 600 }
const ids = (b: { state(): { tabs: { id: string }[] } }) => b.state().tabs.map((t) => t.id)

describe('BrowserService · tab groups', () => {
  it('groups tabs, renames, recolors, folds, dissolves and closes groups — and shows them in the state', async () => {
    const { b, host } = await setupBrowser()
    b.attach(host)
    const first = b.state().tabs[0]
    const a = b.open({ url: 'https://a.dev/' })
    const c = b.open({ url: 'https://c.dev/' })
    const g = b.group([c.id, first.id], { title: 'Work', color: 'green' })
    expect(g).toMatchObject({ title: 'Work', color: 'green', collapsed: false })
    expect(ids(b)).toEqual([first.id, c.id, a.id])
    expect(b.state().groups).toEqual([g])
    expect(b.state().tabs.map((t) => t.groupId)).toEqual([g.id, g.id, undefined])
    b.updateGroup(g.id, { title: 'Docs', color: 'amber' })
    expect(b.state().groups[0]).toMatchObject({ title: 'Docs', color: 'amber' })
    // folding the group of the tab on screen (c): the next tab outside it comes up
    b.updateGroup(g.id, { collapsed: true })
    expect(b.state().activeId).toBe(a.id)
    // a tab of the folded group comes up again (tab search, a shortcut): the group unfolds
    b.activate(c.id)
    expect(b.state().groups[0].collapsed).toBe(false)
    // nothing after it: the one before it
    b.move(a.id, 0)
    expect(ids(b)).toEqual([a.id, first.id, c.id])
    b.updateGroup(g.id, { collapsed: true })
    expect(b.state().activeId).toBe(a.id)
    // folding a group not on screen changes nothing else
    b.updateGroup(g.id, { collapsed: false })
    b.updateGroup(g.id, { collapsed: true })
    expect(b.state().activeId).toBe(a.id)
    b.ungroup(g.id)
    expect(b.state().groups).toEqual([])
    expect(b.state().tabs.every((t) => !t.groupId)).toBe(true)
    // closing a group closes its tabs
    const g2 = b.group([first.id, c.id])
    b.closeGroup(g2.id)
    expect(ids(b)).toEqual([a.id])
    expect(b.state().groups).toEqual([])
    expect(() => b.closeGroup(g2.id)).toThrow(expect.objectContaining({ code: 'not-found' }))
    // the only tabs fold away: a new tab comes up
    const g3 = b.group([a.id])
    b.updateGroup(g3.id, { collapsed: true })
    expect(b.state().tabs).toHaveLength(2)
    expect(b.state().tabs.find((t) => t.id === b.state().activeId)).toMatchObject({ url: '' })
    expect(() => b.group([a.id, 'nope'])).toThrow(expect.objectContaining({ code: 'not-found' }))
  })

  it('moves tabs into and out of groups, keeps opened tabs in their opener’s group, and puts reopened tabs back', async () => {
    const { b, host, events } = await setupBrowser()
    b.attach(host)
    const first = b.state().tabs[0]
    const a = b.open({ url: 'https://a.dev/' })
    const c = b.open({ url: 'https://c.dev/' })
    const g = b.group([a.id])
    b.move(c.id, 0, g.id)
    expect(ids(b)).toEqual([first.id, c.id, a.id])
    expect(b.state().tabs.find((t) => t.id === c.id)!.groupId).toBe(g.id)
    // a link from a grouped tab: a tab in the same group; a private one stays out
    events.openTab('https://link.dev/', { background: true, opener: a.id })
    const link = b.state().tabs.find((t) => t.url === 'https://link.dev/')!
    expect(link.groupId).toBe(g.id)
    events.openTab('https://secret.dev/', { background: true, opener: a.id, private: true })
    expect(b.state().tabs.find((t) => t.url === 'https://secret.dev/')!.groupId).toBeUndefined()
    expect(b.duplicate(first.id).groupId).toBeUndefined()
    // out of the group again
    b.move(c.id, 1, null)
    expect(b.state().tabs.find((t) => t.id === c.id)!.groupId).toBeUndefined()
    expect(() => b.move(c.id, 0, 'nope')).toThrow(expect.objectContaining({ code: 'not-found' }))
    // pinning takes a tab out of its group
    b.update(link.id, { pinned: true })
    expect(b.state().tabs[0]).toMatchObject({ id: link.id, pinned: true })
    expect(b.state().tabs[0].groupId).toBeUndefined()
    // closed and reopened: back in its group while that is open
    b.close(a.id)
    expect(b.state().groups).toEqual([]) // its last tab: the group is gone
    const g2 = b.group([c.id])
    const back = b.open({ url: 'https://back.dev/' })
    b.move(back.id, 0, g2.id)
    b.close(back.id)
    expect(b.reopen()!.groupId).toBe(g2.id)
    // the group closed meanwhile: just a tab
    b.closeGroup(g2.id)
    const reopened = b.reopen()!
    expect(reopened.url).toBe('https://c.dev/')
    expect(reopened.groupId).toBeUndefined()
  })
})

describe('BrowserService · split view', () => {
  it('splits with a new tab or a tab of its own — the newcomer gets the focus — and shows both pages', async () => {
    const { b, host, sent } = await setupBrowser()
    b.attach(host)
    b.setView(area)
    const first = b.state().tabs[0]
    const a = b.open({ url: 'https://a.dev/' })
    const g = b.group([a.id])
    // with a new tab: beside it, in its group, its address bar takes the keyboard
    host.focusUi.mockClear()
    const s1 = b.split(a.id)
    const fresh = b.state().tabs.find((t) => t.id === s1.tabs[1])!
    expect(fresh).toMatchObject({ url: '', groupId: g.id })
    expect(ids(b)).toEqual([first.id, a.id, fresh.id])
    expect(b.state().activeId).toBe(fresh.id)
    expect(b.state().splits).toEqual([s1])
    expect(sent('browser:command').at(-1)).toEqual({ command: 'focusOmnibox' })
    expect(host.focusUi).toHaveBeenCalled()
    // the new tab has no page: only the other one shows
    expect(host.show).toHaveBeenLastCalledWith(undefined, a.id)
    // with an existing tab
    const c = b.open({ url: 'https://c.dev/', background: true })
    const s2 = b.split(a.id, c.id, true)
    expect(b.state().splits).toEqual([s2]) // a was in s1: that one ended
    expect(s2).toMatchObject({ tabs: [a.id, c.id], vertical: true })
    expect(b.state().activeId).toBe(c.id) // a was not on screen: c came, c has the focus
    expect(host.show).toHaveBeenLastCalledWith(c.id, a.id)
    // dropped on the left of the page on screen: the dragged tab comes first, and gets the focus
    const d = b.open({ url: 'https://d.dev/', background: true })
    const s3 = b.split(d.id, c.id)
    expect(s3.tabs).toEqual([d.id, c.id])
    expect(b.state().activeId).toBe(d.id)
    // a private tab splits with a new private tab
    const p = b.open({ private: true })
    const s4 = b.split(p.id)
    expect(b.state().tabs.find((t) => t.id === s4.tabs[1])!.profile).toBe('private')
    expect(() => b.split(a.id, a.id)).toThrow(expect.objectContaining({ code: 'same-tab' }))
    expect(() => b.split('nope')).toThrow(expect.objectContaining({ code: 'not-found' }))
  })

  it('follows the panes the UI reports, moves the focus to the side clicked into, and ends with a closed tab', async () => {
    // tabs of a session brought back after a crash: they load once on screen
    const { b, host, events } = await setupBrowser({
      session: { exit: 'running', activeId: 'a', tabs: [{ id: 'a', url: 'https://a.dev/', title: 'A' }, { id: 'c', url: 'https://c.dev/', title: 'C' }] }
    })
    b.restoreSession(true)
    b.attach(host)
    const [a, c] = b.state().tabs
    const s = b.split(a.id, c.id)
    expect(host.create).not.toHaveBeenCalled() // not on screen yet
    const panes = [
      { id: a.id, bounds: { x: 0, y: 0, width: 497, height: 600 } },
      { id: c.id, bounds: { x: 503, y: 0, width: 497, height: 600 } }
    ]
    b.setView(area, true, panes)
    expect(host.setBounds).toHaveBeenLastCalledWith(area, true, panes)
    expect(host.create.mock.calls.map(([id]) => id).sort()).toEqual([a.id, c.id].sort())
    expect(host.show).toHaveBeenLastCalledWith(c.id, a.id)
    // panes only count while the module is on screen
    b.setView(null, true, panes)
    expect(host.setBounds).toHaveBeenLastCalledWith(null, true)
    b.setView(area, false)
    expect(host.setBounds).toHaveBeenLastCalledWith(area, false)
    // the user clicks into the other page: it gets the focus; a page outside the split does not
    events.focused(a.id)
    expect(b.state().activeId).toBe(a.id)
    const other = b.open({ url: 'https://o.dev/', background: true })
    events.focused(other.id)
    expect(b.state().activeId).toBe(a.id)
    // an error page on one side: only the other page's view
    events.failed(c.id, { code: -105, description: 'NAME_NOT_RESOLVED', url: 'https://c.dev/' })
    expect(host.show).toHaveBeenLastCalledWith(a.id)
    // the divider, the sides, stacking
    b.updateSplit(s.id, { ratio: 0.3, swap: true, vertical: true })
    expect(b.state().splits[0]).toMatchObject({ tabs: [c.id, a.id], ratio: 0.7, vertical: true })
    // the focused page closes: the one beside it takes over; the split ends
    b.close(a.id)
    expect(b.state().activeId).toBe(c.id)
    expect(b.state().splits).toEqual([])
    // ended by the user
    const s2 = b.split(c.id, other.id)
    b.unsplit(s2.id)
    expect(b.state().splits).toEqual([])
    expect(() => b.unsplit(s2.id)).toThrow(expect.objectContaining({ code: 'not-found' }))
    // the window closes: the panes are gone with it
    b.split(c.id, other.id)
    b.detach()
    b.attach(host)
    host.setBounds.mockClear()
    b.setView(area)
    expect(host.setBounds).toHaveBeenLastCalledWith(area, true)
  })

  it('gives agents the page the user works in — in a split the focused side, then the other', async () => {
    const { b, host } = await setupBrowser()
    b.attach(host)
    const a = b.open({ url: 'https://a.dev/' })
    const local = b.open({ url: 'http://localhost:5173/', background: true })
    expect(b.onScreen()).toEqual([a.id])
    b.split(a.id, local.id)
    expect(b.onScreen()).toEqual([local.id, a.id])
    expect(b.agentTab().id).toBe(local.id)
    // the focus on the side agents can't see: the shared one beside it
    b.activate(a.id)
    expect(b.agentTab().id).toBe(local.id)
  })
})

describe('BrowserService · keys and menus for groups and split view', () => {
  it('⌘⇧G groups the tab on screen and asks for a name; ⌘⇧D splits and unsplits; ⌘⇧, toggles vertical tabs', async () => {
    const { b, host, events, sent } = await setupBrowser()
    b.attach(host)
    const a = b.open({ url: 'https://a.dev/' })
    events.shortcut('newGroup')
    const g = b.state().groups[0]
    expect(b.state().tabs.find((t) => t.id === a.id)!.groupId).toBe(g.id)
    expect(sent('browser:command').at(-1)).toEqual({ command: 'editGroup', id: g.id })
    events.shortcut('split')
    expect(b.state().splits).toHaveLength(1)
    events.shortcut('split')
    expect(b.state().splits).toEqual([])
    events.shortcut('verticalTabs')
    expect(sent('browser:command').at(-1)).toEqual({ command: 'verticalTabs' })
  })

  it('the tab menu groups, splits and turns vertical tabs on — each entry doing what it says', async () => {
    const { b, host, sent } = await setupBrowser({ deps: { appForUrl: undefined } })
    b.attach(host)
    const first = b.state().tabs[0]
    const a = b.open({ url: 'https://a.dev/' })
    const c = b.open({ url: 'https://c.dev/', background: true })
    const p = b.open({ private: true, background: true })
    const work = b.group([first.id], { title: 'Work' })
    const secret = b.group([p.id], { title: 'Secret' })
    // c (not on screen): new group, other groups of its kind, open beside the tab on screen
    b.tool(c.id, 'tabMenu')
    expect(menuEntry(lastMenu(host), 'Add Tab to Group').submenu!.map((e) => ('label' in e ? e.label : ''))).toEqual(['Work'])
    menuEntry(menuEntry(lastMenu(host), 'Add Tab to Group').submenu!, 'Work').run()
    expect(b.state().tabs.find((t) => t.id === c.id)!.groupId).toBe(work.id)
    b.tool(c.id, 'tabMenu')
    expect(lastMenu(host).map((e) => ('label' in e ? e.label : '—'))).toContain('Remove from Group')
    menuEntry(lastMenu(host), 'Remove from Group').run()
    expect(b.state().tabs.find((t) => t.id === c.id)!.groupId).toBeUndefined()
    expect(ids(b).indexOf(c.id)).toBeGreaterThan(ids(b).indexOf(first.id)) // right after the group
    b.tool(c.id, 'tabMenu')
    menuEntry(lastMenu(host), 'Add Tab to New Group').run()
    expect(b.state().groups).toHaveLength(3)
    expect(sent('browser:command').at(-1)).toMatchObject({ command: 'editGroup' })
    // the private tab sees only the private group (its own: none to join)
    b.tool(p.id, 'tabMenu')
    expect(lastMenu(host).map((e) => ('label' in e ? e.label : '—'))).not.toContain('Add Tab to Group')
    expect(secret.private).toBe(true)

    b.tool(c.id, 'tabMenu')
    menuEntry(lastMenu(host), 'Open Beside Current Tab').run()
    const split = b.state().splits[0]
    expect(split.tabs).toEqual([a.id, c.id])
    // in the split: swap, stack, end — and no "open beside" for the tab beside the one on screen
    b.tool(a.id, 'tabMenu')
    expect(lastMenu(host).map((e) => ('label' in e ? e.label : '—'))).not.toContain('Open Beside Current Tab')
    menuEntry(lastMenu(host), 'Swap Sides').run()
    b.tool(a.id, 'tabMenu')
    menuEntry(lastMenu(host), 'Stack Top and Bottom').run()
    expect(b.state().splits[0]).toMatchObject({ tabs: [c.id, a.id], vertical: true })
    b.tool(a.id, 'tabMenu')
    menuEntry(lastMenu(host), 'Close Split View').run()
    expect(b.state().splits).toEqual([])
    b.tool(a.id, 'tabMenu')
    menuEntry(lastMenu(host), 'Split with New Tab').run()
    expect(b.state().splits[0].tabs[0]).toBe(a.id)
    // vertical tabs: checked as the setting is, the UI toggles it
    b.tool(a.id, 'tabMenu')
    expect(menuEntry(lastMenu(host), 'Vertical Tabs').checked).toBe(false)
    menuEntry(lastMenu(host), 'Vertical Tabs').run()
    expect(sent('browser:command').at(-1)).toEqual({ command: 'verticalTabs' })
  })
})

describe('BrowserService · groups and splits across restarts', () => {
  it('keeps groups and splits in the session — never private ones — for a crash; a clean start begins anew', async () => {
    const { b, dir } = await setupBrowser()
    const first = b.state().tabs[0]
    const a = b.open({ url: 'https://a.dev/' })
    const c = b.open({ url: 'https://c.dev/' })
    const p = b.open({ private: true })
    const q = b.open({ private: true })
    const g = b.group([a.id, c.id], { title: 'Work', color: 'purple' })
    b.group([p.id, q.id])
    const s = b.split(a.id, first.id)
    b.split(p.id, q.id)
    await b.dispose()
    const saved = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'))
    expect(saved.groups).toEqual([{ id: g.id, title: 'Work', color: 'purple', collapsed: false }])
    expect(saved.splits).toEqual([{ id: s.id, tabs: [a.id, first.id], ratio: 0.5 }])
    expect(saved.tabs.find((t: { id: string }) => t.id === c.id).groupId).toBe(g.id)

    // Quit cleanly: one new tab, no groups or splits; the pages wait in the closed tabs.
    const again = await setupBrowser({ dir })
    expect(again.state()).toMatchObject({ groups: [], splits: [], closed: 2 })
    expect(again.state().tabs).toEqual([expect.objectContaining({ url: '' })])
  })

  it('after a crash: groups and splits wait with their tabs, are saved meanwhile, and come back with them', async () => {
    const session = {
      exit: 'running',
      activeId: 'a',
      tabs: [
        { id: 'a', url: 'https://a.dev/', title: 'A', groupId: 'g' },
        { id: 'b', url: 'https://b.dev/', title: 'B', groupId: 'g' },
        { id: 'c', url: 'https://c.dev/', title: 'C', groupId: 7 }
      ],
      groups: [{ id: 'g', title: 'Work', color: 'green', collapsed: false }],
      splits: [{ id: 's', tabs: ['a', 'c'], ratio: 0.6 }],
      closed: [{ url: 'https://x.dev/', index: 0, groupId: 'g' }]
    }
    const { b, dir } = await setupBrowser({ session })
    expect(b.state().groups).toEqual([])
    b.open({ url: 'https://new.dev/' })
    await tick(450)
    const saved = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'))
    expect(saved.groups).toEqual(session.groups)
    expect(saved.splits).toEqual(session.splits)
    b.restoreSession(true)
    expect(b.state().groups).toEqual(session.groups)
    expect(b.state().splits).toEqual(session.splits)
    expect(b.state().tabs.find((t) => t.id === 'c')!.groupId).toBeUndefined()
    // the closed tab of the group goes back into it
    expect(b.reopen()!.groupId).toBe('g')
  })
})
