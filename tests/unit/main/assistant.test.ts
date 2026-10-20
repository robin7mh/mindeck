import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { tempDir, tick } from './helpers'
import { AssistantService, closeOpenToolCalls } from '../../../electron/main/services/ai/AssistantService'
import { ConversationStore } from '../../../electron/main/services/ai/ConversationStore'
import { RunStore } from '../../../electron/main/services/ai/RunStore'
import { PermissionService } from '../../../electron/main/services/ai/PermissionService'
import { ToolRegistry } from '../../../electron/main/services/ai/tools/registry'
import type { ToolDefinition } from '../../../electron/main/services/ai/tools/types'
import type { AgentDefinition } from '../../../electron/main/services/ai/agents'
import { AGENTS } from '../../../electron/main/services/ai/agents'
import { EventBus } from '../../../electron/main/services/events/EventBus'
import { aiError, type LlmBlock, type LlmMessage, type LlmRequest, type LlmTurn } from '../../../electron/main/services/ai/llm'
import type { ChatMessage, ToolCallPart } from '@shared/types/ai'
import type { MindeckEvent } from '@shared/types/events'

// --- fixtures -------------------------------------------------------------------

const tools: ToolDefinition<never>[] = [
  {
    name: 'read_x',
    title: 'Read X',
    description: 'reads',
    risk: 'read',
    schema: z.object({ q: z.string() }),
    summarize: (i: { q: string }) => `read ${i.q}`,
    run: async (i: { q: string }, ctx: { projectId?: string }) => `read:${i.q}:${ctx.projectId ?? '-'}`
  },
  {
    name: 'write_x',
    title: 'Write X',
    description: 'writes',
    risk: 'write',
    schema: z.object({ v: z.string(), reason: z.string(), projectId: z.string().optional() }),
    summarize: (i: { v: string }) => `write ${i.v}`,
    run: async (i: { v: string }) => `wrote:${i.v}`
  },
  {
    name: 'exec_x',
    title: 'Exec X',
    description: 'executes',
    risk: 'execute',
    schema: z.object({ cmd: z.string(), reason: z.string() }),
    summarize: (i: { cmd: string }) => `run ${i.cmd}`,
    run: async (i: { cmd: string }) => `ran:${i.cmd}`
  },
  {
    name: 'boom',
    title: 'Boom',
    description: 'fails',
    risk: 'read',
    schema: z.object({}),
    summarize: () => 'boom',
    run: async () => {
      throw new Error('kaboom')
    }
  },
  {
    name: 'tag_x',
    title: 'Tag X',
    description: 'writes without a reason field',
    risk: 'write',
    schema: z.object({}),
    summarize: () => 'tag',
    run: async () => 'tagged'
  },
  {
    name: 'other_agent_tool',
    title: 'Other',
    description: 'not allowlisted',
    risk: 'read',
    schema: z.object({}),
    summarize: () => 'other',
    run: async () => 'other'
  }
] as unknown as ToolDefinition<never>[]

const agentDef = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: 'tester',
  name: 'Tester',
  description: 'd',
  tools: ['read_x', 'write_x', 'exec_x', 'boom', 'tag_x', 'missing_tool'],
  web: false,
  systemPrompt: 'SYSTEM',
  maxIterations: 6,
  timeoutMs: 60_000,
  ...over
})

type Step = (req: LlmRequest, onText: (t: string) => void) => Promise<LlmTurn>
const turn = (blocks: LlmBlock[], stopReason: LlmTurn['stopReason'] = 'end_turn', over: Partial<LlmTurn> = {}): LlmTurn => ({
  message: { role: 'assistant', blocks },
  stopReason,
  model: 'claude-opus-5-5',
  usage: { inputTokens: 10, outputTokens: 5 },
  serverTools: [],
  ...over
})
const say =
  (text: string, stopReason: LlmTurn['stopReason'] = 'end_turn'): Step =>
  async (_req, onText) => {
    for (const piece of text.match(/.{1,3}/g) ?? []) onText(piece)
    return turn([{ type: 'text', text }], stopReason)
  }
const call = (name: string, input: unknown, id = `tu_${name}`, text?: string, stopReason: LlmTurn['stopReason'] = 'tool_use'): Step => async (_req, onText) => {
  if (text) onText(text)
  return turn([...(text ? [{ type: 'text' as const, text }] : []), { type: 'tool_call', id, name, input }], stopReason)
}
/** Waits until the run is aborted, then fails like the provider does. */
const hang: Step = (req) =>
  new Promise((_, reject) => req.signal!.addEventListener('abort', () => reject(aiError('cancelled', 'Cancelled'))))

async function harness(
  opts: { script?: Step[]; agents?: AgentDefinition[]; remoteShell?: boolean; noKey?: boolean; remoteAccess?: { tool(input: unknown, projectId?: string): Promise<void> } } = {}
) {
  const dir = await tempDir()
  const script = [...(opts.script ?? [])]
  const requests: LlmRequest[] = []
  const provider = {
    stream: vi.fn(async (req: LlmRequest, onText: (t: string) => void) => {
      requests.push({ ...req, messages: structuredClone(req.messages) })
      const step = script.shift()
      if (!step) throw new Error('script exhausted')
      return step(req, onText)
    })
  }
  const events: MindeckEvent[] = []
  const bus = new EventBus({ sink: { persist: () => {} } })
  bus.subscribe('*', (e) => events.push(e))
  const pushed: { channel: string; payload: unknown }[] = []
  const permissions = new PermissionService({ file: `${dir}/grants.json`, events: bus, onRequest: () => {}, onResolved: () => {} })
  const store = new ConversationStore(dir)
  const runs = new RunStore()
  const svc = new AssistantService({
    ai: {
      provider: async () => {
        if (opts.noKey) throw aiError('no-key', 'No key')
        return provider
      },
      settings: () => ({ model: 'claude-opus-5-5', effort: 'medium' }),
      model: async () => 'claude-opus-5-5'
    } as never,
    store,
    runs,
    tools: new ToolRegistry(tools),
    permissions,
    events: bus,
    context: { build: async (_t: string, p?: string) => `<context>${p ?? ''}</context>` } as never,
    publish: (channel, payload) => pushed.push({ channel, payload }),
    remoteShell: () => !!opts.remoteShell,
    remoteAccess: opts.remoteAccess,
    agents: opts.agents ?? [agentDef()]
  })
  const reply = async (conversationId: string): Promise<ChatMessage> => (await svc.conversation(conversationId)).messages.at(-1)!
  const transcript = async (conversationId: string): Promise<LlmMessage[]> => (await store.get(conversationId))!.transcript
  const waitFor = async (fn: () => boolean) => {
    for (let i = 0; i < 200 && !fn(); i += 1) await tick(2)
  }
  return { svc, provider, requests, events, pushed, permissions, store, runs, reply, transcript, waitFor, script }
}

const ipc = { transport: 'ipc' as const }
const remote = { transport: 'remote' as const, deviceId: 'phone' }
const toolParts = (m: ChatMessage) => m.parts.filter((p): p is ToolCallPart => p.type === 'tool')

// --- tests ----------------------------------------------------------------------

describe('AssistantService — conversation basics', () => {
  it('streams a plain answer into a new conversation and records the run', async () => {
    const h = await harness({ script: [say('Hello there')] })
    const { conversationId, messageId } = await h.svc.send({ text: '  Hi   Mindeck ', projectId: 'p1' }, ipc)
    await h.svc.idle()

    const conv = await h.svc.conversation(conversationId)
    expect(conv).toMatchObject({ title: 'Hi Mindeck', agentId: 'tester', projectId: 'p1', running: false })
    expect(conv).not.toHaveProperty('transcript')
    expect(conv.messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'done'],
      ['assistant', 'done']
    ])
    expect(conv.messages[1]).toMatchObject({ id: messageId, parts: [{ type: 'text', text: 'Hello there' }], usage: { inputTokens: 10, outputTokens: 5 } })
    expect(h.requests[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', system: 'SYSTEM', maxTokens: 32000, webTools: false })
    expect(h.requests[0].messages).toEqual([{ role: 'user', blocks: [{ type: 'text', text: '<context>p1</context>' }, { type: 'text', text: '  Hi   Mindeck ' }] }])
    expect(h.requests[0].tools.map((t) => t.name)).toEqual(['read_x', 'write_x', 'exec_x', 'boom', 'tag_x'])
    expect((await h.transcript(conversationId)).map((m) => m.role)).toEqual(['user', 'assistant'])

    const deltas = h.pushed.filter((p) => p.channel === 'ai:delta').map((p) => (p.payload as { text: string }).text)
    expect(deltas.join('')).toBe('Hello there')
    expect(h.pushed.at(-1)).toEqual({ channel: 'ai:conversationsChanged', payload: { reason: 'updated', id: conversationId } })
    expect(h.pushed[0]).toEqual({ channel: 'ai:conversationsChanged', payload: { reason: 'created', id: conversationId } })
    expect(h.events.map((e) => e.type)).toEqual(['agent.started', 'agent.status.updated', 'agent.completed'])
    expect((await h.svc.runs())[0]).toMatchObject({ status: 'completed', iterations: 1, inputTokens: 10, outputTokens: 5 })
    expect((await h.svc.conversations())[0]).toMatchObject({ id: conversationId, running: false })
    expect(h.svc.agents()).toEqual([{ id: 'tester', name: 'Tester', description: 'd', tools: agentDef().tools, web: false }])
  })

  it('continues a conversation (append-only transcript), refuses while busy, rejects unknown ids', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = await harness({
      script: [
        say('first'),
        async (req, onText) => {
          await gate
          return say('second')(req, onText)
        }
      ]
    })
    const { conversationId } = await h.svc.send({ text: 'one' }, ipc)
    await h.svc.idle()
    const before = await h.transcript(conversationId)
    await h.svc.send({ conversationId, text: 'two', projectId: 'p9' }, ipc)
    expect((await h.svc.conversations())[0].running).toBe(true)
    expect((await h.svc.conversation(conversationId)).running).toBe(true)
    await expect(h.svc.send({ conversationId, text: 'three' }, ipc)).rejects.toMatchObject({ code: 'busy' })
    release()
    await h.svc.idle()
    const after = await h.transcript(conversationId)
    expect(after.slice(0, before.length)).toEqual(before) // nothing earlier was edited
    expect(after[2].blocks[0]).toEqual({ type: 'text', text: '<context>p9</context>' })
    expect((await h.svc.conversation(conversationId)).projectId).toBe('p9')
    await expect(h.svc.send({ conversationId: 'nope', text: 'x' }, ipc)).rejects.toMatchObject({ code: 'not-found' })
    await expect(h.svc.send({ conversationId: 'nope', text: 'x' }, ipc)).rejects.toMatchObject({ code: 'not-found' }) // reservation released
    await expect(h.svc.conversation('nope')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('two quick sends to one conversation: the second is refused before any work starts', async () => {
    const h = await harness({ script: [say('first'), say('second')] })
    const { conversationId } = await h.svc.send({ text: 'one' }, ipc)
    await h.svc.idle()
    const [a, b] = await Promise.allSettled([
      h.svc.send({ conversationId, text: 'two' }, ipc),
      h.svc.send({ conversationId, text: 'three' }, ipc)
    ])
    expect(a.status).toBe('fulfilled')
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'busy' } })
    await h.svc.idle()
    expect((await h.transcript(conversationId)).filter((m) => m.role === 'user')).toHaveLength(2)
  })

  it('without a key nothing is created', async () => {
    const h = await harness({ noKey: true })
    await expect(h.svc.send({ text: 'x' }, ipc)).rejects.toMatchObject({ code: 'no-key' })
    expect(await h.svc.conversations()).toEqual([])
  })

  it('picks the requested agent, falls back to the first one', async () => {
    const h = await harness({ script: [say('a'), say('b')], agents: [agentDef(), agentDef({ id: 'chat', name: 'Chat', tools: [] })] })
    const a = await h.svc.send({ text: 'x', agentId: 'chat' }, ipc)
    await h.svc.idle()
    expect((await h.svc.conversation(a.conversationId)).agentId).toBe('chat')
    expect(h.requests[0].tools).toEqual([])
    const b = await h.svc.send({ text: 'x', agentId: 'ghost' }, ipc)
    await h.svc.idle()
    expect((await h.svc.conversation(b.conversationId)).agentId).toBe('tester')
    expect(new AssistantService({} as never).agents().map((x) => x.id)).toEqual(AGENTS.map((x) => x.id))
  })
})

describe('AssistantService — tools and the permission gate', () => {
  it('runs read tools directly and feeds results back', async () => {
    const h = await harness({ script: [call('read_x', { q: 'a' }, 'tu1', 'Looking. '), say('Done')] })
    const { conversationId } = await h.svc.send({ text: 'go', projectId: 'p1' }, ipc)
    await h.svc.idle()
    const m = await h.reply(conversationId)
    expect(m.parts.map((p) => p.type)).toEqual(['text', 'tool', 'text'])
    expect(toolParts(m)[0]).toMatchObject({ name: 'read_x', title: 'Read X', status: 'done', output: 'read:a:p1' })
    const t = await h.transcript(conversationId)
    expect(t[2]).toEqual({ role: 'user', blocks: [{ type: 'tool_result', callId: 'tu1', content: 'read:a:p1' }] })
    expect(h.events.map((e) => e.type)).toEqual(expect.arrayContaining(['tool.started', 'tool.completed']))
    expect((await h.svc.runs())[0].iterations).toBe(2)
  })

  it('asks before writing: allow once, deny, and "always" remembered per agent + tool', async () => {
    const h = await harness({
      script: [
        call('write_x', { v: '1', reason: 'save it' }, 'w1'),
        call('write_x', { v: '2', reason: 'again' }, 'w2'),
        call('write_x', { v: '3', reason: 'always' }, 'w3'),
        call('write_x', { v: '4', reason: 'granted now' }, 'w4'),
        say('ok')
      ]
    })
    const { conversationId } = await h.svc.send({ text: 'write' }, ipc)
    const answer = async (decision: 'once' | 'deny' | 'always') => {
      await h.waitFor(() => h.permissions.list().length === 1)
      const [req] = h.permissions.list()
      const live = h.pushed.filter((p) => p.channel === 'ai:message').at(-1)!.payload as { message: ChatMessage }
      expect(toolParts(live.message).at(-1)).toMatchObject({ status: 'awaiting-approval', requestId: expect.any(String) })
      // A client that missed the push (reconnecting) reads the same from the conversation, not the last saved copy.
      const now = await h.svc.conversation(conversationId)
      expect(now.running).toBe(true)
      expect(toolParts(now.messages.at(-1)!).at(-1)).toMatchObject({ status: 'awaiting-approval', requestId: req.id })
      expect(toolParts((await h.store.get(conversationId))!.messages.at(-1)!).at(-1)?.requestId).not.toBe(req.id)
      expect(req).toMatchObject({ agentName: 'Tester', toolTitle: 'Write X', risk: 'write', allowAlways: true })
      await h.permissions.respond(req.id, decision)
      return req
    }
    const r1 = await answer('once')
    expect(r1).toMatchObject({ summary: 'write 1', reason: 'save it' })
    await answer('deny')
    await answer('always')
    await h.svc.idle()
    const parts = toolParts(await h.reply(conversationId))
    expect(parts.map((p) => `${p.input && (p.input as { v: string }).v}:${p.status}`)).toEqual(['1:done', '2:denied', '3:done', '4:done'])
    expect(parts[1].output).toBe('The user denied this action.')
    expect(h.events.filter((e) => e.type === 'permission.requested')).toHaveLength(3) // the 4th was granted
  })

  it('a write tool without a reason field still asks (empty reason)', async () => {
    const h = await harness({ script: [call('tag_x', {}), say('ok')] })
    await h.svc.send({ text: 'x' }, ipc)
    await h.waitFor(() => h.permissions.list().length === 1)
    expect(h.permissions.list()[0].reason).toBe('')
    await h.permissions.respond(h.permissions.list()[0].id, 'once')
    await h.svc.idle()
  })

  it('commands always ask, never "always"; remote devices need the shell switch', async () => {
    const h = await harness({ script: [call('exec_x', { cmd: 'ls', reason: 'look' }, 'e1'), say('ok'), call('exec_x', { cmd: 'rm', reason: 'x' }, 'e2'), say('no')] })
    const { conversationId } = await h.svc.send({ text: 'run' }, ipc)
    await h.waitFor(() => h.permissions.list().length === 1)
    expect(h.permissions.list()[0].allowAlways).toBe(false)
    await h.permissions.respond(h.permissions.list()[0].id, 'always')
    await h.svc.idle()
    expect(toolParts(await h.reply(conversationId))[0]).toMatchObject({ status: 'done', output: 'ran:ls' })

    await h.svc.send({ conversationId, text: 'again' }, remote)
    await h.svc.idle()
    expect(toolParts(await h.reply(conversationId))[0]).toMatchObject({
      status: 'denied',
      output: 'Changing files and running commands is disabled for remote devices on this Mindeck core.'
    })

    const allowed = await harness({ remoteShell: true, script: [call('exec_x', { cmd: 'ls', reason: 'r' }), say('ok')] })
    const c = await allowed.svc.send({ text: 'x' }, remote)
    await allowed.waitFor(() => allowed.permissions.list().length === 1)
    await allowed.permissions.respond(allowed.permissions.list()[0].id, 'once')
    await allowed.svc.idle()
    expect(toolParts(await allowed.reply(c.conversationId))[0].status).toBe('done')
  })

  it('a remote run writes nothing without remote shells, and stays out of what devices may not reach', async () => {
    const tool = vi.fn(async (input: unknown) => {
      if ((input as { q?: string }).q === 'secret') throw Object.assign(new Error('.env is off-limits for paired devices'), { code: 'remote-forbidden' })
    })
    const h = await harness({ remoteAccess: { tool }, script: [call('write_x', { v: '1', reason: 'r' }, 'w1'), call('read_x', { q: 'ok' }, 'r1'), call('read_x', { q: 'secret' }, 'r2'), say('done')] })
    const { conversationId } = await h.svc.send({ text: 'x', projectId: 'p1' }, remote)
    await h.svc.idle()
    const parts = toolParts(await h.reply(conversationId))
    expect(parts.map((p) => p.status)).toEqual(['denied', 'done', 'denied'])
    expect(parts[2].output).toBe('.env is off-limits for paired devices')
    expect(tool).toHaveBeenCalledWith({ q: 'ok' }, 'p1')
    expect(h.permissions.list()).toEqual([])
    // The desktop's runs are never checked.
    const d = await harness({ remoteAccess: { tool }, script: [call('read_x', { q: 'secret' }), say('ok')] })
    await d.svc.send({ text: 'x' }, ipc)
    await d.svc.idle()
    expect(tool).toHaveBeenCalledTimes(2)
  })

  it('"always" holds in the tool’s project only', async () => {
    const h = await harness({
      script: [call('write_x', { v: '1', reason: 'r' }, 'w1'), call('write_x', { v: '2', reason: 'r' }, 'w2'), call('write_x', { v: '3', reason: 'r', projectId: 'p2' }, 'w3'), say('ok')]
    })
    await h.svc.send({ text: 'x', projectId: 'p1' }, ipc)
    await h.waitFor(() => h.permissions.list().length === 1)
    expect(h.permissions.list()[0].projectId).toBe('p1')
    await h.permissions.respond(h.permissions.list()[0].id, 'always')
    await h.waitFor(() => h.permissions.list().length === 1) // w2 ran unasked; w3 names another project
    expect(h.permissions.list()[0].projectId).toBe('p2')
    await h.permissions.respond(h.permissions.list()[0].id, 'once')
    await h.svc.idle()
    expect(await h.permissions.grants()).toEqual([expect.objectContaining({ agentId: 'tester', toolName: 'write_x', projectId: 'p1' })])
  })

  it('rejects unknown and not-allowlisted tools, invalid input and failing tools', async () => {
    const h = await harness({
      script: [
        async () =>
          turn(
            [
              { type: 'tool_call', id: 'a', name: 'missing_tool', input: {} },
              { type: 'tool_call', id: 'b', name: 'other_agent_tool', input: {} },
              { type: 'tool_call', id: 'c', name: 'read_x', input: { q: 5 } },
              { type: 'tool_call', id: 'd', name: 'boom', input: {} }
            ],
            'tool_use'
          ),
        say('sorry')
      ]
    })
    const { conversationId } = await h.svc.send({ text: 'x' }, ipc)
    await h.svc.idle()
    const parts = toolParts(await h.reply(conversationId))
    expect(parts.map((p) => [p.name, p.status, p.title])).toEqual([
      ['missing_tool', 'denied', 'missing_tool'],
      ['other_agent_tool', 'denied', 'Other'],
      ['read_x', 'error', 'Read X'],
      ['boom', 'error', 'Boom']
    ])
    expect(parts[0].output).toBe('The tool missing_tool is not available to the Tester agent.')
    expect(parts[2].output).toContain('Invalid input for read_x: q')
    expect(parts[3].output).toBe('Error: kaboom')
    const results = (await h.transcript(conversationId))[2].blocks
    expect(results.every((b) => b.type === 'tool_result' && b.isError)).toBe(true)
  })

  it('shows provider-side web tools as finished parts', async () => {
    const h = await harness({
      script: [
        async (_r, onText) => {
          onText('Searching.')
          return turn([{ type: 'text', text: 'Searching.' }, { type: 'opaque', data: { type: 'server_tool_use' } }], 'end_turn', {
            serverTools: [
              { id: 's1', name: 'web_search', input: { query: 'q' }, output: 'A — https://a' },
              { id: 's2', name: 'web_fetch', input: { url: 'u' } }
            ],
            model: 'claude-opus-4-8'
          })
        }
      ]
    })
    const { conversationId } = await h.svc.send({ text: 'research' }, ipc)
    await h.svc.idle()
    const m = await h.reply(conversationId)
    expect(toolParts(m).map((p) => [p.title, p.server, p.status])).toEqual([
      ['Web search', true, 'done'],
      ['Fetch page', true, 'done']
    ])
    expect(m.model).toBe('claude-opus-4-8') // served by the fallback model
  })
})

describe('AssistantService — limits, stop reasons, cancellation', () => {
  it('maps stop reasons: refusal, pause_turn, max_tokens', async () => {
    const h = await harness({
      script: [
        say('', 'refusal'),
        say('part one', 'pause_turn'),
        say(' part two', 'max_tokens'),
        call('read_x', { q: 'cut' }, 'x', undefined, 'max_tokens')
      ]
    })
    const a = await h.svc.send({ text: 'x' }, ipc)
    await h.svc.idle()
    expect(await h.reply(a.conversationId)).toMatchObject({ status: 'error', error: 'The model declined this request.' })
    const b = await h.svc.send({ text: 'y' }, ipc)
    await h.svc.idle()
    const mb = await h.reply(b.conversationId)
    expect(mb.status).toBe('done')
    expect((mb.parts[0] as { text: string }).text).toBe('part one part two\n\n_The answer hit the length limit._')
    const c = await h.svc.send({ text: 'z' }, ipc)
    await h.svc.idle()
    expect(await h.reply(c.conversationId)).toMatchObject({ status: 'error', error: 'A tool call was cut off by the length limit.' })
    // the unanswered tool call was closed so the history stays valid
    expect((await h.transcript(c.conversationId)).at(-1)).toEqual({
      role: 'user',
      blocks: [{ type: 'tool_result', callId: 'x', content: 'Interrupted before this tool ran.', isError: true }]
    })
  })

  it('stops at the iteration limit', async () => {
    const loop = Array.from({ length: 3 }, (_, i) => call('read_x', { q: String(i) }, `t${i}`))
    const h = await harness({ script: loop, agents: [agentDef({ maxIterations: 2 })] })
    const { conversationId } = await h.svc.send({ text: 'x' }, ipc)
    await h.svc.idle()
    const m = await h.reply(conversationId)
    expect(m.status).toBe('done')
    expect((m.parts.at(-1) as { text: string }).text).toContain('Stopped after 2 steps')
    expect(h.provider.stream).toHaveBeenCalledTimes(2)
  })

  it('cancels while streaming and while waiting for approval; times out; reports failures', async () => {
    const h = await harness({ script: [hang] })
    const a = await h.svc.send({ text: 'x' }, ipc)
    await tick(5)
    h.svc.cancel(a.conversationId)
    h.svc.cancel('not-running')
    await h.svc.idle()
    expect(await h.reply(a.conversationId)).toMatchObject({ status: 'cancelled' })
    expect(h.events.at(-1)?.type).toBe('agent.cancelled')

    const w = await harness({ script: [call('write_x', { v: '1', reason: 'r' }, 'w')] })
    const b = await w.svc.send({ text: 'x' }, ipc)
    await w.waitFor(() => w.permissions.list().length === 1)
    w.svc.cancel(b.conversationId)
    await w.svc.idle()
    const mb = await w.reply(b.conversationId)
    expect(mb.status).toBe('cancelled')
    expect(toolParts(mb)[0]).toMatchObject({ status: 'denied' })
    expect(w.permissions.list()).toEqual([])

    // a failure while a call is still open marks it interrupted
    const s = await harness({ script: [call('write_x', { v: '1', reason: 'r' }, 'w')] })
    vi.spyOn(s.permissions, 'isGranted').mockRejectedValueOnce(new Error('disk gone'))
    const c = await s.svc.send({ text: 'x' }, ipc)
    await s.svc.idle()
    const mc = await s.reply(c.conversationId)
    expect(mc).toMatchObject({ status: 'error', error: 'disk gone' })
    expect(toolParts(mc)[0]).toMatchObject({ status: 'error', output: 'Interrupted' })

    const t = await harness({ script: [hang], agents: [agentDef({ timeoutMs: 20 })] })
    const d = await t.svc.send({ text: 'x' }, ipc)
    await t.svc.idle()
    expect(await t.reply(d.conversationId)).toMatchObject({ status: 'error', error: 'Stopped: the run exceeded 0 minutes.' })
    expect((await t.svc.runs())[0].status).toBe('timeout')

    const f = await harness({ script: [async () => Promise.reject('plain failure')] })
    const e = await f.svc.send({ text: 'x' }, ipc)
    await f.svc.idle()
    expect(await f.reply(e.conversationId)).toMatchObject({ status: 'error', error: 'plain failure' })
    expect((await f.svc.runs())[0]).toMatchObject({ status: 'failed' })
    expect(f.events.at(-1)).toMatchObject({ type: 'agent.failed', payload: { error: 'plain failure' } })
  })

  it('removes conversations (stopping a running one) and disposes cleanly', async () => {
    const h = await harness({ script: [say('x'), hang, hang] })
    const a = await h.svc.send({ text: 'x' }, ipc)
    await h.svc.idle()
    await h.svc.remove(a.conversationId)
    expect(await h.svc.conversations()).toEqual([])
    expect(h.pushed.at(-1)).toEqual({ channel: 'ai:conversationsChanged', payload: { reason: 'deleted', id: a.conversationId } })

    const b = await h.svc.send({ text: 'y' }, ipc)
    await tick(5)
    await h.svc.remove(b.conversationId)
    expect(await h.svc.conversations()).toEqual([])

    await h.svc.send({ text: 'z' }, ipc)
    await tick(5)
    await h.svc.dispose()
    expect((await h.svc.conversations())[0].running).toBe(false)
  })
})

describe('closeOpenToolCalls', () => {
  it('only answers dangling tool calls of a final assistant message', () => {
    const t: LlmMessage[] = []
    closeOpenToolCalls(t)
    expect(t).toEqual([])
    const u: LlmMessage[] = [{ role: 'user', blocks: [] }]
    closeOpenToolCalls(u)
    expect(u).toHaveLength(1)
    const a: LlmMessage[] = [{ role: 'assistant', blocks: [{ type: 'text', text: 'x' }] }]
    closeOpenToolCalls(a)
    expect(a).toHaveLength(1)
  })
})
