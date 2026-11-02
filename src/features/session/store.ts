import { create } from 'zustand'
import { errorMessage, ipc, isDesktop, setTransport } from '@shared/ipc/client'
import {
  adoptBrowserSession,
  createRemoteTransport,
  endBrowserSession,
  pairBrowser,
  probeCore,
  type LinkState,
  type RemoteTransport
} from '@shared/ipc/transport'
import type { AppInfo } from '@shared/types/server'
import { getT } from '@/lib/i18n'

/** Where the token was kept before the cookie (read once, to hand it over, then deleted). */
const TOKEN_KEY = 'mindeck.token'
/** This browser's device id — no secret: it only says this browser was paired (and where, local or session). */
const DEVICE_KEY = 'mindeck.deviceId'

export type SessionStatus = 'checking' | 'unpaired' | 'unreachable' | 'ready'

// The device token is a bearer key to the whole core: the page never holds
// it. The core keeps it in an HttpOnly cookie (FE-SEC-03) — persistent when
// the browser "stays paired" (the default: pairing again needs a fresh code
// from the core), a session cookie on a shared computer. A token kept in web
// storage by an older version (or handed in by the desktop's remote window)
// is exchanged for the cookie once and deleted.

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key) ?? localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null, remember = true): void {
  try {
    localStorage.removeItem(key)
    sessionStorage.removeItem(key)
    if (value !== null) (remember ? localStorage : sessionStorage).setItem(key, value)
  } catch {
    /* storage unavailable — the session just won't survive a reload */
  }
}

/** What outlives signing out: how the app looks and which language it speaks — nothing about the work. */
const KEEP_ON_LOGOUT = new Set(['mindeck.theme', 'mindeck.appearance', 'mindeck.locale'])

/** Signing out forgets this browser's traces: prompt history, drafts, recent files, layouts, paths. */
function forgetBrowserData(): void {
  for (const storage of [() => localStorage, () => sessionStorage]) {
    try {
      const store = storage()
      const keys = Array.from({ length: store.length }, (_, i) => store.key(i)!)
      for (const key of keys) if (key.startsWith('mindeck.') && !KEEP_ON_LOGOUT.has(key)) store.removeItem(key)
    } catch {
      /* storage unavailable — nothing was kept there */
    }
  }
}

/** A readable default name for this browser, e.g. "Chrome · macOS". */
export function defaultDeviceName(ua: string = navigator.userAgent): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser'
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Web'
  return `${browser} · ${os}`
}

interface SessionState {
  status: SessionStatus
  link: LinkState
  info?: AppInfo
  error?: string
  /** Start: desktop is always ready; a browser asks the core whether its cookie still holds. */
  init: () => Promise<void>
  /** `remember: false` keeps the pairing only as long as the browser session (a session cookie). */
  pair: (code: string, name: string, remember?: boolean) => Promise<boolean>
  /** Forget this browser's device (also revokes it on the core) and what it kept locally. */
  logout: () => Promise<void>
}

let transport: RemoteTransport | null = null

/** Same-origin core (the web UI is served by the core it talks to). */
const BASE_URL = ''

/**
 * A token from web storage goes into the cookie (and out of the storage):
 * remembered when it was kept in localStorage. Null when there is none or it
 * was handed over; the token itself when the core could not take it now
 * (unreachable) — used as before for this visit, handed over next time.
 */
async function migrateToken(): Promise<string | null> {
  const token = read(TOKEN_KEY)
  if (!token) return null
  // (read() just looked in sessionStorage: it answers.)
  const remember = sessionStorage.getItem(TOKEN_KEY) === null
  try {
    const { device } = await adoptBrowserSession(BASE_URL, token, remember)
    write(DEVICE_KEY, device.id, remember)
  } catch (err) {
    // Unknown to the core (revoked, expired): gone for good. Anything else: try again next time.
    if ((err as { code?: string }).code !== 'unauthorized') return token
  }
  write(TOKEN_KEY, null)
  return null
}

export const useSession = create<SessionState>((set, get) => {
  /**
   * Cookie session (no token), or — while a stored token could not be handed over yet — that token.
   * `paired`: this browser was paired before, so a rejection means "no longer paired".
   */
  const connect = (token: string | undefined, paired: boolean) => {
    transport?.close()
    transport = createRemoteTransport({
      baseUrl: BASE_URL,
      token,
      onLinkState: (link) => set({ link }),
      onUnauthorized: () => {
        // Paired before: say so; a browser that never paired just pairs.
        const known = paired || read(DEVICE_KEY) !== null
        write(TOKEN_KEY, null)
        write(DEVICE_KEY, null)
        transport?.close()
        transport = null
        setTransport(null)
        set({ status: 'unpaired', info: undefined, error: known ? getT().pair.noLongerPaired : undefined })
      }
    })
    setTransport(transport)
  }

  const loadInfo = async (): Promise<void> => {
    try {
      const info = await ipc('app:info')
      set({ info, status: 'ready', link: 'online', error: undefined })
    } catch (err) {
      // unauthorized → onUnauthorized already reset the session
      if ((err as { code?: string }).code !== 'unauthorized') set({ status: 'unreachable', error: errorMessage(err) })
    }
  }

  return {
    status: 'checking',
    link: 'connecting',

    init: async () => {
      if (isDesktop()) {
        set({ status: 'ready', link: 'online' })
        try {
          set({ info: await ipc('app:info') })
        } catch {
          /* info is decorative on the desktop */
        }
        return
      }
      set({ status: 'checking', error: undefined })
      if (!(await probeCore(BASE_URL))) return set({ status: 'unreachable', error: getT().pair.noCore })
      // The cookie (HttpOnly) can't be read here: the core says whether it still holds.
      const paired = read(DEVICE_KEY) !== null || read(TOKEN_KEY) !== null
      connect((await migrateToken()) ?? undefined, paired)
      await loadInfo()
    },

    pair: async (code, name, remember = true) => {
      set({ error: undefined })
      try {
        const result = await pairBrowser(BASE_URL, code.trim(), name.trim(), remember)
        write(DEVICE_KEY, result.device.id, remember)
        write(TOKEN_KEY, null)
        connect(undefined, true)
        await loadInfo()
        return true
      } catch (err) {
        set({ error: errorMessage(err) })
        return false
      }
    },

    logout: async () => {
      // The core removes this browser's device and deletes the cookie (a token not handed over yet: its device).
      if (get().status === 'ready') await endBrowserSession(BASE_URL, read(TOKEN_KEY) ?? undefined).catch(() => {})
      write(TOKEN_KEY, null)
      write(DEVICE_KEY, null)
      forgetBrowserData()
      transport?.close()
      transport = null
      setTransport(null)
      set({ status: 'unpaired', info: undefined, error: undefined })
    }
  }
})
