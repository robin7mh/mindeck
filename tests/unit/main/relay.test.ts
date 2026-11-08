import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer, createWebSocketStream } from 'ws'
import { tempDir, tick } from './helpers'
import { AuthService } from '../../../electron/main/services/auth/AuthService'
import { EventHub } from '../../../electron/main/core/EventHub'
import { Certificates, type TlsCredentials } from '../../../electron/main/server/Certificates'
import { HttpServer, RELAY_ADDRESS, type ForwardDecision } from '../../../electron/main/server/HttpServer'
import { tunnelTarget } from '../../../electron/main/services/browser/devServers'
import { MAX_PIPES, PIPE_CHUNK, RelayLink } from '../../../electron/main/server/RelayLink'
import { ServerController } from '../../../electron/main/server/ServerController'
import { SettingsService } from '../../../electron/main/services/settings/SettingsService'
import { Router } from '../../../electron/ipc/router'
import { createRemoteTransport, eventsProtocols, forwardProtocols, forwardUrl, pairingLink, parsePairingLink, FORWARD_PROTOCOL } from '@shared/ipc/transport'
import type { Device } from '@shared/types/server'

const closers: (() => unknown)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

let credentials: TlsCredentials | undefined
async function tls(): Promise<TlsCredentials> {
  credentials ??= await new Certificates({ dir: join(await tempDir(), 'tls'), hostname: () => 'Studio-Mac' }).credentials([])
  return credentials
}

/** The core's HTTPS server (loopback only, like a Mac with the LAN off), with a paired device. */
async function core(opts: { forward?: (device: Device, port: number) => ForwardDecision | Promise<ForwardDecision>; plain?: boolean; remoteTerminal?: boolean; maxForwards?: number } = {}) {
  const dir = await tempDir()
  const auth = new AuthService(join(dir, 'devices.json'))
  const hub = new EventHub()
  const router = new Router({ remoteTerminal: () => opts.remoteTerminal ?? true })
  router.register('app:info', (_req, ctx) => ctx as never)
  const http = new HttpServer({ router, hub, auth, mode: 'desktop', version: '9.9.9', remoteTerminal: () => true, hostname: () => 'Studio-Mac', forward: opts.forward, maxForwards: opts.maxForwards })
  const creds = opts.plain ? undefined : await tls()
  await http.listen('127.0.0.1', 0, creds)
  closers.push(() => http.close())
  const { code } = await auth.createPairingCode()
  const { token, device } = await auth.pair(code, 'phone')
  return { http, auth, hub, token, device, creds }
}

/** A TLS client over any byte stream, trusting exactly `creds` (what the app's pin does). */
function pinnedTls(stream: Duplex, creds: TlsCredentials): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ socket: stream, ca: creds.cert, servername: 'localhost', checkServerIdentity: () => undefined })
    socket.once('secureConnect', () => resolve(socket))
    socket.once('error', reject)
  })
}

/** One HTTP request over an already connected socket: status and JSON body. */
function requestOver(socket: Duplex, path: string, opts: { method?: string; token?: string; body?: unknown; host?: string } = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        createConnection: () => socket as Socket,
        path,
        method: opts.method ?? 'GET',
        headers: { Host: opts.host ?? '127.0.0.1:7420', 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) }
      },
      (res: IncomingMessage) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }))
      }
    )
    req.on('error', reject)
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body))
  })
}

/** Two connected streams, like the two ends of a relay pipe. */
function pipePair(): [Duplex, Duplex] {
  let a: Duplex | undefined
  let b: Duplex | undefined
  const make = (peer: () => Duplex) =>
    new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        peer().push(chunk)
        cb()
      },
      final(cb) {
        peer().push(null)
        cb()
      },
      destroy(err, cb) {
        const p = peer()
        if (!p.destroyed) p.destroy()
        cb(err)
      }
    })
  a = make(() => b!)
  b = make(() => a!)
  return [a, b]
}

describe('HttpServer — pipes from the relay', () => {
  it('a pipe speaks the core’s HTTPS: the same token check, never this computer', async () => {
    const { http, token, creds } = await core()
    /** One request through a fresh pipe (each closes after its answer). */
    const call = async (path: string, opts: Parameters<typeof requestOver>[2] = {}) => {
      const [coreEnd, phoneEnd] = pipePair()
      expect(http.attachRelay(coreEnd)).toBe(true)
      return requestOver(await pinnedTls(phoneEnd, creds!), path, opts)
    }
    expect(await call('/api/health')).toMatchObject({ status: 200, body: { ok: true, name: 'Mindeck' } })
    // Same rules as anyone on the network: no token, no call.
    expect(await call('/api/rpc/app:info', { method: 'POST', body: null })).toMatchObject({ status: 401 })
    expect(await call('/api/rpc/app:info', { method: 'POST', token, body: null })).toMatchObject({ status: 200, body: { ok: true, data: { transport: 'remote' } } })
    // A pipe that ends is counted out.
    await vi.waitFor(() => expect(http.relayCount).toBe(0))
  })

  it('a pipe that does not start TLS gets nothing in the clear', async () => {
    const { http } = await core()
    const [coreEnd, phoneEnd] = pipePair()
    expect(http.attachRelay(coreEnd)).toBe(true)
    const errored = new Promise<boolean>((resolve) => {
      phoneEnd.on('data', (chunk: Buffer) => resolve(!String(chunk).includes('"ok":true')))
      phoneEnd.on('close', () => resolve(true))
    })
    phoneEnd.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
    expect(await errored).toBe(true)
  })

  it('a pipe that breaks is closed and counted out', async () => {
    const { http } = await core()
    const [coreEnd] = pipePair()
    http.attachRelay(coreEnd)
    coreEnd.emit('error', new Error('relay gone'))
    await vi.waitFor(() => expect(http.relayCount).toBe(0))
    expect(coreEnd.destroyed).toBe(true)
  })

  it('is refused without HTTPS (the cloud would read along) and once the server is closed', async () => {
    const plain = await core({ plain: true })
    expect(plain.http.attachRelay(pipePair()[0])).toBe(false)
    const { http } = await core()
    await http.close()
    expect(http.attachRelay(pipePair()[0])).toBe(false)
  })

  it('pairing through a pipe counts as the relay, not as this computer', async () => {
    const { http, auth, creds } = await core()
    expect(RELAY_ADDRESS).toBe('relay')
    const [coreEnd, phoneEnd] = pipePair()
    http.attachRelay(coreEnd)
    const socket = await pinnedTls(phoneEnd, creds!)
    const { code } = await auth.createPairingCode()
    const paired = await requestOver(socket, '/api/pair', { method: 'POST', body: { code, name: 'away' } })
    expect(paired).toMatchObject({ status: 200, body: { ok: true, data: { device: { name: 'away' }, fingerprint: creds!.fingerprint } } })
  })
})

/** A dev server stand-in: echoes what it gets, prefixed. */
async function echoServer(host = '127.0.0.1'): Promise<{ server: NetServer; port: number; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>()
  const server = createNetServer((s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
    s.on('data', (d) => s.write(Buffer.concat([Buffer.from('echo:'), d])))
  })
  await new Promise<void>((r) => server.listen(0, host, r))
  closers.push(() => new Promise((r) => server.close(r)))
  closers.push(() => sockets.forEach((s) => s.destroy()))
  return { server, port: (server.address() as { port: number }).port, sockets }
}

function upgradeFails(url: string, protocols: string[]): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocols, { rejectUnauthorized: false })
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0)
      ws.terminate()
    })
    ws.on('open', () => resolve(101))
    ws.on('error', () => {})
  })
}

describe('HttpServer — dev-server tunnels (WS /api/forward)', () => {
  it('carries raw bytes to the dev server the policy names, in both directions', async () => {
    const dev = await echoServer()
    const decide = vi.fn((_d: Device, port: number): ForwardDecision => ({ hosts: ['127.0.0.1'], port }))
    const { http, token, device } = await core({ forward: decide })
    const url = forwardUrl(`https://127.0.0.1:${http.port}`, dev.port)
    expect(url).toBe(`wss://127.0.0.1:${http.port}/api/forward?port=${dev.port}`)
    const ws = new WebSocket(url, forwardProtocols(token), { rejectUnauthorized: false })
    await new Promise((r) => ws.once('open', r))
    expect(ws.protocol).toBe(FORWARD_PROTOCOL)
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ id: device.id }), dev.port)
    const got = new Promise<string>((r) => ws.once('message', (d) => r(String(d))))
    ws.send(Buffer.from('GET / HTTP/1.1'))
    expect(await got).toBe('echo:GET / HTTP/1.1')
    expect(dev.sockets.size).toBe(1)
    // The phone closes: the dev server's connection ends too.
    ws.close()
    await vi.waitFor(() => expect(dev.sockets.size).toBe(0))
  })

  it('tries the names in order (Vite on macOS listens on ::1 only)', async () => {
    const dev = await echoServer('::1').catch(() => null)
    if (!dev) return // no IPv6 loopback here
    const { http, token } = await core({ forward: (_d, port) => ({ hosts: ['127.0.0.1', '::1'], port }) })
    const ws = new WebSocket(forwardUrl(`https://127.0.0.1:${http.port}`, dev.port), forwardProtocols(token), { rejectUnauthorized: false })
    await new Promise((r) => ws.once('open', r))
    const got = new Promise<string>((r) => ws.once('message', (d) => r(String(d))))
    ws.send('hi')
    expect(await got).toBe('echo:hi')
    ws.close()
  })

  it('refuses before the upgrade: no token, a port the policy refuses, nothing listening, no policy', async () => {
    const dev = await echoServer()
    let decision: ForwardDecision = { error: 'not-a-dev-server' }
    const { http, token } = await core({ forward: () => decision })
    const at = (port: number | string) => `wss://127.0.0.1:${http.port}/api/forward?port=${port}`
    expect(await upgradeFails(at(dev.port), [FORWARD_PROTOCOL])).toBe(401)
    expect(await upgradeFails(at(dev.port), forwardProtocols('mindeck_wrong'))).toBe(401)
    // The events socket's token offer never opens a tunnel without the right answer either.
    expect(await upgradeFails(at(dev.port), eventsProtocols(token))).toBe(404)
    expect(await upgradeFails(at('abc'), forwardProtocols(token))).toBe(400)
    expect(await upgradeFails(at(dev.port), forwardProtocols(token))).toBe(404)
    decision = { error: 'remote-terminal-disabled' }
    expect(await upgradeFails(at(dev.port), forwardProtocols(token))).toBe(403)
    // Allowed, but nothing listens there.
    const free = await echoServer()
    await new Promise((r) => free.server.close(r))
    decision = { hosts: ['127.0.0.1'], port: free.port }
    expect(await upgradeFails(at(free.port), forwardProtocols(token))).toBe(502)
    const none = await core()
    expect(await upgradeFails(`wss://127.0.0.1:${none.http.port}/api/forward?port=${dev.port}`, forwardProtocols(none.token))).toBe(403)
  })

  it('a removed device’s tunnels end, and all of them when remote shells go off', async () => {
    const dev = await echoServer()
    const { http, token, device, auth } = await core({ forward: (_d, port) => ({ hosts: ['127.0.0.1'], port }) })
    const open = async (t: string) => {
      const ws = new WebSocket(forwardUrl(`https://127.0.0.1:${http.port}`, dev.port), forwardProtocols(t), { rejectUnauthorized: false })
      await new Promise((r) => ws.once('open', r))
      return ws
    }
    const mine = await open(token)
    const other = await auth.pair((await auth.createPairingCode()).code, 'tablet')
    const theirs = await open(other.token)
    await vi.waitFor(() => expect(dev.sockets.size).toBe(2))
    http.disconnectDevice(device.id)
    await new Promise((r) => mine.once('close', r))
    expect(theirs.readyState).toBe(WebSocket.OPEN)
    http.closeForwards()
    await new Promise((r) => theirs.once('close', r))
    await vi.waitFor(() => expect(dev.sockets.size).toBe(0))
  })
})

describe('HttpServer — dev-server tunnels: edges', () => {
  it('answers only a client that asks for the tunnel’s protocol; a failing device store is a 503', async () => {
    const dev = await echoServer()
    const { http, token, auth } = await core({ forward: (_d, port) => ({ hosts: ['127.0.0.1'], port }) })
    const url = forwardUrl(`https://127.0.0.1:${http.port}`, dev.port)
    // The token alone, without `mindeck.forward`: the core picks no protocol, the client gives up.
    const failed = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url, [`mindeck.bearer.${token}`], { rejectUnauthorized: false })
      ws.on('open', () => resolve(false))
      ws.on('error', () => resolve(true))
    })
    expect(failed).toBe(true)
    vi.spyOn(auth, 'verify').mockRejectedValueOnce(new Error('disk gone'))
    expect(await upgradeFails(url, forwardProtocols(token))).toBe(503)
  })

  it('a device holds a bounded number of tunnels; one whose phone gave up meanwhile is not opened', async () => {
    const dev = await echoServer()
    let gone: (() => void) | undefined
    const { http, token } = await core({
      maxForwards: 1,
      forward: async (_d, port) => {
        // The phone hangs up while the core decides: the dev server's connection must not stay behind.
        if (gone) {
          gone()
          await tick(30)
        }
        return { hosts: ['127.0.0.1'], port }
      }
    })
    const url = forwardUrl(`https://127.0.0.1:${http.port}`, dev.port)
    const first = new WebSocket(url, forwardProtocols(token), { rejectUnauthorized: false })
    await new Promise((r) => first.once('open', r))
    expect(await upgradeFails(url, forwardProtocols(token))).toBe(429)
    first.close()
    await vi.waitFor(() => expect(dev.sockets.size).toBe(0))
    const quitter = new WebSocket(url, forwardProtocols(token), { rejectUnauthorized: false })
    quitter.on('error', () => {})
    gone = () => quitter.terminate()
    await new Promise((r) => quitter.once('close', r))
    await tick(60)
    expect(dev.sockets.size).toBe(0)
  })

  it('tunnels go to this machine only: the listed server’s loopback, both for localhost', () => {
    const at = (url: string) => ({ url, label: '', terminalId: 't', detectedAt: '' })
    expect(tunnelTarget([at('http://localhost:5173/')], 5173)).toEqual({ hosts: ['127.0.0.1', '::1'], port: 5173 })
    expect(tunnelTarget([at('http://127.0.0.1:3000/')], 3000)).toEqual({ hosts: ['127.0.0.1'], port: 3000 })
    expect(tunnelTarget([at('http://[::1]:4321/')], 4321)).toEqual({ hosts: ['::1'], port: 4321 })
    expect(tunnelTarget([at('http://app.localhost:8080/')], 8080)).toEqual({ hosts: ['127.0.0.1', '::1'], port: 8080 })
    expect(tunnelTarget([at('http://localhost:5173/')], 5174)).toBeNull()
    // Never a way into the LAN, however the list came about.
    expect(tunnelTarget([at('http://192.168.1.9:5173/')], 5173)).toBeNull()
  })
})

describe('HttpServer — dev-server tunnels: revocation, limits, dead peers', () => {
  /** A policy that holds every decision until `release()` — the window in which a revocation may land. */
  const gated = () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let allow = true
    const decide = vi.fn(async (_d: Device, port: number): Promise<ForwardDecision> => {
      await gate
      return allow ? { hosts: ['127.0.0.1'], port } : { error: 'remote-terminal-disabled' }
    })
    return { decide, release: () => release(), deny: () => (allow = false) }
  }

  it('a device removed while its tunnel is set up gets none', async () => {
    const dev = await echoServer()
    const g = gated()
    const { http, token, device, auth } = await core({ forward: g.decide })
    const pending = upgradeFails(forwardUrl(`https://127.0.0.1:${http.port}`, dev.port), forwardProtocols(token))
    await vi.waitFor(() => expect(g.decide).toHaveBeenCalled())
    await auth.revoke(device.id)
    http.disconnectDevice(device.id)
    g.release()
    expect(await pending).toBe(403)
    await vi.waitFor(() => expect(dev.sockets.size).toBe(0))
  })

  it('a device store that fails when asked again counts as no: no tunnel', async () => {
    const dev = await echoServer()
    const g = gated()
    const { http, token, auth } = await core({ forward: g.decide })
    const pending = upgradeFails(forwardUrl(`https://127.0.0.1:${http.port}`, dev.port), forwardProtocols(token))
    await vi.waitFor(() => expect(g.decide).toHaveBeenCalled())
    vi.spyOn(auth, 'verify').mockRejectedValueOnce(new Error('disk gone'))
    http.disconnectDevice('someone-else')
    g.release()
    expect(await pending).toBe(403)
  })

  it('remote shells switched off while a tunnel is set up: none; another device removed meanwhile: it opens', async () => {
    const dev = await echoServer()
    let g = gated()
    const { http, token, auth } = await core({ forward: (d, p) => g.decide(d, p) })
    const url = forwardUrl(`https://127.0.0.1:${http.port}`, dev.port)
    let pending = upgradeFails(url, forwardProtocols(token))
    await vi.waitFor(() => expect(g.decide).toHaveBeenCalled())
    http.closeForwards()
    g.deny()
    g.release()
    expect(await pending).toBe(403)
    // Someone else removed: asked again, and still allowed.
    g = gated()
    const other = await auth.pair((await auth.createPairingCode()).code, 'tablet')
    pending = upgradeFails(url, forwardProtocols(token))
    await vi.waitFor(() => expect(g.decide).toHaveBeenCalled())
    await auth.revoke(other.device.id)
    http.disconnectDevice(other.device.id)
    g.release()
    expect(await pending).toBe(101)
  })

  it('tunnels on their way count against the limit: six at once, two open', async () => {
    const dev = await echoServer()
    const g = gated()
    const { http, token } = await core({ maxForwards: 2, forward: g.decide })
    const url = forwardUrl(`https://127.0.0.1:${http.port}`, dev.port)
    const all = Array.from({ length: 6 }, () => upgradeFails(url, forwardProtocols(token)))
    await vi.waitFor(() => expect(g.decide).toHaveBeenCalledTimes(2))
    g.release()
    const codes = await Promise.all(all)
    expect(codes.filter((c) => c === 101)).toHaveLength(2)
    expect(codes.filter((c) => c === 429)).toHaveLength(4)
  })

  it('a handshake ws refuses (400) leaves no dev-server connection behind', async () => {
    const dev = await echoServer()
    const { http, token } = await core({ forward: (_d, port) => ({ hosts: ['127.0.0.1'], port }) })
    const socket = await new Promise<TLSSocket>((resolve) => {
      const s = tlsConnect({ host: '127.0.0.1', port: http.port, rejectUnauthorized: false }, () => resolve(s))
    })
    const answer = new Promise<string>((resolve) => socket.once('data', (d) => resolve(String(d))))
    socket.write(
      `GET /api/forward?port=${dev.port} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 99\r\nSec-WebSocket-Protocol: ${forwardProtocols(token).join(', ')}\r\n\r\n`
    )
    expect(await answer).toMatch(/^HTTP\/1\.1 400/)
    await vi.waitFor(() => expect(dev.sockets.size).toBe(0))
    socket.destroy()
  })

  it('a tunnel whose phone stopped answering pings is closed at the next heartbeat; a live one stays', async () => {
    const dev = await echoServer()
    const { http, token } = await core({ forward: (_d, port) => ({ hosts: ['127.0.0.1'], port }) })
    const ws = new WebSocket(forwardUrl(`https://127.0.0.1:${http.port}`, dev.port), forwardProtocols(token), { rejectUnauthorized: false })
    await new Promise((r) => ws.once('open', r))
    const sweep = () => (http as unknown as { sweep(): void }).sweep()
    sweep()
    await new Promise((r) => ws.once('ping', r))
    await tick(30)
    sweep() // it answered: still open
    expect(ws.readyState).toBe(WebSocket.OPEN)
    sweep() // no pong in between: dead
    await new Promise((r) => ws.once('close', r))
    await vi.waitFor(() => expect(dev.sockets.size).toBe(0))
  })
})

describe('RelayLink — edges', () => {
  it('starts once; waking or refreshing a stopped link does nothing; a stopped attempt that resolves late stays stopped', async () => {
    const cloud = await fakeCloud()
    let release: ((t: string) => void) | undefined
    const link = new RelayLink({ cloudUrl: () => `${cloud.url}/`, token: () => new Promise<string>((r) => (release = r)), attach: () => false })
    link.wake()
    link.refresh()
    link.sleep() // not connected: nothing to tell
    link.start()
    link.start()
    link.stop()
    release!('core-session')
    await tick(30)
    expect(cloud.tokens).toEqual([])
    expect(link.status()).toEqual({ state: 'off' })
  })

  it('a session store that fails counts as signed out; the cloud refusing a core or erring is said so', async () => {
    const cloud = await fakeCloud()
    let failing = true
    const link = new RelayLink({
      cloudUrl: () => cloud.url,
      token: async () => {
        if (failing) throw new Error('keychain locked')
        return 'core-session'
      },
      attach: () => false,
      minDelayMs: 10
    })
    closers.push(() => link.stop())
    link.start()
    await vi.waitFor(() => expect(link.status()).toEqual({ state: 'unavailable', reason: 'signed-out' }))
    link.refresh() // still failing: stays as it is
    await tick(20)
    failing = false
    cloud.refuse = 403
    link.refresh()
    await vi.waitFor(() => expect(link.status()).toEqual({ state: 'error', reason: 'core-only' }))
    cloud.refuse = 500
    link.wake()
    await vi.waitFor(() => expect(link.status()).toEqual({ state: 'error', reason: 'http-500' }))
    cloud.refuse = undefined
    await vi.waitFor(() => expect(link.status().state).toBe('online'))
    cloud.controls.at(-1)!.close(4401, 'session_invalid')
    await vi.waitFor(() => expect(link.status()).toEqual({ state: 'error', reason: 'session-invalid' }))
  })

  it('a flood of opens dials at most MAX_PIPES; a new account ends the old session’s pipes', async () => {
    const cloud = await fakeCloud('second')
    let token = 'second'
    const link = new RelayLink({ cloudUrl: () => cloud.url, token: async () => token, attach: () => true })
    closers.push(() => link.stop())
    link.start()
    await vi.waitFor(() => expect(link.status().state).toBe('online'))
    for (let i = 0; i < MAX_PIPES + 5; i += 1) cloud.controls[0].send(JSON.stringify({ t: 'open', pipe: i.toString(16).padStart(32, '0') }))
    await vi.waitFor(() => expect(cloud.accepted.size).toBe(MAX_PIPES))
    await tick(50)
    expect(cloud.accepted.size).toBe(MAX_PIPES)
    // Signed in as someone else: every pipe of the old session goes.
    token = 'third'
    link.refresh()
    await vi.waitFor(() => expect([...cloud.accepted.values()].every((ws) => ws.readyState === WebSocket.CLOSED)).toBe(true))
  })

  it('a big answer leaves in pieces the cloud takes (≤ 64 KiB each), whole and in order', async () => {
    const cloud = await fakeCloud()
    const dir = await tempDir()
    const auth = new AuthService(join(dir, 'devices.json'))
    const router = new Router({ remoteTerminal: () => true })
    const big = Array.from({ length: 3 * 1024 * 1024 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')
    router.register('app:info', () => ({ big }) as never)
    const http = new HttpServer({ router, hub: new EventHub(), auth, mode: 'desktop', version: '1', remoteTerminal: () => true })
    const creds = await tls()
    await http.listen('127.0.0.1', 0, creds)
    closers.push(() => http.close())
    const { token } = await auth.pair((await auth.createPairingCode()).code, 'p')
    const link = new RelayLink({ cloudUrl: () => cloud.url, token: async () => 'core-session', attach: (p) => http.attachRelay(p) })
    closers.push(() => link.stop())
    link.start()
    await vi.waitFor(() => expect(link.status().state).toBe('online'))
    const pipe = await cloud.open()
    const sizes: number[] = []
    ;[...cloud.accepted.values()].at(-1)!.on('message', (m: Buffer) => sizes.push(m.length))
    const phone = await pinnedTls(pipe, creds)
    const res = await requestOver(phone, '/api/rpc/app:info', { method: 'POST', token, body: null })
    expect((res.body as { data: { big: string } }).data.big).toBe(big)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(PIPE_CHUNK)
    expect(sizes.length).toBeGreaterThan(40)
  })

  it('an account without a license is told so — on the way in and while connected — and not asked again at once', async () => {
    const cloud = await fakeCloud()
    cloud.refuse = 403
    cloud.refuseBody = JSON.stringify({ error: { code: 'license_required', message: 'trial expired' } })
    const link = new RelayLink({ cloudUrl: () => cloud.url, token: async () => 'core-session', attach: () => false, minDelayMs: 10 })
    closers.push(() => link.stop())
    link.start()
    await vi.waitFor(() => expect(link.status()).toEqual({ state: 'error', reason: 'license-required' }))
    const tries = cloud.tokens.length
    await tick(50)
    expect(cloud.tokens.length).toBe(tries)
    // A body that says nothing: a 403 is a session that cannot hold a core.
    cloud.refuseBody = 'not json'
    link.wake()
    await vi.waitFor(() => expect(link.status()).toEqual({ state: 'error', reason: 'core-only' }))
    cloud.refuse = undefined
    link.wake()
    await vi.waitFor(() => expect(link.status().state).toBe('online'))
    cloud.controls.at(-1)!.close(4402, 'license_required')
    await vi.waitFor(() => expect(link.status()).toEqual({ state: 'error', reason: 'license-required' }))
  })

  it('a pipe the cloud refuses, or the server does not take, ends', async () => {
    const cloud = await fakeCloud()
    const attach = vi.fn(() => false)
    const link = new RelayLink({ cloudUrl: () => cloud.url, token: async () => 'core-session', attach })
    closers.push(() => link.stop())
    link.start()
    await vi.waitFor(() => expect(link.status().state).toBe('online'))
    await cloud.open()
    // Not taken: the core hangs up that pipe.
    await vi.waitFor(() => expect([...cloud.accepted.values()].at(-1)!.readyState).toBe(WebSocket.CLOSED))
    expect(attach).toHaveBeenCalledTimes(1)
    cloud.refuseAccept = true
    cloud.controls[0].send(JSON.stringify({ t: 'open', pipe: 'ab'.repeat(16) }))
    await vi.waitFor(() => expect(cloud.refusedAccepts).toBe(1))
    await vi.waitFor(() => expect(link.status().pipes).toBe(0))
  })
})

// --- RelayLink against a stand-in for Mindeck Cloud ------------------------

interface FakeCloud {
  url: string
  server: Server
  /** The core's control connection(s), newest last. */
  controls: WebSocket[]
  /** What the core sent on its control connection. */
  said: unknown[]
  /** Accepted pipes by id. */
  accepted: Map<string, WebSocket>
  /** Tells the core a phone wants in; resolves the phone's end once the core accepted. */
  open(): Promise<Duplex>
  /** Refuse the next control connections with this HTTP status (and body). */
  refuse?: number
  refuseBody?: string
  /** Refuse the core's accepts (404), counting them. */
  refuseAccept?: boolean
  refusedAccepts: number
  tokens: string[]
}

/** Just enough of Mindeck Cloud's relay: `core`, `accept` and a way for a "phone" in. */
async function fakeCloud(token = 'core-session'): Promise<FakeCloud> {
  const wss = new WebSocketServer({ noServer: true })
  const server = createHttpServer()
  const cloud: FakeCloud = {
    url: '',
    server,
    controls: [],
    said: [],
    accepted: new Map(),
    tokens: [],
    refusedAccepts: 0,
    open: async () => {
      const pipe = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
      cloud.controls.at(-1)!.send(JSON.stringify({ t: 'open', pipe }))
      await vi.waitFor(() => expect(cloud.accepted.has(pipe)).toBe(true))
      return createWebSocketStream(cloud.accepted.get(pipe)!)
    }
  }
  server.on('upgrade', (req, socket, head) => {
    const auth = String(req.headers.authorization ?? '')
    cloud.tokens.push(auth)
    const url = new URL(req.url!, 'http://x')
    if (cloud.refuseAccept && url.pathname === '/v1/relay/accept') {
      cloud.refusedAccepts += 1
      socket.end('HTTP/1.1 404 No\r\nConnection: close\r\n\r\n')
      return
    }
    if (cloud.refuse || auth !== `Bearer ${token}`) {
      const body = cloud.refuseBody ?? ''
      socket.end(`HTTP/1.1 ${cloud.refuse ?? 401} No\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname === '/v1/relay/core') {
        cloud.controls.push(ws)
        ws.on('message', (d) => cloud.said.push(JSON.parse(String(d))))
        ws.send(JSON.stringify({ t: 'ready', installId: 'install-1' }))
      } else if (url.pathname === '/v1/relay/accept') {
        cloud.accepted.set(url.searchParams.get('pipe')!, ws)
      } else ws.close()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  cloud.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  closers.push(() => {
    for (const c of wss.clients) c.terminate()
    return new Promise((r) => server.close(r))
  })
  return cloud
}

describe('RelayLink', () => {
  it('dials out with the core’s session, goes online, and hands each pipe to the HTTPS server — end to end', async () => {
    const cloud = await fakeCloud()
    const { http, token, creds } = await core()
    const states: string[] = []
    const link = new RelayLink({ cloudUrl: () => cloud.url, token: async () => 'core-session', attach: (p) => http.attachRelay(p), onStatus: (s) => states.push(s.state) })
    closers.push(() => link.stop())
    link.start()
    await vi.waitFor(() => expect(link.status().state).toBe('online'))
    expect(cloud.tokens[0]).toBe('Bearer core-session')
    expect(states).toEqual(['connecting', 'online'])

    // A phone through the relay: its TLS ends at the core, with the pinned certificate.
    const pipe = await cloud.open()
    const phone = await pinnedTls(pipe, creds!)
    expect(link.status()).toMatchObject({ state: 'online', pipes: 1 })
    const info = await requestOver(phone, '/api/rpc/app:info', { method: 'POST', token, body: null })
    expect(info).toMatchObject({ status: 200, body: { ok: true, data: { transport: 'remote' } } })
    // Every pipe dials back with the session too.
    expect(cloud.tokens.at(-1)).toBe('Bearer core-session')
    // The phone's end goes: the cloud closes the core's pipe, and the core counts it out.
    pipe.destroy()
    await vi.waitFor(() => expect(http.relayCount).toBe(0))
    expect(link.status().pipes).toBe(0)
  })

  it('the full app transport through the relay: calls and the events socket', async () => {
    const cloud = await fakeCloud()
    const { http, hub, token, creds } = await core()
    const link = new RelayLink({ cloudUrl: () => cloud.url, token: async () => 'core-session', attach: (p) => http.attachRelay(p) })
    closers.push(() => link.stop())
    link.start()
    await vi.waitFor(() => expect(link.status().state).toBe('online'))
    // What the phone's native forwarder does: a local port whose connections each become a relay pipe.
    const forwarder = createNetServer((local) => {
      void cloud.open().then((pipe) => {
        local.pipe(pipe).pipe(local)
        pipe.on('error', () => local.destroy())
        local.on('error', () => pipe.destroy())
      })
    })
    await new Promise<void>((r) => forwarder.listen(0, '127.0.0.1', r))
    closers.push(() => new Promise((r) => forwarder.close(r)))
    const base = `https://127.0.0.1:${(forwarder.address() as { port: number }).port}`
    const agent = new HttpsAgent({ ca: creds!.cert, checkServerIdentity: () => undefined })
    const fetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
      new Promise<{ status: number; json(): Promise<unknown> }>((resolve, reject) => {
        const req = httpsRequest(url, { method: init?.method ?? 'GET', headers: init?.headers, agent }, (res) => {
          let text = ''
          res.on('data', (c) => (text += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: async () => JSON.parse(text) }))
        })
        req.on('error', reject)
        req.end(init?.body)
      })
    class PinnedWs extends WebSocket {
      constructor(url: string, protocols?: string[]) {
        // tls reads a returned value as the error (ws's types say boolean).
        super(url, protocols, { ca: creds!.cert, checkServerIdentity: (() => undefined) as never })
      }
    }
    const transport = createRemoteTransport({ baseUrl: base, token, fetch: fetchLike, WebSocket: PinnedWs as never })
    closers.push(() => transport.close())
    expect(await transport.invoke('app:info')).toMatchObject({ ok: true, data: { transport: 'remote' } })
    const events: unknown[] = []
    transport.on('memory:changed', (p) => events.push(p))
    await vi.waitFor(() => expect(http.clientCount).toBe(1))
    hub.publish('memory:changed', { paths: ['a.md'] })
    await vi.waitFor(() => expect(events).toEqual([{ paths: ['a.md'] }]))
    agent.destroy()
  })

  it('signed out: unavailable until the account is back; a new session reconnects, the same one does not', async () => {
    const cloud = await fakeCloud('second')
    let token: string | null = null
    const link = new RelayLink({ cloudUrl: () => cloud.url, token: async () => token, attach: () => false, minDelayMs: 10, maxDelayMs: 20 })
    closers.push(() => link.stop())
    link.start()
    await vi.waitFor(() => expect(link.status()).toEqual({ state: 'unavailable', reason: 'signed-out' }))
    token = 'second'
    link.refresh()
    await vi.waitFor(() => expect(link.status().state).toBe('online'))
    const connections = cloud.controls.length
    link.refresh()
    await tick(30)
    expect(cloud.controls.length).toBe(connections)
  })

  it('a refused session waits (no hammering); a replaced link backs off; a dropped one comes back', async () => {
    const cloud = await fakeCloud()
    cloud.refuse = 401
    const link = new RelayLink({ cloudUrl: () => cloud.url, token: async () => 'core-session', attach: () => false, minDelayMs: 10, maxDelayMs: 600 })
    closers.push(() => link.stop())
    link.start()
    await vi.waitFor(() => expect(link.status()).toEqual({ state: 'error', reason: 'session-invalid' }))
    const tries = cloud.tokens.length
    await tick(60)
    expect(cloud.tokens.length).toBe(tries) // five minutes, not 10 ms
    cloud.refuse = undefined
    link.wake()
    await vi.waitFor(() => expect(link.status().state).toBe('online'))
    // The cloud ends the connection (a deploy): back by itself.
    cloud.controls.at(-1)!.terminate()
    await vi.waitFor(() => expect(cloud.controls.length).toBe(2))
    await vi.waitFor(() => expect(link.status().state).toBe('online'))
    cloud.controls.at(-1)!.close(4009, 'replaced')
    await vi.waitFor(() => expect(link.status()).toEqual({ state: 'error', reason: 'replaced' }))
    cloud.controls.at(-1)!.close(4401, 'session_invalid')
  })

  it('tells the cloud the Mac sleeps; after waking it dials anew; silence counts as a dead connection', async () => {
    const cloud = await fakeCloud()
    const link = new RelayLink({ cloudUrl: () => cloud.url, token: async () => 'core-session', attach: () => false, minDelayMs: 10, silenceMs: 80 })
    closers.push(() => link.stop())
    link.start()
    await vi.waitFor(() => expect(link.status().state).toBe('online'))
    // The cloud's pings keep it alive past the silence limit.
    const pings = setInterval(() => cloud.controls.at(-1)!.ping(), 20)
    await tick(200)
    clearInterval(pings)
    expect(cloud.controls.length).toBe(1)
    link.sleep()
    await vi.waitFor(() => expect(cloud.said).toEqual([{ t: 'sleep' }]))
    link.wake()
    await vi.waitFor(() => expect(cloud.controls.length).toBe(2))
    // Nothing from the cloud (no ping, no message) for longer than allowed: dropped and dialled again.
    await vi.waitFor(() => expect(cloud.controls.length).toBeGreaterThanOrEqual(3), { timeout: 2000 })
  })

  it('dials only pipe ids it can trust, and none after stopping', async () => {
    const cloud = await fakeCloud()
    const attach = vi.fn(() => true)
    const link = new RelayLink({ cloudUrl: () => cloud.url, token: async () => 'core-session', attach })
    link.start()
    await vi.waitFor(() => expect(link.status().state).toBe('online'))
    cloud.controls[0].send(JSON.stringify({ t: 'open', pipe: '../../v1/admin' }))
    cloud.controls[0].send('not json')
    cloud.controls[0].send(Buffer.from([1, 2, 3]))
    await tick(50)
    expect(cloud.accepted.size).toBe(0)
    link.stop()
    expect(link.status()).toEqual({ state: 'off' })
    expect(link.active).toBe(false)
  })
})

describe('ServerController — away access', () => {
  const base = async () => {
    const dir = await tempDir()
    const settings = new SettingsService(join(dir, 'settings.json'))
    await settings.init()
    return {
      settings,
      deps: {
        mode: 'desktop' as const,
        version: '1.0.0',
        router: new Router({ remoteTerminal: () => false }),
        hub: new EventHub(),
        auth: new AuthService(join(dir, 'devices.json')),
        certificates: new Certificates({ dir: join(dir, 'tls') })
      }
    }
  }

  it('runs the link with HTTPS only, says why not otherwise, and names the core in the pairing link', async () => {
    const { settings, deps } = await base()
    const link = { start: vi.fn(), stop: vi.fn(), sleep: vi.fn(), wake: vi.fn(), refresh: vi.fn(), active: true, status: vi.fn(() => ({ state: 'online' as const, pipes: 0 })) }
    const createRelay = vi.fn((_opts: { attach: (pipe: Duplex) => boolean }) => link as never)
    let installId = 'install-1'
    const controller = new ServerController({
      ...deps,
      settings,
      relay: { cloudUrl: () => 'https://api.example', token: async () => 'core-session', installId: () => installId },
      createRelay,
      createServer: () => ({ listen: vi.fn(async () => {}), close: vi.fn(async () => {}), attachRelay: vi.fn(() => true), setTls: vi.fn(), closeForwards: vi.fn(), port: 7420 }) as never
    })
    closers.push(() => controller.stop())
    expect(controller.relayStatus()).toEqual({ state: 'unavailable', reason: 'server-off' })
    expect(controller.port()).toBe(7420) // off: the configured one
    // On by default; LAN off — the relay alone switches HTTPS on.
    let status = await controller.configure({ enabled: true })
    expect(status.tls).toBeDefined()
    expect(createRelay).toHaveBeenCalledTimes(1)
    expect(link.start).toHaveBeenCalled()
    expect(status.relay).toEqual({ state: 'online', pipes: 0 })
    expect(controller.relayInfo()).toEqual({ installId: 'install-1' })
    // Pipes go to the running server.
    expect(createRelay.mock.calls[0][0].attach(pipePair()[0])).toBe(true)
    link.status.mockReturnValueOnce({ state: 'error', pipes: 0 } as never)
    expect(controller.relayInfo()).toBeUndefined()
    // A cloud service not set up yet has no id to give.
    installId = ''
    expect(controller.relayInfo()).toBeUndefined()
    installId = 'install-1'
    const code = await controller.createPairingCode()
    expect(code.installId).toBe('install-1')
    const url = pairingLink(code.urls[0].replace('http:', 'https:'), code.code, code.fingerprint, code.spkiFingerprint, code.installId)
    expect(parsePairingLink(url)).toMatchObject({ installId: 'install-1', fingerprint: code.fingerprint })

    controller.relaySleep()
    controller.relayWake()
    controller.relayRefresh()
    expect([link.sleep, link.wake, link.refresh].every((f) => f.mock.calls.length === 1)).toBe(true)

    // Off: the link stops, without a restart; without TLS (nothing else wants it) the server restarts plain.
    status = await controller.configure({ relay: false })
    expect(link.stop).toHaveBeenCalled()
    expect(status.relay).toEqual({ state: 'off' })
    expect(status.tls).toBeUndefined()
    expect(controller.relayInfo()).toBeUndefined()
    expect((await controller.createPairingCode()).installId).toBeUndefined()

    // HTTPS switched off: away access cannot run (the cloud would see the connection in the clear).
    status = await controller.configure({ relay: true, tls: false })
    expect(status.relay).toEqual({ state: 'unavailable', reason: 'tls-off' })
    expect(createRelay).toHaveBeenCalledTimes(1)
  })

  it('a core without a cloud keeps the LAN’s rules: no HTTPS just for the relay', async () => {
    const { settings, deps } = await base()
    const controller = new ServerController({
      ...deps,
      settings,
      createServer: () => ({ listen: vi.fn(async () => {}), close: vi.fn(async () => {}), port: 7420 }) as never
    })
    closers.push(() => controller.stop())
    const status = await controller.configure({ enabled: true })
    expect(status.tls).toBeUndefined()
    expect(status.relay).toEqual({ state: 'off' })
  })
})

describe('transport — a base that moves (Wi-Fi ↔ relay)', () => {
  it('asks for the base before every call and socket; reconnect() moves the socket and resumes the stream', async () => {
    const opened: string[] = []
    const sockets: { url: string; close: () => void; onopen: ((e: unknown) => void) | null; onclose: ((e: unknown) => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onerror: null }[] = []
    class FakeSocket {
      onopen: ((e: unknown) => void) | null = null
      onclose: ((e: unknown) => void) | null = null
      onmessage: ((e: { data: unknown }) => void) | null = null
      onerror = null
      constructor(readonly url: string) {
        opened.push(url)
        sockets.push(this as never)
      }
      close() {
        this.onclose?.({ code: 1000 })
      }
    }
    let base = 'https://192.168.1.5:7420'
    const calls: string[] = []
    const transport = createRemoteTransport({
      baseUrl: () => base,
      token: 't',
      fetch: async (url) => {
        calls.push(url)
        return { status: 200, json: async () => ({ ok: true, data: null }) }
      },
      WebSocket: FakeSocket as never
    })
    await transport.invoke('app:info')
    transport.on('memory:changed', () => {})
    sockets[0].onopen?.({})
    sockets[0].onmessage?.({ data: JSON.stringify({ channel: 'hello', payload: { stream: 's1', seq: 0 } }) })
    sockets[0].onmessage?.({ data: JSON.stringify({ channel: 'memory:changed', payload: {}, seq: 1 }) })
    base = 'https://127.0.0.1:50123'
    transport.reconnect()
    await transport.invoke('app:info')
    expect(calls).toEqual(['https://192.168.1.5:7420/api/rpc/app:info', 'https://127.0.0.1:50123/api/rpc/app:info'])
    expect(opened).toEqual(['wss://192.168.1.5:7420/api/events', 'wss://127.0.0.1:50123/api/events?stream=s1&since=1'])
    // The socket drops: a retry waits. Reconnecting now replaces the wait.
    sockets[1].onopen?.({})
    sockets[1].close()
    expect(opened).toHaveLength(2)
    transport.reconnect()
    expect(opened).toHaveLength(3)
    transport.close()
    transport.reconnect() // closed: nothing
    expect(opened).toHaveLength(3)
    // Nobody listens: nothing to reconnect.
    const quiet = createRemoteTransport({ baseUrl: () => base, token: 't', WebSocket: FakeSocket as never })
    quiet.reconnect()
    expect(opened).toHaveLength(3)
  })

  it('the pairing link names the core at the cloud only next to a pinned certificate', () => {
    const fp = 'AB'.repeat(32)
    expect(pairingLink('https://192.168.1.5:7420', 'K7QM-2XPA', fp, fp, 'install-1')).toBe(`https://192.168.1.5:7420/#pair=K7QM-2XPA&fp=${'ab'.repeat(32)}&pk=${'ab'.repeat(32)}&ci=install-1`)
    expect(pairingLink('https://192.168.1.5:7420', 'K7QM-2XPA', undefined, undefined, 'install-1')).toBe('https://192.168.1.5:7420/#pair=K7QM-2XPA')
    expect(pairingLink('https://x', 'C', fp, fp, 'no spaces allowed')).not.toContain('&ci=')
    expect(parsePairingLink(`https://x/#pair=C&ci=install-1`)).not.toHaveProperty('installId')
    expect(parsePairingLink(`https://x/#pair=C&fp=${fp}&ci=install-1`)).toMatchObject({ installId: 'install-1' })
    expect(parsePairingLink(`https://x/#pair=C&fp=${fp}&ci=a`)).not.toHaveProperty('installId')
  })
})
