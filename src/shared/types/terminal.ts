// Interactive terminal sessions (phase PT): a PTY per session in the main
// process, rendered by xterm.js. Pure module — compiles under both tsconfigs.

export interface TerminalInfo {
  id: string
  /** Tab label: project name, or `~` for the home folder. */
  title: string
  cwd: string
  /** `cwd` with the home folder shortened to `~`, for display. */
  cwdLabel: string
  /** Shell binary name, e.g. `zsh`. */
  shell: string
  projectId?: string
  createdAt: string
  /** 'agent': a coding agent's PTY (Agents module) — not listed as a terminal tab. */
  kind?: 'agent'
  /** The profile it was started with (a detected shell's or a custom profile's id). */
  profileId?: string
  /** Shell integration is loaded: the shell reports its folder and command boundaries. */
  integration?: boolean
  /**
   * `terminal:list` only: the program in the foreground when listed (e.g.
   * `node`); absent while the shell waits at its prompt.
   */
  running?: string
}

/**
 * Output chunk. `end` is the session's total emitted length after this chunk,
 * so a view that attached mid-stream (see `terminal:attach`) can drop the part
 * it already got from the scrollback buffer.
 */
export interface TerminalData {
  id: string
  data: string
  end: number
}

export interface TerminalExit {
  id: string
  exitCode: number
}

export interface TerminalAttach {
  info: TerminalInfo
  /** Recent output (bounded), for views that mount after the session started. */
  buffer: string
  end: number
}

/** An agent started a command in a terminal (`terminal:reveal`): the Terminal shows that tab. */
export interface TerminalReveal {
  info: TerminalInfo
  /** Who started it, e.g. "Claude Code". */
  by: string
}

/** A shell found on this machine (`terminal:shells`), offered as a profile. */
export interface TerminalShell {
  /** Stable id, e.g. `zsh`, `pwsh`, `wsl` — what `profileId` names. */
  id: string
  name: string
  file: string
  args: string[]
}

/** A profile of the user's own: any program with its arguments, environment and folder. */
export interface TerminalProfile {
  /** `custom-…`, so it never collides with a detected shell's id. */
  id: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  /** Absolute start folder; unset = Home (or the project it is opened in). */
  cwd?: string
}

export const TERMINAL_CURSORS = ['bar', 'block', 'underline'] as const

export type TerminalCursor = (typeof TERMINAL_CURSORS)[number]

/** The Terminal's preferences (Settings → Terminal), kept in the app settings. */
export interface TerminalSettings {
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorStyle: TerminalCursor
  cursorBlink: boolean
  /** Lines each view keeps to scroll back through. */
  scrollback: number
  /** Output (KB) the core keeps per session, for views that attach later. */
  bufferKb: number
  copyOnSelect: boolean
  /** Draw with WebGL (falls back to the DOM renderer when the GPU can't). */
  gpu: boolean
  /** Tabs, layout, folders and recent output come back after a restart. */
  restore: boolean
  /** Folder tracking and command marks for bash, zsh, fish and PowerShell. */
  shellIntegration: boolean
  /** Profile new terminals start with: a shell's or a custom profile's id; unset or '' = the login shell. */
  defaultProfile?: string
  profiles: TerminalProfile[]
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
  fontSize: 13,
  lineHeight: 1.25,
  cursorStyle: 'bar',
  cursorBlink: true,
  scrollback: 5000,
  bufferKb: 256,
  copyOnSelect: false,
  gpu: true,
  restore: true,
  shellIntegration: true,
  profiles: []
}

/** Bounds the settings are held to (the schema and the inputs use them). */
export const TERMINAL_LIMITS = {
  fontSize: [8, 32],
  lineHeight: [1, 2],
  scrollback: [500, 100_000],
  bufferKb: [64, 8192],
  profiles: 20
} as const

/** One tab as it was when Mindeck last saved the terminals. */
export interface TerminalSnapshotTab {
  title: string
  cwd: string
  projectId?: string
  profileId?: string
  /** The view's recent output (serialized, bounded). */
  scrollback: string
}

/** What `terminal:persist` saves and `terminal:restore` hands back after a restart. */
export interface TerminalSnapshot {
  layout: 'single' | 'cols' | 'rows' | 'grid'
  /** Index of the focused tab. */
  active: number
  tabs: TerminalSnapshotTab[]
  savedAt: string
}
