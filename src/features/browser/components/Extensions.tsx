import { useState, type FormEvent } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, FolderOpen, Puzzle, RefreshCw, Trash2, X } from 'lucide-react'
import type { BrowserExtension, ChromiumProfile } from '@shared/types/browserExtensions'
import { TechLabel } from '@/components/ui/TechLabel'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useBrowser } from '../store'

const NONE: BrowserExtension[] = []

const small =
  'flex items-center gap-1 rounded-md border border-hud/60 px-2 py-1 font-sans text-[11.5px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan disabled:pointer-events-none disabled:opacity-40'

function Icon({ ext, size = 16 }: { ext: BrowserExtension; size?: number }) {
  if (ext.icon) return <img src={ext.icon} alt="" style={{ width: size, height: size }} className="shrink-0 object-contain" draggable={false} />
  return <Puzzle size={size - 2} className="shrink-0 text-text-muted" aria-hidden />
}

/**
 * The toolbar icons of the enabled extensions (Chrome's puzzle area): a
 * click opens the extension's popup under its icon — Bitwarden, uBlock.
 */
export function ExtensionButtons() {
  const t = useT()
  const extensions = useBrowser((s) => s.state.extensions ?? NONE)
  const run = useBrowser((s) => s.run)
  const shown = extensions.filter((e) => e.enabled && !e.error)
  return (
    <>
      {shown.map((ext) => (
        <button
          key={ext.id}
          type="button"
          aria-label={ext.popup ? t.browserExtras.openPopup(ext.name) : t.browserExtras.noPopup(ext.name)}
          title={ext.popup ? ext.name : t.browserExtras.noPopup(ext.name)}
          disabled={!ext.popup}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            void run('browser:extensions:popup', { id: ext.id, anchor: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } })
          }}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-elevated disabled:opacity-50"
        >
          <Icon ext={ext} />
        </button>
      ))}
    </>
  )
}

function ExtensionRow({ ext }: { ext: BrowserExtension }) {
  const t = useT()
  const run = useBrowser((s) => s.run)
  const [open, setOpen] = useState(false)
  const x = t.browserExtras
  return (
    <li className="rounded-md border border-hud/50 bg-surface/60 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <Icon ext={ext} size={18} />
        <div className="min-w-0 flex-1">
          <div className={cn('truncate font-sans text-[12.5px]', ext.enabled ? 'text-text-primary' : 'text-text-muted')} title={ext.name}>
            {ext.name}
          </div>
          <div className="truncate font-mono text-[10.5px] text-text-muted">
            {ext.version} · {x.sources[ext.source]}
          </div>
        </div>
        <input
          type="checkbox"
          role="switch"
          aria-label={x.toggle(ext.name)}
          checked={ext.enabled}
          onChange={(e) => void run('browser:extensions:update', { id: ext.id, enabled: e.target.checked })}
          className="h-3.5 w-3.5 accent-cyan"
        />
        <button
          type="button"
          aria-label={x.remove(ext.name)}
          title={x.remove(ext.name)}
          onClick={() => void run('browser:extensions:remove', { id: ext.id })}
          className="rounded-sm p-1 text-text-muted hover:bg-elevated hover:text-danger"
        >
          <Trash2 size={12} />
        </button>
      </div>
      {ext.error && (
        <p role="alert" className="mt-1.5 flex items-start gap-1 font-sans text-[11px] text-danger">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {ext.error}
        </p>
      )}
      {ext.unsupported.length > 0 && (
        <p className="mt-1.5 font-sans text-[11px] text-amber">
          {x.unsupported} <span className="font-mono">{ext.unsupported.join(', ')}</span>
        </p>
      )}
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="mt-1 flex items-center gap-0.5 font-sans text-[11px] text-text-muted hover:text-text-primary">
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} {x.details}
      </button>
      {open && (
        <div className="mt-1 space-y-1 font-sans text-[11px] text-text-secondary">
          {ext.description && <p>{ext.description}</p>}
          <p className="text-text-muted">{ext.permissions.length ? x.permissions : x.noPermissions}</p>
          {ext.permissions.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {ext.permissions.map((p) => (
                <li key={p} className={cn('rounded-sm border px-1 font-mono text-[10px]', ext.unsupported.includes(p) ? 'border-amber/40 text-amber' : 'border-hud/50')}>
                  {p}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}

/** Extensions in another browser's profiles, to take over with a click. */
function Profiles({ profiles, reload }: { profiles: ChromiumProfile[]; reload: () => Promise<void> }) {
  const t = useT()
  const run = useBrowser((s) => s.run)
  const [busy, setBusy] = useState<string | null>(null)
  if (!profiles.length) return <p className="px-1 py-2 font-sans text-[11.5px] text-text-muted">{t.browserExtras.noProfiles}</p>
  const take = async (path: string) => {
    setBusy(path)
    await run('browser:extensions:install', { source: 'profile', path })
    await reload()
    setBusy(null)
  }
  return (
    <div className="space-y-2">
      {profiles.map((p) => (
        <div key={p.path}>
          <TechLabel className="text-text-muted">
            {t.browserExtras.browsers[p.browser]} · {p.name}
          </TechLabel>
          <ul className="mt-1 space-y-1">
            {p.extensions.map((e) => (
              <li key={e.path} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-sans text-[12px] text-text-primary" title={`${e.name} ${e.version}`}>
                  {e.name}
                </span>
                {e.installed ? (
                  <span className="font-sans text-[11px] text-green">{t.browserExtras.installed}</span>
                ) : (
                  <button type="button" disabled={busy !== null} onClick={() => void take(e.path)} className={small}>
                    {t.browserExtras.takeOver}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

/**
 * The extension manager: install from the Chrome Web Store, a folder or
 * another browser; turn on and off, remove, see what each may do, update.
 */
export function ExtensionsPanel() {
  const t = useT()
  const x = t.browserExtras
  const extensions = useBrowser((s) => s.state.extensions ?? NONE)
  const run = useBrowser((s) => s.run)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [profiles, setProfiles] = useState<ChromiumProfile[] | null>(null)
  const [report, setReport] = useState<string | null>(null)

  const install = async (e: FormEvent) => {
    e.preventDefault()
    if (!input.trim()) return
    setBusy(true)
    if (await run('browser:extensions:install', { source: 'store', input: input.trim() })) setInput('')
    setBusy(false)
  }
  const loadFolder = async () => {
    setBusy(true)
    await run('browser:extensions:install', { source: 'folder' })
    setBusy(false)
  }
  const loadProfiles = async () => setProfiles((await run('browser:extensions:profiles')) ?? [])
  const showProfiles = () => (profiles ? setProfiles(null) : void loadProfiles())
  const checkUpdates = async () => {
    setBusy(true)
    const result = await run('browser:extensions:checkUpdates')
    setBusy(false)
    if (result) setReport(x.updated(result.updated.join(', ')))
  }

  return (
    <aside aria-label={x.extensions} className="flex w-80 shrink-0 flex-col border-l border-hud/50 bg-surface/40">
      <div className="flex h-9 items-center justify-between border-b border-hud/50 px-3">
        <TechLabel className="text-text-secondary">{x.extensions}</TechLabel>
        <button type="button" aria-label={t.common.close} onClick={() => useBrowser.getState().toggleExtensions()} className="rounded-sm p-1 text-text-muted hover:bg-elevated hover:text-text-primary">
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
        <form onSubmit={(e) => void install(e)} className="flex gap-1.5">
          <input
            aria-label={x.installPlaceholder}
            placeholder={x.installPlaceholder}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-hud/60 bg-surface/70 px-2 py-1 font-mono text-[11.5px] text-text-primary outline-hidden placeholder:font-sans focus:border-cyan/60"
          />
          <button type="submit" disabled={busy || !input.trim()} className={cn(small, 'border-cyan/50 text-cyan')}>
            {x.install}
          </button>
        </form>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" disabled={busy} onClick={() => void loadFolder()} className={small}>
            <FolderOpen size={12} /> {x.loadFolder}
          </button>
          <button type="button" aria-expanded={!!profiles} onClick={showProfiles} className={small}>
            {x.fromBrowser}
          </button>
        </div>
        {profiles && <Profiles profiles={profiles} reload={loadProfiles} />}
        <ul className="space-y-1">
          {!extensions.length && <li className="px-1 py-4 text-center font-sans text-[12px] text-text-muted">{x.noExtensions}</li>}
          {extensions.map((ext) => (
            <ExtensionRow key={ext.id} ext={ext} />
          ))}
        </ul>
        {extensions.length > 0 && (
          <div className="flex items-center gap-2">
            <button type="button" disabled={busy} onClick={() => void checkUpdates()} className={small}>
              <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> {x.checkUpdates}
            </button>
            {report && <span className="min-w-0 flex-1 truncate font-sans text-[11px] text-text-muted" title={report}>{report}</span>}
          </div>
        )}
      </div>
    </aside>
  )
}
