import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Bot } from 'lucide-react'
import { en } from '@/lib/i18n/en'
import { useOverlays } from '@/lib/overlay'
import { useWorkspace } from '@/features/workspace/store'
import { useEditor, type EditorTab } from '@/features/editor/store'
import { allCommands, prepareCommands, registerCommands, subscribeCommands, type Command } from '@/features/palette/registry'
import { scoreText, searchCommands } from '@/features/palette/search'
import { MAX_RECENT, usePalette } from '@/features/palette/store'
import { MAX_RECENT_FILES, rememberFile, trackRecentFiles, useRecentFiles } from '@/features/palette/recentFiles'
import { matchPaletteKey, usePaletteKeys } from '@/features/palette/keys'
import { FLASH_MS, revealSettings, showModule } from '@/features/palette/reveal'
import { CommandPalette } from '@/features/palette/components/CommandPalette'
import { ShortcutsDialog } from '@/features/palette/components/ShortcutsDialog'
import { PaletteButton } from '@/features/palette/components/PaletteButton'
import { PaletteHost } from '@/features/palette/components/PaletteHost'

const initialWorkspace = useWorkspace.getState()
const cmd = (id: string, label: string, extra: Partial<Command> = {}): Command => ({ id, label, group: 'Test', run: vi.fn(), ...extra })
const frames = (n = 1) => act(async () => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => requestAnimationFrame(r))
})

beforeEach(() => {
  useWorkspace.setState(initialWorkspace, true)
  usePalette.setState({ view: undefined, query: '', recent: [] })
  useOverlays.setState({ count: 0 })
  ;(window as unknown as { mindeck: { platform: string } }).mindeck = { platform: 'darwin' }
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the command registry', () => {
  it('lists every source’s commands in order — the first of an id wins, a failing source is left out', () => {
    const offA = registerCommands('a', () => [cmd('x', 'X'), cmd('y', 'Y')])
    const offB = registerCommands('b', { commands: (t) => [cmd('y', `Other Y ${t.common.save}`), cmd('z', 'Z')] })
    const offC = registerCommands('c', () => {
      throw new Error('broken')
    })
    expect(allCommands(en).map((c) => c.label)).toEqual(['X', 'Y', 'Z'])
    // The same id again replaces the source; taking back a replaced one leaves the new one.
    const offA2 = registerCommands('a', () => [cmd('w', 'W')])
    offA()
    expect(allCommands(en).map((c) => c.id)).toEqual(['w', 'y', 'z'])
    for (const off of [offA2, offB, offC]) off()
    expect(allCommands(en)).toEqual([])
  })

  it('lets sources fetch when the palette opens, and tell when their commands change', () => {
    const prepare = vi.fn()
    const listeners = new Set<() => void>()
    const offs = [
      registerCommands('fetching', { commands: () => [], prepare, subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)) }),
      registerCommands('failing', {
        commands: () => [],
        prepare: () => {
          throw new Error('offline')
        }
      }),
      registerCommands('plain', () => [])
    ]
    prepareCommands()
    expect(prepare).toHaveBeenCalledTimes(1)
    const changed = vi.fn()
    const stop = subscribeCommands(changed)
    listeners.forEach((fn) => fn())
    expect(changed).toHaveBeenCalledTimes(1)
    stop()
    expect(listeners.size).toBe(0)
    offs.forEach((off) => off())
  })
})

describe('searching commands', () => {
  it('scores whole pieces above scattered letters, word starts and early places higher', () => {
    expect(scoreText('Split pane', '')).toBe(0)
    expect(scoreText('Split pane', 'split')).toBe(140)
    expect(scoreText('Split pane', 'pane')).toBe(134) // at a word's start, a little later
    expect(scoreText('Unsplit', 'split')).toBe(98) // inside a word
    expect(scoreText('Settings: Appearance', 'stapp')).toBeGreaterThan(0)
    expect(scoreText('Split pane', 'spp')).toBe(30 - 4)
    expect(scoreText('Theme: Dark appearance', 'pane', false)).toBeNull() // only pieces, where asked
    expect(scoreText('Split pane', 'zz')).toBeNull()
    expect(scoreText('Browser › Bookmarks', 'bookm brow')).toBe(130 + 140)
    expect(scoreText('a'.repeat(200) + 'x', 'x')).toBe(50) // far in: no extra for the place
    expect(scoreText('ab', 'ab')).toBe(140)
    expect(scoreText('acccccccccccccccccccccccccccccccccccccb', 'ab')).toBe(1) // gaps cost, a match still counts
  })

  it('without a query: the recently used first, then everything but what only a search shows', () => {
    const list = [cmd('a', 'Alpha'), cmd('b', 'Beta'), cmd('note', 'Note', { searchOnly: true }), cmd('c', 'Gamma')]
    const { recent, results } = searchCommands(list, ' ', ['c', 'gone', 'note'])
    expect(recent.map((c) => c.id)).toEqual(['c', 'note'])
    expect(results.map((c) => c.id)).toEqual(['a', 'b'])
    expect(searchCommands(list, '', [], 1).results).toHaveLength(1)
  })

  it('with one: the matches, best first — by label, then group, detail and keywords; recent ones a little ahead', () => {
    const list = [
      cmd('theme', 'Theme: Dark', { group: 'Appearance', keywords: 'dunkel' }),
      cmd('split', 'Split pane', { group: 'Workspace' }),
      cmd('file', 'index.ts', { detail: 'shop › src' }),
      cmd('beside', 'Browser in a new pane', { group: 'Workspace' })
    ]
    expect(searchCommands(list, 'dunkel', []).results.map((c) => c.id)).toEqual(['theme'])
    expect(searchCommands(list, 'shop', []).results.map((c) => c.id)).toEqual(['file'])
    expect(searchCommands(list, 'pane', []).results.map((c) => c.id)).toEqual(['split', 'beside'])
    expect(searchCommands(list, 'pane', ['beside']).results.map((c) => c.id)).toEqual(['beside', 'split'])
    expect(searchCommands(list, 'workspace', ['beside']).results.map((c) => c.id)).toEqual(['beside', 'split'])
    expect(searchCommands(list, 'xyz', []).results).toEqual([])
    expect(searchCommands(list, 'splpn', []).results.map((c) => c.id)).toEqual(['split']) // scattered letters: the label only
    expect(searchCommands(list, 'pane', [], 1).results).toHaveLength(1)
  })
})

describe('the palette store', () => {
  it('opens, closes and toggles the palette and the shortcut overview', () => {
    const p = () => usePalette.getState()
    p().show('set')
    expect(p()).toMatchObject({ view: 'commands', query: 'set' })
    p().toggle('commands')
    expect(p().view).toBeUndefined()
    p().toggle('commands')
    expect(p()).toMatchObject({ view: 'commands', query: '' })
    p().toggle('shortcuts')
    expect(p().view).toBe('shortcuts')
    p().toggle('shortcuts')
    expect(p().view).toBeUndefined()
  })

  it('remembers the commands used last, per device — a few of them', async () => {
    for (let i = 0; i < MAX_RECENT + 2; i += 1) usePalette.getState().used(`c${i}`)
    usePalette.getState().used('c3')
    expect(usePalette.getState().recent[0]).toBe('c3')
    expect(usePalette.getState().recent).toHaveLength(MAX_RECENT)
    expect(JSON.parse(localStorage.getItem('mindeck.palette.recent')!)[0]).toBe('c3')

    vi.resetModules()
    expect((await import('@/features/palette/store')).usePalette.getState().recent[0]).toBe('c3')
    localStorage.setItem('mindeck.palette.recent', JSON.stringify(['a', 3, 'b']))
    vi.resetModules()
    expect((await import('@/features/palette/store')).usePalette.getState().recent).toEqual(['a', 'b'])
    localStorage.setItem('mindeck.palette.recent', '{"no":1}')
    vi.resetModules()
    expect((await import('@/features/palette/store')).usePalette.getState().recent).toEqual([])
    localStorage.setItem('mindeck.palette.recent', '{')
    vi.resetModules()
    expect((await import('@/features/palette/store')).usePalette.getState().recent).toEqual([])
    localStorage.removeItem('mindeck.palette.recent')
    vi.resetModules()
    expect((await import('@/features/palette/store')).usePalette.getState().recent).toEqual([])

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    usePalette.getState().used('x')
    expect(usePalette.getState().recent[0]).toBe('x') // until reload
  })
})

describe('recent files', () => {
  const tab = (path: string): EditorTab => ({ id: `p:${path}`, projectId: 'p', path, name: path, loading: false, revision: 1, dirty: false, saving: false, conflict: false, deleted: false })

  it('follows the file the editor shows, the latest first, without repeats', () => {
    useRecentFiles.setState({ files: [] })
    const stop = trackRecentFiles()
    useEditor.setState({ tabs: [tab('a.ts'), tab('b.ts')], activeId: 'p:a.ts' })
    useEditor.setState({ activeId: 'p:b.ts' })
    useEditor.setState({ dirty: true } as never) // anything else: nothing
    useEditor.setState({ activeId: 'p:a.ts' })
    useEditor.setState({ activeId: 'p:gone' })
    expect(useRecentFiles.getState().files).toEqual([
      { projectId: 'p', path: 'a.ts' },
      { projectId: 'p', path: 'b.ts' }
    ])
    stop()
    useEditor.setState({ activeId: 'p:b.ts' })
    expect(useRecentFiles.getState().files[0].path).toBe('a.ts')
    for (let i = 0; i < MAX_RECENT_FILES + 3; i += 1) rememberFile({ projectId: 'q', path: `${i}.md` })
    expect(useRecentFiles.getState().files).toHaveLength(MAX_RECENT_FILES)
    expect(JSON.parse(localStorage.getItem('mindeck.recentFiles')!)).toHaveLength(MAX_RECENT_FILES)
  })

  it('comes back after a restart — what is valid of it', async () => {
    localStorage.setItem('mindeck.recentFiles', JSON.stringify([{ projectId: 'p', path: 'a.ts' }, { path: 'b' }, null, 'x']))
    vi.resetModules()
    expect((await import('@/features/palette/recentFiles')).useRecentFiles.getState().files).toEqual([{ projectId: 'p', path: 'a.ts' }])
    localStorage.setItem('mindeck.recentFiles', '"nope"')
    vi.resetModules()
    expect((await import('@/features/palette/recentFiles')).useRecentFiles.getState().files).toEqual([])
    localStorage.setItem('mindeck.recentFiles', '[')
    vi.resetModules()
    expect((await import('@/features/palette/recentFiles')).useRecentFiles.getState().files).toEqual([])
    localStorage.removeItem('mindeck.recentFiles')
    vi.resetModules()
    expect((await import('@/features/palette/recentFiles')).useRecentFiles.getState().files).toEqual([])
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    rememberFile({ projectId: 'p', path: 'c.ts' })
    expect(useRecentFiles.getState().files[0].path).toBe('c.ts')
  })
})

describe('the palette’s keys', () => {
  const key = (k: Partial<KeyboardEvent>) => ({ key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...k })

  it('leave ⌘K to the code editor and the terminal, ⌘/ to the editors, "?" to anything one types into', () => {
    document.body.innerHTML = '<div class="monaco-editor"><textarea id="m"></textarea></div><div class="xterm"><textarea id="x"></textarea></div><div class="cm-editor"><div id="c" contenteditable="true"></div></div><input id="i"><div id="d" contenteditable="false"></div><button id="b"></button>'
    const el = (id: string) => document.getElementById(id)
    const cmdK = key({ key: 'k', code: 'KeyK', metaKey: true })
    expect(matchPaletteKey(cmdK, true, el('b'))).toBe('palette')
    expect(matchPaletteKey(cmdK, true, el('m'))).toBeNull()
    expect(matchPaletteKey(cmdK, true, el('x'))).toBeNull()
    expect(matchPaletteKey(cmdK, true, el('i'))).toBe('palette') // the palette's own field: closes it
    const cmdShiftP = key({ key: 'P', code: 'KeyP', metaKey: true, shiftKey: true })
    expect(matchPaletteKey(cmdShiftP, true, el('m'))).toBe('palette')
    const slash = key({ key: '/', code: 'Slash', metaKey: true })
    expect(matchPaletteKey(slash, true, el('m'))).toBeNull()
    expect(matchPaletteKey(slash, true, el('c'))).toBeNull()
    expect(matchPaletteKey(slash, true, el('x'))).toBe('shortcuts')
    const question = key({ key: '?', shiftKey: true })
    expect(matchPaletteKey(question, false, el('b'))).toBe('shortcuts')
    expect(matchPaletteKey(question, false, null)).toBe('shortcuts')
    for (const id of ['i', 'c', 'x', 'm']) expect(matchPaletteKey(question, false, el(id)), id).toBeNull()
    expect(matchPaletteKey(question, false, el('d'))).toBe('shortcuts')
    expect(matchPaletteKey(key({ key: 'k', ctrlKey: true }), false, el('b'))).toBe('palette')
    expect(matchPaletteKey(key({ key: 'j', metaKey: true }), true, el('b'))).toBeNull()
    document.body.innerHTML = ''
  })

  it('open and close the palette and the overview from anywhere — not while composing or held down', () => {
    function Keys() {
      usePaletteKeys()
      return null
    }
    const { unmount } = render(<Keys />)
    const inner = vi.fn()
    window.addEventListener('keydown', inner)
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
    expect(usePalette.getState().view).toBe('commands')
    expect(inner).not.toHaveBeenCalled() // taken before the modules see it
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
    expect(usePalette.getState().view).toBeUndefined()
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true })
    expect(usePalette.getState().view).toBe('shortcuts')
    fireEvent.keyDown(window, { key: '/', metaKey: true })
    expect(usePalette.getState().view).toBeUndefined()
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true, repeat: true })
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true, isComposing: true })
    fireEvent.keyDown(window, { key: 'a' })
    expect(usePalette.getState().view).toBeUndefined()
    expect(inner).toHaveBeenCalledTimes(3) // what it doesn't take goes on to the modules
    unmount()
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
    expect(usePalette.getState().view).toBeUndefined()
    window.removeEventListener('keydown', inner)
  })
})

describe('jumping somewhere', () => {
  it('brings a module up and puts the keyboard into its pane', async () => {
    document.body.innerHTML = '<div data-pane-id="p1" tabindex="-1"></div>'
    showModule('terminal')
    expect(useWorkspace.getState().layout.panes[0].module).toBe('terminal')
    await frames()
    expect(document.activeElement).toBe(document.querySelector('[data-pane-id="p1"]'))
    document.body.innerHTML = ''
  })

  it('scrolls Settings to a section and lights it up a moment — once it is drawn', async () => {
    const scroll = vi.mocked(Element.prototype.scrollIntoView)
    scroll.mockClear()
    revealSettings('Mindeck "AI"')
    expect(useWorkspace.getState().layout.panes[0].module).toBe('settings')
    await frames(3)
    document.body.innerHTML = '<section data-card="Mindeck &quot;AI&quot;"></section>'
    await frames(2)
    const section = document.querySelector('section')!
    expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' })
    expect(section).toHaveAttribute('data-flash')
    await act(() => new Promise((r) => setTimeout(r, FLASH_MS + 10)))
    expect(section).not.toHaveAttribute('data-flash')
    document.body.innerHTML = ''
  })

  it('gives up on a section that never shows (a card this core doesn’t have)', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    revealSettings('Nowhere')
    await frames(40)
    // the first look and 29 more, then no more
    expect(raf.mock.calls.length).toBeLessThan(80)
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.calls.every(([o]) => (o as ScrollIntoViewOptions)?.block !== 'start')).toBe(true)
  })
})

describe('the command palette', () => {
  const open = (commands: Command[], query = '') => {
    const off = registerCommands('test', () => commands)
    usePalette.getState().show(query)
    const view = render(<PaletteOnly />)
    return { off, ...view }
  }
  function PaletteOnly() {
    return usePalette((s) => s.view) === 'commands' ? <CommandPalette /> : null
  }
  const input = () => screen.getByRole('combobox', { name: 'Command palette' })
  const options = () => screen.getAllByRole('option').map((o) => o.textContent)

  it('lists the recently used first; arrows, Page keys and Enter choose and run; the choice moves to the top', () => {
    const split = vi.fn()
    usePalette.setState({ recent: ['b'] })
    const { off } = open([cmd('a', 'Agents', { group: 'Open', icon: Bot, detail: 'module' }), cmd('b', 'Split pane', { group: 'Workspace', keys: '⌘\\', run: split }), cmd('c', 'Settings')])
    expect(useOverlays.getState().count).toBe(1)
    expect(input()).toHaveFocus()
    expect(screen.getByText('Recently used')).toBeInTheDocument()
    expect(screen.getByText('All commands')).toBeInTheDocument()
    expect(options()).toEqual(['Split paneWorkspace⌘\\', 'AgentsmoduleOpen', 'SettingsTest'])
    expect(input()).toHaveAttribute('aria-activedescendant', 'palette-0')
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'ArrowDown' }) // stays at the end
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input(), { key: 'PageUp' })
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input(), { key: 'PageDown' })
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input(), { key: 'x' }) // typing: nothing moves
    fireEvent.mouseMove(screen.getAllByRole('option')[0])
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(split).toHaveBeenCalled()
    expect(usePalette.getState()).toMatchObject({ view: undefined, recent: ['b'] })
    off()
  })

  it('searches as one types; a click runs; nothing to run says so', () => {
    const run = vi.fn()
    const { off } = open([cmd('a', 'Agents'), cmd('t', 'Theme: Dark', { run })], 'theme')
    expect(options()).toEqual(['Theme: DarkTest'])
    expect(screen.queryByText('Recently used')).toBeNull()
    fireEvent.change(input(), { target: { value: 'zzz' } })
    expect(screen.getByText('Nothing matches')).toBeInTheDocument()
    expect(input()).not.toHaveAttribute('aria-activedescendant')
    fireEvent.keyDown(input(), { key: 'Enter' }) // nothing
    expect(usePalette.getState().view).toBe('commands')
    fireEvent.change(input(), { target: { value: 'dark' } })
    fireEvent.click(screen.getByRole('option'))
    expect(run).toHaveBeenCalled()
    expect(usePalette.getState().recent).toEqual(['t'])
    off()
  })

  it('lists anew when a source’s commands change while it is open', () => {
    let labels = ['Before']
    const listeners = new Set<() => void>()
    const off = registerCommands('live', { commands: () => labels.map((l) => cmd(l, l)), subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)) })
    usePalette.getState().show()
    render(<PaletteOnly />)
    expect(options()).toEqual(['BeforeTest'])
    labels = ['After']
    act(() => listeners.forEach((fn) => fn()))
    expect(options()).toEqual(['AfterTest'])
    off()
  })

  it('Escape and a click outside close it, and the keyboard goes back where it was', () => {
    document.body.innerHTML = '<button id="before">x</button>'
    const before = document.getElementById('before')!
    before.focus()
    const { off, unmount } = open([cmd('a', 'Agents')])
    fireEvent.mouseDown(screen.getByRole('dialog')) // inside: stays
    expect(usePalette.getState().view).toBe('commands')
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(usePalette.getState().view).toBeUndefined()
    expect(before).toHaveFocus()
    unmount()
    usePalette.getState().show()
    const again = render(<PaletteOnly />)
    before.remove() // gone meanwhile: the focus stays where it is
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)
    expect(usePalette.getState().view).toBeUndefined()
    again.unmount()
    off()
  })
})

describe('the shortcut overview', () => {
  const open = () => {
    usePalette.getState().showShortcuts()
    return render(<PaletteHostOnlyShortcuts />)
  }
  function PaletteHostOnlyShortcuts() {
    return usePalette((s) => s.view) === 'shortcuts' ? <ShortcutsDialog /> : null
  }

  it('lists every shortcut by where it works, with this platform’s keys — searchable by name and key', () => {
    open()
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(useOverlays.getState().count).toBe(1)
    const everywhere = within(dialog).getByRole('region', { name: 'Everywhere' })
    expect(within(everywhere).getByText('Command palette').closest('li')).toHaveTextContent('⌘K⇧⌘P')
    expect(within(everywhere).getAllByText('Editor, Terminal: the module’s own key wins').length).toBeGreaterThan(0)
    expect(within(dialog).getByRole('region', { name: 'Editor' })).toBeInTheDocument()
    expect(within(dialog).getByRole('region', { name: 'Files' })).toBeInTheDocument()
    expect(within(dialog).getByText('Step into')).toBeInTheDocument() // F11 on a Mac
    const search = within(dialog).getByRole('textbox', { name: 'Search shortcuts' })
    fireEvent.change(search, { target: { value: 'reopen' } })
    expect(within(dialog).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Reopen closed tab⇧⌘T'])
    fireEvent.change(search, { target: { value: '⌘\\' } })
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(3) // the workspace's split, the editor's, and its ⌘K ⌘\\ down
    fireEvent.change(search, { target: { value: 'files paste' } })
    expect(within(dialog).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Paste⌘V'])
    fireEvent.change(search, { target: { value: 'qqq' } })
    expect(within(dialog).getByText('No shortcut matches')).toBeInTheDocument()
    fireEvent.keyDown(search, { key: 'a' })
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(usePalette.getState().view).toBeUndefined()
  })

  it('elsewhere shows Ctrl, leaves out what has no key there; closes by its button or a click outside', () => {
    ;(window as unknown as { mindeck: { platform: string } }).mindeck = { platform: 'linux' }
    document.body.innerHTML = '<button id="before">x</button>'
    document.getElementById('before')!.focus()
    const { unmount } = open()
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(within(within(dialog).getByRole('region', { name: 'Everywhere' })).getByText('Command palette').closest('li')).toHaveTextContent('Ctrl+KCtrl+Shift+P')
    expect(within(dialog).queryByText('Step into')).toBeNull() // F11 is full screen there
    fireEvent.mouseDown(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(usePalette.getState().view).toBeUndefined()
    expect(document.getElementById('before')).toHaveFocus()
    unmount()
    open()
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)
    expect(usePalette.getState().view).toBeUndefined()
    // Escape closes it with the focus anywhere
    open()
    document.body.focus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(usePalette.getState().view).toBeUndefined()
    // what had the focus is gone meanwhile: nothing to give it back to
    document.body.innerHTML = '<button id="gone">x</button>'
    document.getElementById('gone')!.focus()
    open()
    document.getElementById('gone')!.remove()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(usePalette.getState().view).toBeUndefined()
  })
})

describe('the palette in the app', () => {
  it('a button in the top bar opens it, showing the key to learn', () => {
    render(<PaletteButton />)
    const button = screen.getByRole('button', { name: 'Open the command palette' })
    expect(button).toHaveAttribute('title', 'Open the command palette (⌘K)')
    fireEvent.click(button)
    expect(usePalette.getState().view).toBe('commands')
  })

  it('the host draws the palette or the overview, with the built-in commands and the keys', () => {
    render(<PaletteHost />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()
    expect(allCommands(en).some((c) => c.id === 'module.terminal')).toBe(true)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'keyboard shortcuts' } })
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
  })
})
