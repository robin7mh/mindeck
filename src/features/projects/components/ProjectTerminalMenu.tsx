import { useEffect, useRef, useState } from 'react'
import { Plus, TerminalSquare } from 'lucide-react'
import { ipc } from '@shared/ipc/client'
import type { TerminalInfo } from '@shared/types/terminal'
import { TechLabel } from '@/components/ui/TechLabel'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { tabLabels, useTerminals } from '@/features/terminal/store'
import { ActionButton } from './ActionButton'

interface Shell {
  id: string
  label: string
  /** What runs in it (e.g. `node`); absent when it waits at its prompt. */
  running?: string
}

/**
 * "Terminal" for a project, in Mindeck's own terminal. Without a shell there yet,
 * a click opens one. Otherwise a menu: this project's shells — free, or what
 * runs in them — and "New terminal", so unused shells don't pile up.
 */
export function ProjectTerminalMenu({ projectId, onShow }: { projectId: string; onShow: () => void }) {
  const t = useT()
  const [shells, setShells] = useState<Shell[] | null>(null) // null: closed
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!shells) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current!.contains(e.target as Node)) setShells(null)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setShells(null)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [shells])

  const openNew = () => {
    setShells(null)
    void useTerminals.getState().openProject(projectId)
    onShow()
  }

  const show = (id: string) => {
    setShells(null)
    useTerminals.getState().setActive(id)
    onShow()
  }

  const toggle = async () => {
    if (shells) return setShells(null)
    // The Terminal module may not have been opened yet: pick up running shells first.
    await useTerminals.getState().init()
    const live = await ipc('terminal:list').catch(() => [] as TerminalInfo[])
    const { tabs } = useTerminals.getState()
    const labels = tabLabels(tabs)
    const mine = tabs.filter((tab) => tab.projectId === projectId && tab.exitCode === undefined)
    if (mine.length === 0) return openNew()
    setShells(mine.map((tab) => ({ id: tab.id, label: labels.get(tab.id)!, running: live.find((l) => l.id === tab.id)?.running })))
  }

  const item =
    'flex w-full items-center gap-2 px-3 py-1.5 text-left font-sans text-[12.5px] text-text-secondary transition-colors hover:bg-elevated/60 hover:text-text-primary'

  return (
    <div ref={ref} className="relative">
      <ActionButton icon={TerminalSquare} label={t.projects.terminal} title={t.projects.terminalHint} expanded={!!shells} onClick={() => void toggle()} />
      {shells && (
        <div className="absolute bottom-full left-0 z-30 mb-1.5 w-64 rounded-md border border-hud/60 bg-panel py-1 shadow-lg">
          <TechLabel className="block px-3 pb-1 pt-1.5 text-text-muted">{t.projects.shellsHere}</TechLabel>
          {shells.map((sh) => (
            <button key={sh.id} type="button" onClick={() => show(sh.id)} className={item}>
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', sh.running ? 'bg-amber' : 'bg-green')} />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{sh.label}</span>
              <span className={cn('shrink-0 font-mono text-[10.5px]', sh.running ? 'text-amber' : 'text-text-muted')}>{sh.running ?? t.projects.shellFree}</span>
            </button>
          ))}
          <div className="my-1 border-t border-hud/50" />
          <button type="button" onClick={openNew} className={item}>
            <Plus size={13} className="text-text-muted" />
            {t.terminal.new}
          </button>
        </div>
      )}
    </div>
  )
}
