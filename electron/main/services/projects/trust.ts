import { posix, win32 } from 'node:path'
import type { Project } from '@shared/types/project'

/**
 * Workspace trust (BE-SEC-01): whether Mindeck may run a project's own tools.
 * Only a project the user trusted is; everything else — a new project, a
 * folder outside every project (an agent's worktree) — is restricted.
 */
export class WorkspaceTrust {
  private readonly path: typeof posix
  private readonly fold: (p: string) => string

  constructor(
    private readonly projects: () => Project[],
    platform: NodeJS.Platform = process.platform
  ) {
    this.path = platform === 'win32' ? win32 : posix
    this.fold = platform === 'win32' || platform === 'darwin' ? (p) => p.toLowerCase() : (p) => p
  }

  /** The project with this id is trusted. */
  project(id: string): boolean {
    return this.projects().find((p) => p.id === id)?.trusted === true
  }

  /**
   * The folder belongs to a trusted project: the innermost project holding it
   * decides (an untrusted clone inside a trusted folder stays untrusted).
   */
  folder(dir: string): boolean {
    const target = this.fold(this.path.resolve(dir))
    let best: Project | undefined
    for (const p of this.projects()) {
      const root = this.fold(this.path.resolve(p.path))
      const inside = target === root || target.startsWith(root.endsWith(this.path.sep) ? root : root + this.path.sep)
      if (inside && (!best || root.length > this.fold(this.path.resolve(best.path)).length)) best = p
    }
    return best?.trusted === true
  }
}
