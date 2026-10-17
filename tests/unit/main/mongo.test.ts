import { describe, expect, it } from 'vitest'
import { hostOf, mongoDriver, MongoService, type MongoClientLike, type MongoCollectionLike, type MongoDriver } from '../../../electron/main/services/mongo/MongoService'

type Doc = Record<string, unknown> & { _id?: unknown }

/** An in-memory MongoDB: databases of collections of documents (filters match by equality). */
function fakeMongo(opts: { failConnect?: string; failList?: boolean; failClose?: boolean } = {}) {
  const data: Record<string, Record<string, Doc[]>> = { shop: { users: [{ _id: 1, name: 'Ann', age: 31 }, { _id: 2, name: 'Bob', age: 25 }], views: [] }, empty: {} }
  const calls: string[] = []
  let closed = 0
  let nextId = 10
  const matches = (doc: Doc, filter: object) => Object.entries(filter).every(([k, v]) => JSON.stringify(doc[k]) === JSON.stringify(v))
  const collection = (db: string, name: string): MongoCollectionLike => {
    const docs = () => (data[db][name] ??= [])
    return {
      find: (filter) => {
        let list = docs().filter((d) => matches(d, filter))
        const cursor = {
          sort: (s: object) => {
            const [[key, dir]] = Object.entries(s) as [string, number][]
            list = [...list].sort((a, b) => ((a[key] as number) - (b[key] as number)) * dir)
            return cursor
          },
          project: (p: object) => {
            calls.push(`project ${JSON.stringify(p)}`)
            return cursor
          },
          skip: (n: number) => ((list = list.slice(n)), cursor),
          limit: (n: number) => (calls.push(`limit ${n}`), (list = list.slice(0, n)), cursor),
          toArray: async () => list
        }
        return cursor
      },
      countDocuments: async (filter, o) => (calls.push(`count cap ${o.limit}`), docs().filter((d) => matches(d, filter)).length),
      insertOne: async (doc) => {
        const _id = (doc as Doc)._id ?? nextId++
        docs().push({ ...(doc as Doc), _id })
        return { insertedId: _id }
      },
      replaceOne: async (filter, doc) => {
        const i = docs().findIndex((d) => matches(d, filter))
        if (i >= 0) docs()[i] = doc as Doc
        return { matchedCount: i >= 0 ? 1 : 0 }
      },
      deleteOne: async (filter) => {
        const i = docs().findIndex((d) => matches(d, filter))
        if (i >= 0) docs().splice(i, 1)
        return { deletedCount: i >= 0 ? 1 : 0 }
      },
      aggregate: (pipeline) => ({ toArray: async () => (calls.push(`aggregate ${JSON.stringify(pipeline)}`), [{ _id: null, n: docs().length }]) }),
      indexes: async () => [{ name: '_id_', key: { _id: 1 } }, { name: 'email_1', key: { email: 1 }, unique: true }]
    }
  }
  const client: MongoClientLike = {
    db: (name = 'admin') => ({
      listCollections: () => ({ toArray: async () => Object.keys(data[name] ?? {}).map((c) => (c === 'views' ? { name: c, type: 'view' } : { name: c })) }),
      collection: (c) => collection(name, c),
      createCollection: async (c) => (data[name][c] = []),
      dropCollection: async (c) => delete data[name][c],
      admin: () => ({
        listDatabases: async () => {
          if (opts.failList) throw new Error('not authorized')
          return { databases: [{ name: 'shop', sizeOnDisk: 8192 }, { name: 'empty', empty: true }, { name: 'admin' }] }
        }
      })
    }),
    close: async () => {
      closed++
      if (opts.failClose) throw new Error('connection reset')
    }
  }
  const connects: string[] = []
  const driver: MongoDriver = {
    connect: async (uri) => {
      connects.push(uri)
      if (opts.failConnect) throw new Error(opts.failConnect)
      return client
    },
    parse: (text) => JSON.parse(text),
    stringify: (value) => JSON.stringify(value)
  }
  return { data, driver, calls, connects, closed: () => closed }
}

function secrets(initial?: string) {
  const mem = new Map<string, string>(initial === undefined ? [] : [['mongo.connections', initial]])
  return { mem, store: { get: async (k: string) => mem.get(k), set: async (k: string, v: string | null) => void (v === null ? mem.delete(k) : mem.set(k, v)) } }
}

const setup = (m = fakeMongo(), s = secrets()) => ({ ...m, ...s, svc: new MongoService({ secrets: s.store, driver: async () => m.driver }) })

describe('MongoDB', () => {
  it('connection strings are shown without credentials', () => {
    expect(hostOf('mongodb://user:secret@db.example.com:27017/shop?authSource=admin')).toBe('mongodb://db.example.com:27017/shop')
    expect(hostOf('mongodb+srv://u:p@cluster0.abc.mongodb.net/?retryWrites=true')).toBe('mongodb+srv://cluster0.abc.mongodb.net')
    expect(hostOf('mongodb://localhost')).toBe('mongodb://localhost')
    expect(hostOf('weird')).toBe('weird')
  })

  it('saves a connection only once it answers; the string stays in the secret store; removing closes it', async () => {
    const t = setup()
    expect(await t.svc.connections()).toEqual([])
    await expect(t.svc.add('x', 'http://nope')).rejects.toMatchObject({ code: 'bad-uri' })
    const c = await t.svc.add('  Prod ', ' mongodb://me:pw@db:27017/shop ')
    expect(c).toMatchObject({ name: 'Prod', host: 'mongodb://db:27017/shop' })
    expect(JSON.parse(t.mem.get('mongo.connections')!)).toEqual([{ id: c.id, name: 'Prod', uri: 'mongodb://me:pw@db:27017/shop' }])
    expect(await t.svc.connections()).toEqual([{ id: c.id, name: 'Prod', host: 'mongodb://db:27017/shop' }])
    const unnamed = await t.svc.add('', 'mongodb://localhost')
    expect(unnamed.name).toBe('mongodb://localhost')
    expect(t.connects).toHaveLength(2) // the clients from adding are kept
    await t.svc.databases(c.id)
    expect(t.connects).toHaveLength(2)
    await t.svc.remove(c.id)
    await t.svc.remove(unnamed.id)
    expect(t.mem.has('mongo.connections')).toBe(false)
    expect(t.closed()).toBe(2)

    const refused = setup(fakeMongo({ failConnect: 'connect ECONNREFUSED 127.0.0.1:27017' }))
    await expect(refused.svc.add('x', 'mongodb://localhost')).rejects.toMatchObject({ code: 'mongo-connect', message: 'connect ECONNREFUSED 127.0.0.1:27017' })
    const unauthorized = setup(fakeMongo({ failList: true }))
    await expect(unauthorized.svc.add('x', 'mongodb://localhost')).rejects.toMatchObject({ message: 'not authorized' })
    expect(await unauthorized.svc.connections()).toEqual([])
    // a client that fails to close is gone all the same
    const stuck = setup(fakeMongo({ failClose: true }))
    const s1 = await stuck.svc.add('x', 'mongodb://localhost')
    await stuck.svc.remove(s1.id)
    expect(await stuck.svc.connections()).toEqual([])
    expect(stuck.closed()).toBe(1)
  })

  it('opens saved connections on first use (again after a failure); broken storage is no connections', async () => {
    const m = fakeMongo()
    const s = secrets(JSON.stringify([{ id: 'c1', name: 'Saved', uri: 'mongodb://saved' }]))
    const t = setup(m, s)
    expect(await t.svc.databases('c1')).toEqual([
      { name: 'admin', sizeOnDisk: 0, empty: false },
      { name: 'empty', sizeOnDisk: 0, empty: true },
      { name: 'shop', sizeOnDisk: 8192, empty: false }
    ])
    expect(m.connects).toEqual(['mongodb://saved'])
    await expect(t.svc.databases('nope')).rejects.toMatchObject({ code: 'not-found' })

    let fail = true
    const flaky: MongoDriver = { ...m.driver, connect: async (uri) => (fail ? Promise.reject(new Error('down')) : m.driver.connect(uri)) }
    const again = new MongoService({ secrets: s.store, driver: async () => flaky })
    await expect(again.collections('c1', 'shop')).rejects.toMatchObject({ code: 'mongo-connect' })
    await new Promise((r) => setTimeout(r, 0))
    fail = false
    expect(await again.collections('c1', 'shop')).toEqual([
      { name: 'users', type: 'collection' },
      { name: 'views', type: 'view' }
    ])
    await again.dispose()

    expect(await setup(fakeMongo(), secrets('{broken')).svc.connections()).toEqual([])
  })

  it('collections: create, drop; documents: find with filter, sort, projection, paging; insert, replace, delete', async () => {
    const t = setup(fakeMongo(), secrets(JSON.stringify([{ id: 'c', name: 'C', uri: 'mongodb://x' }])))
    await t.svc.createCollection('c', 'shop', 'orders')
    expect((await t.svc.collections('c', 'shop')).map((c) => c.name)).toEqual(['orders', 'users', 'views'])
    await t.svc.dropCollection('c', 'shop', 'orders')
    expect(t.data.shop.orders).toBeUndefined()

    const all = await t.svc.find('c', 'shop', 'users')
    expect(all).toEqual({ documents: ['{"_id":1,"name":"Ann","age":31}', '{"_id":2,"name":"Bob","age":25}'], total: 2 })
    expect(t.calls).toEqual(['limit 50', 'count cap 100000'])
    const sorted = await t.svc.find('c', 'shop', 'users', { filter: ' ', sort: '{"age": 1}', projection: '{"name": 1}', skip: 1, limit: 5000 })
    expect(sorted.documents).toEqual(['{"_id":1,"name":"Ann","age":31}'])
    expect(t.calls.slice(2)).toEqual(['project {"name":1}', 'limit 1000', 'count cap 100000'])
    expect((await t.svc.find('c', 'shop', 'users', { filter: '{"name": "Bob"}' })).total).toBe(1)
    await expect(t.svc.find('c', 'shop', 'users', { filter: '{nope' })).rejects.toMatchObject({ code: 'bad-json', message: expect.stringContaining("The filter isn't valid JSON") })
    await expect(t.svc.find('c', 'shop', 'users', { sort: '[1]' })).rejects.toMatchObject({ code: 'bad-json', message: 'The sort must be an object: { … }' })
    await expect(t.svc.find('c', 'shop', 'users', { filter: 'null' })).rejects.toMatchObject({ code: 'bad-json' })

    const id = await t.svc.insert('c', 'shop', 'users', '{"name": "Cleo"}')
    expect(id).toBe('10')
    await expect(t.svc.insert('c', 'shop', 'users', '')).resolves.toBe('11') // an empty document
    await t.svc.replace('c', 'shop', 'users', id, '{"name": "Cleo B.", "_id": 99}')
    expect(t.data.shop.users.find((d) => d._id === 10)).toEqual({ name: 'Cleo B.', _id: 10 })
    await expect(t.svc.replace('c', 'shop', 'users', '404', '{}')).rejects.toMatchObject({ code: 'not-found' })
    await t.svc.delete('c', 'shop', 'users', id)
    await expect(t.svc.delete('c', 'shop', 'users', id)).rejects.toMatchObject({ code: 'not-found' })
  })

  it('aggregations (capped) and indexes', async () => {
    const t = setup(fakeMongo(), secrets(JSON.stringify([{ id: 'c', name: 'C', uri: 'mongodb://x' }])))
    expect(await t.svc.aggregate('c', 'shop', 'users', '[{"$match": {}}]')).toEqual(['{"_id":null,"n":2}'])
    expect(t.calls.at(-1)).toBe('aggregate [{"$match":{}},{"$limit":1000}]')
    expect(await t.svc.aggregate('c', 'shop', 'users', '')).toHaveLength(1)
    await expect(t.svc.aggregate('c', 'shop', 'users', '{"$match": {}}')).rejects.toMatchObject({ code: 'bad-json', message: expect.stringContaining('list of stages') })
    expect(await t.svc.indexes('c', 'shop', 'users')).toEqual([
      { name: '_id_', key: '{"_id":1}', unique: false },
      { name: 'email_1', key: '{"email":1}', unique: true }
    ])
  })

  it('the real driver: Extended JSON both ways; a server that isn’t there', async () => {
    const driver = await mongoDriver()
    const doc = driver.parse('{"_id": {"$oid": "6acd597170296b89e1a597c3"}, "at": {"$date": "2024-01-02T00:00:00Z"}, "n": 1}') as Record<string, unknown>
    expect(doc._id?.constructor.name).toBe('ObjectId')
    expect(doc.at).toBeInstanceOf(Date)
    expect(JSON.parse(driver.stringify(doc))).toEqual({ _id: { $oid: '6acd597170296b89e1a597c3' }, at: { $date: '2024-01-02T00:00:00Z' }, n: 1 })
    const svc = new MongoService({ secrets: secrets().store })
    await expect(svc.add('x', 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=300')).rejects.toMatchObject({ code: 'mongo-connect' })
  }, 20_000)
})
