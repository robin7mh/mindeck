import { describe, expect, it } from 'vitest'
import { CHANNEL_ACCESS, type ChannelAccess } from '@shared/ipc/contract'

/** Every channel a paired device can reach, by access level (`desktop`: none of them, so not listed). */
function remoteSurface(): Partial<Record<ChannelAccess, string[]>> {
  const levels: Partial<Record<ChannelAccess, string[]>> = {}
  for (const [channel, access] of Object.entries(CHANNEL_ACCESS) as [string, ChannelAccess][]) {
    if (access !== 'desktop') (levels[access] ??= []).push(channel)
  }
  for (const list of Object.values(levels)) list.sort()
  return levels
}

describe('what paired devices reach', () => {
  // A change here widens or narrows the API surface of a phone or a browser tab: the snapshot's diff is the review.
  it('matches the reviewed surface', () => {
    expect(remoteSurface()).toMatchSnapshot()
  })

  it('keeps the browser to its own channels, and its sharing, logins and the desktop’s screen at the desktop', () => {
    expect(remoteSurface().browser!.every((c) => c.startsWith('browser:'))).toBe(true)
    for (const channel of ['server:setDeviceBrowser', 'server:configure', 'browser:activate', 'browser:extensions', 'browser:import', 'browser:historyDelete', 'finder:open', 'finder:reveal', 'finder:clipboardRead', 'finder:clipboardWrite', 'finder:privacySettings']) {
      if (channel in CHANNEL_ACCESS) expect(CHANNEL_ACCESS[channel as keyof typeof CHANNEL_ACCESS], channel).toBe('desktop')
    }
  })
})
