import { afterEach, describe, expect, it, vi } from 'vitest'
import { installBridge, settle } from './bridge'
import { activeTab, useBrowser } from '@/features/browser/store'
import { displayUrl, hostOf, initial, inlineCompletion, security } from '@/features/browser/url'
import { state, tab } from './browserFixtures'

const initialStore = useBrowser.getState()
afterEach(() => useBrowser.setState(initialStore, true))

describe('browser store', () => {
  it('mirrors the core: state, find results, commands and reveal requests', async () => {
    const s = state([tab('a', 'https://a.dev/', { title: 'A' })])
    const bridge = installBridge({ 'browser:state': () => s })
    const handlers = { reveal: vi.fn(), sendToAgent: vi.fn(), settings: vi.fn() }
    const off = useBrowser.getState().connect(handlers)
    await settle()
    expect(useBrowser.getState().state).toEqual(s)

    const next = state([tab('a', 'https://a.dev/'), tab('b', 'https://b.dev/')], { activeId: 'b' })
    bridge.emit('browser:state', next)
    expect(useBrowser.getState().state.activeId).toBe('b')
    bridge.emit('browser:find', { tabId: 'b', active: 1, matches: 4 })
    expect(useBrowser.getState().find).toEqual({ tabId: 'b', active: 1, matches: 4 })
    bridge.emit('browser:command', { command: 'focusOmnibox' })
    expect(useBrowser.getState().focusTick).toBe(1)
    bridge.emit('browser:command', { command: 'find' })
    expect(useBrowser.getState().findOpen).toBe(true)
    bridge.emit('browser:command', { command: 'settings' })
    expect(handlers.settings).toHaveBeenCalled()
    bridge.emit('browser:command', { command: 'sendToAgent' })
    expect(handlers.sendToAgent).toHaveBeenCalledWith(next.tabs[1])
    bridge.emit('browser:reveal', { tabId: 'b' })
    expect(handlers.reveal).toHaveBeenCalled()
    bridge.emit('browser:command', { command: 'focused' }) // nobody asked to hear about page focus
    expect(handlers.sendToAgent).toHaveBeenCalledTimes(1)
    bridge.emit('browser:command', { command: 'workspaceKey', key: { key: '\\', code: 'Backslash', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false } }) // nor about keys

    // no tab: nothing to send
    bridge.emit('browser:state', state([]))
    bridge.emit('browser:command', { command: 'sendToAgent' })
    expect(handlers.sendToAgent).toHaveBeenCalledTimes(1)

    off()
    expect(bridge.listenerCount('browser:state')).toBe(0)
    bridge.emit('browser:reveal', { tabId: 'b' }) // disconnected: nobody listens
    expect(handlers.reveal).toHaveBeenCalledTimes(1)
  })

  it('a second connection replaces the first, whose disconnect then leaves the new handlers alone', async () => {
    const bridge = installBridge({ 'browser:state': () => state([]), 'browser:open': () => tab('x', 'https://x.dev/') })
    const first = { reveal: vi.fn(), sendToAgent: vi.fn(), settings: vi.fn() }
    const second = { reveal: vi.fn(), sendToAgent: vi.fn(), settings: vi.fn(), focused: vi.fn() }
    const offFirst = useBrowser.getState().connect(first)
    const offSecond = useBrowser.getState().connect(second)
    offFirst()
    await useBrowser.getState().show('https://x.dev/')
    expect(second.reveal).toHaveBeenCalled()
    bridge.emit('browser:command', { command: 'focused' }) // a click into the page
    expect(second.focused).toHaveBeenCalledTimes(1)
    const key = { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }
    const withKeys = { ...second, workspaceKey: vi.fn() }
    useBrowser.getState().connect(withKeys)
    bridge.emit('browser:command', { command: 'workspaceKey', key }) // a workspace key pressed in a page
    expect(withKeys.workspaceKey).toHaveBeenCalledWith(key)
    useBrowser.getState().connect(second)
    useBrowser.getState().connect(first)
    offSecond() // the first's listeners stay, without handlers
    offFirst()
    bridge.emit('browser:command', { command: 'focused' })
    expect(second.focused).toHaveBeenCalledTimes(1)
  })

  it('does nothing without the desktop bridge, and shows failures instead of throwing', async () => {
    await useBrowser.getState().refresh() // no bridge: nothing to ask
    expect(useBrowser.getState().state.available).toBe(false)

    installBridge({
      'browser:open': () => {
        throw new Error('no window')
      }
    })
    const reveal = vi.fn()
    useBrowser.getState().connect({ reveal, sendToAgent: vi.fn(), settings: vi.fn() })
    await useBrowser.getState().show('https://x.dev/')
    expect(reveal).not.toHaveBeenCalled()
    expect(useBrowser.getState().error).toBe('no window')
    useBrowser.getState().clearError()
    expect(useBrowser.getState().error).toBeUndefined()
  })

  it('opens, goes, sends to agents and finds through the tab on screen', async () => {
    const calls: [string, unknown][] = []
    const record = (channel: string) => (payload: unknown) => {
      calls.push([channel, payload])
      return channel === 'browser:open' ? tab('n', '') : undefined
    }
    installBridge(Object.fromEntries(['browser:open', 'browser:navigate', 'browser:update', 'browser:findStop'].map((c) => [c, record(c)])))
    const handlers = { reveal: vi.fn(), sendToAgent: vi.fn(), settings: vi.fn() }
    useBrowser.getState().connect(handlers)

    await useBrowser.getState().go('mindeck') // no tab yet: a new one
    expect(calls.at(-1)).toEqual(['browser:open', { url: 'mindeck' }])
    await useBrowser.getState().newTab()
    expect(calls.at(-1)).toEqual(['browser:open', {}])
    expect(useBrowser.getState().focusTick).toBe(1)

    useBrowser.setState({ state: state([tab('ntp', ''), tab('a', 'https://a.dev/')], { activeId: 'ntp' }) })
    await useBrowser.getState().sendToAgent() // the new-tab page has nothing to send
    expect(handlers.sendToAgent).not.toHaveBeenCalled()
    await useBrowser.getState().go('example.com')
    expect(calls.at(-1)).toEqual(['browser:navigate', { id: 'ntp', input: 'example.com' }])

    useBrowser.setState({ state: state([tab('a', 'https://a.dev/')]) })
    await useBrowser.getState().sendToAgent()
    expect(calls.at(-1)).toEqual(['browser:update', { id: 'a', shared: true }])
    expect(handlers.sendToAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))

    useBrowser.getState().setFindOpen(true)
    expect(useBrowser.getState().findOpen).toBe(true)
    useBrowser.setState({ find: { tabId: 'a', active: 1, matches: 1 } })
    useBrowser.getState().setFindOpen(false)
    expect(useBrowser.getState()).toMatchObject({ findOpen: false, find: undefined })
    await settle()
    expect(calls.at(-1)).toEqual(['browser:findStop', { id: 'a' }])
    useBrowser.setState({ state: state([]) })
    useBrowser.getState().setFindOpen(false) // no tab: nothing to stop

    useBrowser.getState().toggleDownloads()
    expect(useBrowser.getState().downloadsOpen).toBe(true)
    useBrowser.getState().toggleDownloads()
    expect(useBrowser.getState().downloadsOpen).toBe(false)
  })

  it('finds the tab on screen, or the first one', () => {
    expect(activeTab(state([tab('a', 'x'), tab('b', 'y')], { activeId: 'b' }))!.id).toBe('b')
    expect(activeTab(state([tab('a', 'x')], { activeId: 'gone' }))!.id).toBe('a')
    expect(activeTab(state([]))).toBeUndefined()
  })
})

describe('browser addresses (UI)', () => {
  it('shows addresses the way people read them', () => {
    expect(displayUrl('')).toBe('')
    expect(displayUrl('https://github.com/')).toBe('github.com')
    expect(displayUrl('http://localhost:5173/app?x=1#top')).toBe('localhost:5173/app?x=1#top')
    expect(displayUrl('file:///Users/me/My%20Page.html')).toBe('/Users/me/My Page.html')
    expect(displayUrl('mailto:a@b.c')).toBe('mailto:a@b.c')
    expect(displayUrl('not a url')).toBe('not a url')
  })

  it('says how a page is reached', () => {
    expect(security('https://a.dev/')).toBe('secure')
    expect(security('http://a.dev/')).toBe('insecure')
    expect(security('http://localhost:3000/')).toBe('local')
    expect(security('https://127.0.0.1/')).toBe('local')
    expect(security('http://shop.localhost/')).toBe('local')
    expect(security('http://[::1]:8080/')).toBe('local')
    expect(security('file:///a.html')).toBe('file')
    expect(security('about:blank')).toBe('none')
    expect(security('')).toBe('none')
    expect(hostOf('https://a.dev:8443/x')).toBe('a.dev:8443')
    expect(hostOf('nope')).toBe('')
  })

  it('gives sites without a favicon a letter', () => {
    expect(initial('https://www.github.com/')).toBe('G')
    expect(initial('', 'docs')).toBe('D')
    expect(initial('')).toBe('?')
  })

  it('completes what was typed like Chrome: the host first, then the whole address', () => {
    const list = [
      { kind: 'search' as const, url: 'https://www.google.com/search?q=gi', title: 'gi' },
      { kind: 'history' as const, url: 'https://www.github.com/acme/shop/', title: 'Shop' },
      { kind: 'tab' as const, url: 'https://docs.dev/guide', title: 'Docs', tabId: 't' }
    ]
    expect(inlineCompletion('', list)).toBeNull()
    expect(inlineCompletion('gi hub', list)).toBeNull()
    expect(inlineCompletion('Gi', list)).toEqual({ value: 'Github.com', url: 'https://www.github.com/' })
    expect(inlineCompletion('github.com/ac', list)).toEqual({ value: 'github.com/acme/shop', url: 'https://www.github.com/acme/shop/' })
    expect(inlineCompletion('docs', list)).toEqual({ value: 'docs.dev', url: 'https://docs.dev/' })
    expect(inlineCompletion('zzz', list)).toBeNull()
  })
})
