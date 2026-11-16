import { create } from 'zustand'
import { errorMessage, ipc } from '@shared/ipc/client'
import { DEFAULT_TERMINAL_SETTINGS, type TerminalSettings, type TerminalShell } from '@shared/types/terminal'

interface TerminalPrefsState {
  settings: TerminalSettings
  /** The shells installed on the machine the core runs on. */
  shells: TerminalShell[]
  loaded: boolean
  error?: string
  /** Read settings and shells once (`force`: again). Defaults until then, or when the core can't say. */
  load: (force?: boolean) => Promise<void>
  configure: (patch: Partial<TerminalSettings>) => Promise<void>
}

/** The Terminal's preferences — read by every view (font, cursor, GPU …) and Settings → Terminal. */
export const useTerminalSettings = create<TerminalPrefsState>((set, get) => ({
  settings: DEFAULT_TERMINAL_SETTINGS,
  shells: [],
  loaded: false,

  load: async (force = false) => {
    if (get().loaded && !force) return
    set({ loaded: true })
    const [settings, shells] = await Promise.all([ipc('terminal:settings').catch(() => get().settings), ipc('terminal:shells').catch(() => [])])
    set({ settings, shells })
  },

  configure: async (patch) => {
    try {
      set({ settings: await ipc('terminal:configure', patch), error: undefined })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  }
}))
