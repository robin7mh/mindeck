import { Search } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { shortcutBindings, formatBinding } from '@/lib/shortcuts'
import { macKeys } from '@/features/workspace/keys'
import { usePalette } from '../store'

/** The palette in the top bar: a search field that opens what ⌘K opens — and shows the key, to learn it. */
export function PaletteButton() {
  const c = useT().commands
  const mac = macKeys()
  const key = formatBinding(shortcutBindings('palette', mac)[0], mac)
  return (
    <button
      type="button"
      aria-label={c.open}
      title={`${c.open} (${key})`}
      onClick={() => usePalette.getState().show()}
      className="no-drag flex h-9 w-full min-w-0 items-center gap-2.5 rounded-md border border-hud/45 bg-panel px-3 text-text-muted transition-colors hover:border-hud-strong/70 hover:text-text-secondary"
    >
      <Search size={15} strokeWidth={1.75} className="shrink-0" />
      <span className="hidden flex-1 truncate text-left font-sans text-[13px] sm:inline">{c.search}</span>
      <kbd className="hidden rounded-sm border border-hud/45 bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-text-secondary sm:inline">{key}</kbd>
    </button>
  )
}
