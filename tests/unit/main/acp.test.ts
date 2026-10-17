import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type NewSessionRequest,
  type PromptCapabilities,
  type PromptRequest,
  type SessionUpdate
} from '@agentclientprotocol/sdk'
import { onCleanup, tempDir, tick } from './helpers'
import { ACP_AGENTS, acpApprovalRisk, acpSpawner, applyAcpUpdate, findAcpTool, isolatedNpx, kindRisk, openTurn, pickOption, spawnAcp, type AcpProcess } from '../../../electron/main/services/agents/acp'
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
    // Approvals: fetching and reading outside the session's folder count as changes (BE-SEC-17).
    expect(acpApprovalRisk('fetch', [], '/w')).toBe('write')
    expect(acpApprovalRisk('read', ['/w/src/a.ts', 'src/b.ts'], '/w')).toBe('read')
    expect(acpApprovalRisk('read', ['/w/a.ts', '/home/me/.ssh/id_ed25519'], '/w')).toBe('write')
    expect(acpApprovalRisk('search', ['../other'], '/w')).toBe('write')
    expect(acpApprovalRisk('edit', ['/etc/x'], '/w')).toBe('write')
    expect(acpApprovalRisk('execute', [], '/w')).toBe('execute')
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

  it('npx runs the adapter from a folder of Mindeck’s — never a copy (or a registry) a cloned repository brings', async () => {
    expect(isolatedNpx(ACP_AGENTS.codex, '/data/agents/npm')).toEqual({ ...ACP_AGENTS.codex, args: ['--prefix', '/data/agents/npm', '-y', '@zed-industries/codex-acp@0.16.0'] })
    expect(isolatedNpx(ACP_AGENTS.codex)).toBe(ACP_AGENTS.codex)
    expect(isolatedNpx(ACP_AGENTS.gemini, '/data/agents/npm')).toBe(ACP_AGENTS.gemini)
    // Exactly one version, never a range.
    expect(ACP_AGENTS.codex.args[1]).toMatch(/@\d+\.\d+\.\d+$/)
    // The adapter itself still runs in the agent's folder.
    const cwd = await tempDir()
    const proc = acpSpawner('/data/agents/npm')({ file: process.execPath, args: [agent] }, cwd, { ...process.env } as Record<string, string>)
    expect(await handshake(proc, cwd)).toBe(`from ${cwd}`)
    proc.kill()
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
})

// --- the service with an in-process ACP agent ----------------------------------

interface FakeAgent {
  proc: AcpProcess
  newSession: NewSessionRequest[]
  prompts: PromptRequest[]
  cancel: Mock
  /** What the agent does on a prompt (it can call back into the client). */
  onPrompt: (conn: AgentSideConnection, req: PromptRequest) => Promise<{ stopReason: 'end_turn' | 'cancelled' }>
  /** Model and mode switches it was asked for. */
  switched: unknown[]
  conn?: AgentSideConnection
}

interface FakeOpts {
  http?: boolean
  failInit?: boolean
  hangInit?: boolean
  slowInit?: Promise<void>
  /** What `session/new` answers besides the id (modes, config options, legacy models). */
  setup?: Record<string, unknown>
  caps?: PromptCapabilities
  /** Switching fails. */
  failSwitch?: boolean
}

function fakeAgent(opts: FakeOpts = {}): FakeAgent {
  const c2a = new TransformStream<Uint8Array>()
  const a2c = new TransformStream<Uint8Array>()
  let exit: ((code: number) => void) | undefined
  const fake: FakeAgent = {
    proc: { stream: ndJsonStream(c2a.writable, a2c.readable), kill: vi.fn(() => exit?.(0)), onExit: (cb) => (exit = cb) },
    newSession: [],
    prompts: [],
    cancel: vi.fn(),
    onPrompt: async () => ({ stopReason: 'end_turn' }),
    switched: []
  }
  const sw = (what: unknown) => {
    if (opts.failSwitch) throw new Error('cannot switch')
    fake.switched.push(what)
  }
  new AgentSideConnection(
    (conn) => ({
      initialize: async () => {
        fake.conn = conn
        if (opts.failInit) throw new Error('not signed in')
        if (opts.hangInit) await new Promise(() => {})
        if (opts.slowInit) await opts.slowInit
        return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { mcpCapabilities: { http: !!opts.http }, ...(opts.caps ? { promptCapabilities: opts.caps } : {}) } }
      },
      newSession: async (req) => {
        fake.newSession.push(req)
        return { sessionId: 'acp-1', ...opts.setup }
      },
      setSessionMode: async (req) => {
        sw({ mode: req.modeId })
        return {}
      },
      setSessionConfigOption: async (req) => {
        sw({ config: req.configId, value: req.value })
        const options = (opts.setup?.configOptions ?? []) as { id: string; currentValue: unknown }[]
        return { configOptions: options.map((o) => (o.id === req.configId ? { ...o, currentValue: req.value } : o)) as never }
      },
      extMethod: async (method, params) => {
        sw({ method, ...params })
        return {}
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

async function acpSetup(agentOpts: FakeOpts = {}) {
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
    t.granted.add('read') // granted by kind, whatever the title says
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
    expect(t.asks[0].input).toMatchObject({ agentId: 'codex', risk: 'execute', allowAlways: false, toolName: 'execute', toolTitle: 'npm test' })
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
      // A tool call that names no kind: nothing to keep, the request decides.
      await conn.sessionUpdate({ sessionId: req.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'plain', title: 'Think' } })
      answers.push(await conn.requestPermission({ sessionId: req.sessionId, toolCall: { toolCallId: 'unseen' }, options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }] }))
      // Reading outside the folder counts as a change (BE-SEC-17).
      answers.push(await conn.requestPermission({ sessionId: req.sessionId, toolCall: { toolCallId: 'r', title: 'Read key', kind: 'read', locations: [{ path: '/etc/ssh/ssh_host_rsa_key' }] }, options: [{ optionId: 'no', name: 'Reject', kind: 'reject_once' }] }))
      return { stopReason: 'cancelled' }
    }
    t.svc.send(s.id, 'edit it')
    await t.settled(s.id, 'approval')
    expect(t.asks[0].input).toMatchObject({ agentId: 'gemini', risk: 'write', allowAlways: true })
    t.asks[0].settle('deny')
    while (t.asks.length < 2) await tick(5)
    expect(t.asks[1].input).toMatchObject({ toolName: 'other', toolTitle: 'tool', risk: 'execute' })
    t.asks[1].settle('deny') // no reject option offered → cancelled
    while (t.asks.length < 3) await tick(5)
    expect(t.asks[2].input).toMatchObject({ toolName: 'read', risk: 'write' })
    t.asks[2].settle('deny')
    await t.settled(s.id, 'idle')
    expect(answers).toEqual([{ outcome: { outcome: 'selected', optionId: 'no' } }, { outcome: { outcome: 'cancelled' } }, { outcome: { outcome: 'selected', optionId: 'no' } }])
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
    await expect(t.svc.send(s.id, 'x')).rejects.toMatchObject({ code: 'not-running' })

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
    failing.svc.interrupt(s3.id) // the handshake fails: nothing to cancel, nothing thrown
    failing.svc.stop(s3.id) // stopped before the failed handshake reports
    await tick(20)
    expect(failing.svc.get(s3.id).error).toBeUndefined()
  })
})

describe('ACP agents in the composer: models, modes, commands, references, images, pushes', () => {
  const png = { name: 'shot.png', mimeType: 'image/png' as const, data: Buffer.from('png').toString('base64') }
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i += 1) await tick(5)
    expect(fn()).toBe(true)
  }
  const configOptions = [
    { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'gpt-5', options: [{ value: 'gpt-5', name: 'GPT-5' }, { value: 'gpt-5-mini', name: 'GPT-5 mini' }] },
    { id: 'approval', name: 'Approval', type: 'select', category: 'mode', currentValue: 'ask', options: [{ value: 'ask', name: 'Ask' }, { value: 'auto', name: 'Auto' }] }
  ]

  it('offers the agent\'s models, modes and commands, takes the wished model, switches through config options', async () => {
    const t = await acpSetup({ setup: { configOptions }, caps: { image: true } })
    const s = await t.svc.create({ kind: 'codex', projectId: 'p1', model: 'gpt-5-mini' })
    expect(s).toMatchObject({ model: 'gpt-5-mini', models: undefined }) // a wish until the agent answers
    await t.settled(s.id, 'idle')
    await until(() => t.svc.get(s.id).model === 'gpt-5-mini')
    expect(t.agents[0].switched).toEqual([{ config: 'model', value: 'gpt-5-mini' }])
    expect(t.svc.get(s.id)).toMatchObject({
      images: true,
      mode: 'ask',
      models: [{ id: 'gpt-5', name: 'GPT-5' }, { id: 'gpt-5-mini', name: 'GPT-5 mini' }],
      modes: [{ id: 'ask', name: 'Ask' }, { id: 'auto', name: 'Auto' }]
    })
    expect(await t.svc.configure(s.id, { mode: 'auto' })).toMatchObject({ mode: 'auto' })
    await expect(t.svc.configure(s.id, { mode: 'yolo' })).rejects.toMatchObject({ code: 'bad-input' })

    // The agent tells about its commands and its own switches.
    const conn = t.agents[0].conn!
    await conn.sessionUpdate({ sessionId: 'acp-1', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review changes', input: { hint: 'branch' } }] } })
    await conn.sessionUpdate({ sessionId: 'acp-1', update: { sessionUpdate: 'current_mode_update', currentModeId: 'ask' } })
    await conn.sessionUpdate({ sessionId: 'acp-1', update: { sessionUpdate: 'config_option_update', configOptions: [{ ...configOptions[0], currentValue: 'gpt-5' }] as never } })
    await until(() => t.svc.get(s.id).model === 'gpt-5')
    expect(t.svc.get(s.id)).toMatchObject({ commands: [{ name: 'review', description: 'Review changes', hint: 'branch' }], mode: 'ask' })

    // Stopped: what the agent says late changes nothing.
    t.svc.stop(s.id)
    await conn.sessionUpdate({ sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } } })
    await tick(10)
    expect(t.svc.get(s.id).messages).toEqual([])
  })

  it('legacy models and session modes switch by their own methods; the choice survives a resume', async () => {
    const setup = {
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'yolo', name: 'YOLO' }] },
      models: { currentModelId: 'pro', availableModels: [{ modelId: 'pro', name: 'Pro' }, { modelId: 'flash', name: 'Flash' }] }
    }
    const t = await acpSetup({ setup })
    const s = await t.svc.create({ kind: 'gemini', projectId: 'p1' })
    await t.settled(s.id, 'idle')
    expect(t.svc.get(s.id)).toMatchObject({ model: 'pro', mode: 'default', images: false })
    await t.svc.configure(s.id, { model: 'flash', mode: 'yolo' })
    expect(t.agents[0].switched).toEqual([{ method: 'session/set_model', sessionId: 'acp-1', modelId: 'flash' }, { mode: 'yolo' }])
    expect(t.svc.get(s.id)).toMatchObject({ model: 'flash', mode: 'yolo' })

    t.svc.stop(s.id)
    await t.svc.configure(s.id, { mode: 'default' }) // not running: for the next start
    await t.svc.resume(s.id)
    await t.settled(s.id, 'idle')
    await until(() => t.agents[1].switched.length === 1)
    expect(t.agents[1].switched).toEqual([{ method: 'session/set_model', sessionId: 'acp-1', modelId: 'flash' }]) // the mode is the agent's default anyway
    await until(() => t.svc.get(s.id).model === 'flash')
  })

  it('nothing to switch: an error while it runs; a wish it can\'t take is logged', async () => {
    const none = await acpSetup()
    const s = await none.svc.create({ kind: 'codex', projectId: 'p1', model: 'gpt-5' })
    await none.settled(s.id, 'idle')
    await expect(none.svc.configure(s.id, { model: 'other' })).rejects.toMatchObject({ code: 'unsupported' })
    expect(none.svc.get(s.id).model).toBe('gpt-5')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = await acpSetup({ failSwitch: true, setup: { modes: { currentModeId: 'a', availableModes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } } })
    const s2 = await failing.svc.create({ kind: 'codex', projectId: 'p1', mode: 'b', model: 'unknown' })
    await failing.settled(s2.id, 'idle')
    await until(() => warn.mock.calls.some(([m]) => m === '[agents] mode not switched:'))
    expect(failing.svc.get(s2.id).mode).toBe('a')
  })

  it('sends references as resource links and images when the agent takes them; the chat shows them', async () => {
    const t = await acpSetup({ caps: { image: true } })
    const s = await t.svc.create({ kind: 'codex', projectId: 'p1' })
    await t.settled(s.id, 'idle')
    await t.svc.send(s.id, 'See', { refs: [{ kind: 'file', path: 'a.ts' }], images: [png] })
    await until(() => t.agents[0].prompts.length === 1)
    expect(t.agents[0].prompts[0].prompt).toEqual([
      { type: 'text', text: 'See' },
      { type: 'resource_link', uri: pathToFileURL(join(t.dir, 'a.ts')).href, name: 'a.ts' },
      { type: 'image', mimeType: 'image/png', data: png.data }
    ])
    expect(t.svc.get(s.id).messages[0]).toMatchObject({ role: 'user', attachments: [{ kind: 'file', label: 'a.ts' }, { kind: 'image', label: 'shot.png' }] })
    await t.settled(s.id, 'idle')
    await t.svc.send(s.id, 'plain')
    await until(() => t.agents[0].prompts.length === 2)
    expect(t.svc.get(s.id).messages[2].attachments).toBeUndefined()

    const blind = await acpSetup()
    const s2 = await blind.svc.create({ kind: 'gemini', projectId: 'p1' })
    await expect(blind.svc.send(s2.id, 'x', { images: [png] })).rejects.toMatchObject({ code: 'images-unsupported' }) // waits for the handshake first
  })

  it('approvals are kept by the tool\'s kind (from its tool call when the request leaves it out); pushes name the kind, never the title', async () => {
    const t = await acpSetup()
    const push = vi.fn()
    t.deps.push = push
    const s = await t.svc.create({ kind: 'codex', projectId: 'p1' })
    await t.settled(s.id, 'idle')
    const options = [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' as const }]
    t.agents[0].onPrompt = async (conn, req) => {
      await conn.sessionUpdate({ sessionId: req.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'w', title: 'Write secrets.env', kind: 'edit' } })
      await conn.requestPermission({ sessionId: req.sessionId, toolCall: { toolCallId: 'w' }, options })
      t.granted.add('edit') // the user chose "Always allow"
      await conn.requestPermission({ sessionId: req.sessionId, toolCall: { toolCallId: 'w2', title: 'Write b.ts', kind: 'edit' }, options })
      throw new Error('boom')
    }
    await t.svc.send(s.id, 'go')
    await until(() => t.asks.length === 1)
    expect(t.asks[0].input).toMatchObject({ toolName: 'edit', toolTitle: 'Write secrets.env', risk: 'write', allowAlways: true })
    expect(push).toHaveBeenLastCalledWith({ kind: 'approval', title: 'Codex', body: 'Edit files · Waiting for your approval · Demo', sessionId: s.id })
    t.asks[0].settle('always')
    await t.settled(s.id, 'idle')
    expect(t.asks).toHaveLength(1) // the second edit was not asked
    expect(push).toHaveBeenLastCalledWith({ kind: 'agent_error', title: 'Codex', body: 'Stopped with an error · Demo', sessionId: s.id })
    expect(t.deps.notify).toHaveBeenLastCalledWith('Codex', 'Stopped with an error', s.id)

    const failing = await acpSetup({ failInit: true })
    failing.deps.push = vi.fn()
    await failing.svc.create({ kind: 'codex', projectId: 'p1' })
    await until(() => (failing.deps.push as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    expect(failing.deps.push).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agent_error' }))
  })
})
