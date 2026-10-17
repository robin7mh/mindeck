import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, installBridge, installRemote, settle } from './bridge'
import { currentTransport, ipc, isDesktop, onEvent, onResync, setTransport } from '@shared/ipc/client'
import {
  bridgeTransport,
  createRemoteTransport,
  eventsProtocols,
  eventsUrl,
  pairDevice,
  probeCore,
  type LinkState
} from '@shared/ipc/transport'
import { defaultDeviceName, useSession } from '@/features/session/store'
import { SessionGate } from '@/features/session/components/SessionGate'
import { formatCode } from '@/features/session/components/PairScreen'
import { FolderPicker } from '@/components/ui/FolderPicker'
import { ProjectsView } from '@/features/projects/components/ProjectsView'
import { ProjectDetailPanel } from '@/features/projects/components/ProjectDetailPanel'
import { useProjects } from '@/features/projects/store'
import type { Project } from '@shared/types/project'

// --- fakes ---------------------------------------------------------------------

type Reply = { status: number; body?: unknown; throws?: Error; badJson?: boolean }
function fakeFetch(route: (url: string, init?: { body?: string; headers?: Record<string, string> }) => Reply) {
  return vi.fn(async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    const r = route(url, init)
    if (r.throws) throw r.throws
    return { status: r.status, json: async () => (r.badJson ? Promise.reject(new Error('bad')) : r.body) }
  })
}

class FakeSocket {
  static all: FakeSocket[] = []
  onopen: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  closed = false
  constructor(
    public url: string,
    public protocols?: string[]
  ) {
    FakeSocket.all.push(this)
  }
  close() {
    this.closed = true
  }
  open() {
    this.onopen?.({})
  }
  message(data: unknown) {
    this.onmessage?.({ data })
  }
  drop(code?: number) {
    this.onerror?.({})
    this.onclose?.(code === undefined ? undefined : { code })
  }
}

beforeEach(() => {
  FakeSocket.all = []
  vi.useRealTimers()
})

// --- transport -----------------------------------------------------------------

describe('remote transport', () => {
  it('derives the events URL — the token is never part of it', () => {
    expect(eventsUrl('https://core.lan:7420/')).toBe('wss://core.lan:7420/api/events')
    expect(eventsUrl('', 'http://localhost:5173')).toBe('ws://localhost:5173/api/events')
    expect(eventsUrl('')).toBe('/api/events')
    expect(eventsProtocols('mindeck_x')).toEqual(['mindeck', 'mindeck.bearer.mindeck_x'])
  })

  it('invokes over HTTP with the bearer token and maps failures', async () => {
    const links: LinkState[] = []
    const onUnauthorized = vi.fn()
    let reply: Reply = { status: 200, body: { ok: true, data: [1] } }
    const fetch = fakeFetch(() => reply)
    const t = createRemoteTransport({ baseUrl: 'http://core/', token: 'tok', fetch, onUnauthorized, onLinkState: (l) => links.push(l) })
    expect(t.kind).toBe('remote')
    expect(await t.invoke('projects:list')).toEqual({ ok: true, data: [1] })
    expect(fetch).toHaveBeenCalledWith('http://core/api/rpc/projects:list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: 'null'
    })
    await t.invoke('memory:read', { path: 'a' })
    expect(fetch.mock.calls[1][1]!.body).toBe('{"path":"a"}')

    reply = { status: 401, body: { ok: false, error: { code: 'unauthorized', message: 'no' } } }
    expect(await t.invoke('x')).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    await t.invoke('x')
    expect(onUnauthorized).toHaveBeenCalledTimes(1) // only once

    reply = { status: 502, badJson: true }
    expect(await t.invoke('x')).toEqual({ ok: false, error: { code: 'bad-response', message: 'Unexpected response (502)' } })
    reply = { status: 0, throws: new Error('ECONNREFUSED') }
    expect(await t.invoke('x')).toMatchObject({ ok: false, error: { code: 'offline' } })
    expect(links).toEqual(['offline'])
  })

  it('opens one socket for push events, dispatches by channel, reconnects with backoff', async () => {
    vi.useFakeTimers()
    const links: LinkState[] = []
    const fetch = fakeFetch(() => ({ status: 200, body: { ok: true } }))
    const t = createRemoteTransport({
      baseUrl: 'http://core',
      token: 'tok',
      fetch,
      WebSocket: FakeSocket,
      onLinkState: (l) => links.push(l),
      minDelayMs: 100,
      maxDelayMs: 150
    })
    const a = vi.fn()
    const off = t.on('memory:changed', a)
    t.on('system:tick', vi.fn())
    expect(FakeSocket.all).toHaveLength(1)
    const ws = FakeSocket.all[0]
    expect(ws.url).toBe('ws://core/api/events')
    expect(ws.protocols).toEqual(['mindeck', 'mindeck.bearer.tok'])
    ws.open()
    ws.message(JSON.stringify({ channel: 'memory:changed', payload: { paths: [] } }))
    ws.message('not json')
    ws.message(JSON.stringify({ channel: 'other' }))
    expect(a).toHaveBeenCalledWith({ paths: [] })
    expect(links).toEqual(['connecting', 'online'])

    ws.drop() // after it was open: reconnect without probing
    expect(fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(FakeSocket.all).toHaveLength(2)
    FakeSocket.all[1].drop(1006) // never opened → probe the API, back off
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(150)
    expect(FakeSocket.all).toHaveLength(3)

    off()
    t.close()
    expect(FakeSocket.all[2].closed).toBe(true)
    FakeSocket.all[2].drop() // closed transport: no reconnect
    t.on('x', vi.fn()) // closed: no new socket
    expect(FakeSocket.all).toHaveLength(3)
    vi.useRealTimers()
  })

  it('tells subscribers to resync whenever the socket is back after an outage — not on the first open', async () => {
    vi.useFakeTimers()
    const fetch = fakeFetch(() => ({ status: 200, body: { ok: true } }))
    const t = createRemoteTransport({ baseUrl: 'http://core', token: 'tok', fetch, WebSocket: FakeSocket, minDelayMs: 100, maxDelayMs: 100 })
    const resync = vi.fn()
    const off = t.onResync!(resync)
    t.on('system:tick', vi.fn())
    FakeSocket.all[0].open()
    expect(resync).not.toHaveBeenCalled()
    FakeSocket.all[0].drop()
    await vi.advanceTimersByTimeAsync(100)
    FakeSocket.all[1].drop(1006) // still down
    await vi.advanceTimersByTimeAsync(100)
    FakeSocket.all[2].open()
    expect(resync).toHaveBeenCalledTimes(1)
    FakeSocket.all[2].message(JSON.stringify({ channel: 'system:tick', payload: {} })) // no resync on messages
    expect(resync).toHaveBeenCalledTimes(1)
    off()
    FakeSocket.all[2].drop()
    await vi.advanceTimersByTimeAsync(100)
    FakeSocket.all[3].open()
    expect(resync).toHaveBeenCalledTimes(1)
    t.close()

    // A first attempt that fails: the events between loading and the socket coming up are missing too.
    const t2 = createRemoteTransport({ baseUrl: 'http://core', token: 'tok', fetch, WebSocket: FakeSocket, minDelayMs: 100 })
    const resync2 = vi.fn()
    t2.onResync!(resync2)
    t2.on('system:tick', vi.fn())
    FakeSocket.all[4].drop(1006)
    await vi.advanceTimersByTimeAsync(100)
    FakeSocket.all[5].open()
    expect(resync2).toHaveBeenCalledTimes(1)
    t2.close()
    vi.useRealTimers()
  })

  it('stops reconnecting without listeners; a revoked token (4401 / 401 probe) ends the session', async () => {
    vi.useFakeTimers()
    const onUnauthorized = vi.fn()
    const fetch = fakeFetch(() => ({ status: 401, body: {} }))
    const t = createRemoteTransport({ baseUrl: '', token: 'tok', fetch, WebSocket: FakeSocket, onUnauthorized })
    const off = t.on('a', vi.fn())
    off()
    FakeSocket.all[0].drop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeSocket.all).toHaveLength(1) // nobody listens → stays down

    t.on('a', vi.fn())
    FakeSocket.all[1].drop() // never opened → probe says 401
    await vi.advanceTimersByTimeAsync(0)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeSocket.all).toHaveLength(2) // unauthorized → no more sockets

    const t2 = createRemoteTransport({ baseUrl: '', token: 'tok', fetch: fakeFetch(() => ({ status: 0, throws: new Error('x') })), WebSocket: FakeSocket, onUnauthorized })
    t2.on('a', vi.fn())
    FakeSocket.all[2].open()
    FakeSocket.all[2].drop(4401)
    expect(onUnauthorized).toHaveBeenCalledTimes(2)

    const t3 = createRemoteTransport({ baseUrl: '', token: 'tok', fetch: fakeFetch(() => ({ status: 0, throws: new Error('x') })), WebSocket: FakeSocket })
    t3.on('a', vi.fn())
    FakeSocket.all[3].drop() // probe fails → ignored
    await vi.advanceTimersByTimeAsync(0)
    t3.close()
    t3.close()
    vi.useRealTimers()
  })

  it('uses the global fetch/WebSocket by default', async () => {
    const g = globalThis as unknown as { fetch: unknown; WebSocket: unknown }
    const saved = { fetch: g.fetch, WebSocket: g.WebSocket }
    g.fetch = fakeFetch(() => ({ status: 200, body: { ok: true, name: 'Mindeck', version: '1', mode: 'server' } }))
    g.WebSocket = FakeSocket
    try {
      const t = createRemoteTransport({ baseUrl: '', token: 'x' })
      await t.invoke('a')
      t.on('b', vi.fn())
      expect(FakeSocket.all).toHaveLength(1)
      t.close()
      expect(await probeCore('')).toEqual({ name: 'Mindeck', version: '1', mode: 'server' })
      g.fetch = fakeFetch(() => ({ status: 200, body: { ok: true, data: { token: 't', device: { id: 'd' } } } }))
      expect(await pairDevice('', 'C', 'N')).toMatchObject({ token: 't' })
    } finally {
      g.fetch = saved.fetch
      g.WebSocket = saved.WebSocket
    }
  })

  it('probeCore recognizes only a Mindeck core; pairDevice surfaces errors', async () => {
    expect(await probeCore('http://x', fakeFetch(() => ({ status: 200, body: { ok: true, name: 'Other' } })))).toBeNull()
    expect(await probeCore('http://x', fakeFetch(() => ({ status: 200, body: null })))).toBeNull()
    expect(await probeCore('http://x', fakeFetch(() => ({ status: 0, throws: new Error('down') })))).toBeNull()

    const pairFetch = fakeFetch((url, init) => {
      expect(url).toBe('http://x/api/pair')
      expect(JSON.parse(init!.body!)).toEqual({ code: 'AB', name: 'Me' })
      return { status: 401, body: { ok: false, error: { code: 'bad-code', message: 'expired' } } }
    })
    await expect(pairDevice('http://x/', 'AB', 'Me', pairFetch)).rejects.toMatchObject({ code: 'bad-code', message: 'expired' })
    await expect(pairDevice('http://x', 'AB', 'Me', fakeFetch(() => ({ status: 500, badJson: true })))).rejects.toMatchObject({ code: 'bad-response' })
  })

  it('bridgeTransport wraps window.mindeck', async () => {
    const bridge = { invoke: vi.fn(async () => ({ ok: true, data: 1 })), on: vi.fn(() => () => {}) }
    const t = bridgeTransport(bridge)
    expect(t.kind).toBe('bridge')
    expect(await t.invoke('a', 1)).toEqual({ ok: true, data: 1 })
    t.on('e', vi.fn())
    expect(bridge.on).toHaveBeenCalled()
    // The desktop bridge cannot drop events: nothing to resync, and onResync is a no-op there.
    expect(t.onResync).toBeUndefined()
  })
})

describe('client transport selection', () => {
  it('prefers the desktop bridge, else the installed remote, else fails cleanly', async () => {
    expect(isDesktop()).toBe(false)
    expect(currentTransport()).toBeNull()
    await expect(ipc('projects:list')).rejects.toMatchObject({ code: 'no-bridge' })
    expect(onEvent('system:tick', vi.fn())).toBeTypeOf('function')
    expect(onResync(vi.fn())).toBeTypeOf('function')

    const remote = installRemote({ 'projects:list': () => ['r'] })
    expect(await ipc('projects:list')).toEqual(['r'])
    const cb = vi.fn()
    onEvent('memory:changed', cb)
    remote.emit('memory:changed', { paths: [] })
    expect(cb).toHaveBeenCalled()

    installBridge({ 'projects:list': () => ['b'] })
    expect(isDesktop()).toBe(true)
    expect(await ipc('projects:list')).toEqual(['b'])
    setTransport(null)
  })
})

// --- session -------------------------------------------------------------------

const initialSession = useSession.getState()
const sessionFetch = (opts: { health?: boolean; pair?: 'ok' | 'bad'; info?: number; revoke?: 'fail' } = {}) =>
  fakeFetch((url) => {
    if (url.endsWith('/api/health')) {
      return opts.health === false ? { status: 0, throws: new Error('down') } : { status: 200, body: { ok: true, name: 'Mindeck', version: '1', mode: 'server' } }
    }
    if (url.endsWith('/api/pair')) {
      return opts.pair === 'bad'
        ? { status: 401, body: { ok: false, error: { code: 'bad-code', message: 'Pairing code is invalid or expired' } } }
        : { status: 200, body: { ok: true, data: { token: 'tok', device: { id: 'dev1', name: 'n', createdAt: '' } } } }
    }
    if (url.endsWith('/api/rpc/app:info')) {
      if (opts.info === 401) return { status: 401, body: { ok: false, error: { code: 'unauthorized', message: 'nope' } } }
      if (opts.info === 0) return { status: 0, throws: new Error('ECONNREFUSED') }
      return { status: 200, body: { ok: true, data: { mode: 'server', version: '1', hostname: 'nas', platform: 'linux', remoteTerminal: false } } }
    }
    if (url.endsWith('/api/rpc/server:revokeDevice')) return opts.revoke === 'fail' ? { status: 0, throws: new Error('offline') } : { status: 200, body: { ok: true } }
    return { status: 404, body: { ok: false, error: { code: 'nf', message: 'nf' } } }
  })

function withFetch(fetch: ReturnType<typeof fakeFetch>) {
  ;(globalThis as unknown as { fetch: unknown }).fetch = fetch
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket
  return fetch
}

describe('session store', () => {
  beforeEach(() => useSession.setState(initialSession, true))

  it('names the browser', () => {
    const cases: [string, string][] = [
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36', 'Chrome · macOS'],
      ['Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537.36 Edg/130', 'Edge · Windows'],
      ['Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko Firefox/130.0', 'Firefox · Linux'],
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17 Safari/604.1', 'Safari · iOS'],
      ['Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36', 'Chrome · Android'],
      ['curl/8', 'Browser · Web']
    ]
    for (const [ua, name] of cases) expect(defaultDeviceName(ua)).toBe(name)
    expect(defaultDeviceName()).toContain(' · ')
  })

  it('desktop: ready at once, info is best effort', async () => {
    installBridge({ 'app:info': () => ({ mode: 'desktop' }) })
    await useSession.getState().init()
    expect(useSession.getState()).toMatchObject({ status: 'ready', link: 'online', info: { mode: 'desktop' } })
    installBridge({ 'app:info': () => fail('x') })
    await useSession.getState().init()
    expect(useSession.getState().status).toBe('ready')
  })

  it('browser without a token: unpaired when a core answers, else unreachable', async () => {
    withFetch(sessionFetch())
    await useSession.getState().init()
    expect(useSession.getState().status).toBe('unpaired')
    withFetch(sessionFetch({ health: false }))
    await useSession.getState().init()
    expect(useSession.getState()).toMatchObject({ status: 'unreachable', error: 'No Mindeck core answered at this address' })
  })

  it('pairs, stores the token, reconnects with it, and logs out (revoking the device)', async () => {
    const fetch = withFetch(sessionFetch({ pair: 'bad' }))
    expect(await useSession.getState().pair(' ABCD-EFGH ', ' Me ')).toBe(false)
    expect(useSession.getState().error).toBe('Pairing code is invalid or expired')

    withFetch(sessionFetch())
    expect(await useSession.getState().pair('ABCD-EFGH', 'Me')).toBe(true)
    expect(useSession.getState()).toMatchObject({ status: 'ready', info: { hostname: 'nas' } })
    expect(localStorage.getItem('mindeck.token')).toBe('tok')
    expect(fetch).toBeDefined()

    // reload: the stored token is used
    const revoke = withFetch(sessionFetch())
    useSession.setState(initialSession, true)
    await useSession.getState().init()
    expect(useSession.getState().status).toBe('ready')

    await useSession.getState().logout()
    expect(revoke.mock.calls.some(([url]) => String(url).endsWith('server:revokeDevice'))).toBe(true)
    expect(useSession.getState().status).toBe('unpaired')
    expect(localStorage.getItem('mindeck.token')).toBeNull()
    await useSession.getState().logout() // nothing to revoke

    // The core can't be told: signed out here all the same.
    withFetch(sessionFetch())
    expect(await useSession.getState().pair('ABCD-EFGH', 'Me')).toBe(true)
    const failing = withFetch(sessionFetch({ revoke: 'fail' }))
    useSession.setState(initialSession, true)
    await useSession.getState().init()
    await useSession.getState().logout()
    expect(failing.mock.calls.some(([url]) => String(url).endsWith('server:revokeDevice'))).toBe(true)
    expect(useSession.getState().status).toBe('unpaired')
    expect(localStorage.getItem('mindeck.token')).toBeNull()
  })

  it('"stay paired" off: the token lives only as long as the tab (sessionStorage)', async () => {
    sessionStorage.clear()
    withFetch(sessionFetch())
    expect(await useSession.getState().pair('ABCD-EFGH', 'Me', false)).toBe(true)
    expect(localStorage.getItem('mindeck.token')).toBeNull()
    expect(sessionStorage.getItem('mindeck.token')).toBe('tok')
    expect(sessionStorage.getItem('mindeck.deviceId')).toBe('dev1')
    // a reload of the tab still finds it
    useSession.setState(initialSession, true)
    await useSession.getState().init()
    expect(useSession.getState().status).toBe('ready')
    // pairing again with "stay paired" moves it over
    expect(await useSession.getState().pair('ABCD-EFGH', 'Me')).toBe(true)
    expect(sessionStorage.getItem('mindeck.token')).toBeNull()
    expect(localStorage.getItem('mindeck.token')).toBe('tok')
    await useSession.getState().logout()
    expect(sessionStorage.length + localStorage.length).toBe(0)
  })

  it('signing out forgets prompts, drafts, recent files and layouts — theme and language stay', async () => {
    sessionStorage.clear()
    withFetch(sessionFetch())
    expect(await useSession.getState().pair('ABCD-EFGH', 'Me')).toBe(true)
    const kept = { 'mindeck.theme': 'light', 'mindeck.appearance': '{}', 'mindeck.locale': 'de', 'other.app': 'x' }
    for (const [k, v] of Object.entries({ ...kept, 'mindeck.agents.history': '["secret token sk-1"]', 'mindeck.agents.draft.s1': '{}', 'mindeck.recentFiles': '[]', 'mindeck.editor.layouts': '{}' })) localStorage.setItem(k, v)
    sessionStorage.setItem('mindeck.debug', 'x')
    await useSession.getState().logout()
    expect(Object.fromEntries(Object.entries(localStorage))).toEqual(kept)
    expect(sessionStorage.length).toBe(0)
    // Storage that refuses: signing out still completes.
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new Error('denied')
    })
    await useSession.getState().logout()
    expect(useSession.getState().status).toBe('unpaired')
  })

  it('a rejected token resets to pairing; an unreachable core is reported', async () => {
    localStorage.setItem('mindeck.token', 'old')
    withFetch(sessionFetch({ info: 401 }))
    await useSession.getState().init()
    expect(useSession.getState()).toMatchObject({ status: 'unpaired', error: 'This device is no longer paired' })
    expect(localStorage.getItem('mindeck.token')).toBeNull()

    localStorage.setItem('mindeck.token', 'old')
    withFetch(sessionFetch({ info: 0 }))
    await useSession.getState().init()
    expect(useSession.getState().status).toBe('unreachable')

    // link state follows the socket
    withFetch(sessionFetch())
    await useSession.getState().init()
    onEvent('system:tick', vi.fn())
    FakeSocket.all.at(-1)!.open()
    expect(useSession.getState().link).toBe('online')
  })

  it('survives unavailable storage', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    withFetch(sessionFetch())
    await useSession.getState().init()
    expect(useSession.getState().status).toBe('unpaired')
    expect(await useSession.getState().pair('ABCD-EFGH', 'Me')).toBe(true)
    get.mockRestore()
    set.mockRestore()
  })
})

describe('SessionGate and pairing screens', () => {
  beforeEach(() => useSession.setState(initialSession, true))

  it('formats codes as XXXX-XXXX', () => {
    expect(formatCode('ab')).toBe('AB')
    expect(formatCode('abcd-efgh-ij')).toBe('ABCD-EFGH')
    expect(formatCode('a b c d e')).toBe('ABCD-E')
  })

  it('connecting → pair form → app', async () => {
    withFetch(sessionFetch({ pair: 'bad' }))
    render(
      <SessionGate>
        <div>APP</div>
      </SessionGate>
    )
    expect(screen.getByText(/Connecting to the Mindeck core/)).toBeInTheDocument()
    await act(settle)
    const pairButton = screen.getByText('Pair device').closest('button')!
    expect(pairButton).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: 'Office' } })
    fireEvent.submit(pairButton.closest('form')!) // incomplete code: ignored
    fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: 'abcdefgh' } })
    expect(screen.getByLabelText('Pairing code')).toHaveValue('ABCD-EFGH')
    fireEvent.click(pairButton)
    await act(settle)
    expect(screen.getByText('Pairing code is invalid or expired')).toBeInTheDocument()

    withFetch(sessionFetch())
    const remember = screen.getByRole('checkbox', { name: /Stay paired on this browser/ })
    expect(remember).toBeChecked()
    fireEvent.click(remember)
    sessionStorage.clear()
    fireEvent.click(pairButton)
    await act(settle)
    expect(screen.getByText('APP')).toBeInTheDocument()
    expect(sessionStorage.getItem('mindeck.token')).toBe('tok')
    expect(localStorage.getItem('mindeck.token')).toBeNull()
    sessionStorage.clear()
  })

  it('unreachable core offers a retry', async () => {
    withFetch(sessionFetch({ health: false }))
    render(
      <SessionGate>
        <div>APP</div>
      </SessionGate>
    )
    await act(settle)
    expect(screen.getByText('The Mindeck core did not answer.')).toBeInTheDocument()
    withFetch(sessionFetch())
    fireEvent.click(screen.getByText('Retry'))
    await act(settle)
    expect(screen.getByLabelText('Pairing code')).toBeInTheDocument()
    act(() => useSession.setState({ status: 'unreachable', error: undefined }))
    expect(screen.queryByText('No Mindeck core answered at this address')).toBeNull()
  })
})

// --- folder picker + web projects --------------------------------------------------

describe('FolderPicker', () => {
  it('browses folders on the core, goes home/up, accepts a typed path', async () => {
    const remote = installRemote({
      'fs:dirs': ({ path }: { path?: string }) => {
        if (path === '/bad') return fail('Folder not found: /bad', 'not-found')
        if (path === '/srv') return { path: '/srv', parent: '/', home: '/root', dirs: [] }
        if (path === '/') return { path: '/', parent: null, home: '/root', dirs: ['srv'] }
        if (path === 'C:\\') return { path: 'C:\\', parent: null, home: 'C:\\Users\\me', dirs: ['Users'] }
        return { path: '/root', parent: '/', home: '/root', dirs: ['code', 'notes'] }
      }
    })
    const onPick = vi.fn()
    const onClose = vi.fn()
    render(<FolderPicker title="Pick" onPick={onPick} onClose={onClose} />)
    expect(await screen.findByText('code')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Parent folder'))
    expect(await screen.findByText('srv')).toBeInTheDocument()
    expect(screen.getByLabelText('Parent folder')).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Parent folder')) // no parent: no-op
    fireEvent.click(screen.getByText('srv'))
    expect(await screen.findByText('No sub-folders')).toBeInTheDocument()
    expect(remote.invoke).toHaveBeenLastCalledWith('fs:dirs', { path: '/srv' })
    fireEvent.click(screen.getByText('Select folder'))
    expect(onPick).toHaveBeenCalledWith('/srv')

    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: '/bad' } })
    fireEvent.submit(screen.getByLabelText('Folder path').closest('form')!)
    expect(await screen.findByText('Folder not found: /bad')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: '  ' } })
    fireEvent.submit(screen.getByLabelText('Folder path').closest('form')!)
    fireEvent.click(await screen.findByText('notes'))
    expect(remote.invoke).toHaveBeenLastCalledWith('fs:dirs', { path: '/root/notes' })
    await act(settle)

    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: 'C:\\' } })
    fireEvent.submit(screen.getByLabelText('Folder path').closest('form')!)
    fireEvent.click(await screen.findByText('Users'))
    expect(remote.invoke).toHaveBeenLastCalledWith('fs:dirs', { path: 'C:\\Users' })

    fireEvent.click(screen.getByLabelText('Home folder'))
    await act(settle)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('ignores answers that arrive after a newer request', async () => {
    const pending: Record<string, (v: unknown) => void> = {}
    installRemote({
      'fs:dirs': ({ path }: { path?: string }) =>
        new Promise((resolve, reject) => {
          pending[path ?? 'home'] = (v) => (v instanceof Error ? reject(v) : resolve(v))
        })
    })
    render(<FolderPicker title="Pick" onPick={vi.fn()} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: '/srv' } })
    fireEvent.submit(screen.getByLabelText('Folder path').closest('form')!)
    await act(async () => pending['/srv']({ path: '/srv', parent: '/', home: '/root', dirs: ['wanted'] }))
    await act(async () => pending.home({ path: '/root', parent: '/', home: '/root', dirs: ['stale'] }))
    expect(screen.getByText('wanted')).toBeInTheDocument()
    expect(screen.queryByText('stale')).toBeNull()
    expect(screen.getByLabelText('Folder path')).toHaveValue('/srv')

    // a stale failure is ignored as well
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: '/a' } })
    fireEvent.submit(screen.getByLabelText('Folder path').closest('form')!)
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: '/b' } })
    fireEvent.submit(screen.getByLabelText('Folder path').closest('form')!)
    await act(async () => pending['/b']({ path: '/b', parent: '/', home: '/root', dirs: [] }))
    await act(async () => pending['/a'](Object.assign(new Error('late failure'), { code: 'x' })))
    expect(screen.queryByText('late failure')).toBeNull()
    expect(screen.getByText('No sub-folders')).toBeInTheDocument()
  })

  it('keeps what the user typed while the first listing was still loading', async () => {
    const pending: Record<string, (v: unknown) => void> = {}
    const remote = installRemote({
      'fs:dirs': ({ path }: { path?: string }) => new Promise((resolve) => (pending[path ?? 'home'] = resolve))
    })
    render(<FolderPicker title="Pick" onPick={vi.fn()} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: '/srv' } })
    // the home listing lands between typing and Enter (seen on slow CI runners)
    await act(async () => pending.home({ path: '/root', parent: '/', home: '/root', dirs: ['code'] }))
    expect(screen.getByLabelText('Folder path')).toHaveValue('/srv')
    fireEvent.submit(screen.getByLabelText('Folder path').closest('form')!)
    expect(remote.invoke).toHaveBeenLastCalledWith('fs:dirs', { path: '/srv' })
    // the answer to the typed path shows its canonical form
    await act(async () => pending['/srv']({ path: '/srv/', parent: '/', home: '/root', dirs: ['wanted'] }))
    expect(screen.getByLabelText('Folder path')).toHaveValue('/srv/')
    expect(screen.getByText('wanted')).toBeInTheDocument()
  })

  it('a paired device jumps between its shared folders', async () => {
    const roots = ['/srv/code', '/srv/notes']
    const remote = installRemote({
      'fs:dirs': ({ path }: { path?: string }) => ({ path: path ?? roots[0], parent: null, home: roots[0], dirs: [], roots })
    })
    render(<FolderPicker title="Pick" onPick={vi.fn()} onClose={vi.fn()} />)
    const shared = await screen.findByLabelText('Shared folders')
    expect(screen.getByText('/srv/code', { selector: 'button' })).toHaveClass('text-cyan')
    fireEvent.click(screen.getByText('/srv/notes', { selector: 'button' }))
    await act(settle)
    expect(remote.invoke).toHaveBeenLastCalledWith('fs:dirs', { path: '/srv/notes' })
    expect(shared).toBeInTheDocument()
    expect(screen.getByText('/srv/notes', { selector: 'button' })).toHaveClass('text-cyan')
  })

  it('one shared folder needs no chooser', async () => {
    installRemote({ 'fs:dirs': () => ({ path: '/srv/code', parent: null, home: '/srv/code', dirs: ['app'], roots: ['/srv/code'] }) })
    render(<FolderPicker title="Pick" onPick={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByText('app')).toBeInTheDocument()
    expect(screen.queryByLabelText('Shared folders')).toBeNull()
  })

  it('cannot confirm before a folder loaded', async () => {
    installRemote({ 'fs:dirs': () => new Promise(() => {}) })
    const onPick = vi.fn()
    render(<FolderPicker title="Pick" onPick={onPick} onClose={vi.fn()} />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    const confirm = screen.getByText('Select folder').closest('button')!
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(onPick).not.toHaveBeenCalled()
  })
})

describe('projects in a browser', () => {
  const initial = useProjects.getState()
  beforeEach(() => useProjects.setState(initial, true))
  const project: Project = { id: 'n', name: 'New', path: '/srv/new', addedAt: '', lastSeenAt: '' }

  it('adds a project through the folder browser; no host-app buttons', async () => {
    const remote = installRemote({
      'projects:list': () => [],
      'fs:dirs': () => ({ path: '/srv/new', parent: '/srv', home: '/root', dirs: [] }),
      'projects:add': () => project,
      'projects:refresh': () => project
    })
    render(<ProjectsView onNavigate={vi.fn()} />)
    await act(settle)
    fireEvent.click(screen.getByText('Add project'))
    expect(remote.invoke).not.toHaveBeenCalledWith('projects:pickFolder', undefined)
    fireEvent.click(await screen.findByText('Add project', { selector: 'footer button' }))
    await act(settle)
    expect(remote.invoke).toHaveBeenCalledWith('projects:add', { path: '/srv/new' })
    expect(useProjects.getState().selectedId).toBe('n')
    expect(screen.queryByText('VS Code')).toBeNull()

    fireEvent.click(screen.getAllByText('Add project')[0])
    fireEvent.click(await screen.findByLabelText('Close'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports a failing add; the terminal button follows remote shells', async () => {
    installRemote({ 'projects:add': () => fail('not a folder'), 'projects:refresh': () => project })
    await useProjects.getState().addPath('/x')
    expect(useProjects.getState().error).toBe('not a folder')
    useProjects.setState({ githubDesktop: 'GitHub Desktop' })
    useSession.setState({ info: undefined })
    const { rerender } = render(<ProjectDetailPanel project={{ ...project, git: { isRepo: true } }} onNavigate={vi.fn()} />)
    expect(screen.queryByText('Terminal')).toBeNull()
    expect(screen.queryByText('GitHub Desktop')).toBeNull() // host apps: desktop window only
    useSession.setState({ info: { mode: 'server', version: '1', platform: 'linux', hostname: 'nas', remoteTerminal: true } })
    rerender(<ProjectDetailPanel project={project} onNavigate={vi.fn()} />)
    expect(screen.getByText('Terminal')).toBeInTheDocument()
    await act(settle)
  })
})
