import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { IpcResult } from '@shared/ipc/contract'
import type { BrowserState, HistoryEntry } from '@shared/types/browser'
import { expect, test } from './fixtures'
import { localSite, pressInMain } from './helpers'

/** Type an address into the bar of the tab on screen. */
async function go(page: Page, address: string) {
  const bar = page.getByRole('textbox', { name: 'Address or search' })
  await bar.fill(address)
  await bar.press('Enter')
}

/** A new tab, ready to type an address into. */
async function newTab(page: Page) {
  const count = await page.getByRole('tab').count()
  await page.getByRole('button', { name: 'New tab', exact: true }).click()
  await expect(page.getByRole('tab')).toHaveCount(count + 1)
  await expect(page.getByRole('textbox', { name: 'Address or search' })).toBeFocused()
}

/** What the history knows that matches `query`. */
async function history(page: Page, query: string) {
  const res = (await page.evaluate((q) => window.mindeck!.invoke('browser:history', { query: q, limit: 20 }), query)) as IpcResult<HistoryEntry[]>
  return res.ok ? res.data.map((e) => e.url) : []
}

/** The open tabs, as the core has them. */
async function tabs(page: Page) {
  const res = (await page.evaluate(() => window.mindeck!.invoke('browser:state'))) as IpcResult<BrowserState>
  return res.ok ? res.data.tabs.map((t) => ({ title: t.title, url: t.url, profile: t.profile, canGoBack: t.canGoBack })) : []
}

// qa.example: a site that is not this computer (the ad blocker leaves local pages alone) — served locally.
test.use({ args: ['--host-resolver-rules=MAP qa.example 127.0.0.1', '--no-proxy-server'] })

test('browser: bookmark (⌘D), history page, tab search, private tab, shield, sign-in, download — the session after a restart', async ({ app, page, home, restart }) => {
  const site = await localSite()
  const local = `http://localhost:${site.port}`
  const downloads = join(home, 'QA downloads')
  mkdirSync(downloads)
  try {
    // downloads go to a folder of the test's (Settings → Browser, through the stubbed folder picker)
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
    }, downloads)
    await page.getByTitle('Settings', { exact: true }).click()
    await page.getByRole('button', { name: 'Choose…' }).click()
    await expect(page.getByText(downloads, { exact: true })).toBeVisible()

    await page.getByTitle('Browser', { exact: true }).click()
    await go(page, `localhost:${site.port}`)
    await expect(page.getByRole('tab', { name: /Mindeck E2E/ })).toBeVisible()
    // local pages are never filtered — the shield says so
    await expect(page.getByRole('button', { name: 'Ad blocking is off on this site' })).toBeVisible()

    // ⌘D: bookmarked, named in the dialog, on the bar
    await pressInMain(app, 'D', ['mod'])
    const added = page.getByRole('dialog', { name: 'Bookmark added' })
    await expect(added).toBeVisible()
    await added.getByRole('textbox', { name: 'Name' }).fill('QA home')
    await added.getByRole('button', { name: 'Done' }).click()
    await expect(added).toBeHidden()
    const bar = page.getByRole('toolbar', { name: 'Bookmarks bar' })
    await expect(bar.getByRole('button', { name: 'QA home' })).toBeVisible()

    await go(page, `localhost:${site.port}/second`)
    await expect(page.getByRole('tab', { name: /Second page/ })).toBeVisible()

    // any other site: the ad blocker is on — even without its filter lists (no network here), the page loads
    await newTab(page)
    await go(page, `http://qa.example:${site.port}/`)
    await expect(page.getByRole('tab', { name: /Mindeck E2E/ })).toBeVisible()
    await expect(page.getByRole('button', { name: '0 ads and trackers blocked' })).toBeVisible()
    await page.getByRole('button', { name: 'Close Mindeck E2E' }).click()
    await expect(page.getByRole('tab')).toHaveCount(1)

    // mindeck://history: Mindeck's own page, the visits by day
    await newTab(page)
    await go(page, 'mindeck://history')
    await expect(page.getByRole('tab', { name: /History/ })).toBeVisible()
    const viewport = page.getByTestId('browser-viewport')
    await expect(viewport.getByTitle(`${local}/second`, { exact: true })).toContainText('Second page')
    await expect(viewport.getByTitle(`${local}/`, { exact: true })).toContainText('Mindeck E2E')
    await expect(viewport.getByTitle(`http://qa.example:${site.port}/`, { exact: true })).toContainText('Mindeck E2E')

    // a private tab (⌘⇧N): its visits never reach the history
    await pressInMain(app, 'N', ['mod', 'shift'])
    await expect(page.getByText('You are browsing privately')).toBeVisible()
    await go(page, `localhost:${site.port}/third`)
    await expect(page.getByRole('tab', { name: /Third page/ })).toBeVisible()
    await expect.poll(() => tabs(page)).toContainEqual(expect.objectContaining({ title: 'Third page', profile: 'private' }))
    await page.getByRole('button', { name: 'Close Third page' }).click()
    await expect(page.getByRole('tab', { name: /Third page/ })).toHaveCount(0)
    expect(await history(page, 'third')).toEqual([])
    expect(await history(page, 'second')).toEqual([`${local}/second`])

    // ⌘⇧A: one search over tabs, bookmarks and history
    await pressInMain(app, 'A', ['mod', 'shift'])
    const search = page.getByRole('dialog', { name: 'Search tabs, history and bookmarks' })
    await search.getByRole('textbox').fill('QA home')
    await expect(search.getByRole('option', { name: /QA home/ })).toBeVisible()
    await search.getByRole('textbox').fill('third')
    await expect(search.getByText('Nothing found')).toBeVisible() // the private visit left no trace
    await search.getByRole('textbox').press('Escape')
    await expect(search).toBeHidden()

    // HTTP Basic auth: Mindeck asks, the page opens
    await go(page, `localhost:${site.port}/private`)
    const signIn = page.getByRole('dialog', { name: 'Sign in' })
    await expect(signIn).toBeVisible()
    await expect(signIn).toContainText(`localhost:${site.port} asks for a user name and password`)
    await signIn.getByLabel('User name').fill('e2e')
    await signIn.getByLabel('Password').fill('secret')
    await signIn.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('tab', { name: /Members only/ })).toBeVisible()

    // a download lands in the chosen folder and in the downloads panel
    await go(page, `localhost:${site.port}/report.txt`)
    await expect.poll(() => existsSync(join(downloads, 'report.txt')) && readFileSync(join(downloads, 'report.txt'), 'utf8')).toBe('quarterly numbers\n')
    await page.getByRole('button', { name: 'Downloads', exact: true }).click()
    await expect(page.getByText('report.txt')).toBeVisible()
    await page.getByRole('button', { name: 'Downloads', exact: true }).click()

    // back on the first tab: one step back in its own history
    await page.getByRole('tab', { name: /Second page/ }).click()
    await expect.poll(async () => (await tabs(page)).map((t) => [t.title, t.canGoBack])).toEqual([
      ['Second page', true],
      ['Members only', false]
    ])

    // a restart starts with a new tab; ⌘⇧T brings the pages back — each with its back/forward list
    const again = (await restart()).page
    await again.getByTitle('Browser', { exact: true }).click()
    await expect(again.getByRole('tab')).toHaveCount(1)
    await expect(again.getByRole('tab', { name: /Second page|Members only/ })).toHaveCount(0)
    await expect(again.getByRole('alert').filter({ hasText: 'quit unexpectedly' })).toHaveCount(0) // a clean quit
    for (let i = 0; i < 2; i++) await again.evaluate(() => window.mindeck!.invoke('browser:reopen'))
    await expect(again.getByRole('tab', { name: /Members only/ })).toBeVisible()
    await again.getByRole('tab', { name: /Second page/ }).click()
    const back = again.getByRole('button', { name: 'Back', exact: true })
    await expect(back).toBeEnabled()
    await back.click()
    await expect(again.getByRole('tab', { name: /Mindeck E2E/ })).toBeVisible()
    await expect(again.getByRole('toolbar', { name: 'Bookmarks bar' }).getByRole('button', { name: 'QA home' })).toBeVisible()
  } finally {
    await site.close()
  }
})
