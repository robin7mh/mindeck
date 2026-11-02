import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onCleanup, tempDir, tick } from './helpers'
import { AgentSessionService, type AgentSessionDeps } from '../../../electron/main/services/agents/AgentSessionService'
import { GitService } from '../../../electron/main/services/git/GitService'
import type { ApprovalDecision } from '../../../src/shared/types/ai'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

async function gitProject(): Promise<string> {
  const dir = await tempDir('mindeck-agent-proj-')
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'user.email', 't@t')
  sh(dir, 'config', 'user.name', 'T')
  await writeFile(join(dir, 'app.ts'), 'export const a = 1\n')
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'init')
  return dir
}


/** Everything around the service, faked at its seams; git is real. */
async function setup(opts: { projectPath?: string; projectName?: string; probe?: AgentSessionDeps['probe'] } = {}) {
  const dir = await tempDir('mindeck-agents-')
  const projectPath = opts.projectPath ?? (await gitProject())
  const exits = new Map<string, (code: number) => void>()
  let seq = 0
  const terminal = {
    spawned: [] as Parameters<AgentSessionDeps['terminal']['spawnProgram']>[0][],
    fail: false,
    spawnProgram: vi.fn(async (req: Parameters<AgentSessionDeps['terminal']['spawnProgram']>[0]) => {
      if (terminal.fail) throw new Error('spawn failed')
      terminal.spawned.push(req)
      const id = `pty-${++seq}`
      exits.set(id, req.onExit!)
      return { id, title: req.title, cwd: req.cwd, cwdLabel: req.cwd, shell: 'zsh', createdAt: '', kind: 'agent' as const }
    }),
    write: vi.fn(),
    kill: vi.fn((id: string) => exits.get(id)?.(0))
  }
  const asks: { input: { toolName: string; risk: string; allowAlways: boolean; summary: string }; settle: (d: ApprovalDecision) => void }[] = []
  const granted = new Set<string>()
  const permissions = {
    ask: vi.fn((input: never) => {
      let settle!: (d: ApprovalDecision) => void
      const decision = new Promise<ApprovalDecision>((r) => (settle = r))
      asks.push({ input, settle })
      return { id: `req-${asks.length}`, decision }
    }),
    isGranted: vi.fn(async (_agent: string, tool: string) => granted.has(tool))
  }
  const published: { channel: string; payload: unknown }[] = []
  const journal = vi.fn(async (folder: string, title: string, path: string | undefined) => path ?? `${folder}/${title}.md`)
  const deps: AgentSessionDeps = {
    dir: join(dir, 'agents'),
    worktreesDir: join(dir, 'worktrees'),
    terminal,
    git: new GitService(),
    server: { register: vi.fn(() => 'tok'), unregister: vi.fn(), url: (route: string, id: string) => `http://127.0.0.1:1/${route}/${id}` },
    permissions,
    events: { emit: vi.fn() as never },
    projects: (id) => (id === 'p1' ? { name: opts.projectName ?? 'Demo App', path: projectPath } : undefined),
    publish: (channel, payload) => void published.push({ channel, payload }),
    mcp: vi.fn(async (ctx, msg) => {
      ctx.onCall?.('memory_read', { path: 'Projekte/Demo.md' })
      ctx.onCall?.('memory_read', { path: 'Projekte/Demo.md' }) // the same note again
      ctx.onCall?.('memory_create_note', { title: 'Decision', folder: 'Projekte/' })
      ctx.onCall?.('memory_create_note', { title: 'Loose' })
      ctx.onCall?.('memory_search', { query: 'x' }) // no note involved
      return { echo: msg }
    }),
    journal,
    notify: vi.fn(),
    spawnAcp: vi.fn(),
    ...(opts.probe ? { probe: opts.probe } : {})
  }
  const svc = new AgentSessionService(deps)
  track(svc)
  await svc.init()
  const hook = (id: string, body: object, signal = new AbortController().signal) => svc.handleHook(id, body, signal)
  return { svc, deps, terminal, permissions, asks, granted, published, journal, projectPath, dir, hook }
}

afterEach(() => vi.useRealTimers())

/** Every service a test makes: its pending writes finish before the temp folders go. */
function track(s: AgentSessionService): AgentSessionService {
  onCleanup(() => s.dispose())
  return s
}

describe('AgentSessionService: sessions', () => {
  let t: Awaited<ReturnType<typeof setup>>
  beforeEach(async () => {
    t = await setup()
  })

  it('starts Claude Code in the project with hooks, memory and the first message; refuses unknown agents/projects', async () => {
    const s = await t.svc.create({ kind: 'claude-code', projectId: 'p1', prompt: 'Fix the login bug\nand add a test' })
    expect(s).toMatchObject({ kind: 'claude-code', title: 'Claude Code', projectName: 'Demo App', cwd: t.projectPath, isolated: false, status: 'starting', terminalId: 'pty-1' })
    const req = t.terminal.spawned[0]
    expect(req).toMatchObject({ cwd: t.projectPath, command: { file: 'claude' }, env: { MINDECK_TOKEN: 'tok', MINDECK_HOOK_URL: `http://127.0.0.1:1/hooks/${s.id}` }, projectId: 'p1' })
    expect(req.command.args.slice(0, 2)).toEqual(['--session-id', s.id])
    expect(req.command.args.slice(-2)).toEqual(['--', 'Fix the login bug\nand add a test'])
    expect(t.deps.events.emit).toHaveBeenCalledWith('session.started', expect.objectContaining({ conversationId: s.id }))
    expect(t.svc.list()).toHaveLength(1)
    expect(t.svc.get(s.id)).toMatchObject({ id: s.id, messages: [] })

    expect((await t.svc.create({ kind: 'claude-code', projectId: 'p1', title: '  Named  ' })).title).toBe('Named')
    expect((await t.svc.create({ kind: 'claude-code', projectId: 'p1', title: 'x'.repeat(120) })).title).toHaveLength(80)
    await expect(t.svc.create({ kind: 'claude-code', projectId: 'nope' })).rejects.toMatchObject({ code: 'not-found' })
    expect(() => t.svc.get('nope')).toThrow(expect.objectContaining({ code: 'not-found' }))
  })

  it('types messages into the agent (pastes multi-line), interrupts, stops and resumes', async () => {
    vi.useFakeTimers()
    const s = await t.svc.create({ kind: 'claude-code', projectId: 'p1' })
    t.svc.send(s.id, 'hello')
    t.svc.send(s.id, 'two\nlines')
    vi.advanceTimersByTime(60)
    expect(t.terminal.write.mock.calls).toEqual([
      ['pty-1', 'hello'],
      ['pty-1', '\x1b[200~two\nlines\x1b[201~'],
      ['pty-1', '\r'],
      ['pty-1', '\r']
    ])
    t.svc.interrupt(s.id)
    expect(t.terminal.write).toHaveBeenLastCalledWith('pty-1', '\x1b')

    t.svc.send(s.id, 'late')
    t.svc.stop(s.id) // exits before the Enter is due
    vi.advanceTimersByTime(60)
    expect(t.terminal.write).toHaveBeenLastCalledWith('pty-1', 'late')
    expect(t.svc.get(s.id)).toMatchObject({ status: 'ended', terminalId: undefined })
    expect(t.deps.server.unregister).toHaveBeenCalledWith(s.id)
    expect(() => t.svc.send(s.id, 'x')).toThrow(expect.objectContaining({ code: 'not-running' }))
    t.svc.stop(s.id) // not running: nothing to stop

    const resumed = await t.svc.resume(s.id)
    expect(resumed).toMatchObject({ status: 'starting', terminalId: 'pty-2' })
    expect(t.terminal.spawned[1].command.args.slice(0, 2)).toEqual(['--resume', s.id])
    expect(await t.svc.resume(s.id)).toBe(t.svc.list()[0]) // already running
    t.terminal.spawned[0].onExit!(0) // the old PTY reports its end late: the resumed agent keeps running
    expect(t.svc.get(s.id)).toMatchObject({ status: 'starting', live: true, terminalId: 'pty-2' })
    vi.useRealTimers()
  })

  it('a start that fails right away is an error with a hint; a failing spawn too', async () => {
    const s = await t.svc.create({ kind: 'claude-code', projectId: 'p1' })
    const onExit = t.terminal.spawned[0].onExit!
    onExit(127)
    expect(t.svc.get(s.id)).toMatchObject({ status: 'error', error: expect.stringContaining('exit code 127') })
    onExit(0) // a late second exit for a forgotten session id is harmless
    t.terminal.fail = true
    await expect(t.svc.resume(s.id)).rejects.toThrow('spawn failed')
    expect(t.svc.get(s.id)).toMatchObject({ status: 'error', error: 'spawn failed' })
  })

  it('resume refuses when the working folder is gone; removing forgets the session and its files', async () => {
    const plain = await setup({ projectPath: await tempDir() })
    const s = await plain.svc.create({ kind: 'claude-code', projectId: 'p1' })
    plain.svc.stop(s.id)
    const { rm } = await import('node:fs/promises')
    await rm(plain.projectPath, { recursive: true })
    await expect(plain.svc.resume(s.id)).rejects.toMatchObject({ code: 'not-found' })
    expect(await plain.svc.changes(s.id)).toEqual([]) // no git, no folder: no changes
    await plain.svc.remove(s.id)
    expect(plain.svc.list()).toEqual([])
    plain.terminal.spawned[0].onExit!(0) // a late exit for a removed session is ignored
    expect(plain.published).toContainEqual({ channel: 'agents:changed', payload: { removed: s.id } })
    expect(existsSync(join(plain.deps.dir, `${s.id}.json`))).toBe(false)
  })

  it('remembers sessions across restarts as ended (resumable); survives a broken list', async () => {
    const s = await t.svc.create({ kind: 'claude-code', projectId: 'p1', prompt: 'hi' })
    await t.hook(s.id, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
    const done = await t.svc.create({ kind: 'claude-code', projectId: 'p1' })
    t.svc.stop(done.id)
    const failed = await t.svc.create({ kind: 'claude-code', projectId: 'p1' })
    t.terminal.spawned[2].onExit!(1)
    await t.svc.dispose() // the running one is stopped, writes are flushed

    const again = track(new AgentSessionService(t.deps))
    await again.init()
    expect(again.get(s.id)).toMatchObject({ status: 'ended', terminalId: undefined })
    expect(again.get(s.id).messages[0]).toMatchObject({ role: 'user' })
    expect(again.get(failed.id).status).toBe('error')

    await writeFile(join(t.deps.dir, 'sessions.json'), '{broken')
    const broken = track(new AgentSessionService(t.deps))
    await broken.init()
    expect(broken.list()).toEqual([])
    await rmMessages(t.deps.dir, s.id)
    // a crash left it marked as working: it comes back ended (resumable)
    await writeFile(join(t.deps.dir, 'sessions.json'), JSON.stringify({ version: 1, sessions: [{ session: { ...again.get(s.id), status: 'working', terminalId: 'old' }, baseline: null, projectPath: t.projectPath }] }))
    const noTranscript = track(new AgentSessionService(t.deps))
    await noTranscript.init()
    expect(noTranscript.get(s.id)).toMatchObject({ status: 'ended', terminalId: undefined, messages: [] })
    await noTranscript.dispose()

    // A damaged transcript loses only its own messages, never the other sessions.
    await writeFile(join(t.deps.dir, 'sessions.json'), JSON.stringify({ version: 1, sessions: [s, failed].map((x) => ({ session: again.get(x.id), baseline: null, projectPath: t.projectPath })) }))
    await writeFile(join(t.deps.dir, `${s.id}.json`), '[{"role":')
    const damaged = track(new AgentSessionService(t.deps))
    await damaged.init()
    expect(damaged.list().map((x) => x.id).sort()).toEqual([s.id, failed.id].sort())
    expect(damaged.get(s.id).messages).toEqual([])
  })

  it('named after the agent; renamed by the user (notification and journal follow); the repo page from origin', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    sh(t.projectPath, 'remote', 'add', 'origin', 'git@github.com:me/demo.git')
    const s = await t.svc.create({ kind: 'claude-code', projectId: 'p1' })
    expect(s).toMatchObject({ title: 'Claude Code', repoUrl: 'https://github.com/me/demo' })

    expect(t.svc.rename(s.id, '  Login fix  ').title).toBe('Login fix')
    expect(t.published.at(-1)).toMatchObject({ channel: 'agents:changed', payload: { session: { title: 'Login fix' } } })
    expect(t.svc.rename(s.id, 'y'.repeat(100)).title).toHaveLength(80)
    expect(() => t.svc.rename(s.id, '   ')).toThrow(expect.objectContaining({ code: 'bad-input' }))
    t.svc.rename(s.id, 'Login fix')
    expect(t.journal).not.toHaveBeenCalled() // no journal yet: nothing to follow

    await t.hook(s.id, { hook_event_name: 'UserPromptSubmit', prompt: 'Fix it' })
    await t.hook(s.id, { hook_event_name: 'Stop', last_assistant_message: 'Fixed' })
    expect(t.deps.notify).toHaveBeenCalledWith('Claude Code · Login fix', 'Done — your turn', s.id)
    await vi.advanceTimersByTimeAsync(1500)
    vi.useRealTimers()
    // The journal reads the changes (real git): wait for it, however busy the machine is.
    await vi.waitFor(() => expect(t.svc.get(s.id).journal).toBeDefined())
    expect(t.journal).toHaveBeenCalledTimes(1)
    const note = t.svc.get(s.id).journal
    t.svc.rename(s.id, 'Auth fix')
    await vi.waitFor(() => expect(t.journal).toHaveBeenCalledTimes(2))
    expect(t.journal.mock.calls[1][1]).toContain('Auth fix')
    expect(t.journal.mock.calls[1][2]).toBe(note) // the same note, rewritten
  })

  it('sessions from before: "New chat" becomes the agent\'s name, the repo page is filled in', async () => {
    sh(t.projectPath, 'remote', 'add', 'origin', 'https://user:secret@github.com/me/demo.git')
    const s = await t.svc.create({ kind: 'claude-code', projectId: 'p1' })
    const named = await t.svc.create({ kind: 'claude-code', projectId: 'p1', title: 'Kept' })
    await t.svc.dispose()
    const old = (x: typeof s) => ({ session: { ...x, title: x === s ? 'New chat' : x.title, repoUrl: undefined }, baseline: null, projectPath: t.projectPath })
    await writeFile(join(t.deps.dir, 'sessions.json'), JSON.stringify({ version: 1, sessions: [old(s), old(named)] }))
    const again = track(new AgentSessionService(t.deps))
    await again.init()
    expect(again.get(s.id)).toMatchObject({ title: 'Claude Code', repoUrl: 'https://github.com/me/demo' })
    expect(again.get(named.id).title).toBe('Kept')
  })

  it('a shell in the session\'s folder: one at a time, a new one after it ends, gone with the session; VS Code opens the folder', async () => {
    const s = await t.svc.create({ kind: 'claude-code', projectId: 'p1' })
    expect(s.repoUrl).toBeUndefined() // no remote
    const first = await t.svc.shell(s.id)
    expect(first).toEqual({ terminalId: 'pty-2' })
    expect(t.terminal.spawned[1]).toMatchObject({ cwd: t.projectPath, projectId: 'p1', title: 'Claude Code' })
    expect(await t.svc.shell(s.id)).toEqual(first)

    t.terminal.spawned[1].onExit!(0)
    const second = await t.svc.shell(s.id)
    expect(second).toEqual({ terminalId: 'pty-3' })
    t.terminal.spawned[1].onExit!(0) // a late exit of the old one changes nothing
    expect(await t.svc.shell(s.id)).toEqual(second)

    t.svc.stop(s.id)
    expect(t.terminal.kill).toHaveBeenCalledWith('pty-3')
    const third = await t.svc.shell(s.id)
    await t.svc.dispose()
    expect(t.terminal.kill).toHaveBeenCalledWith(third.terminalId)

    await expect(t.svc.openInEditor(s.id)).rejects.toMatchObject({ code: 'desktop-only' })
    const openFolder = vi.fn(async () => {})
    const desk = track(new AgentSessionService({ ...t.deps, openFolder }))
    await desk.init()
    await desk.openInEditor(s.id)
    expect(openFolder).toHaveBeenCalledWith(t.projectPath)
  })

  it('saving problems are logged, never thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = await setup()
    await writeFile(bad.deps.dir, 'not a folder') // dir replaced by a file
      .catch(async () => {
        const { rm } = await import('node:fs/promises')
        await rm(bad.deps.dir, { recursive: true })
        await writeFile(bad.deps.dir, 'not a folder')
      })
    await bad.svc.create({ kind: 'claude-code', projectId: 'p1' })
    await bad.svc.dispose()
    expect(warn).toHaveBeenCalledWith('[agents] could not save sessions:', expect.any(String))
  })

  it('detects the installed agents through the probe', async () => {
    const probe = vi.fn(async (cmd: string) => (cmd === 'claude --version' ? '2.1.0' : Promise.reject(new Error('nope'))))
    const svc = track(new AgentSessionService({ ...t.deps, probe }))
    expect((await svc.detect())[0]).toMatchObject({ kind: 'claude-code', installed: true, signedIn: false })
  })

  it('a configured Claude binary (MINDECK_CLAUDE_BIN) is used to detect and to start', async () => {
    const probe = vi.fn(async (cmd: string) => (cmd === "'/opt/my claude' --version" ? '3.0.0' : Promise.reject(new Error('nope'))))
    const svc = track(new AgentSessionService({ ...t.deps, probe, claudeBin: '/opt/my claude' }))
    await svc.init()
    expect((await svc.detect())[0]).toMatchObject({ installed: true, version: '3.0.0' })
    await svc.create({ kind: 'claude-code', projectId: 'p1' })
    expect(t.terminal.spawned.at(-1)!.command.file).toBe('/opt/my claude')
  })
})

async function rmMessages(dir: string, id: string) {
  const { rm } = await import('node:fs/promises')
  await rm(join(dir, `${id}.json`), { force: true })
}

describe('AgentSessionService: hooks, approvals, memory', () => {
  let t: Awaited<ReturnType<typeof setup>>
  beforeEach(async () => {
    t = await setup()
  })

  it('hooks become chat messages; the turn end notifies and writes the journal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await t.svc.create({ kind: 'claude-code', projectId: 'p1' })
    expect(await t.hook(s.id, { hook_event_name: 'SessionStart' })).toBeUndefined()
    expect(t.svc.get(s.id).status).toBe('idle')
    await t.hook(s.id, { hook_event_name: 'UserPromptSubmit', prompt: 'Add a greeting' })
    await t.hook(s.id, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'w', tool_input: { file_path: 'hello.ts' } })
    await writeFile(join(t.projectPath, 'hello.ts'), 'export const hi = 1\n')
    await t.hook(s.id, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'w', tool_response: 'ok' })
    await t.hook(s.id, { hook_event_name: 'Stop', last_assistant_message: 'Added hello.ts' })
    expect(t.svc.get(s.id).status).toBe('idle')
    expect(t.deps.notify).toHaveBeenCalledWith('Claude Code', 'Done — your turn', s.id)
    const messages = t.published.filter((p) => p.channel === 'agents:message')
    expect(messages.length).toBeGreaterThan(3)

    await vi.advanceTimersByTimeAsync(1500)
    vi.useRealTimers()
    await vi.waitFor(() => expect(t.svc.get(s.id).journal).toMatch(/^Agents\/Demo App\//))
    expect(t.journal).toHaveBeenCalledWith('Agents/Demo App', expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{4} Add a greeting$/), undefined, expect.stringContaining('`hello.ts` (neu)'))

    // a second turn rewrites the same note
    await t.hook(s.id, { hook_event_name: 'UserPromptSubmit', prompt: 'more' })
    t.svc.stop(s.id) // the exit writes it right away
    await vi.waitFor(() => expect(t.journal).toHaveBeenLastCalledWith('Agents/Demo App', expect.any(String), t.svc.get(s.id).journal, expect.any(String)))
  })

  it('journal: nothing before the first prompt; failures are logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = await t.svc.create({ kind: 'claude-code', projectId: 'p1' })
    t.svc.stop(s.id)
    await tick(30)
    expect(t.journal).not.toHaveBeenCalled()
    const s2 = await t.svc.create({ kind: 'claude-code', projectId: 'p1' })
    await t.hook(s2.id, { hook_event_name: 'UserPromptSubmit', prompt: 'x' })
    t.journal.mockRejectedValueOnce(new Error('vault gone'))
    t.svc.stop(s2.id)
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[agents] journal not written:', 'vault gone'))
    // no vault: the session simply has no journal
    const s3 = await t.svc.create({ kind: 'claude-code', projectId: 'p1' })
    await t.hook(s3.id, { hook_event_name: 'UserPromptSubmit', prompt: 'x' })
    t.journal.mockResolvedValueOnce(undefined as unknown as string)
    t.svc.stop(s3.id)
    await vi.waitFor(() => expect(t.journal).toHaveBeenCalledTimes(2))
    await tick()
    expect(t.svc.get(s3.id).journal).toBeUndefined()
  })

  it('approvals go through Mindeck: allow, deny, standing grants; commands always ask', async () => {
    const s = await t.svc.create({ kind: 'claude-code', projectId: 'p1' })
    await t.hook(s.id, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await t.hook(s.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test' } })
    const allow = t.hook(s.id, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test' } })
    await tick()
    expect(t.svc.get(s.id).status).toBe('approval')
    expect(t.asks[0].input).toMatchObject({ toolName: 'Bash', risk: 'execute', allowAlways: false, summary: 'Run command: npm test' })
    const card = t.svc.get(s.id).messages[1].parts[0]
    expect(card).toMatchObject({ status: 'awaiting-approval', requestId: 'req-1' })
    expect(t.deps.notify).toHaveBeenCalledWith(expect.any(String), 'Waiting for your approval', s.id)
    t.asks[0].settle('once')
    expect(await allow).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    expect(t.svc.get(s.id)).toMatchObject({ status: 'working' })
    expect(t.svc.get(s.id).messages[1].parts[0]).toMatchObject({ status: 'running' })

    const deny = t.hook(s.id, { hook_event_name: 'PermissionRequest', tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: 'a.ts' } })
    await tick()
    expect(t.asks[1].input).toMatchObject({ risk: 'write', allowAlways: true })
    t.asks[1].settle('deny')
    expect(await deny).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny', message: expect.any(String) } } })
    expect(t.svc.get(s.id).messages[1].parts[1]).toMatchObject({ status: 'denied' })

    t.granted.add('Edit') // "Always allow" earlier
    expect(await t.hook(s.id, { hook_event_name: 'PermissionRequest', tool_name: 'Edit', tool_use_id: 'e2' })).toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } }
    })
    expect(t.asks).toHaveLength(2) // not asked again
    // a request without a tool id still gets an answer
    const anon = t.hook(s.id, { hook_event_name: 'PermissionRequest' })
    await tick()
    t.asks[2].settle('always')
    expect(await anon).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } })
  })

  it('ignores hooks for unknown sessions and junk; SessionEnd retires the token', async () => {
    const s = await t.svc.create({ kind: 'claude-code', projectId: 'p1' })
    expect(await t.hook('nope', { hook_event_name: 'Stop' })).toBeUndefined()
    expect(await t.svc.handleHook(s.id, null, new AbortController().signal)).toBeUndefined()
    expect(await t.svc.handleHook(s.id, 'text', new AbortController().signal)).toBeUndefined()
    await t.hook(s.id, { hook_event_name: 'SessionEnd', reason: 'other' })
    expect(t.deps.server.unregister).toHaveBeenCalledWith(s.id)
    expect(t.svc.get(s.id).status).toBe('ended')
    await t.hook(s.id, { hook_event_name: 'Notification', notification_type: 'agent_needs_input' })
    expect(t.deps.notify).toHaveBeenLastCalledWith(expect.any(String), 'Waiting for your answer', s.id)
  })

  it('serves MCP scoped to the project and records the notes the agent used', async () => {
    const s = await t.svc.create({ kind: 'claude-code', projectId: 'p1' })
    expect(await t.svc.handleMcp(s.id, { jsonrpc: '2.0', id: 1, method: 'ping' })).toEqual({ echo: { jsonrpc: '2.0', id: 1, method: 'ping' } })
    expect(t.deps.mcp).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1' }), expect.anything())
    expect(t.svc.get(s.id).notes).toEqual(['Projekte/Demo.md', 'Projekte/Decision.md', 'Loose.md'])
    expect(() => t.svc.handleMcp('nope', {})).toThrow(expect.objectContaining({ code: 'not-found' }))
  })

  it('the plan follows Claude\'s task hooks', async () => {
    const s = await t.svc.create({ kind: 'claude-code', projectId: 'p1' })
    await t.hook(s.id, { hook_event_name: 'TaskCreated', task_id: 'a', task_description: 'write the test' })
    await t.hook(s.id, { hook_event_name: 'TaskCompleted', task_id: 'a' })
    expect(t.svc.get(s.id).plan).toEqual([{ id: 'a', text: 'write the test', done: true }])
    expect(t.published.filter((p) => p.channel === 'agents:changed').at(-1)!.payload).toMatchObject({ session: { plan: [{ done: true }] } })
  })

  it('works without a notifier', async () => {
    const quiet = track(new AgentSessionService({ ...t.deps, notify: undefined }))
    await quiet.init()
    const s = await quiet.create({ kind: 'claude-code', projectId: 'p1' })
    await quiet.handleHook(s.id, { hook_event_name: 'Stop' }, new AbortController().signal)
    expect(quiet.get(s.id).status).toBe('idle')
  })
})

describe('AgentSessionService: changes and own working folders', () => {
  it('in the project: changes since the start (not the user\'s earlier edits) and diffs', async () => {
    const t = await setup()
    await writeFile(join(t.projectPath, 'app.ts'), 'export const a = 2 // mine\n')
    const s = await t.svc.create({ kind: 'claude-code', projectId: 'p1' })
    expect(await t.svc.changes(s.id)).toEqual([])
    await writeFile(join(t.projectPath, 'app.ts'), 'export const a = 3 // agent\n')
    expect(await t.svc.changes(s.id)).toEqual([{ path: 'app.ts', status: 'modified', added: 1, removed: 1 }])
    expect(await t.svc.diff(s.id, 'app.ts')).toEqual({ path: 'app.ts', original: 'export const a = 2 // mine\n', modified: 'export const a = 3 // agent\n' })
    expect(await t.svc.diff(s.id, 'gone.ts')).toEqual({ path: 'gone.ts', original: '', modified: '' })
    await expect(t.svc.diff(s.id, '../escape.ts')).rejects.toMatchObject({ code: 'outside-project' })
    await expect(t.svc.accept(s.id)).rejects.toMatchObject({ code: 'not-isolated' })
    await expect(t.svc.discard(s.id)).rejects.toMatchObject({ code: 'not-isolated' })
  })

  it('no git: no baseline, empty diffs', async () => {
    const t = await setup({ projectPath: await tempDir() })
    await writeFile(join(t.projectPath, 'x.txt'), 'x\n')
    const s = await t.svc.create({ kind: 'claude-code', projectId: 'p1' })
    expect(await t.svc.changes(s.id)).toEqual([])
    expect(await t.svc.diff(s.id, 'x.txt')).toEqual({ path: 'x.txt', original: '', modified: 'x\n' })
    await expect(t.svc.create({ kind: 'claude-code', projectId: 'p1', isolated: true })).rejects.toMatchObject({ code: 'not-a-repo' })
  })

  it('isolated: a worktree with linked dependencies; accept brings the changes over, discard drops them', async () => {
    const t = await setup({ projectName: 'Demo App!' })
    await mkdir(join(t.projectPath, 'node_modules', 'lib'), { recursive: true })
    const s = await t.svc.create({ kind: 'claude-code', projectId: 'p1', isolated: true })
    expect(s).toMatchObject({ isolated: true, branch: `mindeck/${s.id.slice(0, 8)}` })
    expect(s.worktree).toBe(join(t.deps.worktreesDir, `demo-app-${s.id.slice(0, 8)}`))
    expect(s.cwd).toBe(s.worktree)
    expect(lstatSync(join(s.worktree!, 'node_modules')).isSymbolicLink()).toBe(true)

    await writeFile(join(s.worktree!, 'app.ts'), 'export const a = 42\n')
    await writeFile(join(s.worktree!, 'new.ts'), 'export {}\n')
    expect((await t.svc.changes(s.id)).map((c) => c.path)).toEqual(['app.ts', 'new.ts']) // the node_modules link is not a change
    expect(await t.svc.accept(s.id)).toEqual({ files: 2 })
    expect(await readFile(join(t.projectPath, 'app.ts'), 'utf8')).toBe('export const a = 42\n')
    expect(existsSync(s.worktree!)).toBe(false)
    expect(t.svc.get(s.id)).toMatchObject({ status: 'ended', worktree: undefined, cwd: t.projectPath })
    expect(await t.svc.changes(s.id)).toEqual([]) // the diff belongs to the project now
    await expect(t.svc.accept(s.id)).rejects.toMatchObject({ code: 'not-isolated' })

    const other = await t.svc.create({ kind: 'claude-code', projectId: 'p1', isolated: true })
    await writeFile(join(other.worktree!, 'app.ts'), 'throw away\n')
    await t.svc.discard(other.id)
    expect(existsSync(other.worktree!)).toBe(false)
    expect(await readFile(join(t.projectPath, 'app.ts'), 'utf8')).toBe('export const a = 42\n')

    // removing an isolated session takes its worktree along
    const third = await t.svc.create({ kind: 'claude-code', projectId: 'p1', isolated: true, title: 'x' })
    await t.svc.remove(third.id)
    expect(existsSync(third.worktree!)).toBe(false)
  })

  it('the branch of an own working folder: pushed, its pull request (gh), merged — none for a plain session', async () => {
    let gh: () => string = () => '[]'
    const probe = vi.fn(async (_line: string) => gh())
    const t = await setup({ probe })
    const origin = await tempDir('mindeck-origin-')
    sh(origin, 'init', '-q', '--bare', '-b', 'main')
    sh(t.projectPath, 'remote', 'add', 'origin', 'git@github.com:me/demo.git')

    const plain = await t.svc.create({ kind: 'claude-code', projectId: 'p1' })
    expect(await t.svc.branch(plain.id)).toBeNull()
    const s = await t.svc.create({ kind: 'claude-code', projectId: 'p1', isolated: true })
    expect(s.repoUrl).toBe('https://github.com/me/demo')
    sh(t.projectPath, 'remote', 'set-url', 'origin', origin) // the "GitHub" of this test
    sh(t.projectPath, 'push', '-q', 'origin', 'main')

    expect(await t.svc.branch(s.id)).toEqual({ pushed: false, merged: false, uncommitted: 0 })
    expect(probe).toHaveBeenLastCalledWith(`gh pr list --repo me/demo --head ${s.branch} --state all --json number,url,state --limit 1`)

    const wt = s.worktree!
    await writeFile(join(wt, 'app.ts'), 'export const a = 2\n')
    sh(wt, 'commit', '-qam', 'agent work')
    sh(wt, 'push', '-q', '-u', 'origin', s.branch!)
    gh = () => JSON.stringify([{ number: 7, url: 'https://github.com/me/demo/pull/7', state: 'OPEN' }])
    expect(await t.svc.branch(s.id)).toEqual({ pushed: true, pr: { number: 7, url: 'https://github.com/me/demo/pull/7', state: 'open' }, merged: false, uncommitted: 0 })

    gh = () => JSON.stringify([{ number: 7, url: 'https://github.com/me/demo/pull/7', state: 'MERGED' }])
    await writeFile(join(wt, 'left.txt'), 'x\n')
    expect(await t.svc.branch(s.id)).toMatchObject({ pr: { state: 'merged' }, merged: true, uncommitted: 1 })

    // Without gh: merged is read from origin's main.
    gh = () => {
      throw new Error('gh: command not found')
    }
    expect((await t.svc.branch(s.id))!.merged).toBe(false)
    const other = join(await tempDir(), 'other')
    execFileSync('git', ['clone', '-q', origin, other])
    sh(other, 'config', 'user.email', 't@t')
    sh(other, 'config', 'user.name', 'T')
    sh(other, 'merge', '-q', '--no-ff', '-m', 'Merge pull request', `origin/${s.branch}`)
    sh(other, 'push', '-q', 'origin', 'main')
    expect(await t.svc.branch(s.id)).toEqual({ pushed: true, merged: true, uncommitted: 1 })

    // No GitHub remote: no gh at all.
    probe.mockClear()
    const local = await t.svc.create({ kind: 'claude-code', projectId: 'p1', isolated: true })
    expect((await t.svc.branch(local.id))!.pr).toBeUndefined()
    expect(probe).not.toHaveBeenCalled()

    sh(t.projectPath, 'worktree', 'remove', '--force', wt) // the folder is gone: nothing to tell
    expect(await t.svc.branch(s.id)).toBeNull()
  })

  it('isolated without node_modules in the project: no link; a worktree that can\'t be removed is tolerated on remove', async () => {
    const t = await setup({ projectName: '***' })
    const s = await t.svc.create({ kind: 'claude-code', projectId: 'p1', isolated: true })
    expect(s.worktree).toContain(`project-${s.id.slice(0, 8)}`)
    expect(existsSync(join(s.worktree!, 'node_modules'))).toBe(false)
    sh(t.projectPath, 'worktree', 'remove', '--force', s.worktree!)
    await t.svc.remove(s.id) // git refuses, the session goes anyway
    expect(t.svc.list()).toEqual([])
  })
})
