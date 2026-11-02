import { create } from 'zustand'
import { errorMessage, ipc } from '@shared/ipc/client'
import type {
  GraphStyle,
  MemoryChanged,
  MemoryGraph,
  Note,
  NoteMeta,
  SearchHit,
  VaultStatus
} from '@shared/types/memory'

const AUTOSAVE_MS = 700

/** Inline "new note / new folder" input in the sidebar. `parent` '' = vault root. */
export interface Creating {
  kind: 'note' | 'folder'
  parent: string
}

interface MemoryState {
  status?: VaultStatus
  notes: NoteMeta[]
  /** Every folder, empty ones included (the note list alone can't show those). */
  folders: string[]
  graph?: MemoryGraph
  view: 'note' | 'graph'
  mode: 'edit' | 'preview'

  /** Open note as last loaded from disk. */
  note?: Note
  /** Editor text (the note body — frontmatter is never shown or edited here). */
  draft: string
  saving: boolean
  creating: Creating | null

  query: string
  hits: SearchHit[]

  loading: boolean
  error?: string

  init: () => Promise<void>
  onChanged: (change: MemoryChanged) => Promise<void>
  createVault: () => Promise<void>
  pickVault: () => Promise<void>
  /** Use an existing folder as the vault (the web UI's folder browser). */
  setVault: (path: string) => Promise<void>
  reveal: () => Promise<void>
  open: (path: string, mode?: 'edit' | 'preview') => Promise<void>
  /** Follow a link by title: open the note, or create it (Obsidian behavior). */
  openOrCreate: (title: string) => Promise<void>
  setDraft: (body: string) => void
  save: () => Promise<void>
  startCreate: (kind: Creating['kind'], parent?: string) => void
  cancelCreate: () => void
  submitCreate: (name: string) => Promise<void>
  createNote: (title: string, folder?: string) => Promise<void>
  rename: (title: string) => Promise<void>
  moveNote: (path: string, folder: string) => Promise<void>
  moveFolder: (folder: string, into: string) => Promise<void>
  link: (to: string) => Promise<void>
  unlink: (from: string, to: string) => Promise<void>
  trash: (path: string) => Promise<void>
  setView: (view: 'note' | 'graph') => void
  setMode: (mode: 'edit' | 'preview') => void
  search: (query: string) => Promise<void>
  setGraphStyle: (style: GraphStyle) => Promise<void>
  clearError: () => void
}


let saveTimer: number | undefined
let searchSeq = 0
let openSeq = 0
let indexSeq = 0

export const useMemory = create<MemoryState>((set, get) => {
  const reloadIndex = async () => {
    const seq = ++indexSeq
    const [status, notes, graph, folders] = await Promise.all([
      ipc('memory:status'),
      ipc('memory:list'),
      ipc('memory:graph'),
      ipc('memory:folders')
    ])
    // Overlapping reloads (a burst of vault changes): an older answer must not replace a newer one.
    if (seq === indexSeq) set({ status, notes, graph, folders })
    return { status, notes }
  }

  const fail = (err: unknown) => set({ error: errorMessage(err), loading: false, saving: false })

  /** Re-read the open note (links/backlinks may have changed elsewhere). */
  const refreshNote = async () => {
    const { note } = get()
    if (!note) return
    const fresh = await ipc('memory:read', { path: note.path }).catch(() => undefined)
    // Unsaved text in the editor wins over the refreshed body.
    if (fresh) set((s) => ({ note: fresh, draft: s.draft === note.body ? fresh.body : s.draft }))
  }

  return {
    notes: [],
    folders: [],
    view: 'graph',
    mode: 'preview',
    draft: '',
    saving: false,
    creating: null,
    query: '',
    hits: [],
    loading: false,

    init: async () => {
      set({ loading: true, error: undefined })
      try {
        const { notes } = await reloadIndex()
        set({ loading: false })
        const { note } = get()
        if (!note && notes.length) {
          const first = notes.find((n) => /^willkommen\.md$/i.test(n.path)) ?? notes[0]
          await get().open(first.path)
          set({ view: 'graph' })
        }
      } catch (err) {
        fail(err)
      }
    },

    onChanged: async (change) => {
      try {
        await reloadIndex()
        const { note, query } = get()
        if (query) void get().search(query)
        if (!note) return
        const fresh = await ipc('memory:read', { path: note.path }).catch(() => undefined)
        // Our own rename/move may have opened the note under its new path meanwhile.
        if (get().note?.path !== note.path) return
        const dirty = get().draft !== get().note?.body
        if (!fresh) {
          // Gone: deleted, or renamed/moved outside this view's own actions.
          if (!change.paths || change.paths.includes(note.path)) set({ note: undefined, draft: '' })
        } else if (!dirty) {
          set({ note: fresh, draft: fresh.body }) // follow the file (external edit)
        } else {
          set({ note: { ...fresh, body: note.body } }) // keep the user's unsaved text
        }
      } catch (err) {
        fail(err)
      }
    },

    createVault: async () => {
      set({ loading: true, error: undefined })
      try {
        await ipc('memory:createVault')
        set({ note: undefined, draft: '' })
        await get().init()
      } catch (err) {
        fail(err)
      }
    },

    pickVault: async () => {
      try {
        await get().save()
        const status = await ipc('memory:pickVault')
        if (!status) return
        set({ note: undefined, draft: '', query: '', hits: [] })
        await get().init()
      } catch (err) {
        fail(err)
      }
    },

    setVault: async (path) => {
      try {
        await get().save()
        await ipc('memory:setVault', { path })
        set({ note: undefined, draft: '', query: '', hits: [] })
        await get().init()
      } catch (err) {
        fail(err)
      }
    },

    reveal: async () => {
      try {
        await ipc('memory:reveal')
      } catch (err) {
        fail(err)
      }
    },

    open: async (path, mode) => {
      const seq = ++openSeq
      try {
        await get().save()
        const note = await ipc('memory:read', { path })
        // Clicked on to another note meanwhile: that one wins.
        if (seq !== openSeq) return
        set({ note, draft: note.body, view: 'note', mode: mode ?? get().mode, error: undefined })
      } catch (err) {
        fail(err)
      }
    },

    openOrCreate: async (title) => {
      const key = title.replace(/\.md$/i, '').toLowerCase()
      const match = get()
        .notes.filter((n) => n.title.toLowerCase() === key || n.path.replace(/\.md$/i, '').toLowerCase() === key)
        .sort((a, b) => a.path.length - b.path.length)[0]
      if (match) return get().open(match.path)
      const slash = title.lastIndexOf('/')
      return get().createNote(title.slice(slash + 1), slash > 0 ? title.slice(0, slash) : '')
    },

    setDraft: (body) => {
      set({ draft: body })
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => void get().save(), AUTOSAVE_MS)
    },

    save: async () => {
      window.clearTimeout(saveTimer)
      const { note, draft } = get()
      if (!note || draft === note.body) return
      set({ saving: true })
      try {
        await ipc('memory:writeBody', { path: note.path, body: draft })
        const fresh = await ipc('memory:read', { path: note.path })
        // Keep typing that happened while the write was in flight — unless another
        // note opened meanwhile (its draft must never land on this one).
        set((s) =>
          s.note?.path === note.path ? { note: fresh, draft: s.draft === draft ? fresh.body : s.draft, saving: false } : { saving: false }
        )
      } catch (err) {
        fail(err)
      }
    },

    startCreate: (kind, parent = '') => set({ creating: { kind, parent } }),
    cancelCreate: () => set({ creating: null }),

    submitCreate: async (name) => {
      const creating = get().creating
      set({ creating: null })
      if (!creating || !name.trim()) return
      if (creating.kind === 'note') return get().createNote(name.trim(), creating.parent)
      try {
        await ipc('memory:createFolder', { parent: creating.parent, name: name.trim() })
        await reloadIndex()
      } catch (err) {
        fail(err)
      }
    },

    createNote: async (title, folder = '') => {
      try {
        await get().save()
        const meta = await ipc('memory:create', { title, folder })
        await reloadIndex()
        await get().open(meta.path, 'edit')
      } catch (err) {
        fail(err)
      }
    },

    rename: async (title) => {
      const { note } = get()
      if (!note || !title.trim() || title.trim() === note.title) return
      try {
        await get().save()
        const meta = await ipc('memory:rename', { path: note.path, title: title.trim() })
        await reloadIndex()
        await get().open(meta.path, get().mode)
      } catch (err) {
        fail(err)
      }
    },

    moveNote: async (path, folder) => {
      try {
        await get().save()
        const meta = await ipc('memory:move', { path, folder })
        await reloadIndex()
        if (get().note?.path === path) await get().open(meta.path, get().mode)
      } catch (err) {
        fail(err)
      }
    },

    moveFolder: async (folder, into) => {
      try {
        await get().save()
        const to = await ipc('memory:moveFolder', { folder, into })
        await reloadIndex()
        const open = get().note?.path
        if (open?.startsWith(`${folder}/`)) await get().open(`${to}${open.slice(folder.length)}`, get().mode)
      } catch (err) {
        fail(err)
      }
    },

    link: async (to) => {
      const { note } = get()
      if (!note) return
      try {
        await get().save()
        await ipc('memory:link', { from: note.path, to })
        await reloadIndex()
        await refreshNote()
      } catch (err) {
        fail(err)
      }
    },

    unlink: async (from, to) => {
      try {
        await get().save()
        await ipc('memory:unlink', { from, to })
        await reloadIndex()
        await refreshNote()
      } catch (err) {
        fail(err)
      }
    },

    trash: async (path) => {
      try {
        window.clearTimeout(saveTimer)
        await ipc('memory:trash', { path })
        if (get().note?.path === path) set({ note: undefined, draft: '', view: 'graph' })
        await reloadIndex()
      } catch (err) {
        fail(err)
      }
    },

    setView: (view) => {
      if (view === 'graph') void get().save()
      set({ view })
    },

    setMode: (mode) => {
      if (mode === 'preview') void get().save()
      set({ mode })
    },

    search: async (query) => {
      const seq = ++searchSeq
      set({ query })
      if (!query.trim()) return set({ hits: [] })
      try {
        const hits = await ipc('memory:search', { query })
        if (seq === searchSeq) set({ hits })
      } catch (err) {
        fail(err)
      }
    },

    setGraphStyle: async (style) => {
      const prev = get().status
      if (prev) set({ status: { ...prev, graphStyle: style } }) // optimistic
      try {
        const saved = await ipc('memory:setGraphStyle', style)
        const cur = get().status
        if (cur) set({ status: { ...cur, graphStyle: saved } })
      } catch (err) {
        if (prev) set({ status: prev })
        fail(err)
      }
    },

    clearError: () => set({ error: undefined })
  }
})

/** Stable folder → palette slot, shared by the graph and the note list. */
export function folderColors(notes: { folder: string }[]): Map<string, number> {
  const folders = [...new Set(notes.map((n) => n.folder))].sort((a, b) => a.localeCompare(b))
  return new Map(folders.map((f, i) => [f, i]))
}
