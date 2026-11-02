import { create } from 'zustand'
import { errorMessage, ipc } from '@shared/ipc/client'
import type { TerminalInfo } from '@shared/types/terminal'

export interface TerminalTab extends TerminalInfo {
  /** Exit code once the shell has ended (the tab stays until closed/restarted). */
  exitCode?: number
}

/**
 * How many terminals fill one screen: single = one · cols = two side by side ·
 * rows = two stacked · grid = 2×2. Further terminals continue below (scroll).
 */
export type TerminalLayout = 'single' | 'cols' | 'rows' | 'grid'

/** Columns of each layout, and how many rows fill one screen. */
export const LAYOUT_GRID: Record<TerminalLayout, { cols: number; rows: number }> = {
  single: { cols: 1, rows: 1 },
  cols: { cols: 2, rows: 1 },
  rows: { cols: 1, rows: 2 },
  grid: { cols: 2, rows: 2 }
}

interface TerminalState {
  /** Shown in this order, row by row. */
  tabs: TerminalTab[]
  activeId?: string
  layout: TerminalLayout
  error?: string
  initialized: boolean

  /** Re-attach to sessions that survived a renderer reload, else open one (in Home, unless `openHome` is false). */
  init: (openHome?: boolean) => Promise<void>
  open: (projectId?: string) => Promise<void>
  /** From elsewhere in the app (e.g. a project): a shell in that folder, without the extra Home shell of a first visit. */
  openProject: (projectId: string) => Promise<void>
  close: (id: string) => Promise<void>
  /** Replace an exited tab with a fresh shell in the same place. */
  restart: (id: string) => Promise<void>
  /** Focus a tab (the view scrolls it into sight). */
  setActive: (id: string) => void
  /** Switch layout. Never opens shells — the user fills empty panes. */
  setLayout: (layout: TerminalLayout) => void
  markExited: (id: string, exitCode: number) => void
}

/**
 * Display labels: same-named tabs get a number (`~`, `~ 2`, `~ 3`), assigned
 * by creation time so a tab keeps its name when panes are re-arranged.
 */
export function tabLabels(tabs: TerminalTab[]): Map<string, string> {
  const seen = new Map<string, number>()
  const byAge = [...tabs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  return new Map(
    byAge.map((t) => {
      const n = (seen.get(t.title) ?? 0) + 1
      seen.set(t.title, n)
      return [t.id, n === 1 ? t.title : `${t.title} ${n}`]
    })
  )
}

/** Tabs whose restart is in flight — Enter pressed again meanwhile must not spawn a second shell. */
const restarting = new Set<string>()

export const useTerminals = create<TerminalState>((set, get) => ({
  tabs: [],
  layout: 'single',
  initialized: false,

  init: async (openHome = true) => {
    if (get().initialized) return
    set({ initialized: true })
    try {
      const existing = await ipc('terminal:list')
      if (existing.length) set({ tabs: existing, activeId: existing[0].id })
      else if (openHome) await get().open()
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  open: async (projectId) => {
    try {
      const info = await ipc('terminal:create', { projectId })
      set((s) => ({ tabs: [...s.tabs, info], activeId: info.id, error: undefined }))
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  openProject: async (projectId) => {
    await get().init(false)
    await get().open(projectId)
  },

  close: async (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (tab && tab.exitCode === undefined) await ipc('terminal:kill', { id }).catch(() => {})
    set((s) => {
      const i = s.tabs.findIndex((t) => t.id === id)
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeId = s.activeId === id ? (tabs[i] ?? tabs[i - 1])?.id : s.activeId
      return { tabs, activeId }
    })
  },

  restart: async (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab || restarting.has(id)) return
    restarting.add(id)
    try {
      const info = await ipc('terminal:create', { projectId: tab.projectId })
      // The tab was closed while the shell started: don't leave it running unseen.
      if (!get().tabs.some((t) => t.id === id)) return void (await ipc('terminal:kill', { id: info.id }).catch(() => {}))
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? info : t)),
        activeId: s.activeId === id ? info.id : s.activeId,
        error: undefined
      }))
    } catch (err) {
      set({ error: errorMessage(err) })
    } finally {
      restarting.delete(id)
    }
  },

  setActive: (id) => set({ activeId: id }),

  // Only re-arranges; empty panes show a "New terminal" placeholder instead.
  setLayout: (layout) => set({ layout }),

  markExited: (id, exitCode) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, exitCode } : t)) }))
}))
