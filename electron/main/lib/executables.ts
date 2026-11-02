import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, posix, win32 } from 'node:path'

/** Where programs are looked up: the folders of a PATH, and (Windows) the endings a bare name may have. */
export interface SearchPath {
  platform: NodeJS.Platform
  dirs: string[]
  /** Windows' PATHEXT, lower case (.com, .exe, .bat, .cmd, …); empty elsewhere. */
  pathext: string[]
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/** A PATH string (`:`-separated, on Windows `;` with PATHEXT) as folders to search, duplicates and blanks dropped. */
export function searchPath(path: string, platform: NodeJS.Platform = process.platform, pathext: string | undefined = process.env.PATHEXT): SearchPath {
  const win = platform === 'win32'
  const dirs = path
    .split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
  return {
    platform,
    dirs: [...new Set(dirs)],
    pathext: win ? (pathext || DEFAULT_PATHEXT).split(';').filter(Boolean).map((e) => e.toLowerCase()) : []
  }
}

function stat(path: string) {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

/**
 * The program at `file`, if there is one: an executable file on macOS / Linux;
 * on Windows the file with one of PATHEXT's endings (`npm` → `npm.cmd`), or
 * as given when it already ends in one.
 */
export function executableAt(file: string, search: Pick<SearchPath, 'platform' | 'pathext'>): string | undefined {
  if (search.platform !== 'win32') {
    const s = stat(file)
    return s?.isFile() && s.mode & 0o111 ? file : undefined
  }
  const candidates = search.pathext.includes(extname(file).toLowerCase()) ? [file] : search.pathext.map((ext) => file + ext)
  return candidates.find((c) => stat(c)?.isFile())
}

/** Where a program is — `command -v` without a shell (a path is checked as it is). */
export function findExecutable(name: string, search: SearchPath): string | undefined {
  if (isAbsolute(name) || name.includes('/') || (search.platform === 'win32' && name.includes('\\'))) return executableAt(name, search)
  for (const dir of search.dirs) {
    const hit = executableAt(join(dir, name), search)
    if (hit) return hit
  }
  return undefined
}

/** An environment variable whatever its case on Windows (`Path`, `PATHEXT`); exactly as named elsewhere. */
function envValue(env: Record<string, string | undefined>, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name]
  return Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1]
}

/** A folder that says where it is: `C:\…` or `\\server\share` on Windows, `/…` elsewhere. */
const anchored = (dir: string, platform: NodeJS.Platform) => (platform === 'win32' ? /^([a-z]:[\\/]|[\\/]{2})/i.test(dir) : posix.isAbsolute(dir))

/**
 * Where a program Mindeck starts by name may come from: the PATH's absolute
 * folders, nothing else. Never the working folder — Windows looks there
 * first for a bare name (libuv, cmd.exe), so a `git.exe` checked into a
 * project would run in its place — and no empty or relative PATH entry,
 * which means a folder relative to it.
 */
export function programSearch(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): SearchPath {
  const search = searchPath(envValue(env, 'PATH', platform) ?? '', platform, envValue(env, 'PATHEXT', platform))
  return { ...search, dirs: search.dirs.filter((dir) => anchored(dir, platform)) }
}

/**
 * The absolute path to start a program by: a path stays as given, a bare
 * name is looked up with programSearch. A name that isn't on the PATH gets a
 * path in a folder that never exists — the start fails with ENOENT, as for
 * any missing program, instead of finding something next to the project.
 */
export function programPath(name: string, env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
  const path = platform === 'win32' ? win32 : posix
  if (path.isAbsolute(name) || name.includes('/') || (platform === 'win32' && name.includes('\\'))) return name
  return findExecutable(name, programSearch(env, platform)) ?? path.join(dirname(process.execPath), 'not-on-PATH', name)
}

/** Runs a program, resolving with its stdout (also when it exits non-zero: `where.exe` does when one name is missing). */
export type Exec = (file: string, args: string[], env: Record<string, string>) => Promise<string>

const execStdout: Exec = (file, args, env) =>
  new Promise((resolve) => execFile(file, args, { env, timeout: 10_000, windowsHide: true }, (_err, stdout) => resolve(stdout)))

/**
 * Windows' own lookup (`where.exe`), for names the PATH search missed —
 * one call for all of them. Lower-case name (without ending) → first hit.
 */
export async function whereExe(names: string[], env: Record<string, string>, exec: Exec = execStdout): Promise<Map<string, string>> {
  const hits = new Map<string, string>()
  if (!names.length) return hits
  const out = await exec('where.exe', names, env).catch(() => '')
  for (const line of out.split(/\r?\n/).map((l) => l.trim())) {
    if (!line) continue
    const file = basename(line.replace(/\\/g, '/'))
    const name = file.slice(0, file.length - extname(file).length).toLowerCase()
    if (!hits.has(name)) hits.set(name, line)
  }
  return hits
}

/** Reads one registry value (Windows' `reg.exe`); '' when it isn't there. */
export type RegQuery = (key: string, value: string) => Promise<string>

/** The value in `reg query`'s answer ('' when there is none). */
export function regValue(out: string): string {
  return /REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(out)?.[1].trim() ?? ''
}

const regQuery: RegQuery = async (key, value) => regValue(await execStdout('reg.exe', ['query', key, '/v', value], process.env as Record<string, string>))

/** `%VAR%` references expanded from `env` (names case-insensitive, as on Windows); unknown ones stay. */
export function expandWindowsVars(text: string, env: Record<string, string | undefined>): string {
  const byName = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]))
  return text.replace(/%([^%]+)%/g, (all, name: string) => byName.get(name.toLowerCase()) ?? all)
}

/**
 * Windows: the PATH a new terminal would get — the machine's and the user's
 * entries read fresh from the registry (so a tool installed while Mindeck
 * runs counts), then Mindeck's own.
 */
export async function windowsPath(env: Record<string, string | undefined>, query: RegQuery = regQuery): Promise<string> {
  const [machine, user] = await Promise.all([
    query('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path').catch(() => ''),
    query('HKCU\\Environment', 'Path').catch(() => '')
  ])
  const own = Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1] ?? ''
  return [machine, user, own]
    .filter(Boolean)
    .map((p) => expandWindowsVars(p, env))
    .join(';')
}

/** `env` with its PATH replaced — whatever case the key had (Windows writes it `Path`). */
export function withPath(env: Record<string, string>, path: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() !== 'path') out[k] = v
  out[env.Path !== undefined && env.PATH === undefined ? 'Path' : 'PATH'] = path
  return out
}

// cmd.exe quoting, as cross-spawn does it: arguments in double quotes with
// backslashes before quotes doubled, then every cmd metacharacter escaped.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/** One argument for a command line that cmd.exe runs (`double` for npm's shims, which pass `%*` on once more). */
export function cmdArg(arg: string, double = false): string {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
  quoted = `"${quoted}"`.replace(CMD_META, '^$1')
  return double ? quoted.replace(CMD_META, '^$1') : quoted
}

/** PowerShell single-quoting: the word arrives exactly as given. */
export function psQuote(word: string): string {
  return `'${word.replace(/'/g, "''")}'`
}

/**
 * Start a program without a shell. Windows can't start batch files (npm's
 * `.cmd` shims, `.bat` launchers) directly: those run through cmd.exe,
 * quoted so every argument arrives unchanged.
 */
export function spawnProgram(file: string, args: string[], options: SpawnOptions, platform: NodeJS.Platform = process.platform, run: typeof spawn = spawn): ChildProcess {
  if (platform === 'win32') {
    // A bare name from the PATH only — never a program of that name in the (project) working folder.
    const env = options.env ?? process.env
    file = programPath(file, env, platform)
    if (/\.(cmd|bat)$/i.test(file)) {
      const shim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file)
      const line = [file.replace(CMD_META, '^$1'), ...args.map((a) => cmdArg(a, shim))].join(' ')
      return run(process.env.ComSpec || programPath('cmd.exe', env, platform), ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true, windowsHide: true })
    }
  }
  return run(file, args, { ...options, windowsHide: true })
}

/**
 * A program's output when it succeeds ('' when it fails, can't start or takes
 * longer than 10 s) — batch files included (see spawnProgram).
 */
export function outputOf(platform: NodeJS.Platform = process.platform, run: typeof spawn = spawn): Exec {
  return (file, args, env) =>
    new Promise((resolve) => {
      let out = ''
      const proc = spawnProgram(file, args, { env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }, platform, run)
      proc.stdout!.on('data', (d: Buffer) => (out += d.toString()))
      proc.on('error', () => resolve(''))
      proc.on('close', (code) => resolve(code === 0 ? out : ''))
    })
}
