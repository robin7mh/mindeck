import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { IpcResult } from '@shared/ipc/contract'
import type { FinderChunk, FinderListing } from '@shared/types/finder'
import type { PairingCode, PairResult } from '@shared/types/server'
import { expect, test } from './fixtures'

const PORT = 7497

/** A paired phone (an admin device): its own token, calling the API like the mobile app does. */
async function phone(page: Page) {
  const code = (await page.evaluate(() => window.mindeck!.invoke('server:createPairingCode', { role: 'admin' }))) as IpcResult<PairingCode>
  if (!code.ok) throw new Error(code.error.message)
  const paired = (await (await fetch(`http://127.0.0.1:${PORT}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.data.code, name: 'E2E phone' }) })).json()) as IpcResult<PairResult>
  if (!paired.ok) throw new Error(paired.error.message)
  return async <T>(channel: string, payload?: unknown): Promise<IpcResult<T>> =>
    (await (await fetch(`http://127.0.0.1:${PORT}/api/rpc/${channel}`, { method: 'POST', headers: { authorization: `Bearer ${paired.data.token}` }, body: JSON.stringify(payload ?? null) })).json()) as IpcResult<T>
}

test('a paired admin phone: the files with remote shells only, never the desktop\'s browser', async ({ page, home }) => {
  // The desktop runs the API; the phone is paired as an admin.
  await page.getByTitle('Settings', { exact: true }).click()
  await page.getByLabel('Port').fill(String(PORT))
  await page.getByLabel('Port').blur()
  await page.getByLabel('Run the API server').check()
  await expect(page.getByText('API server running')).toBeVisible()
  const call = await phone(page)
  expect(await call('finder:list')).toMatchObject({ ok: false, error: { code: 'remote-terminal-disabled' } })
  await page.getByLabel('Allow remote shells').check()

  // The browser and its tabs stay the desktop's — admins too.
  expect(await call('browser:state')).toMatchObject({ ok: false, error: { code: 'desktop-only' } })
  expect(await call('browser:open', { url: 'https://example.com/' })).toMatchObject({ ok: false, error: { code: 'desktop-only' } })

  // Files: the home folder (read only here — this is the real one), never hidden entries; nothing outside it.
  const listing = await call<FinderListing>('finder:list')
  expect(listing.ok).toBe(true)
  expect(listing.ok && listing.data.entries.some((e) => e.hidden)).toBe(false)
  writeFileSync(join(home, 'phone-note.txt'), 'outside the home folder')
  expect(await call<FinderChunk>('finder:read', { path: join(home, 'phone-note.txt') })).toMatchObject({ ok: false, error: { code: 'remote-forbidden' } })
})
