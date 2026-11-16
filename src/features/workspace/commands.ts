import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Columns2, Expand, LayoutGrid, Maximize2, Minimize2, Shrink, X } from 'lucide-react'
import type { Dict } from '@/lib/i18n/en'
import { formatBinding } from '@/lib/shortcuts'
import type { Command } from '@/features/palette/registry'
import { perform, toggleFullScreen, toggleZen } from './actions'
import { keyLabel, macKeys, workspaceKey } from './keys'
import { PRESETS, SLOTS, type Direction } from './layout'
import { useWorkspace } from './store'
import { PRESET_ICONS } from './components/WorkspaceMenu'

const ARROWS: Record<Direction, typeof ArrowLeft> = { left: ArrowLeft, right: ArrowRight, up: ArrowUp, down: ArrowDown }
const DIRECTIONS: Direction[] = ['left', 'right', 'up', 'down']

/** The workspace in the command palette: layouts, saved workspaces, the panes, zen mode and full screen. */
export function workspaceCommands(t: Dict): Command[] {
  const w = t.workspace
  const k = t.commands.keywords
  const group = w.title
  const s = useWorkspace.getState()
  const { layout, zen } = s
  const many = layout.panes.length > 1
  return [
    ...(layout.panes.length < SLOTS.grid ? [{ id: 'workspace.split', label: w.split, group, icon: Columns2, keys: keyLabel('split'), keywords: k.split, run: () => perform({ type: 'split' }) }] : []),
    ...(many
      ? [
          { id: 'workspace.close', label: w.closePane, group, icon: X, keys: keyLabel('close'), keywords: k.close, run: () => perform({ type: 'close' }) },
          {
            id: 'workspace.maximize',
            label: layout.maximized ? w.restore : w.maximize,
            group,
            icon: layout.maximized ? Minimize2 : Maximize2,
            keys: keyLabel('maximize'),
            run: () => perform({ type: 'maximize' })
          },
          ...DIRECTIONS.map((dir) => ({
            id: `workspace.focus.${dir}`,
            label: t.commands.focusPane[dir],
            group,
            icon: ARROWS[dir],
            keys: formatBinding(`mod+alt+${dir}`, macKeys()),
            run: () => perform({ type: 'focus', dir })
          }))
        ]
      : []),
    ...PRESETS.map((p) => ({ id: `layout.${p}`, label: `${w.layout}: ${w.presets[p]}`, group, icon: PRESET_ICONS[p], keywords: k.layout, run: () => useWorkspace.getState().setPreset(p) })),
    ...s.saved.map((x, i) => ({ id: `workspace.${x.id}`, label: w.open(x.name), group, icon: LayoutGrid, keys: workspaceKey(i), keywords: k.workspace, run: () => useWorkspace.getState().apply(x.id) })),
    { id: 'workspace.zen', label: zen ? w.exitZen : w.zen, group, icon: Shrink, keys: keyLabel('zen'), keywords: k.zen, run: toggleZen },
    { id: 'workspace.fullscreen', label: w.fullScreen, group, icon: Expand, keys: keyLabel('fullscreen'), run: toggleFullScreen }
  ]
}
