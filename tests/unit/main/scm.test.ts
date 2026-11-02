import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './helpers'
import { parseLog, parseNameStatus, parseStatus, ScmService } from '../../../electron/main/services/scm/ScmService'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const identity = (dir: string) => {
  sh(dir, 'config', 'user.email', 't@t')
  sh(dir, 'config', 'user.name', 'Tester')
}

/** A repo with one commit (a.txt, b.txt). */
async function repo(): Promise<string> {
  const dir = await tempDir('mindeck-scm-')
  sh(dir, 'init', '-q', '-b', 'main')
  identity(dir)
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\n')
  await writeFile(join(dir, 'b.txt'), 'bee\n')
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'init')
  return dir
}

/** A bare "GitHub" and a clone of it as the project (upstream set). */
async function withRemote() {
  const origin = await tempDir('mindeck-origin-')
  sh(origin, 'init', '-q', '--bare', '-b', 'main')
  const seed = await repo()
  sh(seed, 'remote', 'add', 'origin', origin)
  sh(seed, 'push', '-q', 'origin', 'main')
  const project = join(await tempDir(), 'project')
  execFileSync('git', ['clone', '-q', origin, project])
  identity(project)
  return { origin, seed, project }
}

const service = (root: string | undefined, limits?: ConstructorParameters<typeof ScmService>[1]) => new ScmService(() => root, limits)

describe('parsers', () => {
  it('status: branch info, ordinary, renamed, conflicted and untracked entries', () => {
    const raw = [
      '# branch.oid 1234567890abcdef',
      '# branch.head feature',
      '# branch.upstream origin/feature',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 aaa bbb staged only.ts',
      '1 .D N... 100644 100644 000000 aaa aaa gone.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc clash.ts',
      '? fresh.ts',
      ''
    ].join('\0')
    expect(parseStatus(raw)).toEqual({
      head: '1234567',
      branch: 'feature',
      upstream: 'origin/feature',
      ahead: 2,
      behind: 1,
      files: [
        { path: 'staged only.ts', staged: 'modified' },
        { path: 'gone.ts', unstaged: 'deleted' },
        { path: 'new name.ts', from: 'old name.ts', staged: 'renamed' },
        { path: 'clash.ts', unstaged: 'conflicted' },
        { path: 'fresh.ts', unstaged: 'untracked' }
      ]
    })
    expect(parseStatus(['# branch.oid (initial)', '# branch.head (detached)'].join('\0'))).toEqual({ ahead: 0, behind: 0, files: [] })
  })

  it('log and name-status records', () => {
    expect(parseLog('a\x1f\x1fAda\x1f10\x1froot\x1f\x1e\nb\x1fa c\x1fBob\x1f20\x1fmerge\x1fHEAD -> main, tag: v1\x1e')).toEqual([
      { hash: 'a', parents: [], author: 'Ada', date: 10_000, subject: 'root', refs: [] },
      { hash: 'b', parents: ['a', 'c'], author: 'Bob', date: 20_000, subject: 'merge', refs: ['HEAD -> main', 'tag: v1'] }
    ])
    expect(parseNameStatus('M\0a.ts\0R087\0old.ts\0new.ts\0C100\0x.ts\0y.ts\0A\0b.ts\0X\0odd.ts\0')).toEqual([
      { path: 'a.ts', change: 'modified' },
      { from: 'old.ts', path: 'new.ts', change: 'renamed' },
      { from: 'x.ts', path: 'y.ts', change: 'copied' },
      { path: 'b.ts', change: 'added' },
      { path: 'odd.ts', change: 'modified' }
    ])
  })
})

describe('ScmService', () => {
  it('a folder without git, an unknown project, and a folder git cannot even enter', async () => {
    const plain = await tempDir()
    expect(await service(plain).status('p')).toEqual({ repo: false, ahead: 0, behind: 0, merging: false, files: [] })
    await expect(service(undefined).status('p')).rejects.toMatchObject({ code: 'not-found' })
    await expect(service(join(plain, 'missing')).status('p')).rejects.toMatchObject({ code: 'git' })
    const s = service(plain)
    expect(await s.init('p')).toMatchObject({ repo: true, files: [] })
    // A machine without git (a slim container): said plainly.
    const path = process.env.PATH
    process.env.PATH = ''
    try {
      await expect(service(plain).status('p')).rejects.toMatchObject({ code: 'git-missing', message: 'Git is not installed on this machine' })
    } finally {
      process.env.PATH = path
    }
  })

  it('stages, unstages (also before the first commit), discards and commits', async () => {
    const fresh = await tempDir()
    sh(fresh, 'init', '-q', '-b', 'main')
    identity(fresh)
    await writeFile(join(fresh, 'new.txt'), 'x\n')
    const f = service(fresh)
    await f.stage('p', ['new.txt'])
    expect((await f.status('p')).files).toEqual([{ path: 'new.txt', staged: 'added' }])
    await f.unstage('p', ['new.txt']) // no HEAD yet
    expect((await f.status('p')).files).toEqual([{ path: 'new.txt', unstaged: 'untracked' }])
    expect(await f.log('p')).toEqual([]) // nothing committed yet

    const dir = await repo()
    const s = service(dir)
    await writeFile(join(dir, 'a.txt'), 'one\nTWO\n')
    await writeFile(join(dir, 'c.txt'), 'new\n')
    expect((await s.status('p')).files).toEqual([
      { path: 'a.txt', unstaged: 'modified' },
      { path: 'c.txt', unstaged: 'untracked' }
    ])
    await s.stage('p', ['a.txt'])
    await s.unstage('p', ['a.txt'])
    await s.discard('p', ['a.txt', 'c.txt'])
    expect((await s.status('p')).files).toEqual([])
    await writeFile(join(dir, 'c.txt'), 'new\n')
    await s.discard('p', ['c.txt']) // untracked only
    await writeFile(join(dir, 'a.txt'), 'changed\n')
    await s.discard('p', ['a.txt']) // tracked only
    expect((await s.status('p')).files).toEqual([])

    await expect(s.commit('p', '   ')).rejects.toMatchObject({ code: 'bad-input' })
    await writeFile(join(dir, 'b.txt'), 'bee bee\n')
    await s.commit('p', '  more bees  ', { all: true })
    expect((await s.log('p'))[0]).toMatchObject({ subject: 'more bees', author: 'Tester', refs: ['HEAD -> main'] })
    await writeFile(join(dir, 'b.txt'), 'bee bee bee\n')
    await s.stage('p', ['b.txt'])
    await s.commit('p', '', { amend: true }) // keeps the message
    await s.commit('p', 'renamed message', { amend: true })
    const log = await s.log('p')
    expect(log.map((c) => c.subject)).toEqual(['renamed message', 'init'])
    expect(log[1].parents).toEqual([])
    expect(log[0].parents).toEqual([log[1].hash])
  })

  it('pushes (publishing a new branch), fetches, pulls; knows ahead/behind and branches', { timeout: 30_000 }, async () => {
    const { seed, project } = await withRemote()
    const s = service(project)
    expect(await s.status('p')).toMatchObject({ repo: true, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, merging: false })

    await writeFile(join(project, 'a.txt'), 'one\ntwo\nthree\n')
    await s.commit('p', 'three', { all: true })
    expect((await s.status('p')).ahead).toBe(1)
    await s.push('p')
    expect((await s.status('p')).ahead).toBe(0)

    // someone else pushes; fetch sees it, pull brings it
    sh(seed, 'pull', '-q', 'origin', 'main')
    await writeFile(join(seed, 'b.txt'), 'from elsewhere\n')
    sh(seed, 'commit', '-qam', 'elsewhere')
    sh(seed, 'push', '-q', 'origin', 'main')
    await s.fetch('p')
    expect((await s.status('p')).behind).toBe(1)
    await s.pull('p')
    expect((await s.status('p')).behind).toBe(0)

    await s.createBranch('p', 'feature/x')
    await expect(s.createBranch('p', 'bad..name')).rejects.toMatchObject({ code: 'bad-input' })
    expect((await s.status('p')).upstream).toBeUndefined()
    await s.push('p') // no upstream yet: published to origin
    expect((await s.status('p')).upstream).toBe('origin/feature/x')

    sh(seed, 'push', '-q', 'origin', 'main:remote-only')
    await s.fetch('p')
    const branches = await s.branches('p')
    expect(branches).toEqual(
      expect.arrayContaining([
        { name: 'feature/x', remote: false, current: true, upstream: 'origin/feature/x' },
        { name: 'main', remote: false, current: false, upstream: 'origin/main' },
        { name: 'origin/remote-only', remote: true, current: false }
      ])
    )
    expect(branches.some((b) => b.name.endsWith('/HEAD'))).toBe(false)
    await s.checkout('p', 'main')
    expect((await s.status('p')).branch).toBe('main')
    await s.checkout('p', 'origin/remote-only') // a local tracking branch appears
    expect(await s.status('p')).toMatchObject({ branch: 'remote-only', upstream: 'origin/remote-only' })
  })

  it('push without an "origin" says so', async () => {
    const s = service(await repo())
    await expect(s.push('p')).rejects.toMatchObject({ code: 'no-remote' })
  })

  it('a conflicted merge: merging, the conflict in the status', async () => {
    const dir = await repo()
    sh(dir, 'switch', '-q', '-c', 'other')
    await writeFile(join(dir, 'a.txt'), 'theirs\n')
    sh(dir, 'commit', '-qam', 'theirs')
    sh(dir, 'switch', '-q', 'main')
    await writeFile(join(dir, 'a.txt'), 'ours\n')
    sh(dir, 'commit', '-qam', 'ours')
    try {
      sh(dir, 'merge', 'other')
    } catch {
      /* the conflict */
    }
    expect(await service(dir).status('p')).toMatchObject({ merging: true, files: [{ path: 'a.txt', unstaged: 'conflicted' }] })
  })

  it('commit details and diffs: working tree, index, commit (also a rename)', async () => {
    const dir = await repo()
    const s = service(dir)
    sh(dir, 'mv', 'b.txt', 'bee.txt')
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    sh(dir, 'commit', '-qam', 'rename and change\n\nwith a body')
    const [head, root] = await s.log('p')
    const detail = await s.show('p', head.hash)
    expect(detail).toMatchObject({ hash: head.hash, author: 'Tester', email: 't@t', message: 'rename and change\n\nwith a body' })
    expect(detail.files).toEqual([
      { path: 'a.txt', change: 'modified' },
      { from: 'b.txt', path: 'bee.txt', change: 'renamed' }
    ])
    expect((await s.show('p', root.hash)).files.map((f) => f.change)).toEqual(['added', 'added'])
    await expect(s.show('p', 'not-a-hash')).rejects.toMatchObject({ code: 'bad-input' })

    expect(await s.diff('p', 'bee.txt', { kind: 'commit', hash: head.hash, from: 'b.txt' })).toEqual({ path: 'bee.txt', original: 'bee\n', modified: 'bee\n' })
    expect(await s.diff('p', 'a.txt', { kind: 'commit', hash: root.hash })).toEqual({ path: 'a.txt', original: '', modified: 'one\ntwo\n' })
    await expect(s.diff('p', 'a.txt', { kind: 'commit', hash: 'zz' })).rejects.toMatchObject({ code: 'bad-input' })

    await writeFile(join(dir, 'a.txt'), 'staged\n')
    await s.stage('p', ['a.txt'])
    await writeFile(join(dir, 'a.txt'), 'working\n')
    expect(await s.diff('p', 'a.txt', { kind: 'staged' })).toEqual({ path: 'a.txt', original: 'one\ntwo\nthree\n', modified: 'staged\n' })
    expect(await s.diff('p', 'a.txt', { kind: 'unstaged' })).toEqual({ path: 'a.txt', original: 'staged\n', modified: 'working\n' })
    await rm(join(dir, 'a.txt'))
    expect((await s.diff('p', 'a.txt', { kind: 'unstaged' })).modified).toBe('')
  })

  it('the gutter baseline: the staged text; null when untracked or without git; never outside', async () => {
    const dir = await repo()
    await writeFile(join(dir, 'a.txt'), 'one\nTWO\n')
    await writeFile(join(dir, 'new.txt'), 'n\n')
    const s = service(dir)
    expect(await s.original('p', 'a.txt')).toBe('one\ntwo\n')
    await s.stage('p', ['a.txt'])
    expect(await s.original('p', 'a.txt')).toBe('one\nTWO\n')
    expect(await s.original('p', 'new.txt')).toBeNull()
    await expect(s.original('p', '../x')).rejects.toMatchObject({ code: 'outside-project' })
    expect(await service(await tempDir()).original('p', 'a.txt')).toBeNull()
  })

  it('quick open lists git’s files (minus deleted ones), else walks the folder with a cap', async () => {
    const dir = await repo()
    await writeFile(join(dir, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(dir, 'ignored.txt'), 'x')
    await writeFile(join(dir, 'new.txt'), 'x')
    await rm(join(dir, 'b.txt'))
    expect((await service(dir).files('p')).sort()).toEqual(['.gitignore', 'a.txt', 'new.txt'])
    // A huge repo stops at the cap.
    expect(await service(dir, { files: 2, matches: 10, line: 10 }).files('p')).toHaveLength(2)

    const plain = await tempDir()
    await mkdir(join(plain, 'src', 'deep'), { recursive: true })
    await mkdir(join(plain, 'node_modules', 'lib'), { recursive: true })
    await writeFile(join(plain, 'src', 'deep', 'x.ts'), 'x')
    await writeFile(join(plain, 'node_modules', 'lib', 'skip.js'), 'x')
    await writeFile(join(plain, 'top.md'), 'x')
    await symlink(join(plain, 'top.md'), join(plain, 'link.md'))
    expect((await service(plain).files('p')).sort()).toEqual(['src/deep/x.ts', 'top.md'])
    expect(await service(plain, { files: 1, matches: 10, line: 10 }).files('p')).toHaveLength(1)
  })

  it('searches with git grep: case, regex, no match, bad pattern, caps; outside a repo too', async () => {
    const dir = await repo()
    await writeFile(join(dir, 'c.txt'), `Hello world\nhello again\n${'x'.repeat(50)} hello long\n`)
    const s = service(dir)
    expect(await s.search('p', { query: '' })).toEqual({ matches: [], truncated: false })
    expect((await s.search('p', { query: 'hello' })).matches).toEqual([
      { path: 'c.txt', line: 1, text: 'Hello world' },
      { path: 'c.txt', line: 2, text: 'hello again' },
      { path: 'c.txt', line: 3, text: `${'x'.repeat(50)} hello long` }
    ])
    expect((await s.search('p', { query: 'Hello', caseSensitive: true })).matches).toHaveLength(1)
    expect((await s.search('p', { query: '^bee$', regex: true })).matches).toEqual([{ path: 'b.txt', line: 1, text: 'bee' }])
    expect(await s.search('p', { query: 'nowhere to be found' })).toEqual({ matches: [], truncated: false })
    await expect(s.search('p', { query: '(', regex: true })).rejects.toMatchObject({ code: 'git' })
    const capped = await service(dir, { files: 10, matches: 2, line: 20 }).search('p', { query: 'hello' })
    expect(capped).toEqual({ truncated: true, matches: [{ path: 'c.txt', line: 1, text: 'Hello world' }, { path: 'c.txt', line: 2, text: 'hello again' }] })
    expect((await service(dir, { files: 10, matches: 5, line: 20 }).search('p', { query: 'long' })).matches[0].text).toBe(`${'x'.repeat(20)}…`)

    const plain = await tempDir()
    await writeFile(join(plain, 'notes.md'), 'find me\n')
    expect((await service(plain).search('p', { query: 'find' })).matches).toEqual([{ path: 'notes.md', line: 1, text: 'find me' }])
    expect(existsSync(join(plain, '.git'))).toBe(false) // searching never creates a repo
  })
})
