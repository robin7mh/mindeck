import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { X509Certificate, randomUUID } from 'node:crypto'
import { connect as connectTcp, createServer as createNetServer, isIP, type Server as NetServer, type Socket } from 'node:net'
import { hostname as osHostname } from 'node:os'
import type { TLSSocket } from 'node:tls'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocketServer, createWebSocketStream, type WebSocket } from 'ws'
import { DESKTOP_EVENTS, TERMINAL_EVENTS, type IpcEvent } from '@shared/ipc/contract'
import { EVENTS_PROTOCOL, FORWARD_PROTOCOL, TOKEN_PROTOCOL_PREFIX } from '@shared/ipc/transport'
import type { PermissionRequest } from '@shared/types/ai'
import type { CoreMode, Device } from '@shared/types/server'
import type { Router } from '../../ipc/router'
import type { EventHub } from '../core/EventHub'
import type { AuthService } from '../services/auth/AuthService'
import type { TlsCredentials } from './Certificates'
import { DeviceRateLimiter, type RateLimits } from './RateLimit'
import { EventStreams, REPLAY_LIMITS, type ReplayLimits } from './EventStreams'

const MAX_BODY = 8 * 1024 * 1024
/** A pairing request (before anyone is known) holds a code and a name. */
const MAX_PAIR_BODY = 16 * 1024
const PAIR_WINDOW_MS = 10 * 60_000
const PAIR_MAX_FAILURES = 10
/** Addresses whose failed pairings are remembered at most — the oldest give way. */
const PAIR_MAX_TRACKED = 1000
/** Open connections at most (a phone, a browser or two — never thousands). */
const MAX_CONNECTIONS = 512
const HEARTBEAT_MS = 30_000
/** Unsent bytes a WebSocket client may fall behind before it is dropped. */
const MAX_BUFFERED = 16 * 1024 * 1024
/** "Stay paired in this browser": the cookie lives as long as browsers let one (400 days) — the token's own idle expiry (90 days) still holds. */
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60
/** The first byte of a TLS handshake: the connection speaks HTTPS. */
const TLS_HANDSHAKE = 0x16
/** A connection that sends nothing is dropped after this long. */
const FIRST_BYTE_MS = 10_000
/** A well-formed Host header (name or IP, optional port). */
const HOST = /^([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d{1,5})?$/i
/** What a connection through the Mindeck Cloud relay counts as: no address of its own, never this computer. */
export const RELAY_ADDRESS = 'relay'
/** Relay pipes open at once at most (a phone's calls, its events socket, a browser preview's connections). */
const MAX_RELAY_PIPES = 128
/** Dev-server tunnels per device at most (a page opens a handful, a dev server's HMR one more). */
const MAX_FORWARDS_PER_DEVICE = 64
/** How long a dev server gets to take the tunnel's connection. */
const FORWARD_CONNECT_MS = 5000
/** Idle HTTP connections stay open this long: over the relay, a new one costs a round through the cloud and a TLS handshake. */
const KEEP_ALIVE_MS = 30_000

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8'
}

/** Same policy as index.html, enforced as a header for the served web UI. */
const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin'
}

/** Remote clients get system ticks while connected; these are no-ops for them. */
const REMOTE_NOOP = new Set(['system:subscribe', 'system:unsubscribe'])

export interface HttpServerOptions {
  router: Router
  hub: EventHub
  auth: AuthService
  mode: CoreMode
  version: string
  /** Built web UI to serve at `/` (optional — API-only without it). */
  webRoot?: string
  remoteTerminal: () => boolean
  /** Connected WebSocket clients changed (drives remote telemetry sampling). */
  onClients?: (count: number) => void
  /** A push event as devices may see it (RemoteScope): itself, trimmed, or null — none of theirs. */
  scope?: (channel: IpcEvent, payload: unknown) => Promise<unknown>
  /**
   * More names the core answers to besides its addresses, `localhost`, the
   * machine's name and its certificate's (`MINDECK_ALLOWED_HOSTS`): a reverse
   * proxy's domain, `.example.com` for its subdomains, `*` for any.
   */
  allowedHosts?: string[]
  /** The machine's name (tests pass their own). */
  hostname?: () => string
  /** How long one scope check may take, and how many events may wait for theirs (defaults below; tests shorten them). */
  outbox?: { timeoutMs?: number; max?: number }
  /**
   * May `device` open a tunnel to `localhost:<port>` (`WS /api/forward`)? The address to
   * connect to, or the refusal's code. Without it there are no tunnels.
   */
  forward?: (device: Device, port: number) => ForwardDecision | Promise<ForwardDecision>
  /** Dev-server tunnels per device at most (default MAX_FORWARDS_PER_DEVICE; tests shrink it). */
  maxForwards?: number
  /** Per-device limits for channels that cost money or quota (`MINDECK_RATE_LIMITS`; default DEFAULT_RATE_LIMITS). */
  rateLimits?: RateLimits
  /** How many events are kept per device for a reconnect (default REPLAY_LIMITS; tests shrink them). */
  replay?: ReplayLimits
  now?: () => number
}

/** A dev-server tunnel: where to connect (the names tried in order), or why not. */
export type ForwardDecision = { hosts: string[]; port: number } | { error: 'remote-terminal-disabled' | 'not-a-dev-server' | 'forbidden' }

/** `MINDECK_ALLOWED_HOSTS=mindeck.example.com,.ts.net` → the names, trimmed. */
export function allowedHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.MINDECK_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
}

/** A scope check slower than this (a hung network share it resolves) is given up: that event is dropped, the next ones go on. */
const SCOPE_TIMEOUT_MS = 2000
/** Events waiting for their check at most — beyond that new ones are dropped until the queue drains (a `system:tick` every 1.5 s piles up). */
const OUTBOX_MAX = 500

/** `work`, or a rejection once `ms` have passed without its answer. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)))
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/** Events meant for one device only (`device`): search results and inline edits are its own. */
const TARGETED: readonly IpcEvent[] = ['search:progress', 'ai:inlineDelta']
/** Snapshots the next one replaces (every 1.5 s): sent without a `seq`, never kept for a reconnect. */
const VOLATILE: readonly IpcEvent[] = ['system:tick']

/** `?stream=<id>&since=<seq>` of a reconnecting client: the last event it saw (no secret — never a token). */
function resumeOf(url: URL): { stream: string; since: number } | null {
  const stream = url.searchParams.get('stream')
  if (!stream) return null
  const since = Number(url.searchParams.get('since'))
  return { stream, since: Number.isSafeInteger(since) && since >= 0 ? since : -1 }
}

interface Client {
  ws: WebSocket
  deviceId: string
  alive: boolean
}

/** An open dev-server tunnel: its socket, whose it is, and whether it answered the last ping. */
interface Forward {
  ws: WebSocket
  tcp: Socket
  deviceId: string
  alive: boolean
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/** A URL part decoded — broken percent-encoding is the client's mistake (400), not the core's. */
function decoded(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    throw new HttpError(400, 'bad-url', 'The URL is not validly encoded')
  }
}

/** An unexpected failure: the details (paths, user names) go to the log, the client gets a reference to quote. */
function internal(err: unknown): HttpError {
  const ref = randomUUID().slice(0, 8)
  console.error(`[server] request failed (ref ${ref}):`, err)
  return new HttpError(500, 'error', `Something went wrong on the Mindeck core (ref ${ref})`)
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(json)
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7).trim()
  return undefined
}

/** A cookie's value from the request, or undefined. */
function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || undefined
  }
  return undefined
}

/**
 * A request from the core's own web UI (CSRF). Browsers say where a request
 * comes from in `Sec-Fetch-Site`, which no page can set: `same-origin` it
 * must be. Browsers without it (older Safari) send an `Origin`: it must name
 * the address asked — the Host (one of the core's own names, `hostAllowed`),
 * or behind a proxy on this computer the `X-Forwarded-Host` it passes on. A
 * page elsewhere, or a request that says neither, is not the web UI.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (site !== undefined) return site === 'same-origin'
  const origin = req.headers.origin
  if (origin === undefined) return false
  const asked = [req.headers.host, isLoopbackAddress(clientIp(req)) ? req.headers['x-forwarded-host'] : undefined]
  try {
    const host = new URL(origin).host.toLowerCase()
    return asked.some((h) => typeof h === 'string' && h.split(',')[0].trim().toLowerCase() === host)
  } catch {
    return false
  }
}

const isJson = (req: IncomingMessage) => /^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] ?? ''))

/**
 * The events socket's token: offered as a subprotocol (`mindeck.bearer.<token>`),
 * so it never lands in a URL (where proxy and access logs keep it). The old
 * `?token=` query is no longer read: the web UI and the app stopped using it.
 */
function socketToken(req: IncomingMessage): string | null {
  const offered = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((p) => p.trim())
    .find((p) => p.startsWith(TOKEN_PROTOCOL_PREFIX))
  return offered ? offered.slice(TOKEN_PROTOCOL_PREFIX.length) : null
}

/** The caller's address — a pipe through the relay has none (it is no TCP socket): `relay`, never loopback. */
function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? RELAY_ADDRESS
}

/** This computer itself (IPv4, IPv6 or IPv4-mapped loopback). */
export function isLoopbackAddress(ip: string): boolean {
  return /^(127\.|::ffff:127\.)/.test(ip) || ip === '::1'
}

/**
 * A proxy on this computer (nginx, Caddy, `kubectl port-forward` with a
 * sidecar …) passes requests on: they come from 127.0.0.1, but they are not
 * this computer's — never trusted like it (plain HTTP, one shared rate limit).
 */
function proxied(req: IncomingMessage): boolean {
  return ['x-forwarded-for', 'x-real-ip', 'forwarded'].some((h) => req.headers[h] !== undefined)
}

/** The rate-limit bucket of an address: IPv6 by its /64 (one LAN host may take as many addresses as it likes), IPv4 as it is. */
export function addressBucket(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return mapped[1]
  if (isIP(ip) !== 6) return ip
  const [head, tail] = ip.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`
}

/** Whose failed pairings a request counts as: its address — behind a proxy here, the one the proxy passes on. */
function rateKey(req: IncomingMessage): string {
  const ip = clientIp(req)
  if (!isLoopbackAddress(ip) || !proxied(req)) return addressBucket(ip)
  const hop = String(req.headers['x-forwarded-for'] ?? req.headers['x-real-ip'] ?? '')
    .split(',')
    .pop()!
    .trim()
  return `proxied:${addressBucket(hop)}`
}

/** The DNS names a certificate is for (`*.example.com` → `.example.com`). */
function certificateNames(cert: string): string[] {
  return (new X509Certificate(cert).subjectAltName ?? '')
    .split(/,\s*/)
    .filter((e) => e.startsWith('DNS:'))
    .map((e) => e.slice(4).toLowerCase().replace(/^\*\./, '.'))
}

const encrypted = (req: IncomingMessage) => (req.socket as TLSSocket).encrypted === true

async function readJson(req: IncomingMessage, limit = MAX_BODY): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'too-large', 'Request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'bad-json', 'Request body is not valid JSON')
  }
}

/**
 * The Mindeck core over the network — one server for the web UI and the mobile
 * app. Same contract as the desktop IPC, same Router (validation + access
 * rules), authenticated with per-device bearer tokens:
 *
 *   GET  /api/health           liveness (public; the version for paired devices)
 *   POST /api/pair             { code, name } → { token, device } (public, rate limited);
 *                              from the web UI with `cookie: true` → { device } + an HttpOnly cookie
 *   POST /api/session          Bearer token → the same token as the web UI's cookie (once, for tokens kept before)
 *   POST /api/logout           removes the calling device and deletes the cookie
 *   POST /api/rpc/<channel>    payload → IpcResult (Bearer token; calls that cost money or quota are rate limited per device)
 *   WS   /api/events           push events as { channel, payload, seq } (token as subprotocol;
 *                              ?stream=&since= replays what a reconnecting client missed)
 *   WS   /api/forward?port=    raw TCP to a dev server on this machine (`forward` decides which;
 *                              token as subprotocol) — how a phone's browser opens localhost:5173
 *   GET  /*                    the built web UI (single-page app)
 *
 * No CORS. Credentials are explicit headers (the app, the desktop) — or, for
 * the web UI the core serves itself, an HttpOnly `SameSite=Strict` cookie
 * on `/api` that scripts in the page never see. A cookie counts only for a
 * request the browser marks as the core's own page (`sameOrigin`) and, for
 * calls, a JSON POST: cross-site requests cannot ride on it. Only requests
 * for the core's own names are answered (`hostAllowed`): DNS rebinding gets
 * `403 host-not-allowed`.
 *
 * With TLS credentials, one port speaks both: HTTPS (and WSS) for everyone,
 * plain HTTP only for this computer itself (127.0.0.1 — the local web UI,
 * health checks). The network gets no answer in the clear: a page request is
 * sent to the HTTPS address, anything else (a token, a pairing code) is refused.
 *
 * Pipes from the Mindeck Cloud relay (`attachRelay`) speak the same HTTPS: the
 * phone's TLS ends here, with the certificate it pinned, so the cloud passes
 * bytes it cannot read. They go through the very same checks as any network
 * connection — they have no address and are never this computer.
 */
export class HttpServer {
  /** The listening socket; it hands each connection to `web` or `secure`. */
  private server?: NetServer
  private web?: Server
  private secure?: HttpsServer
  private tls?: TlsCredentials
  private readonly sockets = new Set<Duplex>()
  /** Pipes from the relay open now. */
  private relayPipes = 0
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    // Answer with Mindeck's own protocol — never echo the token one.
    handleProtocols: (offered) => (offered.has(EVENTS_PROTOCOL) ? EVENTS_PROTOCOL : false)
  })
  private readonly clients = new Set<Client>()
  /** Dev-server tunnels: raw bytes, so a larger message size than events. */
  private readonly forwardWss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
    handleProtocols: (offered) => (offered.has(FORWARD_PROTOCOL) ? FORWARD_PROTOCOL : false)
  })
  private readonly forwards = new Set<Forward>()
  /** Tunnels per device, open or being set up. */
  private readonly forwardSlots = new Map<string, number>()
  /** Counts up with every revocation (a device removed, remote shells off): a tunnel set up meanwhile is asked again. */
  private revocations = 0
  private readonly pairFailures = new Map<string, number[]>()
  /** The names in the certificate the server presents. */
  private certNames: string[] = []
  private heartbeat?: NodeJS.Timeout
  /** Scoped events leave in the order they came (a slow check never lets a later one overtake). */
  private outbox: Promise<void> = Promise.resolve()
  /** Events in the outbox now; while it is full, new ones are dropped (said once). */
  private queued = 0
  private dropping = false
  private unsubscribe?: () => void
  /** Calls that cost the user (AI, GitHub, Mindeck Cloud), counted per device. */
  private readonly limiter: DeviceRateLimiter
  /** Each device's numbered events, kept a while for its reconnect. */
  private readonly streams: EventStreams
  /** The outbox overflowed: events were dropped that devices should have had. */
  private lost = false
  private readonly now: () => number

  constructor(private readonly opts: HttpServerOptions) {
    this.now = opts.now ?? Date.now
    this.limiter = new DeviceRateLimiter(opts.rateLimits, this.now)
    this.streams = new EventStreams(opts.replay ?? REPLAY_LIMITS)
  }

  get clientCount(): number {
    return this.clients.size
  }

  /** Pipes from the relay open now. */
  get relayCount(): number {
    return this.relayPipes
  }

  /** Listen on `host:port` — with `tls`, HTTPS (and HTTP for this computer only). */
  async listen(host: string, port: number, tls?: TlsCredentials): Promise<void> {
    const serve = <T extends Server | HttpsServer>(server: T): T => {
      server.on('request', (req, res) => void this.handle(req, res))
      server.on('upgrade', (req, socket, head) => void this.upgrade(req, socket, head))
      return server
    }
    const web = serve(createServer())
    const secure = tls ? serve(createHttpsServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2', keepAliveTimeout: KEEP_ALIVE_MS })) : undefined
    const server = createNetServer((socket) => this.accept(socket, web, secure))
    server.maxConnections = MAX_CONNECTIONS
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolveListen()
      })
    })
    // They never listen themselves: this starts their request and header timeouts all the same.
    for (const s of [web, secure]) s?.emit('listening')
    Object.assign(this, { server, web, secure, tls, certNames: tls ? certificateNames(tls.cert) : [] })
    this.unsubscribe = this.opts.hub.subscribe((channel, payload) => this.push(channel, payload))
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS)
  }

  /** The bound port (useful with port 0 in tests). */
  get port(): number {
    const addr = this.server?.address()
    return addr && typeof addr === 'object' ? addr.port : 0
  }

  /** A renewed certificate: new connections get it, open ones keep theirs. */
  setTls(tls: TlsCredentials): void {
    if (!this.secure) return
    this.secure.setSecureContext({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' })
    this.tls = tls
    this.certNames = certificateNames(tls.cert)
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    for (const client of [...this.clients]) client.ws.terminate()
    this.clients.clear()
    this.closeForwards()
    this.opts.onClients?.(0)
    const server = this.server
    this.server = undefined
    if (!server) return
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    for (const s of [this.web, this.secure]) s?.close()
    this.web = this.secure = this.tls = undefined
    await new Promise<void>((r) => server.close(() => r()))
  }

  /** A new connection: HTTPS when it opens with a TLS handshake, else plain HTTP. */
  private accept(socket: Socket, web: Server, secure?: HttpsServer): void {
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    if (!secure) return void web.emit('connection', socket)
    socket.setTimeout(FIRST_BYTE_MS, () => socket.destroy())
    socket.once('data', (chunk: Buffer) => {
      socket.setTimeout(0)
      socket.pause()
      socket.unshift(chunk)
      ;(chunk[0] === TLS_HANDSHAKE ? secure : web).emit('connection', socket)
      process.nextTick(() => socket.resume())
    })
  }

  /**
   * A pipe from the Mindeck Cloud relay: the phone's TLS, end to end. It goes
   * straight to the HTTPS server — never the plain one — and has no address,
   * so nothing treats it as this computer. False when the server speaks no
   * HTTPS (the pipe is not taken: in the clear the cloud would read along) or
   * too many pipes are open.
   */
  attachRelay(pipe: Duplex): boolean {
    if (!this.server || !this.secure || this.relayPipes >= MAX_RELAY_PIPES) return false
    this.relayPipes += 1
    this.sockets.add(pipe)
    pipe.once('close', () => {
      this.relayPipes -= 1
      this.sockets.delete(pipe)
    })
    pipe.on('error', () => pipe.destroy())
    this.secure.emit('connection', pipe)
    return true
  }

  /** Plain HTTP while the server speaks HTTPS: only this computer may use it (not a proxy on it). */
  private refusesPlain(req: IncomingMessage): boolean {
    return !!this.secure && !encrypted(req) && (!isLoopbackAddress(clientIp(req)) || proxied(req))
  }

  /**
   * DNS rebinding: a web page that points its own name at this computer
   * still sends that name as Host. Answered are IP addresses, `localhost`,
   * the machine's name (and `<name>.local`), the certificate's names and
   * the allowed hosts — nothing else.
   */
  private hostAllowed(req: IncomingMessage): boolean {
    const m = HOST.exec(String(req.headers.host ?? ''))
    if (!m) return false
    const name = m[1].replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
    if (isIP(name) || name === 'localhost' || name.endsWith('.localhost')) return true
    // macOS names itself `Studio-Mac.local`, a router's DNS `studio-mac.fritz.box`: the bare name counts too.
    const machine = (this.opts.hostname ?? osHostname)().toLowerCase()
    const bare = machine.split('.')[0]
    const names = [machine, bare, `${bare}.local`, ...this.certNames, ...(this.opts.allowedHosts ?? []).map((h) => h.toLowerCase())]
    return names.some((h) => h === '*' || h === name || (h.startsWith('.') && name.endsWith(h)))
  }

  /**
   * What devices may see changed (shared folders, remote shells): events kept
   * from before are no longer replayed — a client that missed any resyncs.
   */
  resetReplay(): void {
    this.streams.clear()
  }

  /** Drop every live connection of a revoked device. */
  disconnectDevice(deviceId: string): void {
    this.limiter.forget(deviceId)
    this.streams.drop(deviceId)
    for (const client of [...this.clients]) {
      if (client.deviceId === deviceId) client.ws.close(4401, 'revoked')
    }
    this.closeForwards(deviceId)
  }

  /** Ends the dev-server tunnels (of one device, or all: remote shells were switched off). */
  closeForwards(deviceId?: string): void {
    this.revocations += 1
    for (const f of [...this.forwards]) {
      if (deviceId !== undefined && f.deviceId !== deviceId) continue
      this.forwards.delete(f)
      f.tcp.destroy()
      f.ws.terminate()
    }
  }

  // --- HTTP ---

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.hostAllowed(req)) {
      return send(res, 403, { ok: false, error: { code: 'host-not-allowed', message: 'This Mindeck core does not answer to that name — add it to MINDECK_ALLOWED_HOSTS' } })
    }
    if (this.refusesPlain(req)) return this.toHttps(req, res)
    // HSTS only for a certificate a browser trusts: with a self-signed one it would turn the
    // warning a person can click through (after comparing the fingerprint) into a dead end.
    if (encrypted(req) && this.tls && !this.tls.selfSigned) res.setHeader('Strict-Transport-Security', 'max-age=31536000')
    try {
      const url = new URL(req.url as string, 'http://local')
      const path = url.pathname
      if (path === '/api/health' && req.method === 'GET') {
        // The version only for paired devices: to anyone else it says which known bugs to try.
        const paired = !!(await this.opts.auth.verify(bearer(req)))
        return send(res, 200, { ok: true, name: 'Mindeck', mode: this.opts.mode, ...(paired ? { version: this.opts.version } : {}) })
      }
      if (path === '/api/pair' && req.method === 'POST') return await this.pair(req, res)
      if (path === '/api/session' && req.method === 'POST') return await this.session(req, res)
      if (path === '/api/logout' && req.method === 'POST') return await this.logout(req, res)
      if (path.startsWith('/api/rpc/') && req.method === 'POST') return await this.rpc(req, res, path.slice(9))
      if (path.startsWith('/api/')) throw new HttpError(404, 'not-found', 'No such endpoint')
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method', 'Method not allowed')
      return await this.serveStatic(path, res)
    } catch (err) {
      const e = err instanceof HttpError ? err : internal(err)
      if (res.headersSent) return void res.destroy()
      send(res, e.status, { ok: false, error: { code: e.code, message: e.message } })
    }
  }

  /** A page goes to its HTTPS address; a call (with a token or a code) is refused, never answered in the clear. */
  private toHttps(req: IncomingMessage, res: ServerResponse): void {
    // The Host is one of the core's own names here (hostAllowed): fit for a redirect.
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.writeHead(308, { ...SECURITY_HEADERS, Location: `https://${req.headers.host}${req.url}`, 'Cache-Control': 'no-store' })
      return void res.end()
    }
    send(res, 403, { ok: false, error: { code: 'https-required', message: 'This Mindeck core accepts the network over HTTPS only — use https://' } })
  }

  private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = rateKey(req)
    const now = Date.now()
    const recent = (this.pairFailures.get(key) ?? []).filter((t) => now - t < PAIR_WINDOW_MS)
    if (recent.length >= PAIR_MAX_FAILURES) {
      throw new HttpError(429, 'rate-limited', 'Too many failed pairing attempts — try again later')
    }
    // Counted up front: concurrent attempts must not all pass the check above
    // before the first failure is recorded. A successful pairing clears it.
    // Kept in order of the last attempt; past the limit the oldest address is forgotten.
    this.pairFailures.delete(key)
    this.pairFailures.set(key, [...recent, now])
    if (this.pairFailures.size > PAIR_MAX_TRACKED) this.pairFailures.delete(this.pairFailures.keys().next().value!)
    const body = (await readJson(req, MAX_PAIR_BODY)) as { code?: unknown; name?: unknown; cookie?: unknown; remember?: unknown } | undefined
    // The web UI keeps its token in a cookie: only its own page may ask for one (before the code is spent).
    const asCookie = body?.cookie === true
    if (asCookie) this.requireWebUi(req)
    try {
      const result = await this.opts.auth.pair(String(body?.code ?? ''), String(body?.name ?? ''))
      this.pairFailures.delete(key)
      // Over HTTPS the device learns the certificate (and its key, which outlives a renewal) to pin from here on.
      const tls = encrypted(req) ? this.tls : undefined
      const pins = tls ? { fingerprint: tls.fingerprint, spkiFingerprint: tls.spkiFingerprint } : {}
      if (!asCookie) return send(res, 200, { ok: true, data: { ...result, ...pins } })
      // The token goes into the cookie only — the page's scripts never see it.
      this.setCookie(req, res, result.token, body?.remember !== false)
      send(res, 200, { ok: true, data: { device: result.device, ...pins } })
    } catch (err) {
      // Only a wrong code is the caller's: anything else (a full disk, a store it can't read) goes to the log, like every failure.
      if ((err as { code?: string }).code !== 'bad-code') throw err
      throw new HttpError(401, 'bad-code', (err as Error).message)
    }
  }

  /** The core's own web UI (same origin, JSON) — refused otherwise: a cookie must not be set or used from elsewhere. */
  private requireWebUi(req: IncomingMessage): void {
    if (!sameOrigin(req)) throw new HttpError(403, 'cross-origin', 'Only the web UI on this Mindeck core’s own address can use a browser session')
    if (!isJson(req)) throw new HttpError(415, 'bad-content-type', 'A browser session sends application/json')
  }

  /** The web UI's cookie: one per core (cores on one computer differ in their port, a browser shares cookies across ports). */
  private cookieName(): string {
    return `mindeck_${this.port}`
  }

  /** `remember`: a persistent cookie ("stay paired in this browser"); else it ends with the browser session. */
  private setCookie(req: IncomingMessage, res: ServerResponse, token: string, remember: boolean): void {
    const secure = encrypted(req) ? '; Secure' : ''
    res.setHeader('Set-Cookie', `${this.cookieName()}=${token}; Path=/api; HttpOnly; SameSite=Strict${secure}${remember ? `; Max-Age=${COOKIE_MAX_AGE_S}` : ''}`)
  }

  /** The Set-Cookie that deletes the web UI's cookie. */
  private expiredCookie(req: IncomingMessage): string {
    return `${this.cookieName()}=; Path=/api; HttpOnly; SameSite=Strict${encrypted(req) ? '; Secure' : ''}; Max-Age=0`
  }

  private clearCookie(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Set-Cookie', this.expiredCookie(req))
  }

  /**
   * Who calls: the device of the Bearer token — or, without one, of the web
   * UI's cookie, which counts only from the web UI itself (CSRF). A cookie
   * whose token the core no longer knows (revoked, expired) is deleted.
   */
  private async caller(req: IncomingMessage, res: ServerResponse, call: boolean): Promise<Device> {
    const header = bearer(req)
    const token = header ?? cookie(req, this.cookieName())
    if (header === undefined && token !== undefined) {
      if (!sameOrigin(req)) throw new HttpError(403, 'cross-origin', 'The browser session is used from the web UI on this Mindeck core’s own address only')
      if (call && !isJson(req)) throw new HttpError(415, 'bad-content-type', 'Calls with the browser session send application/json')
    }
    const device = await this.opts.auth.verify(token)
    if (device) return device
    if (header === undefined && token !== undefined) this.clearCookie(req, res)
    throw new HttpError(401, 'unauthorized', 'Missing or invalid device token')
  }

  /**
   * The web UI from before the cookie kept its token in web storage: it hands
   * it over once (Bearer) and drops it — from then on the cookie carries it.
   */
  private async session(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (bearer(req) === undefined) throw new HttpError(401, 'unauthorized', 'Missing or invalid device token')
    this.requireWebUi(req)
    const device = await this.caller(req, res, true)
    const body = (await readJson(req, MAX_PAIR_BODY)) as { remember?: unknown } | undefined
    this.setCookie(req, res, bearer(req)!, body?.remember !== false)
    send(res, 200, { ok: true, data: { device } })
  }

  /** Signing out of the web UI: this device is removed on the core and the cookie deleted. */
  private async logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const device = await this.caller(req, res, true).catch((err: HttpError) => {
      if (err.status !== 401) throw err
      return null
    })
    if (device) {
      await this.opts.auth.revoke(device.id)
      this.disconnectDevice(device.id)
    }
    this.clearCookie(req, res)
    send(res, 200, { ok: true })
  }

  private async rpc(req: IncomingMessage, res: ServerResponse, channel: string): Promise<void> {
    const device = await this.caller(req, res, true)
    const payload = await readJson(req)
    if (REMOTE_NOOP.has(channel)) return send(res, 200, { ok: true })
    const limited = this.limiter.take(device.id, decoded(channel))
    if (limited) {
      const seconds = Math.ceil(limited.waitMs / 1000)
      res.setHeader('Retry-After', String(seconds))
      throw new HttpError(429, 'rate-limited', `Too many ${limited.group} calls from this device — try again in ${seconds} s`)
    }
    const result = await this.opts.router.dispatch(decoded(channel), payload, {
      transport: 'remote',
      deviceId: device.id,
      role: device.role
    })
    send(res, 200, result)
  }

  private async serveStatic(path: string, res: ServerResponse): Promise<void> {
    const root = this.opts.webRoot
    if (!root) throw new HttpError(404, 'not-found', 'This Mindeck core serves no web UI')
    const rootReal = await realpath(root).catch(() => {
      throw new HttpError(404, 'not-found', 'Web UI not built')
    })
    let file = resolve(rootReal, '.' + decoded(path))
    const inside = file === rootReal || file.startsWith(rootReal + sep)
    const info = inside ? await stat(file).catch(() => null) : null
    if (!info?.isFile()) file = join(rootReal, 'index.html') // SPA fallback
    const body = await readFile(file).catch(() => {
      throw new HttpError(404, 'not-found', 'Web UI not built')
    })
    const isAsset = /[\\/]assets[\\/]/.test(file)
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Content-Security-Policy': CSP
    })
    res.end(body)
  }

  // --- WebSocket ---

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => socket.destroy())
    if (!this.hostAllowed(req) || this.refusesPlain(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    // The app offers its token as a subprotocol; the web UI's browser sends its cookie — from the web UI only.
    const offered = socketToken(req)
    const fromCookie = offered === null ? cookie(req, this.cookieName()) : undefined
    if (fromCookie !== undefined && !sameOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    // Nothing here may reject unhandled. A malformed URL is simply not authenticated.
    const url = URL.canParse(req.url as string, 'http://local') ? new URL(req.url as string, 'http://local') : null
    if (url?.pathname === '/api/forward') return this.forward(req, socket, head, url, offered)
    const device = url?.pathname === '/api/events' ? await this.opts.auth.verify(offered ?? fromCookie).catch(() => undefined) : null
    // The device store failed: nothing is known about the token, so the cookie stays for the next attempt.
    if (device === undefined) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (!url || !device) {
      const clear = fromCookie !== undefined ? `Set-Cookie: ${this.expiredCookie(req)}\r\n` : ''
      socket.write(`HTTP/1.1 401 Unauthorized\r\n${clear}Connection: close\r\n\r\n`)
      socket.destroy()
      return
    }
    const resume = resumeOf(url)
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const stream = this.streams.open(device.id, this.now())
      const client: Client = { ws, deviceId: device.id, alive: true }
      this.clients.add(client)
      this.opts.onClients?.(this.clients.size)
      ws.on('pong', () => (client.alive = true))
      ws.on('close', () => {
        stream.seen = this.now()
        if (this.clients.delete(client)) this.opts.onClients?.(this.clients.size)
      })
      ws.on('error', () => ws.terminate())
      // `stream` + `seq`: where this device's numbered events stand — a client that reconnects names them.
      ws.send(JSON.stringify({ channel: 'hello', payload: { deviceId: device.id, role: device.role, stream: stream.id, seq: stream.seq } }))
      if (!resume) return
      // A reconnect: what it missed, in order — or, when that is no longer known, a resync.
      const missed = stream.after(resume.stream, resume.since, this.now())
      if (!missed) return ws.send(this.resyncMessage(stream))
      for (const message of missed) ws.send(message)
    })
  }

  /**
   * A tunnel to a dev server on this machine: the device's token (a subprotocol — no cookie: the
   * web UI has no use for it), then `forward` decides, then the dev server must take the connection
   * — only then the upgrade is answered, so a phone sees a refusal as one (403/404/502).
   */
  private async forward(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL, token: string | null): Promise<void> {
    const refuse = (status: number, text: string, code: string) => {
      const body = JSON.stringify({ ok: false, error: { code, message: text } })
      socket.write(`HTTP/1.1 ${status} ${text}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
      socket.destroy()
    }
    // A device removed, or remote shells switched off, while this tunnel is set up: asked again before it opens.
    const revocations = this.revocations
    const device = token ? await this.opts.auth.verify(token).catch(() => undefined) : null
    if (device === undefined) return refuse(503, 'Service Unavailable', 'unavailable')
    if (!device) return refuse(401, 'Unauthorized', 'unauthorized')
    const port = Number(url.searchParams.get('port'))
    if (!Number.isInteger(port) || port < 1 || port > 65535) return refuse(400, 'Bad Request', 'bad-request')
    // Counted from here, open or on its way: requests at once cannot pass the limit together.
    const held = this.forwardSlots.get(device.id) ?? 0
    if (held >= (this.opts.maxForwards ?? MAX_FORWARDS_PER_DEVICE)) return refuse(429, 'Too Many Requests', 'rate-limited')
    this.forwardSlots.set(device.id, held + 1)
    // Exactly once: when it opens, at its end; else when setting it up stops.
    const free = () => {
      const left = this.forwardSlots.get(device.id)! - 1
      if (left > 0) this.forwardSlots.set(device.id, left)
      else this.forwardSlots.delete(device.id)
    }
    let opened = false
    try {
      const decision = (await this.opts.forward?.(device, port)) ?? { error: 'forbidden' as const }
      if ('error' in decision) return refuse(decision.error === 'not-a-dev-server' ? 404 : 403, decision.error === 'not-a-dev-server' ? 'Not Found' : 'Forbidden', decision.error)
      const tcp = await this.dial(decision.hosts, decision.port)
      if (!tcp) return refuse(502, 'Bad Gateway', 'not-listening')
      if (this.revocations !== revocations && !(await this.stillAllowed(token!, device.id, port))) {
        tcp.destroy()
        return refuse(403, 'Forbidden', 'revoked')
      }
      // The phone gave up meanwhile — or the handshake is one ws refuses (400) without calling back.
      if (socket.destroyed) return void tcp.destroy()
      socket.once('close', () => {
        if (!opened) tcp.destroy()
      })
      this.forwardWss.handleUpgrade(req, socket, head, (ws) => {
        opened = true
        const forward: Forward = { ws, tcp, deviceId: device.id, alive: true }
        this.forwards.add(forward)
        const pipe = createWebSocketStream(ws)
        const end = () => {
          if (!this.forwards.delete(forward)) return
          free()
          tcp.destroy()
          pipe.destroy()
        }
        ws.on('pong', () => (forward.alive = true))
        pipe.on('error', end)
        pipe.on('close', end)
        tcp.on('close', end)
        tcp.pipe(pipe).pipe(tcp)
      })
    } finally {
      if (!opened) free()
    }
  }

  /** The token still names that device, and the policy still lets it through (asked after a revocation during setup). */
  private async stillAllowed(token: string, deviceId: string, port: number): Promise<boolean> {
    const device = await this.opts.auth.verify(token).catch(() => null)
    if (device?.id !== deviceId) return false
    const decision = await this.opts.forward?.(device, port)
    return !!decision && !('error' in decision)
  }

  /** A TCP connection to the first of `hosts` that takes it (Vite on macOS listens on ::1 only, others on 127.0.0.1). */
  private async dial(hosts: string[], port: number): Promise<Socket | null> {
    for (const host of hosts) {
      const tcp = await new Promise<Socket | null>((resolveDial) => {
        const s = connectTcp({ host, port, timeout: FORWARD_CONNECT_MS })
        const fail = () => {
          s.destroy()
          resolveDial(null)
        }
        s.once('connect', () => {
          s.setTimeout(0)
          s.off('timeout', fail)
          resolveDial(s)
        })
        // Stays: an error later (the dev server resets the connection) destroys the socket, nothing escapes.
        s.on('error', fail)
        s.once('timeout', fail)
      })
      if (tcp) return tcp
    }
    return null
  }

  private push(channel: IpcEvent, payload: unknown): void {
    // Devices connected now or a moment ago (their events wait for their reconnect).
    if (!this.streams.size || DESKTOP_EVENTS.includes(channel)) return
    if (TERMINAL_EVENTS.includes(channel) && !this.opts.remoteTerminal()) return
    const scope = this.opts.scope
    if (!scope) return this.deliver(channel, payload)
    this.enqueue(channel, async () => {
      const shown = await withTimeout(scope(channel, payload), this.opts.outbox?.timeoutMs ?? SCOPE_TIMEOUT_MS)
      if (shown !== null) this.deliver(channel, shown)
    })
  }

  /** An event's check, in order behind the others; while the outbox is full, new ones are dropped (and devices resync later). */
  private enqueue(channel: IpcEvent, check: () => Promise<void>): void {
    const max = this.opts.outbox?.max ?? OUTBOX_MAX
    if (this.queued >= max) {
      if (!this.dropping) console.warn(`[server] ${max} events wait for their check — dropping new ones until those are through`)
      this.dropping = true
      this.lost = true
      return
    }
    this.queued += 1
    this.outbox = this.outbox.then(async () => {
      try {
        await check()
      } catch (err) {
        // What can't be checked (in time) is not sent.
        console.error(`[server] not sending ${channel}:`, err)
      } finally {
        this.queued -= 1
        if (!this.queued) this.drained()
      }
    })
  }

  /** The outbox is empty again. Dropped events leave gaps no `seq` shows: every device resyncs. */
  private drained(): void {
    this.dropping = false
    if (!this.lost) return
    this.lost = false
    this.streams.clear()
    for (const client of this.clients) {
      const stream = this.streams.get(client.deviceId)
      if (stream && client.ws.readyState === client.ws.OPEN) client.ws.send(this.resyncMessage(stream))
    }
  }

  /** "Reload what you mirror": the stream and seq to go on from. */
  private resyncMessage(stream: { id: string; seq: number }): string {
    return JSON.stringify({ channel: 'resync-required', payload: { stream: stream.id, seq: stream.seq } })
  }

  private deliver(channel: IpcEvent, payload: unknown): void {
    // "Always allow" is only ever given at the desktop: devices are not offered it.
    const shown = channel === 'permission:request' ? { ...(payload as PermissionRequest), allowAlways: false } : payload
    // Search results (file contents) and inline edits go only to the device that asked (the desktop's to none).
    const only = TARGETED.includes(channel) ? ((payload as { device?: string }).device ?? null) : undefined
    const body = JSON.stringify({ channel, payload: shown })
    const now = this.now()
    // Each device numbers (and keeps) its own events — also while it is away, for its reconnect.
    for (const [deviceId, stream] of this.streams.entries()) {
      if (only !== undefined && deviceId !== only) continue
      const message = VOLATILE.includes(channel) ? body : stream.record(body, now)
      for (const client of this.clients) {
        if (client.deviceId !== deviceId || client.ws.readyState !== client.ws.OPEN) continue
        // A client that stopped reading (stalled network, suspended phone) would otherwise
        // buffer every event in memory: drop it, it reconnects and catches up.
        if (client.ws.bufferedAmount > MAX_BUFFERED) client.ws.terminate()
        else client.ws.send(message)
      }
    }
  }

  private sweep(): void {
    // Forget failed pairing attempts that left the rate-limit window.
    const now = this.now()
    for (const [ip, times] of this.pairFailures) {
      if (times.every((t) => now - t >= PAIR_WINDOW_MS)) this.pairFailures.delete(ip)
    }
    this.limiter.sweep()
    this.streams.prune(now, new Set([...this.clients].map((c) => c.deviceId)))
    for (const client of [...this.clients]) {
      if (!client.alive) {
        client.ws.terminate()
        continue
      }
      client.alive = false
      client.ws.ping()
    }
    // A phone that left the Wi-Fi leaves its tunnels half open: they go like a dead events socket.
    for (const forward of [...this.forwards]) {
      if (!forward.alive) {
        forward.ws.terminate()
        continue
      }
      forward.alive = false
      forward.ws.ping()
    }
  }
}
