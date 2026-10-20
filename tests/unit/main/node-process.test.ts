import { EventEmitter } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'
import { spawnNode, utilityNode, type UtilityFork } from '../../../electron/main/lib/nodeProcess'
import { runNode } from '../../../electron/main/lib/nodeHost'

const read = (s: Readable) => new Promise<string>((resolve) => {
  let text = ''
  s.on('data', (d: Buffer) => (text += d.toString()))
  s.on('end', () => resolve(text))
})

describe('Node programs on the headless core', () => {
  it('run on this Node (process.execPath), stdin, stdout and stderr piped', async () => {
    const dir = await tempDir()
    const proc = spawnNode(['-e', "process.stdin.on('data', (d) => process.stdout.write(process.env.MINDECK_X + d)); process.stderr.write(process.cwd())"], { cwd: dir, env: { ...process.env, MINDECK_X: 'got:' } as Record<string, string> })
    const out = read(proc.stdout!)
    const err = read(proc.stderr!)
    proc.stdin!.end('ping')
    expect(await out).toBe('got:ping')
    expect(await err).toBe(dir)
  })
})

/** A stand-in Electron utility process. */
class FakeUtility extends EventEmitter {
  stdout: PassThrough | null = new PassThrough()
  stderr: PassThrough | null = new PassThrough()
  posted: unknown[] = []
  kill = vi.fn(() => true)
  postMessage(message: unknown) {
    this.posted.push(message)
  }
}

describe('Node programs in Electron utility processes (the desktop)', () => {
  const setup = (child = new FakeUtility()) => {
    const fork = vi.fn<UtilityFork>(() => child)
    return { child, fork, launch: utilityNode(fork, '/app/out/main/nodeHost.js') }
  }

  it('forks the host with the program’s arguments, its folder, environment and name; unsigned libraries only when asked', () => {
    const { fork, launch } = setup()
    launch(['/ts/tsserver.js', '--x'], { cwd: '/p', env: { A: '1' }, name: 'TypeScript', unsignedLibraries: true })
    launch(['-e', 'code'], { cwd: '/q', env: {} })
    expect(fork.mock.calls).toEqual([
      ['/app/out/main/nodeHost.js', ['/ts/tsserver.js', '--x'], { cwd: '/p', env: { A: '1' }, stdio: 'pipe', serviceName: 'TypeScript', allowLoadingUnsignedLibraries: true }],
      ['/app/out/main/nodeHost.js', ['-e', 'code'], { cwd: '/q', env: {}, stdio: 'pipe', serviceName: 'Node', allowLoadingUnsignedLibraries: false }]
    ])
  })

  it('stdin goes over as messages (null: its end), stdout and stderr come back, kill kills', async () => {
    const { child, launch } = setup()
    const proc = launch(['a.js'], { cwd: '/p', env: {} })
    proc.stdin!.write('{"seq":1}\n')
    proc.stdin!.write(Buffer.from('raw'))
    proc.stdin!.end()
    await new Promise((r) => proc.stdin!.once('finish', r))
    expect(child.posted).toEqual(['{"seq":1}\n', Buffer.from('raw'), null])
    const out = read(proc.stdout!)
    child.stdout!.end('answer')
    expect(await out).toBe('answer')
    expect(proc.kill()).toBe(true)
    expect(child.kill).toHaveBeenCalled()
  })

  it('exit at once, close once stdout and stderr are read to the end (an output error too); nothing is sent after the exit', async () => {
    const { child, launch } = setup()
    const proc = launch(['a.js'], { cwd: '/p', env: {} })
    const events: unknown[][] = []
    proc.on('exit', (...a) => events.push(['exit', ...a]))
    proc.on('close', (...a) => events.push(['close', ...a]))
    proc.stdout!.resume()
    proc.stderr!.resume()
    child.emit('exit', 3)
    expect(events).toEqual([['exit', 3, null]])
    proc.stdin!.write('late')
    proc.stdin!.end()
    await new Promise((r) => proc.stdin!.once('finish', r))
    expect(child.posted).toEqual([])
    child.stdout!.end()
    child.stderr!.destroy(new Error('pipe broke'))
    await vi.waitFor(() => expect(events).toEqual([['exit', 3, null], ['close', 3, null]]))
  })

  it('without output streams: none, and close follows the exit', async () => {
    const child = new FakeUtility()
    child.stdout = null
    child.stderr = null
    const proc = setup(child).launch(['a.js'], { cwd: '/p', env: {} })
    expect(proc.stdout).toBeNull()
    expect(proc.stderr).toBeNull()
    const closed = new Promise((r) => proc.on('close', r))
    child.emit('exit', 0)
    expect(await closed).toBe(0)
  })
})

describe('nodeHost: the program inside the utility process', () => {
  const port = () => {
    const e = new EventEmitter()
    return { on: (event: 'message', fn: (m: { data: unknown }) => void) => e.on(event, fn), send: (data: unknown) => e.emit('message', { data }) }
  }
  const fakeProcess = (cwd: string) => ({ cwd: () => cwd, execPath: '/Mindeck', argv: [] as string[] }) as unknown as NodeJS.Process

  it('runs a script as `node <file> <args…>`, its stdin made of the parent’s messages', async () => {
    const p = port()
    const proc = fakeProcess('/p')
    const runMain = vi.fn()
    runNode(p, ['/ts/tsserver.js', '--flag'], proc, runMain)
    expect(runMain).toHaveBeenCalledWith('/ts/tsserver.js')
    expect(proc.argv).toEqual(['/Mindeck', '/ts/tsserver.js', '--flag'])
    const input = read(proc.stdin)
    p.send('line 1\n')
    p.send(new TextEncoder().encode('line 2\n'))
    p.send(null)
    expect(await input).toBe('line 1\nline 2\n')
  })

  it('runs code as `node -e <code> <args…>`: CommonJS, modules from the working folder', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'dep.js'), 'module.exports = 42')
    const proc = fakeProcess(dir)
    const g = globalThis as { evalled?: unknown }
    runNode(port(), ['-e', 'globalThis.evalled = { dep: require("./dep"), file: __filename, dir: __dirname, same: exports === module.exports }', 'extra'], proc)
    expect(g.evalled).toEqual({ dep: 42, file: join(dir, '[eval]'), dir, same: true })
    expect(proc.argv).toEqual(['/Mindeck', 'extra'])
    delete g.evalled
  })

  it('a script runs as the main module (Node’s own runMain)', async () => {
    const dir = await tempDir()
    const script = join(dir, 'main.js')
    await writeFile(script, 'globalThis.ranAsMain = require.main === module')
    const g = globalThis as { ranAsMain?: unknown }
    runNode(port(), [script], fakeProcess(dir))
    expect(g.ranAsMain).toBe(true)
    delete g.ranAsMain
  })
})

describe('the utility process’s entry (electron/nodeHost.ts)', () => {
  afterEach(() => {
    delete (process as { parentPort?: unknown }).parentPort
    vi.doUnmock('../../../electron/main/lib/nodeHost')
  })

  it('runs the program its arguments name, reading from the parent port', async () => {
    const runNode = vi.fn()
    vi.doMock('../../../electron/main/lib/nodeHost', () => ({ runNode }))
    const parentPort = { on: vi.fn() }
    ;(process as { parentPort?: unknown }).parentPort = parentPort
    await import('../../../electron/nodeHost')
    expect(runNode).toHaveBeenCalledWith(parentPort, process.argv.slice(2))
  })
})
