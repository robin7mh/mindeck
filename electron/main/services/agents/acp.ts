import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk'
import type { AvailableCommand, PermissionOption, SessionConfigOption, SessionModeState, SessionUpdate, ToolKind } from '@agentclientprotocol/sdk'
import type { ApprovalDecision, ChatMessage, ToolCallPart, ToolCallStatus, ToolRisk } from '@shared/types/ai'
import type { AgentCommand, AgentSession, SessionOption } from '@shared/types/agents'
import { shellCommand, shellQuote } from '../terminal/TerminalService'
import { spawnProgram } from '../../lib/executables'
import { reachesOutside, type Applied, type SessionState } from './transcript'

/** How Mindeck starts each ACP agent (the user's own CLI, signed in their way). */
export type AcpKind = 'codex' | 'gemini'

export const ACP_AGENTS: Record<AcpKind, { name: string; file: string; args: string[] }> = {
  // OpenAI's Codex through Zed's ACP adapter; uses the Codex sign-in (ChatGPT plan or API key).
  // An exact version: npx fetches it at run time, and a range would run whatever was published last.
  // npm never lets a version be published twice, and the adapter pins its platform binaries exactly:
  // with npm's integrity check of the tarball this runs exactly what was released (see isolatedNpx).
  codex: { name: 'Codex', file: 'npx', args: ['-y', '@zed-industries/codex-acp@0.16.0'] },
  gemini: { name: 'Gemini CLI', file: 'gemini', args: ['--experimental-acp'] }
}

/** A running ACP agent: its JSON-RPC stream and the process behind it. */
export interface AcpProcess {
  stream: Stream
  kill(): void
  onExit(cb: (code: number) => void): void
}

/**
 * npx's arguments with its project set to `prefix`, a folder of Mindeck's:
 * in the agent's folder (a cloned repository) npx would run a package of
 * the same name from its node_modules and fetch from the registry its
 * .npmrc names. The adapter still runs in the agent's folder.
 */
export function isolatedNpx(command: { file: string; args: string[] }, prefix?: string): { file: string; args: string[] } {
  return prefix && command.file === 'npx' ? { ...command, args: ['--prefix', prefix, ...command.args] } : command
}

/**
 * Start an agent through the user's login shell (their PATH), talking ACP
 * over stdio. Windows: directly, the program from the PATH (spawnProgram).
 * `npmPrefix`: see isolatedNpx.
 */
export function spawnAcp(command: { file: string; args: string[] }, cwd: string, env: Record<string, string>, npmPrefix?: string): AcpProcess {
  const { file, args } = isolatedNpx(command, npmPrefix)
  const line = [file, ...args].map(shellQuote).join(' ')
  const child = process.platform === 'win32' ? spawnProgram(file, args, { cwd, env }) : spawn(shellCommand().file, ['-lc', `exec ${line}`], { cwd, env })
  child.stderr!.resume() // agents log there; never let the pipe fill up
  return {
    stream: ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>),
    kill: () => void child.kill(),
    onExit: (cb) => void child.on('exit', (code) => cb(code ?? 0))
  }
}

/** spawnAcp with npx isolated in `npmPrefix` (see isolatedNpx). */
export const acpSpawner =
  (npmPrefix: string) =>
  (command: { file: string; args: string[] }, cwd: string, env: Record<string, string>): AcpProcess =>
    spawnAcp(command, cwd, env, npmPrefix)

/** read / search / think / fetch only look; edit / delete / move change files; the rest runs things. */
export function kindRisk(kind: ToolKind | null | undefined): ToolRisk {
  if (kind === 'read' || kind === 'search' || kind === 'think' || kind === 'fetch') return 'read'
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return 'write'
  return 'execute'
}

/**
 * The risk an approval carries: by kind, except that fetching (a way out for
 * whatever was read) and reading outside the session's folder count as changes —
 * a device allows them only with remote shells.
 */
export function acpApprovalRisk(kind: ToolKind | null | undefined, paths: string[], cwd: string): ToolRisk {
  if (kind === 'fetch') return 'write'
  const risk = kindRisk(kind)
  return risk === 'read' && paths.some((p) => reachesOutside(p, cwd)) ? 'write' : risk
}

/**
 * What "always allow" is remembered by: the tool's kind (edit, read, …) —
 * stable, unlike its title, which names the file or command each time.
 */
export function grantKey(kind: ToolKind | null | undefined): string {
  return kind ?? 'other'
}

/** How a tool kind reads in an approval and a push (never the title: it can name files or commands). */
export const KIND_TITLES: Record<string, string> = {
  read: 'Read files',
  edit: 'Edit files',
  delete: 'Delete files',
  move: 'Move files',
  search: 'Search',
  execute: 'Run command',
  think: 'Think',
  fetch: 'Fetch page',
  switch_mode: 'Switch mode',
  other: 'Tool'
}

/**
 * The older, unstable way agents offered models (`session/set_model`): still
 * what some ACP adapters send next to (or instead of) config options.
 */
export interface LegacyModels {
  currentModelId: string
  availableModels: { modelId: string; name: string; description?: string | null }[]
}

/** How the session's model and mode are switched: a config option, or the dedicated method. */
export interface AcpControls {
  model?: { configId: string } | { legacy: true }
  mode?: { configId: string } | { legacy: true }
}

/** The agent's answer to `session/new` (and later updates): what it offers, and how to switch it. */
export interface SessionSetup {
  modes?: SessionModeState | null
  configOptions?: SessionConfigOption[] | null
  models?: LegacyModels | null
}

const option = (id: string, name: string, description?: string | null): SessionOption => (description ? { id, name, description } : { id, name })

function selectOptions(o: SessionConfigOption & { type: 'select' }): SessionOption[] {
  return o.options.flatMap((x) => ('group' in x ? x.options : [x])).map((x) => option(x.value, x.name, x.description))
}

/**
 * Models and modes from a session setup: config options first (the current
 * protocol), the session's modes and the legacy model list where they're missing.
 */
export function sessionControls(setup: SessionSetup): { patch: Partial<AgentSession>; controls: AcpControls } {
  const patch: Partial<AgentSession> = {}
  const controls: AcpControls = {}
  const config = (category: string) => setup.configOptions?.find((o) => o.category === category)
  const model = config('model')
  if (model?.type === 'select') {
    Object.assign(patch, { models: selectOptions(model), model: model.currentValue })
    controls.model = { configId: model.id }
  } else if (setup.models?.availableModels.length) {
    Object.assign(patch, { models: setup.models.availableModels.map((m) => option(m.modelId, m.name, m.description)), model: setup.models.currentModelId })
    controls.model = { legacy: true }
  }
  const mode = config('mode')
  if (mode?.type === 'select') {
    Object.assign(patch, { modes: selectOptions(mode), mode: mode.currentValue })
    controls.mode = { configId: mode.id }
  } else if (setup.modes?.availableModes.length) {
    Object.assign(patch, { modes: setup.modes.availableModes.map((m) => option(m.id, m.name, m.description)), mode: setup.modes.currentModeId })
    controls.mode = { legacy: true }
  }
  return { patch, controls }
}

/** The agent's slash commands, as the composer suggests them. */
export function acpCommands(list: AvailableCommand[]): AgentCommand[] {
  return list.map((c) => (c.input ? { name: c.name, description: c.description, hint: c.input.hint } : { name: c.name, description: c.description }))
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
