import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { connect, createServer, type Server as NetServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { tempDir, tick } from './helpers'
import { AuthService, TOKEN_IDLE_MS } from '../../../electron/main/services/auth/AuthService'
import { FsService } from '../../../electron/main/services/fs/FsService'
import { EventHub } from '../../../electron/main/core/EventHub'
import { HttpServer, addressBucket, allowedHostsFromEnv } from '../../../electron/main/server/HttpServer'
import { ServerController, lanAddresses } from '../../../electron/main/server/ServerController'
import { Certificates } from '../../../electron/main/server/Certificates'
import { SettingsService } from '../../../electron/main/services/settings/SettingsService'
import { Router } from '../../../electron/ipc/router'
import { parseRequest } from '@shared/ipc/schemas'
import { eventsProtocols } from '@shared/ipc/transport'
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

  it('gives each device the role of its code; changes roles; keeps at most 20 open codes', async () => {
    const { auth, file } = await setup()
    const member = await auth.pair((await auth.createPairingCode()).code, 'phone')
    expect(member.device.role).toBe('member') // the desktop is the admin: devices start restricted
    const code = await auth.createPairingCode('admin')
    expect(code.role).toBe('admin')
    expect((await auth.pair(code.code, 'laptop')).device.role).toBe('admin')
    expect((await auth.setRole(member.device.id, 'admin')).map((d) => d.role)).toEqual(['admin', 'admin'])
    expect((await auth.verify(member.token))?.role).toBe('admin')
    await expect(auth.setRole('nobody', 'member')).rejects.toMatchObject({ code: 'not-found' })
    for (let i = 0; i < 25; i += 1) await auth.createPairingCode()
    expect(JSON.parse(await readFile(file, 'utf8')).codes).toHaveLength(20)
  })

  it('shares the browser with admin devices only; a demoted device loses it', async () => {
    const { auth } = await setup()
    const member = await auth.pair((await auth.createPairingCode()).code, 'phone')
    const admin = await auth.pair((await auth.createPairingCode('admin')).code, 'tablet')
    await expect(auth.setBrowser(member.device.id, true)).rejects.toMatchObject({ code: 'admin-only' })
    expect((await auth.devices()).some((d) => d.browser)).toBe(false)
    expect((await auth.setBrowser(admin.device.id, true)).find((d) => d.id === admin.device.id)?.browser).toBe(true)
    expect((await auth.verify(admin.token))?.browser).toBe(true)
    // Stopping always works; demoting stops it too, and an admin again starts without it.
    expect((await auth.setBrowser(member.device.id, false)).find((d) => d.id === member.device.id)).not.toHaveProperty('browser')
    await auth.setRole(admin.device.id, 'member')
    await auth.setRole(admin.device.id, 'admin')
    expect((await auth.devices()).find((d) => d.id === admin.device.id)).not.toHaveProperty('browser')
    await auth.setBrowser(admin.device.id, true)
    expect((await auth.setBrowser(admin.device.id, false)).find((d) => d.id === admin.device.id)).not.toHaveProperty('browser')
    await expect(auth.setBrowser('nobody', false)).rejects.toMatchObject({ code: 'not-found' })
  })

  it('a headless core makes its first device admin; devices from before roles get one', async () => {
    const dir = await tempDir()
    const headless = new AuthService(join(dir, 'devices.json'), Date.now, true)
    expect((await headless.pair((await headless.createPairingCode()).code, 'first')).device.role).toBe('admin')
    expect((await headless.pair((await headless.createPairingCode()).code, 'second')).device.role).toBe('member')

    const legacy = { devices: [{ id: 'old', name: 'Old phone', createdAt: '', tokenHash: 'h' }], codes: [] }
    await writeFile(join(dir, 'old-desktop.json'), JSON.stringify(legacy))
    await writeFile(join(dir, 'old-server.json'), JSON.stringify(legacy))
    expect((await new AuthService(join(dir, 'old-desktop.json')).devices())[0].role).toBe('member')
    expect((await new AuthService(join(dir, 'old-server.json'), Date.now, true).devices())[0].role).toBe('admin')
    // A code from before roles pairs a member.
    const hash = createHash('sha256').update('ABCDEFGH').digest('hex')
    await writeFile(join(dir, 'old-code.json'), JSON.stringify({ devices: legacy.devices, codes: [{ hash, expiresAt: new Date(Date.now() + 60_000).toISOString() }] }))
    expect((await new AuthService(join(dir, 'old-code.json')).pair('ABCD-EFGH', 'x')).device.role).toBe('member')
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

  it('a token unused for 90 days expires: the device is forgotten and pairs again (BE-SEC-15)', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z')
    const { auth } = await setup(() => now)
    const used = await auth.pair((await auth.createPairingCode()).code, 'used')
    const idle = await auth.pair((await auth.createPairingCode()).code, 'idle')
    now += TOKEN_IDLE_MS - 1000
    expect(await auth.verify(used.token)).not.toBeNull() // never seen yet: counted from pairing
    now += TOKEN_IDLE_MS - 1000
    expect(await auth.verify(used.token)).not.toBeNull() // seen 90 days ago minus a second: still fine
    expect(await auth.verify(idle.token)).toBeNull() // paired and never used since
    expect((await auth.devices()).map((d) => d.name)).toEqual(['used'])
    now += TOKEN_IDLE_MS + 1
    expect(await auth.verify(used.token)).toBeNull()
    expect(await auth.devices()).toEqual([])
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

  it('a code from a second process survives the running core’s own writes (lastSeen, roles, revoking)', async () => {
    let now = 1_000_000
    const { auth, file } = await setup(() => now)
    const phone = await auth.pair((await auth.createPairingCode()).code, 'phone')
    const laptop = await auth.pair((await auth.createPairingCode()).code, 'laptop')
    expect(await auth.verify(phone.token)).not.toBeNull() // the running core has the file in memory now
    // `mindeck pair` / `docker:pair`: another process writes a code into the file.
    const cli = new AuthService(file, () => now)
    const first = await cli.createPairingCode()
    const second = await cli.createPairingCode()
    const third = await cli.createPairingCode()
    // The paired phone checks in a minute later: lastSeen is written — on top of the file as it is now.
    now += 61_000
    await auth.verify(phone.token)
    expect(JSON.parse(await readFile(file, 'utf8')).codes).toHaveLength(3)
    expect((await auth.pair(first.code, 'tablet')).device.name).toBe('tablet')
    await auth.setRole(phone.device.id, 'admin')
    expect((await auth.pair(second.code, 'tv')).device.name).toBe('tv')
    await auth.revoke(laptop.device.id)
    expect((await auth.pair(third.code, 'watch')).device.name).toBe('watch')
    expect((await auth.devices()).map((d) => d.name)).toEqual(['phone', 'tablet', 'tv', 'watch'])
  })

  it.skipIf(process.platform === 'win32')('a file that can’t be read right now is an error — never read as empty and written over', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = await tempDir()
    const file = join(dir, 'devices.json')
    // A link onto itself: every read fails (ELOOP), like EACCES or EIO would.
    await symlink(file, file)
    const auth = new AuthService(file, Date.now, true)
    await expect(auth.hasDevices()).rejects.toMatchObject({ code: 'ELOOP' })
    await expect(auth.verify('mindeck_x')).rejects.toMatchObject({ code: 'ELOOP' })
    await expect(auth.createPairingCode()).rejects.toMatchObject({ code: 'ELOOP' })
    expect((await lstat(file)).isSymbolicLink()).toBe(true) // nothing was written over it
    expect(warn.mock.calls.at(-1)![0]).toMatch(/cannot read .*devices\.json/)
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

async function startHttp(
  opts: {
    webRoot?: string
    remoteTerminal?: boolean
    onClients?: (n: number) => void
    scope?: (channel: string, payload: unknown) => Promise<unknown>
    allowedHosts?: string[]
    outbox?: { timeoutMs?: number; max?: number }
    rateLimits?: ConstructorParameters<typeof HttpServer>[0]['rateLimits']
    replay?: ConstructorParameters<typeof HttpServer>[0]['replay']
    now?: () => number
  } = {}
) {
  const dir = await tempDir()
  const auth = new AuthService(join(dir, 'devices.json'))
  const hub = new EventHub()
  let terminal = opts.remoteTerminal ?? false
  const router = new Router({ remoteTerminal: () => terminal })
  router.register('projects:list', () => [{ id: 'p' }] as never)
  router.register('memory:read', ({ path }) => ({ path }) as never)
  router.register('app:info', (_req, ctx) => ctx as never)
  router.register('ai:send', () => ({ conversationId: 'c', messageId: 'm' }))
  const http = new HttpServer({
    router,
    hub,
    auth,
    mode: 'server',
    version: '9.9.9',
    webRoot: opts.webRoot,
    remoteTerminal: () => terminal,
    onClients: opts.onClients,
    scope: opts.scope,
    allowedHosts: opts.allowedHosts,
    hostname: () => 'Studio-Mac',
    outbox: opts.outbox,
    rateLimits: opts.rateLimits,
    replay: opts.replay,
    now: opts.now
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

function openSocket(url: string, protocols?: string[]): Promise<{ ws: WebSocket; messages: unknown[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols)
    const messages: unknown[] = []
    ws.on('message', (data) => messages.push(JSON.parse(String(data))))
    ws.once('open', () => resolve({ ws, messages }))
    ws.once('error', reject)
  })
}

describe('HttpServer — API', () => {
  it('sends the browser\'s tabs only to the admin devices it is shared with — asked anew for every push', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const scope = async (_channel: string, payload: unknown) => {
      if ((payload as { boom?: boolean }).boom) throw new Error('boom')
      return (payload as { drop?: boolean }).drop ? null : payload
    }
    const { base, token, hub, auth } = await startHttp({ scope })
    const admin = await auth.pair((await auth.createPairingCode('admin')).code, 'tablet')
    const url = `${base.replace('http', 'ws')}/api/events`
    const member = await openSocket(url, eventsProtocols(token))
    const tablet = await openSocket(url, eventsProtocols(admin.token))
    const bar = [{ id: 'bar', title: 'Bar', children: [] }] as never
    hub.publish('browser:bookmarks', []) // shared with nobody yet
    await tick(30)
    await auth.setBrowser(admin.device.id, true)
    hub.publish('browser:bookmarks', bar)
    hub.publish('browser:state', { drop: true } as never) // the scope keeps it home
    hub.publish('browser:state', { boom: true } as never)
    hub.publish('browser:find', { tabId: 't', active: 0, matches: 0 }) // the desktop's own search bar
    await tick(30)
    expect(tablet.messages.slice(1)).toEqual([{ channel: 'browser:bookmarks', payload: bar, seq: expect.any(Number) }])
    expect(member.messages.slice(1)).toEqual([])
    expect(error).toHaveBeenCalledWith('[server] not sending browser:state:', expect.any(Error))
    // Stopped at the desktop: the next push already stays home.
    await auth.setBrowser(admin.device.id, false)
    hub.publish('browser:bookmarks', bar)
    await tick(30)
    expect(tablet.messages).toHaveLength(2)
    member.ws.close()
    tablet.ws.close()
    error.mockRestore()
  })

  it('without a scope, sends the browser\'s tabs to the shared device as they are', async () => {
    const { base, hub, auth } = await startHttp()
    const admin = await auth.pair((await auth.createPairingCode('admin')).code, 'tablet')
    await auth.setBrowser(admin.device.id, true)
    const tablet = await openSocket(`${base.replace('http', 'ws')}/api/events`, eventsProtocols(admin.token))
    hub.publish('browser:bookmarks', [])
    await tick(30)
    expect(tablet.messages.slice(1)).toEqual([{ channel: 'browser:bookmarks', payload: [], seq: expect.any(Number) }])
    tablet.ws.close()
  })

  it('serves health publicly and guards the RPC with device tokens', async () => {
    const { base, token } = await startHttp()
    const health = await fetch(`${base}/api/health`)
    expect(health.headers.get('x-content-type-options')).toBe('nosniff')
    // The version only for a paired device (BE-SEC-19).
    expect(await health.json()).toEqual({ ok: true, name: 'Mindeck', mode: 'server' })
    expect(await (await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${token}` } })).json()).toEqual({ ok: true, name: 'Mindeck', version: '9.9.9', mode: 'server' })
    expect(await (await fetch(`${base}/api/health`, { headers: { Authorization: 'Bearer mindeck_wrong' } })).json()).not.toHaveProperty('version')

    expect((await rpc(base, 'projects:list')).status).toBe(401)
    const wrongScheme = await fetch(`${base}/api/rpc/projects:list`, { method: 'POST', headers: { Authorization: `Basic ${token}` } })
    expect(wrongScheme.status).toBe(401)

    expect(await (await rpc(base, 'projects:list', undefined, token)).json()).toEqual({ ok: true, data: [{ id: 'p' }] })
    // The handler learns who calls, with the device's role.
    expect(await (await rpc(base, 'app:info', undefined, token)).json()).toEqual({ ok: true, data: { transport: 'remote', deviceId: expect.any(String), role: 'member', browser: false } })
    expect(await (await rpc(base, 'memory:read', { path: 'a.md' }, token)).json()).toEqual({ ok: true, data: { path: 'a.md' } })
    expect(await (await rpc(base, 'memory:read', { path: 1 }, token)).json()).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await (await rpc(base, 'system:subscribe', undefined, token)).json()).toEqual({ ok: true })
    expect(await (await rpc(base, 'nope%3Achannel', undefined, token)).json()).toMatchObject({ error: { code: 'unknown-channel' } })
    // Broken percent-encoding is the client's mistake (BE-BUG-05).
    const broken = await rpc(base, '%E0%A4%A', undefined, token)
    expect(broken.status).toBe(400)
    expect(await broken.json()).toMatchObject({ ok: false, error: { code: 'bad-url' } })

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
})

/** A raw HTTP/1.1 request with exactly these headers: the status line and body that came back. */
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve) => {
    let text = ''
    const socket = connect(port, '127.0.0.1', () => socket.write(request))
    socket.on('data', (c) => (text += c))
    socket.on('close', () => resolve(text))
  })
}
const get = (port: number, path: string, headers: Record<string, string>) =>
  raw(port, `GET ${path} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}Connection: close\r\n\r\n`)

describe('HttpServer — the web UI’s browser session (FE-SEC-03)', () => {
  const json = { 'Content-Type': 'application/json' }
  const post = (url: string, headers: Record<string, string>, body?: unknown) => fetch(url, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) })
  /** `name=value` of the Set-Cookie, and its attributes. */
  const setCookie = (res: Response) => res.headers.get('set-cookie') ?? ''

  it('pairing from the web UI sets an HttpOnly SameSite=Strict cookie on /api — the token never reaches the page', async () => {
    const { base, auth, http } = await startHttp()
    const name = `mindeck_${http.port}`
    const own = { ...json, Origin: base }
    let { code } = await auth.createPairingCode()
    const res = await post(`${base}/api/pair`, own, { code, name: 'Firefox · Linux', cookie: true })
    const body = (await res.json()) as { data: Record<string, unknown> }
    expect(body).toEqual({ ok: true, data: { device: expect.objectContaining({ name: 'Firefox · Linux' }) } })
    expect(JSON.stringify(body)).not.toContain('mindeck_') // no token in the answer
    const cookie = setCookie(res)
    expect(cookie).toMatch(new RegExp(`^${name}=mindeck_[A-Za-z0-9_-]+; Path=/api; HttpOnly; SameSite=Strict; Max-Age=34560000$`))
    // Plain HTTP (this computer): no Secure flag; "don't stay paired": a session cookie.
    ;({ code } = await auth.createPairingCode())
    const session = await post(`${base}/api/pair`, { ...json, 'Sec-Fetch-Site': 'same-origin' }, { code, name: 'n', cookie: true, remember: false })
    expect(setCookie(session)).toMatch(new RegExp(`^${name}=mindeck_[^;]+; Path=/api; HttpOnly; SameSite=Strict$`))
    // The app pairs as before: the token in the answer, no cookie.
    ;({ code } = await auth.createPairingCode())
    const app = await post(`${base}/api/pair`, {}, { code, name: 'Pixel' })
    expect(await app.json()).toMatchObject({ ok: true, data: { token: expect.stringMatching(/^mindeck_/) } })
    expect(app.headers.get('set-cookie')).toBeNull()
  })

  it('a cookie is never set for, or used by, another site (CSRF): Origin / Sec-Fetch-Site, JSON only', async () => {
    const { base, auth, http } = await startHttp()
    const { code } = await auth.createPairingCode()
    const attempts: Record<string, string>[] = [
      { ...json, Origin: 'http://evil.example' },
      { ...json, Origin: base, 'Sec-Fetch-Site': 'same-site' }, // the browser's word counts
      { ...json, 'Sec-Fetch-Site': 'cross-site' },
      { ...json, Origin: 'null' },
      json // says nothing: not the web UI
    ]
    for (const headers of attempts) {
      const res = await post(`${base}/api/pair`, headers, { code, name: 'x', cookie: true })
      expect(res.status, JSON.stringify(headers)).toBe(403)
      expect(await res.json()).toMatchObject({ ok: false, error: { code: 'cross-origin' } })
    }
    const form = await post(`${base}/api/pair`, { 'Content-Type': 'text/plain', Origin: base }, { code, name: 'x', cookie: true })
    expect(form.status).toBe(415)
    // The code was not spent.
    expect((await post(`${base}/api/pair`, { ...json, Origin: base }, { code, name: 'x', cookie: true })).status).toBe(200)

    // Calls riding on the cookie: only from the web UI, only as JSON.
    const token = (await auth.pair((await auth.createPairingCode()).code, 'browser')).token
    const jar = { Cookie: `other=1; mindeck_${http.port}=${token}` }
    const call = (headers: Record<string, string>) => post(`${base}/api/rpc/app:info`, { ...jar, ...headers }, null)
    expect(await (await call({ ...json, Origin: base })).json()).toMatchObject({ ok: true, data: { transport: 'remote', deviceId: expect.any(String) } })
    expect((await call({ ...json, 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200)
    // Behind a proxy that names the core by its own address (nginx's default Host): the browser's word,
    // or — without it — the name the proxy passes on.
    expect((await call({ ...json, Origin: 'https://mindeck.example.com', 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200)
    expect((await call({ ...json, Origin: 'https://mindeck.example.com', 'X-Forwarded-Host': 'mindeck.example.com, inner', 'X-Forwarded-For': '10.0.0.9' })).status).toBe(200)
    expect((await call({ ...json, Origin: 'https://mindeck.example.com', 'X-Forwarded-Host': 'other.example', 'X-Forwarded-For': '10.0.0.9' })).status).toBe(403)
    // From the network, a forwarded name counts for nothing: only a proxy on this computer passes one on.
    const internals = http as unknown as { accept(socket: { remoteAddress?: string }, ...rest: unknown[]): void }
    const accept = internals.accept.bind(http)
    internals.accept = (socket, ...rest) => {
      Object.defineProperty(socket, 'remoteAddress', { get: () => '192.168.1.50' })
      accept(socket, ...rest)
    }
    const fromLan = await raw(http.port, `POST /api/rpc/app:info HTTP/1.1\r\nHost: 127.0.0.1:${http.port}\r\nOrigin: https://mindeck.example.com\r\nX-Forwarded-Host: mindeck.example.com\r\nContent-Type: application/json\r\nCookie: mindeck_${http.port}=${token}\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnull`)
    expect(fromLan).toMatch(/^HTTP\/1\.1 403 /)
    internals.accept = accept
    for (const headers of attempts) expect((await call(headers)).status, JSON.stringify(headers)).toBe(403)
    expect((await call({ Origin: base })).status).toBe(415) // fetch says text/plain
    const bare = await raw(http.port, `POST /api/rpc/app:info HTTP/1.1\r\nHost: 127.0.0.1:${http.port}\r\nOrigin: ${base}\r\nCookie: mindeck_${http.port}=${token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
    expect(bare).toMatch(/^HTTP\/1\.1 415 /) // no type at all
    expect((await call({ 'Content-Type': 'application/jsonp', Origin: base })).status).toBe(415)
    expect((await call({ 'Content-Type': 'application/json; charset=utf-8', Origin: base })).status).toBe(200)
    // A Bearer header is the app's: it wins, and needs no Origin.
    const viaBearer = await post(`${base}/api/rpc/app:info`, { Authorization: `Bearer ${await startToken(auth)}`, Cookie: `mindeck_${http.port}=${token}` }, null)
    expect(viaBearer.status).toBe(200)
    // Another core's cookie (another port) means nothing here.
    expect((await post(`${base}/api/rpc/app:info`, { ...json, Origin: base, Cookie: `mindeck_1=${token}` }, null)).status).toBe(401)
    expect((await post(`${base}/api/rpc/app:info`, { ...json, Origin: base, Cookie: `mindeck_${http.port}=` }, null)).status).toBe(401)
  })

  it('a cookie whose device was removed (or expired) answers 401 and is deleted', async () => {
    const { base, auth, http } = await startHttp()
    const { token, device } = await auth.pair((await auth.createPairingCode()).code, 'browser')
    await auth.revoke(device.id)
    const res = await post(`${base}/api/rpc/app:info`, { ...json, Origin: base, Cookie: `mindeck_${http.port}=${token}` }, null)
    expect(res.status).toBe(401)
    expect(setCookie(res)).toBe(`mindeck_${http.port}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0`)
    // A wrong Bearer token deletes nothing (it is no cookie).
    expect((await post(`${base}/api/rpc/app:info`, { Authorization: 'Bearer mindeck_wrong' }, null)).headers.get('set-cookie')).toBeNull()
  })

  it('the events socket takes the cookie — from the web UI’s own page only', async () => {
    const { base, auth, http, hub } = await startHttp()
    const { token, device } = await auth.pair((await auth.createPairingCode()).code, 'browser')
    const wsUrl = `${base.replace('http', 'ws')}/api/events`
    const open = (headers: Record<string, string>) =>
      new Promise<{ ws: WebSocket; messages: unknown[] }>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, ['mindeck'], { headers })
        const messages: unknown[] = []
        ws.on('message', (data) => messages.push(JSON.parse(String(data))))
        ws.once('open', () => resolve({ ws, messages }))
        ws.once('error', reject)
      })
    const jar = `mindeck_${http.port}=${token}`
    const { messages } = await open({ Cookie: jar, Origin: base })
    await tick(20)
    hub.publish('memory:changed', { paths: ['a.md'] })
    await tick(20)
    expect(messages).toEqual([
      { channel: 'hello', payload: expect.objectContaining({ deviceId: device.id }) },
      { channel: 'memory:changed', payload: { paths: ['a.md'] }, seq: 1 }
    ])
    // Cross-site WebSocket hijacking: another page's socket gets nothing.
    await expect(open({ Cookie: jar, Origin: 'http://evil.example' })).rejects.toThrow('403')
    await expect(open({ Cookie: jar })).rejects.toThrow('403')
    // A cookie the core no longer knows: 401, and it is deleted.
    const answer = await raw(http.port, `GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${http.port}\r\nOrigin: ${base}\r\nCookie: mindeck_${http.port}=mindeck_gone\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}\r\nSec-WebSocket-Protocol: mindeck\r\n\r\n`)
    expect(answer).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\nSet-Cookie: mindeck_\d+=; Path=\/api; HttpOnly; SameSite=Strict; Max-Age=0\r\n/)
  })

  it('a token kept in web storage from before is exchanged for the cookie once (POST /api/session)', async () => {
    const { base, token, device, http } = await startHttp()
    const own = { ...json, Origin: base, Authorization: `Bearer ${token}` }
    const res = await post(`${base}/api/session`, own, { remember: true })
    expect(await res.json()).toEqual({ ok: true, data: { device: expect.objectContaining({ id: device.id }) } })
    expect(setCookie(res)).toBe(`mindeck_${http.port}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=34560000`)
    expect(setCookie(await post(`${base}/api/session`, own, { remember: false }))).toBe(`mindeck_${http.port}=${token}; Path=/api; HttpOnly; SameSite=Strict`)
    expect(setCookie(await post(`${base}/api/session`, own))).toContain('Max-Age=34560000')
    expect((await post(`${base}/api/session`, { ...json, Origin: base }, {})).status).toBe(401) // no token to hand over
    expect((await post(`${base}/api/session`, { ...own, Authorization: 'Bearer mindeck_wrong' }, {})).status).toBe(401)
    expect((await post(`${base}/api/session`, { ...own, Origin: 'http://evil.example' }, {})).status).toBe(403)
    expect((await post(`${base}/api/session`, { ...own, 'Content-Type': 'text/plain' }, {})).status).toBe(415)
  })

  it('signing out removes the device on the core and deletes the cookie', async () => {
    const { base, auth, http } = await startHttp()
    const { token, device } = await auth.pair((await auth.createPairingCode()).code, 'browser')
    const jar = { Cookie: `mindeck_${http.port}=${token}` }
    const socket = await new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/api/events`, ['mindeck'], { headers: { ...jar, Origin: base } })
      ws.once('open', () => resolve(ws))
    })
    const closed = new Promise<number>((r) => socket.once('close', (code) => r(code)))
    expect((await post(`${base}/api/logout`, { ...json, ...jar, Origin: 'http://evil.example' }, {})).status).toBe(403)
    expect(await auth.verify(token)).not.toBeNull()
    const res = await post(`${base}/api/logout`, { ...json, ...jar, Origin: base }, {})
    expect(await res.json()).toEqual({ ok: true })
    expect(setCookie(res)).toBe(`mindeck_${http.port}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0`)
    expect(await auth.verify(token)).toBeNull()
    expect(await closed).toBe(4401)
    expect((await auth.devices()).some((d) => d.id === device.id)).toBe(false)
    // Already gone (or never paired): still deleted, nothing else happens.
    const again = await post(`${base}/api/logout`, { ...json, ...jar, Origin: base }, {})
    expect(again.status).toBe(200)
    expect(setCookie(again)).toContain('Max-Age=0')
    expect((await post(`${base}/api/logout`, {}, {})).status).toBe(200)
    // With a Bearer token (the app): that device goes.
    const app = await auth.pair((await auth.createPairingCode()).code, 'app')
    expect((await post(`${base}/api/logout`, { Authorization: `Bearer ${app.token}` }, {})).status).toBe(200)
    expect(await auth.verify(app.token)).toBeNull()
    // Something else going wrong is no sign-out.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(auth, 'verify').mockRejectedValueOnce(new Error('disk gone'))
    expect((await post(`${base}/api/logout`, { Authorization: 'Bearer x' }, {})).status).toBe(500)
    err.mockRestore()
  })
})

/** Another device's token (pairs one). */
async function startToken(auth: AuthService): Promise<string> {
  return (await auth.pair((await auth.createPairingCode()).code, 'app')).token
}

describe('HttpServer — rate limits', () => {
  it('a device that spends too fast gets 429 rate-limited with Retry-After; a revoked device’s count goes (BE-SEC-18)', async () => {
    const { base, token, auth, http, device } = await startHttp({ rateLimits: { ai: { burst: 2, perMinute: 1 }, inline: null, github: null, cloud: null } })
    const send = () => rpc(base, 'ai:send', { text: 'hi' }, token)
    expect(await (await send()).json()).toMatchObject({ ok: true })
    expect(await (await send()).json()).toMatchObject({ ok: true })
    const limited = await send()
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect(await limited.json()).toEqual({ ok: false, error: { code: 'rate-limited', message: 'Too many ai calls from this device — try again in 60 s' } })
    // Free channels and other devices go on.
    expect((await rpc(base, 'projects:list', undefined, token)).status).toBe(200)
    const { code } = await auth.createPairingCode()
    const other = await auth.pair(code, 'other')
    expect((await rpc(base, 'ai:send', { text: 'hi' }, other.token)).status).toBe(200)
    // Not even counted without a valid token.
    expect((await rpc(base, 'ai:send', { text: 'hi' }, 'mindeck_wrong')).status).toBe(401)
    http.disconnectDevice(device.id)
    expect((await send()).status).toBe(200)
  })
})

describe('HttpServer — hardening', () => {
  it('answers only to its own names: DNS rebinding gets 403 (BE-SEC-19)', async () => {
    const { http, token } = await startHttp({ allowedHosts: ['mindeck.example.com', '.ts.net'] })
    const port = http.port
    for (const host of [`127.0.0.1:${port}`, '192.168.1.20', '[::1]:7420', 'localhost', 'app.localhost', 'studio-mac', 'Studio-Mac.local.', 'mindeck.example.com', 'box.tail1.ts.net']) {
      expect(await get(port, '/api/health', { Host: host }), host).toMatch(/^HTTP\/1\.1 200/)
    }
    for (const host of ['evil.example', `evil.example:${port}`, 'studio-mac.evil.example', 'example.com', 'ts.net.evil', 'not a host']) {
      const answer = await get(port, '/api/health', { Host: host })
      expect(answer, host).toMatch(/^HTTP\/1\.1 403/)
      expect(answer).toContain('host-not-allowed')
    }
    // The events socket too, token or not.
    const ws = await raw(port, `GET /api/events HTTP/1.1\r\nHost: evil.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: ${eventsProtocols(token).join(', ')}\r\n\r\n`)
    expect(ws).toMatch(/^HTTP\/1\.1 403/)
    // A machine whose name already has a domain: that, its bare name and <bare>.local.
    const named = new HttpServer({ router: new Router(), hub: new EventHub(), auth: new AuthService(join(await tempDir(), 'd.json')), mode: 'server', version: '1', remoteTerminal: () => false, hostname: () => 'Robins-MBP.local' })
    await named.listen('127.0.0.1', 0)
    servers.push(named)
    for (const host of ['robins-mbp.local', 'robins-mbp', 'Robins-MBP']) expect(await get(named.port, '/api/health', { Host: host }), host).toMatch(/^HTTP\/1\.1 200/)
    expect(await get(named.port, '/api/health', { Host: 'robins-mbp.local.local' })).toMatch(/^HTTP\/1\.1 403/)
    // `*` answers to any name (a proxy that rewrites them all).
    const any = await startHttp({ allowedHosts: ['*'] })
    expect(await get(any.http.port, '/api/health', { Host: 'whatever.example' })).toMatch(/^HTTP\/1\.1 200/)
    expect(allowedHostsFromEnv({ MINDECK_ALLOWED_HOSTS: ' a.example , .b.example,, ' })).toEqual(['a.example', '.b.example'])
    expect(allowedHostsFromEnv({})).toEqual([])
  })

  it('pairing: IPv6 counted by /64, a bounded memory, a small body; proxies on this computer are not this computer (BE-SEC-20, BE-SEC-21)', async () => {
    expect(addressBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64')
    expect(addressBucket('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64')
    expect(addressBucket('2001:0db8::')).toBe('2001:db8:0:0::/64')
    expect(addressBucket('::1')).toBe('0:0:0:0::/64')
    expect(addressBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
    expect(addressBucket('::ffff:192.168.1.7')).toBe('192.168.1.7')
    expect(addressBucket('10.0.0.1')).toBe('10.0.0.1')
    expect(addressBucket('undefined')).toBe('undefined')

    const { http, base } = await startHttp()
    const internals = http as unknown as { pairFailures: Map<string, number[]>; server: NetServer }
    expect(internals.server.maxConnections).toBe(512)
    const big = await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code: 'x'.repeat(20_000) }) })
    expect(big.status).toBe(413)

    // Behind a proxy on this computer every client comes from 127.0.0.1: each gets its own bucket.
    const pair = (headers: Record<string, string> = {}) => fetch(`${base}/api/pair`, { method: 'POST', headers, body: '{}' })
    for (let i = 0; i < 10; i += 1) expect((await pair({ 'X-Forwarded-For': '203.0.113.9, 10.0.0.5' })).status).toBe(401)
    expect((await pair({ 'X-Forwarded-For': '10.0.0.5' })).status).toBe(429)
    expect((await pair({ 'X-Real-IP': '10.0.0.6' })).status).toBe(401)
    expect((await pair({ Forwarded: 'for=10.0.0.7' })).status).toBe(401)
    expect((await pair()).status).toBe(401) // this computer itself: not locked out by the proxy's clients
    expect([...internals.pairFailures.keys()]).toEqual(['proxied:10.0.0.5', 'proxied:10.0.0.6', 'proxied:', '127.0.0.1'])

    // At most 1000 addresses are remembered: the oldest give way.
    internals.pairFailures.clear()
    for (let i = 0; i < 1000; i += 1) internals.pairFailures.set(`10.1.${i >> 8}.${i & 255}`, [Date.now()])
    expect((await pair()).status).toBe(401)
    expect(internals.pairFailures.size).toBe(1000)
    expect(internals.pairFailures.has('10.1.0.0')).toBe(false)
    expect([...internals.pairFailures.keys()].at(-1)).toBe('127.0.0.1')
  })

  it('an unexpected failure tells the client a reference, the log the details (BE-SEC-19)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { base, auth, token } = await startHttp()
    vi.spyOn(auth, 'verify').mockRejectedValueOnce(new Error("EACCES: permission denied, open '/home/robin/.mindeck/devices.json'"))
    const res = await rpc(base, 'projects:list', undefined, token)
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('error')
    expect(body.error.message).toMatch(/^Something went wrong on the Mindeck core \(ref [0-9a-f]{8}\)$/)
    expect(body.error.message).not.toContain('/home/robin')
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^\[server\] request failed \(ref [0-9a-f]{8}\):$/), expect.any(Error))
    error.mockRestore()
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
    expect((await fetch(`${base}/%E0%A4%A`)).status).toBe(400)
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

    await expect(openSocket(`${wsBase}/api/events`)).rejects.toThrow('401')
    await expect(openSocket(`${wsBase}/api/events`, eventsProtocols('wrong'))).rejects.toThrow('401')
    await expect(openSocket(`${wsBase}/api/events?token=wrong`)).rejects.toThrow('401')
    // The token in the query is no longer read: it ends up in proxy and access logs (BE-SEC-15).
    await expect(openSocket(`${wsBase}/api/events?token=${token}`)).rejects.toThrow('401')
    await expect(openSocket(`${wsBase}/elsewhere`, eventsProtocols(token))).rejects.toThrow('401')
    // The token alone is no protocol to answer with: the client gives up.
    await expect(openSocket(`${wsBase}/api/events`, [eventsProtocols(token)[1]])).rejects.toThrow('subprotocol')

    hub.publish('memory:changed', { paths: ['nobody-listens.md'] })
    const { ws, messages } = await openSocket(`${wsBase}/api/events`, eventsProtocols(token))
    expect(ws.protocol).toBe('mindeck') // never the token
    await tick(20)
    expect(http.clientCount).toBe(1)
    expect(onClients).toHaveBeenLastCalledWith(1)
    hub.publish('memory:changed', { paths: ['a.md'] })
    hub.publish('terminal:exit', { id: 't', exitCode: 0 })
    setTerminal(true)
    hub.publish('terminal:exit', { id: 't2', exitCode: 0 })
    hub.publish('permission:request', { id: 'r1', allowAlways: true } as never)
    hub.publish('browser:reveal', { tabId: 't' }) // the desktop window's own
    hub.publish('browser:bookmarks', []) // the browser is not shared (no setting at all)
    // Search results (file contents) reach only the device that searched — the desktop's none.
    hub.publish('search:progress', { id: 's', files: [], done: true })
    hub.publish('search:progress', { id: 's', files: [], done: true, device: 'another-device' })
    hub.publish('search:progress', { id: 'mine', files: [], done: true, device: device.id })
    await tick(30)
    expect(messages).toEqual([
      // Where this device's numbered events stand (FE-BUG-01): it was connected a moment ago (the
      // attempt without the protocol), so the event in between was kept for it as #1.
      { channel: 'hello', payload: { deviceId: device.id, role: 'member', stream: expect.any(String), seq: 1 } },
      { channel: 'memory:changed', payload: { paths: ['a.md'] }, seq: 2 },
      { channel: 'terminal:exit', payload: { id: 't2', exitCode: 0 }, seq: 3 },
      // "Always allow" is the desktop's to give.
      { channel: 'permission:request', payload: { id: 'r1', allowAlways: false }, seq: 4 },
      // Numbered per device: the other device's search took no number of this one.
      { channel: 'search:progress', payload: { id: 'mine', files: [], done: true, device: device.id }, seq: 5 }
    ])
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)))
    http.disconnectDevice('someone-else')
    http.disconnectDevice(device.id)
    expect(await closed).toBe(4401)
    await tick(20)
    expect(http.clientCount).toBe(0)
    expect(onClients).toHaveBeenLastCalledWith(0)
  })

  it('sends devices only what their projects allow, in order; what can’t be checked is not sent', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const scope = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === 'tests:changed') throw new Error('lookup failed')
      if (channel === 'agents:message') {
        await tick(20) // a slow check: what comes after waits for it
        return (payload as { sessionId: string }).sessionId === 'private' ? null : payload
      }
      return channel === 'liveServer:changed' ? (payload as { projectId: string }[]).filter((s) => s.projectId !== 'private') : payload
    })
    const { hub, base, token, device } = await startHttp({ scope })
    const { messages } = await openSocket(`${base.replace('http', 'ws')}/api/events`, eventsProtocols(token))
    await tick(20)
    hub.publish('agents:message', { sessionId: 'private', message: {} } as never)
    hub.publish('agents:message', { sessionId: 'shared', message: {} } as never)
    hub.publish('tests:changed', { projectId: 'x' } as never)
    hub.publish('liveServer:changed', [{ projectId: 'private' }, { projectId: 'shared' }] as never)
    hub.publish('browser:reveal', { tabId: 't' }) // the desktop's own: never even checked
    // Inline edits are the asking device's code.
    hub.publish('ai:inlineDelta', { requestId: 'q', text: 'desktop' })
    hub.publish('ai:inlineDelta', { requestId: 'q', text: 'mine', device: device.id })
    await tick(80)
    expect(messages.slice(1)).toEqual([
      { channel: 'agents:message', payload: { sessionId: 'shared', message: {} }, seq: 1 },
      { channel: 'liveServer:changed', payload: [{ projectId: 'shared' }], seq: 2 },
      { channel: 'ai:inlineDelta', payload: { requestId: 'q', text: 'mine', device: device.id }, seq: 3 }
    ])
    expect(scope).not.toHaveBeenCalledWith('browser:reveal', expect.anything())
    expect(error).toHaveBeenCalledWith('[server] not sending tests:changed:', expect.any(Error))
    error.mockRestore()
  })

  it('a check that hangs (a network share gone) holds nothing up: that event is dropped; a full outbox drops new ones until it drains', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let hang = true
    const scope = vi.fn((channel: string, payload: unknown) => (channel === 'tests:changed' && hang ? new Promise<unknown>(() => {}) : Promise.resolve(payload)))
    const { hub, base, token, http, device } = await startHttp({ scope, outbox: { timeoutMs: 40, max: 3 } })
    const { messages } = await openSocket(`${base.replace('http', 'ws')}/api/events`, eventsProtocols(token))
    await tick(20)
    // A second connection of the device that is closing just now: it gets nothing, not even the resync.
    const closing = { deviceId: device.id, alive: true, ws: { readyState: 2, OPEN: 1, send: vi.fn(), terminate: vi.fn(), ping: vi.fn() } }
    const clients = (http as unknown as { clients: Set<unknown> }).clients
    clients.add(closing)
    hub.publish('tests:changed', { projectId: 'on-a-dead-mount' } as never)
    hub.publish('memory:changed', { paths: ['a.md'] })
    hub.publish('memory:changed', { paths: ['b.md'] })
    hub.publish('memory:changed', { paths: ['dropped.md'] }) // the outbox holds 3
    hub.publish('memory:changed', { paths: ['dropped-too.md'] })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/3 events wait for their check — dropping new ones/)
    await vi.waitFor(() => expect(messages.length).toBe(4))
    expect(messages.slice(1, 3).map((m) => (m as { payload: { paths: string[] } }).payload.paths[0])).toEqual(['a.md', 'b.md'])
    // Drained: the dropped events left a gap no seq shows — the device is told to resync (FE-BUG-01).
    const hello = messages[0] as { payload: { stream: string } }
    expect(messages[3]).toEqual({ channel: 'resync-required', payload: { stream: hello.payload.stream, seq: 2 } })
    expect(closing.ws.send).not.toHaveBeenCalled()
    clients.delete(closing)
    expect(error).toHaveBeenCalledWith('[server] not sending tests:changed:', expect.objectContaining({ message: 'no answer within 40 ms' }))
    // Events flow again, and a full outbox would be said again.
    hang = false
    hub.publish('memory:changed', { paths: ['c.md'] })
    await vi.waitFor(() => expect(messages.length).toBe(5))
    expect(messages[4]).toMatchObject({ payload: { paths: ['c.md'] }, seq: 3 })
    error.mockRestore()
    warn.mockRestore()
  })

  it('rejects nothing for clients that never resume (mindeck-mobile before seq): hello, then events', async () => {
    const { hub, base, token } = await startHttp()
    const { messages } = await openSocket(`${base.replace('http', 'ws')}/api/events`, eventsProtocols(token))
    await tick(20)
    hub.publish('memory:changed', { paths: ['a.md'] })
    await tick(20)
    expect(messages.map((m) => (m as { channel: string }).channel)).toEqual(['hello', 'memory:changed'])
  })

  it('heartbeat drops dead clients; closed sockets are skipped; close() is idempotent', async () => {
    const { http, hub, base, token } = await startHttp()
    const { ws } = await openSocket(`${base.replace('http', 'ws')}/api/events`, eventsProtocols(token))
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
    const second = await openSocket(`${base.replace('http', 'ws')}/api/events`, eventsProtocols(token))
    await tick(20)
    const serverSide = [...internals.clients][0] as unknown as { ws: { emit(e: string, err: Error): void } }
    const ended = new Promise((r) => second.ws.once('close', r))
    serverSide.ws.emit('error', new Error('bad frame'))
    await ended

    // closing with a live client terminates it (its late close event is ignored)
    const third = await openSocket(`${base.replace('http', 'ws')}/api/events`, eventsProtocols(token))
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

// --- event replay (FE-BUG-01) -------------------------------------------------

interface Msg {
  channel: string
  payload: { stream?: string; seq?: number; paths?: string[] } & Record<string, unknown>
  seq?: number
}

describe('HttpServer — event replay', () => {
  const connect = async (base: string, token: string, resume?: { stream: string; since: number | string }) => {
    const query = resume ? `?stream=${encodeURIComponent(resume.stream)}&since=${resume.since}` : ''
    const socket = await openSocket(`${base.replace('http', 'ws')}/api/events${query}`, eventsProtocols(token))
    await tick(20)
    return { ...socket, messages: socket.messages as Msg[] }
  }
  const close = async (ws: WebSocket) => {
    const closed = new Promise((r) => ws.once('close', r))
    ws.close()
    await closed
    await tick(10)
  }
  const paths = (messages: Msg[]) => messages.filter((m) => m.channel === 'memory:changed').map((m) => `${m.payload.paths![0]}#${m.seq}`)

  it('a reconnect names the last event it saw: the core sends what it missed, in order, then goes on live', async () => {
    const { hub, base, token } = await startHttp()
    const first = await connect(base, token)
    const { stream } = first.messages[0].payload
    hub.publish('memory:changed', { paths: ['a.md'] })
    await tick(20)
    await close(first.ws)
    // Away (standby, another Wi-Fi): kept for this device.
    hub.publish('memory:changed', { paths: ['b.md'] })
    hub.publish('permission:request', { id: 'r1', allowAlways: true } as never)
    hub.publish('memory:changed', { paths: ['c.md'] })
    await tick(20)
    const again = await connect(base, token, { stream: stream!, since: 1 })
    hub.publish('memory:changed', { paths: ['d.md'] })
    await tick(20)
    expect(again.messages[0]).toEqual({ channel: 'hello', payload: expect.objectContaining({ stream, seq: 4 }) })
    expect(again.messages.slice(1)).toEqual([
      { channel: 'memory:changed', payload: { paths: ['b.md'] }, seq: 2 },
      { channel: 'permission:request', payload: { id: 'r1', allowAlways: false }, seq: 3 },
      { channel: 'memory:changed', payload: { paths: ['c.md'] }, seq: 4 },
      { channel: 'memory:changed', payload: { paths: ['d.md'] }, seq: 5 }
    ])
    // Up to date: nothing to replay, no resync.
    await close(again.ws)
    const current = await connect(base, token, { stream: stream!, since: 5 })
    expect(current.messages).toEqual([{ channel: 'hello', payload: expect.objectContaining({ seq: 5 }) }])
  })

  it('a gap the core no longer holds, another stream (a restarted core) or a nonsense seq: resync-required', async () => {
    const { hub, base, token } = await startHttp({ replay: { maxEvents: 3, maxBytes: 1 << 20, maxAgeMs: 60_000, maxDevices: 8 } })
    const first = await connect(base, token)
    const { stream } = first.messages[0].payload
    await close(first.ws)
    for (const p of ['1', '2', '3', '4', '5']) hub.publish('memory:changed', { paths: [p] })
    await tick(20)
    const resync = { channel: 'resync-required', payload: { stream, seq: 5 } }
    // Overflow: 1 and 2 are gone — the client reloads instead.
    expect((await connect(base, token, { stream: stream!, since: 0 })).messages.slice(1)).toEqual([resync])
    // The last three are still there.
    expect(paths((await connect(base, token, { stream: stream!, since: 2 })).messages)).toEqual(['3#3', '4#4', '5#5'])
    for (const resume of [
      { stream: 'another-core', since: 5 },
      { stream: stream!, since: 9 }, // ahead of the core: not this numbering
      { stream: stream!, since: 'x' },
      { stream: stream!, since: -1 }
    ]) {
      expect((await connect(base, token, resume)).messages.slice(1), JSON.stringify(resume)).toEqual([resync])
    }
  })

  it('only what the device may see is numbered and kept: scope, other devices’ results, shells, ticks', async () => {
    const scope = async (channel: string, payload: unknown) => (channel === 'tests:changed' && (payload as { projectId: string }).projectId === 'private' ? null : payload)
    const { hub, base, token, auth, device } = await startHttp({ scope })
    const { code } = await auth.createPairingCode()
    const other = await auth.pair(code, 'other')
    const mine = await connect(base, token)
    const theirs = await connect(base, other.token)
    await close(mine.ws)
    await close(theirs.ws)
    hub.publish('tests:changed', { projectId: 'private' } as never) // not the device's: never kept
    hub.publish('tests:changed', { projectId: 'shared' } as never)
    hub.publish('terminal:data', { id: 't', data: 'secret', start: 0 } as never) // shells are off
    hub.publish('system:tick', { cpu: 1 } as never) // a snapshot: not kept
    hub.publish('ai:inlineDelta', { requestId: 'q', text: 'for the other device', device: other.device.id })
    hub.publish('ai:inlineDelta', { requestId: 'q', text: 'mine', device: device.id })
    await tick(30)
    const back = await connect(base, token, { stream: mine.messages[0].payload.stream!, since: 0 })
    expect(back.messages.slice(1)).toEqual([
      { channel: 'tests:changed', payload: { projectId: 'shared' }, seq: 1 },
      { channel: 'ai:inlineDelta', payload: { requestId: 'q', text: 'mine', device: device.id }, seq: 2 }
    ])
    const theirsBack = await connect(base, other.token, { stream: theirs.messages[0].payload.stream!, since: 0 })
    expect(theirsBack.messages.slice(1)).toEqual([
      { channel: 'tests:changed', payload: { projectId: 'shared' }, seq: 1 },
      { channel: 'ai:inlineDelta', payload: { requestId: 'q', text: 'for the other device', device: other.device.id }, seq: 2 }
    ])
    // Live ticks carry no seq: they never open a gap.
    hub.publish('system:tick', { cpu: 2 } as never)
    await tick(20)
    expect(back.messages.at(-1)).toEqual({ channel: 'system:tick', payload: { cpu: 2 } })
  })

  it('what devices may see changed, or a device was removed: kept events are not replayed', async () => {
    const { http, hub, base, token, device } = await startHttp()
    const first = await connect(base, token)
    const { stream } = first.messages[0].payload
    await close(first.ws)
    hub.publish('memory:changed', { paths: ['before.md'] })
    await tick(20)
    http.resetReplay() // e.g. a shared folder was removed at the desktop
    hub.publish('memory:changed', { paths: ['after.md'] })
    await tick(20)
    // Missed one from before the change: resync. Saw it: the one after comes.
    expect((await connect(base, token, { stream: stream!, since: 0 })).messages.slice(1)).toEqual([{ channel: 'resync-required', payload: { stream, seq: 2 } }])
    expect(paths((await connect(base, token, { stream: stream!, since: 1 })).messages)).toEqual(['after.md#2'])
    const internals = http as unknown as { streams: { size: number } }
    expect(internals.streams.size).toBe(1)
    http.disconnectDevice(device.id)
    expect(internals.streams.size).toBe(0)
  })

  it('kept for a while only: old events and devices long gone are forgotten', async () => {
    let now = 1_000_000
    const { http, hub, base, token, auth } = await startHttp({ now: () => now, replay: { maxEvents: 100, maxBytes: 1 << 20, maxAgeMs: 60_000, maxDevices: 1 } })
    const first = await connect(base, token)
    const { stream } = first.messages[0].payload
    await close(first.ws)
    hub.publish('memory:changed', { paths: ['old.md'] })
    await tick(20)
    now += 61_000
    hub.publish('memory:changed', { paths: ['new.md'] })
    await tick(20)
    const stale = await connect(base, token, { stream: stream!, since: 0 })
    expect(stale.messages.slice(1)).toEqual([{ channel: 'resync-required', payload: { stream, seq: 2 } }])
    await close(stale.ws)
    const back = await connect(base, token, { stream: stream!, since: 1 })
    expect(paths(back.messages)).toEqual(['new.md#2'])
    const internals = http as unknown as { sweep(): void; streams: { size: number; get(id: string): unknown } }
    // A second device connects; with room for one stream the device gone longest gives way — never a connected one.
    const { code } = await auth.createPairingCode()
    const other = await auth.pair(code, 'other')
    const second = await connect(base, other.token)
    internals.sweep()
    expect(internals.streams.size).toBe(2) // both connected
    await close(back.ws)
    now += 1000
    await close(second.ws)
    internals.sweep()
    expect(internals.streams.size).toBe(1)
    expect(internals.streams.get(other.device.id)).toBeDefined()
    // Gone longer than events are kept: forgotten — the next connection starts a new stream.
    now += 61_000
    internals.sweep()
    expect(internals.streams.size).toBe(0)
    const fresh = await connect(base, other.token, { stream: second.messages[0].payload.stream!, since: 0 })
    expect(fresh.messages[0].payload.stream).not.toBe(second.messages[0].payload.stream)
    expect(fresh.messages[1]).toMatchObject({ channel: 'resync-required', payload: { seq: 0 } })
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
      deps: {
        mode: 'desktop' as const,
        version: '1.0.0',
        router: new Router(),
        hub: new EventHub(),
        auth: new AuthService(join(dir, 'devices.json')),
        certificates: new Certificates({ dir: join(dir, 'tls') })
      }
    }
  }

  it('desktop: off by default, configurable, restarts on network changes only', async () => {
    const { settings, deps } = await base()
    const created: { listen: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; disconnectDevice: ReturnType<typeof vi.fn>; resetReplay: ReturnType<typeof vi.fn> }[] = []
    const controller = new ServerController({
      ...deps,
      settings,
      addresses: () => ['192.168.1.5'],
      createServer: () => {
        const fake = { listen: vi.fn(async () => {}), close: vi.fn(async () => {}), disconnectDevice: vi.fn(), setTls: vi.fn(), resetReplay: vi.fn() }
        created.push(fake)
        return fake as never
      }
    })
    expect(controller.status()).toEqual({ config: DEFAULT_SERVER_CONFIG, running: false, urls: ['http://127.0.0.1:7420'], error: undefined, configurable: true })
    expect(DEFAULT_SERVER_CONFIG.tls).toBe(true) // the network gets HTTPS unless switched off
    await controller.start()
    expect(created).toHaveLength(0)

    let status = await controller.configure({ enabled: true, lan: true })
    expect(status.running).toBe(true)
    // The desktop itself keeps plain HTTP on loopback; the network gets HTTPS.
    expect(status.urls).toEqual(['http://127.0.0.1:7420', 'https://192.168.1.5:7420'])
    const sha256 = expect.stringMatching(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(status.tls).toEqual({ fingerprint: sha256, spkiFingerprint: sha256, expiresAt: expect.any(String), selfSigned: true })
    expect(created[0].listen).toHaveBeenCalledWith('0.0.0.0', 7420, expect.objectContaining({ fingerprint: status.tls!.fingerprint, cert: expect.stringContaining('BEGIN CERTIFICATE') }))
    expect(settings.get().server).toMatchObject({ enabled: true, lan: true })
    await controller.start() // already running
    expect(created).toHaveLength(1)

    status = await controller.configure({ remoteTerminal: true, remoteRoots: ['/srv/code'] }) // no restart
    expect(controller.remoteTerminal()).toBe(true)
    expect(controller.remoteRoots()).toEqual(['/srv/code'])
    expect(settings.get().server?.remoteRoots).toEqual(['/srv/code'])
    expect(created).toHaveLength(1)
    // What devices may see changed: events kept for their reconnect are not replayed (FE-BUG-01).
    expect(created[0].resetReplay).toHaveBeenCalledTimes(1)
    await controller.configure({ remoteRoots: ['/srv/code'] })
    expect(created[0].resetReplay).toHaveBeenCalledTimes(1)
    await controller.configure({ remoteRoots: ['/srv/other'] })
    await controller.configure({ remoteTerminal: false })
    expect(created[0].resetReplay).toHaveBeenCalledTimes(3)
    await controller.configure({ remoteTerminal: true, remoteRoots: ['/srv/code'] })

    const code = await controller.createPairingCode()
    expect(code).toMatchObject({ role: 'member', fingerprint: status.tls!.fingerprint, spkiFingerprint: status.tls!.spkiFingerprint })
    expect(code.urls).toHaveLength(2)
    const paired = await deps.auth.pair(code.code, 'p')
    expect(await controller.devices()).toHaveLength(1)
    expect(await controller.setDeviceRole(paired.device.id, 'admin')).toEqual([expect.objectContaining({ id: paired.device.id, role: 'admin' })])
    expect(await controller.setDeviceBrowser(paired.device.id, true)).toEqual([expect.objectContaining({ id: paired.device.id, browser: true })])
    expect((await controller.createPairingCode('admin')).role).toBe('admin')
    await controller.revoke(paired.device.id)
    expect(created[0].disconnectDevice).toHaveBeenCalledWith(paired.device.id)
    expect(await controller.devices()).toHaveLength(0)

    await controller.configure({ lan: false })
    expect(created[0].close).toHaveBeenCalled()
    expect(created[1].listen).toHaveBeenCalledWith('127.0.0.1', 7420, undefined) // this computer only: no TLS
    expect(controller.status().tls).toBeUndefined()
    expect((await controller.createPairingCode()).fingerprint).toBeUndefined()
    expect((await controller.createPairingCode()).spkiFingerprint).toBeUndefined()
    await controller.stop()
    await controller.stop()
    await controller.revoke('nobody') // no server running
  })

  it('keeps a start error in the status; reads saved settings', async () => {
    const { settings, deps } = await base()
    await settings.update({ server: { enabled: true, lan: false, tls: true, port: 7999, remoteTerminal: false, remoteRoots: [] } })
    const fake = { listen: vi.fn(async () => Promise.reject(new Error('EADDRINUSE'))), close: vi.fn(async () => {}) }
    const controller = new ServerController({ ...deps, settings, createServer: () => fake as never })
    await controller.start()
    expect(controller.status()).toMatchObject({ running: false, error: 'EADDRINUSE', urls: ['http://127.0.0.1:7999'] })
    expect(fake.close).toHaveBeenCalled()
  })

  it('standalone: fixed config, real server, not configurable', async () => {
    const { deps } = await base()
    const controller = new ServerController({ ...deps, mode: 'server', fixedConfig: { enabled: true, lan: false, tls: true, port: 0, remoteTerminal: false, remoteRoots: [] } })
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
    const c = new ServerController({ ...deps, mode: 'server', fixedConfig: { enabled: false, lan: true, tls: false, port: 7420, remoteTerminal: false, remoteRoots: [] } })
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
