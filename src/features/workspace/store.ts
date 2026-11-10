import { create } from 'zustand'
import type { ModuleId } from '@/types'
import { getT } from '@/lib/i18n'
import * as L from './layout'

/** A named layout ("Coding", "Review") to switch to with one key. */
export interface SavedWorkspace {
  id: string
  name: string
  layout: L.Layout
}

interface WorkspaceState {
  layout: L.Layout
  saved: SavedWorkspace[]
  /** The saved workspace last switched to or saved — the menu names it. */
  current?: string
  /** Zen mode: only the panes, no top bar or side navigation. */
  zen: boolean
  show(module: ModuleId): void
  place(paneId: string, module: ModuleId): void
  focus(paneId: string): void
  moveFocus(dir: L.Direction): void
  split(): void
  /** Open a module in a new pane beside pane `paneId` (a drop on its edge). */
  dropBeside(paneId: string, side: L.Side, module: ModuleId): void
  /** Open a module next to the focused pane ("Open in a new pane"). */
  openBeside(module: ModuleId): void
  /** Put a module on screen, the focus staying where it is (e.g. a terminal an agent started a command in). */
  reveal(module: ModuleId): void
  close(paneId?: string): void
  setPreset(preset: L.Preset): void
  resize(key: keyof L.Sizes, value: number): void
  toggleMaximize(paneId?: string): void
  setZen(zen: boolean): void
  /** Save the layout on screen under `name` (a workspace of that name is overwritten). */
  save(name: string): void
  /** Overwrite a saved workspace with the layout on screen. */
  update(id: string): void
  rename(id: string, name: string): void
  remove(id: string): void
  /** Switch to a saved workspace by id or by its place in the list (⌘⌥1…9). */
  apply(target: string | number): void
}

/** The saved workspaces of this device. */
const KEY = 'mindeck.workspace'
/** The layout on screen, for this run only: a reload (⌘R, a crashed page) keeps it; every start opens on Core. */
const SESSION_KEY = 'mindeck.workspace.session'
export const MAX_NAME = 40

/** What a fresh install starts with: two layouts to try (the screen itself always starts on Core). */
function initial(): Pick<WorkspaceState, 'saved'> {
  const t = getT().workspace
  return {
    saved: [
      { id: 'w1', name: t.seedCoding, layout: L.makeLayout('main', ['editor', 'terminal', 'browser']) },
      { id: 'w2', name: t.seedReview, layout: L.makeLayout('columns', ['agents', 'browser']) }
    ]
  }
}

/** The saved workspaces of this device (each device has its own screen). */
function loadSaved(): SavedWorkspace[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return initial().saved
    const stored = JSON.parse(raw) as { saved?: unknown }
    const saved: SavedWorkspace[] = []
    for (const w of Array.isArray(stored.saved) ? (stored.saved as Partial<SavedWorkspace>[]) : []) {
      const parsed = L.parseLayout(w?.layout)
      const name = typeof w?.name === 'string' ? w.name.trim().slice(0, MAX_NAME) : ''
      if (parsed && name && typeof w.id === 'string' && !saved.some((s) => s.id === w.id)) saved.push({ id: w.id, name, layout: { ...parsed, maximized: undefined } })
    }
    return saved
  } catch {
    return initial().saved
  }
}

/**
 * What the workspace starts with: Core on its own, every time Mindeck starts —
 * the screen left last time doesn't come back (the saved workspaces do). Only a
 * reload within this run (⌘R, a crashed page) keeps the layout on screen.
 */
function load(): Pick<WorkspaceState, 'layout' | 'saved' | 'current'> {
  const saved = loadSaved()
  try {
    const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as { layout?: unknown; current?: unknown } | null
    const layout = L.parseLayout(session?.layout)
    if (layout) return { layout, saved, current: saved.some((s) => s.id === session?.current) ? (session?.current as string) : undefined }
  } catch {
    /* unreadable: a start */
  }
  return { layout: L.singleLayout('core'), saved, current: undefined }
}

function persist(s: WorkspaceState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 2, saved: s.saved }))
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ layout: s.layout, current: s.current }))
  } catch {
    /* storage unavailable: the saved workspaces last until reload */
  }
}

/** A saved layout carries no maximized pane. */
const snapshot = (layout: L.Layout): L.Layout => ({ ...layout, maximized: undefined })

function newId(saved: SavedWorkspace[]): string {
  const taken = new Set(saved.map((w) => w.id))
  let n = 1
  while (taken.has(`w${n}`)) n += 1
  return `w${n}`
}

/**
 * The workspace on screen: which panes, which module in each, the sizes, the
 * focus — kept through a reload, while every start opens on Core — plus the
 * named layouts the user saved (kept per device).
 */
export const useWorkspace = create<WorkspaceState>((set, get) => {
  const edit = (fn: (layout: L.Layout) => L.Layout) => {
    const layout = fn(get().layout)
    if (layout !== get().layout) set({ layout })
  }
  return {
    ...load(),
    zen: false,

    show: (module) => edit((l) => L.show(l, module)),
    place: (paneId, module) => edit((l) => L.place(l, paneId, module)),
    focus: (paneId) => edit((l) => L.focus(l, paneId)),
    moveFocus: (dir) => edit((l) => L.moveFocus(l, dir)),
    split: () => edit(L.split),
    dropBeside: (paneId, side, module) => edit((l) => L.dropBeside(l, paneId, side, module)),
    openBeside: (module) => edit((l) => L.openBeside(l, module)),
    reveal: (module) => edit((l) => L.reveal(l, module)),
    close: (paneId) => edit((l) => L.close(l, paneId)),
    setPreset: (preset) => edit((l) => L.setPreset(l, preset)),
    resize: (key, value) => edit((l) => L.resize(l, key, value)),
    toggleMaximize: (paneId) => edit((l) => L.toggleMaximize(l, paneId)),
    setZen: (zen) => set({ zen }),

    save: (name) => {
      const clean = name.trim().slice(0, MAX_NAME)
      if (!clean) return
      const { saved, layout } = get()
      const same = saved.find((w) => w.name.toLowerCase() === clean.toLowerCase())
      if (same) return get().update(same.id)
      const id = newId(saved)
      set({ saved: [...saved, { id, name: clean, layout: snapshot(layout) }], current: id })
    },
    update: (id) => set((s) => ({ saved: s.saved.map((w) => (w.id === id ? { ...w, layout: snapshot(s.layout) } : w)), current: id })),
    rename: (id, name) => {
      const clean = name.trim().slice(0, MAX_NAME)
      if (clean) set((s) => ({ saved: s.saved.map((w) => (w.id === id ? { ...w, name: clean } : w)) }))
    },
    remove: (id) => set((s) => ({ saved: s.saved.filter((w) => w.id !== id), current: s.current === id ? undefined : s.current })),
    apply: (target) => {
      const { saved } = get()
      const w = typeof target === 'number' ? saved[target] : saved.find((x) => x.id === target)
      if (w) set({ layout: snapshot(w.layout), current: w.id })
    }
  }
})

useWorkspace.subscribe(persist)
