import { EventEmitter } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
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
  const svc = new LintService({ resolveRoot: (id) => (id === 'p' ? root : undefined), prettier: join(bundled, 'prettier/index.js'), ...opts })
  services.push(svc)
  return { svc, root }
}

describe('ESLint and Prettier from the project', () => {
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
    await tick()
    procs[0].say('a plugin printing to stdout')
    procs[0].say(JSON.stringify({ id: 99, ok: true, result: 'not ours' }))
    procs[0].say(JSON.stringify({ id: 1, ok: true, result: 'formatted' }))
    expect(await pending).toBe('formatted')
    await expect(svc.format('p', 'a.js', 'x')).rejects.toMatchObject({ code: 'lint-timeout' })
    // A worker that timed out may be stuck for good: it is stopped, the next request gets a fresh one.
    expect(procs[0].killed).toBe(true)
    const waiting = svc.format('p', 'a.js', 'x')
    for (let i = 0; i < 500 && spawned < 2; i++) await new Promise((r) => setImmediate(r)) // answer well within the 50 ms timeout
    expect(spawned).toBe(2)
    procs[0].emit('exit') // a stale exit: the new worker and what waits on it stay
    procs[1].say(JSON.stringify({ id: 3, ok: true, result: 'still here' }))
    expect(await waiting).toBe('still here')
    const crashing = svc.format('p', 'a.js', 'x')
    await tick()
    procs[1].emit('exit')
    await expect(crashing).rejects.toMatchObject({ message: 'The ESLint / Prettier worker stopped' })
    void svc.format('p', 'a.js', 'x').catch(() => {})
    await tick()
    expect(spawned).toBe(3)
    await tick(260) // idle: stopped
    expect(procs[2].killed).toBe(true)
    void svc.format('p', 'a.js', 'x').catch(() => {})
    await tick()
    svc.restart()
    expect(procs[3].killed).toBe(true)
  })

  it('Mindeck’s Prettier lies outside the app archive (the worker is its own Node)', () => {
    expect(bundledPrettier((id) => `/App/Resources/app.asar${sep}node_modules${sep}${id}${sep}index.cjs`)).toBe(`/App/Resources/app.asar.unpacked${sep}node_modules${sep}prettier${sep}index.cjs`)
    expect(bundledPrettier()).toMatch(/prettier/)
  })
})

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

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
