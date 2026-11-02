// Renderer-side typed client. In the desktop window it talks to the core over
// the preload bridge (window.mindeck); in a browser over HTTP + WebSocket once
// the device is paired (setTransport). Without either it fails cleanly.

import type { IpcChannel, IpcChannels, IpcEvent, IpcEvents, IpcResult } from './contract'
import { bridgeTransport, type Transport } from './transport'

let remote: Transport | null = null

interface RemoteSub {
  channel: string
  cb: (payload: unknown) => void
  off: () => void
}
/** Event subscriptions made in a browser — re-bound whenever the transport changes (re-pairing, reconnect). */
const remoteSubs = new Set<RemoteSub>()
const noop = () => {}

/** Install (or clear) the network transport — called by the web session. */
export function setTransport(transport: Transport | null): void {
  remote = transport
  for (const sub of remoteSubs) {
    sub.off()
    sub.off = transport ? transport.on(sub.channel, sub.cb) : noop
  }
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

/** Human-readable message for anything thrown (IpcError is an Error too). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
    throw new IpcError('no-bridge', 'Not connected to a Mindeck core')
  }
  const res = (await transport.invoke(channel, args[0])) as IpcResult<Res<K>>
  if (!res.ok) throw new IpcError(res.error.code, res.error.message)
  return res.data
}

/**
 * Subscribe to a push event. Returns an unsubscribe function. In a browser the
 * subscription outlives the current transport: it is bound to whichever core
 * the session pairs with next (and stays idle while there is none).
 */
export function onEvent<K extends IpcEvent>(
  channel: K,
  cb: (payload: IpcEvents[K]) => void
): () => void {
  const bridge = window.mindeck
  if (bridge?.invoke) return bridgeTransport(bridge).on(channel, (payload) => cb(payload as IpcEvents[K]))
  const sub: RemoteSub = { channel, cb: (payload) => cb(payload as IpcEvents[K]), off: noop }
  sub.off = remote ? remote.on(channel, sub.cb) : noop
  remoteSubs.add(sub)
  return () => {
    remoteSubs.delete(sub)
    sub.off()
  }
}
