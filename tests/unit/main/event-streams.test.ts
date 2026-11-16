import { describe, expect, it } from 'vitest'
import { DeviceStream, EventStreams, REPLAY_LIMITS } from '../../../electron/main/server/EventStreams'

const body = (n: number, pad = '') => JSON.stringify({ channel: 'memory:changed', payload: { paths: [`${n}${pad}`] } })

describe('event streams (FE-BUG-01)', () => {
  it('numbers a device’s events and returns them with their seq', () => {
    const stream = new DeviceStream(REPLAY_LIMITS, 0)
    expect(stream.record(body(1), 0)).toBe('{"channel":"memory:changed","payload":{"paths":["1"]},"seq":1}')
    stream.record(body(2), 0)
    expect(stream.after(stream.id, 0, 0)).toHaveLength(2)
    expect(stream.after(stream.id, 1, 0)).toEqual(['{"channel":"memory:changed","payload":{"paths":["2"]},"seq":2}'])
    expect(stream.after(stream.id, 2, 0)).toEqual([])
    expect(stream.after('other', 2, 0)).toBeNull()
    expect(stream.after(stream.id, 3, 0)).toBeNull()
    stream.clear()
    expect(stream.size).toBe(0)
    expect(stream.after(stream.id, 2, 0)).toEqual([])
    expect(stream.after(stream.id, 1, 0)).toBeNull()
    expect(new DeviceStream(REPLAY_LIMITS, 0).id).not.toBe(stream.id)
  })

  it('keeps at most so many events, so many bytes, for so long', () => {
    const byCount = new DeviceStream({ ...REPLAY_LIMITS, maxEvents: 2 }, 0)
    for (let i = 1; i <= 4; i += 1) byCount.record(body(i), 0)
    expect(byCount.size).toBe(2)
    expect(byCount.after(byCount.id, 1, 0)).toBeNull()
    expect(byCount.after(byCount.id, 2, 0)).toHaveLength(2)

    const one = body(1, 'x'.repeat(100)).length + ',"seq":1'.length
    const bySize = new DeviceStream({ ...REPLAY_LIMITS, maxBytes: one * 2 }, 0)
    for (let i = 1; i <= 3; i += 1) bySize.record(body(i, 'x'.repeat(100)), 0)
    expect(bySize.size).toBe(2)
    // One event bigger than the whole budget: not even it stays.
    bySize.record(body(4, 'y'.repeat(one * 3)), 0)
    expect(bySize.size).toBe(0)
    expect(bySize.after(bySize.id, 3, 0)).toBeNull()

    const byAge = new DeviceStream({ ...REPLAY_LIMITS, maxAgeMs: 1000 }, 0)
    byAge.record(body(1), 0)
    byAge.record(body(2), 600)
    expect(byAge.after(byAge.id, 0, 1001)).toBeNull() // #1 ran out
    expect(byAge.after(byAge.id, 1, 1001)).toHaveLength(1)
    expect(byAge.after(byAge.id, 1, 1601)).toBeNull()
  })

  it('streams per device: kept on reconnect, forgotten when gone too long, the ones gone longest give way first', () => {
    const streams = new EventStreams({ ...REPLAY_LIMITS, maxAgeMs: 1000, maxDevices: 2 })
    const a = streams.open('a', 0)
    expect(streams.open('a', 10)).toBe(a)
    expect(a.seen).toBe(10)
    streams.open('b', 20)
    streams.open('c', 30)
    expect(streams.size).toBe(3)
    streams.prune(40, new Set(['a']))
    expect([...streams.entries()].map(([id]) => id)).toEqual(['a', 'c']) // b went first (a is connected)
    streams.prune(2000, new Set())
    expect(streams.size).toBe(0)
    streams.open('d', 0).record(body(1), 0)
    streams.clear()
    expect(streams.get('d')!.size).toBe(0)
    streams.drop('d')
    expect(streams.get('d')).toBeUndefined()
    expect(new EventStreams().size).toBe(0)
  })
})
