import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import type { TestFramework, TestItem, TestResult, TestRunState } from '@shared/types/tests'
import type { DebugBreakpoint, DebugSession } from '@shared/types/debug'
import { spawnInShell } from '../debug/adapters'
import { pythonFor } from '../tools/catalog'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

const JS_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/
const PY_TEST = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/
const GO_TEST = /_test\.go$/
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.venv', 'venv', 'env', '__pycache__', '.next', 'vendor', '.mindeck', 'target'])
const MAX_FILES = 3000
/** What a run keeps of the runner's output. */
const MAX_OUTPUT = 200_000

const slash = (p: string) => p.split(sep).join('/')
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// --- finding tests (nothing runs) ---

/** describe / it / test calls of a JS / TS file, nested — read with TypeScript's parser. */
export async function jsTests(path: string, text: string, framework: TestFramework): Promise<TestItem[]> {
  const ts = await import('typescript')
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const SUITES = ['describe', 'suite', 'context']
  const TESTS = ['it', 'test', 'bench']
  /** `describe`, `it.only`, `test.each(…)` → the function's base name. */
  const base = (callee: import('typescript').Expression): string | undefined => {
    if (ts.isIdentifier(callee)) return callee.text
    if (ts.isPropertyAccessExpression(callee)) return base(callee.expression)
    if (ts.isCallExpression(callee) || ts.isTaggedTemplateExpression(callee)) return base(ts.isCallExpression(callee) ? callee.expression : callee.tag)
    return undefined
  }
  const nameOf = (arg: import('typescript').Expression | undefined) =>
    arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : arg && ts.isTemplateExpression(arg) ? arg.getText().slice(1, -1) : undefined
  const walk = (node: import('typescript').Node, parents: string[], into: TestItem[]) => {
    if (ts.isCallExpression(node)) {
      const fn = base(node.expression)
      const name = nameOf(node.arguments[0])
      if (fn && name !== undefined && (SUITES.includes(fn) || TESTS.includes(fn))) {
        const names = [...parents, name]
        const item: TestItem = {
          id: `${path}::${names.join(' > ')}`,
          name,
          kind: SUITES.includes(fn) ? 'suite' : 'test',
          framework,
          path,
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        }
        if (item.kind === 'suite') {
          item.children = []
          node.arguments.slice(1).forEach((a) => walk(a, names, item.children!))
        }
        into.push(item)
        return
      }
    }
    node.forEachChild((child) => walk(child, parents, into))
  }
  const items: TestItem[] = []
  walk(source, [], items)
  return items
}

/** pytest's tests: test_ functions, and Test classes with test_ methods. */
export function pyTests(path: string, text: string): TestItem[] {
  const items: TestItem[] = []
  let cls: TestItem | undefined
  text.split('\n').forEach((line, i) => {
    const klass = /^class\s+(Test\w*)/.exec(line)
    if (klass) {
      cls = { id: `${path}::${klass[1]}`, name: klass[1], kind: 'suite', framework: 'pytest', path, line: i + 1, children: [] }
      items.push(cls)
      return
    }
    if (/^\S/.test(line)) cls = undefined
    const fn = /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/.exec(line)
    if (!fn) return
    if (fn[1] && cls) cls.children!.push({ id: `${cls.id}::${fn[2]}`, name: fn[2], kind: 'test', framework: 'pytest', path, line: i + 1 })
    else if (!fn[1]) items.push({ id: `${path}::${fn[2]}`, name: fn[2], kind: 'test', framework: 'pytest', path, line: i + 1 })
  })
  return items
}

/** go test's tests: func TestXxx(t *testing.T) — ids by package folder. */
export function goTests(path: string, text: string): TestItem[] {
  const dir = path.includes('/') ? dirname(path) : '.'
  return text
    .split('\n')
    .map((line, i) => ({ m: /^func\s+(Test\w*)\s*\(\s*\w+\s+\*testing\.T\s*\)/.exec(line), line: i + 1 }))
    .filter((x) => x.m)
    .map(({ m, line }) => ({ id: `${dir}::${m![1]}`, name: m![1], kind: 'test' as const, framework: 'go' as const, path, line }))
}

// --- what runners report ---

/** A failure as worth reading: no colours, no frames inside the runner or Node, paths from the project. */
export function tidyMessage(root: string, message: string): string {
  return message
    .replace(/\u001b\[[\d;]*m/g, '')
    .split('\n')
    .filter((line) => !/^\s*at\b/.test(line) || !/node_modules|node:|<anonymous>/.test(line))
    .join('\n')
    .split(`file://${root}/`)
    .join('')
    .split(`${root}/`)
    .join('')
    .trim()
}

/** Vitest's / Jest's JSON report → results by test id. */
export function jestResults(root: string, report: unknown): Record<string, TestResult> {
  const out: Record<string, TestResult> = {}
  const STATE: Record<string, TestResult['state']> = { passed: 'passed', failed: 'failed' }
  for (const file of (report as { testResults?: unknown[] }).testResults ?? []) {
    const f = file as { name: string; status?: string; message?: string; assertionResults?: { ancestorTitles: string[]; title: string; status: string; duration?: number | null; failureMessages?: string[] }[] }
    const path = slash(relative(root, f.name))
    // A file that failed before any test ran (a syntax error, a missing import).
    if (f.status === 'failed' && !f.assertionResults?.length) out[path] = { state: 'failed', message: f.message && tidyMessage(root, f.message) }
    for (const a of f.assertionResults ?? []) {
      out[`${path}::${[...a.ancestorTitles, a.title].join(' > ')}`] = {
        state: STATE[a.status] ?? 'skipped',
        durationMs: a.duration ?? undefined,
        message: a.failureMessages?.length ? tidyMessage(root, a.failureMessages.join('\n')) : undefined
      }
    }
  }
  return out
}

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const WORST: TestResult['state'][] = ['failed', 'passed', 'skipped']
/** Several results for one test (parameters, subtests): the worst counts, their times add up. */
function merge(into: Record<string, TestResult>, id: string, r: TestResult & { durationMs: number }): void {
  const had = into[id]
  const worse = !had || WORST.indexOf(r.state) < WORST.indexOf(had.state)
  into[id] = { ...(worse ? r : had), durationMs: (had ? had.durationMs! : 0) + r.durationMs }
}

/** pytest's JUnit XML (xunit1: with file names) → results by node id (parameters merged). */
export function junitResults(xml: string): Record<string, TestResult> {
  const out: Record<string, TestResult> = {}
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attr = (name: string) => decode(new RegExp(`\\b${name}="([^"]*)"`).exec(m[1])?.[1] ?? '')
    const file = attr('file')
    const classname = attr('classname')
    const module = file.replace(/\.py$/, '').split('/').join('.')
    const cls = classname.length > module.length ? classname.slice(module.length + 1).split('.') : []
    const name = attr('name').replace(/\[.*\]$/, '')
    const body = m[3] ?? ''
    const failure = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body)
    const state: TestResult['state'] = failure ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed'
    const message = failure ? decode([/\bmessage="([^"]*)"/.exec(failure[2])?.[1], failure[3]].filter(Boolean).join('\n').trim()) : undefined
    merge(out, [file, ...cls, name].join('::'), { state, durationMs: Math.round(Number(attr('time')) * 1000), message })
  }
  return out
}

const GO_STATE: Record<string, TestResult['state'] | undefined> = { pass: 'passed', fail: 'failed', skip: 'skipped' }

/** `go test -json` events → results by `dir::TestName` (subtests count for their test). */
export function goResults(lines: string, modulePath: string): Record<string, TestResult> {
  const out: Record<string, TestResult> = {}
  const output = new Map<string, string>()
  for (const line of lines.split('\n')) {
    let e: { Action?: string; Package?: string; Test?: string; Elapsed?: number; Output?: string }
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (!e.Test || !e.Package) continue
    const dir = e.Package === modulePath ? '.' : e.Package.startsWith(`${modulePath}/`) ? e.Package.slice(modulePath.length + 1) : e.Package
    const id = `${dir}::${e.Test.split('/')[0]}`
    if (e.Action === 'output') output.set(id, (output.get(id) ?? '') + (e.Output ?? ''))
    const state = GO_STATE[e.Action ?? '']
    if (state) merge(out, id, { state, durationMs: Math.round((e.Elapsed ?? 0) * 1000), message: state === 'failed' ? output.get(id)?.trim() : undefined })
  }
  return out
}

// --- the service ---

export interface TestOptions {
  resolveRoot: (projectId: string) => string | undefined
  publish: (state: TestRunState) => void
  /** Start a run (tests give a stand-in). */
  start?: (command: string, args: string[], cwd: string) => ChildProcess
  /** Debug a test with Mindeck's debugger. */
  debug?: (req: {
    projectId: string
    program: string
    args: string[]
    breakpoints: DebugBreakpoint[]
    inspectChild?: boolean
    module?: string
    goTest?: boolean
  }) => Promise<DebugSession>
}

interface Project {
  root: string
  frameworks: TestFramework[]
  tests: TestItem[]
  run?: ChildProcess
  state: TestRunState
}

/** The ids of a test and everything under it. */
function leaves(item: TestItem): string[] {
  return item.children ? item.children.flatMap(leaves) : [item.id]
}

function find(items: TestItem[], id: string): TestItem | undefined {
  for (const item of items) {
    if (item.id === id) return item
    const hit = item.children && find(item.children, id)
    if (hit) return hit
  }
  return undefined
}

/**
 * The test explorer behind the editor (like VS Code's Testing view): finds
 * Vitest / Jest, pytest and go tests without running anything, runs all or
 * one with the project's own runner, maps the report back onto the tests,
 * and starts Mindeck's debugger on one.
 */
export class TestService {
  private projects = new Map<string, Project>()

  constructor(private readonly opts: TestOptions) {}

  /** Every test of the project, by file. */
  async discover(projectId: string): Promise<TestItem[]> {
    const root = await this.root(projectId)
    const frameworks = await detect(root)
    const files: string[] = []
    const walk = async (dir: string) => {
      for (const e of await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])) {
        if (files.length >= MAX_FILES) return
        const rel = dir ? `${dir}/${e.name}` : e.name
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(rel)
        } else if (JS_TEST.test(rel) || PY_TEST.test(rel) || GO_TEST.test(rel)) files.push(rel)
      }
    }
    await walk('')
    const js = frameworks.find((f) => f === 'vitest' || f === 'jest')
    const tests: TestItem[] = []
    for (const path of files.sort()) {
      const framework: TestFramework | undefined = JS_TEST.test(path) ? js : GO_TEST.test(path) ? (frameworks.includes('go') ? 'go' : undefined) : frameworks.includes('pytest') ? 'pytest' : undefined
      if (!framework) continue
      const text = await readFile(join(root, path), 'utf8')
      const children = await (framework === 'pytest' ? pyTests(path, text) : framework === 'go' ? goTests(path, text) : jsTests(path, text, framework))
      if (children.length) tests.push({ id: path, name: path, kind: 'file', framework, path, children })
    }
    const old = this.projects.get(projectId)
    this.projects.set(projectId, { root, frameworks, tests, run: old?.run, state: old?.state ?? { projectId, running: false, results: {}, output: '' } })
    return tests
  }

  /** The last run's results and output. */
  state(projectId: string): TestRunState {
    return this.projects.get(projectId)?.state ?? { projectId, running: false, results: {}, output: '' }
  }

  /** Run every test, or one file / suite / test. */
  async run(projectId: string, id?: string): Promise<TestRunState> {
    const p = this.projects.get(projectId) ?? (await this.discover(projectId), this.projects.get(projectId)!)
    if (p.run) throw coded('busy', 'Tests are running already')
    const target = id ? find(p.tests, id) : undefined
    if (id && !target) throw coded('not-found', `No test ${id}`)
    const scope = target ? [target] : p.tests
    const running = Object.fromEntries(scope.flatMap(leaves).map((x) => [x, { state: 'running' as const }]))
    // A file that failed to load before: this run says again whether it still does.
    const files = new Set(scope.map((x) => x.path))
    const kept = Object.fromEntries(Object.entries(p.state.results).filter(([k]) => !files.has(k)))
    p.state = { projectId, running: true, results: { ...kept, ...running }, output: '' }
    this.opts.publish(p.state)
    const frameworks = target ? [target.framework] : [...new Set(p.tests.map((t) => t.framework))]
    const results: Record<string, TestResult> = {}
    try {
      for (const framework of frameworks) Object.assign(results, await this.runFramework(p, framework, target))
    } finally {
      // Only what this run was for: the runner reports tests it filtered out as skipped, they keep their last result.
      const fresh = Object.fromEntries(Object.entries(results).filter(([k]) => k in running || files.has(k)))
      // Whatever didn't report (a crashed runner) isn't running any more.
      const settled = Object.fromEntries(Object.keys(running).map((k) => [k, results[k] ?? { state: 'skipped' as const }]))
      p.state = { ...p.state, running: false, results: { ...p.state.results, ...settled, ...fresh } }
      p.run = undefined
      this.opts.publish(p.state)
    }
    return p.state
  }

  /** Stop the running tests. */
  cancel(projectId: string): void {
    this.projects.get(projectId)?.run?.kill()
  }

  /** Debug one test (or suite / file) with Mindeck's debugger: breakpoints in the test and the code it calls. */
  async debug(projectId: string, id: string, breakpoints: DebugBreakpoint[]): Promise<DebugSession> {
    const p = this.projects.get(projectId) ?? (await this.discover(projectId), this.projects.get(projectId)!)
    const item = find(p.tests, id)
    if (!item) throw coded('not-found', `No test ${id}`)
    if (!this.opts.debug) throw coded('unsupported', 'No debugger here')
    const filter = this.jsFilter(item)
    const base = { projectId, breakpoints }
    switch (item.framework) {
      case 'vitest':
        // Vitest runs tests in a worker: it opens the inspector there (one file at a time).
        return this.opts.debug({ ...base, program: 'node_modules/vitest/vitest.mjs', args: ['run', item.path, ...filter, '--inspect-brk=127.0.0.1:0', '--no-file-parallelism', '--test-timeout=0'], inspectChild: true })
      case 'jest':
        return this.opts.debug({ ...base, program: 'node_modules/jest/bin/jest.js', args: ['--runInBand', item.path, ...filter, '--testTimeout=999999999'] })
      case 'pytest':
        return this.opts.debug({ ...base, program: item.path, module: 'pytest', args: [item.id, '-p', 'no:cacheprovider'] })
      default: {
        const name = item.kind === 'test' ? item.name : undefined
        return this.opts.debug({ ...base, program: item.path, goTest: true, args: name ? ['-test.run', `^${name}$`] : [] })
      }
    }
  }

  // --- running ---

  /** Vitest / Jest: run this file, and only tests whose full name matches. */
  private jsFilter(item: TestItem): string[] {
    if (item.kind === 'file') return []
    const names = item.id.slice(item.path.length + 2).split(' > ')
    // Vitest and Jest match "Suite name test name" (spaces between).
    const pattern = `^${escapeRegex(names.join(' '))}${item.kind === 'suite' ? ' ' : '$'}`
    return ['-t', pattern]
  }

  private async runFramework(p: Project, framework: TestFramework, target?: TestItem): Promise<Record<string, TestResult>> {
    const tmp = await mkdtemp(join(tmpdir(), 'mindeck-tests-'))
    const report = join(tmp, 'report')
    try {
      const bin = (name: string) => localBin(p.root, name) ?? ['npx', '--no-install', name]
      const files = target ? [target.path] : []
      const filter = target ? this.jsFilter(target) : []
      let command: string[]
      if (framework === 'vitest') command = [...bin('vitest'), 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${report}`, ...files, ...filter]
      else if (framework === 'jest') command = [...bin('jest'), '--json', `--outputFile=${report}`, ...files, ...filter]
      else if (framework === 'pytest') command = [pythonFor(p.root), '-m', 'pytest', ...(target ? [target.id] : []), '-p', 'no:cacheprovider', '-o', 'junit_family=xunit1', `--junitxml=${report}`]
      else {
        const dir = target ? (target.kind === 'file' ? (target.path.includes('/') ? dirname(target.path) : '.') : target.id.split('::')[0]) : undefined
        const names = target && target.kind === 'test' ? ['-run', `^${target.name}$`] : target ? ['-run', `^(${target.children!.map((c) => c.name).join('|')})$`] : []
        command = ['go', 'test', '-json', ...names, dir ? `./${dir}` : './...']
      }
      const stdout = await this.exec(p, command)
      if (framework === 'go') return goResults(stdout, await goModule(p.root))
      const text = await readFile(report, 'utf8').catch(() => '')
      if (!text) return {}
      return framework === 'pytest' ? junitResults(text) : jestResults(p.root, JSON.parse(text))
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }

  /** Run a command in the project; its output goes to the output view; resolves with stdout. */
  private exec(p: Project, [command, ...args]: string[]): Promise<string> {
    return new Promise((resolve) => {
      const proc = (this.opts.start ?? spawnInShell)(command, args, p.root)
      p.run = proc
      let stdout = ''
      const append = (text: string) => {
        p.state = { ...p.state, output: (p.state.output + text).slice(-MAX_OUTPUT) }
        this.opts.publish(p.state)
      }
      append(`$ ${[command, ...args].join(' ')}\n`)
      proc.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString()
        append(d.toString())
      })
      proc.stderr?.on('data', (d: Buffer) => append(d.toString()))
      proc.on('error', (err) => {
        append(`${err.message}\n`)
        resolve(stdout)
      })
      proc.on('close', () => resolve(stdout))
    })
  }

  private async root(projectId: string): Promise<string> {
    const configured = this.opts.resolveRoot(projectId)
    if (!configured) throw coded('not-found', `Unknown project: ${projectId}`)
    return realpath(configured)
  }
}

/** The project's own copy of a runner (`node_modules/.bin`; on Windows its `.cmd` shim). */
export function localBin(root: string, name: string, platform: NodeJS.Platform = process.platform): string[] | undefined {
  const bin = join(root, 'node_modules', '.bin', platform === 'win32' ? `${name}.cmd` : name)
  return existsSync(bin) ? [bin] : undefined
}

/** Which test runners a project uses. */
export async function detect(root: string): Promise<TestFramework[]> {
  const found: TestFramework[] = []
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8').catch(() => '{}')) as Record<string, Record<string, string> | undefined>
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const has = (...names: string[]) => names.some((n) => existsSync(join(root, n)))
  if ('vitest' in deps || has('vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs')) found.push('vitest')
  else if ('jest' in deps || has('jest.config.js', 'jest.config.ts', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.json') || (pkg as { jest?: unknown }).jest) found.push('jest')
  const pyproject = await readFile(join(root, 'pyproject.toml'), 'utf8').catch(() => '')
  if (has('pytest.ini', 'conftest.py', 'tox.ini', 'setup.py', 'setup.cfg', 'requirements.txt') || /pytest/.test(pyproject)) found.push('pytest')
  if (has('go.mod')) found.push('go')
  return found
}

/** The module path in go.mod (package names → folders). */
async function goModule(root: string): Promise<string> {
  return /^module\s+(\S+)/m.exec(await readFile(join(root, 'go.mod'), 'utf8').catch(() => ''))?.[1] ?? ''
}
