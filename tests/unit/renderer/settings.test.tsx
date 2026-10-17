import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, installBridge, installRemote, settle, choose } from './bridge'
import type { ServerStatus } from '@shared/types/server'
import type { SystemSnapshot } from '@shared/types/system'
import type { ProjectContext } from '@shared/types/context'
import { canManage, isLoopback, myDeviceId, pairingReachable, pairingUrl, useSettings } from '@/features/settings/store'
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
import { BrowserCard } from '@/features/settings/components/BrowserCard'
import { surfaceTokens, useAppearance } from '@/lib/theme'

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
  config: { enabled: true, lan: false, tls: true, port: 7420, remoteTerminal: false, remoteRoots: [] },
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
  })

  it('knows when a phone could reach the core at all', () => {
    expect(['http://localhost', 'http://127.0.0.1:1/x', 'http://[::1]:7420', 'http://localhost.example.com'].map(isLoopback)).toEqual([true, true, true, false])
    expect(pairingReachable(['http://127.0.0.1:7420'])).toBe(false)
    expect(pairingReachable(['http://127.0.0.1:7420'], 'http://localhost:5173')).toBe(false)
    expect(pairingReachable(['http://127.0.0.1:7420'], 'http://nas.local:7420')).toBe(true)
    expect(pairingReachable(['http://127.0.0.1:7420'], 'http://nas.local:7420', true)).toBe(false)
    expect(pairingReachable(['http://127.0.0.1:7420', 'http://192.168.1.9:7420'], undefined, true)).toBe(true)
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

describe('SettingsView', () => {
  it('lists the coding agents on this machine and checks again on request', async () => {
    const detect = vi.fn()
      .mockResolvedValueOnce([
        { kind: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.287', signedIn: true, account: 'Pro plan', ready: true },
        { kind: 'codex', name: 'Codex', installed: true, ready: false, hint: 'Coming to Mindeck soon' }
      ])
      .mockResolvedValueOnce([{ kind: 'claude-code', name: 'Claude Code', installed: true, ready: true }])
    installBridge(settingsCore({ 'agents:detect': detect }))
    render(<SettingsView />)
    await act(settle)
    expect(screen.getByText('Coding agents')).toBeInTheDocument()
    expect(screen.getByText('Pro plan · v2.1.287')).toBeInTheDocument()
    expect(screen.getByText('Coming to Mindeck soon')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Check again'))
    await act(settle)
    expect(detect).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Codex')).toBeNull()
  })

  it('the composer\'s send key and pushes to the phone (with a Mindeck account)', async () => {
    const setPush = vi.fn(({ enabled }: { enabled: boolean }) => ({ enabled, signedIn: true }))
    installBridge(settingsCore({ 'agents:pushSettings': () => ({ enabled: true, signedIn: true }), 'agents:setPushSettings': setPush }))
    render(<SettingsView />)
    await act(settle)
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
    const { unmount } = render(<SettingsView />)
    await act(settle)
    expect(screen.getByRole('switch', { name: 'Notifications on your phone' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Notifications on your phone' })).not.toBeChecked()
    expect(screen.getByText(/Sign in to your Mindeck account to get them/)).toBeInTheDocument()
    unmount()

    installBridge(settingsCore({ 'agents:pushSettings': () => ({ enabled: true, signedIn: true }), 'agents:setPushSettings': () => fail('core down') }))
    const second = render(<SettingsView />)
    await act(settle)
    fireEvent.click(screen.getByRole('switch', { name: 'Notifications on your phone' }))
    await act(settle)
    expect(screen.getByRole('switch', { name: 'Notifications on your phone' })).toBeChecked()
    second.unmount()

    installBridge(settingsCore({ 'agents:pushSettings': () => fail('core down') }))
    render(<SettingsView />)
    await act(settle)
    expect(screen.queryByRole('switch', { name: 'Notifications on your phone' })).toBeNull()
  })

  it('pairing without the LAN explains itself; switching the LAN on brings the QR code (same code)', async () => {
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
    render(<SettingsView />)
    await act(settle)
    fireEvent.click(screen.getByText('Pair a device'))
    await act(settle)
    expect(screen.getByText('WXYZ-2345')).toBeInTheDocument()
    expect(screen.getByText(/Only this computer can connect right now/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Pairing QR code')).toBeNull()

    fireEvent.click(screen.getByLabelText('Reachable on the local network'))
    await act(settle)
    expect(screen.getByText('WXYZ-2345')).toBeInTheDocument()
    expect(screen.getByLabelText('Pairing QR code').innerHTML).toContain('<svg')
    expect(screen.getByText('http://192.168.1.9:7420/#pair=WXYZ-2345')).toBeInTheDocument()
    expect(screen.queryByText(/Only this computer/)).toBeNull()

    // changing settings with no pairing open just updates the server
    fireEvent.click(screen.getByLabelText('Close pairing'))
    fireEvent.click(screen.getByLabelText('Allow remote shells'))
    await act(settle)
    expect(useSettings.getState().pairing).toBeUndefined()
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
    render(<SettingsView />)
    await act(settle)
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

  it('an own certificate from the environment is named as such', async () => {
    installRemote(settingsCore({ 'server:status': () => server({ configurable: false, tls: { fingerprint: FP, spkiFingerprint: PK, expiresAt: '2027-01-01T00:00:00.000Z', selfSigned: false } }) }))
    render(<SettingsView />)
    await act(settle)
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
    render(<SettingsView />)
    await act(settle)
    expect(screen.getByText('Through your Mindeck account · Claude Haiku 5.5')).toBeInTheDocument()
    expect(screen.getByText('€0.85 of €1.00 used')).toBeInTheDocument()
    expect(screen.getByText('this month · renews on November 1')).toBeInTheDocument()
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
    expect(screen.getByText('credit of the trial (once)')).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'AI credit' }).firstElementChild).toHaveClass('bg-cyan')
    expect(screen.getByText('Your own API key is set: the assistant uses it instead of this credit.')).toBeInTheDocument()
    expect(screen.getByLabelText('Suggestions while typing')).toBeEnabled()
    expect(screen.queryByText(/switched off for your account/)).not.toBeInTheDocument()
    // An admin switched the cloud AI off for this account.
    act(() => useAssistant.setState({ status: cloudStatus({ cloud: { ...cloudStatus().cloud, blocked: true } }) as never }))
    expect(screen.getByRole('status')).toHaveTextContent('The AI through Mindeck Cloud is switched off for your account')
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
    render(<SettingsView />)
    await act(settle)
    expect(screen.getByText('Anthropic key stored · …ABCD')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('New API key'), { target: { value: 'sk-bad' } })
    fireEvent.click(screen.getByText('Save'))
    await act(settle)
    expect(screen.getByLabelText('New API key')).toHaveValue('sk-bad')
  })

  it('desktop: AI key + model, server toggles, pairing, devices, grants, vault, about', async () => {
    installBridge(settingsCore())
    localStorage.setItem('mindeck.deviceId', 'd2')
    useAssistant.setState({ status: { configured: true, model: 'claude-opus-5-5', cloud: null, source: 'stored', keyHint: 'ABCD', settings: { model: 'claude-opus-5-5', effort: 'high', inline: false, inlineModel: 'claude-opus-5-5', cloudModel: 'claude-haiku-5-5' } } })
    useSession.setState({ info: { mode: 'desktop', version: '1.2.3', platform: 'darwin', hostname: 'mac', remoteTerminal: false } })
    render(<SettingsView />)
    await act(settle)

    // AI
    expect(screen.getByText('Anthropic key stored · …ABCD')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('New API key'), { target: { value: 'sk-new' } })
    fireEvent.click(screen.getByText('Save'))
    await act(settle)
    expect(screen.getByText('Anthropic key stored · …NEW1')).toBeInTheDocument()
    expect(screen.getByLabelText('New API key')).toHaveValue('')
    choose('Effort', 'low')
    await act(settle)
    expect(useAssistant.getState().status?.settings.effort).toBe('low')
    choose('Model', /^Claude Sonnet 5\.5/)
    await act(settle)
    // Suggestions while typing: opt-in, with their own (faster) model.
    expect(screen.getByText(/⌘K in the editor rewrites the selection/)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Suggestions while typing'))
    await act(settle)
    expect(useAssistant.getState().status?.settings.inline).toBe(true)
    choose('Model for suggestions', /^Claude Haiku 5\.5/)
    await act(settle)
    expect(useAssistant.getState().status?.settings.inlineModel).toBe('claude-haiku-5-5')
    fireEvent.click(screen.getByLabelText('Remove key'))
    await act(settle)
    expect(screen.getByText('Sign in to your Mindeck account to use the AI')).toBeInTheDocument()

    // server
    expect(screen.getByText('API server running')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Reachable on the local network'))
    await act(settle)
    expect(useSettings.getState().server?.config.lan).toBe(true)
    fireEvent.click(screen.getByLabelText('Allow remote shells'))
    fireEvent.click(screen.getByLabelText('Run the API server'))
    await act(settle)
    const port = screen.getByLabelText('Port')
    fireEvent.change(port, { target: { value: '80' } })
    fireEvent.blur(port) // below 1024: ignored
    fireEvent.change(port, { target: { value: '7421' } })
    fireEvent.blur(port)
    await act(settle)

    // pairing (as admin) + devices and their roles
    act(() => useSettings.setState({ server: server() }))
    fireEvent.click(screen.getByLabelText('Pair as admin'))
    fireEvent.click(screen.getByText('Pair a device'))
    await act(settle)
    expect(window.mindeck!.invoke).toHaveBeenCalledWith('server:createPairingCode', { role: 'admin' })
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

    // grants
    expect(screen.getByText('assistant → memory_create_note')).toBeInTheDocument()

    // vault (desktop: native picker)
    expect(screen.getByText('/v')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Choose folder…'))
    await act(settle)
    expect(screen.getByText('/picked')).toBeInTheDocument()
    expect(screen.getByText(/Not created yet · custom folder/)).toBeInTheDocument()

    // about
    expect(screen.getByText('Desktop app')).toBeInTheDocument()
    expect(screen.queryByText('Database')).toBeNull() // the core keeps files, no database
    expect(screen.getByText('Desktop window')).toBeInTheDocument()
    useSession.setState({ info: undefined })
  })

  it('desktop: shared folders for paired devices', async () => {
    installBridge(settingsCore())
    render(<SettingsView />)
    await act(settle)
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
    render(<SettingsView />)
    await act(settle)
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
    for (const label of ['assistant memory_create_note · Outside projects', 'claude-code Write · Shop', 'claude-code Edit · A removed project', 'claude-code Bash · All projects (from before grants were per project)']) {
      fireEvent.click(screen.getByLabelText(`Revoke ${label}`))
      await act(settle)
    }
    expect(screen.getByText('No standing permissions')).toBeInTheDocument()

  })

  it('in a browser: an admin device manages devices; a member removes only itself and sees the grants', async () => {
    const devices = (meRole: 'admin' | 'member') => [
      { id: 'me', name: 'This laptop', role: meRole, createdAt: new Date().toISOString() },
      { id: 'phone', name: 'Pixel Phone', role: 'member' as const, createdAt: new Date().toISOString() }
    ]
    localStorage.setItem('mindeck.deviceId', 'me')
    const remote = installRemote(settingsCore({ 'server:devices': () => devices('admin') }))
    useSession.setState({ info: { mode: 'server', version: '1', platform: 'linux', hostname: 'nas', remoteTerminal: false } })
    const { unmount } = render(<SettingsView />)
    await act(settle)
    expect(screen.getByText('Pair a device')).toBeInTheDocument()
    expect(screen.getByLabelText('Pair as admin')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Role of Pixel Phone' })).toBeInTheDocument()
    expect(screen.getByLabelText('Revoke Pixel Phone')).toBeInTheDocument()
    expect(screen.getByLabelText('Revoke assistant memory_create_note · Outside projects')).toBeInTheDocument()
    unmount()

    remote.routes['server:devices'] = () => devices('member')
    render(<SettingsView />)
    await act(settle)
    expect(screen.queryByText('Pair a device')).toBeNull()
    expect(screen.queryByLabelText('Pair as admin')).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Role of Pixel Phone' })).toBeNull()
    expect(screen.getAllByText('Member')).toHaveLength(2)
    expect(screen.queryByLabelText('Revoke Pixel Phone')).toBeNull()
    expect(screen.getByLabelText('Revoke This laptop')).toBeInTheDocument() // unpairing itself
    expect(screen.getByText('assistant → memory_create_note')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Revoke assistant/)).toBeNull()
    localStorage.removeItem('mindeck.deviceId')
    useSession.setState({ info: undefined })
  })

  it('in a browser: server settings are read-only, vault via folder browser, errors show', async () => {
    installRemote(
      settingsCore({
        'server:status': () => server({ configurable: false, running: false, error: 'EADDRINUSE', config: { enabled: true, lan: true, tls: true, port: 7420, remoteTerminal: true, remoteRoots: [] } }),
        'server:devices': () => [],
        'memory:setVault': () => fail('That folder does not exist')
      })
    )
    useAssistant.setState({ status: { configured: true, model: 'claude-opus-5-5', cloud: null, source: 'env', keyHint: '9999', settings: { model: 'claude-opus-5-5', effort: 'high', inline: false, inlineModel: 'claude-opus-5-5', cloudModel: 'claude-haiku-5-5' } }, error: 'ai problem' })
    useSession.setState({ info: { mode: 'server', version: '1', platform: 'linux', hostname: 'nas', remoteTerminal: true } })
    render(<SettingsView />)
    await act(settle)
    expect(screen.getByText('Anthropic key from the environment · …9999')).toBeInTheDocument()
    expect(screen.queryByLabelText('New API key')).toBeNull()
    expect(screen.getByText('API server off')).toBeInTheDocument()
    expect(screen.getByText('EADDRINUSE')).toBeInTheDocument()
    expect(screen.getByText(/configured through its environment/)).toBeInTheDocument()
    expect(screen.getByText(/Remote shells: allowed/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Port')).toBeNull()
    expect(screen.getByText('No devices paired')).toBeInTheDocument()
    expect(screen.queryByText('Pair a device')).toBeNull() // not an admin device
    expect(screen.getByText('Server')).toBeInTheDocument()
    expect(screen.getByText('Browser (paired)')).toBeInTheDocument()

    expect(screen.getByText('ai problem')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(useAssistant.getState().error).toBeUndefined()

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
    render(<SettingsView />)
    await act(settle)
    expect(screen.getByText('Sign in to your Mindeck account to use the AI')).toBeInTheDocument()
    expect(screen.getByText(/configured through its environment/)).toBeInTheDocument()
    expect(screen.getByText('vault down')).toBeInTheDocument()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Choose folder…')) // cancelled native picker
    await act(settle)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    get.mockRestore()
    act(() => useSettings.setState({ server: server({ configurable: true }) }))
    expect(screen.getByLabelText('Port')).toBeInTheDocument()
  })

  it('desktop without editable config: read-only hint names the desktop app', async () => {
    installRemote(settingsCore({ 'server:status': () => server({ configurable: true }) }))
    render(<SettingsView />)
    await act(settle)
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
    expect(screen.getByText('60.4').className).toContain('text-amber')
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
})

describe('BrowserCard', () => {
  it('shows nothing outside the desktop app, or before the core answered', async () => {
    const { container } = render(<BrowserCard />)
    expect(container).toBeEmptyDOMElement()
    installBridge({ 'browser:settings': () => fail('no core') })
    render(<BrowserCard />)
    await act(settle)
    expect(container).toBeEmptyDOMElement()
  })

  it('picks the search engine and where links open, and clears the history', async () => {
    let current = { searchEngine: 'google', openLinksInMindeck: true }
    const configure = vi.fn((patch: Partial<typeof current>) => (current = { ...current, ...patch }))
    let clearFails = true
    installBridge({
      'browser:settings': () => current,
      'browser:configure': configure,
      'browser:clearHistory': () => (clearFails ? fail('busy') : undefined)
    })
    render(<BrowserCard />)
    await act(settle)
    expect(screen.getByRole('combobox', { name: 'Search engine' })).toHaveTextContent('Google')
    choose('Search engine', 'DuckDuckGo')
    await act(settle)
    expect(configure).toHaveBeenLastCalledWith({ searchEngine: 'duckduckgo' })
    expect(screen.getByRole('combobox', { name: 'Search engine' })).toHaveTextContent('DuckDuckGo')
    fireEvent.click(screen.getByRole('switch', { name: 'Open links in Mindeck' }))
    await act(settle)
    expect(configure).toHaveBeenLastCalledWith({ openLinksInMindeck: false })
    expect(screen.getByRole('switch', { name: 'Open links in Mindeck' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Clear history' })) // fails: stays as it was
    await act(settle)
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
