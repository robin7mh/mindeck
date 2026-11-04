import type { IpcChannel } from '@shared/ipc/contract'
import { isLicenseFree } from '@shared/types/cloud'
import type { DeviceActivity } from '@shared/types/events'
import type { CallContext } from '../../ipc/router'

/** Paths a batch names in the log (the count says how many there were). */
const LOGGED_PATHS = 20

/**
 * What clients ask by themselves: a tab or an app that is merely open keeps
 * doing it, and an agent at work sets it off. None of it says anyone is there
 * — the trial clock must not run on it: the editor's look at the disk and git
 * every few seconds, a session's changes every minute, what follows a push or
 * a reconnect, and an open file the agent changed (reloaded, parsed, linted).
 */
const BY_ITSELF: ReadonlySet<IpcChannel> = new Set<IpcChannel>([
  'agents:branch',
  'agents:changes',
  'agents:detect',
  'agents:get',
  'agents:list',
  'agents:pushSettings',
  'ai:agents',
  'ai:conversation',
  'ai:conversations',
  'ai:runs',
  'ai:status',
  'ai:tools',
  'editor:settings',
  'events:recent',
  'files:read',
  'files:stat',
  'lint:file',
  'liveServer:status',
  'lsp:change',
  'lsp:close',
  'lsp:diagnostics',
  'lsp:open',
  'memory:folders',
  'memory:graph',
  'memory:list',
  'memory:read',
  'memory:status',
  'permission:grants',
  'permission:pending',
  'projects:list',
  'scm:blame',
  'scm:branches',
  'scm:original',
  'scm:stashes',
  'scm:status',
  'server:devices',
  'server:status',
  'sftp:targets',
  'system:snapshot',
  'system:user',
  'terminal:attach',
  'terminal:list',
  'terminal:resize',
  'terminal:settings',
  'terminal:shells',
  'tests:state',
  'tools:runtimes',
  'tools:status'
])

export interface RemoteActivityDeps {
  /** The paired devices (for their names). */
  devices: () => Promise<{ id: string; name: string }[]>
  /** Into the audit log. */
  log: (type: 'device.files', deviceId: string, payload: DeviceActivity) => void
  /** Someone did something on a device, under the license (the trial clock's signal). */
  used: () => void
}

type Payload = Record<string, unknown>

/** A batch of paths for the log: the first few and how many. */
function batch(paths: string[]): Pick<DeviceActivity, 'paths' | 'count'> {
  return { paths: paths.slice(0, LOGGED_PATHS), count: paths.length }
}

/**
 * What paired devices do: with the computer's files an audit entry per action
 * (`device.files` — which file and where, never its content), shown on the
 * desktop only; with anything under the license a sign that someone is there.
 */
export class RemoteActivity {
  constructor(private readonly deps: RemoteActivityDeps) {}

  /** The Router's observer: a remote call that went through. */
  observe(channel: IpcChannel, payload: unknown, data: unknown, ctx: CallContext): void {
    const deviceId = ctx.deviceId
    if (ctx.transport !== 'remote' || !deviceId) return
    if (!isLicenseFree(channel) && !BY_ITSELF.has(channel)) this.deps.used()
    if (!channel.startsWith('finder:')) return
    const entry = this.filesEntry(channel, (payload ?? {}) as Payload, data)
    if (entry) void this.record(deviceId, entry)
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

  /** A device's name — its id when it is not known (any more). */
  private async deviceName(id: string): Promise<string> {
    const devices = await this.deps.devices().catch(() => [])
    return devices.find((d) => d.id === id)?.name ?? id
  }

  private async record(deviceId: string, entry: Omit<DeviceActivity, 'device'>): Promise<void> {
    const device = await this.deviceName(deviceId)
    const payload = Object.fromEntries(Object.entries({ device, ...entry }).filter(([, v]) => v !== undefined)) as unknown as DeviceActivity
    this.deps.log('device.files', deviceId, payload)
  }
}
