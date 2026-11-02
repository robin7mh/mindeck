import type { Router } from './router'
import type { VaultService } from '../main/services/memory/VaultService'

/** Binds the memory:* contract channels to VaultService. */
export function registerMemoryIpc(router: Router, service: VaultService): void {
  router.register('memory:status', () => service.status())
  router.register('memory:createVault', () => service.createVault())
  router.register('memory:pickVault', () => service.pickVault())
  router.register('memory:list', () => service.list())
  router.register('memory:read', ({ path }) => service.read(path))
  router.register('memory:write', ({ path, raw }) => service.write(path, raw))
  router.register('memory:create', ({ title, folder, template, now }) => service.create(title, folder, template, now))
  router.register('memory:trash', ({ path }) => service.trash(path))
  router.register('memory:graph', () => service.graph())
  router.register('memory:search', ({ query }) => service.search(query))
  router.register('memory:setGraphStyle', (style) => service.setGraphStyle(style))
  router.register('memory:reveal', () => service.reveal())
  router.register('memory:folders', () => service.folders())
  router.register('memory:writeBody', ({ path, body }) => service.writeBody(path, body))
  router.register('memory:createFolder', ({ parent, name }) => service.createFolder(parent, name))
  router.register('memory:rename', ({ path, title }) => service.rename(path, title))
  router.register('memory:move', ({ path, folder }) => service.move(path, folder))
  router.register('memory:moveFolder', ({ folder, into }) => service.moveFolder(folder, into))
  router.register('memory:link', ({ from, to }) => service.link(from, to))
  router.register('memory:unlink', ({ from, to }) => service.unlink(from, to))
  router.register('memory:setVault', ({ path }) => service.setVault(path))
  router.register('memory:daily', ({ now }) => service.daily(now))
  router.register('memory:setDailyNotes', (daily) => service.setDailyNotes(daily))
  router.register('memory:renderTemplate', ({ path, title, now }) => service.renderTemplate(path, title, now))
  router.register('memory:attach', ({ name, data }) => service.attach(name, data))
  router.register('memory:attachment', ({ target, from }) => service.attachment(target, from))
}
