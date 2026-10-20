import { FileDown, FolderSearch, X } from 'lucide-react'
import { TechLabel } from '@/components/ui/TechLabel'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { isMac } from '@/lib/platform'
import { formatBytes } from '@/features/files/kinds'
import { useBrowser } from '../store'

const action = 'rounded-sm px-1.5 py-0.5 font-sans text-[11px] text-text-secondary transition-colors hover:bg-elevated hover:text-cyan'

/** Downloads of this session: progress, then open or show in the folder. */
export function DownloadsPanel() {
  const t = useT()
  const downloads = useBrowser((s) => s.state.downloads)
  const run = useBrowser((s) => s.run)
  const act = (id: string, a: 'open' | 'reveal' | 'cancel' | 'remove') => void run('browser:download', { id, action: a })

  return (
    <aside aria-label={t.browser.downloads} className="flex w-72 shrink-0 flex-col border-l border-hud/50 bg-surface/40">
      <div className="flex h-9 items-center justify-between border-b border-hud/50 px-3">
        <TechLabel className="text-text-secondary">{t.browser.downloads}</TechLabel>
        <button type="button" aria-label={t.common.close} onClick={() => useBrowser.getState().toggleDownloads()} className="rounded-sm p-1 text-text-muted hover:bg-elevated hover:text-text-primary">
          <X size={13} />
        </button>
      </div>
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {!downloads.length && <li className="px-1 py-6 text-center font-sans text-[12px] text-text-muted">{t.browser.noDownloads}</li>}
        {downloads.map((d) => {
          const progress = d.total ? Math.min(100, Math.round((d.received / d.total) * 100)) : 0
          return (
            <li key={d.id} className="rounded-md border border-hud/50 bg-surface/60 px-2.5 py-2">
              <div className="flex items-center gap-2">
                <FileDown size={14} className={cn('shrink-0', d.state === 'completed' ? 'text-green' : d.state === 'progressing' ? 'text-cyan' : 'text-danger')} />
                <span className="min-w-0 flex-1 truncate font-sans text-[12px] text-text-primary" title={d.path}>
                  {d.filename}
                </span>
              </div>
              {d.state === 'progressing' && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-elevated">
                  <div className="h-full bg-cyan transition-[width]" style={{ width: `${progress}%` }} />
                </div>
              )}
              <div className="mt-1 flex items-center gap-1">
                <span className="flex-1 font-mono text-[10.5px] text-text-muted">
                  {t.browser.downloadStates[d.state]}
                  {d.state === 'progressing' ? ` · ${formatBytes(d.received)}${d.total ? ` / ${formatBytes(d.total)}` : ''}` : d.total ? ` · ${formatBytes(d.total)}` : ''}
                </span>
                {d.state === 'completed' && (
                  <button type="button" onClick={() => act(d.id, 'open')} className={action}>
                    {t.browser.openDownload}
                  </button>
                )}
                {d.state === 'completed' && (
                  <button type="button" aria-label={t.browser.reveal(isMac)} title={t.browser.reveal(isMac)} onClick={() => act(d.id, 'reveal')} className={action}>
                    <FolderSearch size={12} />
                  </button>
                )}
                {d.state === 'progressing' ? (
                  <button type="button" onClick={() => act(d.id, 'cancel')} className={action}>
                    {t.browser.cancelDownload}
                  </button>
                ) : (
                  <button type="button" aria-label={t.browser.removeDownload} title={t.browser.removeDownload} onClick={() => act(d.id, 'remove')} className={action}>
                    <X size={12} />
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
