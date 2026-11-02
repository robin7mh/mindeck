import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { TERMINAL_EVENTS, type IpcEvent } from '@shared/ipc/contract'
import type { CoreMode } from '@shared/types/server'
import type { Router } from '../../ipc/router'
import type { EventHub } from '../core/EventHub'
import type { AuthService } from '../services/auth/AuthService'

const MAX_BODY = 8 * 1024 * 1024
const PAIR_WINDOW_MS = 10 * 60_000
const PAIR_MAX_FAILURES = 10
const HEARTBEAT_MS = 30_000
/** Unsent bytes a WebSocket client may fall behind before it is dropped. */
const MAX_BUFFERED = 16 * 1024 * 1024

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
}

interface Client {
  ws: WebSocket
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

function clientIp(req: IncomingMessage): string {
  return String(req.socket.remoteAddress)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, 'too-large', 'Request body too large')
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
 *   GET  /api/health           liveness + version (public)
 *   POST /api/pair             { code, name } → { token, device } (public, rate limited)
 *   POST /api/rpc/<channel>    payload → IpcResult (Bearer token)
 *   WS   /api/events?token=…   push events as { channel, payload }
 *   GET  /*                    the built web UI (single-page app)
 *
 * No cookies and no CORS: credentials are explicit headers, so cross-site
 * requests cannot ride on a session.
 */
export class HttpServer {
  private server?: Server
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  private readonly clients = new Set<Client>()
  private readonly pairFailures = new Map<string, number[]>()
  private heartbeat?: NodeJS.Timeout
  private unsubscribe?: () => void

  constructor(private readonly opts: HttpServerOptions) {}

  get clientCount(): number {
    return this.clients.size
  }

  async listen(host: string, port: number): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res))
    server.on('upgrade', (req, socket, head) => void this.upgrade(req, socket, head))
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolveListen()
      })
    })
    this.server = server
    this.unsubscribe = this.opts.hub.subscribe((channel, payload) => this.push(channel, payload))
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS)
  }

  /** The bound port (useful with port 0 in tests). */
  get port(): number {
    const addr = this.server?.address()
    return addr && typeof addr === 'object' ? addr.port : 0
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    for (const client of [...this.clients]) client.ws.terminate()
    this.clients.clear()
    this.opts.onClients?.(0)
    const server = this.server
    this.server = undefined
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }

  /** Drop every live connection of a revoked device. */
  disconnectDevice(deviceId: string): void {
    for (const client of [...this.clients]) {
      if (client.deviceId === deviceId) client.ws.close(4401, 'revoked')
    }
  }

  // --- HTTP ---

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url as string, 'http://local')
      const path = url.pathname
      if (path === '/api/health' && req.method === 'GET') {
        return send(res, 200, { ok: true, name: 'Mindeck', version: this.opts.version, mode: this.opts.mode })
      }
      if (path === '/api/pair' && req.method === 'POST') return await this.pair(req, res)
      if (path.startsWith('/api/rpc/') && req.method === 'POST') return await this.rpc(req, res, path.slice(9))
      if (path.startsWith('/api/')) throw new HttpError(404, 'not-found', 'No such endpoint')
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method', 'Method not allowed')
      return await this.serveStatic(path, res)
    } catch (err) {
      const e = err instanceof HttpError ? err : new HttpError(500, 'error', String((err as Error).message))
      if (res.headersSent) return void res.destroy()
      send(res, e.status, { ok: false, error: { code: e.code, message: e.message } })
    }
  }

  private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = clientIp(req)
    const now = Date.now()
    const recent = (this.pairFailures.get(ip) ?? []).filter((t) => now - t < PAIR_WINDOW_MS)
    if (recent.length >= PAIR_MAX_FAILURES) {
      throw new HttpError(429, 'rate-limited', 'Too many failed pairing attempts — try again later')
    }
    // Counted up front: concurrent attempts must not all pass the check above
    // before the first failure is recorded. A successful pairing clears it.
    this.pairFailures.set(ip, [...recent, now])
    const body = (await readJson(req)) as { code?: unknown; name?: unknown } | undefined
    let result: Awaited<ReturnType<AuthService['pair']>>
    try {
      result = await this.opts.auth.pair(String(body?.code ?? ''), String(body?.name ?? ''))
    } catch (err) {
      throw new HttpError(401, 'bad-code', (err as Error).message)
    }
    this.pairFailures.delete(ip)
    send(res, 200, { ok: true, data: result })
  }

  private async rpc(req: IncomingMessage, res: ServerResponse, channel: string): Promise<void> {
    const device = await this.opts.auth.verify(bearer(req))
    if (!device) throw new HttpError(401, 'unauthorized', 'Missing or invalid device token')
    const payload = await readJson(req)
    if (REMOTE_NOOP.has(channel)) return send(res, 200, { ok: true })
    const result = await this.opts.router.dispatch(decodeURIComponent(channel), payload, {
      transport: 'remote',
      deviceId: device.id
    })
    send(res, 200, result)
  }

  private async serveStatic(path: string, res: ServerResponse): Promise<void> {
    const root = this.opts.webRoot
    if (!root) throw new HttpError(404, 'not-found', 'This Mindeck core serves no web UI')
    const rootReal = await realpath(root).catch(() => {
      throw new HttpError(404, 'not-found', 'Web UI not built')
    })
    let file = resolve(rootReal, '.' + decodeURIComponent(path))
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
    let device: Awaited<ReturnType<AuthService['verify']>> = null
    try {
      const url = new URL(req.url as string, 'http://local')
      device = url.pathname === '/api/events' ? await this.opts.auth.verify(url.searchParams.get('token')) : null
    } catch {
      /* malformed URL or the device store failed: not authenticated */
    }
    if (!device) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const deviceId = device.id
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { ws, deviceId, alive: true }
      this.clients.add(client)
      this.opts.onClients?.(this.clients.size)
      ws.on('pong', () => (client.alive = true))
      ws.on('close', () => {
        if (this.clients.delete(client)) this.opts.onClients?.(this.clients.size)
      })
      ws.on('error', () => ws.terminate())
      ws.send(JSON.stringify({ channel: 'hello', payload: { deviceId } }))
    })
  }

  private push(channel: IpcEvent, payload: unknown): void {
    if (!this.clients.size) return
    if (TERMINAL_EVENTS.includes(channel) && !this.opts.remoteTerminal()) return
    const message = JSON.stringify({ channel, payload })
    for (const client of [...this.clients]) {
      if (client.ws.readyState !== client.ws.OPEN) continue
      // A client that stopped reading (stalled network, suspended phone) would
      // otherwise buffer every event in memory: drop it, it reconnects and re-attaches.
      if (client.ws.bufferedAmount > MAX_BUFFERED) {
        client.ws.terminate()
        continue
      }
      client.ws.send(message)
    }
  }

  private sweep(): void {
    // Forget failed pairing attempts that left the rate-limit window.
    const now = Date.now()
    for (const [ip, times] of this.pairFailures) {
      if (times.every((t) => now - t >= PAIR_WINDOW_MS)) this.pairFailures.delete(ip)
    }
    for (const client of [...this.clients]) {
      if (!client.alive) {
        client.ws.terminate()
        continue
      }
      client.alive = false
      client.ws.ping()
    }
  }
}
