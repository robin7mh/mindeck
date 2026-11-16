import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ChatMessage, ToolCallPart, ToolRisk } from '@shared/types/ai'
import type { PlanItem, PlanStatus, SessionStatus } from '@shared/types/agents'
import { landsAt } from '../../lib/confine'
import { approvedHint, PLAN_TOOL_KEY, stopHint, writtenStep } from './planTool'
import { isDeniedName } from '../../server/RemoteAccess'

/** A Claude Code hook event (common fields + whatever the event adds). */
export interface HookEvent {
  hook_event_name: string
  session_id?: string
  transcript_path?: string
  cwd?: string
  prompt?: string
  user_prompt?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_use_id?: string
  tool_response?: unknown
  error?: unknown
  last_assistant_message?: string
  notification_type?: string
  message?: string
  task_id?: string
  /** A task's title (TaskCreated, TaskCompleted); `task_description` may say more. */
  task_subject?: string
  task_description?: string
  /** The permission mode Claude Code runs in (`plan` while it plans first). */
  permission_mode?: string
  /** Stop: it goes on because a stop hook said so. */
  stop_hook_active?: boolean
  source?: string
  reason?: string
}

/** A SessionEnd the agent goes on after: `/clear` and `/resume` start another conversation in the same process. */
export const conversationOnly = (e: HookEvent) => e.reason === 'clear' || e.reason === 'resume'

/** The part of a session the hooks change. */
export interface SessionState {
  status: SessionStatus
  messages: ChatMessage[]
  plan: PlanItem[]
  planStatus?: PlanStatus
  /** The mode the user chose for the session (`plan`: plan first). */
  readonly mode?: string
}

const OUTPUT_LIMIT = 4000

const READ = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ToolSearch'])
const WRITE = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
/** Tools that ask the user something (its plan, its questions) — no work on the project. */
const ASKS_USER = new Set(['ExitPlanMode', 'AskUserQuestion'])

/** read: looks only · write: changes files · execute: runs things (asked every time). */
export function toolRisk(name: string): ToolRisk {
  if (READ.has(name) || /^mcp__mindeck__(memory_search|memory_read|memory_list|project_context|browser_(tabs|snapshot|read|screenshot|console)|terminal_read|plan_update)$/.test(name)) return 'read'
  // Starting a command in a Mindeck terminal is running one, like the agent's own shell.
  if (name === 'mcp__mindeck__terminal_run') return 'execute'
  if (WRITE.has(name) || /^mcp__mindeck__/.test(name)) return 'write'
  return 'execute'
}

/**
 * A path an agent wants to look at that leaves its folder (`/etc`, `~/.ssh/…`,
 * `../other`) or names keys and credentials. Without a folder to compare with,
 * any absolute path does.
 */
export function reachesOutside(path: string, cwd?: string): boolean {
  if (path.startsWith('~') || path.split(/[\\/]+/).some(isDeniedName)) return true
  if (!cwd) return isAbsolute(path)
  const root = resolve(cwd)
  const abs = resolve(root, path)
  return abs !== root && !abs.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Files in a folder that run by themselves once written, with no approval of a
 * command: agents' hooks and servers, git's hooks and config, what an editor or
 * a dev container runs when the folder opens.
 */
const RUN_BY_THEMSELVES = new Set(['.claude', '.mcp.json', '.gemini', '.codex', '.cursor', '.git', '.githooks', '.husky', '.devcontainer', '.vscode'])

/** A path among them, inside the folder, ignoring case and what Windows ignores (`.git.`, `.git::$INDEX_ALLOCATION`). */
export function runsByItself(path: string, cwd?: string): boolean {
  const inside = cwd ? relative(resolve(cwd), resolve(cwd, path)) : path
  return inside.split(/[\\/]+/).some((name) => RUN_BY_THEMSELVES.has(name.toLowerCase().replace(/[. ]*(?::.*)?$/, '')))
}

/** A pattern's braces, written out; past this many it isn't looked at (and asks). */
const MAX_ALTERNATIVES = 256

function alternatives(pattern: string): string[] {
  const open = [pattern]
  const done: string[] = []
  for (let p = open.pop(); p !== undefined; p = open.pop()) {
    const brace = /\{([^{}]*)\}/.exec(p)
    if (!brace) done.push(p)
    else for (const option of brace[1].split(',')) open.push(p.slice(0, brace.index) + option + p.slice(brace.index + brace[0].length))
    if (open.length + done.length > MAX_ALTERNATIVES) return ['..']
  }
  return done
}

/**
 * The paths a tool call names. A Glob's pattern says where it looks, relative
 * to its `path`, in every alternative of its braces, and any `..` in one leaves
 * (`**\/../x` is `../x` when `**` is nothing); a Grep's is what it looks for.
 */
export function toolPaths(name: string, input: Record<string, unknown> = {}): string[] {
  const named = ['file_path', 'notebook_path', 'path'].map((k) => input[k]).filter((v): v is string => typeof v === 'string')
  if (name !== 'Glob' || typeof input.pattern !== 'string') return named
  const { path } = input
  const fromPath = (p: string) => (typeof path === 'string' && !isAbsolute(p) && !p.startsWith('~') ? join(path, p) : p)
  return [...named, ...alternatives(input.pattern).map((p) => (p.split(/[\\/]+/).includes('..') ? '..' : fromPath(p)))]
}

/**
 * Where paths that stay in the folder as written really land, named from `cwd`
 * as `reachesOutside` and `runsByItself` read them: a cloned repository can
 * bring `vendor -> ~`, and `vendor/.zshenv` looks inside. A file yet to come
 * lands by its nearest existing parent. Those outside as written were decided
 * without asking the disk (on Windows, asking `\\\\host\\share` sends the user's
 * credentials there); one that can't be told counts as outside.
 */
export async function landings(paths: string[], cwd: string): Promise<string[]> {
  const written = paths.filter((path) => !reachesOutside(path, cwd))
  const root = written.length ? await realpath(cwd).catch(() => null) : null
  if (!root) return []
  return Promise.all(
    written.map(async (path) => {
      const real = await landsAt(root, resolve(root, relative(resolve(cwd), resolve(cwd, path))))
      if (!real) return '..'
      return real === root || real.startsWith(root + sep) ? relative(root, real) : real
    })
  )
}

/**
 * Whether a tool call stays in the session's folder and away from keys, as
 * written and where it really `lands` (see `landings`), and if it changes
 * something, away from files that run by themselves. Only then an "Always
 * allow" holds for it: a grant from `Write src/a.ts` must not cover
 * `Write ~/.zshenv`, which runs at the next login without any approval of a command.
 */
export function staysInside(name: string, input: Record<string, unknown> = {}, cwd?: string, lands: string[] = []): boolean {
  const paths = [...toolPaths(name, input), ...lands]
  if (paths.some((path) => reachesOutside(path, cwd))) return false
  return toolRisk(name) !== 'write' || !paths.some((path) => runsByItself(path, cwd))
}

/**
 * The risk an approval carries: `toolRisk`, except that looking outside the
 * project (Read/Glob/Grep/LS on `~/.ssh`) and fetching from the web (a way out
 * for whatever was read) count as changes — a device allows them only with
 * remote shells, like any change.
 */
export function approvalRisk(name: string, input: Record<string, unknown> = {}, cwd?: string, lands: string[] = []): ToolRisk {
  const risk = toolRisk(name)
  if (risk !== 'read') return risk
  if (name === 'WebFetch') return 'write'
  return staysInside(name, input, cwd, lands) ? 'read' : 'write'
}

const TITLES: Record<string, string> = {
  Bash: 'Run command',
  Read: 'Read file',
  Edit: 'Edit file',
  MultiEdit: 'Edit file',
  Write: 'Write file',
  NotebookEdit: 'Edit notebook',
  Glob: 'Find files',
  Grep: 'Search code',
  LS: 'List folder',
  WebFetch: 'Fetch page',
  WebSearch: 'Search the web',
  TodoWrite: 'Update plan',
  Task: 'Subagent',
  Agent: 'Subagent'
}

export function toolTitle(name: string): string {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name)
  if (mcp && mcp[1] === 'mindeck' && mcp[2].startsWith('browser_')) return `Mindeck browser · ${mcp[2].slice(8)}`
  if (mcp && mcp[1] === 'mindeck' && mcp[2].startsWith('terminal_')) return `Mindeck terminal · ${mcp[2].slice(9)}`
  if (name === PLAN_TOOL_KEY) return 'Update plan'
  if (mcp) return mcp[1] === 'mindeck' ? `Mindeck memory · ${mcp[2].replace(/_/g, ' ')}` : `${mcp[1]} · ${mcp[2].replace(/_/g, ' ')}`
  return TITLES[name] ?? name
}

/** One line for an approval: what exactly the agent wants to do. */
export function toolSummary(name: string, input: Record<string, unknown> = {}): string {
  const first = ['command', 'file_path', 'notebook_path', 'path', 'url', 'query', 'pattern', 'title', 'description'].map((k) => input[k]).find((v) => typeof v === 'string')
  return first ? `${toolTitle(name)}: ${String(first)}` : toolTitle(name)
}

function outputText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1)
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… [${text.length - OUTPUT_LIMIT} more characters]` : text
}

const now = () => new Date().toISOString()

/** The assistant turn in progress (created on demand, e.g. after a resume). */
function currentTurn(state: SessionState): ChatMessage {
  const last = state.messages[state.messages.length - 1]
  if (last?.role === 'assistant' && last.status === 'streaming') return last
  const turn: ChatMessage = { id: randomUUID(), role: 'assistant', parts: [], createdAt: now(), status: 'streaming' }
  state.messages.push(turn)
  return turn
}

function findTool(state: SessionState, id: string | undefined): ToolCallPart | undefined {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const part = state.messages[i].parts.find((p): p is ToolCallPart => p.type === 'tool' && p.id === id)
    if (part) return part
  }
  return undefined
}

/**
 * The card a tool event is about: the one with its tool id. A PermissionRequest
 * comes without one — then the latest card of that tool still open (the one its
 * PreToolUse started), the one with the same input first.
 */
export function toolOf(state: SessionState, e: HookEvent): ToolCallPart | undefined {
  if (e.tool_use_id) return findTool(state, e.tool_use_id)
  const input = JSON.stringify(e.tool_input ?? {})
  let open: ToolCallPart | undefined
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const parts = state.messages[i].parts
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const p = parts[j]
      if (p.type !== 'tool' || p.name !== e.tool_name || (p.status !== 'running' && p.status !== 'awaiting-approval')) continue
      if (JSON.stringify(p.input) === input) return p
      open ??= p
    }
  }
  return open
}

function addTool(state: SessionState, e: HookEvent): ToolCallPart {
  const name = e.tool_name ?? 'tool'
  const part: ToolCallPart = {
    type: 'tool',
    id: e.tool_use_id ?? randomUUID(),
    name,
    title: toolTitle(name),
    risk: toolRisk(name),
    input: e.tool_input ?? {},
    status: 'running'
  }
  currentTurn(state).parts.push(part)
  return part
}

/** Claude's own to-do list (TodoWrite) becomes the session plan. */
function planFromTodos(input: Record<string, unknown>): PlanItem[] | undefined {
  if (!Array.isArray(input.todos)) return undefined
  return input.todos.map((t: { content?: string; status?: string }, i) => ({
    id: `todo-${i}`,
    text: String(t.content ?? ''),
    done: t.status === 'completed',
    active: t.status === 'in_progress'
  }))
}

/** A plan step's words: its Markdown (bold, code, links, a trailing colon or full stop) taken off, long ones cut at a word. */
function stepText(raw: string): string {
  const text = raw
    .replace(/\*\*|__/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(?<!\.)[:：.]\s*$/, '')
    .trim()
  return text.length > 120 ? `${text.slice(0, 120).replace(/\s+\S*$/, '')}…` : text
}

/**
 * The steps of a plan written in Markdown: its top-level numbered items — or,
 * without any (and not `ordered`), its bullets and task boxes — each by its
 * bold lead-in ("**Add tests:** the pure …" → "Add tests"), else in full. So a
 * "Verification" list of bullets under numbered steps is no step. `prefix`
 * tells where the plan came from (ids `<prefix>-<n>`).
 */
export function planFromMarkdown(markdown: string, prefix: string, ordered = false): PlanItem[] {
  const numbered: string[] = []
  const bullets: string[] = []
  for (const line of markdown.split('\n')) {
    const n = /^\d+[.)]\s+(.+)$/.exec(line)
    const b = /^[-*+]\s+(.+)$/.exec(line)
    if (n) numbered.push(n[1])
    else if (b && !ordered) bullets.push(b[1])
  }
  const items: PlanItem[] = []
  for (const line of numbered.length ? numbered : bullets) {
    const box = /^\[([ xX])\]\s+(.*)$/.exec(line)
    const body = box ? box[2] : line
    const lead = /^\*\*(.+?)\*\*/.exec(body)
    const text = stepText(lead ? lead[1] : body)
    if (text) items.push({ id: `${prefix}-${items.length}`, text, done: !!box && box[1] !== ' ' })
  }
  return items
}

/** Claude Code's tasks (TaskCreated/TaskCompleted) are the live plan: a plan only written down gives way to them. */
const tasksOf = (plan: PlanItem[]) => plan.filter((p) => !writtenStep(p))

/** What changed for the rest of Mindeck (messages to push, a notification to show). */
export interface Applied {
  /** Messages that were added or changed. */
  changed: ChatMessage[]
  /** The agent stopped and is now waiting for the user. */
  attention?: 'approval' | 'waiting' | 'done'
  /** The hook's answer to Claude Code (context for it, or that it goes on). */
  reply?: unknown
}

/**
 * Folds one hook event into a session: chat messages with tool cards, the
 * status and the plan. Mutates `state` (the service owns it) and reports what
 * changed. Unknown events are ignored, so newer Claude Code versions don't break.
 */
export function applyHook(state: SessionState, e: HookEvent): Applied {
  const changed = new Set<ChatMessage>()
  let attention: Applied['attention']
  let reply: unknown
  const touch = (m: ChatMessage) => changed.add(m)

  switch (e.hook_event_name) {
    case 'SessionStart':
      if (state.status === 'starting') state.status = 'idle'
      break
    case 'UserPromptSubmit': {
      // A turn still open (interrupted) is closed first.
      const open = state.messages[state.messages.length - 1]
      if (open?.role === 'assistant' && open.status === 'streaming') {
        open.status = 'done'
        touch(open)
      }
      const text = e.prompt ?? e.user_prompt ?? ''
      const user: ChatMessage = { id: randomUUID(), role: 'user', parts: [{ type: 'text', text }], createdAt: now(), status: 'done' }
      state.messages.push(user)
      touch(user)
      touch(currentTurn(state))
      state.status = 'working'
      break
    }
    case 'PreToolUse': {
      const part = findTool(state, e.tool_use_id) ?? addTool(state, e)
      part.status = 'running'
      const input = part.input as Record<string, unknown>
      // Its to-do list (being worked through), or the plan it presents to leave plan mode (Claude Code puts the plan file's text in) — a proposal.
      const todos = e.tool_name === 'TodoWrite' ? planFromTodos(input) : undefined
      const proposed = e.tool_name === 'ExitPlanMode' ? planFromMarkdown(String(input.plan ?? ''), 'mode') : undefined
      if (todos?.length) setPlan(state, todos, 'active')
      if (proposed?.length) setPlan(state, proposed, 'draft')
      touch(currentTurn(state))
      state.status = 'working'
      break
    }
    case 'PermissionRequest': {
      const part = toolOf(state, e) ?? addTool(state, e)
      touch(currentTurn(state))
      // Its questions are answered in its terminal: the user's turn, not an approval.
      if (e.tool_name === 'AskUserQuestion') {
        state.status = 'waiting'
        attention = 'waiting'
        break
      }
      part.status = 'awaiting-approval'
      state.status = 'approval'
      attention = 'approval'
      break
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const part = findTool(state, e.tool_use_id) ?? addTool(state, e)
      const failed = e.hook_event_name === 'PostToolUseFailure'
      part.status = failed ? 'error' : 'done'
      part.output = outputText(failed ? (e.error ?? 'failed') : (e.tool_response ?? ''))
      touch(currentTurn(state))
      state.status = 'working'
      // The plan approved, it carries it out now — and gets the steps to mark as it goes.
      if (!failed && e.tool_name === 'ExitPlanMode' && state.planStatus === 'draft' && state.plan.length && state.plan.every(writtenStep)) {
        state.planStatus = 'active'
        reply = { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: approvedHint(state.plan) } }
      }
      break
    }
    case 'Stop': {
      const turn = currentTurn(state)
      const text = e.last_assistant_message?.trim()
      if (text) turn.parts.push({ type: 'text', text })
      // Planning first, it answered with a numbered plan: that is the plan (a proposal) — unless one came from its tools and isn't through.
      const replaceable = state.plan.every((p) => p.id.startsWith('answer-')) || state.plan.every((p) => p.done)
      if (text && (state.mode === 'plan' || e.permission_mode === 'plan') && replaceable) {
        const plan = planFromMarkdown(text, 'answer', true)
        if (plan.length >= 2) setPlan(state, plan, 'draft')
      }
      // Carrying out a plan, it worked this turn (changed or ran something) and would stop with steps open:
      // asked once to mark what it finished (a turn it only talked in, or one it goes on in because of that, isn't).
      const open = state.planStatus === 'active' && state.plan.length > 0 && state.plan.every(writtenStep) && state.plan.some((p) => !p.done)
      const worked = turn.parts.some((p) => p.type === 'tool' && p.risk !== 'read' && !ASKS_USER.has(p.name))
      if (open && worked && !e.stop_hook_active) {
        touch(turn)
        reply = { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: stopHint(state.plan) } }
        break
      }
      turn.status = 'done'
      touch(turn)
      state.status = 'idle'
      attention = 'done'
      break
    }
    case 'Notification':
      // A question or dialog only the agent's terminal shows. `idle_prompt` ("still waiting for
      // your input", a minute after a finished turn) is no news: Stop already said so.
      if (e.notification_type === 'agent_needs_input' || e.notification_type === 'elicitation_dialog') {
        if (state.status !== 'approval') state.status = 'waiting'
        attention = 'waiting'
      }
      break
    case 'TaskCreated': {
      // Its title is the step (the description, when there is no title).
      const step = { id: String(e.task_id), text: (e.task_subject ?? e.task_description ?? '').trim(), done: false }
      const tasks = tasksOf(state.plan)
      setPlan(state, tasks.some((p) => p.id === step.id) ? tasks.map((p) => (p.id === step.id ? { ...p, text: step.text } : p)) : [...tasks, step], 'active')
      break
    }
    case 'TaskCompleted':
      state.plan = state.plan.map((p) => (p.id === e.task_id ? { ...p, done: true } : p))
      break
    case 'SessionEnd':
      if (!conversationOnly(e)) state.status = 'ended'
      break
  }
  return { changed: [...changed], attention, reply }
}

/** A new plan, proposed or being worked through. */
function setPlan(state: SessionState, plan: PlanItem[], status: PlanStatus): void {
  state.plan = plan
  state.planStatus = status
}
