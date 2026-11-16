// Shared across main process, preload and renderer. Pure types only — no DOM,
// no Node, no Electron — so both tsconfig sides can compile it.

export interface GitInfo {
  isRepo: boolean
  branch?: string
  ahead?: number
  behind?: number
  dirty?: boolean
  lastCommit?: { hash: string; subject: string; author: string; date: string }
  /** The repo's page (GitHub, GitLab, …) from `origin`. */
  webUrl?: string
}

export interface StackInfo {
  languages: string[]
  frameworks: string[]
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun'
  hasReadme: boolean
  packageJson?: { name?: string; version?: string; scripts: string[] }
}

export interface Project {
  id: string
  name: string
  path: string // absolute, canonicalized
  addedAt: string // ISO
  lastSeenAt: string // ISO
  git?: GitInfo
  stack?: StackInfo
  pinned?: boolean
  /** Added by a paired device: reachable remotely only inside the shared folders. */
  addedRemotely?: boolean
  /**
   * The user trusts the project's authors: Mindeck may run the project's own
   * tools — its TypeScript, ESLint / Prettier and their configs, its Python,
   * its git config and hooks, its .vscode/sftp.json. Not true (every newly
   * added project): restricted, Mindeck's own tools only (BE-SEC-01).
   */
  trusted?: boolean
}
