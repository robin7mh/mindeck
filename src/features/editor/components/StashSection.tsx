import { useState } from 'react'
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Loader2, PackageOpen, Trash2 } from 'lucide-react'
import { TechLabel } from '@/components/ui/TechLabel'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { relativeTime } from '@/features/agents/format'
import { useScm } from '../scm'

const icon = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-elevated hover:text-text-primary disabled:opacity-40'
const button = 'flex items-center justify-center gap-1 rounded-md border border-hud/60 px-2 py-1 font-sans text-[11.5px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan disabled:opacity-40'

/** "On main: message" → "message"; "WIP on main: abc subject" stays as it is. */
const shortMessage = (message: string) => message.replace(/^On [^:]+: /, '')

/**
 * Git stash in the source control view: stash the changes (with a message,
 * untracked files optionally), and per stash apply, pop or drop it — or open
 * it to see its files, each a click away from its diff.
 */
export function StashSection({ readOnly }: { readOnly: boolean }) {
  const t = useT()
  const { stashes, stashFiles, busy, status } = useScm()
  const scm = useScm.getState()
  const [naming, setNaming] = useState(false)
  const [message, setMessage] = useState('')
  const [untracked, setUntracked] = useState(false)
  const [dropping, setDropping] = useState<string>()
  const changes = !!status?.files.length

  const stash = async () => {
    if (await scm.stash(message, untracked)) {
      setNaming(false)
      setMessage('')
      setUntracked(false)
    }
  }

  return (
    <section className="mt-3">
      <div className="flex items-center gap-1 px-1.5 py-1">
        <TechLabel className="flex-1 text-text-muted">
          {t.stash.title} <span className="ml-1 font-mono">{stashes.length}</span>
        </TechLabel>
        {!readOnly && (
          <button type="button" aria-label={t.stash.create} title={t.stash.create} className={icon} disabled={!!busy || !changes} onClick={() => setNaming((v) => !v)}>
            <Archive size={13} />
          </button>
        )}
      </div>
      {naming && (
        <div className="space-y-1.5 px-1.5 pb-2">
          <input
            autoFocus
            aria-label={t.stash.message}
            placeholder={t.stash.message}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void stash()
              if (e.key === 'Escape') setNaming(false)
            }}
            className="w-full rounded-md border border-hud/60 bg-surface/50 px-2 py-1 font-sans text-[12px] text-text-primary outline-hidden focus:border-cyan/50"
          />
          <div className="flex items-center gap-2">
            <label className="flex flex-1 items-center gap-1 font-sans text-[11px] text-text-muted">
              <input type="checkbox" checked={untracked} onChange={(e) => setUntracked(e.target.checked)} className="accent-cyan" />
              {t.stash.untracked}
            </label>
            <button type="button" className={button} disabled={!!busy} onClick={() => void stash()}>
              {busy === 'stash' ? <Loader2 size={12} className="animate-spin" /> : <Archive size={12} />} {t.stash.stash}
            </button>
          </div>
        </div>
      )}
      {!stashes.length && <p className="px-1.5 font-sans text-[11.5px] text-text-muted">{t.stash.empty}</p>}
      <ul>
        {stashes.map((s) => {
          const files = stashFiles[s.hash]
          return (
            <li key={s.hash}>
              <div className="group flex items-center gap-1 rounded-sm px-1.5 py-0.5 hover:bg-elevated/50">
                <button type="button" aria-expanded={!!files} title={s.message} onClick={() => void scm.toggleStash(s.hash)} className="flex min-w-0 flex-1 items-center gap-1 text-left">
                  {files ? <ChevronDown size={12} className="shrink-0 text-text-muted" /> : <ChevronRight size={12} className="shrink-0 text-text-muted" />}
                  <span className="min-w-0 truncate font-sans text-[12px] text-text-primary">{shortMessage(s.message)}</span>
                  <span className="shrink-0 font-mono text-[10px] text-text-muted">{relativeTime(new Date(s.date).toISOString())}</span>
                </button>
                {!readOnly && (
                  <span className="hidden items-center group-hover:flex">
                    <button type="button" aria-label={`${t.stash.apply}: ${s.message}`} title={t.stash.apply} className={icon} disabled={!!busy} onClick={() => void scm.applyStash(s.hash, false)}>
                      <PackageOpen size={13} />
                    </button>
                    <button type="button" aria-label={`${t.stash.pop}: ${s.message}`} title={t.stash.pop} className={icon} disabled={!!busy} onClick={() => void scm.applyStash(s.hash, true)}>
                      <ArchiveRestore size={13} />
                    </button>
                    <button type="button" aria-label={`${t.stash.drop}: ${s.message}`} title={t.stash.drop} className={icon} disabled={!!busy} onClick={() => setDropping(s.hash)}>
                      <Trash2 size={13} />
                    </button>
                  </span>
                )}
              </div>
              {dropping === s.hash && (
                <div role="alertdialog" className="mx-1.5 my-1 space-y-1.5 rounded-md border border-danger/40 bg-danger/6 p-2">
                  <p className="font-sans text-[11.5px] text-text-primary">{t.stash.confirmDrop(shortMessage(s.message))}</p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setDropping(undefined)
                        void scm.dropStash(s.hash)
                      }}
                      className={cn(button, 'flex-1 border-danger/50 text-danger hover:border-danger hover:text-danger')}
                    >
                      {t.stash.drop}
                    </button>
                    <button type="button" onClick={() => setDropping(undefined)} className={cn(button, 'flex-1')}>
                      {t.common.cancel}
                    </button>
                  </div>
                </div>
              )}
              {files && (
                <ul className="pl-5">
                  {files.map((f) => {
                    const name = f.path.slice(f.path.lastIndexOf('/') + 1)
                    return (
                      <li key={f.path}>
                        <button
                          type="button"
                          title={f.from ? `${f.from} → ${f.path}` : f.path}
                          onClick={() => void scm.openDiff(f, { kind: 'stash', hash: s.hash, from: f.from, untracked: f.change === 'untracked' }, `${name} (${t.stash.title}: ${shortMessage(s.message)})`)}
                          className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-left hover:bg-elevated/50"
                        >
                          <span className="min-w-0 flex-1 truncate font-sans text-[12px] text-text-primary">{name}</span>
                          <span className="min-w-0 truncate font-mono text-[10px] text-text-muted">{f.path.slice(0, f.path.length - name.length)}</span>
                          <span className="shrink-0 font-sans text-[10.5px] text-text-muted">{t.scm.change[f.change]}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
