import type { ChildProcess } from 'node:child_process'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** The process a client talks to — stdio pipes, killable (a fake in tests). */
export type RpcProcess = Pick<ChildProcess, 'stdin' | 'stdout' | 'kill' | 'on'>

interface Message {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

export interface LspClientOptions {
  /** Server → client notifications (diagnostics, logs). */
  onNotification?: (method: string, params: unknown) => void
  /** Server → client requests; throw for "method not found". */
  onRequest?: (method: string, params: unknown) => unknown
  onExit?: () => void
  timeoutMs?: number
}

const REQUEST_TIMEOUT_MS = 30_000

/** Content-Length framed messages: what LSP and DAP both speak over stdio and sockets. */
export class FrameReader {
  private buffer = Buffer.alloc(0)

  constructor(private readonly onMessage: (msg: unknown) => void) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const length = Number(/Content-Length: *(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString())?.[1] ?? -1)
      const start = headerEnd + 4
      if (length < 0) {
        this.buffer = this.buffer.subarray(start)
        continue
      }
      if (this.buffer.length < start + length) return
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      try {
        this.onMessage(JSON.parse(body))
      } catch {
        /* a broken message is dropped */
      }
    }
  }
}

export const frame = (msg: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}

/**
 * A JSON-RPC connection to a language server (the Language Server Protocol
 * VS Code uses for every language): requests with answers, notifications
 * both ways, and the server's own requests answered by the editor.
 */
export class LspClient {
  private seq = 0
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private alive = true

  constructor(
    private readonly proc: RpcProcess,
    private readonly opts: LspClientOptions = {}
  ) {
    const reader = new FrameReader((msg) => void this.handle(msg as Message))
    proc.stdout!.on('data', (chunk: Buffer) => reader.push(chunk))
    // A write racing the server's exit (EPIPE) must not crash the app; 'exit' ends the client.
    proc.stdin?.on('error', () => {})
    proc.on('exit', () => this.exited())
    proc.on('error', () => this.exited())
  }

  get running(): boolean {
    return this.alive
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = this.opts.timeoutMs ?? REQUEST_TIMEOUT_MS): Promise<T> {
    if (!this.alive) return Promise.reject(coded('lsp-stopped', 'The language server stopped'))
    const id = ++this.seq
    const answer = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(coded('lsp-timeout', `The language server did not answer ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
    })
    this.write({ jsonrpc: '2.0', id, method, params })
    return answer
  }

  notify(method: string, params: unknown): void {
    if (this.alive) this.write({ jsonrpc: '2.0', method, params })
  }

  /** Ask the server to end, then make sure it does. */
  async dispose(): Promise<void> {
    if (!this.alive) return
    await this.request('shutdown', null, 2000).catch(() => {})
    this.notify('exit', null)
    this.proc.kill()
    this.exited()
  }

  private write(msg: unknown): void {
    this.proc.stdin!.write(frame(msg))
  }

  private async handle(msg: Message): Promise<void> {
    if (msg.method === undefined) {
      const waiting = this.pending.get(msg.id as number)
      if (!waiting) return
      this.pending.delete(msg.id as number)
      if (msg.error) waiting.reject(coded('lsp', msg.error.message))
      else waiting.resolve(msg.result ?? null)
      return
    }
    if (msg.id === undefined) {
      // A malformed notification (a URI we can't map, …) is dropped — never an unhandled rejection.
      try {
        this.opts.onNotification?.(msg.method, msg.params)
      } catch {
        /* ignored */
      }
      return
    }
    try {
      const result = await (this.opts.onRequest ?? (() => Promise.reject(new Error('unhandled'))))(msg.method, msg.params)
      if (this.alive) this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? null })
    } catch (err) {
      if (this.alive) this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: (err as Error).message } })
    }
  }

  private exited(): void {
    if (!this.alive) return
    this.alive = false
    for (const p of this.pending.values()) p.reject(coded('lsp-stopped', 'The language server stopped'))
    this.pending.clear()
    this.opts.onExit?.()
  }
}
