// How a client reaches the Mindeck core. Two implementations, one interface:
// the Electron preload bridge (desktop window) and HTTP + WebSocket (web UI,
// mobile app). Uses only `fetch` and `WebSocket` — no DOM, no Node — so the
// React Native app can import this file as-is.

import type { IpcResult } from './contract'
import type { PairResult } from '@shared/types/server'

export type LinkState = 'connecting' | 'online' | 'offline'

export interface Transport {
  readonly kind: 'bridge' | 'remote'
  invoke(channel: string, payload?: unknown): Promise<IpcResult<unknown>>
  /** Subscribe to a push event. Returns an unsubscribe function. */
  on(channel: string, cb: (payload: unknown) => void): () => void
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
type SocketCtor = new (url: string) => SocketLike

export interface RemoteTransportOptions {
  /** Core base URL, e.g. `http://192.168.1.20:7420` ('' = same origin). */
  baseUrl: string
  token: string
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

/** ws(s)://host/api/events?token=… derived from the HTTP base URL. */
export function eventsUrl(baseUrl: string, token: string, origin?: string): string {
  const base = trimSlash(baseUrl) || trimSlash(origin ?? '')
  return `${base.replace(/^http/, 'ws')}/api/events?token=${encodeURIComponent(token)}`
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
  const minDelay = opts.minDelayMs ?? 500
  const maxDelay = opts.maxDelayMs ?? 10_000
  let socket: SocketLike | null = null
  let delay = minDelay
  let retry: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let unauthorized = false
  let socketOpen = false

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
    const ws = new Socket(eventsUrl(base, opts.token, origin))
    socket = ws
    let opened = false
    // A blocked SYN can keep a socket "connecting" for a minute or more — give up
    // after 10 s so the reconnect loop gets a fresh attempt.
    const connectTimer = setTimeout(() => {
      if (!opened) ws.close()
    }, 10_000)
    ws.onopen = () => {
      clearTimeout(connectTimer)
      opened = true
      socketOpen = true
      delay = minDelay
      setLink('online')
    }
    ws.onmessage = (ev) => {
      let msg: { channel?: string; payload?: unknown }
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      for (const cb of [...(listeners.get(String(msg.channel)) ?? [])]) cb(msg.payload)
    }
    ws.onerror = () => {}
    ws.onclose = (ev) => {
      clearTimeout(connectTimer)
      if (socket === ws) {
        socket = null
        socketOpen = false
      }
      const code = (ev as { code?: number } | undefined)?.code
      if (code === 4401) return rejectToken()
      if (closed) return
      setLink('offline')
      if (!listenerCount()) return
      // A socket that never opened may mean a bad token — ask the API once.
      if (!opened) void doFetch(`${base}/api/rpc/app:info`, request(null)).then((r) => r.status === 401 && rejectToken(), () => {})
      retry = setTimeout(() => {
        retry = null
        connect()
      }, delay)
      // Jitter, so many clients do not reconnect in lockstep after a core restart.
      delay = Math.min(maxDelay, delay * 2 * (0.8 + Math.random() * 0.4))
    }
  }

  const request = (payload: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}` },
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
      // A failed call marked the link offline; a successful one while the event
      // socket is up means the core is reachable again.
      else if (socketOpen) setLink('online')
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
    close() {
      closed = true
      if (retry) clearTimeout(retry)
      retry = null
      socket?.close()
      socket = null
      socketOpen = false
    }
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

/** Redeem a pairing code for this device's token. Throws with the core's message. */
export async function pairDevice(
  baseUrl: string,
  code: string,
  name: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike
): Promise<PairResult> {
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await fetchImpl(`${trimSlash(baseUrl)}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name })
    })
  } catch (err) {
    throw Object.assign(new Error(`Mindeck core unreachable: ${(err as Error).message}`), { code: 'offline' })
  }
  const body = (await res.json().catch(() => null)) as IpcResult<PairResult> | null
  if (!body) throw Object.assign(new Error(`Unexpected response (${res.status})`), { code: 'bad-response' })
  if (!body.ok) throw Object.assign(new Error(body.error.message), { code: body.error.code })
  return body.data
}
