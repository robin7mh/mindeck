import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { offlineDaysLeft, OFFLINE_WARN_DAYS, type CloudStatus } from '@shared/types/cloud'
import { cloudError, formatDuration, useCloud } from '@/features/cloud/store'
import { CloudNotice, SignInForm } from '@/features/cloud/components/CloudForms'
import { CloudScreen, LicenseGate } from '@/features/cloud/components/LicenseGate'
import { OfflineChip } from '@/features/cloud/components/OfflineChip'
import { useWorkspace } from '@/features/workspace/store'
import { AccountView } from '@/features/account/components/AccountView'
import { SideNavigation } from '@/components/nav/SideNavigation'
import { useLocale } from '@/lib/i18n'
import { fail, installBridge, OPEN_CLOUD, settle } from './bridge'

const status = (over: Partial<CloudStatus> = {}): CloudStatus => ({ ...(OPEN_CLOUD as CloudStatus), ...over })
const ACCOUNT = { email: 'robin@mindeck.test', name: 'Robin' }
const TRIAL = { plan: 'trial' as const, trialLimitSeconds: 25_200, trialUsedSeconds: 3_600, trialRemainingSeconds: 21_600 }
const LIFETIME = { ...TRIAL, plan: 'lifetime' as const }
const locked = (state: CloudStatus['state'], over: Partial<CloudStatus> = {}) =>
  status({ enforced: true, allowed: false, state, account: state === 'signed_out' ? null : ACCOUNT, ...over })

beforeEach(() => {
  act(() => useLocale.setState({ locale: 'en' }))
  useCloud.setState({ status: null, loadError: null, busy: false, message: null, checkoutUrl: null })
})

describe('helpers', () => {
  it('translates cloud errors by code', () => {
    expect(cloudError(Object.assign(new Error('raw'), { code: 'invalid_credentials' }))).toBe('Email or password is wrong.')
    expect(cloudError(Object.assign(new Error('raw text'), { code: 'something_new' }))).toBe('raw text')
    expect(cloudError(new Error('plain'))).toBe('plain')
  })

  it('warns about the offline certificate in its last 30 days only', () => {
    const now = Date.parse('2026-10-17T12:00:00Z')
    const at = (days: number) => ({ offlineUntil: new Date(now + days * 86_400_000).toISOString() })
    expect(OFFLINE_WARN_DAYS).toBe(30)
    expect(offlineDaysLeft({ offlineUntil: null }, now)).toBeNull()
    expect(offlineDaysLeft(at(200), now)).toBeNull()
    expect(offlineDaysLeft(at(30), now)).toBeNull()
    expect(offlineDaysLeft(at(29.5), now)).toBe(29)
    expect(offlineDaysLeft(at(12.2), now)).toBe(12)
    expect(offlineDaysLeft(at(0.5), now)).toBe(0)
    expect(offlineDaysLeft(at(-3), now)).toBe(0)
    expect(offlineDaysLeft({ offlineUntil: new Date(Date.now() + 5.5 * 86_400_000).toISOString() })).toBe(5) // the clock by default
  })

  it('formats trial time', () => {
    expect(formatDuration(6 * 3600 + 12 * 60 + 59)).toBe('6 h 12 min')
    expect(formatDuration(45 * 60)).toBe('45 min')
    expect(formatDuration(-5)).toBe('0 min')
  })
})

describe('cloud store', () => {
  it('loads the status, follows updates and unsubscribes', async () => {
    const bridge = installBridge({ 'cloud:status': () => locked('signed_out') })
    const off = useCloud.getState().connect()
    await settle()
    expect(useCloud.getState().status?.state).toBe('signed_out')
    act(() => bridge.emit('cloud:status', locked('trial_expired')))
    expect(useCloud.getState().status?.state).toBe('trial_expired')
    off()
    expect(bridge.listenerCount('cloud:status')).toBe(0)
  })

  it('remembers a failed load', async () => {
    installBridge({ 'cloud:status': () => fail('core gone') })
    await useCloud.getState().load()
    expect(useCloud.getState().loadError).toBe('core gone')
  })

  it('runs account actions with their payloads and results', async () => {
    const bridge = installBridge({
      'cloud:login': () => locked('checking'),
      'cloud:register': () => locked('email_unverified'),
      'cloud:logout': () => locked('signed_out'),
      'cloud:refresh': () => status({ state: 'active', account: ACCOUNT }),
      'cloud:checkout': () => ({ url: 'https://checkout.stripe.test/1' })
    })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const s = useCloud.getState()

    expect(await s.login(' robin@mindeck.test ', 'pw')).toBe(true)
    expect(bridge.invoke).toHaveBeenLastCalledWith('cloud:login', { email: 'robin@mindeck.test', password: 'pw' })
    expect(useCloud.getState().status?.state).toBe('checking')

    act(() => useLocale.setState({ locale: 'de' }))
    await s.register('new@mindeck.test', 'long enough!', '  Robin ')
    expect(bridge.invoke).toHaveBeenLastCalledWith('cloud:register', { email: 'new@mindeck.test', password: 'long enough!', name: 'Robin', locale: 'de' })
    await s.register('new@mindeck.test', 'long enough!', '   ')
    expect(bridge.invoke).toHaveBeenLastCalledWith('cloud:register', { email: 'new@mindeck.test', password: 'long enough!', locale: 'de' })

    await s.forgot(' a@b.de ')
    expect(bridge.invoke).toHaveBeenLastCalledWith('cloud:forgotPassword', { email: 'a@b.de' })
    expect(useCloud.getState().message).toEqual({ kind: 'info', text: expect.stringContaining('Falls es ein Konto') })
    act(() => useLocale.setState({ locale: 'en' }))

    await s.resend()
    expect(useCloud.getState().message?.text).toContain('Sent.')
    await s.refresh()
    expect(useCloud.getState()).toMatchObject({ status: { state: 'active' }, message: null })
    await s.buy()
    expect(open).toHaveBeenCalledWith('https://checkout.stripe.test/1', '_blank', 'noopener,noreferrer')
    expect(useCloud.getState()).toMatchObject({ checkoutUrl: 'https://checkout.stripe.test/1', message: { kind: 'info' } })
    await s.logout()
    expect(useCloud.getState().status?.state).toBe('signed_out')
    s.clearMessage()
    expect(useCloud.getState().message).toBeNull()
  })

  it('shows what went wrong and stays usable', async () => {
    installBridge({ 'cloud:login': () => fail('nope', 'invalid_credentials') })
    expect(await useCloud.getState().login('a@b.de', 'x')).toBe(false)
    expect(useCloud.getState()).toMatchObject({ busy: false, message: { kind: 'error', text: 'Email or password is wrong.', code: 'invalid_credentials' } })
  })

  it('too many devices: says so in the UI language', async () => {
    installBridge({ 'cloud:login': () => fail('Signed in on 3 computers already', 'device_limit') })
    await useCloud.getState().login('a@b.de', 'x')
    expect(useCloud.getState().message).toMatchObject({ code: 'device_limit', text: expect.stringContaining('Remove one under Devices') })
    act(() => useLocale.setState({ locale: 'de' }))
    await useCloud.getState().login('a@b.de', 'x')
    expect(useCloud.getState().message!.text).toContain('Entferne eines unter „Geräte“')
  })
})

describe('CloudNotice', () => {
  it('shows the last message, else why the cloud signed the user out', () => {
    const { container, rerender } = render(<CloudNotice />)
    expect(container).toBeEmptyDOMElement()
    act(() => useCloud.setState({ status: locked('signed_out', { error: 'session_expired' }) }))
    rerender(<CloudNotice />)
    expect(screen.getByRole('alert')).toHaveTextContent('You were signed out')
    act(() => useCloud.setState({ status: locked('signed_out', { error: 'weird_code' }) }))
    expect(container).toBeEmptyDOMElement()
    act(() => useCloud.setState({ message: { kind: 'info', text: 'Sent.' } }))
    expect(screen.getByRole('status')).toHaveTextContent('Sent.')
    act(() => useCloud.setState({ message: { kind: 'error', text: 'Bad.' } }))
    expect(screen.getByRole('alert')).toHaveTextContent('Bad.')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('device limit: links the website’s device list once the core knows where it is', () => {
    act(() => useCloud.setState({ status: locked('signed_out'), message: { kind: 'error', text: 'Too many.', code: 'device_limit' } }))
    const { rerender } = render(<CloudNotice />)
    expect(screen.getByRole('alert')).toHaveTextContent('Too many.')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    act(() => useCloud.setState({ status: locked('signed_out', { webUrl: 'https://mindeck.test' }) }))
    rerender(<CloudNotice />)
    expect(screen.getByRole('link', { name: 'Manage devices' })).toHaveAttribute('href', 'https://mindeck.test/account')
  })
})

describe('SignInForm', () => {
  it('signs in, creates an account, or asks for a reset link', async () => {
    const bridge = installBridge({ 'cloud:login': () => locked('checking'), 'cloud:register': () => locked('email_unverified') })
    render(<SignInForm />)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'robin@mindeck.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await settle()
    expect(bridge.invoke).toHaveBeenLastCalledWith('cloud:login', { email: 'robin@mindeck.test', password: 'pw' })

    act(() => useCloud.setState({ message: { kind: 'error', text: 'old' } }))
    fireEvent.click(screen.getByRole('button', { name: 'No account yet? Create one' }))
    expect(useCloud.getState().message).toBeNull()
    expect(screen.getByRole('form', { name: 'Create account' })).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toHaveAttribute('minLength', '10')
    fireEvent.change(screen.getByLabelText('Name (optional)'), { target: { value: 'Robin' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'long enough!' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await settle()
    expect(bridge.invoke).toHaveBeenLastCalledWith('cloud:register', expect.objectContaining({ name: 'Robin', password: 'long enough!' }))

    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }))
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Send link' }))
    await settle()
    expect(bridge.invoke).toHaveBeenLastCalledWith('cloud:forgotPassword', { email: 'robin@mindeck.test' })
    expect(screen.getByRole('status')).toHaveTextContent('a link is on its way')
  })

  it('is disabled while busy', () => {
    useCloud.setState({ busy: true })
    render(<SignInForm />)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
  })
})

describe('LicenseGate', () => {
  it('shows the app when Mindeck may run, a check while loading, and a retry when the core does not answer', async () => {
    const bridge = installBridge({ 'cloud:status': () => fail('no core') })
    render(
      <LicenseGate>
        <div>app</div>
      </LicenseGate>
    )
    expect(screen.getByText('Checking your license…')).toBeInTheDocument()
    await settle()
    expect(screen.getByText('no core')).toBeInTheDocument()
    bridge.routes['cloud:status'] = () => status()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('app')).toBeInTheDocument()
  })

  it('asks a signed-out user to sign in before anything else', async () => {
    installBridge({ 'cloud:status': () => locked('signed_out') })
    render(
      <LicenseGate>
        <div>app</div>
      </LicenseGate>
    )
    expect(await screen.findByRole('form', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByText('app')).not.toBeInTheDocument()
  })

  it('covers the open app when the license ends — the app stays mounted with its state', async () => {
    installBridge({ 'cloud:status': () => status({ enforced: true, allowed: true, state: 'active', account: ACCOUNT }) })
    const mounts = vi.fn()
    function App() {
      const [n, setN] = useState(0)
      useEffect(() => mounts(), [])
      return <button onClick={() => setN(n + 1)}>clicked {n}</button>
    }
    render(
      <LicenseGate>
        <App />
      </LicenseGate>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'clicked 0' }))
    act(() => useCloud.setState({ status: locked('trial_expired') }))
    expect(screen.getByText('Your trial is over')).toBeInTheDocument()
    expect(screen.getByText('clicked 1').closest('[inert]')).not.toBeNull()
    act(() => useCloud.setState({ status: status({ enforced: true, allowed: true, state: 'active', account: ACCOUNT }) }))
    expect(screen.queryByText('Your trial is over')).not.toBeInTheDocument()
    expect(screen.getByText('clicked 1').closest('[inert]')).toBeNull()
    expect(mounts).toHaveBeenCalledTimes(1)
  })
})

describe('CloudScreen', () => {
  const show = (s: CloudStatus) => render(<CloudScreen status={s} />)

  it('offline: check again or sign out', async () => {
    const bridge = installBridge({ 'cloud:refresh': () => locked('offline'), 'cloud:logout': () => locked('signed_out') })
    useCloud.setState({ checkoutUrl: 'https://checkout.stripe.test/1' })
    show(locked('offline'))
    expect(screen.getByText('Mindeck Cloud unreachable')).toBeInTheDocument()
    expect(screen.queryByText('Open checkout')).not.toBeInTheDocument()
    expect(screen.getByText('robin@mindeck.test')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await settle()
    expect(bridge.invoke).toHaveBeenCalledWith('cloud:refresh', undefined)
    expect(bridge.invoke).toHaveBeenCalledWith('cloud:logout', undefined)
  })

  it('unconfirmed email: names the address, resends, checks again', async () => {
    const bridge = installBridge()
    show(locked('email_unverified'))
    expect(screen.getByText(/We sent a link to robin@mindeck.test/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }))
    await settle()
    expect(bridge.invoke).toHaveBeenCalledWith('cloud:resendVerification', undefined)
  })

  it('trial over: buy (with a fallback link to the checkout) or check again', async () => {
    const bridge = installBridge({ 'cloud:checkout': () => ({ url: 'https://checkout.stripe.test/9' }) })
    vi.spyOn(window, 'open').mockReturnValue(null)
    show(locked('trial_expired'))
    fireEvent.click(screen.getByRole('button', { name: 'Buy lifetime license' }))
    expect(await screen.findByRole('link', { name: 'Open checkout' })).toHaveAttribute('href', 'https://checkout.stripe.test/9')
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await settle()
    expect(bridge.invoke).toHaveBeenCalledWith('cloud:refresh', undefined)
  })

  it('a disputed payment: the license is paused — nothing to buy, check again or sign out', async () => {
    const bridge = installBridge()
    show(locked('license_suspended', { license: LIFETIME }))
    expect(screen.getByText('Payment disputed — license paused')).toBeInTheDocument()
    expect(screen.getByText(/was disputed \(a chargeback\)/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Buy lifetime license' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await settle()
    expect(bridge.invoke).toHaveBeenCalledWith('cloud:refresh', undefined)
    act(() => useLocale.setState({ locale: 'de' }))
    expect(screen.getByText('Zahlung angefochten – Lizenz pausiert')).toBeInTheDocument()
  })

  it('waits while checking; keeps buttons off while busy; works without a known account', () => {
    installBridge()
    const { rerender } = show(locked('checking'))
    expect(screen.getByText('Checking your license…')).toBeInTheDocument()
    useCloud.setState({ busy: true })
    rerender(<CloudScreen status={locked('offline', { account: null })} />)
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled()
    expect(screen.queryByText('robin@mindeck.test')).not.toBeInTheDocument()
    rerender(<CloudScreen status={locked('email_unverified', { account: null })} />)
    expect(screen.getByText(/We sent a link to \./)).toBeInTheDocument()
  })
})

describe('AccountView account card', () => {
  const card = () => within(screen.getByText('Mindeck account').closest('section')!)

  it('a trial account: name, email, time left, buy / check again / sign out', async () => {
    const bridge = installBridge({ 'cloud:checkout': () => ({ url: 'https://x' }) })
    vi.spyOn(window, 'open').mockReturnValue(null)
    useCloud.setState({ status: status({ enforced: true, state: 'active', account: ACCOUNT, license: TRIAL }) })
    render(<AccountView />)
    expect(card().getByText('Robin')).toBeInTheDocument()
    expect(card().getByText('robin@mindeck.test')).toBeInTheDocument()
    expect(card().getByText('Trial')).toBeInTheDocument()
    expect(card().getByText('6 h 0 min of trial left')).toBeInTheDocument()
    expect(card().getByRole('progressbar')).toHaveAttribute('aria-valuenow', '14')
    expect(card().queryByText(/Developer build/)).not.toBeInTheDocument()
    for (const name of ['Buy lifetime license', 'Check again', 'Sign out']) {
      fireEvent.click(card().getByRole('button', { name }))
      await settle() // one action at a time: the others wait while it runs
    }
    expect(bridge.invoke).toHaveBeenCalledWith('cloud:checkout', undefined)
    expect(bridge.invoke).toHaveBeenCalledWith('cloud:refresh', undefined)
    expect(bridge.invoke).toHaveBeenCalledWith('cloud:logout', undefined)
  })

  it('a lifetime account: offline window instead of trial time, no buy button', () => {
    act(() => useLocale.setState({ locale: 'de' }))
    useCloud.setState({
      status: status({ state: 'active', account: { ...ACCOUNT, name: null }, license: LIFETIME, validUntil: '2026-10-24T10:00:00.000Z' })
    })
    render(<AccountView />)
    expect(screen.getAllByText('robin@mindeck.test')).toHaveLength(1)
    expect(screen.getByText('Lifetime')).toBeInTheDocument()
    expect(screen.getByText('Funktioniert offline bis 24.10.2026')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Lifetime-Lizenz kaufen' })).not.toBeInTheDocument()
    expect(screen.getByText(/Entwickler-Build/)).toBeInTheDocument()
  })

  it('a lifetime account on its offline certificate: how long it holds — and a warning in its last 30 days', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'))
    useCloud.setState({
      status: status({ state: 'active', account: ACCOUNT, license: LIFETIME, validUntil: '2026-10-31T12:00:00.000Z', offlineUntil: '2027-09-01T12:00:00.000Z' })
    })
    const { unmount } = render(<AccountView />)
    expect(screen.getByText('Works offline until Sep 1, 2027')).toBeInTheDocument()
    expect(screen.queryByText(/offline certificate runs out/)).not.toBeInTheDocument()
    unmount()
    for (const [until, when] of [['2026-11-03T12:00:00.000Z', 'in 17 days'], ['2026-10-18T13:00:00.000Z', 'in 1 day'], ['2026-10-17T13:00:00.000Z', 'within a day']]) {
      useCloud.setState({ status: status({ state: 'active', account: ACCOUNT, license: LIFETIME, validUntil: null, offlineUntil: until }) })
      const view = render(<AccountView />)
      expect(screen.getByRole('status')).toHaveTextContent(`The offline certificate runs out ${when}`)
      view.unmount()
    }
    act(() => useLocale.setState({ locale: 'de' }))
    render(<AccountView />)
    expect(screen.getByRole('status')).toHaveTextContent('Das Offline-Zertifikat läuft in weniger als einem Tag ab')
    vi.useRealTimers()
  })

  it('a paused lifetime license (disputed payment) says so on the card', () => {
    useCloud.setState({ status: status({ state: 'license_suspended', account: ACCOUNT, license: LIFETIME }) })
    render(<AccountView />)
    expect(screen.getByRole('status')).toHaveTextContent('Payment disputed — license paused.')
  })

  it('without a license yet, or a lifetime license not yet confirmed offline', () => {
    useCloud.setState({ status: status({ state: 'checking', account: ACCOUNT, license: null }) })
    const { unmount } = render(<AccountView />)
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByText('Trial')).not.toBeInTheDocument()
    unmount()
    useCloud.setState({ status: status({ state: 'active', account: ACCOUNT, license: LIFETIME, validUntil: null }), busy: true })
    render(<AccountView />)
    expect(screen.queryByText(/Works offline/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled()
  })

  it('signed out: the sign-in form (plus the dev-build hint where no license is needed)', () => {
    useCloud.setState({ status: status() })
    const { unmount } = render(<AccountView />)
    expect(screen.getByRole('form', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByText(/Developer build/)).toBeInTheDocument()
    unmount()
    useCloud.setState({ status: locked('signed_out') })
    render(<AccountView />)
    expect(screen.queryByText(/Developer build/)).not.toBeInTheDocument()
  })
})

describe('OfflineChip', () => {
  it('shows in the top bar in the certificate’s last 30 days and opens the profile', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'))
    const { container, rerender } = render(<OfflineChip />)
    expect(container).toBeEmptyDOMElement() // no status yet
    act(() => useCloud.setState({ status: status({ offlineUntil: '2027-10-17T12:00:00.000Z' }) }))
    expect(container).toBeEmptyDOMElement()
    act(() => useCloud.setState({ status: status({ offlineUntil: '2026-10-27T12:00:00.000Z' }) }))
    rerender(<OfflineChip />)
    const show = vi.spyOn(useWorkspace.getState(), 'show')
    fireEvent.click(screen.getByRole('button', { name: 'Offline license ends in 10 days' }))
    expect(show).toHaveBeenCalledWith('account')
    act(() => useCloud.setState({ status: status({ offlineUntil: '2026-10-18T13:00:00.000Z' }) }))
    expect(screen.getByRole('button', { name: 'Offline license ends in 1 day' })).toBeInTheDocument()
    act(() => useCloud.setState({ status: status({ offlineUntil: '2026-10-17T13:00:00.000Z' }) }))
    expect(screen.getByRole('button', { name: 'Offline license ends within a day' })).toBeInTheDocument()
    act(() => useLocale.setState({ locale: 'de' }))
    expect(screen.getByRole('button', { name: 'Offline-Lizenz endet in weniger als einem Tag' })).toBeInTheDocument()
    act(() => useCloud.setState({ status: status({ offlineUntil: '2026-10-18T13:00:00.000Z' }) }))
    expect(screen.getByRole('button', { name: 'Offline-Lizenz endet in 1 Tag' })).toBeInTheDocument()
    act(() => useCloud.setState({ status: status({ offlineUntil: '2026-10-27T12:00:00.000Z' }) }))
    expect(screen.getByRole('button', { name: 'Offline-Lizenz endet in 10 Tagen' })).toBeInTheDocument()
    vi.useRealTimers()
  })
})

describe('SideNavigation profile tab', () => {
  it('shows who is signed in', () => {
    const { rerender } = render(<SideNavigation active="core" onSelect={() => {}} />)
    expect(screen.getByText('Not signed in')).toBeInTheDocument()
    act(() => useCloud.setState({ status: status({ account: ACCOUNT }) }))
    rerender(<SideNavigation active="core" onSelect={() => {}} />)
    expect(screen.getByText('Robin')).toBeInTheDocument()
    expect(screen.getByText('robin@mindeck.test')).toBeInTheDocument()
    act(() => useCloud.setState({ status: status({ account: { ...ACCOUNT, name: null } }) }))
    expect(screen.getByText('Profile')).toBeInTheDocument()
  })
})
