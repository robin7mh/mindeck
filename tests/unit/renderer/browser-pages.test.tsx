import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settle } from './bridge'
import { bridge, dataTransfer, folder, library, link } from './browserLibraryFixtures'
import { useBrowser } from '@/features/browser/store'
import { useOverlays } from '@/lib/overlay'
import { useLocale } from '@/lib/i18n'
import { HistoryPage } from '@/features/browser/components/HistoryPage'
import { BookmarksPage } from '@/features/browser/components/BookmarksPage'
import { ImportDialog, ImportStep } from '@/features/browser/components/ImportDialog'
import { BOOKMARK_DRAG } from '@/features/browser/components/BookmarksBar'
import type { HistoryEntry } from '@shared/types/browser'
import type { ImportSource } from '@shared/types/browserData'

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

const NOW = new Date(2026, 9, 15, 14, 30).getTime()
const HOUR = 3_600_000
const entry = (url: string, title: string, ms: number): HistoryEntry => ({ url, title, visits: 1, lastVisit: new Date(ms).toISOString() })

describe('HistoryPage (mindeck://history)', () => {
  it('lists pages by day, searches, pages on, and opens a page here or in a tab behind', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW })
    const first = Array.from({ length: 150 }, (_, i) => entry(`https://p${i}.dev/`, i === 1 ? '' : `Page ${i}`, NOW - i * 60_000))
    first[148] = entry('https://y.dev/', 'Yesterday page', NOW - 20 * HOUR)
    first[149] = entry('https://old.dev/', 'Old page', NOW - 5 * 24 * HOUR)
    const { sent } = bridge({
      'browser:historyList': (p: { query?: string; before?: number }) =>
        p.query === 'none' ? [] : p.query ? [entry('https://hit.dev/', 'Hit', NOW)] : p.before ? [entry('https://older.dev/', 'Older', NOW - 6 * 24 * HOUR)] : first
    })
    const go = vi.fn(async () => {})
    useBrowser.setState({ go })
    render(<HistoryPage />)
    expect(await screen.findByRole('region', { name: 'Today' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Yesterday' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: /2026/ })).toBeInTheDocument()
    expect(screen.getAllByText('p1.dev')).toHaveLength(2) // untitled: its address as the name
    fireEvent.click(screen.getByText('Page 0'))
    expect(go).toHaveBeenCalledWith('https://p0.dev/')
    fireEvent(screen.getByText('Page 0'), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    fireEvent(screen.getByText('Page 0'), new MouseEvent('auxclick', { bubbles: true, button: 0 }))
    await settle()
    expect(sent('browser:open')).toEqual([{ url: 'https://p0.dev/', background: true }])

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(await screen.findByText('Older')).toBeInTheDocument()
    expect(sent('browser:historyList').at(-1)).toEqual({ before: NOW - 5 * 24 * HOUR, limit: 150 })
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()

    fireEvent.change(screen.getByRole('textbox', { name: 'Search history' }), { target: { value: ' hit ' } })
    expect(await screen.findByText('Hit')).toBeInTheDocument()
    expect(sent('browser:historyList').at(-1)).toEqual({ query: 'hit', limit: 150 })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search history' }), { target: { value: 'none' } })
    expect(await screen.findByText('Nothing in your history matches.')).toBeInTheDocument()
  }, 30_000) // a full page of rows renders slowly in jsdom

  it('forgets a page, a day, or the last hour, day, week — or all of it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW })
    let list = [entry('https://a.dev/', 'A', NOW - HOUR), entry('https://b.dev/', '', NOW - 26 * HOUR)]
    const { sent } = bridge({
      'browser:historyList': () => list,
      'browser:historyDelete': () => {
        list = []
        return 1
      }
    })
    render(<HistoryPage />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Remove “A” from history' }))
    await settle()
    expect(sent('browser:historyDelete')).toEqual([{ urls: ['https://a.dev/'] }])
    expect(screen.getByText('Pages you visit show up here.')).toBeInTheDocument()

    list = [entry('https://b.dev/', '', NOW - 26 * HOUR)]
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'b' } })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Remove “b.dev” from history' }))
    await settle()
    list = [entry('https://b.dev/', '', NOW - 26 * HOUR)]
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Remove this day' }))
    await settle()
    const yesterday = new Date(2026, 9, 14).getTime()
    expect(sent('browser:historyDelete').at(-1)).toEqual({ from: yesterday, to: new Date(2026, 9, 15).getTime() })

    for (const [range, from] of [
      ['Last hour', NOW - HOUR],
      ['Last 24 hours', NOW - 24 * HOUR],
      ['Last 7 days', NOW - 7 * 24 * HOUR]
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: 'Clear history…' }))
      expect(useOverlays.getState().count).toBe(1)
      fireEvent.click(screen.getByRole('menuitem', { name: range }))
      await settle()
      expect((sent('browser:historyDelete').at(-1) as { from: number }).from).toBeGreaterThanOrEqual(from)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Clear history…' }))
    fireEvent.mouseDown(screen.getByRole('menu')) // inside: stays
    fireEvent.click(screen.getByRole('menuitem', { name: 'All time' }))
    await settle()
    expect(sent('browser:clearHistory')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Clear history…' }))
    fireEvent.mouseDown(screen.getByRole('menu').parentElement!)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('drops an answer that a newer search overtook, and shows nothing when the core fails', async () => {
    const answers: ((v: unknown) => void)[] = []
    bridge({ 'browser:historyList': () => new Promise((r) => answers.push(r)) })
    render(<HistoryPage />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } })
    answers[0]([entry('https://stale.dev/', 'Stale', NOW)])
    answers[1]([entry('https://fresh.dev/', 'Fresh', NOW)])
    await settle()
    expect(screen.queryByText('Stale')).toBeNull()
    expect(screen.getByText('Fresh')).toBeInTheDocument()

    bridge({
      'browser:historyList': () => {
        throw new Error('down')
      }
    })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'y' } })
    await settle()
    expect(screen.getByText('Fresh')).toBeInTheDocument()
  })
})

describe('BookmarksPage (mindeck://bookmarks)', () => {
  const tree = library(
    [link('a', 'Alpha', 'https://alpha.dev/'), folder('dev', 'Dev', [link('m', 'MDN', 'https://mdn.dev/'), folder('deep', 'Deep')]), link('u', '', 'https://untitled.dev/')],
    [link('o', 'Other one', 'https://other.dev/')]
  )

  it('shows folders as a tree and a folder’s contents; opens, edits and deletes', async () => {
    const { sent } = bridge()
    const go = vi.fn(async () => {})
    useBrowser.setState({ bookmarks: tree, go })
    render(<BookmarksPage />)
    const nav = screen.getByRole('navigation', { name: 'Bookmarks' })
    expect(within(nav).getAllByRole('treeitem').map((i) => i.querySelector('button')!.textContent)).toEqual(['Bookmarks bar', 'Dev', 'Deep', 'Other bookmarks'])
    const list = () => screen.getAllByRole('list').at(-1)!
    expect(within(list()).getAllByRole('listitem')).toHaveLength(3)
    expect(within(list()).getAllByText('untitled.dev')).toHaveLength(2) // untitled: the address as its name

    fireEvent.click(within(list()).getByText('Alpha'))
    expect(go).toHaveBeenCalledWith('https://alpha.dev/')
    fireEvent(within(list()).getByText('Alpha'), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    fireEvent(within(list()).getByText('Alpha'), new MouseEvent('auxclick', { bubbles: true, button: 2 }))
    fireEvent(within(list()).getByText('Dev'), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    await settle()
    expect(sent('browser:open')).toEqual([{ url: 'https://alpha.dev/', background: true }])
    fireEvent.click(screen.getByRole('button', { name: 'Edit… Alpha' }))
    expect(useBrowser.getState().editing).toEqual({ id: 'a' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha' }))
    await settle()
    expect(sent('browser:bookmarkRemove')).toEqual([{ ids: ['a'] }])

    // into a folder by clicking it in the list, or in the tree
    fireEvent.click(within(list()).getByText('Dev'))
    expect(within(list()).getByText('MDN')).toBeInTheDocument()
    fireEvent.click(within(list()).getByText('Deep'))
    expect(screen.getByText(/This folder is empty/)).toBeInTheDocument()
    fireEvent.click(within(nav).getByText('Other bookmarks'))
    expect(within(list()).getByText('Other one')).toBeInTheDocument()
    // the open folder disappears: back to the bar
    act(() => useBrowser.setState({ bookmarks: library([link('a', 'Alpha', 'https://alpha.dev/')]) }))
    fireEvent.click(within(nav).getByText('Bookmarks bar'))
    act(() => useBrowser.setState({ bookmarks: library([folder('f', 'F')]) }))
    fireEvent.click(within(list()).getByText('F'))
    act(() => useBrowser.setState({ bookmarks: library([link('f', 'F was a folder', 'https://f.dev/')]) }))
    expect(within(list()).getByText('F was a folder')).toBeInTheDocument()
  })

  it('searches all bookmarks with the folders they are in', () => {
    bridge()
    useBrowser.setState({ bookmarks: tree })
    render(<BookmarksPage />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search bookmarks' }), { target: { value: 'mdn' } })
    const hits = screen.getByRole('list', { name: 'Search bookmarks' })
    expect(within(hits).getByText('MDN')).toBeInTheDocument()
    expect(within(hits).getByText('· Dev')).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: /Bookmarks bar/ })).toHaveAttribute('aria-selected', 'false')
    fireEvent.change(screen.getByRole('textbox', { name: 'Search bookmarks' }), { target: { value: 'zzz' } })
    expect(screen.getByText('No bookmark matches.')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Dev'))
    expect(screen.getByRole('textbox', { name: 'Search bookmarks' })).toHaveValue('')
  })

  it('moves by dragging: before a row, or into a folder of the tree', async () => {
    const { sent } = bridge()
    useBrowser.setState({ bookmarks: tree })
    render(<BookmarksPage />)
    const row = (name: string) => screen.getAllByText(name).find((el) => el.closest('li[draggable]'))!.closest('li')!
    const start = dataTransfer([])
    fireEvent.dragStart(row('Alpha'), { dataTransfer: start })
    expect(start.setData).toHaveBeenCalledWith(BOOKMARK_DRAG, 'a')
    fireEvent.dragOver(row('Alpha'), { dataTransfer: dataTransfer(['Files']) })
    fireEvent.dragOver(row('Alpha'), { dataTransfer: dataTransfer([BOOKMARK_DRAG]) })
    expect(row('Alpha').className).toContain('border-t-cyan')
    fireEvent.dragLeave(row('Alpha'))
    fireEvent.drop(row('Dev'), { dataTransfer: dataTransfer([BOOKMARK_DRAG], 'u') })
    fireEvent.drop(row('Dev'), { dataTransfer: dataTransfer([BOOKMARK_DRAG], 'dev') })
    const tree_ = screen.getByRole('navigation')
    const deep = within(tree_).getByText('Deep').closest('button')!
    fireEvent.dragOver(deep, { dataTransfer: dataTransfer(['Files']) })
    fireEvent.dragOver(deep, { dataTransfer: dataTransfer([BOOKMARK_DRAG]) })
    expect(deep.className).toContain('border-cyan')
    fireEvent.dragLeave(deep)
    fireEvent.drop(deep, { dataTransfer: dataTransfer([BOOKMARK_DRAG], 'a') })
    fireEvent.drop(deep, { dataTransfer: dataTransfer([BOOKMARK_DRAG], 'deep') })
    await settle()
    expect(sent('browser:bookmarkMove')).toEqual([
      { id: 'u', parentId: 'bar', index: 1 },
      { id: 'a', parentId: 'deep', index: 100_000 }
    ])
    // while searching, rows are not drop places
    fireEvent.change(screen.getByRole('textbox', { name: 'Search bookmarks' }), { target: { value: 'dev' } })
    fireEvent.dragOver(row('MDN'), { dataTransfer: dataTransfer([BOOKMARK_DRAG]) })
    fireEvent.drop(row('MDN'), { dataTransfer: dataTransfer([BOOKMARK_DRAG], 'a') })
    await settle()
    expect(sent('browser:bookmarkMove')).toHaveLength(2)
  })

  it('makes folders, imports and exports bookmark files, and imports from another browser', async () => {
    const { sent } = bridge({
      'browser:bookmarkAdd': () => folder('nf', 'New folder'),
      'browser:bookmarksImport': () => 3,
      'browser:bookmarksExport': () => '<DL></DL>'
    })
    useBrowser.setState({ bookmarks: tree })
    render(<BookmarksPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    await settle()
    expect(sent('browser:bookmarkAdd')).toEqual([{ parentId: 'bar', title: 'New folder' }])
    expect(useBrowser.getState().editing).toEqual({ id: 'nf' })

    const input = screen.getByLabelText('Import file…', { selector: 'input' }) as HTMLInputElement
    const click = vi.spyOn(input, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: 'Import file…' }))
    expect(click).toHaveBeenCalled()
    // (jsdom's File has no text(); Chromium's has)
    const file = Object.assign(new File([''], 'bookmarks.html', { type: 'text/html' }), { text: async () => '<DL><DT><A HREF="https://x.dev/">X</A></DL>' })
    fireEvent.change(input, { target: { files: [file] } })
    await settle()
    expect(sent('browser:bookmarksImport')).toEqual([{ html: '<DL><DT><A HREF="https://x.dev/">X</A></DL>' }])
    expect(screen.getByRole('status')).toHaveTextContent('3 bookmarks imported')
    fireEvent.change(input, { target: { files: [] } }) // nothing picked

    const created = vi.fn(() => 'blob:x')
    const revoked = vi.fn()
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked })
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }))
    await settle()
    expect(created).toHaveBeenCalledWith(expect.any(Blob))
    expect(anchorClick).toHaveBeenCalled()
    expect(revoked).toHaveBeenCalledWith('blob:x')

    fireEvent.click(screen.getByRole('button', { name: 'Import from browser…' }))
    expect(useBrowser.getState().importOpen).toBe(true)
  })

  it('does nothing more when the core refuses', async () => {
    const fail = () => {
      throw new Error('no')
    }
    bridge({ 'browser:bookmarkAdd': fail, 'browser:bookmarksImport': fail, 'browser:bookmarksExport': fail })
    const created = vi.fn()
    Object.assign(URL, { createObjectURL: created })
    useBrowser.setState({ bookmarks: tree })
    render(<BookmarksPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }))
    fireEvent.change(screen.getByLabelText('Import file…', { selector: 'input' }), { target: { files: [Object.assign(new File(['x'], 'x.html'), { text: async () => 'x' })] } })
    await settle()
    expect(useBrowser.getState().editing).toBeUndefined()
    expect(created).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('ImportDialog', () => {
  const sources: ImportSource[] = [
    { id: 'chrome:/p/Default', browser: 'chrome', profile: 'Robin', kinds: ['bookmarks', 'history', 'settings'] },
    { id: 'firefox:/f/x', browser: 'firefox', profile: 'default-release', kinds: ['bookmarks', 'history'] }
  ]

  it('looks for browsers, then imports what was picked — with progress and the outcome', async () => {
    let finish: (v: unknown) => void = () => {}
    const b = bridge({ 'browser:importSources': () => sources, 'browser:import': () => new Promise((r) => (finish = r)) })
    const onClose = vi.fn()
    render(<ImportDialog onClose={onClose} />)
    expect(screen.getByText('Looking for browsers…')).toBeInTheDocument()
    await settle()
    expect(screen.getByRole('combobox', { name: 'From' })).toHaveTextContent('Google Chrome — Robin')
    expect(screen.getByText(/Passwords and cookies stay in the other browser/)).toBeInTheDocument()
    expect(screen.getAllByRole('checkbox').map((c) => (c as HTMLInputElement).checked)).toEqual([true, true, true])
    fireEvent.click(screen.getByRole('checkbox', { name: 'Search engine' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'History' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'History' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await settle()
    expect(b.sent('browser:import')).toEqual([{ sourceId: 'chrome:/p/Default', kinds: ['bookmarks', 'history'] }])
    expect(screen.getByText('Importing bookmarks…')).toBeInTheDocument()
    act(() => b.b.emit('browser:import', { sourceId: 'chrome:/p/Default', kind: 'history' }))
    expect(screen.getByText('Importing history…')).toBeInTheDocument()
    // while it runs, it stays open
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => finish({ sourceId: 'chrome:/p/Default', bookmarks: 12, history: 340, searchEngine: 'duckduckgo', errors: [{ kind: 'history', message: 'locked' }] }))
    expect(screen.getByRole('status')).toHaveTextContent('Done: 12 new bookmarks, 340 pages of history.')
    expect(screen.getByText('Searching with DuckDuckGo from now on.')).toBeInTheDocument()
    expect(screen.getByText(/History: could not be read/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('switches the profile, says when nothing is found, and shows a failed import', async () => {
    bridge({
      'browser:importSources': () => sources,
      'browser:import': () => {
        throw new Error('That browser profile is gone')
      }
    })
    const onClose = vi.fn()
    render(<ImportDialog onClose={onClose} />)
    await settle()
    fireEvent.click(screen.getByRole('combobox', { name: 'From' }))
    fireEvent.click(screen.getByRole('option', { name: 'Firefox — default-release' }))
    expect(screen.queryByRole('checkbox', { name: 'Search engine' })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bookmarks' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'History' }))
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'History' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('That browser profile is gone')
    fireEvent.mouseDown(screen.getByText('Import from another browser'))
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(1)

    bridge({
      'browser:importSources': () => {
        throw new Error('x')
      }
    })
    render(<ImportDialog onClose={onClose} />)
    await settle()
    expect(screen.getAllByText('No other browser was found on this computer.')).toHaveLength(1)
    expect(screen.queryAllByRole('button', { name: 'Import' })).toHaveLength(1) // only the first dialog's
  })

  it('is a step of the first-run setup too: skipping or finishing moves on', async () => {
    bridge({ 'browser:importSources': () => [] })
    const next = vi.fn()
    render(<ImportStep next={next} />)
    expect(screen.getByRole('region', { name: 'Import from another browser' })).toBeInTheDocument()
    expect(useOverlays.getState().count).toBe(0) // inline, no page to freeze
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(next).toHaveBeenCalledTimes(1)
  })
})
