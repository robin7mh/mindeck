import { useState, type MouseEvent } from 'react'
import { Code2, ExternalLink, FolderSearch, Globe, X } from 'lucide-react'
import type { FinderPreview } from '@shared/types/finder'
import { extOf } from '@shared/types/finder'
import { TechLabel } from '@/components/ui/TechLabel'
import { useT } from '@/lib/i18n'
import { isMac } from '@/lib/platform'
import { Markdown } from '@/components/ui/Markdown'
import { useBrowser } from '@/features/browser/store'
import { entryKind, fileUrl, formatBytes, formatMode, formatModified, thumbUrl } from '../kinds'
import { useFiles } from '../store'
import { FileIcon } from './FileIcon'

const action =
  'flex items-center justify-center gap-1.5 rounded-md border border-hud/60 px-2.5 py-1.5 font-sans text-[12px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan'

/** The OS's picture of a file (PDF pages, documents, …), else its icon. */
function SystemThumb({ preview }: { preview: FinderPreview }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <div className="flex h-40 items-center justify-center">
        <FileIcon entry={preview.entry} size={64} />
      </div>
    )
  }
  return <img src={thumbUrl(preview.entry.path, 512)} alt="" onError={() => setFailed(true)} className="mx-auto max-h-80 max-w-full rounded-sm border border-hud/40 object-contain" />
}

function Body({ preview }: { preview: FinderPreview }) {
  const t = useT()
  const { entry, type } = preview
  const markdown = type === 'text' && ['md', 'markdown', 'mdx'].includes(extOf(entry.name))

  // Links in a rendered note open in Mindeck's browser, never in this window.
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    if (/^https?:/i.test(a.href)) void useBrowser.getState().show(a.href)
  }

  if (type === 'image') return <img src={fileUrl(entry.path)} alt={entry.name} className="mx-auto max-h-[60vh] max-w-full rounded-sm border border-hud/40 object-contain" />
  if (type === 'video') return <video src={fileUrl(entry.path)} controls className="w-full rounded-sm border border-hud/40 bg-black" />
  if (type === 'audio') return <audio src={fileUrl(entry.path)} controls className="w-full" />
  if (type === 'dir') {
    return (
      <div className="flex flex-col items-center gap-2 py-6">
        <FileIcon entry={entry} size={64} />
        <span className="font-sans text-[12px] text-text-muted">{t.files.folderInfo(preview.items ?? 0)}</span>
      </div>
    )
  }
  if (type === 'text') {
    return (
      <div className="space-y-1.5">
        {markdown ? (
          <Markdown text={preview.text ?? ''} className="text-[13px]" onClick={onClick} />
        ) : (
          <pre className="overflow-x-auto whitespace-pre rounded-md border border-hud/40 bg-surface/60 p-2.5 font-mono text-[11px] leading-relaxed text-text-secondary">{preview.text}</pre>
        )}
        {preview.truncated && <p className="font-sans text-[11px] text-text-muted">{t.files.textTruncated}</p>}
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <SystemThumb preview={preview} />
      {type === 'binary' && <p className="text-center font-sans text-[11.5px] text-text-muted">{t.files.noPreview}</p>}
    </div>
  )
}

export interface PreviewActions {
  open(path: string): void
  openInEditor?(path: string): void
  openInBrowser?(path: string): void
}

/** The selected entry: a look at it, what it is, and what to do with it. */
export function PreviewPane({ actions, editable, browsable }: { actions: PreviewActions; editable: boolean; browsable: boolean }) {
  const t = useT()
  const preview = useFiles((s) => s.preview)
  const count = useFiles((s) => s.selected.length)
  const info = useFiles((s) => (s.info?.entry.path === s.preview?.entry.path ? s.info : undefined))
  const size = useFiles((s) => s.size)
  // Nothing selected (or several): no pane, the files get the room.
  if (!preview || count !== 1) return null
  const { entry } = preview
  return (
    <aside aria-label={t.files.preview} className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-hud/50">
      <div className="flex items-center gap-2 border-b border-hud/40 px-3 py-2.5">
        <FileIcon entry={entry} size={18} />
        <span className="min-w-0 flex-1 truncate font-sans text-[13px] font-medium text-text-primary" title={entry.name}>
          {entry.name}
        </span>
        <button
          type="button"
          aria-label={t.files.closePreview}
          title={t.files.closePreview}
          onClick={() => useFiles.getState().clearSelection()}
          className="shrink-0 rounded-sm p-0.5 text-text-muted transition-colors hover:bg-elevated hover:text-text-primary"
        >
          <X size={13} />
        </button>
      </div>
      <div className="p-3">
        <Body preview={preview} />
      </div>
      <dl className="mx-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-hud/40 pt-2.5">
        <dt><TechLabel>{t.files.kind}</TechLabel></dt>
        <dd className="font-sans text-[12px] text-text-secondary">{t.files.kinds[entryKind(entry)]}</dd>
        {entry.kind === 'file' && (
          <>
            <dt><TechLabel>{t.files.size}</TechLabel></dt>
            <dd className="font-mono text-[11.5px] text-text-secondary">{formatBytes(entry.size)}</dd>
          </>
        )}
        {entry.kind === 'dir' && size && (
          <>
            <dt><TechLabel>{t.files.size}</TechLabel></dt>
            <dd className="font-mono text-[11.5px] text-text-secondary">
              {size === 'counting' ? t.files.counting : t.files.folderSize(formatBytes(size.bytes), size.files, size.partial)}
            </dd>
          </>
        )}
        {info && (
          <>
            <dt><TechLabel>{t.files.created}</TechLabel></dt>
            <dd className="font-mono text-[11.5px] text-text-secondary">{formatModified(info.createdMs)}</dd>
          </>
        )}
        <dt><TechLabel>{t.files.modified}</TechLabel></dt>
        <dd className="font-mono text-[11.5px] text-text-secondary">{formatModified(entry.mtimeMs)}</dd>
        {info && (
          <>
            <dt><TechLabel>{t.files.permissions}</TechLabel></dt>
            <dd className="font-mono text-[11.5px] text-text-secondary" title={info.mode.toString(8).padStart(3, '0')}>
              {formatMode(info.mode)}
            </dd>
            <dt><TechLabel>{t.files.owner}</TechLabel></dt>
            <dd className="font-sans text-[12px] text-text-secondary">{info.owner ?? t.files.otherOwner}</dd>
          </>
        )}
      </dl>
      {info && !info.writable && <p className="mx-3 mt-2 font-sans text-[11px] text-amber">{t.files.readOnly}</p>}
      <p className="mx-3 mt-2 break-all font-mono text-[10.5px] text-text-muted">{entry.path}</p>
      <div className="mt-3 flex flex-wrap gap-1.5 px-3 pb-3">
        <button type="button" onClick={() => actions.open(entry.path)} className={action}>
          <ExternalLink size={12} /> {t.files.open}
        </button>
        {editable && actions.openInEditor && (
          <button type="button" onClick={() => actions.openInEditor!(entry.path)} className={action}>
            <Code2 size={12} /> {t.files.openInEditor}
          </button>
        )}
        {browsable && actions.openInBrowser && (
          <button type="button" onClick={() => actions.openInBrowser!(entry.path)} className={action}>
            <Globe size={12} /> {t.files.openInBrowser}
          </button>
        )}
        <button type="button" onClick={() => void useFiles.getState().reveal(entry.path)} className={action} title={t.files.reveal(isMac)}>
          <FolderSearch size={12} /> {t.files.reveal(isMac)}
        </button>
      </div>
    </aside>
  )
}
