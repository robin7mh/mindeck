import { EventEmitter } from 'node:events'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tempDir } from './helpers'
import { bundledPrettier, LintService } from '../../../electron/main/services/lint/LintService'

/** A stand-in ESLint (flat-config API) — bad words are errors, `var` has a fix, files under ignored/ are ignored. */
const ESLINT = `
class ESLint {
  constructor(o) { this.fix = o.fix }
  async isPathIgnored(f) { return f.includes('/ignored/') }
  async lintText(text, { filePath }) {
    if (text.includes('CRASH')) throw new Error('Parsing error: Unexpected token')
    if (filePath.endsWith('.skip.js')) return []
    const messages = []
    text.split('\\n').forEach((line, i) => {
      const at = line.indexOf('var ')
      if (at >= 0) messages.push({ line: i + 1, column: at + 1, endLine: i + 1, endColumn: at + 4, message: 'Unexpected var', ruleId: 'no-var', severity: 2, fix: { range: [0, 3], text: 'let' } })
      if (line.includes('TODO')) messages.push({ line: i + 1, column: 1, message: 'A todo', ruleId: null, severity: 1 })
    })
    return [{ messages, output: this.fix ? text.replace(/var /g, 'let ') : undefined }]
  }
}
module.exports = { ESLint, loadESLint: async () => ESLint }
`
const LEGACY_ESLINT = `module.exports = { ESLint: class { constructor() {} async isPathIgnored() { return false } async lintText() { return [{ messages: [], output: undefined }] } } }`
/** A stand-in Prettier: upper-cases, knows .js and .css, ignores what .prettierignore names. */
const PRETTIER = (tag: string) => `
const fs = require('fs'), path = require('path')
module.exports = {
  async getFileInfo(file, { ignorePath }) {
    const ignored = fs.existsSync(ignorePath) && fs.readFileSync(ignorePath, 'utf8').split('\\n').some((l) => l && file.endsWith(l))
    return { ignored, inferredParser: /\\.(js|css)$/.test(file) ? 'babel' : null }
  },
  async resolveConfig(file) { return fs.existsSync(path.join(path.dirname(file), '.prettierrc')) ? { semi: false } : null },
  async format(text, options) { return '${tag}:' + JSON.stringify({ semi: options.semi }) + ':' + text.toUpperCase() }
}
`

async function project(files: Record<string, string>): Promise<string> {
  const root = await tempDir('mindeck-lint-')
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true })
    await writeFile(join(root, name), text)
  }
  return root
}

const services: LintService[] = []
afterEach(() => services.splice(0).forEach((s) => s.dispose()))

async function setup(files: Record<string, string>, opts: Partial<ConstructorParameters<typeof LintService>[0]> = {}) {
  const root = await project(files)
  const bundled = await project({ 'prettier/index.js': PRETTIER('bundled') })
  const svc = new LintService({ resolveRoot: (id) => (id === 'p' ? root : undefined), trusted: () => true, prettier: join(bundled, 'prettier/index.js'), ...opts })
  services.push(svc)
  return { svc, root }
}

describe('ESLint and Prettier from the project', () => {
  // The project's tools also resolve through NODE_PATH, which on some machines names a global
  // ESLint or Prettier. The tests' projects have none: no global ones either.
  let savedNodePath: string | undefined
  beforeEach(() => {
    savedNodePath = process.env.NODE_PATH
    delete process.env.NODE_PATH
  })
  afterEach(() => {
    if (savedNodePath !== undefined) process.env.NODE_PATH = savedNodePath
  })

  it('lints with the project’s ESLint: problems, severities, fixes; ignored and other files are not linted', async () => {
    const { svc } = await setup({ 'eslint.config.js': 'export default []', 'node_modules/eslint/index.js': ESLINT })
    const res = await svc.lint('p', 'src/a.js', 'var x = 1\n// TODO\n')
    expect(res.available).toBe(true)
    expect(res.diagnostics).toEqual([
      { range: { start: { line: 1, offset: 1 }, end: { line: 1, offset: 4 } }, message: 'Unexpected var', severity: 'error', code: 'no-var', source: 'eslint', fix: { start: 0, end: 3, text: 'let' } },
      { range: { start: { line: 2, offset: 1 }, end: { line: 2, offset: 2 } }, message: 'A todo', severity: 'warning', code: undefined, source: 'eslint' }
    ])
    expect(await svc.lint('p', 'ignored/a.js', 'var x')).toEqual({ available: false, diagnostics: [] })
    expect(await svc.lint('p', 'x.skip.js', 'var x')).toEqual({ available: false, diagnostics: [] })
    expect(await svc.lint('p', 'README.md', 'var x')).toEqual({ available: false, diagnostics: [] })
    expect(await svc.fix('p', 'src/a.js', 'var x = 1')).toBe('let x = 1')
    expect(await svc.fix('p', 'ignored/a.js', 'var x')).toBeNull()
    expect(await svc.fix('p', 'README.md', 'var x')).toBeNull()
    await expect(svc.lint('p', 'src/a.js', 'CRASH')).rejects.toMatchObject({ code: 'lint', message: 'Parsing error: Unexpected token' })
    await expect(svc.lint('nope', 'a.js', '')).rejects.toMatchObject({ code: 'not-found' })
    await expect(svc.lint('p', '../outside.js', '')).rejects.toMatchObject({ code: 'outside-project' })
  }, 20_000)

  it('no ESLint config, or no ESLint module: nothing to lint; an old ESLint without loadESLint works too; package.json eslintConfig counts', async () => {
    const noConfig = await setup({ 'node_modules/eslint/index.js': ESLINT })
    expect((await noConfig.svc.lint('p', 'a.js', 'var x')).available).toBe(false)
    const noModule = await setup({ 'eslint.config.js': '' })
    expect((await noModule.svc.lint('p', 'a.js', 'var x')).available).toBe(false)
    const legacy = await setup({ 'package.json': '{ "eslintConfig": {} }', 'node_modules/eslint/index.js': LEGACY_ESLINT })
    expect(await legacy.svc.lint('p', 'a.js', 'var x')).toEqual({ available: true, diagnostics: [] })
    expect(await legacy.svc.fix('p', 'a.js', 'var x')).toBeNull()
    const rc = await setup({ 'package.json': '{}', '.eslintrc.json': '{}', 'node_modules/eslint/index.js': LEGACY_ESLINT })
    expect((await rc.svc.lint('p', 'a.js', '')).available).toBe(true)
    // A package.json Node can't read: no ESLint (Node can't load modules under it either).
    const broken = await setup({ 'package.json': '{ broken', '.eslintrc.json': '{}', 'node_modules/eslint/index.js': LEGACY_ESLINT })
    expect((await broken.svc.lint('p', 'a.js', '')).available).toBe(false)
  }, 20_000)

  it('Prettier: the project’s with its config; Mindeck’s only when asked (with the user’s options); ignored and unknown files are the editor’s', async () => {
    const own = await setup({ '.prettierrc': '{}', 'node_modules/prettier/index.js': PRETTIER('project'), '.prettierignore': 'skip.js\n' })
    expect(await own.svc.format('p', 'a.js', 'x')).toBe('project:{"semi":false}:X')
    expect(await own.svc.format('p', 'skip.js', 'x')).toBeNull()
    expect(await own.svc.format('p', 'a.py', 'x')).toBeNull()
    const none = await setup({})
    expect(await none.svc.format('p', 'a.css', 'x')).toBeNull()
    expect(await none.svc.format('p', 'a.css', 'x', { prettier: true, options: { semi: true } })).toBe('bundled:{"semi":true}:X')
    expect(await none.svc.format('p', 'a.css', 'x', { prettier: true })).toBe('bundled:{}:X')
  }, 20_000)

  it('a project that isn’t trusted: none of its modules or configs load — no ESLint, only Mindeck’s Prettier with the editor’s options', async () => {
    // The attack: loading the project's ESLint, Prettier or their configs runs its code.
    const PWN = "require('fs').writeFileSync(require('path').join(process.env.MINDECK_ROOT, 'pwned-' + Math.random()), '');"
    const { svc, root } = await setup(
      {
        'eslint.config.js': PWN,
        'node_modules/eslint/index.js': PWN + ESLINT,
        'node_modules/prettier/index.js': PWN + PRETTIER('project'),
        '.prettierrc': '{}'
      },
      { trusted: () => false }
    )
    expect(await svc.lint('p', 'a.js', 'var x')).toEqual({ available: false, diagnostics: [] })
    expect(await svc.fix('p', 'a.js', 'var x')).toBeNull()
    expect(await svc.format('p', 'a.js', 'x')).toBeNull()
    // Mindeck's own, with the user's options (not the project's .prettierrc: semi false).
    expect(await svc.format('p', 'a.js', 'x', { prettier: true, options: { semi: true } })).toBe('bundled:{"semi":true}:X')
    expect((await readdir(root)).filter((f) => f.startsWith('pwned'))).toEqual([])
  }, 20_000)

  it('without a trust check, a project counts as not trusted', async () => {
    const started: boolean[] = []
    const svc = new LintService({
      resolveRoot: () => process.cwd(),
      prettier: 'x',
      spawn: (_root, trusted) => {
        started.push(trusted)
        return new FakeWorker() as never
      }
    })
    services.push(svc)
    void svc.format('p', 'a.js', 'x').catch(() => {})
    await tick()
    expect(started).toEqual([false])
  })

  it('a worker started under the other trust is replaced', async () => {
    let trusted = false
    const procs: { trusted: boolean; proc: FakeWorker }[] = []
    const { svc } = await setup({}, {
      trusted: () => trusted,
      spawn: (_root, t) => {
        const proc = new FakeWorker()
        procs.push({ trusted: t, proc })
        return proc as never
      }
    })
    void svc.format('p', 'a.js', 'x').catch(() => {})
    void svc.format('p', 'a.js', 'x').catch(() => {})
    await tick()
    expect(procs.map((p) => p.trusted)).toEqual([false])
    trusted = true
    void svc.format('p', 'a.js', 'x').catch(() => {})
    await tick()
    expect(procs.map((p) => p.trusted)).toEqual([false, true])
    expect(procs[0].proc.killed).toBe(true)
  })

  it('the worker: noise on stdout is skipped, a slow answer times out, a crash fails what waits and it starts again; idle workers stop; restart', async () => {
    let spawned = 0
    const procs: FakeWorker[] = []
    const { svc } = await setup({}, {
      timeoutMs: 50,
      idleMs: 200,
      spawn: () => {
        spawned += 1
        const p = new FakeWorker()
        procs.push(p)
        return p as never
      }
    })
    const pending = svc.format('p', 'a.js', 'x')
    await until(() => procs.length === 1)
    procs[0].say('a plugin printing to stdout')
    procs[0].say(JSON.stringify({ id: 99, ok: true, result: 'not ours' }))
    procs[0].say(JSON.stringify({ id: 1, ok: true, result: 'formatted' }))
    expect(await pending).toBe('formatted')
    await expect(svc.format('p', 'a.js', 'x')).rejects.toMatchObject({ code: 'lint-timeout' })
    const crashing = svc.format('p', 'a.js', 'x')
    await tick()
    procs[0].emit('exit')
    await expect(crashing).rejects.toMatchObject({ message: 'The ESLint / Prettier worker stopped' })
    void svc.format('p', 'a.js', 'x').catch(() => {})
    await until(() => spawned === 2)
    expect(spawned).toBe(2)
    procs[0].emit('exit') // a stale exit: the new worker stays
    await tick(260) // idle: stopped
    expect(procs[1].killed).toBe(true)
    void svc.format('p', 'a.js', 'x').catch(() => {})
    await until(() => procs.length === 3)
    svc.restart()
    expect(procs[2].killed).toBe(true)
  })

  it('Mindeck’s Prettier lies outside the app archive (the worker is its own Node)', () => {
    expect(bundledPrettier((id) => `/App/Resources/app.asar${sep}node_modules${sep}${id}${sep}index.cjs`)).toBe(`/App/Resources/app.asar.unpacked${sep}node_modules${sep}prettier${sep}index.cjs`)
    expect(bundledPrettier()).toMatch(/prettier/)
  })
})

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))
/** Waits by the clock (not a fixed number of turns): under load the worker starts later. */
async function until(done: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !done() && Date.now() < end; ) await tick(5)
}

class FakeWorker extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  say(line: string) {
    this.stdout.write(`${line}\n`)
  }
  kill() {
    this.killed = true
    return true
  }
}
