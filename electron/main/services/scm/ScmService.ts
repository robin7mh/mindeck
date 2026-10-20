import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type {
  BlameCommit,
  ScmBlame,
  ScmBranch,
  ScmChange,
  ScmCommit,
  ScmCommitDetail,
  ScmCommitFile,
  ScmDiffTarget,
  ScmFile,
  ScmOperation,
  ScmStash,
  ScmStatus
} from '@shared/types/scm'
import type { FileDiff } from '@shared/types/agents'
import { confine } from '../../lib/confine'
import { gitGuard, gitProgram } from '../../lib/git'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Network calls (push, pull, fetch) may take a while; everything else is local and quick. */
const LOCAL_MS = 30_000
const NETWORK_MS = 120_000
/** Caps that keep a huge folder from flooding the UI. */
export const SCM_LIMITS = { files: 20_000 }
/** Folders the quick-open walk skips outside a git repository. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', 'coverage'])

const CHANGE: Record<string, ScmChange> = { M: 'modified', T: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied' }

/**
 * Runs the user's own git — their config, credential helper and SSH agent —
 * with array args (never a shell string). Never waits for a terminal prompt or
 * an editor: a credential git can't find fails with git's message instead.
 * `input` is written to git's stdin (`blame --contents -`). In a repository
 * that isn't trusted, the repository's config runs nothing (see untrustedOverrides).
 */
async function git(cwd: string, args: string[], opts: { timeout?: number; input?: string; trusted?: boolean } = {}): Promise<string> {
  const guard = await gitGuard(cwd, !!opts.trusted).catch((err: Error & { stderr?: string }) => {
    throw failure(cwd, err, err.stderr ?? '')
  })
  return new Promise((resolve, reject) => {
    const child = execFile(
      gitProgram(),
      [...guard, '-c', 'core.quotepath=false', ...args],
      {
        cwd,
        timeout: opts.timeout ?? LOCAL_MS,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' }
      },
      (err, stdout, stderr) => (err ? reject(failure(cwd, err, stderr)) : resolve(stdout))
    )
    if (opts.input !== undefined) {
      // git may exit before reading it all (a bad path): that's its error to report, not EPIPE.
      child.stdin!.on('error', () => {})
      child.stdin!.end(opts.input)
    }
  })
}

/** git's failure as a coded error: its last stderr lines, or "not installed". */
function failure(cwd: string, err: Error, stderr: string | Buffer): Error {
  const exit = (err as { code?: number | string }).code
  if (exit === 'git-untrusted') return err
  // spawn ENOENT: no git — unless the folder itself is gone.
  if (exit === 'ENOENT' && existsSync(cwd)) return Object.assign(coded('git-missing', 'Git is not installed on this machine'), { exit })
  const why = String(stderr).trim().split('\n').filter(Boolean).slice(-3).join('\n')
  return Object.assign(coded('git', why || err.message), { exit })
}

const HASH = /^[0-9a-f]{4,40}$/i
const FULL_HASH = /^[0-9a-f]{40}$/i

/** `git status --porcelain=v2 -z` → branch info and changed files. */
export function parseStatus(raw: string): Omit<ScmStatus, 'repo' | 'merging' | 'operation'> {
  const status: Omit<ScmStatus, 'repo' | 'merging' | 'operation'> = { ahead: 0, behind: 0, files: [] }
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

/** `git blame --porcelain` → the commits, and per line the commit that last changed it. */
export function parseBlame(raw: string): ScmBlame {
  const commits: Record<string, BlameCommit> = {}
  const lines: string[] = []
  let hash = ''
  let line = 0
  for (const row of raw.split('\n')) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(row)
    if (head) {
      hash = head[1]
      line = Number(head[2])
      commits[hash] ??= { hash, author: '', email: '', date: 0, summary: '' }
    } else if (row.startsWith('\t')) {
      lines[line - 1] = hash
    } else {
      const space = row.indexOf(' ')
      const key = row.slice(0, space)
      const value = row.slice(space + 1)
      const commit = commits[hash]
      if (key === 'author') commit.author = value
      else if (key === 'author-mail') commit.email = value.replace(/^<|>$/g, '')
      else if (key === 'author-time') commit.date = Number(value) * 1000
      else if (key === 'summary') commit.summary = value
    }
  }
  return { commits, lines }
}

/** `git stash list --format=%H%x1f%gs%x1f%ct%x1e` → the stashes, newest first. */
export function parseStashes(raw: string): ScmStash[] {
  return raw
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r, index) => {
      const [hash, message, date] = r.split('\x1f')
      return { hash, index, message, date: Number(date) * 1000 }
    })
}

/** What a stopped operation is called on git's command line. */
const OPERATION_COMMAND: Record<ScmOperation['kind'], string> = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' }

/**
 * Source control for a project, the way VS Code's Git view does it: status,
 * staging, commits, push / pull / fetch, branches, the history for a graph,
 * diffs, merges and rebases that stopped (abort / continue), stashes and
 * blame — and, because it is quick with git, the file list for quick open.
 */
export class ScmService {
  constructor(
    private readonly resolveRoot: (projectId: string) => string | undefined,
    private readonly limits = SCM_LIMITS,
    /** Whether the project at this root is trusted (WorkspaceTrust); restricted when not. */
    private readonly trusted: (root: string) => boolean = () => false
  ) {}

  /** git in a project's folder, the way its trust allows. */
  private git(root: string, args: string[], opts: { timeout?: number; input?: string } = {}): Promise<string> {
    return git(root, args, { ...opts, trusted: this.trusted(root) })
  }

  async status(projectId: string): Promise<ScmStatus> {
    const root = this.root(projectId)
    let raw: string
    try {
      // Restricted: no recursing into submodules, whose own config would run unchecked.
      raw = await this.git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', ...(this.trusted(root) ? [] : ['--ignore-submodules=all'])])
    } catch (err) {
      if (/not a git repository/i.test((err as Error).message)) return { repo: false, ahead: 0, behind: 0, merging: false, files: [] }
      throw err
    }
    const operation = await this.operation(root)
    return { repo: true, merging: operation?.kind === 'merge', ...(operation ? { operation } : {}), ...parseStatus(raw) }
  }

  /** A merge, rebase, cherry-pick or revert in progress — git keeps their state in files under .git. */
  private async operation(root: string): Promise<ScmOperation | undefined> {
    const names = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']
    const raw = await this.git(root, ['rev-parse', ...names.flatMap((n) => ['--git-path', n])])
    const [merge, apply, mergeHead, pick, revert] = raw.split('\n').map((p) => resolve(root, p))
    const count = async (file: string) => Number((await readFile(file, 'utf8').catch(() => '')).trim()) || undefined
    // `rebase-apply` is also `git am`'s; only a rebase leaves `rebasing` in it.
    if (existsSync(merge)) return { kind: 'rebase', step: await count(join(merge, 'msgnum')), total: await count(join(merge, 'end')) }
    if (existsSync(join(apply, 'rebasing'))) return { kind: 'rebase', step: await count(join(apply, 'next')), total: await count(join(apply, 'last')) }
    if (existsSync(mergeHead)) return { kind: 'merge' }
    if (existsSync(pick)) return { kind: 'cherry-pick' }
    if (existsSync(revert)) return { kind: 'revert' }
    return undefined
  }

  /** Give up the merge / rebase / cherry-pick / revert in progress: back to where it started. */
  async abort(projectId: string): Promise<void> {
    const { operation } = await this.status(projectId)
    if (!operation) throw coded('bad-input', 'There is no merge or rebase to abort')
    await this.git(this.root(projectId), [OPERATION_COMMAND[operation.kind], '--abort'])
  }

  /** Go on once the conflicts are resolved and staged: commits the merge, or rebases the next commit. */
  async continue(projectId: string): Promise<void> {
    const { operation } = await this.status(projectId)
    if (!operation) throw coded('bad-input', 'There is no merge or rebase to continue')
    await this.git(this.root(projectId), [OPERATION_COMMAND[operation.kind], '--continue'])
  }

  async init(projectId: string): Promise<ScmStatus> {
    await this.git(this.root(projectId), ['init', '-q'])
    return this.status(projectId)
  }

  async stage(projectId: string, paths: string[]): Promise<void> {
    await this.git(this.root(projectId), ['add', '-A', '--', ...paths])
  }

  async unstage(projectId: string, paths: string[]): Promise<void> {
    const root = this.root(projectId)
    if (await this.hasHead(root)) await this.git(root, ['restore', '--staged', '--', ...paths])
    else await this.git(root, ['rm', '--cached', '-r', '-q', '--', ...paths])
  }

  /** Throws away working-tree changes; untracked files are deleted (the UI asks first). */
  async discard(projectId: string, paths: string[]): Promise<void> {
    const root = this.root(projectId)
    const untracked = new Set((await this.status(projectId)).files.filter((f) => f.unstaged === 'untracked').map((f) => f.path))
    const tracked = paths.filter((p) => !untracked.has(p))
    const fresh = paths.filter((p) => untracked.has(p))
    if (tracked.length) await this.git(root, ['restore', '--', ...tracked])
    if (fresh.length) await this.git(root, ['clean', '-f', '-q', '--', ...fresh])
  }

  /** Commit the index; `all` stages every change first (VS Code's "smart commit"). */
  async commit(projectId: string, message: string, opts: { amend?: boolean; all?: boolean } = {}): Promise<void> {
    const root = this.root(projectId)
    if (opts.all) await this.git(root, ['add', '-A'])
    const text = message.trim()
    if (!text && !opts.amend) throw coded('bad-input', 'A commit needs a message')
    await this.git(root, ['commit', '-q', ...(opts.amend ? ['--amend'] : []), ...(text ? ['-m', text] : ['--no-edit'])])
  }

  async fetch(projectId: string): Promise<void> {
    await this.git(this.root(projectId), ['fetch', '--all', '--prune', '--quiet'], { timeout: NETWORK_MS })
  }

  /** Pull with the user's own pull settings (merge or rebase); conflicts show up in the status. */
  async pull(projectId: string): Promise<void> {
    await this.git(this.root(projectId), ['pull', '--no-edit', '--quiet'], { timeout: NETWORK_MS })
  }

  /** Push; a branch without upstream is published to `origin`. */
  async push(projectId: string): Promise<void> {
    const root = this.root(projectId)
    const { upstream } = await this.status(projectId)
    if (upstream) return void (await this.git(root, ['push', '--quiet'], { timeout: NETWORK_MS }))
    if (!(await this.git(root, ['remote'])).split('\n').includes('origin')) throw coded('no-remote', 'This repository has no remote "origin" to push to')
    await this.git(root, ['push', '--quiet', '-u', 'origin', 'HEAD'], { timeout: NETWORK_MS })
  }

  async branches(projectId: string): Promise<ScmBranch[]> {
    const raw = await this.git(this.root(projectId), ['for-each-ref', '--format=%(refname)%1f%(HEAD)%1f%(upstream:short)', 'refs/heads', 'refs/remotes'])
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
    if (!remote) return void (await this.git(root, ['switch', '--', name]))
    const local = name.slice(name.indexOf('/') + 1)
    await this.git(root, ['switch', '--track', '-c', local, name])
  }

  async createBranch(projectId: string, name: string): Promise<void> {
    const root = this.root(projectId)
    await this.git(root, ['check-ref-format', '--branch', name]).catch(() => {
      throw coded('bad-input', `"${name}" is not a valid branch name`)
    })
    await this.git(root, ['switch', '-c', name])
  }

  /** The newest commits of every branch, newest first — enough for the graph. */
  async log(projectId: string, limit = 300): Promise<ScmCommit[]> {
    const root = this.root(projectId)
    if (!(await this.hasHead(root))) return []
    const raw = await this.git(root, ['log', '--all', '--date-order', `-n${limit}`, '--pretty=format:%H%x1f%P%x1f%an%x1f%at%x1f%s%x1f%D%x1e'])
    return parseLog(raw)
  }

  async show(projectId: string, hash: string): Promise<ScmCommitDetail> {
    if (!HASH.test(hash)) throw coded('bad-input', 'Not a commit hash')
    const root = this.root(projectId)
    const head = await this.git(root, ['show', '--no-patch', '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%B', hash])
    const [full, author, email, date, message] = head.split('\x1f')
    const files = parseNameStatus(await this.git(root, ['diff-tree', '--no-commit-id', '-r', '-M', '--root', '--name-status', '-z', hash]))
    return { hash: full, author, email, date: Number(date) * 1000, message: message.trim(), files }
  }

  /** Before → after of one file: working tree vs. index, index vs. HEAD, or a commit vs. its parent. */
  async diff(projectId: string, path: string, target: ScmDiffTarget): Promise<FileDiff> {
    const root = this.root(projectId)
    const blob = (spec: string) => this.git(root, ['show', spec]).catch(() => '')
    if (target.kind === 'unstaged') {
      const abs = await confine(root, path)
      return { path, original: await blob(`:${path}`), modified: await readFile(abs, 'utf8').catch(() => '') }
    }
    if (target.kind === 'staged') return { path, original: await blob(`HEAD:${path}`), modified: await blob(`:${path}`) }
    if (!HASH.test(target.hash)) throw coded('bad-input', 'Not a commit hash')
    // A stash commit's first parent is the commit it was made on; its third holds the untracked files.
    if (target.kind === 'stash' && target.untracked) return { path, original: '', modified: await blob(`${target.hash}^3:${path}`) }
    return { path, original: await blob(`${target.hash}^:${target.from ?? path}`), modified: await blob(`${target.hash}:${path}`) }
  }

  /**
   * The staged (index) text of a file — what the editor's gutter compares the
   * buffer with, like VS Code. Null for untracked files and outside a repo.
   */
  async original(projectId: string, path: string): Promise<string | null> {
    const root = this.root(projectId)
    await confine(root, path)
    return this.git(root, ['show', `:./${path}`]).catch(() => null)
  }

  /** Every file of the project for quick open: git's view (ignores respected), else a capped walk. */
  async files(projectId: string): Promise<string[]> {
    const root = this.root(projectId)
    try {
      const raw = await this.git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
      return [...new Set(raw.split('\0').filter(Boolean))].filter((p) => existsSync(join(root, p))).slice(0, this.limits.files)
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

  /** The stashes, newest first (none before the first commit). */
  async stashes(projectId: string): Promise<ScmStash[]> {
    const root = this.root(projectId)
    if (!(await this.hasHead(root))) return []
    return parseStashes(await this.git(root, ['stash', 'list', '--format=%H%x1f%gs%x1f%ct%x1e']))
  }

  /** Stash the working tree and the index (`untracked`: new files too). */
  async stash(projectId: string, opts: { message?: string; untracked?: boolean } = {}): Promise<void> {
    const root = this.root(projectId)
    const before = (await this.stashes(projectId))[0]?.hash
    const message = opts.message?.trim()
    await this.git(root, ['stash', 'push', ...(opts.untracked ? ['--include-untracked'] : []), ...(message ? ['-m', message] : [])])
    // With nothing to stash git still succeeds ("No local changes to save").
    if ((await this.stashes(projectId))[0]?.hash === before) throw coded('bad-input', 'There are no local changes to stash')
  }

  /** Apply a stash to the working tree; `pop` drops it afterwards (unless that conflicted — git keeps it then). */
  async applyStash(projectId: string, hash: string, pop = false): Promise<void> {
    await this.git(this.root(projectId), ['stash', pop ? 'pop' : 'apply', await this.stashRef(projectId, hash)])
  }

  async dropStash(projectId: string, hash: string): Promise<void> {
    await this.git(this.root(projectId), ['stash', 'drop', '-q', await this.stashRef(projectId, hash)])
  }

  /** The files a stash holds: changes to tracked files, and the untracked files it took along. */
  async stashFiles(projectId: string, hash: string): Promise<ScmCommitFile[]> {
    if (!FULL_HASH.test(hash)) throw coded('bad-input', 'Not a stash')
    const root = this.root(projectId)
    const tracked = parseNameStatus(await this.git(root, ['diff-tree', '-r', '-M', '--name-status', '-z', `${hash}^1`, hash]))
    const untracked = await this.git(root, ['ls-tree', '-r', '-z', '--name-only', `${hash}^3`]).then(
      (raw) => raw.split('\0').filter(Boolean),
      () => [] // no untracked files in this stash
    )
    return [...tracked, ...untracked.map((path) => ({ path, change: 'untracked' as const }))]
  }

  /**
   * Who last changed each line. With `text` (the editor's buffer, unsaved
   * edits included) the lines are the buffer's: edited ones are uncommitted.
   */
  async blame(projectId: string, path: string, text?: string): Promise<ScmBlame> {
    const root = this.root(projectId)
    await confine(root, path)
    const contents = text === undefined ? [] : ['--contents', '-']
    return parseBlame(await this.git(root, ['blame', '--porcelain', ...contents, '--', path], { input: text }))
  }

  /** `stash@{n}` for a stash — found by its hash, since the positions shift as stashes come and go. */
  private async stashRef(projectId: string, hash: string): Promise<string> {
    const stash = (await this.stashes(projectId)).find((s) => s.hash === hash)
    if (!stash) throw coded('not-found', 'This stash no longer exists')
    return `stash@{${stash.index}}`
  }

  private async hasHead(root: string): Promise<boolean> {
    return this.git(root, ['rev-parse', '--verify', '-q', 'HEAD']).then(
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
