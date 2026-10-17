import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:net'
import { realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'
import { FrameReader, frame } from '../../../electron/main/services/lsp/LspClient'
import { DapClient, DapSession, type DapTransport } from '../../../electron/main/services/debug/Dap'
import { socketTransport, spawnInShell, startAdapter, stdioTransport, type Spawn } from '../../../electron/main/services/debug/adapters'
import { DebugService, MAC_DEBUG_HINT, MAC_HINT_MS } from '../../../electron/main/services/debug/DebugService'
import type { DebugOutput, DebugSession } from '@shared/types/debug'

type Req = { seq: number; type: string; command: string; arguments?: Record<string, unknown> }
type Handler = (args: never, adapter: FakeAdapter) => unknown

/** A scripted debug adapter on an in-memory transport. */
class FakeAdapter {
  received: Req[] = []
  private readonly toClient = new PassThrough()
  private closeFns: (() => void)[] = []
  closed = false
  transport: DapTransport
  constructor(public handlers: Record<string, Handler> = {}) {
    const reader = new FrameReader((m) => void this.receive(m as Req))
    this.transport = {
      write: (data) => reader.push(data),
      onData: (fn) => void this.toClient.on('data', fn),
      onClose: (fn) => void this.closeFns.push(fn),
      close: () => {
        this.closed = true
        this.closeFns.forEach((f) => f())
      }
    }
  }
  private async receive(m: Req) {
    this.received.push(m)
    if (m.type !== 'request') return
    const handler = this.handlers[m.command] ?? (() => ({}))
    try {
      this.send({ seq: 0, type: 'response', request_seq: m.seq, command: m.command, success: true, body: await handler(m.arguments as never, this) })
    } catch (err) {
      this.send({ seq: 0, type: 'response', request_seq: m.seq, command: m.command, success: false, message: (err as Error).message || undefined })
    }
  }
  send(msg: unknown) {
    this.toClient.write(frame(msg))
  }
  event(event: string, body?: unknown) {
    this.send({ seq: 0, type: 'event', event, body })
  }
  commands() {
    return this.received.filter((m) => m.type === 'request').map((m) => m.command)
  }
}

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms))

describe('DapClient', () => {
  it('requests, failures, events, the adapter’s own requests, timeouts and closing', async () => {
    const adapter = new FakeAdapter({ ok: () => ({ fine: true }), bare: () => undefined, bad: () => Promise.reject(new Error('nope')), silent: () => Promise.reject(new Error('')), hang: () => new Promise(() => {}) })
    const client = new DapClient(adapter.transport, 30)
    expect(await client.request('ok', { a: 1 })).toEqual({ fine: true })
    expect(await client.request('bare')).toEqual({})
    await expect(client.request('bad')).rejects.toMatchObject({ code: 'debug', message: 'nope' })
    await expect(client.request('silent')).rejects.toMatchObject({ message: 'silent failed' })
    await expect(client.request('hang')).rejects.toMatchObject({ code: 'debug-timeout' })
    const events: unknown[] = []
    client.on('stopped', (b) => events.push(b))
    adapter.event('stopped', { reason: 'x' })
    adapter.event('stopped')
    adapter.event('other', {})
    adapter.send({ seq: 0, type: 'response', request_seq: 999, success: true })
    adapter.send({ seq: 7, type: 'request', command: 'runInTerminal', arguments: {} })
    await tick()
    expect(events).toEqual([{ reason: 'x' }, {}])
    expect(adapter.received.find((m) => m.type === 'response')).toMatchObject({ request_seq: 7, success: false, message: 'Not supported by Mindeck' })

    const pending = client.request('hang', undefined, 10_000)
    let closed = 0
    client.on('close', () => (closed += 1))
    client.close()
    await expect(pending).rejects.toMatchObject({ code: 'debug-closed' })
    await expect(client.request('ok')).rejects.toMatchObject({ code: 'debug-closed' })
    client.close()
    expect(closed).toBe(1)
    expect(adapter.closed).toBe(true)
  })
})

function session(handlers: Record<string, Handler> = {}) {
  const adapter = new FakeAdapter({
    initialize: () => ({ exceptionBreakpointFilters: [{ filter: 'uncaught', default: true }, { filter: 'raised' }] }),
    launch: (_a, ad) => {
      setTimeout(() => ad.event('initialized'), 5)
      return {}
    },
    threads: () => ({ threads: [{ id: 1 }] }),
    stackTrace: () => ({
      stackFrames: [
        { id: 10, name: 'add', line: 2, column: 5, source: { path: '/root/app.py' } },
        { id: 11, name: '<module>', line: 7, column: 1, source: { path: '/usr/lib/python/runpy.py' } },
        { id: 12, name: 'native', line: 0, column: 0 }
      ]
    }),
    scopes: (a: { frameId: number }) => ({ scopes: a.frameId === 10 ? [{ name: 'Locals', variablesReference: 4 }, { name: 'Empty', variablesReference: 0 }] : [] }),
    variables: () => ({ variables: [{ name: 'a', value: '2', type: 'int', variablesReference: 0 }, { name: 'user', value: "{'n': 1}", variablesReference: 9 }] }),
    evaluate: (a: { expression: string }) => (a.expression === 'bad' ? Promise.reject(new Error('NameError')) : { result: '20', type: 'int', variablesReference: 0 }),
    ...handlers
  })
  const sessions: DebugSession[] = []
  const output: DebugOutput[] = []
  let killed = 0
  const dap = new DapSession(new DapClient(adapter.transport), { adapterID: 'debugpy', arguments: { program: '/root/app.py' }, kill: () => (killed += 1) }, {
    projectId: 'p',
    program: 'app.py',
    root: '/root',
    publish: (c, p) => (c === 'debug:session' ? sessions.push(p as DebugSession) : output.push(p as DebugOutput))
  })
  return { adapter, dap, sessions, output, killed: () => killed, last: () => sessions[sessions.length - 1] }
}

describe('DapSession', () => {
  it('the handshake: launch, breakpoints, exception filters, configurationDone — then stops, frames, variables', async () => {
    const s = session()
    await s.dap.start([{ path: 'app.py', line: 2 }, { path: 'app.py', line: 5 }, { path: 'lib/x.py', line: 1 }], true)
    expect(s.adapter.commands()).toEqual(['initialize', 'launch', 'setBreakpoints', 'setBreakpoints', 'setExceptionBreakpoints', 'configurationDone'])
    const init = s.adapter.received.find((m) => m.command === 'initialize')!.arguments
    expect(init).toMatchObject({ adapterID: 'debugpy', linesStartAt1: true, columnsStartAt1: true })
    expect(s.adapter.received.find((m) => m.command === 'launch')!.arguments).toEqual({ program: '/root/app.py', stopOnEntry: true })
    const bps = s.adapter.received.filter((m) => m.command === 'setBreakpoints').map((m) => m.arguments)
    expect(bps).toEqual([
      { source: { path: '/root/app.py' }, breakpoints: [{ line: 2 }, { line: 5 }] },
      { source: { path: '/root/lib/x.py' }, breakpoints: [{ line: 1 }] }
    ])
    expect(s.adapter.received.find((m) => m.command === 'setExceptionBreakpoints')!.arguments).toEqual({ filters: ['uncaught'] })
    expect(s.last().status).toBe('running')

    s.adapter.event('output', { category: 'stdout', output: 'hi\n' })
    s.adapter.event('output', { category: 'stderr', output: 'warn\n' })
    s.adapter.event('output', { category: 'console', output: 'note\n' })
    s.adapter.event('output', { category: 'telemetry', output: '{}' })
    s.adapter.event('stopped', { reason: 'breakpoint', threadId: 1 })
    await tick(40)
    expect(s.output.map((o) => `${o.stream}:${o.text}`)).toEqual(['stdout:hi\n', 'stderr:warn\n', 'info:note\n'])
    expect(s.last()).toMatchObject({ status: 'paused', reason: 'breakpoint', exception: undefined })
    expect(s.last().frames.map((f) => [f.id, f.name, f.path, f.url, f.line])).toEqual([
      ['10', 'add', 'app.py', '/root/app.py', 2],
      ['11', '<module>', undefined, '/usr/lib/python/runpy.py', 7],
      ['12', 'native', undefined, '', 0]
    ])
    expect(s.last().frames[0].scopes).toEqual([{ type: 'Locals', objectId: '4' }, { type: 'Empty', objectId: undefined }])
    expect(await s.dap.variables('4')).toEqual([
      { name: 'a', value: '2', type: 'int', objectId: undefined },
      { name: 'user', value: "{'n': 1}", type: 'value', objectId: '9' }
    ])
    expect(await s.dap.evaluate('a * 10', '10')).toEqual({ name: 'a * 10', value: '20', type: 'int', objectId: undefined })
    expect(await s.dap.evaluate('bad')).toEqual({ name: 'bad', value: 'NameError', type: 'error' })
    expect(s.adapter.received.filter((m) => m.command === 'evaluate').map((m) => m.arguments!.frameId)).toEqual([10, undefined])

    for (const action of ['continue', 'pause', 'stepOver', 'stepInto', 'stepOut'] as const) await s.dap.control(action)
    expect(s.adapter.commands().slice(-5)).toEqual(['continue', 'pause', 'next', 'stepIn', 'stepOut'])
    expect(s.adapter.received.at(-1)!.arguments).toEqual({ threadId: 1 })

    // Breakpoints change: the file that has none now is cleared.
    await s.dap.setBreakpoints([{ path: 'app.py', line: 9 }])
    expect(s.adapter.received.filter((m) => m.command === 'setBreakpoints').slice(-2).map((m) => m.arguments)).toEqual([
      { source: { path: '/root/app.py' }, breakpoints: [{ line: 9 }] },
      { source: { path: '/root/lib/x.py' }, breakpoints: [] }
    ])

    s.adapter.event('continued', {})
    await tick()
    expect(s.last().status).toBe('running')
    s.adapter.event('stopped', { reason: 'exception', description: 'ZeroDivisionError', threadId: 1 })
    await tick(40)
    expect(s.last()).toMatchObject({ reason: 'exception', exception: 'ZeroDivisionError' })
    s.adapter.event('exited', { exitCode: 3 })
    s.adapter.event('terminated', {})
    await tick()
    expect(s.last()).toMatchObject({ status: 'exited', exitCode: 3, frames: [] })
    expect(s.output.at(-1)).toMatchObject({ stream: 'info', text: 'exit 3\n' })
    expect(s.killed()).toBe(1)
    await s.dap.stop() // already over
    expect(s.adapter.commands()).not.toContain('disconnect')
  })

  it('stops without a thread from the event, frames that can’t be listed, a failing breakpoint', async () => {
    const s = session({
      launch: (_a, ad) => (setTimeout(() => ad.event('initialized'), 5), {}),
      threads: () => Promise.reject(new Error('no threads')),
      stackTrace: () => Promise.reject(new Error('gone')),
      setBreakpoints: () => Promise.reject(new Error('bad file')),
      initialize: () => ({})
    })
    await s.dap.start([{ path: 'a.py', line: 1 }], false)
    expect(s.adapter.received.find((m) => m.command === 'setExceptionBreakpoints')!.arguments).toEqual({ filters: [] })
    s.adapter.event('stopped', { reason: 'pause', text: 'Paused' })
    await tick(40)
    expect(s.last()).toMatchObject({ status: 'paused', frames: [] })
    await expect(s.dap.control('pause')).rejects.toMatchObject({ code: 'debug' })
  })

  it('pause before any stop asks for the threads; many frames load scopes only at the top', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: i, name: `f${i}`, line: 1, column: 1, source: i === 1 ? { name: '<string>' } : { path: `/root/f${i}.py` } }))
    const s = session({
      stackTrace: () => ({ stackFrames: many }),
      // frame 2 has none, frame 3's can't be read: both show without scopes
      scopes: (a: { frameId: number }) => (a.frameId === 3 ? Promise.reject(new Error('gone')) : a.frameId === 2 ? {} : { scopes: [{ name: 'Locals', variablesReference: 1 }] }),
      // an adapter that fails to disconnect is closed all the same
      disconnect: () => Promise.reject(new Error('already gone'))
    })
    await s.dap.start([], false)
    await s.dap.control('pause')
    expect(s.adapter.received.at(-1)).toMatchObject({ command: 'pause', arguments: { threadId: 1 } })
    s.adapter.event('stopped', { reason: 'pause' })
    await tick(60)
    expect(s.last().frames.filter((f) => f.scopes.length)).toHaveLength(18)
    expect(s.last().frames[1]).toMatchObject({ url: '<string>', path: undefined })
    await s.dap.stop()
    expect(s.adapter.commands()).toContain('disconnect')
    expect(s.last().status).toBe('exited')
    expect(s.output.at(-1)!.text).toBe('exit -\n')
  })

  it('a program that stops on entry before the handshake is answered stays paused', async () => {
    const s = session({
      configurationDone: (_a, ad) => {
        ad.event('stopped', { reason: 'entry', threadId: 1 })
        return new Promise((r) => setTimeout(() => r({}), 30))
      }
    })
    await s.dap.start([], true)
    expect(s.last()).toMatchObject({ status: 'paused', reason: 'entry' })
  })

  it('a launch the adapter refuses ends the session with the reason; the adapter going away ends it too', async () => {
    const refused = session({ launch: () => Promise.reject(new Error('No module named debugpy')) })
    await expect(refused.dap.start([], false)).rejects.toMatchObject({ message: 'No module named debugpy' })
    expect(refused.last()).toMatchObject({ status: 'exited', error: 'No module named debugpy' })

    const gone = session()
    await gone.dap.start([], false)
    gone.adapter.transport.close()
    expect(gone.last().status).toBe('exited')
    gone.dap.dispose()

    const failed = session()
    failed.dap.fail('spawn python3 ENOENT')
    expect(failed.last()).toMatchObject({ status: 'exited', error: 'spawn python3 ENOENT' })
  })
})

/** A stand-in child process for adapter starts. */
class FakeProc extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = 0
  kill() {
    this.killed += 1
    return true
  }
}

describe('starting debug adapters', () => {
  const servers: Server[] = []
  afterEach(() => servers.splice(0).forEach((s) => s.close()))

  it('Python: debugpy through the project’s interpreter, over stdio', async () => {
    const root = await tempDir()
    const proc = new FakeProc()
    const calls: Parameters<Spawn>[] = []
    const run: Spawn = (...args) => (calls.push(args), proc as never)
    const { transport, launch } = await startAdapter('python', { root, program: join(root, 'app.py'), args: ['-v'], debugger: '/tools/debugpy', output: () => {} }, run)
    expect(calls[0]).toEqual(['python3', ['-m', 'debugpy.adapter'], root, { PYTHONPATH: '/tools/debugpy' }])
    expect(launch).toMatchObject({ adapterID: 'debugpy', arguments: { type: 'python', program: join(root, 'app.py'), args: ['-v'], python: ['python3'], console: 'internalConsole' } })
    // A test: pytest runs as a module.
    const tests = await startAdapter('python', { root, program: join(root, 'test_a.py'), args: ['test_a.py::test_x'], debugger: '/tools/debugpy', output: () => {}, module: 'pytest' }, () => new FakeProc() as never)
    expect(tests.launch.arguments).toMatchObject({ module: 'pytest', args: ['test_a.py::test_x'] })
    expect(tests.launch.arguments).not.toHaveProperty('program')
    const got: string[] = []
    transport.onData((d) => got.push(d.toString()))
    let closed = false
    transport.onClose(() => (closed = true))
    proc.stdout.write('x')
    let written = ''
    proc.stdin.on('data', (d: Buffer) => (written += d.toString()))
    transport.write(Buffer.from('y'))
    await tick()
    expect([got.join(''), written]).toEqual(['x', 'y'])
    proc.emit('exit')
    expect(closed).toBe(true)
    transport.close()
    launch.kill()
    expect(proc.killed).toBe(2)
  })

  it('Go: Delve’s DAP server on a local port; its later output is the program’s', async () => {
    const server = createServer((socket) => socket.on('data', (d) => socket.write(d)))
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const proc = new FakeProc()
    const out: string[] = []
    const started = startAdapter('go', { root: '/r', program: '/r/cmd/main.go', args: [], debugger: '/go/bin/dlv', output: (s, t) => out.push(`${s}:${t}`) }, (cmd, args) => {
      expect([cmd, args]).toEqual(['/go/bin/dlv', ['dap', '--listen=127.0.0.1:0']])
      return proc as never
    })
    proc.stderr.write('warming up\n')
    proc.stdout.write(`DAP server listening at: 127.0.0.1:${port}\n`)
    const { transport, launch } = await started
    expect(launch).toMatchObject({ adapterID: 'go', arguments: { mode: 'debug', program: '/r/cmd' } })
    proc.stdout.write('program says hi\n')
    const echoed = new Promise<string>((r) => transport.onData((d) => r(d.toString())))
    transport.write(Buffer.from('ping'))
    expect(await echoed).toBe('ping')
    let closed = false
    transport.onClose(() => (closed = true))
    transport.close()
    await tick()
    expect(closed).toBe(true)
    expect(out).toEqual(['stderr:warming up\n', 'stdout:program says hi\n'])
    launch.kill()
    expect(proc.killed).toBe(1)
    // A test: Delve builds the package's tests.
    const testProc = new FakeProc()
    const testing = startAdapter('go', { root: '/r', program: '/r/pkg/a_test.go', args: ['-test.run', '^TestA$'], debugger: 'dlv', output: () => {}, goTest: true }, () => testProc as never)
    testProc.stdout.write(`DAP server listening at: 127.0.0.1:${port}\n`)
    const test = await testing
    expect(test.launch.arguments).toMatchObject({ mode: 'test', program: '/r/pkg', args: ['-test.run', '^TestA$'] })
    test.transport.close()
  })

  it('Go: Delve that never listens, or can’t start, or a port nobody answers', async () => {
    const quits = new FakeProc()
    const a = startAdapter('go', { root: '/r', program: '/r/m.go', args: [], debugger: 'dlv', output: () => {} }, () => quits as never)
    quits.stdout.write('some text\n')
    quits.emit('exit')
    await expect(a).rejects.toMatchObject({ message: 'Delve did not start' })

    const broken = new FakeProc()
    const b = startAdapter('go', { root: '/r', program: '/r/m.go', args: [], debugger: 'dlv', output: () => {} }, () => broken as never)
    broken.emit('error', new Error('spawn dlv ENOENT'))
    await expect(b).rejects.toMatchObject({ message: 'spawn dlv ENOENT' })

    const closedPort = new FakeProc()
    const c = startAdapter('go', { root: '/r', program: '/r/m.go', args: [], debugger: 'dlv', output: () => {} }, () => closedPort as never)
    closedPort.stdout.write('DAP server listening at: 127.0.0.1:1\n')
    await expect(c).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    closedPort.emit('exit') // after it listened: nothing more to reject
  })

  it('spawnInShell runs through the user’s shell with extra environment; socket transports', async () => {
    const proc = spawnInShell('node', ['-e', 'process.stdout.write(process.env.MINDECK_X)'], await tempDir(), { MINDECK_X: 'yes' })
    let out = ''
    proc.stdout!.on('data', (d: Buffer) => (out += d.toString()))
    await new Promise((r) => proc.on('exit', r))
    expect(out).toBe('yes')
    const plain = spawnInShell('true', [], await tempDir())
    await new Promise((r) => plain.on('exit', r))
    // Windows: the program itself (lldb-dap.exe, dlv.exe, python) — PowerShell would mangle POSIX quoting.
    const direct = spawnInShell(process.execPath, ['-e', 'process.stdout.write(process.env.MINDECK_X)'], await tempDir(), { MINDECK_X: 'win', ELECTRON_RUN_AS_NODE: '1' }, 'win32')
    let got = ''
    direct.stdout!.on('data', (d: Buffer) => (got += d.toString()))
    await new Promise((r) => direct.on('exit', r))
    expect(got).toBe('win')
    expect(typeof socketTransport).toBe('function')
    expect(typeof stdioTransport).toBe('function')
  }, 20_000)
})

describe('DebugService: Python and Go through their debuggers', () => {
  async function service(debuggerPath: string | undefined, adapter = new FakeAdapter({ launch: (_a, ad) => (setTimeout(() => ad.event('initialized'), 5), {}) })) {
    const root = await tempDir()
    await writeFile(join(root, 'app.py'), '')
    await writeFile(join(root, 'a.js'), '')
    const sessions: DebugSession[] = []
    const output: DebugOutput[] = []
    let ctxOutput!: (s: 'stdout' | 'stderr', t: string) => void
    const svc = new DebugService({
      resolveRoot: () => root,
      publish: (c, p) => (c === 'debug:session' ? sessions.push(p as DebugSession) : output.push(p as DebugOutput)),
      tools: { locate: async () => debuggerPath },
      adapter: async (language, ctx) => {
        expect(language).toBe('python')
        ctxOutput = ctx.output
        ctx.output('stdout', 'before the session') // dropped: no session yet
        return { transport: adapter.transport, launch: { adapterID: 'debugpy', arguments: {}, kill: () => {} } }
      },
      launch: () => new FakeProc() as never
    })
    return { svc, adapter, sessions, output, emit: (s: 'stdout' | 'stderr', t: string) => ctxOutput(s, t), last: () => sessions[sessions.length - 1] }
  }

  it('a missing debugger says where to get one', async () => {
    const { svc } = await service(undefined)
    await expect(svc.start({ projectId: 'p', program: 'app.py', breakpoints: [] })).rejects.toMatchObject({ code: 'debugger-missing', message: expect.stringContaining('Python') })
    const none = new DebugService({ resolveRoot: () => '/', publish: () => {} })
    await expect(none.start({ projectId: 'p', program: 'x.py', breakpoints: [] })).rejects.toBeTruthy()
  })

  it('runs, controls and stops a Python program; a Node program afterwards takes over', async () => {
    const t = await service('/tools/debugpy')
    const started = await t.svc.start({ projectId: 'p', program: 'app.py', breakpoints: [{ path: 'app.py', line: 1 }], stopOnEntry: true })
    expect(started.status).toBe('starting')
    await tick(40)
    expect(t.svc.session()?.status).toBe('running')
    t.emit('stdout', 'program output')
    expect(t.output).toEqual([{ sessionId: started.id, stream: 'stdout', text: 'program output' }])
    await t.svc.control('stepOver')
    expect(await t.svc.variables('3')).toEqual([])
    expect(await t.svc.evaluate('x')).toMatchObject({ name: 'x' })
    await t.svc.setBreakpoints('p', [{ path: 'app.py', line: 2 }])
    await t.svc.setBreakpoints('other', [])
    expect(t.adapter.received.filter((m) => m.command === 'setBreakpoints')).toHaveLength(2)
    await t.svc.stop()
    expect(t.svc.session()?.status).toBe('exited')
    await t.svc.setBreakpoints('p', [])
    await expect(t.svc.control('continue')).rejects.toMatchObject({ code: 'debug-not-running' })
    await expect(t.svc.variables('1')).rejects.toMatchObject({ code: 'debug-not-running' })
    await expect(t.svc.evaluate('1')).rejects.toMatchObject({ code: 'debug-not-running' })
    t.svc.dispose()

    // Node runs on its own inspector again.
    await t.svc.start({ projectId: 'p', program: 'a.js', breakpoints: [] })
    expect(t.svc.session()?.program).toBe('a.js')
    t.svc.dispose()
  })

  it('Go through Delve (a stand-in here), started the way the app does it', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'main.go'), 'package main\n')
    const sessions: DebugSession[] = []
    const output: DebugOutput[] = []
    const svc = new DebugService({
      resolveRoot: () => root,
      publish: (c, p) => (c === 'debug:session' ? sessions.push(p as DebugSession) : output.push(p as DebugOutput)),
      tools: { locate: async () => join(__dirname, 'fixtures', 'fake-dlv.mjs') }
    })
    await svc.start({ projectId: 'p', program: 'main.go', breakpoints: [] })
    for (let i = 0; i < 200 && sessions.at(-1)?.status !== 'exited'; i += 1) await tick(20)
    expect(sessions.at(-1)).toMatchObject({ status: 'exited', exitCode: 0 })
    expect(output.map((o) => o.text).join('')).toContain('hello from go')
    svc.dispose()
  }, 20_000)

  it('a launch that fails ends the session with the reason', async () => {
    const t = await service('/tools/debugpy', new FakeAdapter({ launch: () => Promise.reject(new Error('cannot run')) }))
    await t.svc.start({ projectId: 'p', program: 'app.py', breakpoints: [] })
    await tick(40)
    expect(t.last()).toMatchObject({ status: 'exited', error: 'cannot run' })
  })
})

describe('starting debug adapters: LLDB, PHP, Java, Kotlin', () => {
  const servers: Server[] = []
  afterEach(() => servers.splice(0).forEach((s) => s.close()))
  const base = { root: '/r', args: ['a b', 'c', 'say "hi"'], debugger: '/dbg', output: () => {} }

  it('C, C++, Rust, Swift and built programs: lldb-dap over stdio, its stderr as output', async () => {
    for (const language of ['cpp', 'rust', 'swift', 'native']) {
      const proc = new FakeProc()
      const out: string[] = []
      const calls: Parameters<Spawn>[] = []
      const { launch } = await startAdapter(language, { ...base, program: '/r/.mindeck/build/app', output: (s, t) => out.push(`${s}:${t}`) }, (...a) => (calls.push(a), proc as never))
      expect(calls[0]).toEqual(['/dbg', [], '/r'])
      expect(launch).toMatchObject({ adapterID: 'lldb-dap', arguments: { program: '/r/.mindeck/build/app', args: base.args, cwd: '/r' } })
      proc.stderr.write('warning: no dSYM\n')
      await tick()
      expect(out).toEqual(['stderr:warning: no dSYM\n'])
      launch.kill()
      expect(proc.killed).toBe(1)
    }
  })

  it('PHP: Xdebug’s adapter on Mindeck’s own Node; php gets Xdebug pointed at the adapter’s port', async () => {
    const proc = new FakeProc()
    const calls: Parameters<Spawn>[] = []
    const { launch } = await startAdapter('php', { ...base, program: '/r/index.php', debugger: '/tools/php-debug/extension/out/phpDebug.js' }, (...a) => (calls.push(a), proc as never))
    expect(calls[0]).toEqual([process.execPath, ['/tools/php-debug/extension/out/phpDebug.js'], '/r', { ELECTRON_RUN_AS_NODE: '1' }])
    expect(launch.arguments).toMatchObject({ type: 'php', program: '/r/index.php', port: 0, runtimeArgs: ['-dxdebug.mode=debug', '-dxdebug.start_with_request=yes', '-dxdebug.client_port=${port}'] })
    launch.kill()
    expect(proc.killed).toBe(1)
  })

  it('Java: jdtls resolves the main class and classpath, then opens the DAP port', async () => {
    const server = createServer((socket) => socket.on('data', (d) => socket.write(d)))
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const asked: [string, unknown[]][] = []
    const command = async (cmd: string, args: unknown[]) => {
      asked.push([cmd, args])
      if (cmd === 'vscode.java.resolveMainClass') return [{ mainClass: 'demo.Other', projectName: 'demo' }, { mainClass: 'demo.App', projectName: 'demo', filePath: '/r/src/App.java' }]
      if (cmd === 'vscode.java.resolveClasspath') return [['/m'], ['/r/bin']]
      return port
    }
    const { transport, launch } = await startAdapter('java', { ...base, program: '/r/src/App.java', command }, () => new FakeProc() as never)
    expect(asked.map((a) => a[0])).toEqual(['vscode.java.resolveMainClass', 'vscode.java.resolveClasspath', 'vscode.java.startDebugSession'])
    expect(asked[0][1]).toEqual(['file:///r'])
    expect(asked[1][1]).toEqual(['demo.App', 'demo'])
    expect(launch.arguments).toMatchObject({ type: 'java', mainClass: 'demo.App', projectName: 'demo', modulePaths: ['/m'], classPaths: ['/r/bin'], args: '"a b" c "say \\"hi\\""', console: 'internalConsole' })
    const echoed = new Promise<string>((r) => transport.onData((d) => r(d.toString())))
    transport.write(Buffer.from('ping'))
    expect(await echoed).toBe('ping')
    launch.kill()

    // Another file: the first main class; none at all: say why.
    const first = await startAdapter('java', { ...base, args: [], program: '/r/src/Util.java', command: async (cmd) => (cmd === 'vscode.java.resolveMainClass' ? [{ mainClass: 'demo.Other' }] : cmd === 'vscode.java.resolveClasspath' ? [[], []] : port) }, () => new FakeProc() as never)
    expect(first.launch.arguments).toMatchObject({ mainClass: 'demo.Other', args: '' })
    first.launch.kill()
    await expect(startAdapter('java', { ...base, program: '/r/A.java', command: async () => null }, () => new FakeProc() as never)).rejects.toMatchObject({ code: 'debug-program' })
  })

  it('Kotlin: the adapter runs the file’s class (package + FileKt)', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'main.kt'), '// demo\npackage com.example.app\n\nfun main() {}\n')
    await writeFile(join(root, 'Tool.kt'), 'fun main() {}\n')
    const proc = new FakeProc()
    const calls: Parameters<Spawn>[] = []
    const { launch } = await startAdapter('kotlin', { ...base, root, program: join(root, 'main.kt'), debugger: '/k/bin/kotlin-debug-adapter' }, (...a) => (calls.push(a), proc as never))
    expect(calls[0]).toEqual(['/k/bin/kotlin-debug-adapter', [], root])
    expect(launch.arguments).toMatchObject({ type: 'kotlin', projectRoot: root, mainClass: 'com.example.app.MainKt' })
    launch.kill()
    expect(proc.killed).toBe(1)
    const plain = await startAdapter('kotlin', { ...base, root, program: join(root, 'Tool.kt') }, () => new FakeProc() as never)
    expect(plain.launch.arguments).toMatchObject({ mainClass: 'ToolKt' })
  })
})

describe('DebugService: compiled languages, the build step, other languages', () => {
  async function setup(files: Record<string, string>, opts: { build?: (ctx: Parameters<NonNullable<ConstructorParameters<typeof DebugService>[0]['build']>>[0]) => Promise<string>; locate?: string } = {}) {
    const root = await realpath(await tempDir())
    for (const [f, text] of Object.entries(files)) await writeFile(join(root, f), text)
    const sessions: DebugSession[] = []
    const output: DebugOutput[] = []
    const adapters: { language: string; program: string; command?: unknown }[] = []
    const executed: unknown[][] = []
    const svc = new DebugService({
      resolveRoot: () => root,
      publish: (c, p) => (c === 'debug:session' ? sessions.push(p as DebugSession) : output.push(p as DebugOutput)),
      tools: { locate: async (language) => (opts.locate === undefined ? `/dbg/${language}` : opts.locate || undefined) },
      build: opts.build,
      lsp: { executeCommand: async (...a) => (executed.push(a), 'ok') },
      adapter: async (language, ctx) => {
        adapters.push({ language, program: ctx.program, command: await ctx.command!('x', [1]) })
        const fake = new FakeAdapter({ launch: (_a, ad) => (setTimeout(() => ad.event('initialized'), 5), {}) })
        return { transport: fake.transport, launch: { adapterID: language, arguments: {}, kill: () => {} } }
      },
      launch: () => new FakeProc() as never
    })
    return { svc, root, sessions, output, adapters, executed }
  }

  it('C: built first (its output in the session), then LLDB runs the result; the session keeps its id', async () => {
    const t = await setup({ 'main.c': 'int main(){}' }, {
      build: async (ctx) => {
        ctx.output('stderr', 'compiling\n')
        expect(ctx).toMatchObject({ language: 'cpp', command: undefined })
        return join(ctx.root, '.mindeck/build/main')
      }
    })
    const started = await t.svc.start({ projectId: 'p', program: 'main.c', breakpoints: [] })
    expect(t.sessions[0]).toMatchObject({ id: started.id, status: 'starting', program: 'main.c' })
    expect(t.output[0]).toEqual({ sessionId: started.id, stream: 'stderr', text: 'compiling\n' })
    expect(t.adapters[0]).toMatchObject({ language: 'cpp', program: join(t.root, '.mindeck/build/main'), command: 'ok' })
    expect(t.executed[0]).toEqual(['p', 'cpp', 'x', [1]])
    t.svc.dispose()
  })

  it('a program without a language is a built one (LLDB, the C / C++ debugger); the build step runs for any language', async () => {
    const t = await setup({ app: '', 'run.py': '' }, { build: async (ctx) => (ctx.command ? `${ctx.program}-built` : ctx.program) })
    await t.svc.start({ projectId: 'p', program: 'app', breakpoints: [] })
    expect(t.adapters[0]).toMatchObject({ language: 'native', program: join(t.root, 'app') })
    await t.svc.start({ projectId: 'p', program: 'run.py', breakpoints: [], build: ' make ' })
    expect(t.adapters[1]).toMatchObject({ language: 'python', program: `${join(t.root, 'run.py')}-built` })
    // Without a build step Python starts right away.
    await t.svc.start({ projectId: 'p', program: 'run.py', breakpoints: [], build: '  ' })
    expect(t.adapters[2].program).toBe(join(t.root, 'run.py'))
    t.svc.dispose()
    const none = await setup({ app: '' }, { locate: '' })
    await expect(none.svc.start({ projectId: 'p', program: 'app', breakpoints: [] })).rejects.toMatchObject({ code: 'debugger-missing', message: expect.stringContaining('C / C++') })
  })

  it('a failed build ends the session with the reason; stopping during the build ends it quietly', async () => {
    const failing = await setup({ 'main.c': '' }, { build: async () => Promise.reject(Object.assign(new Error('Build failed: clang (exit 1)'), { code: 'build-failed' })) })
    expect(await failing.svc.start({ projectId: 'p', program: 'main.c', breakpoints: [] })).toMatchObject({ status: 'exited', error: 'Build failed: clang (exit 1)' })
    expect(failing.adapters).toEqual([])

    let finish!: (v: string) => void
    let signal!: AbortSignal
    const slow = await setup({ 'main.c': '' }, { build: (ctx) => ((signal = ctx.signal), new Promise((r) => (finish = r))) })
    const starting = slow.svc.start({ projectId: 'p', program: 'main.c', breakpoints: [] })
    await tick()
    expect(slow.svc.session()).toMatchObject({ status: 'starting' })
    await slow.svc.stop()
    expect(signal.aborted).toBe(true)
    finish('/built')
    expect(await starting).toMatchObject({ status: 'exited', error: undefined })
    expect(slow.adapters).toEqual([])

    // A build that throws because it was stopped: also quiet.
    let fail!: (e: Error) => void
    const killed = await setup({ 'main.c': '' }, { build: () => new Promise((_r, reject) => (fail = reject)) })
    const run = killed.svc.start({ projectId: 'p', program: 'main.c', breakpoints: [] })
    await tick()
    await killed.svc.stop()
    fail(new Error('Build failed: clang (exit 1)'))
    expect(await run).toMatchObject({ status: 'exited', error: undefined })

    // Started again while building: the first build's end leaves the second one alone.
    const builds: ((v: string) => void)[] = []
    const again = await setup({ 'main.c': '' }, { build: () => new Promise((r) => builds.push(r)) })
    const first = again.svc.start({ projectId: 'p', program: 'main.c', breakpoints: [] })
    await tick()
    const second = again.svc.start({ projectId: 'p', program: 'main.c', breakpoints: [] })
    while (builds.length < 2) await tick()
    builds[0]('/built')
    expect(await first).toMatchObject({ status: 'exited', error: undefined })
    expect(again.svc.session()).toMatchObject({ status: 'starting' })
    builds[1]('/built')
    expect((await second).error).toBeUndefined()
    expect(again.adapters).toHaveLength(1) // only the second build reached the debugger
  })

  it('a built program goes to LLDB as it is (nothing to compile)', async () => {
    const t = await setup({ app: '' })
    await t.svc.start({ projectId: 'p', program: 'app', breakpoints: [] })
    expect(t.adapters[0]).toMatchObject({ language: 'native', program: join(t.root, 'app') })
    t.svc.dispose()
  })

  it('languages without a debugger say so', async () => {
    const t = await setup({ 'run.sh': '' })
    await expect(t.svc.start({ projectId: 'p', program: 'run.sh', breakpoints: [] })).rejects.toMatchObject({ code: 'debug-unsupported', message: "Mindeck can't debug Shell programs yet" })
  })

  it('on macOS a native program that doesn’t start soon gets the permission hint', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const t = await setup({ 'main.c': '' }, { build: async () => '/built' })
      const s = await t.svc.start({ projectId: 'p', program: 'main.c', breakpoints: [] })
      vi.advanceTimersByTime(MAC_HINT_MS)
      expect(t.output.map((o) => o.text)).toContain(MAC_DEBUG_HINT)
      expect(t.output[0].sessionId).toBe(s.id)
      // Once it runs there is nothing to say.
      const quick = await setup({ 'main.c': '' }, { build: async () => '/built' })
      await quick.svc.start({ projectId: 'p', program: 'main.c', breakpoints: [] })
      await vi.advanceTimersByTimeAsync(10)
      vi.advanceTimersByTime(MAC_HINT_MS)
      expect(quick.output.map((o) => o.text)).not.toContain(MAC_DEBUG_HINT)
      t.svc.dispose()
      quick.svc.dispose()
    } finally {
      vi.useRealTimers()
      Object.defineProperty(process, 'platform', platform)
    }
  })
})
