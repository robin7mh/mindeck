import { useEffect, useState } from 'react'
import { ArrowRightLeft, Check, Loader2 } from 'lucide-react'
import { errorMessage, ipc, isDesktop } from '@shared/ipc/client'
import { LANGUAGES } from '@shared/types/languages'
import type { ExtensionFate, MigrationResult, MigrationSource } from '@shared/types/migrate'
import { Card } from '@/components/ui/Card'
import { useT } from '@/lib/i18n'
import { useEditorPrefs } from '@/features/editor/prefs'

const FATES: ExtensionFate[] = ['built-in', 'language', 'snippets', 'theme', 'unsupported']

/** One app found on this machine: what comes over, and what becomes of its extensions. */
function Source({ source }: { source: MigrationSource }) {
  const t = useT()
  const m = t.migrate
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<MigrationResult>()
  const [error, setError] = useState<string>()

  const apply = async () => {
    setBusy(true)
    setError(undefined)
    try {
      setDone(await ipc('migrate:apply', { app: source.app }))
      await useEditorPrefs.getState().load()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="rounded-sm border border-hud/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto font-sans text-[13px] font-medium text-text-primary">{source.name}</p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void apply()}
          className="flex items-center gap-1.5 rounded-md border border-cyan/40 bg-cyan/6 px-2.5 py-1 font-sans text-[12px] text-cyan hover:bg-cyan/12 disabled:opacity-50"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <ArrowRightLeft size={12} />} {m.apply}
        </button>
      </div>
      <p className="mt-0.5 font-sans text-[11.5px] text-text-secondary">{m.counts(source.settings, source.keybindings, source.snippets)}</p>
      {done && (
        <p role="status" className="mt-1 flex items-center gap-1 font-sans text-[11.5px] text-green">
          <Check size={12} /> {m.done(done.settings, done.keybindings, done.snippets)}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1 font-sans text-[11.5px] text-danger">
          {error}
        </p>
      )}
      {FATES.map((fate) => {
        const list = source.extensions.filter((e) => e.fate === fate)
        if (!list.length) return null
        const languages = [...new Set(list.map((e) => e.language).filter(Boolean))].map((id) => LANGUAGES.find((l) => l.id === id)?.name ?? id)
        return (
          <div key={fate} className="mt-1.5">
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">{m.fates[fate]}</p>
            <p className="font-sans text-[11.5px] text-text-secondary">
              {list.map((e) => e.name).join(' · ')}
              {fate === 'language' && languages.length > 0 && <span className="text-cyan"> → {m.installLanguages(languages.join(', '))}</span>}
            </p>
          </div>
        )
      })}
    </li>
  )
}

/**
 * Settings → moving over from VS Code / Cursor: Mindeck reads their editor
 * settings, keybindings, snippets and extensions (never changing them) and
 * takes over what it understands. Colors stay Mindeck's.
 */
export function MigrateCard() {
  const t = useT()
  const m = t.migrate
  const desktop = isDesktop()
  const [sources, setSources] = useState<MigrationSource[]>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!desktop) return
    ipc('migrate:scan').then(setSources, (err: unknown) => setError(errorMessage(err)))
  }, [desktop])

  return (
    <Card icon={ArrowRightLeft} title={m.title} className="pane-lg:col-span-2">
      <p className="mb-2 font-sans text-[12px] text-text-secondary">{m.intro}</p>
      {!desktop && <p className="font-sans text-[12px] text-text-muted">{m.desktopOnly}</p>}
      {error && <p className="font-sans text-[12px] text-danger">{error}</p>}
      {desktop && !sources && !error && <Loader2 size={14} aria-label={t.common.loading} className="animate-spin text-text-muted" />}
      {sources && !sources.length && <p className="font-sans text-[12px] text-text-muted">{m.none}</p>}
      <ul className="grid gap-2 pane-lg:grid-cols-2">
        {sources?.map((s) => (
          <Source key={s.app} source={s} />
        ))}
      </ul>
    </Card>
  )
}
