import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { tempDir, tick } from './helpers'

type FakePty = {
  pid: number
  file: string
  args: string[]
  opts: { cwd: string; cols: number; rows: number; env: Record<string, string> }
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  data: (d: string) => void
  exit: (code: number) => void
}
const h = vi.hoisted(() => ({
  ptys: [] as FakePty[],
  /** What node-pty reports as the foreground process ('' = the shell itself). */
  foreground: '' as string | Error,
  userShell: '/bin/zsh' as string | undefined | Error,
  missing: new Set<string>()
}))
vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[], opts: FakePty['opts']) => {
    let onData: (d: string) => void = () => {}
    let onExit: (e: { exitCode: number }) => void = () => {}
    const pty: FakePty = {
      pid: h.ptys.length + 100,
      file,
      args,
      opts,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => onExit({ exitCode: 0 })),
      data: (d) => onData(d),
      exit: (code) => onExit({ exitCode: code })
    }
    h.ptys.push(pty)
    return {
      ...pty,
      get process() {
        if (h.foreground instanceof Error) throw h.foreground
        return h.foreground || file.split('/').pop()
      },
      onData: (cb: typeof onData) => (onData = cb),
      onExit: (cb: typeof onExit) => (onExit = cb)
    }
  }
}))
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return {
    ...actual,
    userInfo: () => {
      if (h.userShell instanceof Error) throw h.userShell
      return { ...actual.userInfo(), shell: h.userShell }
    }
  }
})
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  // The default shells "exist" on every runner (CI images ship without zsh).
  const shells = new Set(['/bin/zsh', '/bin/bash'])
  return { ...actual, existsSync: (p: string) => !h.missing.has(p) && (shells.has(p) || actual.existsSync(p)) }
})

import { TerminalService } from '../../../electron/main/services/terminal/TerminalService'
import type { AppSettings } from '@shared/types/settings'
import type { TerminalSettings, TerminalSnapshot } from '@shared/types/terminal'

const realPlatform = process.platform
const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p })

let emit: Mock
let svc: TerminalService
let projectDir: string
let dataDir: string

/** App settings in memory; tests without integration unless they turn it on. */
function settingsStore(terminal: Partial<TerminalSettings> = {}) {
  let current: AppSettings = { terminal: { shellIntegration: false, ...terminal } }
  return {
    get: () => current,
    update: vi.fn(async (patch: Partial<AppSettings>) => (current = { ...current, ...patch }))
  }
}

/** A service like the core's; `resolveProject` defaults to the one demo project. */
function service(opts: { resolveProject?: (id: string) => { name: string; path: string } | undefined; terminal?: Partial<TerminalSettings>; dir?: string } = {}) {
  return new TerminalService({
    emit,
    resolveProject: opts.resolveProject ?? ((id) => (id === 'p1' ? { name: 'demo', path: projectDir } : undefined)),
    settings: settingsStore(opts.terminal),
    dir: opts.dir ?? dataDir
  })
}

beforeEach(async () => {
  h.ptys.length = 0
  h.foreground = ''
  h.userShell = '/bin/zsh'
  h.missing.clear()
  emit = vi.fn()
  projectDir = await tempDir()
  dataDir = await tempDir()
  svc = service()
})
afterEach(() => {
  setPlatform(realPlatform)
  svc.killAll()
})
const pty = () => h.ptys[h.ptys.length - 1]

describe('TerminalService.create', () => {
  it('starts the login shell in Home with a cleaned environment', async () => {
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.npm_config_x = 'y'
    process.env.VITE_X = 'z'
    process.env.INIT_CWD = '/x'
    // markers of a Claude Code session Mindeck was started from (CLAUDE_CODE_*, CLAUDECODE, …)
    const claude = ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT']
    for (const k of claude) process.env[k] = '1'
    process.env.CLAUDE_CONFIG_DIR = '/kept'
    const info = await svc.create({ cols: 100, rows: 30 })
    delete process.env.ELECTRON_RUN_AS_NODE
    delete process.env.npm_config_x
    delete process.env.VITE_X
    delete process.env.INIT_CWD
    for (const k of [...claude, 'CLAUDE_CONFIG_DIR']) delete process.env[k]
    expect(info).toMatchObject({ title: '~', cwd: homedir(), cwdLabel: '~', shell: 'zsh', projectId: undefined })
    expect(pty().args).toEqual(['-l'])
    expect(pty().opts).toMatchObject({ cwd: homedir(), cols: 100, rows: 30 })
    const env = pty().opts.env
    expect(env).toMatchObject({ TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Mindeck' })
    for (const k of ['ELECTRON_RUN_AS_NODE', 'npm_config_x', 'VITE_X', 'INIT_CWD', 'NODE_ENV', ...claude]) expect(env).not.toHaveProperty(k)
    expect(env.CLAUDE_CONFIG_DIR).toBe('/kept') // the user's own Claude settings stay
    expect(env.LANG).toBeTruthy()
  })

  it('opens in a project with a ~-shortened label, clamping odd sizes', async () => {
    const info = await svc.create({ projectId: 'p1', cols: 99999, rows: Number.NaN })
    expect(info).toMatchObject({ title: 'demo', cwd: projectDir, projectId: 'p1' })
    expect(pty().opts).toMatchObject({ cols: 1000, rows: 24 })
    expect(info.cwdLabel).toBe(projectDir.startsWith(homedir()) ? `~${projectDir.slice(homedir().length)}` : projectDir)
  })

  it('labels folders under Home with ~', async () => {
    const svc2 = service({ resolveProject: () => ({ name: 'h', path: join(homedir()) }) })
    expect((await svc2.create({ projectId: 'any' })).cwdLabel).toBe('~')
    const under = await mkdtemp(join(homedir(), '.mindeck-test-'))
    const inHome = service({ resolveProject: () => ({ name: 'u', path: under }) })
    expect((await inHome.create({ projectId: 'any' })).cwdLabel).toBe(`~${under.slice(homedir().length)}`)
    inHome.killAll()
    await rm(under, { recursive: true, force: true })
    const sub = service({ resolveProject: () => ({ name: 's', path: join(homedir(), '..') }) })
    expect((await sub.create({ projectId: 'any' })).cwdLabel).toBe(join(homedir(), '..'))
    svc2.killAll()
    sub.killAll()
  })

  it('opens in any folder (from Files), named after it; the session is found by its id', async () => {
    const folder = await tempDir()
    const info = await svc.create({ cwd: folder })
    expect(info).toMatchObject({ title: basename(folder), cwd: folder, projectId: undefined })
    expect(svc.info(info.id)).toEqual(info)
    expect(svc.info('nope')).toBeUndefined()
    expect((await svc.create({ cwd: homedir() })).title).toBe('~')
    expect((await svc.create({ cwd: '/' })).title).toBe('/')
    await expect(svc.create({ cwd: 'relative/dir' })).rejects.toMatchObject({ code: 'bad-path' })
    // a folder asked for (a restored tab's last one) wins over the project's root; the tab keeps the project's name
    expect(await svc.create({ projectId: 'p1', cwd: folder })).toMatchObject({ cwd: folder, title: 'demo', projectId: 'p1' })
  })

  it('rejects unknown projects, missing folders and too many sessions', async () => {
    await expect(svc.create({ projectId: 'nope' })).rejects.toMatchObject({ code: 'not-found' })
    const gone = service({ resolveProject: () => ({ name: 'x', path: join(projectDir, 'missing') }) })
    await expect(gone.create({ projectId: 'x' })).rejects.toMatchObject({ code: 'not-found' })
    for (let i = 0; i < 12; i += 1) await svc.create(undefined as never)
    await expect(svc.create({})).rejects.toMatchObject({ code: 'limit' })
  })

  it('picks the shell per platform and falls back when it is missing', async () => {
    setPlatform('win32')
    await svc.create({})
    expect(pty()).toMatchObject({ file: 'powershell.exe', args: ['-NoLogo'] })
    expect(svc.list().at(-1)!.shell).toBe('powershell')

    setPlatform('darwin')
    h.userShell = undefined
    const savedShell = process.env.SHELL
    delete process.env.SHELL
    await svc.create({})
    expect(pty().file).toBe('/bin/zsh')

    setPlatform('linux')
    h.userShell = new Error('no passwd')
    await svc.create({})
    expect(pty().file).toBe('/bin/bash')

    process.env.SHELL = '/usr/local/bin/fish'
    h.missing.add('/usr/local/bin/fish')
    await svc.create({})
    expect(pty().file).toBe('/bin/sh')
    if (savedShell === undefined) delete process.env.SHELL
    else process.env.SHELL = savedShell
  })
})

describe('TerminalService sessions', () => {
  it('batches output per frame, keeps bounded scrollback and supports attach', async () => {
    const { id } = await svc.create({})
    pty().data('hel')
    pty().data('lo')
    expect(emit).not.toHaveBeenCalled()
    await tick(20)
    expect(emit).toHaveBeenCalledWith('terminal:data', { id, data: 'hello', end: 5 })

    pty().data('!')
    expect(svc.attach(id)).toEqual({ info: expect.objectContaining({ id }), buffer: 'hello!', end: 6 }) // attach flushes
    expect(svc.attach(id).end).toBe(6) // nothing pending
    pty().data('x'.repeat(300 * 1024))
    expect(svc.attach(id).buffer).toHaveLength(256 * 1024)
  })

  it('writes and resizes (with clamping), rejecting bad input', async () => {
    const { id } = await svc.create({})
    svc.write(id, 'ls\r')
    expect(pty().write).toHaveBeenCalledWith('ls\r')
    expect(() => svc.write(id, 5 as never)).toThrow('Invalid terminal input')
    expect(() => svc.write(id, 'x'.repeat(1024 * 1024 + 1))).toThrow('Invalid terminal input')
    svc.resize(id, 1, 0)
    expect(pty().resize).toHaveBeenCalledWith(2, 1)
    pty().resize.mockImplementationOnce(() => {
      throw new Error('exited')
    })
    expect(() => svc.resize(id, 80, 24)).not.toThrow()
    expect(() => svc.write('nope', 'x')).toThrow('Terminal session has ended')
  })

  it('reports exits (flushing pending output) and forgets the session', async () => {
    const { id } = await svc.create({})
    pty().data('bye')
    pty().exit(3)
    expect(emit.mock.calls).toEqual([
      ['terminal:data', { id, data: 'bye', end: 3 }],
      ['terminal:exit', { id, exitCode: 3 }]
    ])
    expect(svc.list()).toEqual([])
    svc.kill(id) // unknown → no-op
  })

  it('lists what runs in each shell: nothing at the prompt, else the program', async () => {
    const { id } = await svc.create({})
    expect(svc.list()[0]).not.toHaveProperty('running') // zsh waits at its prompt
    h.foreground = 'node'
    expect(svc.list()[0]).toMatchObject({ id, running: 'node' })
    h.foreground = '-zsh' // a login shell's process name
    expect(svc.list()[0].running).toBeUndefined()
    h.foreground = new Error('closed')
    expect(svc.list()[0].running).toBeUndefined()
  })

  it('kill and killAll end sessions, clearing pending timers', async () => {
    const a = await svc.create({})
    await svc.create({})
    svc.kill(a.id)
    expect(svc.list()).toHaveLength(1)
    pty().data('pending')
    svc.killAll()
    expect(svc.list()).toEqual([])
    svc.killAll() // idempotent
  })
})

describe('TerminalService.spawnProgram (agents)', () => {
  it('runs a program through the login shell with extra env; hidden from the terminal tabs', async () => {
    const onExit = vi.fn()
    const info = await svc.spawnProgram({
      title: 'Claude Code',
      cwd: projectDir,
      command: { file: 'claude', args: ['--session-id', 'abc', '--settings', '{"a":"it\'s"}'] },
      env: { MINDECK_HOOK_TOKEN: 't' },
      projectId: 'p1',
      onExit
    })
    expect(info).toMatchObject({ kind: 'agent', title: 'Claude Code', projectId: 'p1', shell: 'zsh' })
    expect(pty().file).toBe('/bin/zsh')
    expect(pty().args).toEqual(['-lc', `exec claude --session-id abc --settings '{"a":"it'\\''s"}'`])
    expect(pty().opts.env).toMatchObject({ MINDECK_HOOK_TOKEN: 't', TERM_PROGRAM: 'Mindeck' })
    expect(svc.list()).toEqual([]) // the Terminal module only lists shells
    expect(svc.attach(info.id).info.id).toBe(info.id) // but views can attach to it
    await svc.create({})
    expect(svc.list()).toHaveLength(1)

    pty().exit(0) // the shell tab — no agent callback
    h.ptys[0].exit(2)
    expect(onExit).toHaveBeenCalledOnce()
    expect(onExit).toHaveBeenCalledWith(2)
  })

  it('on Windows starts the program directly', async () => {
    setPlatform('win32')
    await svc.spawnProgram({ title: 'x', cwd: projectDir, command: { file: 'claude.exe', args: ['--a b'] } })
    expect(pty().file).toBe('claude.exe')
    expect(pty().args).toEqual(['--a b'])
  })

  it('refuses a missing folder', async () => {
    await expect(svc.spawnProgram({ title: 'x', cwd: join(projectDir, 'nope'), command: { file: 'claude', args: [] } })).rejects.toMatchObject({
      code: 'not-found'
    })
  })
})

describe('shellQuote', () => {
  it('leaves plain words, quotes everything else', async () => {
    const { shellQuote } = await import('../../../electron/main/services/terminal/TerminalService')
    expect(shellQuote('--session-id')).toBe('--session-id')
    expect(shellQuote('/a/b.c:1,2=3@x%y+z')).toBe('/a/b.c:1,2=3@x%y+z')
    expect(shellQuote('')).toBe("''")
    expect(shellQuote('a b')).toBe("'a b'")
    expect(shellQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`)
  })
})

describe('TerminalService settings and profiles', () => {
  it('fills in defaults; configure saves and resizes the kept output', async () => {
    expect(svc.settings()).toMatchObject({ fontSize: 13, bufferKb: 256, restore: true, shellIntegration: false, profiles: [] })
    const { id } = await svc.create({})
    expect(await svc.configure({ bufferKb: 64, fontSize: 15 })).toMatchObject({ bufferKb: 64, fontSize: 15 })
    expect(svc.settings().fontSize).toBe(15)
    pty().data('y'.repeat(100 * 1024))
    expect(svc.attach(id).buffer).toHaveLength(64 * 1024)
    expect(svc.shells().map((s) => s.id)).toEqual(expect.arrayContaining(['zsh', 'bash']))
  })

  it('starts a detected shell, a custom profile (through the login shell) or the default one', async () => {
    const own = { id: 'custom-ssh', name: 'Server', command: 'ssh', args: ['my host'], env: { FOO: 'bar' }, cwd: projectDir }
    svc = service({ terminal: { profiles: [own], defaultProfile: 'custom-ssh' } })

    const bash = await svc.create({ profileId: 'bash' })
    expect(pty().file).toMatch(/\/bash$/)
    expect(pty().args).toEqual(['-l'])
    expect(bash).toMatchObject({ profileId: 'bash', shell: 'bash', cwd: homedir() })
    expect(bash).not.toHaveProperty('integration')

    // the default profile: its folder, its environment, started via `zsh -lc exec …`
    const ssh = await svc.create({})
    expect(pty()).toMatchObject({ file: '/bin/zsh', args: ['-lc', "exec ssh 'my host'"] })
    expect(pty().opts).toMatchObject({ cwd: projectDir, env: expect.objectContaining({ FOO: 'bar', TERM_PROGRAM: 'Mindeck' }) })
    expect(ssh).toMatchObject({ profileId: 'custom-ssh', shell: 'ssh', title: basename(projectDir) })
    h.foreground = 'ssh'
    expect(svc.list().find((t) => t.id === ssh.id)).not.toHaveProperty('running') // ssh is the "shell" here

    // a project still opens in its own folder
    expect((await svc.create({ projectId: 'p1' })).cwd).toBe(projectDir)
    await expect(svc.create({ profileId: 'nope' })).rejects.toMatchObject({ code: 'not-found' })

    // a default that no longer exists: the login shell
    svc = service({ terminal: { defaultProfile: 'gone' } })
    expect(await svc.create({})).not.toHaveProperty('profileId')
    expect(pty()).toMatchObject({ file: '/bin/zsh', args: ['-l'] })
    // '' clears the default
    svc = service({ terminal: { defaultProfile: '' } })
    await svc.create({})
    expect(pty().args).toEqual(['-l'])
  })
})

describe('TerminalService shell integration', () => {
  it('loads zsh through ZDOTDIR, writing the scripts once', async () => {
    svc = service({ terminal: { shellIntegration: true } })
    process.env.ZDOTDIR = '/home/u/.config/zsh'
    const info = await svc.create({})
    delete process.env.ZDOTDIR
    expect(info.integration).toBe(true)
    const dir = join(dataDir, 'shell-integration')
    expect(pty().args).toEqual(['-l'])
    expect(pty().opts.env).toMatchObject({ ZDOTDIR: join(dir, 'zsh'), MINDECK_ZDOTDIR: '/home/u/.config/zsh' })
    expect(await readFile(join(dir, 'zsh', '.zshrc'), 'utf8')).toContain('133;C')
    await svc.create({})
    expect(pty().opts.env.MINDECK_ZDOTDIR).toBe('')
  })

  it('a custom profile that is a shell runs directly and takes the integration', async () => {
    const own = { id: 'custom-b', name: 'Bash', command: '/bin/bash', args: ['-l'], env: {} }
    svc = service({ terminal: { shellIntegration: true, profiles: [own] } })
    expect(await svc.create({ profileId: 'custom-b' })).toMatchObject({ integration: true, shell: 'bash' })
    expect(pty()).toMatchObject({ file: '/bin/bash', args: ['--init-file', join(dataDir, 'shell-integration', 'mindeck.bash'), '-i'] })
    expect(pty().opts.env.MINDECK_SHELL_LOGIN).toBe('1')
  })

  it('PowerShell needs no files; shells it cannot load into start without it', async () => {
    svc = service({ terminal: { shellIntegration: true }, dir: join(projectDir, 'file') })
    await writeFile(join(projectDir, 'file'), 'not a folder') // the scripts can't be written here
    expect(await svc.create({})).not.toHaveProperty('integration')
    expect(pty().args).toEqual(['-l'])

    setPlatform('win32')
    expect((await svc.create({})).integration).toBe(true)
    expect(pty().args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand'])

    setPlatform('linux')
    h.userShell = '/bin/sh'
    expect(await svc.create({})).not.toHaveProperty('integration')
  })
})

describe('TerminalService follows the folder (OSC 7)', () => {
  it('renames a folder tab, keeps a project tab name, and reads reports split across chunks', async () => {
    const folder = await tempDir()
    const { id } = await svc.create({})
    pty().data(`a\x1b]7;file://host${folder}\x07b`)
    await tick(20)
    expect(emit).toHaveBeenCalledWith('terminal:info', expect.objectContaining({ id, cwd: folder, title: basename(folder), cwdLabel: folder }))
    expect(svc.list()[0].cwd).toBe(folder)
    emit.mockClear()
    pty().data(`\x1b]7;file://host${folder}\x07`) // same folder: nothing new
    await tick(20)
    expect(emit.mock.calls.filter(([c]) => c === 'terminal:info')).toEqual([])

    const p = await svc.create({ projectId: 'p1' })
    pty().data('\x1b]7;file://host/')
    await tick(20)
    pty().data('tmp\x1b\\')
    await tick(20)
    expect(emit).toHaveBeenCalledWith('terminal:info', expect.objectContaining({ id: p.id, cwd: '/tmp', title: 'demo' }))
  })
})

describe('TerminalService saves the tabs for the next start', () => {
  const snapshot: TerminalSnapshot = {
    layout: 'cols',
    active: 1,
    tabs: [{ title: '~', cwd: '/home/u', scrollback: 'hello', profileId: 'zsh' }],
    savedAt: '2026-10-15T10:00:00.000Z'
  }

  it('persists and restores; nothing is kept when restoring is off', async () => {
    expect(await svc.restore()).toBeNull() // nothing saved yet
    await svc.persist(snapshot)
    expect(await svc.restore()).toEqual(snapshot)
    // Scrollback may show secrets: the file is the user's alone.
    if (process.platform !== 'win32') expect((await stat(join(dataDir, 'terminals.json'))).mode & 0o777).toBe(0o600)

    await writeFile(join(dataDir, 'terminals.json'), '{"layout":"nope"}')
    expect(await svc.restore()).toBeNull()
    // damaged: set aside for rescue, not overwritten by the next save
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeFile(join(dataDir, 'terminals.json'), '{"layout":')
    expect(await svc.restore()).toBeNull()
    expect((await readdir(dataDir)).some((name) => name.startsWith('terminals.corrupt-'))).toBe(true)

    // a quit waits for the save under way — a failing one too
    const pending = svc.persist(snapshot)
    let done = false
    const quit = svc.saved().then(() => (done = true))
    expect(done).toBe(false)
    await pending
    await quit
    expect(done).toBe(true)
    await svc.saved() // nothing under way: at once
    await rm(join(dataDir, 'terminals.json'))
    await mkdir(join(dataDir, 'terminals.json')) // a folder in the way: the save fails
    const failing = svc.persist(snapshot)
    failing.catch(() => {})
    await svc.saved()
    await expect(failing).rejects.toThrow()
    await rm(join(dataDir, 'terminals.json'), { recursive: true })
    svc = service({ terminal: { restore: false } })
    expect(await svc.restore()).toBeNull()
    await svc.persist(snapshot)
    await expect(readFile(join(dataDir, 'terminals.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('terminal request schemas', () => {
  it('hold profiles and settings to their bounds', async () => {
    const { parseRequest } = await import('@shared/ipc/schemas')
    const profile = { id: 'custom-1', name: 'Dev', command: 'ssh', args: ['h'], env: { A_1: 'x' }, cwd: '/srv' }
    expect(parseRequest('terminal:configure', { profiles: [profile], defaultProfile: '' })).toMatchObject({ ok: true })
    expect(parseRequest('terminal:configure', { profiles: [{ ...profile, cwd: 'C:\\Users' }] })).toMatchObject({ ok: true })
    expect(parseRequest('terminal:configure', { profiles: [{ ...profile, cwd: 'relative' }] })).toMatchObject({ ok: false })
    expect(parseRequest('terminal:configure', { profiles: [{ ...profile, id: 'zsh' }] })).toMatchObject({ ok: false })
    expect(parseRequest('terminal:configure', { profiles: [{ ...profile, env: { 'BAD KEY': 'x' } }] })).toMatchObject({ ok: false })
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`K${i}`, 'v']))
    expect(parseRequest('terminal:configure', { profiles: [{ ...profile, env: many }] })).toMatchObject({ ok: false })
    expect(parseRequest('terminal:configure', { fontSize: 99 })).toMatchObject({ ok: false })
    expect(parseRequest('terminal:configure', { cursorStyle: 'block', scrollback: 1000 })).toMatchObject({ ok: true })
    expect(parseRequest('terminal:persist', { layout: 'grid', active: 0, tabs: [], savedAt: 'x' })).toMatchObject({ ok: true })
  })
})
