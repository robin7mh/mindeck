import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { localSite } from './helpers'

/** Drags the column divider between two points, back and forth. */
async function shake(page: Page, times: number, steps: number) {
  const divider = page.getByRole('separator', { name: 'Resize the columns' })
  const stage = (await page.getByTestId('workspace').boundingBox())!
  for (let i = 0; i < times; i += 1) {
    const box = (await divider.boundingBox())!
    const y = box.y + box.height / 2
    await page.mouse.move(box.x + box.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(stage.x + stage.width * (i % 2 ? 0.25 : 0.75), y, { steps })
    await page.mouse.move(stage.x + stage.width * (i % 2 ? 0.7 : 0.3), y, { steps })
    await page.mouse.up()
  }
}

test('dragging dividers and modules back and forth — in zen mode too — keeps the app and its modules alive', async ({ app, page, mainLog }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? ''}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
  let exited: number | null = null
  app.process().on('exit', (code) => (exited = code ?? -1))
  const site = await localSite()
  try {
    // A terminal first (kept mounted from then on), then agents | browser side by side.
    await page.getByTitle('Terminal', { exact: true }).click()
    await expect(page.locator('.xterm').first()).toBeVisible()
    await page.getByRole('button', { name: 'Layout and workspaces' }).click()
    await page.getByRole('button', { name: 'Side by side', exact: true }).click()
    await page.keyboard.press('Escape')
    const left = page.locator('[data-testid^="pane-head-"]').first()
    await left.getByRole('button', { name: /show another module here/ }).click()
    await page.getByRole('menuitemradio', { name: 'Agents' }).click()
    const right = page.locator('[data-testid^="pane-head-"]').nth(1)
    await right.getByRole('button', { name: /show another module here/ }).click()
    await page.getByRole('menuitemradio', { name: 'Browser' }).click()
    const address = page.getByRole('textbox', { name: 'Address or search' })
    await address.fill(`localhost:${site.port}`)
    await address.press('Enter')
    await expect(page.getByRole('tab', { name: /Mindeck E2E/ })).toBeVisible()

    // Fast and slow drags, in the normal layout and in zen mode.
    await shake(page, 25, 2)
    await shake(page, 10, 12)
    await page.keyboard.press('ControlOrMeta+Alt+z')
    await expect(page.getByText('Mindeck · Zen mode')).toBeVisible()
    await shake(page, 25, 2)
    await page.getByRole('button', { name: 'Leave zen mode' }).first().click()

    // Modules switched back and forth between the panes (terminal ↔ browser, agents ↔ editor).
    for (let i = 0; i < 8; i += 1) {
      await right.getByRole('button', { name: /show another module here/ }).click()
      await page.getByRole('menuitemradio', { name: i % 2 ? 'Browser' : 'Terminal' }).click()
      await left.getByRole('button', { name: /show another module here/ }).click()
      await page.getByRole('menuitemradio', { name: i % 2 ? 'Agents' : 'Editor' }).click()
      await shake(page, 2, 3)
    }
    // Modules dragged from the side navigation onto the panes.
    for (let i = 0; i < 6; i += 1) {
      const module = ['Terminal', 'Browser', 'Agents'][i % 3]
      const target = page.locator('[data-pane-id]').nth(i % 2)
      await page.getByTitle(module, { exact: true }).dragTo(target)
    }

    await page.waitForTimeout(1500)
    expect(exited, 'the app ended').toBeNull()
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    await expect(page.getByRole('alert').filter({ hasText: /crash|stopped working|went wrong/i })).toHaveCount(0)
    expect(errors.filter((e) => !e.includes('Failed to load resource'))).toEqual([])
    expect(mainLog()).not.toMatch(/Uncaught|renderer is gone|not responding|process gone: crashed/)
  } finally {
    await site.close()
  }
})
