import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { UpdateStatus } from '@shared/types/server'
import { useUpdate } from '@/features/update/store'
import { UpdateChip } from '@/features/update/components/UpdateChip'
import { AccountView } from '@/features/account/components/AccountView'
import { useLocale } from '@/lib/i18n'
import { fail, installBridge, installRemote, settle } from './bridge'

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({ state: 'idle', currentVersion: '0.1.0', ...over })

beforeEach(() => {
  act(() => useLocale.setState({ locale: 'en' }))
  useUpdate.setState({ status: null, error: null })
})

describe('update store', () => {
  it('loads and follows the status on the desktop', async () => {
    const bridge = installBridge({ 'update:status': () => status() })
    const off = useUpdate.getState().connect()
    await settle()
    expect(useUpdate.getState().status).toEqual(status())
    act(() => bridge.emit('update:status', status({ state: 'ready', version: '0.2.0' })))
    expect(useUpdate.getState().status?.state).toBe('ready')
    off()
    expect(bridge.listenerCount('update:status')).toBe(0)
  })

  it('stays quiet in a browser and when the core has no updater', async () => {
    installRemote()
    useUpdate.getState().connect()()
    installBridge({ 'update:status': () => fail('unknown', 'unknown-channel') })
    useUpdate.getState().connect()
    await settle()
    expect(useUpdate.getState().status).toBeNull()
  })

  it('checks and installs, keeping errors readable', async () => {
    const bridge = installBridge({ 'update:check': () => status({ state: 'checking' }), 'update:install': () => fail('No update is ready') })
    await useUpdate.getState().check()
    expect(useUpdate.getState().status?.state).toBe('checking')
    await useUpdate.getState().install()
    expect(useUpdate.getState().error).toBe('No update is ready')
    bridge.routes['update:check'] = () => fail('offline')
    await useUpdate.getState().check()
    expect(useUpdate.getState().error).toBe('offline')
  })
})

describe('UpdateChip', () => {
  it('appears only when an update waits for a restart', async () => {
    const bridge = installBridge({ 'update:status': () => status() })
    render(<UpdateChip />)
    await settle()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    act(() => bridge.emit('update:status', status({ state: 'ready', version: '0.2.0' })))
    fireEvent.click(screen.getByRole('button', { name: 'Update 0.2.0 · restart' }))
    await settle()
    expect(bridge.invoke).toHaveBeenCalledWith('update:install', undefined)
    act(() => useUpdate.setState({ status: status({ state: 'ready', version: undefined }) }))
    expect(screen.getByRole('button', { name: 'Update · restart' })).toBeInTheDocument()
  })

  it('a .deb install: a new version links to its download', () => {
    installBridge({ 'update:status': () => status() })
    render(<UpdateChip />)
    const url = 'https://github.com/robin7mh/mindeck/releases/download/v0.2.0/Mindeck.deb'
    act(() => useUpdate.setState({ status: status({ state: 'available', version: '0.2.0', downloadUrl: url }) }))
    expect(screen.getByRole('link', { name: 'New version 0.2.0 · download' })).toHaveAttribute('href', url)
    act(() => useUpdate.setState({ status: status({ state: 'available', downloadUrl: url }) }))
    expect(screen.getByRole('link', { name: 'New version · download' })).toBeInTheDocument()
    act(() => useUpdate.setState({ status: status({ state: 'available' }) }))
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})

describe('profile update row', () => {
  const row = () => screen.getByText('Update').parentElement!

  it('shows every state with the fitting action', async () => {
    const bridge = installBridge()
    render(<AccountView />)
    expect(screen.queryByText('Update')).not.toBeInTheDocument()

    act(() => useUpdate.setState({ status: status({ state: 'disabled' }) }))
    expect(row()).toHaveTextContent('Automatic in the installed app')
    expect(row().querySelector('button')).toBeNull()

    act(() => useUpdate.setState({ status: status() }))
    expect(row()).toHaveTextContent('Up to date')
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    await settle()
    expect(bridge.invoke).toHaveBeenCalledWith('update:check', undefined)

    act(() => useUpdate.setState({ status: status({ state: 'checking' }), error: null }))
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled()
    expect(row()).toHaveTextContent('Checking for updates…')

    act(() => useUpdate.setState({ status: status({ state: 'downloading', progress: 37 }) }))
    expect(row()).toHaveTextContent('Downloading update… 37 %')
    expect(row().querySelector('button')).toBeNull()
    act(() => useUpdate.setState({ status: status({ state: 'downloading' }) }))
    expect(row()).toHaveTextContent('Downloading update… 0 %')

    act(() => useUpdate.setState({ status: status({ state: 'error', error: 'x' }) }))
    expect(row()).toHaveTextContent('Update failed')
    act(() => useUpdate.setState({ error: 'feed down' }))
    expect(row()).toHaveTextContent('feed down')

    act(() => useUpdate.setState({ status: status({ state: 'ready', version: '0.2.0' }), error: null }))
    expect(row()).toHaveTextContent('Version 0.2.0 is ready')
    fireEvent.click(screen.getByRole('button', { name: 'Restart & update' }))
    await settle()
    expect(bridge.invoke).toHaveBeenCalledWith('update:install', undefined)
    act(() => useUpdate.setState({ status: status({ state: 'ready' }) }))
    expect(row()).toHaveTextContent('Version is ready')

    // A .deb install downloads the new version itself.
    const url = 'https://github.com/robin7mh/mindeck/releases/download/v0.3.0/Mindeck.deb'
    act(() => useUpdate.setState({ status: status({ state: 'available', version: '0.3.0', downloadUrl: url }) }))
    expect(row()).toHaveTextContent('Version 0.3.0 is out — download it to update')
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', url)
    act(() => useUpdate.setState({ status: status({ state: 'available' }) }))
    expect(row()).toHaveTextContent('Version is out')
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeInTheDocument()
  })
})
