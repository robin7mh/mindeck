import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import type { LicensePlan } from '@shared/types/cloud'

/**
 * A signed statement from Mindeck Cloud: "this account may use Mindeck until
 * `exp`". Format `mindeck1.<base64url JSON>.<base64url Ed25519 signature>` —
 * the same as the cloud's `src/lib/entitlement.ts`.
 */
export interface EntitlementClaims {
  sub: string
  email: string
  plan: LicensePlan
  active: boolean
  /** `license_suspended`: a lifetime license whose payment is disputed (chargeback) — inactive until the dispute is closed. */
  reason: 'ok' | 'trial_expired' | 'email_unverified' | 'license_suspended'
  /** Trial seconds left (0 for lifetime). */
  rem: number
  /** The device it was issued to: Mindeck Cloud's id for the install (or its install id). */
  dev?: string
  /** A lifetime license's offline certificate: valid without the cloud until `exp` (renewed with every heartbeat). */
  perpetual?: boolean
  /**
   * A follower lease (`POST /v1/license/follower-lease`): issued to a desktop
   * for one core it runs elsewhere (Remote-SSH, Dev Container) — `dev` is
   * that core's install id, `exp` short. It holds on that core only.
   */
  lease?: 'follower'
  /** Id of the key that signed it (keyId()). Absent on tokens from before key ids: those verify with the legacy key only. */
  kid?: string
  iat: number
  exp: number
}

/**
 * The keys this core trusts, by id — the token's `kid` picks one, never "try
 * them all". `legacy` is the first key built in (the one cores pinned before
 * key ids): the only key for a token without a `kid`.
 */
export interface TrustedKeys {
  byKid: ReadonlyMap<string, KeyObject>
  legacy: KeyObject
  legacyKid: string
}

/** Prefix of the cloud's signed revocation list (`GET /v1/license/revocations`) — not `mindeck1`, so it is never taken for an entitlement. */
export const REVOCATIONS_PREFIX = 'mindeck-rl1'

/** The cloud's public key as PEM, or as base64 SPKI DER (handier in build variables). */
export function parsePublicKey(key: string): KeyObject {
  const text = key.replace(/\\n/g, '\n').trim()
  return text.startsWith('-----BEGIN')
    ? createPublicKey(text)
    : createPublicKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' })
}

/**
 * `MINDECK_CLOUD_KEY` as a list (after a key rotation the next key is built in
 * next to the current one): PEM blocks and/or base64 SPKI DER, separated by
 * commas or line breaks — the original (legacy) key first. Throws on any key
 * it can't read: a release must not quietly trust fewer keys than it was built with.
 */
export function parsePublicKeys(raw: string): KeyObject[] {
  // In the order written: the first key is the legacy key.
  const entries = raw.replace(/\\n/g, '\n').match(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----|[^\s,]+/g) ?? []
  return entries.map((entry) => {
    const key = parsePublicKey(entry)
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Mindeck Cloud keys are Ed25519 keys')
    return key
  })
}

/**
 * A key's id, as Mindeck Cloud computes it (`keyId()` in its
 * `src/lib/entitlement.ts`): the first 16 characters of
 * base64url(SHA-256(SPKI DER of the public key)).
 */
export function keyId(key: KeyObject): string {
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('base64url').slice(0, 16)
}

/** The keys by id, the first one the legacy key; null without any. */
export function trustedKeys(keys: readonly KeyObject[]): TrustedKeys | null {
  if (!keys.length) return null
  const byKid = new Map<string, KeyObject>()
  for (const key of keys) byKid.set(keyId(key), key)
  return { byKid, legacy: keys[0], legacyKid: keyId(keys[0]) }
}

/** The ids a core announces in `Mindeck-Keys` (the cloud then signs with one of them): every trusted key that is not revoked. */
export function announcedKids(keys: TrustedKeys, revoked: ReadonlySet<string>): string[] {
  return [...keys.byKid.keys()].filter((kid) => !revoked.has(kid))
}

/**
 * `<prefix>.<payload>.<signature>` → the payload if the signature verifies
 * with the key its `kid` names (none: the legacy key, if `legacy` allows it).
 * The payload is read unverified only to pick the key; an unknown or revoked
 * kid is rejected without trying any other key.
 */
function verifySigned<T extends { kid?: unknown }>(token: string, prefix: string, keys: TrustedKeys, revoked: ReadonlySet<string>, legacy: boolean): T | null {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== prefix) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as T
    if (!payload || typeof payload !== 'object') return null
    const kid = payload.kid === undefined && legacy ? keys.legacyKid : payload.kid
    if (typeof kid !== 'string' || revoked.has(kid)) return null
    const key = keys.byKid.get(kid)
    if (!key) return null
    return verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url')) ? payload : null
  } catch {
    return null
  }
}

/**
 * The claims if the signature is genuine — expired or not (the caller decides
 * what an expired lease means). Null for anything forged or malformed, and for
 * a token whose key this core doesn't know or knows to be revoked.
 */
export function verifyEntitlement(token: string, keys: TrustedKeys, revoked: ReadonlySet<string> = new Set()): EntitlementClaims | null {
  return verifySigned<EntitlementClaims>(token, 'mindeck1', keys, revoked, true)
}

/**
 * The key ids the cloud's signed revocation list names
 * (`mindeck-rl1.<base64url { kid, iat, exp, revokedKids }>.<Ed25519 over mindeck-rl1.<payload>>`)
 * — null unless it is signed by a trusted, not revoked key (it always names
 * one), has not run out and lists strings.
 */
export function verifyRevocations(doc: string, keys: TrustedKeys, revoked: ReadonlySet<string>, nowSeconds: number): string[] | null {
  const list = verifySigned<{ kid?: unknown; exp?: unknown; revokedKids?: unknown }>(doc, REVOCATIONS_PREFIX, keys, revoked, false)
  if (!list || typeof list.exp !== 'number' || list.exp <= nowSeconds || !Array.isArray(list.revokedKids)) return null
  return list.revokedKids.every((k) => typeof k === 'string') ? (list.revokedKids as string[]) : null
}
