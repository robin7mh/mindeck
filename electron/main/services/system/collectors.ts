import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import { freemem, totalmem, userInfo } from 'node:os'
import { promisify } from 'node:util'
import si from 'systeminformation'
import type { ProcessInfo, SystemSnapshot } from '@shared/types/system'
import { TOP_N, WinSampler } from './winSampler'

const run = promisify(execFile)
const isMac = process.platform === 'darwin'
// On Windows systeminformation spawns a PowerShell per call — keep it off the tick.
const isWin = process.platform === 'win32'
const winSampler = new WinSampler()

const r1 = (n: number) => Math.round(n * 10) / 10
const clampPct = (n: number) => Math.max(0, Math.min(100, n))

/** Disk usage and battery change slowly; sampling them every tick only costs CPU. */
const DISK_TTL_MS = 30_000
const BATTERY_TTL_MS = 60_000

function cached<T>(ttlMs: number, load: () => Promise<T>): () => Promise<T> {
  let hit: { value: T; at: number } | undefined
  return async () => {
    if (hit && Date.now() - hit.at < ttlMs) return hit.value
    const value = await load()
    hit = { value, at: Date.now() }
    return value
  }
}

/** Start the background sampler (Windows) — idempotent, restarts it if it died. */
export function startSampling(): void {
  if (isWin) winSampler.start()
}

export function stopSampling(): void {
  if (isWin) winSampler.stop()
}

async function cpu(): Promise<SystemSnapshot['cpu']> {
  const load = await si.currentLoad()
  return {
    total: clampPct(r1(load.currentLoad)),
    cores: load.cpus.map((c) => clampPct(r1(c.load)))
  }
}

async function mem(): Promise<SystemSnapshot['mem']> {
  if (isWin) {
    // Free physical memory = Task Manager's "available".
    const total = totalmem()
    const used = total - freemem()
    return { usedPct: clampPct(r1((used / total) * 100)), usedGb: r1(used / 1e9), totalGb: r1(total / 1e9) }
  }
  const m = await si.mem()
  // `active` excludes cache/buffers → closest to what Activity Monitor shows.
  const used = m.active || m.used
  return {
    usedPct: clampPct(r1((used / m.total) * 100)),
    usedGb: r1(used / 1e9),
    totalGb: r1(m.total / 1e9)
  }
}

// Finder and System Settings count purgeable space as available ("important
// usage" capacity); statfs/df don't, which overstates usage by up to ~10 pp.
// Only Foundation exposes that number, hence the JXA one-liner.
const MAC_DISK_JXA =
  'ObjC.import("Foundation");const u=$.NSURL.fileURLWithPath("/");' +
  'const v=k=>{const r=Ref();u.getResourceValueForKeyError(r,$(k),null);return ObjC.unwrap(r[0])};' +
  'JSON.stringify([v("NSURLVolumeTotalCapacityKey"),v("NSURLVolumeAvailableCapacityForImportantUsageKey")])'
async function macDiskUsedPct(): Promise<number> {
  const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', MAC_DISK_JXA], { timeout: 5000 })
  const [total, avail] = JSON.parse(stdout) as [number, number]
  if (!(total > 0) || !(avail >= 0)) throw new Error('volume capacity unavailable')
  return clampPct(r1(((total - avail) / total) * 100))
}

/** The system drive, like Explorer: used = total − free. */
async function winDisk(): Promise<SystemSnapshot['disk']> {
  const mount = process.env.SystemDrive || 'C:'
  const s = await statfs(`${mount}\\`)
  return { usedPct: s.blocks > 0 ? clampPct(r1(((s.blocks - s.bfree) / s.blocks) * 100)) : 0, mount }
}

const disk = cached(DISK_TTL_MS, async (): Promise<SystemSnapshot['disk']> => {
  if (isWin) return winDisk()
  if (isMac) {
    try {
      return { usedPct: await macDiskUsedPct(), mount: '/' }
    } catch {
      /* fall through to the generic volume scan */
    }
  }
  const list = await si.fsSize()
  // The volume actually holding the most data (on macOS `/` is the tiny
  // read-only system snapshot; the Data volume is where usage lives).
  const primary = list.length
    ? list.reduce((a, b) => ((b.used ?? 0) > (a.used ?? 0) ? b : a))
    : undefined
  return { usedPct: clampPct(r1(primary?.use ?? 0)), mount: primary?.mount ?? '/' }
})

async function net(): Promise<SystemSnapshot['net']> {
  if (isWin) return winSampler.net
  const stats = await si.networkStats()
  const agg = stats.reduce(
    (a, n) => ({ rx: a.rx + (n.rx_sec || 0), tx: a.tx + (n.tx_sec || 0) }),
    { rx: 0, tx: 0 }
  )
  return { rxMbps: r1(agg.rx / 1e6), txMbps: r1(agg.tx / 1e6) }
}

const battery = cached(BATTERY_TTL_MS, async (): Promise<SystemSnapshot['battery']> => {
  const b = await si.battery()
  return { pct: clampPct(b.percent ?? 0), charging: !!b.isCharging, hasBattery: !!b.hasBattery }
})

/** The OS account's display name (macOS full name, Linux GECOS), else the login. */
export async function currentUser(): Promise<{ name: string; firstName: string }> {
  const login = userInfo().username
  let name = ''
  try {
    if (isMac) name = (await run('id', ['-F'], { timeout: 2000 })).stdout.trim()
    else if (process.platform === 'linux') {
      const { stdout } = await run('getent', ['passwd', login], { timeout: 2000 })
      name = (stdout.split(':')[4] ?? '').split(',')[0].trim()
    }
  } catch {
    /* fall back to the login name */
  }
  name ||= login
  const first = name.split(/[\s._-]+/)[0] || name
  return { name, firstName: first.charAt(0).toUpperCase() + first.slice(1) }
}

const MB_PER_UNIT: Record<string, number> = { B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024, T: 1048576 }

/** top's MEM column, e.g. "686M+", "1824K", "1.2G" → MB. */
function parseTopMem(raw: string): number {
  const m = /^([\d.]+)([BKMGT])?/.exec(raw)
  return m ? Math.round(parseFloat(m[1]) * MB_PER_UNIT[m[2] ?? 'B']) : 0
}

/**
 * Matches Activity Monitor: `ps` reports a decaying CPU average and RSS, while
 * the second `top` sample gives instantaneous %CPU and the physical footprint.
 * top truncates names to 16 chars, so full names come from `ps`.
 */
async function macProcesses(): Promise<ProcessInfo[]> {
  const pending = run(
    'top',
    ['-l', '2', '-s', '1', '-o', 'cpu', '-n', String(TOP_N + 1), '-stats', 'pid,cpu,mem,command'],
    { timeout: 5000 }
  )
  const selfPid = pending.child.pid
  const { stdout } = await pending
  const rows = stdout
    .slice(stdout.lastIndexOf('PID'))
    .split('\n')
    .slice(1)
    .map((l) => /^\s*(\d+)\s+([\d.]+)\s+(\S+)\s+(.+?)\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null && Number(m[1]) !== selfPid)
    .map((m) => [m[1], m[2], m[3], m[4]] as const)
    .slice(0, TOP_N)
  if (rows.length === 0) throw new Error('top returned no rows')

  const pids = rows.map((c) => c[0])
  const { stdout: psOut } = await run('ps', ['-o', 'pid=,comm=', '-p', pids.join(',')], { timeout: 2000 })
  const names = new Map<string, string>()
  for (const line of psOut.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (m) names.set(m[1], m[2].slice(m[2].lastIndexOf('/') + 1)) // basename of the binary path
  }

  return rows.map(([pid, cpuPct, memRaw, topName]) => ({
    pid: Number(pid),
    name: names.get(pid) ?? topName, // ps has no row for kernel_task (pid 0)
    cpu: Math.max(0, r1(parseFloat(cpuPct))), // per core, may exceed 100 like Activity Monitor
    mem: parseTopMem(memRaw)
  }))
}

async function genericProcesses(): Promise<ProcessInfo[]> {
  const p = await si.processes()
  return p.list
    .slice()
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, TOP_N)
    .map((x) => ({
      pid: x.pid,
      name: x.name,
      cpu: Math.max(0, r1(x.cpu)),
      mem: Math.round((x.memRss ?? 0) / 1024) // KB → MB
    }))
}

/** Top processes by CPU. Slow on macOS (~1 s, two top samples) — run off the tick. */
export async function collectProcesses(): Promise<ProcessInfo[]> {
  // The sampler's list is free; one-off calls without it (AI tool) scan once.
  if (isWin && winSampler.running) return winSampler.procs
  if (isMac) {
    try {
      return await macProcesses()
    } catch {
      /* fall back to the ps-based scan */
    }
  }
  return genericProcesses()
}

/** Collect one snapshot of the cheap metrics, carrying the latest process list. */
export async function collect(procs: ProcessInfo[]): Promise<SystemSnapshot> {
  const [c, m, d, n, b] = await Promise.all([cpu(), mem(), disk(), net(), battery()])
  return {
    cpu: c,
    mem: m,
    disk: d,
    net: n,
    battery: b,
    uptimeSec: si.time().uptime ?? 0,
    processes: procs,
    ts: Date.now()
  }
}
