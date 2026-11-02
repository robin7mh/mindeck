import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge, settle } from './bridge'
import { useFiles } from '@/features/files/store'
import { useProjects } from '@/features/projects/store'
import { useEditor } from '@/features/editor/store'
import { useBrowser } from '@/features/browser/store'
import { useTerminals } from '@/features/terminal/store'
import { useAgents } from '@/features/agents/sessions'
import { FilesView } from '@/features/files/components/FilesView'
import { Sidebar } from '@/features/files/components/Sidebar'
import { FileIcon } from '@/features/files/components/FileIcon'
import { ContextMenu } from '@/features/files/components/ContextMenu'
import { PreviewPane } from '@/features/files/components/PreviewPane'
import type { FinderEntry, FinderPreview } from '@shared/types/finder'

const initial = {
  files: useFiles.getState(),
  projects: useProjects.getState(),
  editor: useEditor.getState(),
  browser: useBrowser.getState(),
  terminals: useTerminals.getState(),
  agents: useAgents.getState()
}

const entry = (path: string, extra: Partial<FinderEntry> = {}): FinderEntry => ({
  name: path.split('/').pop()!,
  path,
  kind: 'file',
  size: 1200,
  mtimeMs: new Date(2026, 9, 15, 9, 5).getTime(),
  hidden: false,
  ...extra
})

const FOLDERS: Record<string, FinderEntry[]> = {
  '/': [entry('/home', { kind: 'dir' })],
  '/home': [entry('/home/shop', { kind: 'dir' }), entry('/home/Tools.app', { kind: 'dir', bundle: true }), entry('/home/notes.md'), entry('/home/photo.png'), entry('/home/archive.zip')],
  '/home/shop': [entry('/home/shop/src', { kind: 'dir' }), entry('/home/shop/App.tsx'), entry('/home/shop/index.html'), entry('/home/shop/.env', { hidden: true })],
  '/home/shop/src': [],
  '/deep/a/b/c/d/e': [entry('/deep/a/b/c/d/e/f.txt'), entry('/deep/a/b/c/d/e/page.html')]
}

function preview(path: string): FinderPreview {
  const e = Object.values(FOLDERS).flat().find((x) => x.path === path) ?? entry(path)
  if (e.kind === 'dir' && !e.bundle) return { entry: e, type: 'dir', items: 3 }
  if (path.endsWith('.md')) return { entry: e, type: 'text', text: '# Notes\n\n[docs](https://docs.dev/) and [local](#x)', truncated: true }
  if (path.endsWith('.tsx')) return { entry: e, type: 'text', text: 'export const App = 1', truncated: false }
  if (path.endsWith('.png')) return { entry: e, type: 'image' }
  return { entry: e, type: 'binary' }
}

function setup(routes: Record<string, (p: never) => unknown> = {}) {
  const calls: [string, unknown][] = []
  const b = installBridge({
    'finder:places': () => ({ home: '/home', places: [{ id: 'home', path: '/home' }, { id: 'downloads', path: '/home/Downloads' }], volumes: [{ name: 'Backup', path: '/Volumes/Backup' }] }),
    'finder:list': ({ path, hidden }: { path: string; hidden?: boolean }) => {
      if (path === '/locked') throw Object.assign(new Error('Cannot read /locked: EACCES'), { code: 'no-access' })
      const entries = (FOLDERS[path] ?? []).filter((e) => hidden || !e.hidden)
      return { path, parent: path === '/' ? null : path.split('/').slice(0, -1).join('/') || '/', entries, total: entries.length, offset: 0 }
    },
    'finder:preview': ({ path }: { path: string }) => preview(path),
    'finder:search': ({ query }: { query: string }) => (query === 'none' ? [] : [entry(`/home/shop/src/${query}.ts`)]),
    'finder:mkdir': ({ parent, name }: { parent: string; name: string }) => `${parent}/${name}`,
    'finder:rename': ({ path, name }: { path: string; name: string }) => `${path.split('/').slice(0, -1).join('/')}/${name}`,
    'finder:trash': () => [],
    'finder:conflicts': () => [],
    'finder:transfer': () => ({ items: [], replaced: [], skipped: [] }),
    'finder:info': ({ path }: { path: string }) => ({ entry: preview(path).entry, createdMs: 0, accessedMs: 0, mode: 0o644, owner: 'me', writable: true }),
    'finder:folderSize': () => ({ bytes: 4200, files: 3, folders: 1, partial: false }),
    'finder:clipboardRead': () => [],
    'finder:clipboardWrite': () => undefined,
    'finder:open': () => undefined,
    'finder:reveal': () => undefined,
    'memory:status': () => ({ exists: true, root: '/home/vault' }),
    'projects:list': () => [{ id: 'p1', name: 'shop', path: '/home/shop', addedAt: '', lastSeenAt: '' }],
    ...routes
  })
  const invoke = b.invoke.getMockImplementation()!
  b.invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    calls.push([channel, payload])
    return invoke(channel, payload)
  })
  const sent = (channel: string) => calls.filter(([c]) => c === channel).map(([, p]) => p)
  const onNavigate = vi.fn()
  const view = render(<FilesView onNavigate={onNavigate} />)
  return { sent, onNavigate, view }
}

const row = (name: string) => screen.getByRole('row', { name: new RegExp(`^${name.replace('.', '\\.')}`) })
const main = () => screen.getByRole('grid').parentElement!
const key = (k: string, mods: Record<string, boolean> = {}) => fireEvent.keyDown(main(), { key: k, ...mods })
/** jsdom has no DragEvent: drag events get their ⌥ state by hand. */
const drag = (type: 'dragOver' | 'drop', el: HTMLElement, dataTransfer: object, altKey = false) => {
  const event = createEvent[type](el, { dataTransfer })
  Object.defineProperty(event, 'altKey', { value: altKey })
  fireEvent(el, event)
}

beforeEach(() => {
  useFiles.setState(initial.files, true)
  useProjects.setState(initial.projects, true)
  useEditor.setState(initial.editor, true)
  useBrowser.setState(initial.browser, true)
  useTerminals.setState(initial.terminals, true)
  useAgents.setState(initial.agents, true)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('FilesView', () => {
  it('lives in the desktop app', () => {
    render(<FilesView onNavigate={vi.fn()} />)
    expect(screen.getByText('Files live in the desktop app')).toBeInTheDocument()
  })

  it('lists Home with places, columns and a status line — and walks the folders', async () => {
    const { sent } = setup()
    await settle()
    expect(screen.getByRole('navigation', { name: 'Files' })).toHaveTextContent('FavoritesHomeDownloadsMemory vaultProjectsshopLocationsBackup')
    expect(screen.getAllByRole('row')).toHaveLength(6) // the header and five entries
    expect(row('shop')).toHaveTextContent('Folder')
    expect(row('notes.md')).toHaveTextContent('1.2 KB')
    expect(row('Tools.app')).toHaveTextContent('App or package')
    expect(screen.getByText('5 items')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '~' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()

    fireEvent.doubleClick(row('shop'))
    await settle()
    expect(within(screen.getByTitle('Go to folder (⌘⇧G) — type a path')).getByRole('button', { name: 'shop' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Enclosing folder' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: '~' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Enclosing folder' }))
    await settle()
    expect(screen.getByRole('button', { name: '/' })).toBeInTheDocument() // outside Home: from the root
    expect(screen.getByRole('button', { name: 'Enclosing folder' })).toBeDisabled()
    expect(sent('finder:list').map((p) => (p as { path: string }).path)).toEqual(['/home', '/home/shop', '/home', '/home/shop', '/home', '/home', '/'])
    // the sidebar takes you anywhere it lists
    fireEvent.click(screen.getByRole('button', { name: 'Memory vault' }))
    await settle()
    expect(sent('finder:list').at(-1)).toEqual({ path: '/home/vault', hidden: false })
  })

  it('goes to a typed path (⌘⇧G or a double-click on the path), folding deep paths in the middle', async () => {
    const { sent } = setup()
    await settle()
    fireEvent.doubleClick(screen.getByTitle('Go to folder (⌘⇧G) — type a path'))
    const input = screen.getByRole('textbox', { name: 'Go to folder (⌘⇧G) — type a path' }) as HTMLInputElement
    expect(input.value).toBe('/home')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '/deep/a/b/c/d/e' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await settle()
    expect(screen.getByText('…')).toHaveAttribute('title', '/deep/a/b/c/d/e') // the middle folds
    expect(screen.getByRole('button', { name: 'e' })).toBeInTheDocument()
    key('g', { metaKey: true, shiftKey: true })
    const again = screen.getByRole('textbox', { name: /Go to folder/ })
    fireEvent.change(again, { target: { value: '~/shop' } })
    fireEvent.keyDown(again, { key: 'Enter' })
    await settle()
    expect(sent('finder:list').at(-1)).toMatchObject({ path: '/home/shop' })
    fireEvent.doubleClick(screen.getByTitle('Go to folder (⌘⇧G) — type a path'))
    fireEvent.change(screen.getByRole('textbox', { name: /Go to folder/ }), { target: { value: '~' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: /Go to folder/ }), { key: 'Enter' })
    await settle()
    expect(sent('finder:list').at(-1)).toMatchObject({ path: '/home' })
    // Escape, an empty path or leaving the field change nothing
    fireEvent.doubleClick(screen.getByTitle('Go to folder (⌘⇧G) — type a path'))
    fireEvent.keyDown(screen.getByRole('textbox', { name: /Go to folder/ }), { key: 'Escape' })
    fireEvent.doubleClick(screen.getByTitle('Go to folder (⌘⇧G) — type a path'))
    fireEvent.change(screen.getByRole('textbox', { name: /Go to folder/ }), { target: { value: '  ' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: /Go to folder/ }), { key: 'a' })
    fireEvent.keyDown(screen.getByRole('textbox', { name: /Go to folder/ }), { key: 'Enter' })
    fireEvent.doubleClick(screen.getByTitle('Go to folder (⌘⇧G) — type a path'))
    fireEvent.blur(screen.getByRole('textbox', { name: /Go to folder/ }))
    fireEvent.doubleClick(screen.getByRole('button', { name: '~' })) // on a crumb: no editing
    expect(screen.queryByRole('textbox', { name: /Go to folder/ })).toBeNull()
    expect(sent('finder:list')).toHaveLength(4)
  })

  it('searches after a pause, shows what it found and clears', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    setup()
    await settle()
    const search = screen.getByRole('textbox', { name: 'Search in “home”' })
    fireEvent.change(search, { target: { value: 'cart' } })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    await settle()
    expect(screen.getByText('1 found')).toBeInTheDocument()
    expect(row('cart.ts')).toBeInTheDocument()
    fireEvent.contextMenu(main()) // no folder menu over search hits
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    await settle()
    expect(screen.getByText('5 items')).toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'none' } })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    await settle()
    expect(screen.getByText('Nothing found')).toBeInTheDocument()
    fireEvent.keyDown(search, { key: 'Escape' })
    fireEvent.keyDown(search, { key: 'a' })
    await settle()
    expect(screen.getByText('5 items')).toBeInTheDocument()
    act(() => useFiles.setState({ searching: true }))
    expect(screen.getByText('Searching…')).toBeInTheDocument()
  })

  it('switches views, shows hidden files and the preview, creates folders and refreshes', async () => {
    const { sent } = setup()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Icons' }))
    expect(screen.getByRole('button', { name: 'Icons' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('gridcell').map((c) => c.getAttribute('title'))).toEqual(['shop', 'archive.zip', 'notes.md', 'photo.png', 'Tools.app']) // apps sort like files
    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show hidden files' }))
    await settle()
    expect(sent('finder:list').at(-1)).toEqual({ path: '/home', hidden: true })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('complementary', { name: 'Preview' })).toBeNull() // nothing selected: no pane, the files get the room
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    const name = screen.getByRole('textbox', { name: 'New folder' }) as HTMLInputElement
    expect(name.value).toBe('untitled folder')
    fireEvent.change(name, { target: { value: 'Plans' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    await settle()
    expect(sent('finder:mkdir')).toEqual([{ parent: '/home', name: 'Plans' }])
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(sent('finder:list').length).toBeGreaterThan(3)
  })

  it('opens what a double-click or Enter means: folders here, project files in the Editor, pages in the Browser, the rest with its app', async () => {
    const selectProject = vi.fn(async () => {})
    const open = vi.fn(async () => {})
    const show = vi.fn(async () => {})
    useEditor.setState({ selectProject, open })
    useBrowser.setState({ show })
    const { sent, onNavigate } = setup()
    await settle()
    fireEvent.doubleClick(row('Tools.app'))
    fireEvent.doubleClick(row('archive.zip'))
    await settle()
    expect(sent('finder:open')).toEqual([{ path: '/home/Tools.app' }, { path: '/home/archive.zip' }])
    fireEvent.doubleClick(row('shop'))
    await settle()
    fireEvent.doubleClick(row('App.tsx'))
    await settle()
    expect(selectProject).toHaveBeenCalledWith('p1')
    expect(open).toHaveBeenCalledWith('App.tsx')
    expect(onNavigate).toHaveBeenCalledWith('editor')
    fireEvent.doubleClick(row('index.html')) // a page of a project is code: the Editor
    await settle()
    expect(open).toHaveBeenLastCalledWith('index.html')
    expect(show).not.toHaveBeenCalled()
    act(() => void useFiles.getState().open('/deep/a/b/c/d/e'))
    await settle()
    fireEvent.doubleClick(row('page.html')) // any other page: the Browser
    expect(show).toHaveBeenCalledWith('file:///deep/a/b/c/d/e/page.html')
  })

  it('takes the keyboard like Finder', async () => {
    const { sent } = setup()
    await settle()
    key('ArrowDown')
    expect(useFiles.getState().selected).toEqual(['/home/shop'])
    key('ArrowDown')
    key('ArrowDown', { shiftKey: true })
    expect(useFiles.getState().selected).toEqual(['/home/archive.zip', '/home/notes.md'])
    key('ArrowUp')
    expect(useFiles.getState().selected).toEqual(['/home/archive.zip'])
    key('Enter') // one picked: open it
    await settle()
    expect(sent('finder:open')).toEqual([{ path: '/home/archive.zip' }])
    key('a', { metaKey: true })
    expect(useFiles.getState().selected).toHaveLength(5)
    key('Enter') // several picked: nothing to open
    key('F2')
    act(() => useFiles.getState().clearSelection())
    key('ArrowUp') // nothing picked: the first
    expect(useFiles.getState().selected).toEqual(['/home/shop'])
    key('F2')
    expect(useFiles.getState().renaming).toBe('/home/shop')
    key('Enter') // while renaming the field has the keys
    act(() => useFiles.getState().cancelRename())
    key(' ')
    expect(useFiles.getState().showPreview).toBe(false)
    key(' ')
    key('n', { metaKey: true, shiftKey: true })
    expect(useFiles.getState().creating).toBe(true)
    act(() => useFiles.getState().cancelCreate())
    key('Backspace', { metaKey: true })
    await settle()
    expect(sent('finder:trash')).toEqual([{ paths: ['/home/shop'] }])
    expect(screen.getByText('Moved to the Trash')).toBeInTheDocument()
    key('ArrowDown', { ctrlKey: true }) // nothing picked: ⌘↓ (Ctrl elsewhere) picks the first …
    expect(useFiles.getState().selected).toEqual(['/home/shop'])
    key('ArrowDown', { metaKey: true }) // … and then opens it
    await settle()
    key('[', { metaKey: true })
    await settle()
    key(']', { metaKey: true })
    await settle()
    key('ArrowUp', { metaKey: true })
    await settle()
    expect(sent('finder:list').map((p) => (p as { path: string }).path).slice(-4)).toEqual(['/home/shop', '/home', '/home/shop', '/home'])
    key('x') // not a key of the module
    // in the icon grid ↑/↓ move a row, ←/→ one
    fireEvent.click(screen.getByRole('button', { name: 'Icons' }))
    Object.defineProperty(main(), 'clientWidth', { value: 240, configurable: true })
    act(() => useFiles.getState().select('/home/shop'))
    key('ArrowRight')
    expect(useFiles.getState().selected).toEqual(['/home/archive.zip'])
    key('ArrowLeft')
    key('ArrowDown') // two tiles fit across
    expect(useFiles.getState().selected).toEqual(['/home/notes.md'])
  })

  it('offers the right actions on an entry and on the folder', async () => {
    const openFolder = vi.fn(async () => {})
    const openDialog = vi.fn()
    useTerminals.setState({ openFolder })
    useAgents.setState({ openDialog })
    const { sent, onNavigate } = setup()
    await settle()
    const menuOf = (target: HTMLElement) => {
      fireEvent.contextMenu(target, { clientX: 10, clientY: 20 })
      return screen.getByRole('menu', { name: 'File actions' })
    }
    const pick = (menu: HTMLElement, label: string) => fireEvent.click(within(menu).getByRole('menuitem', { name: label }))

    // the folder itself
    let menu = menuOf(main())
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['New folder', 'Paste', 'New tab', 'Open Terminal here', 'Show in folder', 'Refresh'])
    pick(menu, 'Open Terminal here')
    expect(openFolder).toHaveBeenCalledWith('/home')
    expect(onNavigate).toHaveBeenLastCalledWith('terminal')
    for (const label of ['Show in folder', 'Refresh', 'New folder']) pick(menuOf(main()), label)
    await settle()
    expect(sent('finder:reveal')).toEqual([{ path: '/home' }])
    act(() => useFiles.getState().cancelCreate())

    // a folder entry
    menu = menuOf(row('shop'))
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Open',
      'Open in new tab',
      'Show in folder',
      'Open Terminal here',
      'Copy',
      'Cut',
      'Duplicate',
      'Compress',
      'Add to sidebar',
      'Ask an agent about it',
      'Copy path',
      'Rename',
      'Move to Trash'
    ])
    pick(menu, 'Open Terminal here')
    expect(openFolder).toHaveBeenLastCalledWith('/home/shop')
    pick(menuOf(row('shop')), 'Ask an agent about it')
    expect(openDialog).toHaveBeenCalledWith('Look at /home/shop — ')
    expect(onNavigate).toHaveBeenLastCalledWith('agents')
    pick(menuOf(row('shop')), 'Copy path') // no clipboard: still says so
    expect(screen.getByText('Path copied')).toBeInTheDocument()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    pick(menuOf(row('shop')), 'Copy path')
    expect(writeText).toHaveBeenCalledWith('/home/shop')
    Reflect.deleteProperty(navigator, 'clipboard')
    pick(menuOf(row('shop')), 'Rename')
    const rename = screen.getByRole('textbox', { name: 'Rename' }) as HTMLInputElement
    fireEvent.change(rename, { target: { value: 'store' } })
    fireEvent.keyDown(rename, { key: 'Enter' })
    await settle()
    expect(sent('finder:rename')).toEqual([{ path: '/home/shop', name: 'store' }])
    pick(menuOf(row('archive.zip')), 'Duplicate')
    pick(menuOf(row('archive.zip')), 'Open with default app')
    pick(menuOf(row('archive.zip')), 'Show in folder')
    pick(menuOf(row('archive.zip')), 'Move to Trash')
    await settle()
    expect(sent('finder:transfer')).toEqual([{ id: expect.any(String), paths: ['/home/archive.zip'], dest: '/home', mode: 'copy', choices: {} }])
    expect(sent('finder:trash')).toEqual([{ paths: ['/home/archive.zip'] }])
    pick(menuOf(row('archive.zip')), 'Open')

    // several picked: no single-entry actions
    act(() => useFiles.getState().selectAll())
    menu = menuOf(row('notes.md'))
    expect(within(menu).getByRole('menuitem', { name: 'Open' })).toBeDisabled()
    expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens project files in the Editor and pages in the Browser from the menu and the preview', async () => {
    const selectProject = vi.fn(async () => {})
    const open = vi.fn(async () => {})
    const show = vi.fn(async () => {})
    useEditor.setState({ selectProject, open })
    useBrowser.setState({ show })
    setup()
    await settle()
    fireEvent.doubleClick(row('shop'))
    await settle()
    fireEvent.contextMenu(row('App.tsx'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Editor' }))
    await settle()
    expect(open).toHaveBeenCalledWith('App.tsx')
    fireEvent.contextMenu(row('index.html'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Browser' }))
    expect(show).toHaveBeenCalledWith('file:///home/shop/index.html')

    // the preview pane offers the same
    fireEvent.click(row('App.tsx'))
    await settle()
    expect(screen.getByText('export const App = 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open in Editor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await settle()
    expect(open).toHaveBeenCalledTimes(3)
    fireEvent.click(row('index.html'))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Open in Browser' }))
    expect(show).toHaveBeenCalledTimes(2)
  })

  it('shows Windows paths from the drive (or Home) on, and offers no menu before a folder is shown', async () => {
    setup({
      'finder:places': () => ({ home: 'C:\\Users\\me', places: [], volumes: [] }),
      'finder:list': () => {
        throw new Error('EPERM')
      }
    })
    await settle()
    const area = screen.getByText('This folder is empty').closest('[tabindex="0"]')!
    fireEvent.contextMenu(area)
    expect(screen.queryByRole('menu')).toBeNull()
    act(() => useFiles.setState({ error: undefined, listing: { path: 'C:\\Users\\me\\code', parent: 'C:\\Users\\me', entries: [], total: 0, offset: 0 } }))
    const crumbs = screen.getByTitle('Go to folder (⌘⇧G) — type a path')
    expect(within(crumbs).getAllByRole('button').map((b) => [b.textContent, b.title])).toEqual([
      ['~', 'C:\\Users\\me'],
      ['code', 'C:\\Users\\me\\code']
    ])
    act(() => useFiles.setState({ listing: { path: 'D:\\data', parent: 'D:\\', entries: [], total: 0, offset: 0 } }))
    // the drive's root (D:\\), not the bare drive — that would be its current folder
    expect(within(crumbs).getAllByRole('button').map((b) => [b.textContent, b.title])).toEqual([
      ['D:', 'D:\\'],
      ['data', 'D:\\data']
    ])
  })

  it('opens a project’s files in the Editor on Windows too (backslashes)', async () => {
    const selectProject = vi.fn(async () => {})
    const open = vi.fn(async () => {})
    useEditor.setState({ selectProject, open })
    setup({ 'projects:list': () => [{ id: 'w', name: 'shop', path: 'C:\\shop', addedAt: '', lastSeenAt: '' }] })
    await settle()
    const file = entry('C:\\shop\\src\\App.tsx', { name: 'App.tsx' })
    act(() => useFiles.setState({ listing: { path: 'C:\\shop\\src', parent: 'C:\\shop', entries: [file], total: 1, offset: 0 } }))
    fireEvent.doubleClick(row('App.tsx'))
    await settle()
    expect(selectProject).toHaveBeenCalledWith('w')
    expect(open).toHaveBeenCalledWith('src/App.tsx')
  })

  it('explains folders it may not read, and errors it got; notices fade', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    setup()
    await settle()
    act(() => void useFiles.getState().open('/locked'))
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('Mindeck may not read this folder')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    act(() => useFiles.setState({ error: 'disk full' }))
    expect(screen.getByRole('alert')).toHaveTextContent('disk full')
    act(() => useFiles.setState({ notice: { key: 'trashed', count: 3 } }))
    expect(screen.getByText('3 items moved to the Trash')).toBeInTheDocument()
    await act(async () => {
      vi.advanceTimersByTime(3600)
    })
    expect(screen.queryByText('3 items moved to the Trash')).toBeNull()
    act(() => useFiles.setState({ notice: { key: 'trashed', count: 3, noUndo: 1 } }))
    expect(screen.getByText('3 items moved to the Trash · 1 of them cannot be put back with ⌘Z')).toBeInTheDocument()
    // ⌘Z after the trash was emptied: what is lost, by name.
    act(() => useFiles.setState({ error: 'a.txt, b.txt', errorCode: 'trash-gone' }))
    expect(screen.getByRole('alert')).toHaveTextContent('No longer in the Trash, so it cannot come back: a.txt, b.txt')
    expect(screen.queryByRole('button', { name: 'Open System Settings' })).toBeNull()
    // macOS without Full Disk Access: which switch, and a way there.
    act(() => useFiles.setState({ error: 'EPERM', errorCode: 'full-disk-access' }))
    expect(screen.getByRole('alert')).toHaveTextContent('only with Full Disk Access')
    fireEvent.click(screen.getByRole('button', { name: 'Open System Settings' }))
    await settle()
    expect(useFiles.getState().errorCode).toBe('full-disk-access')
    act(() => useFiles.setState({ listing: { path: '/home/shop/src', parent: '/home/shop', entries: [], total: 0, offset: 0 } }))
    expect(screen.getByText('This folder is empty')).toBeInTheDocument()
    act(() => useFiles.setState({ selected: ['/x'] }))
    act(() => useFiles.setState({ listing: { path: '/home', parent: '/', entries: [entry('/home/a.txt')], total: 0, offset: 0 }, selected: ['/home/a.txt'] }))
    expect(screen.getByText('1 of 1 selected')).toBeInTheDocument()
    fireEvent.click(main()) // the empty area: nothing picked
    expect(useFiles.getState().selected).toEqual([])
  })
})

describe('files building blocks', () => {
  /** A folder already on screen: no places to load, no vault, no projects. */
  const quiet = () => {
    installBridge({ 'memory:status': () => ({ exists: false, root: '' }), 'projects:list': () => [] })
    useFiles.setState({ places: { home: '/home', places: [], volumes: [] } })
  }

  it('Sidebar: no vault when its status can\'t be read', async () => {
    installBridge({ 'memory:status': () => Promise.reject(new Error('offline')), 'projects:list': () => [] })
    useFiles.setState({ places: { home: '/home', places: [{ id: 'home', path: '/home' }], volumes: [] } })
    render(<Sidebar />)
    await settle()
    expect(screen.queryByText('Memory vault')).toBeNull()
  })

  it('Sidebar: places, vault, projects and drives — and a drop target for moving and copying', async () => {
    installBridge({ 'memory:status': () => ({ exists: false, root: '/v' }), 'finder:move': () => [], 'finder:copy': () => [], 'finder:list': () => ({ path: '/home', parent: '/', entries: [], total: 0, offset: 0 }) })
    const move = vi.fn(async () => {})
    useFiles.setState({ places: { home: '/home', places: [{ id: 'home', path: '/home' }], volumes: [] }, move })
    useProjects.setState({ projects: [{ id: 'p', name: 'p', path: '/p', addedAt: '', lastSeenAt: '' }] })
    render(<Sidebar />)
    await settle()
    expect(screen.queryByText('Memory vault')).toBeNull()
    expect(screen.queryByText('Locations')).toBeNull()
    const home = screen.getByRole('button', { name: 'Home' })
    const files = (paths: string[]) => ({ types: ['application/x-mindeck-files'], getData: () => JSON.stringify(paths), dropEffect: '' })
    drag('dragOver', home, { types: ['text/plain'] }) // not files
    expect(home.className).not.toContain('ring-cyan/50')
    const fromOs = { types: ['Files'], dropEffect: '' }
    drag('dragOver', home, fromOs) // from Finder / Explorer: copied in
    expect(fromOs.dropEffect).toBe('copy')
    fireEvent.dragLeave(home)
    const over = files(['/x.txt'])
    drag('dragOver', home, over)
    expect(home.className).toContain('ring-cyan/50')
    expect(over.dropEffect).toBe('move')
    drag('dragOver', home, over, true)
    expect(over.dropEffect).toBe('copy')
    fireEvent.dragLeave(home)
    expect(home.className).not.toContain('ring-cyan/50')
    drag('drop', home, files(['/x.txt', '/home']))
    drag('drop', home, files(['/y.txt']), true)
    drag('drop', home, files(['/home'])) // onto itself: nothing
    const dropFiles = vi.fn(async () => {})
    useFiles.setState({ dropFiles })
    const file = new File([''], 'f.txt')
    drag('drop', home, { types: ['Files'], getData: () => '', files: [file] }, true)
    expect(dropFiles).toHaveBeenCalledWith([file], '/home', true)
    expect(move.mock.calls).toEqual([
      [['/x.txt'], '/home', false],
      [['/y.txt'], '/home', true]
    ])
  })

  it('rows and tiles drag the selection (or themselves) onto folders', async () => {
    quiet()
    const move = vi.fn(async () => {})
    const list = { path: '/home', parent: '/', entries: [entry('/home/a.txt'), entry('/home/b.txt'), entry('/home/dir', { kind: 'dir' }), entry('/home/.h', { hidden: true })], total: 4, offset: 0 }
    useFiles.setState({ listing: list, selected: ['/home/a.txt', '/home/b.txt'], move })
    render(<FilesView onNavigate={vi.fn()} />)
    const data: Record<string, string> = {}
    const dt = { setData: (k: string, v: string) => (data[k] = v), getData: (k: string) => data[k], types: ['application/x-mindeck-files'], effectAllowed: '' }
    fireEvent.dragStart(row('a.txt'), { dataTransfer: dt })
    expect(JSON.parse(data['application/x-mindeck-files'])).toEqual(['/home/a.txt', '/home/b.txt'])
    drag('drop', row('dir'), dt)
    fireEvent.dragStart(row('dir'), { dataTransfer: dt }) // not selected: just itself
    expect(JSON.parse(data['application/x-mindeck-files'])).toEqual(['/home/dir'])
    expect(move).toHaveBeenCalledWith(['/home/a.txt', '/home/b.txt'], '/home/dir', false)
    expect(row('.h').className).toContain('opacity-60')
    drag('dragOver', row('dir'), dt)
    expect(row('dir').className).toContain('ring-cyan/60')
    fireEvent.click(row('dir'), { metaKey: true }) // ⌘-click adds …
    expect(useFiles.getState().selected).toEqual(['/home/a.txt', '/home/b.txt', '/home/dir'])
    fireEvent.click(row('a.txt'))
    fireEvent.click(row('dir'), { shiftKey: true }) // … ⇧-click spans
    expect(useFiles.getState().selected).toEqual(['/home/dir', '/home/.h', '/home/a.txt'])
    act(() => useFiles.setState({ selected: ['/home/a.txt', '/home/b.txt'] }))
    act(() => useFiles.getState().startRename('/home/a.txt'))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename' }), { key: 'Escape' })
    expect(useFiles.getState().renaming).toBeUndefined()
    // the same on tiles
    act(() => useFiles.setState({ view: 'grid' }))
    const tile = screen.getByTitle('a.txt')
    fireEvent.dragStart(tile, { dataTransfer: dt })
    expect(screen.getByTitle('.h').className).toContain('opacity-60')
    drag('dragOver', screen.getByTitle('dir'), dt)
    expect(screen.getByTitle('dir').className).toContain('ring-cyan/60')
    fireEvent.contextMenu(tile)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.mouseDown(document.body) // a click elsewhere closes it
    expect(screen.queryByRole('menu')).toBeNull()
    // renaming on a tile: Escape gives up, and a field never commits twice
    act(() => useFiles.getState().startRename('/home/b.txt'))
    const field = screen.getByRole('textbox', { name: 'Rename' }) as HTMLInputElement
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 1]) // the name, not the extension
    fireEvent.click(field)
    fireEvent.doubleClick(field)
    fireEvent.keyDown(field, { key: 'x' })
    fireEvent.keyDown(field, { key: 'Escape' })
    fireEvent.blur(field)
    expect(useFiles.getState().renaming).toBeUndefined()
    act(() => useFiles.getState().startRename('/home/dir'))
    const dirField = screen.getByRole('textbox', { name: 'Rename' }) as HTMLInputElement
    expect([dirField.selectionStart, dirField.selectionEnd]).toEqual([0, 3])
    const rename = vi.fn(async () => {})
    useFiles.setState({ rename })
    fireEvent.blur(dirField) // leaving the field commits — once
    fireEvent.keyDown(dirField, { key: 'Enter' })
    expect(rename.mock.calls).toEqual([['/home/dir', 'dir']])
    // creating in the grid
    act(() => useFiles.setState({ creating: true, renaming: undefined }))
    const create = screen.getByRole('textbox', { name: 'New folder' })
    const mkdir = vi.fn(async () => {})
    const cancelCreate = vi.fn()
    useFiles.setState({ mkdir, cancelCreate })
    fireEvent.keyDown(create, { key: 'Escape' })
    expect(cancelCreate).toHaveBeenCalled()
  })

  it('sorts by the column clicked, telling assistive tech the order', async () => {
    quiet()
    useFiles.setState({ listing: { path: '/home', parent: '/', entries: [entry('/home/b.txt', { size: 1 }), entry('/home/a.txt', { size: 2 })], total: 0, offset: 0 } })
    render(<FilesView onNavigate={vi.fn()} />)
    const header = (name: string) => screen.getByRole('columnheader', { name: new RegExp(name) })
    expect(header('Name')).toHaveAttribute('aria-sort', 'ascending')
    fireEvent.click(header('Size'))
    expect(header('Size')).toHaveAttribute('aria-sort', 'descending')
    expect(header('Name')).toHaveAttribute('aria-sort', 'none')
    expect(screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('gridcell')[0].textContent)).toEqual(['a.txt', 'b.txt'])
    fireEvent.click(header('Size'))
    expect(header('Size')).toHaveAttribute('aria-sort', 'ascending')
    fireEvent.click(header('Modified'))
    fireEvent.click(header('Kind'))
    expect(header('Kind')).toHaveAttribute('aria-sort', 'ascending')
  })

  it('FileIcon: thumbnails where they say something, icons otherwise and when there is none', () => {
    const { container, rerender } = render(<FileIcon entry={entry('/a/photo.png')} thumb size={56} />)
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toBe('mindeck-file://thumb/a/photo.png?size=112')
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
    for (const e of [entry('/a/notes.md'), entry('/a/song.mp3'), entry('/a/dir', { kind: 'dir' })]) {
      rerender(<FileIcon key={e.path} entry={e} thumb />)
      expect(container.querySelector('img')).toBeNull()
    }
    rerender(<FileIcon key="x" entry={entry('/a/x.zip')} />)
    expect(container.querySelector('img')).toBeNull()
  })

  it('ContextMenu stays inside the window and closes on a pick, Escape or a click elsewhere', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 200, height: 100 } as DOMRect)
    const onClose = vi.fn()
    const run = vi.fn()
    render(<ContextMenu x={window.innerWidth - 10} y={window.innerHeight - 10} label="Menu" onClose={onClose} items={[{ label: 'One', run }, 'separator', { label: 'Gone', run, disabled: true }, { label: 'Delete', run, danger: true }]} />)
    const menu = screen.getByRole('menu', { name: 'Menu' })
    expect(menu.style.left).toBe(`${window.innerWidth - 204}px`)
    expect(menu.style.top).toBe(`${window.innerHeight - 104}px`)
    expect(screen.getByRole('separator')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Gone' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Delete' }).className).toContain('text-danger')
    fireEvent.mouseDown(menu) // inside: stays
    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'One' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('PreviewPane shows pictures, video, audio, folders, notes and documents — links go to the browser', async () => {
    const show = vi.fn(async () => {})
    useBrowser.setState({ show })
    const actions = { open: vi.fn() }
    const view = (p: FinderPreview) => {
      act(() => useFiles.setState({ preview: p, selected: [p.entry.path] }))
    }
    const { container, rerender } = render(<PreviewPane actions={actions} editable={false} browsable={false} />)
    expect(container).toBeEmptyDOMElement() // nothing selected: no pane
    view({ entry: entry('/a/photo.png'), type: 'image' })
    expect(container.querySelector('img[alt="photo.png"]')!.getAttribute('src')).toBe('mindeck-file://local/a/photo.png')
    view({ entry: entry('/a/clip.mp4'), type: 'video' })
    expect(container.querySelector('video')!.getAttribute('src')).toBe('mindeck-file://local/a/clip.mp4')
    view({ entry: entry('/a/song.mp3'), type: 'audio' })
    expect(container.querySelector('audio')).not.toBeNull()
    view({ entry: entry('/a/docs', { kind: 'dir' }), type: 'dir', items: 1 })
    expect(screen.getByText('Folder · 1 item')).toBeInTheDocument()
    view({ entry: entry('/a/docs', { kind: 'dir' }), type: 'dir' })
    expect(screen.getByText('Folder · 0 items')).toBeInTheDocument()
    expect(screen.queryByText('Size')).toBeNull() // folders have no size here
    view({ entry: entry('/a/notes.md'), type: 'text', text: '# Notes\n\n[docs](https://docs.dev/) [mail](mailto:a@b.c)', truncated: true })
    expect(screen.getByRole('heading', { name: 'Notes' })).toBeInTheDocument()
    expect(screen.getByText('Showing the beginning of the file')).toBeInTheDocument()
    fireEvent.click(screen.getByText('docs'))
    expect(show).toHaveBeenCalledWith('https://docs.dev/')
    fireEvent.click(screen.getByText('mail'))
    fireEvent.click(screen.getByRole('heading', { name: 'Notes' })) // not a link
    expect(show).toHaveBeenCalledTimes(1)
    view({ entry: entry('/a/empty.md'), type: 'text' })
    expect(container.querySelector('.md-prose')!.textContent).toBe('')
    view({ entry: entry('/a/x.ts'), type: 'text' })
    expect(container.querySelector('pre')!.textContent).toBe('')
    view({ entry: entry('/a/paper.pdf'), type: 'pdf' })
    const thumb = container.querySelector('img')!
    expect(thumb.getAttribute('src')).toBe('mindeck-file://thumb/a/paper.pdf?size=512')
    fireEvent.error(thumb)
    expect(container.querySelector('img')).toBeNull()
    view({ entry: entry('/a/blob.bin'), type: 'binary' })
    expect(screen.getByText('No preview for this file')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(actions.open).toHaveBeenCalledWith('/a/blob.bin')
    // without handlers for the Editor and the Browser, no such buttons
    rerender(<PreviewPane actions={actions} editable browsable />)
    expect(screen.queryByRole('button', { name: 'Open in Editor' })).toBeNull()
    act(() => useFiles.setState({ selected: ['/a', '/b'] }))
    expect(container).toBeEmptyDOMElement() // several: no pane either
    // × closes it: the selection goes, and with it the pane
    view({ entry: entry('/a/blob.bin'), type: 'binary' })
    fireEvent.click(screen.getByRole('button', { name: 'Close the preview' }))
    expect(useFiles.getState().selected).toEqual([])
    expect(container).toBeEmptyDOMElement()
  })
})
