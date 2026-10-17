import { X509Certificate, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { join } from 'node:path'
import { generate } from 'selfsigned'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { tempDir, tick } from './helpers'
import { AuthService } from '../../../electron/main/services/auth/AuthService'
import { EventHub } from '../../../electron/main/core/EventHub'
import { Certificates, certificateHosts, type TlsCredentials } from '../../../electron/main/server/Certificates'
import { HttpServer, isLoopbackAddress } from '../../../electron/main/server/HttpServer'
import { ServerController, tlsWanted } from '../../../electron/main/server/ServerController'
import { SettingsService } from '../../../electron/main/services/settings/SettingsService'
import { Router } from '../../../electron/ipc/router'
import { eventsProtocols, pairingLink, parsePairingLink } from '@shared/ipc/transport'
import { DEFAULT_SERVER_CONFIG } from '@shared/types/server'

const DAY = 24 * 60 * 60_000
const closers: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(closers.splice(0).map((c) => c()))
})

/** SHA-256 of a public key's DER SubjectPublicKeyInfo, `AB:CD:…` — what a client pinning the key compares. */
const spkiOf = (key: KeyObject) =>
  createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').toUpperCase().replace(/(..)(?!$)/g, '$1:')

const rsa = () =>
  generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })

/** A certificate signed by a (test) authority — like one from Let's Encrypt. */
async function caSigned(names = true): Promise<{ cert: string; key: string }> {
  const caKeys = rsa()
  const leafKeys = rsa()
  const validity = { algorithm: 'sha256', notBeforeDate: new Date(Date.now() - DAY), notAfterDate: new Date(Date.now() + 90 * DAY) }
  const ca = await generate([{ name: 'commonName', value: 'Test CA' }], {
    ...validity,
    keyPair: caKeys,
    extensions: [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true }]
  })
  const leaf = await generate([{ name: 'commonName', value: 'mindeck.example' }], {
    ...validity,
    keyPair: leafKeys,
    ca: { key: caKeys.privateKey, cert: ca.cert },
    // Without names: some extension all the same, or selfsigned adds the common name as one.
    extensions: names
      ? [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, { type: 2, value: 'mindeck.example' }, { type: 2, value: '*.apps.example' }] }]
      : [{ name: 'basicConstraints', cA: false }]
  })
  return { cert: leaf.cert, key: leafKeys.privateKey }
}

describe('Certificates — self-signed', () => {
  const setup = async (now = () => Date.now()) => {
    const dir = join(await tempDir(), 'tls')
    return { dir, certs: new Certificates({ dir, now, hostname: () => 'Studio-Mac' }) }
  }

  it('names every way to reach the core: localhost, loopback, the machine (and its .local) and the LAN', () => {
    expect(certificateHosts(['192.168.1.5', '127.0.0.1'], 'Studio-Mac')).toEqual(['localhost', '127.0.0.1', 'studio-mac', 'studio-mac.local', '192.168.1.5'])
    expect(certificateHosts([], 'nas.home.arpa')).toEqual(['localhost', '127.0.0.1', 'nas.home.arpa'])
    expect(certificateHosts([], 'bad_name')).toEqual(['localhost', '127.0.0.1']) // not a DNS name
  })

  it('makes one for all names (key 0600), keeps it, and tells what it is', async () => {
    const { dir, certs } = await setup()
    expect(certs.custom).toBe(false)
    expect(await certs.current()).toBeNull()
    const creds = await certs.credentials(['192.168.1.5'])
    const x509 = new X509Certificate(creds.cert)
    expect(x509.subjectAltName).toBe('DNS:localhost, IP Address:127.0.0.1, DNS:studio-mac, DNS:studio-mac.local, IP Address:192.168.1.5')
    expect(x509.subject).toContain('CN=Mindeck (Studio-Mac)')
    expect(x509.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']) // serverAuth
    expect(x509.ca).toBe(false)
    expect(x509.checkPrivateKey(createPrivateKey(creds.key))).toBe(true)
    expect(creds.fingerprint).toBe(x509.fingerprint256)
    expect(creds.selfSigned).toBe(true)
    const days = (Date.parse(creds.expiresAt) - Date.now()) / DAY
    expect(days).toBeGreaterThan(728)
    expect(days).toBeLessThan(825) // what Apple platforms accept
    expect(await readFile(join(dir, 'cert.pem'), 'utf8')).toBe(creds.cert)
    expect(await readFile(join(dir, 'key.pem'), 'utf8')).toBe(creds.key)
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'key.pem'))).mode & 0o777).toBe(0o600)
      expect((await stat(dir)).mode & 0o777).toBe(0o700)
    }
    expect(creds.spkiFingerprint).toBe(spkiOf(createPublicKey(creds.key)))
    expect(await certs.current()).toEqual({ fingerprint: creds.fingerprint, spkiFingerprint: creds.spkiFingerprint, expiresAt: creds.expiresAt, selfSigned: true })

    // The same addresses (or fewer): the same certificate, also for the next process.
    expect((await certs.credentials([])).fingerprint).toBe(creds.fingerprint)
    expect((await new Certificates({ dir, hostname: () => 'Studio-Mac' }).credentials(['192.168.1.5'])).fingerprint).toBe(creds.fingerprint)
  })

  it('renews on the same key for a new address, a month before its end, or when it is not valid yet', async () => {
    let now = Date.now()
    const { certs } = await setup(() => now)
    const first = await certs.credentials(['192.168.1.5'])
    const moved = await certs.credentials(['10.0.0.8'])
    expect(moved.fingerprint).not.toBe(first.fingerprint)
    expect(moved.key).toBe(first.key) // a pinned public key survives
    expect(moved.spkiFingerprint).toBe(first.spkiFingerprint)
    expect(new X509Certificate(moved.cert).checkIP('10.0.0.8')).toBe('10.0.0.8')

    now += 701 * DAY // less than a month left
    const late = await certs.credentials(['10.0.0.8'])
    expect(late.fingerprint).not.toBe(moved.fingerprint)
    now -= 801 * DAY // a clock far behind
    expect((await certs.credentials(['10.0.0.8'])).fingerprint).not.toBe(late.fingerprint)
  })

  it('replaces damaged, foreign or mismatched files; one request at a time', async () => {
    const { dir, certs } = await setup()
    const [a, b] = await Promise.all([certs.credentials([]), certs.credentials([])])
    expect(b.fingerprint).toBe(a.fingerprint) // the second waited for the first

    await writeFile(join(dir, 'cert.pem'), 'garbage')
    const repaired = await certs.credentials([])
    expect(repaired.key).toBe(a.key)
    expect(await certs.current()).toMatchObject({ fingerprint: repaired.fingerprint })

    // A key that isn't the certificate's: a new certificate for the key on disk.
    await writeFile(join(dir, 'key.pem'), rsa().privateKey)
    const rekeyed = await certs.credentials([])
    expect(rekeyed.fingerprint).not.toBe(repaired.fingerprint)
    expect(new X509Certificate(rekeyed.cert).checkPrivateKey(createPrivateKey(rekeyed.key))).toBe(true)

    // Not an RSA key (or none at all): a new key.
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    await writeFile(join(dir, 'key.pem'), ec)
    expect((await certs.credentials([])).key).not.toBe(ec)
    await writeFile(join(dir, 'key.pem'), 'not a key')
    expect((await certs.credentials([])).key).toContain('BEGIN PRIVATE KEY')

    // A folder that can't be written: the error, and the next request still runs.
    const blocked = join(await tempDir(), 'file')
    await writeFile(blocked, '')
    const broken = new Certificates({ dir: join(blocked, 'tls') })
    await expect(broken.credentials([])).rejects.toThrow()
    await expect(broken.credentials([])).rejects.toThrow()
  })
})

describe('Certificates — an own certificate from the environment', () => {
  it('is used as it is, checked against its key', async () => {
    const dir = await tempDir()
    const own = await caSigned()
    const files = { cert: join(dir, 'fullchain.pem'), key: join(dir, 'privkey.pem') }
    await writeFile(files.cert, own.cert)
    await writeFile(files.key, own.key)
    const certs = new Certificates({ dir: join(dir, 'tls'), files })
    expect(certs.custom).toBe(true)
    const creds = await certs.credentials(['192.168.1.5']) // not in it: not ours to change
    expect(creds).toMatchObject({ cert: own.cert, key: own.key, selfSigned: false })
    expect(await certs.current()).toMatchObject({ fingerprint: creds.fingerprint, selfSigned: false })

    const bad = (f: Partial<typeof files>) => new Certificates({ dir, files: { ...files, ...f } }).credentials([])
    await expect(bad({ cert: join(dir, 'missing.pem') })).rejects.toMatchObject({ code: 'bad-certificate', message: expect.stringContaining('Cannot read') })
    await writeFile(join(dir, 'junk.pem'), 'junk')
    await expect(bad({ cert: join(dir, 'junk.pem') })).rejects.toMatchObject({ message: expect.stringContaining('holds no PEM certificate') })
    await expect(bad({ key: join(dir, 'junk.pem') })).rejects.toMatchObject({ message: expect.stringContaining('holds no PEM private key') })
    await writeFile(join(dir, 'other.pem'), rsa().privateKey)
    await expect(bad({ key: join(dir, 'other.pem') })).rejects.toMatchObject({ message: expect.stringContaining('is not the key of') })
  })
})

// --- the server over TLS -----------------------------------------------------

interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
  /** The certificate the server presented. */
  peer: X509Certificate
}

/** HTTPS that verifies the server against its own (self-signed) certificate — what a client does after TOFU. */
function httpsCall(port: number, ca: string, path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', ca, agent: false, headers: init.headers }, (res) => {
      const peer = (res.socket as TLSSocket).getPeerX509Certificate() as X509Certificate
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode as number, headers: res.headers, body, peer }))
    })
    req.on('error', reject)
    req.end(init.body)
  })
}

/** A bare TLS handshake: the certificate the server presents, verified or not. */
function handshake(port: number, opts: { ca?: string; servername?: string } = {}): Promise<{ authorized: boolean; peer: X509Certificate }> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false, ...opts }, () => {
      resolve({ authorized: socket.authorized, peer: socket.getPeerX509Certificate() as X509Certificate })
      socket.end()
    })
    socket.on('error', reject)
  })
}

/** Connections seem to come from another computer on the network while switched on (kept-alive ones too). */
function fromNetwork(http: HttpServer): (on: boolean) => void {
  let remote = true
  const internals = http as unknown as { accept(socket: Socket, ...rest: unknown[]): void }
  const accept = internals.accept.bind(http)
  internals.accept = (socket, ...rest) => {
    Object.defineProperty(socket, 'remoteAddress', { get: () => (remote ? '192.168.1.50' : '127.0.0.1') })
    accept(socket, ...rest)
  }
  return (on) => (remote = on)
}

async function startTls(creds?: TlsCredentials) {
  const dir = await tempDir()
  const auth = new AuthService(join(dir, 'devices.json'))
  const hub = new EventHub()
  const router = new Router()
  router.register('projects:list', () => [] as never)
  const tls = creds ?? (await new Certificates({ dir: join(dir, 'tls') }).credentials(['192.168.1.5']))
  const http = new HttpServer({ router, hub, auth, mode: 'server', version: '1', remoteTerminal: () => false })
  await http.listen('127.0.0.1', 0, tls)
  closers.push(() => http.close())
  return { http, auth, hub, tls, port: http.port, dir }
}

describe('HttpServer over TLS', () => {
  it('a real handshake: the certificate verifies against itself and its fingerprint is the one in the pairing link', async () => {
    const { tls, port, auth } = await startTls()
    expect(tls.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)

    // Trust on first use: the client knows nothing but the fingerprint from the QR code.
    const link = pairingLink(`https://192.168.1.5:${port}`, 'ABCD-EFGH', tls.fingerprint)
    expect(link).toBe(`https://192.168.1.5:${port}/#pair=ABCD-EFGH&fp=${tls.fingerprint.replace(/:/g, '').toLowerCase()}`)
    const pinned = parsePairingLink(link)!.fingerprint
    const first = await handshake(port, { servername: 'localhost' })
    expect(first.authorized).toBe(false) // no authority vouches for it…
    expect(first.peer.fingerprint256).toBe(pinned) // …but it is the one from the QR code

    // Pinned as trust anchor, it verifies like any certificate (name checked too).
    expect((await handshake(port, { ca: tls.cert, servername: 'localhost' })).authorized).toBe(true)
    const health = await httpsCall(port, tls.cert, '/api/health')
    expect(health.status).toBe(200)
    expect(health.peer.fingerprint256).toBe(tls.fingerprint)
    expect(health.headers['strict-transport-security']).toBeUndefined() // never for a self-signed certificate
    expect(health.headers['x-content-type-options']).toBe('nosniff')

    // A device paired over HTTPS learns the certificate to pin.
    const { code } = await auth.createPairingCode()
    const paired = await httpsCall(port, tls.cert, '/api/pair', { method: 'POST', body: JSON.stringify({ code, name: 'Phone' }) })
    const result = JSON.parse(paired.body).data
    expect(result).toMatchObject({ token: expect.stringMatching(/^mindeck_/), fingerprint: tls.fingerprint, spkiFingerprint: tls.spkiFingerprint })
    const calls = await new Promise<Answer>((resolve, reject) => {
      const req = httpsRequest({ host: '127.0.0.1', port, path: '/api/rpc/projects:list', method: 'POST', ca: tls.cert, headers: { Authorization: `Bearer ${result.token}` } }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode as number, headers: res.headers, body, peer: null as never }))
      })
      req.on('error', reject)
      req.end()
    })
    expect(JSON.parse(calls.body)).toEqual({ ok: true, data: [] })

    // Events over WSS.
    const ws = new WebSocket(`wss://127.0.0.1:${port}/api/events`, eventsProtocols(result.token), { ca: tls.cert })
    const hello = await new Promise((resolve, reject) => {
      ws.once('message', (d) => resolve(JSON.parse(String(d))))
      ws.once('error', reject)
    })
    expect(hello).toMatchObject({ channel: 'hello' })
    ws.close()
  })

  it('the web UI’s cookie is Secure over HTTPS — also the one that deletes it (FE-SEC-03)', async () => {
    const { tls, port, auth } = await startTls()
    const own = { 'Content-Type': 'application/json', Origin: `https://127.0.0.1:${port}`, Host: `127.0.0.1:${port}` }
    const { code } = await auth.createPairingCode()
    const paired = await httpsCall(port, tls.cert, '/api/pair', { method: 'POST', headers: own, body: JSON.stringify({ code, name: 'Browser', cookie: true }) })
    expect(JSON.parse(paired.body).data).toEqual({ device: expect.objectContaining({ name: 'Browser' }), fingerprint: tls.fingerprint, spkiFingerprint: tls.spkiFingerprint })
    const cookie = String(paired.headers['set-cookie'])
    expect(cookie).toMatch(new RegExp(`^mindeck_${port}=mindeck_[^;]+; Path=/api; HttpOnly; SameSite=Strict; Secure; Max-Age=34560000$`))
    const jar = cookie.split(';')[0]
    expect(JSON.parse((await httpsCall(port, tls.cert, '/api/rpc/projects:list', { method: 'POST', headers: { ...own, Cookie: jar }, body: 'null' })).body)).toEqual({ ok: true, data: [] })
    const out = await httpsCall(port, tls.cert, '/api/logout', { method: 'POST', headers: { ...own, Cookie: jar }, body: '{}' })
    expect(String(out.headers['set-cookie'])).toBe(`mindeck_${port}=; Path=/api; HttpOnly; SameSite=Strict; Secure; Max-Age=0`)
  })

  it('this computer keeps plain HTTP; the network is sent to HTTPS or refused', async () => {
    const { http, port, auth, tls } = await startTls()
    const base = `http://127.0.0.1:${port}`
    const network = fromNetwork(http)
    network(false)
    expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({ ok: true })
    const { code } = await auth.createPairingCode()
    const local = await (await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code, name: 'Local' }) })).json()
    expect(local.data.token).toBeTruthy()
    expect(local.data.fingerprint).toBeUndefined() // not over TLS

    network(true)
    const page = await fetch(`${base}/projects/x?y=1`, { redirect: 'manual' })
    expect(page.status).toBe(308)
    expect(page.headers.get('location')).toBe(`https://127.0.0.1:${port}/projects/x?y=1`)
    // Calls (with a code or a token) are never answered in the clear.
    const pair = await fetch(`${base}/api/pair`, { method: 'POST', body: '{}' })
    expect(pair.status).toBe(403)
    expect(await pair.json()).toMatchObject({ ok: false, error: { code: 'https-required' } })
    const raw = (request: string) =>
      new Promise<string>((resolve) => {
        const socket = netConnect(port, '127.0.0.1', () => socket.write(request))
        let text = ''
        socket.on('data', (d) => (text += d))
        socket.on('close', () => resolve(text))
      })
    // No redirect to a made-up host, nor without one.
    expect(await raw('GET / HTTP/1.1\r\nHost: evil.example/path\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 403/)
    expect(await raw('GET / HTTP/1.0\r\n\r\n')).toMatch(/^HTTP\/1\.1 403/)
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events`, eventsProtocols(local.data.token))
        ws.once('open', resolve)
        ws.once('error', reject)
      })
    ).rejects.toThrow('403')
    // HTTPS from the network: as usual.
    expect((await httpsCall(port, tls.cert, '/api/health')).status).toBe(200)

    // A proxy on this computer passes the network on: no plain HTTP for it either (BE-SEC-21).
    network(false)
    const proxied = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'X-Forwarded-For': '192.168.1.77' }, body: '{}' })
    expect(proxied.status).toBe(403)
    expect(await proxied.json()).toMatchObject({ error: { code: 'https-required' } })
  })

  it('an own certificate from an authority gets HSTS', async () => {
    const own = await caSigned()
    const dir = await tempDir()
    await writeFile(join(dir, 'c.pem'), own.cert)
    await writeFile(join(dir, 'k.pem'), own.key)
    const creds = await new Certificates({ dir, files: { cert: join(dir, 'c.pem'), key: join(dir, 'k.pem') } }).credentials([])
    const { port } = await startTls(creds)
    // (the test authority is nobody's trust anchor: the header is what counts here)
    const raw = await new Promise<Answer>((resolve, reject) => {
      const req = httpsRequest({ host: '127.0.0.1', port, path: '/api/health', rejectUnauthorized: false, agent: false }, (res2) => {
        res2.resume()
        res2.on('end', () => resolve({ status: res2.statusCode as number, headers: res2.headers, body: '', peer: null as never }))
      })
      req.on('error', reject)
      req.end()
    })
    expect(raw.headers['strict-transport-security']).toBe('max-age=31536000')
    // It answers to the certificate's names (BE-SEC-19): its domain, any name under a wildcard.
    const named = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = httpsRequest({ host: '127.0.0.1', port, path: '/api/health', rejectUnauthorized: false, agent: false, headers: { host } }, (res2) => {
          res2.resume()
          resolve(res2.statusCode as number)
        })
        req.on('error', reject)
        req.end()
      })
    expect(await named('mindeck.example')).toBe(200)
    expect(await named('web.apps.example')).toBe(200)
    expect(await named('evil.example')).toBe(403)
    // A certificate without any names: just the core's own then.
    const bare = await caSigned(false)
    const internals = (await startTls({ ...creds, cert: bare.cert, key: bare.key })).http as unknown as { certNames: string[] }
    expect(internals.certNames).toEqual([])
    // Plain loopback HTTP never gets it.
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).headers.get('strict-transport-security')).toBeNull()
  })

  it('takes a renewed certificate for new connections; silent and idle sockets are dropped', async () => {
    const { http, port, dir, tls } = await startTls()
    const next = await new Certificates({ dir: join(dir, 'tls'), hostname: () => 'renamed' }).credentials(['10.1.1.1'])
    expect(next.fingerprint).not.toBe(tls.fingerprint)
    const plain = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/api/health', agent: false, headers: { host } }, (res) => {
          res.resume()
          resolve(res.statusCode as number)
        })
        req.on('error', reject)
        req.end()
      })
    expect(await plain('renamed')).toBe(403)
    http.setTls(next)
    expect((await handshake(port)).peer.fingerprint256).toBe(next.fingerprint)
    expect(await plain('renamed.local')).toBe(200) // the renewed certificate's names

    const internals = http as unknown as { sockets: Set<Socket> }
    const silent = netConnect(port, '127.0.0.1')
    await new Promise((r) => silent.once('connect', r))
    await tick(20)
    const closed = new Promise((r) => silent.once('close', r))
    ;[...internals.sockets].at(-1)!.emit('timeout') // nothing said within the first-byte window
    await closed
    const broken = netConnect(port, '127.0.0.1')
    await new Promise((r) => broken.once('connect', r))
    await tick(20)
    const gone = new Promise((r) => broken.once('close', r))
    ;[...internals.sockets].at(-1)!.emit('error', new Error('reset'))
    await gone

    // An open TLS connection ends with the server.
    const open = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false })
    await new Promise((r) => open.once('secureConnect', r))
    const ended = new Promise((r) => open.once('close', r))
    await http.close()
    await ended
  })

  it('plain servers ignore a certificate; loopback is told apart', async () => {
    const http = new HttpServer({ router: new Router(), hub: new EventHub(), auth: new AuthService(join(await tempDir(), 'd.json')), mode: 'server', version: '1', remoteTerminal: () => false })
    await http.listen('127.0.0.1', 0)
    closers.push(() => http.close())
    http.setTls({} as TlsCredentials) // nothing to renew
    fromNetwork(http)
    expect((await fetch(`http://127.0.0.1:${http.port}/api/health`)).status).toBe(200) // TLS off: as before
    for (const ip of ['127.0.0.1', '127.8.0.1', '::1', '::ffff:127.0.0.1']) expect(isLoopbackAddress(ip)).toBe(true)
    for (const ip of ['192.168.1.5', '::ffff:10.0.0.1', 'fe80::1', 'undefined']) expect(isLoopbackAddress(ip)).toBe(false)
  })
})

// --- the controller ------------------------------------------------------------

describe('ServerController — TLS', () => {
  const setup = async (patch: Partial<typeof DEFAULT_SERVER_CONFIG> = {}, files?: { cert: string; key: string }) => {
    const dir = await tempDir()
    const settings = new SettingsService(join(dir, 'settings.json'))
    await settings.init()
    await settings.update({ server: { ...DEFAULT_SERVER_CONFIG, enabled: true, lan: true, port: 0, ...patch } })
    let addresses = ['192.168.1.5']
    const certificates = new Certificates({ dir: join(dir, 'tls'), files })
    const controller = new ServerController({
      mode: 'desktop',
      version: '1',
      router: new Router(),
      hub: new EventHub(),
      auth: new AuthService(join(dir, 'devices.json')),
      settings,
      certificates,
      addresses: () => addresses
    })
    closers.push(() => controller.stop())
    return { controller, certificates, dir, move: (a: string[]) => (addresses = a) }
  }

  it('end to end: pairing link with fingerprint → TLS handshake → pinned pairing', async () => {
    const { controller } = await setup()
    await controller.start()
    const status = controller.status()
    expect(status.running).toBe(true)
    const port = Number(status.urls[0].split(':').pop())
    expect(status.urls).toEqual([`http://127.0.0.1:${port}`, `https://192.168.1.5:${port}`])

    const pairing = await controller.createPairingCode()
    const link = parsePairingLink(pairingLink(pairing.urls[1], pairing.code, pairing.fingerprint, pairing.spkiFingerprint))!
    expect(link).toEqual({ baseUrl: `https://192.168.1.5:${port}`, code: pairing.code, fingerprint: status.tls!.fingerprint, spkiFingerprint: status.tls!.spkiFingerprint })
    const { peer } = await handshake(port)
    expect(peer.fingerprint256).toBe(link.fingerprint) // the client may go on
    expect(spkiOf(peer.publicKey)).toBe(link.spkiFingerprint) // a client pinning the key, too
    expect(peer.checkIP('192.168.1.5')).toBe('192.168.1.5')
    const paired = await httpsCall(port, peer.toString(), '/api/pair', { method: 'POST', body: JSON.stringify({ code: link.code, name: 'Phone' }) })
    expect(JSON.parse(paired.body).data).toMatchObject({ fingerprint: link.fingerprint, spkiFingerprint: link.spkiFingerprint })
  })

  it('renews for a new address before pairing and twice a day; off when switched off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { controller, move } = await setup()
    await controller.start()
    const first = controller.status().tls!.fingerprint
    const spki = controller.status().tls!.spkiFingerprint
    await controller.renewTls() // nothing changed
    expect(controller.status().tls!.fingerprint).toBe(first)

    move(['10.0.0.8'])
    const code = await controller.createPairingCode()
    expect(code.fingerprint).not.toBe(first)
    expect(controller.status().tls!.fingerprint).toBe(code.fingerprint)
    const port = Number(controller.status().urls[0].split(':').pop())
    const renewed = (await handshake(port)).peer
    expect(renewed.fingerprint256).toBe(code.fingerprint)
    // A new certificate on the same key: a device that pinned the key still finds it.
    expect(code.spkiFingerprint).toBe(spki)
    expect(spkiOf(renewed.publicKey)).toBe(spki)

    move(['10.0.0.9'])
    vi.advanceTimersByTime(12 * 60 * 60_000)
    await vi.waitFor(() => expect(controller.status().tls!.fingerprint).not.toBe(code.fingerprint))

    const off = await controller.configure({ tls: false })
    expect(off.tls).toBeUndefined()
    expect(off.urls[1]).toMatch(/^http:\/\/10\.0\.0\.9:/)
    await controller.renewTls() // no TLS: nothing to renew
  })

  it('a renewal that fails is reported; one that ends after a stop is dropped', async () => {
    const { controller, certificates, move } = await setup()
    await controller.start()
    const spy = vi.spyOn(certificates, 'credentials').mockRejectedValueOnce(new Error('disk full'))
    await controller.renewTls()
    expect(controller.status()).toMatchObject({ running: true, error: 'disk full' })

    move(['10.0.0.8'])
    spy.mockRestore()
    const renewing = controller.renewTls()
    await controller.stop()
    await renewing
    expect(controller.status().tls).toBeUndefined()
  })

  it('no plain fallback: a certificate that cannot be read keeps the server off', async () => {
    const dir = await tempDir()
    const { controller } = await setup({}, { cert: join(dir, 'none.pem'), key: join(dir, 'none.key') })
    await controller.start()
    expect(controller.status()).toMatchObject({ running: false, error: expect.stringContaining('Cannot read') })
  })

  it('HTTPS when wanted: with LAN access, or with an own certificate; a headless core lists HTTPS on loopback too', async () => {
    const config = { ...DEFAULT_SERVER_CONFIG }
    expect(tlsWanted({ ...config, lan: true }, false)).toBe(true)
    expect(tlsWanted({ ...config, lan: false }, false)).toBe(false)
    expect(tlsWanted({ ...config, lan: false }, true)).toBe(true)
    expect(tlsWanted({ ...config, lan: true, tls: false }, true)).toBe(false)

    const dir = await tempDir()
    const controller = new ServerController({
      mode: 'server',
      version: '1',
      router: new Router(),
      hub: new EventHub(),
      auth: new AuthService(join(dir, 'devices.json')),
      fixedConfig: { ...config, enabled: true, lan: false, port: 0 },
      certificates: new Certificates({ dir: join(dir, 'tls') })
    })
    expect(controller.status().urls).toEqual(['http://127.0.0.1:0'])
    const docker = new ServerController({
      mode: 'server',
      version: '1',
      router: new Router(),
      hub: new EventHub(),
      auth: new AuthService(join(dir, 'devices.json')),
      fixedConfig: { ...config, enabled: true, lan: true, port: 7420 },
      certificates: new Certificates({ dir: join(dir, 'tls') }),
      addresses: () => ['172.17.0.2']
    })
    // In Docker, "127.0.0.1" on the host is a forwarded port — not loopback for the core.
    expect(docker.status().urls).toEqual(['https://127.0.0.1:7420', 'https://172.17.0.2:7420'])
  })
})
