import { randomUUID } from 'node:crypto'
import type { MongoCollection, MongoConnection, MongoDatabase, MongoDocuments, MongoIndex, MongoQuery } from '@shared/types/mongo'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** The part of the driver Mindeck uses (tests give a stand-in). */
export interface MongoDriver {
  connect(uri: string): Promise<MongoClientLike>
  /** Extended JSON. */
  parse(text: string): unknown
  stringify(value: unknown): string
}

export interface MongoCursorLike {
  sort(sort: object): MongoCursorLike
  project(projection: object): MongoCursorLike
  skip(n: number): MongoCursorLike
  limit(n: number): MongoCursorLike
  toArray(): Promise<object[]>
}

export interface MongoCollectionLike {
  find(filter: object): MongoCursorLike
  countDocuments(filter: object, opts: { limit: number }): Promise<number>
  insertOne(doc: object): Promise<{ insertedId: unknown }>
  replaceOne(filter: object, doc: object): Promise<{ matchedCount: number }>
  deleteOne(filter: object): Promise<{ deletedCount: number }>
  aggregate(pipeline: object[]): { toArray(): Promise<object[]> }
  indexes(): Promise<{ name: string; key: object; unique?: boolean }[]>
}

export interface MongoDbLike {
  listCollections(): { toArray(): Promise<{ name: string; type?: string }[]> }
  collection(name: string): MongoCollectionLike
  createCollection(name: string): Promise<unknown>
  dropCollection(name: string): Promise<unknown>
  admin(): { listDatabases(): Promise<{ databases: { name: string; sizeOnDisk?: number; empty?: boolean }[] }> }
}

export interface MongoClientLike {
  db(name?: string): MongoDbLike
  close(): Promise<void>
}

/** The real driver, loaded when the first connection opens. */
export async function mongoDriver(): Promise<MongoDriver> {
  const { MongoClient, BSON } = await import('mongodb')
  const { EJSON } = BSON
  return {
    connect: async (uri) => (await new MongoClient(uri, { serverSelectionTimeoutMS: 8000, appName: 'Mindeck' }).connect()) as unknown as MongoClientLike,
    parse: (text) => EJSON.parse(text, { relaxed: true }),
    stringify: (value) => EJSON.stringify(value as never, undefined, 2, { relaxed: true })
  }
}

interface Saved {
  id: string
  name: string
  uri: string
}

export interface MongoOptions {
  secrets: { get(name: string): Promise<string | undefined>; set(name: string, value: string | null): Promise<void> }
  driver?: () => Promise<MongoDriver>
}

const SECRET = 'mongo.connections'
/** Counting stops here (a huge collection would take long). */
const COUNT_CAP = 100_000
const MAX_LIMIT = 1000

/**
 * Operators that run JavaScript on the database server (`$where`,
 * `$function`, `$accumulator` and the old `$eval`): a filter or pipeline from
 * a paired device must not load the database with code of its own. A BSON
 * `Code` value (`{"$code": …}` in Extended JSON) is JavaScript, too.
 */
const SERVER_JS = new Set(['$where', '$function', '$accumulator', '$eval'])

/** Whether a query or pipeline may run JavaScript on the server: typed at the desktop yes, from a device no. */
export interface MongoCallOptions {
  serverJs?: boolean
}

/** The first server-side JavaScript in a parsed filter, projection, sort or pipeline (at any depth), or null. */
export function serverScript(value: unknown, seen = new Set<object>()): string | null {
  if (!value || typeof value !== 'object' || seen.has(value)) return null
  seen.add(value)
  if ((value as { _bsontype?: unknown })._bsontype === 'Code') return '$code'
  for (const [key, inner] of Object.entries(value)) {
    if (SERVER_JS.has(key)) return key
    const found = serverScript(inner, seen)
    if (found) return found
  }
  return null
}

/** mongodb://user:pass@host/db?x → mongodb://host/db (no credentials, no options). */
export function hostOf(uri: string): string {
  const m = /^(mongodb(?:\+srv)?:\/\/)(?:[^@/]*@)?([^/?]*)(\/[^?]*)?/.exec(uri)
  return m ? `${m[1]}${m[2]}${m[3] && m[3] !== '/' ? m[3] : ''}` : uri
}

/**
 * MongoDB from the editor (the MongoDB for VS Code extension): saved
 * connections whose strings stay encrypted in the core, browsing databases
 * and collections, finding, inserting, replacing and deleting documents,
 * aggregations and indexes. One client per connection, opened on first use.
 */
export class MongoService {
  private clients = new Map<string, Promise<MongoClientLike>>()
  private driver?: Promise<MongoDriver>

  constructor(private readonly opts: MongoOptions) {}

  async connections(): Promise<MongoConnection[]> {
    return (await this.saved()).map(({ id, name, uri }) => ({ id, name, host: hostOf(uri) }))
  }

  /** Save a connection — only after it answered. */
  async add(name: string, uri: string): Promise<MongoConnection> {
    const trimmed = uri.trim()
    if (!/^mongodb(\+srv)?:\/\//.test(trimmed)) throw coded('bad-uri', 'A connection string starts with mongodb:// or mongodb+srv://')
    const client = await this.open(trimmed)
    await client.db().admin().listDatabases()
    const saved: Saved = { id: randomUUID(), name: name.trim() || hostOf(trimmed), uri: trimmed }
    this.clients.set(saved.id, Promise.resolve(client))
    await this.store([...(await this.saved()), saved])
    return { id: saved.id, name: saved.name, host: hostOf(trimmed) }
  }

  async remove(id: string): Promise<void> {
    await this.close(id)
    await this.store((await this.saved()).filter((c) => c.id !== id))
  }

  async databases(id: string): Promise<MongoDatabase[]> {
    const { databases } = await (await this.client(id)).db().admin().listDatabases()
    return databases.map((d) => ({ name: d.name, sizeOnDisk: d.sizeOnDisk ?? 0, empty: !!d.empty })).sort((a, b) => a.name.localeCompare(b.name))
  }

  async collections(id: string, db: string): Promise<MongoCollection[]> {
    const list = await (await this.client(id)).db(db).listCollections().toArray()
    return list.map((c) => ({ name: c.name, type: c.type ?? 'collection' })).sort((a, b) => a.name.localeCompare(b.name))
  }

  async createCollection(id: string, db: string, name: string): Promise<void> {
    await (await this.client(id)).db(db).createCollection(name)
  }

  async dropCollection(id: string, db: string, name: string): Promise<void> {
    await (await this.client(id)).db(db).dropCollection(name)
  }

  async find(id: string, db: string, collection: string, query: MongoQuery = {}, opts: MongoCallOptions = {}): Promise<MongoDocuments> {
    const c = (await this.client(id)).db(db).collection(collection)
    const driver = await this.loadDriver()
    const filter = this.object(driver, query.filter, 'filter', opts)
    let cursor = c.find(filter)
    if (query.sort?.trim()) cursor = cursor.sort(this.object(driver, query.sort, 'sort', opts))
    if (query.projection?.trim()) cursor = cursor.project(this.object(driver, query.projection, 'projection', opts))
    if (query.skip) cursor = cursor.skip(query.skip)
    cursor = cursor.limit(Math.min(query.limit || 50, MAX_LIMIT))
    const [docs, total] = await Promise.all([cursor.toArray(), c.countDocuments(filter, { limit: COUNT_CAP })])
    return { documents: docs.map((d) => driver.stringify(d)), total }
  }

  /** Insert a document (Extended JSON); returns its _id as Extended JSON. */
  async insert(id: string, db: string, collection: string, document: string): Promise<string> {
    const driver = await this.loadDriver()
    const doc = this.object(driver, document, 'document')
    const { insertedId } = await (await this.client(id)).db(db).collection(collection).insertOne(doc)
    return driver.stringify(insertedId)
  }

  /** Replace the document with this _id (both Extended JSON). */
  async replace(id: string, db: string, collection: string, docId: string, document: string): Promise<void> {
    const driver = await this.loadDriver()
    const _id = driver.parse(docId)
    const doc = this.object(driver, document, 'document') as Record<string, unknown>
    const { matchedCount } = await (await this.client(id)).db(db).collection(collection).replaceOne({ _id }, { ...doc, _id })
    if (!matchedCount) throw coded('not-found', 'The document is gone (deleted elsewhere?)')
  }

  async delete(id: string, db: string, collection: string, docId: string): Promise<void> {
    const driver = await this.loadDriver()
    const { deletedCount } = await (await this.client(id)).db(db).collection(collection).deleteOne({ _id: driver.parse(docId) })
    if (!deletedCount) throw coded('not-found', 'The document is gone (deleted elsewhere?)')
  }

  async aggregate(id: string, db: string, collection: string, pipeline: string, opts: MongoCallOptions = {}): Promise<string[]> {
    const driver = await this.loadDriver()
    const stages = driver.parse(pipeline || '[]')
    if (!Array.isArray(stages)) throw coded('bad-json', 'A pipeline is a list of stages: [{ "$match": … }]')
    this.noScript(stages, 'pipeline', opts)
    const docs = await (await this.client(id)).db(db).collection(collection).aggregate([...(stages as object[]), { $limit: MAX_LIMIT }]).toArray()
    return docs.map((d) => driver.stringify(d))
  }

  async indexes(id: string, db: string, collection: string): Promise<MongoIndex[]> {
    const list = await (await this.client(id)).db(db).collection(collection).indexes()
    return list.map((i) => ({ name: i.name, key: JSON.stringify(i.key), unique: !!i.unique }))
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((id) => this.close(id)))
  }

  // --- helpers ---

  private loadDriver(): Promise<MongoDriver> {
    this.driver ??= (this.opts.driver ?? mongoDriver)()
    return this.driver
  }

  private async open(uri: string): Promise<MongoClientLike> {
    try {
      return await (await this.loadDriver()).connect(uri)
    } catch (err) {
      throw coded('mongo-connect', (err as Error).message)
    }
  }

  private async client(id: string): Promise<MongoClientLike> {
    let client = this.clients.get(id)
    if (!client) {
      const saved = (await this.saved()).find((c) => c.id === id)
      if (!saved) throw coded('not-found', 'No such connection')
      client = this.open(saved.uri)
      this.clients.set(id, client)
      client.catch(() => this.clients.delete(id))
    }
    return client
  }

  private async close(id: string): Promise<void> {
    const client = this.clients.get(id)
    this.clients.delete(id)
    await client?.then((c) => c.close()).catch(() => {})
  }

  /** Server-side JavaScript refused unless the call allows it (the desktop's own). */
  private noScript(value: unknown, what: string, opts: MongoCallOptions): void {
    const found = opts.serverJs === false ? serverScript(value) : null
    if (found) throw coded('remote-forbidden', `${found} runs JavaScript on the database server: not from a paired device (the ${what} uses it)`)
  }

  /** Extended JSON that must be an object ('' → {}). */
  private object(driver: MongoDriver, text: string | undefined, what: string, opts: MongoCallOptions = {}): object {
    if (!text?.trim()) return {}
    let value: unknown
    try {
      value = driver.parse(text)
    } catch (err) {
      throw coded('bad-json', `The ${what} isn't valid JSON: ${(err as Error).message}`)
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw coded('bad-json', `The ${what} must be an object: { … }`)
    this.noScript(value, what, opts)
    return value
  }

  private async saved(): Promise<Saved[]> {
    const raw = await this.opts.secrets.get(SECRET)
    try {
      return raw ? (JSON.parse(raw) as Saved[]) : []
    } catch {
      return []
    }
  }

  private async store(list: Saved[]): Promise<void> {
    await this.opts.secrets.set(SECRET, list.length ? JSON.stringify(list) : null)
  }
}
