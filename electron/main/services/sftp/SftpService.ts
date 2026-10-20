import { lstat, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, join, posix, relative, sep } from 'node:path'
import ignore from 'ignore'
import type { SftpEntry, SftpProgress, SftpTarget } from '@shared/types/sftp'
import { confine } from '../../lib/confine'
import { parseJsonc } from '../migrate/MigrateService'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** What Mindeck needs of an SFTP connection (ssh2-sftp-client; a fake in tests). */
export interface SftpClient {
  connect(options: Record<string, unknown>): Promise<unknown>
  list(path: string): Promise<{ name: string; type: string; size: number; modifyTime: number }[]>
  fastPut(local: string, remote: string): Promise<unknown>
  fastGet(remote: string, local: string): Promise<unknown>
  mkdir(path: string, recursive?: boolean): Promise<unknown>
  end(): Promise<unknown>
}

/** One entry of .vscode/sftp.json (the extension's format), merged with a profile. */
interface RawConfig {
  name?: string
  protocol?: string
  host?: string
  port?: number
  username?: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
  agent?: string
  remotePath?: string
  context?: string
  uploadOnSave?: boolean
  ignore?: string[]
  connectTimeout?: number
  profiles?: Record<string, Partial<RawConfig>>
}

/** Never sent, never fetched. */
const ALWAYS_IGNORED = ['.vscode', '.git', '.DS_Store']

/**
 * SFTP for a project, configured exactly as for the VS Code SFTP extension
 * (.vscode/sftp.json, its profiles and contexts): upload on save, upload and
 * download of files and folders, syncing either way, browsing the server.
 * Passwords stay where the user put them; Mindeck stores nothing extra.
 */
export class SftpService {
  constructor(
    private readonly opts: {
      resolveRoot: (projectId: string) => string | undefined
      /** Whether the project is trusted (WorkspaceTrust): its .vscode/sftp.json counts only then. */
      trusted?: (projectId: string) => boolean
      client?: () => Promise<SftpClient>
      publish?: (progress: SftpProgress) => void
      home?: string
    }
  ) {}

  /** The project's targets — none when it has no .vscode/sftp.json, or isn't trusted. */
  async targets(projectId: string): Promise<SftpTarget[]> {
    if (!this.trusts(projectId)) return []
    return (await this.configs(projectId)).map(({ name, raw }) => ({
      name,
      host: raw.host!,
      username: raw.username,
      remotePath: raw.remotePath ?? '/',
      context: clean(raw.context),
      uploadOnSave: !!raw.uploadOnSave
    }))
  }

  /** A folder on the server (relative to the target's remotePath; '' = remotePath itself). */
  async list(projectId: string, target: string, dir = ''): Promise<SftpEntry[]> {
    return this.session(projectId, target, async ({ client, remote }) => {
      const base = posix.join(remote, dir)
      const items = await client.list(base)
      return items
        .map((i) => ({
          name: i.name,
          path: posix.join(dir, i.name),
          type: i.type === 'd' ? 'dir' : i.type === 'l' ? 'link' : 'file',
          size: i.size,
          modified: i.modifyTime
        }))
        .sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name)) as SftpEntry[]
    })
  }

  /** Upload project files or folders (project-relative paths inside the target's context). */
  async upload(projectId: string, target: string, paths: string[]): Promise<number> {
    return this.session(projectId, target, async ({ client, remote: base, root, context, ig }) => {
      const files: string[] = []
      for (const p of paths) {
        const abs = await confine(root, p)
        if (abs !== context && !abs.startsWith(context + sep)) throw coded('outside-context', `${p} is not inside the SFTP context`)
        await collect(abs, context, ig, files)
      }
      const made = new Set<string>()
      for (const [i, abs] of files.entries()) {
        const rel = relative(context, abs).split(sep).join('/')
        const remote = posix.join(base, rel)
        const dir = posix.dirname(remote)
        if (!made.has(dir)) {
          await client.mkdir(dir, true)
          made.add(dir)
        }
        await client.fastPut(abs, remote)
        this.opts.publish?.({ projectId, action: 'upload', file: relative(root, abs).split(sep).join('/'), done: i + 1, total: files.length })
      }
      return files.length
    })
  }

  /** Download server files or folders (paths relative to remotePath) into the context; returns project-relative paths. */
  async download(projectId: string, target: string, paths: string[]): Promise<string[]> {
    return this.session(projectId, target, async ({ client, remote, root, context, ig }) => {
      const files: string[] = []
      const walk = async (rel: string, type: string) => {
        if (rel && ig.ignores(rel)) return
        if (type !== 'd') return void files.push(rel)
        for (const i of await client.list(posix.join(remote, rel))) await walk(posix.join(rel, i.name), i.type)
      }
      for (const p of paths) {
        const parent = await client.list(posix.join(remote, posix.dirname(p)))
        const entry = p === '' ? { type: 'd' } : parent.find((i) => i.name === posix.basename(p))
        if (!entry) throw coded('not-found', `${p} is not on the server`)
        await walk(p, entry.type)
      }
      const written: string[] = []
      for (const [i, rel] of files.entries()) {
        const local = await confine(context, rel)
        await mkdir(dirname(local), { recursive: true })
        await client.fastGet(posix.join(remote, rel), local)
        written.push(relative(root, local).split(sep).join('/'))
        this.opts.publish?.({ projectId, action: 'download', file: rel, done: i + 1, total: files.length })
      }
      return written
    })
  }

  /** Everything up (local → server) or down (server → local), the ignore list respected. */
  async sync(projectId: string, target: string, direction: 'up' | 'down'): Promise<number> {
    const t = (await this.targets(projectId)).find((x) => x.name === target)
    if (!t) throw coded('not-found', `No SFTP target ${target}`)
    return direction === 'up' ? this.upload(projectId, target, [t.context]) : (await this.download(projectId, target, [''])).length
  }

  // --- helpers ---

  private async configs(projectId: string): Promise<{ name: string; raw: RawConfig }[]> {
    const configured = this.opts.resolveRoot(projectId)
    if (!configured) throw coded('not-found', `Unknown project: ${projectId}`)
    const file = join(configured, '.vscode', 'sftp.json')
    const text = await readFile(file, 'utf8').catch(() => null)
    if (text === null) return []
    let parsed: unknown
    try {
      parsed = parseJsonc(text)
    } catch {
      throw coded('bad-config', '.vscode/sftp.json is not valid JSON')
    }
    const list = (Array.isArray(parsed) ? parsed : [parsed]) as RawConfig[]
    return list.flatMap((raw, i) => {
      const name = raw.name ?? (list.length > 1 ? `${raw.host ?? 'server'} ${i + 1}` : (raw.host ?? 'server'))
      const base = { name, raw }
      const profiles = Object.entries(raw.profiles ?? {}).map(([p, over]) => ({ name: `${name}/${p}`, raw: { ...raw, ...over } }))
      return [base, ...profiles].filter((c) => c.raw.host)
    })
  }

  private trusts(projectId: string): boolean {
    return this.opts.trusted?.(projectId) ?? false
  }

  private async session<T>(projectId: string, target: string, fn: (s: { client: SftpClient; remote: string; root: string; context: string; ig: ReturnType<typeof ignore> }) => Promise<T>): Promise<T> {
    // A repository's sftp.json names a server to send files to (and keys to send along): only once the user trusts the project.
    if (!this.trusts(projectId)) throw coded('untrusted', 'SFTP uses .vscode/sftp.json only in projects you trust')
    const found = (await this.configs(projectId)).find((c) => c.name === target)
    if (!found) throw coded('not-found', `No SFTP target ${target}`)
    const { raw } = found
    if (raw.protocol && raw.protocol !== 'sftp') throw coded('unsupported', `${raw.protocol.toUpperCase()} isn't supported — use SFTP`)
    const root = await realpath(this.opts.resolveRoot(projectId)!)
    const ig = ignore().add([...ALWAYS_IGNORED, ...(raw.ignore ?? []).map((g) => g.replace(/^\//, ''))])
    const client = await (this.opts.client ?? defaultClient)()
    await client.connect(await this.connectOptions(raw))
    try {
      return await fn({ client, remote: raw.remotePath ?? '/', root, context: await confine(root, clean(raw.context)), ig })
    } finally {
      await client.end().catch(() => {})
    }
  }

  private async connectOptions(raw: RawConfig): Promise<Record<string, unknown>> {
    const home = this.opts.home ?? homedir()
    const key = raw.privateKeyPath ? await readFile(raw.privateKeyPath.replace(/^~(?=\/|$)/, home)).catch(() => {
      throw coded('bad-config', `Can't read the private key ${raw.privateKeyPath}`)
    }) : undefined
    return {
      host: raw.host,
      port: raw.port ?? 22,
      // Like ssh: without a user name, the one signed in here.
      username: raw.username || userInfo().username,
      password: raw.password,
      privateKey: key,
      passphrase: raw.passphrase,
      // Without a password or key, the user's SSH agent signs in — as `ssh` would.
      agent: raw.agent ?? (raw.password || key ? undefined : process.env.SSH_AUTH_SOCK),
      readyTimeout: raw.connectTimeout ?? 10_000
    }
  }
}

const clean = (context?: string) => (context ?? '').replace(/^\.?\/+|\/+$/g, '')

/**
 * Files under `abs` (or `abs` itself), relative-to-context ignores respected.
 * Links inside a folder are skipped, never followed: `assets -> ~/.ssh` in a
 * repository would upload the user's keys (`abs` itself passed confine).
 */
async function collect(abs: string, context: string, ig: ReturnType<typeof ignore>, out: string[], top = true): Promise<void> {
  const rel = relative(context, abs).split(sep).join('/')
  if (rel && ig.ignores(rel)) return
  const info = top ? await stat(abs) : await lstat(abs)
  if (info.isSymbolicLink()) return
  if (!info.isDirectory()) return void out.push(abs)
  for (const d of await readdir(abs)) await collect(join(abs, d), context, ig, out, false)
}

async function defaultClient(): Promise<SftpClient> {
  const { default: Client } = await import('ssh2-sftp-client')
  return new Client() as unknown as SftpClient
}
