import { useEffect, useState } from 'react'
import { ChevronRight, Database, Loader2, Plug, Plus, Table2, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useMongo } from '../mongo'

const row = 'flex w-full min-w-0 items-center gap-1.5 rounded-sm py-[3px] pr-2 text-left font-sans text-[12.5px] text-text-secondary transition-colors hover:bg-elevated/60 hover:text-text-primary'
const tool = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-elevated hover:text-text-primary disabled:opacity-40'
const field = 'w-full rounded-md border border-hud/60 bg-void/40 px-2 py-1 font-sans text-[12.5px] text-text-primary outline-hidden placeholder:text-text-muted focus:border-cyan/60'
const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

function AddConnection() {
  const t = useT()
  const busy = useMongo((s) => s.busy)
  const [name, setName] = useState('')
  const [uri, setUri] = useState('')
  return (
    <form
      aria-label={t.mongo.add}
      className="space-y-1.5 px-2 pb-2"
      onSubmit={(e) => {
        e.preventDefault()
        void useMongo.getState().add(name, uri)
      }}
    >
      <input aria-label={t.mongo.name} placeholder={t.mongo.name} value={name} onChange={(e) => setName(e.target.value)} className={field} />
      <input aria-label={t.mongo.uri} placeholder={t.mongo.uriHint} value={uri} onChange={(e) => setUri(e.target.value)} type="password" autoComplete="off" className={cn(field, 'font-mono')} />
      <div className="flex gap-1.5">
        <button type="submit" disabled={!uri.trim() || busy} className="flex items-center gap-1 rounded-sm border border-cyan/50 px-2 py-0.5 font-sans text-[12px] text-cyan hover:bg-cyan/10 disabled:opacity-40">
          {busy && <Loader2 size={11} className="animate-spin" />}
          {t.mongo.connect}
        </button>
        <button type="button" onClick={() => useMongo.getState().setAdding(false)} className="rounded-sm border border-hud/60 px-2 py-0.5 font-sans text-[12px] text-text-secondary">
          {t.mongo.cancel}
        </button>
      </div>
    </form>
  )
}

/** A database: its collections, a new one, deleting one (asked first). */
function DatabaseRow({ id, db, info }: { id: string; db: string; info: string }) {
  const t = useT()
  const key = `${id}/${db}`
  const open = useMongo((s) => !!s.expanded[key])
  const collections = useMongo((s) => s.collections[key])
  const current = useMongo((s) => s.open)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [dropping, setDropping] = useState<string>()
  const mongo = useMongo.getState()
  return (
    <div>
      <div className="group flex items-center">
        <button type="button" role="treeitem" aria-expanded={open} onClick={() => void mongo.toggle(key)} className={cn(row, 'pl-5')}>
          <ChevronRight size={12} className={cn('shrink-0 text-text-muted transition-transform', open && 'rotate-90')} />
          <Database size={12} className="shrink-0 text-cyan/70" />
          <span className="truncate">{db}</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-text-muted">{info}</span>
        </button>
        <button type="button" aria-label={`${t.mongo.newCollection} (${db})`} title={t.mongo.newCollection} onClick={() => setNaming(true)} className={cn(tool, 'hidden group-hover:flex')}>
          <Plus size={12} />
        </button>
      </div>
      {naming && (
        <form
          className="flex gap-1 py-1 pl-9 pr-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            setNaming(false)
            setName('')
            void mongo.createCollection(id, db, name.trim())
          }}
        >
          <input autoFocus aria-label={t.mongo.collectionName} placeholder={t.mongo.collectionName} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setNaming(false)} className={cn(field, 'py-0.5 font-mono text-[12px]')} />
          <button type="submit" className="rounded-sm border border-cyan/50 px-1.5 font-sans text-[11.5px] text-cyan">
            {t.mongo.create}
          </button>
        </form>
      )}
      {open && !collections && <Loader2 size={12} aria-label={t.common.loading} className="ml-10 animate-spin text-text-muted" />}
      {open &&
        collections?.map((c) => {
          const active = current?.id === id && current.db === db && current.collection === c.name
          return (
            <div key={c.name}>
              <div className="group flex items-center">
                <button type="button" role="treeitem" aria-current={active || undefined} onClick={() => void mongo.openCollection({ id, db, collection: c.name })} className={cn(row, 'pl-12', active && 'bg-cyan/8 text-text-primary')}>
                  <Table2 size={12} className="shrink-0 text-text-muted" />
                  <span className="truncate">{c.name}</span>
                  {c.type !== 'collection' && <span className="ml-auto shrink-0 font-mono text-[10px] text-text-muted">{c.type}</span>}
                </button>
                <button type="button" aria-label={t.mongo.drop(c.name)} title={t.mongo.drop(c.name)} onClick={() => setDropping(c.name)} className={cn(tool, 'hidden group-hover:flex')}>
                  <Trash2 size={11} />
                </button>
              </div>
              {dropping === c.name && (
                <div role="alertdialog" aria-label={t.mongo.drop(c.name)} className="mx-2 my-1 space-y-1.5 rounded-md border border-danger/40 bg-danger/6 p-2">
                  <p className="font-sans text-[12px] text-text-primary">{t.mongo.confirmDrop(c.name)}</p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setDropping(undefined)
                        void mongo.dropCollection({ id, db, collection: c.name })
                      }}
                      className="rounded-sm border border-danger/50 px-2 py-0.5 font-sans text-[12px] text-danger hover:bg-danger/10"
                    >
                      {t.mongo.delete}
                    </button>
                    <button type="button" onClick={() => setDropping(undefined)} className="rounded-sm border border-hud/60 px-2 py-0.5 font-sans text-[12px] text-text-secondary">
                      {t.mongo.cancel}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
    </div>
  )
}

/** The MongoDB for VS Code extension's explorer: connections → databases → collections. */
export function MongoPanel() {
  const t = useT()
  const { connections, expanded, databases, adding } = useMongo()
  const mongo = useMongo.getState()

  useEffect(() => {
    void useMongo.getState().load()
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center px-2 pb-2">
        <p className="mr-auto font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">{t.mongo.title}</p>
        <button type="button" aria-label={t.mongo.add} title={t.mongo.add} onClick={() => mongo.setAdding(!adding)} className={tool}>
          <Plus size={13} />
        </button>
      </div>
      {adding && <AddConnection />}
      {connections.length === 0 && !adding && (
        <div className="space-y-1 px-2 font-sans text-[12px] text-text-secondary">
          <p className="text-text-primary">{t.mongo.empty}</p>
          <p>{t.mongo.emptyHint}</p>
        </div>
      )}
      <div role="tree" aria-label={t.mongo.title} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {connections.map((c) => (
          <div key={c.id}>
            <div className="group flex items-center">
              <button type="button" role="treeitem" aria-expanded={!!expanded[c.id]} title={c.host} onClick={() => void mongo.toggle(c.id)} className={cn(row, 'pl-1')}>
                <ChevronRight size={12} className={cn('shrink-0 text-text-muted transition-transform', expanded[c.id] && 'rotate-90')} />
                <Plug size={12} className="shrink-0 text-green" />
                <span className="truncate">{c.name}</span>
              </button>
              <button type="button" aria-label={t.mongo.remove(c.name)} title={t.mongo.remove(c.name)} onClick={() => void mongo.remove(c.id)} className={cn(tool, 'hidden group-hover:flex')}>
                <X size={12} />
              </button>
            </div>
            {expanded[c.id] && !databases[c.id] && <Loader2 size={12} aria-label={t.common.loading} className="ml-6 animate-spin text-text-muted" />}
            {expanded[c.id] && databases[c.id]?.map((d) => <DatabaseRow key={d.name} id={c.id} db={d.name} info={d.empty ? '–' : size(d.sizeOnDisk)} />)}
          </div>
        ))}
      </div>
    </div>
  )
}
