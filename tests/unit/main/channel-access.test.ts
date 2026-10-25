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
})
