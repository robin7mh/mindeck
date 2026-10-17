import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

type Fixtures = {
  /** Throwaway ~/Mindeck for this test (vault, settings, project registry). */
  home: string
  /** Extra environment for the app (set with `test.use({ env: … })`). */
  env: Record<string, string>
  /** Extra command-line switches for the app (set with `test.use({ args: … })`). */
  args: string[]
  app: ElectronApplication
  /** The main window, past the boot overlay. */
  page: Page
  /** Everything the main process printed so far. */
  mainLog: () => string
  /**
   * Quit the app the way a user does (confirming the quit while shells run)
   * and start it again on the same home and window storage — what a restart
   * restores. The fixtures `app` and `page` keep pointing at the first run.
   */
  restart: () => Promise<{ app: ElectronApplication; page: Page }>
}

/**
 * Every test runs on a fresh ~/Mindeck, so the window opens as a first start
 * with the setup over it (it has its own test). Waits until the setup has
 * decided and skips it.
 */
export async function skipSetup(page: Page): Promise<void> {
  await page.waitForFunction(() => localStorage.getItem('mindeck.onboarding') !== null)
  const decided = await page.evaluate(() => JSON.parse(localStorage.getItem('mindeck.onboarding')!) as { done: boolean })
  if (!decided.done) await page.getByRole('dialog', { name: 'Set up Mindeck' }).getByRole('button', { name: 'Skip setup' }).click()
}

/**
 * A fresh profile shows the split screen's tip under the top bar's Split
 * button; tests that don't need it put it away, so it covers nothing.
 */
export async function dismissTips(page: Page): Promise<void> {
  const tip = page.getByRole('dialog', { name: 'Split screen' })
  if (await tip.isVisible()) await tip.getByRole('button', { name: 'Dismiss' }).click()
}

/** The real, built app on `home` — with its own window storage there too. */
function launch(home: string, extra: Record<string, string>, switches: string[]): Promise<ElectronApplication> {
  // MINDECK_CLAUDE_BIN: agent sessions run a stand-in for Claude Code (no account, no model).
  const env = { ...process.env, MINDECK_HOME: home, LANG: 'en_US.UTF-8', MINDECK_CLAUDE_BIN: resolve('tests/e2e/fake-claude.mjs'), ...extra } as Record<string, string>
  delete env.ELECTRON_RENDERER_URL // always the built renderer, never a dev server
  delete env.ELECTRON_RUN_AS_NODE
  return electron.launch({
    // MINDECK_E2E_ELECTRON: another Electron binary — one with a release's fuses (RunAsNode off), say.
    ...(process.env.MINDECK_E2E_ELECTRON ? { executablePath: process.env.MINDECK_E2E_ELECTRON } : {}),
    // --no-sandbox: CI runners and containers have no usable Chromium sandbox.
    // --lang: on macOS Electron takes the system language, not LANG.
    // --user-data-dir: the window's own storage (layout, setup, …) is this test's too.
    args: [resolve('out/main/index.js'), '--no-sandbox', '--lang=en-US', `--user-data-dir=${join(home, 'electron')}`, ...switches],
    env
  })
}

/** The main window, past the setup and the boot overlay. */
async function mainWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await skipSetup(page)
  const boot = page.getByText('click to skip')
  if (await boot.isVisible()) await boot.click()
  await boot.waitFor({ state: 'detached' })
  await dismissTips(page)
  return page
}

/** End a run without anyone to answer a dialog. */
async function kill(app: ElectronApplication): Promise<void> {
  // Shells or agents still running make a quit ask first (no one answers here): exit outright.
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  // A program the app started (a file manager, a browser) can hold its output open: don't wait on it for ever.
  const closed = app.close().then(
    () => true,
    () => true
  )
  if (!(await Promise.race([closed, new Promise<false>((r) => setTimeout(() => r(false), 10_000))]))) app.process().kill('SIGKILL')
}

export const test = base.extend<Fixtures>({
  home: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'mindeck-e2e-'))
    await use(dir)
    await rm(dir, { recursive: true, force: true })
  },

  env: [{}, { option: true }],
  args: [[], { option: true }],

  app: async ({ home, env, args }, use) => {
    const app = await launch(home, env, args)
    await use(app)
    await kill(app)
  },

  mainLog: async ({ app }, use) => {
    let log = ''
    app.process().stdout?.on('data', (d) => (log += String(d)))
    app.process().stderr?.on('data', (d) => (log += String(d)))
    await use(() => log)
  },

  page: async ({ app, mainLog }, use) => {
    void mainLog // start capturing before the window opens
    await use(await mainWindow(app))
  },

  restart: async ({ app, home, env, args }, use) => {
    let current = app
    const later: ElectronApplication[] = []
    await use(async () => {
      // The quit asks while shells run: the user confirms ("Quit Mindeck").
      await current.evaluate(({ dialog }) => {
        dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox
      })
      const exited = new Promise((done) => current.process().once('exit', done))
      await current.evaluate(({ app }) => app.quit())
      await exited
      current = await launch(home, env, args)
      later.push(current)
      return { app: current, page: await mainWindow(current) }
    })
    for (const run of later) await kill(run)
  }
})

export { expect } from '@playwright/test'
