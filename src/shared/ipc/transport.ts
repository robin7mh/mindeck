// How a client reaches the Mindeck core. Two implementations, one interface:
// the Electron preload bridge (desktop window) and HTTP + WebSocket (web UI,
// mobile app). Uses only `fetch` and `WebSocket` — no DOM, no Node — so the
// React Native app can import this file as-is.

import type { IpcResult } from './contract'
import type { Device, PairResult } from '@shared/types/server'

export type LinkState = 'connecting' | 'online' | 'offline'

export interface Transport {
  readonly kind: 'bridge' | 'remote'
  invoke(channel: string, payload?: unknown): Promise<IpcResult<unknown>>
  /** Subscribe to a push event. Returns an unsubscribe function. */
  on(channel: string, cb: (payload: unknown) => void): () => void
  /**
   * Called when events were lost: the push channel is back after an outage
   * and the core could not replay the gap (`resync-required`, or a core that
   * keeps no replay), so whoever mirrors core state reloads it. A gap the
   * core replays needs no resync. Absent where events cannot drop (the
   * desktop bridge).
   */
  onResync?(cb: () => void): () => void
}

/** The subset of `window.mindeck` a bridge transport needs. */
export interface BridgeLike {
  invoke(channel: string, payload?: unknown): Promise<unknown>
  on(channel: string, cb: (payload: unknown) => void): () => void
}

export function bridgeTransport(bridge: BridgeLike): Transport {
  return {
    kind: 'bridge',
    invoke: (channel, payload) => bridge.invoke(channel, payload) as Promise<IpcResult<unknown>>,
    on: (channel, cb) => bridge.on(channel, cb)
  }
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  status: number
  json(): Promise<unknown>
}>

interface SocketLike {
  onopen: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  close(): void
}
type SocketCtor = new (url: string, protocols?: string[]) => SocketLike

export interface RemoteTransportOptions {
  /** Core base URL, e.g. `http://192.168.1.20:7420` ('' = same origin). */
  baseUrl: string
  /**
   * The device token (Bearer). Absent: the web UI on the core's own address,
   * where the browser's HttpOnly cookie carries it (`pairBrowser`) — no
   * script in the page ever holds it.
   */
  token?: string
  fetch?: FetchLike
  WebSocket?: SocketCtor
  /** The core rejected the token (revoked / unknown) — clear it and re-pair. */
  onUnauthorized?: () => void
  onLinkState?: (state: LinkState) => void
  /** Reconnect delay bounds for the event socket. */
  minDelayMs?: number
  maxDelayMs?: number
}

export interface RemoteTransport extends Transport {
  readonly kind: 'remote'
  close(): void
}

const trimSlash = (url: string) => url.replace(/\/+$/, '')

/**
 * ws(s)://host/api/events derived from the HTTP base URL. A reconnecting
 * client adds where it stopped (`?stream=<id>&since=<seq>`, from the core's
 * `hello` and the events' `seq`): the core replays what it missed.
 */
export function eventsUrl(baseUrl: string, origin?: string, resume?: { stream: string; since: number }): string {
  const base = trimSlash(baseUrl) || trimSlash(origin ?? '')
  const query = resume ? `?stream=${encodeURIComponent(resume.stream)}&since=${resume.since}` : ''
  return `${base.replace(/^http/, 'ws')}/api/events${query}`
}

/** The events socket's subprotocol — the core answers with it. */
export const EVENTS_PROTOCOL = 'mindeck'
/** The device token travels as a second offered subprotocol: never in the URL (and so never in a log). */
export const TOKEN_PROTOCOL_PREFIX = 'mindeck.bearer.'

/** What a client offers when it opens the events socket (without a token: the browser sends its cookie). */
export function eventsProtocols(token?: string): string[] {
  return token ? [EVENTS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`] : [EVENTS_PROTOCOL]
}

/**
 * HTTP RPC + one auto-reconnecting WebSocket for push events. The socket
 * opens with the first subscription and stays up while anyone listens.
 */
export function createRemoteTransport(opts: RemoteTransportOptions): RemoteTransport {
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike)
  const Socket = opts.WebSocket ?? (globalThis.WebSocket as unknown as SocketCtor)
  const base = trimSlash(opts.baseUrl)
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const resyncs = new Set<() => void>()
  const minDelay = opts.minDelayMs ?? 500
  const maxDelay = opts.maxDelayMs ?? 10_000
  let socket: SocketLike | null = null
  let delay = minDelay
  let retry: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let unauthorized = false
  /** The socket went down (or never came up) since the last open: events may be missing. */
  let dropped = false
  /** Where the core's numbered events stand for this client (its `hello`, then each event's `seq`). */
  let stream: string | null = null
  let lastSeq = 0
  /** Back after an outage, resumed: the core replays — unless its hello shows it can't (an older core). */
  let awaitingHello = false

  const resync = () => {
    for (const cb of [...resyncs]) cb()
  }

  const setLink = (state: LinkState) => opts.onLinkState?.(state)
  const listenerCount = () => [...listeners.values()].reduce((n, s) => n + s.size, 0)

  const rejectToken = () => {
    if (unauthorized) return
    unauthorized = true
    opts.onUnauthorized?.()
  }

  const connect = () => {
    if (closed || socket || unauthorized) return
    setLink('connecting')
    const origin = (globalThis as { location?: { origin?: string } }).location?.origin
    const resuming = stream !== null
    const ws = new Socket(eventsUrl(base, origin, resuming ? { stream: stream!, since: lastSeq } : undefined), eventsProtocols(opts.token))
    socket = ws
    let opened = false
    ws.onopen = () => {
      opened = true
      delay = minDelay
      setLink('online')
      if (!dropped) return
      dropped = false
      // Resumed: the core sends what was missed (or says resync-required). Nothing to resume from: reload now.
      if (resuming) awaitingHello = true
      else resync()
    }
    ws.onmessage = (ev) => {
      let msg: { channel?: string; payload?: unknown; seq?: unknown }
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      const p = (msg.payload ?? {}) as { stream?: unknown; seq?: unknown }
      const numbered = typeof p.stream === 'string' && typeof p.seq === 'number'
      let gap = false
      if (msg.channel === 'hello') {
        // A new numbering (first connection, a restarted core): start from where it stands.
        if (numbered && p.stream !== stream) [stream, lastSeq] = [p.stream as string, p.seq as number]
        // A core without replay: whatever happened in the gap is lost.
        if (!numbered && awaitingHello) gap = true
        awaitingHello = false
      } else if (msg.channel === 'resync-required') {
        if (numbered) [stream, lastSeq] = [p.stream as string, p.seq as number]
        gap = true
      } else if (typeof msg.seq === 'number') {
        if (msg.seq <= lastSeq) return // seen already
        gap = msg.seq > lastSeq + 1
        lastSeq = msg.seq
      }
      for (const cb of [...(listeners.get(String(msg.channel)) ?? [])]) cb(msg.payload)
      if (gap) resync()
    }
    ws.onerror = () => {}
    ws.onclose = (ev) => {
      socket = null
      const code = (ev as { code?: number } | undefined)?.code
      if (code === 4401) return rejectToken()
      if (closed) return
      dropped = true
      setLink('offline')
      if (!listenerCount()) return
      // A socket that never opened may mean a bad token — ask the API once.
      if (!opened) void doFetch(`${base}/api/rpc/app:info`, request(null)).then((r) => r.status === 401 && rejectToken(), () => {})
      retry = setTimeout(() => {
        retry = null
        connect()
      }, delay)
      delay = Math.min(maxDelay, delay * 2)
    }
  }

  const request = (payload: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: JSON.stringify(payload ?? null)
  })

  return {
    kind: 'remote',
    async invoke(channel, payload) {
      let res: Awaited<ReturnType<FetchLike>>
      try {
        res = await doFetch(`${base}/api/rpc/${channel}`, request(payload))
      } catch (err) {
        setLink('offline')
        return { ok: false, error: { code: 'offline', message: `Mindeck core unreachable: ${(err as Error).message}` } }
      }
      if (res.status === 401) rejectToken()
      const body = (await res.json().catch(() => null)) as IpcResult<unknown> | null
      return body ?? { ok: false, error: { code: 'bad-response', message: `Unexpected response (${res.status})` } }
    },
    on(channel, cb) {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(cb)
      connect()
      return () => {
        listeners.get(channel)?.delete(cb)
      }
    },
    onResync(cb) {
      resyncs.add(cb)
      return () => {
        resyncs.delete(cb)
      }
    },
    close() {
      closed = true
      if (retry) clearTimeout(retry)
      retry = null
      socket?.close()
      socket = null
    }
  }
}

/** A SHA-256 fingerprint as 64 hex digits (any notation: `AB:CD…`, `ab cd…`), or null. */
export function normalizeFingerprint(fingerprint: string): string | null {
  const hex = fingerprint.replace(/[\s:]/g, '').toUpperCase()
  return /^[0-9A-F]{64}$/.test(hex) ? hex : null
}

/** `AB:CD:…` — how certificate viewers show a fingerprint. */
export function formatFingerprint(fingerprint: string): string {
  return (normalizeFingerprint(fingerprint) ?? '').replace(/(..)(?!$)/g, '$1:')
}

/**
 * The link a QR code carries: `<base>/#pair=<code>` and, for a core that
 * speaks HTTPS, `&fp=<sha256>` — the certificate a client should find there —
 * and `&pk=<sha256>`, its public key (the same after the core renews the certificate).
 */
export function pairingLink(baseUrl: string, code: string, fingerprint?: string, spkiFingerprint?: string): string {
  const fp = fingerprint ? normalizeFingerprint(fingerprint) : null
  const pk = fp && spkiFingerprint ? normalizeFingerprint(spkiFingerprint) : null
  return `${trimSlash(baseUrl)}/#pair=${encodeURIComponent(code)}${fp ? `&fp=${fp.toLowerCase()}` : ''}${pk ? `&pk=${pk.toLowerCase()}` : ''}`
}

export interface PairingLink {
  baseUrl: string
  code: string
  /** `AB:CD:…`, when the link names the core's certificate. */
  fingerprint?: string
  /** `AB:CD:…`, when the link also names the certificate's public key. */
  spkiFingerprint?: string
}

/** A scanned pairing link taken apart (null when it is none). */
export function parsePairingLink(link: string): PairingLink | null {
  const m = /^(https?:\/\/[^#]+?)\/?#(.*)$/i.exec(link.trim())
  const params = new URLSearchParams(m?.[2] ?? '')
  const code = params.get('pair')
  if (!m || !code) return null
  const fingerprint = normalizeFingerprint(params.get('fp') ?? '')
  const spki = normalizeFingerprint(params.get('pk') ?? '')
  return {
    baseUrl: m[1],
    code,
    ...(fingerprint ? { fingerprint: formatFingerprint(fingerprint) } : {}),
    ...(fingerprint && spki ? { spkiFingerprint: formatFingerprint(spki) } : {})
  }
}

/** Liveness check — also tells a client whether a URL really is a Mindeck core. */
export async function probeCore(
  baseUrl: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike
): Promise<{ name: string; version: string; mode: string } | null> {
  try {
    const res = await fetchImpl(`${trimSlash(baseUrl)}/api/health`, { method: 'GET' })
    const body = (await res.json()) as { ok?: boolean; name?: string; version: string; mode: string }
    return body?.ok && body.name === 'Mindeck' ? { name: body.name, version: body.version, mode: body.mode } : null
  } catch {
    return null
  }
}

/** A POST to the core's own endpoints: its data, or a throw with the core's message and code. */
async function post<T>(fetchImpl: FetchLike, url: string, payload: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload)
  })
  const body = (await res.json().catch(() => null)) as IpcResult<T> | null
  if (!body) throw Object.assign(new Error(`Unexpected response (${res.status})`), { code: 'bad-response' })
  if (!body.ok) throw Object.assign(new Error(body.error.message), { code: body.error.code })
  return body.data
}

/** Redeem a pairing code for this device's token. Throws with the core's message. */
export function pairDevice(baseUrl: string, code: string, name: string, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): Promise<PairResult> {
  return post<PairResult>(fetchImpl, `${trimSlash(baseUrl)}/api/pair`, { code, name })
}

/** What the web UI learns when it pairs: its device — the token stays in the core's HttpOnly cookie. */
export type BrowserPairResult = Omit<PairResult, 'token'>

/**
 * The web UI on the core's own address redeems a pairing code: the core
 * keeps the token in an HttpOnly cookie for `/api` — for good (`remember`)
 * or until the browser closes. Throws with the core's message.
 */
export function pairBrowser(baseUrl: string, code: string, name: string, remember: boolean, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): Promise<BrowserPairResult> {
  return post<BrowserPairResult>(fetchImpl, `${trimSlash(baseUrl)}/api/pair`, { code, name, cookie: true, remember })
}

/** A token the web UI kept in web storage (before the cookie): handed to the core once, which puts it into the cookie. */
export function adoptBrowserSession(baseUrl: string, token: string, remember: boolean, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): Promise<{ device: Device }> {
  return post<{ device: Device }>(fetchImpl, `${trimSlash(baseUrl)}/api/session`, { remember }, { Authorization: `Bearer ${token}` })
}

/** Sign the web UI out: the core removes this browser's device (its cookie's, or `token`'s) and deletes the cookie. */
export async function endBrowserSession(baseUrl: string, token?: string, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): Promise<void> {
  await post<unknown>(fetchImpl, `${trimSlash(baseUrl)}/api/logout`, {}, token ? { Authorization: `Bearer ${token}` } : {})
}
