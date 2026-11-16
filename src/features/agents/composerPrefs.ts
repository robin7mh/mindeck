import { create } from 'zustand'
import type { ComposerRef } from '@shared/types/composer'

// The composer's memory on this device: how a message is sent, the prompts
// sent before (↑/↓), and an unsent draft per session. Browser storage can be
// missing or full (private windows, quotas) — then each simply starts empty.

/** enter: Enter sends, Shift+Enter breaks the line · mod-enter: ⌘/Ctrl+Enter sends, Enter breaks the line. */
export type SendKey = 'enter' | 'mod-enter'

const SEND_KEY = 'mindeck.agents.sendKey'
const HISTORY_KEY = 'mindeck.agents.history'
const DRAFT_PREFIX = 'mindeck.agents.draft.'
const HISTORY_MAX = 50

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === undefined) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable or full: nothing to keep */
  }
}

interface ComposerPrefs {
  sendKey: SendKey
  setSendKey: (key: SendKey) => void
}

export const useComposerPrefs = create<ComposerPrefs>((set) => ({
  sendKey: read<SendKey>(SEND_KEY, 'enter') === 'mod-enter' ? 'mod-enter' : 'enter',
  setSendKey: (sendKey) => {
    write(SEND_KEY, sendKey)
    set({ sendKey })
  }
}))

/** Prompts sent before, newest first. */
export function promptHistory(): string[] {
  const list = read<unknown>(HISTORY_KEY, [])
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
}

export function rememberPrompt(text: string): void {
  if (!text.trim()) return
  write(HISTORY_KEY, [text, ...promptHistory().filter((x) => x !== text)].slice(0, HISTORY_MAX))
}

export interface Draft {
  text: string
  refs: ComposerRef[]
}

export function loadDraft(key: string): Draft {
  const d = read<Partial<Draft> | null>(DRAFT_PREFIX + key, null)
  return { text: typeof d?.text === 'string' ? d.text : '', refs: Array.isArray(d?.refs) ? d.refs : [] }
}

/** Keeps what is typed but not sent (an empty draft is dropped). */
export function saveDraft(key: string, draft: Draft): void {
  write(DRAFT_PREFIX + key, draft.text || draft.refs.length ? draft : undefined)
}
