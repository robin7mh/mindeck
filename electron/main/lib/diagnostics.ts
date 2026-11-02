import { redact, type LogEntry } from './log'

export interface DiagnosticsInfo {
  version: string
  /** `process.platform` / `process.arch` and the OS's own version string. */
  platform: string
  arch: string
  os: string
  /** Electron, Chromium and Node versions (`process.versions`). */
  versions: { electron?: string; chrome?: string; node?: string }
  locale: string
  packaged: boolean
  secretsEncrypted: boolean
  /** The license state (`active`, `offline` …) — never the token behind it. */
  license: string
  running: { agents: number; terminals: number }
  /** Seconds since start. */
  uptime: number
  logsDir: string
  /** The user's home folder — shown as `~` so the report does not carry the user name. */
  home: string
}

/**
 * The text "Copy diagnostics" puts on the clipboard for a bug report: version,
 * OS, the state of the app and the latest warnings and errors. Built from
 * facts only — no settings, paths beyond `~`, secrets or tokens (and the log
 * lines are redacted once more).
 */
export function diagnosticsReport(info: DiagnosticsInfo, recent: LogEntry[]): string {
  const tidy = (text: string) => redact(info.home ? text.split(info.home).join('~') : text)
  const v = info.versions
  const lines = [
    `Mindeck ${info.version}${info.packaged ? '' : ' (dev)'}`,
    `OS: ${info.platform} ${info.arch} · ${info.os}`,
    `Electron ${v.electron ?? '?'} · Chromium ${v.chrome ?? '?'} · Node ${v.node ?? '?'}`,
    `Locale: ${info.locale}`,
    `Secrets: ${info.secretsEncrypted ? 'encrypted by the OS keychain' : 'plain text (no keychain available)'}`,
    `License: ${info.license}`,
    `Running: ${info.running.agents} agent session(s), ${info.running.terminals} terminal(s)`,
    `Uptime: ${Math.round(info.uptime / 60)} min`,
    `Logs: ${info.logsDir}`,
    '',
    recent.length ? `Latest warnings and errors (${recent.length}, oldest first):` : 'No warnings or errors since the start.',
    ...recent.map((e) => `${e.time} ${e.level.toUpperCase()} [${e.source}] ${e.message}`)
  ]
  return tidy(lines.join('\n'))
}
