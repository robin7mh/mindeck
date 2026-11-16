import { afterEach, describe, expect, it, vi } from 'vitest'
import { adoptLoginEnv, LOGIN_ENV_TIMEOUT_MS, needsLoginEnv, parseEnvOutput, runShell, takeOver, type RunShell } from '../../../electron/main/platform/loginEnv'

/** What `printf %s MARK; /usr/bin/env -0; printf %s MARK` prints, with the mark the command line carries. */
const answer = (command: string, vars: Record<string, string>, noise = { before: '', after: '' }) => {
  const mark = /printf %s (\S+);/.exec(command)![1]
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}\0`)
    .join('')
  return `${noise.before}${mark}${body}${mark}${noise.after}`
}

/** A shell double answering with `vars`; records how it was started. */
function shellAnswering(vars: Record<string, string>, noise?: { before: string; after: string }) {
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number }[] = []
  const run: RunShell = async (file, args, env, timeoutMs) => {
    calls.push({ file, args, env, timeoutMs })
    return answer(args[1], vars, noise)
  }
  return { run, calls }
}

/** launchd's environment for an app started from the Finder. */
const finder = (): NodeJS.ProcessEnv => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/r', SSH_AUTH_SOCK: '/launchd/agent' })

afterEach(() => vi.useRealTimers())

describe('whether Mindeck lacks the shell environment', () => {
  it('started from the Finder / Dock (no SHLVL) on macOS and Linux — not from a terminal, never on Windows', () => {
    expect(needsLoginEnv({ PATH: '/usr/bin' }, 'darwin')).toBe(true)
    expect(needsLoginEnv({ PATH: '/usr/bin' }, 'linux')).toBe(true)
    expect(needsLoginEnv({ PATH: '/usr/bin', SHLVL: '1' }, 'darwin')).toBe(false)
    expect(needsLoginEnv({ PATH: 'C:\\Windows' }, 'win32')).toBe(false)
    // These tests run from a shell.
    expect(needsLoginEnv()).toBe(process.platform !== 'win32' && !process.env.SHLVL)
  })
})

describe("reading the shell's answer", () => {
  it('only what env -0 printed between the marks: values with = and line breaks intact, noise around ignored', () => {
    const out = `Welcome!\n\x1b[1mMARK${'PATH=/a:/b\0'}${'URL=x=1&y=2\0'}${'MULTI=one\ntwo\0'}${'not-a-variable\0'}${'=empty-name\0'}MARK\x1b[0m bye`
    expect(parseEnvOutput(out, 'MARK')).toEqual({ PATH: '/a:/b', URL: 'x=1&y=2', MULTI: 'one\ntwo' })
  })

  it('nothing without both marks', () => {
    expect(parseEnvOutput('PATH=/a\0', 'MARK')).toBeUndefined()
    expect(parseEnvOutput('MARKPATH=/a\0', 'MARK')).toBeUndefined()
  })
})

describe('taking it over', () => {
  it("the shell's values win, as in the user's terminal; unchanged ones aren't counted", () => {
    const env = finder()
    const changed = takeOver(env, { PATH: '/Users/r/.local/bin:/opt/homebrew/bin:/usr/bin:/bin', HOME: '/Users/r', SSH_AUTH_SOCK: '/1password/agent.sock', GEMINI_API_KEY: 'g' })
    expect(changed).toEqual(['PATH', 'SSH_AUTH_SOCK', 'GEMINI_API_KEY'])
    expect(env).toEqual({ PATH: '/Users/r/.local/bin:/opt/homebrew/bin:/usr/bin:/bin', HOME: '/Users/r', SSH_AUTH_SOCK: '/1password/agent.sock', GEMINI_API_KEY: 'g' })
  })

  it("keeps the answering session's own state, the terminal's, Electron's switches, Mindeck's settings and the language", () => {
    const env: NodeJS.ProcessEnv = { MINDECK_HOME: '/Users/r/Mindeck' }
    const kept = ['PWD', 'OLDPWD', 'SHLVL', '_', 'COLORTERM', 'TERM', 'TERM_PROGRAM', 'TERM_SESSION_ID', 'ELECTRON_RUN_AS_NODE', 'MINDECK_HOME', 'MINDECK_RESOLVING_ENVIRONMENT']
    // git's messages stay English — Mindeck reads them (ScmService).
    const language = ['LANG', 'LANGUAGE', 'LC_ALL', 'LC_MESSAGES']
    const changed = takeOver(env, { ...Object.fromEntries([...kept, ...language].map((k) => [k, 'shell'])), TERMINFO_DIRS: '/t', LANGFLAGS: 'x' })
    expect(changed).toEqual(['TERMINFO_DIRS', 'LANGFLAGS'])
    expect(env).toEqual({ MINDECK_HOME: '/Users/r/Mindeck', TERMINFO_DIRS: '/t', LANGFLAGS: 'x' })
  })
})

describe('adopting the login environment at start', () => {
  it('asks the shell as an interactive login shell (profile and rc files), marked, and takes its answer over', async () => {
    const shell = shellAnswering({ PATH: '/Users/r/.local/bin:/usr/bin:/bin', HOME: '/Users/r', PWD: '/Users/r', SHLVL: '1' }, { before: 'Last login: today\n', after: '' })
    const env = finder()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const changed = await adoptLoginEnv({ env, platform: 'darwin', shell: '/bin/zsh', run: shell.run })
    expect(changed).toEqual(['PATH'])
    expect(env.PATH).toBe('/Users/r/.local/bin:/usr/bin:/bin')
    expect(env.PWD).toBeUndefined()
    expect(env.SHLVL).toBeUndefined() // the next start from the Dock (an update's relaunch) asks again
    const [call] = shell.calls
    expect(call.file).toBe('/bin/zsh')
    expect(call.args[0]).toBe('-ilc')
    expect(call.args[1]).toMatch(/^printf %s (MINDECK[0-9a-f]{32}); \/usr\/bin\/env -0; printf %s \1$/)
    expect(call.env).toMatchObject({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', MINDECK_RESOLVING_ENVIRONMENT: '1' })
    expect(env.MINDECK_RESOLVING_ENVIRONMENT).toBeUndefined() // only the shell sees the marker
    expect(call.timeoutMs).toBe(LOGIN_ENV_TIMEOUT_MS)
    // How many and how long — never a value.
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[env\] took over 1 variable\(s\) from zsh -ilc in \d+ ms, PATH among them$/))
  })

  it("logs no PATH when the shell's PATH is the one Mindeck has", async () => {
    const env = finder()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const changed = await adoptLoginEnv({ env, platform: 'linux', shell: '/bin/bash', run: shellAnswering({ ...finder(), JAVA_HOME: '/opt/jdk' }).run })
    expect(changed).toEqual(['JAVA_HOME'])
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[env\] took over 1 variable\(s\) from bash -ilc in \d+ ms$/))
  })

  it("asks the user's own shell — the one their terminals run — when none is given", async () => {
    const shell = shellAnswering({ PATH: '/x' })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await adoptLoginEnv({ env: finder(), platform: 'darwin', run: shell.run })
    expect(shell.calls[0].file).toMatch(/\/\w+$/)
  })

  it('asks nothing when started from a terminal, or on Windows', async () => {
    const shell = shellAnswering({ PATH: '/x' })
    expect(await adoptLoginEnv({ env: { ...finder(), SHLVL: '2' }, platform: 'darwin', run: shell.run })).toEqual([])
    expect(await adoptLoginEnv({ env: finder(), platform: 'win32', run: shell.run })).toEqual([])
    expect(shell.calls).toHaveLength(0)
  })

  it("keeps what Mindeck has when the shell fails, answers without the marks or without a PATH — and says so", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing: RunShell = async () => {
      throw new Error('spawn /bin/nu ENOENT')
    }
    const garbled: RunShell = async () => 'zsh: command not found: printf'
    const pathless: RunShell = async (_f, args) => answer(args[1], { HOME: '/Users/r' })
    for (const run of [failing, garbled, pathless]) {
      const env = finder()
      expect(await adoptLoginEnv({ env, platform: 'darwin', shell: '/bin/nu', run })).toEqual([])
      expect(env).toEqual(finder())
    }
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      "[env] couldn't read the environment of /bin/nu (spawn /bin/nu ENOENT): programs find what a login shell has",
      "[env] couldn't read the environment of /bin/nu (its answer held no environment): programs find what a login shell has",
      "[env] couldn't read the environment of /bin/nu (its answer held no environment): programs find what a login shell has"
    ])
  })

  it("stops waiting after the time limit — even when the shell's output stays open — and keeps what Mindeck has", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const env = finder()
    const pending = adoptLoginEnv({ env, platform: 'darwin', shell: '/bin/zsh', run: () => new Promise<string>(() => {}), timeoutMs: 3000 })
    await vi.advanceTimersByTimeAsync(3000)
    expect(await pending).toEqual([])
    expect(env).toEqual(finder())
    expect(warn).toHaveBeenCalledWith("[env] couldn't read the environment of /bin/zsh (no answer within 3 s): programs find what a login shell has")
  })
})

describe('running the shell', () => {
  it("its stdout — also when it exits non-zero; stdin is closed, so a read gets EOF instead of waiting", async () => {
    expect(await runShell('/bin/sh', ['-c', 'printf ok'], { PATH: '/usr/bin:/bin' }, 5000)).toBe('ok')
    expect(await runShell('/bin/sh', ['-c', 'printf partial; exit 3'], { PATH: '/usr/bin:/bin' }, 5000)).toBe('partial')
    expect(await runShell('/bin/sh', ['-c', 'read line; printf "read:%s" "$line"'], { PATH: '/usr/bin:/bin' }, 5000)).toBe('read:')
  })

  it('rejected without any output: a failure, or nothing printed', async () => {
    await expect(runShell('/bin/sh', ['-c', 'exit 3'], { PATH: '/usr/bin:/bin' }, 5000)).rejects.toThrow(/Command failed/)
    await expect(runShell('/bin/sh', ['-c', 'true'], { PATH: '/usr/bin:/bin' }, 5000)).rejects.toThrow('no output')
  })
})
