import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { finished } from 'node:stream/promises'

/** A Node program Mindeck runs (tsserver, the lint worker, …): stdio pipes, killable — what a ChildProcess offers. */
export interface NodeProcess {
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  kill(): boolean
  on(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (err: Error) => void): this
}

export interface NodeOptions {
  cwd: string
  env: Record<string, string>
  /** Its name in the OS task manager (Electron's app metrics). */
  name?: string
  /**
   * It runs the project's code (ESLint plugins …), whose native addons aren't
   * signed by Mindeck: on macOS it then runs in the helper that may load them.
   */
  unsignedLibraries?: boolean
}

/** Runs `node <args…>` — a script and its arguments, or `-e <code>` — with stdin, stdout and stderr piped. */
export type NodeLauncher = (args: string[], opts: NodeOptions) => NodeProcess

/** The headless core (Docker, a home server): `process.execPath` is a real Node. */
export const spawnNode: NodeLauncher = (args, { cwd, env }) => spawn(process.execPath, args, { cwd, env, stdio: 'pipe' })

/** What an Electron utility process (`utilityProcess.fork`) offers here. */
export interface UtilityChild {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  postMessage(message: unknown): void
  kill(): boolean
  on(event: 'exit', listener: (code: number) => void): unknown
}

export type UtilityFork = (
  modulePath: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdio: 'pipe'; serviceName: string; allowLoadingUnsignedLibraries: boolean }
) => UtilityChild

/** A utility process as the child process the services expect. */
class UtilityNode extends EventEmitter {
  readonly stdin: Writable
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  private exited = false

  constructor(private readonly child: UtilityChild) {
    super()
    this.stdout = child.stdout && new Readable().wrap(child.stdout)
    this.stderr = child.stderr && new Readable().wrap(child.stderr)
    // It has no stdin: what is written goes over as messages, null for its end (nodeHost.ts reads them).
    this.stdin = new Writable({
      decodeStrings: false,
      write: (chunk: string | Buffer, _encoding, done) => {
        if (!this.exited) child.postMessage(chunk)
        done()
      },
      final: (done) => {
        if (!this.exited) child.postMessage(null)
        done()
      }
    })
    child.on('exit', (code) => {
      this.exited = true
      this.emit('exit', code, null)
      // Like a child process: 'close' once its output is read to the end.
      const output = [this.stdout, this.stderr].filter((s): s is Readable => s !== null)
      void Promise.all(output.map((s) => finished(s).catch(() => {}))).then(() => this.emit('close', code, null))
    })
  }

  kill(): boolean {
    return this.child.kill()
  }
}

/**
 * The desktop app: Node programs run in Electron utility processes — the
 * main process starts them, nothing else can (Mindeck's binary never runs as
 * Node: the RunAsNode fuse is off). `host` is the entry (nodeHost.ts) that
 * runs the program inside.
 */
export function utilityNode(fork: UtilityFork, host: string): NodeLauncher {
  return (args, opts) =>
    new UtilityNode(
      fork(host, args, { cwd: opts.cwd, env: opts.env, stdio: 'pipe', serviceName: opts.name ?? 'Node', allowLoadingUnsignedLibraries: !!opts.unsignedLibraries })
    )
}
