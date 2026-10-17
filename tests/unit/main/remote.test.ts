import { EventEmitter } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'
import { archOf, coreCommand, defaultDevcontainer, hostArgs, pairingCode, parseSshConfig, RemoteService, type RemoteOptions } from '../../../electron/main/services/remote/RemoteService'
import type { RemoteConnection } from '@shared/types/remote'

/** A stand-in child process: scripted output, an exit code, kill. */
class FakeProc extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  constructor(public line: string) {
    super()
  }
  finish(code: number | null, out = '', err = '') {
    if (out) this.stdout.write(out)
    if (err) this.stderr.write(err)
    setTimeout(() => this.emit('close', code), 5)
  }
  kill() {
    if (this.killed) return true
    this.killed = true
    this.emit('exit', null)
    this.emit('close', null)
    return true
  }
}

type Script = (p: FakeProc) => void
const banner = (port = 1) => `[server] Mindeck 0.1.0 listening on http://127.0.0.1:${port}\n  │  Code:  PAIR-1   (valid 10 minutes, one use)\n`

/** The other machine: what each command line does there. */
function machine(over: Partial<Record<'probe' | 'install' | 'core' | 'pair' | 'up' | 'pipe', Script>> = {}) {
  const procs: FakeProc[] = []
  const scripts: Record<string, Script> = {
    probe: (p) => p.finish(0, 'aarch64\n'),
    install: (p) => {
      let bytes = 0
      p.stdin.on('data', (d: Buffer) => (bytes += d.length))
      p.stdin.on('end', () => p.finish(bytes > 0 ? 0 : 9))
    },
    core: (p) => setTimeout(() => p.stdout.write(banner()), 5),
    pair: (p) => p.finish(0, '  │  Code:  PAIR-2\n'),
    up: (p) => p.finish(0, 'log line\n{"outcome":"success","containerId":"c0ffee","remoteUser":"node","remoteWorkspaceFolder":"/workspaces/app"}\n'),
    pipe: (p) => p.stdin.pipe(p.stdout),
    ...over
  }
  const start: RemoteOptions['start'] = (command, args, env) => {
    const line = [command, ...args].join(' ')
    const p = new FakeProc(line)
    p.envUsed = env
    procs.push(p)
    const kind = line.includes('uname -m')
      ? 'probe'
      : line.includes('tar xzf')
        ? 'install'
        : line.includes(' pair')
          ? 'pair'
          : line.includes('exec ./node out/server/index.cjs')
            ? 'core'
            : line.includes('devcontainer')
              ? 'up'
              : 'pipe'
    queueMicrotask(() => scripts[kind](p))
    return p as never
  }
  return { start, procs, find: (part: string) => procs.filter((p) => p.line.includes(part)) }
}
declare module 'node:events' {
  interface EventEmitter {
    envUsed?: Record<string, string>
  }
}

/** The remote core's HTTP API through the tunnel. */
function api(opts: { tokenOk?: boolean; pair?: 'ok' | 'refuse'; adopt?: 'ok' | 'fail' | 'garbage'; addFails?: boolean } = {}) {
  const calls: { url: string; body: unknown; auth?: string }[] = []
  const fetch = vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body, auth: init.headers.authorization })
    const reply = (data: unknown) => ({ status: 200, json: async () => data })
    if (url.endsWith('/api/pair')) return opts.pair === 'refuse' ? reply({ ok: false, error: { message: 'Code expired' } }) : reply({ ok: true, data: { token: 'tok-new', device: { id: 'dev-new' } } })
    if (url.endsWith('/api/rpc/app:info')) return reply(opts.tokenOk ? { ok: true, data: {} } : { ok: false, error: { message: 'unauthorized' } })
    if (url.endsWith('/api/rpc/projects:add') && opts.addFails) return reply({ ok: false, error: { message: 'Folder not found' } })
    if (url.endsWith('/api/rpc/cloud:adopt')) {
      if (opts.adopt === 'garbage') return { status: 502, json: async () => Promise.reject(new Error('not json')) }
      return reply(opts.adopt === 'fail' ? { ok: false, error: { message: 'bad-entitlement' } } : { ok: true, data: {} })
    }
    return reply({ ok: true, data: {} })
  })
  return { fetch, calls }
}

const services: RemoteService[] = []
afterEach(() => services.splice(0).forEach((s) => s.dispose()))

async function setup(o: { machine?: ReturnType<typeof machine>; api?: ReturnType<typeof api>; saved?: string; entitlement?: boolean; window?: boolean; licensed?: boolean } = {}) {
  const dir = await tempDir('mindeck-remote-')
  const bundle = join(dir, 'pkg.tar.gz')
  await writeFile(bundle, 'TARBALL')
  const m = o.machine ?? machine()
  const a = o.api ?? api()
  const secrets = new Map<string, string>(o.saved ? [['remote.ssh:box', o.saved]] : [])
  const published: RemoteConnection[][] = []
  const windows: { title: string; url: string; token: string; deviceId: string; close: ReturnType<typeof vi.fn>; shut: () => void }[] = []
  const svc = new RemoteService({
    version: '0.1.0',
    licensed: o.licensed ?? true,
    deviceName: 'Studio',
    bundle: vi.fn(async () => bundle),
    secrets: { get: async (k) => secrets.get(k), set: async (k, v) => void (v === null ? secrets.delete(k) : secrets.set(k, v)) },
    entitlement: () => (o.entitlement === false ? null : { token: 'ent', account: { email: 'r@mindeck.test', name: null } }),
    openWindow:
      o.window === false
        ? undefined
        : (w) => {
            let shut!: () => void
            const closed = new Promise<void>((r) => (shut = r))
            const entry = { ...w, close: vi.fn(), shut }
            windows.push(entry)
            return { closed, close: entry.close }
          },
    publish: (list) => published.push(list),
    sshConfig: join(dir, 'ssh_config'),
    devcontainer: (root) => ['devcontainer', ['up', '--workspace-folder', root], { X: '1' }],
    start: m.start,
    fetch: a.fetch as never,
    licenseMs: 20,
    timeoutMs: 400
  })
  services.push(svc)
  return { svc, m, a, secrets, published, windows, dir }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe('remote helpers', () => {
  it('reads concrete hosts from an ssh config (patterns and Match blocks left out)', () => {
    const text = `# mine
Host build-box db
  HostName 10.0.0.5
  User robin
  Port 2222
  IdentityFile ~/.ssh/id_box
Host *.internal
  User nobody
Host=pi raspberry
  HostName pi.local # comment
Match host x
  User skipped
`
    expect(parseSshConfig(text)).toEqual([
      { name: 'build-box', hostName: '10.0.0.5', user: 'robin', port: 2222 },
      { name: 'db', hostName: '10.0.0.5', user: 'robin', port: 2222 },
      { name: 'pi', hostName: 'pi.local' },
      { name: 'raspberry', hostName: 'pi.local' }
    ])
  })

  it('architectures, host arguments, pairing codes, the start command', () => {
    expect(['x86_64', 'amd64', 'aarch64', 'arm64\n', 'riscv64'].map(archOf)).toEqual(['x64', 'x64', 'arm64', 'arm64', undefined])
    expect(hostArgs('robin@box:2222')).toEqual(['-p', '2222', 'robin@box'])
    expect(hostArgs('box:22')).toEqual(['-p', '22', 'box'])
    expect(hostArgs('build-box')).toEqual(['build-box'])
    expect(pairingCode('…│  Code:  AB12CD   (valid…')).toBe('AB12CD')
    expect(pairingCode('nothing')).toBeUndefined()
    expect(coreCommand('1.2.3', 4000, true)).toBe(
      'cd "$HOME/.mindeck-server/1.2.3" && MINDECK_HOME="$HOME/.mindeck" MINDECK_PORT=4000 MINDECK_REMOTE_TERMINAL=1 MINDECK_EXIT_WITH_STDIN=1 MINDECK_LICENSE=follower NODE_ENV=production exec ./node out/server/index.cjs'
    )
    expect(coreCommand('1.2.3', 4000, false)).not.toContain('follower')
    expect(defaultDevcontainer('/p')).toEqual([process.execPath, [expect.stringMatching(/@devcontainers[/\\]cli[/\\]devcontainer\.js$/), 'up', '--workspace-folder', '/p'], { ELECTRON_RUN_AS_NODE: '1' }])
  })
})

describe('Remote-SSH', () => {
  it('lists the ssh config’s hosts (none without one)', async () => {
    const t = await setup()
    expect(await t.svc.hosts()).toEqual([])
    await writeFile(join(t.dir, 'ssh_config'), 'Host box\n  HostName 1.2.3.4\n')
    expect(await t.svc.hosts()).toEqual([{ name: 'box', hostName: '1.2.3.4' }])
  })

  it('first time: installs Mindeck there, starts it behind a tunnel, pairs, hands the license over, opens a window', async () => {
    const remote: Parameters<typeof api>[0] = {}
    const t = await setup({ api: api(remote) })
    const c = await t.svc.ssh('box')
    expect(c).toMatchObject({ id: 'ssh:box', kind: 'ssh', label: 'box', state: 'ready', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) })
    expect(t.published.map((l) => l[0].state)).toEqual(['connecting', 'installing', 'starting', 'ready'])
    const core = t.m.find('exec ./node')[0]
    expect(core.line).toMatch(/^ssh -o BatchMode=yes .* -F .*ssh_config -o ExitOnForwardFailure=yes -L 127\.0\.0\.1:\d+:127\.0\.0\.1:\d+ box cd "\$HOME/)
    expect(core.line).toContain('MINDECK_LICENSE=follower')
    expect(t.a.calls.find((x) => x.url.endsWith('/api/pair'))!.body).toEqual({ code: 'PAIR-1', name: 'Mindeck Desktop · Studio' })
    expect(JSON.parse(t.secrets.get('remote.ssh:box')!)).toEqual({ token: 'tok-new', deviceId: 'dev-new' })
    expect(t.a.calls.find((x) => x.url.endsWith('cloud:adopt'))).toMatchObject({ auth: 'Bearer tok-new', body: { token: 'ent' } })
    expect(t.windows[0]).toMatchObject({ title: 'SSH: box', url: c.url, token: 'tok-new', deviceId: 'dev-new' })
    // The license goes over again now and then.
    await tick(60)
    expect(t.a.calls.filter((x) => x.url.endsWith('cloud:adopt')).length).toBeGreaterThan(1)
    // A handover that fails later keeps the connection.
    remote.adopt = 'fail'
    await tick(60)
    expect(t.svc.list()[0].state).toBe('ready')
    // Connecting again while it runs: the same connection.
    expect(await t.svc.ssh('box')).toBe(c)
    expect(t.svc.list()).toHaveLength(1)
    // Closing the window ends it — the core goes with the ssh process.
    t.windows[0].shut()
    await tick()
    expect(t.svc.list()[0].state).toBe('closed')
    expect(core.killed).toBe(true)
  })

  it('again: nothing to install, the saved pairing works, no license to hand over; a window that won’t open', async () => {
    const m = machine({ probe: (p) => p.finish(0, 'x86_64\n0.1.0\n'), core: (p) => p.stdout.write('[server] Mindeck 0.1.0 listening on http://127.0.0.1:1\n') })
    const t = await setup({ machine: m, api: api({ tokenOk: true }), saved: JSON.stringify({ token: 'tok-old', deviceId: 'dev-old' }), entitlement: false, window: false, licensed: false })
    await t.svc.ssh('box')
    expect(m.find('tar xzf')).toEqual([])
    expect(t.a.calls.map((x) => x.url.split('/api/')[1])).toEqual(['rpc/app:info'])
    expect(m.find('exec ./node')[0].line).not.toContain('follower')
    expect(t.windows).toEqual([])
    await t.svc.disconnect('ssh:box')
    await t.svc.disconnect('nope')
    expect(t.svc.list()[0].state).toBe('closed')
  })

  it('a pairing the core forgot: a new code from `pair`; no code, or a refused one, fails', async () => {
    const saved = JSON.stringify({ token: 'tok-old', deviceId: 'dev-old' })
    const quiet = machine({ core: (p) => p.stdout.write('[server] Mindeck 0.1.0 listening on http://127.0.0.1:1\n') })
    const t = await setup({ machine: quiet, saved })
    await t.svc.ssh('box')
    expect(t.a.calls.find((x) => x.url.endsWith('/api/pair'))!.body).toMatchObject({ code: 'PAIR-2' })

    const silent = machine({ core: (p) => p.stdout.write('[server] Mindeck 0.1.0 listening on x\n'), pair: (p) => p.finish(0, 'nothing') })
    const u = await setup({ machine: silent })
    await expect(u.svc.ssh('box')).rejects.toMatchObject({ code: 'remote-pair', message: 'The remote Mindeck gave no pairing code' })
    expect(u.svc.list()[0]).toMatchObject({ state: 'failed', error: 'The remote Mindeck gave no pairing code' })

    const refused = await setup({ api: api({ pair: 'refuse' }) })
    await expect(refused.svc.ssh('box')).rejects.toMatchObject({ message: 'Code expired' })
  })

  it('what can go wrong: unreachable, unsupported, install, start, license, later exit', async () => {
    const unreachable = await setup({ machine: machine({ probe: (p) => p.finish(255, '', 'ssh: Could not resolve hostname box\n') }) })
    await expect(unreachable.svc.ssh('box')).rejects.toMatchObject({ code: 'remote-unreachable', message: 'ssh: Could not resolve hostname box' })
    const silentFail = await setup({ machine: machine({ probe: (p) => p.finish(1) }) })
    await expect(silentFail.svc.ssh('box')).rejects.toMatchObject({ message: 'exit 1' })
    const broken = await setup({ machine: machine({ probe: (p) => p.emit('error', new Error('spawn ssh ENOENT')) }) })
    await expect(broken.svc.ssh('box')).rejects.toMatchObject({ message: 'spawn ssh ENOENT' })

    const mips = await setup({ machine: machine({ probe: (p) => p.finish(0, 'mips\n') }) })
    await expect(mips.svc.ssh('box')).rejects.toMatchObject({ code: 'remote-unsupported', message: expect.stringContaining('mips') })
    const blank = await setup({ machine: machine({ probe: (p) => p.finish(0, '') }) })
    await expect(blank.svc.ssh('box')).rejects.toMatchObject({ message: expect.stringContaining('unknown') })

    const full = await setup({ machine: machine({ install: (p) => (p.stdin.resume(), p.stdin.on('end', () => p.finish(2, '', 'tar: No space left on device\n'))) }) })
    await expect(full.svc.ssh('box')).rejects.toMatchObject({ code: 'remote-install', message: 'tar: No space left on device' })
    const quietInstall = await setup({ machine: machine({ install: (p) => (p.stdin.resume(), p.stdin.on('end', () => p.finish(2))) }) })
    await expect(quietInstall.svc.ssh('box')).rejects.toMatchObject({ message: 'exit 2' })

    const dies = await setup({ machine: machine({ core: (p) => (p.stdout.write('Error: EADDRINUSE\n'), p.finish(1)) }) })
    await expect(dies.svc.ssh('box')).rejects.toMatchObject({ code: 'remote-start', message: 'Error: EADDRINUSE' })
    const mute = await setup({ machine: machine({ core: (p) => p.finish(1) }) })
    await expect(mute.svc.ssh('box')).rejects.toMatchObject({ message: 'The remote Mindeck stopped' })
    const slow = await setup({ machine: machine({ core: (p) => p.stderr.write('warming up\n') }) })
    await expect(slow.svc.ssh('box')).rejects.toMatchObject({ message: 'The remote Mindeck did not start in time' })

    const unlicensed = await setup({ api: api({ adopt: 'fail' }) })
    await expect(unlicensed.svc.ssh('box')).rejects.toMatchObject({ code: 'remote-license', message: expect.stringContaining('(bad-entitlement)') })
    const garbled = await setup({ api: api({ adopt: 'garbage' }) })
    await expect(garbled.svc.ssh('box')).rejects.toMatchObject({ message: expect.stringContaining('(HTTP 502)') })

    // Ready, then the core goes away: the connection fails, the window closes.
    const t = await setup()
    await t.svc.ssh('box')
    t.m.find('exec ./node')[0].kill()
    expect(t.svc.list()[0]).toMatchObject({ state: 'failed', error: 'The remote Mindeck stopped' })
    expect(t.windows[0].close).toHaveBeenCalled()
    // A failed one can be tried again.
    expect((await t.svc.ssh('box')).state).toBe('ready')
  })

  it('for real: the user’s ssh (nobody listens on port 1 here) and the default ssh config', async () => {
    const home = process.env.HOME
    process.env.HOME = await tempDir('mindeck-home-')
    try {
      const svc = new RemoteService({ version: '0.1.0', licensed: false, deviceName: 'x', bundle: async () => '', secrets: { get: async () => undefined, set: async () => {} }, entitlement: () => null, publish: () => {} })
      services.push(svc)
      expect(await svc.hosts()).toEqual([])
      await expect(svc.ssh('nobody@127.0.0.1:1')).rejects.toMatchObject({ code: 'remote-unreachable' })
    } finally {
      process.env.HOME = home
    }
  }, 30_000)

  it('a process that never ends is stopped after the timeout', async () => {
    const t = await setup({ machine: machine({ probe: () => {} }) })
    await expect(t.svc.ssh('box')).rejects.toMatchObject({ message: 'exit 1' })
  })
})

describe('Dev Containers', () => {
  async function project(file: '.devcontainer/devcontainer.json' | '.devcontainer.json' | null = '.devcontainer/devcontainer.json') {
    const root = join(await tempDir('mindeck-devc-'), 'my-app')
    await mkdir(join(root, '.devcontainer'), { recursive: true })
    if (file) await writeFile(join(root, file), '{ "image": "debian" }')
    return root
  }

  it('only for projects that describe one', async () => {
    const t = await setup()
    expect(t.svc.hasContainer(await project())).toBe(true)
    expect(t.svc.hasContainer(await project('.devcontainer.json'))).toBe(true)
    const none = await project(null)
    expect(t.svc.hasContainer(none)).toBe(false)
    await expect(t.svc.container(none)).rejects.toMatchObject({ code: 'no-devcontainer' })
  })

  it('starts the container, installs and starts Mindeck in it, pipes connections in, opens its folder', async () => {
    const t = await setup()
    const root = await project()
    const c = await t.svc.container(root)
    expect(c).toMatchObject({ kind: 'container', label: 'Container: my-app', state: 'ready' })
    const up = t.m.find('devcontainer up')[0]
    expect(up.envUsed).toEqual({ X: '1' })
    expect(t.m.find('uname -m')[0].line).toBe(`docker exec -i -u node c0ffee sh -c uname -m; cat "$HOME/.mindeck-server/0.1.0/VERSION" 2>/dev/null; true`)
    expect(t.a.calls.find((x) => x.url.endsWith('projects:add'))!.body).toEqual({ path: '/workspaces/app' })
    expect(t.windows[0].title).toBe('Container: my-app')

    // A connection to the local port goes through `docker exec … node -e <pipe>`.
    const port = Number(c.url!.split(':')[2])
    const socket = connect(port, '127.0.0.1')
    const echoed = new Promise<string>((r) => socket.once('data', (d) => r(d.toString())))
    socket.write('ping')
    expect(await echoed).toBe('ping')
    const pipe = t.m.find('-e ')[0]
    expect(pipe.line).toContain(`exec "$HOME/.mindeck-server/0.1.0/node" -e "const s=require('net').connect(`)
    socket.destroy()
    await tick()
    expect(pipe.killed).toBe(true)
    // A pipe that ends closes its socket; a socket error ends its pipe.
    const second = connect(port, '127.0.0.1')
    await new Promise((r) => second.once('connect', r))
    await tick()
    const closed = new Promise((r) => second.once('close', r))
    t.m.find('-e ').at(-1)!.kill()
    await closed
    const third = connect(port, '127.0.0.1')
    await new Promise((r) => third.once('connect', r))
    await tick()
    third.resetAndDestroy()
    await tick()
    expect(t.m.find('-e ').at(-1)!.killed).toBe(true)

    await t.svc.disconnect(c.id)
    expect(t.svc.list()[0].state).toBe('closed')
  })

  it('a container that won’t come up says why', async () => {
    for (const [out, err, message] of [
      ['{"outcome":"error","message":"Command failed: docker run"}\n', '', 'Command failed: docker run'],
      ['not json\n', 'Docker is not running\n', 'Docker is not running'],
      ['', '', 'devcontainer up failed'],
      ['{"outcome":"success"}\n', '', 'devcontainer up failed']
    ]) {
      const t = await setup({ machine: machine({ up: (p) => p.finish(1, out, err) }) })
      await expect(t.svc.container(await project())).rejects.toMatchObject({ code: 'devcontainer', message })
    }
    // A container user it doesn't name is root.
    const t = await setup({ machine: machine({ up: (p) => p.finish(0, '{"outcome":"success","containerId":"c1"}\n') }) })
    await t.svc.container(await project())
    expect(t.m.find('uname -m')[0].line).toContain('-u root c1')
    expect(t.a.calls.some((x) => x.url.endsWith('projects:add'))).toBe(false)
  })

  it('a folder the container\'s Mindeck can\'t add leaves the connection up', async () => {
    const t = await setup({ api: api({ addFails: true }) })
    expect(await t.svc.container(await project())).toMatchObject({ state: 'ready' })
    expect(t.a.calls.some((x) => x.url.endsWith('projects:add'))).toBe(true)
  })
})
