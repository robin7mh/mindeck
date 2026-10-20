import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { formatWithOptions } from 'node:util'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  time: string
  level: LogLevel
  /** Who logged it: `main`, `renderer`, `renderer:agents` … */
  source: string
  message: string
}

export interface LoggerOptions {
  /** ~/Mindeck/logs */
  dir: string
  /** Rotate once the file would grow past this (default 1 MiB). */
  maxBytes?: number
  /** Older files kept next to the current one: mindeck.1.log … (default 3). */
  keep?: number
  now?: () => Date
}

const FILE = 'mindeck.log'
/** Warnings and errors kept in memory for "Copy diagnostics". */
const RECENT = 50
const MAX_MESSAGE = 8000
const R = '‹redacted›'
/** `token=…`, `"password": "…"` — unless a rule before took the value out already (or it is a Bearer's, done too). */
const KEYED = new RegExp(String.raw`((?:token|password|passwd|secret|api[_-]?key|authorization|cookie)["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic)\s|${R})[^\s"'&,;}]+`, 'gi')

/** A pairing code (`K7QM-2XPA`, no 0/O/1/I/L) after `Code:`, `"code": "…"` or a link's `#pair=` — an admin's, maybe. */
const PAIRING_CODE = /(\b(?:[Cc]ode|pair)["']?\s*[:=]\s*["']?)[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}(?![\w-])/g

/**
 * Takes secrets out of a log line: bearer and session tokens, Mindeck's own
 * device tokens and pairing codes, signed entitlements, JWTs, API keys,
 * private keys, passwords in URLs (`mongodb://user:pw@host`, a git remote)
 * and `token=` / `password: …` style values. Logs are shared in bug reports —
 * nothing in them may sign anyone in.
 */
export function redact(text: string): string {
  return text
    .replace(/-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g, `-----BEGIN $1PRIVATE KEY-----${R}`)
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, `$1 ${R}`)
    .replace(/\bmindeck1\.[\w-]+\.[\w-]+/g, `mindeck1.${R}`)
    .replace(/\bmindeck_[\w-]{20,}/g, `mindeck_${R}`)
    .replace(PAIRING_CODE, `$1${R}`)
    .replace(/\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]+/g, R)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/gi, `$1:${R}@`)
    .replace(/\b(sk-ant-|sk-|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|glpat-|npm_|xox[abpe]-|AKIA|AIza)[\w-]{8,}/g, `$1${R}`)
    .replace(KEYED, `$1${R}`)
}

/**
 * The desktop app's log: one file in ~/Mindeck/logs, rotated by size, written
 * synchronously (the last line before a crash must land) and never throwing —
 * a full disk must not take Mindeck down with its log. The latest warnings and
 * errors stay in memory for the diagnostics.
 */
export class Logger {
  readonly dir: string
  private readonly maxBytes: number
  private readonly keep: number
  private readonly now: () => Date
  private size = -1
  private readonly recentEntries: LogEntry[] = []

  constructor(opts: LoggerOptions) {
    this.dir = opts.dir
    this.maxBytes = opts.maxBytes ?? 1024 * 1024
    this.keep = opts.keep ?? 3
    this.now = opts.now ?? (() => new Date())
  }

  get file(): string {
    return join(this.dir, FILE)
  }

  info(source: string, ...args: unknown[]): void {
    this.write('info', source, args)
  }

  warn(source: string, ...args: unknown[]): void {
    this.write('warn', source, args)
  }

  error(source: string, ...args: unknown[]): void {
    this.write('error', source, args)
  }

  /** The latest warnings and errors, oldest first. */
  recent(): LogEntry[] {
    return [...this.recentEntries]
  }

  /** `echo`: print the line to stderr as well (for what no console call printed already). */
  write(level: LogLevel, source: string, args: unknown[], echo = false): void {
    const message = redact(formatWithOptions({ colors: false, depth: 4 }, ...args)).slice(0, MAX_MESSAGE)
    const entry: LogEntry = { time: this.now().toISOString(), level, source, message }
    if (level !== 'info') {
      this.recentEntries.push(entry)
      if (this.recentEntries.length > RECENT) this.recentEntries.shift()
    }
    const line = `${entry.time} ${level.toUpperCase().padEnd(5)} [${source}] ${message}\n`
    if (echo) process.stderr.write(line)
    try {
      this.rotate(Buffer.byteLength(line))
      appendFileSync(this.file, line, { encoding: 'utf8', mode: 0o600 })
      this.size += Buffer.byteLength(line)
    } catch {
      this.size = -1 // try again from what is on disk next time
    }
  }

  /** mindeck.log → mindeck.1.log → … → mindeck.<keep>.log (the oldest goes). */
  private rotate(incoming: number): void {
    if (this.size < 0) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      this.size = fileSize(this.file)
    }
    if (this.size === 0 || this.size + incoming <= this.maxBytes) return
    for (let i = this.keep - 1; i >= 1; i -= 1) moveIfThere(join(this.dir, `mindeck.${i}.log`), join(this.dir, `mindeck.${i + 1}.log`))
    moveIfThere(this.file, join(this.dir, 'mindeck.1.log'))
    this.size = 0
  }
}

function fileSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

function moveIfThere(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch {
    /* nothing to move */
  }
}

type ConsoleLike = Pick<Console, 'log' | 'info' | 'warn' | 'error'>

/**
 * Everything the main process prints also goes to the log — the services
 * already report through console (`[agents] could not save …`). Returns the
 * function that puts the console back.
 */
export function captureConsole(logger: Logger, target: ConsoleLike = console): () => void {
  const original = { log: target.log, info: target.info, warn: target.warn, error: target.error }
  const levels: Record<keyof ConsoleLike, LogLevel> = { log: 'info', info: 'info', warn: 'warn', error: 'error' }
  for (const name of Object.keys(levels) as (keyof ConsoleLike)[]) {
    target[name] = (...args: unknown[]) => {
      original[name].apply(target, args)
      logger.write(levels[name], 'main', args)
    }
  }
  return () => Object.assign(target, original)
}

/**
 * A stray exception or rejection in the main process is logged instead of
 * ending Mindeck (agents and terminals keep running). Returns the uninstaller.
 */
export function catchCrashes(logger: Logger, proc: Pick<NodeJS.Process, 'on' | 'off'> = process): () => void {
  const exception = (err: unknown) => logger.write('error', 'main', ['Uncaught exception:', err], true)
  const rejection = (reason: unknown) => logger.write('error', 'main', ['Unhandled promise rejection:', reason], true)
  proc.on('uncaughtException', exception)
  proc.on('unhandledRejection', rejection)
  return () => {
    proc.off('uncaughtException', exception)
    proc.off('unhandledRejection', rejection)
  }
}

/** What the renderer reports (see RendererError in @shared/types/desktop). */
export interface RendererReport {
  kind: string
  module?: string
  message: string
  stack?: string
  componentStack?: string
}

/**
 * Logs the renderer's error reports — at most `limit` a minute, so a module
 * that fails on every frame cannot flood the disk.
 */
export function rendererErrors(logger: Logger, opts: { limit?: number; now?: () => number } = {}): (report: RendererReport) => void {
  const limit = opts.limit ?? 30
  const now = opts.now ?? Date.now
  let windowStart = 0
  let count = 0
  let dropped = 0
  return (report) => {
    const t = now()
    if (t - windowStart >= 60_000) {
      if (dropped) logger.warn('renderer', `${dropped} more error report(s) were dropped`)
      windowStart = t
      count = 0
      dropped = 0
    }
    if (++count > limit) {
      dropped += 1
      return
    }
    const source = report.module ? `renderer:${report.module}` : 'renderer'
    const detail = [report.stack, report.componentStack && `Component stack:${report.componentStack}`].filter(Boolean).join('\n')
    logger.error(source, `${report.kind}: ${report.message}${detail ? `\n${detail}` : ''}`)
  }
}
