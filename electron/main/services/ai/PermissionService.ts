import { randomUUID } from 'node:crypto'
import { ALL_PROJECTS, type ApprovalDecision, type PermissionGrant, type PermissionRequest } from '@shared/types/ai'
import type { EventBus } from '../events/EventBus'
import { readJson } from '../../lib/jsonFile'
import { writeAtomic } from '../../lib/writeAtomic'

const APPROVAL_TIMEOUT_MS = 10 * 60_000
/** How long an answer counts for an agent's own approval of the same Mindeck tool. */
const RECENT_MS = 60_000
const GRANTS_VERSION = 2
/** Agents whose grants were keyed by a tool call's changing title before version 2 — they never matched again. */
const TITLE_KEYED = new Set(['codex', 'gemini'])

export interface PermissionDeps {
  file: string
  events: EventBus
  /** Push to every client: a request appeared / was answered. */
  onRequest: (req: PermissionRequest) => void
  onResolved: (res: { id: string; decision: ApprovalDecision }) => void
  timeoutMs?: number
}

/** A paired device answering (not the desktop window), and whether remote shells are allowed. */
export interface RemoteResponder {
  deviceId?: string
  shells: boolean
}

interface Pending {
  request: PermissionRequest
  settle: (d: ApprovalDecision) => void
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** A grant holds for the request's project — or everywhere (grants from before version 2). */
const holds = (g: PermissionGrant, agentId: string, toolName: string, projectId?: string) =>
  g.agentId === agentId && g.toolName === toolName && (g.projectId === ALL_PROJECTS || g.projectId === projectId)

/**
 * Version 1 grants were global: kept as `ALL_PROJECTS` (the user chose them,
 * Settings shows them, one click revokes them) — except Codex's and Gemini's,
 * whose keys were per-call titles that never matched again.
 */
function migrate(parsed: { version?: number; grants?: unknown }): PermissionGrant[] {
  const grants = Array.isArray(parsed.grants) ? (parsed.grants as PermissionGrant[]) : []
  if (parsed.version === GRANTS_VERSION) return grants
  return grants.filter((g) => !TITLE_KEYED.has(g.agentId)).map((g) => ({ ...g, projectId: ALL_PROJECTS }))
}

/**
 * The permission gate in front of every write/execute tool call
 * (architecture §9). Policy is code, decisions are the user's — a model can
 * request, never grant. "Always allow" is a persisted grant scoped to
 * agent + tool + project and only exists for write tools; commands are asked
 * every time. Unanswered requests are denied after 10 minutes.
 *
 * Paired devices answer within limits: they may deny anything and allow
 * reads, but allow changes and commands only while remote shells are on — an
 * approval is a shell's power — and never "always".
 */
export class PermissionService {
  private readonly pending = new Map<string, Pending>()
  private grantList?: Promise<PermissionGrant[]>
  private changing: Promise<void> = Promise.resolve()
  private recent: { request: PermissionRequest; at: number }[] = []

  constructor(private readonly deps: PermissionDeps) {}

  /** `toolName` is the tool's stable key (a name, or an ACP tool kind). */
  async isGranted(agentId: string, toolName: string, projectId?: string): Promise<boolean> {
    return (await this.loadGrants()).some((g) => holds(g, agentId, toolName, projectId))
  }

  async grants(): Promise<PermissionGrant[]> {
    return [...(await this.loadGrants())]
  }

  /** Removes exactly one grant (`projectId` as listed; none = outside projects). */
  revoke(agentId: string, toolName: string, projectId?: string): Promise<void> {
    return this.change((grants) => grants.filter((g) => !(g.agentId === agentId && g.toolName === toolName && g.projectId === projectId)))
  }

  list(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request)
  }

  /** Ask the user. `decision` resolves with their answer ('deny' on timeout or abort). */
  ask(input: Omit<PermissionRequest, 'id' | 'createdAt'>, signal: AbortSignal): { id: string; decision: Promise<ApprovalDecision> } {
    const request: PermissionRequest = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }
    const decision = new Promise<ApprovalDecision>((resolveAsk) => {
      const finish = (decision: ApprovalDecision) => {
        this.pending.delete(request.id)
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.deps.onResolved({ id: request.id, decision })
        resolveAsk(decision)
      }
      const onAbort = () => finish('deny')
      const timer = setTimeout(() => finish('deny'), this.deps.timeoutMs ?? APPROVAL_TIMEOUT_MS)
      this.pending.set(request.id, { request, settle: finish })
      signal.addEventListener('abort', onAbort, { once: true })
      this.deps.events.emit('permission.requested', {
        actor: { kind: 'agent', id: request.agentId },
        conversationId: request.conversationId,
        payload: { requestId: request.id, tool: request.toolName, summary: request.summary, reason: request.reason }
      })
      this.deps.onRequest(request)
      if (signal.aborted) onAbort()
    })
    return { id: request.id, decision }
  }

  /** The user's answer, from the desktop or (`remote`) a paired device. */
  async respond(id: string, decision: ApprovalDecision, remote?: RemoteResponder): Promise<void> {
    const p = this.pending.get(id)
    if (!p) throw coded('not-pending', 'This request is no longer pending')
    if (remote && decision !== 'deny' && p.request.risk !== 'read' && !remote.shells) {
      throw coded('remote-terminal-disabled', 'Changes and commands can only be allowed on the desktop while remote shells are off')
    }
    const effective: ApprovalDecision = decision === 'always' && (!p.request.allowAlways || remote) ? 'once' : decision
    if (effective === 'always') {
      const { agentId, toolName, projectId } = p.request
      await this.change((grants) =>
        grants.some((g) => holds(g, agentId, toolName, projectId))
          ? grants
          : [...grants, { agentId, toolName, ...(projectId ? { projectId } : {}), createdAt: new Date().toISOString() }]
      )
    }
    if (effective !== 'deny') this.remember(p.request)
    this.deps.events.emit(effective === 'deny' ? 'permission.denied' : 'permission.granted', {
      actor: { kind: 'user', ...(remote?.deviceId ? { id: remote.deviceId } : {}) },
      conversationId: p.request.conversationId,
      payload: { requestId: id, tool: p.request.toolName, decision: effective }
    })
    p.settle(effective)
  }

  /**
   * Whether the user just allowed a matching request in this conversation —
   * an agent that asks with its own gate before it calls a Mindeck tool. Each
   * answer counts once, for a minute.
   */
  takeApproval(conversationId: string, match: (request: PermissionRequest) => boolean): boolean {
    const now = Date.now()
    this.recent = this.recent.filter((r) => now - r.at < RECENT_MS)
    const i = this.recent.findIndex((r) => r.request.conversationId === conversationId && match(r.request))
    if (i < 0) return false
    this.recent.splice(i, 1)
    return true
  }

  private remember(request: PermissionRequest): void {
    this.recent = [...this.recent, { request, at: Date.now() }].slice(-20)
  }

  private loadGrants(): Promise<PermissionGrant[]> {
    this.grantList ??= (async () => {
      // Missing or damaged → empty (a damaged file is set aside, see readJson).
      const parsed = (await readJson<{ version?: number; grants?: unknown } | null>(this.deps.file)) ?? {}
      const grants = migrate(parsed)
      // Store the migrated list right away (best effort — it is migrated again on the next start otherwise).
      if (parsed.version !== GRANTS_VERSION && grants.length) await this.write(grants).catch(() => {})
      return grants
    })()
    return this.grantList
  }

  /** Serialized read-modify-write: two quick "always" answers both land. */
  private change(fn: (grants: PermissionGrant[]) => PermissionGrant[]): Promise<void> {
    const run = this.changing.then(async () => {
      const next = fn(await this.loadGrants())
      await this.write(next)
      this.grantList = Promise.resolve(next)
    })
    this.changing = run.catch(() => {})
    return run
  }

  /** Atomic, one write at a time, readable by the user only. */
  private write(grants: PermissionGrant[]): Promise<void> {
    return writeAtomic(this.deps.file, JSON.stringify({ version: GRANTS_VERSION, grants }, null, 2), 0o600)
  }
}
