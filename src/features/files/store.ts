import { create } from 'zustand'
import { errorMessage, ipc, isDesktop } from '@shared/ipc/client'
import type {
  ConflictChoice,
  FinderEntry,
  FinderInfo,
  FinderListing,
  FinderPlaces,
  FinderPreview,
  FinderProgress,
  FolderSize,
  TrashedItem
} from '@shared/types/finder'
import { baseName, entryKind } from './kinds'

export type SortKey = 'name' | 'modified' | 'size' | 'kind'
export type ViewMode = 'list' | 'grid' | 'columns'

export type Notice =
  | { key: 'copied' }
  /** `noUndo`: how many of them ⌘Z cannot bring back (a mixed selection). */
  | { key: 'trashed'; count: number; noUndo?: number }
  | { key: 'clipboard'; count: number; cut: boolean }
  | { key: 'undone' }
  | { key: 'stopped' }

interface Prefs {
  view: ViewMode
  sort: { key: SortKey; desc: boolean }
  hidden: boolean
  showPreview: boolean
  /** Folders pinned to the sidebar. */
  favorites: string[]
  /** Where the module was last. */
  path?: string
}

const KEY = 'mindeck.files'
const DEFAULTS: Prefs = { view: 'list', sort: { key: 'name', desc: false }, hidden: false, showPreview: true, favorites: [] }
const VIEWS: ViewMode[] = ['list', 'grid', 'columns']
/** Undo remembers this many steps. */
const UNDO_STEPS = 30

function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>
    return {
      view: VIEWS.includes(saved.view!) ? saved.view! : 'list',
      sort: saved.sort && ['name', 'modified', 'size', 'kind'].includes(saved.sort.key) ? { key: saved.sort.key, desc: !!saved.sort.desc } : DEFAULTS.sort,
      hidden: saved.hidden === true,
      showPreview: saved.showPreview !== false,
      favorites: Array.isArray(saved.favorites) ? saved.favorites.filter((f): f is string => typeof f === 'string') : [],
      ...(typeof saved.path === 'string' ? { path: saved.path } : {})
    }
  } catch {
    return DEFAULTS
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // storage unavailable — the choices last until reload
  }
}

/** Folders first, then by the chosen column (names compare like Finder: "file 2" before "file 10"). */
export function sortEntries(entries: FinderEntry[], sort: Prefs['sort']): FinderEntry[] {
  const byName = (a: FinderEntry, b: FinderEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  const by: Record<SortKey, (a: FinderEntry, b: FinderEntry) => number> = {
    name: byName,
    modified: (a, b) => a.mtimeMs - b.mtimeMs || byName(a, b),
    size: (a, b) => a.size - b.size || byName(a, b),
    kind: (a, b) => entryKind(a).localeCompare(entryKind(b)) || byName(a, b)
  }
  const dir = sort.desc ? -1 : 1
  return [...entries].sort((a, b) => {
    const folderA = a.kind === 'dir' && !a.bundle
    const folderB = b.kind === 'dir' && !b.bundle
    if (folderA !== folderB) return folderA ? -1 : 1
    return by[sort.key](a, b) * dir
  })
}

/** One undo step: what to do to take an operation back (in this order). */
export interface UndoStep {
  /** Created by the operation — goes to the trash. */
  trash?: string[]
  /** Moved or renamed — goes back. */
  moves?: { from: string; to: string }[]
  /** Trashed by it — comes back. */
  untrash?: { path: string; restore: string }[]
}

/** A tab: its own folder and history (the active one's live state is the store's). */
export interface FilesTab {
  id: string
  path: string
  back: string[]
  forward: string[]
}

/** The conflict dialog's question: names taken where things go. */
export interface ConflictQuestion {
  names: string[]
  dest: string
  answer: (choices: Record<string, ConflictChoice> | null) => void
}

interface FilesState extends Prefs {
  places?: FinderPlaces
  listing?: FinderListing
  loading: boolean
  error?: string
  /** The error's code (`trash-gone`, `full-disk-access`, …) — some are explained in the UI. */
  errorCode?: string
  /** A short message for the status line. */
  notice?: Notice
  back: string[]
  forward: string[]
  selected: string[]
  /** The last single pick — where a shift-click range starts. */
  anchor?: string
  preview?: FinderPreview
  /** The selected entry's details, and its size for a folder. */
  info?: FinderInfo
  size?: FolderSize | 'counting'
  query: string
  /** Search hits; undefined while not searching. */
  results?: FinderEntry[]
  searching: boolean
  /** The entry whose name is being edited. */
  renaming?: string
  /** A new folder's name is being typed. */
  creating: boolean
  /** ⌘C / ⌘X inside Mindeck. */
  clipboard?: { paths: string[]; cut: boolean }
  undo: UndoStep[]
  /** Running copies, archives, size counts — by id. */
  jobs: Record<string, FinderProgress>
  conflict?: ConflictQuestion
  tabs: FilesTab[]
  activeTab: string
  /** Paths being dragged out of Mindeck right now (an OS drag that may come back in). */
  dragging?: string[]

  init(): Promise<void>
  /** Show a folder (remembered for Back). */
  open(path: string, opts?: { history?: boolean }): Promise<void>
  goBack(): Promise<void>
  goForward(): Promise<void>
  goUp(): Promise<void>
  reload(): Promise<void>
  select(path: string, mode?: 'single' | 'toggle' | 'range'): void
  selectAll(): void
  clearSelection(): void
  setView(view: ViewMode): void
  setSort(key: SortKey): void
  toggleHidden(): Promise<void>
  togglePreview(): void
  search(query: string): Promise<void>
  clearSearch(): void
  startCreate(): void
  cancelCreate(): void
  mkdir(name: string): Promise<void>
  startRename(path: string): void
  cancelRename(): void
  rename(path: string, name: string): Promise<void>
  trash(paths?: string[]): Promise<void>
  /** Move (or copy) entries into a folder — asking about names that are taken. */
  move(paths: string[], dest: string, copy?: boolean): Promise<void>
  copy(paths?: string[]): Promise<void>
  cut(paths?: string[]): Promise<void>
  /** ⌘V: what was copied in Mindeck — or in Finder / Explorer — into `dest`. */
  paste(dest?: string): Promise<void>
  undoLast(): Promise<void>
  compress(paths?: string[]): Promise<void>
  extract(path: string): Promise<void>
  cancelJob(id: string): Promise<void>
  onProgress(p: FinderProgress): void
  answerConflict(choices: Record<string, ConflictChoice> | null): void
  newTab(path?: string): Promise<void>
  closeTab(id: string): Promise<void>
  switchTab(id: string): Promise<void>
  toggleFavorite(path: string): void
  startDrag(paths: string[]): boolean
  /** Files dropped from the OS (or an OS drag of our own coming back) onto `dest`. */
  dropFiles(files: File[], dest: string, copy: boolean): Promise<void>
  endDrag(): void
  openWithApp(path: string): Promise<void>
  reveal(path: string): Promise<void>
  loadPreview(path: string): Promise<void>
  setNotice(notice?: Notice): void
  clearError(): void
  /** macOS: System Settings at Full Disk Access (taking things out of the Trash needs it). */
  privacySettings(): Promise<void>
}

/** The entries on screen: search hits or the folder, sorted. */
export function visibleEntries(s: Pick<FilesState, 'results' | 'listing' | 'sort'>): FinderEntry[] {
  return sortEntries(s.results ?? s.listing?.entries ?? [], s.sort)
}

/** A folder in full: the first page, then the rest. */
export async function listAll(path: string, hidden: boolean): Promise<FinderListing> {
  const first = await ipc('finder:list', { path, hidden })
  let entries = first.entries
  while (entries.length < first.total) {
    const next = await ipc('finder:list', { path: first.path, hidden, offset: entries.length })
    if (!next.entries.length) break
    entries = [...entries, ...next.entries]
  }
  return { ...first, entries }
}

const newId = () => crypto.randomUUID()
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))
const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))) || '/'

export const useFiles = create<FilesState>((set, get) => {
  const prefs = () => {
    const { view, sort, hidden, showPreview, favorites, listing } = get()
    savePrefs({ view, sort, hidden, showPreview, favorites, ...(listing ? { path: listing.path } : {}) })
  }
  const fail = (err: unknown) => set({ error: errorMessage(err), errorCode: (err as { code?: string }).code, loading: false, searching: false })
  let searchSeq = 0
  let listSeq = 0
  let detailSeq = 0
  /** The folder size being counted (stopped when the selection moves on). */
  let sizeJob: string | undefined
  const firstTab = newId()

  const remember = (step: UndoStep) => set((s) => ({ undo: [...s.undo, step].slice(-UNDO_STEPS) }))

  /** After a change: the folder or the search again, with `select` picked. */
  const refresh = async (select?: string[]) => {
    if (get().results) await get().search(get().query)
    else await get().reload()
    if (select?.length) {
      get().select(select[0])
      if (select.length > 1) set({ selected: select })
    }
  }

  /** The rest of a big folder, page by page, while it is still the one shown. */
  const loadRest = async (seq: number) => {
    for (;;) {
      const l = get().listing!
      if (seq !== listSeq || l.entries.length >= l.total) return
      const next = await ipc('finder:list', { path: l.path, hidden: get().hidden, offset: l.entries.length }).catch(() => null)
      if (!next?.entries.length || seq !== listSeq) return
      set({ listing: { ...l, entries: [...l.entries, ...next.entries], total: next.total } })
    }
  }

  /** The selected entry's details; a folder's size is counted (the previous count stops). */
  const loadDetails = async (path: string) => {
    const seq = ++detailSeq
    if (sizeJob) void ipc('finder:cancel', { id: sizeJob }).catch(() => {})
    sizeJob = undefined
    const info = await ipc('finder:info', { path }).catch(() => undefined)
    if (seq !== detailSeq) return
    set({ info, size: undefined })
    if (info?.entry.kind !== 'dir') return
    set({ size: 'counting' })
    const id = (sizeJob = newId())
    const size = await ipc('finder:folderSize', { path, id }).catch(() => undefined)
    if (sizeJob === id) sizeJob = undefined
    if (seq === detailSeq) set({ size })
  }

  /** Copy or move with the conflict dialog; remembers how to undo it. */
  const transfer = async (paths: string[], dest: string, mode: 'copy' | 'move'): Promise<string[] | null> => {
    const names = await ipc('finder:conflicts', { paths, dest })
    let choices: Record<string, ConflictChoice> = {}
    if (names.length) {
      const answer = await new Promise<Record<string, ConflictChoice> | null>((resolve) => set({ conflict: { names, dest, answer: resolve } }))
      set({ conflict: undefined })
      if (!answer) return null
      choices = answer
    }
    const id = newId()
    set((s) => ({ jobs: { ...s.jobs, [id]: { id, kind: mode, done: 0, total: 0 } } }))
    try {
      const res = await ipc('finder:transfer', { id, paths, dest, mode, choices })
      // Undo only when everything replaced can come back from the trash.
      if (res.replaced.every((r) => r.restore) && res.items.length) {
        remember({
          ...(mode === 'copy' ? { trash: res.items.map((i) => i.to) } : { moves: res.items.map((i) => ({ from: i.to, to: i.from })) }),
          ...(res.replaced.length ? { untrash: res.replaced as { path: string; restore: string }[] } : {})
        })
      }
      if (res.cancelled) set({ notice: { key: 'stopped' } })
      return res.items.map((i) => i.to)
    } finally {
      set((s) => {
        const { [id]: _done, ...jobs } = s.jobs
        return { jobs }
      })
    }
  }

  /** A job with progress (archives): runs `work`, then refreshes and selects what it made. */
  const job = async (kind: FinderProgress['kind'], work: (id: string) => Promise<string>) => {
    const id = newId()
    set((s) => ({ jobs: { ...s.jobs, [id]: { id, kind, done: 0, total: 0 } } }))
    try {
      const made = await work(id)
      remember({ trash: [made] })
      await refresh([made])
    } catch (err) {
      if ((err as { code?: string }).code === 'cancelled') set({ notice: { key: 'stopped' } })
      else fail(err)
    } finally {
      set((s) => {
        const { [id]: _done, ...jobs } = s.jobs
        return { jobs }
      })
    }
  }

  return {
    ...loadPrefs(),
    loading: false,
    back: [],
    forward: [],
    selected: [],
    query: '',
    searching: false,
    creating: false,
    undo: [],
    jobs: {},
    tabs: [{ id: firstTab, path: '', back: [], forward: [] }],
    activeTab: firstTab,

    init: async () => {
      if (!isDesktop() || get().places) return
      try {
        const places = await ipc('finder:places')
        set({ places })
        const start = get().path ?? places.home
        await get().open(start, { history: false })
        // The remembered folder is gone: start at Home.
        if (!get().listing && start !== places.home) {
          set({ error: undefined })
          await get().open(places.home, { history: false })
        }
      } catch (err) {
        fail(err)
      }
    },

    open: async (path, opts = {}) => {
      const current = get().listing?.path
      const seq = ++listSeq
      set({ loading: true, error: undefined })
      try {
        const listing = await ipc('finder:list', { path, hidden: get().hidden })
        if (seq !== listSeq) return
        set((s) => {
          const history = opts.history !== false && current && current !== listing.path ? { back: [...s.back, current].slice(-50), forward: [] } : {}
          const back = history.back ?? s.back
          const forward = history.forward ?? s.forward
          return {
            listing,
            loading: false,
            selected: [],
            anchor: undefined,
            preview: undefined,
            info: undefined,
            size: undefined,
            results: undefined,
            query: '',
            renaming: undefined,
            creating: false,
            back,
            forward,
            tabs: s.tabs.map((t) => (t.id === s.activeTab ? { ...t, path: listing.path, back, forward } : t))
          }
        })
        prefs()
        await loadRest(seq)
      } catch (err) {
        if (seq === listSeq) fail(err)
      }
    },

    // Back and Forward only fill while a folder is shown, so there is always one to come back to.
    goBack: async () => {
      const { back, forward, listing } = get()
      const target = back[back.length - 1]
      if (!target) return
      set({ back: back.slice(0, -1), forward: [listing!.path, ...forward] })
      await get().open(target, { history: false })
    },

    goForward: async () => {
      const { forward, back, listing } = get()
      const target = forward[0]
      if (!target) return
      set({ forward: forward.slice(1), back: [...back, listing!.path] })
      await get().open(target, { history: false })
    },

    goUp: async () => {
      const parent = get().listing?.parent
      if (parent) await get().open(parent)
    },

    reload: async () => {
      const listing = get().listing
      if (!listing) return
      const selected = get().selected
      await get().open(listing.path, { history: false })
      const still = new Set(get().listing!.entries.map((e) => e.path))
      set({ selected: selected.filter((p) => still.has(p)) })
    },

    select: (path, mode = 'single') => {
      const s = get()
      if (mode === 'toggle') {
        const selected = s.selected.includes(path) ? s.selected.filter((p) => p !== path) : [...s.selected, path]
        set({ selected, anchor: path })
      } else if (mode === 'range' && s.anchor) {
        const order = visibleEntries(s).map((e) => e.path)
        const [a, b] = [order.indexOf(s.anchor), order.indexOf(path)].sort((x, y) => x - y)
        set({ selected: a < 0 ? [path] : order.slice(a, b + 1) })
      } else {
        set({ selected: [path], anchor: path })
      }
      const picked = get().selected
      if (picked.length === 1 && get().showPreview) {
        void get().loadPreview(picked[0])
        void loadDetails(picked[0])
      } else set({ preview: undefined, info: undefined, size: undefined })
    },

    selectAll: () => set((s) => ({ selected: visibleEntries(s).map((e) => e.path), preview: undefined, info: undefined, size: undefined })),
    clearSelection: () => set({ selected: [], anchor: undefined, preview: undefined, info: undefined, size: undefined }),

    setView: (view) => {
      set({ view })
      prefs()
    },

    setSort: (key) => {
      set((s) => ({ sort: { key, desc: s.sort.key === key ? !s.sort.desc : key === 'modified' || key === 'size' } }))
      prefs()
    },

    toggleHidden: async () => {
      set((s) => ({ hidden: !s.hidden }))
      prefs()
      await get().reload()
    },

    togglePreview: () => {
      set((s) => ({ showPreview: !s.showPreview }))
      prefs()
      const { showPreview, selected } = get()
      if (showPreview && selected.length === 1) {
        void get().loadPreview(selected[0])
        void loadDetails(selected[0])
      }
    },

    search: async (query) => {
      const listing = get().listing
      const q = query.trim()
      set({ query })
      if (!q || !listing) return get().clearSearch()
      const mine = ++searchSeq
      set({ searching: true, error: undefined })
      try {
        const results = await ipc('finder:search', { path: listing.path, query: q })
        if (mine === searchSeq) set({ results, searching: false, selected: [], preview: undefined })
      } catch (err) {
        if (mine === searchSeq) fail(err)
      }
    },

    clearSearch: () => {
      searchSeq += 1
      set({ query: '', results: undefined, searching: false })
    },

    startCreate: () => set({ creating: true, renaming: undefined }),
    cancelCreate: () => set({ creating: false }),

    mkdir: async (name) => {
      const listing = get().listing
      set({ creating: false })
      if (!listing || !name.trim()) return
      try {
        const path = await ipc('finder:mkdir', { parent: listing.path, name })
        remember({ trash: [path] })
        await get().reload()
        get().select(path)
      } catch (err) {
        fail(err)
      }
    },

    startRename: (path) => set({ renaming: path, creating: false }),
    cancelRename: () => set({ renaming: undefined }),

    rename: async (path, name) => {
      set({ renaming: undefined })
      const entry = get().listing?.entries.find((e) => e.path === path) ?? get().results?.find((e) => e.path === path)
      if (!name.trim() || name === entry?.name) return
      try {
        const next = await ipc('finder:rename', { path, name })
        remember({ moves: [{ from: next, to: path }] })
        await refresh([next])
      } catch (err) {
        fail(err)
      }
    },

    trash: async (paths = get().selected) => {
      if (!paths.length) return
      try {
        const items: TrashedItem[] = await ipc('finder:trash', { paths })
        // Undo only for what the system lets Mindeck put back.
        const back = items.filter((i): i is { path: string; restore: string } => !!i.restore)
        if (back.length) remember({ untrash: back })
        const noUndo = back.length ? items.length - back.length : 0
        set({ notice: { key: 'trashed', count: paths.length, ...(noUndo ? { noUndo } : {}) } })
        await refresh()
        set({ selected: [], preview: undefined, info: undefined, size: undefined })
      } catch (err) {
        fail(err)
      }
    },

    move: async (paths, dest, copy = false) => {
      if (!paths.length) return
      try {
        const made = await transfer(paths, dest, copy ? 'copy' : 'move')
        if (!made) return
        // Into the shown folder: show what arrived.
        await refresh(dest === get().listing?.path ? made : undefined)
      } catch (err) {
        fail(err)
      }
    },

    copy: async (paths = get().selected) => {
      if (!paths.length) return
      set({ clipboard: { paths, cut: false }, notice: { key: 'clipboard', count: paths.length, cut: false } })
      await ipc('finder:clipboardWrite', { paths, cut: false }).catch(() => {})
    },

    cut: async (paths = get().selected) => {
      if (!paths.length) return
      set({ clipboard: { paths, cut: true }, notice: { key: 'clipboard', count: paths.length, cut: true } })
      await ipc('finder:clipboardWrite', { paths, cut: true }).catch(() => {})
    },

    paste: async (dest = get().listing?.path) => {
      if (!dest) return
      const system = await ipc('finder:clipboardRead').catch(() => [] as string[])
      const own = get().clipboard
      // Mindeck's own ⌘C/⌘X wins while the system clipboard still holds the same files (or none).
      const fromUs = own && (!system.length || sameSet(system, own.paths))
      const paths = fromUs ? own.paths : system
      if (!paths.length) return
      const cut = !!fromUs && own.cut
      await get().move(paths, dest, !cut)
      if (cut) set({ clipboard: undefined })
    },

    undoLast: async () => {
      const step = get().undo.at(-1)
      if (!step) return
      set((s) => ({ undo: s.undo.slice(0, -1) }))
      try {
        if (step.trash?.length) await ipc('finder:trash', { paths: step.trash })
        if (step.moves?.length) await ipc('finder:restore', { moves: step.moves })
        const back = step.untrash?.length ? await ipc('finder:untrash', { items: step.untrash }) : { items: [], gone: [] }
        // Something came back (or nothing was asked of the trash): undone.
        if (back.items.length || !back.gone.length) set({ notice: { key: 'undone' } })
        await refresh([...(step.moves ?? []).map((m) => m.to), ...back.items.map((u) => u.to)].filter((p) => dirOf(p) === get().listing?.path))
        // Emptied from the trash since: said after the refresh (which clears errors), naming what is lost.
        if (back.gone.length) set({ error: back.gone.map(baseName).join(', '), errorCode: 'trash-gone' })
      } catch (err) {
        fail(err)
      }
    },

    compress: async (paths = get().selected) => {
      if (!paths.length) return
      await job('zip', (id) => ipc('finder:compress', { paths, id }))
    },

    extract: async (path) => {
      await job('unzip', (id) => ipc('finder:extract', { path, id }))
    },

    cancelJob: async (id) => {
      await ipc('finder:cancel', { id }).catch(() => {})
    },

    onProgress: (p) => {
      // Only jobs this view started (a size count shows in the info, not the status line).
      if (!get().jobs[p.id] || p.finished) return
      set((s) => ({ jobs: { ...s.jobs, [p.id]: p } }))
    },

    answerConflict: (choices) => get().conflict?.answer(choices),

    newTab: async (path) => {
      const s = get()
      const target = path ?? s.listing?.path ?? s.places?.home
      if (!target) return
      const id = newId()
      set({ tabs: [...s.tabs, { id, path: target, back: [], forward: [] }], activeTab: id, back: [], forward: [] })
      await get().open(target, { history: false })
    },

    closeTab: async (id) => {
      const s = get()
      if (s.tabs.length < 2) return
      const index = s.tabs.findIndex((t) => t.id === id)
      const tabs = s.tabs.filter((t) => t.id !== id)
      set({ tabs })
      if (id === s.activeTab) await get().switchTab(tabs[Math.max(0, index - 1)].id)
    },

    switchTab: async (id) => {
      const s = get()
      const tab = s.tabs.find((t) => t.id === id)
      if (!tab || id === s.activeTab) return
      set({ activeTab: id, back: tab.back, forward: tab.forward })
      await get().open(tab.path, { history: false })
    },

    toggleFavorite: (path) => {
      set((s) => ({ favorites: s.favorites.includes(path) ? s.favorites.filter((f) => f !== path) : [...s.favorites, path] }))
      prefs()
    },

    startDrag: (paths) => {
      const bridge = window.mindeck
      if (!bridge?.startDrag) return false
      set({ dragging: paths })
      bridge.startDrag(paths)
      return true
    },

    dropFiles: async (files, dest, copy) => {
      const bridge = window.mindeck
      const paths = files.map((f) => bridge?.pathForFile?.(f) ?? '').filter(Boolean)
      const dragging = get().dragging
      set({ dragging: undefined })
      if (!paths.length) return
      // Our own drag coming back is a move (⌥ copies); files from other apps are copied.
      const own = !!dragging && sameSet(paths, dragging)
      await get().move(paths.filter((p) => dirOf(p) !== dest || !own), dest, own ? copy : true)
    },

    endDrag: () => set({ dragging: undefined }),

    openWithApp: async (path) => {
      try {
        await ipc('finder:open', { path })
      } catch (err) {
        fail(err)
      }
    },

    reveal: async (path) => {
      try {
        await ipc('finder:reveal', { path })
      } catch (err) {
        fail(err)
      }
    },

    loadPreview: async (path) => {
      try {
        const preview = await ipc('finder:preview', { path })
        // Only if it is still what is selected.
        if (get().selected.length === 1 && get().selected[0] === path) set({ preview })
      } catch {
        set({ preview: undefined })
      }
    },

    setNotice: (notice) => set({ notice }),
    clearError: () => set({ error: undefined }),

    privacySettings: async () => {
      await ipc('finder:privacySettings').catch(fail)
    }
  }
})
