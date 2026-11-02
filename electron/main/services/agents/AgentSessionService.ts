import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ApprovalDecision, ChatMessage, PermissionRequest, ToolCallPart } from '@shared/types/ai'
import { ClientSideConnection, PROTOCOL_VERSION, type RequestPermissionRequest, type RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type {
  AgentAvailability,
  AgentKind,
  AgentSession,
  AgentSessionDetail,
  CreateSessionRequest,
  FileChange,
  FileDiff,
  SessionBranch
} from '@shared/types/agents'
import type { IpcEvents } from '@shared/ipc/contract'
import type { TerminalInfo } from '@shared/types/terminal'
import type { EventBus } from '../events/EventBus'
import type { GitBaseline, GitService } from '../git/GitService'
import type { LocalAgentServer } from './LocalAgentServer'
import type { McpSessionContext } from './mcp'
import { confine } from '../../lib/confine'
import { claudeArgs, claudeEnv } from './claudeLaunch'
import { detectAgents, loginShellProbe, type Probe } from './detect'
import { applyHook, toolRisk, toolSummary, toolTitle, type Applied, type HookEvent } from './transcript'
import { journalBody, journalTitle } from './journal'
import { ACP_AGENTS, applyAcpUpdate, findAcpTool, kindRisk, openTurn, pickOption, type AcpKind, type AcpProcess } from './acp'
import { shellCommand, shellEnv, shellQuote } from '../terminal/TerminalService'

const AGENT_NAMES: Record<AgentKind, string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' }
/** Left out of an isolated session's diff: the link to the project's dependencies. */
const LINKED = ['node_modules']
const JOURNAL_DELAY_MS = 1500
const MAX_NOTES = 30

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

interface Record_ {
  session: AgentSession
  baseline: GitBaseline | null
  projectPath: string
}

/** An ACP agent's connection (Codex, Gemini): no PTY — JSON-RPC over its stdio. */
interface AcpLink {
  conn: ClientSideConnection
  proc: AcpProcess
  /** The agent's session id once the handshake is done. */
  ready: Promise<string>
  /** Ends pending approvals when the agent goes away. */
  abort: AbortController
}

interface Live extends Record_ {
  messages: ChatMessage[]
  journalTimer?: NodeJS.Timeout
  acp?: AcpLink
  /** A plain shell in the session's folder (ACP agents have no terminal of their own). */
  shellId?: string
  /** Counts the agent's starts: only the current process's exit ends the session — not a late one from before a resume. */
  run?: number
}

export interface AgentSessionDeps {
  /** ~/Mindeck/data/agents — session list + one transcript file per session. */
  dir: string
  /** ~/Mindeck/worktrees — isolated sessions' working folders. */
  worktreesDir: string
  terminal: {
    spawnProgram(req: {
      title: string
      cwd: string
      command: { file: string; args: string[] }
      env?: Record<string, string>
      projectId?: string
      cols?: number
      rows?: number
      onExit?: (exitCode: number) => void
    }): Promise<TerminalInfo>
    write(id: string, data: string): void
    kill(id: string): void
  }
  git: GitService
  server: Pick<LocalAgentServer, 'register' | 'unregister' | 'url'>
  permissions: {
    ask(input: Omit<PermissionRequest, 'id' | 'createdAt'>, signal: AbortSignal): { id: string; decision: Promise<ApprovalDecision> }
    isGranted(agentId: string, toolName: string): Promise<boolean>
  }
  events: Pick<EventBus, 'emit'>
  projects: (id: string) => { name: string; path: string } | undefined
  publish: <K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]) => void
  mcp: (ctx: McpSessionContext, message: unknown) => Promise<unknown>
  /** Writes (or rewrites) a vault note; resolves to its path, or undefined without a vault. */
  journal: (folder: string, title: string, path: string | undefined, body: string) => Promise<string | undefined>
  /** Desktop notification when the agent needs the user (the host decides if the window is focused). */
  notify?: (title: string, body: string, sessionId: string) => void
  probe?: Probe
  /** Starts an ACP agent process (`spawnAcp`; tests use an in-process agent). */
  spawnAcp: (command: { file: string; args: string[] }, cwd: string, env: Record<string, string>) => AcpProcess
  /** The Claude Code binary (default `claude` from the user's PATH; tests point it at a stand-in). */
  claudeBin?: string
  /** Opens a folder in VS Code (desktop only). */
  openFolder?: (path: string) => Promise<void>
}

const MAX_TITLE = 80
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'

/**
 * The agent cockpit's core: runs Claude Code (the user's own, unmodified CLI,
 * on their own plan) per session in a PTY, and turns its hooks into a chat
 * with tool cards, approvals through Mindeck's permission gate, a plan, the
 * changes since the session started, and a journal in the vault.
 */
export class AgentSessionService {
  private readonly live = new Map<string, Live>()
  private writes = Promise.resolve()
  private disposed = false

  /** Runs the user's own CLIs (`gh`) like their terminal would. */
  private readonly probe: Probe

  constructor(private readonly deps: AgentSessionDeps) {
    this.probe = deps.probe ?? loginShellProbe
  }

  /** Sessions from earlier runs: their processes are gone — they can be resumed. */
  async init(): Promise<void> {
    await mkdir(this.deps.dir, { recursive: true })
    const raw = await readFile(join(this.deps.dir, 'sessions.json'), 'utf8').catch(() => '')
    let records: Record_[] = []
    try {
      records = raw ? (JSON.parse(raw) as { sessions: Record_[] }).sessions : []
    } catch {
      /* unreadable list: start empty, the transcripts stay on disk */
    }
    const repos = new Map<string, Promise<string | undefined>>()
    for (const r of records) {
      let messages: ChatMessage[] = []
      try {
        messages = JSON.parse(await readFile(this.file(r.session.id), 'utf8').catch(() => '[]')) as ChatMessage[]
      } catch {
        /* a damaged transcript loses its messages, never the other sessions */
      }
      const wasRunning = r.session.status !== 'ended' && r.session.status !== 'error'
      if (!repos.has(r.projectPath)) repos.set(r.projectPath, this.deps.git.webUrl(r.projectPath))
      const session: AgentSession = {
        ...r.session,
        // Sessions from before titles defaulted to the agent's name.
        title: r.session.title === 'New chat' ? AGENT_NAMES[r.session.kind] : r.session.title,
        repoUrl: r.session.repoUrl ?? (await repos.get(r.projectPath)),
        live: false,
        terminalId: undefined,
        status: wasRunning ? 'ended' : r.session.status
      }
      this.live.set(session.id, { ...r, session, messages })
    }
  }

  detect(): Promise<AgentAvailability[]> {
    return detectAgents(this.deps.probe, this.deps.claudeBin)
  }

  list(): AgentSession[] {
    return [...this.live.values()].map((l) => l.session).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(id: string): AgentSessionDetail {
    const l = this.require(id)
    return { ...l.session, messages: l.messages }
  }

  async create(req: CreateSessionRequest): Promise<AgentSession> {
    const project = this.deps.projects(req.projectId)
    if (!project) throw coded('not-found', 'Project not found')
    const id = randomUUID()
    const title = req.title?.trim().slice(0, MAX_TITLE) || AGENT_NAMES[req.kind]

    let cwd = project.path
    let worktree: string | undefined
    let branch: string | undefined
    if (req.isolated) {
      if (!(await this.deps.git.isRepo(project.path))) throw coded('not-a-repo', 'An own working folder needs a git repository')
      worktree = join(this.deps.worktreesDir, `${slug(project.name)}-${id.slice(0, 8)}`)
      branch = `mindeck/${id.slice(0, 8)}`
      await mkdir(this.deps.worktreesDir, { recursive: true })
      await this.deps.git.addWorktree(project.path, worktree, branch)
      // Dependencies: a link to the project's, not a second install.
      const modules = join(project.path, 'node_modules')
      if (existsSync(modules)) await symlink(modules, join(worktree, 'node_modules'), 'dir').catch(() => {})
      cwd = worktree
    }

    const now = new Date().toISOString()
    const session: AgentSession = {
      id,
      kind: req.kind,
      projectId: req.projectId,
      projectName: project.name,
      title,
      cwd,
      isolated: !!req.isolated,
      worktree,
      branch,
      repoUrl: await this.deps.git.webUrl(project.path),
      status: 'starting',
      live: false,
      plan: [],
      notes: [],
      createdAt: now,
      updatedAt: now
    }
    const l: Live = { session, baseline: await this.deps.git.baseline(cwd), projectPath: project.path, messages: [] }
    this.live.set(id, l)
    if (req.kind === 'claude-code') await this.launch(l, { prompt: req.prompt })
    else this.launchAcp(l, req.prompt)
    this.deps.events.emit('session.started', {
      actor: { kind: 'agent', id: req.kind },
      projectId: session.projectId,
      conversationId: id,
      payload: { title, agent: AGENT_NAMES[req.kind], isolated: session.isolated }
    })
    return l.session
  }

  /** Send a message: ACP agents get a prompt; Claude Code gets it typed (several lines as a paste, then Enter). */
  send(id: string, text: string): void {
    const l = this.require(id)
    if (l.acp && l.session.live) return void this.acpSend(l, l.acp, text)
    const terminalId = this.running(id)
    this.deps.terminal.write(terminalId, text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text)
    // Enter separately, so the TUI sees the paste end before the submit.
    setTimeout(() => {
      if (this.live.get(id)?.session.terminalId === terminalId) this.deps.terminal.write(terminalId, '\r')
    }, 60)
  }

  /** The agent stops what it is doing and waits (Esc for Claude Code, session/cancel for ACP). */
  interrupt(id: string): void {
    const acp = this.require(id).acp
    if (acp) return void acp.ready.then((sessionId) => acp.conn.cancel({ sessionId })).catch(() => {})
    this.deps.terminal.write(this.running(id), '\x1b')
  }

  stop(id: string): void {
    const l = this.require(id)
    if (l.acp) l.acp.proc.kill()
    else if (l.session.terminalId) this.deps.terminal.kill(l.session.terminalId)
    if (l.shellId) this.deps.terminal.kill(l.shellId)
    l.shellId = undefined
  }

  /** The user names the session (its journal heading follows; Claude Code gets it on resume). */
  rename(id: string, title: string): AgentSession {
    const l = this.require(id)
    const next = title.trim().slice(0, MAX_TITLE)
    if (!next) throw coded('bad-input', 'A session needs a name')
    this.update(l, { title: next })
    if (l.session.journal) this.scheduleJournal(l, 0)
    return l.session
  }

  /** A plain shell in the session's folder — one per session, started on first ask. */
  async shell(id: string): Promise<{ terminalId: string }> {
    const l = this.require(id)
    if (l.shellId) return { terminalId: l.shellId }
    const info = await this.deps.terminal.spawnProgram({
      title: l.session.title,
      cwd: l.session.cwd,
      command: shellCommand(),
      projectId: l.session.projectId,
      onExit: () => {
        if (l.shellId === info.id) l.shellId = undefined
      }
    })
    l.shellId = info.id
    return { terminalId: info.id }
  }

  /** The session's folder in VS Code — its own worktree, if it has one. */
  async openInEditor(id: string): Promise<void> {
    const { session } = this.require(id)
    if (!this.deps.openFolder) throw coded('desktop-only', 'Opening VS Code works in the desktop app')
    await this.deps.openFolder(session.cwd)
  }

  /** Start the agent again in the same folder (Claude Code continues its transcript). */
  async resume(id: string): Promise<AgentSession> {
    const l = this.require(id)
    if (l.session.live) return l.session
    if (!existsSync(l.session.cwd)) throw coded('not-found', 'The working folder is gone')
    if (l.session.kind === 'claude-code') await this.launch(l, { resume: true })
    else this.launchAcp(l)
    return l.session
  }

  /** Delete the session (its worktree too — the UI asks first). */
  async remove(id: string): Promise<void> {
    const l = this.require(id)
    this.stop(id)
    this.deps.server.unregister(id)
    clearTimeout(l.journalTimer)
    if (l.session.worktree && l.session.branch) await this.deps.git.removeWorktree(l.projectPath, l.session.worktree, l.session.branch).catch(() => {})
    this.live.delete(id)
    // In the write queue: a save still in flight must not bring the file back.
    // Never rejects: a rejected queue would skip every later save.
    this.writes = this.writes.then(() => rm(this.file(id), { force: true })).catch(() => {})
    await this.persist()
    this.deps.publish('agents:changed', { removed: id })
  }

  async changes(id: string): Promise<FileChange[]> {
    const l = this.require(id)
    if (!l.baseline || !existsSync(l.session.cwd)) return []
    return this.deps.git.changes(l.session.cwd, l.baseline, l.session.worktree ? LINKED : [])
  }

  /**
   * An own working folder's branch: pushed? its pull request? merged into the
   * default branch? — so a merged PR shows as merged, not as changes to take over.
   */
  async branch(id: string): Promise<SessionBranch | null> {
    const l = this.require(id)
    const { worktree, repoUrl } = l.session
    if (!worktree || !existsSync(worktree)) return null
    // An own working folder always has its branch and its starting point.
    const branch = l.session.branch!
    const [pushed, pr, uncommitted] = await Promise.all([
      this.deps.git.pushed(worktree, branch),
      this.pullRequest(repoUrl, branch),
      this.deps.git.uncommitted(worktree, LINKED)
    ])
    const merged = pr ? pr.state === 'merged' : await this.deps.git.landed(worktree, branch, l.baseline!.base)
    return { pushed, ...(pr ? { pr } : {}), merged, uncommitted }
  }

  /** The branch's pull request on GitHub, through the user's own `gh` (absent without it). */
  private async pullRequest(repoUrl: string | undefined, branch: string): Promise<SessionBranch['pr']> {
    const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(repoUrl ?? '')?.[1]
    if (!repo) return undefined
    try {
      const line = `gh pr list --repo ${shellQuote(repo)} --head ${shellQuote(branch)} --state all --json number,url,state --limit 1`
      const [pr] = JSON.parse(await this.probe(line)) as { number: number; url: string; state: string }[]
      return pr && { number: pr.number, url: pr.url, state: pr.state.toLowerCase() as NonNullable<SessionBranch['pr']>['state'] }
    } catch {
      return undefined
    }
  }

  async diff(id: string, path: string): Promise<FileDiff> {
    const l = this.require(id)
    const abs = await confine(l.session.cwd, path)
    return {
      path,
      original: l.baseline ? await this.deps.git.fileAt(l.session.cwd, l.baseline.base, path) : '',
      modified: await readFile(abs, 'utf8').catch(() => '')
    }
  }

  /** Isolated sessions: bring the changes into the project, then drop the worktree. */
  async accept(id: string): Promise<{ files: number }> {
    const l = this.isolated(id)
    this.stop(id)
    const files = await this.deps.git.applyTo(l.projectPath, l.session.worktree!, l.baseline!.base, LINKED)
    await this.dropWorktree(l)
    return { files }
  }

  /** Isolated sessions: throw the worktree and its branch away. */
  async discard(id: string): Promise<void> {
    const l = this.isolated(id)
    this.stop(id)
    await this.dropWorktree(l)
  }

  /** A hook from the session's Claude Code (via LocalAgentServer). */
  async handleHook(id: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const l = this.live.get(id)
    if (!l || typeof body !== 'object' || body === null) return undefined
    const e = body as HookEvent
    if (e.hook_event_name === 'PermissionRequest') return this.approve(l, e, signal)
    this.applied(l, applyHook(this.state(l), e))
    if (e.hook_event_name === 'SessionEnd') this.deps.server.unregister(id)
    return undefined
  }

  /** An MCP message from the session's agent: Mindeck's memory, scoped to its project. */
  handleMcp(id: string, body: unknown): Promise<unknown> {
    const l = this.require(id)
    return this.deps.mcp({ projectId: l.session.projectId, onCall: (tool, input) => this.usedNote(l, tool, input) }, body)
  }

  /** App quit: stop every agent (their sessions can be resumed next time). */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const l of this.live.values()) {
      if (l.acp) l.acp.proc.kill()
      else if (l.session.terminalId) this.deps.terminal.kill(l.session.terminalId)
      if (l.shellId) this.deps.terminal.kill(l.shellId)
      clearTimeout(l.journalTimer)
    }
    await this.writes
  }

  // --- internals ---

  private async launch(l: Live, opts: { prompt?: string; resume?: boolean }): Promise<void> {
    const { session } = l
    const run = (l.run = (l.run ?? 0) + 1)
    const token = this.deps.server.register(session.id)
    const hookUrl = this.deps.server.url('hooks', session.id)
    try {
      const info = await this.deps.terminal.spawnProgram({
        title: session.title,
        cwd: session.cwd,
        command: {
          file: this.deps.claudeBin ?? 'claude',
          args: claudeArgs({
            sessionId: session.id,
            title: session.title,
            hookUrl,
            mcpUrl: this.deps.server.url('mcp', session.id),
            token,
            resume: opts.resume,
            prompt: opts.prompt
          })
        },
        env: claudeEnv(hookUrl, token),
        projectId: session.projectId,
        cols: 120,
        rows: 36,
        onExit: (code) => l.run === run && this.exited(session.id, code)
      })
      this.update(l, { terminalId: info.id, live: true, status: 'starting', error: undefined })
    } catch (err) {
      this.deps.server.unregister(session.id)
      this.update(l, { status: 'error', error: (err as Error).message })
      throw err
    }
  }

  private exited(id: string, code: number): void {
    const l = this.live.get(id)
    if (!l) return
    this.deps.server.unregister(id)
    l.acp?.abort.abort()
    l.acp = undefined
    // A turn the agent never finished (it crashed or was stopped) no longer shows as running.
    const last = l.messages[l.messages.length - 1]
    if (last?.role === 'assistant' && last.status === 'streaming') {
      last.status = 'done'
      this.deps.publish('agents:message', { sessionId: id, message: last })
    }
    const failed = code !== 0 && l.session.status === 'starting'
    const name = AGENT_NAMES[l.session.kind]
    this.update(l, {
      terminalId: undefined,
      live: false,
      status: failed ? 'error' : 'ended',
      error: failed ? `${name} stopped right away (exit code ${code}). Is it installed and signed in?` : l.session.error
    })
    this.deps.events.emit('session.ended', { actor: { kind: 'agent', id: l.session.kind }, projectId: l.session.projectId, conversationId: id, payload: { code } })
    this.scheduleJournal(l, 0)
  }

  /**
   * Codex / Gemini over ACP: start the agent, shake hands, open a session
   * with Mindeck's memory as MCP server (when the agent takes HTTP servers).
   * Runs in the background — a slow first start (e.g. npx) never blocks.
   */
  private launchAcp(l: Live, prompt?: string): void {
    const { session } = l
    const kind = session.kind as AcpKind
    const run = (l.run = (l.run ?? 0) + 1)
    const token = this.deps.server.register(session.id)
    const proc = this.deps.spawnAcp(ACP_AGENTS[kind], session.cwd, shellEnv())
    const link: AcpLink = { proc, abort: new AbortController() } as AcpLink
    link.conn = new ClientSideConnection(
      () => ({
        requestPermission: (params) => this.acpPermission(l, link, params),
        sessionUpdate: ({ update }) => this.applied(l, applyAcpUpdate(this.state(l), update))
      }),
      proc.stream
    )
    link.ready = (async () => {
      const init = await link.conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const mcpServers = init.agentCapabilities?.mcpCapabilities?.http
        ? [{ type: 'http' as const, name: 'mindeck', url: this.deps.server.url('mcp', session.id), headers: [{ name: 'Authorization', value: `Bearer ${token}` }] }]
        : []
      return (await link.conn.newSession({ cwd: session.cwd, mcpServers })).sessionId
    })()
    l.acp = link
    proc.onExit((code) => l.run === run && this.exited(session.id, code))
    this.update(l, { live: true, status: 'starting', terminalId: undefined, error: undefined })
    link.ready.then(
      () => {
        if (l.acp !== link) return
        this.update(l, { status: 'idle' })
        if (prompt) this.acpSend(l, link, prompt)
      },
      (err: Error) => {
        if (l.acp !== link) return
        this.update(l, { status: 'error', error: `${ACP_AGENTS[kind].name} could not start: ${err.message}` })
        proc.kill()
      }
    )
  }

  /** One prompt turn with an ACP agent: the user's message, then streamed updates until it stops. */
  private async acpSend(l: Live, link: AcpLink, text: string): Promise<void> {
    const user: ChatMessage = { id: randomUUID(), role: 'user', parts: [{ type: 'text', text }], createdAt: new Date().toISOString(), status: 'done' }
    l.messages.push(user)
    const turn = openTurn(this.state(l))
    this.applied(l, { changed: [user, turn] })
    this.update(l, { status: 'working' })
    try {
      const { stopReason } = await link.conn.prompt({ sessionId: await link.ready, prompt: [{ type: 'text', text }] })
      turn.status = stopReason === 'cancelled' ? 'cancelled' : 'done'
    } catch (err) {
      turn.status = 'error'
      turn.error = (err as Error).message
    }
    // The agent went away meanwhile: the turn's end still reaches the UI (no spinner forever).
    if (l.acp !== link) {
      if (this.live.get(l.session.id) === l) this.applied(l, { changed: [turn] })
      return
    }
    this.update(l, { status: 'idle' })
    this.applied(l, { changed: [turn], attention: 'done' })
  }

  /** An ACP agent asks permission: Mindeck's approval gate decides, the agent's option is picked. */
  private async acpPermission(l: Live, link: AcpLink, params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const kind = l.session.kind
    const call = params.toolCall
    const name = call.title ?? 'tool'
    const risk = kindRisk(call.kind)
    const hit = findAcpTool(l, call.toolCallId)
    if (hit) hit.part.status = 'awaiting-approval'
    let decision: ApprovalDecision = 'once'
    if (risk === 'execute' || !(await this.deps.permissions.isGranted(kind, name))) {
      const asked = this.deps.permissions.ask(
        {
          runId: l.session.id,
          conversationId: l.session.id,
          agentId: kind,
          agentName: AGENT_NAMES[kind],
          toolName: name,
          toolTitle: name,
          risk,
          summary: name,
          reason: '',
          input: call.rawInput ?? {},
          allowAlways: risk !== 'execute'
        },
        link.abort.signal
      )
      if (hit) hit.part.requestId = asked.id
      this.update(l, { status: 'approval' })
      this.applied(l, { changed: hit ? [hit.message] : [], attention: 'approval' })
      decision = await asked.decision
    }
    if (hit) {
      hit.part.status = decision === 'deny' ? 'denied' : 'running'
      this.applied(l, { changed: [hit.message] })
    }
    this.update(l, { status: 'working' })
    const optionId = pickOption(params.options, decision)
    return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } }
  }

  /** Claude Code asks permission for a tool: Mindeck's approval gate decides. */
  private async approve(l: Live, e: HookEvent, signal: AbortSignal): Promise<unknown> {
    const applied = applyHook(this.state(l), e)
    const name = e.tool_name ?? 'tool'
    const risk = toolRisk(name)
    const part = this.tool(l, e.tool_use_id)
    let decision: ApprovalDecision = 'once'
    if (risk === 'execute' || !(await this.deps.permissions.isGranted('claude-code', name))) {
      const input = e.tool_input ?? {}
      const asked = this.deps.permissions.ask(
        {
          runId: l.session.id,
          conversationId: l.session.id,
          agentId: 'claude-code',
          agentName: AGENT_NAMES['claude-code'],
          toolName: name,
          toolTitle: toolTitle(name),
          risk,
          summary: toolSummary(name, input),
          reason: '',
          input,
          // Commands are asked every time; file and memory tools can be allowed for good.
          allowAlways: risk !== 'execute'
        },
        signal
      )
      if (part) part.requestId = asked.id
      this.applied(l, applied)
      decision = await asked.decision
    }
    if (part) part.status = decision === 'deny' ? 'denied' : 'running'
    this.applied(l, { changed: applied.changed })
    this.update(l, { status: 'working' })
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: decision === 'deny' ? { behavior: 'deny', message: 'The user denied this in Mindeck.' } : { behavior: 'allow' }
      }
    }
  }

  /** Push what a hook changed: messages, the session itself, a notification, the journal. */
  private applied(l: Live, applied: Applied): void {
    for (const message of applied.changed) this.deps.publish('agents:message', { sessionId: l.session.id, message })
    this.update(l, {})
    if (!applied.attention) return
    const body =
      applied.attention === 'approval' ? 'Waiting for your approval' : applied.attention === 'waiting' ? 'Waiting for your answer' : 'Done — your turn'
    const name = AGENT_NAMES[l.session.kind]
    this.deps.notify?.(l.session.title === name ? name : `${name} · ${l.session.title}`, body, l.session.id)
    if (applied.attention === 'done') this.scheduleJournal(l, JOURNAL_DELAY_MS)
  }

  private usedNote(l: Live, tool: string, input: Record<string, unknown>): void {
    const note =
      tool === 'memory_create_note'
        ? `${input.folder ? `${String(input.folder).replace(/\/$/, '')}/` : ''}${String(input.title)}.md`
        : typeof input.path === 'string'
          ? input.path
          : undefined
    if (!note || l.session.notes.includes(note)) return
    this.update(l, { notes: [...l.session.notes, note].slice(-MAX_NOTES) })
  }

  private scheduleJournal(l: Live, delay: number): void {
    if (this.disposed) return // shutting down: the session file keeps everything
    clearTimeout(l.journalTimer)
    l.journalTimer = setTimeout(() => void this.writeJournal(l), delay)
  }

  private async writeJournal(l: Live): Promise<void> {
    try {
      const body = journalBody(l.session, l.messages, await this.changes(l.session.id).catch(() => []))
      if (!body) return
      const path = await this.deps.journal(`Agents/${l.session.projectName}`, journalTitle(l.session, l.messages), l.session.journal, body)
      if (path && path !== l.session.journal) this.update(l, { journal: path })
    } catch (err) {
      console.warn('[agents] journal not written:', (err as Error).message)
    }
  }

  private async dropWorktree(l: Live): Promise<void> {
    await this.deps.git.removeWorktree(l.projectPath, l.session.worktree!, l.session.branch!)
    this.update(l, { worktree: undefined, cwd: l.projectPath, status: 'ended', live: false, terminalId: undefined })
    // The journal keeps the record; the diff now belongs to the project.
    l.baseline = null
  }

  private update(l: Live, patch: Partial<AgentSession>): void {
    l.session = { ...l.session, ...patch, updatedAt: new Date().toISOString() }
    this.deps.publish('agents:changed', { session: l.session })
    void this.persist(l)
  }

  /** Atomic writes, one after another (hooks can come in bursts). */
  private persist(l?: Live): Promise<void> {
    this.writes = this.writes.then(async () => {
      const atomic = async (file: string, data: string) => {
        await writeFile(`${file}.tmp`, data)
        await rename(`${file}.tmp`, file)
      }
      try {
        if (l && this.live.has(l.session.id)) await atomic(this.file(l.session.id), JSON.stringify(l.messages))
        const sessions = [...this.live.values()].map(({ session, baseline, projectPath }) => ({ session, baseline, projectPath }))
        await atomic(join(this.deps.dir, 'sessions.json'), JSON.stringify({ version: 1, sessions }))
      } catch (err) {
        console.warn('[agents] could not save sessions:', (err as Error).message)
      }
    })
    return this.writes
  }

  /** The transcript state the hook reducer works on, written back into the record. */
  private state(l: Live) {
    return {
      get status() {
        return l.session.status
      },
      set status(status) {
        l.session = { ...l.session, status }
      },
      messages: l.messages,
      get plan() {
        return l.session.plan
      },
      set plan(plan) {
        l.session = { ...l.session, plan }
      }
    }
  }

  private tool(l: Live, id: string | undefined): ToolCallPart | undefined {
    for (const m of l.messages) {
      const part = m.parts.find((p): p is ToolCallPart => p.type === 'tool' && p.id === id)
      if (part) return part
    }
    return undefined
  }

  private file(id: string): string {
    return join(this.deps.dir, `${id}.json`)
  }

  private require(id: string): Live {
    const l = this.live.get(id)
    if (!l) throw coded('not-found', 'Unknown agent session')
    return l
  }

  private running(id: string): string {
    const terminalId = this.require(id).session.terminalId
    if (!terminalId) throw coded('not-running', 'The agent is not running — resume the session first')
    return terminalId
  }

  private isolated(id: string): Live {
    const l = this.require(id)
    if (!l.session.worktree || !l.session.branch || !l.baseline) throw coded('not-isolated', 'This session works directly in the project')
    return l
  }
}
