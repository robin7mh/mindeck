import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test('terminal: find in the output (Ctrl+Shift+F), and after a restart one clean shell in Home', async ({ page, home, restart }) => {
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

  // nothing of the last run: one new shell, in Home (the last run's tabs only when asked for in Settings)
  const again = (await restart()).page
  await again.getByTitle('Terminal', { exact: true }).click()
  const fresh = again.locator('.xterm-rows').first()
  await expect(again.locator('.xterm-rows')).toHaveCount(1)
  await again.locator('.xterm-helper-textarea').first().focus()
  await again.keyboard.type('echo "now in $PWD"\n')
  await expect(fresh).toContainText(`now in ${homedir()}`)
  await expect(fresh).not.toContainText('marker-42')
  await expect(fresh).not.toContainText(/Restored · /)
})
