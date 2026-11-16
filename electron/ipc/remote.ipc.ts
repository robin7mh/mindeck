import type { Router } from './router'
import type { RemoteService } from '../main/services/remote/RemoteService'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Binds the remote:* channels (Remote-SSH, Dev Containers) to RemoteService.
 * Opening a Dev Container runs commands the project names on this computer,
 * before any container exists (`initializeCommand`): only once the user trusts it.
 */
export function registerRemoteIpc(router: Router, service: RemoteService, resolveRoot: (projectId: string) => string | undefined, trusted: (projectId: string) => boolean): void {
  const root = (projectId: string) => {
    const path = resolveRoot(projectId)
    if (!path) throw coded('not-found', `Unknown project: ${projectId}`)
    return path
  }
  router.register('remote:hosts', () => service.hosts())
  router.register('remote:list', () => service.list())
  router.register('remote:ssh', ({ target }) => service.ssh(target))
  router.register('remote:container', ({ projectId }) => {
    if (!trusted(projectId)) throw coded('untrusted', 'A Dev Container runs the project’s own commands on this computer — trust this project first')
    return service.container(root(projectId))
  })
  router.register('remote:hasContainer', ({ projectId }) => service.hasContainer(root(projectId)))
  router.register('remote:disconnect', ({ id }) => service.disconnect(id))
}
