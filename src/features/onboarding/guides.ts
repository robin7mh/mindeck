/** The programs the setup checks for: the coding agents, and Node.js, which Mindeck needs to connect Codex and Gemini CLI. */
export type GuideId = 'claude-code' | 'codex' | 'gemini' | 'node'

/** What the machine installs with (tools:runtimes). */
export interface Machine {
  platform: string
  /** npm is there; `globalWritable` false: `npm install -g` may not write its folder (the system's — only sudo may). */
  npm?: { globalWritable?: boolean }
  /** Homebrew is there (macOS, Linux). */
  brew?: boolean
}

export interface Guide {
  id: GuideId
  name: string
  /** The command that installs it on this machine (none: there is only the vendor's installer to download). */
  install?: string
  /** The install command asks for the user's password (sudo). */
  sudo?: boolean
  /** Signs in (an agent that is installed but not signed in). */
  signIn?: string
  /** Installs with npm: Node.js has to be there first. */
  npm?: boolean
}

const GEMINI = '@google/gemini-cli'

/**
 * Gemini CLI comes through npm — through Homebrew where npm may not write its
 * global folder (the Node.js installer leaves it to root) or isn't there yet,
 * and only without Homebrew through `sudo npm`.
 */
function gemini(m: Machine): Pick<Guide, 'install' | 'sudo' | 'npm'> {
  if (m.platform === 'win32' || (m.npm && m.npm.globalWritable !== false)) return { install: `npm install -g ${GEMINI}`, npm: true }
  if (m.brew) return { install: 'brew install gemini-cli' }
  if (m.npm) return { install: `sudo npm install -g ${GEMINI}`, sudo: true, npm: true }
  return { install: `npm install -g ${GEMINI}`, npm: true }
}

/**
 * How each one gets onto this machine and signs in — the vendors' own ways:
 * the installers of Claude Code and Codex (PowerShell ones on Windows; no npm,
 * no admin rights), npm or Homebrew for Gemini CLI, winget / Homebrew for
 * Node.js.
 */
export function guides(m: Machine): Guide[] {
  const windows = m.platform === 'win32'
  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      install: windows ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash',
      signIn: 'claude auth login'
    },
    {
      id: 'codex',
      name: 'Codex',
      install: windows ? 'irm https://chatgpt.com/codex/install.ps1 | iex' : 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      signIn: 'codex login'
    },
    { id: 'gemini', name: 'Gemini CLI', ...gemini(m), signIn: 'gemini' },
    { id: 'node', name: 'Node.js', install: windows ? 'winget install --id OpenJS.NodeJS.LTS --exact' : m.brew ? 'brew install node' : undefined }
  ]
}

/** The command as the setup runs it: the shell ends once it succeeded, so the setup knows to look again (a failed one stays open). */
export function untilDone(command: string, platform: string): string {
  return platform === 'win32' ? `${command}; if ($?) { exit }` : `${command} && exit`
}
