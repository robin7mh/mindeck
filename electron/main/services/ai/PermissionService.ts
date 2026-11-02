import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { ApprovalDecision, PermissionGrant, PermissionRequest } from '@shared/types/ai'
import { writeAtomic } from '../../lib/writeAtomic'
import type { EventBus } from '../events/EventBus'

const APPROVAL_TIMEOUT_MS = 10 * 60_000

export interface PermissionDeps {
  file: string
  events: EventBus
  /** Push to every client: a request appeared / was answered. */
  onRequest: (req: PermissionRequest) => void
  onResolved: (res: { id: string; decision: ApprovalDecision }) => void
  timeoutMs?: number
}

interface Pending {
  request: PermissionRequest
  settle: (d: ApprovalDecision) => void
}

/**
 * The permission gate in front of every write/execute tool call
 * (architecture §9). Policy is code, decisions are the user's — a model can
 * request, never grant. "Always allow" is a persisted grant scoped to
 * agent + tool and only exists for write tools; commands are asked every time.
 * Unanswered requests are denied after 10 minutes.
 */
export class PermissionService {
  private readonly pending = new Map<string, Pending>()
  private grantList?: PermissionGrant[]

  constructor(private readonly deps: PermissionDeps) {}

  async isGranted(agentId: string, toolName: string): Promise<boolean> {
    return (await this.loadGrants()).some((g) => g.agentId === agentId && g.toolName === toolName)
  }

  async grants(): Promise<PermissionGrant[]> {
    return [...(await this.loadGrants())]
  }

  async revoke(agentId: string, toolName: string): Promise<void> {
    const next = (await this.loadGrants()).filter((g) => !(g.agentId === agentId && g.toolName === toolName))
    await this.saveGrants(next)
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

  /** The user's answer (from any connected client). */
  async respond(id: string, decision: ApprovalDecision, deviceId?: string): Promise<void> {
    const p = this.pending.get(id)
    if (!p) throw Object.assign(new Error('This request is no longer pending'), { code: 'not-pending' })
    const effective: ApprovalDecision = decision === 'always' && !p.request.allowAlways ? 'once' : decision
    if (effective === 'always' && !(await this.isGranted(p.request.agentId, p.request.toolName))) {
      const next = [...(await this.loadGrants()), { agentId: p.request.agentId, toolName: p.request.toolName, createdAt: new Date().toISOString() }]
      await this.saveGrants(next)
    }
    this.deps.events.emit(effective === 'deny' ? 'permission.denied' : 'permission.granted', {
      actor: { kind: 'user', ...(deviceId ? { id: deviceId } : {}) },
      conversationId: p.request.conversationId,
      payload: { requestId: id, tool: p.request.toolName, decision: effective }
    })
    p.settle(effective)
  }

  private async loadGrants(): Promise<PermissionGrant[]> {
    if (this.grantList) return this.grantList
    try {
      const parsed = JSON.parse(await readFile(this.deps.file, 'utf8'))
      this.grantList = Array.isArray(parsed.grants) ? parsed.grants : []
    } catch {
      this.grantList = []
    }
    return this.grantList!
  }

  private async saveGrants(grants: PermissionGrant[]): Promise<void> {
    // In memory first: two answers at once each build on the other's grant instead of losing one.
    this.grantList = grants
    // Queued per file with its own temp file — concurrent writes never race on one `.tmp`.
    await writeAtomic(this.deps.file, JSON.stringify({ version: 1, grants }, null, 2))
  }
}
