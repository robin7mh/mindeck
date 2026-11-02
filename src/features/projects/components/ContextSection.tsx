import { useEffect, useState } from 'react'
import { ListTodo, Loader2, RefreshCw, ScanSearch } from 'lucide-react'
import { ipc, isDesktop } from '@shared/ipc/client'
import { TechLabel } from '@/components/ui/TechLabel'
import { relativeTime } from '@/features/agents/format'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useContextStore, useProjectContextEntry } from '@/features/context/store'

const chip = 'rounded-sm border border-hud/60 bg-elevated/40 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary'

/**
 * Project context (P3): the deterministic structural scan — files, config,
 * dependencies, README outline and TODO markers. The same data feeds the
 * assistant's context engine and its project_context tool.
 */
export function ContextSection({ projectId }: { projectId: string }) {
  const t = useT()
  const entry = useProjectContextEntry(projectId)
  const { load, reindex } = useContextStore.getState()
  const [showAllTodos, setShowAllTodos] = useState(false)
  const c = entry.context
  const desktop = isDesktop()

  useEffect(() => {
    void useContextStore.getState().load(projectId)
  }, [projectId])

  const todos = c ? (showAllTodos ? c.todos : c.todos.slice(0, 8)) : []
  const runtime = c?.dependencies.filter((d) => !d.dev) ?? []
  const dev = c?.dependencies.filter((d) => d.dev) ?? []

  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <TechLabel className="text-text-secondary">{t.projects.context}</TechLabel>
        {c && <span className="font-mono text-[10px] text-text-muted">{t.projects.indexed(relativeTime(c.indexedAt))}</span>}
        <button
          type="button"
          onClick={() => void reindex(projectId)}
          disabled={entry.indexing}
          className="ml-auto flex items-center gap-1.5 rounded-sm border border-hud/60 px-2 py-0.5 font-sans text-[11px] text-text-secondary hover:border-cyan/50 hover:text-cyan disabled:opacity-50"
        >
          {entry.indexing ? <Loader2 size={11} className="animate-spin" /> : c ? <RefreshCw size={11} /> : <ScanSearch size={11} />}
          {entry.indexing ? t.projects.scanning(entry.progress?.filesScanned) : c ? t.projects.reindex : t.projects.analyze}
        </button>
      </div>

      {entry.error && (
        <p className="font-mono text-[11px] text-danger">
          {entry.error}{' '}
          <button type="button" className="underline" onClick={() => void load(projectId)}>
            {t.projects.retry}
          </button>
        </p>
      )}
      {!c && !entry.indexing && !entry.error && (
        <p className="font-sans text-[12px] text-text-muted">
          {entry.loading ? t.common.loading : t.projects.notAnalyzed}
        </p>
      )}

      {c && (
        <div className="space-y-2 font-mono text-[12px] text-text-secondary">
          <p>
            {t.projects.counts(c.fileCount, c.dirCount, !!c.truncated)}
          </p>
          {c.readme && (
            <p className="font-sans text-[12px]">
              <span className="text-text-muted">README </span>
              {c.readme.title && <span className="text-text-primary">{c.readme.title}</span>}
              {c.readme.sections.length > 0 && <span className="text-text-muted"> · {c.readme.sections.slice(0, 6).join(' · ')}</span>}
            </p>
          )}
          {c.configFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {c.configFiles.map((f) => (
                <span key={f.name} className={chip} title={f.kind}>
                  {f.name}
                </span>
              ))}
            </div>
          )}
          {(runtime.length > 0 || dev.length > 0) && (
            <p className="font-sans text-[12px]">
              <span className="text-text-muted">{t.projects.dependencies} </span>
              {t.projects.depCounts(runtime.length, dev.length)}
              {runtime.length > 0 && <span className="text-text-muted"> — {runtime.slice(0, 8).map((d) => d.name).join(', ')}</span>}
            </p>
          )}
          {c.todos.length > 0 && (
            <div>
              <p className="mb-1 flex items-center gap-1.5 font-sans text-[12px] text-text-muted">
                <ListTodo size={12} /> {t.projects.markers(c.todos.length)}
              </p>
              <ul className="space-y-0.5">
                {todos.map((todo) => (
                  <li key={`${todo.file}:${todo.line}`} className="flex gap-2">
                    <span className={cn('shrink-0 text-[10px]', todo.kind === 'FIXME' || todo.kind === 'HACK' ? 'text-amber' : 'text-cyan')}>{todo.kind}</span>
                    {desktop ? (
                      <button
                        type="button"
                        title={t.projects.openInEditor}
                        onClick={() => void ipc('projects:openFile', { id: projectId, file: todo.file, line: todo.line }).catch(() => {})}
                        className="shrink-0 text-text-muted hover:text-cyan"
                      >
                        {todo.file}:{todo.line}
                      </button>
                    ) : (
                      <span className="shrink-0 text-text-muted">
                        {todo.file}:{todo.line}
                      </span>
                    )}
                    <span className="min-w-0 truncate">{todo.text}</span>
                  </li>
                ))}
              </ul>
              {c.todos.length > 8 && (
                <button type="button" onClick={() => setShowAllTodos(!showAllTodos)} className="mt-1 font-sans text-[11px] text-cyan hover:underline">
                  {showAllTodos ? t.projects.showFewer : t.projects.showAll(c.todos.length)}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
