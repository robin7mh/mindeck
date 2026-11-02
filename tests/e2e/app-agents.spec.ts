import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from './fixtures'

test('agents: the composer — an @ file reference, an attached image and the model, sent to the agent', async ({ page, home }) => {
  const root = join(home, 'composer-demo')
  mkdirSync(root)
  writeFileSync(join(root, 'README.md'), '# demo\n') // 7 bytes
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', 'add', '.'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'init'], { cwd: root })
  await page.evaluate((path) => window.mindeck!.invoke('projects:add', { path }), root)

  await page.getByTitle('Agents', { exact: true }).click()
  await page.getByRole('button', { name: 'New chat' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New chat' })
  await expect(dialog.getByText('Pro plan · v9.9.9')).toBeVisible()
  await dialog.getByRole('button', { name: 'Start' }).click()
  await expect(dialog).toBeHidden()

  // the model, as Claude Code offers it
  const model = page.getByRole('combobox', { name: 'Model' })
  await expect(model).toHaveText(/Default model/)
  await model.click()
  await page.getByRole('option', { name: /Sonnet/ }).click()
  await expect(model).toHaveText(/Sonnet/)

  // @ finds the project's files
  const message = page.getByRole('textbox', { name: 'Message' })
  await message.click()
  await page.keyboard.type('Summarize @READ')
  const refs = page.getByRole('listbox', { name: 'Files, notes and tabs' })
  await expect(refs.getByRole('option', { name: /README\.md/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Remove README.md' })).toBeVisible()
  await expect(message).toHaveValue('Summarize ')

  // an image, attached from disk
  await page.getByTestId('image-input').setInputFiles(resolve('build/icon.png'))
  await expect(page.locator('img[alt="icon.png"]')).toBeVisible()

  // sent: the agent gets the text, the file and the image — and says what it read
  await message.press('Enter')
  await expect(page.getByText('Read README.md (7 bytes) and an image (PNG)')).toBeVisible()
  await expect(page.getByText('Summarize').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove README.md' })).toHaveCount(0) // the composer is empty again
})
