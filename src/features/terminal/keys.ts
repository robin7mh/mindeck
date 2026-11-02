import { isMac } from '@/lib/platform'

/** What the Terminal does itself with a key instead of sending it to the shell. */
export type TerminalAction = 'find' | 'prevCommand' | 'nextCommand' | 'clear' | 'copy' | 'paste' | 'close'

type Keys = Pick<KeyboardEvent, 'type' | 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>

/**
 * The Terminal's own shortcuts. macOS: ⌘F find, ⌘↑/⌘↓ previous/next command,
 * ⌘K clear (like iTerm), ⌘W closes the tab; ⌘C/⌘V are the Edit menu's. Elsewhere Ctrl alone
 * belongs to the shell (Ctrl+C interrupts, Ctrl+F and Ctrl+K are readline
 * keys), so the same actions sit on Ctrl+Shift — copy and paste too
 * (Ctrl+Shift+C/V), and Ctrl+Insert / Shift+Insert as in every terminal there.
 * Ctrl+W stays the shell's (delete a word).
 */
export function terminalAction(e: Keys, mac = isMac): TerminalAction | undefined {
  if (e.type !== 'keydown' || e.altKey) return undefined
  if (!mac && e.key === 'Insert' && !e.metaKey && e.ctrlKey !== e.shiftKey) return e.ctrlKey ? 'copy' : 'paste'
  const mod = mac ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.metaKey
  if (!mod) return undefined
  const key = e.key.toLowerCase()
  if (key === 'f') return 'find'
  if (key === 'k') return 'clear'
  if (key === 'arrowup') return 'prevCommand'
  if (key === 'arrowdown') return 'nextCommand'
  if (mac && key === 'w') return 'close'
  if (!mac && key === 'c') return 'copy'
  if (!mac && key === 'v') return 'paste'
  return undefined
}

/** How the shortcut reads on this platform, for menus and tooltips. */
export function shortcutLabel(action: TerminalAction, mac = isMac): string {
  const key = { find: 'F', clear: 'K', prevCommand: '↑', nextCommand: '↓', copy: 'C', paste: 'V', close: 'W' }[action]
  return mac ? `⌘${key}` : `Ctrl+Shift+${key}`
}
