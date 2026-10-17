import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudService, deriveState, FOLLOWER_HANDOVER_MS, holdsOffline, OFFLINE_SECRET, PAUSE_GRACE_MS, SESSION_SECRET, type CloudServiceOptions } from '../../../electron/main/services/cloud/CloudService'
import { parsePublicKey, verifyEntitlement, type EntitlementClaims } from '../../../electron/main/services/cloud/entitlement'
import { bakedCloud, cloudConfig, cloudDefines, DEV_CLOUD_URL, isReleaseBuild } from '../../../electron/main/services/cloud/config'
import { SecretStore } from '../../../electron/main/services/ai/SecretStore'
import { Router } from '../../../electron/ipc/router'
import { isLicenseFree } from '@shared/types/cloud'
import { tempDir } from './helpers'

// --- a fake Mindeck Cloud that signs real entitlements -------------------------

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), der: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
}

function signToken(payload: string, privateKey: KeyObject): string {
  const body = Buffer.from(payload).toString('base64url')
  return `mindeck1.${body}.${sign(null, Buffer.from(`mindeck1.${body}`), privateKey).toString('base64url')}`
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

interface Call {
  method: string
  path: string
  body: Record<string, unknown> | undefined
  auth: string | undefined
}

function fakeCloud(clock: { now: number }) {
  const k = keys()
  const s = {
    plan: 'trial' as 'trial' | 'lifetime',
    active: true,
    reason: 'ok' as EntitlementClaims['reason'],
    ttl: 90,
    used: 0,
    down: false,
    lease: true as boolean | 'forged' | 'broken',
    /** A lifetime account's offline certificate (newer clouds); undefined = an older cloud without the field. */
    cert: undefined as undefined | 'good' | 'forged' | 'temporary',
    /** The id the cloud gave the device (`dev` of leases and certificates); `certDev` overrides it for the certificate. */
    dev: undefined as string | undefined,
    certDev: undefined as string | undefined,
    fail: {} as Record<string, { status: number; body?: unknown }>,
    /** Follower leases (POST /v1/license/follower-lease): how long, for whom, how marked; 'none' answers without one. */
    leaseTtl: 3600,
    leaseDev: undefined as string | undefined,
    leaseKind: 'follower' as 'follower' | 'plain' | 'forged' | 'none',
    ai: {
      available: true,
      credit: { period: 'trial', allowanceCents: 30, usedCents: 2, remainingCents: 28, renewsAt: null },
      models: [{ id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', costFactor: 1 }]
    } as Record<string, unknown>,
    calls: [] as Call[]
  }
  const license = () => ({ plan: s.plan, trial: { limitSeconds: 25_200, usedSeconds: s.used, remainingSeconds: 25_200 - s.used } })
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    s.calls.push({ method: init?.method ?? 'GET', path, body, auth: headers.authorization })
    if (s.down) throw new TypeError('fetch failed')
    const fail = s.fail[path]
    if (fail) return fail.body === undefined ? new Response('oops', { status: fail.status, statusText: 'Broken' }) : json(fail.body, fail.status)
    switch (path) {
      case '/v1/meta':
        return json({ entitlementPublicKey: k.pem, webUrl: 'https://mindeck.test' })
      case '/v1/auth/login':
      case '/v1/auth/register':
        return json({ user: { email: body!.email, name: body!.name ?? null }, license: license(), session: { token: 'ws_secret' } })
      case '/v1/me':
        return json({ user: { email: 'robin@mindeck.test', name: 'Robin' }, license: license() })
      case '/v1/license/heartbeat': {
        if (s.lease === 'broken') return json({})
        const iat = Math.floor(clock.now / 1000)
        const claims = { sub: 'u1', email: 'robin@mindeck.test', plan: s.plan, active: s.active, reason: s.reason, rem: 1, ...(s.dev ? { dev: s.dev } : {}), iat, exp: iat + s.ttl }
        const token = s.lease === 'forged' ? signToken(JSON.stringify(claims), keys().privateKey) : signToken(JSON.stringify(claims), k.privateKey)
        const perpetual = { ...claims, ...(s.certDev ? { dev: s.certDev } : {}), perpetual: s.cert !== 'temporary', exp: iat + 100 * 365 * 86_400 }
        const certSigner = s.cert === 'forged' ? keys().privateKey : k.privateKey
        return json({
          license: license(),
          entitlement: s.lease ? { token } : null,
          nextHeartbeatSeconds: 60,
          ...(s.cert ? { offlineCertificate: signToken(JSON.stringify(perpetual), certSigner) } : {})
        })
      }
      case '/v1/license/follower-lease': {
        if (s.leaseKind === 'none') return json({ entitlement: null })
        const iat = Math.floor(clock.now / 1000)
        const claims = { sub: 'u1', email: 'robin@mindeck.test', plan: s.plan, active: s.active, reason: s.reason, rem: 1, dev: s.leaseDev ?? body!.installId, ...(s.leaseKind === 'plain' ? {} : { lease: 'follower' }), iat, exp: iat + s.leaseTtl }
        return json({ entitlement: { token: signToken(JSON.stringify(claims), s.leaseKind === 'forged' ? keys().privateKey : k.privateKey) } })
      }
      case '/v1/billing/checkout':
        return json({ url: 'https://checkout.stripe.test/1' })
      case '/v1/me/ai':
        return json(s.ai)
      default:
        return new Response(null, { status: 204 })
    }
  })
  return { s, fetch, k, last: (path: string) => [...s.calls].reverse().find((c) => c.path === path) }
}

// --- harness -------------------------------------------------------------------

const services: CloudService[] = []
afterEach(() => {
  services.splice(0).forEach((s) => s.dispose())
  vi.useRealTimers()
})

async function setup(
  opts: Partial<CloudServiceOptions> & { dir?: string; secrets?: SecretStore; offline?: boolean } = {}
) {
  const clock = { now: Date.parse('2026-10-10T10:00:00Z') }
  const cloud = fakeCloud(clock)
  cloud.s.down = !!opts.offline
  const dir = opts.dir ?? (await tempDir())
  const secrets = opts.secrets ?? new SecretStore(join(dir, 'secrets.json'))
  const onStatus = vi.fn()
  let userActive = true
  const svc = new CloudService({
    baseUrl: 'http://cloud.test',
    enforced: true,
    client: 'desktop',
    version: '0.2.0',
    deviceName: 'Studio',
    platform: 'darwin',
    file: join(dir, 'cloud.json'),
    secrets,
    isUserActive: () => userActive,
    onStatus,
    fetch: cloud.fetch as unknown as typeof fetch,
    now: () => clock.now,
    ...opts
  })
  services.push(svc)
  await svc.init()
  await vi.waitFor(() => expect(onStatus).toHaveBeenCalled())
  return {
    svc,
    cloud,
    clock,
    dir,
    secrets,
    onStatus,
    advance: (seconds: number) => void (clock.now += seconds * 1000),
    setUserActive: (v: boolean) => void (userActive = v),
    signIn: () => svc.login({ email: 'robin@mindeck.test', password: 'pw' })
  }
}

// --- tests -----------------------------------------------------------------------

describe('deriveState', () => {
  const claims = (over: Partial<EntitlementClaims> = {}): EntitlementClaims => ({
    sub: 'u',
    email: 'e',
    plan: 'trial',
    active: true,
    reason: 'ok',
    rem: 1,
    iat: 0,
    exp: 100,
    ...over
  })
  it('turns what the core knows into one state', () => {
    const base = { signedIn: true, now: 50_000, online: true }
    expect(deriveState({ ...base, signedIn: false, claims: null })).toBe('signed_out')
    expect(deriveState({ ...base, claims: claims({ active: false, reason: 'email_unverified' }) })).toBe('email_unverified')
    expect(deriveState({ ...base, claims: claims({ active: false, reason: 'trial_expired' }) })).toBe('trial_expired')
    expect(deriveState({ ...base, claims: claims() })).toBe('active')
    expect(deriveState({ ...base, now: 200_000, claims: claims() })).toBe('paused')
    expect(deriveState({ ...base, now: 200_000, online: false, claims: claims() })).toBe('offline')
    expect(deriveState({ ...base, claims: null })).toBe('checking')
  })

  it('keeps an expired trial lease usable only for a while once a renewal failed', () => {
    const base = { signedIn: true, online: true, claims: claims() } // ended at 100 s
    const late = 100_000 + PAUSE_GRACE_MS + 1
    expect(deriveState({ ...base, now: late })).toBe('paused') // nobody asked since: nobody was here
    expect(deriveState({ ...base, now: late, lastAttempt: 50_000 })).toBe('paused')
    expect(deriveState({ ...base, now: 100_000 + PAUSE_GRACE_MS, lastAttempt: 120_000 })).toBe('paused')
    expect(deriveState({ ...base, now: late, lastAttempt: 120_000 })).toBe('offline')
    expect(deriveState({ ...base, now: late, lastAttempt: 120_000, claims: claims({ plan: 'lifetime' }) })).toBe('paused')
  })

  it('a lifetime license’s offline certificate keeps Mindeck running without the cloud', () => {
    const cert = claims({ plan: 'lifetime', perpetual: true, exp: 4_000_000_000 })
    const base = { signedIn: true, now: 200_000, claims: claims({ plan: 'lifetime' }), offline: cert }
    expect(deriveState({ ...base, online: false })).toBe('active')
    expect(deriveState({ ...base, online: true, lastAttempt: 150_000 })).toBe('active')
    expect(deriveState({ ...base, online: false, claims: null })).toBe('active')
    // the cloud's word that the license ended wins
    expect(deriveState({ ...base, online: true, claims: claims({ active: false, reason: 'trial_expired' }) })).toBe('trial_expired')
    expect(holdsOffline(null, 0)).toBe(false)
    expect(holdsOffline(claims({ perpetual: false, exp: 4_000_000_000 }), 0)).toBe(false)
    expect(holdsOffline(claims({ perpetual: true, active: false, exp: 4_000_000_000 }), 0)).toBe(false)
    expect(holdsOffline(claims({ perpetual: true, exp: 1 }), 2000)).toBe(false)
    expect(deriveState({ ...base, online: false, offline: claims({ perpetual: true, exp: 1 }) })).toBe('offline')
  })
})

describe('entitlement tokens', () => {
  it('reads keys as PEM (also with escaped newlines) or base64 DER', () => {
    const k = keys()
    expect(parsePublicKey(k.pem).asymmetricKeyType).toBe('ed25519')
    expect(parsePublicKey(k.pem.replace(/\n/g, '\\n')).asymmetricKeyType).toBe('ed25519')
    expect(parsePublicKey(k.der).asymmetricKeyType).toBe('ed25519')
  })

  it('accepts only genuine tokens', () => {
    const k = keys()
    const key = parsePublicKey(k.pem)
    const good = signToken(JSON.stringify({ sub: 'u', exp: 1 }), k.privateKey)
    expect(verifyEntitlement(good, key)).toMatchObject({ sub: 'u', exp: 1 })
    expect(verifyEntitlement(signToken('{"sub":"u"}', keys().privateKey), key)).toBeNull()
    expect(verifyEntitlement('mindeck1.only-two', key)).toBeNull()
    expect(verifyEntitlement(good.replace('mindeck1.', 'mindeck2.'), key)).toBeNull()
    expect(verifyEntitlement(signToken('not json', k.privateKey), key)).toBeNull()
  })
})

describe('cloud config', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__MINDECK_CLOUD_URL__
    delete (globalThis as Record<string, unknown>).__MINDECK_CLOUD_KEY__
    delete (globalThis as Record<string, unknown>).__MINDECK_FOLLOWER__
  })

  it('reads the values baked in at build time', () => {
    expect(bakedCloud()).toEqual({ url: undefined, key: undefined })
    Object.assign(globalThis, { __MINDECK_CLOUD_URL__: '', __MINDECK_CLOUD_KEY__: '' })
    expect(bakedCloud()).toEqual({ url: undefined, key: undefined })
    Object.assign(globalThis, { __MINDECK_CLOUD_URL__: 'https://api.mindeck.test', __MINDECK_CLOUD_KEY__: 'KEY' })
    expect(bakedCloud()).toEqual({ url: 'https://api.mindeck.test', key: 'KEY' })
    Object.assign(globalThis, { __MINDECK_FOLLOWER__: '1' })
    expect(bakedCloud()).toEqual({ url: 'https://api.mindeck.test', key: 'KEY', follower: true })
    Object.assign(globalThis, { __MINDECK_FOLLOWER__: '' })
    expect(bakedCloud()).toEqual({ url: 'https://api.mindeck.test', key: 'KEY' })
  })

  it('locks release builds to the baked cloud; dev runs are open and configurable', () => {
    const baked = { url: 'https://api.mindeck.test/', key: 'BAKED' }
    const env = { MINDECK_CLOUD_URL: 'http://evil.test', MINDECK_CLOUD_KEY: 'EVIL', MINDECK_LICENSE: 'off' }
    expect(cloudConfig(true, env, baked)).toEqual({ url: 'https://api.mindeck.test', publicKey: 'BAKED', enforced: true })
    expect(cloudConfig(false, env, baked)).toEqual({ url: 'http://evil.test', publicKey: 'EVIL', enforced: false })
    expect(cloudConfig(false, {}, baked)).toEqual({ url: 'https://api.mindeck.test', publicKey: 'BAKED', enforced: false })
    expect(cloudConfig(false, { MINDECK_LICENSE: 'required' }, {})).toEqual({ url: DEV_CLOUD_URL, enforced: true })
    expect(cloudConfig(true, {}, {})).toEqual({ url: DEV_CLOUD_URL, enforced: true })
    expect(cloudConfig(false).enforced).toBe(false)
  })

  it('a release is a build with the cloud baked in — and a baked cloud needs its key', () => {
    expect(isReleaseBuild()).toBe(false)
    expect(isReleaseBuild({ url: 'https://api.mindeck.test', key: 'K' })).toBe(true)
    expect(cloudDefines({})).toEqual({ __MINDECK_CLOUD_URL__: '""', __MINDECK_CLOUD_KEY__: '""', __MINDECK_FOLLOWER__: '""' })
    expect(cloudDefines({ MINDECK_CLOUD_URL: 'https://api.mindeck.test', MINDECK_CLOUD_KEY: 'K' })).toEqual({
      __MINDECK_CLOUD_URL__: '"https://api.mindeck.test"',
      __MINDECK_CLOUD_KEY__: '"K"',
      __MINDECK_FOLLOWER__: '""'
    })
    // The server package for Remote-SSH / Dev Containers (remote/Dockerfile).
    expect(cloudDefines({ MINDECK_FOLLOWER_BUILD: '1' }).__MINDECK_FOLLOWER__).toBe('"1"')
    expect(() => cloudDefines({ MINDECK_CLOUD_URL: 'https://api.mindeck.test' })).toThrow('without MINDECK_CLOUD_KEY')
    expect(cloudDefines()).toHaveProperty('__MINDECK_CLOUD_URL__')
  })

  it('a core the desktop runs elsewhere follows its license — in a release only the server package built for that', () => {
    expect(cloudConfig(false, { MINDECK_LICENSE: 'follower' }, {})).toEqual({ url: DEV_CLOUD_URL, enforced: true, follower: true })
    expect(cloudConfig(true, { MINDECK_LICENSE: 'follower' }, { key: 'K', follower: true })).toEqual({ url: DEV_CLOUD_URL, publicKey: 'K', enforced: true, follower: true })
    // The desktop app, the Docker image, any other release server: the variable changes nothing — it signs in itself.
    expect(cloudConfig(true, { MINDECK_LICENSE: 'follower' }, { url: 'https://api.mindeck.test', key: 'K' })).toEqual({ url: 'https://api.mindeck.test', publicKey: 'K', enforced: true })
  })
})

describe('router license gate', () => {
  it('refuses licensed channels until Mindeck may run; sign-in channels always work', async () => {
    let licensed = false
    const router = new Router({ remoteTerminal: () => false, licensed: (ch) => isLicenseFree(ch) || licensed })
    router.register('projects:list', () => [])
    router.register('cloud:status', () => ({}) as never)
    router.register('app:info', () => ({}) as never)
    expect(await router.dispatch('projects:list', undefined, { transport: 'ipc' })).toEqual({
      ok: false,
      error: { code: 'license-required', message: expect.stringContaining('license') }
    })
    expect(await router.dispatch('cloud:status', undefined, { transport: 'remote' })).toMatchObject({ ok: true })
    expect(await router.dispatch('app:info', undefined, { transport: 'ipc' })).toMatchObject({ ok: true })
    expect(isLicenseFree('update:install')).toBe(true) // a locked app can still be updated
    expect(isLicenseFree('desktop:diagnostics')).toBe(true) // … and say what went wrong
    licensed = true
    expect(await router.dispatch('projects:list', undefined, { transport: 'ipc' })).toEqual({ ok: true, data: [] })
  })
})

describe('CloudService', () => {
  it('starts signed out: a fresh install id, nothing sent, locked only when enforced', async () => {
    const { svc, cloud, dir } = await setup()
    expect(svc.status()).toEqual({
      enforced: true,
      allowed: false,
      state: 'signed_out',
      account: null,
      license: null,
      validUntil: null,
      online: true,
      webUrl: null,
      error: null
    })
    expect(svc.allowed()).toBe(false)
    expect(cloud.s.calls).toHaveLength(0)
    const saved = JSON.parse(await readFile(join(dir, 'cloud.json'), 'utf8'))
    expect(saved.installId).toMatch(/^[0-9a-f-]{36}$/)
    const open = await setup({ enforced: false })
    expect(open.svc.status()).toMatchObject({ state: 'signed_out', allowed: true })
  })

  it('signs in as this device, keeps the token secret and holds a verified lease', async () => {
    const t = await setup()
    const status = await t.signIn()
    expect(status).toMatchObject({
      allowed: true,
      state: 'active',
      account: { email: 'robin@mindeck.test', name: null },
      license: { plan: 'trial', trialLimitSeconds: 25_200, trialUsedSeconds: 0, trialRemainingSeconds: 25_200 },
      validUntil: new Date(t.clock.now + 90_000).toISOString(),
      webUrl: 'https://mindeck.test',
      error: null
    })
    const login = t.cloud.last('/v1/auth/login')!
    expect(login.auth).toBeUndefined()
    expect(login.body).toMatchObject({
      email: 'robin@mindeck.test',
      client: 'desktop',
      device: { name: 'Studio', platform: 'darwin', appVersion: '0.2.0', installId: expect.any(String) }
    })
    expect(t.cloud.last('/v1/license/heartbeat')).toMatchObject({ auth: 'Bearer ws_secret', body: { appVersion: '0.2.0' } })
    expect(await t.secrets.get(SESSION_SECRET)).toBe('ws_secret')
    const file = await readFile(join(t.dir, 'cloud.json'), 'utf8')
    expect(file).not.toContain('ws_secret')
    expect(t.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'active' }))
  })

  it('the AI through the cloud: the session for it, the account’s credit and models — nothing when signed out, offline or not offered', async () => {
    const t = await setup()
    expect(await t.svc.sessionToken()).toBeNull()
    expect(await t.svc.aiInfo()).toBeNull()
    await t.signIn()
    expect(await t.svc.sessionToken()).toBe('ws_secret')
    expect(await t.svc.aiInfo()).toEqual({
      credit: { period: 'trial', allowanceCents: 30, usedCents: 2, remainingCents: 28, renewsAt: null },
      models: [{ id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', costFactor: 1 }]
    })
    expect(t.cloud.last('/v1/me/ai')).toMatchObject({ method: 'GET', auth: 'Bearer ws_secret' })
    t.cloud.s.ai = { available: false, credit: null, models: [] }
    expect(await t.svc.aiInfo()).toBeNull()
    t.cloud.s.down = true
    expect(await t.svc.aiInfo()).toBeNull()
    // A core the desktop runs elsewhere has no account of its own.
    const follower = await setup({ follower: true })
    expect(await follower.svc.aiInfo()).toBeNull()
  })

  it('registers with name and language', async () => {
    const t = await setup()
    await t.svc.register({ email: 'new@mindeck.test', password: 'long enough!', name: 'Robin', locale: 'de' })
    expect(t.cloud.last('/v1/auth/register')!.body).toMatchObject({ name: 'Robin', locale: 'de', client: 'desktop' })
    expect(t.svc.status().account).toEqual({ email: 'new@mindeck.test', name: 'Robin' })
  })

  it('passes sign-in errors through and stays signed out', async () => {
    const t = await setup()
    t.cloud.s.fail['/v1/auth/login'] = { status: 401, body: { error: { code: 'invalid_credentials', message: 'Email or password is wrong' } } }
    await expect(t.signIn()).rejects.toMatchObject({ code: 'invalid_credentials', message: 'Email or password is wrong' })
    expect(t.svc.status().state).toBe('signed_out')
  })

  it('renews a trial lease shortly before it ends — only while someone uses Mindeck', async () => {
    const t = await setup()
    await t.signIn()
    const beats = () => t.cloud.s.calls.filter((c) => c.path === '/v1/license/heartbeat').length
    t.advance(30)
    await t.svc.tick()
    expect(beats()).toBe(1) // 60 s left: not yet
    t.advance(20)
    await t.svc.tick()
    expect(beats()).toBe(2) // 40 s left: renewed

    t.setUserActive(false)
    t.advance(100)
    await t.svc.tick()
    expect(beats()).toBe(2)
    expect(t.svc.status()).toMatchObject({ state: 'paused', allowed: true }) // nobody here: the clock pauses

    t.svc.setRemoteClients(1) // a paired phone counts as use
    await t.svc.tick()
    expect(beats()).toBe(3)
    t.svc.setRemoteClients(0)
  })

  it('treats a core without a user signal as idle unless a device is connected', async () => {
    const t = await setup({ isUserActive: undefined })
    await t.signIn()
    t.advance(60)
    await t.svc.tick()
    expect(t.cloud.s.calls.filter((c) => c.path === '/v1/license/heartbeat')).toHaveLength(1)
  })

  it('locks a trial without the cloud, and retries after a pause', async () => {
    const t = await setup()
    await t.signIn()
    t.cloud.s.down = true
    t.advance(60)
    await t.svc.tick()
    t.advance(31)
    expect(t.svc.status()).toMatchObject({ state: 'offline', allowed: false, online: false, error: 'cloud-unreachable' })
    const attempts = t.cloud.s.calls.length
    t.advance(-20)
    await t.svc.tick() // 11 s after the failure: wait
    expect(t.cloud.s.calls.length).toBe(attempts)
    t.cloud.s.down = false
    t.advance(25)
    await t.svc.tick()
    expect(t.svc.status()).toMatchObject({ state: 'active', online: true, error: null })
  })

  it('keeps a lifetime license working offline and refreshes it now and then', async () => {
    const t = await setup()
    t.cloud.s.plan = 'lifetime'
    t.cloud.s.ttl = 14 * 86_400
    await t.signIn()
    const beats = () => t.cloud.s.calls.filter((c) => c.path === '/v1/license/heartbeat').length
    t.advance(60)
    await t.svc.tick()
    expect(beats()).toBe(1)
    t.cloud.s.down = true
    t.advance(16 * 60)
    await t.svc.tick()
    expect(beats()).toBe(2)
    expect(t.svc.status()).toMatchObject({ state: 'active', allowed: true, online: false, license: { plan: 'lifetime' } })
    t.advance(10)
    await t.svc.tick() // failed 10 s ago: rest first
    expect(beats()).toBe(2)
  })

  it('stops a trial whose renewals keep failing two hours after the lease ended (a cloud that answers 5xx)', async () => {
    const t = await setup()
    await t.signIn()
    t.cloud.s.fail['/v1/license/heartbeat'] = { status: 503 }
    t.advance(60)
    await t.svc.tick() // renewal due, fails
    t.advance(60)
    await t.svc.tick() // the lease has ended, the renewal still fails
    expect(t.svc.status()).toMatchObject({ state: 'paused', allowed: true, online: true, error: 'http-503' })
    t.advance(PAUSE_GRACE_MS / 1000)
    await t.svc.tick()
    expect(t.svc.status()).toMatchObject({ state: 'offline', allowed: false, error: 'http-503' })
    delete t.cloud.s.fail['/v1/license/heartbeat']
    t.advance(10)
    await t.svc.tick()
    expect(t.svc.status()).toMatchObject({ state: 'active', allowed: true, error: null })
  })

  it('lifetime: keeps the cloud’s offline certificate (encrypted with the secrets) and runs on it without the cloud', async () => {
    const t = await setup()
    t.cloud.s.plan = 'lifetime'
    t.cloud.s.cert = 'good'
    await t.signIn()
    const stored = await t.secrets.get(OFFLINE_SECRET)
    expect(stored).toMatch(/^mindeck1\./)
    expect(await readFile(join(t.dir, 'cloud.json'), 'utf8')).not.toContain(stored!)
    // the lease (90 s here) runs out while the cloud is gone — or answers 5xx
    t.cloud.s.down = true
    t.advance(20 * 60)
    await t.svc.tick()
    const status = t.svc.status()
    expect(status).toMatchObject({ state: 'active', allowed: true, online: false })
    expect(Date.parse(status.validUntil!)).toBeGreaterThan(t.clock.now + 90 * 365 * 86_400_000)
    t.cloud.s.down = false
    t.cloud.s.fail['/v1/license/heartbeat'] = { status: 500 }
    t.advance(20 * 60)
    await t.svc.tick()
    expect(t.svc.status()).toMatchObject({ state: 'active', online: true, error: 'http-500' })
    t.svc.dispose()

    // after a restart, still without the cloud
    const again = await setup({ dir: t.dir, secrets: t.secrets, offline: true })
    again.advance(3 * 86_400 * 365)
    expect(again.svc.status()).toMatchObject({ state: 'active', allowed: true })
  })

  it('lifetime: a certificate holds on the device it was issued to only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = await setup()
    t.cloud.s.plan = 'lifetime'
    t.cloud.s.cert = 'good'
    t.cloud.s.dev = 'dev-row-1' // the cloud's id for this install
    await t.signIn()
    expect(await t.secrets.get(OFFLINE_SECRET)).toBeDefined()
    expect(JSON.parse(await readFile(join(t.dir, 'cloud.json'), 'utf8')).deviceId).toBe('dev-row-1')
    // Bound by the install id works too.
    const installId = JSON.parse(await readFile(join(t.dir, 'cloud.json'), 'utf8')).installId as string
    t.cloud.s.certDev = installId
    await t.svc.refresh()
    expect(await t.secrets.get(OFFLINE_SECRET)).toBeDefined()
    // Another device's certificate: not kept.
    await t.secrets.set(OFFLINE_SECRET, null)
    t.cloud.s.certDev = 'someone-elses-device'
    await t.svc.refresh()
    expect(await t.secrets.get(OFFLINE_SECRET)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('offline certificate'))
    // …nor used when it is copied into this installation's store.
    t.cloud.s.certDev = undefined
    t.cloud.s.cert = 'good'
    await t.svc.refresh()
    const genuine = (await t.secrets.get(OFFLINE_SECRET))!
    t.svc.dispose()
    const saved = JSON.parse(await readFile(join(t.dir, 'cloud.json'), 'utf8')) as Record<string, unknown>
    const other = await tempDir()
    const store = new SecretStore(join(other, 'secrets.json'))
    await store.set(OFFLINE_SECRET, genuine)
    await store.set(SESSION_SECRET, 'ws_secret')
    await writeFile(join(other, 'cloud.json'), JSON.stringify({ ...saved, installId: 'another-install', deviceId: undefined, entitlement: null }))
    const copied = await setup({ dir: other, secrets: store, offline: true })
    copied.advance(3 * 86_400)
    expect(copied.svc.status().state).toBe('offline')
    // The installation it was issued to runs on it — also when saved before the device id was (its last lease names it).
    await writeFile(join(t.dir, 'cloud.json'), JSON.stringify({ ...saved, deviceId: undefined }))
    const original = await setup({ dir: t.dir, secrets: t.secrets, offline: true })
    original.advance(3 * 86_400)
    expect(original.svc.status().state).toBe('active')
    warn.mockRestore()
  })

  it('lifetime: a refund (the cloud says inactive) drops the certificate; an older cloud without it changes nothing', async () => {
    const t = await setup()
    t.cloud.s.plan = 'lifetime'
    t.cloud.s.cert = 'good'
    await t.signIn()
    expect(await t.secrets.get(OFFLINE_SECRET)).toBeDefined()
    // an older cloud (no field) and a lifetime license: the certificate stays
    t.cloud.s.cert = undefined
    await t.svc.refresh()
    expect(await t.secrets.get(OFFLINE_SECRET)).toBeDefined()
    // refunded: back to an expired trial
    t.cloud.s.plan = 'trial'
    t.cloud.s.active = false
    t.cloud.s.reason = 'trial_expired'
    await t.svc.refresh()
    expect(await t.secrets.get(OFFLINE_SECRET)).toBeUndefined()
    t.cloud.s.down = true
    t.advance(3600)
    expect(t.svc.status()).toMatchObject({ state: 'trial_expired', allowed: false })
  })

  it('lifetime: an inactive lease alone also drops it; forged or temporary certificates are ignored; sign-out forgets it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = await setup()
    t.cloud.s.plan = 'lifetime'
    t.cloud.s.cert = 'forged'
    await t.signIn()
    expect(await t.secrets.get(OFFLINE_SECRET)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('offline certificate'))
    t.cloud.s.cert = 'temporary' // genuine, but not perpetual
    await t.svc.refresh()
    expect(await t.secrets.get(OFFLINE_SECRET)).toBeUndefined()
    t.cloud.s.cert = 'good'
    await t.svc.refresh()
    expect(await t.secrets.get(OFFLINE_SECRET)).toBeDefined()
    t.cloud.s.cert = undefined
    t.cloud.s.active = false // still "lifetime", but the cloud says no
    await t.svc.refresh()
    expect(await t.secrets.get(OFFLINE_SECRET)).toBeUndefined()

    t.cloud.s.active = true
    t.cloud.s.cert = 'good'
    await t.svc.refresh()
    await t.svc.logout()
    expect(await t.secrets.get(OFFLINE_SECRET)).toBeUndefined()
    // signed out, a certificate left in the store is not even looked at
    await t.secrets.set(OFFLINE_SECRET, 'mindeck1.x.y')
    const again = await setup({ dir: t.dir, secrets: t.secrets, offline: true })
    expect(again.svc.status().state).toBe('signed_out')
  })

  it('reports what the cloud refuses, and re-checks every 30 s', async () => {
    const t = await setup()
    t.cloud.s.active = false
    t.cloud.s.reason = 'email_unverified'
    await t.signIn()
    expect(t.svc.status()).toMatchObject({ state: 'email_unverified', allowed: false })
    t.advance(10)
    await t.svc.tick()
    t.cloud.s.active = true
    t.cloud.s.reason = 'ok'
    t.advance(25)
    await t.svc.tick()
    expect(t.svc.status().state).toBe('active')
    t.cloud.s.active = false
    t.cloud.s.reason = 'trial_expired'
    await t.svc.refresh()
    expect(t.svc.status()).toMatchObject({ state: 'trial_expired', account: { name: 'Robin' } })
  })

  it('rejects entitlements it cannot verify and keeps the last good one', async () => {
    const t = await setup()
    await t.signIn()
    const until = t.svc.status().validUntil
    t.cloud.s.lease = 'forged'
    await t.svc.refresh()
    expect(t.svc.status()).toMatchObject({ error: 'bad-entitlement', validUntil: until })
    t.cloud.s.lease = false // a heartbeat without a lease leaves it as it is
    t.advance(31)
    await t.svc.refresh()
    expect(t.svc.status()).toMatchObject({ error: null, validUntil: until })
    t.cloud.s.lease = 'broken' // malformed answer
    await t.svc.refresh()
    expect(t.svc.status().error).toBe('error')
  })

  it('cannot verify anything with a broken built-in key', async () => {
    const t = await setup({ publicKey: 'not a key' })
    await t.signIn()
    expect(t.svc.status()).toMatchObject({ state: 'checking', error: 'bad-entitlement', webUrl: 'https://mindeck.test' })
  })

  it('signs out when the cloud ends the session or disables the account', async () => {
    const t = await setup()
    await t.signIn()
    t.cloud.s.fail['/v1/license/heartbeat'] = { status: 401, body: { error: { code: 'session_invalid' } } }
    await t.svc.refresh()
    expect(t.svc.status()).toMatchObject({ state: 'signed_out', error: 'session_expired', account: null })
    expect(await t.secrets.get(SESSION_SECRET)).toBeUndefined()

    delete t.cloud.s.fail['/v1/license/heartbeat']
    await t.signIn()
    t.cloud.s.fail['/v1/me'] = { status: 403, body: { error: { code: 'account_disabled', message: 'disabled' } } }
    await t.svc.refresh()
    expect(t.svc.status()).toMatchObject({ state: 'signed_out', error: 'account_disabled' })
  })

  it('notices a session token that vanished from the keychain', async () => {
    const t = await setup()
    await t.signIn()
    await t.secrets.set(SESSION_SECRET, null)
    await t.svc.refresh()
    expect(t.svc.status()).toMatchObject({ state: 'signed_out', error: 'session_expired' })
  })

  it('signs out on request (and tells the cloud)', async () => {
    const t = await setup()
    await t.svc.logout() // signed out already: nothing to tell
    expect(t.cloud.s.calls).toHaveLength(0)
    await t.signIn()
    const status = await t.svc.logout()
    expect(t.cloud.last('/v1/auth/logout')!.auth).toBe('Bearer ws_secret')
    expect(status).toMatchObject({ state: 'signed_out', account: null, license: null, validUntil: null })
    // the cloud not answering never keeps the user signed in
    await t.signIn()
    t.cloud.s.fail['/v1/auth/logout'] = { status: 503 }
    expect(await t.svc.logout()).toMatchObject({ state: 'signed_out', account: null })
  })

  it('refresh does nothing while signed out, and survives a failing account read', async () => {
    const t = await setup()
    expect((await t.svc.refresh()).state).toBe('signed_out')
    expect(t.cloud.s.calls).toHaveLength(0)
    await t.signIn()
    t.cloud.s.fail['/v1/me'] = { status: 500 }
    const status = await t.svc.refresh()
    expect(status.state).toBe('active')
    expect(t.cloud.last('/v1/license/heartbeat')).toBeTruthy()
  })

  it('shares one heartbeat between overlapping refreshes', async () => {
    const t = await setup()
    await t.signIn()
    const before = t.cloud.s.calls.filter((c) => c.path === '/v1/license/heartbeat').length
    await Promise.all([t.svc.refresh(), t.svc.refresh()])
    expect(t.cloud.s.calls.filter((c) => c.path === '/v1/license/heartbeat').length).toBe(before + 1)
  })

  it('resends the confirmation, asks for a reset link and opens a checkout', async () => {
    const t = await setup()
    await t.svc.forgotPassword({ email: 'robin@mindeck.test' })
    expect(t.cloud.last('/v1/auth/forgot-password')).toMatchObject({ auth: undefined, body: { email: 'robin@mindeck.test' } })
    await t.signIn()
    await t.svc.resendVerification()
    expect(t.cloud.last('/v1/auth/resend-verification')!.auth).toBe('Bearer ws_secret')
    expect(await t.svc.checkout()).toEqual({ url: 'https://checkout.stripe.test/1' })
    t.cloud.s.fail['/v1/billing/checkout'] = { status: 503, body: { error: { code: 'billing_unavailable' } } }
    await expect(t.svc.checkout()).rejects.toMatchObject({ code: 'billing_unavailable' })
    t.cloud.s.fail['/v1/billing/checkout'] = { status: 502 }
    await expect(t.svc.checkout()).rejects.toMatchObject({ code: 'http-502', message: 'Broken' })
    expect(t.svc.status().state).toBe('active')
  })

  it('authenticated API calls for other features (Settings Sync): any method, signed in only', async () => {
    const t = await setup()
    expect(t.svc.isSignedIn()).toBe(false)
    await t.signIn()
    expect(t.svc.isSignedIn()).toBe(true)
    await t.svc.api('PUT', '/v1/me/sync', { data: {}, baseVersion: 0 })
    expect(t.cloud.last('/v1/me/sync')).toMatchObject({ method: 'PUT', auth: 'Bearer ws_secret', body: { data: {}, baseVersion: 0 } })
    await t.svc.api('DELETE', '/v1/me/sync')
    expect(t.cloud.last('/v1/me/sync')).toMatchObject({ method: 'DELETE', body: undefined })
    t.cloud.s.fail['/v1/me/sync'] = { status: 409, body: { error: { code: 'sync_conflict', message: 'Settings were changed on another device' } } }
    await expect(t.svc.api('PUT', '/v1/me/sync', {})).rejects.toMatchObject({ code: 'sync_conflict' })
  })

  it('remote windows keep a trial lease going like a user at this machine', async () => {
    const t = await setup()
    await t.signIn()
    t.setUserActive(false)
    const beats = () => t.cloud.s.calls.filter((c) => c.path === '/v1/license/heartbeat').length
    const before = beats()
    t.advance(60)
    await t.svc.tick()
    expect(beats()).toBe(before)
    t.svc.setRemoteSessions(1)
    await t.svc.tick()
    expect(beats()).toBe(before + 1)
  })

  it('hands its entitlement to follower cores only while it is valid', async () => {
    const t = await setup()
    expect(t.svc.entitlement()).toBeNull()
    await t.signIn()
    expect(t.svc.entitlement()).toEqual({ token: expect.stringMatching(/^mindeck1\./), account: { email: 'robin@mindeck.test', name: null } })
    t.advance(120) // the trial lease ran out
    expect(t.svc.entitlement()).toBeNull()
    t.cloud.s.active = false
    t.cloud.s.reason = 'trial_expired'
    t.advance(-120)
    await t.svc.refresh()
    expect(t.svc.entitlement()).toBeNull()
  })

  it('a follower never signs in itself: it adopts the desktop’s entitlement (verified with the cloud’s key)', async () => {
    const leader = await setup()
    await leader.signIn()
    const { token, account } = leader.svc.entitlement()!
    const follower = await setup({ follower: true, publicKey: leader.cloud.k.pem })
    expect(follower.cloud.s.calls).toEqual([]) // no heartbeat, nothing
    expect(follower.svc.status()).toMatchObject({ state: 'signed_out', allowed: false })
    expect(await follower.svc.adopt(token, account)).toMatchObject({ state: 'active', allowed: true, account })
    await expect(follower.svc.adopt('mindeck1.forged.sig', account)).rejects.toMatchObject({ code: 'bad-entitlement' })
    expect(follower.svc.status().state).toBe('active')
    follower.advance(120)
    expect(follower.svc.status()).toMatchObject({ allowed: false, state: 'offline' }) // until the desktop hands a fresh one over
    // Only the desktop's current lease: not one that ran out (copied from a cloud.json), not one the cloud
    // refused, never a lifetime license's offline certificate (bound to its device, valid for good).
    await expect(follower.svc.adopt(token, account)).rejects.toMatchObject({ code: 'bad-entitlement', message: expect.stringContaining('not valid') })
    const now = Math.floor(follower.clock.now / 1000)
    const claims = { sub: 'u1', email: 'robin@mindeck.test', plan: 'lifetime', active: true, reason: 'ok', rem: 0, dev: 'desktop-1', iat: now, exp: now + 90 }
    const signed = (over: Record<string, unknown>) => signToken(JSON.stringify({ ...claims, ...over }), leader.cloud.k.privateKey)
    await expect(follower.svc.adopt(signed({ active: false, reason: 'trial_expired' }), account)).rejects.toMatchObject({ code: 'bad-entitlement' })
    await expect(follower.svc.adopt(signed({ perpetual: true, exp: now + 100 * 365 * 86_400 }), account)).rejects.toMatchObject({
      code: 'bad-entitlement',
      message: expect.stringContaining('offline certificate')
    })
    expect(follower.svc.status()).toMatchObject({ allowed: false, state: 'offline' })
    expect(await follower.svc.adopt(signed({}), account)).toMatchObject({ state: 'active', allowed: true })
    // Without a built-in key it asks the cloud for it (and can't verify without it).
    const keyless = await setup({ follower: true })
    await expect(keyless.svc.adopt(token, account)).rejects.toMatchObject({ code: 'bad-entitlement' }) // its cloud's key isn't the leader's
    expect(keyless.cloud.s.calls.map((c) => c.path)).toEqual(['/v1/meta'])
    const offline = await setup({ follower: true, offline: true })
    await expect(offline.svc.adopt(token, account)).rejects.toMatchObject({ code: 'bad-entitlement' })
    // A core that signs in itself doesn't adopt.
    await expect(leader.svc.adopt(token, account)).rejects.toMatchObject({ code: 'not-follower' })
  })

  it('desktop: asks Mindeck Cloud for a follower lease bound to the remote core, keeps it until half of it passed (BE-SEC-09)', async () => {
    const t = await setup()
    expect(await t.svc.followerLease('remote-1')).toBeNull() // signed out: no license to lease from
    await t.signIn()
    const lease = await t.svc.followerLease('remote-1')
    expect(lease).toEqual({ token: expect.stringMatching(/^mindeck1\./), account: { email: 'robin@mindeck.test', name: null } })
    expect(t.cloud.last('/v1/license/follower-lease')).toMatchObject({ method: 'POST', auth: 'Bearer ws_secret', body: { installId: 'remote-1', appVersion: '0.2.0' } })
    expect(verifyEntitlement(lease!.token, parsePublicKey(t.cloud.k.pem))).toMatchObject({ dev: 'remote-1', lease: 'follower' })
    const asked = () => t.cloud.s.calls.filter((c) => c.path === '/v1/license/follower-lease').length
    // Kept for half its time (the trial lease of the desktop is renewed meanwhile).
    t.cloud.s.ttl = 86_400
    await t.svc.refresh()
    t.advance(1700)
    expect((await t.svc.followerLease('remote-1'))!.token).toBe(lease!.token)
    expect(asked()).toBe(1)
    t.advance(200)
    expect((await t.svc.followerLease('remote-1'))!.token).not.toBe(lease!.token)
    expect(asked()).toBe(2)
    // Another core: its own lease.
    await t.svc.followerLease('remote-2')
    expect(t.cloud.last('/v1/license/follower-lease')!.body).toMatchObject({ installId: 'remote-2' })

    // The cloud unreachable: a lease still held goes on; none held: none.
    t.advance(2000)
    t.cloud.s.down = true
    const held = await t.svc.followerLease('remote-1')
    expect(held).not.toBeNull()
    t.advance(2000) // that one ran out too
    expect(await t.svc.followerLease('remote-1')).toBeNull()
    t.cloud.s.down = false
    await t.svc.refresh()

    // What the cloud sends must be a lease for that core: else ignored.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const [kind, dev] of [['plain', undefined], ['forged', undefined], ['follower', 'remote-9'], ['none', undefined]] as const) {
      t.cloud.s.leaseKind = kind
      t.cloud.s.leaseDev = dev
      expect(await t.svc.followerLease('remote-3'), kind).toBeNull()
    }
    expect(warn).toHaveBeenCalledWith('[cloud] ignoring a follower lease that is not valid for that core')
    t.cloud.s.leaseKind = 'follower'
    t.cloud.s.leaseDev = undefined
    t.cloud.s.leaseTtl = -1
    expect(await t.svc.followerLease('remote-3')).toBeNull() // ran out already
    t.cloud.s.leaseTtl = 3600
    t.cloud.s.active = false
    t.cloud.s.reason = 'trial_expired'
    expect(await t.svc.followerLease('remote-3')).toBeNull() // inactive
    t.cloud.s.active = true
    t.cloud.s.reason = 'ok'
    warn.mockRestore()

    // A cloud without leases (404): not asked again for an hour — the desktop hands over its own then.
    t.cloud.s.fail['/v1/license/follower-lease'] = { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } }
    expect(await t.svc.followerLease('remote-4')).toBeNull()
    const before = asked()
    t.advance(30 * 60)
    expect(await t.svc.followerLease('remote-4')).toBeNull()
    expect(asked()).toBe(before)
    delete t.cloud.s.fail['/v1/license/follower-lease']
    t.advance(31 * 60)
    await t.svc.refresh()
    expect(await t.svc.followerLease('remote-4')).not.toBeNull()
    // Another failure (5xx) is no "no leases": asked again next time.
    t.cloud.s.fail['/v1/license/follower-lease'] = { status: 503 }
    expect(await t.svc.followerLease('remote-5')).toBeNull()
    delete t.cloud.s.fail['/v1/license/follower-lease']
    expect(await t.svc.followerLease('remote-5')).not.toBeNull()
    // A follower leases nothing on.
    expect(await (await setup({ follower: true })).svc.followerLease('x')).toBeNull()
  })

  it('a follower takes a lease only for itself, and the desktop’s own entitlement only for a day — never again once it had a lease (BE-SEC-09)', async () => {
    const leader = await setup()
    leader.cloud.s.plan = 'lifetime'
    leader.cloud.s.ttl = 14 * 86_400 // a lifetime lease holds for weeks
    await leader.signIn()
    const own = leader.svc.entitlement()!
    const follower = await setup({ follower: true, publicKey: leader.cloud.k.pem })
    follower.clock.now = leader.clock.now
    const installId = follower.svc.installId()
    expect(installId).toMatch(/^[0-9a-f-]{36}$/)

    // Transition: the desktop's own entitlement — a day from the hand-over at most.
    expect(await follower.svc.adopt(own.token, own.account)).toMatchObject({ state: 'active', validUntil: new Date(follower.clock.now + FOLLOWER_HANDOVER_MS).toISOString().replace(/\.\d+Z$/, '.000Z') })
    follower.advance(FOLLOWER_HANDOVER_MS / 1000 + 1)
    expect(follower.svc.status()).toMatchObject({ allowed: false, state: 'offline' }) // the desktop stopped handing it over
    leader.clock.now = follower.clock.now
    await leader.svc.refresh()
    const again = leader.svc.entitlement()!
    expect(await follower.svc.adopt(again.token, again.account)).toMatchObject({ state: 'active' }) // handed over again: another day
    // Restarted: the same day still counts, not the entitlement's weeks.
    const restarted = await setup({ follower: true, publicKey: leader.cloud.k.pem, dir: follower.dir })
    restarted.clock.now = follower.clock.now + FOLLOWER_HANDOVER_MS - 1000
    expect(restarted.svc.status()).toMatchObject({ state: 'active' })
    restarted.advance(2)
    expect(restarted.svc.status()).toMatchObject({ allowed: false })

    // A lease for another core is refused; one for this core is taken — and from then on only leases.
    leader.clock.now = follower.clock.now
    const other = (await leader.svc.followerLease('another-core'))!
    await expect(follower.svc.adopt(other.token, other.account)).rejects.toMatchObject({ code: 'bad-entitlement', message: expect.stringContaining('another core') })
    const mine = (await leader.svc.followerLease(installId))!
    expect(await follower.svc.adopt(mine.token, mine.account)).toMatchObject({ state: 'active', validUntil: expect.any(String) })
    expect(Date.parse(follower.svc.status().validUntil!)).toBe((Math.floor(follower.clock.now / 1000) + 3600) * 1000)
    await expect(follower.svc.adopt(again.token, again.account)).rejects.toMatchObject({ code: 'lease-required' })
    // Restarted on its lease: still its own; copied to another core (another install id) it holds nothing.
    const back = await setup({ follower: true, publicKey: leader.cloud.k.pem, dir: follower.dir })
    back.clock.now = follower.clock.now
    expect(back.svc.status()).toMatchObject({ state: 'active' })
    const saved = JSON.parse(await readFile(join(follower.dir, 'cloud.json'), 'utf8'))
    expect(saved).toMatchObject({ leased: true, installId })
    const copy = await tempDir()
    await writeFile(join(copy, 'cloud.json'), JSON.stringify({ ...saved, installId: 'someone-else' }))
    const copied = await setup({ follower: true, publicKey: leader.cloud.k.pem, dir: copy })
    copied.clock.now = follower.clock.now
    expect(copied.svc.status()).toMatchObject({ allowed: false })
    // A saved entitlement from before leases and hand-over times: held for nothing until the desktop hands one over.
    const legacy = await tempDir()
    await writeFile(join(legacy, 'cloud.json'), JSON.stringify({ ...saved, leased: undefined, adoptedAt: undefined, entitlement: again.token, installId: 'x' }))
    const old = await setup({ follower: true, publicKey: leader.cloud.k.pem, dir: legacy })
    old.clock.now = follower.clock.now
    expect(old.svc.status()).toMatchObject({ allowed: false })
    // A leased core whose saved entitlement is the desktop's own (written by hand): nothing.
    const mixed = await tempDir()
    await writeFile(join(mixed, 'cloud.json'), JSON.stringify({ ...saved, entitlement: again.token }))
    const odd = await setup({ follower: true, publicKey: leader.cloud.k.pem, dir: mixed })
    odd.clock.now = follower.clock.now
    expect(odd.svc.status()).toMatchObject({ allowed: false })
  })

  it('remembers the account across restarts — a lifetime license even without the cloud', async () => {
    const first = await setup()
    first.cloud.s.plan = 'lifetime'
    first.cloud.s.ttl = 14 * 86_400
    await first.signIn()
    first.svc.dispose()

    const again = await setup({ dir: first.dir, secrets: first.secrets, offline: true })
    expect(again.svc.status()).toMatchObject({ state: 'active', allowed: true, account: { email: 'robin@mindeck.test' }, license: { plan: 'lifetime' } })
    const saved = JSON.parse(await readFile(join(first.dir, 'cloud.json'), 'utf8'))
    expect(saved.installId).toBe(JSON.parse(await readFile(join(again.dir, 'cloud.json'), 'utf8')).installId)
  })

  it('ignores a damaged state file and a remembered lease it cannot check', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'cloud.json'), 'null')
    expect((await setup({ dir })).svc.status().state).toBe('signed_out')
    await writeFile(join(dir, 'cloud.json'), '{ broken')
    expect((await setup({ dir })).svc.status().state).toBe('signed_out')
    await writeFile(
      join(dir, 'cloud.json'),
      JSON.stringify({ installId: 'abc', account: { email: 'a@b.c', name: null }, license: null, entitlement: 'mindeck1.a.b', publicKey: null, webUrl: null })
    )
    await new SecretStore(join(dir, 'secrets.json')).set(OFFLINE_SECRET, 'mindeck1.a.b') // no key to check it with
    const t = await setup({ dir, enforced: false, offline: true })
    await vi.waitFor(() => expect(t.svc.status().online).toBe(false))
    expect(t.svc.status()).toMatchObject({ state: 'offline', allowed: true, validUntil: null, error: 'cloud-unreachable' })
  })

  it('works without injected fetch or clock, and ticks on its own', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const dir = await tempDir()
    const onStatus = vi.fn()
    const svc = new CloudService({
      baseUrl: 'http://cloud.test',
      enforced: false,
      client: 'server',
      version: '1',
      deviceName: 'srv',
      platform: 'linux',
      file: join(dir, 'cloud.json'),
      secrets: new SecretStore(join(dir, 's.json')),
      onStatus
    })
    services.push(svc)
    await svc.init()
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledTimes(1))
    const tick = vi.spyOn(svc, 'tick')
    vi.advanceTimersByTime(10_000)
    expect(tick).toHaveBeenCalledTimes(1)
    expect(onStatus).toHaveBeenCalledTimes(1) // nothing changed, nothing re-sent
  })
})
