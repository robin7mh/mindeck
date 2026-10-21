import { spawn, type IPty } from 'node-pty'
import { existsSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { REQUEST_SCHEMAS } from '@shared/ipc/schemas'
import type { AppSettings } from '@shared/types/settings'
import {
  DEFAULT_TERMINAL_SETTINGS,
  type TerminalAttach,
  type TerminalData,
  type TerminalExit,
  type TerminalInfo,
  type TerminalReveal,
  type TerminalSettings,
  type TerminalShell,
  type TerminalSnapshot
} from '@shared/types/terminal'
import { readJson } from '../../lib/jsonFile'
import { writeAtomic } from '../../lib/writeAtomic'
import { integrate, scanCwd, shellKind, writeScripts, type ShellLaunch } from './integration'
import { detectShells } from './shells'

const MAX_SESSIONS = 12
const FLUSH_MS = 8 // batch PTY output into ~frame-sized IPC messages
const MAX_WRITE = 1024 * 1024

interface Session {
  info: TerminalInfo
  pty: IPty
  pending: string
  timer?: NodeJS.Timeout
  buffer: string
  end: number
  /** The start of a folder report (OSC 7) the next chunk completes. */
  osc: string
}

type Emit = {
  (channel: 'terminal:data', payload: TerminalData): void
  (channel: 'terminal:exit', payload: TerminalExit): void
  (channel: 'terminal:info', payload: TerminalInfo): void
  (channel: 'terminal:reveal', payload: TerminalReveal): void
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

const clamp = (n: unknown, min: number, max: number, fallback: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback

/** The user's login shell — what Terminal.app would start. */
export function shellCommand(): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] }
  let file = ''
  try {
    file = userInfo().shell ?? ''
  } catch {
    /* no passwd entry */
  }
  file ||= process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  if (!existsSync(file)) file = '/bin/sh'
  // Login shell: apps launched from the Dock get a minimal PATH; -l restores
  // the user's real environment (Homebrew, nvm, …) from their profile.
  return { file, args: ['-l'] }
}

/** POSIX single-quoting: the word reaches the program exactly as given. */
export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/** A program started like from the user's terminal (login shell → real PATH). */
function viaLoginShell(command: { file: string; args: string[] }): { file: string; args: string[] } {
  if (process.platform === 'win32') return command
  const shell = shellCommand().file
  return { file: shell, args: ['-lc', `exec ${[command.file, ...command.args].map(shellQuote).join(' ')}`] }
}

/**
 * The user's own environment, minus what Mindeck's dev tooling injected:
 * ELECTRON_RUN_AS_NODE alone would break any Electron app started from here,
 * and the markers of a Claude Code session Mindeck may have been launched from
 * would make a `claude` started here think it is that session's child.
 */
export function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  // process.env values are always strings at runtime (assigning undefined stores 'undefined').
  for (const [key, value] of Object.entries(process.env) as [string, string][]) {
    if (/^(ELECTRON_|VITE_|npm_)/i.test(key) || key === 'INIT_CWD' || key === 'NODE_ENV') continue
    if (/^(CLAUDE_CODE_|CLAUDE_AGENT_SDK)/.test(key) || key === 'CLAUDECODE' || key === 'CLAUDE_PID' || key === 'CLAUDE_EFFORT') continue
    env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'Mindeck'
  env.LANG ||= 'en_US.UTF-8'
  return env
}

/** A folder's tab title: `~` for Home, else its name. */
const folderTitle = (cwd: string) => (cwd === homedir() ? '~' : basename(cwd) || cwd)

/** A folder for display, Home shortened to `~`. */
function cwdLabel(cwd: string): string {
  const home = homedir()
  return cwd === home ? '~' : cwd.startsWith(home + sep) ? `~${cwd.slice(home.length)}` : cwd
}

const isDir = (path: string) => stat(path).then((s) => s.isDirectory(), () => false)

/** Shells a command can be typed into (a profile's own program, e.g. htop, is none). */
const typable = (shell: string) => !!shellKind(shell) || /^(sh|dash|ksh)$/.test(shell)

/** The command as typed into a shell that may be in another folder: change there first. */
function inFolder(shell: string, cwd: string, command: string): string {
  if (shellKind(shell) === 'pwsh') return `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ${command}`
  return `cd ${shellQuote(cwd)} && ${command}`
}

/**
 * Interactive shells for the user (phase PT). Distinct from agent command
 * execution (§8.1): the renderer can only send keystrokes and sizes — which
 * binary runs, and where, is decided here (a detected shell, or a profile the
 * user set up in the desktop's settings). Output is batched per frame and a
 * bounded scrollback is kept so a view can re-attach after a reload; the
 * folder a shell reports (OSC 7) follows along. The renderer's tabs, layout
 * and recent output are kept in a file so they come back after a restart.
 */
export class TerminalService {
  private readonly sessions = new Map<string, Session>()
  /** Chars of output kept per session (Settings → Terminal). */
  private limit: number
  /** The integration scripts are written once per run; false: they couldn't be. */
  private scripts?: Promise<boolean>
  /** Saves of the tabs still being written (the window's last one arrives while Mindeck quits). */
  private readonly writing = new Set<Promise<unknown>>()

  constructor(
    private readonly opts: {
      emit: Emit
      /** Project id → name/path (ProjectService); undefined if unknown. */
      resolveProject: (id: string) => { name: string; path: string } | undefined
      /** The app settings: the Terminal's preferences live in `terminal`. */
      settings: { get(): AppSettings; update(patch: Partial<AppSettings>): Promise<AppSettings> }
      /** Where the integration scripts and the saved terminals go (the data folder). */
      dir: string
    }
  ) {
    this.limit = this.settings().bufferKb * 1024
  }

  /** The Terminal's preferences, defaults filled in. */
  settings(): TerminalSettings {
    return { ...DEFAULT_TERMINAL_SETTINGS, ...this.opts.settings.get().terminal }
  }

  async configure(patch: Partial<TerminalSettings>): Promise<TerminalSettings> {
    const next = { ...this.settings(), ...patch }
    await this.opts.settings.update({ terminal: next })
    this.limit = next.bufferKb * 1024
    return next
  }

  /** The shells installed here — profiles of their own, next to the user's. */
  shells(): TerminalShell[] {
    return detectShells()
  }

  async create(req: { projectId?: string; cwd?: string; cols?: number; rows?: number; profileId?: string }): Promise<TerminalInfo> {
    const project = req?.projectId ? this.opts.resolveProject(req.projectId) : undefined
    if (req?.projectId && !project) throw coded('not-found', 'Project not found')
    if (req?.cwd && !isAbsolute(req.cwd)) throw coded('bad-path', 'cwd must be an absolute folder')
    const prefs = this.settings()
    const profile = this.profile(req?.profileId ?? prefs.defaultProfile, !!req?.profileId)
    // A folder asked for (a restored tab's last one) wins over the project's root.
    const cwd = req?.cwd ? resolve(req.cwd) : (project?.path ?? profile.cwd ?? homedir())
    const launch = prefs.shellIntegration ? await this.integrated(profile.command, profile.env) : undefined
    const command = launch ?? profile.command
    return this.start({
      title: project?.name ?? folderTitle(cwd),
      cwd,
      // A profile's own program starts through the login shell (the user's PATH), like an
      // agent — unless it is a shell itself: that one sets up its PATH (and takes the integration).
      command: profile.custom && !shellKind(profile.command.file) ? viaLoginShell(command) : command,
      shell: basename(profile.command.file).replace(/\.exe$/i, ''),
      env: { ...profile.env, ...launch?.env },
      projectId: project ? req.projectId : undefined,
      profileId: profile.id,
      integration: !!launch,
      cols: req?.cols,
      rows: req?.rows
    })
  }

  /**
   * What a profile id starts: the user's own profile, a detected shell, or
   * (none given) the login shell. An unknown default falls back to the login
   * shell; an unknown id asked for is an error.
   */
  private profile(
    id: string | undefined,
    explicit: boolean
  ): { id?: string; command: ShellLaunch; env?: Record<string, string>; cwd?: string; custom?: boolean } {
    if (id) {
      const own = this.settings().profiles.find((p) => p.id === id)
      if (own) return { id, command: { file: own.command, args: own.args }, env: own.env, cwd: own.cwd, custom: true }
      const shell = this.shells().find((s) => s.id === id)
      if (shell) return { id, command: { file: shell.file, args: shell.args } }
      if (explicit) throw coded('not-found', 'Terminal profile not found')
    }
    return { command: shellCommand() }
  }

  /** The command with shell integration, if it can take it (and the scripts are in place). */
  private async integrated(command: ShellLaunch, env: Record<string, string> = {}): Promise<ShellLaunch | undefined> {
    const kind = shellKind(command.file)
    if (!kind) return undefined
    const dir = join(this.opts.dir, 'shell-integration')
    if (kind !== 'pwsh') {
      this.scripts ??= writeScripts(dir).then(
        () => true,
        () => false
      )
      if (!(await this.scripts)) return undefined
    }
    return integrate(command, dir, { ...shellEnv(), ...env })
  }

  /**
   * Saves the renderer's tabs for the next start (nothing — and nothing kept — when restoring is off).
   * Scrollback holds whatever the shells printed (tokens, keys): for the user's eyes only (0600).
   */
  async persist(snapshot: TerminalSnapshot): Promise<void> {
    const file = join(this.opts.dir, 'terminals.json')
    const write = this.settings().restore ? writeAtomic(file, JSON.stringify(snapshot), 0o600) : rm(file, { force: true })
    this.writing.add(write)
    try {
      await write
    } finally {
      this.writing.delete(write)
    }
  }

  /** Once the saves under way are on disk (or failed — persist's caller hears of that): a quit waits for them. */
  async saved(): Promise<void> {
    await Promise.allSettled([...this.writing])
  }

  /** The tabs saved last time, unless restoring is off or the file is missing or damaged. */
  async restore(): Promise<TerminalSnapshot | null> {
    if (!this.settings().restore) return null
    // A damaged file is set aside (readJson) rather than overwritten by the next save.
    const parsed = REQUEST_SCHEMAS['terminal:persist'].safeParse(await readJson(join(this.opts.dir, 'terminals.json')))
    return parsed.success ? parsed.data : null
  }

  /**
   * Core-internal (never an IPC channel): run a program — a coding agent — in
   * a PTY, started through the user's login shell so it finds what their own
   * terminal would. The renderer can watch and type into it like any session.
   */
  async spawnProgram(req: {
    title: string
    cwd: string
    command: { file: string; args: string[] }
    env?: Record<string, string>
    projectId?: string
    cols?: number
    rows?: number
    onExit?: (exitCode: number) => void
  }): Promise<TerminalInfo> {
    return this.start({ ...req, command: viaLoginShell(req.command), kind: 'agent' })
  }

  private async start(req: {
    title: string
    cwd: string
    command: { file: string; args: string[] }
    /** Display name of the program (default: the binary's). */
    shell?: string
    env?: Record<string, string>
    projectId?: string
    profileId?: string
    integration?: boolean
    cols?: number
    rows?: number
    kind?: 'agent'
    onExit?: (exitCode: number) => void
  }): Promise<TerminalInfo> {
    if (this.sessions.size >= MAX_SESSIONS) throw coded('limit', `At most ${MAX_SESSIONS} terminals`)
    const { cwd, command } = req
    if (!(await isDir(cwd))) {
      throw coded('not-found', `Folder not found: ${cwd}`)
    }

    const pty = spawn(command.file, command.args, {
      name: 'xterm-256color',
      cols: clamp(req.cols, 2, 1000, 80),
      rows: clamp(req.rows, 1, 500, 24),
      cwd,
      env: { ...shellEnv(), ...req.env }
    })

    const info: TerminalInfo = {
      id: randomUUID(),
      title: req.title,
      cwd,
      cwdLabel: cwdLabel(cwd),
      shell: req.shell ?? basename(command.file).replace(/\.exe$/i, ''),
      projectId: req.projectId,
      createdAt: new Date().toISOString(),
      ...(req.kind ? { kind: req.kind } : {}),
      ...(req.profileId ? { profileId: req.profileId } : {}),
      ...(req.integration ? { integration: true } : {})
    }
    const session: Session = { info, pty, pending: '', buffer: '', end: 0, osc: '' }
    pty.onData((data) => this.push(session, data))
    // node-pty can call this from its native exit callback: an exception thrown here would
    // not reach Node's handlers but end the whole app (std::terminate) — log it instead.
    pty.onExit(({ exitCode }) => {
      try {
        this.flush(session)
        this.sessions.delete(info.id)
        this.opts.emit('terminal:exit', { id: info.id, exitCode })
        req.onExit?.(exitCode)
      } catch (err) {
        console.error(`[terminal] after ${info.id} ended:`, err)
      }
    })
    this.sessions.set(info.id, session)
    return info
  }

  /**
   * Core-internal (an agent's terminal_run): run a command where the user sees
   * it — in the first terminal waiting at its prompt (after changing to `cwd`),
   * else in a new one there — and show that terminal (`terminal:reveal`).
   * `start` is the terminal's output length before the command: what it printed
   * since is `output(id, start)`.
   */
  async runVisible(req: { command: string; cwd: string; projectId?: string; by: string }): Promise<{ info: TerminalInfo; opened: boolean; start: number }> {
    if (!req.command.trim() || req.command.length > MAX_WRITE || /[\r\n]/.test(req.command)) throw coded('bad-input', 'One command line, please')
    // Windows reports no foreground program: whether a shell there is free can't be told, so a new one.
    const free =
      process.platform === 'win32' ? undefined : [...this.sessions.values()].find((s) => s.info.kind !== 'agent' && typable(s.info.shell) && !this.foreground(s))
    let session = free
    if (!session) session = this.require((await this.create({ projectId: req.projectId, cwd: req.cwd })).id)
    this.flush(session)
    const start = session.end
    const { shell } = session.info
    // A reused shell may sit in another folder, with something half typed at its prompt (cleared first: ^E^U).
    const line = free ? inFolder(shell, req.cwd, req.command) : req.command
    session.pty.write(`${free && shellKind(shell) !== 'pwsh' ? '\x05\x15' : ''}${line}\r`)
    this.opts.emit('terminal:reveal', { info: session.info, by: req.by })
    return { info: session.info, opened: !free, start }
  }

  /** What a session printed since `from` (its output length then), as far as the kept output reaches back. */
  output(id: string, from = 0): string {
    const s = this.require(id)
    this.flush(s)
    return s.buffer.slice(Math.max(0, from - (s.end - s.buffer.length)))
  }

  /** The Terminal module's tabs — agent PTYs live in the Agents module — with what runs in them now. */
  list(): TerminalInfo[] {
    return [...this.sessions.values()]
      .filter((s) => s.info.kind !== 'agent')
      .map((s) => {
        const running = this.foreground(s)
        return running ? { ...s.info, running } : s.info
      })
  }

  /** A session's info (agent PTYs included), if it is still running. */
  info(id: string): TerminalInfo | undefined {
    return this.sessions.get(id)?.info
  }

  attach(id: string): TerminalAttach {
    const s = this.require(id)
    this.flush(s)
    return { info: s.info, buffer: s.buffer, end: s.end }
  }

  write(id: string, data: string): void {
    if (typeof data !== 'string' || data.length > MAX_WRITE) throw coded('bad-input', 'Invalid terminal input')
    this.require(id).pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.require(id)
    try {
      s.pty.resize(clamp(cols, 2, 1000, 80), clamp(rows, 1, 500, 24))
    } catch {
      /* the process may have exited between the check and the resize */
    }
  }

  kill(id: string): void {
    this.sessions.get(id)?.pty.kill()
  }

  /** Window closed or app quitting: no shell outlives its window. */
  killAll(): void {
    for (const s of this.sessions.values()) {
      if (s.timer) clearTimeout(s.timer)
      s.pty.kill()
    }
    this.sessions.clear()
  }

  /** The foreground program, unless it is the shell itself — then the shell waits at its prompt. */
  private foreground(s: Session): string | undefined {
    let name = ''
    try {
      name = s.pty.process.replace(/^-/, '').replace(/\.exe$/i, '')
    } catch {
      /* the PTY is closing */
    }
    return name && name !== s.info.shell ? name : undefined
  }

  private require(id: string): Session {
    const s = this.sessions.get(id)
    if (!s) throw coded('not-found', 'Terminal session has ended')
    return s
  }

  private push(s: Session, data: string): void {
    s.pending += data
    s.timer ??= setTimeout(() => this.flush(s), FLUSH_MS)
  }

  private flush(s: Session): void {
    if (s.timer) clearTimeout(s.timer)
    s.timer = undefined
    if (!s.pending) return
    const data = s.pending
    s.pending = ''
    s.end += data.length
    s.buffer = (s.buffer + data).slice(-this.limit)
    this.opts.emit('terminal:data', { id: s.info.id, data, end: s.end })
    this.follow(s, data)
  }

  /** The shell reported a new folder (OSC 7): a folder tab is named after it. */
  private follow(s: Session, data: string): void {
    const { cwd, carry } = scanCwd(s.osc + data)
    s.osc = carry
    if (!cwd || cwd === s.info.cwd) return
    const title = s.info.projectId ? s.info.title : folderTitle(cwd)
    s.info = { ...s.info, cwd, cwdLabel: cwdLabel(cwd), title }
    this.opts.emit('terminal:info', s.info)
  }
}
