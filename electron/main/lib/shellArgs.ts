/**
 * Arguments that make the user's shell run a command line as their terminal
 * would — a login shell (`-lc`, their PATH) that becomes the command (`exec`)
 * on macOS / Linux, PowerShell on Windows.
 */
export function shellArgs(line: string, platform: NodeJS.Platform = process.platform, replace = true): string[] {
  if (platform === 'win32') return ['-NoLogo', '-Command', line]
  return ['-lc', replace ? `exec ${line}` : line]
}

/**
 * Windows PowerShell running a script line on its own: no profile, never
 * waiting for input, and scripts allowed for this one process (npm's and
 * scoop's `.ps1` shims would be blocked by the default execution policy).
 */
export function powershellArgs(line: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', line]
}
