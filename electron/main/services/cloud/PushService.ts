import type { PushNotice, PushSettings } from '@shared/types/cloud'
import type { SettingsService } from '../settings/SettingsService'

/** At most one push per session (or kind, without one) in this time. */
export const PUSH_INTERVAL_MS = 30_000
const MAX_TITLE = 120
const MAX_BODY = 240

export interface PushDeps {
  /** Mindeck Cloud's API address. */
  baseUrl: string
  /** The core's cloud session (null when signed out) — the same Bearer the heartbeat sends. */
  token: () => Promise<string | null>
  settings: Pick<SettingsService, 'get' | 'update'>
  /** Someone looks at Mindeck right now (desktop: its window has focus) — then the phone stays quiet. */
  focused: () => boolean
  fetch?: typeof fetch
  now?: () => number
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * Pushes to the user's phone through Mindeck Cloud when an agent waits for an
 * approval, finished or failed — only while Mindeck is in the background and
 * the user is signed in. Fire and forget: a failure is logged, never thrown,
 * so it can't get in a session's way.
 */
export class PushService {
  private readonly last = new Map<string, number>()
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(private readonly deps: PushDeps) {
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  async settings(): Promise<PushSettings> {
    return { enabled: this.deps.settings.get().agents?.pushToPhone !== false, signedIn: !!(await this.deps.token()) }
  }

  async configure(enabled: boolean): Promise<PushSettings> {
    await this.deps.settings.update({ agents: { ...this.deps.settings.get().agents, pushToPhone: enabled } })
    return this.settings()
  }

  /** Sends `notice` unless Mindeck is in front, pushes are off, or this session just pushed. */
  send(notice: PushNotice): void {
    void this.deliver(notice).catch((err: Error) => console.warn('[push] not sent:', err.message))
  }

  private async deliver(notice: PushNotice): Promise<void> {
    if (this.deps.focused() || this.deps.settings.get().agents?.pushToPhone === false) return
    const key = notice.sessionId ?? notice.kind
    const now = this.now()
    if (now - (this.last.get(key) ?? -Infinity) < PUSH_INTERVAL_MS) return
    // Taken before anything is awaited: a burst of events sends one push.
    this.last.set(key, now)
    const token = await this.deps.token()
    if (!token) return
    const body: PushNotice = { kind: notice.kind, title: clip(notice.title, MAX_TITLE), body: clip(notice.body, MAX_BODY) }
    if (notice.sessionId) body.sessionId = notice.sessionId
    const res = await this.fetch(`${this.deps.baseUrl}/v1/push/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) throw new Error(`Mindeck Cloud answered ${res.status}`)
  }
}
