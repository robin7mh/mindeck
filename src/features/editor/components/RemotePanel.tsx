import { useEffect } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, ChevronRight, Download, Folder, FolderOpen, Loader2, RefreshCw, Server, X } from 'lucide-react'
import type { SftpEntry } from '@shared/types/sftp'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { Select } from '@/components/ui/Select'
import { useSftp } from '../sftp'
import { fileIcon } from './FileTree'

const row = 'flex w-full items-center gap-1.5 rounded-sm py-[3px] pr-2 text-left font-sans text-[12.5px] text-text-secondary transition-colors hover:bg-elevated/60 hover:text-text-primary'
const tool = 'flex h-6 w-6 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-elevated hover:text-text-primary disabled:opacity-40'

function Level({ dir, depth }: { dir: string; depth: number }) {
  const t = useT()
  const entries = useSftp((s) => s.tree[dir])
  const expanded = useSftp((s) => s.expanded)
  const sftp = useSftp.getState()
  if (!entries) return <Loader2 size={12} aria-label={t.common.loading} className="ml-4 animate-spin text-text-muted" />
  return (
    <>
      {entries.map((e: SftpEntry) => {
        const pad = { paddingLeft: 6 + depth * 12 }
        if (e.type === 'dir') {
          const open = !!expanded[e.path]
          return (
            <div key={e.path}>
              <div className="group flex items-center">
                <button type="button" role="treeitem" aria-expanded={open} style={pad} onClick={() => void sftp.toggle(e.path)} className={row}>
                  <ChevronRight size={12} className={cn('shrink-0 text-text-muted transition-transform', open && 'rotate-90')} />
                  {open ? <FolderOpen size={13} className="shrink-0 text-cyan/70" /> : <Folder size={13} className="shrink-0 text-cyan/70" />}
                  <span className="truncate">{e.name}</span>
                </button>
                <button type="button" aria-label={t.sftp.downloadItem(e.name)} title={t.sftp.download} onClick={() => void sftp.download([e.path])} className={cn(tool, 'hidden shrink-0 group-hover:flex')}>
                  <Download size={11} />
                </button>
              </div>
              {open && <Level dir={e.path} depth={depth + 1} />}
            </div>
          )
        }
        const { Icon, tint } = fileIcon(e.name)
        return (
          <div key={e.path} className="group flex items-center">
            <button type="button" role="treeitem" title={t.sftp.openHint} style={{ paddingLeft: pad.paddingLeft + 14 }} onClick={() => void sftp.open(e.path)} className={row}>
              <Icon size={13} className={cn('shrink-0', tint)} />
              <span className="truncate">{e.name}</span>
            </button>
            <button type="button" aria-label={t.sftp.downloadItem(e.name)} title={t.sftp.download} onClick={() => void sftp.download([e.path])} className={cn(tool, 'hidden shrink-0 group-hover:flex')}>
              <Download size={11} />
            </button>
          </div>
        )
      })}
    </>
  )
}

/**
 * The server side of a project with a .vscode/sftp.json — browse it, open
 * files from it, download, sync either way (the VS Code SFTP extension's
 * remote explorer).
 */
export function RemotePanel() {
  const t = useT()
  const { targets, target, busy, progress, message, error, confirmDown } = useSftp()
  const sftp = useSftp.getState()
  const current = targets.find((x) => x.name === target)

  useEffect(() => {
    if (target && !useSftp.getState().expanded['']) void useSftp.getState().toggle('')
  }, [target])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1.5 px-2 pb-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">{t.sftp.title}</p>
        {targets.length > 1 && (
          <Select label={t.sftp.target} icon={Server} value={target ?? ''} onChange={(v) => sftp.select(v)} options={targets.map((x) => ({ value: x.name, label: x.name, hint: x.host }))} />
        )}
        {current && (
          <p className="truncate font-mono text-[11px] text-text-secondary" title={`${current.username ?? ''}@${current.host}:${current.remotePath}`}>
            {current.username ? `${current.username}@` : ''}
            {current.host}:{current.remotePath}
          </p>
        )}
        <div className="flex items-center gap-0.5">
          <button type="button" aria-label={t.sftp.refresh} title={t.sftp.refresh} disabled={busy} onClick={() => void sftp.refresh()} className={tool}>
            <RefreshCw size={12} />
          </button>
          <button type="button" aria-label={t.sftp.syncUp} title={t.sftp.syncUp} disabled={busy} onClick={() => void sftp.sync('up')} className={tool}>
            <ArrowUpFromLine size={12} />
          </button>
          <button type="button" aria-label={t.sftp.syncDown} title={t.sftp.syncDown} disabled={busy} onClick={() => sftp.setConfirmDown(true)} className={tool}>
            <ArrowDownToLine size={12} />
          </button>
          {current?.uploadOnSave && <span className="ml-auto font-sans text-[10.5px] text-text-muted">{t.sftp.uploadOnSave}</span>}
        </div>
        {confirmDown && (
          <div role="alertdialog" aria-label={t.sftp.syncDown} className="space-y-1.5 rounded-md border border-amber/40 bg-amber/6 p-2">
            <p className="font-sans text-[12px] text-text-primary">{t.sftp.confirmDown}</p>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => void sftp.sync('down')} className="rounded-sm border border-amber/50 px-2 py-0.5 font-sans text-[12px] text-amber hover:bg-amber/10">
                {t.sftp.syncDown}
              </button>
              <button type="button" onClick={() => sftp.setConfirmDown(false)} className="rounded-sm border border-hud/60 px-2 py-0.5 font-sans text-[12px] text-text-secondary">
                {t.common.cancel}
              </button>
            </div>
          </div>
        )}
        {busy && (
          <p role="status" className="flex items-center gap-1.5 font-sans text-[11.5px] text-text-secondary">
            <Loader2 size={11} className="animate-spin" />
            {progress ? t.sftp.progress(progress.action, progress.done, progress.total, progress.file) : t.sftp.working}
          </p>
        )}
        {!busy && message !== undefined && <p className="font-sans text-[11.5px] text-green">{t.sftp.done(message)}</p>}
        {error && (
          <p role="alert" className="flex items-start gap-1 rounded-sm bg-danger/10 px-2 py-1 font-sans text-[11.5px] text-danger">
            <span className="flex-1 whitespace-pre-wrap">{error}</span>
            <button type="button" aria-label={t.common.dismiss} onClick={() => sftp.clearError()}>
              <X size={12} />
            </button>
          </p>
        )}
      </div>
      <div role="tree" aria-label={t.sftp.title} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {target && <Level dir="" depth={0} />}
      </div>
    </div>
  )
}
