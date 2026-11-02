import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentAvailability, AgentKind } from '@shared/types/agents'
import { shellCommand, shellQuote } from '../terminal/TerminalService'

/** Runs a command line like the user's own terminal would (login shell → their PATH). */
export type Probe = (commandLine: string) => Promise<string>

export const loginShellProbe: Probe = (commandLine) =>
  new Promise((resolve, reject) => {
    const { file } = shellCommand()
    // Windows: npm's agents are .ps1 shims — the default execution policy would block them.
    const args = process.platform === 'win32' ? ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', commandLine] : ['-lc', commandLine]
    execFile(file, args, { timeout: 10_000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })

const version = (out: string) => /(\d+\.\d+\.\d+)/.exec(out)?.[1]

const NAMES: Record<AgentKind, string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' }

const PLANS: Record<string, string> = { pro: 'Pro plan', max: 'Max plan', team: 'Team plan', enterprise: 'Enterprise plan' }

async function claude(probe: Probe, bin: string): Promise<AgentAvailability> {
  const base = { kind: 'claude-code' as const, name: NAMES['claude-code'] }
  const v = await probe(`${bin} --version`).catch(() => '')
  if (!v) return { ...base, installed: false, ready: false, hint: 'Install Claude Code: https://code.claude.com' }
  let status: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string } = {}
  try {
    status = JSON.parse(await probe(`${bin} auth status`))
  } catch {
    /* older versions (no JSON) or not signed in: exit code 1 */
  }
  const account =
    status.authMethod === 'claude.ai'
      ? (PLANS[status.subscriptionType ?? ''] ?? 'Claude account')
      : status.authMethod && status.authMethod !== 'none'
        ? 'API key'
        : undefined
  const signedIn = !!status.loggedIn
  return {
    ...base,
    installed: true,
    version: version(v),
    signedIn,
    account,
    ready: signedIn,
    hint: signedIn ? undefined : 'Sign in once: claude auth login'
  }
}

/**
 * Whether an ACP agent is signed in, as far as it tells: `codex login status`
 * succeeds when it is; Gemini keeps its Google sign-in in ~/.gemini or takes
 * an API key from the environment.
 */
async function acpSignedIn(kind: 'codex' | 'gemini', probe: Probe, home: string, env: Record<string, string | undefined>): Promise<boolean> {
  if (kind === 'codex') return !!(await probe('codex login status').catch(() => ''))
  return !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY) || existsSync(join(home, '.gemini', 'oauth_creds.json'))
}

/** ACP agents: installed = their CLI answers. Codex also needs npx for its ACP adapter. */
async function acpAgent(kind: 'codex' | 'gemini', probe: Probe, home: string, env: Record<string, string | undefined>): Promise<AgentAvailability> {
  const v = await probe(`${kind} --version`).catch(() => '')
  if (!v) return { kind, name: NAMES[kind], installed: false, ready: false, hint: `Not installed (${kind})` }
  const [adapter, signedIn] = await Promise.all([kind === 'gemini' || probe('npx --version').then((out) => !!out, () => false), acpSignedIn(kind, probe, home, env)])
  return {
    kind,
    name: NAMES[kind],
    installed: true,
    version: version(v),
    signedIn,
    account: 'Your own sign-in',
    ready: adapter,
    hint: adapter ? undefined : 'Needs Node.js (npx) for the ACP adapter'
  }
}

/**
 * What's installed and usable — asked when the user opens "New chat" or
 * Settings. `claudeBin` overrides the Claude Code binary (tests, odd installs).
 */
export async function detectAgents(probe: Probe = loginShellProbe, claudeBin = 'claude', home = homedir(), env: Record<string, string | undefined> = process.env): Promise<AgentAvailability[]> {
  return Promise.all([claude(probe, shellQuote(claudeBin)), acpAgent('codex', probe, home, env), acpAgent('gemini', probe, home, env)])
}
