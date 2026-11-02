// The desktop app around the core: what closing the window does, where the
// logs are, and what the renderer reports when part of it crashes.
// Pure module (no DOM/Node/Electron) so it compiles under every tsconfig.

/**
 * Closing the window while agents or terminals run (Windows/Linux — on macOS
 * Mindeck always keeps running in the background):
 * - `ask`         ask each time (the default)
 * - `background`  keep running in the background, with a tray icon
 * - `quit`        quit Mindeck, ending them
 */
export const CLOSE_BEHAVIORS = ['ask', 'background', 'quit'] as const
export type CloseBehavior = (typeof CLOSE_BEHAVIORS)[number]

export interface DesktopStatus {
  platform: string
  /** ~/Mindeck/logs — the log files and local crash reports. */
  logsDir: string
  /**
   * Stored secrets (API keys, the account session) are encrypted by the OS
   * keychain. False on Linux without a keyring: they are in plain text,
   * protected only by the file's permissions.
   */
  secretsEncrypted: boolean
  closeBehavior: CloseBehavior
}

/** A renderer error for the log: where it happened and what React knew. */
export interface RendererError {
  /** `module` — a module's error boundary caught it; `app` — the whole UI; `error` / `rejection` — uncaught. */
  kind: 'module' | 'app' | 'error' | 'rejection'
  /** The module (`agents`, `editor`, …) for `module`. */
  module?: string
  message: string
  stack?: string
  componentStack?: string
}
