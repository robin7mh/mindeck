import { session, type Session } from 'electron'
import type { BrowserProfile } from '@shared/types/browser'
import { BROWSER_PARTITION, configureBrowserSession, type SessionTarget } from './session'

/** Private tabs: in memory only (no `persist:`), emptied when the last one closes. */
export const PRIVATE_PARTITION = 'mindeck-private'
/** Tabs agents open: their own cookies and logins, never the user's. */
export const AGENTS_PARTITION = 'persist:mindeck-agents'

/** The Chromium partition of a profile (none: the user's own). */
export function partitionOf(profile?: BrowserProfile): string {
  return profile === 'private' ? PRIVATE_PARTITION : profile === 'agents' ? AGENTS_PARTITION : BROWSER_PARTITION
}

/**
 * The profile's session, set up like every other (user agent, permission
 * questions, downloads, blocking) — one factory, so no partition misses a rule.
 */
export function profileSession(profile: BrowserProfile | undefined, current: () => SessionTarget | null): Session {
  const ses = session.fromPartition(partitionOf(profile))
  configureBrowserSession(ses, current)
  return ses
}

/** Forgets everything private tabs left: cookies, storage, cache, logins typed into HTTP auth. */
export async function clearPrivate(): Promise<void> {
  const ses = session.fromPartition(PRIVATE_PARTITION)
  await Promise.all([ses.clearStorageData(), ses.clearCache(), ses.clearAuthCache()])
}
