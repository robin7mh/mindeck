import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve, sep } from 'node:path'
import type { ChatMessage, ToolCallPart, ToolRisk } from '@shared/types/ai'
import type { PlanItem, SessionStatus } from '@shared/types/agents'
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
  if (READ.has(name) || /^mcp__mindeck__(memory_search|memory_read|memory_list|project_context|browser_(tabs|snapshot|read|screenshot|console))$/.test(name)) return 'read'
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
 * The risk an approval carries: `toolRisk`, except that looking outside the
 * project (Read/Glob/Grep/LS on `~/.ssh`) and fetching from the web (a way out
 * for whatever was read) count as changes — a device allows them only with
 * remote shells, like any change.
 */
export function approvalRisk(name: string, input: Record<string, unknown> = {}, cwd?: string): ToolRisk {
  const risk = toolRisk(name)
  if (risk !== 'read') return risk
  if (name === 'WebFetch') return 'write'
  const paths = ['file_path', 'notebook_path', 'path'].map((k) => input[k]).filter((v): v is string => typeof v === 'string')
  return paths.some((p) => reachesOutside(p, cwd)) ? 'write' : 'read'
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
      state.status = 'ended'
      break
  }
  return { changed: [...changed], attention }
}
