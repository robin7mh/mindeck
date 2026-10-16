import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge, settle } from './bridge'
import { state, tab } from './browserFixtures'
import { bridge, dataTransfer, folder, library, link } from './browserLibraryFixtures'
import { useBrowser } from '@/features/browser/store'
import { useOverlays } from '@/lib/overlay'
import { useLocale } from '@/lib/i18n'
import { byDay, dayStart, findByUrl, findNode, folderChoices, nodeName, searchBookmarks, tabLabel, walk } from '@/features/browser/library'
import { ENGINE_LABELS, inlineCompletion, withSuggestions } from '@/features/browser/url'
import { BookmarkEditor } from '@/features/browser/components/BookmarkEditor'
import { BOOKMARK_DRAG, BookmarksBar } from '@/features/browser/components/BookmarksBar'
import { TabSearch } from '@/features/browser/components/TabSearch'
import { RestoreBar } from '@/features/browser/components/RestoreBar'
import { RemoteUseBar } from '@/features/browser/components/RemoteUseBar'
import { Omnibox } from '@/features/browser/components/Omnibox'
import { Viewport } from '@/features/browser/components/Viewport'
import { TabStrip } from '@/features/browser/components/TabStrip'
import { BrowserView } from '@/features/browser/components/BrowserView'
import { BrowserCard } from '@/features/settings/components/BrowserCard'
import { DEFAULT_BROWSER_SETTINGS, type BrowserSuggestion } from '@shared/types/browser'

const initialBrowser = useBrowser.getState()
beforeEach(() => {
  useBrowser.setState(initialBrowser, true)
  useOverlays.setState({ count: 0 })
  useLocale.setState({ locale: 'en' })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const tree = library(
  [link('a', 'Alpha', 'https://alpha.dev/'), folder('dev', 'Dev', [link('m', 'MDN', 'https://mdn.dev/'), folder('deep', 'Deep', [link('x', '', 'https://x.dev/')]), folder('void', 'Void')])],
  [link('o', 'Other one', 'https://other.dev/')]
)

describe('the library helpers', () => {
  it('find bookmarks and folders, list folders to pick and search', () => {
    expect(findByUrl(tree, 'https://mdn.dev/')!.id).toBe('m')
    expect(findByUrl(tree, 'https://none.dev/')).toBeUndefined()
    expect(findNode(tree, 'bar')).toEqual({ node: tree[0] })
    expect(findNode(tree, 'x')!.parent!.id).toBe('deep')
    expect(findNode(tree, 'gone')).toBeUndefined()
    expect(walk(tree).find((w) => w.node.id === 'x')!.path).toEqual(['Dev', 'Deep'])
    const name = (id: string) => (id === 'bar' ? 'Bar' : 'Other')
    expect(folderChoices(tree, name).map((f) => [f.label, f.depth])).toEqual([
      ['Bar', 0],
      ['Dev', 1],
      ['Deep', 2],
      ['Void', 2],
      ['Other', 0]
    ])
    expect(folderChoices(tree, name, 'dev').map((f) => f.label)).toEqual(['Bar', 'Other'])
    expect(searchBookmarks(tree, '  ')).toEqual([])
    expect(searchBookmarks(tree, 'DEV').map((b) => b.id)).toEqual(['a', 'm', 'x', 'o'])
    expect(searchBookmarks(tree, 'dev mdn')[0].path).toEqual(['Dev'])
    expect(searchBookmarks(tree, 'dev', 2)).toHaveLength(2)
  })

  it('group history by day and name tabs', () => {
    const day = new Date(2026, 9, 15, 15).getTime()
    expect(dayStart(day)).toBe(new Date(2026, 9, 15).getTime())
    const at = (ms: number) => ({ url: `https://${ms}.dev/`, title: '', visits: 1, lastVisit: new Date(ms).toISOString() })
    const groups = byDay([at(day), at(day - 3_600_000), at(day - 86_400_000)])
    expect(groups.map((g) => g.entries.length)).toEqual([2, 1])
    const pages = { history: 'History', bookmarks: 'Bookmarks' }
    expect(tabLabel({ url: 'mindeck://history', title: '' }, pages)).toBe('History')
    expect(tabLabel({ url: 'https://a.dev/', title: 'A' }, pages)).toBe('A')
    expect(tabLabel({ url: 'https://a.dev/', title: '' }, pages)).toBe('https://a.dev/')
    expect(tabLabel({ url: '', title: '' }, pages)).toBe('')
    expect([nodeName(folder('f', '')), nodeName(link('l', '', 'https://l.dev/')), nodeName(link('l', '', 'https://l.dev/'), (u) => u.length.toString()), nodeName(link('l', 'L', 'x'))]).toEqual(['', 'https://l.dev/', '14', 'L'])
  })

  it('put the engine’s suggestions below the first line, and complete bookmarks inline', () => {
    const list: BrowserSuggestion[] = [
      { kind: 'search', url: 's', title: 'q' },
      { kind: 'history', url: 'h', title: 'H' }
    ]
    const extra: BrowserSuggestion[] = [
      { kind: 'suggestion', url: 's', title: 'dup' },
      { kind: 'suggestion', url: 'n', title: 'new' }
    ]
    expect(withSuggestions(list, extra).map((s) => s.url)).toEqual(['s', 'n', 'h'])
    expect(withSuggestions(list, Array.from({ length: 12 }, (_, i) => ({ kind: 'suggestion' as const, url: `u${i}`, title: '' })))).toHaveLength(10)
    expect(inlineCompletion('alp', [{ kind: 'bookmark', url: 'https://alpha.dev/x', title: 'A' }])).toEqual({ value: 'alpha.dev', url: 'https://alpha.dev/' })
    expect(inlineCompletion('alp', [{ kind: 'suggestion', url: 'https://alpha.dev/', title: 'A' }])).toBeNull()
    expect(ENGINE_LABELS.brave).toBe('Brave Search')
  })
})

describe('browser store · library', () => {
  it('loads bookmarks and settings with the state, follows pushes and answers the library commands', async () => {
    const settings = { ...DEFAULT_BROWSER_SETTINGS, bookmarksBar: false }
    const b = bridge({
      'browser:state': () => state([tab('a', 'https://a.dev/', { title: 'A' })]),
      'browser:bookmarks': () => tree,
      'browser:settings': () => settings,
      'browser:configure': (p: { bookmarksBar: boolean }) => ({ ...settings, ...p }),
      'browser:bookmarkAdd': () => link('new', 'A', 'https://a.dev/')
    })
    const off = useBrowser.getState().connect({ reveal: vi.fn(), sendToAgent: vi.fn(), settings: vi.fn() })
    await settle()
    expect(useBrowser.getState()).toMatchObject({ bookmarks: tree, settings })
    b.b.emit('browser:bookmarks', library())
    expect(useBrowser.getState().bookmarks).toEqual(library())

    b.b.emit('browser:command', { command: 'tabSearch' })
    expect(useBrowser.getState().tabSearchOpen).toBe(true)
    b.b.emit('browser:command', { command: 'import' })
    expect(useBrowser.getState().importOpen).toBe(true)
    b.b.emit('browser:command', { command: 'palette' }) // no one to open a palette here: nothing
    b.b.emit('browser:command', { command: 'bookmarksBar' })
    await settle()
    expect(b.sent('browser:configure')).toEqual([{ bookmarksBar: true }])
    expect(useBrowser.getState().settings.bookmarksBar).toBe(true)
    // ⌘D on a page without a bookmark: saved on the bar, then the editor
    b.b.emit('browser:command', { command: 'bookmark' })
    await settle()
    expect(b.sent('browser:bookmarkAdd')).toEqual([{ parentId: 'bar', title: 'A', url: 'https://a.dev/' }])
    expect(useBrowser.getState().editing).toEqual({ id: 'new', added: true })
    // … with one: just the editor
    useBrowser.setState({ bookmarks: library([link('k', 'K', 'https://a.dev/')]), editing: undefined })
    await useBrowser.getState().bookmarkActive()
    expect(useBrowser.getState().editing).toEqual({ id: 'k' })
    useBrowser.getState().edit()
    useBrowser.getState().setTabSearch(false)
    useBrowser.getState().setImport(false)
    expect(useBrowser.getState()).toMatchObject({ editing: undefined, tabSearchOpen: false, importOpen: false })
    off()
    // ⇧⌘P on a page: the app's command palette.
    const palette = vi.fn()
    const offPalette = useBrowser.getState().connect({ reveal: vi.fn(), sendToAgent: vi.fn(), settings: vi.fn(), palette })
    b.b.emit('browser:command', { command: 'palette' })
    expect(palette).toHaveBeenCalledTimes(1)
    offPalette()
  })

  it('bookmarks only web pages, and keeps quiet when saving fails', async () => {
    const b = bridge({
      'browser:bookmarkAdd': () => {
        throw new Error('full')
      },
      'browser:configure': () => {
        throw new Error('nope')
      }
    })
    useBrowser.setState({ state: state([tab('n', '')]) })
    await useBrowser.getState().bookmarkActive()
    useBrowser.setState({ state: state([tab('h', 'mindeck://history')]) })
    await useBrowser.getState().bookmarkActive()
    useBrowser.setState({ state: state([]) })
    await useBrowser.getState().bookmarkActive()
    expect(b.sent('browser:bookmarkAdd')).toEqual([])
    useBrowser.setState({ state: state([tab('f', 'file:///a.html', { title: '' })]) })
    await useBrowser.getState().bookmarkActive()
    expect(b.sent('browser:bookmarkAdd')).toEqual([{ parentId: 'bar', title: 'file:///a.html', url: 'file:///a.html' }])
    expect(useBrowser.getState().editing).toBeUndefined()
    await useBrowser.getState().configure({ bookmarksBar: false })
    expect(useBrowser.getState().settings.bookmarksBar).toBe(true)
  })

  it('refreshes what it can when part of it fails', async () => {
    installBridge({
      'browser:state': () => {
        throw new Error('x')
      }
    })
    await useBrowser.getState().refresh()
    expect(useBrowser.getState().state.available).toBe(false)
  })
})

describe('BookmarkEditor', () => {
  it('shows nothing without a bookmark to edit — or while the new one has not arrived', () => {
    bridge()
    const { container, rerender } = render(<BookmarkEditor />)
    expect(container).toBeEmptyDOMElement()
    act(() => useBrowser.setState({ editing: { id: 'missing' }, bookmarks: tree }))
    rerender(<BookmarkEditor />)
    expect(container).toBeEmptyDOMElement()
    act(() => useBrowser.setState({ editing: { id: 'bar' } }))
    rerender(<BookmarkEditor />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renames, re-addresses and moves a bookmark — or removes it', async () => {
    const { sent } = bridge()
    useBrowser.setState({ bookmarks: tree, editing: { id: 'a', added: true } })
    render(<BookmarkEditor />)
    expect(screen.getByRole('dialog', { name: 'Bookmark added' })).toBeInTheDocument()
    expect(useOverlays.getState().count).toBe(1)
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Alpha docs' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Address' }), { target: { value: ' https://alpha.dev/docs ' } })
    fireEvent.click(screen.getByRole('combobox', { name: 'Folder' }))
    fireEvent.click(screen.getByRole('option', { name: /Deep/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await settle()
    expect(sent('browser:bookmarkUpdate')).toEqual([{ id: 'a', title: 'Alpha docs', url: 'https://alpha.dev/docs' }])
    expect(sent('browser:bookmarkMove')).toEqual([{ id: 'a', parentId: 'deep', index: 100_000 }])
    expect(useBrowser.getState().editing).toBeUndefined()

    // nothing changed: nothing sent; Enter is Done
    act(() => useBrowser.setState({ editing: { id: 'o' } }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Enter' })
    await settle()
    expect(sent('browser:bookmarkUpdate')).toHaveLength(1)
    expect(sent('browser:bookmarkMove')).toHaveLength(1)
    // a blank address keeps the old one
    act(() => useBrowser.setState({ editing: { id: 'o' } }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Address' }), { target: { value: '  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await settle()
    expect(sent('browser:bookmarkUpdate')).toHaveLength(1)

    act(() => useBrowser.setState({ editing: { id: 'm' } }))
    expect(screen.getByRole('dialog', { name: 'Edit bookmark' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await settle()
    expect(sent('browser:bookmarkRemove')).toEqual([{ ids: ['m'] }])
    expect(useBrowser.getState().editing).toBeUndefined()
  })

  it('renames a folder (never into itself), and closes on Escape, ×, or a click outside', async () => {
    bridge()
    useBrowser.setState({ bookmarks: tree, editing: { id: 'dev' } })
    render(<BookmarkEditor />)
    expect(screen.getByRole('dialog', { name: 'Rename folder' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Address' })).toBeNull()
    fireEvent.click(screen.getByRole('combobox', { name: 'Folder' }))
    expect(screen.queryByRole('option', { name: /Deep/ })).toBeNull()
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Folder' }), { key: 'Escape' })
    fireEvent.focus(screen.getByRole('textbox', { name: 'Name' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'a' })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Escape' })
    expect(useBrowser.getState().editing).toBeUndefined()
    act(() => useBrowser.setState({ editing: { id: 'dev' } }))
    fireEvent.mouseDown(screen.getByText('Rename folder')) // inside: stays
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(useBrowser.getState().editing).toBeUndefined()
    act(() => useBrowser.setState({ editing: { id: 'dev' } }))
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(useBrowser.getState().editing).toBeUndefined()
  })
})

describe('BookmarksBar', () => {
  it('hides when turned off, and invites to import while empty', () => {
    bridge()
    useBrowser.setState({ settings: { ...DEFAULT_BROWSER_SETTINGS, bookmarksBar: false } })
    const { container, rerender } = render(<BookmarksBar />)
    expect(container).toBeEmptyDOMElement()
    act(() => useBrowser.setState({ settings: DEFAULT_BROWSER_SETTINGS }))
    rerender(<BookmarksBar />)
    expect(screen.getByText(/put your bookmarks here/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Other bookmarks' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Import bookmarks…' }))
    expect(useBrowser.getState().importOpen).toBe(true)
  })

  it('opens links here or in a tab behind, and folders as menus with their subfolders', async () => {
    const { sent } = bridge()
    const go = vi.fn(async () => {})
    useBrowser.setState({ bookmarks: tree, go })
    render(<BookmarksBar />)
    const bar = screen.getByRole('toolbar', { name: 'Bookmarks bar' })
    fireEvent.click(within(bar).getByText('Alpha'))
    expect(go).toHaveBeenCalledWith('https://alpha.dev/')
    fireEvent.click(within(bar).getByText('Alpha'), { metaKey: true })
    fireEvent.click(within(bar).getByText('Alpha'), { ctrlKey: true })
    fireEvent(within(bar).getByText('Alpha'), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    fireEvent(within(bar).getByText('Alpha'), new MouseEvent('auxclick', { bubbles: true, button: 2 }))
    fireEvent(within(bar).getByText('Dev'), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    await settle()
    expect(sent('browser:open')).toEqual(Array(3).fill({ url: 'https://alpha.dev/', background: true }))

    fireEvent.click(within(bar).getByText('Dev'))
    let menu = screen.getByRole('menu', { name: 'Dev' })
    expect(useOverlays.getState().count).toBe(1)
    fireEvent.click(within(menu).getByText('Deep'))
    menu = screen.getByRole('menu', { name: 'Deep' })
    expect(within(menu).getByRole('menuitem', { name: /x\.dev/ })).toBeInTheDocument() // untitled: its address
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Back' }))
    fireEvent.click(within(screen.getByRole('menu', { name: 'Dev' })).getByText('Void'))
    expect(screen.getByText('(empty)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Back' }))
    fireEvent(within(screen.getByRole('menu')).getByText('Void'), new MouseEvent('auxclick', { bubbles: true, button: 1 })) // a folder: nothing
    fireEvent(within(screen.getByRole('menu')).getByText('MDN'), new MouseEvent('auxclick', { bubbles: true, button: 2 })) // not the middle button
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent(within(screen.getByRole('menu')).getByText('MDN'), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(screen.queryByRole('menu')).toBeNull()
    await settle()
    expect(sent('browser:open').at(-1)).toEqual({ url: 'https://mdn.dev/', background: true })
    fireEvent.click(within(bar).getByText('Dev'))
    fireEvent.click(within(screen.getByRole('menu')).getByText('MDN'))
    expect(go).toHaveBeenLastCalledWith('https://mdn.dev/')
    expect(screen.queryByRole('menu')).toBeNull()

    // Other bookmarks on the right; a click elsewhere or Escape closes the menu
    fireEvent.click(screen.getByRole('button', { name: 'Other bookmarks' }))
    expect(within(screen.getByRole('menu', { name: 'Other bookmarks' })).getByText('Other one')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByRole('menu'))
    fireEvent.keyDown(document, { key: 'a' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Other bookmarks' }))
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(useOverlays.getState().count).toBe(0)
  })

  it('right-click: open in a tab behind, edit, delete', async () => {
    const { sent } = bridge()
    useBrowser.setState({ bookmarks: tree })
    render(<BookmarksBar />)
    const bar = screen.getByRole('toolbar')
    fireEvent.contextMenu(within(bar).getByText('Alpha'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in new tab' }))
    fireEvent.contextMenu(within(bar).getByText('Alpha'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit…' }))
    expect(useBrowser.getState().editing).toEqual({ id: 'a' })
    fireEvent.contextMenu(within(bar).getByText('Dev'))
    expect(screen.queryByRole('menuitem', { name: 'Open in new tab' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await settle()
    expect(sent('browser:open')).toEqual([{ url: 'https://alpha.dev/', background: true }])
    expect(sent('browser:bookmarkRemove')).toEqual([{ ids: ['dev'] }])
  })

  it('reorders by dragging: before a link, into a folder, to the end of the bar', async () => {
    const { sent } = bridge()
    useBrowser.setState({ bookmarks: library([link('a', 'Alpha', 'https://alpha.dev/'), folder('dev', 'Dev'), link('u', '', 'https://untitled.dev/')]) })
    render(<BookmarksBar />)
    const bar = screen.getByRole('toolbar')
    const alpha = within(bar).getByText('Alpha').closest('button')!
    const dev = within(bar).getByText('Dev').closest('button')!
    const untitled = within(bar).getByText('https://untitled.dev/').closest('button')!
    const start = dataTransfer([])
    fireEvent.dragStart(alpha, { dataTransfer: start })
    expect(start.setData).toHaveBeenCalledWith(BOOKMARK_DRAG, 'a')

    fireEvent.dragOver(untitled, { dataTransfer: dataTransfer(['Files']) }) // not a bookmark: no drop here
    expect(untitled.className).not.toContain('border-cyan')
    fireEvent.dragOver(untitled, { dataTransfer: dataTransfer([BOOKMARK_DRAG], 'a') })
    expect(untitled.className).toContain('border-cyan')
    fireEvent.dragLeave(dev)
    fireEvent.dragLeave(untitled)
    expect(untitled.className).not.toContain('border-cyan')
    fireEvent.drop(untitled, { dataTransfer: dataTransfer([BOOKMARK_DRAG], 'a') })
    fireEvent.drop(dev, { dataTransfer: dataTransfer([BOOKMARK_DRAG], 'u') })
    fireEvent.drop(bar, { dataTransfer: dataTransfer([BOOKMARK_DRAG], 'a') })
    fireEvent.drop(alpha, { dataTransfer: dataTransfer([BOOKMARK_DRAG], 'a') }) // onto itself
    fireEvent.drop(alpha, { dataTransfer: dataTransfer([BOOKMARK_DRAG], '') })
    fireEvent.dragOver(bar, { dataTransfer: dataTransfer([BOOKMARK_DRAG]) })
    await settle()
    expect(sent('browser:bookmarkMove')).toEqual([
      { id: 'a', parentId: 'bar', index: 2 },
      { id: 'u', parentId: 'dev', index: 100_000 },
      { id: 'a', parentId: 'bar', index: 3 }
    ])
  })
})

describe('TabSearch (⌘⇧A)', () => {
  it('searches open tabs, bookmarks and history — a tab is switched to, the rest opens', async () => {
    const { sent } = bridge({
      'browser:history': (p: { query: string }) => (p.query === 'dev' ? [{ url: 'https://seen.dev/', title: '', visits: 1, lastVisit: '' }] : [])
    })
    useBrowser.setState({
      tabSearchOpen: false,
      bookmarks: tree,
      state: state([tab('h', 'mindeck://history'), tab('n', ''), tab('d', 'https://docs.dev/', { title: 'Docs' })])
    })
    const { container, rerender } = render(<TabSearch />)
    expect(container).toBeEmptyDOMElement()
    act(() => useBrowser.setState({ tabSearchOpen: true }))
    rerender(<TabSearch />)
    expect(useOverlays.getState().count).toBe(1)
    const input = screen.getByRole('textbox', { name: 'Search tabs, history and bookmarks' })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Historymindeck://history', 'New tab', 'Docsdocs.dev'])
    fireEvent.change(input, { target: { value: 'dev' } })
    await settle()
    expect(screen.getByText('Open tabs')).toBeInTheDocument()
    expect(screen.getByText('Bookmarks')).toBeInTheDocument()
    expect(screen.getByText('History')).toBeInTheDocument()
    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['Docsdocs.dev', 'Alphaalpha.dev', 'MDNmdn.dev', 'x.devx.dev', 'Other oneother.dev', 'seen.devseen.dev'])
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(sent('browser:activate')).toEqual([{ id: 'd' }])
    expect(useBrowser.getState().tabSearchOpen).toBe(false)

    act(() => useBrowser.setState({ tabSearchOpen: true }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'dev' } })
    await settle()
    fireEvent.mouseEnter(screen.getAllByRole('option')[5])
    fireEvent.click(screen.getAllByRole('option')[5])
    await settle()
    expect(sent('browser:open')).toEqual([{ url: 'https://seen.dev/' }])

    act(() => useBrowser.setState({ tabSearchOpen: true }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'zzz' } })
    await settle()
    expect(screen.getByText('Nothing found')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' }) // nothing to choose
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'x' })
    fireEvent.mouseDown(screen.getByRole('listbox'))
    expect(useBrowser.getState().tabSearchOpen).toBe(true)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(useBrowser.getState().tabSearchOpen).toBe(false)
    act(() => useBrowser.setState({ tabSearchOpen: true }))
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(useBrowser.getState().tabSearchOpen).toBe(false)
  })

  it('ignores a history answer that came too late, or none at all', async () => {
    let answer: (v: unknown) => void = () => {}
    bridge({ 'browser:history': () => new Promise((r) => (answer = r)) })
    useBrowser.setState({ tabSearchOpen: true, state: state([]) })
    render(<TabSearch />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a' } })
    const late = answer
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    late([{ url: 'https://late.dev/', title: 'Late', visits: 1, lastVisit: '' }])
    await settle()
    expect(screen.queryByText('Late')).toBeNull()
    installBridge({ 'browser:history': () => Promise.reject(new Error('x')) })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'b' } })
    await settle()
    expect(screen.getByText('Nothing found')).toBeInTheDocument()
  })
})

describe('RemoteUseBar', () => {
  it('shows which paired device uses the browser, and stops it at once', async () => {
    const { sent } = bridge({ 'server:setDeviceBrowser': () => [] })
    const { container } = render(<RemoteUseBar />)
    expect(container).toBeEmptyDOMElement()
    act(() => useBrowser.setState({ state: state([tab('n', '')], { remote: [] }) }))
    expect(container).toBeEmptyDOMElement()
    act(() =>
      useBrowser.setState({
        state: state([tab('n', '')], {
          remote: [
            { deviceId: 'd1', device: 'iPhone', since: '2026-10-16T10:00:00.000Z' },
            { deviceId: 'd2', device: 'iPad', since: '2026-10-16T09:00:00.000Z' }
          ]
        })
      })
    )
    expect(screen.getByRole('status')).toHaveTextContent('iPhone is using this browser — it sees your tabs and acts with your logins')
    expect(screen.getByRole('status')).toHaveTextContent('iPad is using this browser')
    fireEvent.click(screen.getAllByRole('button', { name: 'Stop' })[1])
    await settle()
    expect(sent('server:setDeviceBrowser')).toEqual([{ id: 'd2', browser: false }])
  })
})

describe('RestoreBar', () => {
  it('offers the tabs of a session that ended in a crash', async () => {
    const { sent } = bridge()
    const { container, rerender } = render(<RestoreBar />)
    expect(container).toBeEmptyDOMElement()
    act(() => useBrowser.setState({ state: state([tab('n', '')], { restorable: 3 }) }))
    rerender(<RestoreBar />)
    expect(screen.getByRole('alert')).toHaveTextContent('Mindeck quit unexpectedly. Restore 3 tabs from before?')
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await settle()
    expect(sent('browser:restoreSession')).toEqual([{ restore: true }, { restore: false }])
    act(() => useBrowser.setState({ state: state([tab('n', '')], { restorable: 1 }) }))
    expect(screen.getByRole('alert')).toHaveTextContent('Restore the tab from before?')
  })
})

describe('Omnibox · bookmarks and the engine’s suggestions', () => {
  it('shows a star for web pages: empty to bookmark, filled to edit', async () => {
    bridge({ 'browser:bookmarkAdd': () => link('n', 'A', 'https://a.dev/') })
    useBrowser.setState({ state: state([tab('a', 'https://a.dev/', { title: 'A' })]) })
    const { rerender } = render(<Omnibox tab={tab('a', 'https://a.dev/')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bookmark this tab (⌘D)' }))
    await settle()
    expect(useBrowser.getState().editing).toEqual({ id: 'n', added: true })
    act(() => useBrowser.setState({ bookmarks: library([link('n', 'A', 'https://a.dev/')]) }))
    expect(screen.getByRole('button', { name: 'Edit bookmark (⌘D)' })).toBeInTheDocument()
    rerender(<Omnibox tab={tab('h', 'mindeck://history')} />)
    expect(screen.queryByRole('button', { name: /bookmark/i })).toBeNull()
    rerender(<Omnibox />)
    expect(screen.queryByRole('button', { name: /bookmark/i })).toBeNull()
  })

  it('adds what the search engine suggests once typing pauses — unless the user picked a line or typed on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { sent } = bridge({
      'browser:suggest': (p: { text: string }) => [
        { kind: 'search', url: `https://s/?q=${p.text}`, title: p.text },
        { kind: 'bookmark', url: 'https://reactjs.org/', title: 'React' }
      ],
      'browser:searchSuggest': (p: { text: string }) => (p.text === 'none' ? [] : [{ kind: 'suggestion', url: 'https://s/?q=react+hooks', title: 'react hooks' }])
    })
    useBrowser.setState({ state: state([tab('n', '')]) })
    render(<Omnibox tab={tab('n', '')} />)
    const input = screen.getByRole('textbox', { name: 'Address or search' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'react' } })
    await act(() => vi.advanceTimersByTimeAsync(10))
    expect(screen.getAllByRole('option')).toHaveLength(2)
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(sent('browser:searchSuggest')).toEqual([{ text: 'react' }])
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['react', 'react hooks', 'Reactreactjs.org'])

    // a line picked before the answer: the list stays as it is
    fireEvent.change(input, { target: { value: 'reac' } })
    await act(() => vi.advanceTimersByTimeAsync(10))
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(screen.getAllByRole('option')).toHaveLength(2)
    // typed on: the older answer is dropped; nothing suggested: nothing added
    fireEvent.change(input, { target: { value: 'none' } })
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(screen.getAllByRole('option')).toHaveLength(2)
    // closing the list stops a pending question
    fireEvent.change(input, { target: { value: 'react' } })
    await act(() => vi.advanceTimersByTimeAsync(10))
    fireEvent.blur(input)
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(sent('browser:searchSuggest')).toEqual([{ text: 'react' }, { text: 'reac' }, { text: 'none' }])
  })

  it('shows engine suggestions as searches and bookmarks with their address', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    bridge({
      'browser:suggest': () => [{ kind: 'search', url: 'https://s/?q=x', title: 'x' }],
      'browser:searchSuggest': () => {
        throw new Error('offline')
      }
    })
    render(<Omnibox tab={tab('n', '')} />)
    const input = screen.getByRole('textbox', { name: 'Address or search' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'x' } })
    await act(() => vi.advanceTimersByTimeAsync(300))
    expect(screen.getAllByRole('option')).toHaveLength(1)
  })
})

describe('the browser module · library pieces', () => {
  it('draws Mindeck’s own pages in the viewport and names their tabs', async () => {
    bridge({ 'browser:historyList': () => [] })
    useBrowser.setState({ bookmarks: tree, state: state([tab('h', 'mindeck://history'), tab('b', 'mindeck://bookmarks')], { activeId: 'h' }) })
    const { rerender } = render(<Viewport active />)
    expect(await screen.findByRole('textbox', { name: 'Search history' })).toBeInTheDocument()
    act(() => useBrowser.setState({ state: state([tab('h', 'mindeck://history'), tab('b', 'mindeck://bookmarks')], { activeId: 'b' }) }))
    rerender(<Viewport active />)
    expect(screen.getByRole('textbox', { name: 'Search bookmarks' })).toBeInTheDocument()
    render(<TabStrip />)
    expect(screen.getByRole('tab', { name: /^History/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^Bookmarks/ })).toBeInTheDocument()
  })

  it('keeps sharing and agents off Mindeck’s pages, and opens the import dialog when asked', async () => {
    bridge({ 'browser:importSources': () => [], 'browser:historyList': () => [] })
    useBrowser.setState({ state: state([tab('h', 'mindeck://history')]) })
    render(<BrowserView active />)
    expect(screen.getByRole('button', { name: 'Send to an agent' })).toBeDisabled()
    act(() => useBrowser.setState({ importOpen: true }))
    expect(await screen.findByText('No other browser was found on this computer.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useBrowser.getState().importOpen).toBe(false)
  })
})

describe('BrowserCard · library settings', () => {
  it('turns suggestions and the bookmarks bar on and off, and imports from another browser', async () => {
    const settings = DEFAULT_BROWSER_SETTINGS
    const { sent } = bridge({
      'browser:settings': () => settings,
      'browser:configure': (p: object) => ({ ...settings, ...p }),
      'browser:importSources': () => []
    })
    render(<BrowserCard />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Search suggestions' }))
    await settle()
    fireEvent.click(screen.getByRole('switch', { name: 'Show bookmarks bar' }))
    await settle()
    expect(sent('browser:configure')).toEqual([{ searchSuggestions: false }, { bookmarksBar: false }])
    expect(useBrowser.getState().settings.bookmarksBar).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Import from another browser…' }))
    expect(await screen.findByRole('dialog', { name: 'Import from another browser' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
