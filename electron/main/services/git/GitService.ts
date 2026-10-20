import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { FileChange } from '@shared/types/agents'
import { gitGuard, gitProgram } from '../../lib/git'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Run git with array args (never a shell string); optional stdin. Rejects with stderr on failure. */
async function git(cwd: string, guard: Promise<string[]>, args: string[], input?: string): Promise<string> {
  const prefix = await guard
  return new Promise((resolve, reject) => {
    const child = spawn(gitProgram(), [...prefix, ...args], { cwd, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(coded('git', err.trim() || `git ${args[0]} failed (${code})`))))
    child.stdin.end(input)
  })
}

/** A network call that only checks something: never asks for credentials, gives up after 15 s. */
const quietGit = async (cwd: string, guard: Promise<string[]>, args: string[]) =>
  promisify(execFile)(gitProgram(), [...(await guard), ...args], { cwd, timeout: 15_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

const lines = (s: string) => s.split('\n').filter(Boolean)

/** Pathspecs for "everything except …" (e.g. a node_modules link in a worktree). */
const except = (exclude: string[]) => (exclude.length ? ['--', '.', ...exclude.map((p) => `:(exclude)${p}`)] : [])

/**
 * A remote's address as a web page: `git@host:owner/repo.git` and
 * `https://user:token@host/owner/repo.git` → `https://host/owner/repo`.
 * Credentials never make it into the link. Undefined for anything else.
 */
export function remoteWebUrl(remote: string): string | undefined {
  const r = remote.trim()
  const m =
    /^(?:ssh:\/\/)?git@([^:/]+)(?::\d+(?=\/))?[:/](.+?)(?:\.git)?\/?$/.exec(r) ?? /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(r)
  if (!m || !m[2].includes('/')) return undefined
  return `https://${m[1]}/${m[2]}`
}

/** Where an agent session started: the commit to diff against, plus files that were already untracked. */
export interface GitBaseline {
  base: string
  untracked: string[]
}

/**
 * The git side of the agent cockpit: a baseline when a session starts, what
 * changed since, the old version of a file, and isolated worktrees for agents
 * that work in parallel. Read-only on the user's project except `applyTo`,
 * which the user triggers explicitly ("Übernehmen").
 */
export class GitService {
  /** `trusted`: whether a folder belongs to a trusted project (WorkspaceTrust) — restricted git when not. */
  constructor(private readonly opts: { trusted?: (dir: string) => boolean } = {}) {}

  /** The untrusted overrides for git in `cwd`, when it needs them. */
  private guard(cwd: string): Promise<string[]> {
    return gitGuard(cwd, this.opts.trusted?.(cwd) ?? false)
  }
  async isRepo(cwd: string): Promise<boolean> {
    return git(cwd, this.guard(cwd), ['rev-parse', '--is-inside-work-tree']).then(
      (out) => out.trim() === 'true',
      () => false
    )
  }

  /** The repo's page on GitHub (or GitLab, …) from `origin`; undefined without one. */
  async webUrl(cwd: string): Promise<string | undefined> {
    return git(cwd, this.guard(cwd), ['remote', 'get-url', 'origin']).then(remoteWebUrl, () => undefined)
  }

  /** Whether `branch` is on origin (as of the last push or fetch). */
  async pushed(cwd: string, branch: string): Promise<boolean> {
    return git(cwd, this.guard(cwd), ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).then(
      () => true,
      () => false
    )
  }

  /**
   * Whether the commits on `branch` since `base` have all reached origin's
   * default branch — merged, fast-forwarded or rebased in. (A squash merge
   * makes new commits; the pull request tells that one.) Fetches it first.
   */
  async landed(cwd: string, branch: string, base: string): Promise<boolean> {
    try {
      const main = await git(cwd, this.guard(cwd), ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).then(
        (out) => out.trim(),
        () => git(cwd, this.guard(cwd), ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']).then(() => 'origin/main', () => 'origin/master')
      )
      await quietGit(cwd, this.guard(cwd), ['fetch', '--quiet', 'origin', main.slice('origin/'.length)]).catch(() => {})
      const count = async (range: string) => Number((await git(cwd, this.guard(cwd), ['rev-list', '--count', range])).trim())
      return (await count(`${base}..${branch}`)) > 0 && (await count(`${main}..${branch}`)) === 0
    } catch {
      return false
    }
  }

  /** How many files in a working folder are changed but not committed. */
  async uncommitted(cwd: string, exclude: string[] = []): Promise<number> {
    // Restricted: submodules (their own config unchecked) aren't looked into.
    const submodules = this.opts.trusted?.(cwd) ? [] : ['--ignore-submodules=all']
    return lines(await git(cwd, this.guard(cwd), ['status', '--porcelain', ...submodules, ...except(exclude)])).length
  }

  /**
   * The working tree as it is now, without touching it: `git stash create`
   * makes a commit of uncommitted edits (empty output when clean → HEAD).
   * Null outside a repo or before the first commit.
   */
  async baseline(cwd: string): Promise<GitBaseline | null> {
    try {
      const stash = (await git(cwd, this.guard(cwd), ['stash', 'create'])).trim()
      const base = stash || (await git(cwd, this.guard(cwd), ['rev-parse', 'HEAD'])).trim()
      return { base, untracked: lines(await git(cwd, this.guard(cwd), ['ls-files', '--others', '--exclude-standard'])) }
    } catch {
      return null
    }
  }

  /** Files changed since the baseline (tracked diff + files that became untracked since). */
  async changes(cwd: string, from: GitBaseline, exclude: string[] = []): Promise<FileChange[]> {
    const [numstat, names, untracked] = await Promise.all([
      git(cwd, this.guard(cwd), ['diff', '--no-renames', '--numstat', from.base, ...except(exclude)]),
      git(cwd, this.guard(cwd), ['diff', '--no-renames', '--name-status', from.base, ...except(exclude)]),
      git(cwd, this.guard(cwd), ['ls-files', '--others', '--exclude-standard', ...except(exclude)])
    ])
    const status = new Map(lines(names).map((l) => [l.slice(l.indexOf('\t') + 1), l[0]]))
    const changes: FileChange[] = lines(numstat).map((l) => {
      const [added, removed, path] = l.split('\t')
      const s = status.get(path)
      return {
        path,
        status: s === 'A' ? 'added' : s === 'D' ? 'deleted' : 'modified',
        added: added === '-' ? 0 : Number(added),
        removed: removed === '-' ? 0 : Number(removed)
      }
    })
    const before = new Set(from.untracked)
    for (const path of lines(untracked)) {
      if (before.has(path)) continue
      const text = await readFile(join(cwd, path), 'utf8').catch(() => '')
      changes.push({ path, status: 'added', added: text.includes('\0') ? 0 : lines(text).length, removed: 0 })
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path))
  }

  /** A file's content at the baseline ('' if it did not exist then). */
  async fileAt(cwd: string, base: string, path: string): Promise<string> {
    return git(cwd, this.guard(cwd), ['show', `${base}:${path}`]).catch(() => '')
  }

  /** A new worktree on a new branch from HEAD, for an agent working in parallel. */
  async addWorktree(repo: string, dir: string, branch: string): Promise<void> {
    await git(repo, this.guard(repo), ['worktree', 'add', '-b', branch, dir, 'HEAD'])
  }

  /** Remove a worktree and its branch (best effort for the branch). */
  async removeWorktree(repo: string, dir: string, branch: string): Promise<void> {
    await git(repo, this.guard(repo), ['worktree', 'remove', '--force', dir])
    await git(repo, this.guard(repo), ['branch', '-D', branch]).catch(() => '')
  }

  /**
   * Bring a worktree's changes (committed or not, new files included) into the
   * project as uncommitted edits. Refuses with `conflict` — touching nothing —
   * when they don't apply cleanly; the worktree stays as it is.
   */
  async applyTo(repo: string, worktree: string, base: string, exclude: string[] = []): Promise<number> {
    await git(worktree, this.guard(worktree), ['add', '-A', ...except(exclude)])
    const patch = await git(worktree, this.guard(worktree), ['diff', '--binary', '--cached', base])
    if (!patch.trim()) return 0
    await git(repo, this.guard(repo), ['apply', '--whitespace=nowarn', '-'], patch).catch((err: Error) => {
      throw coded('conflict', `The changes don't apply cleanly to the project: ${err.message}`)
    })
    return lines(await git(worktree, this.guard(worktree), ['diff', '--cached', '--name-only', base])).length
  }
}
