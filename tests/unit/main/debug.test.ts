import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from './helpers'
import { WebSocketServer } from 'ws'
import { connectCdp, describe as describeValue, DebugService, launchNode, nodeCommand, type Cdp } from '../../../electron/main/services/debug/DebugService'
import type { DebugOutput, DebugSession } from '@shared/types/debug'

const PROGRAM = `function add(a, b) {
  const sum = a + b
  return sum
}
const user = { name: 'Ada', tags: ['x'] }
console.log('start')
const total = add(2, 3)
console.error('warn', total)
`

/** The service with real Node (this test runner's), recording what it publishes. */
function harness(root: string | undefined) {
  const sessions: DebugSession[] = []
  const output: DebugOutput[] = []
  const service = new DebugService({
    resolveRoot: () => root,
    publish: (channel, payload) => (channel === 'debug:session' ? sessions.push(payload as DebugSession) : output.push(payload as DebugOutput)),
    launch: (args, cwd) => spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  })
  const until = async (pred: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timed out; sessions: ${JSON.stringify(sessions.map((s) => s.status))}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  const last = () => sessions[sessions.length - 1]
  return { service, sessions, output, until, last }
}

const services: DebugService[] = []
afterEach(() => services.splice(0).forEach((s) => s.dispose()))

describe('DebugService (real node --inspect)', () => {
  it('stops at breakpoints, shows frames and scopes, steps, evaluates, and runs to the end', { timeout: 30_000 }, async () => {
    const root = await tempDir('mindeck-debug-')
    await writeFile(join(root, 'app.js'), PROGRAM)
    const h = harness(root)
    services.push(h.service)
    const started = await h.service.start({ projectId: 'p', program: 'app.js', breakpoints: [{ path: 'app.js', line: 2 }, { path: '../outside.js', line: 1 }] })
    expect(started).toMatchObject({ projectId: 'p', program: 'app.js', status: 'starting' })
    expect(h.service.session()?.id).toBe(started.id)

    await h.until(() => h.last().status === 'paused')
    const paused = h.last()
    expect(paused.reason).toBe('breakpoint')
    expect(paused.frames[0]).toMatchObject({ name: 'add', path: 'app.js', line: 2 })
    expect(paused.frames.some((f) => f.path === undefined)).toBe(true) // Node's own loader frames
    const local = paused.frames[0].scopes.find((s) => s.type === 'local')!
    const vars = await h.service.variables(local.objectId!)
    expect(vars.find((v) => v.name === 'a')).toEqual({ name: 'a', value: '2', type: 'number' })

    expect(await h.service.evaluate('a * 10', paused.frames[0].id)).toEqual({ name: 'a * 10', value: '20', type: 'number' })
    expect(await h.service.evaluate('nope', paused.frames[0].id)).toMatchObject({ type: 'error', value: expect.stringContaining('ReferenceError') })
    expect(await h.service.evaluate('1 + 1')).toEqual({ name: '1 + 1', value: '2', type: 'number' }) // global scope
    const user = await h.service.evaluate('user', paused.frames[1].id) // the module code that called add()
    expect(user).toMatchObject({ type: 'object', value: 'Object' })
    const props = await h.service.variables(user.objectId!)
    expect(props.map((p) => `${p.name}=${p.value}`)).toEqual(['name="Ada"', 'tags=Array(1)'])

    await h.service.control('stepOver')
    await h.until(() => h.last().status === 'paused' && h.last().frames[0].line === 3)
    expect(h.last().reason).toBe('step')

    await h.service.setBreakpoints('p', []) // no more stops
    await h.service.setBreakpoints('other', [{ path: 'app.js', line: 1 }]) // another project: ignored
    await h.service.control('continue')
    await h.until(() => h.last().status === 'exited')
    expect(h.last()).toMatchObject({ exitCode: 0, frames: [] })
    const out = h.output.map((o) => `${o.stream}:${o.text}`).join('')
    expect(out).toContain('stdout:start\n')
    expect(out).toContain('stderr:warn 5\n')
    expect(out).toContain('info:exit 0\n')
    expect(out).not.toContain('Debugger')
    await expect(h.service.control('continue')).rejects.toMatchObject({ code: 'debug-not-running' })
    await h.service.setBreakpoints('p', [])
    await h.service.stop() // already over
  })

  it('stops on entry when asked, pauses on uncaught exceptions, stops a running program', { timeout: 30_000 }, async () => {
    const root = await tempDir('mindeck-debug-')
    await writeFile(join(root, 'boom.mjs'), `const x = 1\nsetTimeout(() => {\n  throw new Error('boom ' + x)\n}, 0)\n`)
    await writeFile(join(root, 'loop.js'), `setInterval(() => {}, 1000)\n`)
    const h = harness(root)
    services.push(h.service)
    await h.service.start({ projectId: 'p', program: 'boom.mjs', stopOnEntry: true, breakpoints: [] })
    await h.until(() => h.last().status === 'paused')
    expect(h.last().frames[0]).toMatchObject({ path: 'boom.mjs', line: 1 })
    await h.service.control('continue')
    await h.until(() => h.last().status === 'paused' && h.last().reason === 'exception')
    expect(h.last().exception).toContain('Error: boom 1')
    expect(h.last().frames[0]).toMatchObject({ path: 'boom.mjs', line: 3 }) // an ES module: file URLs map back too

    // A new start ends the old session first.
    await h.service.start({ projectId: 'p', program: 'loop.js', breakpoints: [] })
    await h.until(() => h.last().status === 'running')
    await h.service.control('pause')
    await h.until(() => h.last().status === 'paused')
    await h.service.stop()
    expect(h.last().status).toBe('exited')
  })

  it('runs TypeScript directly: Node strips the types, breakpoints still match', { timeout: 30_000 }, async () => {
    const root = await tempDir('mindeck-debug-')
    await writeFile(join(root, 'typed.ts'), `interface P {\n  x: number\n}\nconst p: P = { x: 3 }\nconsole.log('x', p.x)\n`)
    const h = harness(root)
    services.push(h.service)
    await h.service.start({ projectId: 'p', program: 'typed.ts', breakpoints: [{ path: 'typed.ts', line: 5 }] })
    await h.until(() => h.last().status === 'paused')
    expect(h.last().frames[0]).toMatchObject({ path: 'typed.ts', line: 5 })
    expect(await h.service.evaluate('p.x', h.last().frames[0].id)).toMatchObject({ value: '3' })
    await h.service.control('continue')
    await h.until(() => h.last().status === 'exited')
    expect(h.output.map((o) => o.text).join('')).toContain('x 3')
  })

  it('refuses unknown projects and paths outside; reports a program that cannot start', async () => {
    const root = await tempDir()
    const h = harness(root)
    await expect(harness(undefined).service.start({ projectId: 'p', program: 'a.js', breakpoints: [] })).rejects.toMatchObject({ code: 'not-found' })
    await expect(h.service.start({ projectId: 'p', program: '../a.js', breakpoints: [] })).rejects.toMatchObject({ code: 'outside-project' })
    expect(h.service.session()).toBeNull()
    await h.service.stop() // nothing running
    h.service.dispose()
    await expect(h.service.variables('x')).rejects.toMatchObject({ code: 'debug-not-running' })

    const broken = new DebugService({
      resolveRoot: () => root,
      publish: (channel, payload) => channel === 'debug:session' && h.sessions.push(payload as DebugSession),
      launch: () => spawn('/definitely/not/node', [], { stdio: ['ignore', 'pipe', 'pipe'] })
    })
    await broken.start({ projectId: 'p', program: 'a.js', breakpoints: [] })
    await h.until(() => h.last().status === 'exited')
    expect(h.last().error).toContain('ENOENT')
  })

  it('launchNode runs the user’s node through their login shell', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'v.js'), `console.log('v=' + process.version)\n`)
    const proc = launchNode(['v.js'], root)
    let out = ''
    proc.stdout!.on('data', (d: Buffer) => (out += d.toString()))
    await new Promise((r) => proc.on('exit', r))
    expect(out).toMatch(/^v=v\d+/)
  }, 20_000)
})

/** A scripted inspector for what real Node rarely does. */
function fakeRun(onSend: (method: string, params: Record<string, unknown>) => unknown = () => ({})) {
  const handlers = new Map<string, ((p: never) => void)[]>()
  const cdp: Cdp & { emit: (event: string, params: unknown) => void; closed: number } = {
    closed: 0,
    send: async (method, params = {}) => onSend(method, params as Record<string, unknown>) as never,
    on: (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    close: () => (cdp.closed += 1),
    emit: (event, params) => handlers.get(event)?.forEach((fn) => fn(params as never))
  }
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => true })
  return { cdp, proc }
}

describe('DebugService edge cases', () => {
  it('a failed connection, odd frames, getters, and stderr noise split across chunks', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'a.js'), '')
    const sessions: DebugSession[] = []
    const output: DebugOutput[] = []
    const { cdp, proc } = fakeRun((method) => {
      if (method === 'Runtime.getProperties') return { result: [{ name: 'g', get: { type: 'function' } }, { name: 'v', value: { type: 'number', value: 1, description: '1' } }, { name: 'skip' }] }
      if (method === 'Debugger.setBreakpointByUrl') throw new Error('bad')
      return {}
    })
    let connects = 0
    const service = new DebugService({
      resolveRoot: () => root,
      publish: (c, p) => (c === 'debug:session' ? sessions.push(p as DebugSession) : output.push(p as DebugOutput)),
      launch: () => proc as never,
      connect: async () => {
        connects += 1
        if (connects === 1) throw new Error('refused')
        return cdp
      }
    })
    await service.start({ projectId: 'p', program: 'a.js', breakpoints: [{ path: 'a.js', line: 1 }] })
    proc.stderr.write('Debugger listening on ws://x/1\n')
    await new Promise((r) => setTimeout(r, 10))
    expect(sessions[sessions.length - 1].error).toBe('refused')
    proc.stderr.write('Debugger listening on ws://x/2\nFor help, see: https://nodejs.org/en/docs/inspector\nhalf a li')
    await new Promise((r) => setTimeout(r, 10))
    cdp.emit('Debugger.paused', { reason: 'Break on start', callFrames: [] })
    cdp.emit('Debugger.scriptParsed', { scriptId: '7', url: '' })
    cdp.emit('Debugger.paused', {
      reason: 'exception',
      callFrames: [{ callFrameId: 'f', functionName: '', location: { scriptId: '7', lineNumber: 0 }, scopeChain: [{ type: 'global', object: {} }] }]
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(sessions[sessions.length - 1]).toMatchObject({ status: 'paused', reason: 'exception', exception: undefined, frames: [{ name: '(anonymous)', url: '', column: 1, path: undefined }] })
    cdp.emit('Debugger.paused', { reason: 'other', callFrames: [{ callFrameId: 'f', functionName: 'x', url: 'node:internal/x', location: { scriptId: '1', lineNumber: 0 }, scopeChain: [] }] })
    await new Promise((r) => setTimeout(r, 10))
    expect(sessions[sessions.length - 1].frames[0].path).toBeUndefined()
    expect(await service.variables('o')).toEqual([
      { name: 'g', value: '(getter)', type: 'accessor' },
      { name: 'v', value: '1', type: 'number' }
    ])
    // Node's inspector chatter, whichever order it ends in, stays out of the program's output.
    proc.stderr.write('ne\nDebugger ending on ws://x/2\nWaiting for the debugger to disconnect...\n')
    await new Promise((r) => setTimeout(r, 10))
    expect(cdp.closed).toBe(1)
    proc.stderr.write('tail without newline')
    proc.emit('exit', 1)
    expect(output.map((o) => o.text)).toEqual(['half a line\n', 'tail without newline', 'exit 1\n'])
    proc.emit('exit', 1)
  })

  it('a stop waits for the process; dispose without a session is fine', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'a.js'), '')
    const { proc } = fakeRun()
    const service = new DebugService({ resolveRoot: () => root, publish: () => {}, launch: () => proc as never })
    service.dispose()
    await service.start({ projectId: 'p', program: 'a.js', breakpoints: [] })
    const stopping = service.stop()
    proc.emit('exit', null)
    await stopping
    expect(service.session()?.status).toBe('exited')
    service.dispose()
  })

  it('a program that opens the inspector in its worker (Vitest): no --inspect-brk for the program itself', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'a.js'), '')
    const { proc } = fakeRun()
    const launched: string[][] = []
    const service = new DebugService({ resolveRoot: () => root, publish: () => {}, launch: (args) => (launched.push(args), proc as never) })
    await service.start({ projectId: 'p', program: 'a.js', args: ['run'], breakpoints: [], inspectChild: true })
    expect(launched[0]).toEqual([join(await realpath(root), 'a.js'), 'run'])
    service.dispose()
  })

  it('describes values like the console', () => {
    expect(describeValue({ type: 'undefined' })).toBe('undefined')
    expect(describeValue({ type: 'number', unserializableValue: 'NaN' })).toBe('NaN')
    expect(describeValue({ type: 'string', value: 'a"b' })).toBe('"a\\"b"')
    expect(describeValue({ type: 'object', subtype: 'null', value: null })).toBe('null')
    expect(describeValue({ type: 'boolean', value: true })).toBe('true')
    expect(describeValue({ type: 'function', description: 'function f() {}' })).toBe('function f() {}')
  })


  it('evaluation errors without an exception object, frames at the project root, a stop of a process already signalled', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'a.js'), '')
    const sessions: DebugSession[] = []
    const { cdp, proc } = fakeRun((method) => (method === 'Runtime.evaluate' ? { result: { type: 'undefined' }, exceptionDetails: { text: 'Uncaught' } } : {}))
    const service = new DebugService({ resolveRoot: () => root, publish: (c, p) => c === 'debug:session' && sessions.push(p as DebugSession), launch: () => proc as never, connect: async () => cdp })
    await service.start({ projectId: 'p', program: 'a.js', breakpoints: [] })
    proc.stderr.write('Debugger listening on ws://x/1\n')
    await new Promise((r) => setTimeout(r, 10))
    expect(await service.evaluate('x')).toEqual({ name: 'x', value: 'Uncaught', type: 'error' })
    cdp.emit('Debugger.paused', { reason: 'Break on start', callFrames: [] })
    const { realpath } = await import('node:fs/promises')
    cdp.emit('Debugger.paused', { reason: 'other', callFrames: [{ callFrameId: 'f', functionName: 'x', url: await realpath(root), location: { scriptId: '1', lineNumber: 0 }, scopeChain: [] }] })
    await new Promise((r) => setTimeout(r, 10))
    expect(sessions[sessions.length - 1].frames[0].path).toBeUndefined() // the folder itself is no file
    Object.assign(proc, { signalCode: 'SIGTERM' })
    await service.stop()
  })
})

describe('DebugService · an inspector that refuses', () => {
  it('a refused resume at the start or a breakpoint that won\'t go is no error', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'a.js'), '')
    const sent: string[] = []
    const { cdp, proc } = fakeRun((method) => {
      sent.push(method)
      if (method === 'Debugger.setBreakpointByUrl') return { breakpointId: `bp-${sent.length}` }
      if (method === 'Debugger.removeBreakpoint' || method === 'Debugger.resume') throw new Error('gone')
      return {}
    })
    const sessions: DebugSession[] = []
    const service = new DebugService({ resolveRoot: () => root, publish: (c, p) => c === 'debug:session' && sessions.push(p as DebugSession), launch: () => proc as never, connect: async () => cdp })
    await service.start({ projectId: 'p', program: 'a.js', breakpoints: [{ path: 'a.js', line: 1 }] })
    proc.stderr.write('Debugger listening on ws://x/1\n')
    await new Promise((r) => setTimeout(r, 10))
    cdp.emit('Debugger.paused', { reason: 'Break on start', callFrames: [] })
    await new Promise((r) => setTimeout(r, 10))
    expect(sent).toContain('Debugger.resume')
    await service.setBreakpoints('p', [{ path: 'a.js', line: 2 }])
    expect(sent.filter((m) => m === 'Debugger.removeBreakpoint')).toHaveLength(1)
    expect(sent.filter((m) => m === 'Debugger.setBreakpointByUrl')).toHaveLength(2)
    expect(sessions.at(-1)?.error).toBeUndefined()
    service.dispose()
  })
})

describe('the inspector connection', () => {
  it('requests, errors, events; a closed connection rejects what is pending and what comes after', async () => {
    const server = new WebSocketServer({ port: 0 })
    await new Promise((r) => server.once('listening', r))
    const port = (server.address() as { port: number }).port
    server.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { id: number; method: string }
        if (msg.method === 'ok') socket.send(JSON.stringify({ id: msg.id, result: { fine: true } }))
        if (msg.method === 'bad') socket.send(JSON.stringify({ id: msg.id, error: { message: 'no such method' } }))
        if (msg.method === 'ping') socket.send(JSON.stringify({ method: 'Debugger.paused', params: { reason: 'x' } }))
        if (msg.method === 'quit') socket.close()
      })
    )
    const cdp = await connectCdp(`ws://127.0.0.1:${port}`)
    expect(await cdp.send('ok')).toEqual({ fine: true })
    await expect(cdp.send('bad', { a: 1 })).rejects.toMatchObject({ code: 'debug', message: 'no such method' })
    const events: unknown[] = []
    cdp.on('Debugger.paused', (p) => events.push(p))
    cdp.on('Debugger.paused', () => events.push('second'))
    const unanswered = cdp.send('ping') // never answered — but the event arrives
    await new Promise((r) => setTimeout(r, 50))
    const closed = new Promise((r) => cdp.on('close', r))
    const hanging = cdp.send('quit')
    await expect(hanging).rejects.toMatchObject({ code: 'debug-closed' })
    await expect(unanswered).rejects.toMatchObject({ code: 'debug-closed' })
    await closed
    expect(events).toEqual([{ reason: 'x' }, 'second'])
    await expect(cdp.send('ok')).rejects.toMatchObject({ code: 'debug-closed' })
    cdp.close()
    server.close()
    await expect(connectCdp('ws://127.0.0.1:1')).rejects.toBeTruthy()
  })

  it('node through the user’s shell on macOS / Linux, PowerShell on Windows', () => {
    expect(nodeCommand(['--inspect-brk=127.0.0.1:0', 'my app.js'], 'darwin').args).toEqual(['-lc', "exec node --inspect-brk=127.0.0.1:0 'my app.js'"])
    expect(nodeCommand(['a.js'], 'win32').args).toEqual(['-NoLogo', '-Command', 'node a.js'])
  })
})
