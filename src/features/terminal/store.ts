import { create } from 'zustand'
import { errorMessage, ipc, isDesktop, onEvent } from '@shared/ipc/client'
import type { TerminalInfo, TerminalSnapshot } from '@shared/types/terminal'
import { useTerminalSettings } from './settings'

export interface TerminalTab extends TerminalInfo {
  /** Exit code once the shell has ended (the tab stays until closed/restarted). */
  exitCode?: number
  /** After a restart: the output this tab showed last time, shown greyed above the new shell. */
  restored?: { scrollback: string; savedAt: string }
}

/**
 * How many terminals fill one screen: single = one · cols = two side by side ·
 * rows = two stacked · grid = 2×2. Further terminals continue below (scroll).
 */
export type TerminalLayout = TerminalSnapshot['layout']

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

  /**
   * Re-attach to sessions that survived a renderer reload; else bring back the
   * tabs of the last run (Settings → Terminal → restore); else open one (in
   * Home, unless `openHome` is false).
   */
  init: (openHome?: boolean) => Promise<void>
  /** A new shell: in Home or a project, with a profile (default: the one set in Settings). */
  open: (projectId?: string, profileId?: string) => Promise<void>
  /** From elsewhere in the app (e.g. a project): a shell in that folder, without the extra Home shell of a first visit. */
  openProject: (projectId: string) => Promise<void>
  /** From Files: a shell in any folder (absolute path), likewise without the extra Home shell. */
  openFolder: (cwd: string) => Promise<void>
  /** A new shell in Home that runs `command` (the onboarding's installs and sign-ins); its tab, unless it failed. */
  run: (command: string) => Promise<TerminalTab | undefined>
  /** A second shell next to this one: same folder, same profile (single layout → side by side). */
  split: (id: string) => Promise<void>
  close: (id: string) => Promise<void>
  /** Replace an exited tab with a fresh shell in the same place. */
  restart: (id: string) => Promise<void>
  /** An agent started a command in this shell (`terminal:reveal`): its tab (added if new) is focused and on screen. */
  reveal: (info: TerminalInfo) => Promise<void>
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

/** Each mounted view's recent output as plain text (useXterm registers it), for the saved tabs. */
export const serializers = new Map<string, () => string>()

/** Output kept per saved tab (chars). */
export const SAVED_SCROLLBACK = 256 * 1024
/** Changes are saved this long after the first one (output keeps coming — no debounce). */
export const SAVE_MS = 3000

let saveTimer: ReturnType<typeof setTimeout> | undefined
let saving = false

/** The tabs as they are now, for the next start. */
export function snapshot(): TerminalSnapshot {
  const { tabs, activeId, layout } = useTerminals.getState()
  return {
    layout,
    active: Math.max(0, tabs.findIndex((t) => t.id === activeId)),
    tabs: tabs.map((t) => ({
      title: t.title,
      cwd: t.cwd,
      ...(t.projectId ? { projectId: t.projectId } : {}),
      ...(t.profileId ? { profileId: t.profileId } : {}),
      scrollback: (serializers.get(t.id)?.() ?? '').slice(-SAVED_SCROLLBACK)
    })),
    savedAt: new Date().toISOString()
  }
}

/** Save the tabs now (window closing), unless restoring is off. */
export async function saveNow(): Promise<void> {
  clearTimeout(saveTimer)
  saveTimer = undefined
  if (!saving || !useTerminalSettings.getState().settings.restoreTabs) return
  await ipc('terminal:persist', snapshot()).catch(() => {})
}

/** Something changed (tabs, layout, output): save a little later. */
export function scheduleSave(): void {
  if (saving && !saveTimer) saveTimer = setTimeout(() => void saveNow(), SAVE_MS)
}

/** From init on (desktop only): every change is saved; so is the last state when the window closes. */
function startSaving(): void {
  if (saving || !isDesktop()) return
  saving = true
  useTerminals.subscribe(scheduleSave)
  window.addEventListener('beforeunload', () => void saveNow())
}

/** Folder changes the shells report (OSC 7) — the tab follows; listened to from init on. */
let offInfo: (() => void) | undefined
function followInfo(): void {
  offInfo?.()
  offInfo = onEvent('terminal:info', (info) =>
    useTerminals.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === info.id ? { ...t, cwd: info.cwd, cwdLabel: info.cwdLabel, title: info.title } : t))
    }))
  )
}

/** Brings back the last run's tabs: same folders, profiles and layout, their output greyed above. */
async function restore(): Promise<boolean> {
  const saved = isDesktop() ? await ipc('terminal:restore').catch(() => null) : null
  if (!saved?.tabs.length) return false
  const tabs: TerminalTab[] = []
  for (const t of saved.tabs) {
    // The folder, project or profile may be gone by now: then a shell in Home.
    const info = await ipc('terminal:create', { cwd: t.cwd, projectId: t.projectId, profileId: t.profileId })
      .catch(() => ipc('terminal:create', {}))
      .catch(() => undefined)
    if (info) tabs.push({ ...info, ...(t.scrollback.trim() ? { restored: { scrollback: t.scrollback, savedAt: saved.savedAt } } : {}) })
  }
  if (!tabs.length) return false
  useTerminals.setState({ tabs, layout: saved.layout, activeId: (tabs[saved.active] ?? tabs[0]).id })
  return true
}

const VIEW_KEY = 'mindeck.terminal.view'

/**
 * This window's view of the shells (their order, the layout, the active one),
 * kept for the session: after a renderer crash the window reloads, the shells
 * are still running in the core, and the view comes back as it was.
 */
function rememberView(s: TerminalState): void {
  try {
    sessionStorage.setItem(VIEW_KEY, JSON.stringify({ layout: s.layout, order: s.tabs.map((t) => t.id), activeId: s.activeId }))
  } catch {
    /* storage unavailable: a reload shows the shells in one pane */
  }
}

let remembering = false
function followView(): void {
  if (remembering) return
  remembering = true
  useTerminals.subscribe(rememberView)
}

function lastView(): { layout?: unknown; order?: unknown; activeId?: unknown } | null {
  try {
    return JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? 'null') as { layout?: unknown; order?: unknown; activeId?: unknown } | null
  } catch {
    return null // unreadable: the shells as listed
  }
}

/** Running shells re-attached in the order, layout and focus this window last showed (new ones at the end). */
function reattach(existing: TerminalInfo[], view: ReturnType<typeof lastView>): Pick<TerminalState, 'tabs' | 'layout' | 'activeId'> {
  const order: unknown[] = Array.isArray(view?.order) ? view.order : []
  const rank = (t: TerminalInfo) => (order.includes(t.id) ? order.indexOf(t.id) : order.length)
  const tabs = [...existing].sort((a, b) => rank(a) - rank(b))
  const layout = typeof view?.layout === 'string' && view.layout in LAYOUT_GRID ? (view.layout as TerminalLayout) : 'single'
  const activeId = tabs.find((t) => t.id === view?.activeId)?.id ?? tabs[0].id
  return { tabs, layout, activeId }
}

/** The layouts by how many terminals they show at once; a further one still fits in the grid's scroll. */
const GROWS: TerminalLayout[] = ['single', 'cols', 'grid']

/** A layout that shows the `n`th terminal on the first screen: the one on screen, else the next one large enough. */
export function layoutFor(layout: TerminalLayout, n: number): TerminalLayout {
  const cells = (l: TerminalLayout) => LAYOUT_GRID[l].cols * LAYOUT_GRID[l].rows
  if (n <= cells(layout)) return layout
  return GROWS.find((l) => cells(l) >= n) ?? 'grid'
}

/** Puts a new shell's tab in place (after `after`, else at the end) and focuses it. */
function add(info: TerminalInfo, after?: string) {
  useTerminals.setState((s) => {
    const at = after ? s.tabs.findIndex((t) => t.id === after) + 1 : 0
    const tabs = at > 0 ? [...s.tabs.slice(0, at), info, ...s.tabs.slice(at)] : [...s.tabs, info]
    return { tabs, activeId: info.id, error: undefined }
  })
}

/**
 * The first init, until it is done: a second caller (a shell from Files or a
 * project while the last run's tabs are still coming back) waits for it —
 * else the restored tabs would replace its new shell, which ran on unseen.
 */
let initializing: Promise<void> | undefined

export const useTerminals = create<TerminalState>((set, get) => ({
  tabs: [],
  layout: 'single',
  initialized: false,

  init: async (openHome = true) => {
    if (get().initialized) return initializing
    // Read before anything changes the store (and so the remembered view).
    const view = lastView()
    set({ initialized: true })
    initializing = (async () => {
      followInfo()
      await useTerminalSettings.getState().load()
      try {
        const existing = await ipc('terminal:list')
        // A reload: the shells this window showed are still running. Else shells running already were
        // started for an agent before the Terminal was opened: they join the last run's tabs.
        if (existing.length && view) set(reattach(existing, view))
        else if (await restore()) set((s) => ({ tabs: [...s.tabs, ...existing] }))
        else if (existing.length) set(reattach(existing, view))
        else if (openHome) await get().open()
      } catch (err) {
        set({ error: errorMessage(err) })
      }
      startSaving()
      followView()
    })()
    return initializing
  },

  open: async (projectId, profileId) => {
    try {
      add(await ipc('terminal:create', { projectId, ...(profileId ? { profileId } : {}) }))
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  openProject: async (projectId) => {
    await get().init(false)
    await get().open(projectId)
  },

  openFolder: async (cwd) => {
    await get().init(false)
    try {
      add(await ipc('terminal:create', { cwd }))
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  split: async (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    try {
      add(await ipc('terminal:create', { projectId: tab.projectId, cwd: tab.cwd, profileId: tab.profileId }), id)
      if (get().layout === 'single') set({ layout: 'cols' })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  run: async (command) => {
    await get().init(false)
    try {
      const info = await ipc('terminal:create', {})
      set((s) => ({ tabs: [...s.tabs, info], activeId: info.id, error: undefined }))
      // The shell reads it once it is up, as if typed.
      await ipc('terminal:write', { id: info.id, data: `${command}\r` })
      return info
    } catch (err) {
      set({ error: errorMessage(err) })
      return undefined
    }
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
    if (!tab) return
    try {
      // Same place again: the folder it was last in (its project's, if any), the same profile.
      const info = await ipc('terminal:create', { projectId: tab.projectId, cwd: tab.cwd, profileId: tab.profileId })
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? info : t)),
        activeId: s.activeId === id ? info.id : s.activeId,
        error: undefined
      }))
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  reveal: async (info) => {
    await get().init(false)
    set((s) => {
      const tabs = s.tabs.some((t) => t.id === info.id) ? s.tabs : [...s.tabs, info]
      return { tabs, activeId: info.id, layout: layoutFor(s.layout, tabs.findIndex((t) => t.id === info.id) + 1), error: undefined }
    })
  },

  setActive: (id) => set({ activeId: id }),

  // Only re-arranges; empty panes show a "New terminal" placeholder instead.
  setLayout: (layout) => set({ layout }),

  markExited: (id, exitCode) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, exitCode } : t)) }))
}))
