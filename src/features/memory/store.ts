import { create } from 'zustand'
import { errorMessage, ipc, type IpcError } from '@shared/ipc/client'
import type {
  DailyNotesSettings,
  GraphStyle,
  MemoryChanged,
  MemoryGraph,
  Note,
  NoteMeta,
  SearchHit,
  VaultStatus
} from '@shared/types/memory'
import { findNote } from './links'

const AUTOSAVE_MS = 700
const SOURCE_KEY = 'mindeck.memory.source'

/** Inline "new note / new folder" input in the sidebar. `parent` '' = vault root. */
export interface Creating {
  kind: 'note' | 'folder'
  parent: string
  /** A new note starts from this template note. */
  template?: string
}

/** The UI's wall-clock time without a zone ("2026-10-15T09:30:00") — daily notes and templates use the user's date. */
export function localNow(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Pasted pictures are named like Obsidian names them: "Pasted image 20261015093000.png". */
export function pictureName(file: File, d = new Date()): string {
  if (file.name && file.name !== 'image.png') return file.name
  const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') || 'png'
  return `Pasted image ${localNow(d).replace(/\D/g, '')}.${ext}`
}

/** A file's bytes as base64 (what `memory:attach` carries). */
function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the picture'))
    reader.readAsDataURL(file)
  })
}

function loadSource(): boolean {
  try {
    return localStorage.getItem(SOURCE_KEY) === '1'
  } catch {
    return false
  }
}

interface MemoryState {
  status?: VaultStatus
  notes: NoteMeta[]
  /** Every folder, empty ones included (the note list alone can't show those). */
  folders: string[]
  graph?: MemoryGraph
  view: 'note' | 'graph'
  mode: 'edit' | 'preview'
  /** Editing shows plain Markdown instead of Live Preview (remembered per device). */
  source: boolean

  /** Open note as last loaded from disk. */
  note?: Note
  /** Editor text (the note body — frontmatter is never shown or edited here). */
  draft: string
  saving: boolean
  /** The file moved on (or went) under the draft: the user decides, nothing is overwritten by itself. */
  conflict: boolean
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
  /**
   * Write the draft (`force`: over a file that moved on). False when it could
   * not be written: it is still only here, so nothing may replace it.
   */
  save: (opts?: { force?: boolean }) => Promise<boolean>
  /** Give up the draft for what the disk has. */
  loadDisk: () => Promise<void>
  startCreate: (kind: Creating['kind'], parent?: string, template?: string) => void
  cancelCreate: () => void
  submitCreate: (name: string) => Promise<void>
  createNote: (title: string, folder?: string, template?: string) => Promise<void>
  rename: (title: string) => Promise<void>
  moveNote: (path: string, folder: string) => Promise<void>
  moveFolder: (folder: string, into: string) => Promise<void>
  link: (to: string) => Promise<void>
  unlink: (from: string, to: string) => Promise<void>
  trash: (path: string) => Promise<void>
  setView: (view: 'note' | 'graph') => void
  setMode: (mode: 'edit' | 'preview') => void
  setSource: (source: boolean) => void
  search: (query: string) => Promise<void>
  setGraphStyle: (style: GraphStyle) => Promise<void>
  /** Today's daily note — created from its template the first time. */
  openDaily: () => Promise<void>
  setDailyNotes: (daily: DailyNotesSettings) => Promise<void>
  /** A template filled in for the open note — for "Insert template". */
  renderTemplate: (path: string) => Promise<string | null>
  /** Save a pasted or dropped picture; returns what goes into `![[…]]`. */
  attach: (file: File) => Promise<string | null>
  /** A picture the open note shows, as a data: URL (null when it is not in the vault). */
  loadImage: (target: string) => Promise<string | null>
  clearError: () => void
}


let saveTimer: number | undefined
let searchSeq = 0
let openSeq = 0
let indexSeq = 0
/** Writes run one after the other: each starts from the text and the time the one before left. */
let writes: Promise<unknown> = Promise.resolve()
/** Pictures by note + target; dropped on every vault change (a picture may have come or gone). */
let images = new Map<string, Promise<string | null>>()

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

  /**
   * The open note as the disk has it now: a clean editor follows. Unsaved text
   * stays, on the version it was typed on, so that saving it notices the file moved on.
   */
  const follow = (path: string, fresh: Note) =>
    set((s) => {
      // Another note opened meanwhile: its text must not end up paired with this one (the next save would write it here).
      if (s.note?.path !== path) return {}
      return s.draft === s.note.body ? { note: fresh, draft: fresh.body, conflict: false } : { note: { ...fresh, body: s.note.body, modifiedAt: s.note.modifiedAt } }
    })

  /** Re-read the open note (links/backlinks may have changed elsewhere). */
  const refreshNote = async () => {
    const { note } = get()
    if (!note) return
    const fresh = await ipc('memory:read', { path: note.path }).catch(() => undefined)
    if (fresh) follow(note.path, fresh)
  }

  /** What the disk has for the open note now; it may be gone. */
  const followOpen = async (change: MemoryChanged) => {
    const { note } = get()
    if (!note) return
    const fresh = await ipc('memory:read', { path: note.path }).catch((err: IpcError) => (err.code === 'not-found' ? null : undefined))
    // Our own rename/move may have opened the note under its new path meanwhile. A read that failed says nothing.
    if (get().note?.path !== note.path || fresh === undefined) return
    if (fresh) return follow(note.path, fresh)
    // Gone: deleted, or renamed/moved outside this view's own actions. Unsaved text stays: saving it will ask.
    if ((!change.paths || change.paths.includes(note.path)) && get().draft === get().note!.body) set({ note: undefined, draft: '' })
  }

  const writeDraft = async (force: boolean) => {
    const { note, draft } = get()
    if (!note || draft === note.body) return null
    set({ saving: true })
    const saved = await ipc('memory:writeBody', { path: note.path, body: draft, ...(force ? {} : { expectedMtime: Date.parse(note.modifiedAt) }) }).catch((err: IpcError) => {
      // "Keep mine" for a note deleted meanwhile: it is written anew.
      if (force && err.code === 'not-found') return ipc('memory:write', { path: note.path, raw: draft })
      throw err
    })
    // From here on the disk has this text, at this time (another save, right behind this one, builds on it).
    set((s) => (s.note?.path === note.path ? { note: { ...s.note, body: draft, modifiedAt: saved.modifiedAt }, conflict: false } : {}))
    return { path: note.path, draft, modifiedAt: saved.modifiedAt }
  }

  return {
    notes: [],
    folders: [],
    view: 'graph',
    mode: 'preview',
    source: loadSource(),
    draft: '',
    saving: false,
    conflict: false,
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
        // Memory was off screen (it follows the vault only while it shows): the note may have moved on.
        if (note) await followOpen({})
        else if (notes.length) {
          const first = notes.find((n) => /^willkommen\.md$/i.test(n.path)) ?? notes[0]
          await get().open(first.path)
          set({ view: 'graph' })
        }
      } catch (err) {
        fail(err)
      }
    },

    onChanged: async (change) => {
      images = new Map()
      try {
        await reloadIndex()
        const { query } = get()
        if (query) void get().search(query)
        await followOpen(change)
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
        if (!(await get().save())) return
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
        if (!(await get().save())) return
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
      // Two quick clicks: the note clicked last wins, not the one answered last.
      const seq = ++openSeq
      try {
        if (!(await get().save())) return
        const note = await ipc('memory:read', { path })
        if (seq !== openSeq) return
        set({ note, draft: note.body, view: 'note', mode: mode ?? get().mode, error: undefined, conflict: false })
      } catch (err) {
        fail(err)
      }
    },

    openOrCreate: async (title) => {
      const match = findNote(title, get().notes)
      if (match) return get().open(match.path)
      const name = title.replace(/[#^].*$/, '').replace(/\.md$/i, '').trim()
      const slash = name.lastIndexOf('/')
      return get().createNote(name.slice(slash + 1), slash > 0 ? name.slice(0, slash) : '')
    },

    setDraft: (body) => {
      set({ draft: body })
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => void get().save(), AUTOSAVE_MS)
    },

    save: async ({ force = false } = {}) => {
      window.clearTimeout(saveTimer)
      const write = writes.then(() => writeDraft(force))
      writes = write.catch(() => {})
      try {
        const written = await write
        if (!written) return true
        const fresh = await ipc('memory:read', { path: written.path })
        // Another note was opened meanwhile (its draft must not land in this one), or a newer write landed.
        // Else keep typing that happened while the write was in flight.
        set((s) => (s.note?.path !== written.path || s.note.modifiedAt !== written.modifiedAt ? { saving: false } : { note: fresh, draft: s.draft === written.draft ? fresh.body : s.draft, saving: false }))
        return true
      } catch (err) {
        if ((err as IpcError).code === 'conflict') set({ conflict: true, saving: false })
        else fail(err)
        return false
      }
    },

    loadDisk: async () => {
      const { note } = get()
      if (!note) return
      window.clearTimeout(saveTimer)
      try {
        const fresh = await ipc('memory:read', { path: note.path })
        set((s) => (s.note?.path === note.path ? { note: fresh, draft: fresh.body, conflict: false } : {}))
      } catch (err) {
        // Deleted, and the user lets the text go with it.
        if ((err as IpcError).code === 'not-found') set({ note: undefined, draft: '', conflict: false })
        else fail(err)
      }
    },

    startCreate: (kind, parent = '', template) => set({ creating: { kind, parent, ...(template ? { template } : {}) } }),
    cancelCreate: () => set({ creating: null }),

    submitCreate: async (name) => {
      const creating = get().creating
      set({ creating: null })
      if (!creating || !name.trim()) return
      if (creating.kind === 'note') return get().createNote(name.trim(), creating.parent, creating.template)
      try {
        await ipc('memory:createFolder', { parent: creating.parent, name: name.trim() })
        await reloadIndex()
      } catch (err) {
        fail(err)
      }
    },

    createNote: async (title, folder = '', template) => {
      try {
        if (!(await get().save())) return
        const meta = await ipc('memory:create', { title, folder, ...(template ? { template, now: localNow() } : {}) })
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
        if (!(await get().save())) return
        const meta = await ipc('memory:rename', { path: note.path, title: title.trim() })
        await reloadIndex()
        await get().open(meta.path, get().mode)
      } catch (err) {
        fail(err)
      }
    },

    moveNote: async (path, folder) => {
      try {
        if (!(await get().save())) return
        const meta = await ipc('memory:move', { path, folder })
        await reloadIndex()
        if (get().note?.path === path) await get().open(meta.path, get().mode)
      } catch (err) {
        fail(err)
      }
    },

    moveFolder: async (folder, into) => {
      try {
        if (!(await get().save())) return
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

    setSource: (source) => {
      try {
        localStorage.setItem(SOURCE_KEY, source ? '1' : '0')
      } catch {
        // storage unavailable — the choice lasts until reload
      }
      set({ source, mode: 'edit' })
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

    openDaily: async () => {
      try {
        if (!(await get().save())) return
        const meta = await ipc('memory:daily', { now: localNow() })
        await reloadIndex()
        await get().open(meta.path, 'edit')
      } catch (err) {
        fail(err)
      }
    },

    setDailyNotes: async (daily) => {
      try {
        const saved = await ipc('memory:setDailyNotes', daily)
        const cur = get().status
        if (cur) set({ status: { ...cur, dailyNotes: saved } })
      } catch (err) {
        fail(err)
      }
    },

    renderTemplate: async (path) => {
      const { note } = get()
      if (!note) return null
      try {
        return await ipc('memory:renderTemplate', { path, title: note.title, now: localNow() })
      } catch (err) {
        fail(err)
        return null
      }
    },

    attach: async (file) => {
      try {
        const { link } = await ipc('memory:attach', { name: pictureName(file), data: await base64(file) })
        return link
      } catch (err) {
        fail(err)
        return null
      }
    },

    loadImage: (target) => {
      const from = get().note?.path
      const clean = target.trim()
      // Inline data: pictures are safe as they are; anything with a scheme (http:, file:) never loads.
      if (/^data:image\//i.test(clean)) return Promise.resolve(clean)
      if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) return Promise.resolve(null)
      let decoded = clean
      try {
        decoded = decodeURI(clean)
      } catch {
        // a literal % in the name
      }
      const key = `${from ?? ''}|${decoded}`
      if (!images.has(key)) {
        images.set(
          key,
          ipc('memory:attachment', { target: decoded, ...(from ? { from } : {}) }).then(
            (a) => a.dataUrl,
            () => null
          )
        )
      }
      return images.get(key)!
    },

    clearError: () => set({ error: undefined })
  }
})

/** Stable folder → palette slot, shared by the graph and the note list. */
export function folderColors(notes: { folder: string }[]): Map<string, number> {
  const folders = [...new Set(notes.map((n) => n.folder))].sort((a, b) => a.localeCompare(b))
  return new Map(folders.map((f, i) => [f, i]))
}

// Unsaved text vetoes closing the window, whichever module is on screen; the desktop app then asks (main.ts).
// A write started now could be refused with no one left to tell (the file moved on, a read-only vault): this window has the only copy.
window.addEventListener('beforeunload', (e) => {
  const { note, draft } = useMemory.getState()
  if (!note || draft === note.body) return
  e.preventDefault()
  e.returnValue = ''
})
