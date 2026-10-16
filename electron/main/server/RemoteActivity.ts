import { CHANNEL_ACCESS, type IpcChannel } from '@shared/ipc/contract'
import type { BrowserRemoteUse } from '@shared/types/browser'
import type { DeviceActivity } from '@shared/types/events'
import type { CallContext } from '../../ipc/router'

/** How long after a device's last browser call the desktop still shows it as using the browser. */
export const IN_USE_MS = 45_000
/** Pictures and taps of one page are logged once per this long — not each of them. */
export const REPEAT_MS = 60_000
/** Paths a batch names in the log (the count says how many there were). */
const LOGGED_PATHS = 20

export interface RemoteActivityDeps {
  /** The paired devices (for their names). */
  devices: () => Promise<{ id: string; name: string }[]>
  /** Into the audit log. */
  log: (type: 'device.browser' | 'device.files', deviceId: string, payload: DeviceActivity) => void
  /** The devices using the browser now, the newest first (the desktop shows them). */
  inUse: (devices: BrowserRemoteUse[]) => void
  /** A browser tab by id (undefined: none). */
  browserTab: (id: string) => { url: string } | undefined
  /** The web page typed text leads to (undefined: none). */
  webUrl: (input: string) => string | undefined
  now?: () => number
}

type Payload = Record<string, unknown>

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).hostname || undefined
  } catch {
    return undefined
  }
}

/** A batch of paths for the log: the first few and how many. */
function batch(paths: string[]): Pick<DeviceActivity, 'paths' | 'count'> {
  return { paths: paths.slice(0, LOGGED_PATHS), count: paths.length }
}

/**
 * What paired devices do with the desktop's browser and files: an audit
 * entry per action (`device.browser`, `device.files` — where, never what was
 * typed; pictures and taps of a page once a minute), and the desktop's sign
 * that a device uses its browser (until 45 s after its last call, or at once
 * when the desktop stops it).
 */
export class RemoteActivity {
  private readonly using = new Map<string, { use: BrowserRemoteUse; timer: ReturnType<typeof setTimeout> }>()
  private readonly repeats = new Map<string, number>()
  private readonly now: () => number

  constructor(private readonly deps: RemoteActivityDeps) {
    this.now = deps.now ?? Date.now
  }

  /** The Router's observer: a remote call that went through. */
  observe(channel: IpcChannel, payload: unknown, data: unknown, ctx: CallContext): void {
    const deviceId = ctx.deviceId
    if (ctx.transport !== 'remote' || !deviceId) return
    const p = (payload ?? {}) as Payload
    if (CHANNEL_ACCESS[channel] === 'browser') {
      this.touch(deviceId)
      const entry = this.browserEntry(deviceId, channel, p)
      if (entry) void this.record('device.browser', deviceId, entry)
    } else if (channel.startsWith('finder:')) {
      const entry = this.filesEntry(channel, p, data)
      if (entry) void this.record('device.files', deviceId, entry)
    }
  }

  /** The device no longer uses the browser (sharing stopped, device removed): its sign goes at once. */
  release(deviceId: string): void {
    const known = this.using.get(deviceId)
    if (!known) return
    clearTimeout(known.timer)
    this.using.delete(deviceId)
    this.publish()
  }

  dispose(): void {
    for (const { timer } of this.using.values()) clearTimeout(timer)
    this.using.clear()
  }

  private touch(deviceId: string): void {
    const known = this.using.get(deviceId)
    if (known) {
      clearTimeout(known.timer)
      known.timer = this.expire(deviceId)
      return
    }
    const use = { deviceId, device: '', since: new Date(this.now()).toISOString() }
    this.using.set(deviceId, { use, timer: this.expire(deviceId) })
    void this.deviceName(deviceId).then((name) => {
      if (this.using.get(deviceId)?.use !== use) return
      use.device = name
      this.publish()
    })
  }

  private expire(deviceId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.release(deviceId), IN_USE_MS)
    timer.unref()
    return timer
  }

  private publish(): void {
    const shown = [...this.using.values()].map((u) => u.use).filter((u) => u.device)
    this.deps.inUse(shown.sort((a, b) => b.since.localeCompare(a.since)).map((u) => ({ ...u })))
  }

  private browserEntry(deviceId: string, channel: IpcChannel, p: Payload): Omit<DeviceActivity, 'device'> | undefined {
    switch (channel) {
      case 'browser:capture':
      case 'browser:input': {
        const action = channel === 'browser:capture' ? 'view' : 'input'
        const host = hostOf(this.deps.browserTab(p.id as string)?.url)
        return this.once(`${deviceId}:${action}:${p.id as string}:${host ?? ''}`) ? { action, host } : undefined
      }
      case 'browser:open':
        return { action: 'open', host: typeof p.url === 'string' ? hostOf(this.deps.webUrl(p.url)) : undefined }
      case 'browser:navigate':
        return { action: 'navigate', host: hostOf(this.deps.webUrl(p.input as string)) }
      case 'browser:close':
        return { action: 'close' }
      case 'browser:bookmarkAdd':
        return { action: 'bookmark', host: hostOf(p.url as string | undefined) }
      default:
        return undefined
    }
  }

  private filesEntry(channel: IpcChannel, p: Payload, data: unknown): Omit<DeviceActivity, 'device'> | undefined {
    switch (channel) {
      case 'finder:read':
        return p.offset ? undefined : { action: 'download', path: p.path as string }
      case 'finder:write':
        return p.offset ? undefined : { action: 'upload', path: p.path as string }
      case 'finder:mkdir':
        return { action: 'mkdir', path: data as string }
      case 'finder:rename':
        return { action: 'rename', path: p.path as string, dest: data as string }
      case 'finder:trash':
        return { action: 'trash', ...batch(p.paths as string[]) }
      case 'finder:untrash':
        return { action: 'restore', ...batch((p.items as { restore: string }[]).map((i) => i.restore)) }
      case 'finder:move':
      case 'finder:copy':
        return { action: channel === 'finder:move' ? 'move' : 'copy', ...batch(p.paths as string[]), dest: p.dest as string }
      case 'finder:transfer':
        return { action: p.mode as string, ...batch(p.paths as string[]), dest: p.dest as string }
      case 'finder:restore':
        return { action: 'undo', count: (p.moves as unknown[]).length }
      case 'finder:compress':
        return { action: 'compress', ...batch(p.paths as string[]), dest: data as string }
      case 'finder:extract':
        return { action: 'extract', path: p.path as string, dest: data as string }
      default:
        return undefined
    }
  }

  /** True the first time per `key` and minute. */
  private once(key: string): boolean {
    const at = this.now()
    const last = this.repeats.get(key)
    if (last !== undefined && at - last < REPEAT_MS) return false
    if (this.repeats.size > 1000) this.repeats.clear()
    this.repeats.set(key, at)
    return true
  }

  /** A device's name — its id when it is not known (any more). */
  private async deviceName(id: string): Promise<string> {
    const devices = await this.deps.devices().catch(() => [])
    return devices.find((d) => d.id === id)?.name ?? id
  }

  private async record(type: 'device.browser' | 'device.files', deviceId: string, entry: Omit<DeviceActivity, 'device'>): Promise<void> {
    const device = await this.deviceName(deviceId)
    const payload = Object.fromEntries(Object.entries({ device, ...entry }).filter(([, v]) => v !== undefined)) as unknown as DeviceActivity
    this.deps.log(type, deviceId, payload)
  }
}
