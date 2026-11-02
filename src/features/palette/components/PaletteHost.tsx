import { useEffect } from 'react'
import { usePaletteKeys } from '../keys'
import { trackRecentFiles } from '../recentFiles'
import { registerBuiltinCommands } from '../sources'
import { usePalette } from '../store'
import { CommandPalette } from './CommandPalette'
import { ShortcutsDialog } from './ShortcutsDialog'

/** The command palette and the shortcut overview over the app, with their keys and the commands they offer of themselves. */
export function PaletteHost() {
  const view = usePalette((s) => s.view)
  useEffect(() => registerBuiltinCommands(), [])
  useEffect(() => trackRecentFiles(), [])
  usePaletteKeys()
  if (view === 'commands') return <CommandPalette />
  if (view === 'shortcuts') return <ShortcutsDialog />
  return null
}
