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
  /** Zen mode: only the panes, no top bar, side navigation or Command Deck. */
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

const KEY = 'mindeck.workspace'
export const MAX_NAME = 40

/** What a fresh install starts with: the dashboard, and two layouts to try. */
function initial(): Pick<WorkspaceState, 'layout' | 'saved' | 'current'> {
  const t = getT().workspace
  return {
    layout: L.singleLayout('core'),
    saved: [
      { id: 'w1', name: t.seedCoding, layout: L.makeLayout('main', ['editor', 'terminal', 'browser']) },
      { id: 'w2', name: t.seedReview, layout: L.makeLayout('columns', ['agents', 'browser']) }
    ]
  }
}

/** The layout of this device (each device has its own screen), as it was left. */
function load(): Pick<WorkspaceState, 'layout' | 'saved' | 'current'> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return initial()
    const stored = JSON.parse(raw) as { layout?: unknown; saved?: unknown; current?: unknown }
    const layout = L.parseLayout(stored.layout) ?? L.singleLayout('core')
    const saved: SavedWorkspace[] = []
    for (const w of Array.isArray(stored.saved) ? (stored.saved as Partial<SavedWorkspace>[]) : []) {
      const parsed = L.parseLayout(w?.layout)
      const name = typeof w?.name === 'string' ? w.name.trim().slice(0, MAX_NAME) : ''
      if (parsed && name && typeof w.id === 'string' && !saved.some((s) => s.id === w.id)) saved.push({ id: w.id, name, layout: { ...parsed, maximized: undefined } })
    }
    const current = saved.some((s) => s.id === stored.current) ? (stored.current as string) : undefined
    return { layout, saved, current }
  } catch {
    return initial()
  }
}

function persist(s: WorkspaceState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, layout: s.layout, saved: s.saved, current: s.current }))
  } catch {
    /* storage unavailable: the layout lasts until reload */
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
 * focus — remembered per device and restored at start — plus the named
 * layouts the user saved.
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
