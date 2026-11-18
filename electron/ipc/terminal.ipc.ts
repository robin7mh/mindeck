import type { Router } from './router'
import type { TerminalService } from '../main/services/terminal/TerminalService'

/** Binds the terminal:* contract channels to TerminalService. */
export function registerTerminalIpc(router: Router, service: TerminalService): void {
  // From a device (phone, web UI) the desktop shows the new shell too; its own it already shows.
  router.register('terminal:create', (req, ctx) => service.create(req, { announce: ctx.transport === 'remote' }))
  router.register('terminal:list', () => service.list())
  router.register('terminal:attach', ({ id }) => service.attach(id))
  router.register('terminal:write', ({ id, data }) => service.write(id, data))
  router.register('terminal:resize', ({ id, cols, rows }) => service.resize(id, cols, rows))
  router.register('terminal:kill', ({ id }) => service.kill(id))
  router.register('terminal:shells', () => service.shells())
  router.register('terminal:settings', () => service.settings())
  router.register('terminal:configure', (patch) => service.configure(patch))
  router.register('terminal:persist', (snapshot) => service.persist(snapshot))
  router.register('terminal:restore', () => service.restore())
}
