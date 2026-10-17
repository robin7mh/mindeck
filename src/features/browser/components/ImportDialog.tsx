import { useEffect, useState } from 'react'
import { CircleCheck, Import, KeyRound, Loader2, TriangleAlert, X } from 'lucide-react'
import { errorMessage, ipc, onEvent } from '@shared/ipc/client'
import { BROWSER_NAMES, type ImportKind, type ImportResult, type ImportSource } from '@shared/types/browserData'
import { Select } from '@/components/ui/Select'
import { useT } from '@/lib/i18n'
import { useOverlay } from '@/lib/overlay'
import { ENGINE_LABELS } from '../url'
import { dialogButton } from './BookmarkEditor'

const ORDER: ImportKind[] = ['bookmarks', 'history', 'settings']

/**
 * Taking bookmarks, history and the search engine over from another browser
 * on this machine: pick the browser and profile, then what to bring. Says up
 * front that passwords and cookies stay behind (Chromium encrypts them).
 * `onClose`: finished, skipped or cancelled. `onBusy`: an import runs (or ended).
 * Stands alone: in a dialog (ImportDialog) or as a step of the first-run setup (ImportStep).
 */
export function ImportPanel({ onClose, onBusy }: { onClose(): void; onBusy?(busy: boolean): void }) {
  const t = useT()
  const [sources, setSources] = useState<ImportSource[] | null>(null)
  const [sourceId, setSourceId] = useState('')
  const [kinds, setKinds] = useState<ImportKind[]>([])
  const [running, setRunning] = useState(false)
  const [step, setStep] = useState<ImportKind>()
  const [result, setResult] = useState<ImportResult>()
  const [error, setError] = useState('')
  const source = sources?.find((s) => s.id === sourceId)

  useEffect(() => {
    const off = onEvent('browser:import', (p) => setStep(p.kind))
    void ipc('browser:importSources').then(
      (list) => {
        setSources(list)
        if (list[0]) pick(list[0])
      },
      () => setSources([])
    )
    return off
  }, [])

  function pick(s: ImportSource) {
    setSourceId(s.id)
    setKinds(s.kinds)
  }

  const start = async () => {
    setRunning(true)
    onBusy?.(true)
    setError('')
    try {
      setResult(await ipc('browser:import', { sourceId, kinds }))
    } catch (err) {
      setError(errorMessage(err))
    }
    setRunning(false)
    onBusy?.(false)
  }

  const label = (s: ImportSource) => `${BROWSER_NAMES[s.browser]} — ${s.profile}`

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <Import size={15} className="text-cyan" />
        <h2 className="flex-1 font-sans text-[14px] font-semibold text-text-primary">{t.library.importTitle}</h2>
        <button
          type="button"
          aria-label={t.common.close}
          disabled={running}
          onClick={onClose}
          className="rounded-sm p-1 text-text-muted hover:bg-elevated hover:text-text-primary disabled:opacity-40"
        >
          <X size={14} />
        </button>
      </div>

      {!sources && <p className="py-4 font-sans text-[12.5px] text-text-muted">{t.library.looking}</p>}
      {sources && !sources.length && <p className="py-4 font-sans text-[12.5px] text-text-secondary">{t.library.noBrowsers}</p>}

      {source && !result && (
        <>
          <div className="mb-3">
            <span className="mb-1 block font-sans text-[12px] text-text-secondary">{t.library.importFrom}</span>
            <Select
              label={t.library.importFrom}
              value={sourceId}
              options={sources!.map((s) => ({ value: s.id, label: label(s) }))}
              onChange={(id) => pick(sources!.find((s) => s.id === id)!)}
            />
          </div>
          <fieldset className="mb-3">
            <legend className="mb-1 font-sans text-[12px] text-text-secondary">{t.library.importWhat}</legend>
            {ORDER.filter((k) => source.kinds.includes(k)).map((k) => (
              <label key={k} className="flex items-center gap-2 py-0.5 font-sans text-[12.5px] text-text-primary">
                <input
                  type="checkbox"
                  checked={kinds.includes(k)}
                  disabled={running}
                  onChange={(e) => setKinds(e.target.checked ? [...kinds, k] : kinds.filter((x) => x !== k))}
                  className="h-3.5 w-3.5 accent-cyan"
                />
                {t.library.kinds[k]}
              </label>
            ))}
          </fieldset>
        </>
      )}

      {result && (
        <div role="status" className="mb-3 flex flex-col gap-1.5 font-sans text-[12.5px] text-text-primary">
          <p className="flex items-center gap-2">
            <CircleCheck size={14} className="shrink-0 text-green" /> {t.library.importDone(result.bookmarks, result.history)}
          </p>
          {result.searchEngine && <p className="text-text-secondary">{t.library.importEngine(ENGINE_LABELS[result.searchEngine])}</p>}
          {result.errors.map((e) => (
            <p key={e.kind} className="flex items-start gap-2 text-text-secondary">
              <TriangleAlert size={13} className="mt-0.5 shrink-0 text-amber" /> {t.library.importFailed(t.library.kinds[e.kind])}
            </p>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="mb-3 font-sans text-[12px] text-danger">
          {error}
        </p>
      )}

      {sources && sources.length > 0 && (
        <p className="mb-4 flex items-start gap-2 rounded-md border border-hud/50 bg-surface/50 px-2.5 py-2 font-sans text-[11.5px] text-text-secondary">
          <KeyRound size={13} className="mt-0.5 shrink-0 text-text-muted" /> {t.library.importNote}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        {running && (
          <span className="mr-auto flex items-center gap-1.5 font-sans text-[12px] text-text-secondary">
            <Loader2 size={13} className="animate-spin text-cyan" /> {t.library.importing[step ?? kinds[0]]}
          </span>
        )}
        {result ? (
          <button type="button" onClick={onClose} className={`${dialogButton} border-cyan/50 text-cyan`}>
            {t.library.done}
          </button>
        ) : (
          <>
            <button type="button" disabled={running} onClick={onClose} className={dialogButton}>
              {t.common.cancel}
            </button>
            {source && (
              <button
                type="button"
                disabled={running || !kinds.length}
                onClick={() => void start()}
                className={`${dialogButton} border-cyan/50 text-cyan disabled:opacity-40`}
              >
                {t.library.importStart}
              </button>
            )}
          </>
        )}
      </div>
    </>
  )
}

/** The import as a dialog (browser menu, bookmark manager, settings). */
export function ImportDialog({ onClose }: { onClose(): void }) {
  const t = useT()
  useOverlay(true)
  const [busy, setBusy] = useState(false)
  return (
    <div
      role="dialog"
      aria-label={t.library.importTitle}
      className="fixed inset-0 z-60 flex justify-center bg-void/40 pt-[10vh]"
      onMouseDown={() => !busy && onClose()}
    >
      <div
        className="h-fit w-[min(480px,92vw)] rounded-lg border border-hud/70 bg-panel/95 p-4 shadow-2xl shadow-black/50 backdrop-blur-md"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <ImportPanel onClose={onClose} onBusy={setBusy} />
      </div>
    </div>
  )
}

/** The import as a step of the first-run setup (the onboarding's browser-import slot): done or skipped, it moves on. */
export function ImportStep({ next }: { next(): void }) {
  return (
    <section aria-label={useT().library.importTitle} className="w-full max-w-[480px]">
      <ImportPanel onClose={next} />
    </section>
  )
}
