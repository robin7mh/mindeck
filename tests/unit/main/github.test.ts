import { chmod, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'
import { checkState, GitHubService, loginShellGh, shellRunner, type GhResult, type GhRunner } from '../../../electron/main/services/github/GitHubService'
import { repoName } from '@shared/types/github'
import type { ScmStatus } from '@shared/types/scm'

const ok = (stdout: unknown): GhResult => ({ code: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' })
const err = (stderr: string, code = 1): GhResult => ({ code, stdout: '', stderr })

/** A fake gh: answers by the joined arguments' first match. */
function fake(routes: [RegExp, GhResult | ((input?: string) => GhResult)][]) {
  const calls: { args: string[]; cwd: string; input?: string; env?: Record<string, string> }[] = []
  const gh: GhRunner = async (args, cwd, input, env) => {
    calls.push({ args, cwd, input, env })
    const line = args.join(' ')
    const hit = routes.find(([re]) => re.test(line))
    if (!hit) return err(`unrouted: ${line}`)
    return typeof hit[1] === 'function' ? hit[1](input) : hit[1]
  }
  return { gh, calls }
}

/** The project's git state as ScmService reports it: one commit, no remote. */
const scmState = (over: Partial<ScmStatus> = {}): ScmStatus => ({ repo: true, branch: 'main', head: 'abc1234', remotes: [], ahead: 0, behind: 0, merging: false, files: [], ...over })
const noScm = async () => scmState()

const service = (gh: GhRunner, root: string | undefined = '/repo', scm: (projectId: string) => Promise<ScmStatus> = noScm) => new GitHubService({ resolveRoot: () => root, trusted: () => true, gh, scm })

const rawPull = (over: Record<string, unknown> = {}) => ({
  number: 8,
  title: 'Develop',
  author: { login: 'robin' },
  headRefName: 'develop',
  baseRefName: 'main',
  isDraft: false,
  state: 'OPEN',
  updatedAt: '2026-10-10T01:00:00Z',
  url: 'https://github.com/o/r/pull/8',
  reviewDecision: '',
  additions: 3,
  deletions: 1,
  ...over
})

describe('GitHub through gh', () => {
  it('status: not installed, signed out, no repository, or the repository', async () => {
    expect(await service(fake([[/api user/, err('zsh: command not found: gh', 127)]]).gh).status('p')).toEqual({ installed: false })
    expect(await service(fake([[/api user/, err('To get started with GitHub CLI, please run:  gh auth login', 4)]]).gh).status('p')).toEqual({ installed: true })
    expect(await service(fake([[/api user/, ok('robin\n')], [/repo view/, err('no git remotes found')]]).gh).status('p')).toEqual({ installed: true, user: 'robin', error: 'no git remotes found' })
    const full = fake([
      [/api user/, ok('robin\n')],
      [/repo view/, ok({ nameWithOwner: 'o/r', url: 'https://github.com/o/r', defaultBranchRef: { name: 'main' } })]
    ])
    expect(await service(full.gh).status('p')).toEqual({ installed: true, user: 'robin', repo: { nameWithOwner: 'o/r', url: 'https://github.com/o/r', defaultBranch: 'main' } })
    expect(full.calls[0].cwd).toBe('/repo')
    const empty = fake([
      [/api user/, ok('robin')],
      [/repo view/, ok({ nameWithOwner: 'o/r', url: 'u', defaultBranchRef: null })]
    ])
    expect((await service(empty.gh).status('p')).repo).toEqual({ nameWithOwner: 'o/r', url: 'u', defaultBranch: undefined })
    // Other failures (network …) are errors.
    await expect(service(fake([[/api user/, err('error connecting to api.github.com\n')]]).gh).status('p')).rejects.toMatchObject({ code: 'gh', message: 'error connecting to api.github.com' })
    await expect(service(fake([[/api user/, err('', 2)]]).gh).status('p')).rejects.toMatchObject({ message: 'gh exited with 2' })
    await expect(new GitHubService({ resolveRoot: () => undefined, gh: fake([]).gh, scm: noScm }).status('p')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('lists pull requests: all, mine, to review; any state', async () => {
    const { gh, calls } = fake([[/pr list/, ok([rawPull(), rawPull({ number: 9, author: null, isDraft: true, reviewDecision: 'APPROVED' })])]])
    const s = service(gh)
    const pulls = await s.list('p')
    expect(pulls[0]).toEqual({ number: 8, title: 'Develop', author: 'robin', head: 'develop', base: 'main', draft: false, state: 'OPEN', updatedAt: '2026-10-10T01:00:00Z', url: 'https://github.com/o/r/pull/8', review: undefined, additions: 3, deletions: 1 })
    expect(pulls[1]).toMatchObject({ author: 'ghost', draft: true, review: 'APPROVED' })
    await s.list('p', 'mine', 'merged')
    await s.list('p', 'review', 'all')
    expect(calls.map((c) => c.args.slice(2).filter((a) => !a.includes(',')).join(' '))).toEqual([
      '--state open --limit 100 --json',
      '--state merged --limit 100 --json --author @me',
      '--state all --limit 100 --json --search review-requested:@me'
    ])
  })

  it('a pull request: checks, files, conversation in order, commits', async () => {
    const { gh } = fake([
      [
        /pr view 8 --json/,
        ok({
          ...rawPull({ reviewDecision: 'CHANGES_REQUESTED' }),
          body: 'Hello',
          createdAt: '2026-10-09T00:00:00Z',
          mergeable: 'MERGEABLE',
          labels: [{ name: 'feature' }],
          changedFiles: 2,
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'Tests', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci/1' },
            { __typename: 'StatusContext', context: 'deploy', state: 'PENDING', targetUrl: 'https://ci/2' },
            { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }
          ],
          files: [
            { path: 'a.ts', changeType: 'MODIFIED', additions: 2, deletions: 1 },
            { path: 'b.ts', additions: 1, deletions: 0 }
          ],
          comments: [{ author: { login: 'ann' }, body: 'Nice', createdAt: '2026-10-09T02:00:00Z' }],
          reviews: [
            { author: { login: 'bob' }, body: 'Fix this', submittedAt: '2026-10-09T01:00:00Z', state: 'CHANGES_REQUESTED' },
            { author: null, body: '', submittedAt: '2026-10-09T03:00:00Z', state: 'PENDING' },
            { author: { login: 'cy' }, body: '', submittedAt: '2026-10-09T04:00:00Z', state: 'SOMETHING_NEW' }
          ],
          commits: [
            { oid: 'abc1234def', messageHeadline: 'feat: x', authoredDate: '2026-10-09T00:00:00Z', authors: [{ login: 'robin', name: 'Robin' }] },
            { oid: 'b', messageHeadline: 'y', authoredDate: 'd', authors: [{ login: '', name: 'Ann' }] },
            { oid: 'c', messageHeadline: 'z', authoredDate: 'd', authors: [] }
          ]
        })
      ]
    ])
    const pr = await service(gh).view('p', 8)
    expect(pr).toMatchObject({ number: 8, body: 'Hello', mergeable: 'MERGEABLE', labels: ['feature'], review: 'CHANGES_REQUESTED', changedFiles: 2 })
    expect(pr.checks).toEqual([
      { name: 'Tests', state: 'success', url: 'https://ci/1' },
      { name: 'deploy', state: 'pending', url: 'https://ci/2' },
      { name: '?', state: 'pending', url: undefined }
    ])
    expect(pr.files).toEqual([
      { path: 'a.ts', change: 'modified', additions: 2, deletions: 1 },
      { path: 'b.ts', change: 'changed', additions: 1, deletions: 0 }
    ])
    expect(pr.events.map((e) => `${e.author}:${e.kind}`)).toEqual(['bob:changes-requested', 'ann:comment', 'cy:reviewed'])
    expect(pr.commits.map((c) => c.author)).toEqual(['robin', 'Ann', '?'])

    const bare = fake([[/pr view/, ok({ ...rawPull(), body: '', createdAt: '', mergeable: 'UNKNOWN', labels: [], statusCheckRollup: null, files: null, comments: [], reviews: [], commits: [] })]])
    expect(await service(bare.gh).view('p', 8)).toMatchObject({ checks: [], files: [] })
  })

  it('check states', () => {
    expect(['SUCCESS', 'FAILURE', 'TIMED_OUT', 'SKIPPED', 'NEUTRAL', 'STALE', 'QUEUED'].map((conclusion) => checkState({ conclusion }))).toEqual(['success', 'failure', 'failure', 'skipped', 'neutral', 'neutral', 'pending'])
    expect(checkState({ state: 'error' })).toBe('failure')
    expect(checkState({})).toBe('pending')
  })

  it('a file of a pull request: merge base vs. head; added, removed, renamed; binary as empty; the comparison is reused', async () => {
    const { gh, calls } = fake([
      [/pr view 8 --json baseRefOid/, ok({ baseRefOid: 'B', headRefOid: 'H' })],
      [
        /compare\/B\.\.\.H/,
        ok({
          base: 'M',
          files: [
            { filename: 'src/a b.ts', status: 'modified' },
            { filename: 'new.ts', status: 'added' },
            { filename: 'gone.ts', status: 'removed' },
            { filename: 'moved.ts', status: 'renamed', previous_filename: 'old.ts' },
            { filename: 'logo.png', status: 'modified' }
          ]
        })
      ],
      [/contents\/src\/a%20b\.ts\?ref=M/, ok('before')],
      [/contents\/src\/a%20b\.ts\?ref=H/, ok('after')],
      [/contents\/new\.ts\?ref=H/, ok('fresh')],
      [/contents\/gone\.ts\?ref=M/, ok('old content')],
      [/contents\/old\.ts\?ref=M/, ok('was here')],
      [/contents\/moved\.ts\?ref=H/, ok('is here')],
      [/contents\/logo\.png/, ok('\x89PNG\0\0')],
      [/contents\/unknown\.ts\?ref=M/, err('HTTP 404: Not Found')],
      [/contents\/unknown\.ts\?ref=H/, ok('x')]
    ])
    const s = service(gh)
    expect(await s.fileDiff('p', 8, 'src/a b.ts')).toEqual({ path: 'src/a b.ts', original: 'before', modified: 'after' })
    expect(await s.fileDiff('p', 8, 'new.ts')).toEqual({ path: 'new.ts', original: '', modified: 'fresh' })
    expect(await s.fileDiff('p', 8, 'gone.ts')).toEqual({ path: 'gone.ts', original: 'old content', modified: '' })
    expect(await s.fileDiff('p', 8, 'moved.ts')).toEqual({ path: 'moved.ts', original: 'was here', modified: 'is here' })
    expect(await s.fileDiff('p', 8, 'logo.png')).toEqual({ path: 'logo.png', original: '', modified: '' })
    expect(await s.fileDiff('p', 8, 'unknown.ts')).toEqual({ path: 'unknown.ts', original: '', modified: 'x' })
    expect(calls.filter((c) => c.args.join(' ').includes('compare'))).toHaveLength(1)
    expect(calls.find((c) => c.args.includes('-H'))!.args.slice(0, 3)).toEqual(['api', '-H', 'Accept: application/vnd.github.raw'])
  })

  it('acts: checkout, create (body on stdin), merge, comment, review', async () => {
    const { gh, calls } = fake([
      [/pr checkout 8/, ok('')],
      [/pr create/, ok('Warning: 1 uncommitted change\nhttps://github.com/o/r/pull/12\n')],
      [/pr merge/, ok('')],
      [/pr comment/, ok('')],
      [/pr review/, ok('')]
    ])
    const s = service(gh)
    await s.checkout('p', 8)
    expect(await s.create('p', { title: 'Add x', body: '## Why\nBecause', base: 'main', draft: true })).toEqual({ number: 12, url: 'https://github.com/o/r/pull/12' })
    expect(await s.create('p', { title: 'Add y', body: '' })).toEqual({ number: 12, url: 'https://github.com/o/r/pull/12' })
    await s.merge('p', 8, 'squash', true)
    await s.merge('p', 8, 'rebase')
    await s.comment('p', 8, 'LGTM')
    await s.review('p', 8, 'approve')
    await s.review('p', 8, 'request-changes', 'Please fix')
    expect(calls.map((c) => [c.args.join(' '), c.input])).toEqual([
      ['pr checkout 8', undefined],
      ['pr create --title Add x --body-file - --base main --draft', '## Why\nBecause'],
      ['pr create --title Add y --body-file -', ''],
      ['pr merge 8 --squash --delete-branch', undefined],
      ['pr merge 8 --rebase', undefined],
      ['pr comment 8 --body-file -', 'LGTM'],
      ['pr review 8 --approve --body-file -', ''],
      ['pr review 8 --request-changes --body-file -', 'Please fix']
    ])
    const odd = fake([[/pr create/, ok('created\n')]])
    expect(await service(odd.gh).create('p', { title: 't', body: '' })).toEqual({ number: 0, url: 'created' })
    await expect(service(fake([[/pr merge/, err('Pull request is not mergeable: the merge commit cannot be cleanly created.')]]).gh).merge('p', 8, 'merge')).rejects.toMatchObject({
      code: 'gh',
      message: 'Pull request is not mergeable: the merge commit cannot be cleanly created.'
    })
  })

  it('owners: the account, then its organizations — without read:org just the account', async () => {
    const both = fake([
      [/api user\/orgs/, ok('acme\nlabs\n')],
      [/api user/, ok('robin\n')]
    ])
    expect(await service(both.gh).owners('p')).toEqual({ user: 'robin', orgs: ['acme', 'labs'] })
    expect(both.calls.every((c) => c.cwd === '/repo')).toBe(true)
    const noOrgs = fake([
      [/api user\/orgs/, err('HTTP 403: Resource not accessible (read:org)')],
      [/api user/, ok('robin')]
    ])
    expect(await service(noOrgs.gh).owners('p')).toEqual({ user: 'robin', orgs: [] })
    // Not signed in: that is the error, so the form can say how to sign in.
    await expect(service(fake([[/api user/, err('To get started with GitHub CLI, please run:  gh auth login', 4)]]).gh).owners('p')).rejects.toMatchObject({ code: 'gh-auth' })
  })

  it('publish: creates the repository under the account or an organization, as origin, and pushes; needs a commit and no origin', async () => {
    const made = { nameWithOwner: 'robin/test', url: 'https://github.com/robin/test' }
    const { gh, calls } = fake([
      [/repo create/, ok('https://github.com/robin/test\n')],
      [/repo view/, ok(made)]
    ])
    expect(await service(gh).publish('p', { name: 'test', owner: 'robin', private: true })).toEqual(made)
    expect(calls.map((c) => c.args)).toEqual([
      ['repo', 'create', 'robin/test', '--private', '--source=.', '--remote=origin', '--push'],
      ['repo', 'view', '--json', 'nameWithOwner,url']
    ])
    expect(calls[0].cwd).toBe('/repo')
    // Public, the account gh is signed in with, a description that starts like an option stays a value.
    await service(gh).publish('p', { name: 'site', private: false, description: '--admin tool' })
    expect(calls[2].args).toEqual(['repo', 'create', 'site', '--public', '--source=.', '--remote=origin', '--push', '--description=--admin tool'])
    // A core that does not list remotes yet: gh decides.
    await service(gh, '/repo', async () => scmState({ remotes: undefined })).publish('p', { name: 'x', private: true })
    expect(calls).toHaveLength(6)

    await expect(service(gh, '/repo', async () => scmState({ head: undefined })).publish('p', { name: 'x', private: true })).rejects.toMatchObject({ code: 'no-commits' })
    await expect(service(gh, '/repo', async () => scmState({ remotes: ['origin'] })).publish('p', { name: 'x', private: true })).rejects.toMatchObject({ code: 'has-remote' })
    expect(calls).toHaveLength(6)
    // gh's own failure (a name already taken) as it says it.
    await expect(service(fake([[/repo create/, err('GraphQL: Name already exists on this account (createRepository)')]]).gh).publish('p', { name: 'x', private: true })).rejects.toMatchObject({
      code: 'gh',
      message: 'GraphQL: Name already exists on this account (createRepository)'
    })
  })

  it('a folder’s name as a repository name', () => {
    expect(repoName('test')).toBe('test')
    expect(repoName('  Mein Projekt (alt)  ')).toBe('Mein-Projekt-alt')
    expect(repoName('--flag')).toBe('flag')
    expect(repoName('Über Größe')).toBe('Uber-Grosse')
    expect(repoName('x'.repeat(120))).toHaveLength(100)
    expect(repoName('..')).toBe('')
    expect(repoName('日本')).toBe('')
  })

  it('in a project that isn’t trusted, the git gh runs gets Mindeck’s untrusted overrides (hooks, filters off)', async () => {
    const repo = await tempDir('mindeck-gh-repo-')
    await promisify(execFile)('git', ['init', '-q'], { cwd: repo })
    await promisify(execFile)('git', ['config', 'filter.evil.clean', 'touch pwned'], { cwd: repo })
    const { gh, calls } = fake([[/pr checkout/, ok('')]])
    const saved = process.env.GIT_CONFIG_PARAMETERS
    process.env.GIT_CONFIG_PARAMETERS = "'user.name=Me'"
    try {
      await new GitHubService({ resolveRoot: () => repo, gh, scm: noScm }).checkout('p', 8)
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_PARAMETERS
      else process.env.GIT_CONFIG_PARAMETERS = saved
    }
    const params = calls[0].env!.GIT_CONFIG_PARAMETERS
    expect(params.startsWith("'user.name=Me' ")).toBe(true)
    expect(params).toContain("'core.fsmonitor=false'")
    expect(params).toContain("'filter.evil.clean='")
    expect(params).toContain("'filter.evil.required=false'")
    // Trusted: gh's git as the user set it up.
    const trusted = fake([[/pr checkout/, ok('')]])
    await new GitHubService({ resolveRoot: () => repo, trusted: () => true, gh: trusted.gh, scm: noScm }).checkout('p', 8)
    expect(trusted.calls[0].env).toBeUndefined()
  })

  it('runs the real program from the login shell: arguments, stdin, output, exit code; missing folder; timeout', async () => {
    const dir = await tempDir('mindeck-gh-')
    const bin = join(dir, 'fake-gh')
    await writeFile(bin, '#!/bin/sh\necho "args:$*"\ncat\necho oops >&2\nexit 3\n')
    await chmod(bin, 0o755)
    expect(await shellRunner(bin)(['pr', 'view', 'it’s'], dir, 'from stdin')).toEqual({ code: 3, stdout: 'args:pr view it’s\nfrom stdin', stderr: 'oops\n' })
    expect((await shellRunner(bin)([], '/definitely/not/here')).code).toBe(127)
    const slow = join(dir, 'slow-gh')
    await writeFile(slow, '#!/bin/sh\nsleep 5\n')
    await chmod(slow, 0o755)
    expect((await shellRunner(slow, 100)([], dir)).code).toBe(1) // killed
    // Extra environment reaches it.
    const envBin = join(dir, 'env-gh')
    await writeFile(envBin, '#!/bin/sh\necho "$GIT_CONFIG_PARAMETERS"\n')
    await chmod(envBin, 0o755)
    expect((await shellRunner(envBin)([], dir, undefined, { GIT_CONFIG_PARAMETERS: "'a.b=c'" })).stdout).toBe("'a.b=c'\n")
    // Windows starts it directly (no login shell) — a bare name from the PATH only, never the one in the project folder.
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    expect((await shellRunner(bin)(['x'], dir)).stdout).toBe('args:x\n')
    expect((await shellRunner('fake-gh')(['x'], dir)).code).toBe(127)
    platform.mockRestore()
    expect(typeof loginShellGh).toBe('function')
  }, 20_000)
})
