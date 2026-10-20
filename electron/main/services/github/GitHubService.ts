import { spawn } from 'node:child_process'
import type {
  CheckState,
  GitHubStatus,
  MergeMethod,
  PullCreate,
  PullDetail,
  PullEvent,
  PullFileChange,
  PullFileDiff,
  PullFilter,
  PullListState,
  PullSummary,
  ReviewAction,
  ReviewDecision
} from '@shared/types/github'
import { shellCommand, shellEnv, shellQuote } from '../terminal/TerminalService'
import { shellArgs } from '../../lib/shellArgs'
import { spawnProgram } from '../../lib/executables'
import { overrideEnv, untrustedOverrides } from '../../lib/git'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export interface GhResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs `gh <args>` in a folder (stdin = input, `env` added to the user's). */
export type GhRunner = (args: string[], cwd: string, input?: string, env?: Record<string, string>) => Promise<GhResult>

const TIMEOUT_MS = 120_000

/** A program (gh) started from the user's login shell (their PATH), never prompting; killed after `timeoutMs`. */
export const shellRunner =
  (program: string, timeoutMs = TIMEOUT_MS): GhRunner =>
  (args, cwd, input, extra) =>
    new Promise((resolve) => {
      const env = {
        ...shellEnv(),
        ...extra,
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GH_PAGER: 'cat',
        NO_COLOR: '1',
        CLICOLOR: '0'
      }
      const proc =
        // Windows: gh from the PATH by its full path (spawnProgram) — never a gh.exe in the project folder.
        process.platform === 'win32' ? spawnProgram(program, args, { cwd, env }) : spawn(shellCommand().file, shellArgs([program, ...args].map(shellQuote).join(' ')), { cwd, env })
      const out: Buffer[] = []
      const err: Buffer[] = []
      const timer = setTimeout(() => proc.kill(), timeoutMs)
      proc.stdout!.on('data', (d: Buffer) => out.push(d))
      proc.stderr!.on('data', (d: Buffer) => err.push(d))
      proc.on('error', (e) => {
        clearTimeout(timer)
        resolve({ code: 127, stdout: '', stderr: e.message })
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(out).toString(),
          stderr: Buffer.concat(err).toString()
        })
      })
      proc.stdin!.end(input ?? '')
    })

/** The user's own gh. */
export const loginShellGh = shellRunner('gh')

export interface GitHubOptions {
  resolveRoot: (projectId: string) => string | undefined
  /** Whether a project folder is trusted (WorkspaceTrust): else the git gh runs (checkout, push) gets the untrusted overrides. */
  trusted?: (dir: string) => boolean
  /** How gh runs (loginShellGh). */
  gh: GhRunner
}

/** gh's JSON for one pull request (the fields Mindeck asks for). */
interface RawPull {
  number: number
  title: string
  author?: { login: string } | null
  headRefName: string
  baseRefName: string
  isDraft: boolean
  state: PullSummary['state']
  updatedAt: string
  url: string
  reviewDecision?: string
  additions: number
  deletions: number
}

interface RawCheck {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
}

const LIST_FIELDS = 'number,title,author,headRefName,baseRefName,isDraft,state,updatedAt,url,reviewDecision,additions,deletions'
const VIEW_FIELDS = `${LIST_FIELDS},body,createdAt,mergeable,labels,statusCheckRollup,changedFiles,files,comments,reviews,commits`

const CHANGE: Record<string, PullFileChange> = {
  ADDED: 'added',
  MODIFIED: 'modified',
  DELETED: 'deleted',
  RENAMED: 'renamed',
  COPIED: 'copied'
}
const REVIEW: Record<string, PullEvent['kind']> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  COMMENTED: 'reviewed',
  DISMISSED: 'dismissed'
}

const login = (a?: { login: string } | null) => a?.login ?? 'ghost'

function summary(p: RawPull): PullSummary {
  return {
    number: p.number,
    title: p.title,
    author: login(p.author),
    head: p.headRefName,
    base: p.baseRefName,
    draft: p.isDraft,
    state: p.state,
    updatedAt: p.updatedAt,
    url: p.url,
    review: (p.reviewDecision || undefined) as ReviewDecision | undefined,
    additions: p.additions,
    deletions: p.deletions
  }
}

/** A check run (GitHub Actions …) or a commit status, as one state. */
export function checkState(c: RawCheck): CheckState {
  const s = (c.conclusion || c.state || c.status || '').toUpperCase()
  if (['SUCCESS'].includes(s)) return 'success'
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s)) return 'failure'
  if (s === 'SKIPPED') return 'skipped'
  if (['NEUTRAL', 'STALE'].includes(s)) return 'neutral'
  return 'pending'
}

/**
 * GitHub pull requests (the GitHub Pull Requests extension) through the
 * user's own `gh`: their login, their tokens, GitHub Enterprise included.
 * Without gh — or signed out — the error says what to run.
 */
export class GitHubService {
  private compareCache = new Map<
    string,
    {
      base: string
      files: { filename: string; status: string; previous_filename?: string }[]
    }
  >()

  constructor(private readonly opts: GitHubOptions) {}

  /** gh installed? signed in? the project's repository? */
  async status(projectId: string): Promise<GitHubStatus> {
    const root = this.root(projectId)
    const user = await this.run(root, ['api', 'user', '--jq', '.login']).catch((err: { code?: string }) => {
      if (err.code === 'gh-missing') return null
      if (err.code === 'gh-auth') return undefined
      throw err
    })
    if (user === null) return { installed: false }
    if (user === undefined) return { installed: true }
    try {
      const repo = JSON.parse(await this.run(root, ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'])) as {
        nameWithOwner: string
        url: string
        defaultBranchRef?: { name: string } | null
      }
      return {
        installed: true,
        user: user.trim(),
        repo: {
          nameWithOwner: repo.nameWithOwner,
          url: repo.url,
          defaultBranch: repo.defaultBranchRef?.name || undefined
        }
      }
    } catch (err) {
      return {
        installed: true,
        user: user.trim(),
        error: (err as Error).message
      }
    }
  }

  async list(projectId: string, filter: PullFilter = 'all', state: PullListState = 'open'): Promise<PullSummary[]> {
    const args = ['pr', 'list', '--state', state, '--limit', '100', '--json', LIST_FIELDS]
    if (filter === 'mine') args.push('--author', '@me')
    if (filter === 'review') args.push('--search', 'review-requested:@me')
    return (JSON.parse(await this.run(this.root(projectId), args)) as RawPull[]).map(summary)
  }

  async view(projectId: string, number: number): Promise<PullDetail> {
    const raw = JSON.parse(await this.run(this.root(projectId), ['pr', 'view', String(number), '--json', VIEW_FIELDS])) as RawPull & {
      body: string
      createdAt: string
      mergeable: PullDetail['mergeable']
      labels: { name: string }[]
      statusCheckRollup: RawCheck[] | null
      changedFiles: number
      files:
        | {
            path: string
            changeType?: string
            additions: number
            deletions: number
          }[]
        | null
      comments: {
        author?: { login: string } | null
        body: string
        createdAt: string
      }[]
      reviews: {
        author?: { login: string } | null
        body: string
        submittedAt: string
        state: string
      }[]
      commits: {
        oid: string
        messageHeadline: string
        authoredDate: string
        authors: { login?: string; name: string }[]
      }[]
    }
    const events: PullEvent[] = [
      ...raw.comments.map((c) => ({
        author: login(c.author),
        body: c.body,
        at: c.createdAt,
        kind: 'comment' as const
      })),
      ...raw.reviews
        .filter((r) => r.state !== 'PENDING')
        .map((r) => ({
          author: login(r.author),
          body: r.body,
          at: r.submittedAt,
          kind: REVIEW[r.state] ?? 'reviewed'
        }))
    ].sort((a, b) => a.at.localeCompare(b.at))
    return {
      ...summary(raw),
      body: raw.body,
      createdAt: raw.createdAt,
      mergeable: raw.mergeable,
      labels: raw.labels.map((l) => l.name),
      checks: (raw.statusCheckRollup ?? []).map((c) => ({
        name: c.name || c.context || '?',
        state: checkState(c),
        url: c.detailsUrl || c.targetUrl || undefined
      })),
      changedFiles: raw.changedFiles,
      files: (raw.files ?? []).map((f) => ({
        path: f.path,
        change: CHANGE[f.changeType ?? ''] ?? 'changed',
        additions: f.additions,
        deletions: f.deletions
      })),
      events,
      commits: raw.commits.map((c) => ({
        oid: c.oid,
        headline: c.messageHeadline,
        author: c.authors[0]?.login || c.authors[0]?.name || '?',
        at: c.authoredDate
      }))
    }
  }

  /** One file as the pull request changes it: its merge base vs. its head (GitHub's own view). */
  async fileDiff(projectId: string, number: number, path: string): Promise<PullFileDiff> {
    const root = this.root(projectId)
    const refs = JSON.parse(await this.run(root, ['pr', 'view', String(number), '--json', 'baseRefOid,headRefOid'])) as { baseRefOid: string; headRefOid: string }
    const key = `${root}#${refs.baseRefOid}...${refs.headRefOid}`
    let compare = this.compareCache.get(key)
    if (!compare) {
      compare = JSON.parse(
        await this.run(root, [
          'api',
          `repos/{owner}/{repo}/compare/${refs.baseRefOid}...${refs.headRefOid}`,
          '--jq',
          '{base: .merge_base_commit.sha, files: [.files[] | {filename, status, previous_filename}]}'
        ])
      ) as NonNullable<typeof compare>
      this.compareCache.clear()
      this.compareCache.set(key, compare)
    }
    const file = compare.files.find((f) => f.filename === path)
    const [original, modified] = await Promise.all([
      file?.status === 'added' ? '' : this.content(root, file?.previous_filename ?? path, compare.base),
      file?.status === 'removed' ? '' : this.content(root, path, refs.headRefOid)
    ])
    return { path, original, modified }
  }

  /** Check out the pull request's branch (gh pr checkout). */
  async checkout(projectId: string, number: number): Promise<void> {
    await this.run(this.root(projectId), ['pr', 'checkout', String(number)])
  }

  /** Open a pull request from the current (pushed) branch; returns it. */
  async create(projectId: string, pr: PullCreate): Promise<{ number: number; url: string }> {
    const args = ['pr', 'create', '--title', pr.title, '--body-file', '-']
    if (pr.base) args.push('--base', pr.base)
    if (pr.draft) args.push('--draft')
    const url = (await this.run(this.root(projectId), args, pr.body)).trim().split('\n').pop()!
    return { number: Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0), url }
  }

  async merge(projectId: string, number: number, method: MergeMethod, deleteBranch = false): Promise<void> {
    const args = ['pr', 'merge', String(number), `--${method}`]
    if (deleteBranch) args.push('--delete-branch')
    await this.run(this.root(projectId), args)
  }

  async comment(projectId: string, number: number, body: string): Promise<void> {
    await this.run(this.root(projectId), ['pr', 'comment', String(number), '--body-file', '-'], body)
  }

  async review(projectId: string, number: number, action: ReviewAction, body = ''): Promise<void> {
    await this.run(this.root(projectId), ['pr', 'review', String(number), `--${action}`, '--body-file', '-'], body)
  }

  // --- helpers ---

  private root(projectId: string): string {
    const root = this.opts.resolveRoot(projectId)
    if (!root) throw coded('not-found', `Unknown project: ${projectId}`)
    return root
  }

  /** A file at a commit ('' when it isn't there or isn't text). */
  private async content(root: string, path: string, ref: string): Promise<string> {
    const encoded = path.split('/').map(encodeURIComponent).join('/')
    const text = await this.run(root, ['api', '-H', 'Accept: application/vnd.github.raw', `repos/{owner}/{repo}/contents/${encoded}?ref=${ref}`]).catch(() => '')
    return text.includes('\0') ? '' : text
  }

  private async run(cwd: string, args: string[], input?: string): Promise<string> {
    // gh runs git (checkout, push): in an untrusted repository with the same overrides as Mindeck's own git.
    const env = this.opts.trusted?.(cwd) ? undefined : { GIT_CONFIG_PARAMETERS: overrideEnv(await untrustedOverrides(cwd), process.env.GIT_CONFIG_PARAMETERS) }
    const r = await this.opts.gh(args, cwd, input, env)
    if (r.code === 0) return r.stdout
    const why = r.stderr.trim().split('\n').filter(Boolean).slice(-3).join('\n')
    if (r.code === 127 || /command not found|not recognized|ENOENT/i.test(why)) throw coded('gh-missing', 'The GitHub CLI (gh) is not installed')
    if (r.code === 4 || /gh auth login/.test(why)) throw coded('gh-auth', 'Not signed in to GitHub — run: gh auth login')
    throw coded('gh', why || `gh exited with ${r.code}`)
  }
}
