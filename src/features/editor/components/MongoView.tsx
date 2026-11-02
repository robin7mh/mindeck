import { lazy, Suspense, useState } from 'react'
import { ChevronLeft, ChevronRight, KeyRound, Loader2, Pencil, Play, Plus, Table2, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useMongo, type MongoMode } from '../mongo'

const JsonEditor = lazy(() => import('./JsonEditor'))

const field = 'rounded-md border border-hud/60 bg-void/40 px-2 py-1 font-mono text-[12px] text-text-primary outline-hidden placeholder:text-text-muted focus:border-cyan/60'
const button = 'flex items-center gap-1 rounded-sm border px-2 py-0.5 font-sans text-[12px] transition-colors disabled:opacity-40'
const MODES: MongoMode[] = ['find', 'aggregate', 'indexes']

/** A document: collapsed to its first lines, editable, deletable (asked first). */
function Document({ text }: { text: string }) {
  const t = useT()
  const [confirm, setConfirm] = useState(false)
  const mongo = useMongo.getState()
  return (
    <li className="group relative rounded-md border border-hud/50 bg-void/30">
      <pre className="max-h-48 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-[1.45] text-text-secondary">{text}</pre>
      <div className="absolute right-1.5 top-1.5 hidden gap-1 group-hover:flex">
        <button type="button" aria-label={t.mongo.edit} title={t.mongo.edit} onClick={() => mongo.edit(text)} className="flex h-6 w-6 items-center justify-center rounded-sm bg-panel text-text-muted hover:text-text-primary">
          <Pencil size={12} />
        </button>
        <button type="button" aria-label={t.mongo.delete} title={t.mongo.delete} onClick={() => setConfirm(true)} className="flex h-6 w-6 items-center justify-center rounded-sm bg-panel text-text-muted hover:text-danger">
          <Trash2 size={12} />
        </button>
      </div>
      {confirm && (
        <div role="alertdialog" aria-label={t.mongo.confirmDelete} className="flex items-center gap-2 border-t border-danger/40 bg-danger/6 px-3 py-1.5">
          <span className="mr-auto font-sans text-[12px] text-text-primary">{t.mongo.confirmDelete}</span>
          <button type="button" onClick={() => void mongo.deleteDocument(text)} className={cn(button, 'border-danger/50 text-danger hover:bg-danger/10')}>
            {t.mongo.delete}
          </button>
          <button type="button" onClick={() => setConfirm(false)} className={cn(button, 'border-hud/60 text-text-secondary')}>
            {t.mongo.cancel}
          </button>
        </div>
      )}
    </li>
  )
}

/** The open collection in the editor area: find with filter / sort / paging, aggregations, indexes, editing documents as JSON. */
export function MongoView() {
  const t = useT()
  const { open, mode, filter, sort, limit, skip, pipeline, documents, total, indexes, editing, busy } = useMongo()
  const mongo = useMongo.getState()
  if (!open) return null
  const from = documents.length ? skip + 1 : 0
  const to = skip + documents.length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-hud/60 px-4 py-2">
        <Table2 size={15} className="shrink-0 text-cyan" />
        <h2 className="mr-3 truncate font-mono text-[13px] text-text-primary">
          {open.db}.{open.collection}
        </h2>
        <div role="group" aria-label={t.mongo.title} className="flex gap-0.5 rounded-md bg-void/40 p-0.5">
          {MODES.map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => mongo.setMode(m)} className={cn('rounded-sm px-2 py-0.5 font-sans text-[12px]', mode === m ? 'bg-elevated text-text-primary' : 'text-text-muted hover:text-text-primary')}>
              {t.mongo.modes[m]}
            </button>
          ))}
        </div>
        {busy && <Loader2 size={13} aria-label={t.common.loading} className="animate-spin text-text-muted" />}
        <button type="button" aria-label={t.mongo.close} title={t.mongo.close} onClick={() => mongo.close()} className="ml-auto flex h-6 w-6 items-center justify-center rounded-sm text-text-muted hover:bg-elevated hover:text-text-primary">
          <X size={14} />
        </button>
      </header>

      {editing ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-hud/60 px-4 py-1.5">
            <span className="mr-auto font-sans text-[12px] text-text-secondary">{editing.docId ? t.mongo.editing : t.mongo.newDocument}</span>
            <button type="button" disabled={busy} onClick={() => void mongo.saveEdit()} className={cn(button, 'border-cyan/50 text-cyan hover:bg-cyan/10')}>
              {t.mongo.save}
            </button>
            <button type="button" onClick={() => mongo.cancelEdit()} className={cn(button, 'border-hud/60 text-text-secondary')}>
              {t.mongo.cancel}
            </button>
          </div>
          <div className="relative min-h-0 flex-1">
            <Suspense fallback={<Loader2 size={16} className="m-4 animate-spin text-text-muted" />}>
              <JsonEditor key={editing.docId ?? 'new'} value={editing.text} onChange={(text) => mongo.setEditText(text)} onSave={() => void mongo.saveEdit()} />
            </Suspense>
          </div>
        </div>
      ) : mode === 'indexes' ? (
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-3">
          {indexes.map((i) => (
            <li key={i.name} className="flex items-center gap-2 font-mono text-[12px] text-text-secondary">
              <KeyRound size={12} className="shrink-0 text-amber" />
              <span className="text-text-primary">{i.name}</span>
              <span>{i.key}</span>
              {i.unique && <span className="rounded-sm bg-amber/10 px-1 font-sans text-[10.5px] text-amber">{t.mongo.unique}</span>}
            </li>
          ))}
          {!busy && indexes.length === 0 && <li className="font-sans text-[12px] text-text-muted">{t.mongo.noIndexes}</li>}
        </ul>
      ) : (
        <>
          <form
            className="flex flex-wrap items-start gap-2 border-b border-hud/60 px-4 py-2"
            onSubmit={(e) => {
              e.preventDefault()
              void mongo.run(0)
            }}
          >
            {mode === 'find' ? (
              <>
                <input aria-label={t.mongo.filter} placeholder={`${t.mongo.filter}  { "age": { "$gt": 30 } }`} value={filter} onChange={(e) => mongo.setQuery({ filter: e.target.value })} className={cn(field, 'min-w-[260px] flex-3')} />
                <input aria-label={t.mongo.sort} placeholder={`${t.mongo.sort}  { "_id": -1 }`} value={sort} onChange={(e) => mongo.setQuery({ sort: e.target.value })} className={cn(field, 'min-w-[140px] flex-1')} />
                <input aria-label={t.mongo.limit} type="number" min={1} max={1000} value={limit} onChange={(e) => mongo.setQuery({ limit: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })} className={cn(field, 'w-20')} />
              </>
            ) : (
              <textarea aria-label={t.mongo.pipeline} value={pipeline} onChange={(e) => mongo.setQuery({ pipeline: e.target.value })} rows={5} className={cn(field, 'min-w-[320px] flex-1 resize-y')} />
            )}
            <button type="submit" disabled={busy} className={cn(button, 'border-cyan/50 py-1 text-cyan hover:bg-cyan/10')}>
              <Play size={11} /> {t.mongo.run}
            </button>
            {mode === 'find' && (
              <button type="button" onClick={() => mongo.newDocument()} className={cn(button, 'border-hud/60 py-1 text-text-secondary hover:text-text-primary')}>
                <Plus size={12} /> {t.mongo.insert}
              </button>
            )}
          </form>
          <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
            {documents.map((d, i) => (
              <Document key={`${skip}-${i}-${d.length}`} text={d} />
            ))}
            {!busy && documents.length === 0 && <li className="font-sans text-[12px] text-text-muted">{t.mongo.none}</li>}
          </ul>
          {mode === 'find' && (
            <footer className="flex items-center justify-end gap-2 border-t border-hud/60 px-4 py-1 font-mono text-[11px] text-text-muted">
              {t.mongo.range(from, to, total)}
              <button type="button" aria-label={t.mongo.prev} disabled={busy || skip === 0} onClick={() => void mongo.run(Math.max(0, skip - limit))} className="rounded-sm p-0.5 hover:bg-elevated hover:text-text-primary disabled:opacity-40">
                <ChevronLeft size={13} />
              </button>
              <button type="button" aria-label={t.mongo.next} disabled={busy || to >= total} onClick={() => void mongo.run(skip + limit)} className="rounded-sm p-0.5 hover:bg-elevated hover:text-text-primary disabled:opacity-40">
                <ChevronRight size={13} />
              </button>
            </footer>
          )}
        </>
      )}
    </div>
  )
}
