import type { Router } from './router'
import type { FinderService } from '../main/services/finder/FinderService'

/** Binds the finder:* contract channels (the Files module) to FinderService. */
export function registerFinderIpc(router: Router, finder: FinderService): void {
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
  router.register('finder:transfer', (req) => finder.transfer(req))
  router.register('finder:cancel', ({ id }) => finder.cancel(id))
  router.register('finder:restore', ({ moves }) => finder.restore(moves))
  router.register('finder:info', ({ path }) => finder.info(path))
  router.register('finder:folderSize', ({ path, id }) => finder.folderSize(path, id))
  router.register('finder:compress', ({ paths, id }) => finder.compress(paths, id))
  router.register('finder:extract', ({ path, id }) => finder.extract(path, id))
  router.register('finder:clipboardWrite', ({ paths, cut }) => finder.clipboardWrite(paths, cut))
  router.register('finder:clipboardRead', () => finder.clipboardRead())
  router.register('finder:read', ({ path, offset, length }) => finder.read(path, offset, length))
  router.register('finder:write', ({ path, data, offset, replace }) => finder.write(path, data, offset, replace))
  router.register('finder:open', ({ path }) => finder.open(path))
  router.register('finder:reveal', ({ path }) => finder.reveal(path))
}
