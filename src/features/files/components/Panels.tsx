import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Square, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { baseName } from '../kinds'
import { useFiles } from '../store'

/** The Files module's tabs (shown once there is more than one): each its own folder and history. */
export function Tabs() {
  const t = useT()
  const tabs = useFiles((s) => s.tabs)
  const active = useFiles((s) => s.activeTab)
  const home = useFiles((s) => s.places?.home)
  if (tabs.length < 2) return null
  return (
    <div role="tablist" aria-label={t.files.tabs} className="flex shrink-0 items-center gap-1 border-b border-hud/50 bg-surface/20 px-2 pt-1">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={tab.id === active}
          title={tab.path}
          onClick={() => void useFiles.getState().switchTab(tab.id)}
          className={cn(
            'group flex min-w-0 max-w-[200px] flex-1 cursor-default items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 py-1 font-sans text-[12px]',
            tab.id === active ? 'border-hud/60 bg-panel text-text-primary' : 'border-transparent text-text-muted hover:bg-elevated/40 hover:text-text-secondary'
          )}
        >
          <span className="min-w-0 flex-1 truncate">{tab.path === home ? '~' : baseName(tab.path)}</span>
          <button
            type="button"
            aria-label={t.files.closeTab}
            onClick={(e) => {
              e.stopPropagation()
              void useFiles.getState().closeTab(tab.id)
            }}
            className="rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-elevated hover:text-text-primary group-hover:opacity-100"
          >
            <X size={11} />
          </button>
        </div>
      ))}
      <button type="button" aria-label={t.files.newTab} title={`${t.files.newTab} (⌘T)`} onClick={() => void useFiles.getState().newTab()} className="rounded-sm p-1 text-text-muted hover:bg-elevated hover:text-text-primary">
        <Plus size={13} />
      </button>
    </div>
  )
}

/** Running copies and archives in the status line: how far, and Stop. */
export function Jobs() {
  const t = useT()
  const jobs = Object.values(useFiles((s) => s.jobs))
  return (
    <>
      {jobs.map((job) => {
        const share = job.total ? Math.min(1, job.done / job.total) : 0
        return (
          <span key={job.id} className="flex items-center gap-1.5 text-cyan" title={job.file}>
            {t.files.jobs[job.kind]}
            <span role="progressbar" aria-label={t.files.jobs[job.kind]} aria-valuenow={Math.round(share * 100)} className="h-1 w-20 overflow-hidden rounded-full bg-elevated">
              <span className="block h-full rounded-full bg-cyan transition-[width]" style={{ width: `${share * 100}%` }} />
            </span>
            <button type="button" aria-label={t.files.stop} title={t.files.stop} onClick={() => void useFiles.getState().cancelJob(job.id)} className="text-text-muted hover:text-danger">
              <Square size={9} />
            </button>
          </span>
        )
      })}
    </>
  )
}

/**
 * Names that are taken where things go — asked one at a time like Finder:
 * keep both (the new one gets a number), skip, or replace (the old one goes
 * to the trash); "apply to all" answers the rest. Escape stops it all.
 */
export function ConflictDialog() {
  const t = useT()
  const q = useFiles((s) => s.conflict)
  const [at, setAt] = useState(0)
  const [all, setAll] = useState(false)
  const [choices, setChoices] = useState<Record<string, 'replace' | 'keep' | 'skip'>>({})

  useEffect(() => {
    setAt(0)
    setAll(false)
    setChoices({})
    if (!q) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && q.answer(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [q])

  if (!q) return null
  const left = q.names.length - at
  const decide = (choice: 'replace' | 'keep' | 'skip') => {
    const names = all ? q.names.slice(at) : [q.names[at]]
    const next = { ...choices, ...Object.fromEntries(names.map((n) => [n, choice])) }
    if (at + names.length >= q.names.length) q.answer(next)
    else {
      setChoices(next)
      setAt(at + names.length)
    }
  }
  const button = 'rounded-md border px-3 py-1.5 font-sans text-[12.5px] font-medium transition-colors'

  return createPortal(
    <div className="fixed inset-0 z-90 flex items-center justify-center bg-void/60 backdrop-blur-xs">
      <div role="alertdialog" aria-label={t.files.conflictTitle(q.names[at], baseName(q.dest))} className="w-[420px] rounded-lg border border-hud/70 bg-panel p-4 shadow-xl">
        <p className="font-sans text-[14px] font-semibold text-text-primary">{t.files.conflictTitle(q.names[at], baseName(q.dest))}</p>
        <p className="mt-1.5 font-sans text-[12.5px] text-text-secondary">{t.files.conflictHint}</p>
        {left > 1 && (
          <label className="mt-3 flex items-center gap-2 font-sans text-[12.5px] text-text-secondary">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="accent-cyan" />
            {t.files.applyToAll(left)}
          </label>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => q.answer(null)} className={cn(button, 'border-hud/60 text-text-muted hover:text-text-primary')}>
            {t.files.stop}
          </button>
          <button type="button" onClick={() => decide('skip')} className={cn(button, 'border-hud/60 text-text-secondary hover:text-text-primary')}>
            {t.files.skip}
          </button>
          <button type="button" onClick={() => decide('replace')} className={cn(button, 'border-danger/50 text-danger hover:bg-danger/10')}>
            {t.files.replace}
          </button>
          <button type="button" autoFocus onClick={() => decide('keep')} className={cn(button, 'border-cyan/50 bg-cyan/10 text-cyan hover:bg-cyan/20')}>
            {t.files.keepBoth}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
