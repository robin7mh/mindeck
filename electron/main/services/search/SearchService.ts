import { spawn } from 'node:child_process'
import { constants, type Dirent } from 'node:fs'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { createContext, Script } from 'node:vm'
import ignore, { type Ignore } from 'ignore'
import {
  expandGlobs,
  matchLine,
  previewOf,
  searchRegExp,
  textLines,
  type FileMatches,
  type SearchEngine,
  type SearchProgress,
  type TextMatch,
  type TextSearchQuery
} from '@shared/types/search'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Caps that keep a huge project from flooding the UI (and the core). */
export const SEARCH_LIMITS = {
  /** Matches per search. */
  matches: 20_000,
  /** Matching lines per file. */
  perFile: 1000,
  /** Built-in engine: bigger files are skipped (minified bundles, data dumps). */
  fileSize: 5 * 1024 * 1024,
  /** Built-in engine: files looked at per search. */
  files: 200_000,
  /** Results go out in batches, at most this often. */
  batchMs: 80,
  /** Built-in engine: one file's matching may take this long — a runaway regex fails instead of freezing the core. */
  regexMs: 2000
}
export type SearchLimits = typeof SEARCH_LIMITS

/** A NUL byte in the first chunk marks a binary file (git's and ripgrep's heuristic). */
const SNIFF_BYTES = 8000

export interface SearchDeps {
  resolveRoot: (projectId: string) => string | undefined
  publish: (progress: SearchProgress) => void
  /** The ripgrep binary; null: always the built-in engine. Default: `rg` where the user has it. */
  ripgrep?: string | null
  limits?: Partial<SearchLimits>
}

/** Folders `rg` usually lives in — a GUI app on macOS doesn't get the shell's PATH. */
const RG_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']

/** The user's ripgrep, if any: on PATH, else in the usual places. Mindeck never downloads one. */
export async function findRipgrep(path = process.env.PATH ?? '', platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const name = platform === 'win32' ? 'rg.exe' : 'rg'
  const dirs = [...path.split(delimiter).filter(Boolean), ...(platform === 'win32' ? [] : RG_DIRS)]
  for (const dir of dirs) {
    const file = join(dir, name)
    if (await access(file, constants.X_OK).then(() => true, () => false)) return file
  }
  return null
}

/** A paired device searching: its results go to it alone, without the files its deny list names. */
export interface RemoteSearcher {
  device?: string
  hidden: (path: string) => boolean
}

/** One search's results on their way out: batched, capped, and silent once cancelled. */
class Collector {
  cancelled = false
  /** A limit cut the search short — the engine stops, the client hears "there is more". */
  capped = false
  /** Stops the engine (ripgrep's process). */
  onCancel?: () => void
  private total = 0
  private pending: FileMatches[] = []
  private timer?: ReturnType<typeof setTimeout>

  constructor(
    private readonly id: string,
    private readonly publish: (p: SearchProgress) => void,
    private readonly limits: SearchLimits,
    private readonly skip: Set<string>,
    private readonly remote?: RemoteSearcher
  ) {}

  /** A file's matches; false once no more are wanted (cancelled, or the limit is reached). */
  add(path: string, matches: TextMatch[]): boolean {
    if (this.cancelled || this.capped) return false
    if (!matches.length || this.skip.has(path) || this.remote?.hidden(path)) return true
    const kept = matches.slice(0, this.limits.matches - this.total)
    this.pending.push({ path, matches: kept })
    this.total += kept.length
    this.capped = this.total >= this.limits.matches
    this.timer ??= setTimeout(() => this.flush(), this.limits.batchMs)
    return !this.capped
  }

  /** The last batch: done (truncated when the limit cut it short), or failed. */
  finish(error?: string): void {
    this.flush(true, error)
    this.cancelled = true
  }

  cancel(): void {
    clearTimeout(this.timer)
    this.cancelled = true
    this.onCancel?.()
  }

  private flush(done = false, error?: string): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.cancelled) return
    const files = this.pending
    this.pending = []
    const device = this.remote?.device
    this.publish({ id: this.id, files, done, ...(done && this.capped ? { truncated: true } : {}), ...(error ? { error } : {}), ...(device ? { device } : {}) })
  }
}

/**
 * A path as ripgrep prints it, as the client knows it: relative, `/`-separated.
 * On Windows ripgrep prints `.\src\a.ts` — results would never match the open
 * buffers they must skip, and opened files would get a second tab.
 */
export function rgPath(printed: string, windows = process.platform === 'win32'): string {
  return (windows ? printed.replace(/\\/g, '/') : printed).replace(/^\.\//, '')
}

/** A ripgrep line's text without its line break. */
const stripEol = (text: string) => text.replace(/\r?\n$/, '')

interface RgMatch {
  type: string
  data: {
    path?: { text?: string }
    lines?: { text?: string }
    line_number?: number
    submatches?: { start: number; end: number }[]
  }
}

/** Ripgrep's byte offsets in a line as JavaScript string offsets. */
function rgMatches(msg: RgMatch['data']): TextMatch[] {
  const line = stripEol(msg.lines!.text!)
  const bytes = Buffer.from(line)
  const ascii = bytes.length === line.length
  const offset = (b: number) => (ascii ? b : bytes.subarray(0, b).toString().length)
  return msg.submatches!.map((s) => {
    const column = offset(s.start)
    const length = offset(s.end) - column
    return { line: msg.line_number!, column, length, ...previewOf(line, column, length) }
  })
}

/** The ripgrep command line for a query — gitignore respected in and outside git repositories, hidden files searched, `.git` never. */
export function ripgrepArgs(q: TextSearchQuery, limits: SearchLimits): string[] {
  const args = ['--json', '--no-config', '--hidden', '--no-require-git', '--glob', '!.git', '--max-count', String(limits.perFile)]
  args.push(q.caseSensitive ? '--case-sensitive' : '--ignore-case')
  // Look-around and back references: PCRE2 when the pattern needs it (and ripgrep has it).
  args.push(...(q.regex ? ['--engine', 'auto'] : ['--fixed-strings']))
  if (q.wholeWord) args.push('--word-regexp')
  for (const g of expandGlobs(q.include)) args.push('--glob', g)
  for (const g of expandGlobs(q.exclude)) args.push('--glob', `!${g}`)
  args.push('-e', q.pattern, '--', '.')
  return args
}

/**
 * Search with ripgrep, streaming its JSON. Resolves false when ripgrep could
 * not do it (not runnable, or a pattern only JavaScript understands) and found
 * nothing — the built-in engine takes over then.
 */
function runRipgrep(rg: string, root: string, q: TextSearchQuery, out: Collector, limits: SearchLimits): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(rg, ripgrepArgs(q, limits), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    out.onCancel = () => child.kill()
    let found = false
    let file: { path: string; matches: TextMatch[] } | undefined
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => void (stderr += d.toString()))
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg: RgMatch
      try {
        msg = JSON.parse(line) as RgMatch
      } catch {
        return
      }
      if (msg.type === 'begin') {
        // Paths that aren't UTF-8 come as bytes: those files are left out.
        const path = msg.data.path?.text
        file = path === undefined ? undefined : { path: rgPath(path), matches: [] }
      } else if (msg.type === 'match' && file && msg.data.lines?.text !== undefined) {
        file.matches.push(...rgMatches(msg.data))
      } else if (msg.type === 'end' && file) {
        found ||= file.matches.length > 0
        if (!out.add(file.path, file.matches)) child.kill()
        file = undefined
      }
    })
    child.on('error', () => resolve(false))
    child.on('close', (code) => {
      // 0: matches, 1: none, 2: an error — fine when it only hit some unreadable files.
      if (code === 2 && !found && stderr.trim()) return resolve(false)
      resolve(true)
    })
  })
}

/** Gitignore rules of one folder, matched against paths relative to it. */
interface Rules {
  base: string
  ig: Ignore
}

const below = (base: string, rel: string) => (base ? rel.slice(base.length + 1) : rel)

/** Ignored by the .gitignore files on the way down? The deepest rule that has a say wins (like git). */
function gitignored(rules: Rules[], rel: string, dir: boolean): boolean {
  let ignored = false
  for (const r of rules) {
    const t = r.ig.test(below(r.base, rel) + (dir ? '/' : ''))
    if (t.ignored) ignored = true
    else if (t.unignored) ignored = false
  }
  return ignored
}

/** One function call with a time limit (the vm module can interrupt a runaway regex; plain code can't). */
const guard = new Script('job()')
function guarded<T>(job: () => T, ms: number): T {
  return guard.runInContext(createContext({ job }), { timeout: ms }) as T
}

/**
 * The built-in engine, for machines without ripgrep: walks the project the way
 * ripgrep does (.gitignore files at every level, hidden files, no symlinks,
 * never `.git`), skips binary and huge files, and matches with JavaScript.
 */
async function runBuiltin(root: string, q: TextSearchQuery, out: Collector, limits: SearchLimits): Promise<void> {
  const re = searchRegExp(q)
  const include = q.include?.length ? ignore().add(expandGlobs(q.include)) : null
  const exclude = ignore().add(expandGlobs(q.exclude))
  let seen = 0

  const searchFile = async (abs: string, rel: string) => {
    const info = await stat(abs)
    if (info.size > limits.fileSize) return true
    const buf = await readFile(abs)
    if (buf.subarray(0, SNIFF_BYTES).includes(0)) return true
    const text = buf.toString('utf8')
    let matches: TextMatch[]
    try {
      matches = guarded(() => {
        const found: TextMatch[] = []
        const lines = textLines(text)
        // Like ripgrep's, the per-file cap counts lines, not matches.
        for (let i = 0, hit = 0; i < lines.length && hit < limits.perFile; i += 1) {
          const m = matchLine(re, lines[i], i + 1)
          if (m.length) hit += 1
          found.push(...m)
        }
        return found
      }, limits.regexMs)
    } catch {
      throw coded('search-timeout', `The search pattern takes too long on ${rel}`)
    }
    return out.add(rel, matches)
  }

  const walk = async (dir: string, rel: string, rules: Rules[]): Promise<boolean> => {
    const here = await readFile(join(dir, '.gitignore'), 'utf8').then(
      (text) => [...rules, { base: rel, ig: ignore().add(text) }],
      () => rules
    )
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return true // unreadable folder: skipped, like ripgrep does
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (out.cancelled || e.name === '.git' || e.isSymbolicLink()) continue
      const path = rel ? `${rel}/${e.name}` : e.name
      const isDir = e.isDirectory()
      if (gitignored(here, path, isDir) || exclude.ignores(isDir ? `${path}/` : path)) continue
      if (isDir) {
        if (!(await walk(join(dir, e.name), path, here))) return false
      } else if (e.isFile() && (!include || include.ignores(path))) {
        if ((seen += 1) > limits.files) {
          out.capped = true
          return false
        }
        if (!(await searchFile(join(dir, e.name), path).catch(rethrowTimeout))) return false
      }
    }
    return true
  }
  await walk(root, '', [])
}

/** Searches by caller: the desktop's ids, and each device's apart (no device stops another's search). */
const runKey = (id: string, device?: string) => (device === undefined ? `desktop:${id}` : `device:${device}:${id}`)

/** A file that vanished or can't be read is skipped; a runaway pattern ends the search. */
function rethrowTimeout(err: unknown): true {
  if ((err as { code?: string }).code === 'search-timeout') throw err
  return true
}

/**
 * Project-wide text search (the editor's ⇧⌘F): ripgrep when the user has it,
 * else a built-in engine in Node. Results stream to the client as
 * `search:progress` events, grouped by file; the client replaces matches
 * itself (open buffers stay undoable). One search per client id at a time —
 * per caller: a paired device's ids are its own (`remote`), and so are its
 * results.
 */
export class SearchService {
  private readonly runs = new Map<string, Collector>()
  private readonly limits: SearchLimits
  private rg?: Promise<string | null>

  constructor(private readonly deps: SearchDeps) {
    this.limits = { ...SEARCH_LIMITS, ...deps.limits }
  }

  async start(id: string, projectId: string, query: TextSearchQuery, remote?: RemoteSearcher): Promise<{ engine: SearchEngine }> {
    const root = this.deps.resolveRoot(projectId)
    if (!root) throw coded('not-found', 'Project not found')
    try {
      searchRegExp(query)
    } catch (err) {
      throw coded('bad-input', (err as Error).message)
    }
    const key = runKey(id, remote && (remote.device ?? ''))
    this.stop(key)
    const out = new Collector(id, this.deps.publish, this.limits, new Set(query.skip), remote)
    this.runs.set(key, out)
    const rg = await (this.rg ??= this.deps.ripgrep === undefined ? findRipgrep() : Promise.resolve(this.deps.ripgrep))
    void this.run(rg, root, query, out).finally(() => {
      if (this.runs.get(key) === out) this.runs.delete(key)
    })
    return { engine: rg ? 'ripgrep' : 'builtin' }
  }

  /** Stops a search — the desktop's, or (`device`) one a paired device started. */
  cancel(id: string, device?: string): void {
    this.stop(runKey(id, device))
  }

  dispose(): void {
    for (const key of [...this.runs.keys()]) this.stop(key)
  }

  private stop(key: string): void {
    this.runs.get(key)?.cancel()
    this.runs.delete(key)
  }

  private async run(rg: string | null, root: string, query: TextSearchQuery, out: Collector): Promise<void> {
    try {
      if (rg && (await runRipgrep(rg, root, query, out, this.limits))) return out.finish()
      await runBuiltin(root, query, out, this.limits)
      out.finish()
    } catch (err) {
      out.finish((err as Error).message)
    }
  }
}
