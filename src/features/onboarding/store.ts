import { create } from 'zustand'
import { ipc } from '@shared/ipc/client'

/** The setup's steps, in order. `browserImport` shows only when its slot is filled (see slots.ts). */
export type StepId = 'welcome' | 'agents' | 'project' | 'import' | 'browserImport' | 'done'
export const STEPS: StepId[] = ['welcome', 'agents', 'project', 'import', 'browserImport', 'done']

const KEY = 'mindeck.onboarding'

interface Saved {
  /** Finished or skipped once: it doesn't open by itself again. */
  done: boolean
  /** Where an unfinished setup continues. */
  step: StepId
  /** This device has decided before (a setup started, finished or skipped) — else firstStart() decides. */
  known: boolean
}

/** What this device remembers (nothing yet: a fresh setup). */
export function loadOnboarding(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Saved> | null
    return { done: saved?.done === true, step: STEPS.includes(saved?.step as StepId) ? (saved!.step as StepId) : 'welcome', known: !!saved }
  } catch {
    return { done: false, step: 'welcome', known: false }
  }
}

function save(saved: Omit<Saved, 'known'>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved))
  } catch {
    /* storage unavailable — the setup shows again next time */
  }
}

interface OnboardingState extends Saved {
  /** Shown now. */
  open: boolean
  /** Go to a step (remembered, so a restart of the app continues there). */
  go: (step: StepId) => void
  /** Finished or skipped: closes, and stays closed on the next start. */
  finish: () => void
  /** From Settings: from the first step again. */
  restart: () => void
  /**
   * Nothing remembered yet: open only on a real first start — no projects,
   * agent sessions or assistant chats on this core. Someone who used Mindeck
   * before this setup existed gets it marked done, silently.
   */
  firstStart: () => Promise<void>
}

/**
 * The first-start setup — remembered per device, like the language and the
 * appearance it starts with. Opens by itself until it was finished or skipped.
 */
export const useOnboarding = create<OnboardingState>((set, get) => {
  const saved = loadOnboarding()
  return {
    ...saved,
    open: !saved.done && saved.known,
    go: (step) => {
      save({ done: get().done, step })
      set({ step, known: true })
    },
    finish: () => {
      save({ done: true, step: 'welcome' })
      set({ done: true, step: 'welcome', open: false, known: true })
    },
    restart: () => {
      save({ done: get().done, step: 'welcome' })
      set({ step: 'welcome', open: true, known: true })
    },
    firstStart: async () => {
      if (get().known) return
      // An answer that fails, or isn't a list, counts as nothing there.
      const count = (list: Promise<unknown[]>) => list.then((l) => (Array.isArray(l) ? l.length : 0), () => 0)
      const used = (await Promise.all([count(ipc('projects:list')), count(ipc('agents:list')), count(ipc('ai:conversations'))])).some((n) => n > 0)
      if (get().known) return // decided meanwhile (Settings → Setup)
      if (used) return get().finish()
      save({ done: false, step: 'welcome' })
      set({ known: true, open: true })
    }
  }
})
