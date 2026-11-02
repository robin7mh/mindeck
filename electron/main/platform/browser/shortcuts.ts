import type { WorkspaceKey } from '@shared/types/browser'
import type { ShortcutAction } from '../../services/browser/types'

/** The fields of Electron's `before-input-event` input that decide a shortcut. */
export interface KeyInput {
  type: string
  key: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
  /** The physical key (`KeyZ`, `Digit1`) — a Mac's ⌥ changes `key`, not this. */
  code?: string
}

/**
 * The browser's keys, as in Chrome — ⌘ on macOS, Ctrl elsewhere. Matched in
 * the main process before a page or the Mindeck UI sees the key, so they work
 * whichever has the focus (and never reach the default menu, whose ⌘R would
 * reload Mindeck itself).
 */
export function matchShortcut(input: KeyInput, mac: boolean): ShortcutAction | null {
  if (input.type !== 'keyDown') return null
  const mod = mac ? input.meta && !input.control : input.control && !input.meta
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key
  if (input.key === 'F5') return input.shift || mod ? 'hardReload' : 'reload'
  // Ctrl+Tab cycles tabs on every platform.
  if (input.control && key === 'Tab') return input.shift ? 'prevTab' : 'nextTab'
  if (!mac && input.alt && !input.control && !input.meta) {
    if (key === 'ArrowLeft') return 'back'
    if (key === 'ArrowRight') return 'forward'
  }
  if (!mod) return null
  if (input.alt) {
    // ⌘⌥←/→ (Ctrl+Alt+←/→) move the focus between the workspace's panes — the tabs have Ctrl+Tab and ⌘⇧[ / ].
    if (mac && (key === 'i' || input.key === 'ˆ')) return 'devtools'
    // ⌥ turns letters into symbols on a Mac keyboard: ⌘⌥B arrives as "∫".
    if (mac && (key === 'b' || input.key === '∫')) return 'bookmarkManager'
    return null
  }
  if (input.shift) {
    if (key === 't') return 'reopenTab'
    if (key === 'n') return 'newPrivateTab'
    if (key === 'r') return 'hardReload'
    if (key === 'a') return 'tabSearch'
    // Mindeck's command palette — also while a page has the keyboard (⌘K stays the page's own).
    if (key === 'p') return 'palette'
    if (key === 'b') return 'bookmarksBar'
    if (key === 'g') return 'newGroup'
    if (key === 'd') return 'split'
    // Edge's key for vertical tabs: ⌘⇧, — whatever ⇧ makes of the comma key on this layout.
    if (input.code === 'Comma' || key === ',' || key === '<') return 'verticalTabs'
    if (!mac && key === 'o') return 'bookmarkManager'
    if (!mac && key === 'i') return 'devtools'
    if (key === '+' || key === '=') return 'zoomIn'
    if (key === ']' || key === '}') return 'nextTab'
    if (key === '[' || key === '{') return 'prevTab'
    return null
  }
  const plain: Record<string, ShortcutAction> = {
    t: 'newTab',
    w: 'closeTab',
    l: 'focusOmnibox',
    r: 'reload',
    f: 'find',
    p: 'print',
    '[': 'back',
    ']': 'forward',
    '=': 'zoomIn',
    '+': 'zoomIn',
    '-': 'zoomOut',
    '0': 'zoomReset',
    '9': 'lastTab',
    d: 'bookmark',
    // Chrome: ⌘Y on a Mac, Ctrl+H elsewhere.
    [mac ? 'y' : 'h']: 'history'
  }
  if (plain[key]) return plain[key]
  if (/^[1-8]$/.test(key)) return `tab${key}` as ShortcutAction
  return null
}

/**
 * Full screen: ⌃⌘F on macOS, F11 elsewhere. Taken in the main process (from
 * the Mindeck UI and from pages), so it toggles exactly once — never once by
 * the page and again by the menu.
 */
export function isFullScreenKey(input: KeyInput, mac: boolean): boolean {
  if (input.type !== 'keyDown' || input.alt || input.shift) return false
  return mac ? input.control && input.meta && input.key.toLowerCase() === 'f' : !input.control && !input.meta && input.key === 'F11'
}

const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])

/**
 * The workspace's keys (src/features/workspace/keys.ts: ⌘⌥ arrows and digits,
 * ⌘⌥Z, ⌘⇧W, ⌘⇧↵, ⌘\ — Ctrl instead of ⌘ elsewhere). A page that has the
 * keyboard would swallow them; its view hands them to the Mindeck UI instead
 * (null: not one of them).
 */
export function workspaceKey(input: KeyInput, mac: boolean): WorkspaceKey | null {
  if (input.type !== 'keyDown') return null
  const mod = mac ? input.meta && !input.control : input.control && !input.meta
  if (!mod) return null
  // As in the UI: on a Mac letters and digits go by their place (⌥ changes the key), elsewhere by the key.
  const letter = (l: string) => (mac ? input.code === `Key${l.toUpperCase()}` : input.key.toLowerCase() === l)
  const digit = mac ? /^Digit[1-9]$/.test(input.code ?? '') : /^[1-9]$/.test(input.key)
  const hit =
    input.alt && !input.shift
      ? ARROWS.has(input.key) || digit || letter('z')
      : input.shift && !input.alt
        ? input.key === 'Enter' || letter('w')
        : !input.alt && !input.shift && input.key === '\\'
  if (!hit) return null
  return { key: input.key, code: input.code ?? '', metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift }
}
