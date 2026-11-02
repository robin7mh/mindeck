import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '@/lib/i18n/en'
import { makeLayout, singleLayout } from '@/features/workspace/layout'

const KEY = 'mindeck.workspace'

/** The store as a fresh start reads it from this device's storage. */
async function fresh(stored?: unknown) {
  if (stored !== undefined) localStorage.setItem(KEY, typeof stored === 'string' ? stored : JSON.stringify(stored))
  vi.resetModules()
  const { useWorkspace } = await import('@/features/workspace/store')
  return useWorkspace
}
const saved = () => JSON.parse(localStorage.getItem(KEY)!) as { layout: unknown; saved: { name: string }[]; current?: string }

afterEach(() => {
  vi.useRealTimers()
})

describe('workspace store', () => {
  it('starts with the dashboard and two layouts to try', async () => {
    const ws = await fresh()
    expect(ws.getState().layout).toEqual(singleLayout('core'))
    expect(ws.getState().saved.map((w) => [w.name, w.layout.preset])).toEqual([
      [en.workspace.seedCoding, 'main'],
      [en.workspace.seedReview, 'columns']
    ])
    expect(ws.getState().current).toBeUndefined()
    expect(ws.getState().zen).toBe(false)
  })

  it('restores the layout of this device — what is valid of it', async () => {
    const layout = makeLayout('columns', ['agents', 'browser'])
    const ws = await fresh({
      v: 1,
      layout: { ...layout, maximized: 'p2' },
      saved: [
        { id: 'a', name: '  Coding  ', layout },
        { id: 'a', name: 'Twice', layout },
        { id: 'b', name: '', layout },
        { id: 'c', name: 'Broken', layout: { preset: 'nope' } },
        { id: 7, name: 'No id', layout },
        { id: 'd', name: 42, layout },
        null,
        { id: 'e', name: 'Max', layout: { ...layout, maximized: 'p1' } }
      ],
      current: 'e'
    })
    expect(ws.getState().layout).toMatchObject({ preset: 'columns', maximized: 'p2', focus: 'p2' })
    expect(ws.getState().saved.map((w) => w.name)).toEqual(['Coding', 'Max'])
    expect(ws.getState().saved[1].layout.maximized).toBeUndefined() // a saved layout has nothing maximized
    expect(ws.getState().current).toBe('e')

    localStorage.clear()
    const other = await fresh({ layout: 'garbage', saved: 'nope', current: 'zz' })
    expect(other.getState()).toMatchObject({ layout: singleLayout('core'), saved: [], current: undefined })
    localStorage.clear()
    expect((await fresh('{broken')).getState().saved).toHaveLength(2) // unreadable: a fresh start
  })

  it('arranges panes and remembers every change', async () => {
    const ws = await fresh()
    const s = () => ws.getState()
    s().split()
    expect(saved().layout).toMatchObject({ preset: 'columns' })
    s().show('browser')
    expect(s().layout.panes.map((p) => p.module)).toEqual(['core', 'browser'])
    s().place('p1', 'browser') // swaps
    expect(s().layout.panes.map((p) => p.module)).toEqual(['browser', 'core'])
    s().focus('p2')
    s().moveFocus('left')
    expect(s().layout.focus).toBe('p1')
    s().setPreset('grid')
    expect(s().layout.panes).toHaveLength(4)
    s().resize('x', 0.3)
    expect(s().layout.sizes.x).toBe(0.3)
    s().toggleMaximize('p3')
    expect(s().layout.maximized).toBe('p3')
    s().toggleMaximize()
    s().close('p4')
    expect(s().layout.preset).toBe('main')
    s().setZen(true)
    expect(s().zen).toBe(true)

    // nothing changes: nothing is written
    s().focus('p1')
    const listener = vi.fn()
    const off = ws.subscribe(listener)
    s().moveFocus('left')
    s().focus(s().layout.focus)
    expect(listener).not.toHaveBeenCalled()
    off()

    // storage gone: the layout lasts until reload
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => s().split()).not.toThrow()
  })

  it('opens modules beside a pane — dropped on its edge, or next to the focused one', async () => {
    vi.resetModules()
    const { useWorkspace } = await import('@/features/workspace/store')
    const s = () => useWorkspace.getState()
    s().dropBeside('p1', 'left', 'browser')
    expect(s().layout.panes.map((p) => p.module)).toEqual(['browser', 'core'])
    s().openBeside('terminal')
    expect(s().layout.panes.map((p) => p.module)).toEqual(['browser', 'terminal', 'core'])
    expect(JSON.parse(localStorage.getItem('mindeck.workspace')!).layout.preset).toBe('main')
  })

  it('saves, updates, renames, removes and switches named workspaces', async () => {
    const ws = await fresh()
    const s = () => ws.getState()
    s().save('   ') // no name: nothing saved
    expect(s().saved).toHaveLength(2)
    s().setPreset('rows')
    s().toggleMaximize('p2')
    s().save('  Writing  ')
    expect(s().saved.at(-1)).toMatchObject({ id: 'w3', name: 'Writing' })
    expect(s().saved.at(-1)!.layout).toMatchObject({ preset: 'rows', maximized: undefined })
    expect(s().current).toBe('w3')
    expect(saved().current).toBe('w3')

    s().apply(0) // ⌘⌥1
    expect(s().layout.preset).toBe('main')
    expect(s().current).toBe('w1')
    s().split()
    s().save('coding') // the same name: overwrites "Coding"
    expect(s().saved).toHaveLength(3)
    expect(s().saved[0].layout.preset).toBe('grid')
    s().update('w2')
    expect(s().saved[1].layout.preset).toBe('grid')
    expect(s().current).toBe('w2')

    s().rename('w2', '  Review all  ')
    s().rename('w2', ' ')
    expect(s().saved[1].name).toBe('Review all')
    s().rename('w1', 'x'.repeat(60))
    expect(s().saved[0].name).toHaveLength(40)

    s().remove('w2')
    expect(s().current).toBeUndefined()
    s().apply('w3')
    s().remove('w1')
    expect(s().current).toBe('w3')
    expect(s().saved.map((w) => w.id)).toEqual(['w3'])
    s().save('Next') // ids are reused once free
    expect(s().saved.at(-1)!.id).toBe('w1')

    const before = s().layout
    s().apply(5)
    s().apply('nope')
    expect(s().layout).toBe(before)
  })
})

describe('workspace actions', () => {
  it('puts the keyboard focus back where it was in a pane', async () => {
    const { focusInto, rememberFocus } = await import('@/features/workspace/actions')
    document.body.innerHTML = '<div data-pane-id="p1" tabindex="-1"><input id="a" /><input id="b" /></div><div data-pane-id="p2" tabindex="-1"><input id="c" /></div>'
    const [a, b, c] = ['a', 'b', 'c'].map((id) => document.getElementById(id) as HTMLInputElement)
    focusInto('nope') // no such pane
    focusInto('p1')
    expect(document.activeElement).toBe(document.querySelector('[data-pane-id="p1"]'))
    rememberFocus('p1', b)
    c.focus()
    focusInto('p1')
    expect(document.activeElement).toBe(b)
    a.focus()
    focusInto('p1') // already in there
    expect(document.activeElement).toBe(a)
    rememberFocus('p2', b) // remembered somewhere else: the pane itself
    focusInto('p2')
    expect(document.activeElement).toBe(document.querySelector('[data-pane-id="p2"]'))
    // a dialog that opened in the meantime keeps the focus
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><input id="d" /></div>')
    const d = document.getElementById('d') as HTMLInputElement
    d.focus()
    focusInto('p1')
    expect(document.activeElement).toBe(d)
    document.body.innerHTML = ''
  })

  it('toggles full screen: the app’s, or the page’s in a browser', async () => {
    const { toggleFullScreen } = await import('@/features/workspace/actions')
    const toggle = vi.fn()
    ;(window as unknown as { mindeck: object }).mindeck = { platform: 'darwin', toggleFullScreen: toggle }
    toggleFullScreen()
    expect(toggle).toHaveBeenCalled()
    Reflect.deleteProperty(window, 'mindeck')

    toggleFullScreen() // jsdom has no full screen: nothing happens
    const request = vi.fn(async () => {})
    document.documentElement.requestFullscreen = request
    toggleFullScreen()
    expect(request).toHaveBeenCalled()
    document.documentElement.requestFullscreen = vi.fn(async () => Promise.reject(new Error('denied')))
    toggleFullScreen()
    const exit = vi.fn(async () => Promise.reject(new Error('no')))
    Object.defineProperty(document, 'fullscreenElement', { value: document.body, configurable: true })
    document.exitFullscreen = exit
    toggleFullScreen()
    expect(exit).toHaveBeenCalled()
    await Promise.resolve()
    Reflect.deleteProperty(document, 'fullscreenElement')
    Reflect.deleteProperty(document, 'exitFullscreen')
    Reflect.deleteProperty(document.documentElement, 'requestFullscreen')
  })

  it('does what a shortcut asks', async () => {
    vi.resetModules()
    const { perform } = await import('@/features/workspace/actions')
    const { useWorkspace } = await import('@/features/workspace/store')
    const s = () => useWorkspace.getState()
    perform({ type: 'split' })
    expect(s().layout.panes).toHaveLength(2)
    document.body.innerHTML = '<div data-pane-id="p1" tabindex="-1"></div>'
    vi.useFakeTimers()
    perform({ type: 'focus', dir: 'left' })
    expect(s().layout.focus).toBe('p1')
    vi.advanceTimersByTime(20) // once drawn, the keyboard goes there too
    expect(document.activeElement).toBe(document.querySelector('[data-pane-id="p1"]'))
    vi.useRealTimers()
    perform({ type: 'maximize' })
    expect(s().layout.maximized).toBe('p1')
    perform({ type: 'maximize' })
    perform({ type: 'close' })
    expect(s().layout.panes).toHaveLength(1)
    perform({ type: 'zen' })
    expect(s().zen).toBe(true)
    perform({ type: 'zen' })
    expect(s().zen).toBe(false)
    perform({ type: 'workspace', index: 1 })
    expect(s().current).toBe('w2')
    const toggle = vi.fn()
    ;(window as unknown as { mindeck: object }).mindeck = { platform: 'linux', toggleFullScreen: toggle }
    perform({ type: 'fullscreen' })
    expect(toggle).toHaveBeenCalled()
    document.body.innerHTML = ''
  })

  it('lists the workspace in the command palette — what the layout on screen allows', async () => {
    vi.resetModules()
    const { workspaceCommands } = await import('@/features/workspace/commands')
    const { useWorkspace } = await import('@/features/workspace/store')
    const labels = () => workspaceCommands(en).map((i) => i.label)
    const run = (id: string) => workspaceCommands(en).find((i) => i.id === id)!.run()
    expect(labels()).toEqual([
      'Split pane',
      'Layout: One pane',
      'Layout: Side by side',
      'Layout: Stacked',
      'Layout: One large, two small',
      'Layout: 2 × 2',
      'Switch to Coding',
      'Switch to Review',
      'Zen mode',
      'Full screen'
    ])
    expect(workspaceCommands(en).every((c) => c.group === 'Workspace' && c.icon)).toBe(true)
    run('layout.grid')
    expect(useWorkspace.getState().layout.preset).toBe('grid')
    expect(labels()).not.toContain('Split pane') // four panes: no more
    expect(labels().slice(0, 6)).toEqual(['Close pane', 'Maximize pane', 'Focus the pane on the left', 'Focus the pane on the right', 'Focus the pane above', 'Focus the pane below'])
    run('workspace.focus.right')
    expect(useWorkspace.getState().layout.focus).toBe('p2')
    run('workspace.close')
    expect(useWorkspace.getState().layout.preset).toBe('main')
    run('workspace.maximize')
    expect(useWorkspace.getState().layout.maximized).toBeDefined()
    expect(labels()).toContain('Restore panes')
    run('workspace.w2')
    expect(useWorkspace.getState().current).toBe('w2')
    run('workspace.split')
    expect(useWorkspace.getState().layout.panes).toHaveLength(3)
    run('workspace.zen')
    expect(useWorkspace.getState().zen).toBe(true)
    expect(labels()).toContain('Leave zen mode')
    const toggle = vi.fn()
    ;(window as unknown as { mindeck: object }).mindeck = { platform: 'linux', toggleFullScreen: toggle }
    run('workspace.fullscreen')
    expect(toggle).toHaveBeenCalled()
    expect(workspaceCommands(en).find((i) => i.id === 'workspace.w1')!.keys).toBe('Ctrl+Alt+1')
    expect(workspaceCommands(en).find((i) => i.id === 'workspace.focus.left')!.keys).toBe('Ctrl+Alt+←')
  })
})
