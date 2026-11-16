/**
 * What a paired device may spend per minute. Some channels cost the user
 * money or quota — the assistant and agents (AI credit, the user's own key or
 * subscription), inline AI, GitHub's API (5000 calls an hour per token) and
 * Mindeck Cloud — and a stolen or runaway device should not burn through it.
 * Each device gets a token bucket per group: `burst` calls at once, refilled
 * at `perMinute`. The desktop window is never limited.
 */
export type RateGroup = 'ai' | 'inline' | 'github' | 'cloud'

export interface RateLimit {
  /** Calls a device may make at once (the bucket's size). */
  burst: number
  /** Calls it gets back per minute. */
  perMinute: number
}

/** Each group's limit; null switches it off. */
export type RateLimits = Record<RateGroup, RateLimit | null>

export const DEFAULT_RATE_LIMITS: RateLimits = {
  // A message to the assistant or an agent: a person types these.
  ai: { burst: 20, perMinute: 20 },
  // Suggestions while typing (one per pause) and ⌘K edits.
  inline: { burst: 40, perMinute: 60 },
  github: { burst: 60, perMinute: 60 },
  // Sign-in, checks, sync and mails through Mindeck Cloud.
  cloud: { burst: 10, perMinute: 10 }
}

/** Messages that start AI work (the assistant, the agents). */
const AI = new Set(['ai:send', 'agents:create', 'agents:send', 'agents:resume'])
/** Account channels answered from what the core knows (or, `adopt`, from the desktop): no cloud call. */
const CLOUD_LOCAL = new Set(['cloud:status', 'cloud:adopt', 'cloud:installId'])

/** The group a channel's calls count against, or null (free). */
export function rateGroup(channel: string): RateGroup | null {
  if (channel === 'ai:inlineComplete' || channel === 'ai:inlineEdit') return 'inline'
  if (AI.has(channel)) return 'ai'
  if (channel.startsWith('github:')) return 'github'
  if (channel.startsWith('cloud:') && !CLOUD_LOCAL.has(channel)) return 'cloud'
  return null
}

const GROUPS = Object.keys(DEFAULT_RATE_LIMITS) as RateGroup[]

/**
 * `MINDECK_RATE_LIMITS=ai=10,github=120:60,cloud=off` → the defaults with
 * these changed: `<group>=<per minute>[:<burst>]` (burst defaults to the rate),
 * `off` or `0` switches a group off. What can't be read is said and ignored.
 */
export function rateLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimits {
  const limits = { ...DEFAULT_RATE_LIMITS }
  for (const entry of (env.MINDECK_RATE_LIMITS ?? '').split(',').map((e) => e.trim()).filter(Boolean)) {
    const m = /^([a-z]+)=(?:(off|0)|(\d+)(?::(\d+))?)$/.exec(entry)
    const group = m?.[1] as RateGroup | undefined
    if (!m || !GROUPS.includes(group!)) {
      console.warn(`[server] MINDECK_RATE_LIMITS: ignoring "${entry}" (expected <${GROUPS.join('|')}>=<per minute>[:<burst>] or =off)`)
      continue
    }
    const perMinute = Number(m[3])
    limits[group!] = m[2] || !perMinute ? null : { perMinute, burst: m[4] ? Math.max(1, Number(m[4])) : perMinute }
  }
  return limits
}

interface Bucket {
  tokens: number
  at: number
}

export class DeviceRateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  constructor(
    private readonly limits: RateLimits = DEFAULT_RATE_LIMITS,
    private readonly now: () => number = Date.now
  ) {}

  /** A call of `deviceId` on `channel`: null when it may go ahead (and is counted), else the milliseconds until it may. */
  take(deviceId: string, channel: string): { group: RateGroup; waitMs: number } | null {
    const group = rateGroup(channel)
    const limit = group && this.limits[group]
    if (!limit) return null
    const key = `${deviceId}\u0000${group}`
    const now = this.now()
    const perMs = limit.perMinute / 60_000
    const last = this.buckets.get(key)
    const tokens = last ? Math.min(limit.burst, last.tokens + (now - last.at) * perMs) : limit.burst
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now })
      return { group: group!, waitMs: Math.ceil((1 - tokens) / perMs) }
    }
    this.buckets.set(key, { tokens: tokens - 1, at: now })
    return null
  }

  /** A removed device's buckets go with it. */
  forget(deviceId: string): void {
    for (const key of [...this.buckets.keys()]) if (key.startsWith(`${deviceId}\u0000`)) this.buckets.delete(key)
  }

  /** Buckets that filled up again are the same as none: forgotten (the map stays small). */
  sweep(): void {
    const now = this.now()
    for (const [key, bucket] of this.buckets) {
      const limit = this.limits[key.split('\u0000')[1] as RateGroup]!
      if (bucket.tokens + (now - bucket.at) * (limit.perMinute / 60_000) >= limit.burst) this.buckets.delete(key)
    }
  }

  /** Buckets kept now (tests). */
  get size(): number {
    return this.buckets.size
  }
}
