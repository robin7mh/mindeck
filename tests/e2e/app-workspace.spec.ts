import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { localSite } from './helpers'

/** Where the browser's page sits in the window (its native view), if one is on screen. */
function pageView(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => {
    const views = BrowserWindow.getAllWindows()[0].contentView.children.filter((v) => v.getVisible())
    return views.map((v) => v.getBounds())[0] ?? null
  })
}

/** A pane's place on screen, by the module in it. */
async function paneBox(page: Page, module: string) {
  const id = await page.getByTestId(`pane-head-${module}`).evaluate((head) => {
    const left = head.getBoundingClientRect().left
    return [...document.querySelectorAll<HTMLElement>('[data-pane-id]')].find((p) => Math.abs(p.getBoundingClientRect().left - left) < 1)!.dataset.paneId!
  })
  return (await page.locator(`[data-pane-id="${id}"]`).boundingBox())!
}

test('workspace: two panes side by side with agents, terminal and browser — divider, zen mode, saved workspaces, restored after a restart', async ({ app, page, restart }) => {
  const site = await localSite()
  try {
    const menu = page.getByRole('button', { name: 'Layout and workspaces' })
    await menu.click()
    await page.getByRole('button', { name: 'Side by side' }).click()
    await page.keyboard.press('Escape')
    // the new pane gets the first module not on screen yet: the terminal
    await expect(page.getByTestId('pane-head-core')).toBeVisible()
    await expect(page.getByTestId('pane-head-terminal')).toBeVisible()
    await expect(page.locator('.xterm-rows')).toBeVisible()

    // the left pane shows the agents instead
    await page.getByRole('button', { name: 'Core – show another module here' }).click()
    await page.getByRole('menuitemradio', { name: 'Agents' }).click()
    await expect(page.getByTestId('pane-head-agents')).toBeVisible()
    await expect(page.getByText('Your agents, in one place')).toBeVisible()

    // the right one the browser, its page exactly in the pane
    await page.getByRole('button', { name: 'Terminal – show another module here' }).click()
    await page.getByRole('menuitemradio', { name: 'Browser' }).click()
    const address = page.getByRole('textbox', { name: 'Address or search' })
    await address.fill(`localhost:${site.port}`)
    await address.press('Enter')
    await expect(page.getByRole('tab', { name: /Mindeck E2E/ })).toBeVisible()
    const fits = async () => {
      const view = await pageView(app)
      const pane = await paneBox(page, 'browser')
      return !!view && view.x >= pane.x - 1 && view.x + view.width <= pane.x + pane.width + 1 && view.width > 200
    }
    await expect.poll(fits).toBe(true)

    // drag the divider to a third: the panes and the page follow
    const divider = page.getByRole('separator', { name: 'Resize the columns' })
    const box = (await divider.boundingBox())!
    const stage = (await page.getByTestId('workspace').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(stage.x + stage.width * 0.35, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect(divider).toHaveAttribute('aria-valuenow', '35')
    await expect.poll(async () => Math.round(((await paneBox(page, 'agents')).width / stage.width) * 100)).toBeLessThanOrEqual(35)
    await expect.poll(fits).toBe(true)

    // zen mode: only the panes (and the way out)
    await page.keyboard.press('ControlOrMeta+Alt+z')
    await expect(page.getByText('Mindeck · Zen mode')).toBeVisible()
    await expect(page.getByTitle('Terminal', { exact: true })).toHaveCount(0) // no side navigation
    await expect(page.getByTestId('pane-head-agents')).toBeVisible()
    await page.getByRole('button', { name: 'Leave zen mode' }).first().click()
    await expect(page.getByText('Mindeck · Zen mode')).toHaveCount(0)
    await expect(page.getByTitle('Terminal', { exact: true })).toBeVisible()

    // saved as a workspace, switched away (a seeded one) and back by its key
    await menu.click()
    await page.getByRole('textbox', { name: 'Workspace name' }).fill('QA review')
    await page.getByRole('button', { name: 'Save layout' }).click()
    await page.getByRole('button', { name: 'Switch to Coding' }).click()
    await expect(page.getByTestId('pane-head-editor')).toBeVisible()
    await expect(page.getByTestId('pane-head-terminal')).toBeVisible()
    await expect(page.getByTestId('pane-head-agents')).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+Alt+3')
    await expect(page.getByTestId('pane-head-agents')).toBeVisible()
    await expect(page.getByTestId('pane-head-browser')).toBeVisible()
    await expect(divider).toHaveAttribute('aria-valuenow', '35')
    await expect(menu).toContainText('QA review')

    // a restart brings the same workspace back
    const next = await restart()
    const again = next.page
    await expect(again.getByTestId('pane-head-agents')).toBeVisible()
    await expect(again.getByTestId('pane-head-browser')).toBeVisible()
    await expect(again.getByRole('separator', { name: 'Resize the columns' })).toHaveAttribute('aria-valuenow', '35')
    await expect(again.getByRole('button', { name: 'Layout and workspaces' })).toContainText('QA review')
    await expect(again.getByRole('tab', { name: /Mindeck E2E/ })).toHaveCount(0) // the browser starts with a new tab
  } finally {
    await site.close()
  }
})
