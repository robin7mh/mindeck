import { create } from 'zustand'
import { errorMessage, ipc, IpcError } from '@shared/ipc/client'
import type { FileEntry, FileStat } from '@shared/types/files'
import { groupOrder, leaf, neighbour, parseGrid, removeGroup, splitGroup, moveSash, evenSizes, type GridNode, type Sash, type Side } from './groups'

export interface EditorTab {
  /** `projectId:path` — tabs of several projects can be open side by side. */
  id: string
  projectId: string
  /** Posix path relative to the project root. */
  path: string
  name: string
  loading: boolean
  /** Text as last read from / written to disk. Absent until loaded, or when not editable. */
  content?: string
  mtimeMs?: number
  unsupported?: 'binary' | 'too-large'
  /** Bumped whenever `content` was re-read from disk — the view swaps the buffer text. */
  revision: number
  dirty: boolean
  saving: boolean
  /** Changed on disk while there were unsaved edits — the user decides. */
  conflict: boolean
  /** Gone from disk; saving recreates it. */
  deleted: boolean
  error?: string
}

/**
 * The live text buffers, implemented by the Monaco view. Keeps Monaco (a few
 * MB, loaded on demand) out of the store, and keystrokes out of React state:
 * the store asks for the text only when it saves.
 */
export interface BufferHost {
  /** Current text plus its version (Monaco's alternative version id). */
  snapshot(id: string): { text: string; version: number } | undefined
  /** `version` is now what's on disk — the view derives `dirty` from it. */
  markClean(id: string, version: number): void
  /** The tab closed — free its buffer. */
  drop(id: string): void
  /** Get the buffer ready to be written (format, tidy — the user's save settings). */
  prepare?(id: string): Promise<void>
  /** The file was renamed — carry the buffer (unsaved edits included) over to its new id. */
  rekey(id: string, next: { id: string; projectId: string; path: string }): void
  /** Replace ranges of the buffer as one undoable edit (search & replace). Columns are 0-based. */
  edit?(id: string, edits: { line: number; column: number; length: number; text: string }[]): void
}

let host: BufferHost | null = null
export function setBufferHost(next: BufferHost | null): void {
  host = next
}

/** An open file's text as edited (unsaved edits included) — undefined when it has no buffer. */
export function bufferText(id: string): string | undefined {
  return host?.snapshot(id)?.text
}

/** Edit an open file's buffer (undoable in the editor); false when it has none. */
export function editBuffer(id: string, edits: Parameters<NonNullable<BufferHost['edit']>>[1]): boolean {
  if (!host?.edit || !host.snapshot(id)) return false
  host.edit(id, edits)
  return true
}

export const tabKey = (projectId: string, path: string): string => `${projectId}:${path}`

/** Runs after every successful save (Live Sass compiles, SFTP uploads). */
type SavedListener = (file: { projectId: string; path: string }) => void
const savedListeners = new Set<SavedListener>()
export function onSaved(listener: SavedListener): () => void {
  savedListeners.add(listener)
  return () => savedListeners.delete(listener)
}

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`)

/** An editor group: a tab bar and an editor, somewhere in the grid. */
export interface EditorGroup {
  id: string
  /** Its tabs (ids of open files), in the order of its tab bar. A file can be open in several groups. */
  tabs: string[]
  activeId?: string
}

/** A project's editor area: its groups and how they're laid out. */
export interface EditorSession {
  grid: GridNode
  groups: EditorGroup[]
  activeGroup: string
}

type Area = EditorSession & { activeId?: string }

/** The area's state, consistent: the active group exists, `activeId` is its tab. */
function area(groups: EditorGroup[], grid: GridNode, activeGroup: string): Area {
  const order = groupOrder(grid)
  const active = order.includes(activeGroup) ? activeGroup : order[0]
  return { groups, grid, activeGroup: active, activeId: groups.find((g) => g.id === active)?.activeId }
}

/** One group with these tabs — a fresh editor area. */
export function oneGroup(tabs: string[] = [], activeId: string | undefined = tabs[0]): Area {
  return area([{ id: 'g1', tabs, activeId }], leaf('g1'), 'g1')
}

/** The next free group id. */
function newGroupId(groups: EditorGroup[]): string {
  let n = 1
  while (groups.some((g) => g.id === `g${n}`)) n += 1
  return `g${n}`
}

/** The group that takes over from `id` (its nearest neighbour). */
function heirOf(grid: GridNode, id: string): string | undefined {
  return neighbour(grid, id, 'left') ?? neighbour(grid, id, 'up') ?? neighbour(grid, id, 'right') ?? neighbour(grid, id, 'down')
}

/**
 * A tab leaves a group: its neighbour (right, else left) becomes active, like
 * VS Code — and a group left empty closes, unless it is the last one.
 */
function withoutTab(s: EditorSession, groupId: string, id: string): EditorSession {
  // Callers name a group that exists.
  const group = s.groups.find((g) => g.id === groupId)!
  const index = group.tabs.indexOf(id)
  if (index < 0) return s
  const tabs = group.tabs.filter((x) => x !== id)
  if (!tabs.length && s.groups.length > 1) {
    const activeGroup = s.activeGroup === groupId ? heirOf(s.grid, groupId)! : s.activeGroup
    return { groups: s.groups.filter((g) => g.id !== groupId), grid: removeGroup(s.grid, groupId)!, activeGroup }
  }
  const activeId = group.activeId === id ? tabs[Math.min(index, tabs.length - 1)] : group.activeId
  return { ...s, groups: s.groups.map((g) => (g.id === groupId ? { ...g, tabs, activeId } : g)) }
}

/** `id` in `tabs` at `index` (or right after the active tab), moved there if it already is. */
function placeTab(group: EditorGroup, id: string, index?: number): string[] {
  const from = group.tabs.indexOf(id)
  // Already there, no place asked for: it stays where it is.
  if (index === undefined && from >= 0) return group.tabs
  const rest = group.tabs.filter((x) => x !== id)
  let at = index ?? (group.activeId ? rest.indexOf(group.activeId) + 1 : rest.length)
  if (from >= 0 && index! > from) at -= 1
  rest.splice(Math.min(Math.max(at, 0), rest.length), 0, id)
  return rest
}

const LAYOUTS_KEY = 'mindeck.editor.layouts'

interface StoredSession {
  grid: GridNode
  groups: { id: string; tabs: string[]; active?: string }[]
  active: string
}

function storedSessions(): Record<string, unknown> {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUTS_KEY) ?? '{}') as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** A project's editor area as it was left (this device), or undefined. */
export function loadSession(projectId: string): EditorSession | undefined {
  const raw = storedSessions()[projectId] as Partial<StoredSession> | undefined
  const grid = parseGrid(raw?.grid)
  if (!grid) return undefined
  const stored = Array.isArray(raw!.groups) ? raw!.groups : []
  const groups = groupOrder(grid).map((id): EditorGroup => {
    const g = stored.find((x) => x?.id === id)
    const paths = [...new Set((Array.isArray(g?.tabs) ? g!.tabs : []).filter((p): p is string => typeof p === 'string' && !!p))]
    const tabs = paths.map((p) => tabKey(projectId, p))
    const active = typeof g?.active === 'string' && paths.includes(g.active) ? tabKey(projectId, g.active) : tabs[0]
    return { id, tabs, activeId: active }
  })
  return { grid, groups, activeGroup: typeof raw!.active === 'string' ? raw!.active : groups[0].id }
}

/** Remember the project's editor area (paths, not ids: a project's id is the same on every start). */
function saveSession(projectId: string, s: EditorSession): void {
  const prefix = `${projectId}:`
  const own = (id: string) => (id.startsWith(prefix) ? [id.slice(prefix.length)] : [])
  const stored: StoredSession = {
    grid: s.grid,
    groups: s.groups.map((g) => ({ id: g.id, tabs: g.tabs.flatMap(own), active: g.activeId && own(g.activeId)[0] })),
    active: s.activeGroup
  }
  try {
    localStorage.setItem(LAYOUTS_KEY, JSON.stringify({ ...storedSessions(), [projectId]: stored }))
  } catch {
    /* storage unavailable: the layout lasts until reload */
  }
}

/** The explorer's inline name field: a new file or folder inside `dir`, or renaming `path`. */
export interface Naming {
  mode: 'file' | 'dir' | 'rename'
  dir: string
  path?: string
  error?: string
}

interface EditorState {
  projectId?: string
  /** Listed folders by `projectId:dir` ('' = the project root). */
  tree: Record<string, FileEntry[]>
  expanded: Record<string, boolean>
  treeError?: string
  /** Open files (one entry per file, whichever groups show it) — their text, disk state and unsaved flag. */
  tabs: EditorTab[]
  /** The editor area: groups in a grid. */
  grid: GridNode
  groups: EditorGroup[]
  /** The group with the focus — opening, saving and the status bar are about it. */
  activeGroup: string
  /** The active group's tab. */
  activeId?: string
  /** The editor areas of the other projects, while this one is on screen. */
  sessions: Record<string, EditorSession>
  /** Dirty tab waiting for "save before closing?". */
  closing?: string
  /**
   * A line to scroll to once its tab shows (search results, symbols); the view
   * clears it. `match` (0-based column) is selected. In `group`, else the active one.
   */
  reveal?: { id: string; line: number; match?: { column: number; length: number }; group?: string }
  /** The explorer's focused entry — new files land in it (a folder) or next to it (a file). */
  selection?: { path: string; kind: FileEntry['kind'] }
  naming?: Naming
  /** Entry waiting for "move to the trash?". */
  deleting?: string
  /** A file operation failed (create, rename, delete). */
  fileError?: string

  selectProject: (id: string) => Promise<void>
  loadDir: (dir: string) => Promise<void>
  toggleDir: (dir: string) => Promise<void>
  /** Re-list the root and every open folder of the current project. */
  refreshTree: () => Promise<void>
  /** Open a file in a group (the active one) and show it. */
  open: (path: string, opts?: { group?: string }) => Promise<void>
  /** Open a file and put the cursor on `line` (1-based) — or select a match there. */
  openAt: (path: string, line: number, match?: { column: number; length: number }) => Promise<void>
  /** Show an open file in a group (the active one), which gets the focus. */
  setActive: (id: string, group?: string) => void
  /** Open a file in the group to the right of the active one (splitting, if there is none). */
  openToSide: (path: string) => Promise<void>
  /** Split the active group (⌘\ right, ⌘K ⌘\ down): a new group next to it, with its file. */
  split: (side?: Side, id?: string) => void
  focusGroup: (group: string) => void
  /** ⌘1…⌘9: the n-th group (0-based, grid order); one past the last splits it, like VS Code. */
  focusGroupAt: (index: number) => void
  /** Close a group (the active one); its files open elsewhere stay, unsaved ones move to its neighbour. */
  closeGroup: (group?: string) => void
  /** Move a tab to another group (or another place in its own); `copy` keeps it where it was. */
  moveTab: (id: string, from: string, to: string, opts?: { index?: number; copy?: boolean }) => void
  /** Drop a tab on a group's edge: a new group on that side with the tab. */
  dropTab: (id: string, from: string, target: string, side: Side, opts?: { copy?: boolean }) => void
  /** Close every tab of a group but this one (unsaved ones ask, one at a time). */
  closeOthers: (id: string, group: string) => void
  /** Drag a sash to `at`; `min` is the smallest group (both in fractions of the area). */
  resizeGrid: (sash: Pick<Sash, 'path' | 'index'>, at: number, min: number) => void
  /** Equal sizes for the groups of one row or column. */
  evenGrid: (path: number[]) => void
  /** The tab of the focused group. */
  focusedId: () => string | undefined
  setDirty: (id: string, dirty: boolean) => void
  /** Write the buffer to disk. `force` overwrites a newer disk copy. Resolves true when saved. */
  save: (id?: string, opts?: { force?: boolean }) => Promise<boolean>
  /** Save every tab with unsaved edits. */
  saveAll: () => Promise<void>
  /**
   * Re-read from disk. `ifClean`: if edits appeared meanwhile, flag a conflict instead.
   * `restoring`: a file of a restored layout — one that can't be read any more closes.
   */
  reload: (id: string, opts?: { ifClean?: boolean; restoring?: boolean }) => Promise<void>
  /** Close a tab of a group (the active one) — or ask first when there are unsaved edits it alone shows. */
  requestClose: (id: string, group?: string) => void
  cancelClose: () => void
  saveAndClose: (id: string) => Promise<void>
  /** Close a file: out of every group, its buffer freed. */
  close: (id: string) => void
  /** Follow the disk: reload clean tabs that changed, flag dirty ones, mark deleted files. */
  checkDisk: () => Promise<void>

  select: (path: string, kind: FileEntry['kind']) => void
  /** Ask for a name: a new file / folder in the selected folder, or a new name for the selection. */
  startNaming: (mode: Naming['mode'], target?: { path: string; kind: FileEntry['kind'] }) => Promise<void>
  cancelNaming: () => void
  /** Create or rename with `name`; a bad name keeps the field open with the error. */
  submitName: (name: string) => Promise<void>
  requestDelete: (path?: string) => void
  cancelDelete: () => void
  confirmDelete: () => Promise<void>
  collapseAll: () => void
  clearFileError: () => void
}

const update =
  (id: string, changes: Partial<EditorTab> | ((t: EditorTab) => Partial<EditorTab>)) =>
  (s: EditorState) => ({
    tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...(typeof changes === 'function' ? changes(t) : changes) } : t))
  })

/**
 * The editor: a lazily listed file tree per project, and open files as tabs.
 * Files on disk stay the source of truth — saves refuse to overwrite a copy
 * someone else changed, and `checkDisk` keeps open tabs in step with edits
 * made elsewhere (agents, git, another editor).
 */
export const useEditor = create<EditorState>((set, get) => ({
  tree: {},
  expanded: {},
  tabs: [],
  ...oneGroup(),
  sessions: {},

  selectProject: async (id) => {
    const s = get()
    if (s.projectId === id) return
    // Each project has its own editor area: the one on screen is put aside, the project's own comes back.
    const { [id]: kept, ...others } = s.sessions
    // The first project of a start brings its layout back — unless files are already on screen (they stay).
    const showing = !s.projectId && s.groups.some((g) => g.tabs.length)
    const session = showing ? s : (kept ?? loadSession(id))
    const next = session ? area(session.groups, session.grid, session.activeGroup) : oneGroup()
    set({
      projectId: id,
      treeError: undefined,
      sessions: s.projectId ? { ...others, [s.projectId]: { grid: s.grid, groups: s.groups, activeGroup: s.activeGroup } } : others,
      ...next
    })
    // Files of a restored layout that aren't open yet load now; gone ones drop out.
    const missing = [...new Set(next.groups.flatMap((g) => g.tabs))].filter((t) => !get().tabs.some((x) => x.id === t))
    set((st) => ({ tabs: [...st.tabs, ...missing.map((t) => newTab(id, t.slice(id.length + 1)))] }))
    await Promise.all([get().loadDir(''), ...missing.map((t) => get().reload(t, { restoring: true }))])
  },

  loadDir: async (dir) => {
    const projectId = get().projectId!
    const key = tabKey(projectId, dir)
    try {
      const entries = await ipc('files:list', { projectId, dir })
      set((s) => ({ tree: { ...s.tree, [key]: entries }, treeError: dir ? s.treeError : undefined }))
    } catch (err) {
      if (!dir) return set({ treeError: errorMessage(err) })
      // A sub-folder that can't be listed (deleted, renamed) just folds away.
      set((s) => {
        const { [key]: _gone, ...tree } = s.tree
        const { [key]: _open, ...expanded } = s.expanded
        return { tree, expanded }
      })
    }
  },

  toggleDir: async (dir) => {
    const key = tabKey(get().projectId!, dir)
    if (get().expanded[key]) {
      set((s) => {
        const { [key]: _closed, ...expanded } = s.expanded
        return { expanded }
      })
      return
    }
    set((s) => ({ expanded: { ...s.expanded, [key]: true } }))
    await get().loadDir(dir)
  },

  refreshTree: async () => {
    const prefix = `${get().projectId!}:`
    const open = Object.keys(get().expanded)
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
    await Promise.all(['', ...open].map((dir) => get().loadDir(dir)))
  },

  open: async (path, { group } = {}) => {
    const projectId = get().projectId!
    const id = tabKey(projectId, path)
    const known = get().tabs.some((t) => t.id === id)
    if (!known) set((s) => ({ tabs: [...s.tabs, newTab(projectId, path)] }))
    get().setActive(id, group)
    if (!known) await get().reload(id)
  },

  openAt: async (path, line, match) => {
    await get().open(path)
    set({ reveal: { id: tabKey(get().projectId!, path), line, match, group: get().activeGroup } })
  },

  setActive: (id, group = get().activeGroup) =>
    set((s) => {
      const target = s.groups.find((g) => g.id === group) ?? s.groups.find((g) => g.id === s.activeGroup)!
      const groups = s.groups.map((g) => (g.id === target.id ? { ...g, tabs: g.tabs.includes(id) ? g.tabs : placeTab(g, id), activeId: id } : g))
      return area(groups, s.grid, target.id)
    }),

  openToSide: async (path) => {
    const s = get()
    const empty = !s.groups.find((g) => g.id === s.activeGroup)!.tabs.length
    let target = empty ? s.activeGroup : neighbour(s.grid, s.activeGroup, 'right')
    if (!target) {
      target = newGroupId(s.groups)
      set(area([...s.groups, { id: target, tabs: [] }], splitGroup(s.grid, s.activeGroup, target, 'right'), target))
    }
    await get().open(path, { group: target })
  },

  split: (side = 'right', id = get().focusedId()) => {
    const s = get()
    const file = id && s.tabs.some((t) => t.id === id) ? id : undefined
    const created = newGroupId(s.groups)
    set(area([...s.groups, { id: created, tabs: file ? [file] : [], activeId: file }], splitGroup(s.grid, s.activeGroup, created, side), created))
  },

  focusGroup: (group) => {
    const s = get()
    if (s.activeGroup !== group && s.groups.some((g) => g.id === group)) set(area(s.groups, s.grid, group))
  },

  focusGroupAt: (index) => {
    const s = get()
    const order = groupOrder(s.grid)
    if (index < order.length) return get().focusGroup(order[index])
    if (index > order.length) return
    // The next group doesn't exist yet: split the last one, with its file (VS Code's ⌘2 on one group).
    const last = s.groups.find((g) => g.id === order[order.length - 1])!
    const created = newGroupId(s.groups)
    set(area([...s.groups, { id: created, tabs: last.activeId ? [last.activeId] : [], activeId: last.activeId }], splitGroup(s.grid, last.id, created, 'right'), created))
  },

  closeGroup: (groupId = get().activeGroup) => {
    const s = get()
    const group = s.groups.find((g) => g.id === groupId)
    if (!group || s.groups.length < 2) return
    const shownElsewhere = (id: string) => s.groups.some((g) => g.id !== groupId && g.tabs.includes(id))
    const own = group.tabs.filter((id) => !shownElsewhere(id))
    // Unsaved files are never closed by the way: they move to the neighbour, which gets the focus.
    const unsaved = own.filter((id) => s.tabs.find((t) => t.id === id)?.dirty)
    const heir = heirOf(s.grid, groupId)!
    const groups = s.groups
      .filter((g) => g.id !== groupId)
      .map((g) => (g.id === heir && unsaved.length ? { ...g, tabs: [...g.tabs, ...unsaved], activeId: unsaved.includes(group.activeId!) ? group.activeId : unsaved[0] } : g))
    set(area(groups, removeGroup(s.grid, groupId)!, heir))
    for (const id of own) if (!unsaved.includes(id)) get().close(id)
  },

  moveTab: (id, from, to, { index, copy = false } = {}) => {
    const s = get()
    const target = s.groups.find((g) => g.id === to)
    if (!target || !s.groups.find((g) => g.id === from)?.tabs.includes(id)) return
    const placed: EditorSession = { ...s, groups: s.groups.map((g) => (g.id === to ? { ...g, tabs: placeTab(g, id, index), activeId: id } : g)) }
    const next = from === to || copy ? placed : withoutTab(placed, from, id)
    set(area(next.groups, next.grid, to))
  },

  dropTab: (id, from, target, side, { copy = false } = {}) => {
    const s = get()
    const source = s.groups.find((g) => g.id === from)
    if (!source?.tabs.includes(id) || !s.groups.some((g) => g.id === target)) return
    // A group's only tab dropped on its own edge: nothing would move.
    if (!copy && from === target && source.tabs.length === 1) return
    const created = newGroupId(s.groups)
    const split: EditorSession = { groups: [...s.groups, { id: created, tabs: [id], activeId: id }], grid: splitGroup(s.grid, target, created, side), activeGroup: created }
    const next = copy ? split : withoutTab(split, from, id)
    set(area(next.groups, next.grid, created))
  },

  closeOthers: (id, groupId) => {
    const others = get().groups.find((g) => g.id === groupId)?.tabs.filter((t) => t !== id) ?? []
    for (const other of others) {
      if (get().closing) break
      get().requestClose(other, groupId)
    }
  },

  resizeGrid: (sash, at, min) => {
    const grid = moveSash(get().grid, sash, at, min)
    if (grid !== get().grid) set({ grid })
  },

  evenGrid: (path) => set({ grid: evenSizes(get().grid, path) }),

  focusedId: () => get().activeId,

  setDirty: (id, dirty) => {
    if (get().tabs.find((t) => t.id === id)?.dirty === dirty) return
    set(update(id, { dirty }))
  },

  save: async (id = get().focusedId(), opts = {}) => {
    // Like VS Code: a save of edited text first formats / tidies it (the user's settings) — then reads it.
    const before = get().tabs.find((t) => t.id === id)
    const prepare = host?.prepare
    if (prepare && before?.content !== undefined && !before.saving && (before.dirty || before.deleted)) await prepare(before.id)
    const tab = get().tabs.find((t) => t.id === id)
    const buffers = host
    const snap = tab && tab.content !== undefined && !tab.saving ? buffers?.snapshot(tab.id) : undefined
    if (!tab || !snap) return false
    if (!tab.dirty && !tab.deleted) return true
    set(update(tab.id, { saving: true }))
    try {
      const saved: FileStat = await ipc('files:write', {
        projectId: tab.projectId,
        path: tab.path,
        content: snap.text,
        expectedMtime: opts.force || tab.deleted ? undefined : tab.mtimeMs
      })
      set(update(tab.id, { saving: false, content: snap.text, mtimeMs: saved.mtimeMs, conflict: false, deleted: false, error: undefined }))
      buffers!.markClean(tab.id, snap.version)
      for (const listener of savedListeners) listener({ projectId: tab.projectId, path: tab.path })
      return true
    } catch (err) {
      const conflict = err instanceof IpcError && err.code === 'conflict'
      set(update(tab.id, (t) => ({ saving: false, conflict: conflict || t.conflict, error: conflict ? undefined : errorMessage(err) })))
      return false
    }
  },

  saveAll: async () => {
    await Promise.all(get().tabs.filter((t) => t.dirty).map((t) => get().save(t.id)))
  },

  reload: async (id, opts = {}) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    try {
      const file = await ipc('files:read', { projectId: tab.projectId, path: tab.path })
      if (opts.ifClean && get().tabs.find((t) => t.id === id)?.dirty) return set(update(id, { conflict: true }))
      set(
        update(id, (t) => ({
          loading: false,
          content: file.content,
          mtimeMs: file.mtimeMs,
          unsupported: file.unsupported,
          revision: t.revision + 1,
          dirty: false,
          conflict: false,
          deleted: false,
          error: undefined
        }))
      )
    } catch (err) {
      if (opts.restoring) return get().close(id)
      set(update(id, { loading: false, error: errorMessage(err) }))
    }
  },

  requestClose: (id, groupId = get().activeGroup) => {
    const s = get()
    // Still on screen in another group: only this group lets go of it.
    if (s.groups.some((g) => g.id === groupId && g.tabs.includes(id)) && s.groups.some((g) => g.id !== groupId && g.tabs.includes(id))) {
      const next = withoutTab(s, groupId, id)
      return set(area(next.groups, next.grid, next.activeGroup))
    }
    if (s.tabs.find((t) => t.id === id)?.dirty) return set({ closing: id })
    get().close(id)
  },

  cancelClose: () => set({ closing: undefined }),

  saveAndClose: async (id) => {
    if (await get().save(id)) get().close(id)
  },

  close: (id) => {
    const s = get()
    if (!s.tabs.some((t) => t.id === id)) return
    host?.drop(id)
    // Out of every group: the neighbour takes over (right, else left), an emptied group closes — like VS Code.
    let next: EditorSession = s
    for (const g of s.groups) next = withoutTab(next, g.id, id)
    const strip = (session: EditorSession): EditorSession => ({
      ...session,
      groups: session.groups.map((g) => (g.tabs.includes(id) ? { ...g, tabs: g.tabs.filter((x) => x !== id), activeId: g.activeId === id ? g.tabs.find((x) => x !== id) : g.activeId } : g))
    })
    set({
      tabs: s.tabs.filter((t) => t.id !== id),
      closing: undefined,
      sessions: Object.fromEntries(Object.entries(s.sessions).map(([p, session]) => [p, strip(session)])),
      ...area(next.groups, next.grid, next.activeGroup)
    })
  },

  checkDisk: async () => {
    const byProject = new Map<string, EditorTab[]>()
    for (const t of get().tabs) {
      if (t.content === undefined || t.saving) continue
      byProject.set(t.projectId, [...(byProject.get(t.projectId) ?? []), t])
    }
    await Promise.all(
      [...byProject].map(async ([projectId, list]) => {
        const stats = await ipc('files:stat', { projectId, paths: list.map((t) => t.path) }).catch(() => null)
        if (!stats) return
        await Promise.all(
          list.map(async ({ id }, i) => {
            const t = get().tabs.find((x) => x.id === id)
            const disk = stats[i]
            if (!t || t.saving) return
            if (!disk) {
              if (!t.deleted) set(update(id, { deleted: true }))
            } else if (disk.mtimeMs === t.mtimeMs) {
              if (t.deleted) set(update(id, { deleted: false }))
            } else if (t.dirty) {
              if (!t.conflict) set(update(id, { conflict: true, deleted: false }))
            } else {
              await get().reload(id, { ifClean: true })
            }
          })
        )
      })
    )
  },

  select: (path, kind) => set({ selection: { path, kind } }),

  startNaming: async (mode, target = get().selection) => {
    if (mode === 'rename') {
      if (!target) return
      return set({ selection: target, naming: { mode, dir: parentOf(target.path), path: target.path } })
    }
    const dir = !target ? '' : target.kind === 'dir' ? target.path : parentOf(target.path)
    if (dir && !get().expanded[tabKey(get().projectId!, dir)]) await get().toggleDir(dir)
    set({ naming: { mode, dir } })
  },

  cancelNaming: () => set({ naming: undefined }),

  submitName: async (raw) => {
    const naming = get().naming
    const name = raw.trim().replace(/^\/+|\/+$/g, '')
    if (!naming) return
    if (!name || name.split('/').some((part) => part === '..' || part === '.' || !part)) return set({ naming: { ...naming, error: 'invalid-name' } })
    const projectId = get().projectId!
    const path = naming.dir ? `${naming.dir}/${name}` : name
    if (naming.mode === 'rename' && path === naming.path) return set({ naming: undefined })
    try {
      if (naming.mode === 'rename') await ipc('files:rename', { projectId, from: naming.path!, to: path })
      else await ipc('files:create', { projectId, path, kind: naming.mode })
    } catch (err) {
      return set({ naming: { ...naming, error: errorMessage(err) } })
    }
    const kind = naming.mode === 'rename' ? get().selection!.kind : naming.mode
    set({ naming: undefined, selection: { path, kind } })
    if (naming.mode === 'rename') moveTabs(naming.path!, path)
    await get().refreshTree()
    if (naming.mode === 'file') await get().open(path)
  },

  requestDelete: (path = get().selection?.path) => set({ deleting: path }),
  cancelDelete: () => set({ deleting: undefined }),

  confirmDelete: async () => {
    const path = get().deleting
    const projectId = get().projectId!
    if (!path) return
    set({ deleting: undefined })
    try {
      await ipc('files:delete', { projectId, path })
    } catch (err) {
      return set({ fileError: errorMessage(err) })
    }
    // Clean tabs of what's gone close; unsaved ones stay (marked deleted — saving brings them back).
    for (const t of get().tabs) if (t.projectId === projectId && under(t.path, path) && !t.dirty) get().close(t.id)
    if (get().selection && under(get().selection!.path, path)) set({ selection: undefined })
    await get().refreshTree()
  },

  collapseAll: () => {
    const prefix = `${get().projectId!}:`
    set((s) => ({ expanded: Object.fromEntries(Object.entries(s.expanded).filter(([k]) => !k.startsWith(prefix))) }))
  },

  clearFileError: () => set({ fileError: undefined })
}))

/** Tabs follow a renamed file or folder — their buffers (unsaved edits too) move along, in every group. */
function moveTabs(from: string, to: string): void {
  const { projectId, tabs } = useEditor.getState()
  for (const t of tabs) {
    if (t.projectId !== projectId || !under(t.path, from)) continue
    const path = to + t.path.slice(from.length)
    const id = tabKey(t.projectId, path)
    const rename = (x: string) => (x === t.id ? id : x)
    host?.rekey(t.id, { id, projectId: t.projectId, path })
    useEditor.setState((s) => ({
      tabs: s.tabs.map((x) => (x.id === t.id ? { ...x, id, path, name: path.slice(path.lastIndexOf('/') + 1) } : x)),
      ...area(
        s.groups.map((g) => ({ ...g, tabs: g.tabs.map(rename), activeId: g.activeId && rename(g.activeId) })),
        s.grid,
        s.activeGroup
      )
    }))
  }
}

/** A tab for a file not loaded yet. */
function newTab(projectId: string, path: string): EditorTab {
  return {
    id: tabKey(projectId, path),
    projectId,
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    loading: true,
    revision: 0,
    dirty: false,
    saving: false,
    conflict: false,
    deleted: false
  }
}

// The project's layout is remembered as it changes — and comes back when the project does (also after a restart).
useEditor.subscribe((s, prev) => {
  if (s.projectId && (s.grid !== prev.grid || s.groups !== prev.groups || s.activeGroup !== prev.activeGroup)) saveSession(s.projectId, s)
})
