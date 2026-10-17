import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import type { DebugAction, DebugBreakpoint, DebugFrame, DebugOutput, DebugSession, DebugVariable } from '@shared/types/debug'
import { confine } from '../../lib/confine'
import { shellCommand, shellEnv, shellQuote } from '../terminal/TerminalService'
import { shellArgs } from '../../lib/shellArgs'
import { LANGUAGES, isTypeScriptFile, languageOf } from '@shared/types/languages'
import { DapClient, DapSession, type DapLaunch, type DapTransport } from './Dap'
import { DAP_LANGUAGES, NATIVE_LANGUAGES, startAdapter, type AdapterContext } from './adapters'
import { buildProgram, type BuildContext } from './build'

/** How long a native program may take to start before the macOS permission hint shows. */
export const MAC_HINT_MS = 6000
export const MAC_DEBUG_HINT =
  'macOS asks for permission to debug (Developer Tools access) — confirm the system dialog, or allow it once in a terminal: sudo DevToolsSecurity -enable\n'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** A V8 inspector connection: Chrome DevTools Protocol requests and events. */
export interface Cdp {
  send<T = unknown>(method: string, params?: object): Promise<T>
  on(event: string, fn: (params: never) => void): void
  close(): void
}

/** Talk CDP over the inspector's WebSocket. */
export function connectCdp(url: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let seq = 0
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
    const handlers = new Map<string, ((params: never) => void)[]>()
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: never }
      if (msg.id !== undefined) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) p?.reject(coded('debug', msg.error.message))
        else p?.resolve(msg.result)
      } else handlers.get(msg.method!)?.forEach((fn) => fn(msg.params!))
    })
    ws.on('close', () => {
      for (const p of pending.values()) p.reject(coded('debug-closed', 'The debugger disconnected'))
      pending.clear()
      handlers.get('close')?.forEach((fn) => fn(undefined as never))
    })
    ws.on('error', reject)
    ws.on('open', () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            if (ws.readyState !== WebSocket.OPEN) return rej(coded('debug-closed', 'The debugger disconnected'))
            seq += 1
            pending.set(seq, { resolve: res as (v: unknown) => void, reject: rej })
            ws.send(JSON.stringify({ id: seq, method, params }))
          }),
        on: (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
        close: () => ws.close()
      })
    )
  })
}

/** `node` with these arguments as the user's shell would start it (their PATH: Homebrew, nvm, …). */
export function nodeCommand(args: string[], platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  return { file: shellCommand().file, args: shellArgs(`node ${args.map(shellQuote).join(' ')}`, platform) }
}

/** Start `node` like the user's terminal would. */
export function launchNode(args: string[], cwd: string): ChildProcess {
  const command = nodeCommand(args)
  return spawn(command.file, command.args, { cwd, env: shellEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
}

/** What V8 calls a value (RemoteObject), as the debug console shows it. */
type Remote = { type: string; subtype?: string; value?: unknown; description?: string; objectId?: string; unserializableValue?: string }
export function describe(o: Remote): string {
  if (o.type === 'undefined') return 'undefined'
  if (o.unserializableValue) return o.unserializableValue
  if (o.type === 'string') return JSON.stringify(o.value)
  if (o.subtype === 'null') return 'null'
  if (o.description !== undefined) return o.description
  return String(o.value)
}
const variable = (name: string, o: Remote): DebugVariable => ({
  name,
  value: describe(o),
  type: o.subtype ?? o.type,
  objectId: o.objectId && o.subtype !== 'null' ? o.objectId : undefined
})

/** Inspector chatter on stderr that isn't the program's. */
const NOISE = /^(Debugger listening on|Debugger attached\.|Debugger ending on|Waiting for the debugger to disconnect|For help, see: https:\/\/nodejs\.org)/

const MAX_PROPERTIES = 500

interface Running {
  session: DebugSession
  root: string
  proc: ChildProcess
  cdp?: Cdp
  stopOnEntry: boolean
  started: boolean
  scripts: Map<string, string>
  breakpointIds: string[]
}

export interface DebugOptions {
  resolveRoot: (projectId: string) => string | undefined
  publish: (channel: 'debug:session' | 'debug:output', payload: DebugSession | DebugOutput) => void
  launch?: (args: string[], cwd: string) => ChildProcess
  connect?: (url: string) => Promise<Cdp>
  /** Where a language's debugger is installed (Settings → Languages). */
  tools?: { locate: (language: string, part: 'debugger') => Promise<string | undefined> }
  /** Start a language's debug adapter (tests script one). */
  adapter?: (language: string, ctx: AdapterContext) => Promise<{ transport: DapTransport; launch: DapLaunch }>
  /** Build what runs (compiled languages, the user's build step). */
  build?: (ctx: BuildContext) => Promise<string>
  /** Language server commands (jdtls starts Java debug sessions). */
  lsp?: { executeCommand: (projectId: string, languageId: string, command: string, args: unknown[]) => Promise<unknown> }
}

/** Starting a debug session: the program, its arguments, the user's build step. */
export interface DebugStart {
  projectId: string
  program: string
  args?: string[]
  stopOnEntry?: boolean
  breakpoints: DebugBreakpoint[]
  build?: string
  /** Node: the program opens the inspector in a child it starts (Vitest's worker) — attach there, not to the program. */
  inspectChild?: boolean
  /** Python: run this module (`pytest`) instead of the program file. */
  module?: string
  /** Go: run the package's tests (Delve's test mode). */
  goTest?: boolean
}

/**
 * Run & Debug for Node.js: starts a project's program under the inspector
 * (paused before its first line), sets the editor's breakpoints, and then
 * drives it — continue, pause, step, the call stack with its scopes,
 * variables on demand and expressions evaluated in a frame. One session at
 * a time; its state and output go to every client as events.
 */
export class DebugService {
  private current?: Running
  /** A program under its language's debug adapter (instead of `current`). */
  private dap?: DapSession
  /** A session being built (compiling before the debugger starts). */
  private building?: { session: DebugSession; abort: AbortController }

  constructor(private readonly opts: DebugOptions) {}

  session(): DebugSession | null {
    return this.building?.session ?? this.dap?.session ?? this.current?.session ?? null
  }

  async start(req: DebugStart): Promise<DebugSession> {
    await this.stop()
    const configured = this.opts.resolveRoot(req.projectId)
    if (!configured) throw coded('not-found', `Unknown project: ${req.projectId}`)
    const root = await realpath(configured)
    const program = await confine(root, req.program)
    const known = languageOf(req.program)
    // Anything that isn't JavaScript / TypeScript and has no language is a built program (LLDB runs it).
    const language = known?.id ?? (isTypeScriptFile(req.program) ? undefined : 'native')
    if (language && DAP_LANGUAGES.concat('native').includes(language)) return this.startDap(language, req, root, program)
    if (known) throw coded('debug-unsupported', `Mindeck can't debug ${known.name} programs yet`)
    this.dap = undefined
    // TypeScript runs as is: Node strips the types (positions stay, so breakpoints match). Default from Node 22.18 on.
    const ts = /\.[cm]?ts$/.test(program) ? ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'] : []
    const inspect = req.inspectChild ? [] : ['--inspect-brk=127.0.0.1:0']
    const proc = (this.opts.launch ?? launchNode)([...inspect, ...ts, program, ...(req.args ?? [])], root)
    const run: Running = {
      session: { id: randomUUID(), projectId: req.projectId, program: req.program, status: 'starting', frames: [] },
      root,
      proc,
      stopOnEntry: !!req.stopOnEntry,
      started: false,
      scripts: new Map(),
      breakpointIds: []
    }
    this.current = run
    const output = (stream: DebugOutput['stream'], text: string) => this.opts.publish('debug:output', { sessionId: run.session.id, stream, text })

    proc.stdout!.on('data', (d: Buffer) => output('stdout', d.toString()))
    let errBuffer = ''
    proc.stderr!.on('data', (d: Buffer) => {
      errBuffer += d.toString()
      const lines = errBuffer.split('\n')
      errBuffer = lines.pop()!
      for (const line of lines) {
        const url = /Debugger listening on (ws:\/\/\S+)/.exec(line)?.[1]
        if (url) void this.attach(run, url, req.breakpoints)
        // The program ended: let the inspector go, so the process can exit.
        if (line.startsWith('Waiting for the debugger to disconnect')) run.cdp?.close()
        if (!NOISE.test(line)) output('stderr', `${line}\n`)
      }
    })
    proc.on('error', (err) => this.update(run, { status: 'exited', error: err.message, frames: [] }))
    proc.on('exit', (code) => {
      if (errBuffer && !NOISE.test(errBuffer)) output('stderr', errBuffer)
      run.cdp?.close()
      this.update(run, { status: 'exited', exitCode: code, frames: [], reason: undefined })
      output('info', `exit ${code}\n`)
    })
    this.publish(run)
    return run.session
  }

  async stop(): Promise<void> {
    this.building?.abort.abort()
    if (this.dap) return this.dap.stop()
    const run = this.current
    if (!run || run.session.status === 'exited') return
    run.cdp?.close()
    run.proc.kill()
    await new Promise<void>((resolve) => {
      if (run.proc.exitCode !== null || run.proc.signalCode !== null) return resolve()
      run.proc.once('exit', () => resolve())
    })
  }

  async control(action: DebugAction): Promise<void> {
    if (this.dap) return this.running().control(action)
    const cdp = this.cdp()
    const method = { continue: 'Debugger.resume', pause: 'Debugger.pause', stepOver: 'Debugger.stepOver', stepInto: 'Debugger.stepInto', stepOut: 'Debugger.stepOut' }[action]
    await cdp.send(method)
  }

  /** The editor's breakpoints changed: the running program gets exactly these. */
  async setBreakpoints(projectId: string, breakpoints: DebugBreakpoint[]): Promise<void> {
    if (this.dap) {
      if (this.dap.session.projectId === projectId && this.dap.session.status !== 'exited') await this.dap.setBreakpoints(breakpoints)
      return
    }
    const run = this.current
    if (!run?.cdp || run.session.projectId !== projectId || run.session.status === 'exited') return
    await this.applyBreakpoints(run, breakpoints)
  }

  async variables(objectId: string): Promise<DebugVariable[]> {
    if (this.dap) return this.running().variables(objectId)
    const { result } = await this.cdp().send<{ result: { name: string; value?: Remote; get?: Remote }[] }>('Runtime.getProperties', {
      objectId,
      ownProperties: true,
      generatePreview: false
    })
    return result
      .filter((p) => p.value || p.get)
      .slice(0, MAX_PROPERTIES)
      .map((p) => (p.value ? variable(p.name, p.value) : { name: p.name, value: '(getter)', type: 'accessor' }))
  }

  /** An expression in a call frame (paused), else in the program's global scope. */
  async evaluate(expression: string, frameId?: string): Promise<DebugVariable> {
    if (this.dap) return this.running().evaluate(expression, frameId)
    const cdp = this.cdp()
    const { result, exceptionDetails } = await cdp.send<{ result: Remote; exceptionDetails?: { exception?: Remote; text: string } }>(
      frameId ? 'Debugger.evaluateOnCallFrame' : 'Runtime.evaluate',
      frameId ? { callFrameId: frameId, expression, generatePreview: false } : { expression, generatePreview: false }
    )
    if (exceptionDetails) return { name: expression, value: exceptionDetails.exception ? describe(exceptionDetails.exception) : exceptionDetails.text, type: 'error' }
    return variable(expression, result)
  }

  dispose(): void {
    this.dap?.dispose()
    const run = this.current
    if (!run) return
    run.cdp?.close()
    run.proc.kill()
  }

  // --- helpers ---

  /** Every other language: its debugger from Settings → Languages, through its debug adapter — compiled first where it must be. */
  private async startDap(language: string, req: DebugStart, root: string, program: string): Promise<DebugSession> {
    const tool = language === 'native' ? 'cpp' : language
    const debuggerPath = await this.opts.tools?.locate(tool, 'debugger')
    const name = LANGUAGES.find((l) => l.id === tool)!.name
    if (!debuggerPath) throw coded('debugger-missing', `No ${name} debugger installed — Settings → Languages`)
    this.current = undefined
    this.dap = undefined
    const id = randomUUID()
    const output = (stream: DebugOutput['stream'], text: string) => this.opts.publish('debug:output', { sessionId: id, stream, text })
    let target = program
    if (req.build?.trim() || NATIVE_LANGUAGES.includes(language)) {
      const session: DebugSession = { id, projectId: req.projectId, program: req.program, status: 'starting', frames: [] }
      const build = { session, abort: new AbortController() }
      this.building = build
      this.opts.publish('debug:session', session)
      try {
        target = await (this.opts.build ?? buildProgram)({ root, program, language, command: req.build?.trim() || undefined, output, signal: build.abort.signal })
      } catch (err) {
        if (!build.abort.signal.aborted) return this.ended(build, (err as Error).message)
      } finally {
        if (this.building === build) this.building = undefined
      }
      if (build.abort.signal.aborted) return this.ended(build)
    }
    let dap: DapSession | undefined
    const { transport, launch } = await (this.opts.adapter ?? startAdapter)(language, {
      root,
      program: target,
      args: req.args ?? [],
      debugger: debuggerPath,
      output: (stream, text) => dap && output(stream, text),
      module: req.module,
      goTest: req.goTest,
      command: (command, args) => this.opts.lsp!.executeCommand(req.projectId, language, command, args)
    })
    dap = new DapSession(new DapClient(transport), launch, { id, projectId: req.projectId, program: req.program, root, publish: this.opts.publish })
    this.dap = dap
    this.opts.publish('debug:session', dap.session)
    void dap.start(req.breakpoints, !!req.stopOnEntry).catch((err: Error) => dap!.fail(err.message))
    // The first time, macOS asks before LLDB may control a program — say so while it waits.
    if (NATIVE_LANGUAGES.includes(language) && process.platform === 'darwin') {
      setTimeout(() => dap!.session.status === 'starting' && output('info', MAC_DEBUG_HINT), MAC_HINT_MS).unref()
    }
    return dap.session
  }

  /** A build that failed or was stopped: the session ends there. */
  private ended(build: { session: DebugSession }, error?: string): DebugSession {
    const session: DebugSession = { ...build.session, status: 'exited', error }
    this.opts.publish('debug:session', session)
    return session
  }

  private running(): DapSession {
    if (this.dap!.session.status === 'exited') throw coded('debug-not-running', 'No program is being debugged')
    return this.dap!
  }

  private cdp(): Cdp {
    const cdp = this.current?.cdp
    if (!cdp || this.current!.session.status === 'exited') throw coded('debug-not-running', 'No program is being debugged')
    return cdp
  }

  private async attach(run: Running, url: string, breakpoints: DebugBreakpoint[]): Promise<void> {
    let cdp: Cdp
    try {
      cdp = await (this.opts.connect ?? connectCdp)(url)
    } catch (err) {
      return this.update(run, { error: (err as Error).message })
    }
    run.cdp = cdp
    cdp.on('Debugger.scriptParsed', (p: { scriptId: string; url: string }) => run.scripts.set(p.scriptId, p.url))
    cdp.on('Debugger.paused', (p: PausedEvent) => void this.paused(run, p))
    cdp.on('Debugger.resumed', () => this.update(run, { status: 'running', frames: [], reason: undefined, exception: undefined }))
    await cdp.send('Runtime.enable')
    await cdp.send('Debugger.enable')
    await cdp.send('Debugger.setPauseOnExceptions', { state: 'uncaught' })
    await this.applyBreakpoints(run, breakpoints)
    await cdp.send('Runtime.runIfWaitingForDebugger')
  }

  private async applyBreakpoints(run: Running, breakpoints: DebugBreakpoint[]): Promise<void> {
    const cdp = run.cdp!
    await Promise.all(run.breakpointIds.map((breakpointId) => cdp.send('Debugger.removeBreakpoint', { breakpointId }).catch(() => {})))
    run.breakpointIds = []
    for (const bp of breakpoints) {
      const abs = await confine(run.root, bp.path).catch(() => null)
      if (!abs) continue
      const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // CommonJS reports plain paths, ES modules file URLs.
      const urlRegex = `^(${esc(pathToFileURL(abs).href)}|${esc(abs)})$`
      const set = await cdp.send<{ breakpointId: string }>('Debugger.setBreakpointByUrl', { urlRegex, lineNumber: bp.line - 1, columnNumber: 0 }).catch(() => null)
      if (set) run.breakpointIds.push(set.breakpointId)
    }
  }

  private async paused(run: Running, p: PausedEvent): Promise<void> {
    // --inspect-brk stops before the first line: go on unless asked to stop there.
    if (!run.started) {
      run.started = true
      if (!run.stopOnEntry) return void (await run.cdp!.send('Debugger.resume').catch(() => {}))
    }
    const frames = p.callFrames.map((f): DebugFrame => {
      const url = f.url || run.scripts.get(f.location.scriptId) || ''
      return {
        id: f.callFrameId,
        name: f.functionName || '(anonymous)',
        path: this.projectPath(run.root, url),
        url,
        line: f.location.lineNumber + 1,
        column: (f.location.columnNumber ?? 0) + 1,
        scopes: f.scopeChain.map((s) => ({ type: s.type, name: s.name, objectId: s.object.objectId }))
      }
    })
    this.update(run, {
      status: 'paused',
      reason: p.hitBreakpoints?.length ? 'breakpoint' : p.reason === 'other' ? 'step' : p.reason,
      exception: p.reason === 'exception' && p.data ? describe(p.data) : undefined,
      frames
    })
  }

  /** The project file behind a script URL, if it is one. */
  private projectPath(root: string, url: string): string | undefined {
    let abs: string
    if (url.startsWith('file://')) abs = fileURLToPath(url)
    else if (isAbsolute(url)) abs = url
    else return undefined
    const rel = relative(root, abs)
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : undefined
  }

  private update(run: Running, patch: Partial<DebugSession>): void {
    run.session = { ...run.session, ...patch }
    this.publish(run)
  }

  private publish(run: Running): void {
    this.opts.publish('debug:session', run.session)
  }
}

interface PausedEvent {
  reason: string
  data?: Remote
  hitBreakpoints?: string[]
  callFrames: {
    callFrameId: string
    functionName: string
    url?: string
    location: { scriptId: string; lineNumber: number; columnNumber?: number }
    scopeChain: { type: string; name?: string; object: { objectId?: string } }[]
  }[]
}
