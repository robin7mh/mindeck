import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk'
import type { PermissionOption, SessionUpdate, ToolKind } from '@agentclientprotocol/sdk'
import type { ApprovalDecision, ChatMessage, ToolCallPart, ToolCallStatus, ToolRisk } from '@shared/types/ai'
import { shellCommand, shellQuote } from '../terminal/TerminalService'
import type { Applied, SessionState } from './transcript'

/** How Mindeck starts each ACP agent (the user's own CLI, signed in their way). */
export type AcpKind = 'codex' | 'gemini'

export const ACP_AGENTS: Record<AcpKind, { name: string; file: string; args: string[] }> = {
  // OpenAI's Codex through Zed's ACP adapter; uses the Codex sign-in (ChatGPT plan or API key).
  codex: { name: 'Codex', file: 'npx', args: ['-y', '@zed-industries/codex-acp@0.16'] },
  gemini: { name: 'Gemini CLI', file: 'gemini', args: ['--experimental-acp'] }
}

/** A running ACP agent: its JSON-RPC stream and the process behind it. */
export interface AcpProcess {
  stream: Stream
  kill(): void
  onExit(cb: (code: number) => void): void
}

/** Start an agent through the user's login shell (their PATH), talking ACP over stdio. */
export function spawnAcp(command: { file: string; args: string[] }, cwd: string, env: Record<string, string>): AcpProcess {
  const line = [command.file, ...command.args].map(shellQuote).join(' ')
  const child =
    process.platform === 'win32'
      ? spawn(command.file, command.args, { cwd, env, windowsHide: true })
      : spawn(shellCommand().file, ['-lc', `exec ${line}`], { cwd, env })
  child.stderr.resume() // agents log there; never let the pipe fill up
  // A start that fails (not on PATH, …) emits 'error' and never 'exit': unhandled, it would take the app down.
  let spawnError = false
  child.on('error', () => {
    if (child.pid === undefined) spawnError = true
  })
  return {
    stream: ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
    kill: () => void child.kill(),
    onExit: (cb) => {
      child.on('exit', (code) => cb(code ?? 0))
      child.on('close', (code) => spawnError && cb(code ?? 1))
    }
  }
}

/** read / search / think / fetch only look; edit / delete / move change files; the rest runs things. */
export function kindRisk(kind: ToolKind | null | undefined): ToolRisk {
  if (kind === 'read' || kind === 'search' || kind === 'think' || kind === 'fetch') return 'read'
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return 'write'
  return 'execute'
}

const STATUS: Record<string, ToolCallStatus> = { pending: 'running', in_progress: 'running', completed: 'done', failed: 'error' }

const OUTPUT_LIMIT = 4000
function outputText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1)
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… [${text.length - OUTPUT_LIMIT} more characters]` : text
}

/** The assistant turn in progress (opened when the user sends). */
export function openTurn(state: SessionState): ChatMessage {
  const last = state.messages[state.messages.length - 1]
  if (last?.role === 'assistant' && last.status === 'streaming') return last
  const turn: ChatMessage = { id: randomUUID(), role: 'assistant', parts: [], createdAt: new Date().toISOString(), status: 'streaming' }
  state.messages.push(turn)
  return turn
}

/** A tool card and the message it lives in. */
export function findAcpTool(state: Pick<SessionState, 'messages'>, id: string): { message: ChatMessage; part: ToolCallPart } | undefined {
  for (const message of state.messages) {
    const part = message.parts.find((p): p is ToolCallPart => p.type === 'tool' && p.id === id)
    if (part) return { message, part }
  }
  return undefined
}

/**
 * Folds one ACP `session/update` into the session: streamed text, tool cards,
 * the plan. Like the Claude hooks, unknown updates are ignored.
 */
export function applyAcpUpdate(state: SessionState, update: SessionUpdate): Applied {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      if (update.content.type !== 'text') return { changed: [] }
      const turn = openTurn(state)
      const last = turn.parts[turn.parts.length - 1]
      if (last?.type === 'text') last.text += update.content.text
      else turn.parts.push({ type: 'text', text: update.content.text })
      state.status = 'working'
      return { changed: [turn] }
    }
    case 'tool_call': {
      const turn = openTurn(state)
      const part: ToolCallPart = {
        type: 'tool',
        id: update.toolCallId,
        name: update.title,
        title: update.title,
        risk: kindRisk(update.kind),
        input: update.rawInput ?? {},
        status: STATUS[update.status ?? 'pending']
      }
      turn.parts.push(part)
      state.status = 'working'
      return { changed: [turn] }
    }
    case 'tool_call_update': {
      const hit = findAcpTool(state, update.toolCallId)
      if (!hit) return { changed: [] }
      if (update.status) hit.part.status = STATUS[update.status]
      if (update.title) hit.part.title = update.title
      if (update.rawOutput !== undefined && update.rawOutput !== null) hit.part.output = outputText(update.rawOutput)
      return { changed: [hit.message] }
    }
    case 'plan':
      state.plan = update.entries.map((e, i) => ({ id: `plan-${i}`, text: e.content, done: e.status === 'completed' }))
      return { changed: [] }
    default:
      return { changed: [] }
  }
}

/** Mindeck's decision → the agent's matching option ("always" falls back to once). */
export function pickOption(options: PermissionOption[], decision: ApprovalDecision): string | undefined {
  const wanted =
    decision === 'deny' ? ['reject_once', 'reject_always'] : decision === 'always' ? ['allow_always', 'allow_once'] : ['allow_once', 'allow_always']
  for (const kind of wanted) {
    const hit = options.find((o) => o.kind === kind)
    if (hit) return hit.optionId
  }
  return undefined
}
