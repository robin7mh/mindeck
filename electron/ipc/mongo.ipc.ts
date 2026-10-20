import type { CallContext, Router } from './router'
import type { MongoCallOptions, MongoService } from '../main/services/mongo/MongoService'

/** Server-side JavaScript (`$where`, `$function` …) only from the desktop: a paired device's query never runs code on the database. */
const callOptions = (ctx: CallContext): MongoCallOptions => ({ serverJs: ctx.transport !== 'remote' })

/** Binds the mongo:* channels (the MongoDB for VS Code extension's features) to MongoService. */
export function registerMongoIpc(router: Router, service: MongoService): void {
  router.register('mongo:connections', () => service.connections())
  router.register('mongo:add', ({ name, uri }) => service.add(name, uri))
  router.register('mongo:remove', ({ id }) => service.remove(id))
  router.register('mongo:databases', ({ id }) => service.databases(id))
  router.register('mongo:collections', ({ id, db }) => service.collections(id, db))
  router.register('mongo:createCollection', ({ id, db, name }) => service.createCollection(id, db, name))
  router.register('mongo:dropCollection', ({ id, db, name }) => service.dropCollection(id, db, name))
  router.register('mongo:find', ({ id, db, collection, query }, ctx) => service.find(id, db, collection, query, callOptions(ctx)))
  router.register('mongo:insert', ({ id, db, collection, document }) => service.insert(id, db, collection, document))
  router.register('mongo:replace', ({ id, db, collection, docId, document }) => service.replace(id, db, collection, docId, document))
  router.register('mongo:delete', ({ id, db, collection, docId }) => service.delete(id, db, collection, docId))
  router.register('mongo:aggregate', ({ id, db, collection, pipeline }, ctx) => service.aggregate(id, db, collection, pipeline, callOptions(ctx)))
  router.register('mongo:indexes', ({ id, db, collection }) => service.indexes(id, db, collection))
}
