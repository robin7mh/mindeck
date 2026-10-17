import { EventEmitter } from 'node:events'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'
import { BRIDGE, NotebookService, type NotebookOptions } from '../../../electron/main/services/notebook/NotebookService'
import type { NotebookEvent } from '@shared/types/notebook'

/** A stand-in for Python running the bridge: what it was told, what it prints. */
class FakeProc extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  told: Record<string, unknown>[] = []
  killed = 0
  constructor() {
    super()
    this.stdin.on('data', (d: Buffer) => d.toString().trim().split('\n').forEach((l) => this.told.push(JSON.parse(l))))
  }
  say(...lines: (Record<string, unknown> | string)[]) {
    this.stdout.write(lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
  }
  kill() {
    this.killed += 1
    this.emit('close', null)
    return true
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5))
/** The n-th Python started (file system work comes first, beyond fake timers). */
async function proc(procs: FakeProc[], n: number): Promise<FakeProc> {
  // By the clock, not by turns: under load the start takes more turns of the event loop.
  for (const until = Date.now() + 10_000; !procs[n] && Date.now() < until; ) await new Promise((r) => setImmediate(r))
  return procs[n]
}

function harness(root: string | undefined, behave: (command: string, args: string[], proc: FakeProc) => void = () => {}, trusted = true) {
  const events: NotebookEvent[] = []
  const calls: { command: string; args: string[]; cwd: string }[] = []
  const procs: FakeProc[] = []
  const opts: NotebookOptions = {
    resolveRoot: () => root,
    trusted: () => trusted,
    publish: (e) => events.push(e),
    start: (command, args, cwd) => {
      calls.push({ command, args, cwd })
      const proc = new FakeProc()
      procs.push(proc)
      setTimeout(() => behave(command, args, proc))
      return proc as never
    }
  }
  return { service: new NotebookService(opts), events, calls, procs }
}

afterEach(() => vi.useRealTimers())

describe('NotebookService', () => {
  it('lists the kernels of the project’s Python — or says Jupyter is missing', async () => {
    const root = await realpath(await tempDir())
    let reply: Record<string, unknown> = { type: 'specs', specs: [{ name: 'python3', displayName: 'Python 3', language: 'python' }] }
    const h = harness(root, (_c, _a, p) => {
      p.say('noise', reply)
      p.emit('close', 0)
    })
    expect(await h.service.kernels('p')).toEqual({ python: 'python3', venv: false, ready: true, specs: [{ name: 'python3', displayName: 'Python 3', language: 'python' }] })
    expect(h.calls[0]).toEqual({ command: 'python3', args: ['-c', BRIDGE, 'specs'], cwd: root })
    reply = { type: 'missing' }
    await mkdir(join(root, '.venv/bin'), { recursive: true })
    await writeFile(join(root, '.venv/bin/python'), '')
    expect(await h.service.kernels('p')).toEqual({ python: join(root, '.venv/bin/python'), venv: true, ready: false, specs: [] })
    // A Python that can't start: not ready.
    const broken = harness(root, (_c, _a, p) => p.emit('error', new Error('spawn ENOENT')))
    expect(await broken.service.kernels('p')).toMatchObject({ ready: false, specs: [] })
    await expect(harness(undefined).service.kernels('p')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('sets a project up: a .venv when it has none, ipykernel into it; failures say why', async () => {
    const root = await realpath(await tempDir())
    const h = harness(root, (command, args, p) => {
      if (args.includes('venv')) void mkdir(join(root, '.venv/bin'), { recursive: true }).then(() => writeFile(join(root, '.venv/bin/python'), '')).then(() => (p.say('venv made'), p.emit('close', 0)))
      else (p.stderr.write(`installed via ${command}\n`), p.emit('close', 0))
    })
    expect(await h.service.setup('p')).toBe(`venv made\ninstalled via ${join(root, '.venv/bin/python')}\n`)
    expect(h.calls.map((c) => [c.command, ...c.args])).toEqual([
      ['python3', '-m', 'venv', '.venv'],
      [join(root, '.venv/bin/python'), '-m', 'pip', 'install', '--disable-pip-version-check', 'ipykernel']
    ])
    // With a virtualenv: just the install, which may fail.
    const failing = harness(root, (_c, _a, p) => (p.say('no network'), p.emit('close', 1)))
    await expect(failing.service.setup('p')).rejects.toMatchObject({ code: 'setup-failed', message: 'Installing ipykernel failed:\nno network' })
    const fresh = await realpath(await tempDir())
    const noVenv = harness(fresh, (_c, _a, p) => (p.say('no ensurepip'), p.emit('close', 1)))
    await expect(noVenv.service.setup('p')).rejects.toMatchObject({ code: 'setup-failed', message: 'Creating .venv failed:\nno ensurepip' })
  })

  it('starts a kernel next to the notebook; runs cells; what the kernel says goes out per notebook', async () => {
    const root = await realpath(await tempDir())
    await mkdir(join(root, 'nb'))
    const h = harness(root, (_c, _a, p) => p.say({ type: 'ready' }))
    await h.service.start('p', 'nb/a.ipynb', 'python3')
    expect(h.calls[0]).toEqual({ command: 'python3', args: ['-c', BRIDGE, 'run', 'python3', join(root, 'nb')], cwd: root })
    // The same kernel again: the running one.
    await h.service.start('p', 'nb/a.ipynb', 'python3')
    expect(h.calls).toHaveLength(1)

    await h.service.execute('p', 'nb/a.ipynb', 'c1', 'print(1)')
    h.service.interrupt('p', 'nb/a.ipynb')
    h.service.restart('p', 'nb/a.ipynb')
    expect(h.procs[0].told).toEqual([{ op: 'execute', cell: 'c1', code: 'print(1)' }, { op: 'interrupt' }, { op: 'restart' }])

    // Output arrives in pieces; lines that aren't the bridge's are skipped.
    h.procs[0].stdout.write('{"type":"status","state":"busy"}\n{"type":"output","cell":"c1","out')
    h.procs[0].stdout.write('put":{"output_type":"stream","name":"stdout","text":"1\\n"}}\nWarning: something\n{"no":"type"}\n{"type":"done","cell":"c1"}\n')
    await tick()
    expect(h.events).toEqual([
      { projectId: 'p', path: 'nb/a.ipynb', type: 'status', state: 'starting' },
      { projectId: 'p', path: 'nb/a.ipynb', type: 'status', state: 'busy' },
      { projectId: 'p', path: 'nb/a.ipynb', type: 'output', cell: 'c1', output: { output_type: 'stream', name: 'stdout', text: '1\n' } },
      { projectId: 'p', path: 'nb/a.ipynb', type: 'done', cell: 'c1' }
    ])

    // The kernel ends: it is gone, and says so.
    h.procs[0].emit('close', 0)
    expect(h.events.at(-1)).toMatchObject({ type: 'status', state: 'dead' })
    await expect(h.service.execute('p', 'nb/a.ipynb', 'c1', 'x')).rejects.toMatchObject({ code: 'not-started' })
    expect(() => h.service.interrupt('p', 'nb/a.ipynb')).toThrow('No kernel is running')
  })

  it('another kernel replaces the running one; shutdown asks, then ends it; dispose ends all', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const root = await realpath(await tempDir())
    const h = harness(root)
    const first = h.service.start('p', 'a.ipynb', 'python3')
    ;(await proc(h.procs, 0)).say({ type: 'ready' })
    await first
    const second = h.service.start('p', 'a.ipynb', 'ir')
    await proc(h.procs, 1)
    expect(h.procs[0].told).toEqual([{ op: 'shutdown' }])
    expect(h.calls[1].args[3]).toBe('ir')
    // The old one didn't stop by itself: ended.
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.procs[0].killed).toBe(1)
    h.procs[1].say({ type: 'ready' })
    await second
    // One that stops when asked isn't killed.
    h.service.shutdown('p', 'a.ipynb')
    h.procs[1].emit('close', 0)
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.procs[1].killed).toBe(0)
    h.service.shutdown('p', 'a.ipynb')

    const third = h.service.start('p', 'b.ipynb', 'python3')
    ;(await proc(h.procs, 2)).say({ type: 'ready' })
    await third
    h.service.dispose()
    expect(h.procs[2].told).toEqual([{ op: 'shutdown' }])
  })

  it('a kernel that can’t start says why: Jupyter missing, the kernel failing, Python not there, too slow', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const root = await realpath(await tempDir())
    const h = harness(root)
    let n = 0
    const start = (path: string) => {
      const p = h.service.start('p', path, 'python3')
      const at = n++
      return { p, proc: () => proc(h.procs, at) }
    }
    let s = start('a.ipynb')
    ;(await s.proc()).say({ type: 'missing' })
    await expect(s.p).rejects.toMatchObject({ code: 'kernel-missing' })
    s = start('b.ipynb')
    ;(await s.proc()).say({ type: 'failed', message: 'NoSuchKernel: ir' })
    await expect(s.p).rejects.toMatchObject({ code: 'kernel-failed', message: 'NoSuchKernel: ir' })
    s = start('c.ipynb')
    ;(await s.proc()).emit('error', new Error('spawn python3 ENOENT'))
    await expect(s.p).rejects.toMatchObject({ code: 'kernel-failed', message: 'spawn python3 ENOENT' })
    s = start('d.ipynb')
    const d = await s.proc()
    d.stderr.write('Traceback: boom\n')
    await new Promise((r) => setImmediate(r))
    d.emit('close', 1)
    await expect(s.p).rejects.toMatchObject({ code: 'kernel-failed', message: 'Traceback: boom' })
    s = start('e.ipynb')
    ;(await s.proc()).emit('close', 1)
    await expect(s.p).rejects.toMatchObject({ message: 'The kernel stopped' })
    s = start('f.ipynb')
    const late = expect(s.p).rejects.toMatchObject({ code: 'kernel-timeout' })
    await s.proc()
    await vi.advanceTimersByTimeAsync(120_000)
    await late
    // Running cells waits for a start; a failed start fails them too.
    const g = start('g.ipynb')
    const gp = await g.proc()
    const run = h.service.execute('p', 'g.ipynb', 'c', 'x')
    gp.say({ type: 'missing' })
    await expect(run).rejects.toMatchObject({ code: 'kernel-missing' })
    await expect(g.p).rejects.toBeTruthy()
  })

  it('without a stand-in, the user’s Python runs the bridge through their shell', { timeout: 30_000 }, async () => {
    const root = await realpath(await tempDir())
    const info = await new NotebookService({ resolveRoot: () => root, trusted: () => true, publish: () => {} }).kernels('p')
    // Whatever this machine has: Jupyter or not, an answer.
    expect(info).toMatchObject({ python: 'python3', venv: false, ready: expect.any(Boolean) })
  })

  it('a project that isn’t trusted: no Python starts in it (its .venv, a json.py next to it), not even to list the kernels', async () => {
    const root = await realpath(await tempDir())
    const h = harness(root, (_c, _a, p) => p.say({ type: 'ready' }), false)
    await expect(h.service.kernels('p')).rejects.toMatchObject({ code: 'untrusted' })
    await expect(h.service.setup('p')).rejects.toMatchObject({ code: 'untrusted' })
    await expect(h.service.start('p', 'x.ipynb', 'python3')).rejects.toMatchObject({ code: 'untrusted' })
    await expect(new NotebookService({ resolveRoot: () => root, publish: () => {} }).kernels('p')).rejects.toMatchObject({ code: 'untrusted' })
    expect(h.calls).toEqual([])
  })

  it('notebooks only inside the project; a folder that isn’t there runs in the project', async () => {
    const root = await realpath(await tempDir())
    const h = harness(root, (_c, _a, p) => p.say({ type: 'ready' }))
    await expect(h.service.start('p', '../x.ipynb', 'python3')).rejects.toMatchObject({ code: 'not-found' })
    await h.service.start('p', 'gone/x.ipynb', 'python3')
    expect(h.calls[0].args[4]).toBe(root)
  })
})
