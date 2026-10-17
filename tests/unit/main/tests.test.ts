import { EventEmitter } from 'node:events'
import { chmod, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { tempDir, tick } from './helpers'

// Folders that can't be read, also when the tests run as root (chmod doesn't stop root).
const unreadable = vi.hoisted(() => new Set<string>())
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const readdir = ((path: string, ...rest: never[]) =>
    unreadable.has(String(path)) ? Promise.reject(Object.assign(new Error(`EACCES: permission denied, scandir '${path}'`), { code: 'EACCES' })) : (real.readdir as (...a: unknown[]) => Promise<unknown>)(path, ...rest)) as typeof real.readdir
  return { ...real, readdir }
})
import { detect, goResults, goTests, jestResults, jsTests, junitResults, localBin, pyTests, TestService, tidyMessage, type TestOptions } from '../../../electron/main/services/tests/TestService'
import type { TestRunState } from '@shared/types/tests'

describe('finding tests without running them', () => {
  it('JS / TS: describe / it / test, nested, with .only / .skip / .each and template names', async () => {
    const text = `import { describe, it, test } from 'vitest'
describe('math', () => {
  it('adds', () => {})
  it.only('multiplies', () => {})
  describe.skip(\`nested\`, () => {
    test.each([1, 2])('param %i', () => {})
  })
})
test.each\`a\${1}\`('tagged', () => {})
it(\`with \${x}\`, () => {})
it(name, () => {})
helpers[0]('not a test', () => {})
other('not a test', () => {})
`
    const items = await jsTests('src/a.test.ts', text, 'vitest')
    expect(items).toEqual([
      {
        id: 'src/a.test.ts::math',
        name: 'math',
        kind: 'suite',
        framework: 'vitest',
        path: 'src/a.test.ts',
        line: 2,
        children: [
          { id: 'src/a.test.ts::math > adds', name: 'adds', kind: 'test', framework: 'vitest', path: 'src/a.test.ts', line: 3 },
          { id: 'src/a.test.ts::math > multiplies', name: 'multiplies', kind: 'test', framework: 'vitest', path: 'src/a.test.ts', line: 4 },
          {
            id: 'src/a.test.ts::math > nested',
            name: 'nested',
            kind: 'suite',
            framework: 'vitest',
            path: 'src/a.test.ts',
            line: 5,
            children: [{ id: 'src/a.test.ts::math > nested > param %i', name: 'param %i', kind: 'test', framework: 'vitest', path: 'src/a.test.ts', line: 6 }]
          }
        ]
      },
      { id: 'src/a.test.ts::tagged', name: 'tagged', kind: 'test', framework: 'vitest', path: 'src/a.test.ts', line: 9 },
      { id: 'src/a.test.ts::with ${x}', name: 'with ${x}', kind: 'test', framework: 'vitest', path: 'src/a.test.ts', line: 10 }
    ])
    // JSX in a .tsx test file parses.
    expect(await jsTests('b.test.tsx', `it('renders', () => <div />)`, 'jest')).toEqual([{ id: 'b.test.tsx::renders', name: 'renders', kind: 'test', framework: 'jest', path: 'b.test.tsx', line: 1 }])
  })

  it('pytest: test functions and Test classes (methods only inside them)', () => {
    const text = `import pytest

def test_one():
    def test_inner():
        pass

class TestGroup:
    def test_a(self):
        pass

    async def test_b(self):
        pass

    def helper(self):
        pass

async def test_two():
    pass
    def test_nested_not_a_test(): pass
`
    expect(pyTests('t/test_x.py', text)).toEqual([
      { id: 't/test_x.py::test_one', name: 'test_one', kind: 'test', framework: 'pytest', path: 't/test_x.py', line: 3 },
      {
        id: 't/test_x.py::TestGroup',
        name: 'TestGroup',
        kind: 'suite',
        framework: 'pytest',
        path: 't/test_x.py',
        line: 7,
        children: [
          { id: 't/test_x.py::TestGroup::test_a', name: 'test_a', kind: 'test', framework: 'pytest', path: 't/test_x.py', line: 8 },
          { id: 't/test_x.py::TestGroup::test_b', name: 'test_b', kind: 'test', framework: 'pytest', path: 't/test_x.py', line: 11 }
        ]
      },
      { id: 't/test_x.py::test_two', name: 'test_two', kind: 'test', framework: 'pytest', path: 't/test_x.py', line: 17 }
    ])
  })

  it('go: TestXxx(t *testing.T) by package folder', () => {
    const text = 'package x\n\nfunc TestA(t *testing.T) {}\nfunc helper() {}\nfunc BenchmarkB(b *testing.B) {}\nfunc TestC( tt  *testing.T ) {}\n'
    expect(goTests('pkg/a_test.go', text)).toEqual([
      { id: 'pkg::TestA', name: 'TestA', kind: 'test', framework: 'go', path: 'pkg/a_test.go', line: 3 },
      { id: 'pkg::TestC', name: 'TestC', kind: 'test', framework: 'go', path: 'pkg/a_test.go', line: 6 }
    ])
    expect(goTests('a_test.go', text)[0].id).toBe('.::TestA')
  })

  it('the project’s own runner: its .cmd shim on Windows', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'node_modules/.bin'), { recursive: true })
    await writeFile(join(root, 'node_modules/.bin/vitest'), '')
    expect(localBin(root, 'vitest', 'darwin')).toEqual([join(root, 'node_modules/.bin/vitest')])
    expect(localBin(root, 'vitest', 'win32')).toBeUndefined()
    await writeFile(join(root, 'node_modules/.bin/vitest.cmd'), '')
    expect(localBin(root, 'vitest', 'win32')).toEqual([join(root, 'node_modules/.bin/vitest.cmd')])
  })

  it('which runners a project uses', async () => {
    const root = await tempDir()
    expect(await detect(root)).toEqual([])
    await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { vitest: '3' } }))
    expect(await detect(root)).toEqual(['vitest'])
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { jest: '29' } }))
    expect(await detect(root)).toEqual(['jest'])
    await writeFile(join(root, 'package.json'), JSON.stringify({ jest: {} }))
    expect(await detect(root)).toEqual(['jest'])
    await writeFile(join(root, 'package.json'), '{}')
    await writeFile(join(root, 'jest.config.js'), '')
    expect(await detect(root)).toEqual(['jest'])
    await writeFile(join(root, 'vitest.config.ts'), '')
    expect(await detect(root)).toEqual(['vitest'])
    await writeFile(join(root, 'pyproject.toml'), '[tool.pytest.ini_options]\n')
    await writeFile(join(root, 'go.mod'), 'module example.com/m\n')
    expect(await detect(root)).toEqual(['vitest', 'pytest', 'go'])
    const py = await tempDir()
    await writeFile(join(py, 'requirements.txt'), '')
    expect(await detect(py)).toEqual(['pytest'])
  })
})

describe('what runners report', () => {
  it('Vitest / Jest JSON: tests by full name, files that failed to load, tidy messages', () => {
    const root = '/p'
    const report = {
      testResults: [
        {
          name: '/p/src/a.test.ts',
          status: 'failed',
          assertionResults: [
            { ancestorTitles: ['math'], title: 'adds', status: 'passed', duration: 3 },
            {
              ancestorTitles: ['math'],
              title: 'fails',
              status: 'failed',
              duration: null,
              failureMessages: ['\u001b[31mAssertionError: nope\u001b[39m\n    at /p/src/a.test.ts:4:5\n    at file:///p/node_modules/vitest/x.js:1:1\n    at node:internal/process:1:1\n    at new Promise (<anonymous>)\n    at file:///p/src/b.ts:2:2']
            },
            { ancestorTitles: [], title: 'later', status: 'pending', failureMessages: [] }
          ]
        },
        { name: '/p/src/broken.test.ts', status: 'failed', message: 'SyntaxError in /p/src/broken.test.ts', assertionResults: [] },
        { name: '/p/src/empty.test.ts', status: 'failed' },
        { name: '/p/src/ok.test.ts', status: 'passed' }
      ]
    }
    expect(jestResults(root, report)).toEqual({
      'src/a.test.ts::math > adds': { state: 'passed', durationMs: 3, message: undefined },
      'src/a.test.ts::math > fails': { state: 'failed', durationMs: undefined, message: 'AssertionError: nope\n    at src/a.test.ts:4:5\n    at src/b.ts:2:2' },
      'src/a.test.ts::later': { state: 'skipped', durationMs: undefined, message: undefined },
      'src/broken.test.ts': { state: 'failed', message: 'SyntaxError in src/broken.test.ts' },
      'src/empty.test.ts': { state: 'failed', message: undefined }
    })
    expect(jestResults(root, {})).toEqual({})
    expect(tidyMessage('/r', '  plain\n')).toBe('plain')
  })

  it('pytest JUnit XML: classes, failures, errors, skips; parameters merge (the worst counts)', () => {
    const xml = `<?xml version="1.0"?><testsuites><testsuite>
<testcase classname="tests.test_calc" file="tests/test_calc.py" name="test_add" time="0.001" />
<testcase classname="tests.test_calc" file="tests/test_calc.py" name="test_fail" time="0.002"><failure message="assert 3 == 4">def test_fail():
&gt;  assert add(1, 2) == 4 &amp;&amp; &quot;x&quot; &#39;y&#39; &apos;z&apos; &lt;</failure></testcase>
<testcase classname="tests.test_calc" file="tests/test_calc.py" name="test_err" time="0"><error message="fixture missing" /></testcase>
<testcase classname="tests.test_calc" file="tests/test_calc.py" name="test_bodyonly" time="0"><failure>just a body</failure></testcase>
<testcase classname="tests.test_calc" file="tests/test_calc.py" name="test_skip" time="0"><skipped message="later" /></testcase>
<testcase classname="tests.test_calc.TestGroup" file="tests/test_calc.py" name="test_param[1]" time="0.5" />
<testcase classname="tests.test_calc.TestGroup" file="tests/test_calc.py" name="test_param[2]" time="0.25"><failure message="bad" /></testcase>
<testcase classname="tests.test_calc.TestGroup" file="tests/test_calc.py" name="test_param[3]" time="0.25" />
<testcase classname="tests.test_calc.TestGroup" file="tests/test_calc.py" name="test_zero[a]" time="0" />
<testcase classname="tests.test_calc.TestGroup" file="tests/test_calc.py" name="test_zero[b]" time="0" />
<testcase name="bare" />
</testsuite></testsuites>`
    expect(junitResults(xml)).toEqual({
      'tests/test_calc.py::test_add': { state: 'passed', durationMs: 1, message: undefined },
      'tests/test_calc.py::test_fail': { state: 'failed', durationMs: 2, message: 'assert 3 == 4\ndef test_fail():\n>  assert add(1, 2) == 4 && "x" \'y\' \'z\' <' },
      'tests/test_calc.py::test_err': { state: 'failed', durationMs: 0, message: 'fixture missing' },
      'tests/test_calc.py::test_bodyonly': { state: 'failed', durationMs: 0, message: 'just a body' },
      'tests/test_calc.py::test_skip': { state: 'skipped', durationMs: 0, message: undefined },
      'tests/test_calc.py::TestGroup::test_param': { state: 'failed', durationMs: 1000, message: 'bad' },
      'tests/test_calc.py::TestGroup::test_zero': { state: 'passed', durationMs: 0, message: undefined },
      '::bare': { state: 'passed', durationMs: 0, message: undefined }
    })
  })

  it('go test -json: by package folder; subtests count for their test; output explains failures', () => {
    const lines = [
      'not json',
      JSON.stringify({ Action: 'start', Package: 'example.com/m' }),
      JSON.stringify({ Action: 'run', Package: 'example.com/m', Test: 'TestA' }),
      JSON.stringify({ Action: 'output', Package: 'example.com/m', Test: 'TestA', Output: '--- FAIL: TestA\n' }),
      JSON.stringify({ Action: 'output', Package: 'example.com/m', Test: 'TestA/sub', Output: '    a_test.go:5: want 1\n' }),
      JSON.stringify({ Action: 'output', Package: 'example.com/m', Test: 'TestA' }),
      JSON.stringify({ Package: 'example.com/m', Test: 'TestA' }),
      JSON.stringify({ Action: 'fail', Package: 'example.com/m', Test: 'TestA/sub', Elapsed: 0.01 }),
      JSON.stringify({ Action: 'fail', Package: 'example.com/m', Test: 'TestA', Elapsed: 0.02 }),
      JSON.stringify({ Action: 'pass', Package: 'example.com/m/pkg', Test: 'TestB' }),
      JSON.stringify({ Action: 'skip', Package: 'other.org/x', Test: 'TestC', Elapsed: 0 })
    ].join('\n')
    expect(goResults(lines, 'example.com/m')).toEqual({
      '.::TestA': { state: 'failed', durationMs: 30, message: '--- FAIL: TestA\n    a_test.go:5: want 1' },
      'pkg::TestB': { state: 'passed', durationMs: 0, message: undefined },
      'other.org/x::TestC': { state: 'skipped', durationMs: 0, message: undefined }
    })
  })
})

/** A stand-in runner: prints, writes the report the real one would, then closes. */
class FakeProc extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = 0
  kill() {
    this.killed += 1
    this.emit('close', null)
    return true
  }
}

function harness(root: string | undefined, behave: (command: string, args: string[], proc: FakeProc) => Promise<void> | void = (_c, _a, p) => void setTimeout(() => p.emit('close', 0))) {
  const published: TestRunState[] = []
  const calls: { command: string; args: string[]; cwd: string }[] = []
  const debugged: unknown[] = []
  const procs: FakeProc[] = []
  const opts: TestOptions = {
    resolveRoot: () => root,
    publish: (s) => published.push(s),
    start: (command, args, cwd) => {
      calls.push({ command, args, cwd })
      const proc = new FakeProc()
      procs.push(proc)
      setTimeout(() => void behave(command, args, proc))
      return proc as never
    },
    debug: async (req) => (debugged.push(req), { id: 's', projectId: req.projectId, program: req.program, status: 'starting', frames: [] })
  }
  return { service: new TestService(opts), opts, published, calls, debugged, procs }
}

/** Where the runner was told to write its report. */
const reportOf = (args: string[]) => {
  const arg = args.find((a) => /^--(outputFile(\.json)?|junitxml)=/.test(a))!
  return arg.slice(arg.indexOf('=') + 1)
}

async function project() {
  const root = await realpath(await tempDir())
  await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { vitest: '3' } }))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/a.test.ts'), `describe('math', () => {\n  it('adds', () => {})\n  it('fails', () => {})\n})\nit('top', () => {})\n`)
  await writeFile(join(root, 'src/none.test.ts'), `// nothing yet\n`)
  await writeFile(join(root, 'src/app.ts'), '')
  await writeFile(join(root, 'pytest.ini'), '')
  await mkdir(join(root, 'tests'))
  await writeFile(join(root, 'tests/test_x.py'), 'def test_x():\n    pass\n')
  await writeFile(join(root, 'main_test.go'), 'func TestGo(t *testing.T) {}\n') // no go.mod: not a go project
  for (const dir of ['node_modules/pkg', '.hidden', 'dist']) {
    await mkdir(join(root, dir), { recursive: true })
    await writeFile(join(root, dir, 'x.test.ts'), `it('ignored', () => {})`)
  }
  return root
}

describe('TestService', () => {
  it('finds the tests by file, skipping dependencies, build output and hidden folders', async () => {
    const root = await project()
    const { service } = harness(root)
    const items = await service.discover('p')
    expect(items.map((i) => [i.id, i.framework, i.children!.length])).toEqual([
      ['src/a.test.ts', 'vitest', 2],
      ['tests/test_x.py', 'pytest', 1]
    ])
    expect(service.state('p')).toEqual({ projectId: 'p', running: false, results: {}, output: '' })
    // Found again: the last run stays.
    expect(await service.discover('p')).toEqual(items)
    expect(service.state('other')).toEqual({ projectId: 'other', running: false, results: {}, output: '' })
    await expect(harness(undefined).service.discover('p')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('an unreadable folder is passed over; at most 3000 test files', { timeout: 30_000 }, async () => {
    const root = await realpath(await tempDir())
    await writeFile(join(root, 'go.mod'), 'module m\n')
    await mkdir(join(root, 'locked'))
    await writeFile(join(root, 'locked/a_test.go'), 'func TestA(t *testing.T) {}\n')
    unreadable.add(join(root, 'locked'))
    await mkdir(join(root, 'many'))
    await Promise.all(Array.from({ length: 3001 }, (_, i) => writeFile(join(root, 'many', `t${i}_test.go`), `func TestN${i}(t *testing.T) {}\n`)))
    try {
      const items = await harness(root).service.discover('p')
      expect(items).toHaveLength(3000)
      expect(items.every((i) => i.path.startsWith('many/'))).toBe(true)
    } finally {
      unreadable.clear()
    }
  })

  it('runs everything: each runner with its report; tests it never reported settle as skipped', async () => {
    const root = await project()
    await mkdir(join(root, 'node_modules/.bin'), { recursive: true })
    await writeFile(join(root, 'node_modules/.bin/vitest'), '')
    const h = harness(root, async (command, args, proc) => {
      proc.stdout.write('running\n')
      proc.stderr.write('warn\n')
      if (command.endsWith('vitest')) {
        await writeFile(
          reportOf(args),
          JSON.stringify({
            testResults: [
              {
                name: join(root, 'src/a.test.ts'),
                assertionResults: [
                  { ancestorTitles: ['math'], title: 'adds', status: 'passed', duration: 1 },
                  { ancestorTitles: ['math'], title: 'fails', status: 'failed', failureMessages: ['nope'] }
                ]
              }
            ]
          })
        )
      } else {
        await writeFile(reportOf(args), '<testsuite><testcase classname="tests.test_x" file="tests/test_x.py" name="test_x" time="0.1" /></testsuite>')
      }
      proc.emit('close', 0)
    })
    const state = await h.service.run('p')
    expect(h.calls.map((c) => [c.command, ...c.args.map((a) => a.replace(/=.*report$/, '=REPORT'))])).toEqual([
      [join(root, 'node_modules/.bin/vitest'), 'run', '--reporter=default', '--reporter=json', '--outputFile.json=REPORT'],
      ['python3', '-m', 'pytest', '-p', 'no:cacheprovider', '-o', 'junit_family=xunit1', '--junitxml=REPORT']
    ])
    expect(h.calls[0].cwd).toBe(root)
    expect(state.running).toBe(false)
    expect(state.results).toEqual({
      'src/a.test.ts::math > adds': { state: 'passed', durationMs: 1, message: undefined },
      'src/a.test.ts::math > fails': { state: 'failed', durationMs: undefined, message: 'nope' },
      'src/a.test.ts::top': { state: 'skipped' },
      'tests/test_x.py::test_x': { state: 'passed', durationMs: 100, message: undefined }
    })
    expect(state.output).toContain('running\nwarn\n')
    // First published: everything running.
    expect(h.published[0]).toMatchObject({ running: true, results: { 'src/a.test.ts::top': { state: 'running' } } })
  })

  it('runs one test, suite or file with a name filter; the rest keep their last result', async () => {
    const root = await project()
    let report: unknown = {}
    const h = harness(root, async (_c, args, proc) => {
      await writeFile(reportOf(args), JSON.stringify(report))
      proc.emit('close', 1)
    })
    await h.service.discover('p')
    report = {
      testResults: [
        {
          name: join(root, 'src/a.test.ts'),
          assertionResults: [
            { ancestorTitles: ['math'], title: 'adds', status: 'passed' },
            { ancestorTitles: ['math'], title: 'fails', status: 'failed' },
            { ancestorTitles: [], title: 'top', status: 'passed' }
          ]
        }
      ]
    }
    await h.service.run('p', 'src/a.test.ts')
    // A single test: the others come back "skipped" from the runner, but they weren't asked for.
    report = {
      testResults: [
        {
          name: join(root, 'src/a.test.ts'),
          assertionResults: [
            { ancestorTitles: ['math'], title: 'adds', status: 'skipped' },
            { ancestorTitles: ['math'], title: 'fails', status: 'passed' },
            { ancestorTitles: [], title: 'top', status: 'skipped' }
          ]
        }
      ]
    }
    const state = await h.service.run('p', 'src/a.test.ts::math > fails')
    expect(Object.fromEntries(Object.entries(state.results).map(([k, v]) => [k, v.state]))).toEqual({
      'src/a.test.ts::math > adds': 'passed',
      'src/a.test.ts::math > fails': 'passed',
      'src/a.test.ts::top': 'passed'
    })
    await h.service.run('p', 'src/a.test.ts::math')
    const args = h.calls.map((c) => c.args.slice(c.args.findIndex((a) => a.startsWith('--outputFile')) + 1))
    expect(args).toEqual([['src/a.test.ts'], ['src/a.test.ts', '-t', '^math fails$'], ['src/a.test.ts', '-t', '^math ']])
    // Without the runner installed in the project, npx (no installs) runs it.
    expect(h.calls[0].command).toBe('npx')
    expect(h.calls[0].args.slice(0, 2)).toEqual(['--no-install', 'vitest'])
  })

  it('a file that failed to load is cleared by the next run of it', async () => {
    const root = await project()
    let report: unknown = { testResults: [{ name: join(root, 'src/a.test.ts'), status: 'failed', message: 'SyntaxError' }] }
    const h = harness(root, async (_c, args, proc) => {
      await writeFile(reportOf(args), JSON.stringify(report))
      proc.emit('close', 1)
    })
    expect((await h.service.run('p', 'src/a.test.ts')).results['src/a.test.ts']).toEqual({ state: 'failed', message: 'SyntaxError' })
    report = { testResults: [] }
    expect((await h.service.run('p', 'src/a.test.ts')).results).not.toHaveProperty(['src/a.test.ts'])
  })

  it('jest and pytest targets; a runner that writes no report or cannot start', async () => {
    const root = await realpath(await tempDir())
    await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { jest: '29' } }))
    await writeFile(join(root, 'conftest.py'), '')
    await writeFile(join(root, 's.test.js'), `describe('s', () => { test('a', () => {}) })`)
    await writeFile(join(root, 'test_y.py'), 'class TestK:\n    def test_k(self):\n        pass\n')
    await mkdir(join(root, '.venv/bin'), { recursive: true })
    await writeFile(join(root, '.venv/bin/python'), '')
    const h = harness(root, (command, _args, proc) => {
      if (command === 'npx') proc.emit('error', new Error('spawn npx ENOENT'))
      else proc.emit('close', 0)
    })
    const state = await h.service.run('p', 's.test.js::s > a')
    expect(h.calls[0].args.map((a) => a.replace(/=.*report$/, '=REPORT'))).toEqual(['--no-install', 'jest', '--json', '--outputFile=REPORT', 's.test.js', '-t', '^s a$'])
    expect(state.results['s.test.js::s > a']).toEqual({ state: 'skipped' })
    expect(state.output).toContain('spawn npx ENOENT')
    await h.service.run('p', 'test_y.py::TestK')
    expect([h.calls[1].command, h.calls[1].args[2]]).toEqual([join(root, '.venv/bin/python'), 'test_y.py::TestK'])
  })

  it('go: a package, a file, one test', async () => {
    const root = await realpath(await tempDir())
    await writeFile(join(root, 'go.mod'), 'module example.com/m\n')
    await writeFile(join(root, 'a_test.go'), 'func TestA(t *testing.T) {}\nfunc TestB(t *testing.T) {}\n')
    await mkdir(join(root, 'pkg'))
    await writeFile(join(root, 'pkg/c_test.go'), 'func TestC(t *testing.T) {}\n')
    await writeFile(join(root, 'test_q.py'), 'def test_q():\n    pass\n') // no pytest in this project: not listed
    const h = harness(root, (_c, _a, proc) => {
      proc.stdout.write(JSON.stringify({ Action: 'pass', Package: 'example.com/m/pkg', Test: 'TestC', Elapsed: 0.001 }) + '\n')
      setTimeout(() => proc.emit('close', 0))
    })
    expect((await h.service.run('p')).results['pkg::TestC']).toEqual({ state: 'passed', durationMs: 1, message: undefined })
    await h.service.run('p', 'a_test.go')
    await h.service.run('p', 'pkg/c_test.go')
    await h.service.run('p', 'pkg::TestC')
    expect(h.calls.map((c) => [c.command, ...c.args])).toEqual([
      ['go', 'test', '-json', './...'],
      ['go', 'test', '-json', '-run', '^(TestA|TestB)$', './.'],
      ['go', 'test', '-json', '-run', '^(TestC)$', './pkg'],
      ['go', 'test', '-json', '-run', '^TestC$', './pkg']
    ])
    // A go.mod without a module line still reads; one that can't be read is no module either.
    await writeFile(join(root, 'go.mod'), '')
    expect((await h.service.run('p', 'pkg::TestC')).results['pkg::TestC'].state).toBe('skipped')
    await rm(join(root, 'go.mod'))
    await mkdir(join(root, 'go.mod'))
    expect((await h.service.run('p', 'pkg::TestC')).results['pkg::TestC'].state).toBe('skipped')
  })

  it('without a stand-in, the runner starts through the user’s shell', { timeout: 30_000 }, async () => {
    const root = await realpath(await tempDir())
    await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { vitest: '3' } }))
    await writeFile(join(root, 'a.test.ts'), `it('t', () => {})`)
    await mkdir(join(root, 'node_modules/.bin'), { recursive: true })
    await writeFile(join(root, 'node_modules/.bin/vitest'), '#!/bin/sh\necho "ran $1"\n')
    await chmod(join(root, 'node_modules/.bin/vitest'), 0o755)
    const service = new TestService({ resolveRoot: () => root, publish: () => {} })
    const state = await service.run('p')
    expect(state.output).toContain('ran run')
    expect(state.results['a.test.ts::t']).toEqual({ state: 'skipped' })
  })

  it('one run at a time; cancel stops it; unknown tests; the output keeps its end', async () => {
    const root = await project()
    const h = harness(root, (_c, _a, proc) => {
      proc.stdout.write('x'.repeat(250_000))
    })
    await expect(h.service.run('p', 'nope')).rejects.toMatchObject({ code: 'not-found' })
    const running = h.service.run('p', 'src/a.test.ts')
    // Running, with more output than is kept.
    while (h.service.state('p').output.length < 200_000) await tick(5)
    await expect(h.service.run('p')).rejects.toMatchObject({ code: 'busy' })
    h.service.cancel('p')
    h.service.cancel('other')
    const state = await running
    expect(h.procs[0].killed).toBe(1)
    expect(state.output.length).toBe(200_000)
  })

  it('debugs a test with Mindeck’s debugger, per runner', async () => {
    const root = await realpath(await tempDir())
    await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { vitest: '3' } }))
    await writeFile(join(root, 'a.test.ts'), `describe('s', () => { it('t', () => {}) })`)
    const bps = [{ path: 'a.test.ts', line: 1 }]
    const h = harness(root)
    await h.service.debug('p', 'a.test.ts::s > t', bps)
    await h.service.debug('p', 'a.test.ts', [])
    expect(h.debugged).toEqual([
      {
        projectId: 'p',
        breakpoints: bps,
        program: 'node_modules/vitest/vitest.mjs',
        args: ['run', 'a.test.ts', '-t', '^s t$', '--inspect-brk=127.0.0.1:0', '--no-file-parallelism', '--test-timeout=0'],
        inspectChild: true
      },
      { projectId: 'p', breakpoints: [], program: 'node_modules/vitest/vitest.mjs', args: ['run', 'a.test.ts', '--inspect-brk=127.0.0.1:0', '--no-file-parallelism', '--test-timeout=0'], inspectChild: true }
    ])
    await expect(h.service.debug('p', 'nope', [])).rejects.toMatchObject({ code: 'not-found' })
    await expect(new TestService({ ...h.opts, debug: undefined }).debug('p', 'a.test.ts', [])).rejects.toMatchObject({ code: 'unsupported' })

    await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { jest: '29' } }))
    await writeFile(join(root, 'go.mod'), 'module m\n')
    await writeFile(join(root, 'requirements.txt'), '')
    await writeFile(join(root, 'test_p.py'), 'def test_p():\n    pass\n')
    await writeFile(join(root, 'x_test.go'), 'func TestX(t *testing.T) {}\n')
    const j = harness(root)
    await j.service.debug('p', 'a.test.ts::s', [])
    await j.service.debug('p', 'test_p.py::test_p', [])
    await j.service.debug('p', '.::TestX', [])
    await j.service.debug('p', 'x_test.go', [])
    expect(j.debugged).toEqual([
      { projectId: 'p', breakpoints: [], program: 'node_modules/jest/bin/jest.js', args: ['--runInBand', 'a.test.ts', '-t', '^s ', '--testTimeout=999999999'] },
      { projectId: 'p', breakpoints: [], program: 'test_p.py', module: 'pytest', args: ['test_p.py::test_p', '-p', 'no:cacheprovider'] },
      { projectId: 'p', breakpoints: [], program: 'x_test.go', goTest: true, args: ['-test.run', '^TestX$'] },
      { projectId: 'p', breakpoints: [], program: 'x_test.go', goTest: true, args: [] }
    ])
  })
})
