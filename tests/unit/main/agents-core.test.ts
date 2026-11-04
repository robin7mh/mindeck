import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'
import { detectAgents, loginShellProbe, type Probe } from '../../../electron/main/services/agents/detect'
import {
  claudeArgs,
  claudeEnv,
  HOOK_RELAY,
  hookSettings,
  MCP_BROWSER_READ_TOOLS,
  MCP_TERMINAL_READ_TOOLS,
  mcpConfig,
  MEMORY_READ_TOOLS,
  SYSTEM_HINT
} from '../../../electron/main/services/agents/claudeLaunch'
import { applyHook, approvalRisk, landings, reachesOutside, runsByItself, staysInside, toolPaths, toolRisk, toolSummary, toolTitle, type SessionState } from '../../../electron/main/services/agents/transcript'
import type { ChatMessage, ToolCallPart } from '../../../src/shared/types/ai'
import type { AgentSession } from '../../../src/shared/types/agents'
import { journalBody, journalTitle, vaultJournal } from '../../../electron/main/services/agents/journal'

describe('detectAgents', () => {
  const probe =
    (answers: Record<string, string | Error>): Probe =>
    async (cmd) => {
      const a = answers[cmd]
      if (a === undefined || a instanceof Error) throw a ?? new Error(`not found: ${cmd}`)
      return a
    }

  it('Claude Code signed in with a plan; Codex ready through npx; Gemini missing', async () => {
    const list = await detectAgents(
      probe({
        'claude --version': '2.1.287 (Claude Code)\n',
        'claude auth status': JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }),
        'codex --version': 'codex-cli 0.98.0',
        'npx --version': '10.9.0'
      })
    )
    expect(list).toEqual([
      { kind: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.287', signedIn: true, account: 'Max plan', ready: true, hint: undefined },
      { kind: 'codex', name: 'Codex', installed: true, version: '0.98.0', signedIn: false, account: 'Your own sign-in', ready: true, hint: undefined },
      { kind: 'gemini', name: 'Gemini CLI', installed: false, ready: false, hint: 'Not installed (gemini)' }
    ])
  })

  it('accounts: unknown plan, API key, signed out, unreadable status; Codex without npx; Gemini ready', async () => {
    const run = (status: string | Error) =>
      detectAgents(probe({ 'claude --version': 'x 1.0.0', 'claude auth status': status, 'codex --version': '1.2.3', 'gemini --version': '0.5.0' }))
    expect((await run(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })))[0].account).toBe('Claude account')
    expect((await run(JSON.stringify({ loggedIn: true, authMethod: 'api_key' })))[0].account).toBe('API key')
    const out = (await run(JSON.stringify({ loggedIn: false, authMethod: 'none' })))[0]
    expect(out).toMatchObject({ signedIn: false, account: undefined, ready: false, hint: 'Sign in once: claude auth login' })
    const broken = await run(new Error('exit 1'))
    expect(broken[0]).toMatchObject({ installed: true, signedIn: false, ready: false })
    expect(broken[1]).toMatchObject({ installed: true, ready: false, hint: 'Needs Node.js (npx) for the ACP adapter' })
    expect(broken[2]).toMatchObject({ ready: true, version: '0.5.0', hint: undefined })
    expect((await detectAgents(probe({}))).every((a) => !a.installed)).toBe(true)
    // a configured binary is probed (quoted) instead of `claude`
    expect((await detectAgents(probe({ "'/opt/my claude' --version": '3.0.0' }), '/opt/my claude'))[0]).toMatchObject({ installed: true, version: '3.0.0' })
  })

  it('Codex and Gemini: signed in as far as they tell', async () => {
    const home = await tempDir()
    const answers = { 'codex --version': '1.0.0', 'gemini --version': '0.5.0', 'npx --version': '10.0.0' }
    const [, codex, gemini] = await detectAgents(probe({ ...answers, 'codex login status': 'Logged in using ChatGPT' }), 'claude', home, {})
    expect([codex.signedIn, gemini.signedIn]).toEqual([true, false])
    expect((await detectAgents(probe(answers), 'claude', home, { GEMINI_API_KEY: 'k' }))[2].signedIn).toBe(true)
    expect((await detectAgents(probe(answers), 'claude', home, { GOOGLE_API_KEY: 'k' }))[2].signedIn).toBe(true)
    await mkdir(join(home, '.gemini'))
    await writeFile(join(home, '.gemini', 'oauth_creds.json'), '{}')
    expect((await detectAgents(probe(answers), 'claude', home, {}))[2].signedIn).toBe(true)
  })

  it('the default probe runs through a login shell', async () => {
    expect((await loginShellProbe('echo mindeck')).trim()).toBe('mindeck')
    await expect(loginShellProbe('exit 3')).rejects.toThrow()
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' }) // PowerShell there — not on this machine
    try {
      await expect(loginShellProbe('echo ok')).rejects.toThrow()
    } finally {
      Object.defineProperty(process, 'platform', { value: platform })
    }
  })
})

describe('Claude Code launch', () => {
  const input = { sessionId: 's1', title: 'Fix login', settingsFile: '/data/agents/launch/s1/settings.json', mcpFile: '/data/agents/launch/s1/mcp.json' }

  it('new sessions: id, name, hooks, memory server, hint, read tools allowed, first prompt after --', () => {
    const args = claudeArgs({ ...input, prompt: '--looks like a flag' })
    expect(args.slice(0, 4)).toEqual(['--session-id', 's1', '--name', 'Fix login'])
    // Hooks and memory server come from files: the token they carry never is on the command line.
    expect(args[args.indexOf('--settings') + 1]).toBe(input.settingsFile)
    expect(args[args.indexOf('--mcp-config') + 1]).toBe(input.mcpFile)
    expect(mcpConfig('http://127.0.0.1:9/mcp/s1', 'tok')).toEqual({
      mcpServers: { mindeck: { type: 'http', url: 'http://127.0.0.1:9/mcp/s1', headers: { Authorization: 'Bearer tok' } } }
    })
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(SYSTEM_HINT)
    // reading memory, the browser's shared tabs and the agents' own terminals runs unasked; everything else asks in Mindeck
    expect(args.slice(args.indexOf('--allowedTools') + 1, -2)).toEqual([...MEMORY_READ_TOOLS, ...MCP_BROWSER_READ_TOOLS, ...MCP_TERMINAL_READ_TOOLS])
    expect(args.slice(-2)).toEqual(['--', '--looks like a flag'])
  })

  it('resume continues the transcript and sends no prompt', () => {
    const args = claudeArgs({ ...input, resume: true, prompt: 'ignored' })
    expect(args.slice(0, 2)).toEqual(['--resume', 's1'])
    expect(args).not.toContain('--')
    expect(claudeArgs(input)).not.toContain('--')
  })

  it('hooks: HTTP for tool/turn events, long wait for approvals, a relay for the rest', () => {
    const { hooks } = hookSettings('http://h', 'tok') as { hooks: Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]> }
    expect(hooks.PreToolUse[0]).toEqual({ matcher: '*', hooks: [{ type: 'http', url: 'http://h', headers: { Authorization: 'Bearer tok' }, timeout: 10 }] })
    expect(hooks.Stop[0].matcher).toBeUndefined()
    expect(hooks.PermissionRequest[0].hooks[0]).toMatchObject({ type: 'http', timeout: 660 })
    expect(hooks.SessionStart[0].hooks[0]).toEqual({ type: 'command', command: HOOK_RELAY, async: true })
    expect(hooks.Notification[0].hooks[0]).toMatchObject({ type: 'command' })
    expect(HOOK_RELAY).toContain('$MINDECK_TOKEN')
    expect(claudeEnv('http://h', 'tok')).toEqual({ MINDECK_HOOK_URL: 'http://h', MINDECK_TOKEN: 'tok' })
  })
})

describe('hook events → chat, status and plan', () => {
  const fresh = (): SessionState => ({ status: 'starting', messages: [], plan: [] })
  const tool = (s: SessionState, id: string) =>
    s.messages.flatMap((m) => m.parts).find((p): p is ToolCallPart => p.type === 'tool' && p.id === id)!

  it('a full turn: prompt, tool with approval, result, answer', () => {
    const s = fresh()
    applyHook(s, { hook_event_name: 'SessionStart', source: 'startup' })
    expect(s.status).toBe('idle')
    applyHook(s, { hook_event_name: 'SessionStart', source: 'resume' }) // not starting anymore: unchanged
    expect(s.status).toBe('idle')

    const prompt = applyHook(s, { hook_event_name: 'UserPromptSubmit', prompt: 'run the tests' })
    expect(prompt.changed.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(s.status).toBe('working')

    applyHook(s, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1' })
    expect(tool(s, 't1')).toMatchObject({ title: 'Run command', risk: 'execute', status: 'running' })
    const ask = applyHook(s, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1' })
    expect(ask.attention).toBe('approval')
    expect(s.status).toBe('approval')
    expect(tool(s, 't1').status).toBe('awaiting-approval')

    applyHook(s, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_response: { stdout: 'ok' } })
    expect(tool(s, 't1')).toMatchObject({ status: 'done', output: '{\n "stdout": "ok"\n}' })
    const stop = applyHook(s, { hook_event_name: 'Stop', last_assistant_message: '  All green.  ' })
    expect(stop.attention).toBe('done')
    expect(s.status).toBe('idle')
    const answer = s.messages[1]
    expect(answer).toMatchObject({ role: 'assistant', status: 'done' })
    expect(answer.parts.at(-1)).toEqual({ type: 'text', text: 'All green.' })
  })

  it('failures, long output, tools without a PreToolUse, empty answers, interrupted turns', () => {
    const s = fresh()
    applyHook(s, { hook_event_name: 'UserPromptSubmit', user_prompt: 'go' })
    applyHook(s, { hook_event_name: 'PostToolUseFailure', tool_name: 'Read', tool_use_id: 'r1', error: 'ENOENT' })
    expect(tool(s, 'r1')).toMatchObject({ status: 'error', output: 'ENOENT', risk: 'read' })
    applyHook(s, { hook_event_name: 'PostToolUseFailure', tool_name: 'Read', tool_use_id: 'r2' })
    expect(tool(s, 'r2').output).toBe('failed')
    applyHook(s, { hook_event_name: 'PostToolUse', tool_use_id: 'x9', tool_response: 'y'.repeat(5000) })
    expect(tool(s, 'x9')).toMatchObject({ name: 'tool', title: 'tool' })
    expect(tool(s, 'x9').output).toMatch(/… \[1000 more characters\]$/)
    applyHook(s, { hook_event_name: 'PostToolUse', tool_name: 'Glob', tool_use_id: 'g1' })
    expect(tool(s, 'g1').output).toBe('')
    applyHook(s, { hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_use_id: 'w1' }) // no PreToolUse seen
    expect(tool(s, 'w1')).toMatchObject({ status: 'awaiting-approval', risk: 'write' })

    // the user sends again while the turn is still open (interrupted)
    applyHook(s, { hook_event_name: 'UserPromptSubmit' })
    expect(s.messages[1].status).toBe('done')
    expect(s.messages[2]).toMatchObject({ role: 'user', parts: [{ text: '' }] })
    applyHook(s, { hook_event_name: 'Stop' }) // no text
    expect(s.messages[3].parts).toEqual([])

    // events after a resume: a turn is opened on demand; a tool id seen twice is reused
    applyHook(s, { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' } })
    const t = s.messages[4].parts[0] as ToolCallPart
    applyHook(s, { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_use_id: t.id })
    expect(s.messages[4].parts).toHaveLength(1)
  })

  it('plan from TodoWrite and task hooks; notifications; session end', () => {
    const s = fresh()
    applyHook(s, { hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_use_id: 'p', tool_input: { todos: [{ content: 'find bug', status: 'completed' }, { status: 'pending' }] } })
    expect(s.plan).toEqual([
      { id: 'todo-0', text: 'find bug', done: true },
      { id: 'todo-1', text: '', done: false }
    ])
    applyHook(s, { hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_use_id: 'q', tool_input: {} }) // malformed: plan kept
    expect(s.plan).toHaveLength(2)
    applyHook(s, { hook_event_name: 'TaskCreated', task_id: 't1', task_description: 'write test' })
    applyHook(s, { hook_event_name: 'TaskCreated', task_id: 't1', task_description: 'write the test' })
    applyHook(s, { hook_event_name: 'TaskCreated', task_id: 't2' })
    applyHook(s, { hook_event_name: 'TaskCompleted', task_id: 't1' })
    expect(s.plan.slice(2)).toEqual([
      { id: 't1', text: 'write the test', done: true },
      { id: 't2', text: '', done: false }
    ])

    s.status = 'working'
    expect(applyHook(s, { hook_event_name: 'Notification', notification_type: 'auth_success' }).attention).toBeUndefined()
    expect(s.status).toBe('working')
    // "Still waiting for your input" a minute after a turn: no news — no status, no notification.
    expect(applyHook(s, { hook_event_name: 'Notification', notification_type: 'idle_prompt' }).attention).toBeUndefined()
    expect(s.status).toBe('working')
    expect(applyHook(s, { hook_event_name: 'Notification', notification_type: 'agent_needs_input' }).attention).toBe('waiting')
    expect(s.status).toBe('waiting')
    s.status = 'approval'
    applyHook(s, { hook_event_name: 'Notification', notification_type: 'agent_needs_input' })
    expect(s.status).toBe('approval') // an open approval stays the thing to answer
    applyHook(s, { hook_event_name: 'Notification', notification_type: 'elicitation_dialog' })
    applyHook(s, { hook_event_name: 'SomethingNew' })
    applyHook(s, { hook_event_name: 'SessionEnd', reason: 'other' })
    expect(s.status).toBe('ended')
  })

  it('a Glob looks everywhere its braces say: every alternative counts, any .. in one leaves', () => {
    const cwd = '/work/app'
    for (const pattern of ['{.,../..}/**/*', '.{.,x}/secret', '**/../x', 'a/{b,{c,..}}/*', '{x,y}{a,b}/../*', '{.env,a.ts}', '{~/x,a}', '{/etc,src}/*'])
      expect(staysInside('Glob', { pattern }, cwd), pattern).toBe(false)
    for (const pattern of ['**/*.ts', '{src,lib}/**/*.{ts,tsx}', 'unbalanced{/*', 'a..b/*', '{1..3}/*'])
      expect(staysInside('Glob', { pattern }, cwd), pattern).toBe(true)
    // Past a limit it isn't written out, and asks.
    expect(toolPaths('Glob', { pattern: '{a,b}'.repeat(8) })).toHaveLength(256)
    expect(toolPaths('Glob', { pattern: '{a,b}'.repeat(9) })).toEqual(['..'])
    // Its pattern is relative to its path; what starts elsewhere doesn't care.
    expect(toolPaths('Glob', { pattern: 'x/*', path: 'src' })).toEqual(['src', 'src/x/*'])
    expect(toolPaths('Glob', { pattern: '/etc/*', path: 'src' })).toEqual(['src', '/etc/*'])
    expect(toolPaths('Glob', { pattern: '~/x', path: 'src' })).toEqual(['src', '~/x'])
    expect(toolPaths('Glob', { path: 'src' })).toEqual(['src'])
    expect(toolPaths('Grep', { pattern: '../..', path: 'src' })).toEqual(['src'])
    expect(toolPaths('Read')).toEqual([])
  })

  it('files that run by themselves: however a path names them, inside the folder only', () => {
    const cwd = '/work/app'
    for (const path of ['.claude/settings.json', '/work/app/.mcp.json', 'sub/.git/hooks/x', '.GIT/config', '.Claude/x', '.git./hooks/x', '.git ./hooks/x', '.git::$INDEX_ALLOCATION/hooks/x', '.git.::$DATA', '.husky/pre-commit', '.githooks/pre-commit', '.devcontainer/x.json', '.vscode/tasks.json', '.gemini/settings.json', '.codex/config.toml', '.cursor/hooks.json', 'a\\.git\\x'])
      expect(runsByItself(path, cwd), path).toBe(true)
    for (const path of ['src/a.ts', '.github/x.yml', '.mcp.json.bak', 'git/x', 'claude/x', '.gitignore', 'vscode']) expect(runsByItself(path, cwd), path).toBe(false)
    expect(runsByItself('.git/x')).toBe(true) // no folder to compare with: all of it counts
    // The folder's own place doesn't count: a project somewhere under ~/.claude writes its files like any other.
    expect(runsByItself('a.ts', '/home/me/.claude/skills/x')).toBe(false)
    // They are a matter of changing them: reading one is reading.
    expect(staysInside('Write', { file_path: '.claude/settings.json' }, cwd)).toBe(false)
    expect(staysInside('NotebookEdit', { notebook_path: '.vscode/a.ipynb' }, cwd)).toBe(false)
    expect(staysInside('Read', { file_path: '.claude/settings.json' }, cwd)).toBe(true)
    expect(approvalRisk('Read', { file_path: '.claude/settings.json' }, cwd)).toBe('read')
  })

  it('where a path really lands, named from the folder: links followed, the nearest parent deciding, unknown is outside', async () => {
    const home = await tempDir()
    const real = await tempDir()
    await mkdir(join(real, 'src'))
    await writeFile(join(real, 'src/a.ts'), '')
    await symlink(home, join(real, 'vendor'))
    await symlink(join(home, 'not-yet'), join(real, 'dangling.md'))
    await symlink('src', join(real, 'lib'))
    await symlink('.claude', join(real, 'docs'))
    await symlink('loop', join(real, 'loop'))
    await symlink('.ssh', join(real, 'conf'))
    expect(await landings(['src/a.ts', 'lib/a.ts', 'lib/new/b.ts', 'docs/settings.json', join(real, 'src/a.ts')], real)).toEqual(['src/a.ts', 'src/a.ts', 'src/new/b.ts', '.claude/settings.json', 'src/a.ts'])
    expect(await landings(['vendor/.zshenv', 'vendor/new/deep', 'dangling.md'], real)).toEqual([join(home, '.zshenv'), join(home, 'new/deep'), join(home, 'not-yet')])
    expect(await landings([], real)).toEqual([])
    expect(await landings([real], real)).toEqual([''])
    expect(await landings(['loop/x'], real)).toEqual(['..'])
    // Outside as written: decided without asking the disk.
    expect(await landings(['/etc/passwd', '../x', '~/.ssh/x', '.env'], real)).toEqual([])
    // A folder that isn't there has no links.
    expect(await landings(['a.ts'], join(real, 'gone'))).toEqual([])
    // The folder itself may be reached by a link: its files are still inside.
    await symlink(real, join(home, 'project'))
    const viaLink = join(home, 'project')
    expect(await landings(['src/a.ts', join(viaLink, 'lib/a.ts')], viaLink)).toEqual(['src/a.ts', 'src/a.ts'])
    // What they mean for a grant and for how a look outside counts.
    const lands = await landings(['vendor/.zshenv'], real)
    expect(staysInside('Write', { file_path: 'vendor/.zshenv' }, real, lands)).toBe(false)
    expect(approvalRisk('Read', { file_path: 'vendor/.zshenv' }, real, lands)).toBe('write')
    expect(approvalRisk('Read', { file_path: 'lib/a.ts' }, real, await landings(['lib/a.ts'], real))).toBe('read')
    expect(staysInside('Write', { file_path: 'docs/settings.json' }, real, await landings(['docs/settings.json'], real))).toBe(false)
    // A link to keys inside the folder is keys.
    expect(staysInside('Read', { file_path: 'conf/notes' }, real, await landings(['conf/notes'], real))).toBe(false)
  })

  it('approvals: looking outside the project or fetching from the web count as changes (BE-SEC-17)', () => {
    const cwd = '/work/app'
    expect(approvalRisk('Read', { file_path: '/work/app/src/a.ts' }, cwd)).toBe('read')
    expect(approvalRisk('Read', { file_path: 'src/a.ts' }, cwd)).toBe('read')
    expect(approvalRisk('Glob', { pattern: '**/*.ts' }, cwd)).toBe('read')
    expect(approvalRisk('Read', { file_path: '/home/me/.ssh/id_ed25519' }, cwd)).toBe('write')
    expect(approvalRisk('Read', { file_path: '~/.aws/credentials' }, cwd)).toBe('write')
    expect(approvalRisk('Read', { file_path: '/work/app-other/x' }, cwd)).toBe('write') // a sibling, not inside
    expect(approvalRisk('Grep', { pattern: 'x', path: '../../etc' }, cwd)).toBe('write')
    expect(approvalRisk('Read', { file_path: '.env' }, cwd)).toBe('write') // keys and credentials, even inside
    expect(approvalRisk('LS', { path: '/work/app' }, cwd)).toBe('read')
    expect(approvalRisk('WebFetch', { url: 'https://example.com/?q=secret' }, cwd)).toBe('write')
    expect(approvalRisk('WebSearch', { query: 'x' }, cwd)).toBe('read')
    expect(approvalRisk('Bash', { command: 'ls' }, cwd)).toBe('execute')
    expect(approvalRisk('Edit', { file_path: 'a.ts' }, cwd)).toBe('write')
    expect(approvalRisk('Read')).toBe('read')
    expect(approvalRisk('Glob', { pattern: '/home/me/.ssh/*' }, cwd)).toBe('write') // a Glob's pattern says where it looks
    expect(approvalRisk('Glob', { pattern: '**/.env' }, cwd)).toBe('write')
    expect(approvalRisk('Grep', { pattern: '/home/me/.ssh' }, cwd)).toBe('read') // a Grep's is what it looks for
    expect(staysInside('Write', { file_path: 'src/a.ts' }, cwd)).toBe(true)
    expect(staysInside('Write', { file_path: '/home/me/.zshenv' }, cwd)).toBe(false)
    expect(staysInside('WebFetch', { url: 'https://example.com' }, cwd)).toBe(true)
    expect(staysInside('Edit', undefined, cwd)).toBe(true)
    // Without a folder to compare with, any absolute path reaches outside.
    expect(reachesOutside('/etc/passwd')).toBe(true)
    expect(reachesOutside('src/a.ts')).toBe(false)
    expect(reachesOutside('/work/app/', '/work/app/')).toBe(false)
    expect(reachesOutside('/work/app/x', '/work/app/')).toBe(false)
    expect(reachesOutside('/etc/hosts', '/')).toBe(false) // a session at the disk's root: nothing is outside
  })

  it('tool titles, risks and one-line summaries', () => {
    // Mindeck's browser: reading shared tabs runs, acting asks; titled as the browser
    expect(toolRisk('mcp__mindeck__browser_snapshot')).toBe('read')
    expect(toolRisk('mcp__mindeck__browser_console')).toBe('read')
    expect(toolRisk('mcp__mindeck__browser_click')).toBe('write')
    expect(toolTitle('mcp__mindeck__browser_click')).toBe('Mindeck browser · click')
    // Mindeck's terminals: reading the agents' own runs, starting a command is running one
    expect(toolRisk('mcp__mindeck__terminal_read')).toBe('read')
    expect(toolRisk('mcp__mindeck__terminal_run')).toBe('execute')
    expect(toolRisk('mcp__mindeck__terminal_stop')).toBe('write')
    expect(toolTitle('mcp__mindeck__terminal_run')).toBe('Mindeck terminal · run')
    expect(toolTitle('mcp__mindeck__memory_read')).toBe('Mindeck memory · memory read')
    expect(['Read', 'Edit', 'Bash', 'mcp__mindeck__memory_search', 'mcp__mindeck__memory_append', 'mcp__github__create_pr', 'Whatever'].map(toolRisk)).toEqual([
      'read',
      'write',
      'execute',
      'read',
      'write',
      'execute',
      'execute'
    ])
    expect(toolTitle('mcp__mindeck__memory_search')).toBe('Mindeck memory · memory search')
    expect(toolTitle('mcp__claude_ai_Gmail__search_threads')).toBe('claude_ai_Gmail · search threads')
    expect(toolTitle('Custom')).toBe('Custom')
    expect(toolSummary('Bash', { command: 'npm test' })).toBe('Run command: npm test')
    expect(toolSummary('Edit', { file_path: '/a/b.ts', old_string: 'x' })).toBe('Edit file: /a/b.ts')
    expect(toolSummary('Task', { other: 1 })).toBe('Subagent')
    expect(toolSummary('Task')).toBe('Subagent')
    const s = fresh()
    applyHook(s, { hook_event_name: 'PreToolUse', tool_name: 'mcp__mindeck__memory_read', tool_use_id: 'm' })
    expect(tool(s, 'm').title).toBe('Mindeck memory · memory read')
  })
})

void vi

describe('session journal', () => {
  const session = (over: Partial<AgentSession> = {}): AgentSession => ({
    id: 's',
    kind: 'claude-code',
    projectId: 'p',
    projectName: 'Demo',
    title: 'Fix login',
    cwd: '/code/demo',
    isolated: false,
    status: 'idle',
    live: true,
    plan: [],
    notes: [],
    createdAt: new Date(2026, 9, 3, 9, 5).toISOString(),
    updatedAt: '',
    ...over
  })
  const msg = (role: ChatMessage['role'], ...texts: string[]): ChatMessage => ({
    id: role,
    role,
    parts: texts.map((text) => ({ type: 'text' as const, text })),
    createdAt: '',
    status: 'done'
  })

  it('titles sort by local time; a session still named after its agent takes its first message', () => {
    expect(journalTitle(session())).toBe('2026-10-03 0905 Fix login')
    expect(journalTitle(session({ title: 'Claude Code' }))).toBe('2026-10-03 0905 Claude Code')
    expect(journalTitle(session({ title: 'Claude Code' }), [msg('user', 'Login fails\nwith empty password')])).toBe('2026-10-03 0905 Login fails')
    expect(journalTitle(session(), [msg('user', 'Login fails')])).toBe('2026-10-03 0905 Fix login')
  })

  it('records task, result, changed files and open plan items; nothing before the first prompt', () => {
    expect(journalBody(session(), [], [])).toBeNull()
    expect(journalBody(session(), [msg('user', '   ')], [])).toBeNull()
    const body = journalBody(
      session({ branch: 'mindeck/abc', kind: 'codex', plan: [{ id: '1', text: 'add test', done: false }, { id: '2', text: 'done', done: true }] }),
      [msg('user', 'Login fails\nwith empty password'), msg('assistant', 'Looking…'), msg('user', 'also check logout\nplease'), msg('assistant', '', 'Fixed both.')],
      [
        { path: 'auth.ts', status: 'modified', added: 3, removed: 1 },
        { path: 'new.ts', status: 'added', added: 9, removed: 0 },
        { path: 'old.ts', status: 'deleted', added: 0, removed: 4 }
      ]
    )!
    expect(body).toContain('**Agent:** Codex · **Projekt:** Demo · **Ordner:** `/code/demo` (Branch `mindeck/abc`)')
    expect(body).toContain('## Auftrag\n\nLogin fails\nwith empty password\n- also check logout\n')
    expect(body).toContain('## Ergebnis\n\nFixed both.\n')
    expect(body).toContain('- `auth.ts` (+3 −1)\n- `new.ts` (neu)\n- `old.ts` (gelöscht)')
    expect(body).toContain('## Offen\n\n- [ ] add test\n')
    expect(body).not.toContain('done')
  })

  it('without answers, changes or open items', () => {
    const body = journalBody(session(), [msg('user', 'hi')], [])!
    expect(body).toContain('_(noch keine Antwort)_')
    expect(body).toContain('## Geänderte Dateien\n\n_(keine)_\n')
    expect(body).not.toContain('## Offen')
    expect(body).not.toContain('Branch')
  })
})

describe('vaultJournal', () => {
  const vault = (exists = true) => {
    const notes = new Set<string>(['Agents/Demo/old.md'])
    return {
      notes,
      status: vi.fn(async () => ({ exists })),
      create: vi.fn(async (title: string, folder?: string) => {
        const path = `${folder}/${title}.md`
        notes.add(path)
        return { path }
      }),
      writeBody: vi.fn(async (path: string) => {
        if (!notes.has(path)) throw new Error('gone')
        return { path }
      })
    }
  }

  it('creates the note once, then rewrites it; recreates it when deleted; nothing without a vault', async () => {
    const v = vault()
    const write = vaultJournal(v)
    expect(await write('Agents/Demo', 'new', undefined, 'body')).toBe('Agents/Demo/new.md')
    expect(await write('Agents/Demo', 'new', 'Agents/Demo/old.md', 'body 2')).toBe('Agents/Demo/old.md')
    expect(v.create).toHaveBeenCalledTimes(1)
    expect(await write('Agents/Demo', 'again', 'Agents/Demo/deleted.md', 'b')).toBe('Agents/Demo/again.md')
    expect(await vaultJournal(vault(false))('f', 't', undefined, 'b')).toBeUndefined()
  })
})
