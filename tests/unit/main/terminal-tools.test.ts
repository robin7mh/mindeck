import { describe, expect, it, vi } from 'vitest'
import type { TerminalInfo } from '@shared/types/terminal'
import type { Project } from '@shared/types/project'
import { ToolRegistry } from '../../../electron/main/services/ai/tools/registry'
import { plainOutput, terminalTools, TERMINAL_TOOLS, type TerminalAgentApi } from '../../../electron/main/services/ai/tools/terminal'
import type { ToolContext } from '../../../electron/main/services/ai/tools/types'

const projects = [{ id: 'p1', name: 'demo', path: '/work/demo' } as Project, { id: 'p2', name: 'other', path: '/work/other' } as Project]

/** Terminals as the tools see them: one session per run, output appended by the test. */
function fakeTerminals() {
  const out = new Map<string, string>()
  const live = new Map<string, TerminalInfo>()
  let n = 0
  const api: TerminalAgentApi & { print(id: string, text: string): void; close(id: string): void; busy(id: string, program?: string): void; plain(id: string): void } = {
    runVisible: vi.fn(async (req) => {
      const id = `t${++n}`
      const info: TerminalInfo = { id, title: 'demo', cwd: req.cwd, cwdLabel: req.cwd, shell: 'zsh', createdAt: '2026-10-21T00:00:00Z', integration: true }
      live.set(id, { ...info, running: 'node' })
      out.set(id, 'old output')
      return { info, opened: n === 1, start: 'old output'.length }
    }),
    output: (id, from = 0, to) => (out.get(id) ?? '').slice(from, to),
    ended: (id, from) => {
      const text = out.get(id) ?? ''
      const at = text.indexOf('\x1b]133;D', from)
      return { ...(at >= 0 ? { at } : {}), now: text.length }
    },
    write: vi.fn(),
    list: () => [...live.values()],
    print: (id, text) => out.set(id, (out.get(id) ?? '') + text),
    close: (id) => live.delete(id),
    busy: (id, program) => live.set(id, { ...live.get(id)!, running: program }),
    /** A shell without Mindeck's integration: no command marks. */
    plain: (id) => live.set(id, { ...live.get(id)!, integration: undefined })
  }
  return api
}

function setup() {
  const terminal = fakeTerminals()
  const registry = new ToolRegistry(terminalTools({ terminal, projects: { list: () => projects }, firstOutputMs: 0 }))
  const call = (name: string, input: Record<string, unknown>, ctx: Partial<ToolContext> = {}) => {
    const tool = registry.get(name)!
    const parsed = registry.parse(tool, input)
    if (!parsed.ok) throw new Error(parsed.message)
    return tool.run(parsed.data, { signal: new AbortController().signal, ...ctx })
  }
  return { terminal, registry, call }
}

describe('terminal tools for agents', () => {
  it('are offered with their risks: starting runs a command, reading runs unasked, stopping is a write', () => {
    const { registry } = setup()
    expect(registry.info().map(({ name, risk }) => [name, risk])).toEqual([
      ['terminal_run', 'execute'],
      ['terminal_read', 'read'],
      ['terminal_stop', 'write']
    ])
    expect(TERMINAL_TOOLS).toEqual(['terminal_run', 'terminal_read', 'terminal_stop'])
    expect(registry.forModel(['terminal_run'])[0].description).toMatch(/Never start those in the background yourself/)
    expect(registry.get('terminal_run')!.summarize({ command: 'npm run dev', reason: 'x' } as never)).toBe('Run in a Mindeck terminal: npm run dev')
  })

  it('terminal_run starts in the agent’s own folder (a worktree), else in its project’s — never another one', async () => {
    const { terminal, call } = setup()
    terminal.runVisible = vi.fn(terminal.runVisible)
    const agent = { agent: 'Claude Code', projectId: 'p1', onlyProject: true }
    const text = await call('terminal_run', { command: 'npm run dev', reason: 'see the game' }, { ...agent, cwd: '/work/.worktrees/abc' })
    expect(terminal.runVisible).toHaveBeenLastCalledWith({ command: 'npm run dev', cwd: '/work/.worktrees/abc', projectId: 'p1', by: 'Claude Code' })
    expect(text).toMatch(/^Started in a new Mindeck terminal — the user sees it\.\nTerminal \[t1\] demo \(\/work\/.worktrees\/abc\) · running: node/)
    // Its own project named: still its own folder.
    await call('terminal_run', { command: 'npm test', projectId: 'p1', reason: 'x' }, { ...agent, cwd: '/work/.worktrees/abc' })
    expect(terminal.runVisible).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/work/.worktrees/abc', projectId: 'p1' }))

    await call('terminal_run', { command: 'npm start', reason: 'x' }, { projectId: 'p1' }) // the assistant: its conversation's project
    expect(terminal.runVisible).toHaveBeenLastCalledWith({ command: 'npm start', cwd: '/work/demo', projectId: 'p1', by: 'Agent' })
    await call('terminal_run', { command: 'npm start', projectId: 'other', reason: 'x' }, { projectId: 'p1' })
    expect(terminal.runVisible).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/work/other', projectId: 'p2' }))

    await expect(call('terminal_run', { command: 'x', projectId: 'p2', reason: 'x' }, agent)).rejects.toMatchObject({ code: 'no-project' })
    await expect(call('terminal_run', { command: 'x', reason: 'x' })).rejects.toMatchObject({ code: 'no-project' })
    expect(() => call('terminal_run', { command: 'x' })).toThrow(/reason/)
  })

  it('terminal_read: what the command printed since it started, plain; the caller’s own latest', async () => {
    const { terminal, call } = setup()
    const claude = { agent: 'Claude Code', conversationId: 's1', projectId: 'p1' }
    await call('terminal_run', { command: 'npm run dev', reason: 'x' }, claude)
    await call('terminal_run', { command: 'vite', reason: 'x' }, { agent: 'Codex', conversationId: 's2', projectId: 'p1' })
    terminal.print('t1', '\x1b[32m  ➜  Local:\x1b[39m http://localhost:3000/\r\nbuilding 10%\rbuilding 100%\n')
    terminal.print('t2', 'codex output')

    const mine = await call('terminal_read', {}, claude)
    expect(mine).toContain('Terminal [t1] demo (/work/demo) · running: node')
    expect(mine).toContain('--- output since `npm run dev` ---\n  ➜  Local: http://localhost:3000/\nbuilding 100%')
    expect(mine).not.toContain('old output')
    expect(await call('terminal_read', { terminal: 't1', maxChars: 500 }, claude)).toContain('localhost:3000')

    terminal.print('t1', 'x'.repeat(1000))
    expect(await call('terminal_read', { terminal: 't1', maxChars: 500 }, claude)).toMatch(
      /^Terminal \[t1\][^\n]*\n--- output since `npm run dev` ---\n… \[\d+ earlier characters left out\]\nx{500}$/
    )
    terminal.close('t1')
    expect(await call('terminal_read', { terminal: 't1' }, claude)).toBe('Terminal [t1] was closed.')
  })

  it('terminal_read never reaches another conversation’s or project’s command — no fallback to someone else’s', async () => {
    const { call } = setup()
    await call('terminal_run', { command: 'vite', reason: 'x' }, { agent: 'Codex', conversationId: 's2', projectId: 'p1' })
    // Another agent with nothing of its own: nothing, not the latest of all.
    await expect(call('terminal_read', {}, { agent: 'Gemini CLI', conversationId: 's3', projectId: 'p2' })).rejects.toMatchObject({ code: 'not-found' })
    // By id, the same agent kind in another session, or the same session named for another project: not theirs either.
    await expect(call('terminal_read', { terminal: 't1' }, { agent: 'Codex', conversationId: 's4', projectId: 'p1' })).rejects.toMatchObject({ code: 'not-found' })
    await expect(call('terminal_stop', { terminal: 't1', reason: 'x' }, { agent: 'Codex', conversationId: 's2', projectId: 'p2' })).rejects.toMatchObject({ code: 'not-found' })
    await expect(call('terminal_read', { terminal: 'someone-elses' }, { conversationId: 's2', projectId: 'p1' })).rejects.toMatchObject({ code: 'not-found' })
    await expect(call('terminal_read', { terminal: 't1' }, { conversationId: 's2' })).rejects.toMatchObject({ code: 'not-found' }) // named for no project
    expect(await call('terminal_read', { terminal: 't1' }, { conversationId: 's2', projectId: 'p1' })).toContain('output since `vite`')
  })

  it('terminal_read stops where the command ended — what the user does in that terminal afterwards stays theirs', async () => {
    const { terminal, call } = setup()
    const ctx = { conversationId: 's1', projectId: 'p1' }
    await call('terminal_run', { command: 'npm run build', reason: 'x' }, ctx)
    terminal.print('t1', 'built in 2s\r\n\x1b]133;D;0\x07\x1b]133;A\x07$ cat ~/.aws/credentials\r\nSECRET')
    terminal.busy('t1', 'less') // the user's own program now
    const text = await call('terminal_read', {}, ctx)
    expect(text).toContain('· the command has ended')
    expect(text).toContain('built in 2s')
    expect(text).not.toMatch(/SECRET|credentials|less/)
    terminal.print('t1', '\nMORE SECRET')
    expect(await call('terminal_read', {}, ctx)).not.toContain('SECRET')
    // Nothing to stop: Ctrl+C would hit the user's program.
    expect(await call('terminal_stop', { reason: 'x' }, ctx)).toContain('the command has ended')
    expect(terminal.write).not.toHaveBeenCalled()
  })

  it('a shell without command marks: ended once it is back in front; one with them waits while it starts up', async () => {
    const { terminal, call } = setup()
    const ctx = { conversationId: 's1', projectId: 'p1' }
    await call('terminal_run', { command: 'make', reason: 'x' }, ctx)
    terminal.plain('t1')
    terminal.print('t1', 'done\n')
    terminal.busy('t1') // sh is back at its prompt
    expect(await call('terminal_read', {}, ctx)).toContain('· the command has ended')
    terminal.print('t1', '$ printenv\nTOKEN=abc')
    expect(await call('terminal_read', {}, ctx)).not.toContain('TOKEN')

    // zsh with marks, still starting up (in front, nothing run yet): not ended — its command is still to come.
    const runVisible = terminal.runVisible
    terminal.runVisible = vi.fn(async (req) => {
      const started = await runVisible(req)
      terminal.busy(started.info.id)
      return started
    })
    expect(await call('terminal_run', { command: 'npm run dev', reason: 'x' }, ctx)).toContain('· starting')
    expect(await call('terminal_read', {}, ctx)).toContain('· starting')
    terminal.busy('t2', 'node')
    terminal.print('t2', 'ready')
    expect(await call('terminal_read', {}, ctx)).toContain('· running: node')
    // Its marks went missing (another DEBUG trap): back in front after it was seen running counts as the end.
    terminal.busy('t2')
    expect(await call('terminal_read', {}, ctx)).toContain('· the command has ended')
    terminal.print('t2', ' later')
    expect(await call('terminal_read', {}, ctx)).not.toContain('later')
  })

  it('terminal_read and terminal_stop need a command started first; their approval texts', async () => {
    const { registry, call } = setup()
    await expect(call('terminal_read', {})).rejects.toMatchObject({ code: 'not-found' })
    await expect(call('terminal_stop', { reason: 'x' })).rejects.toMatchObject({ code: 'not-found' })
    expect(registry.get('terminal_read')!.summarize({} as never)).toBe('Read the output of a Mindeck terminal')
    expect(registry.get('terminal_stop')!.summarize({ reason: 'x' } as never)).toBe('Stop a command in a Mindeck terminal (Ctrl+C)')
    expect(registry.get('terminal_read')!.shell).toBe(true)
  })

  it('terminal_stop presses Ctrl+C in that terminal while its command runs; the terminal stays open', async () => {
    const { terminal, call } = setup()
    await call('terminal_run', { command: 'npm run dev', reason: 'x' }, { projectId: 'p1' })
    expect(await call('terminal_stop', { reason: 'done playing' }, { projectId: 'p1' })).toContain('running: node')
    expect(terminal.write).toHaveBeenCalledWith('t1', '\x03')
    terminal.close('t1')
    expect(await call('terminal_stop', { reason: 'x' }, { projectId: 'p1' })).toBe('Terminal [t1] was closed.')
    expect(terminal.write).toHaveBeenCalledOnce()
  })

  it('an aborted call stops waiting for the first output', async () => {
    const terminal = fakeTerminals()
    const registry = new ToolRegistry(terminalTools({ terminal, projects: { list: () => projects }, firstOutputMs: 60_000 }))
    const abort = new AbortController()
    const running = registry.get('terminal_run')!.run({ command: 'x', reason: 'x' } as never, { signal: abort.signal, projectId: 'p1' })
    abort.abort()
    await expect(running).resolves.toContain('Started in a new Mindeck terminal')

    // Aborted while waiting the usual few seconds: done at once too.
    const usual = new ToolRegistry(terminalTools({ terminal: fakeTerminals(), projects: { list: () => projects } }))
    const later = new AbortController()
    const waiting = usual.get('terminal_run')!.run({ command: 'x', reason: 'x' } as never, { signal: later.signal, projectId: 'p1' })
    await new Promise((r) => setTimeout(r, 0))
    later.abort()
    await expect(waiting).resolves.toContain('Started in a new Mindeck terminal')
  })
})

describe('plainOutput', () => {
  it('drops colors and keeps only the last state of a line redrawn with \\r', () => {
    expect(plainOutput('\x1b[1mbold\x1b[0m\r\n10%\r50%\r100%\nend')).toBe('bold\n100%\nend')
    expect(plainOutput('\x1b]0;title\x07text')).toBe('text')
  })
})
