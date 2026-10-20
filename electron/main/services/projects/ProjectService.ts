import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath, stat } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Project } from '@shared/types/project'
import { ProjectRegistry } from './registry'
import { detectGit } from './gitDetect'
import { detectStack } from './stackDetect'
import { desktopOnly, type Platform } from '../../platform/types'
import { openInVsCode } from '../../lib/openInVsCode'
import { gitGuard, gitProgram } from '../../lib/git'

const exec = promisify(execFile)

/** GitHub Desktop's link scheme (its `github` command line tool uses the same). */
const GITHUB_DESKTOP = 'x-github-client://'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Orchestrates the project registry, deterministic detection, and the few
 * Electron-side actions (folder picker, open in editor / GitHub Desktop). Holds no UI
 * state — the renderer talks to it exclusively through the projects:* IPC.
 */
export class ProjectService {
  private readonly trustListeners: ((project: Project) => void)[] = []

  constructor(
    private readonly registry: ProjectRegistry,
    private readonly platform: Platform
  ) {}

  async init(): Promise<void> {
    await this.registry.load()
  }

  list(): Project[] {
    return this.registry.all()
  }

  /** Absolute path for a project id, or undefined (used by ContextService). */
  getProjectPath(id: string): string | undefined {
    return this.registry.get(id)?.path
  }

  /** Native directory picker. Returns null if the user cancels. */
  async pickFolder(): Promise<{ path: string } | null> {
    if (!this.platform.pickFolder) throw desktopOnly('The folder picker')
    const path = await this.platform.pickFolder('Add project folder')
    return path ? { path } : null
  }

  /** `remote`: a paired device adds it — it stays reachable for devices only inside the shared folders. */
  async add(path: string, remote = false): Promise<Project> {
    const canonical = await this.canonicalDir(path)
    const existing = this.registry.findByPath(canonical)
    if (existing) {
      // Added at the desktop after all: the desktop's own project now.
      if (existing.addedRemotely && !remote) await this.registry.upsert({ ...existing, addedRemotely: undefined })
      return this.refresh(existing.id) // idempotent: refresh instead of duplicate
    }

    const now = new Date().toISOString()
    // A new project is restricted until the user trusts it — also one the user added (Project.trusted).
    const [git, stack] = await Promise.all([detectGit(canonical, false), detectStack(canonical)])
    const project: Project = {
      id: randomUUID(),
      name: stack.packageJson?.name?.trim() || basename(canonical),
      path: canonical,
      addedAt: now,
      lastSeenAt: now,
      git,
      stack,
      trusted: false,
      ...(remote ? { addedRemotely: true } : {})
    }
    return this.registry.upsert(project)
  }

  async remove(id: string): Promise<void> {
    await this.registry.remove(id)
  }

  /** Re-run detection for one project (Git/stack are never cached as truth). */
  async refresh(id: string): Promise<Project> {
    const project = this.requireProject(id)
    const [git, stack] = await Promise.all([detectGit(project.path, project.trusted === true), detectStack(project.path)])
    return this.registry.upsert({
      ...project,
      git,
      stack,
      name: stack.packageJson?.name?.trim() || project.name,
      lastSeenAt: new Date().toISOString()
    })
  }

  /** Trust the project (its own tools may run) or restrict it again; listeners restart what runs for it. */
  async trust(id: string, trusted: boolean): Promise<Project> {
    const project = await this.registry.upsert({ ...this.requireProject(id), trusted })
    for (const listener of this.trustListeners) listener(project)
    return project
  }

  /** Called after a project's trust changed. */
  onTrustChange(listener: (project: Project) => void): void {
    this.trustListeners.push(listener)
  }

  async openInEditor(id: string): Promise<void> {
    await openInVsCode(this.requireProject(id).path, this.platform)
  }

  /** Open a specific file (optionally at a line) in the editor. Path-confined. */
  async openFile(id: string, file: string, line?: number): Promise<void> {
    const project = this.requireProject(id)
    const target = resolve(project.path, file)
    // Confine: the resolved target must live inside the project root.
    const rootReal = await realpath(project.path)
    const targetReal = await realpath(target).catch(() => target)
    if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
      throw coded('outside-project', 'Refusing to open a file outside the project')
    }
    const arg = line && line > 0 ? `${target}:${line}` : target
    try {
      await exec('code', ['-g', arg], { windowsHide: true }) // -g = go to file:line
      return
    } catch {
      // `code` not available — reveal the file instead
    }
    await this.openPath(target)
  }

  /** `git pull --ff-only`: new commits from the remote, never a merge commit — then fresh detection. */
  async pull(id: string): Promise<Project> {
    const { path, trusted } = this.requireProject(id)
    try {
      const guard = await gitGuard(path, trusted === true)
      await exec(gitProgram(), [...guard, 'pull', '--ff-only', '--quiet'], { cwd: path, timeout: 60_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    } catch (err) {
      const why = (err as { stderr?: string }).stderr?.trim().split('\n')[0]
      throw Object.assign(new Error(why || (err as Error).message), { code: 'pull-failed' })
    }
    return this.refresh(id)
  }

  /** GitHub Desktop's name when it is installed here, else null. */
  githubDesktop(): string | null {
    return this.platform.appForUrl?.(GITHUB_DESKTOP) || null
  }

  /** Open the project in GitHub Desktop — it adds the repo on first use. */
  async openInGitHubDesktop(id: string): Promise<void> {
    const { path } = this.requireProject(id)
    if (!this.platform.openExternal) throw desktopOnly('GitHub Desktop')
    await this.platform.openExternal(`${GITHUB_DESKTOP}openLocalRepo/${encodeURIComponent(path)}`)
  }

  // --- helpers ---

  private async openPath(path: string): Promise<void> {
    if (!this.platform.openPath) throw desktopOnly('Opening files on this machine')
    await this.platform.openPath(path)
  }

  private requireProject(id: string): Project {
    const project = this.registry.get(id)
    if (!project) throw coded('not-found', `Unknown project: ${id}`)
    return project
  }

  /** Resolve symlinks and assert the path is an existing directory. */
  private async canonicalDir(path: string): Promise<string> {
    const canonical = await realpath(path).catch((err: NodeJS.ErrnoException) => {
      throw err.code === 'ENOENT' ? coded('not-found', `Folder not found: ${path}`) : err
    })
    const info = await stat(canonical)
    if (!info.isDirectory()) throw coded('not-a-dir', 'Selected path is not a directory')
    return canonical
  }
}
