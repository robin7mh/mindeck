// Renderer-side typed client. In the desktop window it talks to the core over
// the preload bridge (window.mindeck); in a browser over HTTP + WebSocket once
// the device is paired (setTransport). Without either it fails cleanly.

import type { IpcChannel, IpcChannels, IpcEvent, IpcEvents, IpcResult } from './contract'
import { bridgeTransport, type Transport } from './transport'

let remote: Transport | null = null

/** Install (or clear) the network transport — called by the web session. */
export function setTransport(transport: Transport | null): void {
  remote = transport
}

/** True inside the Electron window (native dialogs, window controls, …). */
export function isDesktop(): boolean {
  return !!window.mindeck?.invoke
}

/** The active transport: the desktop bridge wins, else the paired remote. */
export function currentTransport(): Transport | null {
  const bridge = window.mindeck
  if (bridge?.invoke) return bridgeTransport(bridge)
  return remote
}

export class IpcError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'IpcError'
    this.code = code
  }
}

/** Words the client's own failures (offline, bad response, no core) in the UI's language; undefined keeps the message. */
export type ErrorLocalizer = (code: string, message: string) => string | undefined
let localize: ErrorLocalizer = () => undefined

/** Installed once by the UI (src/lib/i18n): this file stays free of the UI's dictionaries. */
export function setErrorLocalizer(fn: ErrorLocalizer): void {
  localize = fn
}

/** Human-readable message for anything thrown (IpcError is an Error too). */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const code = (err as { code?: unknown }).code
  return (typeof code === 'string' && localize(code, err.message)) || err.message
}

type Req<K extends IpcChannel> = IpcChannels[K]['request']
type Res<K extends IpcChannel> = IpcChannels[K]['response']

/**
 * Typed invoke. For channels whose request is `void` the payload arg is omitted:
 *   await ipc('projects:list')
 *   await ipc('projects:add', { path })
 */
export async function ipc<K extends IpcChannel>(
  channel: K,
  ...args: Req<K> extends void ? [] : [Req<K>]
): Promise<Res<K>> {
  const transport = currentTransport()
  if (!transport) {
    throw new IpcError('no-bridge', localize('no-bridge', '') ?? 'Not connected to a Mindeck core')
  }
  const res = (await transport.invoke(channel, args[0])) as IpcResult<Res<K>>
  if (!res.ok) throw new IpcError(res.error.code, localize(res.error.code, res.error.message) ?? res.error.message)
  return res.data
}

/**
 * Run `cb` whenever the push channel reconnected after an outage (web UI,
 * phone): events of the gap are gone, so reload what they would have changed.
 * Never fires on the desktop, whose bridge cannot drop events.
 */
export function onResync(cb: () => void): () => void {
  return currentTransport()?.onResync?.(cb) ?? (() => {})
}

/**
 * Subscribe to a push event. Returns an unsubscribe function. No-ops (returns
 * a noop unsubscribe) without a transport so callers stay simple.
 */
export function onEvent<K extends IpcEvent>(
  channel: K,
  cb: (payload: IpcEvents[K]) => void
): () => void {
  const transport = currentTransport()
  if (!transport) return () => {}
  return transport.on(channel, (payload) => cb(payload as IpcEvents[K]))
}
