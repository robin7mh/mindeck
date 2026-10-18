import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test('terminal: find in the output (Ctrl+Shift+F), and after a restart the old output greyed above a new shell in the same folder', async ({ page, home, restart }) => {
  const work = join(home, 'work')
  mkdirSync(work)
  await page.getByTitle('Terminal', { exact: true }).click()
  const screen = page.locator('.xterm-rows').first()
  await expect(screen).toBeVisible()
  await page.locator('.xterm-helper-textarea').first().focus()
  await page.keyboard.type(`cd "${work}" && echo "marker-$((6 * 7))"\n`)
  await expect(screen).toContainText('marker-42')

  // find: ⌘F on macOS, else Ctrl+Shift+F (Ctrl+F stays the shell's)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+Shift+F')
  const find = page.getByRole('textbox', { name: 'Find' })
  await expect(find).toBeFocused()
  await find.fill('marker-42')
  await expect(page.getByText('1 of 1')).toBeVisible()
  await find.fill('no-such-text')
  await expect(page.getByText('No results')).toBeVisible()
  await find.press('Escape')
  await expect(find).toBeHidden()

  // the tab follows the shell into the folder before Mindeck quits
  await expect(page.getByRole('button', { name: /^Close .*work/ })).toBeVisible()

  const again = (await restart()).page
  await again.getByTitle('Terminal', { exact: true }).click()
  const restored = again.locator('.xterm-rows').first()
  await expect(restored).toContainText('marker-42') // the last run's output…
  await expect(restored).toContainText(/Restored · /)
  await expect(restored.locator('span', { hasText: 'marker-42' }).first()).toHaveClass(/xterm-fg-8/) // …greyed
  await again.locator('.xterm-helper-textarea').first().focus()
  await again.keyboard.type('echo "now in $PWD"\n')
  await expect(restored).toContainText(`now in ${work}`) // a new shell, where the old one was
})
