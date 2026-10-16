import { realpath as realpathCallback } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32, type PlatformPath } from 'node:path'
import { promisify } from 'node:util'
import type { IpcChannel } from '@shared/ipc/contract'
import type { Project } from '@shared/types/project'
import type { DirListing } from '@shared/types/server'

/**
 * Names a paired device never reads, anywhere: keys, credentials, keychains
 * and browser profiles (compared per path segment, ignoring case).
 */
const DENIED: readonly RegExp[] = [
  /^\.(ssh|aws|gnupg|azure|kube|docker|mozilla)$/,
  // A repository's own data: remote URLs carry tokens (`https://x-access-token:ghp_…@github.com`) — scm:* reads git for devices.
  /^\.git$/,
  /^\.env/,
  /^\.(netrc|pgpass|git-credentials|npmrc|pypirc|yarnrc|yarnrc\.yml|htpasswd|terraformrc|dockercfg|boto|s3cfg|my\.cnf)$/,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx|keychain|keychain-db)$/,
  // Terraform state (every secret of the infrastructure), cloud credentials and service accounts, app secrets.
  /\.tfstate(\..*)?$/,
  /^credentials.*\.json$/,
  /service[-_]?account.*\.json$/,
  /^secrets?\.(ya?ml|json)$/,
  /^wp-config\.php$/,
  // SSH keys (`id_rsa`, `id_ed25519.pub`, `id_github`) — not source files such as `id_utils.py`.
  /^id_[^.]*(\.pub)?$/,
  /^keychains$/,
  /^(google-chrome|chromium|bravesoftware|vivaldi)$/,
  /^(cookies|login data|web data|key4\.db|logins\.json|cookies\.sqlite)$/
]

/** A file or folder name on the deny list (keys, credentials, browser profiles), ignoring case. */
export function isDeniedName(name: string): boolean {
  return DENIED.some((re) => re.test(name.toLowerCase()))
}

/** The operating system's own folders: never a device's, nor any folder that holds one. */
function systemDirs(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const drive = process.env.SystemDrive || 'C:'
    return ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData'].map((d) => `${drive}\\${d}`)
  }
  const unix = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/proc', '/run', '/sbin', '/sys', '/usr', '/var/lib', '/var/log', '/var/run', '/var/spool', '/var/cache']
  return platform === 'darwin' ? [...unix, '/System', '/Library', '/Applications', '/cores', '/private/etc', '/private/var/db', '/private/var/root', '/private/var/log'] : unix
}

/** Where external drives are mounted (the Files module reaches them like Home). */
function driveDirs(platform: NodeJS.Platform, home: string, path: PlatformPath): string[] {
  if (platform === 'darwin') return ['/Volumes']
  if (platform === 'linux') return [path.join('/media', path.basename(home)), path.join('/run/media', path.basename(home)), '/mnt']
  return []
}

/** Where the system trash keeps what Mindeck trashed (an undo takes it back from there). */
function trashDirs(platform: NodeJS.Platform, home: string, path: PlatformPath): string[] {
  if (platform === 'darwin') return [path.join(home, '.Trash')]
  if (platform === 'linux') return [path.join(home, '.local', 'share', 'Trash')]
  return []
}

/** Payload fields that name a file inside the call's project. */
const FILE_FIELDS = ['path', 'dir', 'from', 'to'] as const

function filePaths(payload: Record<string, unknown>): string[] {
  const one = FILE_FIELDS.map((k) => payload[k]).filter((v): v is string => typeof v === 'string')
  const many = Array.isArray(payload.paths) ? payload.paths.filter((v): v is string => typeof v === 'string') : []
  return [...one, ...many]
}

/**
 * The OS's own name for a path (Windows: long names, not `ENV~1.LOC`; links
 * followed) — what the deny list must judge, not the spelling a device sent.
 */
const canonical = promisify(realpathCallback.native)

/** A Windows path to another machine or a device (`\\host\share`, `\\?\C:\…`): touching it sends the user's credentials there. */
const NETWORK_PATH = /^[\\/]{2}/

function refused(message: string): Error {
  return Object.assign(new Error(message), { code: 'remote-forbidden' })
}

export interface RemoteAccessDeps {
  /** The folders shared in the settings (or the environment). */
  roots: () => string[]
  projects: () => Project[]
  /** Remote shells allowed: a device could read anything with a shell, so the shared folders no longer bound it. */
  remoteShell: () => boolean
  /** The folder browser. */
  dirs: (path?: string) => Promise<DirListing>
  /** Mindeck's own data (devices, secrets, grants): never reachable, nor any folder holding it. */
  protectedDirs: string[]
  home?: string
  /** The platform's system folders (tests pass their own). */
  systemDirs?: string[]
  /** Where the Files module reaches with remote shells: Home and the drives (tests pass their own). */
  fileRoots?: string[]
  /** Where trashed things lie, for an undo from a device (tests pass their own). */
  trashDirs?: string[]
  platform?: NodeJS.Platform
}

/**
 * What a paired device may reach on the core's machine (§3.1 of the 2026-10
 * analysis). Always off-limits: the home folder itself (and everything above
 * it), system folders, hidden folders, Mindeck's own data and the deny list
 * (keys, credentials, browser profiles). Without remote shells, a device also
 * stays inside the shared folders — the ones set at the desktop plus the
 * projects added there. The Router asks `check` before a remote call runs.
 */
export class RemoteAccess {
  private readonly home: string
  private readonly system: string[]
  private readonly fileRoots: string[]
  private readonly trash: string[]
  private readonly fold: (path: string) => string
  /** The platform's path rules (a Windows core reads its paths the Windows way). */
  private readonly path: PlatformPath
  /** The protected folders as given and resolved (a data folder behind a symlink is still found). */
  private guarded?: Promise<string[]>

  constructor(private readonly deps: RemoteAccessDeps) {
    const platform = deps.platform ?? process.platform
    this.path = platform === 'win32' ? win32 : posix
    this.home = this.path.resolve(deps.home ?? homedir())
    this.system = deps.systemDirs ?? systemDirs(platform)
    this.fileRoots = (deps.fileRoots ?? [this.home, ...driveDirs(platform, this.home, this.path)]).map((r) => this.path.resolve(r))
    this.trash = (deps.trashDirs ?? trashDirs(platform, this.home, this.path)).map((r) => this.path.resolve(r))
    this.fold = platform === 'win32' || platform === 'darwin' ? (p) => p.toLowerCase() : (p) => p
  }

  /** Router guard for remote calls: folders, projects and files named in the payload. */
  async check(channel: IpcChannel, payload: unknown): Promise<void> {
    const p = (payload ?? {}) as Record<string, unknown>
    if (channel === 'projects:add') await this.folder(String(p.path))
    if (channel === 'memory:setVault') await this.vault(String(p.path))
    // projects:remove / refresh / pull / trust name their project as `id`: a device only acts on projects it may use.
    if (channel.startsWith('projects:') && typeof p.id === 'string') await this.project(p.id)
    if (typeof p.projectId === 'string') {
      await this.project(p.projectId)
      await this.files(filePaths(p), p.projectId)
    }
    if (channel === 'agents:diff') this.file(String(p.path))
    if (channel.startsWith('finder:')) await this.finder(channel, p)
  }

  /**
   * A Files call (remote shells on): every path it names inside Home or on a
   * drive — never hidden folders, keys and credentials, system folders or
   * Mindeck's own data; hidden files are not listed. An undo of the trash
   * takes things back only from the trash.
   */
  private async finder(channel: IpcChannel, p: Record<string, unknown>): Promise<void> {
    if (channel === 'finder:list' && p.hidden) throw refused('Hidden files stay on the desktop')
    const str = (v: unknown): v is string => typeof v === 'string'
    const items = Array.isArray(p.items) ? (p.items as { path?: unknown; restore?: unknown }[]) : []
    const moves = Array.isArray(p.moves) ? (p.moves as { from?: unknown; to?: unknown }[]) : []
    const named = [...filePaths(p), p.parent, p.dest, ...items.map((i) => i.path), ...moves.flatMap((m) => [m.from, m.to])].filter(str)
    for (const path of named) await this.reachable(path)
    for (const restore of items.map((i) => i.restore).filter(str)) await this.inTrash(restore)
  }

  /** A path a device's Files may touch: as written and as it really is (links followed). */
  async reachable(path: string): Promise<string> {
    if (!this.path.isAbsolute(path)) throw Object.assign(new Error('Path must be absolute'), { code: 'bad-path' })
    if (this.path === win32 && NETWORK_PATH.test(path)) throw refused('Network and device paths are off-limits for paired devices')
    const abs = this.path.resolve(path)
    // A name that does not exist yet (a new folder, an upload) is judged by its folder.
    const real = await canonical(abs).catch(async () => this.path.join(await canonical(this.path.dirname(abs)).catch(() => this.path.dirname(abs)), this.path.basename(abs)))
    for (const candidate of new Set([abs, real])) {
      const why = await this.fileOffLimits(candidate)
      if (why) throw refused(`${candidate} is off-limits for paired devices (${why})`)
    }
    return real
  }

  /** Why a device's Files may not touch `abs`, or null. */
  private async fileOffLimits(abs: string): Promise<string | null> {
    const root = this.fileRoots.find((r) => this.inside(abs, r))
    if (!root) return 'outside the home folder and drives'
    if (this.system.some((s) => this.inside(abs, s)) || [this.path.join(this.home, 'Library'), this.path.join(this.home, 'AppData')].some((s) => this.inside(abs, s))) return 'a system folder'
    if ((await this.protectedDirs()).some((d) => this.inside(abs, d))) return "Mindeck's own data"
    const segments = this.path.relative(root, abs).split(/[\\/]+/).filter(Boolean)
    if (segments.some((s) => s.startsWith('.'))) return 'a hidden folder'
    if (this.denied(abs)) return 'keys or credentials'
    return null
  }

  /** Something to take back from the trash: inside it, and not a key or credential. */
  private async inTrash(path: string): Promise<void> {
    if (!this.path.isAbsolute(path)) throw Object.assign(new Error('Path must be absolute'), { code: 'bad-path' })
    const real = await canonical(this.path.resolve(path)).catch(() => this.path.resolve(path))
    const bin = this.trash.find((t) => this.inside(real, t) && real !== t)
    if (!bin) throw refused('Only things in the trash can be brought back from a paired device')
    const hit = this.denied(this.path.relative(bin, real))
    if (hit) throw refused(`${hit} is off-limits for paired devices`)
  }

  /** An assistant tool call that a device started: the same rules for the tool's project and files. */
  async tool(input: unknown, projectId?: string): Promise<void> {
    const p = (input ?? {}) as Record<string, unknown>
    const id = typeof p.projectId === 'string' && p.projectId ? p.projectId : projectId
    if (id) await this.project(id, true)
    await this.files(filePaths(p), id, true)
  }

  /**
   * A project a device may use, by id — or (`byName`) also by name, as the
   * assistant's tools accept it: then every project the word could mean must
   * be allowed. Unknown ones are left to the handler ("not found").
   */
  async project(idOrName: string, byName = false): Promise<void> {
    const candidates = this.deps.projects().filter((p) => p.id === idOrName || (byName && p.name === idOrName))
    for (const project of candidates) {
      const why = await this.offLimits(project.path)
      if (why) throw refused(`The project ${project.name} is off-limits for paired devices (${why})`)
      if (!this.deps.remoteShell() && !this.within(project.path, await this.roots())) {
        throw refused(`The project ${project.name} is not in a folder shared with paired devices`)
      }
    }
  }

  /** The projects a device may use (for its project list). */
  async visible(projects: Project[]): Promise<Project[]> {
    const ok = await Promise.all(projects.map((p) => this.project(p.id).then(() => true, () => false)))
    return projects.filter((_, i) => ok[i])
  }

  /** A path inside a project that names something on the deny list. */
  file(path: string): void {
    const hit = this.denied(path)
    if (hit) throw refused(`${hit} is off-limits for paired devices`)
  }

  /**
   * The segment of `path` on the deny list, if any. Windows opens `id_rsa.`,
   * `id_rsa ` and `id_rsa::$DATA` as `id_rsa`: trailing dots and spaces and
   * stream names don't count there.
   */
  denied(path: string): string | undefined {
    const segments = path.split(/[\\/]+/).map((s) => (this.path === win32 ? s.replace(/:.*$/, '').replace(/[. ]+$/, '') : s))
    return segments.find(isDeniedName)
  }

  /** An existing folder a device may add (project, vault) or browse: its canonical path. */
  async folder(path: string): Promise<string> {
    if (!this.path.isAbsolute(path)) throw Object.assign(new Error('Path must be absolute'), { code: 'bad-path' })
    if (this.path === win32 && NETWORK_PATH.test(path)) throw refused('Network and device paths are off-limits for paired devices')
    const abs = await realpath(path).catch(() => {
      throw Object.assign(new Error(`Folder not found: ${path}`), { code: 'not-found' })
    })
    const why = await this.offLimits(abs)
    if (why) throw refused(`${abs} is off-limits for paired devices (${why})`)
    if (!this.deps.remoteShell() && !this.within(abs, await this.roots())) {
      throw refused(`${abs} is not in a folder shared with paired devices — share it in Settings → Remote access on the desktop`)
    }
    return abs
  }

  /**
   * A folder a device makes the vault. Without remote shells never a project's
   * (nor one holding or inside a project): notes there are project files —
   * `CLAUDE.md`, `AGENTS.md`, the README — that a device could not write otherwise.
   */
  private async vault(path: string): Promise<void> {
    const abs = await this.folder(path)
    if (this.deps.remoteShell()) return
    const project = this.deps.projects().find((p) => this.inside(abs, p.path) || this.inside(p.path, abs))
    if (project) throw refused(`The project ${project.name} cannot be the vault of a paired device while remote shells are off`)
  }

  /** The folder browser for a device: the shared folders only (hidden and denied names left out). */
  async dirs(path?: string): Promise<DirListing> {
    const visible = (listing: DirListing): DirListing => ({
      ...listing,
      dirs: listing.dirs.filter((name) => !isDeniedName(name))
    })
    if (this.deps.remoteShell()) return visible(await this.deps.dirs(path))
    const roots = await this.roots()
    if (!roots.length) throw refused('No folders are shared with paired devices — share one in Settings → Remote access on the desktop')
    const abs = await this.folder(path || roots[0])
    const listing = visible(await this.deps.dirs(abs))
    const parent = listing.parent && this.within(listing.parent, roots) ? listing.parent : null
    return { ...listing, parent, home: roots[0], roots }
  }

  /** Shared folders as the settings store them: absolute, existing, canonical, allowed — or a coded error. */
  async validateRoots(roots: string[]): Promise<string[]> {
    const out: string[] = []
    for (const root of roots) {
      const abs = this.path.isAbsolute(root) ? await realpath(root).catch(() => null) : null
      if (!abs) throw Object.assign(new Error(`Not an existing folder: ${root}`), { code: 'bad-root' })
      const why = await this.offLimits(abs)
      if (why) throw Object.assign(new Error(`${abs} cannot be shared with paired devices (${why})`), { code: 'bad-root' })
      if (!(await stat(abs)).isDirectory()) throw Object.assign(new Error(`Not a folder: ${abs}`), { code: 'bad-root' })
      if (!out.includes(abs)) out.push(abs)
    }
    return out
  }

  /** Shared folders now: the configured ones that exist and are allowed, then the desktop's projects. */
  private async roots(): Promise<string[]> {
    const configured = await Promise.all(this.deps.roots().map((r) => (this.path.isAbsolute(r) ? realpath(r).catch(() => null) : null)))
    const desktop = this.deps.projects().filter((p) => !p.addedRemotely).map((p) => p.path)
    const all = [...new Set([...configured, ...desktop])].filter((r): r is string => !!r)
    const allowed = await Promise.all(all.map(async (r) => !(await this.offLimits(r))))
    return all.filter((_, i) => allowed[i])
  }

  /** Mindeck's own data folders, as given and resolved (a data folder behind a symlink is still found). */
  private protectedDirs(): Promise<string[]> {
    this.guarded ??= Promise.all(this.deps.protectedDirs.map(async (d) => [this.path.resolve(d), await realpath(d).catch(() => this.path.resolve(d))])).then((l) => l.flat())
    return this.guarded
  }

  /** Why a folder is never a device's, or null. */
  private async offLimits(abs: string): Promise<string | null> {
    const guarded = await this.protectedDirs()
    if (this.path.dirname(abs) === abs) return 'the disk itself'
    if (this.inside(this.home, abs)) return 'the home folder'
    if (this.system.some((s) => this.inside(abs, s) || this.inside(s, abs)) || [this.path.join(this.home, 'Library'), this.path.join(this.home, 'AppData')].some((s) => this.inside(abs, s))) {
      return 'a system folder'
    }
    if (guarded.some((d) => this.inside(abs, d) || this.inside(d, abs))) return "Mindeck's own data"
    const segments = abs.split(/[\\/]+/)
    if (segments.some((s) => s.startsWith('.'))) return 'a hidden folder'
    if (segments.some(isDeniedName)) return 'keys or credentials'
    return null
  }

  /**
   * Files a call names in a project: by how they are written, and — for those
   * that exist inside it — by what they really are (a link to `~/.ssh`, a
   * Windows short name such as `ENV~1.LOC`). Paths that leave the project are
   * the handler's to refuse; nothing outside it is touched here.
   */
  private async files(paths: string[], projectId?: string, byName = false): Promise<void> {
    for (const file of paths) this.file(file)
    if (!paths.length) return
    for (const project of this.deps.projects().filter((p) => p.id === projectId || (byName && p.name === projectId))) {
      const root = await canonical(project.path).catch(() => null)
      if (!root) continue
      for (const file of paths) {
        const abs = this.path.resolve(root, file)
        if (!this.inside(abs, root)) continue
        const real = await canonical(abs).catch(() => null)
        if (real) this.file(this.path.relative(root, real))
      }
    }
  }

  private within(abs: string, roots: string[]): boolean {
    return roots.some((r) => this.inside(abs, r))
  }

  /** `path` is `dir` or inside it (either separator: a Windows path reads the same everywhere). */
  private inside(path: string, dir: string): boolean {
    const p = this.fold(path)
    const d = this.fold(dir).replace(/[\\/]+$/, '')
    return p === d || (p.startsWith(d) && /[\\/]/.test(p.charAt(d.length)))
  }
}
