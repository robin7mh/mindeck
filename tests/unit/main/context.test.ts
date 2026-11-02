import { execFileSync } from 'node:child_process'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'

const fsHooks = vi.hoisted(() => ({
  lstat: undefined as undefined | ((path: string) => unknown),
  readFile: undefined as undefined | ((path: string) => unknown)
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: (p: string) => fsHooks.lstat?.(p) ?? actual.lstat(p),
    readFile: ((p: string, ...rest: unknown[]) =>
      fsHooks.readFile?.(String(p)) ?? (actual.readFile as (...a: unknown[]) => unknown)(p, ...rest)) as typeof actual.readFile
  }
})

import { scanProject, type ScanResult } from '../../../electron/main/services/context/scan'
import {
  buildTree,
  detectConfigFiles,
  parseDependencies,
  parseReadme,
  scanTodos
} from '../../../electron/main/services/context/analyzers'
import { ContextService } from '../../../electron/main/services/context/ContextService'
import { ContextStore } from '../../../electron/main/services/context/contextStore'

const write = async (root: string, files: Record<string, string>) => {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), content)
  }
}

describe('scanProject', () => {
  it('walks files and dirs, honours .gitignore and the hard exclude list, skips symlinks', async () => {
    const root = await tempDir()
    await write(root, {
      '.gitignore': 'secret.txt\nlogs/\n',
      'a.ts': 'x',
      'src/b.ts': 'y',
      'secret.txt': 'no',
      'logs/x.log': 'no',
      'node_modules/pkg/index.js': 'no'
    })
    await symlink(join(root, 'src'), join(root, 'link'))
    const progress = vi.fn()
    const scan = await scanProject(root, { onProgress: progress })
    expect(scan.entries.map((e) => e.rel).sort()).toEqual(['.gitignore', 'a.ts', 'src', 'src/b.ts'])
    expect(scan).toMatchObject({ fileCount: 3, dirCount: 1, truncated: false })
    expect(progress).toHaveBeenLastCalledWith(3)
  })

  it('works without .gitignore and without a progress callback', async () => {
    const root = await tempDir()
    await write(root, { 'only.md': '#' })
    expect((await scanProject(root)).fileCount).toBe(1)
  })

  it('stops at maxFiles (truncated), respects maxDepth and reports every 500 files', async () => {
    const root = await tempDir()
    // 'zzz.txt' sorts after 'many/': the parent loop must stop once the subdir truncated
    const files: Record<string, string> = { 'deep/a/b/c.txt': 'x', 'zzz.txt': '' }
    for (let i = 0; i < 501; i += 1) files[`many/f${i}.txt`] = ''
    await write(root, files)
    const progress = vi.fn()
    const capped = await scanProject(root, { maxFiles: 10, onProgress: progress })
    expect(capped).toMatchObject({ fileCount: 10, truncated: true })

    const all = await scanProject(root, { maxDepth: 1, onProgress: progress })
    expect(all.entries.some((e) => e.rel === 'deep/a/b/c.txt')).toBe(false)
    expect(progress).toHaveBeenCalledWith(500)
  })

  it('ignores unreadable dirs, vanished entries and non-regular files', async () => {
    expect(await scanProject('/no/such/root')).toMatchObject({ fileCount: 0, dirCount: 0 })

    const root = await tempDir()
    await write(root, { 'gone.txt': '', 'keep.txt': '' })
    execFileSync('mkfifo', [join(root, 'pipe')])
    fsHooks.lstat = (p) => (p.endsWith('gone.txt') ? Promise.reject(new Error('ENOENT')) : undefined)
    try {
      const scan = await scanProject(root)
      expect(scan.entries.map((e) => e.rel)).toEqual(['keep.txt'])
    } finally {
      fsHooks.lstat = undefined
    }
  })
})

const entry = (rel: string, type: 'file' | 'dir', depth: number, extra: Partial<ScanResult['entries'][0]> = {}) => ({
  rel,
  abs: `/root/${rel}`,
  type,
  depth,
  size: 10,
  mtimeMs: 0,
  ...extra
})
const scanOf = (entries: ScanResult['entries']): ScanResult => ({ entries, fileCount: 0, dirCount: 0, truncated: false })

describe('analyzers', () => {
  it('buildTree: top two levels, dirs first then alphabetical, bounded', () => {
    const scan = scanOf([
      entry('z.ts', 'file', 0),
      entry('b', 'dir', 0),
      entry('a', 'dir', 0),
      entry('a.ts', 'file', 0),
      entry('b/c/deep.ts', 'file', 2)
    ])
    expect(buildTree(scan)).toEqual([
      { path: 'a', type: 'dir' },
      { path: 'b', type: 'dir' },
      { path: 'a.ts', type: 'file' },
      { path: 'z.ts', type: 'file' }
    ])
    expect(buildTree(scan, 1)).toHaveLength(1)
  })

  it('detectConfigFiles: every known kind, once per name, top levels only', () => {
    const names = [
      'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', 'electron.vite.config.ts', 'tailwind.config.ts',
      'postcss.config.js', '.eslintrc.json', 'eslint.config.js', '.prettierrc', 'prettier.config.js',
      'next.config.js', 'next.config.mjs', 'nuxt.config.ts', 'svelte.config.js', 'Dockerfile',
      'docker-compose.yml', 'compose.yaml', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod',
      '.env.example', '.env.sample', 'Makefile', 'unknown.cfg'
    ]
    const scan = scanOf([
      ...names.map((n) => entry(n, 'file', 0)),
      entry('pkg/tsconfig.json', 'file', 1), // duplicate basename
      entry('a/b/Makefile', 'file', 2), // too deep
      entry('Dockerfile', 'dir', 0) // not a file
    ])
    const found = detectConfigFiles(scan)
    expect(found).toHaveLength(names.length - 1)
    expect(new Set(found.map((f) => f.kind))).toEqual(
      new Set(['TypeScript', 'Vite', 'Tailwind', 'PostCSS', 'ESLint', 'Prettier', 'Next.js', 'Nuxt', 'Svelte', 'Docker', 'Python', 'Rust', 'Go', 'Env template', 'Make'])
    )
  })

  it('parseDependencies: sorted deps + devDeps, tolerant of missing fields and bad JSON', async () => {
    const root = await tempDir()
    await write(root, { 'package.json': JSON.stringify({ dependencies: { zod: '3' }, devDependencies: { vite: 5 } }) })
    expect(await parseDependencies(root)).toEqual([
      { name: 'vite', version: '5', dev: true },
      { name: 'zod', version: '3', dev: false }
    ])
    await write(root, { 'package.json': '{}' })
    expect(await parseDependencies(root)).toEqual([])
    await write(root, { 'package.json': '{bad' })
    expect(await parseDependencies(root)).toEqual([])
  })

  it('scanTodos: markers in text files, bounded by files/size/count, skips unreadable', async () => {
    const root = await tempDir()
    await write(root, {
      'a.ts': '// TODO: first\nconst x = 1 // FIXME - second\n',
      'b.md': 'HACK third\nXXX fourth',
      'Makefile': 'TODO: no extension → skipped',
      'img.png': 'TODO binary-ish → skipped'
    })
    const files = ['a.ts', 'b.md', 'Makefile', 'img.png', 'big.ts', 'gone.ts']
    const scan = scanOf(
      files.map((rel) => ({ ...entry(rel, 'file', 0), abs: join(root, rel), size: rel === 'big.ts' ? 10_000_000 : 10 }))
    )
    const todos = await scanTodos(scan)
    expect(todos).toEqual([
      { file: 'a.ts', line: 1, kind: 'TODO', text: 'first' },
      { file: 'a.ts', line: 2, kind: 'FIXME', text: 'second' },
      { file: 'b.md', line: 1, kind: 'HACK', text: 'third' },
      { file: 'b.md', line: 2, kind: 'XXX', text: 'fourth' }
    ])
    expect(await scanTodos(scan, { maxTodos: 1 })).toHaveLength(1)
    expect(await scanTodos(scan, { maxFiles: 1 })).toHaveLength(2)
    expect(await scanTodos(scanOf([entry('dir', 'dir', 0)]))).toEqual([])
  })

  it('parseReadme: title + sections, none, unreadable, at most 30 sections', async () => {
    const root = await tempDir()
    const sections = Array.from({ length: 35 }, (_, i) => `## S${i}`).join('\n')
    await write(root, { 'README.md': `# Title\n# Second H1 ignored\n### Sub\n${sections}` })
    const scan = scanOf([{ ...entry('README.md', 'file', 0), abs: join(root, 'README.md') }])
    const parsed = await parseReadme(root, scan)
    expect(parsed?.title).toBe('Title')
    expect(parsed?.sections).toHaveLength(30)
    expect(parsed?.sections[0]).toBe('Sub')

    expect(await parseReadme(root, scanOf([entry('docs/README.md', 'file', 1)]))).toBeUndefined()
    await rm(join(root, 'README.md'))
    expect(await parseReadme(root, scan)).toBeUndefined()
  })
})

describe('ContextService', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    })

  it('indexes a project, caches it and reports progress', async () => {
    const root = await tempDir()
    await write(root, {
      'package.json': JSON.stringify({ name: 'demo', dependencies: { react: '18' } }),
      'README.md': '# Demo',
      'src/main.ts': '// TODO: ship it'
    })
    git(root, 'init', '-q')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'init')

    const store = new ContextStore(await tempDir())
    const onProgress = vi.fn()
    const service = new ContextService({ store, resolvePath: (id) => (id === 'p1' ? root : undefined), onProgress })

    expect(await service.get('p1')).toBeNull()
    const ctx = await service.reindex('p1')
    expect(ctx).toMatchObject({
      projectId: 'p1',
      fileCount: 3,
      languages: ['JavaScript'],
      frameworks: ['React'],
      readme: { title: 'Demo', sections: [] },
      todos: [{ file: 'src/main.ts', line: 1, kind: 'TODO', text: 'ship it' }],
      packageJson: { name: 'demo' }
    })
    expect(ctx.gitCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(await service.get('p1')).toEqual(ctx)
    expect(onProgress).toHaveBeenLastCalledWith({ projectId: 'p1', filesScanned: 3, done: true })
  })

  it('works without a progress callback and outside git; rejects unknown projects', async () => {
    const root = await tempDir()
    await write(root, { 'x.txt': '' })
    const service = new ContextService({ store: new ContextStore(await tempDir()), resolvePath: () => root })
    expect((await service.reindex('p')).gitCommit).toBeUndefined()
    const none = new ContextService({ store: new ContextStore(await tempDir()), resolvePath: () => undefined })
    await expect(none.reindex('nope')).rejects.toThrow('Unknown project: nope')
  })

  it('the cache never reads outside its folder, whatever id a client sends', async () => {
    const data = await tempDir()
    await write(data, { 'secret.json': '{"projectId":"leak"}' })
    const store = new ContextStore(join(data, 'cache'))
    // The store keeps its files in <dir>/context: two levels up is `secret.json`.
    expect(await store.get('../../secret')).toBeNull()
  })

  it('reports intermediate progress during large scans', async () => {
    const root = await tempDir()
    const files: Record<string, string> = {}
    for (let i = 0; i < 500; i += 1) files[`f${i}.txt`] = ''
    await write(root, files)
    const onProgress = vi.fn()
    await new ContextService({ store: new ContextStore(await tempDir()), resolvePath: () => root, onProgress }).reindex('p')
    expect(onProgress).toHaveBeenCalledWith({ projectId: 'p', filesScanned: 500, done: false })
  })
})
