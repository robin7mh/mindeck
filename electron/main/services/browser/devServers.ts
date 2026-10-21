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

/**
 * Spots dev servers in terminal output — Vite, Next.js, Astro, Rails, Django,
 * anything that prints a local address with a port — so the browser can offer
 * them. Only whole lines count: an address split across two output chunks is
 * read once its line is complete.
 */
export class DevServerDetector {
  private readonly tails = new Map<string, string>()
  private readonly servers = new Map<string, DevServer[]>()

  constructor(
    private readonly onChange: (servers: DevServer[]) => void,
    private readonly now: () => Date = () => new Date()
  ) {}

  feed(terminal: { id: string; projectId?: string }, chunk: string): void {
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
      changed = true
    }
    if (!changed) return
    this.servers.set(terminal.id, list.slice(0, PER_TERMINAL))
    this.onChange(this.list())
  }

  /** The terminal ended: its servers are gone with it. */
  exit(terminalId: string): void {
    this.tails.delete(terminalId)
    if (this.servers.delete(terminalId)) this.onChange(this.list())
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
