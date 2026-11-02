import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { ServerResponse } from 'node:http'
import { connect, createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { tempDir, tick } from './helpers'
import { AuthService } from '../../../electron/main/services/auth/AuthService'
import { FsService } from '../../../electron/main/services/fs/FsService'
import { EventHub } from '../../../electron/main/core/EventHub'
import { HttpServer } from '../../../electron/main/server/HttpServer'
import { ServerController, lanAddresses } from '../../../electron/main/server/ServerController'
import { SettingsService } from '../../../electron/main/services/settings/SettingsService'
import { Router } from '../../../electron/ipc/router'
import { parseRequest } from '@shared/ipc/schemas'
import { DEFAULT_SERVER_CONFIG } from '@shared/types/server'

const servers: HttpServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

describe('request schemas', () => {
  it('accepts null for void channels and explains failures with or without a path', () => {
    expect(parseRequest('projects:list', null)).toEqual({ ok: true, data: undefined })
    expect(parseRequest('fs:dirs', undefined)).toEqual({ ok: true, data: {} })
    expect(parseRequest('ai:runs', undefined)).toEqual({ ok: true, data: {} })
    expect(parseRequest('events:recent', null)).toEqual({ ok: true, data: {} })
    expect(parseRequest('ai:send', { text: '   ' })).toMatchObject({ ok: false })
    expect(parseRequest('memory:read', 'x')).toEqual({ ok: false, message: 'Invalid request for memory:read — Invalid input: expected object, received string' })
    expect(parseRequest('memory:read', { path: '' })).toMatchObject({ ok: false, message: expect.stringContaining('path: ') })
    expect(parseRequest('memory:read', { path: 'a.md', extra: 1 })).toEqual({ ok: true, data: { path: 'a.md' } })
    expect(DEFAULT_SERVER_CONFIG).toMatchObject({ enabled: false, port: 7420 })
  })
})

describe('AuthService', () => {
  const setup = async (now = () => Date.now()) => {
    const dir = await tempDir()
    const file = join(dir, 'data', 'devices.json')
    return { file, auth: new AuthService(file, now) }
  }

  it('pairs a device once per code and stores only hashes (mode 0600)', async () => {
    const { auth, file } = await setup()
    expect(await auth.hasDevices()).toBe(false)
    const { code, expiresAt } = await auth.createPairingCode()
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now())

    const result = await auth.pair(code.toLowerCase().replace('-', ' '), '  My Phone  ')
    expect(result.token).toMatch(/^mindeck_/)
    expect(result.device).toMatchObject({ name: 'My Phone' })
    expect(result.device).not.toHaveProperty('tokenHash')
    await expect(auth.pair(code, 'again')).rejects.toMatchObject({ code: 'bad-code' })

    const raw = await readFile(file, 'utf8')
    expect(raw).not.toContain(result.token)
    expect(raw).not.toContain(code.replace('-', ''))
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await auth.hasDevices()).toBe(true)
    expect(await auth.devices()).toEqual([result.device])
  })

  it('verifies tokens, tracks lastSeen (persisted at most once a minute) and revokes', async () => {
    let now = 1_000_000
    const { auth, file } = await setup(() => now)
    const { code } = await auth.createPairingCode()
    const { token, device } = await auth.pair(code, '')
    expect(device.name).toBe('Device')

    expect(await auth.verify(undefined)).toBeNull()
    expect(await auth.verify('mindeck_nope')).toBeNull()
    expect(await auth.verify(token)).toMatchObject({ id: device.id, lastSeenAt: new Date(now).toISOString() })
    const persisted = JSON.parse(await readFile(file, 'utf8')).devices[0].lastSeenAt
    now += 10_000
    await auth.verify(token) // within a minute: memory only
    expect(JSON.parse(await readFile(file, 'utf8')).devices[0].lastSeenAt).toBe(persisted)
    now += 60_000
    await auth.verify(token)
    expect(JSON.parse(await readFile(file, 'utf8')).devices[0].lastSeenAt).toBe(new Date(now).toISOString())

    // A fresh read (pairing) keeps in-memory lastSeen values.
    now += 1000
    await auth.verify(token)
    const second = await auth.createPairingCode()
    await auth.pair(second.code, 'Laptop')
    expect((await auth.devices()).find((d) => d.id === device.id)?.lastSeenAt).toBe(new Date(now).toISOString())

    await auth.revoke(device.id)
    expect(await auth.verify(token)).toBeNull()
  })

  it('rejects expired codes and picks up codes written by another process', async () => {
    let now = 0
    const { auth, file } = await setup(() => now)
    const { code } = await auth.createPairingCode()
    now += 11 * 60_000
    await expect(auth.pair(code, 'late')).rejects.toMatchObject({ code: 'bad-code' })
    await expect(auth.pair(undefined as unknown as string, undefined as unknown as string)).rejects.toMatchObject({ code: 'bad-code' })

    const cli = new AuthService(file, () => now)
    const fresh = await cli.createPairingCode()
    expect((await auth.pair(fresh.code, 'phone')).device.name).toBe('phone')
  })

  it('keeps a code another process wrote when it persists lastSeen or a revoke', async () => {
    let now = 5_000_000
    const { auth, file } = await setup(() => now)
    const { code } = await auth.createPairingCode()
    const { token, device } = await auth.pair(code, 'phone')
    const cli = new AuthService(file, () => now)
    const fromCli = await cli.createPairingCode() // `mindeck pair` while the server runs
    now += 2 * 60_000
    await auth.verify(token) // persists lastSeen from the cached store
    await auth.revoke('someone-else')
    expect((await auth.pair(fromCli.code, 'laptop')).device.name).toBe('laptop')
    expect((await auth.devices()).map((d) => d.id)).toContain(device.id)
  })

  it('treats a corrupt file as empty and keeps working after a failed write', async () => {
    const dir = await tempDir()
    const file = join(dir, 'devices.json')
    await writeFile(file, '{ nope')
    const auth = new AuthService(file)
    expect(await auth.devices()).toEqual([])
    await writeFile(file, JSON.stringify({ devices: 'x', codes: 5 }))
    expect(await new AuthService(file).devices()).toEqual([])

    const blocked = join(dir, 'blocked')
    await mkdir(join(blocked, 'devices.json'), { recursive: true }) // rename onto a folder fails
    const broken = new AuthService(join(blocked, 'devices.json'))
    await expect(broken.createPairingCode()).rejects.toThrow()
    await expect(broken.createPairingCode()).rejects.toThrow() // the chain survived
  })

  it('a file damaged or removed while running: writes go on from memory', async () => {
    let now = 7_000_000
    const { auth, file } = await setup(() => now)
    const { code } = await auth.createPairingCode()
    const { token, device } = await auth.pair(code, 'phone')
    await writeFile(file, '{ half written')
    await auth.revoke('someone-else') // re-reads what another process wrote: nothing usable
    expect(JSON.parse(await readFile(file, 'utf8')).devices.map((d: { id: string }) => d.id)).toEqual([device.id])
    await writeFile(file, JSON.stringify({ devices: [], codes: 'none' }))
    await auth.revoke('someone-else')
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ devices: [{ id: device.id }], codes: [] })
    await rm(file)
    now += 2 * 60_000
    expect(await auth.verify(token)).toMatchObject({ id: device.id }) // persists lastSeen, file gone
    expect(JSON.parse(await readFile(file, 'utf8')).devices[0].lastSeenAt).toBe(new Date(now).toISOString())
  })
})

describe('FsService', () => {
  it('lists visible sub-folders, sorted, with a parent link', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'b'))
    await mkdir(join(dir, 'a'))
    await mkdir(join(dir, '.hidden'))
    await writeFile(join(dir, 'file.txt'), '')
    const fs = new FsService(dir)
    const home = await fs.dirs()
    expect(home.dirs).toEqual(['a', 'b'])
    expect(home.home).toBe(dir)
    expect(home.parent).toBeTruthy()
    expect((await fs.dirs(join(dir, 'a'))).dirs).toEqual([])
    expect((await fs.dirs('/')).parent).toBeNull()
    await expect(new FsService().dirs().then((l) => l.home)).resolves.toBe(homedir())
  })

  it('rejects relative, missing and non-folder paths', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'file.txt'), '')
    const fs = new FsService(dir)
    await expect(fs.dirs('relative/path')).rejects.toMatchObject({ code: 'bad-path' })
    await expect(fs.dirs(join(dir, 'missing'))).rejects.toMatchObject({ code: 'not-found' })
    await expect(fs.dirs(join(dir, 'file.txt'))).rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('EventHub', () => {
  it('fans out to every listener, isolates failures, unsubscribes', () => {
    const hub = new EventHub()
    const a = vi.fn()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const off = hub.subscribe(a)
    hub.subscribe(() => {
      throw new Error('boom')
    })
    hub.publish('memory:changed', { paths: ['a.md'] })
    expect(a).toHaveBeenCalledWith('memory:changed', { paths: ['a.md'] })
    expect(err).toHaveBeenCalled()
    off()
    hub.publish('memory:changed', { paths: [] })
    expect(a).toHaveBeenCalledTimes(1)
  })
})

// --- HTTP + WebSocket ------------------------------------------------------

async function startHttp(opts: { webRoot?: string; remoteTerminal?: boolean; onClients?: (n: number) => void } = {}) {
  const dir = await tempDir()
  const auth = new AuthService(join(dir, 'devices.json'))
  const hub = new EventHub()
  let terminal = opts.remoteTerminal ?? false
  const router = new Router({ remoteTerminal: () => terminal })
  router.register('projects:list', () => [{ id: 'p' }] as never)
  router.register('memory:read', ({ path }) => ({ path }) as never)
  const http = new HttpServer({
    router,
    hub,
    auth,
    mode: 'server',
    version: '9.9.9',
    webRoot: opts.webRoot,
    remoteTerminal: () => terminal,
    onClients: opts.onClients
  })
  await http.listen('127.0.0.1', 0)
  servers.push(http)
  const base = `http://127.0.0.1:${http.port}`
  const { code } = await auth.createPairingCode()
  const { token, device } = await auth.pair(code, 'test')
  return { http, hub, auth, base, token, device, setTerminal: (v: boolean) => (terminal = v) }
}

const rpc = (base: string, channel: string, body?: unknown, token?: string) =>
  fetch(`${base}/api/rpc/${channel}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  })

function openSocket(url: string): Promise<{ ws: WebSocket; messages: unknown[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const messages: unknown[] = []
    ws.on('message', (data) => messages.push(JSON.parse(String(data))))
    ws.once('open', () => resolve({ ws, messages }))
    ws.once('error', reject)
  })
}

describe('HttpServer — API', () => {
  it('serves health publicly and guards the RPC with device tokens', async () => {
    const { base, token } = await startHttp()
    const health = await fetch(`${base}/api/health`)
    expect(health.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await health.json()).toEqual({ ok: true, name: 'Mindeck', version: '9.9.9', mode: 'server' })

    expect((await rpc(base, 'projects:list')).status).toBe(401)
    const wrongScheme = await fetch(`${base}/api/rpc/projects:list`, { method: 'POST', headers: { Authorization: `Basic ${token}` } })
    expect(wrongScheme.status).toBe(401)

    expect(await (await rpc(base, 'projects:list', undefined, token)).json()).toEqual({ ok: true, data: [{ id: 'p' }] })
    expect(await (await rpc(base, 'memory:read', { path: 'a.md' }, token)).json()).toEqual({ ok: true, data: { path: 'a.md' } })
    expect(await (await rpc(base, 'memory:read', { path: 1 }, token)).json()).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await (await rpc(base, 'system:subscribe', undefined, token)).json()).toEqual({ ok: true })
    expect(await (await rpc(base, 'nope%3Achannel', undefined, token)).json()).toMatchObject({ error: { code: 'unknown-channel' } })

    const badJson = await rpc(base, 'projects:list', '{oops', token)
    expect(badJson.status).toBe(400)
    const huge = await rpc(base, 'projects:list', 'x'.repeat(9 * 1024 * 1024), token)
    expect(huge.status).toBe(413)
    expect((await fetch(`${base}/api/other`)).status).toBe(404)
  })

  it('pairs over HTTP and rate-limits failed attempts per address', async () => {
    const { base, auth, http } = await startHttp()
    const { code } = await auth.createPairingCode()
    const ok = await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code, name: 'Browser' }) })
    expect(await ok.json()).toMatchObject({ ok: true, data: { device: { name: 'Browser' } } })

    for (let i = 0; i < 10; i += 1) {
      const res = await fetch(`${base}/api/pair`, { method: 'POST' })
      expect(res.status).toBe(401)
    }
    const limited = await fetch(`${base}/api/pair`, { method: 'POST', body: '{}' })
    expect(limited.status).toBe(429)

    // the heartbeat forgets attempts once they left the window
    const internals = http as unknown as { sweep(): void; pairFailures: Map<string, number[]> }
    internals.pairFailures.set('10.0.0.9', [Date.now() - 11 * 60_000])
    internals.sweep()
    expect(internals.pairFailures.has('10.0.0.9')).toBe(false)
    expect(internals.pairFailures.size).toBe(1) // the recent ones stay
  })

  it('counts concurrent pairing attempts before they finish (no burst past the limit)', async () => {
    const { base } = await startHttp()
    const statuses = await Promise.all(
      Array.from({ length: 25 }, () => fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code: 'AAAA-AAAA' }) }).then((r) => r.status))
    )
    expect(statuses.filter((s) => s === 401)).toHaveLength(10)
    expect(statuses.filter((s) => s === 429)).toHaveLength(15)
  })
})

describe('HttpServer — robustness', () => {
  it('answers a malformed upgrade with 401 and keeps serving', async () => {
    const { base, http } = await startHttp()
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(http.port, '127.0.0.1', () => {
        socket.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')
      })
      let text = ''
      socket.on('data', (d) => (text += d.toString()))
      socket.on('close', () => resolve(text))
      socket.on('error', reject)
    })
    expect(raw).toContain('401')
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
  })

  it('a failure after the headers went out drops that connection instead of answering twice', async () => {
    const { base, token } = await startHttp()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      // The response breaks mid-way (headers written, body not): no second response on top of it.
      vi.spyOn(ServerResponse.prototype, 'end').mockImplementationOnce(() => {
        throw new Error('stream broke')
      })
      await expect(rpc(base, 'projects:list', undefined, token)).rejects.toThrow()
      await tick(20)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
    expect(await (await rpc(base, 'projects:list', undefined, token)).json()).toEqual({ ok: true, data: [{ id: 'p' }] })
  })

  it('drops a WebSocket client that stopped reading instead of buffering without bound', async () => {
    const { http, hub } = await startHttp()
    const internals = http as unknown as { clients: Set<unknown> }
    const slow = { ws: { readyState: 1, OPEN: 1, bufferedAmount: 64 * 1024 * 1024, send: vi.fn(), terminate: vi.fn() }, deviceId: 'x', alive: true }
    internals.clients.add(slow)
    hub.publish('memory:changed', { paths: [] })
    expect(slow.ws.terminate).toHaveBeenCalled()
    expect(slow.ws.send).not.toHaveBeenCalled()
    internals.clients.delete(slow)
  })
})

describe('HttpServer — web UI', () => {
  it('serves files, falls back to index.html, never leaves the root', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'index.html'), '<!doctype html><title>W</title>')
    await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)')
    await writeFile(join(root, 'blob.bin'), 'x')
    const { base } = await startHttp({ webRoot: root })

    const index = await fetch(`${base}/`)
    expect(index.headers.get('content-type')).toContain('text/html')
    expect(index.headers.get('cache-control')).toBe('no-cache')
    expect(index.headers.get('content-security-policy')).toContain("script-src 'self'")
    const asset = await fetch(`${base}/assets/app.js`)
    expect(asset.headers.get('content-type')).toContain('text/javascript')
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect((await fetch(`${base}/blob.bin`)).headers.get('content-type')).toBe('application/octet-stream')
    expect(await (await fetch(`${base}/projects/deep/link`)).text()).toContain('<title>W</title>')
    expect(await (await fetch(`${base}/%2F..%2F..%2Fetc%2Fpasswd`)).text()).toContain('<title>W</title>')
    expect((await fetch(`${base}/`, { method: 'HEAD' })).status).toBe(200)
    expect((await fetch(`${base}/`, { method: 'PUT' })).status).toBe(405)
    expect((await fetch(`${base}/%E0%A4%A`)).status).toBe(500)
  })

  it('reports a missing or unbuilt web UI as 404', async () => {
    const none = await startHttp()
    expect((await fetch(`${none.base}/`)).status).toBe(404)
    const missing = await startHttp({ webRoot: join(await tempDir(), 'nope') })
    expect((await fetch(`${missing.base}/`)).status).toBe(404)
    const empty = await startHttp({ webRoot: await tempDir() })
    expect((await fetch(`${empty.base}/`)).status).toBe(404)
  })
})

describe('HttpServer — events socket', () => {
  it('authenticates, pushes hub events, filters shells unless enabled, drops revoked devices', async () => {
    const onClients = vi.fn()
    const { http, hub, base, token, device, setTerminal } = await startHttp({ onClients })
    const wsBase = base.replace('http', 'ws')

    await expect(openSocket(`${wsBase}/api/events?token=wrong`)).rejects.toThrow('401')
    await expect(openSocket(`${wsBase}/elsewhere?token=${token}`)).rejects.toThrow('401')

    hub.publish('memory:changed', { paths: ['nobody-listens.md'] })
    const { ws, messages } = await openSocket(`${wsBase}/api/events?token=${token}`)
    await tick(20)
    expect(http.clientCount).toBe(1)
    expect(onClients).toHaveBeenLastCalledWith(1)
    hub.publish('memory:changed', { paths: ['a.md'] })
    hub.publish('terminal:exit', { id: 't', exitCode: 0 })
    setTerminal(true)
    hub.publish('terminal:exit', { id: 't2', exitCode: 0 })
    await tick(30)
    expect(messages).toEqual([
      { channel: 'hello', payload: { deviceId: device.id } },
      { channel: 'memory:changed', payload: { paths: ['a.md'] } },
      { channel: 'terminal:exit', payload: { id: 't2', exitCode: 0 } }
    ])

    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)))
    http.disconnectDevice('someone-else')
    http.disconnectDevice(device.id)
    expect(await closed).toBe(4401)
    await tick(20)
    expect(http.clientCount).toBe(0)
    expect(onClients).toHaveBeenLastCalledWith(0)
  })

  it('heartbeat drops dead clients; closed sockets are skipped; close() is idempotent', async () => {
    const { http, hub, base, token } = await startHttp()
    const { ws } = await openSocket(`${base.replace('http', 'ws')}/api/events?token=${token}`)
    await tick(20)
    const internals = http as unknown as { sweep(): void; clients: Set<{ ws: { readyState: number; OPEN: number; send: () => void }; alive: boolean }> }
    const stale = { ws: { readyState: 3, OPEN: 1, send: vi.fn() }, deviceId: 'x', alive: true }
    internals.clients.add(stale as never)
    hub.publish('memory:changed', { paths: [] })
    expect(stale.ws.send).not.toHaveBeenCalled()
    internals.clients.delete(stale as never)

    internals.sweep() // marks the live client, pings it
    await tick(30) // the pong comes back
    internals.sweep()
    const real = [...internals.clients][0]
    real.alive = false
    const gone = new Promise((r) => ws.once('close', r))
    internals.sweep()
    await gone

    // a socket error terminates that connection
    const second = await openSocket(`${base.replace('http', 'ws')}/api/events?token=${token}`)
    await tick(20)
    const serverSide = [...internals.clients][0] as unknown as { ws: { emit(e: string, err: Error): void } }
    const ended = new Promise((r) => second.ws.once('close', r))
    serverSide.ws.emit('error', new Error('bad frame'))
    await ended

    // closing with a live client terminates it (its late close event is ignored)
    const third = await openSocket(`${base.replace('http', 'ws')}/api/events?token=${token}`)
    await tick(20)
    const lastClose = new Promise((r) => third.ws.once('close', r))
    await http.close()
    await lastClose
    await tick(20)
    await http.close()
    expect(http.port).toBe(0)
    await new HttpServer({ router: new Router(), hub, auth: new AuthService(join(await tempDir(), 'd.json')), mode: 'server', version: '1', remoteTerminal: () => false }).close()
  })

  it('rejects listening on a busy port', async () => {
    const blocker = createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
    const port = (blocker.address() as { port: number }).port
    const http = new HttpServer({ router: new Router(), hub: new EventHub(), auth: new AuthService(join(await tempDir(), 'd.json')), mode: 'server', version: '1', remoteTerminal: () => false })
    await expect(http.listen('127.0.0.1', port)).rejects.toThrow(/EADDRINUSE/)
    await new Promise((r) => blocker.close(r))
  })
})

describe('ServerController', () => {
  const base = async () => {
    const dir = await tempDir()
    const settings = new SettingsService(join(dir, 'settings.json'))
    await settings.init()
    return {
      dir,
      settings,
      deps: { mode: 'desktop' as const, version: '1.0.0', router: new Router(), hub: new EventHub(), auth: new AuthService(join(dir, 'devices.json')) }
    }
  }

  it('desktop: off by default, configurable, restarts on network changes only', async () => {
    const { settings, deps } = await base()
    const created: { listen: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; disconnectDevice: ReturnType<typeof vi.fn> }[] = []
    const controller = new ServerController({
      ...deps,
      settings,
      addresses: () => ['192.168.1.5'],
      createServer: () => {
        const fake = { listen: vi.fn(async () => {}), close: vi.fn(async () => {}), disconnectDevice: vi.fn() }
        created.push(fake)
        return fake as never
      }
    })
    expect(controller.status()).toEqual({ config: DEFAULT_SERVER_CONFIG, running: false, urls: ['http://127.0.0.1:7420'], error: undefined, configurable: true })
    await controller.start()
    expect(created).toHaveLength(0)

    let status = await controller.configure({ enabled: true, lan: true })
    expect(status.running).toBe(true)
    expect(status.urls).toEqual(['http://127.0.0.1:7420', 'http://192.168.1.5:7420'])
    expect(created[0].listen).toHaveBeenCalledWith('0.0.0.0', 7420)
    expect(settings.get().server).toMatchObject({ enabled: true, lan: true })
    await controller.start() // already running
    expect(created).toHaveLength(1)

    status = await controller.configure({ remoteTerminal: true }) // no restart
    expect(controller.remoteTerminal()).toBe(true)
    expect(created).toHaveLength(1)

    const code = await controller.createPairingCode()
    expect(code.urls).toHaveLength(2)
    const paired = await deps.auth.pair(code.code, 'p')
    expect(await controller.devices()).toHaveLength(1)
    await controller.revoke(paired.device.id)
    expect(created[0].disconnectDevice).toHaveBeenCalledWith(paired.device.id)
    expect(await controller.devices()).toHaveLength(0)

    await controller.configure({ lan: false })
    expect(created[0].close).toHaveBeenCalled()
    expect(created[1].listen).toHaveBeenCalledWith('127.0.0.1', 7420)
    await controller.stop()
    await controller.stop()
    await controller.revoke('nobody') // no server running
  })

  it('keeps a start error in the status; reads saved settings', async () => {
    const { settings, deps } = await base()
    await settings.update({ server: { enabled: true, lan: false, port: 7999, remoteTerminal: false } })
    const fake = { listen: vi.fn(async () => Promise.reject(new Error('EADDRINUSE'))), close: vi.fn(async () => {}) }
    const controller = new ServerController({ ...deps, settings, createServer: () => fake as never })
    await controller.start()
    expect(controller.status()).toMatchObject({ running: false, error: 'EADDRINUSE', urls: ['http://127.0.0.1:7999'] })
    expect(fake.close).toHaveBeenCalled()
  })

  it('standalone: fixed config, real server, not configurable', async () => {
    const { deps } = await base()
    const controller = new ServerController({ ...deps, mode: 'server', fixedConfig: { enabled: true, lan: false, port: 0, remoteTerminal: false } })
    await controller.start()
    expect(controller.status()).toMatchObject({ running: true, configurable: false })
    expect(controller.status().urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/)
    // the running server reads the shell switch live from the controller
    const live = controller as unknown as { http: { opts: { remoteTerminal(): boolean } } }
    expect(live.http.opts.remoteTerminal()).toBe(false)
    await expect(controller.configure({ lan: true })).rejects.toMatchObject({ code: 'not-configurable' })
    await expect(new ServerController({ ...deps }).configure({})).rejects.toMatchObject({ code: 'not-configurable' })
    await controller.stop()
  })

  it('LAN mode without injected addresses asks the OS', async () => {
    const { deps } = await base()
    const c = new ServerController({ ...deps, mode: 'server', fixedConfig: { enabled: false, lan: true, port: 7420, remoteTerminal: false } })
    expect(c.status().urls[0]).toBe('http://127.0.0.1:7420')
  })

  it('lists non-internal IPv4 addresses', () => {
    for (const a of lanAddresses()) expect(a).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    const iface = (address: string, family: 'IPv4' | 'IPv6', internal: boolean) =>
      ({ address, family, internal, netmask: '', mac: '', cidr: null }) as never
    expect(
      lanAddresses({
        lo: [iface('127.0.0.1', 'IPv4', true)],
        eth0: [iface('192.168.0.2', 'IPv4', false), iface('fe80::1', 'IPv6', false)],
        gone: undefined
      })
    ).toEqual(['192.168.0.2'])
  })
})
