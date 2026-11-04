import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ChatMessage, ToolCallPart, ToolRisk } from '@shared/types/ai'
import type { PlanItem, SessionStatus } from '@shared/types/agents'
import { landsAt } from '../../lib/confine'
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
  task_description?: string
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
}

const OUTPUT_LIMIT = 4000

const READ = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ToolSearch'])
const WRITE = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** read: looks only · write: changes files · execute: runs things (asked every time). */
export function toolRisk(name: string): ToolRisk {
  if (READ.has(name) || /^mcp__mindeck__(memory_search|memory_read|memory_list|project_context|browser_(tabs|snapshot|read|screenshot|console)|terminal_read)$/.test(name)) return 'read'
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
  return input.todos.map((t: { content?: string; status?: string }, i) => ({ id: `todo-${i}`, text: String(t.content ?? ''), done: t.status === 'completed' }))
}

/** What changed for the rest of Mindeck (messages to push, a notification to show). */
export interface Applied {
  /** Messages that were added or changed. */
  changed: ChatMessage[]
  /** The agent stopped and is now waiting for the user. */
  attention?: 'approval' | 'waiting' | 'done'
}

/**
 * Folds one hook event into a session: chat messages with tool cards, the
 * status and the plan. Mutates `state` (the service owns it) and reports what
 * changed. Unknown events are ignored, so newer Claude Code versions don't break.
 */
export function applyHook(state: SessionState, e: HookEvent): Applied {
  const changed = new Set<ChatMessage>()
  let attention: Applied['attention']
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
      const plan = e.tool_name === 'TodoWrite' ? planFromTodos(part.input as Record<string, unknown>) : undefined
      if (plan) state.plan = plan
      touch(currentTurn(state))
      state.status = 'working'
      break
    }
    case 'PermissionRequest': {
      const part = findTool(state, e.tool_use_id) ?? addTool(state, e)
      part.status = 'awaiting-approval'
      touch(currentTurn(state))
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
      break
    }
    case 'Stop': {
      const turn = currentTurn(state)
      const text = e.last_assistant_message?.trim()
      if (text) turn.parts.push({ type: 'text', text })
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
    case 'TaskCreated':
      state.plan = [...state.plan.filter((p) => p.id !== e.task_id), { id: String(e.task_id), text: String(e.task_description ?? ''), done: false }]
      break
    case 'TaskCompleted':
      state.plan = state.plan.map((p) => (p.id === e.task_id ? { ...p, done: true } : p))
      break
    case 'SessionEnd':
      if (!conversationOnly(e)) state.status = 'ended'
      break
  }
  return { changed: [...changed], attention }
}
