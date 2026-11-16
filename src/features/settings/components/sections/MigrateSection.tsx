import { useEffect, useState } from 'react'
import { ArrowRightLeft, Check, Loader2 } from 'lucide-react'
import { errorMessage, ipc } from '@shared/ipc/client'
import { LANGUAGES } from '@shared/types/languages'
import type { ExtensionFate, MigrationResult, MigrationSource } from '@shared/types/migrate'
import { useT } from '@/lib/i18n'
import { useEditorPrefs } from '@/features/editor/prefs'
import { Advanced, Chip, Group, Row, SectionHeader, btnPrimary } from '../ui'

const FATES: ExtensionFate[] = ['built-in', 'language', 'snippets', 'theme', 'unsupported']

/** One app found on this machine: what comes over, and what becomes of its extensions. */
function Source({ source }: { source: MigrationSource }) {
  const m = useT().migrate
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
    <Group>
      <Row
        label={source.name}
        hint={
          <>
            {m.counts(source.settings, source.keybindings, source.snippets)}
            {done && (
              <span role="status" className="mt-1 flex items-center gap-1.5 text-green">
                <Check size={13} /> {m.done(done.settings, done.keybindings, done.snippets)}
              </span>
            )}
            {error && (
              <span role="alert" className="mt-1 block text-danger">
                {error}
              </span>
            )}
          </>
        }
        align="start"
      >
        <button type="button" className={btnPrimary} disabled={busy || source.settings + source.keybindings + source.snippets === 0} onClick={() => void apply()}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRightLeft size={14} />} {m.apply}
        </button>
      </Row>
      {FATES.map((fate) => {
        const list = source.extensions.filter((e) => e.fate === fate)
        if (!list.length) return null
        const languages = [...new Set(list.map((e) => e.language).filter(Boolean))].map((id) => LANGUAGES.find((l) => l.id === id)?.name ?? id)
        return (
          <Advanced key={fate} summary={`${m.fates[fate]} · ${list.length}`}>
            <div className="flex flex-wrap gap-1.5 px-5 py-4">
              {list.map((e) => (
                <Chip key={e.id}>{e.name}</Chip>
              ))}
            </div>
            {fate === 'language' && languages.length > 0 && <p className="px-5 pb-4 font-sans text-[12.5px] text-cyan">→ {m.installLanguages(languages.join(', '))}</p>}
          </Advanced>
        )
      })}
    </Group>
  )
}

/**
 * Settings → moving over from VS Code / Cursor: Mindeck reads their editor
 * settings, keybindings, snippets and extensions (never changing them) and
 * takes over what it understands. Colors stay Mindeck's.
 */
export function MigrateSection() {
  const t = useT()
  const m = t.migrate
  const s = t.settings
  const [sources, setSources] = useState<MigrationSource[]>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    ipc('migrate:scan').then(setSources, (err: unknown) => setError(errorMessage(err)))
  }, [])

  return (
    <>
      <SectionHeader title={s.sections.migrate.title} intro={s.sections.migrate.intro} />
      {error && <p className="font-sans text-[13px] text-danger">{error}</p>}
      {!sources && !error && <Loader2 size={18} aria-label={t.common.loading} className="animate-spin text-text-muted" />}
      {sources && !sources.length && <p className="px-1 font-sans text-[13px] text-text-secondary">{m.none}</p>}
      {sources?.map((source) => (
        <Source key={source.app} source={source} />
      ))}
    </>
  )
}
