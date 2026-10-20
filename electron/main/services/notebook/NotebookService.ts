import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import type { KernelInfo, KernelState, NotebookEvent } from '@shared/types/notebook'
import { spawnInShell } from '../debug/adapters'
import { pythonFor, systemPython, venvPython } from '../tools/catalog'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * The bridge between Mindeck and a Jupyter kernel, run by the project's Python:
 * jupyter_client starts the kernel; commands come in as JSON lines on stdin,
 * what the kernel says goes out as JSON lines (nbformat outputs per cell).
 * `specs` lists the installed kernels instead.
 */
export const BRIDGE = String.raw`
import json, queue, sys, threading
lock = threading.Lock()
def out(o):
    with lock:
        sys.stdout.write(json.dumps(o, default=str) + "\n")
        sys.stdout.flush()
try:
    from jupyter_client.kernelspec import KernelSpecManager
    from jupyter_client.manager import KernelManager
except ImportError:
    out({"type": "missing"})
    sys.exit(0)
if sys.argv[1] == "specs":
    specs = KernelSpecManager().get_all_specs()
    out({"type": "specs", "specs": [{"name": n, "displayName": s["spec"].get("display_name", n), "language": s["spec"].get("language", "")} for n, s in sorted(specs.items())]})
    sys.exit(0)
km = KernelManager(kernel_name=sys.argv[2])
try:
    km.start_kernel(cwd=sys.argv[3])
    kc = km.client()
    kc.start_channels()
    kc.wait_for_ready(timeout=120)
except Exception as e:
    out({"type": "failed", "message": "%s: %s" % (type(e).__name__, e)})
    try:
        km.shutdown_kernel(now=True)
    except Exception:
        pass
    sys.exit(0)
cells = {}
def iopub():
    while True:
        try:
            msg = kc.get_iopub_msg(timeout=0.2)
        except queue.Empty:
            continue
        except Exception:
            return
        kind, c = msg["header"]["msg_type"], msg["content"]
        cell = cells.get(msg["parent_header"].get("msg_id"))
        if kind == "status":
            out({"type": "status", "state": c["execution_state"]})
            if cell is not None and c["execution_state"] == "idle":
                out({"type": "done", "cell": cell})
            continue
        if cell is None:
            continue
        if kind == "stream":
            o = {"output_type": "stream", "name": c["name"], "text": c["text"]}
        elif kind == "execute_result":
            o = {"output_type": "execute_result", "execution_count": c.get("execution_count"), "data": c.get("data", {}), "metadata": c.get("metadata", {})}
        elif kind in ("display_data", "update_display_data"):
            o = {"output_type": "display_data", "data": c.get("data", {}), "metadata": c.get("metadata", {})}
        elif kind == "error":
            o = {"output_type": "error", "ename": c["ename"], "evalue": c["evalue"], "traceback": c["traceback"]}
        elif kind == "clear_output":
            out({"type": "clear", "cell": cell, "wait": bool(c.get("wait"))})
            continue
        elif kind == "execute_input":
            out({"type": "count", "cell": cell, "count": c.get("execution_count")})
            continue
        else:
            continue
        out({"type": "output", "cell": cell, "output": o})
def drain():
    while True:
        try:
            kc.get_shell_msg(timeout=0.5)
        except queue.Empty:
            continue
        except Exception:
            return
threading.Thread(target=iopub, daemon=True).start()
threading.Thread(target=drain, daemon=True).start()
out({"type": "ready"})
for line in sys.stdin:
    req = json.loads(line)
    op = req.get("op")
    if op == "execute":
        cells[kc.execute(req["code"], store_history=True, allow_stdin=False)] = req["cell"]
    elif op == "interrupt":
        km.interrupt_kernel()
    elif op == "restart":
        out({"type": "status", "state": "restarting"})
        cells.clear()
        km.restart_kernel(now=True)
        kc.wait_for_ready(timeout=120)
        out({"type": "status", "state": "idle"})
    elif op == "shutdown":
        break
km.shutdown_kernel(now=True)
`

/** How long a kernel may take to come up (first starts compile a lot). */
const START_MS = 120_000
/** A kernel that doesn't stop when asked is ended after this. */
const STOP_MS = 3_000

interface Session {
  proc: ChildProcess
  kernel: string
  ready: Promise<void>
}

export interface NotebookOptions {
  resolveRoot: (projectId: string) => string | undefined
  /** Whether the project is trusted (WorkspaceTrust): its Python runs only then. */
  trusted?: (projectId: string) => boolean
  publish: (event: NotebookEvent) => void
  /** Start Python (tests give a stand-in). */
  start?: (command: string, args: string[], cwd: string) => ChildProcess
}

/** Run a one-off command; resolves with what it printed and its exit code. */
function run(proc: ChildProcess): Promise<{ out: string; code: number | null }> {
  return new Promise((done) => {
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    proc.stderr?.on('data', (d: Buffer) => (out += d.toString()))
    proc.on('error', (err) => done({ out: `${out}${err.message}\n`, code: -1 }))
    proc.on('close', (code) => done({ out, code }))
  })
}

/**
 * Jupyter kernels for notebooks: one per open notebook, started by the
 * project's Python with jupyter_client (any installed kernel: Python, R,
 * Julia …). Cells run in order; their outputs stream back as events.
 */
export class NotebookService {
  private sessions = new Map<string, Session>()

  constructor(private readonly opts: NotebookOptions) {}

  /** The kernels the project's Python offers — and whether it can run them at all. */
  async kernels(projectId: string): Promise<KernelInfo> {
    const root = await this.root(projectId)
    const python = pythonFor(root)
    const { out } = await run(this.spawn(python, ['-c', BRIDGE, 'specs'], root))
    const reply = this.lines(out).find((l) => l.type === 'specs' || l.type === 'missing')
    return { python, venv: !!venvPython(root), ready: reply?.type === 'specs', specs: (reply?.specs as KernelInfo['specs']) ?? [] }
  }

  /** Make the project ready for notebooks: a `.venv` when it has none, ipykernel in it. Resolves with the output. */
  async setup(projectId: string): Promise<string> {
    const root = await this.root(projectId)
    let log = ''
    if (!venvPython(root)) {
      const made = await run(this.spawn(systemPython(), ['-m', 'venv', '.venv'], root))
      log += made.out
      if (made.code !== 0) throw coded('setup-failed', `Creating .venv failed:\n${log.trim()}`)
    }
    const installed = await run(this.spawn(pythonFor(root), ['-m', 'pip', 'install', '--disable-pip-version-check', 'ipykernel'], root))
    log += installed.out
    if (installed.code !== 0) throw coded('setup-failed', `Installing ipykernel failed:\n${log.trim()}`)
    return log
  }

  /** A kernel for the notebook (the running one when it is the same kind); resolves when it is ready. */
  async start(projectId: string, path: string, kernel: string): Promise<void> {
    const key = `${projectId}:${path}`
    const running = this.sessions.get(key)
    if (running?.kernel === kernel) return running.ready
    if (running) this.stop(key)
    const root = await this.root(projectId)
    const file = resolve(root, path)
    if (file !== root && !file.startsWith(root + sep)) throw coded('not-found', `Not in the project: ${path}`)
    const publish = (e: Record<string, unknown>) => this.opts.publish({ projectId, path, ...e } as NotebookEvent)
    const proc = this.spawn(pythonFor(root), ['-c', BRIDGE, 'run', kernel, existsSync(dirname(file)) ? dirname(file) : root], root)
    publish({ type: 'status', state: 'starting' satisfies KernelState })
    let stderr = ''
    let buffer = ''
    const ready = new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => fail(coded('kernel-timeout', 'The kernel did not start in time')), START_MS)
      const settle = (err?: Error) => {
        clearTimeout(timer)
        if (err) fail(err)
        else ok()
      }
      proc.stdout!.on('data', (d: Buffer) => {
        buffer += d.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop()!
        for (const line of this.lines(lines.join('\n'))) {
          if (line.type === 'ready') settle()
          else if (line.type === 'missing') settle(coded('kernel-missing', 'Jupyter is not installed for this project’s Python — set it up (ipykernel)'))
          else if (line.type === 'failed') settle(coded('kernel-failed', String(line.message)))
          else publish(line)
        }
      })
      proc.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)))
      proc.on('error', (err) => settle(coded('kernel-failed', err.message)))
      proc.on('close', () => {
        settle(coded('kernel-failed', stderr.trim() || 'The kernel stopped'))
        if (this.sessions.get(key)?.proc === proc) this.sessions.delete(key)
        publish({ type: 'status', state: 'dead' })
      })
    })
    // A failed start is reported to the caller; nobody else waits on it.
    ready.catch(() => {})
    this.sessions.set(key, { proc, kernel, ready })
    return ready
  }

  /** Run a cell's code; outputs follow as events, then `done`. */
  async execute(projectId: string, path: string, cell: string, code: string): Promise<void> {
    const session = this.session(projectId, path)
    await session.ready
    this.send(session, { op: 'execute', cell, code })
  }

  interrupt(projectId: string, path: string): void {
    this.send(this.session(projectId, path), { op: 'interrupt' })
  }

  restart(projectId: string, path: string): void {
    this.send(this.session(projectId, path), { op: 'restart' })
  }

  /** The notebook closed: its kernel stops. */
  shutdown(projectId: string, path: string): void {
    this.stop(`${projectId}:${path}`)
  }

  dispose(): void {
    for (const key of [...this.sessions.keys()]) this.stop(key)
  }

  private stop(key: string): void {
    const session = this.sessions.get(key)
    if (!session) return
    this.sessions.delete(key)
    this.send(session, { op: 'shutdown' })
    const timer = setTimeout(() => session.proc.kill(), STOP_MS)
    session.proc.on('close', () => clearTimeout(timer))
  }

  private send(session: Session, message: Record<string, unknown>): void {
    session.proc.stdin?.write(`${JSON.stringify(message)}\n`)
  }

  private session(projectId: string, path: string): Session {
    const session = this.sessions.get(`${projectId}:${path}`)
    if (!session) throw coded('not-started', 'No kernel is running for this notebook')
    return session
  }

  /** The bridge's JSON lines (anything else it printed is skipped). */
  private lines(text: string): Record<string, unknown>[] {
    return text.split('\n').flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown
        return value && typeof value === 'object' && 'type' in value ? [value as Record<string, unknown>] : []
      } catch {
        return []
      }
    })
  }

  private spawn(command: string, args: string[], cwd: string): ChildProcess {
    return (this.opts.start ?? spawnInShell)(command, args, cwd)
  }

  /**
   * The project's folder — for a trusted project only: Python started there
   * runs the project's code before any cell (its .venv's interpreter, a
   * `json.py` next to it shadowing the standard library).
   */
  private async root(projectId: string): Promise<string> {
    const configured = this.opts.resolveRoot(projectId)
    if (!configured) throw coded('not-found', `Unknown project: ${projectId}`)
    if (!this.opts.trusted?.(projectId)) throw coded('untrusted', 'Notebooks run only in projects you trust — trust this project first')
    return realpath(configured)
  }
}

