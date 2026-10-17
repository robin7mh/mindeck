import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudService, deriveState, FOLLOWER_HANDOVER_MS, holdsOffline, KEYS_HEADER, LEGACY_CERT_SECONDS, OFFLINE_SECRET, PAUSE_GRACE_MS, SESSION_SECRET, type CloudServiceOptions } from '../../../electron/main/services/cloud/CloudService'
import { announcedKids, keyId, parsePublicKey, parsePublicKeys, trustedKeys, verifyEntitlement, verifyRevocations, type EntitlementClaims } from '../../../electron/main/services/cloud/entitlement'
import { bakedCloud, cloudConfig, cloudDefines, cloudKeyDefine, DEV_CLOUD_URL, isReleaseBuild } from '../../../electron/main/services/cloud/config'
import { SecretStore } from '../../../electron/main/services/ai/SecretStore'
import { Router } from '../../../electron/ipc/router'
import { isLicenseFree } from '@shared/types/cloud'
import { tempDir } from './helpers'

// --- a fake Mindeck Cloud that signs real entitlements -------------------------

type KeyPair = ReturnType<typeof keys>

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey,
    publicKey,
    pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    der: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    kid: keyId(publicKey)
  }
}

function signToken(payload: string, privateKey: KeyObject, prefix = 'mindeck1'): string {
  const body = Buffer.from(payload).toString('base64url')
  return `${prefix}.${body}.${sign(null, Buffer.from(`${prefix}.${body}`), privateKey).toString('base64url')}`
}

/** Signed as Mindeck Cloud signs (`signEntitlement`): the signing key's id added to the claims. */
function signClaims(claims: object, key: KeyPair): string {
  return signToken(JSON.stringify({ ...claims, kid: key.kid }), key.privateKey)
}

/** The cloud's signed revocation list (`GET /v1/license/revocations`). */
function signRevocations(revokedKids: string[], key: KeyPair, nowSeconds: number, over: Record<string, unknown> = {}): string {
  return signToken(JSON.stringify({ kid: key.kid, iat: nowSeconds, exp: nowSeconds + 7 * 86_400, revokedKids, ...over }), key.privateKey, 'mindeck-rl1')
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

interface Call {
  method: string
  path: string
  body: Record<string, unknown> | undefined
  auth: string | undefined
  /** The `Mindeck-Keys` header: the key ids the core trusts. */
  keys: string | undefined
}

function fakeCloud(clock: { now: number }, k: KeyPair = keys()) {
  // k: the legacy key — the oldest still in use, `entitlementPublicKey` of /v1/meta.
  const s = {
    /** The account's id (`user.id` on sign-in; an older cloud: undefined) and the `sub` of what it signs. */
    userId: 'u1' as string | undefined,
    sub: 'u1' as string | undefined,
    /** Claims the offline certificate gets on top (another account's `sub`, another plan …). */
    certOver: {} as Record<string, unknown>,
    /** After a rotation: the active key — it signs for cores that announce it (`Mindeck-Keys`), the legacy key for the others. */
    next: null as KeyPair | null,
    /** Tokens as clouds before key ids signed them: without `kid`. */
    noKid: false,
    /** Key ids it revoked; how it answers GET /v1/license/revocations. */
    revoked: [] as string[],
    revocations: 'good' as 'good' | 'forged' | 'expired' | 'missing' | 'garbled' | 'self',
    /** /v1/meta as clouds before key ids answered it (no `entitlementKeys`/`revokedKeyIds`). */
    oldMeta: false,
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
    s.calls.push({ method: init?.method ?? 'GET', path, body, auth: headers.authorization, keys: headers[KEYS_HEADER] })
    // As KeyRing.signerFor: the active key for a core that names it, else the legacy key.
    const signer = s.next && (headers[KEYS_HEADER] ?? '').split(',').includes(s.next.kid) ? s.next : k
    const issue = (claims: object, key: KeyPair = signer) => (s.noKid ? signToken(JSON.stringify(claims), key.privateKey) : signClaims(claims, key))
    if (s.down) throw new TypeError('fetch failed')
    const fail = s.fail[path]
    if (fail) return fail.body === undefined ? new Response('oops', { status: fail.status, statusText: 'Broken' }) : json(fail.body, fail.status)
    switch (path) {
      case '/v1/meta':
        return json({
          entitlementPublicKey: k.pem,
          webUrl: 'https://mindeck.test',
          ...(s.oldMeta ? {} : { entitlementKeys: [...(s.next ? [{ kid: s.next.kid, publicKey: s.next.pem, active: true }] : []), { kid: k.kid, publicKey: k.pem, active: !s.next }], revokedKeyIds: s.revoked })
        })
      case '/v1/auth/login':
      case '/v1/auth/register':
        return json({ user: { ...(s.userId ? { id: s.userId } : {}), email: body!.email, name: body!.name ?? null }, license: license(), session: { token: 'ws_secret' } })
      case '/v1/me':
        return json({ user: { id: 'u1', email: 'robin@mindeck.test', name: 'Robin' }, license: license() })
      case '/v1/license/revocations': {
        const now = Math.floor(clock.now / 1000)
        const forger = keys()
        const doc = {
          good: signRevocations(s.revoked, signer, now),
          // signed by a key the core doesn't know, though it names the cloud's
          forged: signRevocations(s.revoked, forger, now, { kid: signer.kid }),
          expired: signRevocations(s.revoked, signer, now, { exp: now - 1 }),
          missing: undefined,
          garbled: signRevocations(s.revoked, signer, now, { revokedKids: [1, 2] }),
          // a list naming no key, as an entitlement would: no fallback to the legacy key
          self: signToken(JSON.stringify({ iat: now, exp: now + 60, revokedKids: s.revoked }), signer.privateKey, 'mindeck-rl1')
        }[s.revocations]
        return json({ revokedKids: s.revoked, ...(doc ? { revocations: doc } : {}) })
      }
      case '/v1/license/heartbeat': {
        if (s.lease === 'broken') return json({})
        const iat = Math.floor(clock.now / 1000)
        const claims = { sub: s.sub, email: 'robin@mindeck.test', plan: s.plan, active: s.active, reason: s.reason, rem: 1, ...(s.dev ? { dev: s.dev } : {}), iat, exp: iat + s.ttl }
        const token = s.lease === 'forged' ? issue(claims, keys()) : issue(claims)
        const perpetual = { ...claims, ...(s.certDev ? { dev: s.certDev } : {}), perpetual: s.cert !== 'temporary', exp: iat + 100 * 365 * 86_400, ...s.certOver }
        return json({
          license: license(),
          entitlement: s.lease ? { token } : null,
          nextHeartbeatSeconds: 60,
          ...(s.cert ? { offlineCertificate: s.cert === 'forged' ? issue(perpetual, keys()) : issue(perpetual) } : {})
        })
      }
      case '/v1/license/follower-lease': {
        if (s.leaseKind === 'none') return json({ entitlement: null })
        const iat = Math.floor(clock.now / 1000)
        const claims = { sub: 'u1', email: 'robin@mindeck.test', plan: s.plan, active: s.active, reason: s.reason, rem: 1, dev: s.leaseDev ?? body!.installId, ...(s.leaseKind === 'plain' ? {} : { lease: 'follower' }), iat, exp: iat + s.leaseTtl }
        return json({ entitlement: { token: s.leaseKind === 'forged' ? issue(claims, keys()) : issue(claims) } })
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

interface KeyPairs {
  /** The cloud's legacy key. */
  k: KeyPair
  /** The next key (a rotation: `cloud.s.next`). */
  next: KeyPair
}

async function setup(
  opts: Partial<CloudServiceOptions> & {
    dir?: string
    secrets?: SecretStore
    offline?: boolean
    /** The same keys across several cores and restarts. */
    pair?: KeyPairs
    /** MINDECK_CLOUD_KEY of this build, from the keys. */
    builtIn?: (pair: KeyPairs) => string
  } = {}
) {
  const clock = { now: Date.parse('2026-10-10T10:00:00Z') }
  const pair = opts.pair ?? { k: keys(), next: keys() }
  const cloud = fakeCloud(clock, pair.k)
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
    ...(opts.builtIn ? { publicKey: opts.builtIn(pair) } : {}),
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
    pair,
    next: pair.next,
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
    expect(deriveState({ ...base, claims: claims({ plan: 'lifetime', active: false, reason: 'license_suspended' }) })).toBe('license_suspended')
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
    expect(holdsOffline(claims({ perpetual: true, exp: 4_000_000_000 }), 0)).toBe(false) // a trial's: never
    expect(holdsOffline(cert, 0)).toBe(true)
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
    const key = trustedKeys([parsePublicKey(k.pem)])!
    const good = signToken(JSON.stringify({ sub: 'u', exp: 1 }), k.privateKey)
    expect(verifyEntitlement(good, key)).toMatchObject({ sub: 'u', exp: 1 })
    expect(verifyEntitlement(signToken('{"sub":"u"}', keys().privateKey), key)).toBeNull()
    expect(verifyEntitlement('mindeck1.only-two', key)).toBeNull()
    expect(verifyEntitlement(good.replace('mindeck1.', 'mindeck2.'), key)).toBeNull()
    expect(verifyEntitlement(signToken('not json', k.privateKey), key)).toBeNull()
    expect(verifyEntitlement(signToken('null', k.privateKey), key)).toBeNull()
    expect(verifyEntitlement(signToken('5', k.privateKey), key)).toBeNull()
  })

  it('computes key ids exactly as Mindeck Cloud does (first 16 characters of base64url SHA-256 of the SPKI DER)', () => {
    // RFC 8032 test vector 1; the id from mindeck-cloud's keyId() for the same key.
    const der = 'MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo='
    expect(keyId(parsePublicKey(der))).toBe('BuP9j9opu2CrWVV9')
    const k = keys()
    expect(keyId(parsePublicKey(k.pem))).toBe(createHash('sha256').update(Buffer.from(k.der, 'base64')).digest('base64url').slice(0, 16))
  })

  it('reads MINDECK_CLOUD_KEY as a list — PEM or base64 DER, by comma or line, the original key first', () => {
    const [a, b, c] = [keys(), keys(), keys()]
    const kids = (raw: string) => parsePublicKeys(raw).map(keyId)
    expect(kids(a.pem)).toEqual([a.kid])
    expect(kids(`${a.der},${b.der}`)).toEqual([a.kid, b.kid])
    expect(kids(`${a.pem}${b.der}\n${c.pem}`)).toEqual([a.kid, b.kid, c.kid])
    expect(kids(` ${a.pem.replace(/\n/g, '\\n')} ,\n ${b.der} `)).toEqual([a.kid, b.kid])
    expect(kids('')).toEqual([])
    expect(trustedKeys([])).toBeNull()
    expect(() => parsePublicKeys(`${a.der},not-a-key`)).toThrow()
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect(() => parsePublicKeys(`${a.der},${rsa}`)).toThrow('Ed25519')
  })

  it('picks the key by the token’s kid — never tries the others; a token without kid: the original key only (rotation, CL-SEC-06)', () => {
    const [old, next, stranger] = [keys(), keys(), keys()]
    const ring = trustedKeys([old.publicKey, next.publicKey])!
    expect(ring.legacyKid).toBe(old.kid)
    const claims = { sub: 'u', exp: 1 }
    expect(verifyEntitlement(signClaims(claims, old), ring)).toMatchObject({ kid: old.kid })
    expect(verifyEntitlement(signClaims(claims, next), ring)).toMatchObject({ kid: next.kid })
    // From before key ids: the legacy key, and only it.
    expect(verifyEntitlement(signToken(JSON.stringify(claims), old.privateKey), ring)).toMatchObject({ sub: 'u' })
    expect(verifyEntitlement(signToken(JSON.stringify(claims), next.privateKey), ring)).toBeNull()
    // A kid that names another trusted key than the one that signed, an unknown kid, a kid that is no string.
    expect(verifyEntitlement(signToken(JSON.stringify({ ...claims, kid: next.kid }), old.privateKey), ring)).toBeNull()
    expect(verifyEntitlement(signClaims(claims, stranger), ring)).toBeNull()
    expect(verifyEntitlement(signToken(JSON.stringify({ ...claims, kid: 7 }), old.privateKey), ring)).toBeNull()
    // Revoked: its tokens, and — if it is the legacy key — every token without kid.
    expect(verifyEntitlement(signClaims(claims, next), ring, new Set([next.kid]))).toBeNull()
    expect(verifyEntitlement(signClaims(claims, old), ring, new Set([next.kid]))).not.toBeNull()
    expect(verifyEntitlement(signToken(JSON.stringify(claims), old.privateKey), ring, new Set([old.kid]))).toBeNull()
    expect(announcedKids(ring, new Set())).toEqual([old.kid, next.kid])
    expect(announcedKids(ring, new Set([old.kid]))).toEqual([next.kid])
  })

  it('accepts a revocation list only when signed by a trusted key it names, unexpired, listing key ids', () => {
    const [old, next, stranger] = [keys(), keys(), keys()]
    const ring = trustedKeys([old.publicKey, next.publicKey])!
    const now = 1_000_000
    const none = new Set<string>()
    expect(verifyRevocations(signRevocations([old.kid], next, now), ring, none, now)).toEqual([old.kid])
    expect(verifyRevocations(signRevocations([], old, now), ring, none, now)).toEqual([])
    // forged, by an unknown key, by a revoked key, without kid (no legacy fallback for lists)
    expect(verifyRevocations(signRevocations([next.kid], stranger, now, { kid: old.kid }), ring, none, now)).toBeNull()
    expect(verifyRevocations(signRevocations([next.kid], stranger, now), ring, none, now)).toBeNull()
    expect(verifyRevocations(signRevocations([next.kid], old, now), ring, new Set([old.kid]), now)).toBeNull()
    expect(verifyRevocations(signToken(JSON.stringify({ exp: now + 60, revokedKids: [] }), old.privateKey, 'mindeck-rl1'), ring, none, now)).toBeNull()
    // run out, no exp, no list, not a list of strings
    expect(verifyRevocations(signRevocations([], old, now, { exp: now }), ring, none, now)).toBeNull()
    expect(verifyRevocations(signRevocations([], old, now, { exp: 'later' }), ring, none, now)).toBeNull()
    expect(verifyRevocations(signRevocations([], old, now, { revokedKids: 'all' }), ring, none, now)).toBeNull()
    expect(verifyRevocations(signRevocations([], old, now, { revokedKids: [null] }), ring, none, now)).toBeNull()
    // never an entitlement for a list, nor a list for an entitlement
    const entitlement = signClaims({ sub: 'u', exp: now + 60, revokedKids: [] }, old)
    expect(verifyRevocations(entitlement, ring, none, now)).toBeNull()
    expect(verifyEntitlement(signRevocations([], old, now), ring)).toBeNull()
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
    const key = keys().der
    expect(cloudDefines({ MINDECK_CLOUD_URL: 'https://api.mindeck.test', MINDECK_CLOUD_KEY: key })).toEqual({
      __MINDECK_CLOUD_URL__: '"https://api.mindeck.test"',
      __MINDECK_CLOUD_KEY__: JSON.stringify(key),
      __MINDECK_FOLLOWER__: '""'
    })
    // The server package for Remote-SSH / Dev Containers (remote/Dockerfile).
    expect(cloudDefines({ MINDECK_FOLLOWER_BUILD: '1' }).__MINDECK_FOLLOWER__).toBe('"1"')
    expect(() => cloudDefines({ MINDECK_CLOUD_URL: 'https://api.mindeck.test' })).toThrow('without MINDECK_CLOUD_KEY')
    expect(cloudDefines()).toHaveProperty('__MINDECK_CLOUD_URL__')
  })

  it('bakes in a list of keys after a rotation — and fails the build on one that is no Ed25519 public key', () => {
    const [a, b] = [keys(), keys()]
    expect(cloudKeyDefine({})).toBe('""')
    expect(cloudKeyDefine({ MINDECK_CLOUD_KEY: `${a.der},${b.der}` })).toBe(JSON.stringify(`${a.der},${b.der}`))
    expect(JSON.parse(cloudKeyDefine({ MINDECK_CLOUD_KEY: `${a.pem}\n${b.pem}` }))).toBe(`${a.pem}\n${b.pem}`)
    expect(() => cloudKeyDefine({ MINDECK_CLOUD_KEY: `${a.der},${b.der.slice(4)}` })).toThrow('MINDECK_CLOUD_KEY holds a key that is not an Ed25519 public key')
    expect(() => cloudDefines({ MINDECK_CLOUD_URL: 'https://api.mindeck.test', MINDECK_CLOUD_KEY: 'K' })).toThrow('not an Ed25519 public key')
    expect(cloudKeyDefine()).toEqual(expect.any(String))
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
      offlineUntil: null,
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
    expect(verifyEntitlement(lease!.token, trustedKeys([parsePublicKey(t.cloud.k.pem)])!)).toMatchObject({ dev: 'remote-1', lease: 'follower' })
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

// --- signing keys: rotation, revocation, offline certificates (CL-SEC-06) ----------

/** The key id a token names (its payload, unverified). */
const kidOf = (token: string) => (JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { kid?: string }).kid
const saved = async (dir: string) => JSON.parse(await readFile(join(dir, 'cloud.json'), 'utf8')) as Record<string, unknown>
const SIX_HOURS = 6 * 3600

describe('CloudService: signing keys', () => {
  it('names the keys it trusts on license calls only (Mindeck-Keys), so the cloud signs with one of them', async () => {
    const t = await setup({ builtIn: ({ k, next }) => `${k.pem}\n${next.der}` })
    await t.signIn()
    const both = `${t.pair.k.kid},${t.next.kid}`
    expect(t.cloud.last('/v1/license/heartbeat')!.keys).toBe(both)
    expect(t.cloud.last('/v1/license/revocations')).toMatchObject({ method: 'GET', keys: both, auth: undefined })
    expect(t.cloud.last('/v1/auth/login')!.keys).toBeUndefined()
    expect(t.cloud.last('/v1/meta')!.keys).toBeUndefined()
    await t.svc.followerLease('remote-1')
    expect(t.cloud.last('/v1/license/follower-lease')!.keys).toBe(both)
    await t.svc.api('GET', '/v1/me/sync')
    expect(t.cloud.last('/v1/me/sync')!.keys).toBeUndefined()
  })

  it('after a rotation the new key signs for a core that knows it, the old one for a core that doesn’t — both hold', async () => {
    const pair = { k: keys(), next: keys() }
    const builtIn = ({ k, next }: KeyPairs) => `${k.der},${next.pem.replace(/\n/g, '\\n')}`
    const t = await setup({ pair, builtIn })
    t.cloud.s.next = pair.next
    expect((await t.signIn()).state).toBe('active')
    const token = (await saved(t.dir)).entitlement as string
    expect(kidOf(token)).toBe(pair.next.kid)
    t.svc.dispose()
    const again = await setup({ pair, builtIn, dir: t.dir, secrets: t.secrets, offline: true })
    expect(again.svc.status().state).toBe('active') // verified with the new key after a restart
    // A build from before the rotation knows the old key only: it keeps getting tokens signed with it.
    const old = await setup({ pair, builtIn: ({ k }) => k.pem })
    old.cloud.s.next = pair.next
    expect((await old.signIn()).state).toBe('active')
    expect(old.cloud.last('/v1/license/heartbeat')!.keys).toBe(pair.k.kid)
    expect(kidOf((await saved(old.dir)).entitlement as string)).toBe(pair.k.kid)
  })

  it('entitlements from before key ids (no kid) hold with the original key — and only with it', async () => {
    const t = await setup({ builtIn: ({ k, next }) => `${k.pem},${next.pem}` })
    t.cloud.s.noKid = true
    expect((await t.signIn()).state).toBe('active')
    expect(kidOf((await saved(t.dir)).entitlement as string)).toBeUndefined()
    // Signed by the other trusted key without saying so: not tried with it.
    t.cloud.s.next = t.next
    await t.svc.refresh()
    expect(t.svc.status().error).toBe('bad-entitlement')
  })

  it('a revoked key is remembered for good, and nothing it signed holds — entitlement, offline certificate, follower leases', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pair = { k: keys(), next: keys() }
    const builtIn = ({ k, next }: KeyPairs) => `${k.pem},${next.pem}`
    const t = await setup({ pair, builtIn })
    t.cloud.s.plan = 'lifetime'
    t.cloud.s.ttl = 14 * 86_400
    t.cloud.s.cert = 'good'
    await t.signIn()
    const oldCert = (await t.secrets.get(OFFLINE_SECRET))!
    expect(kidOf(oldCert)).toBe(pair.k.kid)
    const follower = await setup({ pair, builtIn, follower: true })
    follower.clock.now = t.clock.now
    const oldLease = (await t.svc.followerLease(follower.svc.installId()))!
    expect(oldLease.revokedKids).toBeUndefined() // nothing revoked yet: nothing to hand over
    expect(await follower.svc.adopt(oldLease.token, oldLease.account)).toMatchObject({ state: 'active' })
    const otherLease = (await t.svc.followerLease('remote-2'))!

    // The old key leaked: an emergency rotation revokes it.
    t.cloud.s.next = pair.next
    t.cloud.s.revoked = [pair.k.kid]
    t.advance(SIX_HOURS)
    await t.svc.refresh()
    expect(warn).toHaveBeenCalledWith(`[cloud] signing key(s) revoked by Mindeck Cloud: ${pair.k.kid}`)
    expect(t.svc.status()).toMatchObject({ state: 'active', error: null })
    expect(await saved(t.dir)).toMatchObject({ revokedKids: [pair.k.kid] })
    expect(kidOf((await saved(t.dir)).entitlement as string)).toBe(pair.next.kid)
    expect(kidOf((await t.secrets.get(OFFLINE_SECRET))!)).toBe(pair.next.kid)
    expect(t.cloud.last('/v1/license/heartbeat')!.keys).toBe(pair.next.kid) // the revoked key is not announced any more
    // Follower leases it signed are asked for anew — and the desktop tells its followers what it revoked.
    const lease = (await t.svc.followerLease('remote-2'))!
    expect(lease.token).not.toBe(otherLease.token)
    expect(kidOf(lease.token)).toBe(pair.next.kid)
    expect(lease.revokedKids).toEqual([pair.k.kid])
    expect(t.svc.entitlement()).toMatchObject({ revokedKids: [pair.k.kid] })

    // The follower: its lease signed with the revoked key holds no more once the desktop says so …
    await expect(follower.svc.adopt('mindeck1.bogus.sig', oldLease.account, [pair.k.kid])).rejects.toMatchObject({ code: 'bad-entitlement' })
    expect(follower.svc.status()).toMatchObject({ allowed: false })
    expect(await saved(follower.dir)).toMatchObject({ revokedKids: [pair.k.kid] })
    await expect(follower.svc.adopt(oldLease.token, oldLease.account)).rejects.toMatchObject({ code: 'bad-entitlement' })
    const fresh = (await t.svc.followerLease(follower.svc.installId()))!
    expect(await follower.svc.adopt(fresh.token, fresh.account, fresh.revokedKids)).toMatchObject({ state: 'active' })

    // The cloud forgets the revocation (a restore, a mistake): the core does not.
    t.cloud.s.revoked = []
    t.advance(SIX_HOURS)
    await t.svc.refresh()
    expect(await saved(t.dir)).toMatchObject({ revokedKids: [pair.k.kid] })
    expect(t.cloud.last('/v1/license/heartbeat')!.keys).toBe(pair.next.kid)

    // Offline, after a restart: the old certificate (put back into the store) holds no more; the new one does.
    const newCert = (await t.secrets.get(OFFLINE_SECRET))!
    t.svc.dispose()
    await t.secrets.set(OFFLINE_SECRET, oldCert)
    const restarted = await setup({ pair, builtIn, dir: t.dir, secrets: t.secrets, offline: true })
    restarted.advance(30 * 86_400) // the 14-day lease ran out
    expect(restarted.svc.status()).toMatchObject({ state: 'offline', allowed: false, offlineUntil: null })
    restarted.svc.dispose()
    await t.secrets.set(OFFLINE_SECRET, newCert)
    const back = await setup({ pair, builtIn, dir: t.dir, secrets: t.secrets, offline: true })
    back.advance(30 * 86_400)
    expect(back.svc.status()).toMatchObject({ state: 'active', allowed: true })
    warn.mockRestore()
  })

  it('a core whose every key is revoked names none and trusts nothing', async () => {
    const t = await setup({ builtIn: ({ k }) => k.pem })
    t.cloud.s.revoked = [t.pair.k.kid]
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await t.signIn()
    expect(t.svc.status()).toMatchObject({ state: 'checking', allowed: false, error: 'bad-entitlement' })
    expect(t.cloud.last('/v1/license/heartbeat')!.keys).toBeUndefined()
  })

  it('ignores a revocation list it cannot verify and asks again in an hour — an older cloud (404) too, an unreachable one with the next heartbeat', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = await setup({ builtIn: ({ k }) => k.pem })
    const asked = () => t.cloud.s.calls.filter((c) => c.path === '/v1/license/revocations').length
    t.cloud.s.plan = 'lifetime'
    t.cloud.s.ttl = 14 * 86_400
    await t.signIn()
    expect(asked()).toBe(1)
    // Within six hours: not again.
    t.advance(SIX_HOURS - 60)
    await t.svc.refresh()
    expect(asked()).toBe(1)
    t.cloud.s.revoked = [t.pair.k.kid] // if any of these counted, nothing would verify any more
    for (const kind of ['forged', 'expired', 'missing', 'garbled', 'self'] as const) {
      t.cloud.s.revocations = kind
      t.advance(SIX_HOURS)
      await t.svc.refresh()
      expect(t.svc.status(), kind).toMatchObject({ state: 'active', error: null })
    }
    expect(warn).toHaveBeenCalledWith('[cloud] ignoring a revocation list this core cannot verify')
    expect((await saved(t.dir)).revokedKids).toBeUndefined()
    const bad = asked()
    t.advance(30 * 60)
    await t.svc.refresh()
    expect(asked()).toBe(bad) // an hour after a bad one
    t.cloud.s.revoked = []
    t.cloud.s.revocations = 'good'
    t.cloud.s.fail['/v1/license/revocations'] = { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } }
    t.advance(31 * 60)
    await t.svc.refresh()
    expect(asked()).toBe(bad + 1)
    expect(t.svc.status()).toMatchObject({ state: 'active', error: null }) // an older cloud: the heartbeat goes on
    t.advance(30 * 60)
    await t.svc.refresh()
    expect(asked()).toBe(bad + 1)
    delete t.cloud.s.fail['/v1/license/revocations']
    t.cloud.s.down = true
    t.advance(31 * 60)
    await t.svc.refresh()
    expect(asked()).toBe(bad + 2)
    t.cloud.s.down = false
    t.advance(31)
    await t.svc.refresh()
    expect(asked()).toBe(bad + 3) // unreachable: asked with the next heartbeat
  })

  it('dev builds (no key built in) take the keys and revoked ids from /v1/meta on first use', async () => {
    const t = await setup()
    t.cloud.s.next = t.next
    t.cloud.s.revoked = ['an-old-key-id']
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await t.signIn()
    expect(await saved(t.dir)).toMatchObject({ publicKey: t.pair.k.pem, publicKeys: [t.next.pem, t.pair.k.pem], revokedKids: ['an-old-key-id'] })
    expect(t.cloud.last('/v1/license/heartbeat')!.keys).toBe(`${t.pair.k.kid},${t.next.kid}`)
    expect(kidOf((await saved(t.dir)).entitlement as string)).toBe(t.next.kid)
    // A cloud from before key ids: its one key.
    const old = await setup()
    old.cloud.s.oldMeta = true
    expect((await old.signIn()).state).toBe('active')
    expect(await saved(old.dir)).toMatchObject({ publicKeys: [] })
    expect(old.cloud.last('/v1/license/heartbeat')!.keys).toBe(old.pair.k.kid)
  })
})

describe('CloudService: offline certificates', () => {
  it('reports when the certificate ends (offlineUntil) — none without one', async () => {
    const t = await setup()
    t.cloud.s.plan = 'lifetime'
    await t.signIn()
    expect(t.svc.status().offlineUntil).toBeNull()
    t.cloud.s.cert = 'good'
    await t.svc.refresh()
    const iat = Math.floor(t.clock.now / 1000)
    expect(t.svc.status().offlineUntil).toBe(new Date((iat + 100 * 365 * 86_400) * 1000).toISOString())
  })

  it('holds only for the signed-in account and a lifetime plan', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = await setup()
    t.cloud.s.plan = 'lifetime'
    t.cloud.s.cert = 'good'
    t.cloud.s.certOver = { sub: 'someone-else' }
    await t.signIn()
    expect(await t.secrets.get(OFFLINE_SECRET)).toBeUndefined()
    t.cloud.s.certOver = { plan: 'trial' }
    await t.svc.refresh()
    expect(await t.secrets.get(OFFLINE_SECRET)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[cloud] ignoring an offline certificate this core cannot verify')
    t.cloud.s.certOver = {}
    await t.svc.refresh()
    expect(await t.secrets.get(OFFLINE_SECRET)).toBeDefined()
    expect(await saved(t.dir)).toMatchObject({ accountId: 'u1' })
    // Signed out: the account's id goes too.
    await t.svc.logout()
    expect((await saved(t.dir)).accountId).toBeUndefined()
  })

  it('knows the account by its first entitlement when the cloud (or an older cloud.json) doesn’t say', async () => {
    const t = await setup()
    t.cloud.s.userId = undefined // an older cloud
    t.cloud.s.plan = 'lifetime'
    t.cloud.s.cert = 'good'
    await t.signIn()
    expect(await t.secrets.get(OFFLINE_SECRET)).toBeDefined()
    expect(await saved(t.dir)).toMatchObject({ accountId: 'u1' })
    t.svc.dispose()
    // Saved before the account's id was: the stored entitlement names it.
    const before = await saved(t.dir)
    await writeFile(join(t.dir, 'cloud.json'), JSON.stringify({ ...before, accountId: undefined }))
    const again = await setup({ dir: t.dir, secrets: t.secrets, offline: true })
    again.advance(30 * 86_400)
    expect(again.svc.status()).toMatchObject({ state: 'active' })
    again.svc.dispose()
    // Nothing names the account: the certificate doesn't hold.
    await writeFile(join(t.dir, 'cloud.json'), JSON.stringify({ ...before, accountId: undefined, entitlement: null }))
    const unknown = await setup({ dir: t.dir, secrets: t.secrets, offline: true })
    expect(unknown.svc.status()).toMatchObject({ state: 'offline', offlineUntil: null })
    // …nor one that names no account, when neither does anything else.
    const none = await setup()
    none.cloud.s.userId = undefined
    none.cloud.s.sub = undefined
    none.cloud.s.plan = 'lifetime'
    none.cloud.s.cert = 'good'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await none.signIn()
    expect(await none.secrets.get(OFFLINE_SECRET)).toBeUndefined()
  })

  it('a certificate from before key ids (no kid, issued for 100 years) holds 400 days from its issue at most', async () => {
    const t = await setup()
    t.cloud.s.noKid = true
    t.cloud.s.plan = 'lifetime'
    t.cloud.s.cert = 'good'
    await t.signIn()
    const iat = Math.floor(t.clock.now / 1000)
    expect(t.svc.status().offlineUntil).toBe(new Date((iat + LEGACY_CERT_SECONDS) * 1000).toISOString())
    t.svc.dispose()
    const again = await setup({ dir: t.dir, secrets: t.secrets, offline: true })
    again.advance(LEGACY_CERT_SECONDS - 60)
    expect(again.svc.status()).toMatchObject({ state: 'active' })
    again.advance(120)
    expect(again.svc.status()).toMatchObject({ state: 'offline', allowed: false })
  })

  it('a disputed payment pauses a lifetime license: its own state, and the certificate goes until it is settled', async () => {
    const t = await setup()
    t.cloud.s.plan = 'lifetime'
    t.cloud.s.cert = 'good'
    await t.signIn()
    expect(await t.secrets.get(OFFLINE_SECRET)).toBeDefined()
    t.cloud.s.active = false
    t.cloud.s.reason = 'license_suspended'
    t.cloud.s.cert = undefined
    await t.svc.refresh()
    expect(t.svc.status()).toMatchObject({ state: 'license_suspended', allowed: false, license: { plan: 'lifetime' }, offlineUntil: null })
    expect(await t.secrets.get(OFFLINE_SECRET)).toBeUndefined()
    t.cloud.s.active = true
    t.cloud.s.reason = 'ok'
    t.advance(31)
    await t.svc.tick()
    expect(t.svc.status()).toMatchObject({ state: 'active', allowed: true })
  })
})

describe('CloudService: new refusals', () => {
  it('too many devices: the sign-in fails with device_limit, and the core learns where the website (its device list) is', async () => {
    const limit = { status: 403, body: { error: { code: 'device_limit', message: 'Signed in on 3 computers already', details: { limit: 3, devices: [] } } } }
    const t = await setup()
    t.cloud.s.fail['/v1/auth/login'] = limit
    await expect(t.signIn()).rejects.toMatchObject({ code: 'device_limit', status: 403 })
    expect(t.svc.status()).toMatchObject({ state: 'signed_out', webUrl: 'https://mindeck.test' })
    expect(t.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ webUrl: 'https://mindeck.test' }))
    // The website unknown as well (the meta fails too): still the device limit.
    const u = await setup()
    u.cloud.s.fail['/v1/auth/register'] = limit
    u.cloud.s.fail['/v1/meta'] = { status: 500 }
    await expect(u.svc.register({ email: 'a@b.c', password: 'long enough!', locale: 'en' })).rejects.toMatchObject({ code: 'device_limit' })
    expect(u.svc.status().webUrl).toBeNull()
  })

  it('the cloud AI switched off for the account: blocked, with credit and models still shown', async () => {
    const t = await setup()
    await t.signIn()
    t.cloud.s.ai = { ...t.cloud.s.ai, blocked: true }
    expect(await t.svc.aiInfo()).toMatchObject({ blocked: true, models: [{ id: 'claude-haiku-5-5' }] })
    t.cloud.s.ai = { ...t.cloud.s.ai, blocked: false }
    expect(await t.svc.aiInfo()).not.toHaveProperty('blocked')
  })
})
