import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type NewSessionRequest,
  type PromptRequest,
  type SessionUpdate
} from '@agentclientprotocol/sdk'
import { onCleanup, tempDir, tick } from './helpers'
import { ACP_AGENTS, applyAcpUpdate, findAcpTool, kindRisk, openTurn, pickOption, spawnAcp, type AcpProcess } from '../../../electron/main/services/agents/acp'
import { AgentSessionService, type AgentSessionDeps } from '../../../electron/main/services/agents/AgentSessionService'
import { GitService } from '../../../electron/main/services/git/GitService'
import type { SessionState } from '../../../electron/main/services/agents/transcript'
import type { ApprovalDecision, ToolCallPart } from '../../../src/shared/types/ai'

const fresh = (): SessionState => ({ status: 'idle', messages: [], plan: [] })

describe('ACP updates → chat, tools, plan', () => {
  it('streams text into one part, adds and updates tool cards, takes the plan', () => {
    const s = fresh()
    const up = (u: SessionUpdate) => applyAcpUpdate(s, u)
    expect(up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } }).changed).toHaveLength(1)
    up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } })
    expect(s.messages[0].parts).toEqual([{ type: 'text', text: 'Hello' }])
    expect(s.status).toBe('working')
    expect(up({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x', mimeType: 'image/png' } }).changed).toEqual([])

    up({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run npm test', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } })
    up({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Read a.ts' })
    const tool = (id: string) => findAcpTool(s, id)!.part
    expect(tool('t1')).toMatchObject({ name: 'Run npm test', risk: 'execute', status: 'running', input: { command: 'npm test' } })
    expect(tool('t2')).toMatchObject({ risk: 'execute', status: 'running', input: {} })
    up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after the tools' } })
    expect(s.messages[0].parts.at(-1)).toEqual({ type: 'text', text: 'after the tools' }) // a new text part

    const updated = up({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', title: 'Ran npm test', rawOutput: { code: 0 } })
    expect(updated.changed[0]).toBe(s.messages[0])
    expect(tool('t1')).toMatchObject({ status: 'done', title: 'Ran npm test', output: '{\n "code": 0\n}' })
    up({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: null, title: null, rawOutput: null })
    expect(tool('t2')).toMatchObject({ status: 'running', title: 'Read a.ts' })
    expect(tool('t2').output).toBeUndefined()
    up({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'failed', rawOutput: 'x'.repeat(4100) })
    expect(tool('t2').status).toBe('error')
    expect(tool('t2').output).toMatch(/\[100 more characters\]$/)
    expect(up({ sessionUpdate: 'tool_call_update', toolCallId: 'nope', status: 'completed' }).changed).toEqual([])

    up({ sessionUpdate: 'plan', entries: [{ content: 'a', status: 'completed', priority: 'high' }, { content: 'b', status: 'pending', priority: 'low' }] })
    expect(s.plan).toEqual([
      { id: 'plan-0', text: 'a', done: true },
      { id: 'plan-1', text: 'b', done: false }
    ])
    expect(up({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }).changed).toEqual([])
  })

  it('risk per tool kind; picking the agent\'s option for a decision; turns open once', () => {
    expect((['read', 'search', 'think', 'fetch', 'edit', 'delete', 'move', 'execute', 'other', undefined, null] as const).map(kindRisk)).toEqual([
      'read', 'read', 'read', 'read', 'write', 'write', 'write', 'execute', 'execute', 'execute', 'execute'
    ])
    const options = [
      { optionId: 'a1', name: 'Allow', kind: 'allow_once' as const },
      { optionId: 'aa', name: 'Always', kind: 'allow_always' as const },
      { optionId: 'r1', name: 'Reject', kind: 'reject_once' as const }
    ]
    expect(pickOption(options, 'once')).toBe('a1')
    expect(pickOption(options, 'always')).toBe('aa')
    expect(pickOption(options, 'deny')).toBe('r1')
    expect(pickOption([options[1]], 'once')).toBe('aa')
    expect(pickOption([options[0]], 'always')).toBe('a1')
    expect(pickOption([options[0]], 'deny')).toBeUndefined()
    const s = fresh()
    expect(openTurn(s)).toBe(openTurn(s))
    expect(ACP_AGENTS.gemini.args).toEqual(['--experimental-acp'])
  })
})

describe('spawnAcp', () => {
  const agent = join(__dirname, 'fixtures', 'acp-agent.mjs')
  const handshake = async (proc: AcpProcess, cwd: string) => {
    const conn = new ClientSideConnection(() => ({ requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }), sessionUpdate: async () => {} }), proc.stream)
    await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    return (await conn.newSession({ cwd, mcpServers: [] })).sessionId
  }

  it('runs the agent through the login shell and speaks ACP over its stdio; kill ends it', async () => {
    const cwd = await tempDir()
    const proc = spawnAcp({ file: process.execPath, args: [agent] }, cwd, { ...process.env } as Record<string, string>)
    expect(await handshake(proc, cwd)).toBe(`from ${cwd}`)
    const exited = new Promise<number>((r) => proc.onExit(r))
    proc.kill()
    expect(typeof (await exited)).toBe('number')
  })

  it('on Windows starts the agent directly', async () => {
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const cwd = await tempDir()
      const proc = spawnAcp({ file: process.execPath, args: [agent] }, cwd, { ...process.env } as Record<string, string>)
      expect(await handshake(proc, cwd)).toBe(`from ${cwd}`)
      proc.kill()
    } finally {
      Object.defineProperty(process, 'platform', { value: platform })
    }
  })

  it('an agent that cannot start ends like one that exited — no uncaught error', async () => {
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' }) // spawned directly: the spawn itself fails
    try {
      const cwd = await tempDir()
      const proc = spawnAcp({ file: join(cwd, 'no-such-agent'), args: [] }, cwd, { ...process.env } as Record<string, string>)
      const code = await new Promise<number>((r) => proc.onExit(r))
      expect(code).not.toBe(0)
    } finally {
      Object.defineProperty(process, 'platform', { value: platform })
    }
  })

  it('a failed start that reports no exit code still ends as a failure', async () => {
    // Node reports the errno as the code; should a platform report none, it must not read as success (0).
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, kill: () => true })
    vi.resetModules()
    vi.doMock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:child_process')>()), spawn: () => child }))
    try {
      const { spawnAcp: spawnFailing } = await import('../../../electron/main/services/agents/acp')
      const proc = spawnFailing({ file: 'missing-agent', args: [] }, await tempDir(), {})
      const exited = new Promise<number>((r) => proc.onExit(r))
      child.emit('error', Object.assign(new Error('spawn missing-agent ENOENT'), { code: 'ENOENT' }))
      child.emit('close', null, null)
      expect(await exited).toBe(1)
    } finally {
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })
})

// --- the service with an in-process ACP agent ----------------------------------

interface FakeAgent {
  proc: AcpProcess
  newSession: NewSessionRequest[]
  prompts: PromptRequest[]
  cancel: ReturnType<typeof vi.fn>
  /** What the agent does on a prompt (it can call back into the client). */
  onPrompt: (conn: AgentSideConnection, req: PromptRequest) => Promise<{ stopReason: 'end_turn' | 'cancelled' }>
}

function fakeAgent(opts: { http?: boolean; failInit?: boolean; hangInit?: boolean; slowInit?: Promise<void> } = {}): FakeAgent {
  const c2a = new TransformStream<Uint8Array>()
  const a2c = new TransformStream<Uint8Array>()
  let exit: ((code: number) => void) | undefined
  const fake: FakeAgent = {
    proc: { stream: ndJsonStream(c2a.writable, a2c.readable), kill: vi.fn(() => exit?.(0)), onExit: (cb) => (exit = cb) },
    newSession: [],
    prompts: [],
    cancel: vi.fn(),
    onPrompt: async () => ({ stopReason: 'end_turn' })
  }
  new AgentSideConnection(
    (conn) => ({
      initialize: async () => {
        if (opts.failInit) throw new Error('not signed in')
        if (opts.hangInit) await new Promise(() => {})
        if (opts.slowInit) await opts.slowInit
        return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { mcpCapabilities: { http: !!opts.http } } }
      },
      newSession: async (req) => {
        fake.newSession.push(req)
        return { sessionId: 'acp-1' }
      },
      authenticate: async () => ({}),
      prompt: async (req) => {
        fake.prompts.push(req)
        return fake.onPrompt(conn, req)
      },
      cancel: async (n) => void fake.cancel(n)
    }),
    ndJsonStream(a2c.writable, c2a.readable)
  )
  return fake
}

async function acpSetup(agentOpts: Parameters<typeof fakeAgent>[0] = {}) {
  const dir = await tempDir('mindeck-acp-')
  const agents: FakeAgent[] = []
  const asks: { input: { agentId: string; risk: string; allowAlways: boolean; toolName: string }; settle: (d: ApprovalDecision) => void }[] = []
  const granted = new Set<string>()
  const published: { channel: string; payload: unknown }[] = []
  const deps: AgentSessionDeps = {
    dir: join(dir, 'agents'),
    worktreesDir: join(dir, 'wt'),
    terminal: { spawnProgram: vi.fn(), write: vi.fn(), kill: vi.fn() } as never,
    git: new GitService(),
    server: { register: () => 'tok', unregister: vi.fn(), url: (route, id) => `http://127.0.0.1:1/${route}/${id}` },
    permissions: {
      ask: (input) => {
        let settle!: (d: ApprovalDecision) => void
        const decision = new Promise<ApprovalDecision>((r) => (settle = r))
        asks.push({ input: input as never, settle })
        return { id: `req-${asks.length}`, decision }
      },
      isGranted: async (_agent, tool) => granted.has(tool)
    },
    events: { emit: vi.fn() as never },
    projects: () => ({ name: 'Demo', path: dir }),
    publish: (channel, payload) => void published.push({ channel, payload }),
    mcp: vi.fn(),
    journal: vi.fn(async () => undefined),
    notify: vi.fn(),
    spawnAcp: vi.fn(() => {
      const a = fakeAgent(agentOpts)
      agents.push(a)
      return a.proc
    })
  }
  const svc = new AgentSessionService(deps)
  onCleanup(() => svc.dispose())
  await svc.init()
  const settled = async (id: string, status: string) => {
    for (let i = 0; i < 100 && svc.get(id).status !== status; i += 1) await tick(5)
    expect(svc.get(id).status).toBe(status)
  }
  return { svc, deps, agents, asks, granted, published, dir, settled }
}

describe('AgentSessionService with ACP agents (Codex, Gemini)', () => {
  it('starts the agent, hands it Mindeck\'s memory, streams a turn with an approval and a plan', async () => {
    const t = await acpSetup({ http: true })
    t.granted.add('Read a.ts')
    const s = await t.svc.create({ kind: 'codex', projectId: 'p1', prompt: 'Run the tests' })
    expect(s).toMatchObject({ kind: 'codex', live: true, status: 'starting', terminalId: undefined })
    expect(t.deps.spawnAcp).toHaveBeenCalledWith(ACP_AGENTS.codex, t.dir, expect.any(Object))
    const agent = t.agents[0]
    agent.onPrompt = async (conn, req) => {
      await conn.sessionUpdate({ sessionId: req.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Running them.' } } })
      await conn.sessionUpdate({ sessionId: req.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'npm test', kind: 'execute', status: 'pending' } })
      const options = [
        { optionId: 'ok', name: 'Allow', kind: 'allow_once' as const },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' as const }
      ]
      const answer = await conn.requestPermission({ sessionId: req.sessionId, toolCall: { toolCallId: 'x', title: 'npm test', kind: 'execute' }, options })
      expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'ok' } })
      // a granted read tool is not asked again
      const read = await conn.requestPermission({ sessionId: req.sessionId, toolCall: { toolCallId: 'r', title: 'Read a.ts', kind: 'read' }, options })
      expect(read).toEqual({ outcome: { outcome: 'selected', optionId: 'ok' } })
      await conn.sessionUpdate({ sessionId: req.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'completed', rawOutput: 'ok' } })
      await conn.sessionUpdate({ sessionId: req.sessionId, update: { sessionUpdate: 'plan', entries: [{ content: 'run tests', status: 'completed', priority: 'medium' }] } })
      return { stopReason: 'end_turn' }
    }
    await t.settled(s.id, 'approval')
    expect(agent.newSession[0]).toMatchObject({ cwd: t.dir, mcpServers: [{ type: 'http', name: 'mindeck', url: `http://127.0.0.1:1/mcp/${s.id}`, headers: [{ name: 'Authorization', value: 'Bearer tok' }] }] })
    expect(agent.prompts[0]).toMatchObject({ sessionId: 'acp-1', prompt: [{ type: 'text', text: 'Run the tests' }] })
    expect(t.asks[0].input).toMatchObject({ agentId: 'codex', risk: 'execute', allowAlways: false, toolName: 'npm test' })
    expect((t.svc.get(s.id).messages[1].parts[1] as ToolCallPart).requestId).toBe('req-1')
    t.asks[0].settle('once')
    await t.settled(s.id, 'idle')
    const detail = t.svc.get(s.id)
    expect(detail.messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'done'],
      ['assistant', 'done']
    ])
    expect(detail.messages[1].parts[0]).toEqual({ type: 'text', text: 'Running them.' })
    expect(detail.messages[1].parts[1]).toMatchObject({ status: 'done', output: 'ok' })
    expect(detail.plan).toEqual([{ id: 'plan-0', text: 'run tests', done: true }])
    expect(t.deps.notify).toHaveBeenLastCalledWith('Codex', 'Done — your turn', s.id)
    expect(t.asks).toHaveLength(1)
  })

  it('denies, cancels when no option fits, interrupts, records failed and cancelled turns', async () => {
    const t = await acpSetup()
    const s = await t.svc.create({ kind: 'gemini', projectId: 'p1' })
    await t.settled(s.id, 'idle')
    const agent = t.agents[0]
    expect(agent.newSession[0].mcpServers).toEqual([]) // no HTTP MCP support: no memory server
    expect(t.deps.spawnAcp).toHaveBeenCalledWith(ACP_AGENTS.gemini, t.dir, expect.any(Object))

    const answers: unknown[] = []
    agent.onPrompt = async (conn, req) => {
      await conn.sessionUpdate({ sessionId: req.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'e', title: 'Edit a.ts', kind: 'edit' } })
      answers.push(await conn.requestPermission({ sessionId: req.sessionId, toolCall: { toolCallId: 'e', title: 'Edit a.ts', kind: 'edit' }, options: [{ optionId: 'no', name: 'Reject', kind: 'reject_once' }] }))
      answers.push(await conn.requestPermission({ sessionId: req.sessionId, toolCall: { toolCallId: 'unseen' }, options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }] }))
      return { stopReason: 'cancelled' }
    }
    t.svc.send(s.id, 'edit it')
    await t.settled(s.id, 'approval')
    expect(t.asks[0].input).toMatchObject({ agentId: 'gemini', risk: 'write', allowAlways: true })
    t.asks[0].settle('deny')
    while (t.asks.length < 2) await tick(5)
    expect(t.asks[1].input).toMatchObject({ toolName: 'tool', risk: 'execute' })
    t.asks[1].settle('deny') // no reject option offered → cancelled
    await t.settled(s.id, 'idle')
    expect(answers).toEqual([{ outcome: { outcome: 'selected', optionId: 'no' } }, { outcome: { outcome: 'cancelled' } }])
    expect(t.svc.get(s.id).messages[1].parts[0]).toMatchObject({ id: 'e', status: 'denied' })
    expect(t.svc.get(s.id).messages[1].status).toBe('cancelled')

    agent.onPrompt = async () => {
      throw new Error('model overloaded')
    }
    t.svc.send(s.id, 'again')
    await tick(30)
    await t.settled(s.id, 'idle')
    expect(t.svc.get(s.id).messages[3]).toMatchObject({ status: 'error', error: 'Internal error' }) // how the SDK reports an agent's crash

    t.svc.interrupt(s.id)
    await tick(20)
    expect(agent.cancel).toHaveBeenCalledWith({ sessionId: 'acp-1' })
  })

  it('a failed start is an error; stop ends it; resume starts the agent again', async () => {
    const t = await acpSetup({ failInit: true })
    const s = await t.svc.create({ kind: 'codex', projectId: 'p1', prompt: 'x' })
    await t.settled(s.id, 'ended')
    expect(t.svc.get(s.id)).toMatchObject({ live: false, error: expect.stringContaining('Codex could not start') })
    expect(t.agents[0].proc.kill).toHaveBeenCalled()
    expect(() => t.svc.send(s.id, 'x')).toThrow(expect.objectContaining({ code: 'not-running' }))

    const ok = await acpSetup()
    const s2 = await ok.svc.create({ kind: 'codex', projectId: 'p1' })
    await ok.settled(s2.id, 'idle')
    ok.svc.stop(s2.id)
    expect(ok.svc.get(s2.id)).toMatchObject({ live: false, status: 'ended' })
    await ok.svc.resume(s2.id)
    expect(ok.agents).toHaveLength(2)
    await ok.settled(s2.id, 'idle')
    expect(await ok.svc.resume(s2.id)).toMatchObject({ live: true }) // already running
    ok.agents[0].proc.kill() // the old process reports its end late: the resumed agent keeps running
    expect(ok.svc.get(s2.id)).toMatchObject({ live: true, status: 'idle' })
  })

  it('stopping in the middle: a late handshake or a late answer changes nothing', async () => {
    const hang = await acpSetup({ hangInit: true })
    const s = await hang.svc.create({ kind: 'codex', projectId: 'p1' })
    hang.svc.interrupt(s.id) // waits for a handshake that never comes: harmless
    hang.svc.stop(s.id)
    expect(hang.svc.get(s.id).status).toBe('ended')

    const t = await acpSetup()
    const s2 = await t.svc.create({ kind: 'codex', projectId: 'p1' })
    await t.settled(s2.id, 'idle')
    let release!: () => void
    t.agents[0].onPrompt = () => new Promise((r) => (release = () => r({ stopReason: 'end_turn' })))
    t.svc.send(s2.id, 'long task')
    while (!t.agents[0].prompts.length) await tick(5)
    const first = t.agents[0]
    t.svc.stop(s2.id)
    await t.svc.resume(s2.id) // a new agent; the old turn's end must not touch it
    release()
    await tick(20)
    expect(t.svc.get(s2.id).status).not.toBe('error')
    expect(first.proc.kill).toHaveBeenCalled()

    let ready!: () => void
    const slow = await acpSetup({ slowInit: new Promise<void>((r) => (ready = r)) })
    const s4 = await slow.svc.create({ kind: 'codex', projectId: 'p1', prompt: 'hello' })
    slow.svc.stop(s4.id) // stopped before the handshake finished
    ready()
    await tick(20)
    expect(slow.svc.get(s4.id).status).toBe('ended')
    expect(slow.agents[0].prompts).toEqual([]) // the first message was never sent

    const failing = await acpSetup({ failInit: true })
    const s3 = await failing.svc.create({ kind: 'codex', projectId: 'p1' })
    failing.svc.stop(s3.id) // stopped before the failed handshake reports
    await tick(20)
    expect(failing.svc.get(s3.id).error).toBeUndefined()
  })
})
