import { createPublicKey, verify, type KeyObject } from 'node:crypto'
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
  reason: 'ok' | 'trial_expired' | 'email_unverified'
  /** Trial seconds left (0 for lifetime). */
  rem: number
  /** The device it was issued to: Mindeck Cloud's id for the install (or its install id). */
  dev?: string
  /** A lifetime license's offline certificate: valid without the cloud for good (until refunded). */
  perpetual?: boolean
  /**
   * A follower lease (`POST /v1/license/follower-lease`): issued to a desktop
   * for one core it runs elsewhere (Remote-SSH, Dev Container) — `dev` is
   * that core's install id, `exp` short. It holds on that core only.
   */
  lease?: 'follower'
  iat: number
  exp: number
}

/** The cloud's public key as PEM, or as base64 SPKI DER (handier in build variables). */
export function parsePublicKey(key: string): KeyObject {
  const text = key.replace(/\\n/g, '\n').trim()
  return text.startsWith('-----BEGIN')
    ? createPublicKey(text)
    : createPublicKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' })
}

/**
 * The claims if the signature is genuine — expired or not (the caller decides
 * what an expired lease means). Null for anything forged or malformed.
 */
export function verifyEntitlement(token: string, publicKey: KeyObject): EntitlementClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'mindeck1') return null
  try {
    const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'))
    return ok ? (JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as EntitlementClaims) : null
  } catch {
    return null
  }
}
