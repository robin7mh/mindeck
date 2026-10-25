import type { IpcChannel, IpcEvent } from '@shared/ipc/contract'
import { ALL_PROJECTS, type AgentRun, type ConversationSummary, type PermissionGrant, type PermissionRequest } from '@shared/types/ai'
import type { AgentSession } from '@shared/types/agents'
import type { FinderEntry, FinderListing } from '@shared/types/finder'
import type { MindeckEvent } from '@shared/types/events'
import type { LiveServerStatus } from '@shared/types/live'
import type { RemoteAccess } from './RemoteAccess'

/** How long a project's verdict is reused for events (a stream of deltas asks again and again). */
const VERDICT_MS = 2000

export interface RemoteScopeDeps {
  access: Pick<RemoteAccess, 'check' | 'project' | 'denied'>
  /** The project an agent session works in (undefined: no such session). */
  sessionProject: (id: string) => string | undefined
  /** The project an assistant conversation belongs to (undefined: none, or no such conversation). */
  conversationProject: (id: string) => Promise<string | undefined>
  /** The approvals waiting now. */
  pending: () => PermissionRequest[]
  now?: () => number
}

type Payload = Record<string, unknown>

/** The desktop's audit of what devices did — not for other devices to read. */
const isDeviceEvent = (e: MindeckEvent) => e.type?.startsWith('device.') === true

/**
 * What a paired device sees of the core's activity: agent sessions,
 * assistant conversations, approvals, the activity log and per-project
 * events belong to a project — and are the device's only when RemoteAccess
 * lets it use that project (§3.1: the shared folders, never the home folder,
 * system folders or Mindeck's data). Calls that name a session, a
 * conversation or an approval by id are checked like calls naming the
 * project (`check`), lists are trimmed (`result`), and push events dropped or
 * trimmed (`event`). Things outside any project (a chat without one) stay
 * visible.
 */
export class RemoteScope {
  private readonly verdicts = new Map<string, { ok: boolean; at: number }>()
  private readonly now: () => number

  constructor(private readonly deps: RemoteScopeDeps) {
    this.now = deps.now ?? Date.now
  }

  /** The Router's guard for remote calls: RemoteAccess's rules, then the session, conversation or approval a call names. */
  async guard(channel: IpcChannel, payload: unknown): Promise<void> {
    await this.deps.access.check(channel, payload)
    await this.check(channel, payload)
  }

  /** The session, conversation or approval a call names: allowed when its project is. */
  async check(channel: IpcChannel, payload: unknown): Promise<void> {
    const p = (payload ?? {}) as Payload
    const id = typeof p.id === 'string' ? p.id : undefined
    if (channel.startsWith('agents:') && id) return this.require(this.deps.sessionProject(id))
    if ((channel === 'ai:conversation' || channel === 'ai:deleteConversation') && id) return this.require(await this.deps.conversationProject(id))
    if ((channel === 'ai:send' || channel === 'ai:cancel') && typeof p.conversationId === 'string') {
      return this.require(await this.conversation(p.conversationId))
    }
    if (channel === 'permission:respond' && id) {
      const request = this.deps.pending().find((r) => r.id === id)
      if (request) return this.require(await this.requestProject(request))
    }
  }

  /** A remote call's answer: lists without what belongs to projects the device may not use. */
  async result(channel: IpcChannel, data: unknown): Promise<unknown> {
    switch (channel) {
      case 'agents:list':
        return this.keep(data as AgentSession[], (s) => s.projectId)
      case 'ai:conversations':
        return this.keep(data as ConversationSummary[], (c) => c.projectId)
      case 'ai:runs':
        return this.keep(data as AgentRun[], (r) => r.projectId)
      case 'permission:pending':
        return this.keep(data as PermissionRequest[], (r) => this.requestProject(r))
      case 'permission:grants':
        return this.keep(data as PermissionGrant[], (g) => (g.projectId === ALL_PROJECTS ? undefined : g.projectId))
      case 'events:recent':
        return this.keep((data as MindeckEvent[]).filter((e) => !isDeviceEvent(e)), (e) => this.eventProject(e))
      case 'liveServer:status':
        return this.keep(data as LiveServerStatus[], (s) => s.projectId)
      case 'finder:list': {
        const listing = data as FinderListing
        const entries = listing.entries.filter((e) => this.visibleFile(e))
        return { ...listing, entries, total: listing.total - (listing.entries.length - entries.length) }
      }
      case 'finder:search':
        return (data as FinderEntry[]).filter((e) => this.visibleFile(e))
      default:
        return data
    }
  }

  /** A push event for paired devices: as it is, trimmed, or null (none of theirs). */
  async event(channel: IpcEvent, payload: unknown): Promise<unknown> {
    const p = payload as Payload
    switch (channel) {
      case 'context:progress':
      case 'lsp:diagnostics':
      case 'sftp:progress':
      case 'tests:changed':
        return this.only(p, p.projectId as string)
      case 'liveServer:changed':
        return this.keep(payload as LiveServerStatus[], (s) => s.projectId)
      case 'agents:changed':
        return p.session ? this.only(p, (p.session as AgentSession).projectId) : p
      case 'agents:message':
        return this.only(p, this.deps.sessionProject(p.sessionId as string))
      case 'ai:delta':
      case 'ai:message':
        return this.only(p, await this.conversation(p.conversationId as string))
      case 'ai:conversationsChanged':
        return this.only(p, await this.conversation(p.id as string))
      case 'permission:request':
        return this.only(p, await this.requestProject(payload as PermissionRequest))
      case 'events:event':
        if (isDeviceEvent(payload as MindeckEvent)) return null
        return this.only(p, await this.eventProject(payload as MindeckEvent))
      default:
        return payload
    }
  }

  /** A file a device's Files lists: not hidden, not a key or credential. */
  private visibleFile(e: FinderEntry): boolean {
    return !e.hidden && !this.deps.access.denied(e.path)
  }

  /** Whether devices may see what belongs to `projectId` (nothing to see: yes). Verdicts are kept a moment. */
  async allows(projectId: string | undefined): Promise<boolean> {
    if (!projectId) return true
    const known = this.verdicts.get(projectId)
    if (known && this.now() - known.at < VERDICT_MS) return known.ok
    const ok = await this.deps.access.project(projectId).then(
      () => true,
      () => false
    )
    if (this.verdicts.size > 500) this.verdicts.clear()
    this.verdicts.set(projectId, { ok, at: this.now() })
    return ok
  }

  private async require(projectId: string | undefined): Promise<void> {
    if (projectId) await this.deps.access.project(projectId)
  }

  private async only(payload: unknown, projectId: string | undefined): Promise<unknown> {
    return (await this.allows(projectId)) ? payload : null
  }

  private async keep<T>(items: T[], projectOf: (item: T) => string | undefined | Promise<string | undefined>): Promise<T[]> {
    const ok = await Promise.all(items.map(async (item) => this.allows(await projectOf(item))))
    return items.filter((_, i) => ok[i])
  }

  /** An agent session's id is its conversation's too (its approvals and events carry it). */
  private async conversation(id: string): Promise<string | undefined> {
    return this.deps.sessionProject(id) ?? (await this.deps.conversationProject(id))
  }

  private async requestProject(r: PermissionRequest): Promise<string | undefined> {
    return r.projectId ?? (await this.conversation(r.conversationId))
  }

  private async eventProject(e: MindeckEvent): Promise<string | undefined> {
    return e.projectId ?? (e.conversationId ? await this.conversation(e.conversationId) : undefined)
  }
}
