import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, installBridge, settle } from './bridge'
import { state, tab } from './browserFixtures'
import { useBrowser } from '@/features/browser/store'
import { useOverlays } from '@/lib/overlay'
import { BrowserView } from '@/features/browser/components/BrowserView'
import { Omnibox } from '@/features/browser/components/Omnibox'
import { TabStrip } from '@/features/browser/components/TabStrip'
import { Viewport } from '@/features/browser/components/Viewport'
import { ExtensionButtons, ExtensionsPanel } from '@/features/browser/components/Extensions'
import { AuthDialog, DangerPage, DrmBar, PrivateTabPage, ShieldButton } from '@/features/browser/components/Protection'
import { BrowserCard } from '@/features/settings/components/BrowserCard'
import type { BrowserExtension, ChromiumProfile } from '@shared/types/browserExtensions'
import { DEFAULT_BROWSER_SETTINGS, type BrowserSettings, type BrowserState } from '@shared/types/browser'

const initialBrowser = useBrowser.getState()

function bridge(routes: Record<string, (p: never) => unknown> = {}) {
  const calls: [string, unknown][] = []
  const b = installBridge(routes)
  const invoke = b.invoke.getMockImplementation()!
  b.invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    calls.push([channel, payload])
    return invoke(channel, payload)
  })
  return { b, sent: (channel: string) => calls.filter(([c]) => c === channel).map(([, p]) => p) }
}

const ext = (id: string, extra: Partial<BrowserExtension> = {}): BrowserExtension => ({
  id,
  name: `Ext ${id}`,
  version: '1.0',
  description: '',
  source: 'store',
  enabled: true,
  popup: true,
  permissions: [],
  unsupported: [],
  installedAt: '2026-10-15T00:00:00.000Z',
  ...extra
})

const show = (s: BrowserState) => act(() => useBrowser.setState({ state: s }))

beforeEach(() => {
  useBrowser.setState(initialBrowser, true)
  useOverlays.setState({ count: 0 })
})
afterEach(() => vi.restoreAllMocks())

describe('extensions in the toolbar', () => {
  it('shows the enabled extensions and opens a popup under its icon', async () => {
    const { sent } = bridge()
    const { container } = render(<ExtensionButtons />)
    expect(container).toBeEmptyDOMElement() // no state yet
    show(
      state([tab('a', 'https://a.dev/')], {
        extensions: [ext('bw', { name: 'Bitwarden', icon: 'data:image/png;base64,x' }), ext('ub', { name: 'uBlock', popup: false }), ext('off', { enabled: false }), ext('bad', { error: 'nope' })]
      })
    )
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'uBlock has no popup' })).toBeDisabled()
    const bw = screen.getByRole('button', { name: 'Bitwarden — open' })
    expect(bw.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,x')
    fireEvent.click(bw)
    await settle()
    expect(sent('browser:extensions:popup')).toEqual([{ id: 'bw', anchor: { x: 0, y: 0, width: 0, height: 0 } }])
  })
})

describe('the extension manager', () => {
  it('installs from the Web Store, a folder or another browser — and says what each extension may do', async () => {
    const profiles: ChromiumProfile[] = [
      {
        browser: 'brave',
        name: 'Work',
        path: '/p',
        extensions: [
          { id: 'x', name: 'Dark Reader', version: '4', path: '/p/Extensions/x/4_0', installed: false },
          { id: 'y', name: 'Vault', version: '1', path: '/p/Extensions/y/1_0', installed: true }
        ]
      }
    ]
    let installFails = true
    const { sent } = bridge({
      'browser:extensions:install': () => (installFails ? fail('Not a Chrome Web Store address or extension id') : ext('new')),
      'browser:extensions:profiles': () => profiles,
      'browser:extensions:checkUpdates': () => ({ checked: 1, updated: ['Vault'], failed: [] })
    })
    useBrowser.setState({ extensionsOpen: true, downloadsOpen: true })
    render(<ExtensionsPanel />)
    expect(screen.getByText(/No extensions yet/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull()

    const input = screen.getByRole('textbox', { name: 'Web Store address or extension id' })
    const install = screen.getByRole('button', { name: 'Install' })
    expect(install).toBeDisabled()
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.submit(input.closest('form')!)
    fireEvent.change(input, { target: { value: 'bitwarden' } })
    fireEvent.click(install)
    await act(settle)
    expect(input).toHaveValue('bitwarden') // refused: still there to fix
    expect(useBrowser.getState().error).toBe('Not a Chrome Web Store address or extension id')
    installFails = false
    fireEvent.click(install)
    await act(settle)
    expect(input).toHaveValue('')
    expect(sent('browser:extensions:install')).toEqual([
      { source: 'store', input: 'bitwarden' },
      { source: 'store', input: 'bitwarden' }
    ])

    fireEvent.click(screen.getByRole('button', { name: /Load unpacked folder/ }))
    await act(settle)
    expect(sent('browser:extensions:install').at(-1)).toEqual({ source: 'folder' })

    const fromBrowser = screen.getByRole('button', { name: 'Take over from another browser' })
    fireEvent.click(fromBrowser)
    await act(settle)
    expect(fromBrowser).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Brave · Work')).toBeInTheDocument()
    expect(screen.getByText('Installed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }))
    await act(settle)
    expect(sent('browser:extensions:install').at(-1)).toEqual({ source: 'profile', path: '/p/Extensions/x/4_0' })
    expect(sent('browser:extensions:profiles')).toHaveLength(2) // read again after taking one over
    fireEvent.click(fromBrowser)
    expect(screen.queryByText('Brave · Work')).toBeNull()

    // installed extensions: on/off, remove, details, problems
    show(
      state([], {
        extensions: [
          ext('bw', { name: 'Bitwarden', description: 'Passwords', permissions: ['storage', 'alarms', '<all_urls>'], unsupported: ['alarms'], source: 'profile' }),
          ext('dev', { name: 'Dev tool', enabled: false, source: 'folder', error: 'Manifest broken' })
        ]
      })
    )
    expect(screen.getByText(/Mindeck’s Chromium lacks these APIs/)).toHaveTextContent('alarms')
    expect(screen.getByRole('alert')).toHaveTextContent('Manifest broken')
    expect(screen.getByText('1.0 · From another browser')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'Bitwarden on or off' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Dev tool' }))
    await act(settle)
    expect(sent('browser:extensions:update')).toEqual([{ id: 'bw', enabled: false }])
    expect(sent('browser:extensions:remove')).toEqual([{ id: 'dev' }])
    const [bwDetails, devDetails] = screen.getAllByRole('button', { name: 'Details' })
    fireEvent.click(bwDetails)
    expect(screen.getByText('Passwords')).toBeInTheDocument()
    expect(screen.getByText('alarms', { selector: 'li' }).className).toContain('text-amber')
    expect(screen.getByText('<all_urls>', { selector: 'li' }).className).not.toContain('text-amber')
    fireEvent.click(devDetails)
    expect(screen.getByText('No special permissions')).toBeInTheDocument()
    fireEvent.click(bwDetails)
    expect(screen.queryByText('Passwords')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    await act(settle)
    expect(screen.getByText('Updated: Vault')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(useBrowser.getState()).toMatchObject({ extensionsOpen: false, downloadsOpen: false })
  })

  it('says when nothing is to take over or update, and when the check fails', async () => {
    let checkFails = false
    bridge({
      'browser:extensions:profiles': () => [],
      'browser:extensions:checkUpdates': () => (checkFails ? fail('store down') : { checked: 1, updated: [], failed: [] })
    })
    useBrowser.setState({ state: state([], { extensions: [ext('a')] }) })
    render(<ExtensionsPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Take over from another browser' }))
    await act(settle)
    expect(screen.getByText(/No Chrome, Brave or Edge profile/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    await act(settle)
    expect(screen.getByText('All extensions are up to date')).toBeInTheDocument()
    checkFails = true
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    await act(settle)
    expect(useBrowser.getState().error).toBe('store down')
  })

  it('reads a failed profile scan as none', async () => {
    bridge({ 'browser:extensions:profiles': () => fail('no access') })
    render(<ExtensionsPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Take over from another browser' }))
    await act(settle)
    expect(screen.getByText(/No Chrome, Brave or Edge profile/)).toBeInTheDocument()
  })
})

describe('protection and privacy', () => {
  it('shows the shield with what was blocked; a click opens its menu', async () => {
    const { sent } = bridge()
    const { container, rerender } = render(<ShieldButton tab={tab('a', '')} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<ShieldButton tab={tab('a', 'https://a.dev/', { shield: { on: true, blocked: 0 } })} />)
    expect(screen.getByRole('button', { name: '0 ads and trackers blocked' }).textContent).toBe('')
    rerender(<ShieldButton tab={tab('a', 'https://a.dev/', { shield: { on: true, blocked: 1 } })} />)
    expect(screen.getByRole('button', { name: '1 ad or tracker blocked' })).toHaveTextContent('1')
    rerender(<ShieldButton tab={tab('a', 'https://a.dev/', { shield: { on: true, blocked: 1234 } })} />)
    expect(screen.getByRole('button')).toHaveTextContent('999+')
    rerender(<ShieldButton tab={tab('a', 'https://a.dev/', { shield: { on: false, blocked: 3 } })} />)
    const off = screen.getByRole('button', { name: 'Ad blocking is off on this site' })
    expect(off.textContent).toBe('')
    expect(fireEvent.mouseDown(off)).toBe(false) // the address bar keeps the focus
    fireEvent.click(off)
    await settle()
    expect(sent('browser:tool')).toEqual([{ id: 'a', tool: 'shield' }])
  })

  it('offers the system browser when a page needs DRM, until closed', async () => {
    const { sent } = bridge()
    const { container, rerender } = render(<DrmBar tab={tab('a', 'https://netflix.com/')} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<DrmBar tab={tab('a', 'https://netflix.com/', { drm: true })} />)
    expect(screen.getByRole('status')).toHaveTextContent('protected content (DRM)')
    fireEvent.click(screen.getByRole('button', { name: /Open in the system browser/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await settle()
    expect(sent('browser:tool')).toEqual([{ id: 'a', tool: 'handoff' }])
    expect(sent('browser:dismissDrm')).toEqual([{ id: 'a' }])
  })

  it('warns before a malware site: back to safety (or closed), or on at the user’s risk', async () => {
    const { sent } = bridge()
    const error = { code: -20, description: 'blocked', url: 'https://evil.dev/x', danger: 'malware' as const }
    const { rerender } = render(<DangerPage tab={tab('a', 'https://evil.dev/x', { error, canGoBack: true })} />)
    expect(screen.getByText(/evil\.dev is on a list of sites that spread malware/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to safety' }))
    rerender(<DangerPage tab={tab('a', 'https://evil.dev/x', { error: { ...error, url: 'weird' } })} />)
    expect(screen.getByText(/^weird is on a list/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to safety' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open anyway (unsafe)' }))
    await settle()
    expect(sent('browser:go')).toEqual([{ id: 'a', action: 'back' }])
    expect(sent('browser:close')).toEqual([{ id: 'a' }])
    expect(sent('browser:proceed')).toEqual([{ id: 'a' }])
  })

  it('asks for a server’s login over a still picture of the page', async () => {
    const { sent } = bridge()
    const { container } = render(<AuthDialog tabId="a" />)
    expect(container).toBeEmptyDOMElement()
    show(state([tab('a', 'https://a.dev/')], { auth: [{ id: 'other', tabId: 'b', host: 'b.dev:443', realm: '', isProxy: false }] }))
    expect(container).toBeEmptyDOMElement() // another tab's question
    show(state([tab('a', 'https://a.dev/')], { auth: [{ id: 'r1', tabId: 'a', host: 'intranet.dev:443', realm: 'Staff only', isProxy: false }] }))
    const dialog = screen.getByRole('dialog', { name: 'Sign in' })
    expect(useOverlays.getState().count).toBe(1)
    expect(dialog).toHaveTextContent('intranet.dev:443 asks for a user name and password')
    expect(dialog).toHaveTextContent('Staff only')
    expect(screen.getByLabelText('User name')).toHaveFocus()
    fireEvent.change(screen.getByLabelText('User name'), { target: { value: 'robin' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(dialog, { key: 'Enter' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await settle()
    expect(sent('browser:auth')).toEqual([{ id: 'r1', username: 'robin', password: 'pw' }, { id: 'r1' }, { id: 'r1' }])
    // a proxy (no tab) asks too
    show(state([], { auth: [{ id: 'p', host: 'proxy:8080', realm: '', isProxy: true }] }))
    expect(screen.getByRole('dialog')).toHaveTextContent('The proxy proxy:8080 asks')
    show(state([]))
    expect(useOverlays.getState().count).toBe(0)
  })

  it('shows a private tab’s page — no history, the address bar a click away', () => {
    render(<PrivateTabPage />)
    expect(screen.getByText('You are browsing privately')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Search the web/ }))
    expect(useBrowser.getState().focusTick).toBe(1)
  })
})

describe('the browser module · extras in place', () => {
  it('puts extensions, the manager and the DRM bar in the toolbar — and keeps private tabs from agents', async () => {
    const { sent } = bridge()
    useBrowser.setState({ downloadsOpen: true, state: state([tab('p', 'https://netflix.com/', { profile: 'private', drm: true })], { extensions: [ext('bw', { name: 'Bitwarden' })] }) })
    render(<BrowserView active />)
    await act(settle)
    expect(screen.getByRole('button', { name: 'Bitwarden — open' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('DRM')
    expect(screen.getByRole('button', { name: /Private: agents cannot see this tab/ })).toBeDisabled()
    const manage = screen.getByRole('button', { name: 'Manage extensions' })
    fireEvent.click(manage)
    expect(manage).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('complementary', { name: 'Extensions' })).toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Downloads' })).toBeNull()
    fireEvent.click(manage)
    expect(screen.queryByRole('complementary', { name: 'Extensions' })).toBeNull()
    await act(settle)
    expect(sent('browser:extensions:popup')).toEqual([])
  })

  it('marks private and agents’ tabs in the address bar and the tab strip, and media playing', async () => {
    bridge()
    const tabs = [
      tab('p', 'https://a.dev/', { profile: 'private', title: 'Secret' }),
      tab('g', 'https://b.dev/', { profile: 'agents', title: 'Container' }),
      tab('o', 'https://c.dev/', { profile: 'agents', openedBy: 'Codex', title: 'Agent' }),
      tab('m', 'https://d.dev/', { playing: true, title: 'Video' }),
      tab('s', 'https://e.dev/', { playing: true, audible: true, title: 'Loud' })
    ]
    useBrowser.setState({ state: state(tabs) })
    render(<TabStrip />)
    const strip = screen.getByRole('tablist')
    expect(within(strip).getAllByLabelText('Private tab')).toHaveLength(1)
    expect(within(strip).getAllByLabelText('Agents’ container — without your logins')).toHaveLength(1)
    expect(within(strip).getAllByLabelText('Playing media')).toHaveLength(1)

    const { rerender } = render(<Omnibox tab={tabs[0]} />)
    expect(screen.getByText('Private tab', { selector: 'span' })).toBeInTheDocument()
    rerender(<Omnibox tab={{ ...tabs[1], shield: { on: true, blocked: 2 } }} />)
    expect(screen.getAllByLabelText('Agents’ container — without your logins').length).toBeGreaterThan(1)
    expect(screen.getByRole('button', { name: '2 ads and trackers blocked' })).toBeInTheDocument()
    // while typing, the shield steps aside
    fireEvent.focus(screen.getByRole('textbox', { name: 'Address or search' }))
    expect(screen.queryByRole('button', { name: '2 ads and trackers blocked' })).toBeNull()
  })

  it('shows the malware warning, a private tab’s page and a login in the page area', async () => {
    bridge()
    useBrowser.setState({ state: state([tab('a', 'https://evil.dev/', { error: { code: -20, description: 'blocked', url: 'https://evil.dev/', danger: 'malware' } })]) })
    const { rerender } = render(<Viewport active />)
    expect(screen.getByText('Dangerous site ahead')).toBeInTheDocument()
    show(state([tab('p', '', { profile: 'private' })], { auth: [{ id: 'r', host: 'x:1', realm: '', isProxy: false }] }))
    expect(screen.getByText('You are browsing privately')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Sign in' })).toBeInTheDocument()
    rerender(<Viewport active={false} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens private tabs from the store', async () => {
    const { sent } = bridge()
    await useBrowser.getState().newTab({ private: true })
    await useBrowser.getState().newTab()
    expect(sent('browser:open')).toEqual([{ private: true }, {}])
  })
})

describe('browser settings · protection, agents, downloads', () => {
  it('switches blocking, malware warnings, agents’ logins and asking for downloads — and picks the folder', async () => {
    let current: BrowserSettings = { ...DEFAULT_BROWSER_SETTINGS }
    let pick: string | null = null
    const configure = vi.fn((patch: Partial<BrowserSettings>) => (current = { ...current, ...patch }))
    installBridge({
      'browser:settings': () => current,
      'browser:configure': configure,
      'browser:pickDownloadDir': () => (pick ? (current = { ...current, downloadDir: pick }) : null)
    })
    render(<BrowserCard />)
    await act(settle)
    for (const [name, key] of [
      ['Block ads and trackers', 'adblock'],
      ['Warn about malware sites', 'malwareProtection'],
      ['Agents may use my logins', 'agentsUseLogins'],
      ['Ask where to save each download', 'askDownloadLocation']
    ] as const) {
      const toggle = screen.getByRole('switch', { name })
      fireEvent.click(toggle)
      await act(settle)
      expect(configure).toHaveBeenLastCalledWith({ [key]: !DEFAULT_BROWSER_SETTINGS[key] })
    }
    expect(screen.getByText('System Downloads folder')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Choose/ })) // cancelled
    await act(settle)
    expect(screen.getByText('System Downloads folder')).toBeInTheDocument()
    pick = '/Users/me/Inbox'
    fireEvent.click(screen.getByRole('button', { name: /Choose/ }))
    await act(settle)
    expect(screen.getByText('/Users/me/Inbox')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await act(settle)
    expect(configure).toHaveBeenLastCalledWith({ downloadDir: '' })
    expect(screen.getByText('System Downloads folder')).toBeInTheDocument()
  })

  it('keeps the folder when the picker fails', async () => {
    installBridge({ 'browser:settings': () => ({ ...DEFAULT_BROWSER_SETTINGS }), 'browser:pickDownloadDir': () => fail('headless') })
    render(<BrowserCard />)
    await act(settle)
    fireEvent.click(screen.getByRole('button', { name: /Choose/ }))
    await act(settle)
    expect(screen.getByText('System Downloads folder')).toBeInTheDocument()
  })
})
