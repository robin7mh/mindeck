import { vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { setTransport } from '@shared/ipc/client'
import type { Transport } from '@shared/ipc/transport'
import { DEFAULT_TERMINAL_SETTINGS } from '@shared/types/terminal'

type Route = (payload: never) => unknown

/** A Mindeck account that may use the app (dev build: no license required). */
export const OPEN_CLOUD = {
  enforced: false,
  allowed: true,
  state: 'signed_out',
  account: null,
  license: null,
  validUntil: null,
  offlineUntil: null,
  online: true,
  webUrl: null,
  error: null
}

/** Answers every test bridge gives unless a test routes the channel itself. */
const DEFAULT_ROUTES: Record<string, Route> = {
  'cloud:status': () => OPEN_CLOUD,
  'sftp:targets': () => [],
  'remote:list': () => [],
  // The Terminal: default settings, no shells found, nothing saved from a last run.
  'terminal:settings': () => DEFAULT_TERMINAL_SETTINGS,
  'terminal:shells': () => [],
  'terminal:restore': () => null
}

/**
 * Installs a fake `window.mindeck` bridge. `routes` answer `invoke` per channel
 * (throwing → `{ ok: false }` like the real registry); `emit` pushes events.
 */
export function installBridge(routes: Record<string, Route> = {}, platform: string = 'darwin') {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const winListeners = { max: new Set<(v: boolean) => void>(), full: new Set<(v: boolean) => void>() }
  const bridge = {
    platform,
    routes,
    invoke: vi.fn(async (channel: string, payload?: unknown) => {
      const fn = routes[channel] ?? DEFAULT_ROUTES[channel]
      try {
        return { ok: true, data: fn ? await fn(payload as never) : undefined }
      } catch (err) {
        const e = err as { code?: string; message?: string }
        return { ok: false, error: { code: e.code ?? 'error', message: e.message ?? String(err) } }
      }
    }),
    on: vi.fn((channel: string, cb: (p: unknown) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(cb)
      return () => listeners.get(channel)!.delete(cb)
    }),
    emit: (channel: string, payload: unknown) => [...(listeners.get(channel) ?? [])].forEach((cb) => cb(payload)),
    listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0,
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(async () => false),
    onMaximizedChange: vi.fn((cb: (v: boolean) => void) => {
      winListeners.max.add(cb)
      return () => winListeners.max.delete(cb)
    }),
    isFullScreen: vi.fn(async () => false),
    onFullScreenChange: vi.fn((cb: (v: boolean) => void) => {
      winListeners.full.add(cb)
      return () => winListeners.full.delete(cb)
    }),
    setMaximized: (v: boolean) => winListeners.max.forEach((cb) => cb(v)),
    setFullScreen: (v: boolean) => winListeners.full.forEach((cb) => cb(v))
  }
  ;(window as unknown as { mindeck: typeof bridge }).mindeck = bridge
  return bridge
}

/** Rejects like a failing IPC handler (code + message). */
export const fail = (message: string, code = 'error') => {
  throw Object.assign(new Error(message), { code })
}

/** Let pending promises/effects settle. */
export const settle = async (rounds = 5) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0))
}

/**
 * Installs a fake *network* transport (web UI mode: no `window.mindeck`).
 * `routes` answer `invoke` like installBridge; `emit` pushes events.
 */
export function installRemote(routes: Record<string, Route> = {}) {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const transport = {
    kind: 'remote' as const,
    routes,
    invoke: vi.fn(async (channel: string, payload?: unknown) => {
      const fn = routes[channel] ?? DEFAULT_ROUTES[channel]
      try {
        return { ok: true, data: fn ? await fn(payload as never) : undefined }
      } catch (err) {
        const e = err as { code?: string; message?: string }
        return { ok: false, error: { code: e.code ?? 'error', message: e.message ?? String(err) } }
      }
    }),
    on: vi.fn((channel: string, cb: (p: unknown) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(cb)
      return () => listeners.get(channel)!.delete(cb)
    }),
    emit: (channel: string, payload: unknown) => [...(listeners.get(channel) ?? [])].forEach((cb) => cb(payload)),
    resyncs: new Set<() => void>(),
    onResync: vi.fn((cb: () => void) => {
      transport.resyncs.add(cb)
      return () => transport.resyncs.delete(cb)
    }),
    /** The push channel is back after an outage. */
    resync: () => [...transport.resyncs].forEach((cb) => cb())
  }
  setTransport(transport as unknown as Transport)
  return transport
}

/** Picks `option` in the Mindeck Select named `label`, the way a user does: open it, click the entry. */
export function choose(label: string, option: string | RegExp): void {
  fireEvent.click(screen.getByRole('combobox', { name: label }))
  fireEvent.click(screen.getByRole('option', { name: option }))
}
