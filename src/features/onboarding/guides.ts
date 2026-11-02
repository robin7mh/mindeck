/** The programs the setup checks for: the coding agents, and Node.js for the ones that come through npm. */
export type GuideId = 'claude-code' | 'codex' | 'gemini' | 'node'

export interface Guide {
  id: GuideId
  name: string
  /** The install command for this platform (none where it is a download from the website). */
  install?: string
  /** Where installing is explained. */
  url: string
  /** Signs in (an agent that is installed but not signed in). */
  signIn?: string
  /** Installs with npm: Node.js has to be there first. */
  npm?: boolean
}

/**
 * How each one gets onto this machine and signs in — the vendors' own ways:
 * Claude Code's installer (a PowerShell one on Windows), npm for Codex and
 * Gemini, winget / Homebrew for Node.js.
 */
export function guides(platform: string): Guide[] {
  const windows = platform === 'win32'
  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      install: windows ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash',
      url: 'https://code.claude.com/docs/en/setup',
      signIn: 'claude auth login'
    },
    { id: 'codex', name: 'Codex', install: 'npm install -g @openai/codex', url: 'https://github.com/openai/codex', signIn: 'codex login', npm: true },
    { id: 'gemini', name: 'Gemini CLI', install: 'npm install -g @google/gemini-cli', url: 'https://github.com/google-gemini/gemini-cli', signIn: 'gemini', npm: true },
    {
      id: 'node',
      name: 'Node.js',
      install: windows ? 'winget install --id OpenJS.NodeJS.LTS --exact' : platform === 'darwin' ? 'brew install node' : undefined,
      url: 'https://nodejs.org/en/download'
    }
  ]
}
