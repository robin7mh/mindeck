import type { Duplex } from 'node:stream'
import { WebSocket, createWebSocketStream } from 'ws'
import type { RelayStatus } from '@shared/types/server'

/** A pipe id as the cloud names it. Anything else is not dialled. */
const PIPE_ID = /^[0-9a-f]{32}$/
/** Control messages are a line of JSON; a bigger one is no control message. */
const MAX_CONTROL_MESSAGE = 4096
/** Pipe messages: TLS records, batched by the phone up to 64 KiB. */
const MAX_PIPE_MESSAGE = 1024 * 1024
/** Pipes dialled or open at once at most: a cloud that floods `open` must not use up the core's sockets. */
export const MAX_PIPES = 128
/**
 * What the core sends into a pipe goes in pieces of this size at most: TLS hands a big answer (a
 * file, a diff) down in one buffer of megabytes, and the cloud takes messages up to 256 KiB.
 */
export const PIPE_CHUNK = 64 * 1024

/** A pipe as a stream for the HTTPS server — what it writes leaves in pieces of PIPE_CHUNK at most, in order. */
export function pipeStream(ws: WebSocket): Duplex {
  const stream = createWebSocketStream(ws)
  const write = stream._write.bind(stream)
  stream._write = (chunk: Buffer, encoding: BufferEncoding, callback: (err?: Error | null) => void) => {
    let offset = 0
    const next = (err?: Error | null) => {
      if (err || offset >= chunk.length) return callback(err)
      const piece = chunk.subarray(offset, offset + PIPE_CHUNK)
      offset += piece.length
      write(piece, encoding, next)
    }
    next()
  }
  return stream
}
/** The cloud pings every 25 s: silent this long, the connection is dead (a sleeping NAT, a lost Wi-Fi). */
const SILENCE_MS = 70_000
/** Refused (the session is gone, the account cannot hold a core): asked again this much later, or at once when the account changes. */
const REFUSED_RETRY_MS = 5 * 60_000

/** Why the cloud refused the control connection: its status, and its error code when it gave one. */
function refusal(status: number, body: string): string {
  let code: unknown
  try {
    code = (JSON.parse(body) as { error?: { code?: unknown } }).error?.code
  } catch {
    code = undefined
  }
  if (status === 401) return 'session-invalid'
  if (code === 'license_required') return 'license-required'
  if (status === 403) return 'core-only'
  return `http-${status}`
}

/** Socket errors end in a close, which is where they are handled. */
const ignore = () => {}
const noToken = () => null

export interface RelayLinkOptions {
  /** Mindeck Cloud's base URL (`https://api.mindeck.de`). */
  cloudUrl: () => string
  /** The core's session at Mindeck Cloud; null while signed out. */
  token: () => Promise<string | null>
  /** Hands an accepted pipe to the HTTPS server; false: it was not taken (and is closed). */
  attach: (pipe: Duplex) => boolean
  /** The link's state changed (connecting, online, refused …). */
  onStatus?: (status: RelayStatus) => void
  /** Injected for tests. */
  WebSocket?: typeof WebSocket
  now?: () => number
  minDelayMs?: number
  maxDelayMs?: number
  silenceMs?: number
}

/**
 * The core's way in from anywhere: a connection **out** to the Mindeck Cloud
 * relay (no open port, nothing to set up on the router). The cloud says when
 * a phone wants in (`open`), the core dials that pipe back (`accept`) and
 * hands it to its own HTTPS server — the phone's TLS ends there, with the
 * certificate it pinned at pairing, so the cloud passes bytes it cannot read.
 * Everything after that is the core's usual way: token, router, rights.
 *
 *   core → cloud   WS /v1/relay/core           Bearer: the core's session
 *   cloud → core   {"t":"ready"} {"t":"open","pipe":"<32 hex>"}
 *   core → cloud   {"t":"sleep"} {"t":"awake"}
 *   core → cloud   WS /v1/relay/accept?pipe=   one per pipe, the bytes as they are
 */
export class RelayLink {
  private ws?: WebSocket
  private retry?: NodeJS.Timeout
  private silence?: NodeJS.Timeout
  private delay: number
  private running = false
  private current: RelayStatus = { state: 'off' }
  /** The token the control connection was opened with. */
  private token: string | null = null
  /** Each connect counts up: a late answer of an older attempt changes nothing. */
  private attempt = 0
  private readonly pipes = new Set<WebSocket>()
  private readonly WS: typeof WebSocket
  private readonly now: () => number
  private readonly minDelay: number
  private readonly maxDelay: number

  constructor(private readonly opts: RelayLinkOptions) {
    this.WS = opts.WebSocket ?? WebSocket
    this.now = opts.now ?? Date.now
    this.minDelay = opts.minDelayMs ?? 1000
    this.maxDelay = opts.maxDelayMs ?? 60_000
    this.delay = this.minDelay
  }

  status(): RelayStatus {
    return { ...this.current, ...(this.current.state === 'online' ? { pipes: this.pipes.size } : {}) }
  }

  get active(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.delay = this.minDelay
    void this.connect()
  }

  /** Off: the control connection and every pipe end. */
  stop(): void {
    this.running = false
    this.attempt += 1
    this.clearTimers()
    this.drop()
    for (const pipe of [...this.pipes]) pipe.terminate()
    this.pipes.clear()
    this.token = null
    this.set({ state: 'off' })
  }

  /** The Mac is about to sleep: the cloud tells phones so ("Mac sleeps since 23:14") instead of "offline". */
  sleep(): void {
    this.sendControl({ t: 'sleep' })
  }

  /** Awake again: the old connection is most likely dead — a fresh one right away. */
  wake(): void {
    if (!this.running) return
    this.delay = this.minDelay
    this.reconnect()
  }

  /** The account may have changed (signed in, out, another session): a new connection when the token did. */
  refresh(): void {
    if (!this.running) return
    void this.opts
      .token()
      .catch(noToken)
      .then((token) => {
        if (!this.running || token === this.token) return
        this.delay = this.minDelay
        // Another account, or none: what phones opened on the old session ends with it.
        for (const pipe of [...this.pipes]) pipe.terminate()
        this.reconnect()
      })
  }

  private reconnect(): void {
    this.clearTimers()
    this.drop()
    void this.connect()
  }

  private async connect(): Promise<void> {
    const attempt = ++this.attempt
    clearTimeout(this.retry)
    const token = await this.opts.token().catch(noToken)
    if (attempt !== this.attempt || !this.running) return
    this.token = token
    // Signed out: nothing to do until the account is back (`refresh`).
    if (!token) return this.set({ state: 'unavailable', reason: 'signed-out' })
    this.set({ state: 'connecting' })
    const ws = new this.WS(`${this.base()}/v1/relay/core`, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 15_000,
      maxPayload: MAX_CONTROL_MESSAGE,
      perMessageDeflate: false
    })
    this.ws = ws
    let refused: string | undefined
    ws.on('unexpected-response', (_req, res) => {
      // The cloud says why in its body (`{"error":{"code":"license_required"}}`): read a little of it, then hang up.
      const status = res.statusCode!
      let body = ''
      const done = () => {
        refused = refusal(status, body)
        ws.terminate()
      }
      res.setEncoding('utf8')
      res.on('data', (part: string) => (body = (body + part).slice(0, 4096)))
      res.once('end', done)
      res.once('error', done)
    })
    ws.on('open', () => {
      this.delay = this.minDelay
      this.heard(ws)
    })
    ws.on('ping', () => this.heard(ws))
    ws.on('message', (data, binary) => {
      this.heard(ws)
      if (binary) return
      let msg: { t?: unknown; pipe?: unknown }
      try {
        msg = JSON.parse(String(data))
      } catch {
        return
      }
      if (msg.t === 'ready') this.set({ state: 'online', since: new Date(this.now()).toISOString() })
      else if (msg.t === 'open' && typeof msg.pipe === 'string' && PIPE_ID.test(msg.pipe)) this.accept(msg.pipe, token)
    })
    ws.on('error', ignore)
    ws.on('close', (code) => {
      // Stopped or replaced: `drop` let go of it first.
      if (this.ws !== ws) return
      this.ws = undefined
      clearTimeout(this.silence)
      if (code === 4401) refused = 'session-invalid'
      if (code === 4402) refused = 'license-required'
      if (code === 4009) refused = 'replaced'
      if (refused === 'session-invalid' || refused === 'core-only' || refused === 'license-required') return this.schedule({ state: 'error', reason: refused }, REFUSED_RETRY_MS)
      // Another instance of this core took over (the same data folder twice): don't fight over it.
      if (refused === 'replaced') return this.schedule({ state: 'error', reason: refused }, this.maxDelay)
      this.schedule(refused ? { state: 'error', reason: refused } : { state: 'connecting' })
    })
  }

  /** A phone wants in: dial its pipe and hand it to the HTTPS server. */
  private accept(pipe: string, token: string): void {
    if (this.pipes.size >= MAX_PIPES) return
    const ws = new this.WS(`${this.base()}/v1/relay/accept?pipe=${pipe}`, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 10_000,
      maxPayload: MAX_PIPE_MESSAGE,
      perMessageDeflate: false
    })
    this.pipes.add(ws)
    ws.on('unexpected-response', (_req, res) => {
      res.resume()
      ws.terminate()
    })
    let stream: Duplex | undefined
    ws.on('error', ignore)
    ws.on('close', () => {
      this.pipes.delete(ws)
      // The phone's end went (or the cloud's): the HTTPS server's connection over it ends now, not at its timeout.
      stream?.destroy()
    })
    // (`stop` terminates every pipe still dialling: none opens after it.)
    ws.on('open', () => {
      stream = pipeStream(ws)
      stream.on('error', ignore)
      if (!this.opts.attach(stream)) stream.destroy()
    })
  }

  /** Something came from the cloud: the connection lives. Silent too long, it is dropped and dialled again. */
  private heard(ws: WebSocket): void {
    clearTimeout(this.silence)
    // Every new connection clears it first: this is always the current one's.
    this.silence = setTimeout(() => ws.terminate(), this.opts.silenceMs ?? SILENCE_MS)
    this.silence.unref?.()
  }

  private schedule(status: RelayStatus, wait?: number): void {
    this.set(status)
    clearTimeout(this.retry)
    const ms = wait ?? this.delay
    this.retry = setTimeout(() => void this.connect(), ms)
    this.retry.unref?.()
    // Jitter, so many cores do not come back in lockstep after a cloud restart.
    if (wait === undefined) this.delay = Math.min(this.maxDelay, this.delay * 2 * (0.8 + Math.random() * 0.4))
  }

  private sendControl(msg: object): void {
    if (this.ws?.readyState === this.WS.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private drop(): void {
    const ws = this.ws
    this.ws = undefined
    ws?.terminate()
  }

  private clearTimers(): void {
    clearTimeout(this.retry)
    clearTimeout(this.silence)
    this.retry = this.silence = undefined
  }

  private set(status: RelayStatus): void {
    const same = this.current.state === status.state && this.current.reason === status.reason
    this.current = status
    if (!same) this.opts.onStatus?.(this.status())
  }

  /** `https://api…` → `wss://api…` (the dev cloud on http:// → ws://: the pipes carry TLS of their own all the same). */
  private base(): string {
    return this.opts.cloudUrl().replace(/\/+$/, '').replace(/^http/, 'ws')
  }
}
