import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Columns2, Expand, Grid2x2, LayoutGrid, LayoutPanelLeft, Pencil, Rows2, Save, Shrink, Square, Trash2, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useOverlay } from '@/lib/overlay'
import { TechLabel } from '@/components/ui/TechLabel'
import { toggleFullScreen, toggleZen } from '../actions'
import { keyLabel, workspaceKey } from '../keys'
import { PRESETS, type Preset } from '../layout'
import { MAX_NAME, useWorkspace, type SavedWorkspace } from '../store'

export const PRESET_ICONS: Record<Preset, LucideIcon> = { single: Square, columns: Columns2, rows: Rows2, main: LayoutPanelLeft, grid: Grid2x2 }

const icon = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-elevated hover:text-text-primary'
const field =
  'min-w-0 flex-1 rounded-md border border-hud/60 bg-surface/60 px-2 py-1 font-sans text-[12.5px] text-text-primary outline-hidden placeholder:text-text-muted focus:border-cyan/50'

/** A saved workspace: switch to it, save the layout on screen into it, rename, delete. */
function SavedRow({ w, index, current, onApply }: { w: SavedWorkspace; index: number; current: boolean; onApply: () => void }) {
  const t = useT().workspace
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(w.name)
  const s = useWorkspace.getState
  const keys = workspaceKey(index)

  if (editing) {
    const commit = (e: FormEvent) => {
      e.preventDefault()
      s().rename(w.id, name)
      setEditing(false)
    }
    return (
      <form onSubmit={commit} className="flex items-center gap-1 px-1 py-0.5">
        <input
          autoFocus
          aria-label={t.rename(w.name)}
          value={name}
          maxLength={MAX_NAME}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.stopPropagation()
            setName(w.name)
            setEditing(false)
          }}
          className={field}
        />
        <button type="submit" aria-label={t.save} className={icon}>
          <Save size={13} />
        </button>
      </form>
    )
  }
  return (
    <div className={cn('group flex items-center gap-0.5 rounded-sm px-1', current && 'bg-cyan/6')}>
      <button
        type="button"
        onClick={onApply}
        aria-label={t.open(w.name)}
        className={cn('flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1.5 py-1.5 text-left transition-colors hover:text-text-primary', current ? 'text-cyan' : 'text-text-secondary')}
      >
        <span className="flex-1 truncate font-sans text-[12.5px]">{w.name}</span>
        {keys && <span className="font-mono text-[10px] text-text-muted">{keys}</span>}
      </button>
      <button type="button" aria-label={t.update(w.name)} title={t.update(w.name)} onClick={() => s().update(w.id)} className={icon}>
        <Save size={13} />
      </button>
      <button
        type="button"
        aria-label={t.rename(w.name)}
        title={t.rename(w.name)}
        onClick={() => {
          setName(w.name)
          setEditing(true)
        }}
        className={icon}
      >
        <Pencil size={13} />
      </button>
      <button type="button" aria-label={t.remove(w.name)} title={t.remove(w.name)} onClick={() => s().remove(w.id)} className={cn(icon, 'hover:text-danger')}>
        <Trash2 size={13} />
      </button>
    </div>
  )
}

/**
 * The workspace menu in the top bar: the layout (one to four panes), the
 * saved workspaces (switch with ⌘⌥1…9), zen mode and full screen.
 */
export function WorkspaceMenu() {
  const t = useT().workspace
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const preset = useWorkspace((s) => s.layout.preset)
  const saved = useWorkspace((s) => s.saved)
  const current = useWorkspace((s) => s.saved.find((w) => w.id === s.current))
  const zen = useWorkspace((s) => s.zen)
  useOverlay(open)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !ref.current!.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const save = (e: FormEvent) => {
    e.preventDefault()
    useWorkspace.getState().save(name)
    setName('')
  }
  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }

  return (
    <div ref={ref} className="no-drag relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t.menu}
        title={t.menu}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-md border px-2 transition-colors',
          open ? 'border-cyan/50 text-cyan' : 'border-hud/60 text-text-secondary hover:border-hud-strong/70 hover:text-text-primary'
        )}
      >
        <LayoutGrid size={14} />
        {current && <span className="hidden max-w-[120px] truncate font-sans text-[12px] lg:inline">{current.name}</span>}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t.menu}
          className="absolute right-0 top-full z-50 mt-1.5 w-80 space-y-3 rounded-lg border border-hud/70 bg-panel/95 p-3 shadow-xl shadow-black/40 backdrop-blur-md"
        >
          <section>
            <TechLabel className="text-text-muted">{t.layout}</TechLabel>
            <div className="mt-1.5 grid grid-cols-5 gap-1">
              {PRESETS.map((p) => {
                const Icon = PRESET_ICONS[p]
                return (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={p === preset}
                    aria-label={t.presets[p]}
                    title={t.presets[p]}
                    onClick={() => useWorkspace.getState().setPreset(p)}
                    className={cn(
                      'flex h-9 items-center justify-center rounded-md border transition-colors',
                      p === preset ? 'border-cyan/50 bg-cyan/8 text-cyan' : 'border-hud/50 text-text-muted hover:border-hud-strong/70 hover:text-text-primary'
                    )}
                  >
                    <Icon size={16} />
                  </button>
                )
              })}
            </div>
          </section>

          <section>
            <TechLabel className="text-text-muted">{t.saved}</TechLabel>
            <div className="mt-1 space-y-0.5">
              {saved.length === 0 && <p className="px-1.5 py-1 font-sans text-[12px] text-text-muted">{t.noneSaved}</p>}
              {saved.map((w, i) => (
                <SavedRow key={w.id} w={w} index={i} current={w.id === current?.id} onApply={run(() => useWorkspace.getState().apply(w.id))} />
              ))}
            </div>
            <form onSubmit={save} className="mt-2 flex items-center gap-1.5">
              <input aria-label={t.name} placeholder={t.namePlaceholder} value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} className={field} />
              <button
                type="submit"
                disabled={!name.trim()}
                className="shrink-0 rounded-md border border-cyan/40 px-2.5 py-1 font-sans text-[12px] text-cyan transition-colors hover:bg-cyan/8 disabled:pointer-events-none disabled:opacity-40"
              >
                {t.saveAs}
              </button>
            </form>
          </section>

          <section className="flex gap-1.5 border-t border-hud/50 pt-3">
            <button
              type="button"
              aria-pressed={zen}
              onClick={run(toggleZen)}
              className="flex flex-1 items-center justify-between gap-2 rounded-md border border-hud/50 px-2 py-1.5 font-sans text-[12px] text-text-secondary transition-colors hover:border-hud-strong/70 hover:text-text-primary"
            >
              <span className="flex items-center gap-1.5">
                <Shrink size={13} /> {t.zen}
              </span>
              <span className="font-mono text-[10px] text-text-muted">{keyLabel('zen')}</span>
            </button>
            <button
              type="button"
              onClick={run(toggleFullScreen)}
              className="flex flex-1 items-center justify-between gap-2 rounded-md border border-hud/50 px-2 py-1.5 font-sans text-[12px] text-text-secondary transition-colors hover:border-hud-strong/70 hover:text-text-primary"
            >
              <span className="flex items-center gap-1.5">
                <Expand size={13} /> {t.fullScreen}
              </span>
              <span className="font-mono text-[10px] text-text-muted">{keyLabel('fullscreen')}</span>
            </button>
          </section>
        </div>
      )}
    </div>
  )
}
