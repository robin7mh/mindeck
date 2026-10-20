import { execFile } from 'node:child_process'
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'
import { gitGuard, gitProgram, neutralize, noHooks, overrideArgs, overrideEnv, parseConfigList, UNTRUSTED_GIT, untrustedOverrides } from '../../../electron/main/lib/git'
import { programPath } from '../../../electron/main/lib/executables'

const run = (cwd: string, args: string[]) => promisify(execFile)(gitProgram(), args, { cwd })
const pwned = async (dir: string) => (await readdir(dir)).filter((f) => f.startsWith('PWNED')).sort()

/**
 * The attack (BE-SEC-01): a repository from a ZIP or tarball brings its .git
 * folder — config and hooks — and git runs what they name on a plain `status`.
 */
async function hostileRepo(): Promise<string> {
  const repo = await tempDir('mindeck-hostile-')
  await run(repo, ['init', '-q'])
  await run(repo, ['config', 'user.email', 'a@b.c'])
  await run(repo, ['config', 'user.name', 'A'])
  await writeFile(join(repo, 'a.txt'), 'hi\n')
  await run(repo, ['add', 'a.txt'])
  await run(repo, ['commit', '-qm', 'one'])
  // Then the hostile parts: a clean filter for every file, an fsmonitor program, a textconv driver, a hook.
  await writeFile(join(repo, '.gitattributes'), '* filter=evil diff=tc\n')
  await run(repo, ['config', 'filter.evil.clean', 'touch PWNED-filter; cat'])
  await run(repo, ['config', 'filter.evil.required', 'true'])
  await run(repo, ['config', 'diff.tc.textconv', 'touch PWNED-textconv; cat'])
  await writeFile(join(repo, 'fsmonitor.sh'), '#!/bin/sh\ntouch PWNED-fsmonitor\n')
  await chmod(join(repo, 'fsmonitor.sh'), 0o755)
  await run(repo, ['config', 'core.fsmonitor', './fsmonitor.sh'])
  await writeFile(join(repo, '.git/hooks/pre-commit'), '#!/bin/sh\ntouch PWNED-hook\n')
  await chmod(join(repo, '.git/hooks/pre-commit'), 0o755)
  await writeFile(join(repo, 'a.txt'), 'changed\n')
  return repo
}

describe('git in a repository Mindeck does not trust', () => {
  it('git is started by its full path from the PATH', () => {
    expect(gitProgram()).toBe(programPath('git'))
  })

  it('hooks from a folder that can’t hold any: /dev/null — on Windows one next to Mindeck that doesn’t exist (C:\\dev\\null could)', () => {
    expect(noHooks('linux')).toBe('/dev/null')
    expect(noHooks('win32')).toBe(join(dirname(process.execPath), 'no-hooks'))
    expect(existsSync(noHooks('win32'))).toBe(false)
    expect(UNTRUSTED_GIT).toContainEqual(['core.hooksPath', noHooks()])
  })

  it('a hostile repository runs nothing — status, blame, show, commit — while plain git would run all of it', { timeout: 30_000 }, async () => {
    const repo = await hostileRepo()
    const guard = await gitGuard(repo, false)
    await run(repo, [...guard, 'status', '--porcelain'])
    await run(repo, [...guard, 'blame', 'a.txt']).catch(() => {}) // fails (no textconv to run) — but runs nothing
    await run(repo, [...guard, 'show', 'HEAD']).catch(() => {})
    await run(repo, [...guard, 'commit', '-qam', 'two'])
    expect(await pwned(repo)).toEqual([])

    // Trusted: no overrides — the repository's config counts (this is what they prevent).
    expect(await gitGuard(repo, true)).toEqual([])
    await run(repo, ['status', '--porcelain'])
    await run(repo, ['blame', 'a.txt']).catch(() => {}) // the required filter has no smudge: fails — after running the rest
    await writeFile(join(repo, 'a.txt'), 'again\n')
    await run(repo, ['commit', '-qam', 'three'])
    expect(await pwned(repo)).toEqual(['PWNED-filter', 'PWNED-fsmonitor', 'PWNED-hook', 'PWNED-textconv'])
  })

  it('outside any repository: only the fixed overrides', async () => {
    const dir = await tempDir()
    const overrides = await untrustedOverrides(dir)
    expect(overrides.slice(0, UNTRUSTED_GIT.length)).toEqual(UNTRUSTED_GIT)
    expect(overrides.filter(([k]) => /^(filter|diff|merge)\./.test(k) && /local/.test(k))).toEqual([])
  })

  it('reads `git config --list -z`, with or without scopes', () => {
    expect(parseConfigList('local\0core.bare\nfalse\0local\0core.fsmonitor\0global\0a.b\nx\ny\0', true)).toEqual([
      { scope: 'local', key: 'core.bare', value: 'false' },
      { scope: 'local', key: 'core.fsmonitor', value: '' },
      { scope: 'global', key: 'a.b', value: 'x\ny' }
    ])
    expect(parseConfigList('a.b\nc', false)).toEqual([{ scope: undefined, key: 'a.b', value: 'c' }])
    expect(parseConfigList('', false)).toEqual([])
    expect(parseConfigList('local', true)).toEqual([{ scope: 'local', key: '', value: '' }])
  })

  it('what the repository sets gets the user’s own value or one that runs nothing; lists are cleared and refilled', () => {
    const e = (scope: string | undefined, key: string, value = '') => ({ scope, key, value })
    expect(
      neutralize([
        e('system', 'credential.helper', 'osxkeychain'),
        e('global', 'core.sshcommand', 'ssh -i ~/.ssh/work'),
        e('global', 'gpg.program', '/usr/local/bin/gpg2'),
        e('local', 'filter.Evil.clean', 'x'),
        e('local', 'filter.Evil.smudge', 'x'),
        e('local', 'filter.Evil.required', 'true'),
        e('worktree', 'diff.tc.textconv', 'x'),
        e('local', 'diff.external', 'x'),
        e('local', 'merge.m.driver', 'x'),
        e('local', 'core.sshcommand', 'evil'),
        e('local', 'core.askpass', 'evil'),
        e('local', 'credential.helper', 'evil'),
        e('local', 'credential.helper', 'evil2'),
        e('local', 'credential.https://x.com.helper', 'evil'),
        e('local', 'gpg.program', 'evil'),
        e('local', 'gpg.x509.program', 'evil'),
        e('local', 'gpg.ssh.program', 'evil'),
        e('local', 'gpg.ssh.defaultkeycommand', 'evil'),
        e('local', 'remote.origin.uploadpack', 'evil'),
        e('local', 'remote.origin.receivepack', 'evil'),
        e('local', 'core.alternaterefscommand', 'evil'),
        e('local', 'user.name', 'harmless'),
        e('command', 'core.sshcommand', 'from the environment')
      ])
    ).toEqual([
      ['filter.Evil.clean', ''],
      ['filter.Evil.required', 'false'],
      ['filter.Evil.smudge', ''],
      ['diff.tc.textconv', ''],
      ['diff.external', ''],
      ['merge.m.driver', ''],
      ['core.sshcommand', 'from the environment'],
      ['core.askpass', ''],
      ['credential.helper', ''],
      ['credential.helper', 'osxkeychain'],
      ['credential.https://x.com.helper', ''],
      ['gpg.program', '/usr/local/bin/gpg2'],
      ['gpg.x509.program', 'gpgsm'],
      ['gpg.ssh.program', 'ssh-keygen'],
      ['gpg.ssh.defaultkeycommand', ''],
      ['remote.origin.uploadpack', 'git-upload-pack'],
      ['remote.origin.receivepack', 'git-receive-pack'],
      ['core.alternaterefscommand', '']
    ])
    // Old git can't say where an entry comes from: every one counts as the repository's.
    expect(neutralize([e(undefined, 'core.sshcommand', 'ssh -i key')])).toEqual([['core.sshcommand', 'ssh']])
    expect(neutralize([e('global', 'filter.lfs.clean', 'git-lfs clean')])).toEqual([])
  })

  it('refuses what can’t be overridden: a first-match key, a driver named with "="', () => {
    expect(() => neutralize([{ scope: 'local', key: 'core.gitproxy', value: 'evil' }])).toThrow(expect.objectContaining({ code: 'git-untrusted' }))
    expect(() => neutralize([{ scope: 'local', key: 'filter.a=b.clean', value: 'evil' }])).toThrow(expect.objectContaining({ code: 'git-untrusted' }))
    expect(neutralize([{ scope: 'global', key: 'core.gitproxy', value: 'mine' }])).toEqual([])
  })

  it('git older than 2.26 (no --show-scope): the plain list, every risky key neutralized; failing both, the call fails', async () => {
    const exec = vi.fn(async (args: string[]) => {
      if (args.includes('--show-scope')) throw new Error('unknown option')
      return 'credential.helper\nstore\0'
    })
    const overrides = await untrustedOverrides('/repo', exec)
    expect(overrides.slice(UNTRUSTED_GIT.length)).toEqual([['credential.helper', '']])
    expect(exec.mock.calls[0][0].slice(0, 2)).toEqual(['-c', 'core.fsmonitor=false'])
    await expect(untrustedOverrides('/repo', async () => Promise.reject(new Error('bad config')))).rejects.toThrow('bad config')
  })

  it('as arguments, and as GIT_CONFIG_PARAMETERS for git that gh starts (quoted, after what is set already)', async () => {
    expect(overrideArgs([['a.b', 'c d']])).toEqual(['-c', 'a.b=c d'])
    expect(overrideEnv([['a.b', "it's"], ['c.d', '']])).toBe(`'a.b=it'\\''s' 'c.d='`)
    expect(overrideEnv([['a.b', 'c']], "'x.y=z'")).toBe(`'x.y=z' 'a.b=c'`)
    // git itself reads them back.
    const dir = await tempDir()
    await mkdir(join(dir, 'x'))
    const { stdout } = await promisify(execFile)(gitProgram(), ['config', '--get', 'a.b'], {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_PARAMETERS: overrideEnv([['a.b', "it's"]]) }
    })
    expect(stdout.trim()).toBe("it's")
  })
})
