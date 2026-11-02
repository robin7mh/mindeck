// The agent cockpit: coding agents the user already has (Claude Code, Codex,
// Gemini CLI) run as their own programs; Mindeck shows each session as a chat
// with tool cards, approvals, the changes it made and what it remembered.
// Pure module (no DOM/Node/Electron) so it compiles under every tsconfig.

import type { ChatMessage } from './ai'
import type { ComposerImage, ComposerRef } from './composer'

export type AgentKind = 'claude-code' | 'codex' | 'gemini'

/** What the core found on this machine for one agent. */
export interface AgentAvailability {
  kind: AgentKind
  name: string
  installed: boolean
  version?: string
  /** Signed in (where the CLI can tell), and how — e.g. "Pro plan", "API key". */
  signedIn?: boolean
  account?: string
  /** Mindeck can run it as a session (installed + an integration exists). */
  ready: boolean
  /** What to do when it isn't ready. */
  hint?: string
}

/**
 * starting → working ⇄ approval → idle (waiting for the user's next message);
 * waiting = the agent asked for input; ended = process gone (can be resumed).
 */
export type SessionStatus = 'starting' | 'working' | 'approval' | 'waiting' | 'idle' | 'ended' | 'error'

export interface PlanItem {
  id: string
  text: string
  done: boolean
}

export interface FileChange {
  path: string
  status: 'added' | 'modified' | 'deleted'
  added: number
  removed: number
}

/** An own working folder's branch, as far as git and GitHub tell. */
export interface SessionBranch {
  /** On origin (as of the last push or fetch). */
  pushed: boolean
  /** Its pull request on GitHub — known when the `gh` CLI is installed and signed in. */
  pr?: { number: number; url: string; state: 'open' | 'merged' | 'closed' }
  /** Its work is in origin's default branch: the pull request was merged, or its commits are there. */
  merged: boolean
  /** Files changed in the folder but not committed — cleaning it up loses them. */
  uncommitted: number
}

/** A model or mode the agent offers for a session. */
export interface SessionOption {
  id: string
  name: string
  description?: string
}

/** A slash command the agent offers (`/name`). */
export interface AgentCommand {
  name: string
  description: string
  /** What goes after the name, when it takes input. */
  hint?: string
}

export interface AgentSession {
  id: string
  kind: AgentKind
  projectId: string
  projectName: string
  title: string
  /** Where the agent works: the project, or its own worktree. */
  cwd: string
  isolated: boolean
  worktree?: string
  branch?: string
  /** The project's repo page (GitHub, GitLab, …) from its `origin` remote. */
  repoUrl?: string
  status: SessionStatus
  /** The agent's process is running (messages can be sent). */
  live: boolean
  /** The PTY running the agent (Claude Code), for "Terminal ▸" — ACP agents have none. */
  terminalId?: string
  plan: PlanItem[]
  /** Vault notes the agent read or wrote through Mindeck's memory tools. */
  notes: string[]
  /** The session's journal note in the vault. */
  journal?: string
  /** The model it runs (an id from `models`); unset = the agent's default. */
  model?: string
  models?: SessionOption[]
  /** Claude Code: its permission mode · ACP agents: their session mode. */
  mode?: string
  modes?: SessionOption[]
  /** Slash commands the agent offers. */
  commands?: AgentCommand[]
  /** The agent takes images in a message. */
  images?: boolean
  createdAt: string
  updatedAt: string
  error?: string
}

export interface AgentSessionDetail extends AgentSession {
  messages: ChatMessage[]
}

export interface CreateSessionRequest {
  kind: AgentKind
  projectId: string
  title?: string
  /** Own git worktree (parallel work) instead of the project folder. */
  isolated?: boolean
  /** First message, sent once the agent is up. */
  prompt?: string
  /** Claude Code: `--model` and `--permission-mode` from the start. */
  model?: string
  mode?: string
}

/** A message for the agent: its text, what the user referenced with `@`, and images. */
export interface AgentInput {
  text: string
  refs?: ComposerRef[]
  images?: ComposerImage[]
}

/** Switch the session's model or mode (Claude Code's permission mode applies from its next start). */
export interface SessionConfigure {
  model?: string
  mode?: string
}

export interface AgentMessageUpdate {
  sessionId: string
  message: ChatMessage
}

export interface FileDiff {
  path: string
  original: string
  modified: string
}
