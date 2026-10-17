import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, Folder, Home, Loader2, X } from 'lucide-react'
import { errorMessage, ipc } from '@shared/ipc/client'
import type { DirListing } from '@shared/types/server'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/cn'
import { TechLabel } from './TechLabel'

/**
 * Folder chooser for the web/mobile UI — browses folders on the machine the
 * Mindeck core runs on (fs:dirs), standing in for the desktop's native dialog.
 * A paired device sees the shared folders only; the core lists them as `roots`.
 */
export function FolderPicker({
  title,
  confirmLabel,
  onPick,
  onClose
}: {
  title: string
  confirmLabel?: string
  onPick: (path: string) => void
  onClose: () => void
}) {
  const t = useT()
  const [listing, setListing] = useState<DirListing>()
  const [typed, setTyped] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  // Only the latest request may update the view (a slow earlier one must not win).
  const latest = useRef(0)

  const open = async (path?: string) => {
    const seq = ++latest.current
    const typedBefore = typed
    setLoading(true)
    setError(undefined)
    try {
      const next = await ipc('fs:dirs', { path })
      if (seq !== latest.current) return
      setListing(next)
      // Show the listed path — unless the user typed something meanwhile.
      setTyped((current) => (current === typedBefore ? next.path : current))
    } catch (err) {
      if (seq === latest.current) setError(errorMessage(err))
    } finally {
      if (seq === latest.current) setLoading(false)
    }
  }

  useEffect(() => {
    void open()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the first listing, once; later ones follow clicks
  }, [])

  const sep = listing?.path.includes('\\') ? '\\' : '/'
  const join = (base: string, name: string) => (base.endsWith(sep) ? base + name : base + sep + name)

  return (
    <div
      role="dialog"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-void/70 p-4 backdrop-blur-xs"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="panel flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden">
        <header className="flex h-10 shrink-0 items-center justify-between border-b border-hud/60 px-3">
          <TechLabel className="text-text-secondary">{title}</TechLabel>
          <button type="button" aria-label={t.common.close} onClick={onClose} className="text-text-muted hover:text-cyan">
            <X size={15} />
          </button>
        </header>

        <form
          className="flex gap-2 border-b border-hud/50 p-2"
          onSubmit={(e) => {
            e.preventDefault()
            void open(typed.trim() || undefined)
          }}
        >
          <button
            type="button"
            aria-label={t.folderPicker.home}
            onClick={() => void open()}
            className="rounded-md border border-hud/60 px-2 text-text-muted hover:border-cyan/50 hover:text-cyan"
          >
            <Home size={14} />
          </button>
          <button
            type="button"
            aria-label={t.folderPicker.parent}
            disabled={!listing?.parent}
            onClick={() => listing?.parent && void open(listing.parent)}
            className="rounded-md border border-hud/60 px-2 text-text-muted hover:border-cyan/50 hover:text-cyan disabled:opacity-30"
          >
            <ArrowUp size={14} />
          </button>
          <input
            aria-label={t.folderPicker.path}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-hud/70 bg-surface/70 px-2 py-1 font-mono text-[12px] text-text-primary outline-hidden focus:border-cyan/60"
          />
        </form>

        {listing?.roots && listing.roots.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-hud/50 px-2 py-1.5" aria-label={t.folderPicker.sharedFolders}>
            {listing.roots.map((root) => (
              <button
                key={root}
                type="button"
                onClick={() => void open(root)}
                className={cn(
                  'max-w-full truncate rounded-sm border px-1.5 py-0.5 font-mono text-[10.5px]',
                  root === listing.path ? 'border-cyan/50 text-cyan' : 'border-hud/60 text-text-muted hover:border-cyan/40 hover:text-cyan'
                )}
              >
                {root}
              </button>
            ))}
          </div>
        )}

        <div className="min-h-[200px] flex-1 overflow-y-auto p-1.5">
          {loading && (
            <p className="flex items-center gap-2 px-2 py-3 font-mono text-[11px] text-text-muted">
              <Loader2 size={12} className="animate-spin" /> {t.common.loading}
            </p>
          )}
          {error && <p className="px-2 py-3 font-mono text-[11px] text-danger">{error}</p>}
          {!loading && listing?.dirs.length === 0 && (
            <p className="px-2 py-3 font-mono text-[11px] text-text-muted">{t.folderPicker.noSubfolders}</p>
          )}
          {!loading &&
            listing?.dirs.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => void open(join(listing.path, name))}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-sans text-[13px] text-text-secondary hover:bg-cyan/6 hover:text-text-primary"
              >
                <Folder size={14} className="shrink-0 text-cyan/80" />
                <span className="truncate">{name}</span>
              </button>
            ))}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-hud/60 p-2.5">
          <span className="truncate font-mono text-[11px] text-text-muted">{listing?.path}</span>
          <button
            type="button"
            disabled={!listing}
            onClick={() => listing && onPick(listing.path)}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-cyan/50 bg-cyan/[0.10] px-3 py-1.5 font-sans text-[12px] font-medium text-cyan hover:bg-cyan/16 disabled:opacity-40"
          >
            <Check size={13} /> {confirmLabel ?? t.folderPicker.select}
          </button>
        </footer>
      </div>
    </div>
  )
}
