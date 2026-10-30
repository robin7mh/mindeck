import { randomUUID } from 'node:crypto'
import type { IpcEvent, IpcEvents } from '@shared/ipc/contract'
import type {
  AgentInfo,
  AgentRun,
  ChatMessage,
  Conversation,
  ConversationSummary,
  SendRequest,
  ToolCallPart
} from '@shared/types/ai'
import type { CallContext } from '../../../ipc/router'
import type { EventBus } from '../events/EventBus'
import { AGENTS, agentInfo, type AgentDefinition } from './agents'
import type { AiService } from './AiService'
import type { ContextBuilder } from './ContextBuilder'
import type { ConversationStore, StoredConversation } from './ConversationStore'
import { aiError, type LlmBlock, type LlmMessage, type LlmProvider } from './llm'
import type { PermissionService } from './PermissionService'
import type { RunStore } from './RunStore'
import type { ToolRegistry } from './tools/registry'
import { truncate } from './tools/builtin'

const MAX_TOKENS = 32_000
const FINAL: readonly ToolCallPart['status'][] = ['done', 'error', 'denied']
const DISPLAY_OUTPUT = 4_000

export interface AssistantDeps {
  ai: AiService
  store: ConversationStore
  runs: RunStore
  tools: ToolRegistry
  permissions: PermissionService
  events: EventBus
  context: ContextBuilder
  publish: <K extends IpcEvent>(channel: K, payload: IpcEvents[K]) => void
  /** Whether paired remote devices may trigger command execution and changes. */
  remoteShell: () => boolean
  /** What a paired device may reach (shared folders, deny list): throws to refuse a tool call it started. */
  remoteAccess?: { tool(input: unknown, projectId?: string): Promise<void> }
  /** Agent definitions (default: the built-in ones). */
  agents?: readonly AgentDefinition[]
}

interface ActiveRun {
  controller: AbortController
  done: Promise<void>
  /** The conversation as the run has it — ahead of the saved copy (streamed text, a tool waiting for approval). */
  conv?: StoredConversation
}

const errorCode = (err: unknown) => String((err as { code?: string })?.code ?? 'error')
const errorText = (err: unknown) => String((err as Error)?.message ?? err)

/**
 * The agent runtime (architecture §7) — a controlled loop, never a
 * free-running process:
 *
 *   goal → model turn → tool call → allowlist → schema → PERMISSION GATE
 *        → execute → result → next turn … until done / limit / cancel
 *
 * Hard limits per agent (iterations, wall clock), cancellation through one
 * AbortController, every step emitted as a structured event. The provider
 * transcript is append-only (the model's own blocks are replayed unchanged).
 * No raw model reasoning is stored or shown.
 */
export class AssistantService {
  private readonly active = new Map<string, ActiveRun>()

  constructor(private readonly deps: AssistantDeps) {}

  agents(): AgentInfo[] {
    return this.agentList().map(agentInfo)
  }

  private agentList(): readonly AgentDefinition[] {
    return this.deps.agents ?? AGENTS
  }

  private agent(id: string | undefined): AgentDefinition {
    const list = this.agentList()
    return list.find((a) => a.id === id) ?? list[0]
  }

  async conversations(): Promise<ConversationSummary[]> {
    return (await this.deps.store.list()).map((c) => ({ ...c, running: this.active.has(c.id) }))
  }

  /**
   * One conversation — while it runs, as it stands right now, so a client that missed push events
   * (a reconnecting web UI or phone) gets the streamed text and the approvals waiting in it.
   */
  async conversation(id: string): Promise<Conversation> {
    const c = this.active.get(id)?.conv ?? (await this.deps.store.get(id))
    if (!c) throw aiError('not-found', 'Conversation not found')
    const { transcript: _t, ...rest } = c
    return { ...structuredClone(rest), running: this.active.has(id) }
  }

  runs(limit?: number): Promise<AgentRun[]> {
    return this.deps.runs.list(limit)
  }

  /** Starts a run in the background; progress arrives as push events. */
  async send(req: SendRequest, ctx: CallContext): Promise<{ conversationId: string; messageId: string }> {
    // Reserve an existing conversation before the first await, so two quick
    // sends cannot both start a run on the same transcript.
    const entry: ActiveRun = { controller: new AbortController(), done: Promise.resolve() }
    const reserved = req.conversationId
    if (reserved) {
      if (this.active.has(reserved)) throw aiError('busy', 'The assistant is still answering in this conversation')
      this.active.set(reserved, entry)
    }
    try {
      return await this.start(req, ctx, entry)
    } catch (err) {
      if (reserved) this.active.delete(reserved)
      throw err
    }
  }

  private async start(req: SendRequest, ctx: CallContext, entry: ActiveRun): Promise<{ conversationId: string; messageId: string }> {
    const provider = await this.deps.ai.provider()
    const settings = { ...this.deps.ai.settings(), model: await this.deps.ai.model() }
    const now = new Date().toISOString()

    let conv: StoredConversation
    if (req.conversationId) {
      const found = await this.deps.store.get(req.conversationId)
      if (!found) throw aiError('not-found', 'Conversation not found')
      conv = found
    } else {
      const agent = this.agent(req.agentId)
      conv = {
        id: randomUUID(),
        title: req.text.replace(/\s+/g, ' ').trim().slice(0, 60),
        agentId: agent.id,
        projectId: req.projectId,
        createdAt: now,
        updatedAt: now,
        messages: [],
        transcript: []
      }
    }
    if (req.projectId) conv.projectId = req.projectId
    const agent = this.agent(conv.agentId)

    const user: ChatMessage = { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: req.text }], createdAt: now, status: 'done' }
    const reply: ChatMessage = { id: randomUUID(), role: 'assistant', parts: [], createdAt: now, status: 'streaming', model: settings.model }
    const context = await this.deps.context.build(req.text, conv.projectId)
    conv.transcript.push({ role: 'user', blocks: [{ type: 'text', text: context }, { type: 'text', text: req.text }] })
    conv.messages.push(user, reply)
    conv.updatedAt = now
    await this.deps.store.save(conv)

    const run: AgentRun = {
      id: randomUUID(),
      agentId: agent.id,
      conversationId: conv.id,
      goal: req.text.slice(0, 500),
      projectId: conv.projectId,
      model: settings.model,
      status: 'running',
      startedAt: now,
      iterations: 0,
      inputTokens: 0,
      outputTokens: 0
    }
    const controller = entry.controller
    entry.conv = conv
    this.active.set(conv.id, entry)
    this.deps.publish('ai:conversationsChanged', { reason: req.conversationId ? 'updated' : 'created', id: conv.id })
    this.deps.publish('ai:message', { conversationId: conv.id, message: user, running: true })
    this.deps.publish('ai:message', { conversationId: conv.id, message: reply, running: true })
    await this.deps.runs.save(run)
    this.deps.events.emit('agent.started', {
      actor: { kind: 'agent', id: agent.id },
      subject: { kind: 'agent_run', id: run.id },
      conversationId: conv.id,
      projectId: conv.projectId,
      payload: { runId: run.id, agent: agent.name, goal: run.goal, model: run.model, transport: ctx.transport }
    })

    entry.done = this.loop({ conv, reply, agent, provider, run, ctx, controller, effort: settings.effort })
    return { conversationId: conv.id, messageId: reply.id }
  }

  cancel(conversationId: string): void {
    this.active.get(conversationId)?.controller.abort('cancelled')
  }

  async remove(id: string): Promise<void> {
    const running = this.active.get(id)
    if (running) {
      running.controller.abort('cancelled')
      await running.done
    }
    await this.deps.store.delete(id)
    this.deps.publish('ai:conversationsChanged', { reason: 'deleted', id })
  }

  /** Resolves once every run in progress has finished (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.active.values()].map((r) => r.done))
  }

  async dispose(): Promise<void> {
    for (const r of this.active.values()) r.controller.abort('cancelled')
    await this.idle()
  }

  // --- the loop ----------------------------------------------------------------

  private async loop(r: {
    conv: StoredConversation
    reply: ChatMessage
    agent: AgentDefinition
    provider: LlmProvider
    run: AgentRun
    ctx: CallContext
    controller: AbortController
    effort: ReturnType<AiService['settings']>['effort']
  }): Promise<void> {
    const { conv, reply, agent, run, controller } = r
    const signal = controller.signal
    const timer = setTimeout(() => controller.abort('timeout'), agent.timeoutMs)
    const publish = () => this.deps.publish('ai:message', { conversationId: conv.id, message: reply, running: true })
    const status = (text: string) =>
      this.deps.events.emit('agent.status.updated', {
        actor: { kind: 'agent', id: agent.id },
        conversationId: conv.id,
        payload: { runId: run.id, iteration: run.iterations, text }
      })

    try {
      for (let step = 1; ; step += 1) {
        if (step > agent.maxIterations) {
          this.appendText(conv, reply, `\n\n_Stopped after ${agent.maxIterations} steps (the agent's limit). Send a message to continue._`)
          break
        }
        run.iterations = step
        status(step === 1 ? 'Thinking' : `Step ${step}`)
        const turn = await r.provider.stream(
          {
            model: run.model,
            effort: r.effort,
            system: agent.systemPrompt,
            messages: conv.transcript,
            tools: this.deps.tools.forModel(agent.tools),
            webTools: agent.web,
            maxTokens: MAX_TOKENS,
            signal,
            kind: 'assistant'
          },
          (text) => this.appendText(conv, reply, text)
        )
        run.inputTokens += turn.usage.inputTokens
        run.outputTokens += turn.usage.outputTokens
        reply.model = turn.model
        run.model = turn.model
        reply.usage = { inputTokens: run.inputTokens, outputTokens: run.outputTokens }
        conv.transcript.push(turn.message)
        for (const s of turn.serverTools) {
          reply.parts.push({
            type: 'tool',
            id: s.id,
            name: s.name,
            title: s.name === 'web_fetch' ? 'Fetch page' : 'Web search',
            risk: 'read',
            input: s.input,
            status: 'done',
            output: s.output,
            server: true
          })
        }
        if (turn.serverTools.length) publish()

        if (turn.stopReason === 'refusal') {
          throw aiError('refused', 'The model declined this request.')
        }
        if (turn.stopReason === 'pause_turn') continue
        const calls = turn.message.blocks.filter((b): b is Extract<LlmBlock, { type: 'tool_call' }> => b.type === 'tool_call')
        if (!calls.length) {
          if (turn.stopReason === 'max_tokens') this.appendText(conv, reply, '\n\n_The answer hit the length limit._')
          break
        }
        if (turn.stopReason === 'max_tokens') throw aiError('truncated', 'A tool call was cut off by the length limit.')

        const results: LlmBlock[] = []
        for (const call of calls) results.push(await this.execute(call, r, publish))
        conv.transcript.push({ role: 'user', blocks: results })
        await this.deps.store.save(conv)
      }
      reply.status = 'done'
      run.status = 'completed'
    } catch (err) {
      const reason = signal.reason
      if (signal.aborted && reason === 'timeout') {
        run.status = 'timeout'
        reply.status = 'error'
        reply.error = `Stopped: the run exceeded ${Math.round(agent.timeoutMs / 60_000)} minutes.`
      } else if (signal.aborted || errorCode(err) === 'cancelled') {
        run.status = 'cancelled'
        reply.status = 'cancelled'
      } else {
        run.status = 'failed'
        reply.status = 'error'
        reply.error = errorText(err)
        reply.errorCode = errorCode(err)
      }
      run.error = reply.error
    } finally {
      clearTimeout(timer)
      for (const part of reply.parts) {
        if (part.type === 'tool' && !FINAL.includes(part.status)) {
          part.status = 'error'
          part.output = 'Interrupted'
        }
      }
      closeOpenToolCalls(conv.transcript)
      run.endedAt = new Date().toISOString()
      conv.updatedAt = run.endedAt
      await this.deps.store.save(conv)
      await this.deps.runs.save(run)
      const type = run.status === 'completed' ? 'agent.completed' : run.status === 'cancelled' ? 'agent.cancelled' : 'agent.failed'
      this.deps.events.emit(type, {
        actor: { kind: 'agent', id: agent.id },
        subject: { kind: 'agent_run', id: run.id },
        conversationId: conv.id,
        projectId: conv.projectId,
        payload: {
          runId: run.id,
          status: run.status,
          iterations: run.iterations,
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          ...(run.error ? { error: run.error } : {})
        }
      })
      this.active.delete(conv.id)
      this.deps.publish('ai:message', { conversationId: conv.id, message: reply, running: false })
      this.deps.publish('ai:conversationsChanged', { reason: 'updated', id: conv.id })
    }
  }

  /** Streamed text lands in the last text part (a new one after a tool call). */
  private appendText(conv: StoredConversation, reply: ChatMessage, text: string): void {
    const last = reply.parts[reply.parts.length - 1]
    if (last?.type === 'text') last.text += text
    else reply.parts.push({ type: 'text', text })
    this.deps.publish('ai:delta', { conversationId: conv.id, messageId: reply.id, text })
  }

  /** One tool call through allowlist → schema → permission gate → execution. */
  private async execute(
    call: Extract<LlmBlock, { type: 'tool_call' }>,
    r: { conv: StoredConversation; reply: ChatMessage; agent: AgentDefinition; run: AgentRun; ctx: CallContext; controller: AbortController },
    publish: () => void
  ): Promise<LlmBlock> {
    const { conv, reply, agent, run } = r
    const tool = this.deps.tools.get(call.name)
    const part: ToolCallPart = {
      type: 'tool',
      id: call.id,
      name: call.name,
      title: tool?.title ?? call.name,
      risk: tool?.risk ?? 'read',
      input: call.input,
      status: 'pending'
    }
    reply.parts.push(part)
    publish()
    const event = (type: 'tool.started' | 'tool.completed' | 'tool.failed' | 'tool.denied', payload: Record<string, unknown>) =>
      this.deps.events.emit(type, {
        actor: { kind: 'agent', id: agent.id },
        conversationId: conv.id,
        projectId: conv.projectId,
        payload: { runId: run.id, tool: call.name, ...payload }
      })
    const finish = (status: ToolCallPart['status'], output: string, isError: boolean): LlmBlock => {
      part.status = status
      part.output = truncate(output, DISPLAY_OUTPUT)
      publish()
      return { type: 'tool_result', callId: call.id, content: output, ...(isError ? { isError: true } : {}) }
    }

    // 1. allowlist — rejected before the policy engine is even consulted
    if (!tool || !agent.tools.includes(call.name)) {
      event('tool.denied', { reason: 'not-allowed' })
      return finish('denied', `The tool ${call.name} is not available to the ${agent.name} agent.`, true)
    }
    // A run a paired device started changes nothing, runs nothing and reads no terminal without remote shells.
    const remote = r.ctx.transport === 'remote'
    if ((tool.risk !== 'read' || tool.shell) && remote && !this.deps.remoteShell()) {
      event('tool.denied', { reason: 'remote-shell-disabled' })
      const what = tool.risk === 'read' ? 'Reading terminals' : 'Changing files and running commands'
      return finish('denied', `${what} is disabled for remote devices on this Mindeck core.`, true)
    }
    // 2. schema
    const parsed = this.deps.tools.parse(tool, call.input)
    if (!parsed.ok) {
      event('tool.failed', { error: parsed.message })
      return finish('error', parsed.message, true)
    }
    const summary = tool.summarize(parsed.data)
    const projectId = (parsed.data as { projectId?: string }).projectId || conv.projectId
    if (remote && this.deps.remoteAccess) {
      try {
        await this.deps.remoteAccess.tool(parsed.data, conv.projectId)
      } catch (err) {
        event('tool.denied', { reason: 'remote-forbidden' })
        return finish('denied', errorText(err), true)
      }
    }
    // 3. permission gate — an "Always allow" holds in the tool's project only
    if (tool.risk !== 'read') {
      let granted = false
      if (tool.risk === 'write') granted = await this.deps.permissions.isGranted(agent.id, tool.name, projectId)
      if (!granted) {
        const reason = String((parsed.data as { reason?: unknown }).reason ?? '')
        const asked = this.deps.permissions.ask(
          {
            runId: run.id,
            conversationId: conv.id,
            agentId: agent.id,
            agentName: agent.name,
            toolName: tool.name,
            toolTitle: tool.title,
            risk: tool.risk,
            summary,
            reason,
            input: parsed.data,
            allowAlways: tool.risk === 'write',
            ...(projectId ? { projectId } : {})
          },
          r.controller.signal
        )
        part.status = 'awaiting-approval'
        part.requestId = asked.id
        publish()
        if ((await asked.decision) === 'deny') {
          part.requestId = undefined
          event('tool.denied', { reason: 'user', summary })
          return finish('denied', 'The user denied this action.', true)
        }
        part.requestId = undefined
      }
    }
    // 4. execute
    part.status = 'running'
    publish()
    event('tool.started', { summary })
    try {
      const output = await tool.run(parsed.data, { projectId: conv.projectId, signal: r.controller.signal, agent: agent.name, conversationId: conv.id })
      event('tool.completed', { summary, bytes: output.length })
      return finish('done', output, false)
    } catch (err) {
      event('tool.failed', { summary, error: errorText(err) })
      return finish('error', `Error: ${errorText(err)}`, true)
    }
  }
}

/**
 * A run that ends mid-step leaves tool calls without results — the API
 * rejects such a history. Answer them as interrupted (append-only).
 */
export function closeOpenToolCalls(transcript: LlmMessage[]): void {
  const last = transcript[transcript.length - 1]
  if (last?.role !== 'assistant') return
  const open = last.blocks.filter((b): b is Extract<LlmBlock, { type: 'tool_call' }> => b.type === 'tool_call')
  if (!open.length) return
  transcript.push({
    role: 'user',
    blocks: open.map((c) => ({ type: 'tool_result', callId: c.id, content: 'Interrupted before this tool ran.', isError: true }))
  })
}
