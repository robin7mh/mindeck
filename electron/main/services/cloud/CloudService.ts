import type { AiCredit, AiStatus } from '@shared/types/ai'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  USABLE_STATES,
  type CloudAccount,
  type CloudLicense,
  type CloudStatus,
  type LicenseState
} from '@shared/types/cloud'
import type { SecretStore } from '../ai/SecretStore'
import { readJson } from '../../lib/jsonFile'
import { announcedKids, parsePublicKeys, trustedKeys, verifyEntitlement, verifyRevocations, type EntitlementClaims, type TrustedKeys } from './entitlement'

/** The session token's name in the secret store (keychain on desktop). */
export const SESSION_SECRET = 'cloud.session'
/** A lifetime license's offline certificate, kept like the session (encrypted on desktop). */
export const OFFLINE_SECRET = 'cloud.offline'

const TICK_MS = 10_000
/** Pause after a failed call, and between re-checks while the cloud says no. */
const RETRY_MS = 30_000
/** A trial lease is renewed this long before it ends (it lasts 90 s). */
const RENEW_BEFORE_MS = 45_000
/** Lifetime: refreshed now and then (refunds, revocations), else valid offline. */
const LIFETIME_REFRESH_MS = 15 * 60_000
/**
 * A trial lease that ran out stays usable this long while the cloud answers
 * but renews nothing (a 5xx, an empty answer) — not for good.
 */
export const PAUSE_GRACE_MS = 2 * 60 * 60_000
/**
 * A follower takes the desktop's own entitlement over only while Mindeck
 * Cloud issues no follower leases — and for this long after the desktop last
 * handed it over, however long the entitlement itself would hold.
 */
export const FOLLOWER_HANDOVER_MS = 24 * 60 * 60_000
/** A cloud without follower leases (404) is asked again after this long. */
const LEASE_RETRY_MS = 60 * 60_000
/** The cloud's signed list of revoked signing keys is fetched again after this long (it is valid for 7 days). */
const REVOCATIONS_REFRESH_MS = 6 * 60 * 60_000
/**
 * An offline certificate from before key ids (no `kid`) was issued for 100
 * years: it holds this long from its issue at most. Newer ones last a year
 * and are renewed with every heartbeat.
 */
export const LEGACY_CERT_SECONDS = 400 * 86_400
/** Request header with the ids of the keys this core trusts — Mindeck Cloud signs with one of them (README → "Signing keys"). */
export const KEYS_HEADER = 'mindeck-keys'

export interface CloudServiceOptions {
  baseUrl: string
  /** Entitlement key(s), the legacy key first (parsePublicKeys); without one they are fetched from the cloud (and remembered). */
  publicKey?: string
  enforced: boolean
  /** How this core signs in: the desktop app, or a headless server/Docker core. */
  client: 'desktop' | 'server'
  version: string
  deviceName: string
  platform: string
  /** ~/Mindeck/data/cloud.json — account, last entitlement, install id. */
  file: string
  secrets: Pick<SecretStore, 'get' | 'set'>
  /** Someone is at this machine (desktop: not idle). Absent on a headless server. */
  isUserActive?: () => boolean
  onStatus: (status: CloudStatus) => void
  fetch?: typeof fetch
  now?: () => number
  /** A core run by the desktop app elsewhere: no sign-in of its own, it adopts the desktop's entitlement. */
  follower?: boolean
}

interface Persisted {
  installId: string
  /** The id Mindeck Cloud gave this install (the `dev` of its verified leases) — what offline certificates are bound to. */
  deviceId?: string
  account: CloudAccount | null
  license: CloudLicense | null
  entitlement: string | null
  /** Without keys built in (dev): the cloud's `entitlementPublicKey` — the legacy key — trusted on first use. */
  publicKey: string | null
  /** …and the other keys its /v1/meta listed (`entitlementKeys`), PEM. */
  publicKeys?: string[]
  /** Every signing key id Mindeck Cloud said is revoked. Only ever grows: a token signed with one is never trusted again, offline neither. */
  revokedKids?: string[]
  /** The signed-in account's id (`sub` of its entitlements) — an offline certificate must name it. */
  accountId?: string
  webUrl: string | null
  /** Follower: when the desktop last handed over its own entitlement (not a lease) — it holds FOLLOWER_HANDOVER_MS from then at most. */
  adoptedAt?: number
  /** Follower: it ran on a lease of its own once — from then on it takes leases only (the cloud issues them). */
  leased?: boolean
}

interface ApiUser {
  id?: string
  email: string
  name: string | null
}
interface ApiLicense {
  plan: 'trial' | 'lifetime'
  trial: { limitSeconds: number; usedSeconds: number; remainingSeconds: number }
}
interface AuthResponse {
  user: ApiUser
  license: ApiLicense
  session: { token: string }
}
interface HeartbeatResponse {
  license: ApiLicense
  entitlement: { token: string } | null
  /** Lifetime accounts (newer clouds): a perpetual entitlement for running without the cloud. */
  offlineCertificate?: string
}
interface Meta {
  entitlementPublicKey: string
  webUrl: string
  /** Newer clouds: every key a core may trust, and the ids it must not (dev builds take them on first use). */
  entitlementKeys?: { kid: string; publicKey: string; active: boolean }[]
  revokedKeyIds?: string[]
}
interface RevocationsResponse {
  revokedKids: string[]
  /** `mindeck-rl1.<payload>.<signature>` — only this signed copy counts. */
  revocations: string
}
/** An entitlement as it is handed to a follower core — with the key ids this core knows to be revoked. */
export interface Handover {
  token: string
  account: CloudAccount
  revokedKids?: string[]
}
interface FollowerLeaseResponse {
  entitlement: { token: string } | null
}

function coded(code: string, message: string, status?: number): Error {
  return Object.assign(new Error(message), { code }, status === undefined ? {} : { status })
}

const toAccount = (u: ApiUser): CloudAccount => ({ email: u.email, name: u.name })
const toLicense = (l: ApiLicense): CloudLicense => ({
  plan: l.plan,
  trialLimitSeconds: l.trial.limitSeconds,
  trialUsedSeconds: l.trial.usedSeconds,
  trialRemainingSeconds: l.trial.remainingSeconds
})

/** A verified offline certificate that still holds: lifetime, active, perpetual. */
export function holdsOffline(cert: EntitlementClaims | null, now: number): cert is EntitlementClaims {
  return !!cert && cert.perpetual === true && cert.active && cert.plan === 'lifetime' && cert.exp * 1000 > now
}

/**
 * The license state from what the core knows. A fresh entitlement decides;
 * so does a lifetime license's offline certificate, with or without the
 * cloud. An active lease that ran out stays usable while the cloud is
 * reachable (nobody was using Mindeck, or the renewal is on its way) — a
 * trial's only until a renewal tried after it ran out has failed for
 * PAUSE_GRACE_MS. Without the cloud and without a valid entitlement, Mindeck
 * waits.
 */
export function deriveState(i: {
  signedIn: boolean
  claims: EntitlementClaims | null
  now: number
  online: boolean
  /** The lifetime license's offline certificate (verified), if any. */
  offline?: EntitlementClaims | null
  /** When the core last asked the cloud for a lease. */
  lastAttempt?: number
}): LicenseState {
  if (!i.signedIn) return 'signed_out'
  const c = i.claims
  if (c && !c.active) return c.reason === 'email_unverified' || c.reason === 'license_suspended' ? c.reason : 'trial_expired'
  if (c && c.exp * 1000 > i.now) return 'active'
  if (holdsOffline(i.offline ?? null, i.now)) return 'active'
  if (!i.online) return 'offline'
  if (!c) return 'checking'
  const ended = c.exp * 1000
  const tried = (i.lastAttempt ?? 0) > ended
  return c.plan === 'trial' && tried && i.now > ended + PAUSE_GRACE_MS ? 'offline' : 'paused'
}

/**
 * The core's link to Mindeck Cloud: sign-in, the trial heartbeat and the signed
 * entitlement that says whether Mindeck may run. The session token lives in the
 * secret store; the rest in cloud.json, so a lifetime license keeps working
 * offline after a restart.
 */
export class CloudService {
  private data: Persisted = {
    installId: '',
    account: null,
    license: null,
    entitlement: null,
    publicKey: null,
    webUrl: null
  }
  private claims: EntitlementClaims | null = null
  /** The lifetime license's offline certificate, verified — and as stored. */
  private offline: EntitlementClaims | null = null
  private offlineToken: string | null = null
  private keys: TrustedKeys | null = null
  /** `revokedKids` as a set. */
  private revoked = new Set<string>()
  /** The revocation list is not asked for before this. */
  private revocationsDue = 0
  private online = true
  private error: string | null = null
  private lastAttempt = 0
  private lastSuccess = 0
  private remoteClients = 0
  private remoteSessions = 0
  private beating: Promise<void> | null = null
  private timer?: ReturnType<typeof setInterval>
  private lastEmitted = ''
  /** Desktop: the follower leases it got, per follower install id (renewed when half of one has passed). */
  private readonly leases = new Map<string, { token: string; claims: EntitlementClaims }>()
  /** Desktop: Mindeck Cloud said it issues no follower leases (404) — not asked again before this. */
  private noLeasesUntil = 0
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(private readonly opts: CloudServiceOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch
    this.now = opts.now ?? Date.now
  }

  /** Loads the remembered account and entitlement; the first heartbeat runs in the background. */
  async init(): Promise<void> {
    this.data = { ...this.data, ...(await this.load()) }
    if (!this.data.installId) {
      this.data.installId = randomUUID()
      await this.save()
    }
    this.revoked = new Set(this.data.revokedKids)
    this.keys = this.trustedKeys()
    this.claims = this.verify(this.data.entitlement)
    // A follower's last entitlement holds as it did when it was handed over (a lease for this core, or briefly the desktop's).
    if (this.opts.follower) this.claims = this.followerClaims(this.claims)
    else {
      // Saved before the device (or the account's id) was remembered: the last lease names it (a lifetime license offline still starts).
      this.data.deviceId ??= this.claims?.dev
      this.data.accountId ??= this.claims?.sub
    }
    const cert = this.data.account ? await this.opts.secrets.get(OFFLINE_SECRET) : undefined
    this.keepCertificate(cert ? this.verifyOffline(cert) : null, cert)
    // A follower only ever hears from the desktop (cloud:adopt).
    if (this.opts.follower) return this.emit()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
    void this.tick()
  }

  dispose(): void {
    clearInterval(this.timer)
  }

  /** The account's session (null when signed out) — the AI through the cloud signs in with it. */
  async sessionToken(): Promise<string | null> {
    return (this.data.account && (await this.opts.secrets.get(SESSION_SECRET))) || null
  }

  /** The account's AI credit and models — null when signed out, offline, a follower or the cloud offers no AI. */
  async aiInfo(): Promise<AiStatus['cloud']> {
    if (!this.data.account || this.opts.follower) return null
    const res = await this.call<{ available: boolean; blocked?: boolean; credit: AiCredit | null; models: { id: string; label: string; costFactor: number }[] }>('GET', '/v1/me/ai').catch(() => null)
    return res?.available && res.credit ? { credit: res.credit, models: res.models, ...(res.blocked ? { blocked: true as const } : {}) } : null
  }

  status(): CloudStatus {
    const now = this.now()
    const state = deriveState({
      signedIn: !!this.data.account,
      claims: this.claims,
      now,
      // A follower never hears from the cloud: an entitlement that ran out locks it until the desktop hands over a new one.
      online: this.online && !this.opts.follower,
      offline: this.offline,
      lastAttempt: this.lastAttempt
    })
    // Running on the offline certificate: it says how long.
    const cert = holdsOffline(this.offline, now) ? this.offline : null
    const until = this.claims && this.claims.exp * 1000 > now ? this.claims : (cert ?? this.claims)
    return {
      enforced: this.opts.enforced,
      allowed: !this.opts.enforced || USABLE_STATES.includes(state),
      state,
      account: this.data.account,
      license: this.data.license,
      validUntil: until ? new Date(until.exp * 1000).toISOString() : null,
      offlineUntil: cert ? new Date(cert.exp * 1000).toISOString() : null,
      online: this.online,
      webUrl: this.data.webUrl,
      error: this.error
    }
  }

  /** Paired devices connected right now — someone uses Mindeck through them. */
  setRemoteClients(count: number): void {
    this.remoteClients = count
  }

  /** Remote windows (SSH, Dev Containers) open right now — Mindeck is in use there, on this license. */
  setRemoteSessions(count: number): void {
    this.remoteSessions = count
  }

  /** Someone is using Mindeck: at this machine, through a connected device, or in a remote window. */
  private inUse(): boolean {
    return this.remoteClients > 0 || this.remoteSessions > 0 || (this.opts.isUserActive?.() ?? false)
  }

  /** May Mindeck be used right now? (The Router asks before every licensed call.) */
  allowed(): boolean {
    return this.status().allowed
  }

  login(req: { email: string; password: string }): Promise<CloudStatus> {
    return this.signIn('/v1/auth/login', req)
  }

  register(req: { email: string; password: string; name?: string; locale: 'de' | 'en' }): Promise<CloudStatus> {
    return this.signIn('/v1/auth/register', req)
  }

  async logout(): Promise<CloudStatus> {
    if (this.data.account) await this.call('POST', '/v1/auth/logout', {}).catch(() => {})
    await this.forget(null)
    return this.status()
  }

  /** Re-reads the account and renews the entitlement now ("check again"). */
  async refresh(): Promise<CloudStatus> {
    if (!this.data.account) return this.status()
    try {
      const me = await this.call<{ user: ApiUser; license: ApiLicense }>('GET', '/v1/me')
      this.data.account = toAccount(me.user)
      this.data.license = toLicense(me.license)
      await this.save()
    } catch (err) {
      this.note(err)
    }
    // Still signed in (the cloud may just have ended the session or disabled the account)?
    if (this.data.account) await this.beat()
    return this.status()
  }

  async resendVerification(): Promise<void> {
    await this.call('POST', '/v1/auth/resend-verification', {})
  }

  async forgotPassword(req: { email: string }): Promise<void> {
    await this.call('POST', '/v1/auth/forgot-password', req, false)
  }

  /** A Stripe Checkout for this account; the client opens the URL in a browser. */
  /** The entitlement a follower core (Remote-SSH, Dev Container) takes over — none while it isn't valid. */
  entitlement(): Handover | null {
    const { entitlement, account } = this.data
    return entitlement && account && this.claims?.active && this.claims.exp * 1000 > this.now() ? this.handover(entitlement, account) : null
  }

  /** What a follower gets: the token, the account — and the revoked key ids, so it stops trusting them too (it never asks the cloud). */
  private handover(token: string, account: CloudAccount): Handover {
    return { token, account, ...(this.revoked.size ? { revokedKids: [...this.revoked] } : {}) }
  }

  /** This install's id — a follower's is what its leases are bound to (`dev`). */
  installId(): string {
    return this.data.installId
  }

  /**
   * Desktop: a follower lease for the core with install id `installId`
   * (Remote-SSH, Dev Container) — signed by Mindeck Cloud for that core alone,
   * short, and asked for again once half of it has passed. Null while this
   * desktop holds no valid license, while the cloud issues no leases (404:
   * asked again after an hour) or can't be reached without a lease still in
   * hand: the desktop then hands over its own entitlement (the transition).
   */
  async followerLease(installId: string): Promise<Handover | null> {
    const own = this.entitlement()
    if (!own || this.opts.follower) return null
    const now = this.now()
    const kept = this.leases.get(installId)
    const held = kept && kept.claims.exp * 1000 > now ? this.handover(kept.token, own.account) : null
    if (held && now < ((kept!.claims.iat + kept!.claims.exp) / 2) * 1000) return held
    if (now < this.noLeasesUntil) return held
    try {
      const res = await this.call<FollowerLeaseResponse>('POST', '/v1/license/follower-lease', { installId, appVersion: this.opts.version })
      const token = res.entitlement?.token
      const claims = this.verify(token)
      if (!claims || claims.lease !== 'follower' || claims.dev !== installId || !claims.active || claims.exp * 1000 <= now) {
        console.warn('[cloud] ignoring a follower lease that is not valid for that core')
        return held
      }
      this.leases.set(installId, { token: token!, claims })
      return this.handover(token!, own.account)
    } catch (err) {
      if ((err as { status?: number }).status === 404) this.noLeasesUntil = now + LEASE_RETRY_MS
      return held
    }
  }

  /**
   * Follower: take an entitlement over from the desktop. It must verify with
   * Mindeck Cloud's key, be active and not run out (not an old one copied from
   * a cloud.json), and never be a lifetime license's offline certificate,
   * which is bound to the device it was issued to and would hold here for
   * good. A follower lease must be this core's (`dev` = its install id); the
   * desktop's own entitlement — while the cloud issues no leases — holds for
   * FOLLOWER_HANDOVER_MS after the desktop last handed it over, and not at all
   * once this core ran on a lease. The key ids the desktop knows to be
   * revoked are kept first: whatever they signed holds here no more.
   */
  async adopt(token: string, account: CloudAccount, revokedKids: readonly string[] = []): Promise<CloudStatus> {
    if (!this.opts.follower) throw coded('not-follower', 'This core signs in itself')
    if (!this.keys) await this.ensureMeta().catch(() => {})
    await this.revoke(revokedKids)
    const claims = this.verify(token)
    if (!claims) throw coded('bad-entitlement', 'This entitlement cannot be verified')
    if (claims.perpetual) throw coded('bad-entitlement', 'An offline certificate holds only on the device it was issued to')
    if (!claims.active || claims.exp * 1000 <= this.now()) throw coded('bad-entitlement', 'This entitlement is not valid (any more)')
    const lease = claims.lease === 'follower'
    if (lease && claims.dev !== this.data.installId) throw coded('bad-entitlement', 'This follower lease is for another core')
    if (!lease && this.data.leased) throw coded('lease-required', 'This core runs on follower leases from Mindeck Cloud only')
    this.data = { ...this.data, account, entitlement: token, license: null, ...(lease ? { leased: true } : { adoptedAt: this.now() }) }
    this.claims = this.followerClaims(claims)
    this.error = null
    await this.save()
    this.emit()
    return this.status()
  }

  /**
   * What an entitlement handed over is worth on this follower: a lease for
   * this core as signed; the desktop's own (no lease) until FOLLOWER_HANDOVER_MS
   * after it was handed over at most, and nothing once this core ran on a
   * lease. Null: it doesn't hold here.
   */
  private followerClaims(claims: EntitlementClaims | null): EntitlementClaims | null {
    if (!claims) return null
    if (claims.lease === 'follower') return claims.dev === this.data.installId ? claims : null
    if (this.data.leased) return null
    return { ...claims, exp: Math.min(claims.exp, Math.floor(((this.data.adoptedAt ?? 0) + FOLLOWER_HANDOVER_MS) / 1000)) }
  }

  /** Signed in to a Mindeck account (the session may still turn out expired). */
  isSignedIn(): boolean {
    return !!this.data.account
  }

  /** An authenticated request to Mindeck Cloud's API (Settings Sync …). */
  api<T = unknown>(method: 'GET' | 'PUT' | 'DELETE', path: string, body?: object): Promise<T> {
    return this.call<T>(method, path, body)
  }

  async checkout(): Promise<{ url: string }> {
    const res = await this.call<{ url: string }>('POST', '/v1/billing/checkout', {})
    return { url: res.url }
  }

  // ── heartbeat ──────────────────────────────────────────────────────────

  /** Runs every 10 s: renews the entitlement when it is due, else re-checks the state. */
  async tick(): Promise<void> {
    if (this.data.account && this.due()) await this.beat()
    else this.emit()
  }

  private due(): boolean {
    const now = this.now()
    const rested = now - this.lastAttempt >= RETRY_MS
    const c = this.claims
    if (!c || !c.active) return rested
    if (c.plan === 'lifetime') return rested && now - this.lastSuccess >= LIFETIME_REFRESH_MS
    // Trial: only while someone uses Mindeck — that is what the 7 hours count.
    return c.exp * 1000 - now <= RENEW_BEFORE_MS && this.inUse() && (this.online || rested)
  }

  private beat(): Promise<void> {
    this.beating ??= (async () => {
      this.lastAttempt = this.now()
      try {
        await this.ensureMeta()
        await this.checkRevocations()
        const res = await this.call<HeartbeatResponse>('POST', '/v1/license/heartbeat', {
          appVersion: this.opts.version
        })
        this.data.license = toLicense(res.license)
        if (res.entitlement) {
          const claims = this.verify(res.entitlement.token)
          if (!claims) throw coded('bad-entitlement', 'Mindeck Cloud sent an entitlement this core cannot verify')
          this.claims = claims
          this.data.entitlement = res.entitlement.token
          if (claims.dev) this.data.deviceId = claims.dev
          this.data.accountId ??= claims.sub
        }
        await this.keepOffline(res)
        await this.save()
        this.lastSuccess = this.now()
        this.error = null
      } catch (err) {
        this.note(err)
      } finally {
        this.beating = null
        this.emit()
      }
    })()
    return this.beating
  }

  // ── internals ──────────────────────────────────────────────────────────

  private client() {
    return {
      client: this.opts.client,
      device: {
        installId: this.data.installId,
        name: this.opts.deviceName,
        platform: this.opts.platform,
        appVersion: this.opts.version
      }
    }
  }

  private async signIn(path: string, req: object): Promise<CloudStatus> {
    let res: AuthResponse
    try {
      res = await this.call<AuthResponse>('POST', path, { ...req, ...this.client() }, false)
    } catch (err) {
      // Signed in on too many devices: one is removed on the website (its account page) — the UI links it once it knows where that is.
      if ((err as { code?: string }).code === 'device_limit') {
        await this.ensureMeta().catch(() => {})
        this.emit()
      }
      throw err
    }
    await this.signedIn(res)
    return this.status()
  }

  private async signedIn(res: AuthResponse): Promise<void> {
    await this.opts.secrets.set(SESSION_SECRET, res.session.token)
    await this.dropOffline() // another account, maybe: its own certificate comes with the first heartbeat
    this.data.accountId = res.user.id // an older cloud doesn't say: the first entitlement's `sub` then
    this.data.account = toAccount(res.user)
    this.data.license = toLicense(res.license)
    this.data.entitlement = null
    this.claims = null
    this.error = null
    await this.save()
    await this.beat()
  }

  /** Signed out (by choice, or the cloud no longer knows the session). */
  private async forget(error: string | null): Promise<void> {
    await this.opts.secrets.set(SESSION_SECRET, null)
    await this.dropOffline()
    this.data = { ...this.data, account: null, license: null, entitlement: null, accountId: undefined }
    this.claims = null
    this.error = error
    await this.save()
    this.emit()
  }

  /**
   * A lifetime license's offline certificate from a heartbeat: kept when it
   * verifies; dropped when the cloud says the license is no longer active
   * (a refund). A cloud that sends none (older versions) changes nothing.
   */
  private async keepOffline(res: HeartbeatResponse): Promise<void> {
    if (typeof res.offlineCertificate === 'string') {
      const cert = this.verifyOffline(res.offlineCertificate)
      if (cert) {
        this.keepCertificate(cert, res.offlineCertificate)
        await this.opts.secrets.set(OFFLINE_SECRET, res.offlineCertificate)
        return
      }
      console.warn('[cloud] ignoring an offline certificate this core cannot verify')
    }
    // A refund, a chargeback, an open dispute: the cloud's answer wins.
    const ended = (this.claims && !this.claims.active) || res.license.plan !== 'lifetime'
    if (ended && this.offline) await this.dropOffline()
  }

  private keepCertificate(cert: EntitlementClaims | null, token: string | undefined): void {
    this.offline = cert
    this.offlineToken = cert ? token! : null
  }

  private async dropOffline(): Promise<void> {
    this.keepCertificate(null, undefined)
    await this.opts.secrets.set(OFFLINE_SECRET, null)
  }

  /**
   * The certificate's claims if it is genuine, perpetual, lifetime, the
   * signed-in account's (`sub`) and this device's — else null. A certificate
   * names the device it was issued to (`dev`: the id Mindeck Cloud gave this
   * install, or its install id): one copied from another installation or
   * account doesn't hold here. One without `dev` holds on any device of the
   * account. One from before key ids (no `kid`) holds LEGACY_CERT_SECONDS
   * from its issue at most.
   */
  private verifyOffline(token: string): EntitlementClaims | null {
    const claims = this.verify(token)
    if (!claims) return null
    const cert = claims.kid ? claims : { ...claims, exp: Math.min(claims.exp, claims.iat + LEGACY_CERT_SECONDS) }
    if (!holdsOffline(cert, this.now()) || !cert.sub || cert.sub !== this.data.accountId) return null
    return !cert.dev || cert.dev === this.data.installId || cert.dev === this.data.deviceId ? cert : null
  }

  /** A token's claims if one of the trusted keys signed it (its `kid`'s) and that key is not revoked. */
  private verify(token: string | null | undefined): EntitlementClaims | null {
    return token && this.keys ? verifyEntitlement(token, this.keys, this.revoked) : null
  }

  /**
   * The cloud's signed revocation list, every REVOCATIONS_REFRESH_MS: only a
   * list signed by a key this core trusts counts (the unsigned copy next to
   * it does not). A cloud that answers without one (older versions: 404) is
   * asked again after an hour; one that can't be reached with the next heartbeat.
   */
  private async checkRevocations(): Promise<void> {
    const now = this.now()
    if (now < this.revocationsDue || !this.keys) return
    const res = await this.call<RevocationsResponse>('GET', '/v1/license/revocations', undefined, false).catch((err: { status?: number }) => {
      if (err.status !== undefined) this.revocationsDue = now + LEASE_RETRY_MS
      return null
    })
    if (!res) return
    const kids = typeof res.revocations === 'string' ? verifyRevocations(res.revocations, this.keys, this.revoked, Math.floor(now / 1000)) : null
    if (!kids) {
      console.warn('[cloud] ignoring a revocation list this core cannot verify')
      this.revocationsDue = now + LEASE_RETRY_MS
      return
    }
    this.revocationsDue = now + REVOCATIONS_REFRESH_MS
    await this.revoke(kids)
  }

  /**
   * Revoked signing keys: remembered for good (never removed), and whatever
   * they signed is dropped — the entitlement, the offline certificate, the
   * follower leases. The cloud signs anew with a key still trusted.
   */
  private async revoke(kids: readonly string[]): Promise<void> {
    const fresh = kids.filter((kid) => !this.revoked.has(kid))
    if (!fresh.length) return
    for (const kid of fresh) this.revoked.add(kid)
    this.data.revokedKids = [...this.revoked]
    console.warn(`[cloud] signing key(s) revoked by Mindeck Cloud: ${fresh.join(', ')}`)
    if (this.claims && !this.verify(this.data.entitlement)) {
      this.claims = null
      this.data.entitlement = null
    }
    if (this.offlineToken && !this.verifyOffline(this.offlineToken)) await this.dropOffline()
    for (const [installId, lease] of this.leases) if (!this.verify(lease.token)) this.leases.delete(installId)
    await this.save()
  }

  private note(err: unknown): void {
    this.error = (err as { code?: string }).code ?? 'error'
  }

  /** The keys built in — else those the cloud named on first use. Null when there are none or one can't be read. */
  private trustedKeys(): TrustedKeys | null {
    const list = this.opts.publicKey ?? [this.data.publicKey, ...(this.data.publicKeys ?? [])].filter(Boolean).join(',')
    try {
      return trustedKeys(parsePublicKeys(list))
    } catch {
      return null
    }
  }

  /** The website URL and (unless built in) the entitlement keys and revoked key ids, until the core knows them. */
  private async ensureMeta(): Promise<void> {
    if (this.keys && this.data.webUrl) return
    const meta = await this.call<Meta>('GET', '/v1/meta', undefined, false)
    this.data.webUrl = meta.webUrl
    const tofu = !this.opts.publicKey
    if (tofu) {
      this.data.publicKey = meta.entitlementPublicKey
      this.data.publicKeys = (meta.entitlementKeys ?? []).map((k) => k.publicKey)
    }
    this.keys = this.trustedKeys()
    if (tofu) await this.revoke(meta.revokedKeyIds ?? [])
    await this.save()
  }

  private async call<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: object, auth = true): Promise<T> {
    const headers: Record<string, string> = {}
    if (body) headers['content-type'] = 'application/json'
    if (auth) {
      const token = await this.opts.secrets.get(SESSION_SECRET)
      if (!token) {
        await this.forget('session_expired')
        throw coded('session_expired', 'Please sign in again')
      }
      headers.authorization = `Bearer ${token}`
    }
    // License calls name the keys this core trusts, so the cloud signs with one of them (after a rotation: the new key).
    const kids = path.startsWith('/v1/license') && this.keys ? announcedKids(this.keys, this.revoked) : []
    if (kids.length) headers[KEYS_HEADER] = kids.join(',')
    let res: Response
    try {
      res = await this.fetch(`${this.opts.baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000)
      })
    } catch {
      this.online = false
      throw coded('cloud-unreachable', 'Mindeck Cloud is not reachable')
    }
    this.online = true
    const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
    if (res.ok) return data as T
    let code = data.error?.code ?? `http-${res.status}`
    if (auth && (res.status === 401 || code === 'account_disabled')) {
      // The cloud no longer accepts this session: sign out, and say why.
      code = res.status === 401 ? 'session_expired' : code
      await this.forget(code)
    }
    throw coded(code, data.error?.message ?? res.statusText, res.status)
  }

  private emit(): void {
    const status = this.status()
    const key = JSON.stringify(status)
    if (key === this.lastEmitted) return
    this.lastEmitted = key
    this.opts.onStatus(status)
  }

  private async load(): Promise<Partial<Persisted>> {
    const parsed = await readJson<Partial<Persisted>>(this.opts.file)
    return parsed && typeof parsed === 'object' ? parsed : {}
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.opts.file), { recursive: true })
    const tmp = `${this.opts.file}.tmp`
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, this.opts.file)
  }
}
