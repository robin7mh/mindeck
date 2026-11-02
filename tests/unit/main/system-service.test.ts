import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const c = vi.hoisted(() => ({
  collect: vi.fn(),
  collectProcesses: vi.fn(),
  currentUser: vi.fn(),
  startSampling: vi.fn(),
  stopSampling: vi.fn()
}))
vi.mock('../../../electron/main/services/system/collectors', () => c)

import { SystemService } from '../../../electron/main/services/system/SystemService'

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  c.collect.mockImplementation(async (procs: unknown[]) => ({ ts: 1, processes: procs }))
  c.collectProcesses.mockResolvedValue([{ pid: 1 }])
  c.currentUser.mockResolvedValue({ name: 'Robin H', firstName: 'Robin' })
})
afterEach(() => vi.useRealTimers())

describe('SystemService', () => {
  it('samples only while subscribed and not paused', async () => {
    const send = vi.fn()
    const s = new SystemService(send, 1000, 3)
    s.subscribe()
    await flush()
    expect(send).toHaveBeenCalledTimes(1) // immediate first sample

    await vi.advanceTimersByTimeAsync(2000)
    expect(send).toHaveBeenCalledTimes(3)
    // The Windows sampler runs exactly while the timer does.
    expect(c.startSampling).toHaveBeenCalledTimes(3)
    expect(c.stopSampling).not.toHaveBeenCalled()

    s.setPaused(true)
    expect(c.stopSampling).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(send).toHaveBeenCalledTimes(3)

    s.setPaused(false)
    await flush()
    s.subscribe() // second subscriber: no second timer
    await vi.advanceTimersByTimeAsync(1000)
    expect(send).toHaveBeenCalledTimes(5)

    s.unsubscribe()
    s.unsubscribe()
    s.unsubscribe() // never below zero
    await vi.advanceTimersByTimeAsync(5000)
    expect(send).toHaveBeenCalledTimes(5)
    s.dispose()
  })

  it('refreshes processes every Nth tick in the background and carries them along', async () => {
    const send = vi.fn()
    const s = new SystemService(send, 1000, 2)
    s.subscribe()
    await flush()
    await vi.advanceTimersByTimeAsync(1000)
    expect(c.collectProcesses).toHaveBeenCalledTimes(1) // ticks 1 → yes, 2 → no
    expect(send).toHaveBeenLastCalledWith({ ts: 1, processes: [{ pid: 1 }] })
    s.dispose()
    s.dispose() // safe twice
  })

  it('skips failing samples and keeps the previous process list on a failed scan', async () => {
    const send = vi.fn()
    const s = new SystemService(send)
    c.collect.mockRejectedValueOnce(new Error('sensor'))
    c.collectProcesses.mockRejectedValueOnce(new Error('top'))
    s.subscribe()
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect(await s.snapshot()).toEqual({ ts: 1, processes: [] })
    s.dispose()
  })

  it('skips ticks while a sample is still in flight (a stuck `df`), then carries on', async () => {
    let release: (v: unknown) => void = () => {}
    c.collect.mockReturnValueOnce(new Promise((r) => (release = r)))
    const send = vi.fn()
    const s = new SystemService(send, 1000, 100)
    s.subscribe()
    await flush()
    await vi.advanceTimersByTimeAsync(3000)
    expect(c.collect).toHaveBeenCalledTimes(1) // no pile-up behind the stuck one
    expect(send).not.toHaveBeenCalled()
    release({ ts: 0, processes: [] })
    await flush()
    expect(send).toHaveBeenCalledWith({ ts: 0, processes: [] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(c.collect).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledTimes(2)
    s.dispose()
  })

  it('never runs two process scans at once', async () => {
    let release: (v: unknown) => void = () => {}
    c.collectProcesses.mockReturnValueOnce(new Promise((r) => (release = r)))
    const s = new SystemService(vi.fn())
    await s.snapshot()
    await s.snapshot()
    expect(c.collectProcesses).toHaveBeenCalledTimes(1)
    release([{ pid: 9 }])
    await flush()
    expect((await s.snapshot()).processes).toEqual([{ pid: 9 }])
  })

  it('exposes the OS user for the greeting', async () => {
    expect(await new SystemService(vi.fn()).user()).toEqual({ name: 'Robin H', firstName: 'Robin' })
  })
})
