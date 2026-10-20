import type { Project } from '@shared/types/project'
import type { Router } from './router'
import type { ProjectService } from '../main/services/projects/ProjectService'

/**
 * Binds the projects:* contract channels to ProjectService methods. Paired
 * devices see only the projects they may use (`remote`, the RemoteAccess rules).
 */
export function registerProjectIpc(router: Router, service: ProjectService, remote?: { visible(projects: Project[]): Promise<Project[]> }): void {
  router.register('projects:list', (_req, ctx) => (ctx.transport === 'remote' && remote ? remote.visible(service.list()) : service.list()))
  router.register('projects:pickFolder', () => service.pickFolder())
  router.register('projects:add', ({ path }, ctx) => service.add(path, ctx.transport === 'remote'))
  router.register('projects:remove', ({ id }) => service.remove(id))
  router.register('projects:refresh', ({ id }) => service.refresh(id))
  router.register('projects:pull', ({ id }) => service.pull(id))
  router.register('projects:openInEditor', ({ id }) => service.openInEditor(id))
  router.register('projects:githubDesktop', () => service.githubDesktop())
  router.register('projects:openInGitHubDesktop', ({ id }) => service.openInGitHubDesktop(id))
  router.register('projects:openFile', ({ id, file, line }) => service.openFile(id, file, line))
  router.register('projects:trust', ({ id, trusted }) => service.trust(id, trusted))
}
