import { connect } from 'node:net'
import type { DevServer } from '@shared/types/browser'

/** Colors, cursor moves and OSC sequences (titles, hyperlinks) — what a terminal draws, not what it says. */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** Terminal output without colors, cursor moves and OSC sequences. */
export const stripAnsi = (text: string) => text.replace(ANSI, '')

/** A local address with a port, the way dev servers announce themselves ("Local: http://localhost:5173/"). */
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z0-9-]+\.localhost):\d{2,5}(?:\/[^\s'"`<>)\]]*)?/gi

/** Servers kept per terminal (the newest). */
const PER_TERMINAL = 4
/** Unfinished output kept until its line ends. */
const MAX_TAIL = 400
/** Shell integration's "a command finished" mark (OSC 133;D). */
const COMMAND_END = '\x1b]133;D'

/** Where to knock for an address: `*.localhost` is this machine (Node's resolver may not know it), no port is the scheme's. */
export function probeTarget(url: string): { host: string; port: number } {
  const u = new URL(url)
  const host = u.hostname.endsWith('.localhost') ? 'localhost' : u.hostname.replace(/^\[|\]$/g, '')
  return { host, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) }
}

/** Something listens at the address: a TCP connection opens within `timeoutMs`. */
export function listening(url: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ ...probeTarget(url), timeout: timeoutMs })
    const done = (up: boolean) => {
      socket.destroy()
      resolve(up)
    }
    socket.once('connect', () => done(true))
    for (const event of ['error', 'timeout']) socket.once(event, () => done(false))
  })
}

export interface DevServerOptions {
  now?: () => Date
  /** Whether something still listens at an address (default: a TCP connection). */
  probe?: (url: string) => Promise<boolean>
  /** How often listed servers are checked. */
  intervalMs?: number
  /** After a command ended, how long its server gets to let go of its port before the check. */
  settleMs?: number
  /** A server that never answered gets this long to start before it counts as gone. */
  graceMs?: number
}

/**
 * Spots dev servers in terminal output — Vite, Next.js, Astro, Rails, Django,
 * anything that prints a local address with a port — so the browser can offer
 * them. Only whole lines count: an address split across two output chunks is
 * read once its line is complete. A server leaves the list once nothing
 * listens at its address any more (stopped with Ctrl+C, crashed, killed
 * elsewhere): checked right after a command ends and every few seconds.
 */
export class DevServerDetector {
  private readonly tails = new Map<string, string>()
  private readonly servers = new Map<string, DevServer[]>()
  /** Addresses that answered at least once — they may go as soon as they stop. */
  private readonly answered = new Set<string>()
  private readonly now: () => Date
  private readonly probe: (url: string) => Promise<boolean>
  private readonly intervalMs: number
  private readonly settleMs: number
  private readonly graceMs: number
  private timer?: NodeJS.Timeout
  private pending?: NodeJS.Timeout
  private checking?: Promise<void>

  constructor(
    private readonly onChange: (servers: DevServer[]) => void,
    opts: DevServerOptions = {}
  ) {
    this.now = opts.now ?? (() => new Date())
    this.probe = opts.probe ?? listening
    this.intervalMs = opts.intervalMs ?? 5000
    this.settleMs = opts.settleMs ?? 300
    this.graceMs = opts.graceMs ?? 20_000
  }

  feed(terminal: { id: string; projectId?: string }, chunk: string): void {
    // A command ended: a server it ran may have stopped with it.
    if (chunk.includes(COMMAND_END) && this.servers.size) {
      clearTimeout(this.pending)
      this.pending = setTimeout(() => void this.check(), this.settleMs)
    }
    const text = (this.tails.get(terminal.id) ?? '') + chunk.replace(ANSI, '')
    const end = text.lastIndexOf('\n')
    this.tails.set(terminal.id, text.slice(end + 1).slice(-MAX_TAIL))
    if (end < 0) return
    let changed = false
    const list = this.servers.get(terminal.id) ?? []
    for (const match of text.slice(0, end).matchAll(LOCAL_URL)) {
      const url = normalize(match[0])
      if (!url || list.some((s) => s.url === url)) continue
      list.unshift({ url, label: new URL(url).host, terminalId: terminal.id, projectId: terminal.projectId, detectedAt: this.now().toISOString() })
      // Announced anew (a restart): it gets its time to start, whatever the address did before.
      this.answered.delete(url)
      changed = true
    }
    if (!changed) return
    this.servers.set(terminal.id, list.slice(0, PER_TERMINAL))
    this.onChange(this.list())
    this.schedule()
  }

  /** The terminal ended: its servers are gone with it. */
  exit(terminalId: string): void {
    this.tails.delete(terminalId)
    if (this.servers.delete(terminalId)) this.onChange(this.list())
    this.schedule()
  }

  /** Knocks at every listed address; servers nothing listens for any more leave the list. One check at a time. */
  check(): Promise<void> {
    this.checking ??= this.sweep().finally(() => (this.checking = undefined))
    return this.checking
  }

  /** No more checks (the core shuts down). */
  dispose(): void {
    clearTimeout(this.pending)
    clearInterval(this.timer)
    this.timer = undefined
  }

  private async sweep(): Promise<void> {
    const urls = [...new Set([...this.servers.values()].flat().map((s) => s.url))]
    const up = new Set((await Promise.all(urls.map(async (url) => ((await this.probe(url)) ? url : '')))).filter(Boolean))
    const now = this.now().getTime()
    let changed = false
    for (const [id, list] of this.servers) {
      // Not listening: gone — unless it never answered and may still be starting.
      const kept = list.filter((s) => up.has(s.url) || (!this.answered.has(s.url) && now - Date.parse(s.detectedAt) < this.graceMs))
      if (kept.length === list.length) continue
      changed = true
      if (kept.length) this.servers.set(id, kept)
      else this.servers.delete(id)
    }
    for (const url of urls) {
      if (up.has(url)) this.answered.add(url)
      else this.answered.delete(url)
    }
    if (changed) this.onChange(this.list())
    this.schedule()
  }

  /** The periodic check runs only while there is something to check. */
  private schedule(): void {
    if (this.servers.size && !this.timer) this.timer = setInterval(() => void this.check(), this.intervalMs).unref()
    else if (!this.servers.size) this.dispose()
  }

  /** Every server seen, newest first, each address once. */
  list(): DevServer[] {
    const seen = new Set<string>()
    return [...this.servers.values()]
      .flat()
      .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))
      .filter((s) => !seen.has(s.url) && !!seen.add(s.url))
  }
}

/** The server's root address: 0.0.0.0 means this machine, trailing punctuation is the sentence's. */
function normalize(raw: string): string | null {
  try {
    const u = new URL(raw.replace(/[.,;:!?]+$/, ''))
    if (u.hostname === '0.0.0.0') u.hostname = 'localhost'
    return `${u.protocol}//${u.host}/`
  } catch {
    return null
  }
}
