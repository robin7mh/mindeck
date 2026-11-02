import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { LANGUAGES, type LanguageStatus, type RuntimeInfo, type ToolProgress, type ToolState } from '@shared/types/languages'
import { loginShellProbe, type Probe } from '../agents/detect'
import { shellCommand, shellEnv } from '../terminal/TerminalService'
import { powershellArgs, shellArgs } from '../../lib/shellArgs'
import { executableAt, findExecutable, outputOf, searchPath, whereExe, windowsPath, withPath, type Exec, type RegQuery } from '../../lib/executables'
import { CATALOG, osOf, type InstallSpec, type LocateContext, type ToolSpec } from './catalog'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export type Part = 'server' | 'debugger'

/** Run an install command line, line by line; resolves with the exit code. */
export type Runner = (commandLine: string, cwd: string, onLine: (line: string) => void, env?: Record<string, string>) => Promise<number>

/** PowerShell before every install: stop at the first error, no progress bar (it slows downloads down a lot), TLS 1.2 for GitHub. */
export const PS_PRELUDE =
  "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12"

/** Installs run in the user's login shell on macOS / Linux, in Windows PowerShell on Windows. */
export const loginShellRunner: Runner = (commandLine, cwd, onLine, env = shellEnv()) =>
  new Promise((resolve) => {
    const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe']
    const proc =
      process.platform === 'win32'
        ? spawn('powershell.exe', powershellArgs(`${PS_PRELUDE}; ${commandLine}`), { cwd, env, stdio, windowsHide: true })
        : spawn(shellCommand().file, shellArgs(commandLine, process.platform, false), { cwd, env, stdio })
    // Each stream keeps its own unfinished line.
    const rest = { out: '', err: '' }
    const feed = (stream: 'out' | 'err') => (d: Buffer) => {
      const lines = (rest[stream] + d.toString()).split(/\r?\n/)
      rest[stream] = lines.pop()!
      lines.filter(Boolean).forEach(onLine)
    }
    proc.stdout.on('data', feed('out'))
    proc.stderr.on('data', feed('err'))
    proc.on('error', (err) => {
      onLine(err.message)
      resolve(127)
    })
    proc.on('close', (code) => {
      for (const line of [rest.out, rest.err]) if (line) onLine(line)
      resolve(code ?? 1)
    })
  })

/**
 * The PATH the user's own terminal has: on macOS / Linux the login shell's
 * (Homebrew, nvm, GOPATH and friends — an app started from the Dock has a
 * minimal one) followed by Mindeck's; on Windows the registry's, read fresh.
 */
export async function userPath(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env, probe: Probe = loginShellProbe, query?: RegQuery): Promise<string> {
  if (platform === 'win32') return windowsPath(env, query)
  const login = (await probe(`printf '%s' "$PATH"`).catch(() => '')).trim()
  return [login, env.PATH].filter(Boolean).join(':')
}

/**
 * The environment the user's own terminal has: Mindeck's (shellEnv) with
 * their PATH — for programs that start theirs (docker, php) without a shell.
 */
export async function userEnv(path: () => Promise<string> = userPath): Promise<Record<string, string>> {
  return withPath(shellEnv(), await path())
}

/** At most this many lines of a failed install go into its error. */
const TAIL = 12

/** Programs the onboarding looks for besides the agents. */
const RUNTIMES: RuntimeInfo['name'][] = ['node', 'npm', 'git']

export interface ToolsOptions {
  /** Mindeck's own tools folder (npm packages, debugpy, downloads, jdtls workspaces). */
  dir: string
  /** The PATH to search (default: userPath()). */
  path?: () => Promise<string>
  /** A program's output (`go env GOPATH`, `xcrun --find …`). */
  exec?: Exec
  /** Windows: where.exe, for names the PATH search missed. */
  where?: (names: string[], env: Record<string, string>) => Promise<Map<string, string>>
  platform?: NodeJS.Platform
  arch?: string
  home?: string
  /** Where the system keeps its programs (default /usr). */
  system?: string
  env?: Record<string, string | undefined>
  run?: Runner
  publish?: (progress: ToolProgress) => void
}

/**
 * Language servers and debuggers on this machine: what is there (looked up
 * without a shell — the user's PATH, PATHEXT on Windows, the places
 * toolchains put them), and installing what is missing the way the platform
 * does it — only when the user asks, from Settings.
 */
export class ToolsService {
  /** `id:part` → path ('' = not there). Filled by status(), cleared by installs. */
  private found = new Map<string, string>()
  private installing = new Set<string>()

  constructor(private readonly opts: ToolsOptions) {}

  get dir(): string {
    return this.opts.dir
  }

  private get platform(): NodeJS.Platform {
    return this.opts.platform ?? process.platform
  }

  private get os() {
    return osOf(this.platform)
  }

  private get installContext() {
    return { tools: this.opts.dir, arch: this.opts.arch ?? process.arch }
  }

  /** Every language with the state of its server and debugger. */
  async status(): Promise<LanguageStatus[]> {
    return this.resolve(async (ctx) => {
      const parts = LANGUAGES.flatMap((lang) => this.parts(lang.id).map(([part, spec]) => ({ key: `${lang.id}:${part}`, spec })))
      const paths = await Promise.all(parts.map(({ spec }) => this.locateWith(spec, ctx)))
      parts.forEach(({ key }, i) => this.found.set(key, paths[i] ?? ''))

      const state = (key: string, spec: ToolSpec): ToolState => {
        if (this.found.get(key)) return { name: spec.name, state: 'ready' }
        const ways = this.ways(spec)
        if (!ways.length) return { name: spec.name, state: 'manual' }
        const way = this.usable(ways, ctx)
        const shown = way ?? ways[0]
        return { name: spec.name, state: way ? 'missing' : 'toolchain', requires: shown.requires, command: shown.command(this.installContext) }
      }
      return LANGUAGES.map((lang) => {
        const entry = CATALOG[lang.id]
        return {
          id: lang.id,
          name: lang.name,
          server: state(`${lang.id}:server`, entry.server),
          debugger: entry.debugger && state(`${lang.id}:debugger`, entry.debugger)
        }
      })
    })
  }

  /** Where a language's server or debugger is; undefined when it isn't installed. */
  async locate(id: string, part: Part): Promise<string | undefined> {
    const key = `${id}:${part}`
    if (!this.found.has(key)) {
      const spec = this.spec(id, part)
      if (!spec) return undefined
      this.found.set(key, (await this.resolve((ctx) => this.locateWith(spec, ctx))) ?? '')
    }
    return this.found.get(key) || undefined
  }

  /** Node, npm and git: whether they are on the PATH, and their versions. */
  async runtimes(): Promise<RuntimeInfo[]> {
    return this.resolve((ctx) =>
      Promise.all(
        RUNTIMES.map(async (name): Promise<RuntimeInfo> => {
          const path = ctx.which(name)
          if (!path) return { name, found: false }
          const version = /(\d+\.\d+\.\d+)/.exec(await ctx.ask(name, ['--version']))?.[1]
          return { name, found: true, path, version }
        })
      )
    )
  }

  /** Install a language's server or debugger; its output streams as `tools:progress`. */
  async install(id: string, part: Part): Promise<LanguageStatus> {
    const spec = this.spec(id, part)
    const ways = spec ? this.ways(spec) : []
    if (!spec || !ways.length) throw coded('not-installable', `Nothing to install for ${id} (${part})`)
    const key = `${id}:${part}`
    if (this.installing.has(key)) throw coded('busy', `${spec.name} is being installed already`)
    this.installing.add(key)
    const tail: string[] = []
    try {
      const { way, path } = await this.resolve(async (ctx, path) => ({ way: this.usable(ways, ctx), path }))
      if (!way) throw coded('toolchain', `${spec.name} needs ${ways[0].requires} — install it first`)
      await mkdir(this.opts.dir, { recursive: true })
      const command = way.command(this.installContext)
      this.opts.publish?.({ id, part, line: `$ ${command}` })
      // Windows: the fresh PATH, so a package manager installed since Mindeck started is found.
      const runEnv = this.platform === 'win32' ? withPath(shellEnv(), path) : undefined
      const code = await (this.opts.run ?? loginShellRunner)(
        command,
        this.opts.dir,
        (line) => {
          tail.push(line)
          if (tail.length > TAIL) tail.shift()
          this.opts.publish?.({ id, part, line })
        },
        runEnv
      )
      if (code !== 0) throw coded('install-failed', tail.join('\n') || `${spec.name}: exit ${code}`)
    } finally {
      this.installing.delete(key)
      this.found.delete(key)
    }
    return (await this.status()).find((l) => l.id === id)!
  }

  private spec(id: string, part: Part): ToolSpec | undefined {
    return part === 'server' ? CATALOG[id]?.server : CATALOG[id]?.debugger
  }

  private parts(id: string): [Part, ToolSpec][] {
    const entry = CATALOG[id]
    return entry.debugger ? [['server', entry.server], ['debugger', entry.debugger]] : [['server', entry.server]]
  }

  /** The ways to install on this platform and architecture. */
  private ways(spec: ToolSpec): InstallSpec[] {
    const arch = this.installContext.arch
    return (spec.install?.[this.os] ?? []).filter((w) => !w.arch || w.arch.includes(arch))
  }

  /** The first way whose programs are all there. */
  private usable(ways: InstallSpec[], ctx: LocateContext): InstallSpec | undefined {
    return ways.find((w) => [w.requires, ...(w.uses ?? [])].every((p) => ctx.which(p)))
  }

  private async locateWith(spec: ToolSpec, ctx: LocateContext): Promise<string | undefined> {
    try {
      return await spec.locate(ctx)
    } catch {
      return undefined
    }
  }

  /**
   * Runs `evaluate` against this machine. Windows: names the PATH search
   * missed get one where.exe call, and `evaluate` a second round with its hits.
   */
  private async resolve<T>(evaluate: (ctx: LocateContext, path: string) => Promise<T>): Promise<T> {
    const platform = this.platform
    const raw = this.opts.env ?? process.env
    const path = await (this.opts.path ?? (() => userPath(platform, raw)))()
    const search = searchPath(path, platform, raw.PATHEXT)
    const env = withPath(Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string')), path)
    const exec = this.opts.exec ?? outputOf(platform)
    const missed = new Set<string>()
    const context = (extra: Map<string, string>): LocateContext => {
      const which = (name: string) => {
        const hit = findExecutable(name, search) ?? extra.get(name.toLowerCase())
        if (!hit) missed.add(name)
        return hit
      }
      const asked = new Map<string, Promise<string>>()
      return {
        tools: this.opts.dir,
        platform,
        home: this.opts.home ?? homedir(),
        system: this.opts.system ?? '/usr',
        env: raw,
        which,
        executable: (file) => executableAt(file, search),
        ask: (program, args) => {
          const key = [program, ...args].join('\0')
          if (!asked.has(key)) {
            const file = which(program)
            asked.set(key, file ? exec(file, args, env).then((out) => out.trim(), () => '') : Promise.resolve(''))
          }
          return asked.get(key)!
        }
      }
    }
    const first = await evaluate(context(new Map()), path)
    if (platform !== 'win32' || !missed.size) return first
    const hits = await (this.opts.where ?? whereExe)([...missed], env)
    return hits.size ? evaluate(context(hits), path) : first
  }
}
