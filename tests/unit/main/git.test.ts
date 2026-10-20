import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './helpers'
import { GitService, remoteWebUrl } from '../../../electron/main/services/git/GitService'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

/** A repo with one commit: a.txt (2 lines) and gone.txt; plus an untracked old.txt. */
async function repo(): Promise<string> {
  const dir = await tempDir('mindeck-git-')
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'user.email', 't@t')
  sh(dir, 'config', 'user.name', 'T')
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\n')
  await writeFile(join(dir, 'gone.txt'), 'x\n')
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'init')
  await writeFile(join(dir, 'old.txt'), 'already untracked\n')
  return dir
}

const git = new GitService()

describe('GitService', () => {
  it('knows repos; no baseline outside a repo or before the first commit', async () => {
    const plain = await tempDir()
    expect(await git.isRepo(plain)).toBe(false)
    expect(await git.baseline(plain)).toBeNull()
    sh(plain, 'init', '-q')
    expect(await git.isRepo(plain)).toBe(true)
    expect(await git.baseline(plain)).toBeNull()
  })

  it('baseline keeps uncommitted edits out of the session diff; changes lists what the agent did', async () => {
    const dir = await repo()
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nmine (before the agent)\n')
    const start = (await git.baseline(dir))!
    expect(start.base).toMatch(/^[0-9a-f]{40}$/)
    expect(start.base).not.toBe(sh(dir, 'rev-parse', 'HEAD').trim()) // the stash commit
    expect(start.untracked).toEqual(['old.txt'])
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toContain('mine') // working tree untouched

    // the agent: edits a.txt, deletes gone.txt, adds new.ts and a binary file
    await writeFile(join(dir, 'a.txt'), 'one\nTWO\nmine (before the agent)\nagent\n')
    await rm(join(dir, 'gone.txt'))
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'src', 'new.ts'), 'export const x = 1\nexport const y = 2\n')
    await writeFile(join(dir, 'logo.bin'), Buffer.from([0, 1, 2]))
    await writeFile(join(dir, 'staged.ts'), 'x\n')
    sh(dir, 'add', 'staged.ts') // a new file the agent already staged
    expect(await git.changes(dir, start)).toEqual([
      { path: 'a.txt', status: 'modified', added: 2, removed: 1 },
      { path: 'gone.txt', status: 'deleted', added: 0, removed: 1 },
      { path: 'logo.bin', status: 'added', added: 0, removed: 0 },
      { path: 'src/new.ts', status: 'added', added: 2, removed: 0 },
      { path: 'staged.ts', status: 'added', added: 1, removed: 0 }
    ])
    expect(await git.fileAt(dir, start.base, 'a.txt')).toBe('one\ntwo\nmine (before the agent)\n')
    expect(await git.fileAt(dir, start.base, 'src/new.ts')).toBe('')
  })

  it('a clean tree uses HEAD; binary diffs count as 0 lines', async () => {
    const dir = await repo()
    await writeFile(join(dir, 'pic.bin'), Buffer.from([0, 9]))
    sh(dir, 'add', 'pic.bin')
    sh(dir, 'commit', '-q', '-m', 'bin')
    const start = (await git.baseline(dir))!
    expect(start.base).toBe(sh(dir, 'rev-parse', 'HEAD').trim())
    await writeFile(join(dir, 'pic.bin'), Buffer.from([0, 8, 7]))
    await symlink(join(dir, 'nowhere'), join(dir, 'dangling')) // new, and nothing to read: 0 lines
    expect(await git.changes(dir, start)).toEqual([
      { path: 'dangling', status: 'added', added: 0, removed: 0 },
      { path: 'pic.bin', status: 'modified', added: 0, removed: 0 }
    ])
  })

  it('worktrees: add, apply into the project (new files too, a node_modules link left out), remove with the branch', async () => {
    const dir = await repo()
    const wt = join(await tempDir(), 'wt')
    await git.addWorktree(dir, wt, 'mindeck/test')
    expect(existsSync(join(wt, 'a.txt'))).toBe(true)
    const start = (await git.baseline(wt))!
    expect(await git.applyTo(dir, wt, start.base)).toBe(0) // nothing yet

    await writeFile(join(wt, 'a.txt'), 'one\ntwo\nfrom the agent\n')
    await writeFile(join(wt, 'added.txt'), 'new\n')
    sh(wt, 'add', 'a.txt')
    sh(wt, 'commit', '-q', '-m', 'agent commit') // committed or not — both come over
    await symlink(join(dir, 'a.txt'), join(wt, 'node_modules'))
    expect((await git.changes(wt, start)).map((c) => c.path)).toContain('node_modules')
    expect((await git.changes(wt, start, ['node_modules'])).map((c) => c.path)).toEqual(['a.txt', 'added.txt'])

    expect(await git.applyTo(dir, wt, start.base, ['node_modules'])).toBe(2)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\nfrom the agent\n')
    expect(await readFile(join(dir, 'added.txt'), 'utf8')).toBe('new\n')
    expect(existsSync(join(dir, 'node_modules'))).toBe(false)

    await git.removeWorktree(dir, wt, 'mindeck/test')
    expect(existsSync(wt)).toBe(false)
    expect(sh(dir, 'branch', '--list', 'mindeck/test')).toBe('')
    await expect(git.removeWorktree(dir, wt, 'mindeck/test')).rejects.toMatchObject({ code: 'git' })
    // its branch gone already: the worktree goes all the same
    const wt2 = join(await tempDir(), 'wt2')
    await git.addWorktree(dir, wt2, 'mindeck/two')
    await git.removeWorktree(dir, wt2, 'mindeck/not-there')
    expect(existsSync(wt2)).toBe(false)
  })

  it('refuses a patch that does not apply, touching nothing', async () => {
    const dir = await repo()
    const wt = join(await tempDir(), 'wt')
    await git.addWorktree(dir, wt, 'mindeck/clash')
    const start = (await git.baseline(wt))!
    await writeFile(join(wt, 'a.txt'), 'one\nagent\n')
    await writeFile(join(dir, 'a.txt'), 'totally\ndifferent\n')
    await expect(git.applyTo(dir, wt, start.base)).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('totally\ndifferent\n')
    // a branch that exists already: git's own error comes through
    await expect(git.addWorktree(dir, join(await tempDir(), 'wt2'), 'mindeck/clash')).rejects.toMatchObject({ code: 'git' })
  })

  it('a branch and origin: pushed, landed in the default branch (only once merged there), uncommitted files', async () => {
    const lone = await repo()
    expect(await git.landed(lone, 'main', 'HEAD')).toBe(false) // no origin at all
    expect(await git.landed(lone, 'main', 'no-such-commit')).toBe(false) // git can't tell: not landed

    const dir = await repo()
    const origin = await tempDir('mindeck-origin-')
    sh(origin, 'init', '-q', '--bare', '-b', 'main')
    sh(dir, 'remote', 'add', 'origin', origin)
    sh(dir, 'push', '-q', 'origin', 'main')
    const wt = join(await tempDir(), 'wt')
    await git.addWorktree(dir, wt, 'mindeck/pr')
    const start = (await git.baseline(wt))!
    expect(await git.pushed(wt, 'mindeck/pr')).toBe(false)
    expect(await git.landed(wt, 'mindeck/pr', start.base)).toBe(false) // no commits of its own yet

    await writeFile(join(wt, 'a.txt'), 'one\ntwo\nthree\n')
    sh(wt, 'commit', '-qam', 'agent work')
    sh(wt, 'push', '-q', '-u', 'origin', 'mindeck/pr')
    expect(await git.pushed(wt, 'mindeck/pr')).toBe(true)
    expect(await git.landed(wt, 'mindeck/pr', start.base)).toBe(false) // pushed, not merged

    // The pull request is merged on the server: another clone merges and pushes main.
    const other = join(await tempDir(), 'other')
    execFileSync('git', ['clone', '-q', origin, other])
    sh(other, 'config', 'user.email', 't@t')
    sh(other, 'config', 'user.name', 'T')
    sh(other, 'merge', '-q', '--no-ff', '-m', 'Merge pull request', 'origin/mindeck/pr')
    sh(other, 'push', '-q', 'origin', 'main')
    expect(await git.landed(wt, 'mindeck/pr', start.base)).toBe(true) // fetched, and it is in origin/main
    sh(dir, 'remote', 'set-head', 'origin', 'main') // origin/HEAD known: the same answer
    expect(await git.landed(wt, 'mindeck/pr', start.base)).toBe(true)

    expect(await git.uncommitted(wt)).toBe(0)
    await writeFile(join(wt, 'left.txt'), 'not committed\n')
    await symlink(join(dir, 'a.txt'), join(wt, 'node_modules'))
    expect(await git.uncommitted(wt, ['node_modules'])).toBe(1)
  })

  it('the repo page from origin; none without a remote', async () => {
    const dir = await repo()
    expect(await git.webUrl(dir)).toBeUndefined()
    sh(dir, 'remote', 'add', 'origin', 'git@github.com:me/demo.git')
    expect(await git.webUrl(dir)).toBe('https://github.com/me/demo')
  })

  it('remote addresses become web pages, never with credentials', () => {
    expect(remoteWebUrl('git@github.com:me/demo.git')).toBe('https://github.com/me/demo')
    expect(remoteWebUrl('ssh://git@gitlab.com:22/group/sub/demo.git')).toBe('https://gitlab.com/group/sub/demo')
    expect(remoteWebUrl('ssh://git@example.org/me/demo')).toBe('https://example.org/me/demo')
    expect(remoteWebUrl('https://user:ghp_secret@github.com/me/demo.git\n')).toBe('https://github.com/me/demo')
    expect(remoteWebUrl('https://git.example.org:8443/me/demo/')).toBe('https://git.example.org:8443/me/demo')
    expect(remoteWebUrl('http://github.com/me/demo')).toBe('https://github.com/me/demo')
    expect(remoteWebUrl('/srv/repos/demo.git')).toBeUndefined()
    expect(remoteWebUrl('https://github.com/demo')).toBeUndefined()
    expect(remoteWebUrl('file:///srv/demo.git')).toBeUndefined()
  })

  it('restricted unless the folder belongs to a trusted project: the repository’s hooks and filters stay off', async () => {
    const dir = await repo()
    await writeFile(join(dir, 'hook.sh'), '#!/bin/sh\ntouch "$(dirname "$0")/PWNED"\n')
    sh(dir, 'config', 'filter.evil.clean', 'sh hook.sh; cat')
    await writeFile(join(dir, '.gitattributes'), '* filter=evil\n')
    await writeFile(join(dir, 'a.txt'), 'changed\n')
    const restricted = new GitService({ trusted: () => false })
    expect(await restricted.uncommitted(dir)).toBe(4) // a.txt, .gitattributes, hook.sh, old.txt
    expect(await git.uncommitted(dir)).toBe(4) // no trust given: restricted
    expect(existsSync(join(dir, 'PWNED'))).toBe(false)
    expect(await new GitService({ trusted: (d) => d === dir }).uncommitted(dir)).toBeGreaterThan(0)
    expect(existsSync(join(dir, 'PWNED'))).toBe(true)
  })

  it('reports a missing git binary as an error', async () => {
    const saved = process.env.PATH
    process.env.PATH = ''
    try {
      await expect(git.addWorktree(await tempDir(), '/x', 'b')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      process.env.PATH = saved
    }
  })
})
