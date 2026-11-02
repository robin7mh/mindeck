import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' })

/** Today as the UI names daily notes (the local date). */
function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test('memory: a note with live preview and [[ completion, saved to disk — and today’s daily note', async ({ page, home }) => {
  await page.getByTitle('Memory', { exact: true }).click()
  await page.getByText('Create Mindeck vault').click()
  await expect(page.getByText('Willkommen', { exact: true }).first()).toBeVisible()

  await page.getByRole('button', { name: 'New note' }).first().click()
  const title = page.getByPlaceholder('Note title…')
  await title.fill('Plans')
  await title.press('Enter')
  const editor = page.locator('.cm-content')
  await expect(editor).toBeVisible()
  await editor.click()
  await page.keyboard.type('# Big plan\n\nStart at [[Willk')
  // the vault's notes, offered as you type
  const options = page.locator('.cm-tooltip-autocomplete [role="option"]')
  // picked with the mouse (Enter right after the list opens is a line break, by CodeMirror's design)
  await options.filter({ hasText: 'Willkommen' }).click()
  await page.keyboard.type(' today.')
  // Live Preview: a heading looks like one, the link like a link
  await expect(page.locator('.cm-line.cm-md-h1')).toContainText('Big plan')
  await expect(page.locator('.cm-md-wikilink')).toContainText('Willkommen')
  await expect(page.locator('.cm-md-unresolved')).toHaveCount(0)
  await page.keyboard.press('Control+s')
  await expect(page.getByText('saved', { exact: true })).toBeVisible()
  await expect.poll(() => (existsSync(join(home, 'vault', 'Plans.md')) ? readFileSync(join(home, 'vault', 'Plans.md'), 'utf8') : '')).toContain('Start at [[Willkommen]] today.')

  // today's daily note: created once, in its folder
  await page.getByRole('button', { name: 'Today' }).click()
  await expect(page.getByRole('textbox', { name: /^Rename/ })).toHaveValue(today())
  await expect.poll(() => existsSync(join(home, 'vault', 'Daily', `${today()}.md`))).toBe(true)
})

test('editor: search and replace across the project (⇧⌘F), and a merge conflict resolved with “Accept Incoming”', async ({ page, home }) => {
  const root = join(home, 'shop')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'theme.ts'), 'export const accent = "tomato"\n')
  writeFileSync(join(root, 'src', 'button.ts'), 'export const border = "tomato"\nexport const text = "black"\n')
  writeFileSync(join(root, 'price.txt'), 'price: 10\n')
  git(root, 'init', '-q')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'base')
  git(root, 'checkout', '-q', '-b', 'sale')
  writeFileSync(join(root, 'price.txt'), 'price: 8\n')
  git(root, 'commit', '-q', '-am', 'sale price')
  git(root, 'checkout', '-q', 'main')
  writeFileSync(join(root, 'price.txt'), 'price: 12\n')
  git(root, 'commit', '-q', '-am', 'new price')
  expect(spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', 'merge', 'sale'], { cwd: root }).status).not.toBe(0) // the conflict
  expect(await page.evaluate((path) => window.mindeck!.invoke('projects:add', { path }), root)).toMatchObject({ ok: true })

  await page.getByTitle('Editor', { exact: true }).click()
  await expect(page.getByRole('treeitem', { name: 'src' })).toBeVisible()
  await page.keyboard.press('Control+Shift+F')
  const search = page.getByRole('textbox', { name: 'Search', exact: true })
  await search.fill('tomato')
  await expect(page.getByText('2 results in 2 files')).toBeVisible()
  await page.getByRole('button', { name: 'Toggle replace' }).click()
  await page.getByRole('textbox', { name: 'Replace', exact: true }).fill('teal')
  await page.getByRole('button', { name: 'Replace all' }).click()
  await expect.poll(() => readFileSync(join(root, 'src', 'theme.ts'), 'utf8')).toBe('export const accent = "teal"\n')
  // the files are written one after the other: wait for the second as well
  await expect.poll(() => readFileSync(join(root, 'src', 'button.ts'), 'utf8')).toBe('export const border = "teal"\nexport const text = "black"\n')
  await expect(page.getByText('No results.')).toBeVisible()

  // the conflicted file: both sides marked, Accept Incoming takes theirs, then it is staged
  await page.getByRole('button', { name: 'Explorer', exact: true }).click()
  await page.getByRole('treeitem', { name: 'price.txt' }).click()
  const conflictBar = page.getByRole('status').filter({ hasText: /merge conflict|No conflicts left/ })
  await expect(conflictBar).toContainText('1 merge conflict')
  await page.locator('.codelens-decoration a', { hasText: 'Accept Incoming Change' }).click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('price: 8')
  await expect(conflictBar).toContainText('No conflicts left in this file.')
  await conflictBar.getByRole('button', { name: 'Mark as resolved' }).click()
  await expect.poll(() => git(root, 'diff', '--name-only', '--diff-filter=U')).toBe('')
  expect(readFileSync(join(root, 'price.txt'), 'utf8')).toBe('price: 8\n')
})
