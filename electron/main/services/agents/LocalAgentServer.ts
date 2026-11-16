import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

const MAX_BODY = 16 * 1024 * 1024
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

export interface LocalHandlers {
  /** A Claude Code hook event. Resolves to the hook's JSON answer, or undefined for "no decision". */
  hook(sessionId: string, body: unknown, signal: AbortSignal): Promise<unknown>
  /** One MCP JSON-RPC message. Resolves to the response, or undefined for notifications. */
  mcp(sessionId: string, body: unknown): Promise<unknown>
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end()
    return
  }
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }))
      }
    })
  })
}

/**
 * The always-on, this-computer-only endpoint agent processes talk back to:
 * Claude Code's HTTP hooks (`/hooks/<session>`) and Mindeck's MCP memory server
 * (`/mcp/<session>`). Separate from the opt-in network API on purpose — it
 * binds 127.0.0.1 on a random port, rejects foreign Host/Origin headers (DNS
 * rebinding) and accepts only the random token issued to each session.
 */
export class LocalAgentServer {
  private server?: Server
  private readonly tokens = new Map<string, Buffer>()

  constructor(private readonly handlers: LocalHandlers) {}

  get port(): number {
    const address = this.server?.address()
    return typeof address === 'object' && address ? address.port : 0
  }

  /** Base URL for a session's routes, e.g. `http://127.0.0.1:51234/hooks/<id>`. */
  url(route: 'hooks' | 'mcp', sessionId: string): string {
    return `http://127.0.0.1:${this.port}/${route}/${sessionId}`
  }

  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    this.server = server
  }

  /** Issue (or re-issue) a session's token. */
  register(sessionId: string): string {
    const token = randomBytes(24).toString('base64url')
    this.tokens.set(sessionId, Buffer.from(token))
    return token
  }

  unregister(sessionId: string): void {
    this.tokens.delete(sessionId)
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private authorized(req: IncomingMessage, sessionId: string): boolean {
    const expected = this.tokens.get(sessionId)
    const given = Buffer.from(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '')
    return !!expected && given.length === expected.length && timingSafeEqual(given, expected)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin
    if (!LOOPBACK.test(String(req.headers.host)) || (origin && !LOOPBACK.test(origin.replace(/^https?:\/\//, '')))) {
      return send(res, 403, { error: 'Local agents only' })
    }
    // Server-side requests always carry a URL.
    const m = /^\/(hooks|mcp)\/([\w-]{1,64})$/.exec(req.url!.split('?')[0])
    if (!m) return send(res, 404, { error: 'Not found' })
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
    const [, route, sessionId] = m
    if (!this.authorized(req, sessionId)) return send(res, 401, { error: 'Unknown session or token' })

    let body: unknown
    try {
      body = await readJson(req)
    } catch (err) {
      return send(res, (err as { status: number }).status, { error: (err as Error).message })
    }

    // A hook waiting for the user (approvals) is abandoned when Claude Code gives up.
    const aborted = new AbortController()
    res.on('close', () => aborted.abort())
    try {
      const answer = route === 'hooks' ? await this.handlers.hook(sessionId, body, aborted.signal) : await this.handlers.mcp(sessionId, body)
      send(res, answer === undefined ? (route === 'mcp' ? 202 : 204) : 200, answer)
    } catch (err) {
      send(res, 500, { error: (err as Error).message })
    }
  }
}
