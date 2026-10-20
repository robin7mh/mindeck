import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { programPath } from './executables'

/** Git's absolute path from the PATH (see programPath) — never a `git.exe` checked into the project. */
export const gitProgram = (): string => programPath('git')

/**
 * A hooks folder that can't hold a hook: /dev/null; on Windows a folder next
 * to Mindeck's executable that doesn't exist (`/dev/null` there would be
 * `C:\dev\null`, which any user may create).
 */
export const noHooks = (platform: NodeJS.Platform = process.platform): string => (platform === 'win32' ? join(dirname(process.execPath), 'no-hooks') : '/dev/null')

/** One `-c key=value` override. */
export type GitOverride = [key: string, value: string]

/**
 * Always set for a repository Mindeck doesn't trust: no fsmonitor program
 * (runs on every `status`), no hooks (`status` can run post-index-change,
 * commit pre-commit …), no gpg for `log`, no `ext::` remotes, no recursing
 * into submodules (whose own config isn't checked here), no bare
 * repository found by walking into a folder. A pager or editor never runs:
 * git's output goes to a pipe, and ScmService sets GIT_EDITOR.
 */
export const UNTRUSTED_GIT: readonly GitOverride[] = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', noHooks()],
  ['log.showSignature', 'false'],
  ['protocol.ext.allow', 'never'],
  ['submodule.recurse', 'false'],
  ['safe.bareRepository', 'explicit']
]

/**
 * Keys a repository's own config can use to make git run a program: filter
 * drivers (status, add, checkout), diff drivers (textconv in show / blame,
 * external diff), merge drivers, ssh / askpass / credential helpers (fetch,
 * push), gpg (commit, log), the upload / receive pack of a local remote.
 * Set by the repository, they get the user's own value (global / system) or
 * one that runs nothing. `multi`: a list (an empty entry clears it).
 */
const RISKY: { key: RegExp; neutral?: string; multi?: true }[] = [
  { key: /^filter\..+\.(clean|smudge|process)$/, neutral: '' },
  { key: /^diff\..+\.(textconv|command)$/, neutral: '' },
  { key: /^diff\.external$/, neutral: '' },
  { key: /^merge\..+\.driver$/, neutral: '' },
  { key: /^core\.sshcommand$/, neutral: 'ssh' },
  { key: /^core\.askpass$/, neutral: '' },
  { key: /^core\.alternaterefscommand$/, neutral: '' },
  { key: /^credential\.(.+\.)?helper$/, multi: true },
  { key: /^gpg\.(openpgp\.)?program$/, neutral: 'gpg' },
  { key: /^gpg\.x509\.program$/, neutral: 'gpgsm' },
  { key: /^gpg\.ssh\.program$/, neutral: 'ssh-keygen' },
  { key: /^gpg\.ssh\.defaultkeycommand$/, neutral: '' },
  { key: /^remote\..+\.uploadpack$/, neutral: 'git-upload-pack' },
  { key: /^remote\..+\.receivepack$/, neutral: 'git-receive-pack' }
]

/** Keys whose first entry wins (a later `-c` can't override them): a repository setting one is refused. */
const UNOVERRIDABLE = /^core\.gitproxy$/

/** One config entry: where it comes from (`local`, `global` …; undefined: git too old to say), key, value. */
interface Entry {
  scope?: string
  key: string
  value: string
}

/** Entries the repository itself sets (its .git/config, worktree config and their includes). */
const fromRepo = (e: Entry) => e.scope === undefined || e.scope === 'local' || e.scope === 'worktree'

function refused(message: string): Error {
  return Object.assign(new Error(message), { code: 'git-untrusted' })
}

/** `git config --list -z` (`--show-scope`: every entry preceded by its scope). */
export function parseConfigList(raw: string, scoped: boolean): Entry[] {
  const fields = raw.split('\0')
  if (fields[fields.length - 1] === '') fields.pop()
  const entries: Entry[] = []
  for (let i = 0; i < fields.length; i += 1) {
    const scope = scoped ? fields[i++] : undefined
    const line = fields[i] ?? ''
    const nl = line.indexOf('\n')
    entries.push({ scope, key: nl < 0 ? line : line.slice(0, nl), value: nl < 0 ? '' : line.slice(nl + 1) })
  }
  return entries
}

/** The overrides for what the repository sets (see RISKY); refuses keys that can't be overridden safely. */
export function neutralize(entries: Entry[]): GitOverride[] {
  const out: GitOverride[] = []
  const done = new Set<string>()
  for (const entry of entries.filter(fromRepo)) {
    const key = entry.key
    if (done.has(key)) continue
    if (UNOVERRIDABLE.test(key.toLowerCase())) throw refused(`This repository sets ${key} — trust the project to use Git with it`)
    const rule = RISKY.find((r) => r.key.test(key.toLowerCase()))
    if (!rule) continue
    // `-c` splits at the first "=": a driver named "a=b" can't be overridden.
    if (key.includes('=')) throw refused(`This repository's config can't be made safe (${key}) — trust the project to use Git with it`)
    done.add(key)
    const own = entries.filter((e) => !fromRepo(e) && e.key === key).map((e) => e.value)
    if (rule.multi) out.push([key, ''], ...own.map((v): GitOverride => [key, v]))
    else out.push([key, own.length ? own[own.length - 1] : rule.neutral!])
    // A required filter without a command would stop git instead.
    if (/^filter\..+\.(clean|smudge|process)$/i.test(key)) {
      const required = `${key.slice(0, key.lastIndexOf('.'))}.required`
      if (!done.has(required)) {
        done.add(required)
        out.push([required, 'false'])
      }
    }
  }
  return out
}

/** Runs git, resolving with its stdout (rejecting when it fails). */
export type GitExec = (args: string[], cwd: string) => Promise<string>

const execGit: GitExec = async (args, cwd) =>
  (await promisify(execFile)(gitProgram(), args, { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout

/**
 * The overrides for git in a repository Mindeck doesn't trust (BE-SEC-01):
 * a repository's own config — part of any ZIP or tarball, or of a parent
 * folder's repository — can make git run programs on its own (status runs
 * fsmonitor, hooks and clean filters; blame and show textconv drivers; log
 * gpg; fetch ssh and credential helpers). Command-line overrides beat every
 * config file: UNTRUSTED_GIT, plus a safe value for each risky key the
 * repository sets (reading the config runs nothing). Git older than 2.26
 * can't say where an entry comes from: then every risky key is neutralized.
 */
export async function untrustedOverrides(cwd: string, exec: GitExec = execGit): Promise<GitOverride[]> {
  const base = UNTRUSTED_GIT.flatMap(([k, v]) => ['-c', `${k}=${v}`])
  const entries = await exec([...base, 'config', '--list', '--show-scope', '-z'], cwd).then(
    (raw) => parseConfigList(raw, true),
    async () => parseConfigList(await exec([...base, 'config', '--list', '-z'], cwd), false)
  )
  return [...UNTRUSTED_GIT, ...neutralize(entries)]
}

/** Overrides as git's leading arguments. */
export const overrideArgs = (overrides: readonly GitOverride[]): string[] => overrides.flatMap(([k, v]) => ['-c', `${k}=${v}`])

/**
 * The leading arguments for a git call in `cwd`: none when the project is
 * trusted, else the untrusted overrides (see untrustedOverrides).
 */
export async function gitGuard(cwd: string, trusted: boolean, exec?: GitExec): Promise<string[]> {
  return trusted ? [] : overrideArgs(await untrustedOverrides(cwd, exec))
}

/**
 * Overrides for git that another program starts (gh): GIT_CONFIG_PARAMETERS,
 * which every git it runs reads like `-c` — after any already set there.
 */
export function overrideEnv(overrides: readonly GitOverride[], existing?: string): string {
  const quoted = overrides.map(([k, v]) => `'${`${k}=${v}`.replace(/'/g, "'\\''")}'`)
  return [existing, ...quoted].filter(Boolean).join(' ')
}
