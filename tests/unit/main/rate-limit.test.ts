import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_RATE_LIMITS, DeviceRateLimiter, rateGroup, rateLimitsFromEnv } from '../../../electron/main/server/RateLimit'

describe('per-device rate limits (BE-SEC-18)', () => {
  it('counts only channels that cost money or quota', () => {
    expect(rateGroup('ai:send')).toBe('ai')
    expect(rateGroup('agents:create')).toBe('ai')
    expect(rateGroup('agents:send')).toBe('ai')
    expect(rateGroup('agents:resume')).toBe('ai')
    expect(rateGroup('ai:inlineComplete')).toBe('inline')
    expect(rateGroup('ai:inlineEdit')).toBe('inline')
    expect(rateGroup('github:list')).toBe('github')
    expect(rateGroup('github:merge')).toBe('github')
    expect(rateGroup('cloud:refresh')).toBe('cloud')
    expect(rateGroup('cloud:forgotPassword')).toBe('cloud')
    // Answered from what the core knows: free.
    for (const channel of ['cloud:status', 'cloud:adopt', 'ai:conversations', 'ai:inlineCancel', 'agents:list', 'projects:list']) expect(rateGroup(channel), channel).toBeNull()
  })

  it('a token bucket per device and group: a burst, then the refill rate; others are not affected', () => {
    let now = 1_000_000
    const limiter = new DeviceRateLimiter({ ...DEFAULT_RATE_LIMITS, ai: { burst: 3, perMinute: 6 }, github: null }, () => now)
    for (let i = 0; i < 3; i += 1) expect(limiter.take('phone', 'ai:send')).toBeNull()
    // Empty: one call back every 10 s.
    expect(limiter.take('phone', 'ai:send')).toEqual({ group: 'ai', waitMs: 10_000 })
    expect(limiter.take('phone', 'agents:send')).toMatchObject({ group: 'ai' }) // the same bucket
    // Another device, another group, a free channel and a switched-off group go on.
    expect(limiter.take('laptop', 'ai:send')).toBeNull()
    expect(limiter.take('phone', 'cloud:refresh')).toBeNull()
    expect(limiter.take('phone', 'projects:list')).toBeNull()
    for (let i = 0; i < 100; i += 1) expect(limiter.take('phone', 'github:list')).toBeNull()
    now += 5_000
    expect(limiter.take('phone', 'ai:send')).toEqual({ group: 'ai', waitMs: 5_000 })
    now += 5_000
    expect(limiter.take('phone', 'ai:send')).toBeNull()
    expect(limiter.take('phone', 'ai:send')).toMatchObject({ waitMs: 10_000 })
    // Never more than the burst, however long a device rested.
    now += 60 * 60_000
    for (let i = 0; i < 3; i += 1) expect(limiter.take('phone', 'ai:send')).toBeNull()
    expect(limiter.take('phone', 'ai:send')).not.toBeNull()
  })

  it('forgets refilled buckets and removed devices', () => {
    let now = 0
    const limiter = new DeviceRateLimiter(DEFAULT_RATE_LIMITS, () => now)
    limiter.take('phone', 'ai:send')
    limiter.take('phone', 'cloud:refresh')
    limiter.take('laptop', 'github:view')
    expect(limiter.size).toBe(3)
    limiter.sweep()
    expect(limiter.size).toBe(3) // still spent
    limiter.forget('laptop')
    expect(limiter.size).toBe(2)
    now += 6_000 // one cloud call (10/min) is back: full again; one AI call (20/min) too
    limiter.sweep()
    expect(limiter.size).toBe(0)
    expect(new DeviceRateLimiter().take('x', 'ai:send')).toBeNull()
  })

  it('MINDECK_RATE_LIMITS changes groups; what it can’t read is said and ignored', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(rateLimitsFromEnv({})).toEqual(DEFAULT_RATE_LIMITS)
    expect(rateLimitsFromEnv({ MINDECK_RATE_LIMITS: ' ai=10 , github=120:60,cloud=off,inline=0,' })).toEqual({
      ai: { perMinute: 10, burst: 10 },
      github: { perMinute: 120, burst: 60 },
      cloud: null,
      inline: null
    })
    expect(rateLimitsFromEnv({ MINDECK_RATE_LIMITS: 'ai=00,github=5:0' })).toEqual({ ...DEFAULT_RATE_LIMITS, ai: null, github: { perMinute: 5, burst: 1 } })
    expect(rateLimitsFromEnv({ MINDECK_RATE_LIMITS: 'mail=5,ai=fast,ai' })).toEqual(DEFAULT_RATE_LIMITS)
    expect(warn).toHaveBeenCalledTimes(3)
    expect(warn.mock.calls[0][0]).toMatch(/ignoring "mail=5"/)
  })
})
