import { create } from 'zustand'
import { errorMessage, ipc, onEvent } from '@shared/ipc/client'
import type { CloudStatus } from '@shared/types/cloud'
import { getT, useLocale } from '@/lib/i18n'
import { openExternal } from '@/lib/links'

export interface CloudMessage {
  kind: 'error' | 'info'
  text: string
  /** The cloud's error code (`device_limit` links the website's device list). */
  code?: string
}

/** A cloud error in the UI language (by code), else its raw message. */
export function cloudError(err: unknown): string {
  const code = (err as { code?: string }).code
  const known = code ? (getT().cloud.errors as Record<string, string>)[code] : undefined
  return known ?? errorMessage(err)
}

/** "6 h 12 min" / "45 min" — trial time left. */
export function formatDuration(seconds: number): string {
  const minutes = Math.max(0, Math.floor(seconds / 60))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h} h ${m} min` : `${m} min`
}

interface CloudState {
  status: CloudStatus | null
  loadError: string | null
  busy: boolean
  message: CloudMessage | null
  /** Last Stripe Checkout, in case the browser blocked the new tab. */
  checkoutUrl: string | null
  /** Loads the status and follows the core's updates; returns the unsubscribe. */
  connect: () => () => void
  load: () => Promise<void>
  login: (email: string, password: string) => Promise<boolean>
  register: (email: string, password: string, name: string) => Promise<boolean>
  forgot: (email: string) => Promise<boolean>
  logout: () => Promise<boolean>
  refresh: () => Promise<boolean>
  resend: () => Promise<boolean>
  buy: () => Promise<boolean>
  clearMessage: () => void
}

/** The Mindeck account (Mindeck Cloud) as the connected core reports it. */
export const useCloud = create<CloudState>((set, get) => {
  /** One user action: busy while it runs, then its result or a readable error. */
  const run = async (action: () => Promise<CloudStatus | void>, info?: () => string): Promise<boolean> => {
    set({ busy: true, message: null })
    try {
      const status = await action()
      set({ busy: false, ...(status ? { status } : {}), message: info ? { kind: 'info', text: info() } : null })
      return true
    } catch (err) {
      set({ busy: false, message: { kind: 'error', text: cloudError(err), code: (err as { code?: string }).code } })
      return false
    }
  }

  return {
    status: null,
    loadError: null,
    busy: false,
    message: null,
    checkoutUrl: null,

    connect: () => {
      void get().load()
      return onEvent('cloud:status', (status) => set({ status }))
    },

    load: async () => {
      try {
        set({ status: await ipc('cloud:status'), loadError: null })
      } catch (err) {
        set({ loadError: errorMessage(err) })
      }
    },

    login: (email, password) => run(() => ipc('cloud:login', { email: email.trim(), password })),

    register: (email, password, name) =>
      run(() =>
        ipc('cloud:register', {
          email: email.trim(),
          password,
          ...(name.trim() ? { name: name.trim() } : {}),
          locale: useLocale.getState().locale
        })
      ),

    forgot: (email) =>
      run(
        () => ipc('cloud:forgotPassword', { email: email.trim() }),
        () => getT().cloud.forgotSent
      ),

    logout: () => run(() => ipc('cloud:logout')),

    refresh: () => run(() => ipc('cloud:refresh')),

    resend: () =>
      run(
        () => ipc('cloud:resendVerification'),
        () => getT().cloud.resent
      ),

    buy: () =>
      run(
        async () => {
          const { url } = await ipc('cloud:checkout')
          set({ checkoutUrl: url })
          // Desktop: opens in the OS browser (the window's open handler).
          openExternal(url)
        },
        () => getT().cloud.checkoutOpened
      ),

    clearMessage: () => set({ message: null })
  }
})
