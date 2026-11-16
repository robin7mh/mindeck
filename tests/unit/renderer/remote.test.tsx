import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, installBridge, settle } from './bridge'
import type { RemoteConnection } from '@shared/types/remote'

vi.mock('@/features/editor/components/CodeEditor', () => ({ default: () => <div data-testid="monaco" /> }))
vi.mock('@/features/editor/components/DiffView', () => ({ default: () => <div data-testid="diff" /> }))

import { isActive, useRemote } from '@/features/remote/store'
import { RemoteMenu } from '@/features/remote/components/RemoteMenu'
import { EditorView } from '@/features/editor/components/EditorView'
import { useEditor } from '@/features/editor/store'
import { useScm } from '@/features/editor/scm'
import { allCommands } from '@/features/palette/registry'
import { en } from '@/lib/i18n/en'
import { useProjects } from '@/features/projects/store'
import { ProjectsView } from '@/features/projects/components/ProjectsView'

const initial = useRemote.getState()
const r = () => useRemote.getState()
const conn = (over: Partial<RemoteConnection> = {}): RemoteConnection => ({ id: 'ssh:box', kind: 'ssh', label: 'box', state: 'ready', url: 'http://127.0.0.1:1', ...over })

function remote(over: Record<string, (p: never) => unknown> = {}) {
  return installBridge({
    'remote:list': () => [conn()],
    'remote:hosts': () => [{ name: 'box', hostName: '10.0.0.5', user: 'robin', port: 2222 }, { name: 'pi' }, { name: 'db', hostName: 'db.local' }],
    'remote:ssh': ({ target }: { target: string }) => conn({ id: `ssh:${target}`, label: target }),
    'remote:container': () => conn({ id: 'container:/p', kind: 'container', label: 'Container: app' }),
    'remote:hasContainer': ({ projectId }: { projectId: string }) => projectId === 'p',
    'remote:disconnect': () => undefined,
    ...over
  })
}

beforeEach(() => {
  useRemote.setState(initial, true)
})

describe('remote store', () => {
  it('follows the connections; starts, stops; failures show', async () => {
    const bridge = remote()
    const stop = r().connect()
    await settle()
    expect(r().connections).toEqual([conn()])
    act(() => bridge.emit('remote:changed', [conn({ state: 'failed', error: 'x' })]))
    expect(r().connections[0].state).toBe('failed')
    await r().loadHosts()
    expect(r().hosts).toHaveLength(3)
    await r().ssh('robin@box:2222')
    await r().container('p')
    await r().disconnect('ssh:box')
    expect(bridge.invoke).toHaveBeenCalledWith('remote:ssh', { target: 'robin@box:2222' })
    expect(bridge.invoke).toHaveBeenCalledWith('remote:container', { projectId: 'p' })
    expect(await r().hasContainer('p')).toBe(true)
    stop()
    expect(bridge.listenerCount('remote:changed')).toBe(0)

    remote({ 'remote:ssh': () => fail('ssh: Could not resolve hostname nope'), 'remote:hasContainer': () => fail('nope'), 'remote:list': () => fail('desktop only') })
    r().connect()
    await settle()
    await r().ssh('nope')
    expect(r().error).toBe('ssh: Could not resolve hostname nope')
    expect(await r().hasContainer('x')).toBe(false)
    r().clearError()
    expect(r().error).toBeUndefined()
    expect([isActive(conn()), isActive(conn({ state: 'installing' })), isActive(conn({ state: 'closed' })), isActive(conn({ state: 'failed' }))]).toEqual([true, true, false, false])
  })
})

describe('remote menu', () => {
  it('hosts from ~/.ssh/config, a typed target, the project’s Dev Container, the connections', async () => {
    const bridge = remote({ 'remote:list': () => [conn(), conn({ id: 'container:/p', kind: 'container', label: 'Container: app', state: 'installing' }), conn({ id: 'ssh:old', label: 'old', state: 'failed', error: 'exit 255' })] })
    render(<RemoteMenu project={{ id: 'p', name: 'app' }} />)
    await act(settle)
    const button = screen.getByRole('button', { name: /Remote/ })
    expect(button).toHaveTextContent('2') // two active
    fireEvent.click(button)
    await act(settle)
    const menu = screen.getByRole('dialog', { name: 'Remote' })
    expect(within(menu).getByRole('button', { name: /box\s*robin@10\.0\.0\.5:2222/ })).toBeInTheDocument()
    expect(within(menu).getByRole('button', { name: /^pi$/ })).toBeInTheDocument()
    expect(within(menu).getByRole('button', { name: /db\s*db\.local$/ })).toBeInTheDocument()
    fireEvent.click(within(menu).getByRole('button', { name: /^pi$/ }))
    expect(bridge.invoke).toHaveBeenCalledWith('remote:ssh', { target: 'pi' })

    expect(within(menu).getByRole('button', { name: 'Connect' })).toBeDisabled()
    fireEvent.change(within(menu).getByLabelText('user@host[:port]'), { target: { value: ' robin@10.0.0.9:22 ' } })
    fireEvent.click(within(menu).getByRole('button', { name: 'Connect' }))
    expect(bridge.invoke).toHaveBeenCalledWith('remote:ssh', { target: 'robin@10.0.0.9:22' })
    fireEvent.change(within(menu).getByLabelText('user@host[:port]'), { target: { value: '  ' } })
    fireEvent.submit(within(menu).getByLabelText('user@host[:port]').closest('form')!)
    expect(bridge.invoke.mock.calls.filter((c) => c[0] === 'remote:ssh')).toHaveLength(2)

    fireEvent.click(within(menu).getByRole('button', { name: 'app in its Dev Container' }))
    expect(bridge.invoke).toHaveBeenCalledWith('remote:container', { projectId: 'p' })

    expect(within(menu).getByText('connected')).toBeInTheDocument()
    expect(within(menu).getByText('installing Mindeck there …')).toBeInTheDocument()
    expect(within(menu).getByText('failed: exit 255')).toBeInTheDocument()
    expect(within(menu).queryByRole('button', { name: 'Disconnect old' })).toBeNull()
    fireEvent.click(within(menu).getByRole('button', { name: 'Disconnect box' }))
    expect(bridge.invoke).toHaveBeenCalledWith('remote:disconnect', { id: 'ssh:box' })

    act(() => useRemote.setState({ error: 'Docker is not running' }))
    expect(within(menu).getByRole('alert')).toHaveTextContent('Docker is not running')
    fireEvent.click(within(menu).getByRole('button', { name: 'Dismiss' }))
    expect(within(menu).queryByRole('alert')).toBeNull()
    // A click elsewhere closes it; a click inside doesn't.
    fireEvent.mouseDown(menu)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('no hosts, no container, no connections; without a project', async () => {
    remote({ 'remote:hosts': () => [], 'remote:list': () => [] })
    const { unmount } = render(<RemoteMenu project={{ id: 'q', name: 'other' }} />)
    fireEvent.click(screen.getByRole('button', { name: /Remote/ }))
    await act(settle)
    expect(screen.getByText('No hosts in ~/.ssh/config.')).toBeInTheDocument()
    expect(screen.queryByText('other in its Dev Container')).toBeNull()
    expect(screen.queryByText('Connections')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Remote/ })) // toggles closed
    expect(screen.queryByRole('dialog')).toBeNull()
    unmount()
    render(<RemoteMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Remote/ }))
    await act(settle)
    expect(screen.queryByText(/in its Dev Container/)).toBeNull()
  })

  it('sits in the Projects header on the desktop', async () => {
    remote({ 'projects:list': () => [], 'remote:list': () => [] })
    useProjects.setState({ projects: [], selectedId: undefined })
    render(<ProjectsView onNavigate={vi.fn()} />)
    await act(settle)
    expect(screen.getByRole('button', { name: /Remote/ })).toBeInTheDocument()
  })
})

describe('remote in the command palette', () => {
  it('connect to a host (picked or typed) and open the project in its Dev Container', async () => {
    const bridge = remote({
      'files:list': () => [],
      'files:stat': () => [],
      'scm:status': () => ({ repo: false, ahead: 0, behind: 0, merging: false, files: [] }),
      'debug:session': () => null,
      'liveServer:status': () => []
    })
    useEditor.setState({ projectId: 'p' })
    useProjects.setState({ projects: [{ id: 'p', name: 'Demo', path: '/x/p', addedAt: '', lastSeenAt: '' }] })
    render(<EditorView active onNavigate={vi.fn()} />)
    await act(settle)
    // The editor's commands, as the palette (⇧⌘P) lists and runs them.
    const pick = (label: string) => void allCommands(en).find((c) => c.label.startsWith(label))!.run()
    pick('Remote: Connect to SSH host')
    await act(settle)
    const items = useScm.getState().pick!.items
    expect(items.map((i) => `${i.label}|${i.detail ?? ''}`)).toEqual(['box|robin@10.0.0.5', 'pi|', 'db|db.local'])
    await act(() => items[0].run() as Promise<void>)
    expect(bridge.invoke).toHaveBeenCalledWith('remote:ssh', { target: 'box' })
    await act(() => useScm.getState().pick!.onText!('robin@1.2.3.4') as Promise<void>)
    expect(bridge.invoke).toHaveBeenCalledWith('remote:ssh', { target: 'robin@1.2.3.4' })
    act(() => useScm.setState({ pick: undefined, quickOpen: false }))
    pick('Remote: Open project in Dev Container')
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('remote:container', { projectId: 'p' })
  })
})
