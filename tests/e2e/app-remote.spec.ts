import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { IpcResult } from '@shared/ipc/contract'
import type { BrowserCapture, BrowserState } from '@shared/types/browser'
import type { FinderChunk, FinderListing } from '@shared/types/finder'
import type { PairingCode, PairResult } from '@shared/types/server'
import { expect, test } from './fixtures'
import { localSite } from './helpers'

const PORT = 7497

/** A paired phone: its own token, calling the API like the mobile app does. */
async function phone(page: Page) {
  const code = (await page.evaluate(() => window.mindeck!.invoke('server:createPairingCode', {}))) as IpcResult<PairingCode>
  if (!code.ok) throw new Error(code.error.message)
  const paired = (await (await fetch(`http://127.0.0.1:${PORT}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.data.code, name: 'E2E phone' }) })).json()) as IpcResult<PairResult>
  if (!paired.ok) throw new Error(paired.error.message)
  return async <T>(channel: string, payload?: unknown): Promise<IpcResult<T>> =>
    (await (await fetch(`http://127.0.0.1:${PORT}/api/rpc/${channel}`, { method: 'POST', headers: { authorization: `Bearer ${paired.data.token}` }, body: JSON.stringify(payload ?? null) })).json()) as IpcResult<T>
}

test('a paired phone uses the shared browser — live picture, taps and text; private tabs never — and the files with remote shells', async ({ page, home }) => {
  const site = await localSite({
    '/form': (_req, res) =>
      res.end(`<!doctype html><title>Form</title><style>body{margin:0}input{position:absolute;left:0;top:0;width:400px;height:60px;font-size:24px}</style>
        <input id="q" oninput="document.title = 'typed:' + this.value">`)
  })
  try {
    // The desktop runs the API, allows remote shells and shares its browser.
    await page.getByTitle('Settings', { exact: true }).click()
    await page.getByLabel('Port').fill(String(PORT))
    await page.getByLabel('Port').blur()
    await page.getByLabel('Run the API server').check()
    await expect(page.getByText('API server running')).toBeVisible()
    const call = await phone(page)
    expect(await call('browser:state')).toMatchObject({ ok: false, error: { code: 'remote-browser-disabled' } })
    expect(await call('finder:list')).toMatchObject({ ok: false, error: { code: 'remote-terminal-disabled' } })
    await page.getByLabel('Allow remote shells').check()
    await page.getByLabel('Share the browser with paired devices').check()

    // A page in the desktop's browser…
    await page.getByTitle('Browser', { exact: true }).click()
    const bar = page.getByRole('textbox', { name: 'Address or search' })
    await bar.fill(`localhost:${site.port}/form`)
    await bar.press('Enter')
    await expect(page.getByRole('tab', { name: /Form/ })).toBeVisible()

    // …the phone sees it as a picture with the page's size…
    const state = await call<BrowserState>('browser:state')
    const tab = state.ok ? state.data.tabs.find((t) => t.url.endsWith('/form')) : undefined
    expect(tab).toBeDefined()
    const shot = await call<BrowserCapture>('browser:capture', { id: tab!.id, width: 600 })
    expect(shot).toMatchObject({ ok: true, data: { image: expect.stringMatching(/^data:image\/jpeg;base64,/), viewport: { width: expect.any(Number) } } })
    expect(shot.ok && shot.data.width).toBeLessThanOrEqual(600)

    // …taps into the field and types: the page reacts.
    expect(await call('browser:input', { id: tab!.id, action: 'click', x: 100, y: 30 })).toEqual({ ok: true })
    expect(await call('browser:input', { id: tab!.id, action: 'type', text: 'hallo' })).toEqual({ ok: true })
    await expect(page.getByRole('tab', { name: /typed:hallo/ })).toBeVisible()

    // A private tab never reaches the phone.
    const priv = (await page.evaluate((url) => window.mindeck!.invoke('browser:open', { url, private: true, background: true }), `http://localhost:${site.port}/second`)) as IpcResult<{ id: string }>
    expect(priv.ok).toBe(true)
    const after = await call<BrowserState>('browser:state')
    expect(after.ok && after.data.tabs.some((t) => t.profile === 'private')).toBe(false)
    expect(await call('browser:capture', { id: priv.ok ? priv.data.id : '' })).toMatchObject({ ok: false, error: { code: 'remote-forbidden' } })

    // Files: the home folder (read only here — this is the real one), never hidden entries; nothing outside it.
    const listing = await call<FinderListing>('finder:list')
    expect(listing.ok).toBe(true)
    expect(listing.ok && listing.data.entries.some((e) => e.hidden)).toBe(false)
    writeFileSync(join(home, 'phone-note.txt'), 'outside the home folder')
    expect(await call<FinderChunk>('finder:read', { path: join(home, 'phone-note.txt') })).toMatchObject({ ok: false, error: { code: 'remote-forbidden' } })
  } finally {
    await site.close()
  }
})
