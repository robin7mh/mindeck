import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { IpcResult } from '@shared/ipc/contract'
import type { BrowserState } from '@shared/types/browser'
import { expect, test } from './fixtures'
import { localSite } from './helpers'

test('boots into the Command Center without any database; the activity log is a file', async ({ page, home }) => {
  await expect(page.getByText('Command Center').first()).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Good (morning|afternoon|evening|night)/)
  const log = join(home, 'data', 'events.jsonl')
  await expect.poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : '')).toContain('"app.started"')
})

test('a first start opens the setup over the window; skipping it leaves the Command Center', async ({ app }) => {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const setup = page.getByRole('dialog', { name: 'Set up Mindeck' })
  await expect(setup).toBeVisible()
  await setup.getByRole('button', { name: 'Skip setup' }).click()
  await expect(setup).toBeHidden()
  const boot = page.getByText('click to skip')
  if (await boot.isVisible()) await boot.click()
  await expect(page.getByText('Command Center').first()).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('mindeck.onboarding'))).toContain('"done":true')
})

test('navigates every module', async ({ page }) => {
  const nav = (name: string) => page.getByRole('button', { name, exact: true }).or(page.getByTitle(name, { exact: true }))
  await nav('Editor').click()
  await expect(page.getByText('No projects yet')).toBeVisible()
  await nav('Projects').click()
  // the editor stays mounted (hidden) once opened — only the visible text counts
  await expect(page.getByText('No projects yet').filter({ visible: true })).toBeVisible()
  await nav('Memory').click()
  await expect(page.getByText('Create Mindeck vault')).toBeVisible()
  await nav('Agents').click()
  await expect(page.getByText('Your agents, in one place')).toBeVisible() // starts with "New chat", no key needed
  await nav('System').click()
  await expect(page.getByText('Top processes')).toBeVisible()
  await nav('Settings').click()
  await expect(page.getByText('Remote access · web & mobile')).toBeVisible()
  await nav('Core').click()
  await expect(page.getByLabel('Open Projects')).toBeVisible()
})

test('settings: the embedded API server starts on demand and answers', async ({ page }) => {
  await page.getByTitle('Settings', { exact: true }).click()
  await expect(page.getByText('API server off')).toBeVisible()
  await page.getByLabel('Port').fill('7499')
  await page.getByLabel('Port').blur()
  await page.getByLabel('Run the API server').check()
  await expect(page.getByText('API server running')).toBeVisible()
  const res = await fetch('http://127.0.0.1:7499/api/health')
  expect(await res.json()).toMatchObject({ ok: true, name: 'Mindeck', mode: 'desktop' })
  await page.getByRole('button', { name: 'Pair a device' }).click()
  // LAN off: no QR a phone couldn't open — the code and what to switch on instead
  await expect(page.getByText(/Only this computer can connect right now/)).toBeVisible()
  await expect(page.getByLabel('Pairing QR code')).toHaveCount(0)
  await page.getByLabel('Run the API server').uncheck()
  await expect(page.getByText('API server off')).toBeVisible()
})

test('the terminal runs a real shell, keeps it across modules and splits panes', async ({ page }) => {
  await page.getByTitle('Terminal', { exact: true }).click()
  const screen = page.locator('.xterm-rows').first()
  await expect(screen).toBeVisible()
  await page.locator('.xterm-helper-textarea').first().focus()
  await page.keyboard.type('echo "mindeck-$((40 + 2))"\n')
  await expect(screen).toContainText('mindeck-42')

  await page.getByTitle('Core', { exact: true }).click()
  await page.getByTitle('Terminal', { exact: true }).click()
  await expect(screen).toContainText('mindeck-42') // same session, still there

  await page.getByLabel('Layout: Side by side').click()
  await page.getByRole('button', { name: 'New terminal' }).last().click()
  await page.getByRole('button', { name: 'Home' }).click()
  await expect(page.locator('.xterm-rows')).toHaveCount(2)
})

test('split screen from the top bar; the command palette brings a module into the focused pane', async ({ page }) => {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.getByTitle('Agents', { exact: true }).click()
  await page.getByRole('button', { name: 'Split screen' }).click()
  await expect(page.getByTestId('pane-head-agents')).toBeVisible()
  await expect(page.getByTestId('pane-head-terminal')).toBeVisible() // the new pane, with the focus

  await page.keyboard.press(`${mod}+Shift+P`)
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  await palette.getByRole('combobox').fill('browser')
  await expect(palette.getByRole('option').first()).toHaveText(/^Browser\s*Open$/)
  await page.keyboard.press('Enter')
  await expect(palette).toBeHidden()
  await expect(page.getByTestId('pane-head-agents')).toBeVisible()
  await expect(page.getByTestId('pane-head-browser')).toBeVisible()
  await expect(page.getByTestId('pane-head-terminal')).toHaveCount(0)

  // Every shortcut, from one list.
  await page.keyboard.press(`${mod}+/`)
  const overview = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(overview.getByText('Split the screen (a new pane)')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(overview).toBeHidden()
})

test('memory: creates the starter vault, writes a note to disk and links it', async ({ page, home }) => {
  await page.getByTitle('Memory', { exact: true }).click()
  await page.getByText('Create Mindeck vault').click()
  await expect(page.getByText('Willkommen', { exact: true }).first()).toBeVisible()

  await page.getByRole('button', { name: 'New note' }).first().click()
  const title = page.getByPlaceholder('Note title…')
  await title.fill('E2E Note')
  await title.press('Enter')
  const editor = page.locator('.cm-content')
  await expect(editor).toBeVisible()
  await editor.fill('Written by Playwright, see [[Willkommen]]')
  await page.keyboard.press('Control+s')
  await expect(page.getByText('saved', { exact: true })).toBeVisible()

  const file = join(home, 'vault', 'E2E Note.md')
  await expect.poll(() => existsSync(file)).toBe(true)
  await page.getByTitle('Read (⌘E)').click()
  await expect(page.locator('.md-prose a.wikilink')).toHaveText('Willkommen')
  await expect(page.getByTitle('This note links to it')).toHaveText('Willkommen')
})

test('projects: adds a git folder through the (stubbed) native picker', async ({ app, page }) => {
  const repo = resolve('.')
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
  }, repo)
  await page.getByTitle('Projects', { exact: true }).click()
  await page.getByRole('button', { name: 'Add project' }).click()
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('mindeck') // package.json name
  await expect(page.getByText(repo).first()).toBeVisible()
  if (branch !== 'HEAD') await expect(page.getByText(branch).first()).toBeVisible()
  await expect(page.getByText('TypeScript').first()).toBeVisible()
})

test('editor: opens a project file in Monaco, saves it with ⌘S and follows changes on disk', async ({ page, home }) => {
  const root = join(home, 'demo')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'hello.ts'), 'export const greeting = "hi"\n')
  writeFileSync(join(root, '.gitignore'), 'dist\n')
  mkdirSync(join(root, 'dist'))
  const added = await page.evaluate((path) => window.mindeck!.invoke('projects:add', { path }), root)
  expect(added).toMatchObject({ ok: true })

  await page.getByTitle('Editor', { exact: true }).click()
  await expect(page.getByRole('treeitem', { name: 'dist' })).toHaveClass(/opacity-50/) // git-ignored
  await page.getByRole('treeitem', { name: 'src' }).click()
  await page.getByRole('treeitem', { name: 'hello.ts' }).click()
  const lines = page.locator('.monaco-editor .view-lines')
  await expect(lines).toContainText('export const greeting')
  await expect(page.getByText('TypeScript', { exact: true })).toBeVisible()

  await lines.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('export const greeting = "from Mindeck"')
  await expect(page.getByText('Unsaved', { exact: true })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  expect(readFileSync(join(root, 'src', 'hello.ts'), 'utf8')).toBe('export const greeting = "from Mindeck"')

  // an outside edit (an agent, git, VS Code) shows up in the clean tab by itself
  writeFileSync(join(root, 'src', 'hello.ts'), 'export const greeting = "changed outside"\n')
  await expect(lines).toContainText('changed outside')
})

test('editor: three editor groups — split right and down, one file edited in all of them, an outline from the language service', async ({ page, home }) => {
  const root = join(home, 'groups')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'shared.ts'), 'export function greet(name: string) {\n  return `hi ${name}`\n}\n')
  writeFileSync(join(root, 'src', 'other.ts'), 'export const other = 1\n')
  const added = await page.evaluate((path) => window.mindeck!.invoke('projects:add', { path }), root)
  expect(added).toMatchObject({ ok: true })

  await page.getByTitle('Editor', { exact: true }).click()
  await page.getByRole('treeitem', { name: 'src' }).click()
  await page.getByRole('treeitem', { name: 'shared.ts' }).click()
  const group = (n: number) => page.getByRole('region', { name: `Editor group ${n}` })
  await expect(group(1).locator('.monaco-editor .view-lines')).toContainText('export function greet')

  // ⌘\ splits right, ⌘K ⌘\ splits the new group down — each new group shows the file too.
  await group(1).locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('ControlOrMeta+Backslash')
  await expect(group(2).locator('.monaco-editor .view-lines')).toContainText('export function greet')
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.press('ControlOrMeta+Backslash')
  await expect(page.getByRole('region', { name: /^Editor group \d$/ })).toHaveCount(3)
  await expect(group(3).locator('.monaco-editor .view-lines')).toContainText('export function greet')

  // An edit in the third group shows in all three (one buffer), unsaved until ⌘S.
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('// edited in group 3')
  for (const n of [1, 2, 3]) await expect(group(n).locator('.monaco-editor .view-lines')).toContainText('edited in group 3')
  await expect(page.getByText('Unsaved', { exact: true })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  expect(readFileSync(join(root, 'src', 'shared.ts'), 'utf8')).toContain('// edited in group 3')

  // ⌘1 focuses the first group; a file opened now opens there, the others keep theirs.
  await page.keyboard.press('ControlOrMeta+1')
  await page.getByRole('treeitem', { name: 'other.ts' }).click()
  await expect(group(1).locator('.monaco-editor .view-lines')).toContainText('export const other')
  await expect(group(2).locator('.monaco-editor .view-lines')).toContainText('edited in group 3')

  // The outline and the breadcrumbs know the file's symbols (Monaco's TypeScript service).
  await group(2).getByRole('tab', { name: /shared\.ts/ }).click()
  await page.getByRole('navigation', { name: 'Editor' }).getByRole('button', { name: 'Outline' }).click()
  await expect(page.getByRole('tree', { name: 'Outline' }).getByRole('treeitem', { name: /greet/ })).toBeVisible()
  await page.getByRole('tree', { name: 'Outline' }).getByRole('treeitem', { name: /greet/ }).click()
  await expect(group(2).getByRole('navigation', { name: 'Breadcrumbs' })).toContainText('greet')
})

test('agents: a coding agent session — chat, approval in Mindeck, the change as a diff, a journal in memory', async ({ page, home }) => {
  const root = join(home, 'agent-demo')
  mkdirSync(root)
  writeFileSync(join(root, 'README.md'), '# demo\n')
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', 'add', '.'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'init'], { cwd: root })
  await page.evaluate((path) => window.mindeck!.invoke('projects:add', { path }), root)
  await page.evaluate(() => window.mindeck!.invoke('memory:createVault'))

  await page.getByTitle('Agents', { exact: true }).click()
  await page.getByRole('button', { name: 'New chat' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New chat' })
  await expect(dialog.getByText('Pro plan · v9.9.9')).toBeVisible() // detected (the stand-in)
  await dialog.getByLabel('First message').fill('Write the output file')
  await dialog.getByRole('button', { name: 'Start' }).click()

  // the agent asks before it runs a command — answered in Mindeck
  await expect(page.getByText('Write the output file').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(1) // inline only — no toast for the open chat
  await page.getByRole('button', { name: 'Allow once' }).click()
  await expect(page.getByText('Done: wrote fake-output.txt')).toBeVisible()
  await expect(page.getByText('· Your turn')).toBeVisible()
  expect(readFileSync(join(root, 'fake-output.txt'), 'utf8')).toBe('written by the fake agent\n')

  // named after its agent; a click on the name renames it
  const name = page.getByLabel('Session name')
  await expect(name).toHaveValue('Claude Code')
  await name.fill('Output writer')
  await name.press('Enter')
  await expect(page.getByText('Output writer', { exact: true })).toBeVisible() // the list follows
  await expect(page.getByText(/^Claude Code · agent-demo/)).toBeVisible()

  // what changed, as a diff
  await page.getByRole('button', { name: /^A fake-output\.txt/ }).click()
  await expect(page.getByRole('dialog', { name: 'Changes in fake-output.txt' })).toBeVisible()
  await expect(page.locator('.monaco-diff-editor')).toBeVisible()
  await page.getByLabel('Close diff').click()

  // the session's journal lands in the vault
  await expect.poll(() => (existsSync(join(home, 'vault', 'Agents', 'agent-demo')) ? readdirSync(join(home, 'vault', 'Agents', 'agent-demo')) : [])).toHaveLength(1)
  await page.getByRole('tab', { name: /Memory/ }).click()
  await expect(page.getByText('Session journal')).toBeVisible()
  await page.getByLabel('End session').click()
  await expect(page.getByText('· Ended')).toBeVisible()
})

test('browser: a local page in a real Chromium tab — back and forth, kept across modules, remembered', async ({ page, home }) => {
  const site = await localSite()
  try {
    await page.getByTitle('Browser', { exact: true }).click()
    await expect(page.getByText('Search the web or type an address')).toBeVisible() // the new-tab page
    const address = page.getByRole('textbox', { name: 'Address or search' })
    await address.fill(`localhost:${site.port}`)
    await address.press('Enter')
    await expect(page.getByRole('tab', { name: /Mindeck E2E/ })).toBeVisible()
    await expect(address).toHaveValue(`localhost:${site.port}`)
    await expect(page.getByTitle('Local page on this computer')).toBeVisible()
    // a local page: agents may see it (the dev loop) without sharing it first
    const tabs = async () => {
      const res = (await page.evaluate(() => window.mindeck!.invoke('browser:state'))) as IpcResult<BrowserState>
      return res.ok ? res.data.tabs.map((t) => [t.title, t.url, t.shared]) : []
    }
    await expect.poll(tabs).toEqual([['Mindeck E2E', `http://localhost:${site.port}/`, true]])

    await address.fill(`localhost:${site.port}/second`)
    await address.press('Enter')
    await expect(page.getByRole('tab', { name: /Second page/ })).toBeVisible()
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page.getByRole('tab', { name: /Mindeck E2E/ })).toBeVisible()

    // other modules and back: the same tab, still there
    await page.getByTitle('Core', { exact: true }).click()
    await page.getByTitle('Browser', { exact: true }).click()
    await expect(page.getByRole('tab', { name: /Mindeck E2E/ })).toBeVisible()

    // a new tab: its own empty address bar, ready to type; closing it shows the page again
    await page.getByRole('button', { name: 'New tab', exact: true }).click()
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(page.getByText('Search the web or type an address')).toBeVisible()
    await expect(address).toBeFocused()
    await expect(address).toHaveValue('')
    await page.getByRole('button', { name: 'Close New tab' }).click()
    await expect(page.getByRole('tab')).toHaveCount(1)

    // the history is a file in Mindeck's folder
    await expect.poll(() => readFileSync(join(home, 'data', 'browser', 'history.jsonl'), 'utf8')).toContain(`http://localhost:${site.port}/second`)
  } finally {
    await site.close()
  }
})

test('browser: two local pages side by side in a split view, a tab group, vertical tabs — kept in the session', async ({ app, page, home }) => {
  const site = await localSite()
  try {
    await page.getByTitle('Browser', { exact: true }).click()
    const address = page.getByRole('textbox', { name: 'Address or search' })
    await address.fill(`localhost:${site.port}`)
    await address.press('Enter')
    await expect(page.getByRole('tab', { name: /Mindeck E2E/ })).toBeVisible()

    // split with a new tab: two panes, the new one's address bar ready to type
    await page.getByRole('button', { name: 'Split with a new tab (⌘⇧D)' }).click()
    await expect(page.getByTestId('browser-pane')).toHaveCount(2)
    await expect(address).toBeFocused()
    await address.fill(`localhost:${site.port}/second`)
    await address.press('Enter')
    await expect(page.getByRole('tab', { name: /Second page/ })).toBeVisible()
    const browser = async () => {
      const res = (await page.evaluate(() => window.mindeck!.invoke('browser:state'))) as IpcResult<BrowserState>
      if (!res.ok) throw new Error(res.error.message)
      const title = (id: string) => res.data.tabs.find((t) => t.id === id)?.title
      return { ...res.data, title, splitTitles: res.data.splits.map((s) => s.tabs.map(title)) }
    }
    await expect.poll(async () => (await browser()).splitTitles).toEqual([['Mindeck E2E', 'Second page']])
    // The browser's keys are taken in the main process (before-input-event), which keys typed by
    // Playwright (CDP) skip: these go in as real input events of the window.
    const shortcut = (keyCode: string) =>
      app.evaluate(({ BrowserWindow }, keyCode) => {
        const wc = BrowserWindow.getAllWindows()[0].webContents
        wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: [process.platform === 'darwin' ? 'meta' : 'control', 'shift'] })
        wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: [process.platform === 'darwin' ? 'meta' : 'control', 'shift'] })
      }, keyCode)
    // the omnibox shows the focused side
    await expect(address).toHaveValue(`localhost:${site.port}/second`)

    // both pages are real web views on screen, side by side in their panes
    const views = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]
          .contentView.children.filter((v) => v.getVisible())
          .map((v) => v.getBounds())
          .sort((a, b) => a.x - b.x)
      )
    await expect
      .poll(async () => {
        const v = await views()
        return v.length === 2 && v[0].y === v[1].y && v[0].height === v[1].height && v[0].x + v[0].width < v[1].x
      })
      .toBe(true)
    // swapped, then stacked: one above the other
    await page.getByRole('button', { name: 'Swap sides' }).click()
    await expect.poll(async () => (await browser()).splitTitles).toEqual([['Second page', 'Mindeck E2E']])
    await page.getByRole('button', { name: 'Stack top and bottom' }).click()
    await expect
      .poll(async () => {
        const v = (await views()).sort((a, b) => a.y - b.y)
        return v.length === 2 && v[0].x === v[1].x && v[0].y + v[0].height < v[1].y
      })
      .toBe(true)

    // the focused tab into a new group (⌘⇧G / Ctrl+Shift+G), named in the editor
    await shortcut('G')
    const editor = page.getByRole('dialog', { name: 'Edit group' })
    await expect(editor).toBeVisible()
    await editor.getByRole('textbox', { name: 'Group name' }).fill('Research')
    await editor.getByRole('textbox', { name: 'Group name' }).press('Enter')
    await expect(editor).toBeHidden()
    const chip = page.getByRole('button', { name: 'Fold Research' })
    await expect(chip).toBeVisible()
    await expect.poll(async () => (await browser()).groups.map((g) => g.title)).toEqual(['Research'])
    await expect.poll(async () => {
      const b = await browser()
      return b.tabs.filter((t) => t.groupId === b.groups[0]?.id).map((t) => t.title)
    }).toEqual(['Second page'])

    // vertical tabs (⌘⇧, / Ctrl+Shift+,): the sidebar instead of the strip — the group and both tabs in it
    await page.getByRole('button', { name: 'Close split view' }).click()
    await expect(page.getByTestId('browser-pane')).toHaveCount(0)
    await shortcut(',')
    const sidebar = page.getByRole('complementary', { name: 'Tabs' })
    await expect(sidebar).toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'Fold Research' })).toBeVisible()
    await expect(sidebar.getByRole('tab')).toHaveCount(2)

    // the session file keeps the group (written shortly after a change)
    const session = join(home, 'data', 'browser', 'session.json')
    await expect
      .poll(() => (existsSync(session) ? (JSON.parse(readFileSync(session, 'utf8')) as { groups?: { title: string }[] }).groups?.map((g) => g.title) : null))
      .toEqual(['Research'])
  } finally {
    await site.close()
  }
})

test('a dev server started in the terminal opens in the browser with one click', async ({ page, home }) => {
  const script = join(home, 'dev-server.mjs')
  writeFileSync(
    script,
    `import { createServer } from 'node:http'
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end('<!doctype html><title>Dev preview</title><h1>Running</h1>')
})
server.listen(0, () => console.log('  Local:   http://localhost:' + server.address().port + '/'))
`
  )
  await page.getByTitle('Terminal', { exact: true }).click()
  await expect(page.locator('.xterm-rows').first()).toBeVisible()
  await page.locator('.xterm-helper-textarea').first().focus()
  await page.keyboard.type(`"${process.execPath}" "${script}"\n`)
  const chip = page.getByTitle(/^Open localhost:\d+$/)
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(page.getByRole('tab', { name: /Dev preview/ })).toBeVisible()
})

test('files: browses a folder, previews notes and pictures, renames, creates, searches — and opens a terminal there', async ({ page, home }) => {
  const demo = join(home, 'Demo')
  mkdirSync(join(demo, 'sub'), { recursive: true })
  writeFileSync(join(demo, 'README.md'), '# Demo notes\n\nPreviewed **in Mindeck**.\n')
  writeFileSync(join(demo, 'notes.txt'), 'plain text\n')
  copyFileSync(resolve('build/icon.png'), join(demo, 'icon.png'))

  await page.getByTitle('Files', { exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Files' })).toContainText('Home')
  // ⌘⇧G (Ctrl elsewhere): any folder by its path
  await page.getByRole('region', { name: 'Files' }).locator('[tabindex="0"]').press('Control+Shift+G')
  const goTo = page.getByRole('textbox', { name: /Go to folder/ })
  await goTo.fill(demo)
  await goTo.press('Enter')
  await page.getByRole('button', { name: 'List', exact: true }).click()
  await expect(page.getByRole('row', { name: /^README\.md/ })).toBeVisible()
  await expect(page.getByText('4 items')).toBeVisible()

  const preview = page.getByRole('complementary', { name: 'Preview' })
  await page.getByRole('row', { name: /^README\.md/ }).click()
  await expect(preview.getByRole('heading', { name: 'Demo notes' })).toBeVisible()
  await page.getByRole('row', { name: /^icon\.png/ }).click()
  const picture = preview.locator('img[alt="icon.png"]')
  await expect(picture).toBeVisible()
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0) // streamed over mindeck-file:

  await page.getByRole('row', { name: /^notes\.txt/ }).click()
  await page.keyboard.press('F2')
  await expect(page.getByRole('textbox', { name: 'Rename' })).toBeFocused()
  await page.keyboard.type('todo') // the name is selected, not the extension
  await page.keyboard.press('Enter')
  await expect(page.getByRole('row', { name: /^todo\.txt/ })).toBeVisible()
  expect(existsSync(join(demo, 'todo.txt'))).toBe(true)

  await page.getByRole('button', { name: 'New folder', exact: true }).click()
  const folder = page.getByRole('textbox', { name: 'New folder' })
  await folder.fill('Plans')
  await folder.press('Enter')
  await expect(page.getByRole('row', { name: /^Plans/ })).toBeVisible()
  expect(statSync(join(demo, 'Plans')).isDirectory()).toBe(true)

  const search = page.getByRole('textbox', { name: 'Search in “Demo”' })
  await search.fill('todo')
  await expect(page.getByText('1 found')).toBeVisible()
  await search.press('Escape')
  await expect(page.getByText('5 items')).toBeVisible()

  await page.getByRole('row', { name: /^sub/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open Terminal here' }).click()
  const screen = page.locator('.xterm-rows').first()
  await expect(screen).toBeVisible()
  await page.locator('.xterm-helper-textarea').first().focus()
  await page.keyboard.type('pwd\n')
  await expect(screen).toContainText('/Demo/sub')
})

