// Source control for the editor: git status, staging, commits, sync,
// branches, history for the graph, merges and rebases, stashes, blame —
// plus quick open.
// Pure module (no DOM/Node/Electron) so it compiles under every tsconfig.

export type ScmChange = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted'

export interface ScmFile {
  /** Posix path relative to the project root. */
  path: string
  /** The old path of a rename or copy. */
  from?: string
  /** Change in the index (staged), against HEAD. */
  staged?: ScmChange
  /** Change in the working tree, against the index. */
  unstaged?: ScmChange
}

export interface ScmStatus {
  /** False: the folder is not a git repository (yet). */
  repo: boolean
  /** Undefined while HEAD is detached (or before the first commit: the branch to be born). */
  branch?: string
  /** Short hash of HEAD; undefined before the first commit. */
  head?: string
  upstream?: string
  /** The remotes' names (`origin`, …); without `origin` a push has nowhere to go — publish first. Absent from older cores. */
  remotes?: string[]
  ahead: number
  behind: number
  /** A merge waits for its conflicts to be resolved and committed. */
  merging: boolean
  /** A merge, rebase, cherry-pick or revert stopped halfway (conflicts, or waiting to continue). */
  operation?: ScmOperation
  files: ScmFile[]
}

export interface ScmOperation {
  kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert'
  /** A rebase's progress: commit `step` of `total`. */
  step?: number
  total?: number
}

export interface ScmStash {
  /** Full hash — the stash entry, whatever its position (`stash@{n}`) is by now. */
  hash: string
  /** Its position in the stash list (0 = newest). */
  index: number
  /** `On main: message` / `WIP on main: abc123 subject`. */
  message: string
  /** Unix ms. */
  date: number
}

export interface BlameCommit {
  hash: string
  author: string
  email: string
  /** Unix ms. */
  date: number
  summary: string
}

/** Who last changed each line of a file. */
export interface ScmBlame {
  /** The commits that appear, by hash. */
  commits: Record<string, BlameCommit>
  /** Per line (index 0 = line 1): the commit's hash; `UNCOMMITTED` for lines not committed yet. */
  lines: string[]
}

/** Git's hash for lines that are not committed yet. */
export const UNCOMMITTED = '0'.repeat(40)

export interface ScmBranch {
  /** `main`, or `origin/feature` for a remote branch. */
  name: string
  remote: boolean
  current: boolean
  upstream?: string
}

export interface ScmCommit {
  hash: string
  parents: string[]
  author: string
  /** Unix ms. */
  date: number
  subject: string
  /** Branch and tag names pointing here (`HEAD -> main`, `origin/main`, `tag: v1`). */
  refs: string[]
}

export interface ScmCommitFile {
  path: string
  from?: string
  change: ScmChange
}

export interface ScmCommitDetail {
  hash: string
  author: string
  email: string
  date: number
  /** The full message. */
  message: string
  files: ScmCommitFile[]
}

/**
 * Which two versions of a file to compare. A stash: the stashed file against
 * the commit it was stashed on (an untracked file against nothing).
 */
export type ScmDiffTarget =
  | { kind: 'unstaged' }
  | { kind: 'staged' }
  | { kind: 'commit'; hash: string; from?: string }
  | { kind: 'stash'; hash: string; from?: string; untracked?: boolean }
