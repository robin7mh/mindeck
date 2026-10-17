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
  jar.cookie = false
  vi.useRealTimers()
})

// --- transport -----------------------------------------------------------------

describe('remote transport', () => {
  it('derives the events URL — the token is never part of it', () => {
    expect(eventsUrl('https://core.lan:7420/')).toBe('wss://core.lan:7420/api/events')
    expect(eventsUrl('', 'http://localhost:5173')).toBe('ws://localhost:5173/api/events')
    expect(eventsUrl('')).toBe('/api/events')
    expect(eventsUrl('http://core', undefined, { stream: 'a b', since: 3 })).toBe('ws://core/api/events?stream=a%20b&since=3')
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

  it('resumes where it stopped: the core replays the gap (no resync) or says resync-required (FE-BUG-01)', async () => {
    vi.useFakeTimers()
    const fetch = fakeFetch(() => ({ status: 200, body: { ok: true } }))
    const t = createRemoteTransport({ baseUrl: 'http://core', token: 'tok', fetch, WebSocket: FakeSocket, minDelayMs: 100, maxDelayMs: 100 })
    const resync = vi.fn()
    t.onResync!(resync)
    const events: unknown[] = []
    t.on('memory:changed', (p) => events.push(p))
    const hello = vi.fn()
    t.on('hello', hello)
    const send = (ws: FakeSocket, msg: object) => ws.message(JSON.stringify(msg))
    const ws = FakeSocket.all[0]
    expect(ws.url).toBe('ws://core/api/events') // nothing to resume yet
    ws.open()
    send(ws, { channel: 'hello', payload: { deviceId: 'd', role: 'member', stream: 's1', seq: 4 } })
    expect(hello).toHaveBeenCalledWith({ deviceId: 'd', role: 'member', stream: 's1', seq: 4 })
    send(ws, { channel: 'memory:changed', payload: { n: 5 }, seq: 5 })
    send(ws, { channel: 'memory:changed', payload: { n: 6 }, seq: 6 })
    ws.drop()
    await vi.advanceTimersByTimeAsync(100)

    // Back: it names the last event it saw; the core replays 7 and 8.
    const again = FakeSocket.all[1]
    expect(again.url).toBe('ws://core/api/events?stream=s1&since=6')
    again.open()
    send(again, { channel: 'hello', payload: { deviceId: 'd', role: 'member', stream: 's1', seq: 8 } })
    send(again, { channel: 'memory:changed', payload: { n: 7 }, seq: 7 })
    send(again, { channel: 'memory:changed', payload: { n: 8 }, seq: 8 })
    send(again, { channel: 'memory:changed', payload: { n: 8 }, seq: 8 }) // seen: dropped
    send(again, { channel: 'system:tick', payload: {} }) // volatile: no seq
    expect(events).toEqual([{ n: 5 }, { n: 6 }, { n: 7 }, { n: 8 }])
    expect(resync).not.toHaveBeenCalled()

    // A gap the core no longer holds: it says so, the stores reload, numbering goes on from its seq.
    again.drop()
    await vi.advanceTimersByTimeAsync(100)
    const third = FakeSocket.all[2]
    expect(third.url).toBe('ws://core/api/events?stream=s1&since=8')
    third.open()
    send(third, { channel: 'hello', payload: { deviceId: 'd', role: 'member', stream: 's1', seq: 40 } })
    send(third, { channel: 'resync-required', payload: { stream: 's1', seq: 40 } })
    expect(resync).toHaveBeenCalledTimes(1)
    send(third, { channel: 'memory:changed', payload: { n: 41 }, seq: 41 })
    expect(resync).toHaveBeenCalledTimes(1)
    // An event that skips numbers (something got lost on the way): resync too.
    send(third, { channel: 'memory:changed', payload: { n: 43 }, seq: 43 })
    expect(resync).toHaveBeenCalledTimes(2)
    expect(events.at(-1)).toEqual({ n: 43 })

    // A restarted core: another stream — its resync-required says where to go on from.
    third.drop()
    await vi.advanceTimersByTimeAsync(100)
    const fourth = FakeSocket.all[3]
    expect(fourth.url).toBe('ws://core/api/events?stream=s1&since=43')
    fourth.open()
    send(fourth, { channel: 'hello', payload: { deviceId: 'd', role: 'member', stream: 's2', seq: 0 } })
    send(fourth, { channel: 'resync-required', payload: { stream: 's2', seq: 0 } })
    expect(resync).toHaveBeenCalledTimes(3)
    send(fourth, { channel: 'memory:changed', payload: { n: 1 }, seq: 1 })
    expect(events.at(-1)).toEqual({ n: 1 })
    send(fourth, { channel: 'resync-required', payload: {} }) // without where: just reload
    expect(resync).toHaveBeenCalledTimes(4)

    // Downgraded to a core without replay: its hello names no stream — reload.
    fourth.drop()
    await vi.advanceTimersByTimeAsync(100)
    const fifth = FakeSocket.all[4]
    expect(fifth.url).toBe('ws://core/api/events?stream=s2&since=1')
    fifth.open()
    expect(resync).toHaveBeenCalledTimes(4) // waits for the hello
    send(fifth, { channel: 'hello', payload: { deviceId: 'd', role: 'member' } })
    expect(resync).toHaveBeenCalledTimes(5)
    send(fifth, { channel: 'hello', payload: { deviceId: 'd', role: 'member' } }) // only once per reconnect
    expect(resync).toHaveBeenCalledTimes(5)
    t.close()
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
/**
 * A core that keeps the web UI's token in its cookie jar (`jar.cookie`): pairing with `cookie: true`
 * and handing over a stored token set it, signing out clears it.
 */
const jar = { cookie: false }
const sessionFetch = (opts: { health?: boolean; pair?: 'ok' | 'bad'; info?: number; session?: 'down' } = {}) =>
  fakeFetch((url, init) => {
    const auth = init?.headers?.Authorization
    if (url.endsWith('/api/health')) {
      return opts.health === false ? { status: 0, throws: new Error('down') } : { status: 200, body: { ok: true, name: 'Mindeck', version: '1', mode: 'server' } }
    }
    if (url.endsWith('/api/pair')) {
      if (opts.pair === 'bad') return { status: 401, body: { ok: false, error: { code: 'bad-code', message: 'Pairing code is invalid or expired' } } }
      jar.cookie = JSON.parse(init!.body!).cookie === true
      return { status: 200, body: { ok: true, data: { device: { id: 'dev1', name: 'n', createdAt: '' } } } }
    }
    if (url.endsWith('/api/session')) {
      if (opts.session === 'down') return { status: 500, body: { ok: false, error: { code: 'error', message: 'Something went wrong' } } }
      if (auth !== 'Bearer old') return { status: 401, body: { ok: false, error: { code: 'unauthorized', message: 'nope' } } }
      jar.cookie = true
      return { status: 200, body: { ok: true, data: { device: { id: 'dev-old', name: 'n', createdAt: '' } } } }
    }
    if (url.endsWith('/api/logout')) {
      jar.cookie = false
      return { status: 200, body: { ok: true } }
    }
    if (url.endsWith('/api/rpc/app:info')) {
      if (opts.info === 0) return { status: 0, throws: new Error('ECONNREFUSED') }
      if (opts.info === 401 || (!jar.cookie && auth !== 'Bearer old')) return { status: 401, body: { ok: false, error: { code: 'unauthorized', message: 'nope' } } }
      return { status: 200, body: { ok: true, data: { mode: 'server', version: '1', hostname: 'nas', platform: 'linux', remoteTerminal: false } } }
    }
    return { status: 404, body: { ok: false, error: { code: 'nf', message: 'nf' } } }
  })
const called = (fetch: ReturnType<typeof fakeFetch>, path: string) => fetch.mock.calls.filter(([url]) => String(url).endsWith(path))

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

  it('a browser that never paired: unpaired (nothing “no longer” about it) when a core answers, else unreachable', async () => {
    jar.cookie = false
    withFetch(sessionFetch())
    await useSession.getState().init()
    expect(useSession.getState()).toMatchObject({ status: 'unpaired', error: undefined })
    withFetch(sessionFetch({ health: false }))
    await useSession.getState().init()
    expect(useSession.getState()).toMatchObject({ status: 'unreachable', error: 'No Mindeck core answered at this address' })
  })

  it('pairs into the core’s HttpOnly cookie — no token in web storage —, reloads on it, and signs out (FE-SEC-03)', async () => {
    jar.cookie = false
    withFetch(sessionFetch({ pair: 'bad' }))
    expect(await useSession.getState().pair(' ABCD-EFGH ', ' Me ')).toBe(false)
    expect(useSession.getState().error).toBe('Pairing code is invalid or expired')

    const fetch = withFetch(sessionFetch())
    expect(await useSession.getState().pair('ABCD-EFGH', 'Me')).toBe(true)
    expect(useSession.getState()).toMatchObject({ status: 'ready', info: { hostname: 'nas' } })
    expect(JSON.parse(called(fetch, '/api/pair')[0][1]!.body!)).toEqual({ code: 'ABCD-EFGH', name: 'Me', cookie: true, remember: true })
    expect(localStorage.getItem('mindeck.token')).toBeNull()
    expect(localStorage.getItem('mindeck.deviceId')).toBe('dev1')
    // Calls and the socket carry no token: the browser sends the cookie.
    expect(called(fetch, '/api/rpc/app:info')[0][1]!.headers).toEqual({ 'Content-Type': 'application/json' })
    onEvent('system:tick', vi.fn())
    expect(FakeSocket.all.at(-1)!.protocols).toEqual(['mindeck'])

    // Reload: the cookie still holds.
    useSession.setState(initialSession, true)
    await useSession.getState().init()
    expect(useSession.getState().status).toBe('ready')

    const out = withFetch(sessionFetch())
    await useSession.getState().logout()
    expect(called(out, '/api/logout')).toHaveLength(1)
    expect(called(out, '/api/logout')[0][1]!.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(jar.cookie).toBe(false)
    expect(useSession.getState().status).toBe('unpaired')
    expect(localStorage.getItem('mindeck.deviceId')).toBeNull()
    await useSession.getState().logout() // signed out already: nothing to tell the core
    expect(called(out, '/api/logout')).toHaveLength(1)
  })

  it('"stay paired" off: a session cookie, the device id only for this tab', async () => {
    sessionStorage.clear()
    jar.cookie = false
    const fetch = withFetch(sessionFetch())
    expect(await useSession.getState().pair('ABCD-EFGH', 'Me', false)).toBe(true)
    expect(JSON.parse(called(fetch, '/api/pair')[0][1]!.body!)).toMatchObject({ cookie: true, remember: false })
    expect(localStorage.getItem('mindeck.deviceId')).toBeNull()
    expect(sessionStorage.getItem('mindeck.deviceId')).toBe('dev1')
    // pairing again with "stay paired" moves it over
    expect(await useSession.getState().pair('ABCD-EFGH', 'Me')).toBe(true)
    expect(sessionStorage.getItem('mindeck.deviceId')).toBeNull()
    expect(localStorage.getItem('mindeck.deviceId')).toBe('dev1')
    await useSession.getState().logout()
    expect(sessionStorage.length + localStorage.length).toBe(0)
  })

  it('a token kept in web storage from before is handed to the core for the cookie once, then deleted', async () => {
    sessionStorage.clear()
    jar.cookie = false
    // localStorage ("stay paired"): a persistent cookie.
    localStorage.setItem('mindeck.token', 'old')
    let fetch = withFetch(sessionFetch())
    await useSession.getState().init()
    const [session] = called(fetch, '/api/session')
    expect(session[1]!.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer old' })
    expect(JSON.parse(session[1]!.body!)).toEqual({ remember: true })
    expect(useSession.getState().status).toBe('ready')
    expect(localStorage.getItem('mindeck.token')).toBeNull()
    expect(localStorage.getItem('mindeck.deviceId')).toBe('dev-old')
    // Next time: nothing to hand over.
    fetch = withFetch(sessionFetch())
    await useSession.getState().init()
    expect(called(fetch, '/api/session')).toHaveLength(0)

    // sessionStorage (this tab only): a session cookie.
    jar.cookie = false
    localStorage.clear()
    sessionStorage.setItem('mindeck.token', 'old')
    fetch = withFetch(sessionFetch())
    await useSession.getState().init()
    expect(JSON.parse(called(fetch, '/api/session')[0][1]!.body!)).toEqual({ remember: false })
    expect(sessionStorage.getItem('mindeck.token')).toBeNull()
    expect(sessionStorage.getItem('mindeck.deviceId')).toBe('dev-old')

    // A token the core no longer knows: deleted; the browser pairs again — and is told why.
    jar.cookie = false
    sessionStorage.clear()
    localStorage.setItem('mindeck.token', 'revoked')
    withFetch(sessionFetch())
    await useSession.getState().init()
    expect(useSession.getState()).toMatchObject({ status: 'unpaired', error: 'This device is no longer paired' })
    expect(localStorage.getItem('mindeck.token')).toBeNull()

    // The core can't take it right now: kept, used as before for this visit (and signed out with).
    localStorage.setItem('mindeck.token', 'old')
    fetch = withFetch(sessionFetch({ session: 'down' }))
    await useSession.getState().init()
    expect(useSession.getState().status).toBe('ready')
    expect(localStorage.getItem('mindeck.token')).toBe('old')
    expect(called(fetch, '/api/rpc/app:info')[0][1]!.headers).toMatchObject({ Authorization: 'Bearer old' })
    await useSession.getState().logout()
    expect(called(fetch, '/api/logout')[0][1]!.headers).toMatchObject({ Authorization: 'Bearer old' })
    expect(localStorage.getItem('mindeck.token')).toBeNull()
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

  it('a cookie the core no longer accepts resets to pairing; an unreachable core is reported', async () => {
    localStorage.clear()
    jar.cookie = true
    localStorage.setItem('mindeck.deviceId', 'dev1')
    withFetch(sessionFetch({ info: 401 }))
    await useSession.getState().init()
    expect(useSession.getState()).toMatchObject({ status: 'unpaired', error: 'This device is no longer paired' })
    expect(localStorage.getItem('mindeck.deviceId')).toBeNull()

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
    expect(sessionStorage.getItem('mindeck.deviceId')).toBe('dev1')
    expect(localStorage.getItem('mindeck.deviceId')).toBeNull()
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
