import { create } from 'zustand'

const RECENT_KEY = 'mindeck.palette.recent'
/** Recently used commands the palette lists first. */
export const MAX_RECENT = 8

function loadRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string').slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

interface PaletteState {
  /** Open now: the command palette, or the shortcut overview. */
  view?: 'commands' | 'shortcuts'
  /** What the palette opens with. */
  query: string
  /** Command ids, the last one used first — remembered per device. */
  recent: string[]
  /** Open the palette (from anywhere: ⌘K, ⇧⌘P, the top bar, the editor's F1). */
  show: (query?: string) => void
  /** Open the shortcut overview (⌘/, "?"). */
  showShortcuts: () => void
  close: () => void
  /** A key that opens one of them closes it again. */
  toggle: (view: 'commands' | 'shortcuts') => void
  /** A command ran: it moves to the top of the recently used ones. */
  used: (id: string) => void
}

/** The command palette and the shortcut overview: which one is open, and the commands used last. */
export const usePalette = create<PaletteState>((set, get) => ({
  query: '',
  recent: loadRecent(),
  show: (query = '') => set({ view: 'commands', query }),
  showShortcuts: () => set({ view: 'shortcuts', query: '' }),
  close: () => set({ view: undefined }),
  toggle: (view) => {
    if (get().view === view) return get().close()
    if (view === 'commands') get().show()
    else get().showShortcuts()
  },
  used: (id) => {
    const recent = [id, ...get().recent.filter((x) => x !== id)].slice(0, MAX_RECENT)
    set({ recent })
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent))
    } catch {
      /* storage unavailable: remembered until reload */
    }
  }
}))
