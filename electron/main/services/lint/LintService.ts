import { realpath } from 'node:fs/promises'
import { sep } from 'node:path'
import { createInterface } from 'node:readline'
import { isTypeScriptFile } from '@shared/types/languages'
import type { LintDiagnostic, LintResult } from '@shared/types/lint'
import { confine } from '../../lib/confine'
import { spawnNode, type NodeLauncher, type NodeProcess } from '../../lib/nodeProcess'
import { shellEnv } from '../terminal/TerminalService'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Runs inside the project (its own node_modules): ESLint lints and fixes,
 * Prettier formats — the project's versions, configs and plugins, as the
 * VS Code extensions use them. One JSON request per line in, one answer out.
 * In a project that isn't trusted (MINDECK_TRUSTED unset) nothing of the
 * project's is loaded — its modules and configs are code: no ESLint, and
 * Prettier only Mindeck's own with the editor's options, when asked for.
 */
export const WORKER = String.raw`
const path = require('path'), fs = require('fs'), readline = require('readline')
const { createRequire } = require('module')
const ROOT = process.env.MINDECK_ROOT
const TRUSTED = process.env.MINDECK_TRUSTED === '1'
const local = createRequire(path.join(ROOT, 'mindeck.js'))
const tryRequire = (m) => { if (!TRUSTED) return null; try { return local(m) } catch { return null } }
const CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts',
  '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yaml', '.eslintrc.yml']
const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) } catch { return {} } })()
const eslintModule = (CONFIGS.some((f) => fs.existsSync(path.join(ROOT, f))) || pkg.eslintConfig) ? tryRequire('eslint') : null
const linters = {}
async function linter(fix) {
  if (!eslintModule) return null
  if (!linters[fix]) {
    const ESLint = eslintModule.loadESLint ? await eslintModule.loadESLint({ cwd: ROOT }) : eslintModule.ESLint
    linters[fix] = new ESLint({ cwd: ROOT, fix })
  }
  return linters[fix]
}
async function lintText(fix, file, text) {
  const eslint = await linter(fix)
  if (!eslint || (await eslint.isPathIgnored(file))) return null
  const [result] = await eslint.lintText(text, { filePath: file, warnIgnored: false })
  return result || null
}
const projectPrettier = tryRequire('prettier')
const ops = {
  async lint({ file, text }) {
    const result = await lintText(false, file, text)
    return result && result.messages.map((m) => ({ line: m.line || 1, column: m.column || 1, endLine: m.endLine, endColumn: m.endColumn,
      message: m.message, rule: m.ruleId, severity: m.severity, fix: m.fix && { start: m.fix.range[0], end: m.fix.range[1], text: m.fix.text } }))
  },
  async fix({ file, text }) {
    const result = await lintText(true, file, text)
    return result && result.output !== undefined ? result.output : null
  },
  async format({ file, text, force, options }) {
    const prettier = projectPrettier || (force ? require(process.env.MINDECK_PRETTIER) : null)
    if (!prettier) return null
    const info = await prettier.getFileInfo(file, { ignorePath: path.join(ROOT, '.prettierignore') })
    if (info.ignored || !info.inferredParser) return null
    const config = TRUSTED ? await prettier.resolveConfig(file, { editorconfig: true }) : null
    return prettier.format(text, { ...(config || options || {}), filepath: file })
  }
}
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const { id, op, ...args } = JSON.parse(line)
  try {
    process.stdout.write(JSON.stringify({ id, ok: true, result: await ops[op](args) }) + '\n')
  } catch (err) {
    process.stdout.write(JSON.stringify({ id, ok: false, error: String((err && err.message) || err) }) + '\n')
  }
})
`

interface RawMessage {
  line: number
  column: number
  endLine?: number
  endColumn?: number
  message: string
  rule: string | null
  severity: 1 | 2
  fix?: { start: number; end: number; text: string }
}

export interface LintOptions {
  resolveRoot: (projectId: string) => string | undefined
  /** Mindeck's own Prettier (used where a project has none, when asked to). */
  prettier: string
  /** Whether the project is trusted (WorkspaceTrust); restricted when not, or without this. */
  trusted?: (projectId: string) => boolean
  /** How the worker runs as a Node program (Platform.node). */
  node?: NodeLauncher
  /** Start the worker in a project (default: WORKER with `node`). */
  spawn?: (root: string, trusted: boolean) => NodeProcess
  /** A worker nobody asked for this long stops. */
  idleMs?: number
  timeoutMs?: number
}

/** The worker of one project: requests by id, stops when idle. */
class Worker {
  private proc?: NodeProcess
  private seq = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private idle?: ReturnType<typeof setTimeout>

  constructor(
    private readonly root: string,
    /** Started for a trusted project (loads the project's ESLint / Prettier). */
    readonly trusted: boolean,
    private readonly opts: LintOptions & Required<Pick<LintOptions, 'idleMs' | 'timeoutMs' | 'spawn'>>
  ) {}

  request<T>(op: string, args: Record<string, unknown>): Promise<T> {
    const proc = (this.proc ??= this.start())
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.stop(), this.opts.idleMs)
    this.idle.unref?.()
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(coded('lint-timeout', `${op} took too long`))
      }, this.opts.timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      proc.stdin!.write(`${JSON.stringify({ id, op, ...args })}\n`)
    })
  }

  stop(): void {
    clearTimeout(this.idle)
    this.proc?.kill()
    this.proc = undefined
  }

  private start(): NodeProcess {
    const proc = this.opts.spawn(this.root, this.trusted)
    createInterface({ input: proc.stdout! }).on('line', (line) => {
      let msg: { id: number; ok: boolean; result?: unknown; error?: string }
      try {
        msg = JSON.parse(line)
      } catch {
        return // a plugin printing to stdout
      }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(coded('lint', msg.error!))
    })
    proc.stderr?.resume()
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = undefined
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(coded('lint', 'The ESLint / Prettier worker stopped'))
        this.pending.delete(id)
      }
    })
    return proc
  }
}

const SEVERITY = { 1: 'warning', 2: 'error' } as const

/**
 * ESLint and Prettier like the VS Code extensions: the project's own
 * versions with its config and plugins, in a worker process per project
 * (started on first use, stopped when idle). ESLint's problems carry their
 * quick fixes; Prettier formats what it knows (and only in projects that use
 * it, unless the user wants Prettier everywhere).
 */
export class LintService {
  private workers = new Map<string, Worker>()
  private readonly opts: LintOptions & Required<Pick<LintOptions, 'idleMs' | 'timeoutMs' | 'spawn'>>

  constructor(opts: LintOptions) {
    this.opts = {
      idleMs: 10 * 60_000,
      timeoutMs: 60_000,
      // The project's ESLint / Prettier plugins may bring native addons (unrs-resolver, @swc/core …).
      spawn: (root, trusted) =>
        (opts.node ?? spawnNode)(['-e', WORKER], {
          cwd: root,
          env: { ...shellEnv(), MINDECK_ROOT: root, MINDECK_PRETTIER: opts.prettier, ...(trusted ? { MINDECK_TRUSTED: '1' } : {}) },
          name: 'ESLint / Prettier',
          unsignedLibraries: true
        }),
      ...opts
    }
  }

  /** ESLint's problems in a JS / TS file (not available: no ESLint in the project, or the file is ignored). */
  async lint(projectId: string, path: string, text: string): Promise<LintResult> {
    if (!isTypeScriptFile(path)) return { available: false, diagnostics: [] }
    const { root, file } = await this.file(projectId, path)
    const messages = await this.worker(root, projectId).request<RawMessage[] | null>('lint', { file, text })
    if (!messages) return { available: false, diagnostics: [] }
    return {
      available: true,
      diagnostics: messages.map(
        (m): LintDiagnostic => ({
          range: { start: { line: m.line, offset: m.column }, end: { line: m.endLine ?? m.line, offset: m.endColumn ?? m.column + 1 } },
          message: m.message,
          severity: SEVERITY[m.severity],
          code: m.rule ?? undefined,
          source: 'eslint',
          ...(m.fix ? { fix: m.fix } : {})
        })
      )
    }
  }

  /** The text with every ESLint fix applied (null: ESLint doesn't lint it). */
  async fix(projectId: string, path: string, text: string): Promise<string | null> {
    if (!isTypeScriptFile(path)) return null
    const { root, file } = await this.file(projectId, path)
    return this.worker(root, projectId).request<string | null>('fix', { file, text })
  }

  /** Prettier's version of the text (null: Prettier isn't responsible — the editor's own formatter is). */
  async format(projectId: string, path: string, text: string, opts: { prettier?: boolean; options?: Record<string, unknown> } = {}): Promise<string | null> {
    const { root, file } = await this.file(projectId, path)
    return this.worker(root, projectId).request<string | null>('format', { file, text, force: !!opts.prettier, options: opts.options })
  }

  /** Start over (after changing the ESLint / Prettier config or installing plugins). */
  restart(): void {
    this.dispose()
  }

  dispose(): void {
    for (const w of this.workers.values()) w.stop()
    this.workers.clear()
  }

  private async file(projectId: string, path: string): Promise<{ root: string; file: string }> {
    const configured = this.opts.resolveRoot(projectId)
    if (!configured) throw coded('not-found', `Unknown project: ${projectId}`)
    const root = await realpath(configured)
    return { root, file: await confine(root, path) }
  }

  /** The project's worker — a new one when its trust changed since it started. */
  private worker(root: string, projectId: string): Worker {
    const trusted = this.opts.trusted?.(projectId) ?? false
    let w = this.workers.get(root)
    if (w && w.trusted !== trusted) w.stop()
    if (!w || w.trusted !== trusted) {
      w = new Worker(root, trusted, this.opts)
      this.workers.set(root, w)
    }
    return w
  }
}

/** Mindeck's own Prettier, outside the app archive (the worker is a Node program of its own). */
export function bundledPrettier(resolve: (id: string) => string = require.resolve): string {
  return resolve('prettier').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
}
