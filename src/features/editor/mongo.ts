import { create } from 'zustand'
import { errorMessage, ipc } from '@shared/ipc/client'
import type { MongoCollection, MongoConnection, MongoDatabase, MongoIndex } from '@shared/types/mongo'

/** The collection shown in the editor area. */
export interface MongoTarget {
  id: string
  db: string
  collection: string
}

export type MongoMode = 'find' | 'aggregate' | 'indexes'

/** A document being edited: an existing one (by its _id) or a new one. */
export interface MongoEdit {
  docId?: string
  text: string
}

interface MongoState {
  connections: MongoConnection[]
  /** Open tree rows: a connection id, or `id/db`. */
  expanded: Record<string, boolean>
  databases: Record<string, MongoDatabase[]>
  collections: Record<string, MongoCollection[]>
  open?: MongoTarget
  mode: MongoMode
  filter: string
  sort: string
  limit: number
  skip: number
  pipeline: string
  documents: string[]
  total: number
  indexes: MongoIndex[]
  editing?: MongoEdit
  busy: boolean
  /** The "add connection" form is open. */
  adding: boolean
  error?: string

  load: () => Promise<void>
  setAdding: (on: boolean) => void
  add: (name: string, uri: string) => Promise<boolean>
  remove: (id: string) => Promise<void>
  toggle: (key: string) => Promise<void>
  /** Show a collection: its first documents. */
  openCollection: (target: MongoTarget) => Promise<void>
  close: () => void
  setMode: (mode: MongoMode) => void
  setQuery: (patch: Partial<Pick<MongoState, 'filter' | 'sort' | 'limit' | 'pipeline'>>) => void
  /** Run the find (from `skip`) or the aggregation. */
  run: (skip?: number) => Promise<void>
  edit: (document: string) => void
  newDocument: () => void
  setEditText: (text: string) => void
  cancelEdit: () => void
  /** Insert the new document or replace the edited one. */
  saveEdit: () => Promise<void>
  deleteDocument: (document: string) => Promise<void>
  createCollection: (id: string, db: string, name: string) => Promise<void>
  dropCollection: (target: MongoTarget) => Promise<void>
  clearError: () => void
}

/** A document's _id as Extended JSON (what the core finds it by). */
export function idOf(document: string): string | undefined {
  try {
    const id = (JSON.parse(document) as { _id?: unknown })._id
    return id === undefined ? undefined : JSON.stringify(id)
  } catch {
    return undefined
  }
}

const NEW_DOCUMENT = '{\n  \n}'

/** MongoDB in the editor — the MongoDB for VS Code extension's explorer and playground. */
export const useMongo = create<MongoState>((set, get) => {
  /** One request at a time for the open collection; its error shows. */
  const guarded = async (fn: () => Promise<void>) => {
    set({ busy: true, error: undefined })
    try {
      await fn()
    } catch (err) {
      set({ error: errorMessage(err) })
    } finally {
      set({ busy: false })
    }
  }
  const loadTree = async (key: string) => {
    const [id, db] = key.split('/')
    if (db === undefined) {
      const databases = await ipc('mongo:databases', { id })
      set((s) => ({ databases: { ...s.databases, [id]: databases } }))
    } else {
      const collections = await ipc('mongo:collections', { id, db })
      set((s) => ({ collections: { ...s.collections, [key]: collections } }))
    }
  }

  return {
    connections: [],
    expanded: {},
    databases: {},
    collections: {},
    mode: 'find',
    filter: '',
    sort: '',
    limit: 50,
    skip: 0,
    pipeline: '[\n  { "$match": {} }\n]',
    documents: [],
    total: 0,
    indexes: [],
    busy: false,
    adding: false,

    load: async () => {
      try {
        set({ connections: await ipc('mongo:connections') })
      } catch (err) {
        set({ error: errorMessage(err) })
      }
    },

    setAdding: (adding) => set({ adding }),

    add: async (name, uri) => {
      set({ busy: true, error: undefined })
      const connection = await ipc('mongo:add', { name, uri }).catch((err: unknown) => void set({ error: errorMessage(err) }))
      set({ busy: false })
      if (!connection) return false
      set((s) => ({ connections: [...s.connections, connection], adding: false }))
      await get().toggle(connection.id)
      return true
    },

    remove: async (id) => {
      try {
        await ipc('mongo:remove', { id })
        set((s) => ({ connections: s.connections.filter((c) => c.id !== id), open: s.open?.id === id ? undefined : s.open }))
      } catch (err) {
        set({ error: errorMessage(err) })
      }
    },

    toggle: async (key) => {
      if (get().expanded[key]) {
        return set((s) => {
          const { [key]: _closed, ...expanded } = s.expanded
          return { expanded }
        })
      }
      set((s) => ({ expanded: { ...s.expanded, [key]: true } }))
      try {
        await loadTree(key)
      } catch (err) {
        set((s) => {
          const { [key]: _failed, ...expanded } = s.expanded
          return { expanded, error: errorMessage(err) }
        })
      }
    },

    openCollection: async (target) => {
      set({ open: target, mode: 'find', filter: '', sort: '', skip: 0, documents: [], total: 0, indexes: [], editing: undefined })
      await get().run(0)
    },

    close: () => set({ open: undefined, editing: undefined }),

    setMode: (mode) => {
      set({ mode, documents: [], total: 0 })
      if (mode === 'indexes') {
        const open = get().open!
        void guarded(async () => {
          const indexes = await ipc('mongo:indexes', open)
          if (get().open === open) set({ indexes })
        })
      } else if (mode === 'find') void get().run(0)
    },

    setQuery: (patch) => set(patch),

    run: async (skip = get().skip) => {
      const open = get().open
      if (!open) return
      await guarded(async () => {
        if (get().mode === 'aggregate') {
          const documents = await ipc('mongo:aggregate', { ...open, pipeline: get().pipeline })
          if (get().open !== open) return // another collection opened meanwhile
          return set({ documents, total: documents.length, skip: 0 })
        }
        const { filter, sort, limit } = get()
        const result = await ipc('mongo:find', { ...open, query: { filter, sort, limit, skip } })
        if (get().open !== open) return // another collection opened meanwhile
        set({ documents: result.documents, total: result.total, skip })
      })
    },

    edit: (document) => set({ editing: { docId: idOf(document), text: document } }),
    newDocument: () => set({ editing: { text: NEW_DOCUMENT } }),
    setEditText: (text) => set((s) => ({ editing: s.editing && { ...s.editing, text } })),
    cancelEdit: () => set({ editing: undefined }),

    saveEdit: async () => {
      const open = get().open
      const editing = get().editing
      if (!open || !editing) return
      await guarded(async () => {
        if (editing.docId) await ipc('mongo:replace', { ...open, docId: editing.docId, document: editing.text })
        else await ipc('mongo:insert', { ...open, document: editing.text })
        set({ editing: undefined })
        await get().run()
      })
    },

    deleteDocument: async (document) => {
      const open = get().open
      const docId = idOf(document)
      if (!open || !docId) return
      await guarded(async () => {
        await ipc('mongo:delete', { ...open, docId })
        await get().run()
      })
    },

    createCollection: async (id, db, name) => {
      try {
        await ipc('mongo:createCollection', { id, db, name })
        await loadTree(`${id}/${db}`)
        await get().openCollection({ id, db, collection: name })
      } catch (err) {
        set({ error: errorMessage(err) })
      }
    },

    dropCollection: async (target) => {
      try {
        await ipc('mongo:dropCollection', { id: target.id, db: target.db, name: target.collection })
        const open = get().open
        if (open?.id === target.id && open.db === target.db && open.collection === target.collection) set({ open: undefined, editing: undefined })
        await loadTree(`${target.id}/${target.db}`)
      } catch (err) {
        set({ error: errorMessage(err) })
      }
    },

    clearError: () => set({ error: undefined })
  }
})
