import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge, settle } from './bridge'
import { state, tab } from './browserFixtures'
import { useBrowser } from '@/features/browser/store'
import { useOverlays } from '@/lib/overlay'
import { relayout } from '@/lib/relayout'
import { PaneContext } from '@/features/workspace/pane'
import { useAssistant } from '@/features/agents/store'
import { useProjects } from '@/features/projects/store'
import { useAppearance } from '@/lib/theme'
import { BrowserView } from '@/features/browser/components/BrowserView'
import { Omnibox } from '@/features/browser/components/Omnibox'
import { TabStrip } from '@/features/browser/components/TabStrip'
import { Viewport } from '@/features/browser/components/Viewport'
import { NewTabPage } from '@/features/browser/components/NewTabPage'
import { AgentBar, ApprovalDock, FindBar, PermissionBar } from '@/features/browser/components/Bars'
import { DownloadsPanel } from '@/features/browser/components/DownloadsPanel'
import type { BrowserDownload, BrowserState } from '@shared/types/browser'

const initialBrowser = useBrowser.getState()
const initialProjects = useProjects.getState()
const initialAssistant = useAssistant.getState()

/** The desktop bridge, answering browser channels and recording every call. */
function bridge(routes: Record<string, (p: never) => unknown> = {}) {
  const calls: [string, unknown][] = []
  const b = installBridge(routes)
  const invoke = b.invoke.getMockImplementation()!
  b.invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    calls.push([channel, payload])
    return invoke(channel, payload)
  })
  const sent = (channel: string) => calls.filter(([c]) => c === channel).map(([, p]) => p)
  return { b, calls, sent }
}

const show = (s: BrowserState) => act(() => useBrowser.setState({ state: s }))

beforeEach(() => {
  useBrowser.setState(initialBrowser, true)
  useProjects.setState(initialProjects, true)
  useAssistant.setState(initialAssistant, true)
  useOverlays.setState({ count: 0 })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('BrowserView', () => {
  it('says where the browser lives when this is not the desktop app, or the core has no window', () => {
    render(<BrowserView active />)
    expect(screen.getByText('The browser lives in the desktop app')).toBeInTheDocument()
    bridge()
    useBrowser.setState({ state: state([], { available: false }) })
    render(<BrowserView active />)
    expect(screen.getAllByText('The browser lives in the desktop app')).toHaveLength(2)
  })

  it('drives the tab on screen from the toolbar and follows the UI’s look and language', async () => {
    const { sent } = bridge()
    useAppearance.setState({ appearance: { ...useAppearance.getState().appearance, mode: 'dark' } })
    useBrowser.setState({ state: state([tab('a', 'https://a.dev/', { title: 'A', canGoBack: true, zoom: 1.25, shared: true })]) })
    render(<BrowserView active />)
    await settle()
    expect(sent('browser:ui')).toEqual([{ theme: 'dark', locale: 'en' }])

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    fireEvent.click(screen.getByTitle('Zoom 125 % — click for 100 %'))
    fireEvent.click(screen.getByRole('button', { name: /Agents can see this tab/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Browser menu' }))
    await settle()
    expect(sent('browser:go')).toEqual([{ id: 'a', action: 'back' }, { id: 'a', action: 'reload' }])
    expect(sent('browser:zoom')).toEqual([{ id: 'a', zoom: 'reset' }])
    expect(sent('browser:update')).toEqual([{ id: 'a', shared: false }])
    expect(sent('browser:tool')).toEqual([{ id: 'a', tool: 'pageMenu' }])

    // loading: stop instead of reload, the loading line runs
    show(state([tab('a', 'https://a.dev/', { loading: true })]))
    fireEvent.click(screen.getByRole('button', { name: 'Stop loading' }))
    expect(document.querySelector('.animate-loadbar')).not.toBeNull()
    // a private tab: the eye is closed; send to an agent shares it
    show(state([tab('a', 'https://a.dev/')]))
    expect(screen.getByRole('button', { name: /Private: agents cannot see this tab/ })).toHaveAttribute('aria-pressed', 'false')
    const sendToAgent = vi.fn(async () => {})
    useBrowser.setState({ sendToAgent })
    fireEvent.click(screen.getByRole('button', { name: 'Send to an agent' }))
    expect(sendToAgent).toHaveBeenCalled()
    await settle()
    expect(sent('browser:go').at(-1)).toEqual({ id: 'a', action: 'stop' })
  })

  it('shows bars for find, page requests, approvals and agents, and the downloads panel', async () => {
    bridge()
    useAssistant.setState({
      pending: [{ id: 'p1', conversationId: 'c1', agentName: 'Claude Code', toolTitle: 'Mindeck browser · click', risk: 'write', summary: 'Click e3', reason: '', allowAlways: true } as never]
    })
    useBrowser.setState({
      findOpen: true,
      downloadsOpen: true,
      error: 'Tab not found',
      state: state([tab('a', 'https://a.dev/', { openedBy: 'Codex' })], {
        permissions: [{ id: 'r1', tabId: 'a', origin: 'https://a.dev', kind: 'camera' }],
        downloads: [{ id: 'd1', filename: 'a.zip', path: '/d/a.zip', url: 'https://a.dev/a.zip', state: 'progressing', received: 1, total: 2, startedAt: 'x' }]
      })
    })
    render(<BrowserView active />)
    expect(screen.getByRole('textbox', { name: 'Find in page' })).toBeInTheDocument()
    expect(screen.getByText(/wants to use your camera/)).toBeInTheDocument()
    expect(screen.getByText('Click e3')).toBeInTheDocument()
    expect(screen.getByText('Opened by Codex')).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Downloads' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Downloads' }).querySelector('.rounded-full')).not.toBeNull() // a download runs
    fireEvent.click(screen.getByRole('button', { name: 'Downloads' }))
    expect(useBrowser.getState().downloadsOpen).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(useBrowser.getState().error).toBeUndefined()

    // the browser off screen: approvals are the floating toasts' again
    act(() => useBrowser.setState({ findOpen: false }))
    render(<BrowserView active={false} />)
    expect(screen.getAllByText('Click e3')).toHaveLength(1)
  })
})

describe('browser edges', () => {
  it('works without any tab, with blank input and untitled suggestions', async () => {
    const { sent } = bridge({ 'browser:suggest': () => [{ kind: 'history', url: 'https://untitled.dev/', title: '' }] })
    useBrowser.setState({ state: state([]) })
    render(<BrowserView active />)
    const input = screen.getByRole('textbox', { name: 'Address or search' }) as HTMLInputElement
    fireEvent.focus(input)
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: '   ' } })
    await settle()
    expect(sent('browser:suggest')).toEqual([])
    fireEvent.change(input, { target: { value: 'unt' } })
    await settle()
    expect(screen.getAllByText('untitled.dev')).toHaveLength(2) // its address stands in for the title
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('')
    show(state([tab('a', 'https://a.dev/', { canGoForward: true })]))
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
    await settle()
    expect(sent('browser:go')).toEqual([{ id: 'a', action: 'forward' }])
  })
})

describe('TabStrip', () => {
  it('keeps the shown tab in sight: a new tab at the end scrolls the strip to it', () => {
    bridge()
    const scrolled = vi.mocked(Element.prototype.scrollIntoView)
    scrolled.mockClear()
    useBrowser.setState({ state: state([tab('a', 'https://a.dev/', { title: 'A' })], { activeId: 'a' }) })
    render(<TabStrip />)
    expect(scrolled.mock.contexts.at(-1)).toHaveTextContent('A')
    show(state([tab('a', 'https://a.dev/', { title: 'A' }), tab('n', '')], { activeId: 'n' }))
    expect(scrolled.mock.contexts.at(-1)).toHaveTextContent('New tab')
    expect(scrolled).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest' })
  })

  it('shows tabs with icons, sound and the agent’s mark — and switches, closes, mutes and reorders them', async () => {
    const { sent } = bridge()
    useBrowser.setState({
      state: state(
        [
          tab('p', 'https://pinned.dev/', { pinned: true, favicon: 'data:image/png;base64,x', title: 'Pinned' }),
          tab('a', 'https://a.dev/', { title: 'A', audible: true }),
          tab('b', 'http://localhost:3000/', { loading: true, muted: true }),
          tab('n', ''),
          tab('g', 'https://agent.dev/', { openedBy: 'Claude Code', title: 'Agent page' })
        ],
        { activeId: 'a' }
      )
    })
    render(<TabStrip />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false', 'false', 'false'])
    expect(tabs[2]).toHaveTextContent('http://localhost:3000/') // no title yet: its address
    expect(tabs[3]).toHaveTextContent('New tab')
    expect(tabs[4]).toHaveAttribute('title', 'Agent page — Opened by Claude Code')
    expect(screen.getByLabelText('Opened by Claude Code')).toBeInTheDocument()
    expect(tabs[0].querySelector('img')).not.toBeNull()

    fireEvent.click(tabs[1]) // already shown: nothing
    fireEvent.click(tabs[4])
    fireEvent.click(screen.getByRole('button', { name: 'Mute tab' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unmute tab' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close A' }))
    fireEvent(tabs[2], new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    fireEvent(tabs[2], new MouseEvent('auxclick', { bubbles: true, button: 2 })) // only the middle button closes
    fireEvent.contextMenu(tabs[4])
    await settle()
    expect(sent('browser:activate')).toEqual([{ id: 'g' }])
    expect(sent('browser:update')).toEqual([{ id: 'a', muted: true }, { id: 'b', muted: false }])
    expect(sent('browser:close')).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(sent('browser:tool')).toEqual([{ id: 'g', tool: 'tabMenu' }])

    // drag a tab onto another to put it there
    const store: Record<string, string> = {}
    const dataTransfer = { setData: (k: string, v: string) => (store[k] = v), getData: (k: string) => store[k] ?? '', types: ['application/x-mindeck-tab'] }
    fireEvent.dragStart(tabs[4], { dataTransfer })
    fireEvent.dragOver(tabs[1], { dataTransfer })
    expect(tabs[1].className).toContain('border-cyan/60')
    fireEvent.dragLeave(tabs[2], { dataTransfer }) // leaving another tab changes nothing
    fireEvent.dragLeave(tabs[1], { dataTransfer })
    fireEvent.dragOver(tabs[1], { dataTransfer })
    fireEvent.drop(tabs[1], { dataTransfer })
    fireEvent.dragOver(tabs[1], { dataTransfer: { types: ['Files'] } }) // not a tab: ignored
    fireEvent.drop(tabs[4], { dataTransfer }) // onto itself: nothing
    await settle()
    expect(sent('browser:move')).toEqual([{ id: 'g', index: 1, groupId: null }])

    // new tabs: the + button, or a double-click on the empty strip
    const newTab = vi.fn(async () => {})
    useBrowser.setState({ newTab })
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    fireEvent.doubleClick(screen.getByRole('tablist').parentElement!)
    fireEvent.doubleClick(screen.getByRole('tablist')) // on the tabs themselves: no
    expect(newTab).toHaveBeenCalledTimes(2)
  })
})

describe('Omnibox', () => {
  const suggestions = [
    { kind: 'search', url: 'https://www.google.com/search?q=gi', title: 'gi' },
    { kind: 'history', url: 'https://github.com/acme', title: 'Acme' },
    { kind: 'tab', url: 'https://gitlab.com/', title: 'GitLab', tabId: 't2' }
  ]

  it('shows where the tab is, and the full address while editing', () => {
    bridge()
    const { rerender } = render(<Omnibox tab={tab('a', 'https://a.dev/docs')} />)
    const input = screen.getByRole('textbox', { name: 'Address or search' }) as HTMLInputElement
    expect(input.value).toBe('a.dev/docs')
    expect(screen.getByTitle('Secure connection')).toBeInTheDocument()
    rerender(<Omnibox tab={tab('a', 'http://plain.dev/')} />)
    expect(screen.getByTitle('Not secure')).toBeInTheDocument()
    rerender(<Omnibox tab={tab('a', 'file:///x.html')} />)
    expect(screen.getByTitle('File on this computer')).toBeInTheDocument()
    rerender(<Omnibox tab={tab('a', 'http://localhost:1/')} />)
    expect(screen.getByTitle('Local page on this computer')).toBeInTheDocument()
    rerender(<Omnibox />)
    expect(input.value).toBe('')
    rerender(<Omnibox tab={tab('a', 'https://a.dev/docs')} />)
    fireEvent.focus(input)
    expect(input.value).toBe('https://a.dev/docs')
    fireEvent.keyDown(input, { key: 'Escape' }) // nothing open: back to the page
    fireEvent.blur(input)
    expect(input.value).toBe('a.dev/docs')
  })

  it('suggests while typing, completes inline, and goes where Enter says', async () => {
    const { sent } = bridge({ 'browser:suggest': () => suggestions })
    const go = vi.fn(async () => {})
    useBrowser.setState({ go, state: state([tab('n', '')]) })
    render(<Omnibox tab={tab('n', '')} />)
    const input = screen.getByRole('textbox', { name: 'Address or search' }) as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'g' } })
    fireEvent.change(input, { target: { value: 'gi' } })
    await settle()
    expect(sent('browser:suggest').at(-1)).toEqual({ text: 'gi' })
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(useOverlays.getState().count).toBe(1) // the list covers the page
    expect(input.value).toBe('github.com') // completed to the site, like Chrome …
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 10]) // … with the completion selected
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(go).toHaveBeenLastCalledWith('https://github.com/')
    expect(useOverlays.getState().count).toBe(0)

    // arrows pick a suggestion; Enter goes there
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'gi' } })
    await settle()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // stays on the last
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(go).toHaveBeenLastCalledWith('https://github.com/acme')

    // a suggested open tab is switched to; Tab accepts the completion; Escape closes the list first
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'gi' } })
    await settle()
    fireEvent.mouseEnter(screen.getAllByRole('option')[2])
    fireEvent.mouseDown(screen.getAllByRole('option')[2])
    fireEvent.click(screen.getAllByRole('option')[2])
    expect(sent('browser:activate')).toEqual([{ id: 't2' }])
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'g' } })
    fireEvent.change(input, { target: { value: 'gi' } })
    await settle()
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input.value).toBe('github.com')
    fireEvent.keyDown(input, { key: 'Tab' }) // nothing more to complete: the browser's Tab
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // no list: nothing to move in
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(go).toHaveBeenLastCalledWith('github.com')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Enter' }) // nothing typed: nowhere to go
    expect(go).toHaveBeenCalledTimes(3)
    fireEvent.keyDown(input, { key: 'Other' })
  })

  it('takes the keyboard on ⌘L and a new tab; late or failed suggestions do not land', async () => {
    let answer: (v: unknown) => void = () => {}
    bridge({ 'browser:suggest': () => new Promise((r) => (answer = r)) })
    render(<Omnibox tab={tab('a', 'https://a.dev/')} />)
    const input = screen.getByRole('textbox', { name: 'Address or search' }) as HTMLInputElement
    act(() => useBrowser.setState({ focusTick: 1 }))
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.blur(input) // gone before the answer came
    answer(suggestions)
    await settle()
    expect(screen.queryByRole('listbox')).toBeNull()
    installBridge({
      'browser:suggest': () => {
        throw new Error('core busy')
      }
    })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'y' } })
    await settle()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('selects the whole address the moment it gets the focus — and after the click that focused it, like Chrome', () => {
    bridge({ 'browser:suggest': () => [] })
    render(<Omnibox tab={tab('a', 'https://a.dev/docs')} />)
    const input = screen.getByRole('textbox', { name: 'Address or search' }) as HTMLInputElement
    const selection = () => [input.selectionStart, input.selectionEnd]
    act(() => input.focus()) // keyboard or ⌘L: typing at once replaces it
    expect(input.value).toBe('https://a.dev/docs')
    expect(selection()).toEqual([0, 18])
    act(() => input.blur())

    // a click drops a caret; releasing the button selects everything
    fireEvent.mouseDown(input)
    act(() => input.focus())
    input.setSelectionRange(4, 4)
    expect(fireEvent.mouseUp(input)).toBe(false) // the caret's default is prevented
    expect(selection()).toEqual([0, 18])
    // the next click in the focused bar places the caret as usual
    fireEvent.mouseDown(input)
    input.setSelectionRange(4, 4)
    expect(fireEvent.mouseUp(input)).toBe(true)
    expect(selection()).toEqual([4, 4])
    act(() => input.blur())
    // dragging over part of the address on the focusing click keeps that part
    fireEvent.mouseDown(input)
    act(() => input.focus())
    input.setSelectionRange(8, 13)
    fireEvent.mouseUp(input)
    expect(selection()).toEqual([8, 13])
  })

  it('follows the tab while focused and untouched (⌘T focuses before the new tab arrives) — never over typed text', () => {
    bridge({ 'browser:suggest': () => [] })
    const { rerender } = render(<Omnibox tab={tab('a', 'https://a.dev/docs')} />)
    const input = screen.getByRole('textbox', { name: 'Address or search' }) as HTMLInputElement
    act(() => input.focus())
    rerender(<Omnibox tab={tab('n', '')} />) // the new tab came
    expect(input.value).toBe('')
    rerender(<Omnibox tab={tab('n', 'https://b.dev/')} />) // a redirect: still untouched, so it follows — selected
    expect(input.value).toBe('https://b.dev/')
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 14])
    fireEvent.change(input, { target: { value: 'news' } })
    rerender(<Omnibox tab={tab('c', 'https://c.dev/')} />)
    expect(input.value).toBe('news')
  })
})

describe('Viewport', () => {
  const rect = (r: Partial<DOMRect>) => vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, toJSON: () => ({}), ...r } as DOMRect)

  it('reports where the page goes — only real changes — and takes it off screen when hidden', async () => {
    const { sent } = bridge()
    useBrowser.setState({ state: state([tab('a', 'https://a.dev/')]) })
    rect({ left: 10.4, top: 20.6, width: 300, height: 200 })
    const { rerender, unmount } = render(<Viewport active />)
    await settle()
    expect(sent('browser:view')).toEqual([{ bounds: { x: 10, y: 21, width: 300, height: 200 }, focused: true }])
    act(() => (globalThis as unknown as { FakeResizeObserver: { instances: { trigger(): void }[] } }).FakeResizeObserver.instances[0].trigger())
    window.dispatchEvent(new Event('resize'))
    rerender(<Viewport active />)
    await settle()
    expect(sent('browser:view')).toHaveLength(1) // same place: not sent again
    rect({ left: 10, top: 60, width: 300, height: 160 })
    rerender(<Viewport active />)
    rerender(<Viewport active={false} />)
    await settle()
    expect(sent('browser:view').slice(1)).toEqual([
      { bounds: { x: 10, y: 60, width: 300, height: 160 }, focused: true },
      { bounds: null, focused: true }
    ])
    rerender(<Viewport active={false} />) // still hidden: nothing new
    unmount()
    await settle()
    expect(sent('browser:view')).toHaveLength(3)
  })

  it('follows its pane: a move without a resize, and whether the pane has the focus', async () => {
    const { sent } = bridge()
    useBrowser.setState({ state: state([tab('a', 'https://a.dev/')]) })
    rect({ left: 0, top: 0, width: 300, height: 200 })
    const pane = (focused: boolean) => (
      <PaneContext.Provider value={{ focused }}>
        <Viewport active />
      </PaneContext.Provider>
    )
    const { rerender, unmount } = render(pane(false))
    await settle()
    expect(sent('browser:view')).toEqual([{ bounds: { x: 0, y: 0, width: 300, height: 200 }, focused: false }])
    rect({ left: 400, top: 0, width: 300, height: 200 })
    act(() => relayout()) // the panes swapped places
    await settle()
    expect(sent('browser:view').at(-1)).toEqual({ bounds: { x: 400, y: 0, width: 300, height: 200 }, focused: false })
    rerender(pane(true)) // the user moved into the browser's pane: its keys win now
    await settle()
    expect(sent('browser:view').at(-1)).toEqual({ bounds: { x: 400, y: 0, width: 300, height: 200 }, focused: true })
    expect(document.querySelector('[data-native-view]')).toBeTruthy()
    unmount()
    await settle()
    expect(sent('browser:view').at(-1)).toEqual({ bounds: null, focused: true })
    const count = sent('browser:view').length
    relayout() // gone: nobody listens
    await settle()
    expect(sent('browser:view')).toHaveLength(count)
  })

  it('stands in a picture of the page while a menu or dialog covers it', async () => {
    const { sent } = bridge({ 'browser:freeze': () => ({ a: 'data:image/jpeg;base64,shot' }) })
    useBrowser.setState({ state: state([tab('a', 'https://a.dev/')]) })
    render(<Viewport active />)
    act(() => useOverlays.setState({ count: 1 }))
    await settle()
    expect(screen.getByRole('presentation', { hidden: true }) ?? document.querySelector('img')).toBeTruthy()
    expect(document.querySelector('img')!.getAttribute('src')).toBe('data:image/jpeg;base64,shot')
    act(() => useOverlays.setState({ count: 0 }))
    await settle()
    expect(document.querySelector('img')).toBeNull()
    expect(sent('browser:unfreeze')).toHaveLength(1)
    // a picture that arrives after the menu closed is dropped
    let deliver: (v: unknown) => void = () => {}
    installBridge({ 'browser:freeze': () => new Promise((r) => (deliver = r)) })
    act(() => useOverlays.setState({ count: 1 }))
    act(() => useOverlays.setState({ count: 0 }))
    deliver({ a: 'data:late' })
    await settle()
    expect(document.querySelector('img')).toBeNull()
    // failures of the core are no reason to break the UI
    installBridge({
      'browser:freeze': () => {
        throw new Error('x')
      },
      'browser:view': () => {
        throw new Error('x')
      },
      'browser:unfreeze': () => {
        throw new Error('x')
      }
    })
    act(() => useOverlays.setState({ count: 1 }))
    act(() => useOverlays.setState({ count: 0 }))
    await settle()
  })

  it('shows the new-tab page, error pages and crash pages instead of the view', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { sent } = bridge()
    useBrowser.setState({ state: state([tab('n', '')]) })
    const { rerender } = render(<Viewport active />)
    expect(screen.getByText('Frequently visited')).toBeInTheDocument()

    // a local dev server that is not up yet: wait and retry
    show(state([tab('a', 'http://localhost:5173/', { error: { code: -102, description: 'ERR_CONNECTION_REFUSED', url: 'http://localhost:5173/' } })]))
    rerender(<Viewport active />)
    expect(screen.getByText(/Nothing answers on localhost:5173 yet/)).toBeInTheDocument()
    await act(async () => {
      vi.advanceTimersByTime(4100)
    })
    expect(sent('browser:go').filter((g) => (g as { action: string }).action === 'reload').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('Open in the system browser')).toBeNull()

    // elsewhere: say why, offer the system browser
    show(state([tab('a', 'https://gone.dev/', { loading: true, error: { code: -105, description: 'ERR_NAME_NOT_RESOLVED', url: 'https://gone.dev/' } })]))
    expect(screen.getByText('ERR_NAME_NOT_RESOLVED')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open in the system browser' }))
    await settle()
    expect(sent('browser:tool')).toEqual([{ id: 'a', tool: 'handoff' }])

    show(state([tab('a', 'https://a.dev/', { crashed: true })]))
    expect(screen.getByText('This page crashed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await settle()
    expect(sent('browser:go').at(-1)).toEqual({ id: 'a', action: 'reload' })
    show(state([]))
  })
})

describe('NewTabPage', () => {
  it('shows running dev servers, the sites visited most and the project repositories', async () => {
    const { sent } = bridge({
      'browser:history': () => [{ url: 'https://github.com/acme', title: 'Acme', visits: 3, lastVisit: 'x' }, { url: 'https://news.dev/', title: '', visits: 1, lastVisit: 'x' }],
      'projects:list': () => [{ id: 'p1', name: 'shop', path: '/p/shop', addedAt: '', lastSeenAt: '', git: { isRepo: true, webUrl: 'https://github.com/acme/shop' } }]
    })
    const go = vi.fn(async (_input: string) => {})
    useBrowser.setState({
      go,
      state: state([tab('n', '')], {
        devServers: [
          { url: 'http://localhost:5173/', label: 'localhost:5173', terminalId: 't', projectId: 'p1', detectedAt: 'x' },
          { url: 'http://localhost:8000/', label: 'localhost:8000', terminalId: 't2', detectedAt: 'x' }
        ]
      })
    })
    render(<NewTabPage />)
    await settle()
    expect(sent('browser:history')).toEqual([{ limit: 8 }])
    fireEvent.click(screen.getByRole('button', { name: 'Open localhost:5173' }))
    expect(screen.getByRole('button', { name: 'Open localhost:5173' })).toHaveTextContent('shop')
    fireEvent.click(screen.getByText('Acme'))
    fireEvent.click(screen.getAllByText('news.dev')[0]) // no title: its address twice
    fireEvent.click(screen.getByRole('button', { name: 'shop' }))
    expect(go.mock.calls.map(([u]) => u)).toEqual(['http://localhost:5173/', 'https://github.com/acme', 'https://news.dev/', 'https://github.com/acme/shop'])
    fireEvent.click(screen.getByText('Search the web or type an address'))
    expect(useBrowser.getState().focusTick).toBe(1)
    expect(screen.getByText('Reopen closed tab')).toBeInTheDocument()
  })

  it('starts empty without history, and keeps loaded projects', async () => {
    const { sent } = bridge({
      'browser:history': () => {
        throw new Error('x')
      }
    })
    useProjects.setState({ projects: [{ id: 'p', name: 'p', path: '/p', addedAt: '', lastSeenAt: '' }] })
    render(<NewTabPage />)
    await settle()
    expect(screen.getByText('Sites you visit often show up here.')).toBeInTheDocument()
    expect(sent('projects:list')).toEqual([])
    expect(screen.queryByText('Running dev servers')).toBeNull()
    expect(screen.queryByText('Your repositories')).toBeNull()
  })
})

describe('browser bars', () => {
  it('FindBar searches as you type, steps through matches and closes', async () => {
    const { sent } = bridge()
    const t = tab('a', 'https://a.dev/')
    useBrowser.setState({ state: state([t]), findOpen: true })
    const { rerender } = render(<FindBar tab={t} />)
    const input = screen.getByRole('textbox', { name: 'Find in page' })
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'needle' } })
    act(() => useBrowser.setState({ find: { tabId: 'a', active: 2, matches: 5 } }))
    rerender(<FindBar tab={t} />)
    expect(screen.getByText('2 of 5')).toBeInTheDocument()
    act(() => useBrowser.setState({ find: { tabId: 'a', active: 0, matches: 0 } }))
    expect(screen.getByText('No matches')).toBeInTheDocument()
    act(() => useBrowser.setState({ find: { tabId: 'other', active: 1, matches: 1 } }))
    expect(screen.queryByText('No matches')).toBeNull()
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }))
    fireEvent.keyDown(input, { key: 'x' })
    await settle()
    expect(sent('browser:find')).toEqual([
      { id: 'a', text: 'needle' },
      { id: 'a', text: 'needle', forward: true, next: true },
      { id: 'a', text: 'needle', forward: false, next: true },
      { id: 'a', text: 'needle', forward: false, next: true },
      { id: 'a', text: 'needle', forward: true, next: true }
    ])
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(useBrowser.getState().findOpen).toBe(false)
    act(() => useBrowser.setState({ findOpen: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(useBrowser.getState().findOpen).toBe(false)
  })

  it('PermissionBar asks for the tab on screen (or any window), remembering the answer unless told not to', async () => {
    const { sent } = bridge()
    useBrowser.setState({
      state: state([], {
        permissions: [
          { id: 'other', tabId: 'b', origin: 'https://b.dev', kind: 'geolocation' },
          { id: 'ext', origin: 'https://meet.dev', kind: 'external', target: 'zoommtg://join', app: 'zoom.us' }
        ]
      })
    })
    const { rerender } = render(<PermissionBar tabId="a" />)
    expect(screen.getByRole('alert')).toHaveTextContent('meet.dev wants to open zoom.us')
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember for this site' }))
    fireEvent.click(screen.getByRole('button', { name: 'Block' }))
    await settle()
    expect(sent('browser:permission')).toEqual([
      { id: 'ext', allow: true, remember: true },
      { id: 'ext', allow: false, remember: false }
    ])
    act(() => useBrowser.setState({ state: state([], { permissions: [{ id: 'k', tabId: 'a', origin: 'odd', kind: 'external' }] }) }))
    rerender(<PermissionBar tabId="a" />)
    expect(screen.getByRole('alert')).toHaveTextContent('odd wants to open')
    act(() => useBrowser.setState({ state: state([], { permissions: [{ id: 'c', tabId: 'a', origin: 'https://cam.dev', kind: 'camera' }] }) }))
    expect(screen.getByRole('alert')).toHaveTextContent('cam.dev wants to use your camera')
    act(() => useBrowser.setState({ state: state([], { permissions: [] }) }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('AgentBar says what an agent did here and makes the tab private again', async () => {
    const { sent } = bridge()
    const { rerender } = render(<AgentBar tab={tab('a', 'https://a.dev/')} />)
    expect(document.body.textContent).toBe('')
    rerender(<AgentBar tab={tab('a', 'http://localhost:1/', { shared: true, agent: { name: 'Claude Code', action: 'click', detail: 'button "Save"', at: new Date().toISOString() } })} />)
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(document.body).toHaveTextContent('Claude Code clicked button "Save" · just now')
    fireEvent.click(screen.getByRole('button', { name: 'Make private' }))
    await settle()
    expect(sent('browser:update')).toEqual([{ id: 'a', shared: false }])
    rerender(<AgentBar tab={tab('a', 'https://agent.dev/', { openedBy: 'Codex', agent: { name: 'Codex', action: 'read', at: new Date().toISOString() } })} />)
    expect(document.body).toHaveTextContent('Codex read the page · just now')
    expect(screen.queryByRole('button', { name: 'Make private' })).toBeNull()
    rerender(<AgentBar tab={tab('a', 'https://agent.dev/', { openedBy: 'Codex' })} />)
    expect(document.body).toHaveTextContent('Opened by Codex')
  })

  it('ApprovalDock answers agents right above the page', async () => {
    const respond = vi.fn(async () => {})
    useAssistant.setState({ respond, pending: [] })
    const { container, rerender } = render(<ApprovalDock />)
    expect(container).toBeEmptyDOMElement()
    const req = (id: string) => ({ id, conversationId: 'c', agentName: 'Claude Code', toolTitle: 'Mindeck browser · click', risk: 'write', summary: `Click ${id}`, reason: '', allowAlways: true }) as never
    act(() => useAssistant.setState({ pending: [req('e1'), req('e2'), req('e3')] }))
    rerender(<ApprovalDock />)
    expect(screen.getByText('3 approvals waiting')).toBeInTheDocument()
    expect(screen.queryByText('Click e3')).toBeNull() // two at a time
    fireEvent.click(screen.getAllByRole('button', { name: /^Allow once$/i })[0])
    expect(respond).toHaveBeenCalledWith('e1', 'once')
    act(() => useAssistant.setState({ pending: [req('e1')] }))
    expect(screen.queryByText(/approvals waiting/)).toBeNull()
  })
})

describe('DownloadsPanel', () => {
  const d = (id: string, extra: Partial<BrowserDownload>): BrowserDownload => ({
    id,
    filename: `${id}.zip`,
    path: `/Downloads/${id}.zip`,
    url: 'https://a.dev/',
    state: 'progressing',
    received: 0,
    total: 0,
    startedAt: 'x',
    ...extra
  })

  it('lists downloads with progress, and opens, reveals, cancels and removes them', async () => {
    const { sent } = bridge()
    useBrowser.setState({ downloadsOpen: true, state: state([]) })
    const { rerender } = render(<DownloadsPanel />)
    expect(screen.getByText('No downloads yet')).toBeInTheDocument()
    act(() =>
      useBrowser.setState({
        state: state([], {
          downloads: [
            d('run', { received: 2_500_000, total: 10_000_000 }),
            d('open', { received: 0 }),
            d('done', { state: 'completed', received: 1200, total: 1200 }),
            d('fail', { state: 'interrupted' }),
            d('stop', { state: 'cancelled', total: 500 })
          ]
        })
      })
    )
    rerender(<DownloadsPanel />)
    expect(screen.getByText('Downloading · 2.5 MB / 10 MB')).toBeInTheDocument()
    expect(screen.getByText('Downloading · 0 B')).toBeInTheDocument()
    expect(screen.getByText('Done · 1.2 KB')).toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByText('Cancelled · 500 B')).toBeInTheDocument()
    expect((document.querySelector('[style]') as HTMLElement).style.width).toBe('25%')
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0])
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove from the list' })[0])
    await settle()
    expect(sent('browser:download')).toEqual([
      { id: 'done', action: 'open' },
      { id: 'done', action: 'reveal' },
      { id: 'run', action: 'cancel' },
      { id: 'done', action: 'remove' }
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(useBrowser.getState().downloadsOpen).toBe(false)
  })
})
