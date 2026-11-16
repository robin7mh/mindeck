import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { shellCommand } from '../services/terminal/TerminalService'

// Started from the Finder, the Dock or Spotlight (or a Linux desktop launcher), Mindeck gets the bare
// environment of launchd / the session — on macOS PATH=/usr/bin:/bin:/usr/sbin:/sbin — not the one the
// user's terminal has. Mindeck starts agents through a login shell (`zsh -lc`), but a non-interactive
// login shell reads ~/.zprofile only, not ~/.zshrc, where installers like Claude Code's put
// ~/.local/bin: from the Finder, Mindeck didn't find agents the terminal did. So once at start, like
// VS Code, the user's shell is asked as an interactive login shell (`-ilc`: profile and rc files) for
// its environment, and the core starts with it.

/** The longest the start waits for the shell (zsh with a plain ~/.zshrc answers in ~80 ms). */
export const LOGIN_ENV_TIMEOUT_MS = 5_000

/**
 * Not taken over: what describes the shell session that answered (its folder, depth and last
 * command), the terminal it would run in, Electron's switches, Mindeck's own settings (paths.ts has
 * read MINDECK_HOME before this runs), and the language: Mindeck reads git's messages in English
 * (ScmService: "not a git repository"), and a LANG=de_DE from ~/.zshrc would translate them.
 * Terminals get a LANG of their own (TerminalService.shellEnv).
 */
const KEEP = /^(PWD|OLDPWD|SHLVL|_|COLORTERM|TERM|TERM_.*|ELECTRON_.*|MINDECK_.*|LANG|LANGUAGE|LC_.*)$/

/**
 * Whether Mindeck lacks the user's shell environment: not when started from a terminal (every
 * POSIX shell and fish export SHLVL — `npm run dev`, a script, the end-to-end tests), never on
 * Windows (a program gets the user's PATH there; executables.ts reads it fresh from the registry).
 */
export function needsLoginEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32' && !env.SHLVL
}

/**
 * The variables `env -0` printed between two marks: whatever the shell's rc files print before
 * or after (a greeting, a prompt's escape codes) stays outside. Undefined when the marks aren't there.
 */
export function parseEnvOutput(out: string, mark: string): Record<string, string> | undefined {
  const start = out.indexOf(mark)
  const end = out.lastIndexOf(mark)
  if (start < 0 || end === start) return undefined
  const vars: Record<string, string> = {}
  for (const entry of out.slice(start + mark.length, end).split('\0')) {
    const eq = entry.indexOf('=')
    if (eq > 0) vars[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return vars
}

/** `vars` into `env`, the shell's value winning (as in the user's terminal) except for KEEP; the names that changed. */
export function takeOver(env: NodeJS.ProcessEnv, vars: Record<string, string>): string[] {
  const changed: string[] = []
  for (const [key, value] of Object.entries(vars)) {
    if (KEEP.test(key) || env[key] === value) continue
    env[key] = value
    changed.push(key)
  }
  return changed
}

/** Runs the shell; resolves with its stdout. */
export type RunShell = (file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<string>

/**
 * Its stdout — also when it exits non-zero (a failing line in ~/.zshrc doesn't spoil the answer);
 * rejected when there is none. stdin is closed at once: an rc file that reads input gets EOF, not a wait.
 */
export const runShell: RunShell = (file, args, env, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      stdout ? resolve(stdout) : reject(err ?? new Error('no output'))
    )
    child.stdin!.end()
  })

/** `promise`, or a rejection after `ms` — a shell's background job can hold its output open after the shell is gone. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms)
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (err: unknown) => (clearTimeout(timer), reject(err))
    )
  })
}

export interface LoginEnvOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** The user's shell (default: TerminalService's, the one their terminals run). */
  shell?: string
  run?: RunShell
  timeoutMs?: number
}

/**
 * Takes the user's shell environment over into `env` (process.env) when Mindeck lacks it; the names
 * that changed. The shell sees MINDECK_RESOLVING_ENVIRONMENT=1, so an rc file can skip what only
 * belongs in a terminal (tmux, a greeting). Never rejects: when the shell can't answer (hanging, gone,
 * one without -ilc), Mindeck keeps the environment it was started with, and programs find what a login
 * shell has. The log names how many variables changed, never their values.
 */
export async function adoptLoginEnv({ env = process.env, platform = process.platform, shell, run = runShell, timeoutMs = LOGIN_ENV_TIMEOUT_MS }: LoginEnvOptions = {}): Promise<string[]> {
  if (!needsLoginEnv(env, platform)) return []
  const file = shell ?? shellCommand().file
  const mark = `MINDECK${randomUUID().replace(/-/g, '')}`
  const started = Date.now()
  try {
    const command = `printf %s ${mark}; /usr/bin/env -0; printf %s ${mark}`
    const out = await within(run(file, ['-ilc', command], { ...env, MINDECK_RESOLVING_ENVIRONMENT: '1' }, timeoutMs), timeoutMs)
    const vars = parseEnvOutput(out, mark)
    if (!vars?.PATH) throw new Error('its answer held no environment')
    const changed = takeOver(env, vars)
    console.log(`[env] took over ${changed.length} variable(s) from ${basename(file)} -ilc in ${Date.now() - started} ms${changed.includes('PATH') ? ', PATH among them' : ''}`)
    return changed
  } catch (err) {
    console.warn(`[env] couldn't read the environment of ${file} (${(err as Error).message}): programs find what a login shell has`)
    return []
  }
}
