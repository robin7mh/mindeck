import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test('first start: the whole setup, step by step — then Settings: diagnostics copied, the logs folder opened', async ({ app, home }) => {
  const project = join(home, 'first-project')
  mkdirSync(project)
  writeFileSync(join(project, 'package.json'), '{ "name": "first-project" }\n')
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
  }, project)

  const page = await app.firstWindow()
  const setup = page.getByRole('dialog', { name: 'Set up Mindeck' })
  await expect(setup).toBeVisible()
  const next = setup.getByRole('button', { name: 'Next' })
  const at = (step: string) => expect(setup.locator('[aria-current="step"]')).toHaveText(step)

  // 1 · Welcome: language and look (the whole UI follows at once)
  await at('Welcome')
  await setup.getByRole('radio', { name: 'Deutsch' }).click()
  const german = page.getByRole('dialog', { name: 'Mindeck einrichten' })
  await expect(german.getByRole('button', { name: 'Weiter' })).toBeVisible()
  await german.getByRole('radio', { name: 'English' }).click()
  await expect(setup).toBeVisible()
  await setup.getByRole('radio', { name: 'Light' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await setup.getByRole('radio', { name: 'Dark' }).click()
  await next.click()

  // 2 · Coding agents: Claude Code found (the stand-in), signed in
  await at('Coding agents')
  await expect(setup.getByText(/Installed · v9\.9\.9 · Signed in/)).toBeVisible()
  await next.click()

  // 3 · First project: through the (stubbed) folder dialog
  await at('First project')
  await setup.getByRole('button', { name: 'Choose a folder …' }).click()
  await expect(setup.getByText(project)).toBeVisible()
  await next.click()

  // 4 · VS Code / Cursor, 5 · browser data: nothing to take over here — on
  await at('VS Code / Cursor')
  await next.click()
  await at('Browser data')
  await next.click()

  // 6 · Done
  await at('Done')
  await expect(setup.getByText('Ready to go')).toBeVisible()
  await setup.getByRole('button', { name: 'Start working' }).click()
  await expect(setup).toBeHidden()
  expect(await page.evaluate(() => localStorage.getItem('mindeck.onboarding'))).toContain('"done":true')
  const boot = page.getByText('click to skip')
  if (await boot.isVisible()) await boot.click()
  await page.getByTitle('Projects', { exact: true }).click()
  await expect(page.getByText('first-project').first()).toBeVisible()

  // Settings → Desktop app: the diagnostics land on the clipboard
  await page.getByTitle('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'Copy diagnostics' }).click()
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible()
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
  expect(copied).toContain('Mindeck ')
  expect(copied).toContain(join(home, 'logs'))

  // the logs folder: handed to the system's file manager (stubbed — a real one would outlive the app and hold up
  // its exit) — and if there is none, Mindeck says so and keeps running
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { opened?: string[] }).opened = opened
    shell.openPath = async (path: string) => (opened.push(path), '')
  })
  await page.getByRole('button', { name: 'Open logs folder' }).click()
  await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened)).toEqual([join(home, 'logs')])
  await app.evaluate(({ shell }) => {
    shell.openPath = async () => 'no application to open it'
  })
  await page.getByRole('button', { name: 'Open logs folder' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'No file manager opened the folder' })).toContainText(join(home, 'logs'))
  expect(await page.evaluate(() => window.mindeck!.invoke('desktop:status'))).toMatchObject({ ok: true }) // the core is still there
})
