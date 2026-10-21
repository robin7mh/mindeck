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
  const api: TerminalAgentApi & { print(id: string, text: string): void; close(id: string): void; busy(id: string, program?: string): void } = {
    runVisible: vi.fn(async (req) => {
      const id = `t${++n}`
      const info: TerminalInfo = { id, title: 'demo', cwd: req.cwd, cwdLabel: req.cwd, shell: 'zsh', createdAt: '2026-10-21T00:00:00Z' }
      live.set(id, { ...info, running: 'node' })
      out.set(id, 'old output')
      return { info, opened: n === 1, start: 'old output'.length }
    }),
    output: (id, from = 0) => (out.get(id) ?? '').slice(from),
    write: vi.fn(),
    list: () => [...live.values()],
    print: (id, text) => out.set(id, (out.get(id) ?? '') + text),
    close: (id) => live.delete(id),
    busy: (id, program) => live.set(id, { ...live.get(id)!, running: program })
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

    await call('terminal_run', { command: 'npm start', reason: 'x' }, { projectId: 'p1' }) // the assistant: its conversation's project
    expect(terminal.runVisible).toHaveBeenLastCalledWith({ command: 'npm start', cwd: '/work/demo', projectId: 'p1', by: 'Agent' })
    await call('terminal_run', { command: 'npm start', projectId: 'other', reason: 'x' }, { projectId: 'p1' })
    expect(terminal.runVisible).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/work/other', projectId: 'p2' }))

    await expect(call('terminal_run', { command: 'x', projectId: 'p2', reason: 'x' }, agent)).rejects.toMatchObject({ code: 'no-project' })
    await expect(call('terminal_run', { command: 'x', reason: 'x' })).rejects.toMatchObject({ code: 'no-project' })
    expect(() => call('terminal_run', { command: 'x' })).toThrow(/reason/)
  })

  it('terminal_read: what the command printed since it started, plain; the caller’s latest by default', async () => {
    const { terminal, call } = setup()
    await call('terminal_run', { command: 'npm run dev', reason: 'x' }, { agent: 'Claude Code', projectId: 'p1' })
    await call('terminal_run', { command: 'vite', reason: 'x' }, { agent: 'Codex', projectId: 'p1' })
    terminal.print('t1', '\x1b[32m  ➜  Local:\x1b[39m http://localhost:3000/\r\nbuilding 10%\rbuilding 100%\n')
    terminal.print('t2', 'codex output')

    const mine = await call('terminal_read', {}, { agent: 'Claude Code' })
    expect(mine).toContain('Terminal [t1] demo (/work/demo) · running: node')
    expect(mine).toContain('--- output since `npm run dev` ---\n  ➜  Local: http://localhost:3000/\nbuilding 100%')
    expect(mine).not.toContain('old output')
    expect(await call('terminal_read', {}, { agent: 'Gemini CLI' })).toContain('codex output') // none of its own: the latest
    expect(await call('terminal_read', { terminal: 't1', maxChars: 500 })).toContain('localhost:3000')

    terminal.print('t1', 'x'.repeat(1000))
    expect(await call('terminal_read', { terminal: 't1', maxChars: 500 })).toMatch(
      /^Terminal \[t1\][^\n]*\n--- output since `npm run dev` ---\n… \[\d+ earlier characters left out\]\nx{500}$/
    )

    terminal.busy('t1')
    expect(await call('terminal_read', { terminal: 't1' })).toContain('waiting at its prompt (the command has ended)')
    terminal.close('t1')
    expect(await call('terminal_read', { terminal: 't1' })).toBe('Terminal [t1] was closed.')
    await expect(call('terminal_read', { terminal: 'someone-elses' })).rejects.toMatchObject({ code: 'not-found' })
  })

  it('terminal_read and terminal_stop need a command started first', async () => {
    const { call } = setup()
    await expect(call('terminal_read', {})).rejects.toMatchObject({ code: 'not-found' })
    await expect(call('terminal_stop', { reason: 'x' })).rejects.toMatchObject({ code: 'not-found' })
  })

  it('terminal_stop presses Ctrl+C in that terminal; the terminal stays open', async () => {
    const { terminal, call } = setup()
    await call('terminal_run', { command: 'npm run dev', reason: 'x' }, { projectId: 'p1' })
    terminal.busy('t1')
    expect(await call('terminal_stop', { reason: 'done playing' })).toContain('waiting at its prompt')
    expect(terminal.write).toHaveBeenCalledWith('t1', '\x03')
    terminal.close('t1')
    expect(await call('terminal_stop', { reason: 'x' })).toBe('Terminal [t1] was closed.')
    expect(terminal.write).toHaveBeenCalledOnce()
  })

  it('an aborted call stops waiting for the first output', async () => {
    const terminal = fakeTerminals()
    const registry = new ToolRegistry(terminalTools({ terminal, projects: { list: () => projects }, firstOutputMs: 60_000 }))
    const abort = new AbortController()
    const running = registry.get('terminal_run')!.run({ command: 'x', reason: 'x' } as never, { signal: abort.signal, projectId: 'p1' })
    abort.abort()
    await expect(running).resolves.toContain('Started in a new Mindeck terminal')
  })
})

describe('plainOutput', () => {
  it('drops colors and keeps only the last state of a line redrawn with \\r', () => {
    expect(plainOutput('\x1b[1mbold\x1b[0m\r\n10%\r50%\r100%\nend')).toBe('bold\n100%\nend')
    expect(plainOutput('\x1b]0;title\x07text')).toBe('text')
  })
})
