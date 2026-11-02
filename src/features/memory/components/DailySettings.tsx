import { useEffect, useRef, useState } from 'react'
import { CalendarCog } from 'lucide-react'
import { TEMPLATES_FOLDER, type DailyNotesSettings, type NoteMeta } from '@shared/types/memory'
import { Select } from '@/components/ui/Select'
import { TechLabel } from '@/components/ui/TechLabel'
import { useT } from '@/lib/i18n'

/** Where daily notes go and which template starts them — Obsidian's "Daily notes" options. */
export function DailySettings({
  daily,
  folders,
  templates,
  onChange
}: {
  daily: DailyNotesSettings
  folders: string[]
  templates: NoteMeta[]
  onChange: (daily: DailyNotesSettings) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      // The Select's menu is portaled to <body>: clicks in it are inside too.
      const target = e.target as HTMLElement
      if (!ref.current?.contains(target) && !target.closest('[role="listbox"]')) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // The configured folder is always offered, even before it exists.
  const folderOptions = [...new Set(['', daily.folder, ...folders])].map((f) => ({ value: f, label: f || t.memory.vaultRoot }))
  const templateOptions = [{ value: '', label: t.memory.noTemplate }, ...templates.map((n) => ({ value: n.path, label: n.title }))]

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={t.memory.dailyNotes}
        aria-label={t.memory.dailyNotes}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated/60 hover:text-cyan"
      >
        <CalendarCog size={14} />
      </button>
      {open && (
        <div role="dialog" aria-label={t.memory.dailyNotes} className="absolute left-0 top-full z-30 mt-1 w-64 space-y-2.5 rounded-md border border-hud/60 bg-panel p-3 shadow-lg">
          <TechLabel className="block text-text-secondary">{t.memory.dailyNotes}</TechLabel>
          <div className="space-y-1">
            <span className="block font-sans text-[11px] text-text-muted">{t.memory.dailyFolder}</span>
            <Select label={t.memory.dailyFolder} value={daily.folder} options={folderOptions} onChange={(folder) => onChange({ ...daily, folder })} />
          </div>
          <div className="space-y-1">
            <span className="block font-sans text-[11px] text-text-muted">{t.memory.dailyTemplate}</span>
            <Select label={t.memory.dailyTemplate} value={daily.template} options={templateOptions} onChange={(template) => onChange({ ...daily, template })} />
          </div>
          <p className="font-sans text-[11px] leading-snug text-text-muted">{t.memory.templatesHint(TEMPLATES_FOLDER)}</p>
        </div>
      )}
    </div>
  )
}
