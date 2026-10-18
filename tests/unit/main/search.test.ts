import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir, tick } from './helpers'
import type { SearchProgress, TextSearchQuery } from '@shared/types/search'
import {
  applyReplacements,
  expandGlobs,
  expandReplacement,
  matchLine,
  matchText,
  previewOf,
  replacementsFor,
  searchRegExp,
  splitGlobs,
  textLines
} from '@shared/types/search'

// Folders and files the "disk" refuses (as root, chmod can't make that happen).
const fsFail = vi.hoisted(() => ({ paths: new Set<string>() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const wrap =
    <A extends unknown[], R>(fn: (p: string, ...a: A) => Promise<R>) =>
    (p: string, ...a: A): Promise<R> =>
      fsFail.paths.has(String(p)) ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })) : fn(p, ...a)
  return { ...real, readdir: wrap(real.readdir as never), stat: wrap(real.stat as never) }
})

import { findRipgrep, rgPath, ripgrepArgs, SEARCH_LIMITS, SearchService } from '../../../electron/main/services/search/SearchService'
import { registerSearchIpc } from '../../../electron/ipc/search.ipc'
import { Router } from '../../../electron/ipc/router'

const q = (pattern: string, more: Partial<TextSearchQuery> = {}): TextSearchQuery => ({ pattern, ...more })

describe('search text helpers', () => {
  it('builds the regex: literal, regex, case, whole word; bad patterns throw', () => {
    expect(searchRegExp(q('a.b')).test('axb')).toBe(false)
    expect(searchRegExp(q('a.b')).flags).toBe('gi')
    expect(searchRegExp(q('a.b', { regex: true })).test('axb')).toBe(true)
    expect(searchRegExp(q('A', { caseSensitive: true })).flags).toBe('g')
    expect(searchRegExp(q('cat', { wholeWord: true })).test('concat')).toBe(false)
    expect(searchRegExp(q('cat', { wholeWord: true }), 'y').flags).toBe('iy')
    expect(() => searchRegExp(q('(', { regex: true }))).toThrow(SyntaxError)
  })

  it('reads globs like VS Code: folders anywhere, anchored paths, braces', () => {
    expect(expandGlobs(['src', './lib/', 'a/b', '*.ts', 'x/**', ' '])).toEqual(['src', '**/src/**', 'lib', '**/lib/**', 'a/b', 'a/b/**', '*.ts', '**/*.ts/**', 'x/**'])
    expect(expandGlobs()).toEqual([])
    expect(splitGlobs(' *.{ts,tsx}, src ,, {a}}, b')).toEqual(['*.{ts,tsx}', 'src', '{a}}', 'b'])
  })

  it('previews a match with some context, capped', () => {
    expect(previewOf('  const x = 1', 8, 1)).toEqual({ before: 'const ', text: 'x', after: ' = 1' })
    const long = `${'a'.repeat(100)}MATCH${'b'.repeat(400)}`
    const p = previewOf(long, 100, 5)
    expect(p.before).toBe(`…${'a'.repeat(40)}`)
    expect(p.text).toBe('MATCH')
    expect(p.after.endsWith('…')).toBe(true)
    expect(p.before.length + p.text.length + p.after.length).toBe(251)
  })

  it('splits lines like ripgrep and Monaco, and finds every match (empty ones too)', () => {
    expect(textLines('﻿a\r\nb\nc')).toEqual(['a', 'b', 'c'])
    expect(matchLine(/a/g, 'banana', 3).map((m) => [m.line, m.column, m.length])).toEqual([
      [3, 1, 1],
      [3, 3, 1],
      [3, 5, 1]
    ])
    expect(matchLine(/^/g, 'xy', 1)).toHaveLength(1)
    expect(matchLine(/a/g, 'aaaa', 1, 2)).toHaveLength(2)
    expect(matchText(/o/g, 'foo\nbar\nboo', 3).map((m) => m.line)).toEqual([1, 1, 3])
  })

  it('expands replacements: groups, names, escapes — literally without regex', () => {
    const m = /(?<word>a)(b)?(c)/.exec('ac')!
    expect(expandReplacement(m, '[$1|$2|$3|$&|$$|$<word>|$<nope>|$0|$9|$]', true)).toBe('[a||c|ac|$|a|$<nope>|$0|$9|$]')
    expect(expandReplacement(m, '\\n\\t\\\\\\x', true)).toBe('\n\t\\\\x')
    expect(expandReplacement(m, '$1\\n', false)).toBe('$1\\n')
    const many = /(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)/.exec('abcdefghijk')!
    expect(expandReplacement(many, '$11-$10-$1x', true)).toBe('k-j-ax')
    const few = /(a)/.exec('a')!
    expect(expandReplacement(few, '$10', true)).toBe('a0')
    const unnamed = /(a)/.exec('a')!
    expect(expandReplacement(unnamed, '$<x>', true)).toBe('$<x>')
    const optional = /(?<o>z)?a/.exec('a')!
    expect(expandReplacement(optional, '[$<o>]', true)).toBe('[]')
  })

  it('replaces at the matches that are still there, keeping line breaks and the BOM', () => {
    const text = '﻿foo foo\r\nbar\nfoo'
    const re = searchRegExp(q('(f)oo', { regex: true }))
    const matches = [
      { line: 1, column: 0, length: 3 },
      { line: 1, column: 4, length: 3 },
      { line: 2, column: 0, length: 3 }, // not a match any more
      { line: 3, column: 0, length: 2 }, // length changed
      { line: 9, column: 0, length: 3 } // no such line
    ]
    const reps = replacementsFor(text, matches, re, '$1u', true)
    expect(reps).toEqual([
      { line: 1, column: 0, length: 3, text: 'fu' },
      { line: 1, column: 4, length: 3, text: 'fu' }
    ])
    expect(applyReplacements(text, reps)).toBe('﻿fu fu\r\nbar\nfoo')
    // Overlaps, out-of-range lines and columns are skipped.
    expect(
      applyReplacements('abcdef', [
        { line: 1, column: 0, length: 3, text: 'X' },
        { line: 1, column: 2, length: 2, text: 'Y' },
        { line: 1, column: 5, length: 9, text: 'Z' },
        { line: 4, column: 0, length: 1, text: 'W' }
      ])
    ).toBe('abYef')
    expect(applyReplacements('a\nb', [{ line: 2, column: 0, length: 1, text: 'B\nC' }])).toBe('a\nB\nC')
  })
})

describe('finding ripgrep', () => {
  it('on PATH, in the usual places, or not at all; rg.exe on Windows', async () => {
    const dir = await tempDir()
    expect(await findRipgrep(dir, 'win32')).toBeNull()
    await writeFile(join(dir, 'rg.exe'), '')
    await chmod(join(dir, 'rg.exe'), 0o755)
    expect(await findRipgrep(`${dir}`, 'win32')).toBe(join(dir, 'rg.exe'))
    await writeFile(join(dir, 'rg'), '')
    expect(await findRipgrep(`${dir}`, 'linux')).not.toBe(join(dir, 'rg')) // not executable
    await chmod(join(dir, 'rg'), 0o755)
    expect(await findRipgrep(`:${dir}`, 'linux')).toBe(join(dir, 'rg'))
    // The default: the process's PATH (also when there is none).
    const path = process.env.PATH
    delete process.env.PATH
    try {
      expect(await findRipgrep()).toBe(['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg'].find((p) => existsSync(p)) ?? null)
    } finally {
      process.env.PATH = path
    }
  })

  it('its paths, relative and with / — also from the Windows build (.\\src\\a.ts)', () => {
    expect(rgPath('./src/a.ts', false)).toBe('src/a.ts')
    expect(rgPath('.\\src\\a.ts', true)).toBe('src/a.ts')
    expect(rgPath('src\\a.ts', true)).toBe('src/a.ts')
    expect(rgPath('odd\\name.ts', false)).toBe('odd\\name.ts') // a backslash is part of a POSIX file name
    expect(rgPath('./a.ts')).toBe('a.ts') // this platform's default
  })

  it('its command line', () => {
    const args = ripgrepArgs(q('x', { regex: true, wholeWord: true, caseSensitive: true, include: ['src'], exclude: ['*.md'] }), SEARCH_LIMITS)
    expect(args).toEqual([
      '--json',
      '--no-config',
      '--hidden',
      '--no-require-git',
      '--glob',
      '!.git',
      '--max-count',
      '1000',
      '--case-sensitive',
      '--engine',
      'auto',
      '--word-regexp',
      '--glob',
      'src',
      '--glob',
      '**/src/**',
      '--glob',
      '!*.md',
      '--glob',
      '!**/*.md/**',
      '-e',
      'x',
      '--',
      '.'
    ])
    expect(ripgrepArgs(q('-x'), SEARCH_LIMITS)).toEqual(expect.arrayContaining(['--ignore-case', '--fixed-strings', '-e', '-x']))
  })
})

/** A service with recorded progress; `results()` waits for the last batch. */
function harness(root: string | undefined, opts: { ripgrep?: string | null; limits?: Partial<typeof SEARCH_LIMITS> } = {}) {
  const events: SearchProgress[] = []
  const service = new SearchService({ resolveRoot: () => root, publish: (p) => events.push(p), ripgrep: opts.ripgrep === undefined ? null : opts.ripgrep, limits: { batchMs: 5, ...opts.limits } })
  const done = async (id: string) => {
    for (let i = 0; i < 400 && !events.some((e) => e.id === id && e.done); i += 1) await tick(5)
    const mine = events.filter((e) => e.id === id)
    const last = mine[mine.length - 1]
    const files = new Map<string, string[]>()
    for (const e of mine) for (const f of e.files) files.set(f.path, [...(files.get(f.path) ?? []), ...f.matches.map((m) => `${m.line}:${m.column}:${m.length}`)])
    return { files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b))), last, batches: mine.length }
  }
  const search = async (query: TextSearchQuery, id = 's1') => {
    await service.start(id, 'p', query)
    return done(id)
  }
  return { service, events, search, done }
}

/** A project: .gitignore files at two levels, hidden files, a binary, a symlink, a .git folder. */
async function project(): Promise<string> {
  const root = await tempDir('mindeck-search-')
  await mkdir(join(root, 'src', 'deep'), { recursive: true })
  await mkdir(join(root, 'build'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(join(root, '.config'), { recursive: true })
  await writeFile(join(root, '.gitignore'), 'build/\n*.log\n')
  await writeFile(join(root, 'src', '.gitignore'), 'secret.ts\n!keep.log\n')
  await writeFile(join(root, 'src', 'a.ts'), 'const needle = 1\nneedle needle\n')
  await writeFile(join(root, 'src', 'deep', 'b.md'), 'a Needle here\n')
  await writeFile(join(root, 'src', 'secret.ts'), 'needle\n')
  await writeFile(join(root, 'src', 'keep.log'), 'needle\n')
  await writeFile(join(root, 'top.log'), 'needle\n')
  await writeFile(join(root, 'build', 'out.js'), 'needle\n')
  await writeFile(join(root, '.git', 'HEAD'), 'needle\n')
  await writeFile(join(root, '.config', 'x.json'), '{"needle": true}\n')
  await writeFile(join(root, 'bin.dat'), Buffer.from([110, 101, 101, 100, 108, 101, 0, 1]))
  await symlink(join(root, 'src', 'a.ts'), join(root, 'link.ts'))
  return root
}

describe('SearchService: the built-in engine', () => {
  it('walks like ripgrep: nested .gitignore (with negation), hidden files, no binaries, symlinks or .git', async () => {
    const { search } = harness(await project())
    const { files, last } = await search(q('needle'))
    expect(files).toEqual({
      '.config/x.json': ['1:2:6'],
      'src/a.ts': ['1:6:6', '2:0:6', '2:7:6'],
      'src/deep/b.md': ['1:2:6'],
      'src/keep.log': ['1:0:6']
    })
    expect(last.done).toBe(true)
    expect(last.truncated).toBeUndefined()
  })

  it('case, whole word, regex, include / exclude globs, skipped paths, previews', async () => {
    const root = await project()
    const { search, events } = harness(root)
    expect((await search(q('Needle', { caseSensitive: true }), 'a')).files).toEqual({ 'src/deep/b.md': ['1:2:6'] })
    await writeFile(join(root, 'src', 'w.ts'), 'needles needle\n')
    expect((await search(q('needle', { wholeWord: true, include: ['src/w.ts'] }), 'b')).files).toEqual({ 'src/w.ts': ['1:8:6'] })
    expect((await search(q('ne+dle\\b', { regex: true, include: ['*.ts'], exclude: ['deep', 'w.ts'] }), 'c')).files).toEqual({ 'src/a.ts': ['1:6:6', '2:0:6', '2:7:6'] })
    expect(Object.keys((await search(q('needle', { exclude: ['src'], skip: ['.config/x.json'] }), 'd')).files)).toEqual([])
    const a = events.find((e) => e.id === 'c' && e.files.length)!.files[0].matches[0]
    expect(a).toEqual({ line: 1, column: 6, length: 6, before: 'const ', text: 'needle', after: ' = 1' })
  })

  it('stops at the limits: matches (truncated), lines per file, files, file size', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'a.txt'), 'x x x\nx\nx\n')
    await writeFile(join(root, 'b.txt'), 'x\n')
    await writeFile(join(root, 'c.txt'), `${'x'.repeat(100)}\n`)
    const capped = await harness(root, { limits: { matches: 4 } }).search(q('x'))
    expect(capped.files).toEqual({ 'a.txt': ['1:0:1', '1:2:1', '1:4:1', '2:0:1'] })
    expect(capped.last.truncated).toBe(true)
    expect((await harness(root, { limits: { perFile: 2 } }).search(q('x'))).files['a.txt']).toEqual(['1:0:1', '1:2:1', '1:4:1', '2:0:1'])
    const files = await harness(root, { limits: { files: 1 } }).search(q('x'))
    expect(Object.keys(files.files)).toEqual(['a.txt'])
    expect(files.last.truncated).toBe(true)
    expect(Object.keys((await harness(root, { limits: { fileSize: 50 } }).search(q('x'))).files)).toEqual(['a.txt', 'b.txt'])
    // The file limit, reached in a sub-folder, ends the whole walk.
    await mkdir(join(root, 'a-dir'))
    await writeFile(join(root, 'a-dir', 'one.txt'), 'x\n')
    await writeFile(join(root, 'a-dir', 'two.txt'), 'x\n')
    expect(Object.keys((await harness(root, { limits: { files: 1 } }).search(q('x'))).files)).toEqual(['a-dir/one.txt'])
  })

  it('a runaway regex ends the search with an error instead of freezing the core', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'evil.txt'), `${'a'.repeat(40)}b\n`)
    const { last } = await harness(root, { limits: { regexMs: 50 } }).search(q('(a+)+$', { regex: true }))
    expect(last).toMatchObject({ done: true, error: 'The search pattern takes too long on evil.txt' })
  })

  it('skips what it cannot read, FIFOs and files that vanish; cancels; refuses bad input', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'locked'))
    await writeFile(join(root, 'locked', 'x.txt'), 'x\n')
    await writeFile(join(root, 'gone.txt'), 'x\n')
    await writeFile(join(root, 'ok.txt'), 'x\n')
    execFileSync('mkfifo', [join(root, 'pipe')])
    fsFail.paths.add(join(root, 'locked'))
    fsFail.paths.add(join(root, 'gone.txt'))
    try {
      const { files } = await harness(root).search(q('x'))
      expect(Object.keys(files)).toEqual(['ok.txt'])
    } finally {
      fsFail.paths.clear()
    }

    const { service, events, done } = harness(root)
    await service.start('c', 'p', q('x'))
    service.cancel('c')
    service.cancel('c') // twice is fine
    await tick(50)
    expect(events.filter((e) => e.id === 'c')).toEqual([])

    await service.start('d', 'p', q('x'))
    await service.start('d', 'p', q('x')) // the same id again: the first run stops
    expect((await done('d')).last.done).toBe(true)
    await service.start('e', 'p', q('x'))
    service.dispose()
    await tick(50)
    expect(events.filter((e) => e.id === 'e')).toEqual([])

    await expect(harness(undefined).service.start('x', 'p', q('x'))).rejects.toMatchObject({ code: 'not-found' })
    await expect(harness(root).service.start('x', 'p', q('(', { regex: true }))).rejects.toMatchObject({ code: 'bad-input' })
  })
})

/** A stand-in ripgrep: prints the given lines (and records its arguments). */
async function fakeRg(spec: { stdout: string[]; stderr?: string; code?: number; hang?: boolean; pauseMs?: number }): Promise<{ bin: string; args: () => string[] }> {
  const dir = await tempDir('mindeck-rg-')
  const bin = join(dir, 'rg')
  await writeFile(join(dir, 'spec.json'), JSON.stringify(spec))
  await writeFile(
    bin,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs'), path = require('path')",
      "const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'spec.json'), 'utf8'))",
      "fs.writeFileSync(path.join(__dirname, 'args.json'), JSON.stringify(process.argv.slice(2)))",
      "process.stdout.write(spec.stdout.map((l) => l + '\\n').join(''))",
      'if (spec.stderr) process.stderr.write(spec.stderr)',
      'if (spec.hang) setInterval(() => {}, 1000)',
      'else if (spec.pauseMs) setTimeout(() => (process.exitCode = spec.code || 0), spec.pauseMs)',
      'else process.exitCode = spec.code || 0'
    ].join('\n')
  )
  await chmod(bin, 0o755)
  const { readFileSync } = await import('node:fs')
  return { bin, args: () => JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8')) as string[] }
}

const rgLine = (type: string, data: Record<string, unknown>) => JSON.stringify({ type, data })
const begin = (path: string) => rgLine('begin', { path: { text: path } })
const end = (path: string) => rgLine('end', { path: { text: path } })
const match = (path: string, line: number, text: string, subs: [number, number][]) =>
  rgLine('match', { path: { text: path }, lines: { text }, line_number: line, submatches: subs.map(([start, stop]) => ({ match: { text: '' }, start, end: stop })) })

describe('SearchService: ripgrep', () => {
  it('streams its JSON: byte offsets become string offsets; odd paths, lines and noise are skipped', async () => {
    const root = await tempDir()
    const rg = await fakeRg({
      stdout: [
        'not json',
        begin('./src/ä.ts'),
        match('./src/ä.ts', 2, 'wörld wörld\r\n', [
          [0, 6],
          [7, 13]
        ]),
        rgLine('match', { path: { text: './src/ä.ts' }, lines: { bytes: 'AAA=' }, line_number: 3, submatches: [] }),
        end('./src/ä.ts'),
        rgLine('begin', { path: { bytes: 'AAA=' } }),
        match('x', 1, 'x\n', [[0, 1]]),
        rgLine('end', { path: { bytes: 'AAA=' } }),
        begin('./empty.ts'),
        end('./empty.ts'),
        begin('./ascii.ts'),
        match('./ascii.ts', 1, 'abc\n', [[1, 2]]),
        end('./ascii.ts'),
        rgLine('summary', {})
      ]
    })
    const h = harness(root, { ripgrep: rg.bin })
    expect(await h.service.start('r', 'p', q('w', { include: ['src'] }))).toEqual({ engine: 'ripgrep' })
    const { files } = await h.done('r')
    expect(files).toEqual({ 'ascii.ts': ['1:1:1'], 'src/ä.ts': ['2:0:5', '2:6:5'] })
    expect(rg.args()).toEqual(ripgrepArgs(q('w', { include: ['src'] }), { ...SEARCH_LIMITS }))
  })

  it('a search still running sends what it found so far, batch by batch', async () => {
    const root = await tempDir()
    const rg = await fakeRg({ stdout: [begin('./a.ts'), match('./a.ts', 1, 'needle\n', [[0, 6]]), end('./a.ts')], pauseMs: 300 })
    const h = harness(root, { ripgrep: rg.bin })
    await h.service.start('slow', 'p', q('needle'))
    const { files, last } = await h.done('slow')
    expect(files).toEqual({ 'a.ts': ['1:0:6'] })
    const mine = h.events.filter((e) => e.id === 'slow')
    // The match went out in a batch of its own (after batchMs), before the search was done.
    expect(mine[0]).toMatchObject({ done: false, files: [{ path: 'a.ts' }] })
    expect(last).toMatchObject({ done: true, files: [] })
  })

  it('stops ripgrep at the match limit, and when cancelled', async () => {
    const root = await tempDir()
    const lines = [begin('./a'), match('./a', 1, 'x x\n', [[0, 1], [2, 3]]), end('./a'), begin('./b'), match('./b', 1, 'x\n', [[0, 1]]), end('./b')]
    const capped = await harness(root, { ripgrep: (await fakeRg({ stdout: lines, hang: true })).bin, limits: { matches: 2 } }).search(q('x'))
    expect(capped.files).toEqual({ a: ['1:0:1', '1:2:1'] })
    expect(capped.last.truncated).toBe(true)

    const h = harness(root, { ripgrep: (await fakeRg({ stdout: [], hang: true })).bin })
    await h.service.start('c', 'p', q('x'))
    h.service.cancel('c')
    await tick(100)
    expect(h.events).toEqual([])
  })

  it('falls back to the built-in engine when ripgrep fails without results; keeps results of a partial error', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'a.txt'), 'x\n')
    const broken = await fakeRg({ stdout: [], stderr: 'regex parse error', code: 2 })
    expect((await harness(root, { ripgrep: broken.bin }).search(q('x'))).files).toEqual({ 'a.txt': ['1:0:1'] })
    const partial = await fakeRg({ stdout: [begin('./z'), match('./z', 1, 'x\n', [[0, 1]]), end('./z')], stderr: 'z: Permission denied', code: 2 })
    expect((await harness(root, { ripgrep: partial.bin }).search(q('x'))).files).toEqual({ z: ['1:0:1'] })
    const quiet = await fakeRg({ stdout: [], code: 2 })
    expect((await harness(root, { ripgrep: quiet.bin }).search(q('x'))).files).toEqual({})
    // Not runnable at all.
    expect((await harness(root, { ripgrep: join(root, 'no-rg') }).search(q('x'))).files).toEqual({ 'a.txt': ['1:0:1'] })
  })

  it('finds ripgrep by itself, once', async () => {
    const root = await tempDir()
    const events: SearchProgress[] = []
    const service = new SearchService({ resolveRoot: () => root, publish: (p) => events.push(p) })
    const a = await service.start('a', 'p', q('x'))
    const b = await service.start('b', 'p', q('x'))
    expect(a.engine).toBe(b.engine)
    expect(['ripgrep', 'builtin']).toContain(a.engine)
    service.dispose()
  })

  it.runIf(existsSync('/usr/bin/rg') || existsSync('/usr/local/bin/rg') || existsSync('/opt/homebrew/bin/rg'))('agrees with the real ripgrep', async () => {
    const root = await project()
    const rg = (await findRipgrep())!
    expect((await harness(root, { ripgrep: rg }).search(q('needle'))).files).toEqual((await harness(root).search(q('needle'))).files)
  })
})

describe('SearchService: paired devices', () => {
  it('a device’s search leaves out its deny list and is addressed to it; ids are per caller', async () => {
    const root = await project()
    await writeFile(join(root, '.npmrc'), '//registry/:_authToken=needle\n')
    await mkdir(join(root, 'certs'))
    await writeFile(join(root, 'certs', 'server.pem'), 'needle\n')
    const { service, events, done } = harness(root)
    const router = new Router({ remoteTerminal: () => false })
    registerSearchIpc(router, service, { denied: (path) => /(^|\/)(\.npmrc|[^/]+\.pem)$/.exec(path)?.[2] })

    const remote = { transport: 'remote' as const, deviceId: 'phone', role: 'member' as const }
    expect(await router.dispatch('search:start', { id: 's', projectId: 'p', query: q('needle') }, remote)).toMatchObject({ ok: true })
    const phone = await done('s')
    expect(Object.keys(phone.files)).toEqual(['.config/x.json', 'src/a.ts', 'src/deep/b.md', 'src/keep.log'])
    expect(events.filter((e) => e.id === 's').every((e) => e.device === 'phone')).toBe(true)

    // The desktop sees everything, addressed to no device.
    events.length = 0
    await router.dispatch('search:start', { id: 's', projectId: 'p', query: q('needle') }, { transport: 'ipc' })
    const desk = await done('s')
    expect(Object.keys(desk.files)).toEqual(['.config/x.json', '.npmrc', 'certs/server.pem', 'src/a.ts', 'src/deep/b.md', 'src/keep.log'])
    expect(events.some((e) => 'device' in e)).toBe(false)

    // A device can't stop the desktop's search (nor another device's) by reusing its id.
    const stop = vi.spyOn(SearchService.prototype as unknown as { stop(key: string): void }, 'stop')
    await router.dispatch('search:cancel', { id: 's' }, remote)
    await router.dispatch('search:cancel', { id: 's' }, { transport: 'remote' })
    await router.dispatch('search:cancel', { id: 's' }, { transport: 'ipc' })
    expect(stop.mock.calls).toEqual([['device:phone:s'], ['device::s'], ['desktop:s']])
    stop.mockRestore()

    // A remote call without a device id still never reaches the desktop's searches, nor any device.
    events.length = 0
    await service.start('t', 'p', q('needle'), { hidden: () => false })
    expect((await done('t')).last).not.toHaveProperty('device')
    service.dispose()
  })
})
