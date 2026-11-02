import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- doubles -----------------------------------------------------------------
const h = vi.hoisted(() => ({
  replies: new Map<string, string | Error>(),
  childPid: 4242,
  si: {
    currentLoad: vi.fn(),
    mem: vi.fn(),
    fsSize: vi.fn(),
    networkStats: vi.fn(),
    battery: vi.fn(),
    processes: vi.fn(),
    time: vi.fn()
  },
  username: 'robin',
  statfs: vi.fn(),
  sampler: {
    start: vi.fn(),
    stop: vi.fn(),
    running: false,
    net: { rxMbps: 1.5, txMbps: 0.2 },
    procs: [{ pid: 7, name: 'Code', cpu: 3, mem: 300 }]
  }
}))

vi.mock('node:child_process', () => {
  const execFile = (() => {}) as unknown as Record<symbol, unknown>
  execFile[promisify.custom] = (cmd: string) => {
    const reply = h.replies.get(cmd) ?? ''
    const p = (reply instanceof Error ? Promise.reject(reply) : Promise.resolve({ stdout: reply, stderr: '' })) as Promise<unknown> & {
      child: { pid: number }
    }
    p.catch(() => {})
    p.child = { pid: h.childPid }
    return p
  }
  return { execFile }
})
vi.mock('node:os', async (orig) => ({
  ...(await orig<typeof import('node:os')>()),
  userInfo: () => ({ username: h.username }),
  totalmem: () => 16e9,
  freemem: () => 4e9
}))
vi.mock('node:fs/promises', async (orig) => ({ ...(await orig<typeof import('node:fs/promises')>()), statfs: h.statfs }))
vi.mock('systeminformation', () => ({ default: h.si }))
vi.mock('../../../electron/main/services/system/winSampler', () => ({
  TOP_N: 6,
  WinSampler: class {
    start = h.sampler.start
    stop = h.sampler.stop
    get running() {
      return h.sampler.running
    }
    get net() {
      return h.sampler.net
    }
    get procs() {
      return h.sampler.procs
    }
  }
}))

type Collectors = typeof import('../../../electron/main/services/system/collectors')
const realPlatform = process.platform

/** Collectors read the platform at import time — load a fresh copy per platform. */
async function load(platform: NodeJS.Platform): Promise<Collectors> {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.resetModules()
  return import('../../../electron/main/services/system/collectors')
}

const TOP = `Processes: 500 total\n...\nPID    %CPU MEM    COMMAND\n1      9.9  1M     first-sample\n\nPID    %CPU MEM    COMMAND
4242   7.4  6816K+ top
606    33.3 686M+  WindowServer
0      10.1 11M+   kernel_task
32689  8.7  1.2G   Electron Helper
32691  6.4  95M-   Electron Helper
36421  5.4  512B   tiny
99     1.0  weird  oddmem
98     0.5  1T     huge
not a row`

beforeEach(() => {
  h.replies.clear()
  h.si.currentLoad.mockResolvedValue({ currentLoad: 12.345, cpus: [{ load: 150 }, { load: -3 }] })
  h.si.mem.mockResolvedValue({ total: 16e9, active: 8e9, used: 15e9 })
  h.si.fsSize.mockResolvedValue([
    { mount: '/', use: 18.4, used: 1 },
    { mount: '/System/Volumes/Data', use: 87.08, used: 400 },
    { mount: '/x', use: 1, used: undefined }
  ])
  h.si.networkStats.mockResolvedValue([{ rx_sec: 2_000_000, tx_sec: null }, { rx_sec: undefined, tx_sec: 500_000 }])
  h.si.battery.mockResolvedValue({ percent: 95, isCharging: false, hasBattery: true })
  h.si.processes.mockResolvedValue({
    list: [
      { pid: 1, name: 'a', cpu: 5, memRss: 2048 },
      { pid: 2, name: 'b', cpu: 50, memRss: undefined },
      { pid: 3, name: 'c', cpu: -1, memRss: 1024 }
    ]
  })
  h.si.time.mockReturnValue({ uptime: 1234 })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
  vi.useRealTimers()
})

describe('collect (generic platforms)', () => {
  it('builds a snapshot from systeminformation, clamped and rounded', async () => {
    const c = await load('linux')
    const snap = await c.collect([{ pid: 1, name: 'x', cpu: 1, mem: 1 }])
    expect(snap).toMatchObject({
      cpu: { total: 12.3, cores: [100, 0] },
      mem: { usedPct: 50, usedGb: 8, totalGb: 16 },
      disk: { usedPct: 87.1, mount: '/System/Volumes/Data' },
      net: { rxMbps: 2, txMbps: 0.5 },
      battery: { pct: 95, charging: false, hasBattery: true },
      uptimeSec: 1234,
      processes: [{ pid: 1 }]
    })
  })

  it('falls back sensibly on sparse data', async () => {
    const c = await load('linux')
    vi.useFakeTimers({ toFake: ['Date'] })
    h.si.mem.mockResolvedValue({ total: 10e9, active: 0, used: 5e9 })
    h.si.fsSize.mockResolvedValue([])
    h.si.battery.mockResolvedValue({ percent: undefined, isCharging: undefined, hasBattery: undefined })
    h.si.time.mockReturnValue({ uptime: undefined })
    const snap = await c.collect([])
    expect(snap.mem.usedPct).toBe(50)
    expect(snap.disk).toEqual({ usedPct: 0, mount: '/' })
    expect(snap.battery).toEqual({ pct: 0, charging: false, hasBattery: false })
    expect(snap.uptimeSec).toBe(0)

    h.si.fsSize.mockResolvedValue([{ mount: '/a', use: 5, used: undefined }, { mount: '/b', use: 9, used: 2 }])
    vi.advanceTimersByTime(31_000) // disk usage is cached for 30 s
    expect((await c.collect([])).disk).toEqual({ usedPct: 9, mount: '/b' })
  })

  it('reads disk every 30 s and battery every 60 s, not every tick', async () => {
    const c = await load('linux')
    vi.useFakeTimers({ toFake: ['Date'] })
    await c.collect([])
    await c.collect([])
    expect(h.si.fsSize).toHaveBeenCalledTimes(1)
    expect(h.si.battery).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(31_000)
    await c.collect([])
    expect(h.si.fsSize).toHaveBeenCalledTimes(2)
    expect(h.si.battery).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(31_000)
    await c.collect([])
    expect(h.si.battery).toHaveBeenCalledTimes(2)
  })

  it('has no background sampler to start or stop', async () => {
    const c = await load('linux')
    c.startSampling()
    c.stopSampling()
    expect(h.sampler.start).not.toHaveBeenCalled()
    expect(h.sampler.stop).not.toHaveBeenCalled()
  })

  it('lists the top processes by CPU via systeminformation', async () => {
    const c = await load('linux')
    expect(await c.collectProcesses()).toEqual([
      { pid: 2, name: 'b', cpu: 50, mem: 0 },
      { pid: 1, name: 'a', cpu: 5, mem: 2 },
      { pid: 3, name: 'c', cpu: 0, mem: 1 }
    ])
  })
})

describe('macOS specifics', () => {
  it('uses Finder-style disk capacity, caches it for 30 s, and falls back on bad data', async () => {
    const c = await load('darwin')
    vi.useFakeTimers({ toFake: ['Date'] })
    h.replies.set('osascript', JSON.stringify([494e9, 110e9]))
    expect((await c.collect([])).disk).toEqual({ usedPct: 77.7, mount: '/' })

    h.replies.set('osascript', JSON.stringify([494e9, 0]))
    expect((await c.collect([])).disk.usedPct).toBe(77.7) // cached
    vi.advanceTimersByTime(31_000)
    expect((await c.collect([])).disk.usedPct).toBe(100)

    vi.advanceTimersByTime(31_000)
    h.replies.set('osascript', JSON.stringify([0, 5]))
    expect((await c.collect([])).disk).toEqual({ usedPct: 87.1, mount: '/System/Volumes/Data' })
    vi.advanceTimersByTime(31_000)
    h.replies.set('osascript', JSON.stringify([10, -1]))
    expect((await c.collect([])).disk.mount).toBe('/System/Volumes/Data')
  })

  it('reads processes like Activity Monitor: second top sample, ps names, footprint', async () => {
    const c = await load('darwin')
    h.replies.set('top', TOP)
    h.replies.set('ps', '  606 /System/Library/WindowServer\n32689 /Apps/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)\n36421 tiny\njunk')
    expect(await c.collectProcesses()).toEqual([
      { pid: 606, name: 'WindowServer', cpu: 33.3, mem: 686 },
      { pid: 0, name: 'kernel_task', cpu: 10.1, mem: 11 }, // no ps row → top's name
      { pid: 32689, name: 'Electron Helper (GPU)', cpu: 8.7, mem: 1229 },
      { pid: 32691, name: 'Electron Helper', cpu: 6.4, mem: 95 },
      { pid: 36421, name: 'tiny', cpu: 5.4, mem: 0 },
      { pid: 99, name: 'oddmem', cpu: 1, mem: 0 }
    ])
  })

  it('handles unit-less memory and the terabyte unit', async () => {
    const c = await load('darwin')
    h.replies.set('top', 'PID %CPU MEM COMMAND\n5 1.0 2048 noUnit\n6 0.1 1T big')
    h.replies.set('ps', '')
    expect((await c.collectProcesses()).map((p) => p.mem)).toEqual([0, 1048576])
  })

  it('falls back to systeminformation when top yields nothing or fails', async () => {
    const c = await load('darwin')
    h.replies.set('top', 'PID %CPU MEM COMMAND\n')
    expect((await c.collectProcesses())[0].pid).toBe(2)
    h.replies.set('top', new Error('top missing'))
    expect((await c.collectProcesses())[0].pid).toBe(2)
  })
})

describe('Windows specifics', () => {
  const systemDrive = process.env.SystemDrive
  afterEach(() => {
    h.sampler.running = false
    if (systemDrive === undefined) delete process.env.SystemDrive
    else process.env.SystemDrive = systemDrive
  })

  it('reads memory and disk without PowerShell, network from the sampler', async () => {
    const c = await load('win32')
    process.env.SystemDrive = 'D:'
    h.statfs.mockResolvedValue({ blocks: 1000, bfree: 250 })
    const snap = await c.collect([])
    expect(h.statfs).toHaveBeenCalledWith('D:\\')
    expect(snap).toMatchObject({
      mem: { usedPct: 75, usedGb: 12, totalGb: 16 },
      disk: { usedPct: 75, mount: 'D:' },
      net: { rxMbps: 1.5, txMbps: 0.2 },
      battery: { pct: 95 }
    })
    expect(h.si.mem).not.toHaveBeenCalled()
    expect(h.si.fsSize).not.toHaveBeenCalled()
    expect(h.si.networkStats).not.toHaveBeenCalled()
  })

  it('defaults to C: and survives an empty volume', async () => {
    const c = await load('win32')
    delete process.env.SystemDrive
    h.statfs.mockResolvedValue({ blocks: 0, bfree: 0 })
    expect((await c.collect([])).disk).toEqual({ usedPct: 0, mount: 'C:' })
  })

  it('starts and stops the sampler, and takes its process list while it runs', async () => {
    const c = await load('win32')
    c.startSampling()
    expect(h.sampler.start).toHaveBeenCalledTimes(1)
    c.stopSampling()
    expect(h.sampler.stop).toHaveBeenCalledTimes(1)

    expect((await c.collectProcesses())[0].pid).toBe(2) // not running → one systeminformation scan
    h.sampler.running = true
    expect(await c.collectProcesses()).toEqual([{ pid: 7, name: 'Code', cpu: 3, mem: 300 }])
  })
})

describe('currentUser', () => {
  it('macOS: full name from id -F', async () => {
    const c = await load('darwin')
    h.replies.set('id', 'Robin Hinkelmann\n')
    expect(await c.currentUser()).toEqual({ name: 'Robin Hinkelmann', firstName: 'Robin' })
  })

  it('Linux: GECOS field from getent, tolerating short entries', async () => {
    const c = await load('linux')
    h.replies.set('getent', 'robin:x:1000:1000:Robin H,,,:/home/robin:/bin/bash\n')
    expect(await c.currentUser()).toEqual({ name: 'Robin H', firstName: 'Robin' })
    h.replies.set('getent', 'robin:x:1000')
    expect((await c.currentUser()).name).toBe('robin')
  })

  it('falls back to the login (capitalized) on other platforms or errors', async () => {
    const c = await load('win32')
    expect(await c.currentUser()).toEqual({ name: 'robin', firstName: 'Robin' })
    const mac = await load('darwin')
    h.replies.set('id', new Error('no id'))
    h.username = 'jane.doe'
    expect(await mac.currentUser()).toEqual({ name: 'jane.doe', firstName: 'Jane' })
    h.username = '_svc'
    expect(await mac.currentUser()).toEqual({ name: '_svc', firstName: '_svc' })
    h.username = 'robin'
  })
})
