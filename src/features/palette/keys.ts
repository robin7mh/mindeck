import { useEffect } from 'react'
import { matchesBinding, shortcutBindings, type Binding } from '@/lib/shortcuts'
import { macKeys, type KeyLike } from '@/features/workspace/keys'
import { usePalette } from './store'

export type PaletteAction = 'palette' | 'shortcuts'

/** Anything one types into: "?" is a character there. */
const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm, .monaco-editor, .cm-editor'

/**
 * Where a binding of the palette's belongs to the element with the focus
 * (lib/shortcuts.ts declares it): ⌘K is the code editor's inline AI and the
 * terminal's (or the shell's) — ⇧⌘P opens the palette there; ⌘/ comments a
 * line in the code and note editors.
 */
const KEPT: Partial<Record<Binding, string>> = {
  'mod+k': '.monaco-editor, .xterm',
  'mod+/': '.monaco-editor, .cm-editor',
  '?': TYPING
}

/** The palette's keys (⌘K, ⇧⌘P, ⌘/, "?") — null when the key isn't one, or `target` keeps it. */
export function matchPaletteKey(e: KeyLike, mac: boolean, target: Element | null): PaletteAction | null {
  for (const action of ['palette', 'shortcuts'] as const) {
    const binding = shortcutBindings(action, mac).find((b) => matchesBinding(b, e, mac))
    if (!binding) continue
    const kept = KEPT[binding]
    return kept && target?.closest(kept) ? null : action
  }
  return null
}

/** The palette's keys, from anywhere in the window: open it (or close it again), open the shortcut overview. */
export function usePaletteKeys(): void {
  useEffect(() => {
    const mac = macKeys()
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat) return
      const action = matchPaletteKey(e, mac, e.target instanceof Element ? e.target : null)
      if (!action) return
      e.preventDefault()
      e.stopPropagation()
      usePalette.getState().toggle(action === 'palette' ? 'commands' : 'shortcuts')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
