import type { Router } from './router'
import type { SearchService } from '../main/services/search/SearchService'
import type { RemoteAccess } from '../main/server/RemoteAccess'

/**
 * Binds the search:* contract channels (the editor's project-wide search) to
 * SearchService. A paired device's search leaves out the files its deny list
 * names (RemoteAccess) and reports to that device only.
 */
export function registerSearchIpc(router: Router, service: SearchService, access: Pick<RemoteAccess, 'denied'>): void {
  const hidden = (path: string) => !!access.denied(path)
  router.register('search:start', ({ id, projectId, query }, ctx) =>
    service.start(id, projectId, query, ctx.transport === 'remote' ? { device: ctx.deviceId, hidden } : undefined)
  )
  router.register('search:cancel', ({ id }, ctx) => service.cancel(id, ctx.transport === 'remote' ? (ctx.deviceId ?? '') : undefined))
}
