import { formatBinding, shortcutLabel, type ShortcutId } from '@/lib/shortcuts'
import type { Direction } from './layout'

/** What a workspace shortcut does. */
export type WorkspaceAction =
  | { type: 'focus'; dir: Direction }
  | { type: 'split' }
  | { type: 'close' }
  | { type: 'maximize' }
  | { type: 'zen' }
  | { type: 'fullscreen' }
  | { type: 'workspace'; index: number }

export type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & {
  getModifierState?: (key: string) => boolean
}

const ARROWS: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

/** Mac keys (⌘) — in the desktop app by its platform, in a browser by the browser's. */
export function macKeys(): boolean {
  return window.mindeck ? window.mindeck.platform === 'darwin' : /mac/i.test(navigator.platform)
}

/**
 * The workspace's keys — ⌘ on macOS, Ctrl elsewhere:
 * ⌘⌥←/→/↑/↓ focus the next pane, ⌘\ splits, ⌘⇧W closes the pane, ⌘⇧↵
 * maximizes it, ⌘⌥Z toggles zen mode, ⌘⌥1…9 switch saved workspaces.
 * They avoid the browser's keys (shortcuts.ts) and the editor's; where one
 * overlaps a key of the module in focus, the module keeps it (see
 * `Workspace`). A web page with the keyboard hands them on (the main
 * process's `workspaceKey` in shortcuts.ts). Full screen (⌃⌘F, F11) is the main process's in the app
 * (shortcuts.ts) and the browser's own on the web — `fullscreen` here only
 * runs from the menu and the palette.
 */
export function matchWorkspaceKey(e: KeyLike, mac: boolean): WorkspaceAction | null {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  // AltGr (Ctrl+Alt on Windows) types characters — those keys are text, never shortcuts.
  if (!mod || e.getModifierState?.('AltGraph')) return null
  // On a Mac ⌥ changes `key` (⌥Z is Ω), so letters and digits go by their place; elsewhere by
  // the key itself, so a Ctrl+Alt combination that types a character never matches.
  const letter = (l: string) => (mac ? e.code === `Key${l.toUpperCase()}` : e.key.toLowerCase() === l)
  if (e.altKey && !e.shiftKey) {
    if (ARROWS[e.key]) return { type: 'focus', dir: ARROWS[e.key] }
    const digit = mac ? /^Digit([1-9])$/.exec(e.code)?.[1] : /^[1-9]$/.exec(e.key)?.[0]
    if (digit) return { type: 'workspace', index: Number(digit) - 1 }
    return letter('z') ? { type: 'zen' } : null
  }
  if (e.shiftKey && !e.altKey) {
    if (e.key === 'Enter') return { type: 'maximize' }
    return letter('w') ? { type: 'close' } : null
  }
  return !e.altKey && !e.shiftKey && e.key === '\\' ? { type: 'split' } : null
}

const IDS = {
  split: 'workspace.split',
  close: 'workspace.close',
  maximize: 'workspace.maximize',
  zen: 'workspace.zen',
  fullscreen: 'workspace.fullscreen'
} as const satisfies Record<Exclude<WorkspaceAction['type'], 'focus' | 'workspace'>, ShortcutId>

/** The key of an action, for tooltips and the palette (lib/shortcuts.ts lists them all). */
export function keyLabel(type: keyof typeof IDS, mac: boolean = macKeys()): string {
  return shortcutLabel(IDS[type], mac)!
}

/** The key that switches to saved workspace `index` (0-based; the first nine have one). */
export function workspaceKey(index: number, mac: boolean = macKeys()): string | undefined {
  if (index > 8) return undefined
  return formatBinding(`mod+alt+${index + 1}`, mac)
}

/**
 * ⌘W (Ctrl+W elsewhere): the module in focus closes what it has open — the
 * editor's tab, the browser's, the terminal's (macOS; Ctrl+W is the shell's),
 * a Files tab — and prevents the default; otherwise the workspace closes the pane.
 */
export function isCloseKey(e: KeyLike, mac: boolean): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'w'
}
