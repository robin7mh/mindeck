import { existsSync, readFileSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import type { TerminalShell } from '@shared/types/terminal'

/** Shells looked for on macOS and Linux: id, label, start arguments (login shells, like Terminal.app). */
const POSIX_SHELLS: [string, string, string[]][] = [
  ['zsh', 'zsh', ['-l']],
  ['bash', 'bash', ['-l']],
  ['fish', 'fish', ['-l']],
  // -Login must come first.
  ['pwsh', 'PowerShell', ['-Login', '-NoLogo']]
]

const POSIX_DIRS = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/snap/bin']

/** The shells listed in /etc/shells — what the system itself calls valid login shells. */
function etcShells(): string[] {
  try {
    return readFileSync('/etc/shells', 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('/'))
  } catch {
    return []
  }
}

function posixShells(env: NodeJS.ProcessEnv): TerminalShell[] {
  const listed = etcShells()
  const dirs = [...(env.PATH ?? '').split(':').filter((d) => d.startsWith('/')), ...POSIX_DIRS]
  const found: TerminalShell[] = []
  for (const [id, name, args] of POSIX_SHELLS) {
    const file = [...listed.filter((p) => posix.basename(p) === id), ...dirs.map((d) => posix.join(d, id))].find((p) => existsSync(p))
    if (file) found.push({ id, name, file, args })
  }
  return found
}

function windowsShells(env: NodeJS.ProcessEnv): TerminalShell[] {
  const root = env.SystemRoot ?? 'C:\\Windows'
  const programs = env.ProgramFiles ?? 'C:\\Program Files'
  const system = win32.join(root, 'System32')
  const onPath = (exe: string) => (env.Path ?? env.PATH ?? '').split(';').filter(Boolean).map((d) => win32.join(d, exe))
  const candidates: [string, string, string[], string[]][] = [
    ['pwsh', 'PowerShell', [...onPath('pwsh.exe'), win32.join(programs, 'PowerShell', '7', 'pwsh.exe')], ['-NoLogo']],
    ['powershell', 'Windows PowerShell', [win32.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe')], ['-NoLogo']],
    ['cmd', 'Command Prompt', [env.ComSpec ?? win32.join(system, 'cmd.exe')], []],
    ['wsl', 'WSL', [win32.join(system, 'wsl.exe')], []],
    ['gitbash', 'Git Bash', [win32.join(programs, 'Git', 'bin', 'bash.exe')], ['--login', '-i']]
  ]
  return candidates.flatMap(([id, name, files, args]) => {
    const file = files.find((f) => existsSync(f))
    return file ? [{ id, name, file, args }] : []
  })
}

/** The shells installed on this machine, offered as profiles (zsh, bash, fish, pwsh · cmd, WSL on Windows). */
export function detectShells(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): TerminalShell[] {
  return platform === 'win32' ? windowsShells(env) : posixShells(env)
}
