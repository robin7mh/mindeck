import { Search } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { shortcutBindings, formatBinding } from '@/lib/shortcuts'
import { macKeys } from '@/features/workspace/keys'
import { usePalette } from '../store'

/** The palette in the top bar: what ⌘K opens, for the mouse — and the key, to learn it. */
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
      className="no-drag flex h-7 items-center gap-2 rounded-md border border-hud/60 px-2 text-text-muted transition-colors hover:border-cyan/50 hover:text-text-primary"
    >
      <Search size={13} />
      <span className="hidden font-sans text-[12px] lg:inline">{c.search}</span>
      <kbd className="hidden rounded-sm border border-hud/70 bg-surface/70 px-1 font-mono text-[10px] text-text-secondary sm:inline">{key}</kbd>
    </button>
  )
}
