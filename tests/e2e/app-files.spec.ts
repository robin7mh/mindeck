import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test('files: copy and paste (with a name clash), rename and undo, zip and unzip, columns, tabs', async ({ page, home }) => {
  const desk = join(home, 'Desk')
  mkdirSync(join(desk, 'sub'), { recursive: true })
  writeFileSync(join(desk, 'a.txt'), 'alpha\n')
  writeFileSync(join(desk, 'b.md'), '# b\n')

  await page.getByTitle('Files', { exact: true }).click()
  const area = page.getByRole('region', { name: 'Files' }).locator('[tabindex="0"]')
  await area.press('Control+Shift+G')
  const goTo = page.getByRole('textbox', { name: /Go to folder/ })
  await goTo.fill(desk)
  await goTo.press('Enter')
  await page.getByRole('button', { name: 'List', exact: true }).click()
  await expect(page.getByText('3 items')).toBeVisible()
  const row = (name: string) => page.getByRole('row', { name: new RegExp(`^${name.replace('.', '\\.')}`) })

  // ⌘C on a file, ⌘V in a folder — and again: the name is taken, keep both
  await row('a.txt').click()
  await area.press('Control+c')
  await expect(page.getByText('1 item copied')).toBeVisible()
  await row('sub').dblclick()
  await expect(page.getByText('0 items')).toBeVisible()
  await area.press('Control+v')
  await expect(row('a.txt')).toBeVisible()
  expect(readFileSync(join(desk, 'sub', 'a.txt'), 'utf8')).toBe('alpha\n')
  await area.press('Control+v')
  const clash = page.getByRole('alertdialog', { name: '“a.txt” already exists in “sub”' })
  await expect(clash).toBeVisible()
  await clash.getByRole('button', { name: 'Keep both' }).click()
  await expect(row('a 2.txt')).toBeVisible()
  expect(existsSync(join(desk, 'sub', 'a 2.txt'))).toBe(true)

  // up again; F2 renames, ⌘Z takes it back
  await area.press('Control+ArrowUp')
  await expect(page.getByText('3 items')).toBeVisible()
  await row('b.md').click()
  await area.press('F2')
  await expect(page.getByRole('textbox', { name: 'Rename' })).toBeFocused()
  await page.keyboard.type('plan')
  await page.keyboard.press('Enter')
  await expect(row('plan.md')).toBeVisible()
  expect(existsSync(join(desk, 'plan.md'))).toBe(true)
  await area.press('Control+z')
  await expect(page.getByText('Undone')).toBeVisible()
  await expect(row('b.md')).toBeVisible()
  expect(existsSync(join(desk, 'b.md')) && !existsSync(join(desk, 'plan.md'))).toBe(true)

  // everything into a ZIP, and out of it again
  await area.press('Control+a')
  await row('a.txt').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Compress 3 items' }).click()
  await expect(row('Archive.zip')).toBeVisible()
  await row('Archive.zip').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Extract' }).click()
  await expect(row('Archive')).toHaveCount(2) // the folder next to the archive
  await expect.poll(() => existsSync(join(desk, 'Archive', 'sub', 'a 2.txt')) && readFileSync(join(desk, 'Archive', 'a.txt'), 'utf8')).toBe('alpha\n')

  // the column view: a folder opens as the next column
  await page.getByRole('button', { name: 'Columns', exact: true }).click()
  const columns = page.getByRole('group', { name: 'Columns' })
  await columns.getByRole('listbox', { name: desk, exact: true }).getByRole('option', { name: 'sub' }).click()
  await expect(columns.getByRole('listbox', { name: join(desk, 'sub'), exact: true }).getByRole('option', { name: 'a 2.txt' })).toBeVisible()

  // tabs: each with its own folder
  await area.press('Control+t')
  const tabs = page.getByRole('tablist', { name: 'Tabs' })
  await expect(tabs.getByRole('tab')).toHaveCount(2)
  await page.getByRole('button', { name: 'List', exact: true }).click()
  await area.press('Control+ArrowUp')
  await expect(tabs.getByRole('tab', { selected: true })).toHaveText('Desk')
  await tabs.getByRole('tab').first().click()
  await expect(tabs.getByRole('tab', { selected: true })).toHaveText('sub')
  await expect(row('a 2.txt')).toBeVisible()
  await tabs.getByRole('tab').first().getByRole('button', { name: 'Close tab' }).click()
  await expect(tabs).toHaveCount(0) // one tab left: no tab strip
  await expect(page.getByText('5 items')).toBeVisible() // Desk: a.txt, b.md, sub, Archive.zip, Archive
})
