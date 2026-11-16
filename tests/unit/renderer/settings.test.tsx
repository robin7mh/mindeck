import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, installBridge, installRemote, settle, choose } from './bridge'
import type { ServerStatus } from '@shared/types/server'
import type { SystemSnapshot } from '@shared/types/system'
import type { ProjectContext } from '@shared/types/context'
import { canManage, isLoopback, liveReach, myDeviceId, pairingReachable, pairingUrl, reachOf, useSettings } from '@/features/settings/store'
import { NAV, type SectionId } from '@/features/settings/sections'
import { SettingsView } from '@/features/settings/components/SettingsView'
import { SystemView } from '@/features/system/components/SystemView'
import { ContextSection } from '@/features/projects/components/ContextSection'
import { useContextStore } from '@/features/context/store'
import { useAssistant } from '@/features/agents/store'
import { useComposerPrefs } from '@/features/agents/composerPrefs'
import { useSession } from '@/features/session/store'
import { linkFromHash, PairScreen } from '@/features/session/components/PairScreen'
import { formatFingerprint, normalizeFingerprint, pairingLink, parsePairingLink } from '@shared/ipc/transport'
import { AppearanceCard } from '@/features/settings/components/AppearanceCard'
import { surfaceTokens, useAppearance } from '@/lib/theme'
import { en } from '@/lib/i18n/en'
import { useBrowser } from '@/features/browser/store'
import { DEFAULT_BROWSER_SETTINGS, type BrowserSettings } from '@shared/types/browser'

const initialSettings = useSettings.getState()
const initialAssistant = useAssistant.getState()
beforeEach(() => {
  useSettings.setState(initialSettings, true)
  useAssistant.setState(initialAssistant, true)
  useContextStore.setState({ byProject: {} })
})

const HEX = 'AB'.repeat(16) + 'CD'.repeat(16)
const FP = formatFingerprint(HEX)
/** The public key's fingerprint (stays when the certificate is renewed). */
const PK_HEX = 'EF'.repeat(32)
const PK = formatFingerprint(PK_HEX)

const server = (over: Partial<ServerStatus> = {}): ServerStatus => ({
  config: { enabled: true, lan: false, tls: true, port: 7420, remoteTerminal: false, remoteRoots: [], relay: false, keepAwake: false },
  running: true,
  urls: ['http://127.0.0.1:7420'],
  configurable: true,
  ...over
})

function settingsCore(over: Record<string, (p: never) => unknown> = {}) {
  return {
    'agents:detect': () => [],
    'server:status': () => server(),
    'server:devices': () => [
      { id: 'd1', name: 'Pixel Phone', role: 'member', createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() },
      { id: 'd2', name: 'Chrome · macOS', role: 'member', createdAt: new Date().toISOString() }
    ],
    'permission:grants': () => [{ agentId: 'assistant', toolName: 'memory_create_note', createdAt: '' }],
    'server:setDeviceRole': ({ id, role }: { id: string; role: string }) => [
      { id: 'd2', name: 'Chrome · macOS', role: id === 'd2' ? role : 'member', createdAt: new Date().toISOString() }
    ],
    'server:configure': (patch: Record<string, unknown>) => server({ config: { ...server().config, ...patch } as never }),
    'server:createPairingCode': () => ({ code: 'ABCD-EFGH', expiresAt: '', urls: ['http://127.0.0.1:7420', 'http://192.168.1.9:7420'] }),
    'server:revokeDevice': () => undefined,
    'permission:revoke': () => undefined,
    'memory:status': () => ({ root: '/v', defaultRoot: '/v', name: 'Mindeck', isDefault: true, exists: true, noteCount: 3, graphStyle: { mode: 'colorful', color: 'cyan' } }),
    'memory:pickVault': () => ({ root: '/picked', defaultRoot: '/v', name: 'picked', isDefault: false, exists: false, noteCount: 0, graphStyle: { mode: 'colorful', color: 'cyan' } }),
    'memory:setVault': ({ path }: { path: string }) => ({ root: path, defaultRoot: '/v', name: 'x', isDefault: false, exists: true, noteCount: 1, graphStyle: { mode: 'colorful', color: 'cyan' } }),
    'fs:dirs': () => ({ path: '/srv/notes', parent: '/srv', home: '/root', dirs: [] }),
    'ai:setKey': () => ({ configured: true, model: 'claude-opus-5-5', cloud: null, source: 'stored', keyHint: 'NEW1', settings: { model: 'claude-opus-5-5', effort: 'high', inline: false, inlineModel: 'claude-opus-5-5', cloudModel: 'claude-haiku-5-5' } }),
    'ai:clearKey': () => ({ configured: false, model: 'claude-opus-5-5', cloud: null, source: null, settings: { model: 'claude-opus-5-5', effort: 'high', inline: false, inlineModel: 'claude-opus-5-5', cloudModel: 'claude-haiku-5-5' } }),
    'ai:configure': (p: Record<string, unknown>) => ({ configured: true, model: 'claude-opus-5-5', cloud: null, source: 'stored', keyHint: 'NEW1', settings: { model: 'claude-opus-5-5', effort: 'high', inline: false, inlineModel: 'claude-opus-5-5', cloudModel: 'claude-haiku-5-5', ...p } }),
    ...over
  }
}

describe('settings store', () => {
  it('builds the pairing URL a phone can open', () => {
    expect(pairingUrl('AB CD', ['http://127.0.0.1:7420', 'http://192.168.1.9:7420'])).toBe('http://192.168.1.9:7420/#pair=AB%20CD')
    expect(pairingUrl('X', ['http://127.0.0.1:7420'])).toBe('http://127.0.0.1:7420/#pair=X')
    expect(pairingUrl('X', ['http://127.0.0.1:7420'], 'http://nas.local:7420/')).toBe('http://nas.local:7420/#pair=X')
    expect(pairingUrl('X', ['http://127.0.0.1:7420'], 'file://')).toBe('http://127.0.0.1:7420/#pair=X')
    // the desktop window's own address is the app itself (dev server or file://) — never for a phone
    const lan = ['http://127.0.0.1:7420', 'http://192.168.1.9:7420']
    expect(pairingUrl('X', lan, 'http://localhost:5173', true)).toBe('http://192.168.1.9:7420/#pair=X')
    expect(pairingUrl('X', lan, 'http://nas.local:7420', true)).toBe('http://192.168.1.9:7420/#pair=X')
    // a browser on this very computer: its loopback address is no use to a phone either
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:7420', 'http://[::1]:7420']) {
      expect(pairingUrl('X', lan, origin)).toBe('http://192.168.1.9:7420/#pair=X')
    }
    // Over HTTPS the link names the certificate; over HTTP there is none to name.
    const tls = ['http://127.0.0.1:7420', 'https://192.168.1.9:7420']
    expect(pairingUrl('X', tls, undefined, true, FP)).toBe(`https://192.168.1.9:7420/#pair=X&fp=${HEX.toLowerCase()}`)
    expect(pairingUrl('X', tls, 'https://nas.local:7420', false, FP)).toBe(`https://nas.local:7420/#pair=X&fp=${HEX.toLowerCase()}`)
    expect(pairingUrl('X', lan, undefined, true, FP)).toBe('http://192.168.1.9:7420/#pair=X')
    // …and its public key, which stays the same when the core renews the certificate.
    expect(pairingUrl('X', tls, undefined, true, FP, PK)).toBe(`https://192.168.1.9:7420/#pair=X&fp=${HEX.toLowerCase()}&pk=${PK_HEX.toLowerCase()}`)
    expect(pairingUrl('X', lan, undefined, true, FP, PK)).toBe('http://192.168.1.9:7420/#pair=X')
    // Away access: the app pairs through the relay, trusting the certificate — whatever the address (LAN off: loopback).
    expect(pairingUrl('X', ['http://127.0.0.1:7420'], undefined, true, FP, PK, 'install-1')).toBe(`http://127.0.0.1:7420/#pair=X&fp=${HEX.toLowerCase()}&pk=${PK_HEX.toLowerCase()}&ci=install-1`)
    // Never without a certificate to trust.
    expect(pairingUrl('X', lan, undefined, true, undefined, undefined, 'install-1')).toBe('http://192.168.1.9:7420/#pair=X')
  })

  it('knows when a phone could reach the core at all', () => {
    expect(['http://localhost', 'http://127.0.0.1:1/x', 'http://[::1]:7420', 'http://localhost.example.com'].map(isLoopback)).toEqual([true, true, true, false])
    expect(pairingReachable(['http://127.0.0.1:7420'])).toBe(false)
    expect(pairingReachable(['http://127.0.0.1:7420'], 'http://localhost:5173')).toBe(false)
    expect(pairingReachable(['http://127.0.0.1:7420'], 'http://nas.local:7420')).toBe(true)
    expect(pairingReachable(['http://127.0.0.1:7420'], 'http://nas.local:7420', true)).toBe(false)
    expect(pairingReachable(['http://127.0.0.1:7420', 'http://192.168.1.9:7420'], undefined, true)).toBe(true)
    // Through the relay a phone gets here from anywhere.
    expect(pairingReachable(['http://127.0.0.1:7420'], undefined, true, true)).toBe(true)
  })

  it('where devices may connect from: as set up, and as it really stands', () => {
    const cfg = server().config
    expect(reachOf(undefined)).toBe('off')
    expect(reachOf({ ...cfg, enabled: false, lan: true, relay: true })).toBe('off')
    expect(reachOf(cfg)).toBe('off')
    expect(reachOf({ ...cfg, lan: true })).toBe('lan')
    expect(reachOf({ ...cfg, relay: true })).toBe('any') // the relay wins, with or without the LAN
    expect(reachOf({ ...cfg, lan: true, relay: true })).toBe('any')
    // Live: anywhere only while the cloud link is online; the LAN while the server listens there.
    expect(liveReach(undefined)).toBe('off')
    expect(liveReach(server({ running: false, config: { ...cfg, lan: true } }))).toBe('off')
    expect(liveReach(server({ config: { ...cfg, relay: true }, relay: { state: 'connecting' } }))).toBe('off')
    expect(liveReach(server({ config: { ...cfg, relay: true } }))).toBe('off')
    expect(liveReach(server({ config: { ...cfg, relay: true, lan: true }, relay: { state: 'error', reason: 'signed-out' } }))).toBe('lan')
    expect(liveReach(server({ config: { ...cfg, relay: true }, relay: { state: 'online' } }))).toBe('any')
    expect(liveReach(server({ config: { ...cfg, relay: false }, relay: { state: 'online' } }))).toBe('off')
    expect(liveReach(server({ config: { ...cfg, lan: true } }))).toBe('lan')
  })

  it('re-reads the server status, but never over a change on its way', async () => {
    let calls = 0
    installBridge(settingsCore({ 'server:status': () => server({ relay: { state: calls++ ? 'online' : 'connecting' } }) }))
    await useSettings.getState().refreshServer()
    expect(useSettings.getState().server?.relay).toEqual({ state: 'connecting' })
    useSettings.setState({ busy: true })
    await useSettings.getState().refreshServer()
    expect(useSettings.getState().server?.relay).toEqual({ state: 'connecting' })
    useSettings.setState({ busy: false })
    await useSettings.getState().refreshServer()
    expect(useSettings.getState().server?.relay).toEqual({ state: 'online' })
    // The answer arrives while a switch moves: the switch wins.
    installBridge(
      settingsCore({
        'server:status': () => {
          useSettings.setState({ busy: true })
          return server({ relay: { state: 'off' } })
        }
      })
    )
    await useSettings.getState().refreshServer()
    expect(useSettings.getState().server?.relay).toEqual({ state: 'online' })
    useSettings.setState({ busy: false })
    installBridge(settingsCore({ 'server:status': () => fail('down') }))
    await useSettings.getState().refreshServer()
    expect(useSettings.getState().server?.relay).toEqual({ state: 'online' })
  })

  it('server switches move at once; the core settles them, a failure puts them back', async () => {
    let answer!: (ok: boolean) => void
    installBridge(
      settingsCore({
        'server:configure': () =>
          new Promise((resolve, reject) => (answer = (ok) => (ok ? resolve({ ...server(), running: false, config: { ...server().config, enabled: false } }) : reject(new Error('port busy')))))
      })
    )
    const s = () => useSettings.getState()
    let pending = s().configureServer({ enabled: false }) // nothing loaded yet: nothing to move early
    expect(s().server).toBeUndefined()
    answer(false)
    await pending
    expect(s().server).toBeUndefined()
    await s().load()

    pending = s().configureServer({ enabled: false })
    expect(s().server).toMatchObject({ running: true, config: { enabled: false } }) // the switch moved, the state is real
    expect(s().busy).toBe(true)
    answer(true)
    await pending
    expect(s().server).toMatchObject({ running: false, config: { enabled: false } })

    useSettings.setState({ server: server() })
    pending = s().configureServer({ enabled: false })
    answer(false)
    await pending
    expect(s().server?.config.enabled).toBe(true)
    expect(s()).toMatchObject({ busy: false, error: 'port busy' })
  })

  it('knows who may manage devices: the desktop window, or an admin device', () => {
    const devices = [{ id: 'me', name: 'x', role: 'admin' as const, createdAt: '' }, { id: 'other', name: 'y', role: 'member' as const, createdAt: '' }]
    expect(canManage(devices, true, null)).toBe(true)
    expect(canManage(devices, false, 'me')).toBe(true)
    expect(canManage(devices, false, 'other')).toBe(false)
    expect(canManage(devices, false, null)).toBe(false)
    localStorage.setItem('mindeck.deviceId', 'me')
    expect(myDeviceId()).toBe('me')
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(myDeviceId()).toBeNull()
    get.mockRestore()
    localStorage.removeItem('mindeck.deviceId')
  })

  it('loads without the projects when they can\'t be listed', async () => {
    installBridge(settingsCore({ 'projects:list': () => fail('busy') }))
    await useSettings.getState().load()
    expect(useSettings.getState().projects).toEqual([])
    expect(useSettings.getState().devices).toHaveLength(2)
  })

  it('loads, configures, pairs (with a QR code), revokes; reports failures', async () => {
    installBridge(settingsCore())
    const s = () => useSettings.getState()
    await s().load()
    expect(s().devices).toHaveLength(2)
    expect(s().grants).toHaveLength(1)
    await s().configureServer({ lan: true })
    expect(s().server?.config.lan).toBe(true)
    await s().createPairing()
    expect(window.mindeck!.invoke).toHaveBeenLastCalledWith('server:createPairingCode', {})
    await s().createPairing('admin')
    expect(window.mindeck!.invoke).toHaveBeenLastCalledWith('server:createPairingCode', { role: 'admin' })
    expect(s().pairing).toMatchObject({ code: 'ABCD-EFGH', url: expect.stringContaining('#pair=ABCD-EFGH') })
    expect(s().pairing!.qr).toContain('<svg')
    s().closePairing()
    expect(s().pairing).toBeUndefined()
    await settle() // closing reloads the device list
    await s().revokeDevice('d1')
    expect(s().devices.map((d) => d.id)).toEqual(['d2'])
    await s().setDeviceRole('d2', 'admin')
    expect(s().devices).toEqual([expect.objectContaining({ id: 'd2', role: 'admin' })])
    await s().revokeGrant(s().grants[0])
    expect(window.mindeck!.invoke).toHaveBeenLastCalledWith('permission:revoke', { agentId: 'assistant', toolName: 'memory_create_note' })
    expect(s().grants).toEqual([])
    useSettings.setState({ grants: [{ agentId: 'claude-code', toolName: 'Write', projectId: 'p1', createdAt: '' }] })
    await s().revokeGrant(s().grants[0])
    expect(window.mindeck!.invoke).toHaveBeenLastCalledWith('permission:revoke', { agentId: 'claude-code', toolName: 'Write', projectId: 'p1' })
    expect(s().projects).toEqual([]) // the bridge had no projects:list

    installBridge(
      Object.fromEntries(
        ['server:status', 'server:configure', 'server:createPairingCode', 'server:revokeDevice', 'server:setDeviceRole', 'permission:revoke'].map((ch) => [ch, () => fail(`${ch} failed`)])
      )
    )
    for (const [run, text] of [
      [() => s().load(), 'server:status failed'],
      [() => s().configureServer({}), 'server:configure failed'],
      [() => s().createPairing(), 'server:createPairingCode failed'],
      [() => s().revokeDevice('x'), 'server:revokeDevice failed'],
      [() => s().setDeviceRole('x', 'admin'), 'server:setDeviceRole failed'],
      [() => s().revokeGrant({ agentId: 'a', toolName: 't', createdAt: '' }), 'permission:revoke failed']
    ] as const) {
      await run()
      expect(s()).toMatchObject({ error: text, busy: false })
    }
    s().clearError()
    expect(s().error).toBeUndefined()
  })
})

const S = en.settings
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The settings' navigation. */
const nav = () => within(screen.getByRole('navigation', { name: S.navLabel }))
/** A section's button in the navigation: its title, then its badge (if any). */
const navButton = (id: SectionId) => nav().getByRole('button', { name: new RegExp(`^${escapeRe(S.sections[id].title)}`) })
/** The sections the navigation lists, in order. */
const navTitles = () => nav().queryAllByRole('button').map((b) => b.textContent)
/** Opens a section the way a user does: its button in the navigation. */
const show = (id: SectionId) => fireEvent.click(navButton(id))
/** The open section's title. */
const openTitle = () => screen.getByRole('heading', { level: 2 }).textContent
/** One of the choices "Where may devices connect from?". */
const reachChoice = (label: string) => within(screen.getByRole('radiogroup', { name: S.reachQuestion })).getByRole('radio', { name: label })
const ALL_SECTIONS = ['General & appearance', 'AI & agents', 'Editor', 'Languages & debuggers', 'Terminal', 'Browser', 'Phone & remote access', 'Memory', 'Move over from VS Code', 'About & diagnostics']
const AI_SETTINGS = { model: 'claude-opus-5-5', effort: 'high', inline: false, inlineModel: 'claude-opus-5-5', cloudModel: 'claude-haiku-5-5' } as const

/** The settings, opened at `id` through the navigation (General when none is named). */
async function renderSettings(id?: SectionId, props: { onOpenAccount?: () => void } = {}) {
  const view = render(<SettingsView {...props} />)
  if (id) show(id)
  await act(settle)
  return view
}

describe('Settings navigation', () => {
  it('sections in four groups, one open at a time — the one chosen stays while Mindeck runs', async () => {
    installBridge(settingsCore())
    useSession.setState({ info: { mode: 'desktop', version: '1.2.3', platform: 'darwin', hostname: 'mac', remoteTerminal: false } })
    const { unmount } = await renderSettings()
    expect(navTitles()).toEqual(ALL_SECTIONS)
    expect(nav().getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['App', 'Work', 'Data & devices', 'Help'])
    expect(openTitle()).toBe('General & appearance')
    expect(navButton('general')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText(/^Changes are saved right away\.\s*Mindeck 1\.2\.3$/)).toBeInTheDocument()

    show('memory')
    await act(settle)
    expect(openTitle()).toBe('Memory')
    expect(navButton('memory')).toHaveAttribute('aria-current', 'page')
    expect(navButton('general')).not.toHaveAttribute('aria-current')
    expect(screen.queryByText('Interface language')).toBeNull() // one section at a time
    unmount()

    useSession.setState({ info: undefined })
    await renderSettings()
    expect(openTitle()).toBe('Memory')
    expect(screen.getByText('Changes are saved right away.')).toBeInTheDocument() // no version known: none named
  })

  it('every section opens from its button, under its own title', async () => {
    installBridge(settingsCore({ 'tools:status': () => [], 'migrate:scan': () => [], 'browser:settings': () => DEFAULT_BROWSER_SETTINGS }))
    await renderSettings()
    for (const id of NAV.flatMap((g) => g.sections)) {
      show(id)
      await act(settle)
      expect(openTitle()).toBe(S.sections[id].title)
      expect(screen.getByText(S.sections[id].intro)).toBeInTheDocument()
      expect(nav().getAllByRole('button').filter((b) => b.getAttribute('aria-current') === 'page')).toEqual([navButton(id)])
    }
  })

  it('the search keeps the sections that match every word; Enter opens the first, Escape clears it', async () => {
    installBridge(settingsCore())
    await renderSettings()
    const search = screen.getByRole('searchbox', { name: S.search })
    fireEvent.change(search, { target: { value: 'Minimap' } })
    expect(navTitles()).toEqual(['Editor'])
    expect(nav().getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Work']) // groups without a hit are gone
    fireEvent.change(search, { target: { value: 'https certificate' } })
    expect(navTitles()).toEqual(['Phone & remote access'])

    fireEvent.change(search, { target: { value: 'https minimap' } })
    expect(navTitles()).toEqual([])
    expect(screen.getByText('No setting found.')).toBeInTheDocument()
    fireEvent.keyDown(search, { key: 'Enter' }) // nothing to open
    expect(openTitle()).toBe('General & appearance')

    fireEvent.change(search, { target: { value: '  font ' } })
    expect(navTitles()).toEqual(['Editor', 'Terminal'])
    expect(screen.queryByText('No setting found.')).toBeNull()
    fireEvent.keyDown(search, { key: 'Enter' })
    await act(settle)
    expect(openTitle()).toBe('Editor')
    expect(useSettings.getState().query).toBe('  font ') // the search stays as typed

    fireEvent.keyDown(search, { key: 'Escape' })
    expect(search).toHaveValue('')
    expect(navTitles()).toEqual(ALL_SECTIONS)
    fireEvent.keyDown(search, { key: 'Escape' }) // empty already: nothing changes
    fireEvent.keyDown(search, { key: 'a' })
    expect(search).toHaveValue('')
    expect(openTitle()).toBe('Editor')
  })

  it('a paired browser does not see what only the desktop window can set', async () => {
    installRemote(settingsCore())
    useSettings.setState({ section: 'browser' })
    await renderSettings()
    expect(navTitles()).toEqual(['General & appearance', 'AI & agents', 'Editor', 'Languages & debuggers', 'Phone & remote access', 'Memory', 'About & diagnostics'])
    // A section it cannot open (chosen in the desktop window) falls back to General.
    expect(openTitle()).toBe('General & appearance')
    expect(navButton('general')).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('combobox', { name: 'Search engine' })).toBeNull()
    for (const query of ['vs code', 'zsh', 'adblock']) {
      fireEvent.change(screen.getByRole('searchbox', { name: S.search }), { target: { value: query } })
      expect(screen.getByText('No setting found.')).toBeInTheDocument()
    }
  })

  it('a badge on AI & agents while the assistant needs signing in', async () => {
    installBridge(settingsCore())
    await renderSettings()
    const badge = () => within(navButton('ai')).queryByText('Sign in')
    expect(badge()).toBeNull() // nothing known yet
    act(() => useAssistant.setState({ status: { configured: false, model: 'claude-opus-5-5', cloud: null, source: null, settings: AI_SETTINGS } }))
    expect(badge()).toBeInTheDocument()
    act(() => useAssistant.setState({ status: { configured: true, model: 'claude-opus-5-5', cloud: null, source: 'stored', keyHint: 'ABCD', settings: AI_SETTINGS } }))
    expect(badge()).toBeNull()
  })

  it('a badge on remote access only while devices can really connect — not merely when it is set up', async () => {
    installBridge(settingsCore({ 'server:status': () => server({ config: { ...server().config, relay: true }, relay: { state: 'connecting' } }) }))
    await renderSettings()
    const badge = () => within(navButton('remote')).queryByText('On')
    // Away access is on by default but works only signed in: until the cloud link stands, nothing reaches this computer.
    expect(useSettings.getState().server).toMatchObject({ running: true, config: { relay: true, lan: false } })
    expect(badge()).toBeNull()
    act(() => useSettings.setState({ server: server({ config: { ...server().config, relay: true }, relay: { state: 'error', reason: 'signed-out' } }) }))
    expect(badge()).toBeNull()
    act(() => useSettings.setState({ server: server({ config: { ...server().config, relay: true, lan: true }, relay: { state: 'connecting' } }) }))
    expect(badge()).toBeInTheDocument() // the home network works meanwhile
    act(() => useSettings.setState({ server: server({ config: { ...server().config, relay: true }, relay: { state: 'online' } }) }))
    expect(badge()).toBeInTheDocument()
    act(() => useSettings.setState({ server: server({ config: { ...server().config, relay: false }, relay: { state: 'online' } }) }))
    expect(badge()).toBeNull() // a link still reported online, but away access is switched off
    act(() => useSettings.setState({ server: server({ running: false, config: { ...server().config, lan: true, relay: true }, relay: { state: 'online' } }) }))
    expect(badge()).toBeNull() // the server isn't running
  })
})

describe('SettingsView', () => {
  it('lists the coding agents on this machine and checks again on request', async () => {
    const detect = vi.fn()
      .mockResolvedValueOnce([
        { kind: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.287', signedIn: true, account: 'Pro plan', ready: true },
        { kind: 'codex', name: 'Codex', installed: true, ready: false, hint: 'Coming to Mindeck soon' },
        { kind: 'gemini', name: 'Gemini CLI', installed: false, ready: false, hint: 'npm install -g @google/gemini-cli' }
      ])
      .mockResolvedValueOnce([{ kind: 'claude-code', name: 'Claude Code', installed: true, ready: true }])
    installBridge(settingsCore({ 'agents:detect': detect }))
    await renderSettings('ai')
    expect(openTitle()).toBe('AI & agents')
    expect(screen.getByText('Coding agents')).toBeInTheDocument()
    expect(screen.getByText('Pro plan · v2.1.287')).toBeInTheDocument()
    expect(screen.getByText('Coming to Mindeck soon')).toBeInTheDocument()
    expect(screen.getByText('Not set up')).toBeInTheDocument() // Codex: installed, not usable yet
    expect(screen.getByText('Not installed')).toBeInTheDocument() // Gemini
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await act(settle)
    expect(detect).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Codex')).toBeNull()
  })

  it('the composer\'s send key and pushes to the phone (with a Mindeck account)', async () => {
    const setPush = vi.fn(({ enabled }: { enabled: boolean }) => ({ enabled, signedIn: true }))
    installBridge(settingsCore({ 'agents:pushSettings': () => ({ enabled: true, signedIn: true }), 'agents:setPushSettings': setPush }))
    await renderSettings('ai')
    const push = screen.getByRole('switch', { name: 'Notifications on your phone' })
    expect(push).toBeChecked()
    fireEvent.click(push)
    await act(settle)
    expect(setPush).toHaveBeenCalledWith({ enabled: false })
    expect(push).not.toBeChecked()
    const mod = screen.getByRole('switch', { name: '⌘/Ctrl+Enter sends' })
    fireEvent.click(mod)
    expect(useComposerPrefs.getState().sendKey).toBe('mod-enter')
    fireEvent.click(mod)
    expect(useComposerPrefs.getState().sendKey).toBe('enter')
  })

  it('pushes need a Mindeck account; a failing core changes nothing', async () => {
    installBridge(settingsCore({ 'agents:pushSettings': () => ({ enabled: true, signedIn: false }) }))
    const { unmount } = await renderSettings('ai')
    expect(screen.getByRole('switch', { name: 'Notifications on your phone' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Notifications on your phone' })).not.toBeChecked()
    expect(screen.getByText(/Sign in to your Mindeck account to get them/)).toBeInTheDocument()
    unmount()

    installBridge(settingsCore({ 'agents:pushSettings': () => ({ enabled: true, signedIn: true }), 'agents:setPushSettings': () => fail('core down') }))
    const second = render(<SettingsView />)
    await act(settle)
    expect(openTitle()).toBe('AI & agents') // the section open last time
    fireEvent.click(screen.getByRole('switch', { name: 'Notifications on your phone' }))
    await act(settle)
    expect(screen.getByRole('switch', { name: 'Notifications on your phone' })).toBeChecked()
    second.unmount()

    installBridge(settingsCore({ 'agents:pushSettings': () => fail('core down') }))
    render(<SettingsView />)
    await act(settle)
    expect(screen.queryByRole('switch', { name: 'Notifications on your phone' })).toBeNull()
  })

  it('not signed in: the AI section says so, and its button opens the account', async () => {
    const onOpenAccount = vi.fn()
    installBridge(settingsCore())
    useAssistant.setState({ status: { configured: false, model: 'claude-opus-5-5', cloud: null, source: null, settings: AI_SETTINGS } })
    await renderSettings('ai', { onOpenAccount })
    const notice = screen.getByRole('alert')
    expect(notice).toHaveTextContent('Not signed in yet. Sign in to your Mindeck account to use the AI.')
    fireEvent.click(within(notice).getByRole('button', { name: 'Sign in' }))
    expect(onOpenAccount).toHaveBeenCalledTimes(1)
    // No key of one's own: its fold-out stays closed, and suggestions while typing wait for one.
    expect(screen.getByText('For heavy use: your own API key').closest('details')).not.toHaveAttribute('open')
    expect(screen.getByText('needs an API key')).toBeInTheDocument()
    expect(screen.getByLabelText('Suggestions while typing')).toBeDisabled()
    expect(screen.getByLabelText('Suggestions while typing')).not.toBeChecked()
  })

  it('where devices may connect from: off, the home network or anywhere — each choice sets the switches behind it', async () => {
    let config: ServerStatus['config'] = { ...server().config, tls: false }
    let relay: ServerStatus['relay'] = { state: 'off' }
    const bridge = installBridge(
      settingsCore({
        'server:status': () => server({ config, relay }),
        'server:configure': (patch: Partial<ServerStatus['config']>) => {
          config = { ...config, ...patch }
          return server({ config, relay })
        }
      })
    )
    const sent = () => bridge.invoke.mock.calls.filter(([channel]) => channel === 'server:configure').map(([, patch]) => patch)
    await renderSettings('remote')
    expect(reachChoice('Off')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Remote access is off')).toBeInTheDocument()
    expect(screen.getByText(S.reachDesc.off)).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Keep the Mac awake on power' })).toBeNull()
    fireEvent.click(reachChoice('Off')) // already so: nothing to send
    expect(sent()).toEqual([])

    fireEvent.click(reachChoice('Home network'))
    await act(settle)
    expect(sent()).toEqual([{ enabled: true, lan: true, relay: false }])
    expect(reachChoice('Home network')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Reachable on your home network')).toBeInTheDocument()
    expect(screen.getByText(S.reachDesc.lan)).toBeInTheDocument()
    expect(within(navButton('remote')).getByText('On')).toBeInTheDocument()
    expect(screen.getByText(/Unencrypted: pairing codes and device tokens/)).toBeInTheDocument() // the network without HTTPS

    // Anywhere: through the cloud, which must never see a connection in the clear — HTTPS comes with it.
    fireEvent.click(reachChoice('Anywhere'))
    await act(settle)
    expect(sent()[1]).toEqual({ enabled: true, lan: true, relay: true, tls: true })
    expect(reachChoice('Anywhere')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(S.reachDesc.any)).toBeInTheDocument()
    expect(screen.queryByText(/Unencrypted:/)).toBeNull()
    expect(screen.getByRole('switch', { name: 'Keep the Mac awake on power' })).not.toBeChecked()
    // Until the cloud link stands, devices get here on the home network only.
    expect(screen.getByText('Reachable on your home network')).toBeInTheDocument()
    relay = { state: 'online' }
    await act(() => useSettings.getState().refreshServer())
    expect(screen.getByText('Reachable from anywhere')).toBeInTheDocument()

    // While a change is on its way, the choices wait.
    act(() => useSettings.setState({ busy: true }))
    expect(reachChoice('Off')).toBeDisabled()
    act(() => useSettings.setState({ busy: false }))

    fireEvent.click(reachChoice('Off'))
    await act(settle)
    expect(sent()[2]).toEqual({ lan: false, relay: false })
    expect(sent()).toHaveLength(3)
    expect(reachChoice('Off')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Remote access is off')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Keep the Mac awake on power' })).toBeNull()
    expect(within(navButton('remote')).queryByText('On')).toBeNull()

    // With the server switched off it is off, whatever the switches behind it say.
    act(() => useSettings.setState({ server: server({ running: false, config: { ...config, enabled: false, lan: true, relay: true } }) }))
    expect(reachChoice('Off')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Remote access is off')).toBeInTheDocument()
  })

  it('pairing with the server on this computer only explains itself; choosing the home network brings the QR code (same code)', async () => {
    const loopback = ['http://127.0.0.1:7420']
    const withLan = [...loopback, 'http://192.168.1.9:7420']
    installBridge(
      settingsCore({
        'server:createPairingCode': () => ({ code: 'WXYZ-2345', expiresAt: '', urls: loopback }),
        'server:configure': (patch: Record<string, unknown>) => {
          const config = { ...server().config, ...patch }
          return server({ config, urls: config.lan ? withLan : loopback })
        }
      })
    )
    await renderSettings('remote')
    fireEvent.click(screen.getByText('Pair a device'))
    await act(settle)
    expect(window.mindeck!.invoke).toHaveBeenCalledWith('server:createPairingCode', { role: 'member' })
    expect(screen.getByText('WXYZ-2345')).toBeInTheDocument()
    expect(screen.getByText(/Only this computer can connect right now/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Pairing QR code')).toBeNull()

    fireEvent.click(reachChoice('Home network'))
    await act(settle)
    expect(screen.getByText('WXYZ-2345')).toBeInTheDocument()
    expect(screen.getByLabelText('Pairing QR code').innerHTML).toContain('<svg')
    expect(screen.getByText('http://192.168.1.9:7420/#pair=WXYZ-2345')).toBeInTheDocument()
    expect(screen.queryByText(/Only this computer/)).toBeNull()

    // changing settings with no pairing open just updates the server
    fireEvent.click(screen.getByLabelText('Close pairing'))
    await act(settle) // closing re-reads the devices and the server
    fireEvent.click(screen.getByLabelText('Allow remote shells'))
    await act(settle)
    expect(useSettings.getState().pairing).toBeUndefined()
    expect(useSettings.getState().server?.config.remoteTerminal).toBe(true)
  })

  it('HTTPS on the network: the switch, the certificate, a warning without it; the pairing names the certificate', async () => {
    const tls = { fingerprint: FP, spkiFingerprint: PK, expiresAt: '2028-10-14T12:00:00.000Z', selfSigned: true }
    const status = (config: ServerStatus['config']) =>
      server({ config, urls: ['http://127.0.0.1:7420', `${config.tls ? 'https' : 'http'}://192.168.1.9:7420`], ...(config.tls ? { tls } : {}) })
    installBridge(
      settingsCore({
        'server:status': () => status({ ...server().config, lan: true }),
        'server:createPairingCode': () => ({ code: 'WXYZ-2345', expiresAt: '', urls: ['http://127.0.0.1:7420', 'https://192.168.1.9:7420'], fingerprint: FP, spkiFingerprint: PK }),
        'server:configure': (patch: Record<string, unknown>) => status({ ...server().config, lan: true, ...patch })
      })
    )
    await renderSettings('remote')
    expect(reachChoice('Home network')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Certificate (SHA-256)')).toBeInTheDocument()
    expect(screen.getByText(FP)).toBeInTheDocument()
    expect(screen.getByText(/Self-signed by this core · valid until/)).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Encrypted (HTTPS)' })).toBeEnabled()
    expect(screen.queryByText(/Unencrypted:/)).toBeNull()

    fireEvent.click(screen.getByText('Pair a device'))
    await act(settle)
    expect(screen.getByText(`https://192.168.1.9:7420/#pair=WXYZ-2345&fp=${HEX.toLowerCase()}&pk=${PK_HEX.toLowerCase()}`)).toBeInTheDocument()
    expect(screen.getByText(/Continue only if the certificate’s SHA-256 fingerprint is this one/)).toBeInTheDocument()
    expect(screen.getAllByText(FP)).toHaveLength(2)

    // Off: plain HTTP, a warning, and the open pairing follows (no certificate to name).
    fireEvent.click(screen.getByRole('switch', { name: 'Encrypted (HTTPS)' }))
    await act(settle)
    expect(window.mindeck!.invoke).toHaveBeenLastCalledWith('server:configure', { tls: false })
    expect(screen.getByText(/Unencrypted: pairing codes and device tokens cross the network in the clear/)).toBeInTheDocument()
    expect(screen.queryByText('Certificate (SHA-256)')).toBeNull()
    expect(screen.getByText('http://192.168.1.9:7420/#pair=WXYZ-2345')).toBeInTheDocument()
    expect(screen.queryByText(/Continue only if/)).toBeNull()

    // And on again: the link names the certificate (and its key) once more.
    fireEvent.click(screen.getByRole('switch', { name: 'Encrypted (HTTPS)' }))
    await act(settle)
    expect(screen.getByText(`https://192.168.1.9:7420/#pair=WXYZ-2345&fp=${HEX.toLowerCase()}&pk=${PK_HEX.toLowerCase()}`)).toBeInTheDocument()
  })

  it('the certificate’s fingerprint is copied with one click', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const writeText = vi.fn(async (_text: string) => {})
      Object.assign(navigator, { clipboard: { writeText } })
      installBridge(settingsCore({ 'server:status': () => server({ tls: { fingerprint: FP, spkiFingerprint: PK, expiresAt: '2028-10-14T12:00:00.000Z', selfSigned: true } }) }))
      await renderSettings('remote')
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
      await act(settle)
      expect(writeText).toHaveBeenCalledWith(FP)
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600)
      })
      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
      // The clipboard refused: it doesn't claim it copied.
      writeText.mockRejectedValueOnce(new Error('denied'))
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
      await act(settle)
      expect(writeText).toHaveBeenCalledTimes(2)
      expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('away access: the choice, where the link stands (re-read while shown), keeping the Mac awake, pairing through the cloud', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const tls = { fingerprint: FP, spkiFingerprint: PK, expiresAt: '2028-10-14T12:00:00.000Z', selfSigned: true }
      let relay: ServerStatus['relay'] = { state: 'connecting' }
      let config = { ...server().config, relay: true }
      const status = () => server({ config, tls, relay })
      installBridge(
        settingsCore({
          'server:status': () => status(),
          'server:configure': (patch: Record<string, unknown>) => {
            config = { ...config, ...patch }
            return status()
          },
          'server:createPairingCode': () => ({ code: 'WXYZ-2345', expiresAt: '', urls: ['http://127.0.0.1:7420'], fingerprint: FP, spkiFingerprint: PK, installId: 'install-1' })
        })
      )
      await renderSettings('remote')
      expect(reachChoice('Anywhere')).toHaveAttribute('aria-checked', 'true')
      expect(screen.getByRole('switch', { name: 'Reachable while away' })).toBeChecked()
      expect(screen.getByText('Connecting to Mindeck Cloud …')).toBeInTheDocument()
      // Set up for anywhere — but nothing gets here yet (the LAN is off, the cloud link not up).
      expect(screen.getByText('Remote access is off')).toBeInTheDocument()
      // HTTPS is the relay's too: its switch stays usable with the LAN off.
      expect(screen.getByRole('switch', { name: 'Encrypted (HTTPS)' })).toBeEnabled()
      relay = { state: 'online', pipes: 2 }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4100)
      })
      expect(screen.getByText('Reachable through Mindeck Cloud · 2 connections open')).toBeInTheDocument()
      expect(screen.getByText('Reachable from anywhere')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('switch', { name: 'Keep the Mac awake on power' }))
      await act(settle)
      expect(window.mindeck!.invoke).toHaveBeenLastCalledWith('server:configure', { keepAwake: true })

      // With the LAN off the phone pairs through the cloud: the QR code is there, with a word on what the cloud sees.
      fireEvent.click(screen.getByText('Pair a device'))
      await act(settle)
      expect(screen.getByLabelText('Pairing QR code')).toBeInTheDocument()
      // Only through the relay: no address to open, no certificate warning — the app scans it.
      expect(screen.getByText(/Scan it with the Mindeck app: it pairs through Mindeck Cloud/)).toBeInTheDocument()
      expect(screen.queryByText(/127\.0\.0\.1:7420\/#pair=/)).toBeNull()
      expect(screen.queryByText(/Continue only if/)).toBeNull()
      expect(useSettings.getState().pairing?.url).toBe(`http://127.0.0.1:7420/#pair=WXYZ-2345&fp=${HEX.toLowerCase()}&pk=${PK_HEX.toLowerCase()}&ci=install-1`)

      relay = { state: 'off' }
      fireEvent.click(screen.getByRole('switch', { name: 'Reachable while away' }))
      await act(settle)
      expect(window.mindeck!.invoke).toHaveBeenLastCalledWith('server:configure', { relay: false })
      expect(screen.queryByRole('switch', { name: 'Keep the Mac awake on power' })).toBeNull()
      expect(screen.queryByText(/Mindeck Cloud …|Reachable through/)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('with the LAN on as well, the pairing names its address and adds a word on pairing from away', async () => {
    const tls = { fingerprint: FP, spkiFingerprint: PK, expiresAt: '2028-10-14T12:00:00.000Z', selfSigned: true }
    installBridge(
      settingsCore({
        'server:status': () => server({ config: { ...server().config, lan: true, relay: true }, tls, relay: { state: 'online' } }),
        'server:createPairingCode': () => ({ code: 'WXYZ-2345', expiresAt: '', urls: ['http://127.0.0.1:7420', 'https://192.168.1.9:7420'], fingerprint: FP, spkiFingerprint: PK, installId: 'install-1' })
      })
    )
    await renderSettings('remote')
    fireEvent.click(screen.getByText('Pair a device'))
    await act(settle)
    expect(screen.getByText(`https://192.168.1.9:7420/#pair=WXYZ-2345&fp=${HEX.toLowerCase()}&pk=${PK_HEX.toLowerCase()}&ci=install-1`)).toBeInTheDocument()
    expect(screen.getByText(/Away from this Wi-Fi, the app pairs through Mindeck Cloud/)).toBeInTheDocument()
  })

  it('says why away access cannot run — in both languages', async () => {
    const { de } = await import('@/lib/i18n/de')
    for (const dict of [en, de]) {
      const say = dict.settings.relayState
      const lines = [
        say('online', undefined, 0),
        say('online', undefined, 1),
        say('online', undefined, 3),
        say('connecting', undefined, 0),
        ...['signed-out', 'server-off', 'tls-off', 'session-invalid', 'replaced', 'http-502', 'license-required'].map((r) => say('error', r, 0)),
        say('error', undefined, 0)
      ]
      expect(new Set(lines).size).toBe(lines.length)
      expect(lines[6]).toMatch(/HTTPS/)
      expect(lines[9]).toContain('http-502')
    }
    // A status without a relay shows no line; one that failed says why.
    let relay: ServerStatus['relay'] = undefined
    installBridge(settingsCore({ 'server:status': () => server({ config: { ...server().config, relay: true }, relay }) }))
    const { unmount } = await renderSettings('remote')
    expect(screen.queryByText(/Connecting to Mindeck Cloud|Reachable through Mindeck Cloud|cannot be reached/)).toBeNull()
    unmount()
    relay = { state: 'error', reason: 'replaced' }
    render(<SettingsView />)
    await act(settle)
    expect(screen.getByText(/Another Mindeck with this account and data folder took over/)).toBeInTheDocument()
  })

  it('an own certificate from the environment is named as such', async () => {
    installRemote(settingsCore({ 'server:status': () => server({ configurable: false, tls: { fingerprint: FP, spkiFingerprint: PK, expiresAt: '2027-01-01T00:00:00.000Z', selfSigned: false } }) }))
    await renderSettings('remote')
    expect(screen.getByText(/Own certificate · valid until/)).toBeInTheDocument()
  })

  it('AI through the Mindeck account: credit, its model (Sonnet costs more), a key of one’s own wins; suggestions need one', async () => {
    const credit = (over = {}) => ({ period: 'month' as const, allowanceCents: 100, usedCents: 85, remainingCents: 15, renewsAt: '2026-11-01T00:00:00.000Z', ...over })
    const cloudStatus = (over: Record<string, unknown> = {}) => ({
      configured: true,
      source: 'cloud' as const,
      model: 'claude-haiku-5-5',
      cloud: {
        credit: credit(),
        models: [
          { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', costFactor: 1 },
          { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', costFactor: 20 }
        ]
      },
      settings: { model: 'claude-opus-5-5', cloudModel: 'claude-haiku-5-5', effort: 'high' as const, inline: false, inlineModel: 'claude-opus-5-5' },
      ...over
    })
    let fresh: Record<string, unknown> = cloudStatus()
    installBridge(
      settingsCore({
        'ai:status': () => fresh,
        'ai:configure': (p: Record<string, unknown>) => (fresh = { ...fresh, settings: { ...(fresh.settings as object), ...p } })
      })
    )
    useAssistant.setState({ status: undefined })
    useSession.setState({ info: { mode: 'desktop', version: '1.2.3', platform: 'darwin', hostname: 'mac', remoteTerminal: false } })
    await renderSettings('ai')
    expect(screen.getByText('Through your Mindeck account · Claude Haiku 5.5')).toBeInTheDocument()
    expect(screen.getByText('€0.85 of €1.00 used · this month · renews on November 1')).toBeInTheDocument()
    const meter = screen.getByRole('meter', { name: 'AI credit' })
    expect(meter).toHaveAttribute('aria-valuenow', '85')
    expect(meter.firstElementChild).toHaveClass('bg-amber')
    // Sonnet: about 20× the credit.
    fireEvent.click(screen.getByRole('combobox', { name: 'Model (Mindeck account)' }))
    expect(screen.getByRole('option', { name: /Claude Sonnet 5\.5.*about 20× the credit/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: /^Claude Sonnet 5\.5/ }))
    await act(settle)
    expect(useAssistant.getState().status?.settings.cloudModel).toBe('claude-sonnet-5-5')
    // Suggestions while typing: only with a key of one's own.
    expect(screen.getByLabelText('Suggestions while typing')).toBeDisabled()

    // The trial's credit, with room left; a key of one's own takes over.
    act(() => useAssistant.setState({ status: cloudStatus({ source: 'stored', keyHint: 'ABCD', model: 'claude-opus-5-5', cloud: { ...cloudStatus().cloud, credit: credit({ period: 'trial', allowanceCents: 30, usedCents: 3, renewsAt: null }) } }) as never }))
    expect(screen.getByText('€0.03 of €0.30 used · credit of the trial (once)')).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'AI credit' }).firstElementChild).toHaveClass('bg-cyan')
    expect(screen.getByText('Your own API key is set: the assistant uses it instead of this credit.')).toBeInTheDocument()
    expect(screen.getByLabelText('Suggestions while typing')).toBeEnabled()
    expect(screen.queryByText(/switched off for your account/)).not.toBeInTheDocument()
    // An admin switched the cloud AI off for this account.
    act(() => useAssistant.setState({ status: cloudStatus({ cloud: { ...cloudStatus().cloud, blocked: true } }) as never }))
    expect(screen.getByRole('alert')).toHaveTextContent('The AI through Mindeck Cloud is switched off for your account')
    // No credit included at all (a cloud set to 0 €): the meter is full.
    act(() => useAssistant.setState({ status: cloudStatus({ cloud: { ...cloudStatus().cloud, credit: credit({ allowanceCents: 0, usedCents: 0 }) } }) as never }))
    expect(screen.getByRole('meter', { name: 'AI credit' })).toHaveAttribute('aria-valuenow', '100')
    // A model the cloud no longer offers: shown by its id.
    act(() => useAssistant.setState({ status: cloudStatus({ model: 'claude-old-1' }) as never }))
    expect(screen.getByText('Through your Mindeck account · claude-old-1')).toBeInTheDocument()
    act(() => useAssistant.setState({ status: cloudStatus({ cloud: null }) as never }))
    expect(screen.getByText('Through your Mindeck account · claude-haiku-5-5')).toBeInTheDocument()
  })

  it('a key that isn\'t taken stays in the field; a credit that can\'t be read keeps the last one', async () => {
    installBridge(settingsCore({ 'ai:status': () => fail('offline'), 'ai:setKey': () => fail('invalid key') }))
    useAssistant.setState({ status: { configured: true, model: 'claude-opus-5-5', cloud: null, source: 'stored', keyHint: 'ABCD', settings: { model: 'claude-opus-5-5', effort: 'high', inline: false, inlineModel: 'claude-opus-5-5', cloudModel: 'claude-haiku-5-5' } } })
    useSession.setState({ info: { mode: 'desktop', version: '1.2.3', platform: 'darwin', hostname: 'mac', remoteTerminal: false } })
    await renderSettings('ai')
    expect(screen.getByText('Anthropic key stored · …ABCD')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('New API key'), { target: { value: 'sk-bad' } })
    fireEvent.click(screen.getByText('Save'))
    await act(settle)
    expect(screen.getByLabelText('New API key')).toHaveValue('sk-bad')
  })

  it('desktop: AI key, model, effort and suggestions; grants; the server; pairing and devices; the vault; about', async () => {
    let revealFails = false
    const bridge = installBridge(settingsCore({ 'memory:reveal': () => (revealFails ? fail('Finder is busy') : undefined) }))
    localStorage.setItem('mindeck.deviceId', 'd2')
    useAssistant.setState({ status: { configured: true, model: 'claude-opus-5-5', cloud: null, source: 'stored', keyHint: 'ABCD', settings: { model: 'claude-opus-5-5', effort: 'high', inline: false, inlineModel: 'claude-opus-5-5', cloudModel: 'claude-haiku-5-5' } } })
    useSession.setState({ info: { mode: 'desktop', version: '1.2.3', platform: 'darwin', hostname: 'mac', remoteTerminal: false } })
    await renderSettings('ai')

    // AI: with a key of one's own, its fold-out is open
    expect(screen.getByText('Anthropic key stored · …ABCD')).toBeInTheDocument()
    expect(screen.getByText('For heavy use: your own API key').closest('details')).toHaveAttribute('open')
    fireEvent.change(screen.getByLabelText('New API key'), { target: { value: 'sk-new' } })
    fireEvent.click(screen.getByText('Save'))
    await act(settle)
    expect(screen.getByText('Anthropic key stored · …NEW1')).toBeInTheDocument()
    expect(screen.getByLabelText('New API key')).toHaveValue('')
    const effort = within(screen.getByRole('radiogroup', { name: 'Effort' }))
    expect(effort.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Fast', 'Medium', 'High', 'Very high', 'Max'])
    expect(effort.getByRole('radio', { name: 'High' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(effort.getByRole('radio', { name: 'Fast' }))
    await act(settle)
    expect(useAssistant.getState().status?.settings.effort).toBe('low')
    expect(effort.getByRole('radio', { name: 'Fast' })).toHaveAttribute('aria-checked', 'true')
    choose('Model', /^Claude Sonnet 5\.5/)
    await act(settle)
    expect(useAssistant.getState().status?.settings.model).toBe('claude-sonnet-5-5')
    // Suggestions while typing: opt-in, with their own (faster) model.
    expect(screen.getByText(/⌘K in the editor rewrites the selection/)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Suggestions while typing'))
    await act(settle)
    expect(useAssistant.getState().status?.settings.inline).toBe(true)
    choose('Model for suggestions', /^Claude Haiku 5\.5/)
    await act(settle)
    expect(useAssistant.getState().status?.settings.inlineModel).toBe('claude-haiku-5-5')
    // grants live with the agents
    expect(screen.getByText('assistant → memory_create_note')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Remove key'))
    await act(settle)
    expect(screen.getByText('Sign in to your Mindeck account to use the AI')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Not signed in yet.')
    expect(within(screen.getByRole('alert')).queryByRole('button')).toBeNull() // nowhere to sign in from here
    expect(within(navButton('ai')).getByText('Sign in')).toBeInTheDocument()

    // server
    show('remote')
    await act(settle)
    expect(screen.getByText('API server running · 2 devices paired')).toBeInTheDocument()
    expect(screen.getByText('API server running')).toBeInTheDocument() // under the technical details
    fireEvent.click(screen.getByLabelText('Reachable on the local network'))
    await act(settle)
    expect(useSettings.getState().server?.config.lan).toBe(true)
    fireEvent.click(screen.getByLabelText('Allow remote shells'))
    await act(settle)
    expect(bridge.invoke).toHaveBeenLastCalledWith('server:configure', { remoteTerminal: true })
    expect(useSettings.getState().server?.config.remoteTerminal).toBe(true)
    fireEvent.click(screen.getByLabelText('Run the API server'))
    await act(settle)
    expect(bridge.invoke).toHaveBeenLastCalledWith('server:configure', { enabled: false })
    expect(useSettings.getState().server?.config.enabled).toBe(false)
    expect(screen.getByLabelText('Reachable on the local network')).toBeDisabled() // nothing to reach without the server
    // The port: saved on leaving the field or on Enter, kept within 1024–65535.
    const sent = () => bridge.invoke.mock.calls.filter(([channel]) => channel === 'server:configure').length
    const port = screen.getByLabelText('Port')
    fireEvent.change(port, { target: { value: '80' } })
    fireEvent.blur(port)
    await act(settle)
    expect(bridge.invoke).toHaveBeenLastCalledWith('server:configure', { port: 1024 })
    expect(port).toHaveValue(1024)
    fireEvent.change(port, { target: { value: '70000' } })
    fireEvent.keyDown(port, { key: 'Enter' })
    await act(settle)
    expect(bridge.invoke).toHaveBeenLastCalledWith('server:configure', { port: 65535 })
    const before = sent()
    fireEvent.change(port, { target: { value: '' } })
    fireEvent.blur(port) // nothing typed: the port as it is, nothing saved
    expect(port).toHaveValue(65535)
    fireEvent.change(port, { target: { value: '65535' } })
    fireEvent.blur(port) // unchanged: nothing saved
    expect(sent()).toBe(before)
    fireEvent.change(port, { target: { value: '7421' } })
    fireEvent.blur(port)
    await act(settle)
    expect(useSettings.getState().server?.config.port).toBe(7421)

    // pairing (as admin) + devices and their roles
    act(() => useSettings.setState({ server: server() }))
    fireEvent.click(screen.getByLabelText('Pair as admin'))
    fireEvent.click(screen.getByText('Pair a device'))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('server:createPairingCode', { role: 'admin' })
    expect(screen.getByText('ABCD-EFGH')).toBeInTheDocument()
    expect(screen.queryByText('For an admin device')).toBeNull() // the fake core answered a member code
    act(() => useSettings.setState({ pairing: { ...useSettings.getState().pairing!, role: 'admin' } }))
    expect(screen.getByText('For an admin device')).toBeInTheDocument()
    expect(screen.getByLabelText('Pairing QR code').innerHTML).toContain('<svg')
    fireEvent.click(screen.getByLabelText('Close pairing'))
    expect(screen.queryByText('ABCD-EFGH')).toBeNull()
    await act(settle)
    expect(screen.getByText('this browser')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Revoke Pixel Phone'))
    await act(settle)
    expect(screen.queryByText('Pixel Phone')).toBeNull()
    choose('Role of Chrome · macOS', 'Admin')
    await act(settle)
    expect(useSettings.getState().devices[0].role).toBe('admin')

    // vault (desktop: shown in the Finder, chosen with the native picker)
    show('memory')
    await act(settle)
    expect(screen.getByText('/v')).toBeInTheDocument()
    expect(screen.getByText('3 notes · default location')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show in Finder' }))
    await act(settle)
    expect(bridge.invoke.mock.calls.map(([channel]) => channel)).toContain('memory:reveal')
    revealFails = true
    fireEvent.click(screen.getByRole('button', { name: 'Show in Finder' }))
    await act(settle)
    expect(screen.getByText('Finder is busy')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Choose folder…'))
    await act(settle)
    expect(screen.queryByText('Finder is busy')).toBeNull()
    expect(screen.getByText('/picked')).toBeInTheDocument()
    expect(screen.getByText(/Not created yet · custom folder/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show in Finder' })).toBeNull() // nothing there to show yet

    // about
    show('about')
    expect(screen.getByText('1.2.3')).toBeInTheDocument()
    expect(screen.getByText('Desktop app')).toBeInTheDocument()
    expect(screen.getByText('mac (darwin)')).toBeInTheDocument()
    expect(screen.queryByText('Database')).toBeNull() // the core keeps files, no database
    expect(screen.getByText('Desktop window')).toBeInTheDocument()
    useSession.setState({ info: undefined })
  })

  it('desktop: shared folders for paired devices', async () => {
    installBridge(settingsCore())
    await renderSettings('remote')
    // shared folders: added through the folder browser, removed with a click (a core from before has none)
    act(() => useSettings.setState({ server: server({ config: { ...server().config, remoteRoots: undefined as never } }) }))
    expect(screen.getByText('None — only the projects added here')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Add folder…'))
    fireEvent.click(await screen.findByText('Share'))
    await act(settle)
    expect(useSettings.getState().server?.config.remoteRoots).toEqual(['/srv/notes'])
    fireEvent.click(screen.getByText('Add folder…'))
    fireEvent.click(await screen.findByText('Share')) // already shared: nothing changes
    await act(settle)
    fireEvent.click(screen.getByText('Add folder…'))
    fireEvent.click(await screen.findByLabelText('Close'))
    fireEvent.click(screen.getByLabelText('Stop sharing /srv/notes'))
    await act(settle)
    expect(useSettings.getState().server?.config.remoteRoots).toEqual([])
  })

  it('desktop: what each grant holds for, revoked one by one', async () => {
    installBridge(settingsCore())
    await renderSettings('ai')
    act(() =>
      useSettings.setState({
        projects: [{ id: 'p1', name: 'Shop', path: '/p', addedAt: '', lastSeenAt: '' }],
        grants: [
          { agentId: 'assistant', toolName: 'memory_create_note', createdAt: '' },
          { agentId: 'claude-code', toolName: 'Write', projectId: 'p1', createdAt: '' },
          { agentId: 'claude-code', toolName: 'Edit', projectId: 'gone', createdAt: '' },
          { agentId: 'claude-code', toolName: 'Bash', projectId: '*', createdAt: '' }
        ]
      })
    )
    expect(screen.getByText('assistant → memory_create_note')).toBeInTheDocument()
    expect(screen.getByText('Outside projects')).toBeInTheDocument()
    expect(screen.getByText('Shop')).toBeInTheDocument()
    expect(screen.getByText('A removed project')).toBeInTheDocument()
    expect(screen.getByText('All projects (from before grants were per project)')).toHaveClass('text-amber')
    expect(screen.queryByText('None')).toBeNull()
    for (const label of ['assistant memory_create_note · Outside projects', 'claude-code Write · Shop', 'claude-code Edit · A removed project', 'claude-code Bash · All projects (from before grants were per project)']) {
      fireEvent.click(screen.getByLabelText(`Revoke ${label}`))
      await act(settle)
    }
    expect(screen.getByText('None')).toBeInTheDocument() // no standing approvals left
  })

  it('in a browser: an admin device manages devices; a member removes only itself and sees the grants', async () => {
    const devices = (meRole: 'admin' | 'member') => [
      { id: 'me', name: 'This laptop', role: meRole, createdAt: new Date().toISOString() },
      { id: 'phone', name: 'Pixel Phone', role: 'member' as const, createdAt: new Date().toISOString() }
    ]
    localStorage.setItem('mindeck.deviceId', 'me')
    const remote = installRemote(settingsCore({ 'server:devices': () => devices('admin') }))
    useSession.setState({ info: { mode: 'server', version: '1', platform: 'linux', hostname: 'nas', remoteTerminal: false } })
    const { unmount } = await renderSettings('remote')
    expect(screen.getByText('Pair a device')).toBeInTheDocument()
    expect(screen.getByLabelText('Pair as admin')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Role of Pixel Phone' })).toBeInTheDocument()
    expect(screen.getByLabelText('Revoke Pixel Phone')).toBeInTheDocument()
    show('ai')
    await act(settle)
    expect(screen.getByLabelText('Revoke assistant memory_create_note · Outside projects')).toBeInTheDocument()
    unmount()

    remote.routes['server:devices'] = () => devices('member')
    await renderSettings('remote')
    expect(screen.queryByText('Pair a device')).toBeNull()
    expect(screen.queryByLabelText('Pair as admin')).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Role of Pixel Phone' })).toBeNull()
    expect(screen.getAllByText('Member')).toHaveLength(2)
    expect(screen.queryByLabelText('Revoke Pixel Phone')).toBeNull()
    expect(screen.getByLabelText('Revoke This laptop')).toBeInTheDocument() // unpairing itself
    show('ai')
    await act(settle)
    expect(screen.getByText('assistant → memory_create_note')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Revoke assistant/)).toBeNull()
    localStorage.removeItem('mindeck.deviceId')
    useSession.setState({ info: undefined })
  })

  it('in a browser: server settings are read-only, vault via folder browser, errors show', async () => {
    installRemote(
      settingsCore({
        'server:status': () => server({ configurable: false, running: false, error: 'EADDRINUSE', config: { enabled: true, lan: true, tls: true, port: 7420, remoteTerminal: true, remoteRoots: [], relay: false, keepAwake: false } }),
        'server:devices': () => [],
        'memory:setVault': () => fail('That folder does not exist')
      })
    )
    useAssistant.setState({ status: { configured: true, model: 'claude-opus-5-5', cloud: null, source: 'env', keyHint: '9999', settings: { model: 'claude-opus-5-5', effort: 'high', inline: false, inlineModel: 'claude-opus-5-5', cloudModel: 'claude-haiku-5-5' } }, error: 'ai problem' })
    useSession.setState({ info: { mode: 'server', version: '1', platform: 'linux', hostname: 'nas', remoteTerminal: true } })
    await renderSettings('ai')
    expect(screen.getByText('Anthropic key from the environment · …9999')).toBeInTheDocument()
    expect(screen.queryByLabelText('New API key')).toBeNull() // a key from the environment is not set here
    expect(screen.queryByLabelText('Remove key')).toBeNull()

    show('remote')
    await act(settle)
    expect(screen.getByText('API server off')).toBeInTheDocument()
    expect(screen.getByText('API server off · 0 devices paired')).toBeInTheDocument()
    expect(screen.getByText('EADDRINUSE')).toBeInTheDocument()
    expect(screen.getByText(/configured through its environment/)).toBeInTheDocument()
    expect(screen.getByText(/Remote shells: allowed/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Port')).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: S.reachQuestion })).toBeNull()
    expect(screen.getByText('No devices paired')).toBeInTheDocument()
    expect(screen.queryByText('Pair a device')).toBeNull() // not an admin device

    show('about')
    expect(screen.getByText('Server')).toBeInTheDocument()
    expect(screen.getByText('Browser (paired)')).toBeInTheDocument()
    expect(screen.queryByText('Logs')).toBeNull() // the logs stay with the desktop app

    expect(screen.getByText('ai problem')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(useAssistant.getState().error).toBeUndefined()

    show('memory')
    await act(settle)
    fireEvent.click(screen.getByText('Choose folder…'))
    fireEvent.click(await screen.findByText('Use as vault'))
    await act(settle)
    expect(screen.getByText('That folder does not exist')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Choose folder…'))
    fireEvent.click(await screen.findByLabelText('Close'))
    useSession.setState({ info: undefined })
  })

  it('desktop server settings without a configurable server, vault errors and storage failures', async () => {
    installBridge(settingsCore({ 'server:status': () => server({ configurable: false }), 'memory:status': () => fail('vault down'), 'memory:pickVault': () => null }))
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    useAssistant.setState({ status: undefined })
    await renderSettings('ai')
    expect(screen.getByText('Sign in to your Mindeck account to use the AI')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull() // nothing known about the assistant yet: no notice
    show('remote')
    await act(settle)
    expect(screen.getByText(/configured through its environment/)).toBeInTheDocument()
    show('memory')
    await act(settle)
    expect(screen.getByText('vault down')).toBeInTheDocument()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Choose folder…')) // cancelled native picker
    await act(settle)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    get.mockRestore()
    show('remote')
    act(() => useSettings.setState({ server: server({ configurable: true }) }))
    expect(screen.getByLabelText('Port')).toBeInTheDocument()
  })

  it('desktop without editable config: read-only hint names the desktop app', async () => {
    installRemote(settingsCore({ 'server:status': () => server({ configurable: true }) }))
    await renderSettings('remote')
    expect(screen.getByText(/can only be changed in the desktop app/)).toBeInTheDocument()
    act(() => useSettings.setState({ error: 'settings broke' }))
    expect(screen.getByText('settings broke')).toBeInTheDocument()
  })
})

describe('SystemView', () => {
  const snap = (over: Partial<SystemSnapshot> = {}): SystemSnapshot => ({
    cpu: { total: 42, cores: [10, 90, 0, 150] },
    mem: { usedPct: 50, usedGb: 8, totalGb: 16 },
    disk: { usedPct: 70, mount: '/' },
    net: { rxMbps: 1.5, txMbps: 0.25 },
    battery: { pct: 80, charging: true, hasBattery: true },
    uptimeSec: 7200,
    processes: [
      { pid: 1, name: 'node', cpu: 60.4, mem: 120.2 },
      { pid: 2, name: 'idle', cpu: 0.1, mem: 1 }
    ],
    ts: 1,
    ...over
  })

  it('offline without a core; live numbers, cores, processes and battery states', async () => {
    const { unmount } = render(<SystemView />)
    expect(screen.getByText('OFFLINE')).toBeInTheDocument()
    expect(screen.getByText('No data yet')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
    unmount()

    const bridge = installBridge({ 'system:snapshot': () => snap() })
    render(<SystemView />)
    await act(settle)
    expect(screen.getByText('LIVE')).toBeInTheDocument()
    expect(screen.getByText('4 cores')).toBeInTheDocument()
    expect(screen.getByText('8.0 / 16.0 GB')).toBeInTheDocument()
    expect(screen.getByText('↓ 1.50 · ↑ 0.25 MB/s')).toBeInTheDocument()
    expect(screen.getByText('charging')).toBeInTheDocument()
    expect(screen.getByText('60.4').className).toContain('text-cyan')
    expect(screen.getByLabelText('Per-core load').children).toHaveLength(4)
    act(() => bridge.emit('system:tick', snap({ battery: { pct: 50, charging: false, hasBattery: true }, cpu: { total: 1, cores: [] } })))
    expect(screen.getByText('on battery')).toBeInTheDocument()
    expect(screen.queryByLabelText('Per-core load')).toBeNull()
    act(() => bridge.emit('system:tick', snap({ battery: { pct: 0, charging: false, hasBattery: false } })))
    expect(screen.getByText('no battery')).toBeInTheDocument()
    expect(screen.getByText('N/A')).toBeInTheDocument()
  })
})

describe('ContextSection', () => {
  const ctx = (over: Partial<ProjectContext> = {}): ProjectContext => ({
    projectId: 'p1',
    indexedAt: new Date().toISOString(),
    fileCount: 12,
    dirCount: 3,
    truncated: true,
    tree: [],
    languages: [],
    frameworks: [],
    dependencies: [
      { name: 'react', version: '18', dev: false },
      { name: 'vitest', version: '3', dev: true }
    ],
    configFiles: [{ name: 'tsconfig.json', kind: 'TypeScript' }],
    todos: Array.from({ length: 10 }, (_, i) => ({ file: `f${i}.ts`, line: i + 1, kind: i === 0 ? ('FIXME' as const) : ('TODO' as const), text: `item ${i}` })),
    readme: { title: 'Demo', sections: ['Intro', 'Usage'] },
    ...over
  })

  it('analyzes, shows structure, TODOs (open in editor on desktop), reindexes with progress', async () => {
    let resolveIndex!: (c: ProjectContext) => void
    const bridge = installBridge({
      'context:get': () => null,
      'context:reindex': () => new Promise((r) => (resolveIndex = r)),
      'projects:openFile': () => undefined
    })
    render(<ContextSection projectId="p1" />)
    await act(settle)
    expect(screen.getByText(/Not analyzed yet/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Analyze project'))
    expect(screen.getByText('Scanning…')).toBeInTheDocument()
    act(() => bridge.emit('context:progress', { projectId: 'p1', filesScanned: 40, done: false }))
    expect(screen.getByText('Scanning · 40 files')).toBeInTheDocument()
    await act(async () => resolveIndex(ctx()))
    expect(screen.getByText('12 files · 3 folders · scan truncated')).toBeInTheDocument()
    expect(screen.getByText('Demo')).toBeInTheDocument()
    expect(screen.getByText('tsconfig.json')).toBeInTheDocument()
    expect(screen.getByText(/1 runtime · 1 dev/)).toBeInTheDocument()
    expect(screen.getByText('FIXME')).toBeInTheDocument()
    expect(screen.queryByText('item 9')).toBeNull()
    fireEvent.click(screen.getByText('Show all 10'))
    expect(screen.getByText('item 9')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Show fewer'))
    fireEvent.click(screen.getByText('f0.ts:1'))
    expect(bridge.invoke).toHaveBeenCalledWith('projects:openFile', { id: 'p1', file: 'f0.ts', line: 1 })
    bridge.invoke.mockRejectedValueOnce(new Error('gone')) // a file that went away: nothing to show
    fireEvent.click(screen.getByText('f0.ts:1'))
    await act(settle)
    expect(screen.getByText('Reindex')).toBeInTheDocument()
  })

  it('in a browser TODOs are plain text; minimal contexts and errors with retry', async () => {
    installRemote({ 'context:get': () => ({ ...ctx(), readme: { sections: [] }, configFiles: [], dependencies: [], todos: [{ file: 'a.ts', line: 2, kind: 'HACK', text: 'x' }], truncated: false }) })
    render(<ContextSection projectId="p2" />)
    await act(settle)
    expect(screen.getByText('a.ts:2').tagName).toBe('SPAN')
    expect(screen.getByText('12 files · 3 folders')).toBeInTheDocument()
    expect(screen.queryByText(/Dependencies/)).toBeNull()

    const failing = installRemote({ 'context:get': () => fail('scan broke') })
    render(<ContextSection projectId="p3" />)
    await act(settle)
    expect(screen.getByText(/scan broke/)).toBeInTheDocument()
    failing.routes['context:get'] = (() => null) as never
    fireEvent.click(screen.getByText('retry'))
    await act(settle)
    expect(screen.getByText(/Not analyzed yet/)).toBeInTheDocument()
    act(() => useContextStore.setState({ byProject: { p3: { loading: true, indexing: false } } }))
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    act(() => useContextStore.setState({ byProject: { p3: { loading: false, indexing: false, context: ctx({ readme: { title: 'T', sections: [] }, dependencies: [{ name: 'd', version: '1', dev: true }] }) } } }))
    expect(screen.getByText('T')).toBeInTheDocument()
    expect(screen.getByText(/0 runtime · 1 dev/)).toBeInTheDocument()
  })
})

describe('pairing link from the QR code', () => {
  it('prefills the code from #pair= and removes it from the URL', () => {
    history.replaceState(null, '', '/#pair=abcd-efgh')
    expect(linkFromHash()).toEqual({ code: 'ABCD-EFGH', fingerprint: null })
    expect(location.hash).toBe('')
    expect(linkFromHash()).toEqual({ code: '', fingerprint: null })
    history.replaceState(null, '', '/#pair=wxyz2345')
    render(<PairScreen />)
    expect(screen.getByLabelText('Pairing code')).toHaveValue('WXYZ-2345')
    expect(screen.queryByText('Check the certificate')).toBeNull()
  })

  it('a broken link (bad percent-encoding) shows an empty form instead of crashing — and is gone from the URL', () => {
    history.replaceState(null, '', '/#pair=%E0%A4%A')
    expect(linkFromHash()).toEqual({ code: '', fingerprint: null })
    expect(location.hash).toBe('')
    history.replaceState(null, '', '/#pair=%E0%A4%A')
    render(<PairScreen />)
    expect(screen.getByLabelText('Pairing code')).toHaveValue('')
  })

  it('asks to compare the certificate the browser warned about with the fingerprint from the QR code', () => {
    history.replaceState(null, '', `/#pair=wxyz2345&fp=${HEX.toLowerCase()}`)
    render(<PairScreen />)
    expect(location.hash).toBe('')
    expect(screen.getByLabelText('Pairing code')).toHaveValue('WXYZ-2345')
    expect(screen.getByText('Check the certificate')).toBeInTheDocument()
    expect(screen.getByLabelText('Check the certificate')).toHaveTextContent(FP)
    expect(screen.getByText(/compare its SHA-256 fingerprint/)).toBeInTheDocument()
    // A damaged fingerprint is none.
    history.replaceState(null, '', '/#pair=wxyz2345&fp=1234')
    expect(linkFromHash()).toEqual({ code: 'WXYZ-2345', fingerprint: null })
  })

  it('links name the core, the code and the certificate — and can be taken apart again (native clients)', () => {
    expect(normalizeFingerprint(FP)).toBe(HEX)
    expect(normalizeFingerprint(HEX.toLowerCase().replace(/(..)/g, '$1 '))).toBe(HEX)
    expect(normalizeFingerprint('AB:CD')).toBeNull()
    expect(formatFingerprint(HEX.toLowerCase())).toBe(FP)
    expect(FP).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(formatFingerprint('nope')).toBe('')

    expect(pairingLink('https://10.0.0.2:7420/', 'ABCD-EFGH', FP)).toBe(`https://10.0.0.2:7420/#pair=ABCD-EFGH&fp=${HEX.toLowerCase()}`)
    expect(pairingLink('http://10.0.0.2:7420', 'ABCD-EFGH')).toBe('http://10.0.0.2:7420/#pair=ABCD-EFGH')
    expect(pairingLink('http://10.0.0.2:7420', 'X', 'not a fingerprint')).toBe('http://10.0.0.2:7420/#pair=X')
    expect(pairingLink('https://10.0.0.2:7420', 'X', FP, PK)).toBe(`https://10.0.0.2:7420/#pair=X&fp=${HEX.toLowerCase()}&pk=${PK_HEX.toLowerCase()}`)
    // The key only alongside the certificate (an older client reads `fp` alone), never a broken one.
    expect(pairingLink('https://10.0.0.2:7420', 'X', undefined, PK)).toBe('https://10.0.0.2:7420/#pair=X')
    expect(pairingLink('https://10.0.0.2:7420', 'X', FP, 'nope')).toBe(`https://10.0.0.2:7420/#pair=X&fp=${HEX.toLowerCase()}`)

    expect(parsePairingLink(` https://10.0.0.2:7420/#pair=ABCD-EFGH&fp=${HEX.toLowerCase()} `)).toEqual({ baseUrl: 'https://10.0.0.2:7420', code: 'ABCD-EFGH', fingerprint: FP })
    expect(parsePairingLink('http://nas.local:7420#pair=AB%20CD')).toEqual({ baseUrl: 'http://nas.local:7420', code: 'AB CD' })
    expect(parsePairingLink(`https://10.0.0.2:7420/#pair=X&fp=${HEX}&pk=${PK_HEX.toLowerCase()}`)).toEqual({ baseUrl: 'https://10.0.0.2:7420', code: 'X', fingerprint: FP, spkiFingerprint: PK })
    expect(parsePairingLink(`https://10.0.0.2:7420/#pair=X&pk=${PK_HEX}`)).toEqual({ baseUrl: 'https://10.0.0.2:7420', code: 'X' })
    expect(parsePairingLink('http://nas.local:7420/#pair=X&fp=zz')).toEqual({ baseUrl: 'http://nas.local:7420', code: 'X' })
    expect(parsePairingLink('http://nas.local:7420/')).toBeNull()
    expect(parsePairingLink('http://nas.local:7420/#fp=00')).toBeNull()
    expect(parsePairingLink('ftp://x/#pair=X')).toBeNull()
  })
})

describe('Appearance', () => {
  it('switches mode, accent and background at once — and back to the defaults', () => {
    useAppearance.getState().reset()
    const root = document.documentElement
    render(<AppearanceCard />)
    const reset = screen.getByRole('button', { name: /Reset to default/ })
    expect(reset).toBeDisabled()

    expect(screen.getByText('Surfaces, lines and grid in the accent color.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Neon pink' }))
    expect(root.dataset.accent).toBe('pink')
    expect(screen.getByRole('radio', { name: 'Neon pink' })).toHaveAttribute('aria-checked', 'true')
    expect(root.style.getPropertyValue('--border-hud')).toBe(surfaceTokens('cyber', 'pink')['--border-hud'])
    fireEvent.click(screen.getByRole('radio', { name: 'Graphite' }))
    expect(root.style.getPropertyValue('--bg-void')).toBe(surfaceTokens('graphite', 'pink')['--bg-void'])
    expect(screen.getByText('Neutral grey, no tint.')).toBeInTheDocument()
    expect(reset).toBeEnabled()

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(root.dataset.theme).toBe('light')
    expect(screen.getByText('Applies to dark mode.')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Graphite' })).toBeDisabled()

    fireEvent.click(reset)
    expect({ ...root.dataset }).toEqual({ theme: 'dark', accent: 'cyan', surface: 'cyber' })
  })

  it('in the settings: mode, accent and background at once — the background only in dark mode — and back to the defaults', async () => {
    useAppearance.getState().reset()
    installBridge(settingsCore())
    await renderSettings('general')
    const root = document.documentElement
    const reset = screen.getByRole('button', { name: 'Reset to default' })
    expect(reset).toBeDisabled()
    expect(screen.getByRole('radiogroup', { name: 'Language / Sprache' })).toBeInTheDocument()

    const accent = within(screen.getByRole('radiogroup', { name: 'Accent color' }))
    expect(screen.getByText('Cyan')).toBeInTheDocument() // the accent's name beside it
    fireEvent.click(accent.getByRole('radio', { name: 'Neon pink' }))
    expect(root.dataset.accent).toBe('pink')
    expect(accent.getByRole('radio', { name: 'Neon pink' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Neon pink')).toBeInTheDocument()
    expect(screen.getByText('Applies to dark mode. Surfaces, lines and grid in the accent color.')).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Background' })).getByRole('radio', { name: 'Graphite' }))
    expect(root.style.getPropertyValue('--bg-void')).toBe(surfaceTokens('graphite', 'pink')['--bg-void'])
    expect(screen.getByText('Applies to dark mode. Neutral grey, no tint.')).toBeInTheDocument()
    expect(reset).toBeEnabled()

    const mode = within(screen.getByRole('radiogroup', { name: 'Mode' }))
    expect(mode.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(mode.getByRole('radio', { name: 'Light' }))
    expect(root.dataset.theme).toBe('light')
    expect(mode.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('radiogroup', { name: 'Background' })).toBeNull()

    fireEvent.click(reset)
    expect({ ...root.dataset }).toEqual({ theme: 'dark', accent: 'cyan', surface: 'cyber' })
    expect(reset).toBeDisabled()
  })
})

describe('Browser settings', () => {
  it('only in the desktop window; nothing to set before the core answered', async () => {
    installBridge(settingsCore({ 'browser:settings': () => fail('no core') }))
    await renderSettings('browser')
    expect(openTitle()).toBe('Browser')
    expect(screen.queryByRole('combobox', { name: 'Search engine' })).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    // (A paired browser doesn't list the section at all — see the navigation's tests.)
  })

  it('picks the search engine, the tab bar and where links open, and clears the history', async () => {
    let current: BrowserSettings = { ...DEFAULT_BROWSER_SETTINGS }
    const configure = vi.fn((patch: Partial<BrowserSettings>) => (current = { ...current, ...patch }))
    let clearFails = true
    installBridge(
      settingsCore({
        'browser:settings': () => current,
        'browser:configure': configure,
        'browser:clearHistory': () => (clearFails ? fail('busy') : undefined)
      })
    )
    await renderSettings('browser')
    expect(screen.getByRole('combobox', { name: 'Search engine' })).toHaveTextContent('Google')
    choose('Search engine', 'DuckDuckGo')
    await act(settle)
    expect(configure).toHaveBeenLastCalledWith({ searchEngine: 'duckduckgo' })
    expect(screen.getByRole('combobox', { name: 'Search engine' })).toHaveTextContent('DuckDuckGo')
    expect(useBrowser.getState().settings?.searchEngine).toBe('duckduckgo') // the browser module follows
    fireEvent.click(screen.getByRole('switch', { name: 'Open links in Mindeck' }))
    await act(settle)
    expect(configure).toHaveBeenLastCalledWith({ openLinksInMindeck: false })
    expect(screen.getByRole('switch', { name: 'Open links in Mindeck' })).not.toBeChecked()
    const tabs = within(screen.getByRole('radiogroup', { name: 'Tab bar' }))
    expect(tabs.getByRole('radio', { name: 'Top' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(tabs.getByRole('radio', { name: 'Side' }))
    await act(settle)
    expect(configure).toHaveBeenLastCalledWith({ verticalTabs: true })
    expect(tabs.getByRole('radio', { name: 'Side' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(tabs.getByRole('radio', { name: 'Top' }))
    await act(settle)
    expect(configure).toHaveBeenLastCalledWith({ verticalTabs: false })
    fireEvent.click(screen.getByRole('button', { name: 'Clear history' })) // fails: stays as it was
    await act(settle)
    expect(screen.getByRole('button', { name: 'Clear history' })).toBeInTheDocument()
    clearFails = false
    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }))
    await act(settle)
    expect(screen.getByRole('button', { name: 'History cleared' })).toBeInTheDocument()
    configure.mockImplementation(() => fail('bad engine'))
    choose('Search engine', 'Kagi') // a refused change keeps the old value
    await act(settle)
    expect(screen.getByRole('combobox', { name: 'Search engine' })).toHaveTextContent('DuckDuckGo')
  })
})
