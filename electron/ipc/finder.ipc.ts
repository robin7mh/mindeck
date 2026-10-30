import type { CallContext, Router } from './router'
import type { FinderService } from '../main/services/finder/FinderService'

/** Binds the finder:* contract channels (the Files module) to FinderService. */
export function registerFinderIpc(router: Router, finder: FinderService): void {
  // Who started each running job (a device's id; none: the desktop) — progress events show every job's id.
  const owners = new Map<string, string | undefined>()
  const own = <T>(id: string, ctx: CallContext, job: T | Promise<T>): Promise<T> => {
    owners.set(id, ctx.deviceId)
    return Promise.resolve(job).finally(() => owners.delete(id))
  }

  router.register('finder:places', () => finder.places())
  router.register('finder:list', ({ path, hidden, offset }) => finder.list(path, hidden, offset))
  router.register('finder:search', ({ path, query }) => finder.search(path, query))
  router.register('finder:preview', ({ path }) => finder.preview(path))
  router.register('finder:mkdir', ({ parent, name }) => finder.mkdir(parent, name))
  router.register('finder:rename', ({ path, name }) => finder.rename(path, name))
  router.register('finder:trash', ({ paths }) => finder.trash(paths))
  router.register('finder:move', ({ paths, dest }) => finder.move(paths, dest))
  router.register('finder:copy', ({ paths, dest }) => finder.copy(paths, dest))
  router.register('finder:untrash', ({ items }) => finder.untrash(items))
  router.register('finder:privacySettings', () => finder.privacySettings())
  router.register('finder:conflicts', ({ paths, dest }) => finder.conflicts(paths, dest))
  router.register('finder:transfer', (req, ctx) => own(req.id, ctx, finder.transfer(req)))
  // The desktop stops anything; a device only what it started.
  router.register('finder:cancel', ({ id }, ctx) => (ctx.transport !== 'remote' || (!!ctx.deviceId && owners.get(id) === ctx.deviceId) ? finder.cancel(id) : undefined))
  router.register('finder:restore', ({ moves }) => finder.restore(moves))
  router.register('finder:info', ({ path }) => finder.info(path))
  router.register('finder:folderSize', ({ path, id }, ctx) => own(id, ctx, finder.folderSize(path, id)))
  router.register('finder:compress', ({ paths, id }, ctx) => own(id, ctx, finder.compress(paths, id)))
  router.register('finder:extract', ({ path, id }, ctx) => own(id, ctx, finder.extract(path, id)))
  router.register('finder:clipboardWrite', ({ paths, cut }) => finder.clipboardWrite(paths, cut))
  router.register('finder:clipboardRead', () => finder.clipboardRead())
  router.register('finder:read', ({ path, offset, length }) => finder.read(path, offset, length))
  router.register('finder:write', ({ path, data, offset, replace }) => finder.write(path, data, offset, replace))
  router.register('finder:open', ({ path }) => finder.open(path))
  router.register('finder:reveal', ({ path }) => finder.reveal(path))
}
