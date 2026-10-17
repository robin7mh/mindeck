import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { test as base, expect, type Page } from '@playwright/test'
import { dismissTips } from './fixtures'
// @ts-expect-error — plain ESM helper without type declarations
import { startFakeAnthropic } from './fake-anthropic.mjs'

/**
 * The web UI against the real standalone core (`npm run web:build` +
 * `npm run server:build`): pairing, live data over the WebSocket, the folder
 * browser and the access rules for remote clients.
 */
/** The stand-in for the Messages API (fake-anthropic.mjs): `hold()` keeps answers back until released. */
type FakeAnthropic = { hold: () => () => void; waiting: () => number }
type Core = { url: string; home: string; code: () => Promise<string>; log: () => string; anthropic: FakeAnthropic }

const test = base.extend<{ core: Core; paired: Page; shells: boolean }>({
  /** Remote shells on this core (off by default, like a real one). */
  shells: [false, { option: true }],
  core: async ({ shells }, use) => {
    const home = await mkdtemp(join(tmpdir(), 'mindeck-web-e2e-'))
    await mkdir(join(home, 'code'))
    const port = 7600 + Math.floor(Math.random() * 300)
    const anthropic = await startFakeAnthropic()
    let log = ''
    const proc: ChildProcess = spawn(process.execPath, [resolve('out/server/index.cjs')], {
      env: {
        ...process.env,
        MINDECK_HOME: home,
        MINDECK_PORT: String(port),
        MINDECK_WEB_ROOT: resolve('out/web'),
        // the folders paired devices may add as projects
        MINDECK_REMOTE_ROOTS: join(home, 'code'),
        ...(shells ? { MINDECK_REMOTE_TERMINAL: '1' } : {}),
        // the assistant talks to a local stand-in for the Messages API
        ANTHROPIC_BASE_URL: anthropic.url,
        ANTHROPIC_API_KEY: 'sk-e2e-fake-key-000000'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    proc.stdout!.on('data', (d) => (log += String(d)))
    proc.stderr!.on('data', (d) => (log += String(d)))
    await expect.poll(() => log, { timeout: 15_000 }).toContain('listening on')
    const code = async () => {
      await expect.poll(() => /Code: {2}([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(log)?.[1]).toBeTruthy()
      return /Code: {2}([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(log)![1]
    }
    await use({ url: `http://127.0.0.1:${port}`, home, code, log: () => log, anthropic })
    proc.kill('SIGTERM')
    await new Promise((r) => proc.once('exit', r))
    await anthropic.close()
    await rm(home, { recursive: true, force: true })
  },

  paired: async ({ page, core }, use) => {
    await page.goto(core.url)
    await page.getByLabel('Pairing code').fill(await core.code())
    await page.getByRole('button', { name: 'Pair device' }).click()
    await page.getByText('click to skip').click()
    await page.getByText('click to skip').waitFor({ state: 'detached' })
    await dismissTips(page)
    await use(page)
  }
})

/** A core route called the way the paired browser calls it (its device token), from outside the browser. */
async function rpc<T>(page: Page, core: Core, channel: string, payload: unknown = null): Promise<T> {
  const token = await page.evaluate(() => sessionStorage.getItem('mindeck.token') ?? localStorage.getItem('mindeck.token'))
  const res = await fetch(`${core.url}/api/rpc/${channel}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  })
  const body = (await res.json()) as { ok: boolean; data: T }
  expect(body.ok).toBe(true)
  return body.data
}

test('pairs a browser and shows live data from the core', async ({ paired, core }) => {
  await expect(paired.getByText(/REMOTE ·/)).toBeVisible()
  await expect(paired.getByText('LIVE')).toBeVisible() // telemetry over the WebSocket
  await expect(paired.getByRole('heading', { level: 1 })).toContainText(/Good (morning|afternoon|evening|night)/)

  // The token lives in the core's HttpOnly cookie, never in web storage (FE-SEC-03).
  expect(await paired.evaluate(() => localStorage.getItem('mindeck.token') ?? sessionStorage.getItem('mindeck.token'))).toBeNull()
  expect((await paired.context().cookies()).find((c) => c.name.startsWith('mindeck_'))).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api' })
  // the pairing survives a reload; unpairing returns to the pairing screen
  await paired.reload()
  await expect(paired.getByText(/REMOTE ·/)).toBeVisible()
  await paired.getByLabel('Disconnect this browser').click()
  await expect(paired.getByLabel('Pairing code')).toBeVisible()
  expect(core.log()).toContain('Mindeck pairing')
})

test('rejects a wrong pairing code', async ({ page, core }) => {
  await page.goto(core.url)
  await page.getByLabel('Pairing code').fill('AAAA-AAAA')
  await page.getByRole('button', { name: 'Pair device' }).click()
  await expect(page.getByText('Pairing code is invalid or expired')).toBeVisible()
})

test('adds a project and a vault through the folder browser; the editor reads it', async ({ paired, core }) => {
  await mkdir(join(core.home, 'code', 'demo'), { recursive: true })
  await writeFile(join(core.home, 'code', 'demo', 'notes.md'), '# Remote notes\n')
  await paired.getByTitle('Projects', { exact: true }).click()
  await paired.getByRole('button', { name: 'Add project' }).click()
  await paired.getByLabel('Folder path').fill(join(core.home, 'code'))
  await paired.getByLabel('Folder path').press('Enter')
  await paired.getByRole('button', { name: 'demo' }).click()
  await paired.locator('footer').getByRole('button', { name: 'Add project' }).click()
  await expect(paired.getByRole('heading', { level: 2 })).toHaveText('demo')
  await expect(paired.getByText('VS Code')).toHaveCount(0) // host apps are desktop-only

  // Monaco runs in the browser too; writing project files needs remote shells (off here)
  await paired.getByTitle('Editor', { exact: true }).click()
  await paired.getByRole('treeitem', { name: 'notes.md' }).click()
  await expect(paired.locator('.monaco-editor .view-lines')).toContainText('# Remote notes')
  await expect(paired.getByText('Read-only')).toBeVisible()

  await paired.getByTitle('Memory', { exact: true }).click()
  await paired.getByText('Create Mindeck vault').click()
  await expect(paired.getByText('Willkommen', { exact: true }).first()).toBeVisible()
  await expect(paired.getByLabel('Show vault in Finder')).toHaveCount(0)
})

test('remote shells stay off unless the core allows them', async ({ paired, core }) => {
  await paired.getByTitle('Terminal', { exact: true }).click()
  await expect(paired.getByText('Remote shells are off')).toBeVisible()
  const res = await fetch(`${core.url}/api/rpc/terminal:list`, { method: 'POST' })
  expect(res.status).toBe(401)
})

// A device approves changes only where it may run commands, too.
test.describe('with remote shells', () => {
  test.use({ shells: true })

  test('agents: streamed answer, a tool call behind an approval, the note lands in the vault', async ({ paired, core }) => {
    await paired.getByTitle('Memory', { exact: true }).click()
    await paired.getByText('Create Mindeck vault').click()
    await expect(paired.getByText('Willkommen', { exact: true }).first()).toBeVisible()

    // ask from the Core dashboard — it opens the Agents module
    await paired.getByTitle('Core', { exact: true }).click()
    await paired.getByLabel('Ask Mindeck').fill('Hallo Mindeck')
    await paired.getByLabel('Ask Mindeck').press('Enter')
    await expect(paired.getByRole('heading', { name: 'Hello from the assistant' })).toBeVisible()
    await expect(paired.getByText('I can see your Mindeck context.')).toBeVisible()
    await expect(paired.getByLabel('Send')).toBeVisible() // the run is over

    await paired.getByLabel('Message').fill('Bitte merk dir das als Notiz')
    await paired.getByLabel('Message').press('Enter')
    await expect(paired.getByText('Why: You asked me to remember this plan')).toBeVisible()
    await paired.getByRole('button', { name: 'Allow once' }).first().click()
    await expect(paired.getByText(/Saved — the note/)).toBeVisible()
    await expect.poll(() => existsSync(join(core.home, 'vault', 'E2E Plan.md'))).toBe(true)
    await expect(paired.getByText(/Run completed · 2 steps/).first()).toBeVisible()

    // settings shows the key from the environment and the standing permissions
    await paired.getByTitle('Settings', { exact: true }).click()
    await expect(paired.getByText(/Anthropic key from the environment/)).toBeVisible()
  })

  test('reconnect: an approval asked for while the browser was offline shows once it is back', async ({ paired, core, context }) => {
    // context.setOffline cuts HTTP, but Chromium keeps an open WebSocket going: the page's sockets get a
    // switch too — down closes them and fails new ones at once (like a dropped Wi-Fi), up lets them through.
    await paired.addInitScript(() => {
      const Real = window.WebSocket
      const open = new Set<WebSocket>()
      let down = false
      window.WebSocket = class extends Real {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          if (down) this.close()
          else {
            open.add(this)
            this.addEventListener('close', () => open.delete(this))
          }
        }
      }
      Object.assign(window, {
        e2eNetwork: {
          down: () => {
            down = true
            for (const socket of open) socket.close()
          },
          up: () => (down = false)
        }
      })
    })
    await paired.reload()
    const network = async (on: boolean) => {
      await context.setOffline(!on)
      await paired.evaluate((on) => (window as unknown as { e2eNetwork: { up(): void; down(): void } }).e2eNetwork[on ? 'up' : 'down'](), on)
    }
    await expect(paired.getByText('LIVE')).toBeVisible()

    await paired.getByTitle('Memory', { exact: true }).click()
    await paired.getByText('Create Mindeck vault').click()
    await expect(paired.getByText('Willkommen', { exact: true }).first()).toBeVisible()
    await paired.getByTitle('Core', { exact: true }).click()
    await paired.getByLabel('Ask Mindeck').fill('Hallo Mindeck')
    await paired.getByLabel('Ask Mindeck').press('Enter')
    await expect(paired.getByRole('heading', { name: 'Hello from the assistant' })).toBeVisible()
    await expect(paired.getByLabel('Send')).toBeVisible()

    // The model takes its time; meanwhile the browser loses the network.
    const release = core.anthropic.hold()
    await paired.getByLabel('Message').fill('Bitte merk dir das als Notiz')
    await paired.getByLabel('Message').press('Enter')
    await expect.poll(() => core.anthropic.waiting()).toBe(1)
    await network(false)
    await expect(paired.getByText(/^(DOWN|SYNC)$/)).toBeVisible()

    // The answer arrives during the outage: the core asks for the approval, pushed to no one.
    release()
    await expect.poll(async () => (await rpc<unknown[]>(paired, core, 'permission:pending')).length, { timeout: 15_000 }).toBe(1)
    await expect(paired.getByText('Why: You asked me to remember this plan')).toHaveCount(0)

    // Back online: the socket reconnects, the UI reloads what it missed — the approval is there and works.
    await network(true)
    await expect(paired.getByText('OK', { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(paired.getByText('Why: You asked me to remember this plan')).toBeVisible()
    await paired.getByRole('button', { name: 'Allow once' }).first().click()
    await expect(paired.getByText(/Saved — the note/)).toBeVisible()
    await expect.poll(() => existsSync(join(core.home, 'vault', 'E2E Plan.md'))).toBe(true)
  })
})
