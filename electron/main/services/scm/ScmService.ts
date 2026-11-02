import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type {
  ScmBranch,
  ScmChange,
  ScmCommit,
  ScmCommitDetail,
  ScmCommitFile,
  ScmDiffTarget,
  ScmFile,
  ScmStatus,
  SearchQuery,
  SearchResult
} from '@shared/types/scm'
import type { FileDiff } from '@shared/types/agents'
import { confine } from '../../lib/confine'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Network calls (push, pull, fetch) may take a while; everything else is local and quick. */
const LOCAL_MS = 30_000
const NETWORK_MS = 120_000
/** Caps that keep a huge folder from flooding the UI. */
export const SCM_LIMITS = { files: 20_000, matches: 1000, line: 300 }
/** Folders the quick-open walk skips outside a git repository. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', 'coverage'])

const CHANGE: Record<string, ScmChange> = { M: 'modified', T: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied' }

/**
 * Runs the user's own git — their config, credential helper and SSH agent —
 * with array args (never a shell string). Never waits for a terminal prompt or
 * an editor: a credential git can't find fails with git's message instead.
 */
function git(cwd: string, args: string[], timeout = LOCAL_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd,
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' }
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout)
        const exit = (err as { code?: number | string }).code
        // spawn ENOENT: no git — unless the folder itself is gone.
        if (exit === 'ENOENT' && existsSync(cwd)) return reject(Object.assign(coded('git-missing', 'Git is not installed on this machine'), { exit }))
        const why = String(stderr).trim().split('\n').filter(Boolean).slice(-3).join('\n')
        reject(Object.assign(coded('git', why || err.message), { exit }))
      }
    )
  })
}

const exitOf = (err: unknown) => (err as { exit?: number | string }).exit

/** `git status --porcelain=v2 -z` → branch info and changed files. */
export function parseStatus(raw: string): Omit<ScmStatus, 'repo' | 'merging'> {
  const status: Omit<ScmStatus, 'repo' | 'merging'> = { ahead: 0, behind: 0, files: [] }
  const fields = raw.split('\0')
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i]
    if (f.startsWith('# branch.oid ')) {
      const oid = f.slice('# branch.oid '.length)
      if (oid !== '(initial)') status.head = oid.slice(0, 7)
    } else if (f.startsWith('# branch.head ')) {
      const head = f.slice('# branch.head '.length)
      if (head !== '(detached)') status.branch = head
    } else if (f.startsWith('# branch.upstream ')) {
      status.upstream = f.slice('# branch.upstream '.length)
    } else if (f.startsWith('# branch.ab ')) {
      const [a, b] = f.slice('# branch.ab '.length).split(' ')
      status.ahead = Number(a.slice(1))
      status.behind = Number(b.slice(1))
    } else if (f.startsWith('1 ') || f.startsWith('2 ')) {
      const parts = f.split(' ')
      const xy = parts[1]
      const file: ScmFile = { path: parts.slice(f.startsWith('1 ') ? 8 : 9).join(' ') }
      if (f.startsWith('2 ')) file.from = fields[++i]
      if (xy[0] !== '.') file.staged = CHANGE[xy[0]]
      if (xy[1] !== '.') file.unstaged = CHANGE[xy[1]]
      status.files.push(file)
    } else if (f.startsWith('u ')) {
      status.files.push({ path: f.split(' ').slice(10).join(' '), unstaged: 'conflicted' })
    } else if (f.startsWith('? ')) {
      status.files.push({ path: f.slice(2), unstaged: 'untracked' })
    }
  }
  return status
}

/** One commit per record: hash, parents, author, date, subject, refs. */
export function parseLog(raw: string): ScmCommit[] {
  return raw
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash, parents, author, date, subject, refs] = r.split('\x1f')
      return {
        hash,
        parents: parents ? parents.split(' ') : [],
        author,
        date: Number(date) * 1000,
        subject,
        refs: refs ? refs.split(', ').filter(Boolean) : []
      }
    })
}

/** `git diff-tree --name-status -z` → the files a commit touched. */
export function parseNameStatus(raw: string): ScmCommitFile[] {
  const fields = raw.split('\0').filter(Boolean)
  const files: ScmCommitFile[] = []
  for (let i = 0; i < fields.length; i += 1) {
    const code = fields[i][0]
    if (code === 'R' || code === 'C') {
      files.push({ from: fields[i + 1], path: fields[i + 2], change: CHANGE[code] })
      i += 2
    } else {
      files.push({ path: fields[i + 1], change: CHANGE[code] ?? 'modified' })
      i += 1
    }
  }
  return files
}

/**
 * Source control for a project, the way VS Code's Git view does it: status,
 * staging, commits, push / pull / fetch, branches, the history for a graph,
 * diffs — and, because it is quick with git, the file list for quick open and
 * text search (`git grep`, which also works outside a repository).
 */
export class ScmService {
  constructor(
    private readonly resolveRoot: (projectId: string) => string | undefined,
    private readonly limits = SCM_LIMITS
  ) {}

  async status(projectId: string): Promise<ScmStatus> {
    const root = this.root(projectId)
    let raw: string
    try {
      raw = await git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
    } catch (err) {
      if (/not a git repository/i.test((err as Error).message)) return { repo: false, ahead: 0, behind: 0, merging: false, files: [] }
      throw err
    }
    const mergeHead = (await git(root, ['rev-parse', '--git-path', 'MERGE_HEAD'])).trim()
    // --git-path is absolute in linked worktrees (`resolve`, not `join`).
    return { repo: true, merging: existsSync(resolve(root, mergeHead)), ...parseStatus(raw) }
  }

  async init(projectId: string): Promise<ScmStatus> {
    await git(this.root(projectId), ['init', '-q'])
    return this.status(projectId)
  }

  async stage(projectId: string, paths: string[]): Promise<void> {
    await git(this.root(projectId), ['add', '-A', '--', ...paths])
  }

  async unstage(projectId: string, paths: string[]): Promise<void> {
    const root = this.root(projectId)
    if (await this.hasHead(root)) await git(root, ['restore', '--staged', '--', ...paths])
    else await git(root, ['rm', '--cached', '-r', '-q', '--', ...paths])
  }

  /** Throws away working-tree changes; untracked files are deleted (the UI asks first). */
  async discard(projectId: string, paths: string[]): Promise<void> {
    const root = this.root(projectId)
    const untracked = new Set((await this.status(projectId)).files.filter((f) => f.unstaged === 'untracked').map((f) => f.path))
    const tracked = paths.filter((p) => !untracked.has(p))
    const fresh = paths.filter((p) => untracked.has(p))
    if (tracked.length) await git(root, ['restore', '--', ...tracked])
    if (fresh.length) await git(root, ['clean', '-f', '-q', '--', ...fresh])
  }

  /** Commit the index; `all` stages every change first (VS Code's "smart commit"). */
  async commit(projectId: string, message: string, opts: { amend?: boolean; all?: boolean } = {}): Promise<void> {
    const root = this.root(projectId)
    if (opts.all) await git(root, ['add', '-A'])
    const text = message.trim()
    if (!text && !opts.amend) throw coded('bad-input', 'A commit needs a message')
    await git(root, ['commit', '-q', ...(opts.amend ? ['--amend'] : []), ...(text ? ['-m', text] : ['--no-edit'])])
  }

  async fetch(projectId: string): Promise<void> {
    await git(this.root(projectId), ['fetch', '--all', '--prune', '--quiet'], NETWORK_MS)
  }

  /** Pull with the user's own pull settings (merge or rebase); conflicts show up in the status. */
  async pull(projectId: string): Promise<void> {
    await git(this.root(projectId), ['pull', '--no-edit', '--quiet'], NETWORK_MS)
  }

  /** Push; a branch without upstream is published to `origin`. */
  async push(projectId: string): Promise<void> {
    const root = this.root(projectId)
    const { upstream } = await this.status(projectId)
    if (upstream) return void (await git(root, ['push', '--quiet'], NETWORK_MS))
    if (!(await git(root, ['remote'])).split('\n').includes('origin')) throw coded('no-remote', 'This repository has no remote "origin" to push to')
    await git(root, ['push', '--quiet', '-u', 'origin', 'HEAD'], NETWORK_MS)
  }

  async branches(projectId: string): Promise<ScmBranch[]> {
    const raw = await git(this.root(projectId), ['for-each-ref', '--format=%(refname)%1f%(HEAD)%1f%(upstream:short)', 'refs/heads', 'refs/remotes'])
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\x1f'))
      .filter(([ref]) => !ref.endsWith('/HEAD'))
      .map(([ref, head, upstream]) => {
        const remote = ref.startsWith('refs/remotes/')
        return {
          name: ref.slice(remote ? 'refs/remotes/'.length : 'refs/heads/'.length),
          remote,
          current: head === '*',
          ...(upstream ? { upstream } : {})
        }
      })
  }

  /** Switch branches; a remote branch gets a local tracking branch of the same name. */
  async checkout(projectId: string, name: string): Promise<void> {
    const root = this.root(projectId)
    const remote = (await this.branches(projectId)).find((b) => b.remote && b.name === name)
    if (!remote) return void (await git(root, ['switch', '--', name]))
    const local = name.slice(name.indexOf('/') + 1)
    await git(root, ['switch', '--track', '-c', local, name])
  }

  async createBranch(projectId: string, name: string): Promise<void> {
    const root = this.root(projectId)
    await git(root, ['check-ref-format', '--branch', name]).catch(() => {
      throw coded('bad-input', `"${name}" is not a valid branch name`)
    })
    await git(root, ['switch', '-c', name])
  }

  /** The newest commits of every branch, newest first — enough for the graph. */
  async log(projectId: string, limit = 300): Promise<ScmCommit[]> {
    const root = this.root(projectId)
    if (!(await this.hasHead(root))) return []
    const raw = await git(root, ['log', '--all', '--date-order', `-n${limit}`, '--pretty=format:%H%x1f%P%x1f%an%x1f%at%x1f%s%x1f%D%x1e'])
    return parseLog(raw)
  }

  async show(projectId: string, hash: string): Promise<ScmCommitDetail> {
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw coded('bad-input', 'Not a commit hash')
    const root = this.root(projectId)
    const head = await git(root, ['show', '--no-patch', '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%B', hash])
    const [full, author, email, date, message] = head.split('\x1f')
    const files = parseNameStatus(await git(root, ['diff-tree', '--no-commit-id', '-r', '-M', '--root', '--name-status', '-z', hash]))
    return { hash: full, author, email, date: Number(date) * 1000, message: message.trim(), files }
  }

  /** Before → after of one file: working tree vs. index, index vs. HEAD, or a commit vs. its parent. */
  async diff(projectId: string, path: string, target: ScmDiffTarget): Promise<FileDiff> {
    const root = this.root(projectId)
    const blob = (spec: string) => git(root, ['show', spec]).catch(() => '')
    if (target.kind === 'unstaged') {
      const abs = await confine(root, path)
      return { path, original: await blob(`:${path}`), modified: await readFile(abs, 'utf8').catch(() => '') }
    }
    if (target.kind === 'staged') return { path, original: await blob(`HEAD:${path}`), modified: await blob(`:${path}`) }
    if (!/^[0-9a-f]{4,40}$/i.test(target.hash)) throw coded('bad-input', 'Not a commit hash')
    return { path, original: await blob(`${target.hash}^:${target.from ?? path}`), modified: await blob(`${target.hash}:${path}`) }
  }

  /**
   * The staged (index) text of a file — what the editor's gutter compares the
   * buffer with, like VS Code. Null for untracked files and outside a repo.
   */
  async original(projectId: string, path: string): Promise<string | null> {
    const root = this.root(projectId)
    await confine(root, path)
    return git(root, ['show', `:./${path}`]).catch(() => null)
  }

  /** Every file of the project for quick open: git's view (ignores respected), else a capped walk. */
  async files(projectId: string): Promise<string[]> {
    const root = this.root(projectId)
    try {
      const raw = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
      // Deleted-but-tracked files are dropped with a sync check — stop at the cap, a huge repo must not freeze the main process.
      const out: string[] = []
      for (const p of new Set(raw.split('\0').filter(Boolean))) {
        if (out.length >= this.limits.files) break
        if (existsSync(join(root, p))) out.push(p)
      }
      return out
    } catch {
      const found: string[] = []
      const walk = async (dir: string) => {
        for (const d of await readdir(dir, { withFileTypes: true })) {
          if (found.length >= this.limits.files) return
          if (d.isDirectory()) {
            if (!SKIP_DIRS.has(d.name)) await walk(join(dir, d.name))
          } else if (d.isFile()) found.push(relative(root, join(dir, d.name)).split(sep).join('/'))
        }
      }
      await walk(root)
      return found
    }
  }

  /** Text search with `git grep` (tracked and untracked files, .gitignore respected; works without a repo too). */
  async search(projectId: string, q: SearchQuery): Promise<SearchResult> {
    if (!q.query) return { matches: [], truncated: false }
    const root = this.root(projectId)
    const repo = (await this.status(projectId)).repo
    const args = [
      'grep',
      '-n',
      '-I',
      '-z',
      '--no-color',
      repo ? '--untracked' : '--no-index',
      ...(q.caseSensitive ? [] : ['-i']),
      q.regex ? '-E' : '-F',
      '-e',
      q.query
    ]
    let raw: string
    try {
      raw = await git(root, args)
    } catch (err) {
      if (exitOf(err) === 1) return { matches: [], truncated: false } // no match
      throw err
    }
    const lines = raw.split('\n').filter(Boolean)
    const { matches: max, line: width } = this.limits
    const matches = lines.slice(0, max).map((l) => {
      const [path, line, ...text] = l.split('\0')
      const t = text.join('\0').trim()
      return { path, line: Number(line), text: t.length > width ? `${t.slice(0, width)}…` : t }
    })
    return { matches, truncated: lines.length > max }
  }

  private async hasHead(root: string): Promise<boolean> {
    return git(root, ['rev-parse', '--verify', '-q', 'HEAD']).then(
      () => true,
      () => false
    )
  }

  private root(projectId: string): string {
    const root = this.resolveRoot(projectId)
    if (!root) throw coded('not-found', 'Project not found')
    return root
  }
}
