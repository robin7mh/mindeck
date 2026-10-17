import { spawnNode, type NodeLauncher, type NodeProcess } from '../../lib/nodeProcess'
import { shellEnv } from '../terminal/TerminalService'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** A diagnostic as tsserver reports it in its `*Diag` events. */
export interface TsDiagnostic {
  start: { line: number; offset: number }
  end: { line: number; offset: number }
  text: string
  code?: number
  category: string
  reportsUnnecessary?: boolean
  reportsDeprecated?: boolean
}

interface Pending {
  resolve: (body: unknown) => void
  reject: (err: Error) => void
}

interface DiagRun {
  found: Map<string, TsDiagnostic[]>
  done: () => void
}

/** The process a TsServer talks to — stdio pipes, killable (a fake in tests). */
export type TsProcess = Pick<NodeProcess, 'stdin' | 'stdout' | 'kill' | 'on'>

/** Longest wait for an answer before a request fails (a hung server never blocks the editor). */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * One tsserver — the language service VS Code runs — spoken to over stdio:
 * requests are JSON lines in, answers and events come back framed with
 * `Content-Length` headers. Diagnostics arrive as events after `geterr`.
 */
export class TsServer {
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private readonly diagRuns = new Map<number, DiagRun>()
  private buffer = Buffer.alloc(0)
  private alive = true

  constructor(
    private readonly proc: TsProcess,
    private readonly onExit: () => void = () => {},
    private readonly timeoutMs = REQUEST_TIMEOUT_MS
  ) {
    proc.stdout!.on('data', (chunk: Buffer) => this.read(chunk))
    proc.on('exit', () => this.exited())
    proc.on('error', () => this.exited())
  }

  /** Start `tsserver.js` as a Node program of this app's (the desktop's: a utility process). */
  static start(tsserver: string, cwd: string, onExit?: () => void, node: NodeLauncher = spawnNode): TsServer {
    // A trusted project's tsserver loads its tsconfig plugins — the project's code, native addons included.
    const proc = node([tsserver, '--disableAutomaticTypingAcquisition'], { cwd, env: shellEnv(), name: 'TypeScript', unsignedLibraries: true })
    proc.stderr!.resume()
    return new TsServer(proc, onExit)
  }

  get running(): boolean {
    return this.alive
  }

  /** A command with an answer; rejects with tsserver's message when it fails. */
  request<T = unknown>(command: string, args: unknown): Promise<T> {
    if (!this.alive) return Promise.reject(coded('lsp-stopped', 'The TypeScript server stopped'))
    const seq = ++this.seq
    const answer = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(coded('lsp-timeout', `TypeScript did not answer ${command}`))
      }, this.timeoutMs)
      this.pending.set(seq, {
        resolve: (body) => {
          clearTimeout(timer)
          resolve(body as T)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        }
      })
    })
    // Registered first: an answer may come back before write() returns.
    this.write(seq, command, args)
    return answer
  }

  /** A command without an answer (tsserver sends none for these). */
  notify(command: string, args: unknown): void {
    if (this.alive) this.write(++this.seq, command, args)
  }

  /** Errors, warnings and suggestions of these files (absolute paths), project-wide checked. */
  diagnostics(files: string[]): Promise<Map<string, TsDiagnostic[]>> {
    if (!this.alive || !files.length) return Promise.resolve(new Map())
    const seq = ++this.seq
    const done = new Promise<Map<string, TsDiagnostic[]>>((resolve) => {
      const found = new Map<string, TsDiagnostic[]>()
      const timer = setTimeout(() => finish(), this.timeoutMs)
      const finish = () => {
        clearTimeout(timer)
        this.diagRuns.delete(seq)
        resolve(found)
      }
      this.diagRuns.set(seq, { found, done: finish })
    })
    this.write(seq, 'geterr', { files, delay: 0 })
    return done
  }

  dispose(): void {
    if (!this.alive) return
    this.proc.kill()
    this.exited()
  }

  // --- protocol ---

  private write(seq: number, command: string, args: unknown): void {
    this.proc.stdin!.write(`${JSON.stringify({ seq, type: 'request', command, arguments: args })}\n`)
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const length = Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString())?.[1] ?? -1)
      const start = headerEnd + 4
      if (length < 0) {
        this.buffer = this.buffer.subarray(start) // not a frame we understand: skip its header
        continue
      }
      if (this.buffer.length < start + length) return
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      try {
        this.handle(JSON.parse(body))
      } catch {
        /* a broken message is dropped; its request times out */
      }
    }
  }

  private handle(msg: { type: string; request_seq?: number; success?: boolean; body?: unknown; message?: string; event?: string }): void {
    if (msg.type === 'response') {
      const waiting = this.pending.get(msg.request_seq!)
      if (!waiting) return
      this.pending.delete(msg.request_seq!)
      if (msg.success) waiting.resolve(msg.body)
      else waiting.reject(coded('lsp', msg.message ?? 'TypeScript request failed'))
      return
    }
    if (msg.type !== 'event') return
    if (msg.event === 'requestCompleted') {
      this.diagRuns.get((msg.body as { request_seq: number }).request_seq)?.done()
      return
    }
    if (msg.event === 'syntaxDiag' || msg.event === 'semanticDiag' || msg.event === 'suggestionDiag') {
      const { file, diagnostics } = msg.body as { file: string; diagnostics: TsDiagnostic[] }
      // Events carry no request number: a geterr runs at a time per server in practice; feed every open run.
      for (const run of this.diagRuns.values()) run.found.set(file, [...(run.found.get(file) ?? []), ...diagnostics])
    }
  }

  private exited(): void {
    if (!this.alive) return
    this.alive = false
    for (const p of this.pending.values()) p.reject(coded('lsp-stopped', 'The TypeScript server stopped'))
    this.pending.clear()
    for (const run of [...this.diagRuns.values()]) run.done()
    this.onExit()
  }
}
