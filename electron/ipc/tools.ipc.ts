import type { Router } from './router'
import type { ToolsService } from '../main/services/tools/ToolsService'

/** Binds the tools:* contract channels (Settings → Languages) to ToolsService. */
export function registerToolsIpc(router: Router, service: ToolsService): void {
  router.register('tools:status', () => service.status())
  router.register('tools:install', ({ id, part }) => service.install(id, part))
  router.register('tools:runtimes', () => service.runtimes())
}
