import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { X } from 'lucide-react'
import type { ModuleId } from '@/types'
import { cn } from '@/lib/cn'
import { ContextMenu, type MenuItem } from '@/features/files/components/ContextMenu'
import { useEditor } from '@/features/editor/store'
import { useTerminals, type TerminalTab } from '../store'
import { getT, useT } from '@/lib/i18n'
import { shortcutLabel } from '../keys'
import type { ProjectFile } from '../links'
import { useXterm } from '../useXterm'
import { TerminalFind } from './TerminalFind'

interface PaneProps {
  tab: TerminalTab
  /** Tab label (numbered when titles repeat). */
  label: string
  /** Has keyboard focus (outlined when framed). */
  active: boolean
  /** Several shells on the page: frame + slim header with title, folder and close. */
  framed: boolean
  /** Switch modules (a clicked file reference opens in the Editor). */
  onNavigate?: (module: ModuleId) => void
}

/**
 * One terminal tab's view (see useXterm) — a cell of the terminal grid. Stays
 * mounted when the layout changes (only the grid around it changes), so nothing
 * is lost. An exited shell restarts on Enter. Right-click: copy, paste, find,
 * the last command's output, clear, split.
 */
export function XtermPane({ tab, label, active, framed, onNavigate }: PaneProps) {
  const t = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const [finding, setFinding] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number }>()
  // Links resolve against the folder the shell is in now (it follows `cd`).
  const tabRef = useRef(tab)
  tabRef.current = tab

  const openFile = async (file: ProjectFile, line: number) => {
    await useEditor.getState().selectProject(file.projectId)
    onNavigate?.('editor')
    await useEditor.getState().openAt(file.path, line)
  }

  const { termRef, fitRef, api } = useXterm(hostRef, tab.id, tab.exitCode !== undefined, {
    onExit: (exitCode) => {
      useTerminals.getState().markExited(tab.id, exitCode)
      return `\r\n\x1b[90m[${getT().terminal.exited(exitCode)}]\x1b[0m\r\n`
    },
    onInputAfterExit: (data) => {
      if (data === '\r') void useTerminals.getState().restart(tab.id)
    },
    onFind: () => setFinding(true),
    onClose: () => void useTerminals.getState().close(tab.id),
    where: () => tabRef.current,
    onOpenFile: (file, line) => void openFile(file, line),
    restored: tab.restored,
    persist: true
  })

  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* not measurable yet */
      }
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs from useXterm: stable
  }, [active])

  const focus = () => {
    if (!active) useTerminals.getState().setActive(tab.id)
    termRef.current?.focus()
  }

  const openMenu = (e: MouseEvent) => {
    e.preventDefault()
    focus()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const items = (): MenuItem[] => {
    const lastOutput = tab.integration ? api.lastOutput() : undefined
    return [
      { label: `${t.terminal.copy} (${shortcutLabel('copy')})`, run: api.copy, disabled: !api.hasSelection() },
      { label: `${t.terminal.paste} (${shortcutLabel('paste')})`, run: () => void api.paste() },
      { label: t.terminal.selectAll, run: api.selectAll },
      'separator',
      { label: `${t.terminal.find} (${shortcutLabel('find')})`, run: () => setFinding(true) },
      ...(tab.integration
        ? ([
            { label: t.terminal.copyOutput, run: () => void navigator.clipboard?.writeText(lastOutput!), disabled: lastOutput === undefined },
            { label: `${t.terminal.prevCommand} (${shortcutLabel('prevCommand')})`, run: api.previousCommand },
            { label: `${t.terminal.nextCommand} (${shortcutLabel('nextCommand')})`, run: api.nextCommand }
          ] satisfies MenuItem[])
        : []),
      'separator',
      { label: `${t.terminal.clear} (${shortcutLabel('clear')})`, run: api.clear },
      { label: t.terminal.split, run: () => void useTerminals.getState().split(tab.id), disabled: tab.exitCode !== undefined }
    ]
  }

  // Padding lives on the wrapper: FitAddon measures the host's parent box, so
  // padding on the host itself would count as usable width and clip the text.
  return (
    <div data-terminal={tab.id} className={cn('min-h-0 min-w-0', framed && 'p-1')} onMouseDown={focus} onContextMenu={openMenu}>
      <div
        className={cn(
          'flex h-full flex-col overflow-hidden',
          framed && 'rounded-md border transition-colors',
          framed && (active ? 'border-cyan/50' : 'border-hud/50')
        )}
      >
        {framed && (
          <div className="flex h-7 shrink-0 items-center gap-2 border-b border-hud/50 px-2.5">
            <span
              className={cn('h-1.5 w-1.5 shrink-0 rounded-full', tab.exitCode === undefined ? 'bg-green' : 'bg-text-muted')}
            />
            <span className={cn('font-mono text-[11px]', active ? 'text-text-primary' : 'text-text-muted')}>{label}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-text-muted">
              {tab.cwdLabel !== tab.title && tab.cwdLabel}
            </span>
            <button
              type="button"
              aria-label={t.terminal.close(label)}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => void useTerminals.getState().close(tab.id)}
              className="rounded-sm p-0.5 text-text-muted transition-colors hover:bg-elevated hover:text-text-primary"
            >
              <X size={11} />
            </button>
          </div>
        )}
        <div className="relative min-h-0 flex-1 px-3 py-2">
          <div ref={hostRef} className="h-full w-full" />
          {finding && <TerminalFind api={api} onClose={() => setFinding(false)} />}
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} label={t.terminal.menu} items={items()} onClose={() => setMenu(undefined)} />}
    </div>
  )
}
