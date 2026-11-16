import { z } from 'zod'
import type { Project } from '@shared/types/project'
import type { TerminalInfo } from '@shared/types/terminal'
import { stripAnsi } from '../../browser/devServers'
import type { ToolContext, ToolDefinition } from './types'
import { truncate } from './builtin'

/** Reading what a command printed runs without asking: only the caller's own commands, from their start to their end. */
export const TERMINAL_READ_TOOLS = ['terminal_read']
/** Every terminal tool; starting a command asks the user, stopping one is a write. */
export const TERMINAL_TOOLS = ['terminal_run', ...TERMINAL_READ_TOOLS, 'terminal_stop']

/** How long terminal_run waits for the first output (a dev server's address, an early error). */
export const FIRST_OUTPUT_MS = 3000
const MAX_OUTPUT = 8000

/** What the tools need from the terminals (TerminalService). */
export interface TerminalAgentApi {
  runVisible(req: { command: string; cwd: string; projectId?: string; by: string }): Promise<{ info: TerminalInfo; opened: boolean; start: number }>
  output(id: string, from?: number, to?: number): string
  /** Where the command typed at `from` ended (OSC 133;D), if it has, and how far the output reaches now. */
  ended(id: string, from: number): { at?: number; now: number }
  write(id: string, data: string): void
  /** The Terminal's tabs, with what runs in them now. */
  list(): TerminalInfo[]
}

/** A command an agent started, and where. */
interface Run {
  id: string
  command: string
  /** Whose it is: the conversation (an agent session) and its project. */
  owner: string
  /** The terminal's output length before the command. */
  start: number
  /** …and when the command ended: what follows is the user's again (a reused terminal is theirs). */
  end?: number
  /** It was seen running (a shell without command marks has ended once it is back in front). */
  seen?: boolean
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Output as the terminal shows it: no colors or cursor moves, a line redrawn with \r only as its last state. */
export function plainOutput(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n')
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    if (signal.aborted) return done()
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', () => (clearTimeout(timer), done()), { once: true })
  })

const reason = z.string().min(1).max(500).describe('One sentence for the user: why this action is needed')
const terminal = z.string().max(100).optional().describe('Terminal id from terminal_run (default: the last one you started a command in)')

/**
 * Mindeck's terminals for agents — through the ToolRegistry for the assistant
 * and through Mindeck's MCP server for Claude Code, Codex and Gemini. Whatever
 * keeps running (a dev server, a watcher, a game) belongs where the user sees
 * and stops it: in the first terminal waiting at its prompt, else a new one,
 * shown beside the chat. Agents only read and stop terminals they started
 * something in.
 */
export function terminalTools(deps: { terminal: TerminalAgentApi; projects: { list(): Project[] }; firstOutputMs?: number }): ToolDefinition<never>[] {
  const runs = new Map<string, Run>()
  const who = (ctx: ToolContext) => ctx.agent ?? 'Agent'
  const owner = (ctx: ToolContext) => `${ctx.conversationId ?? ''}\n${ctx.projectId ?? ''}`

  /** Where a command starts: the agent's own folder (a worktree when isolated), else its project's. */
  const folder = (id: string | undefined, ctx: ToolContext): { cwd: string; projectId?: string } => {
    if (ctx.cwd && (!id || id === ctx.projectId)) return { cwd: ctx.cwd, projectId: ctx.projectId }
    const wanted = id || ctx.projectId
    if (!wanted) throw coded('no-project', 'No project selected — pass projectId (see projects_list)')
    const allowed = ctx.onlyProject ? deps.projects.list().filter((p) => p.id === ctx.projectId) : deps.projects.list()
    const p = allowed.find((x) => x.id === wanted || x.name === wanted)
    if (!p) throw coded('no-project', `Unknown project: ${wanted}`)
    return { cwd: p.path, projectId: p.id }
  }

  /** A terminal the caller started something in: the one asked for, else its latest — never another conversation's or project's. */
  const started = (id: string | undefined, ctx: ToolContext): Run => {
    const mine = (r: Run | undefined): r is Run => r?.owner === owner(ctx)
    if (id) {
      const run = runs.get(id)
      if (!mine(run)) throw coded('not-found', `No command of yours runs in terminal ${id} — terminal_run starts one.`)
      return run
    }
    const run = [...runs.values()].filter(mine).pop()
    if (!run) throw coded('not-found', 'No command started yet — terminal_run starts one.')
    return run
  }

  /** Whether the run's command has ended — its end noted once, at its shell's mark, else when its shell is back in front. */
  const settle = (run: Run, live: TerminalInfo): boolean => {
    if (run.end === undefined) {
      const { at, now } = deps.terminal.ended(run.id, run.start)
      // A shell with Mindeck's integration says where; one starting up is in front before the command ever ran.
      if (at !== undefined) run.end = at
      else if (!live.running && (run.seen || !live.integration)) run.end = now
      else if (live.running) run.seen = true
    }
    return run.end !== undefined
  }

  /** The terminal's state and what the command printed — nothing from before it, nothing after it ended. */
  const report = (run: Run, maxChars = MAX_OUTPUT): string => {
    const live = deps.terminal.list().find((t) => t.id === run.id)
    if (!live) return `Terminal [${run.id}] was closed.`
    const done = settle(run, live)
    // Leading blank lines and trailing space go; a line's indentation stays (a dev server's banner).
    const output = plainOutput(deps.terminal.output(run.id, run.start, run.end))
      .replace(/^\s*\n/, '')
      .trimEnd()
    const state = done ? 'the command has ended' : live.running ? `running: ${live.running}` : 'starting'
    const tail = output.length > maxChars ? `… [${output.length - maxChars} earlier characters left out]\n${output.slice(-maxChars)}` : output
    return `Terminal [${run.id}] ${live.title} (${live.cwdLabel}) · ${state}\n--- output since \`${run.command}\` ---\n${tail || '(nothing yet)'}`
  }

  const tools = [
    {
      name: 'terminal_run',
      title: 'Run in a terminal',
      description:
        'Start a command in a terminal of Mindeck, where the user sees it: in the first terminal waiting at its prompt, else in a new one — shown beside the chat. ' +
        'Use it for everything that keeps running or that the user wants to watch: dev servers (npm run dev, npm start, vite, next dev), watchers, games, local apps. ' +
        'Never start those in the background yourself (no `&`, nohup or background shell tasks): the user sees and stops them in Mindeck. ' +
        'Returns the first seconds of output; read more with terminal_read, stop it with terminal_stop. ' +
        'For short commands whose output you need (tests, builds, git), keep using your own shell.',
      risk: 'execute',
      schema: z.object({
        command: z.string().min(1).max(4000).describe('One command line, as typed into the shell'),
        projectId: z.string().max(200).optional().describe('Project id (defaults to the conversation project)'),
        reason
      }),
      summarize: ({ command }) => `Run in a Mindeck terminal: ${command}`,
      async run({ command, projectId }, ctx) {
        const { cwd, projectId: project } = folder(projectId, ctx)
        const { info, opened, start } = await deps.terminal.runVisible({ command, cwd, projectId: project, by: who(ctx) })
        const run: Run = { id: info.id, command, owner: owner(ctx), start }
        runs.delete(info.id) // the latest run last
        runs.set(info.id, run)
        await wait(deps.firstOutputMs ?? FIRST_OUTPUT_MS, ctx.signal)
        return `Started in ${opened ? 'a new' : 'a free'} Mindeck terminal — the user sees it.\n${report(run, 4000)}`
      }
    } satisfies ToolDefinition<{ command: string; projectId?: string; reason: string }>,
    {
      name: 'terminal_read',
      title: 'Read a terminal',
      description: 'What a command started with terminal_run printed since it started (the latest output), and whether it still runs.',
      risk: 'read',
      shell: true,
      schema: z.object({ terminal, maxChars: z.number().int().min(500).max(30_000).optional() }),
      summarize: () => 'Read the output of a Mindeck terminal',
      async run({ terminal: id, maxChars }, ctx) {
        return truncate(report(started(id, ctx), maxChars))
      }
    } satisfies ToolDefinition<{ terminal?: string; maxChars?: number }>,
    {
      name: 'terminal_stop',
      title: 'Stop a terminal command',
      description: 'Stop the command started with terminal_run (Ctrl+C in its terminal); the terminal stays open for the user.',
      risk: 'write',
      schema: z.object({ terminal, reason }),
      summarize: () => 'Stop a command in a Mindeck terminal (Ctrl+C)',
      async run({ terminal: id }, ctx) {
        const run = started(id, ctx)
        const live = deps.terminal.list().find((t) => t.id === run.id)
        if (!live) return `Terminal [${run.id}] was closed.`
        // Ended: whatever runs there now is the user's.
        if (settle(run, live)) return report(run, 2000)
        deps.terminal.write(run.id, '\x03')
        await wait(500, ctx.signal)
        return report(run, 2000)
      }
    } satisfies ToolDefinition<{ terminal?: string; reason: string }>
  ]
  return tools as unknown as ToolDefinition<never>[]
}
