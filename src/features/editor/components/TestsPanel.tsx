import { useEffect } from 'react'
import { Bug, ChevronRight, CircleCheck, CircleDashed, CircleMinus, CircleX, Filter, FlaskConical, Loader2, Play, RefreshCw, Square, TerminalSquare, X } from 'lucide-react'
import type { TestItem, TestResult } from '@shared/types/tests'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { stateOf, summary, useTests } from '../tests'

const tool = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-elevated hover:text-text-primary disabled:opacity-40'

function StateIcon({ state }: { state?: TestResult['state'] }) {
  const t = useT()
  if (state === 'running') return <Loader2 size={12} aria-label={t.tests.states.running} className="shrink-0 animate-spin text-cyan" />
  if (state === 'passed') return <CircleCheck size={12} aria-label={t.tests.states.passed} className="shrink-0 text-green" />
  if (state === 'failed') return <CircleX size={12} aria-label={t.tests.states.failed} className="shrink-0 text-danger" />
  if (state === 'skipped') return <CircleMinus size={12} aria-label={t.tests.states.skipped} className="shrink-0 text-text-muted" />
  return <CircleDashed size={12} aria-label={t.tests.states.none} className="shrink-0 text-text-muted/60" />
}

/** Does a row (or something under it) belong in the "failed only" view? */
const failedBelow = (item: TestItem, results: Record<string, TestResult>) => stateOf(item, results) === 'failed'

function Row({ item, depth }: { item: TestItem; depth: number }) {
  const t = useT()
  const results = useTests((s) => s.run?.results ?? {})
  const open = useTests((s) => !!s.expanded[item.id])
  const failedOnly = useTests((s) => s.failedOnly)
  const showDetails = useTests((s) => !!s.details[item.id])
  const busy = useTests((s) => !!s.run?.running)
  const tests = useTests.getState()
  const state = stateOf(item, results)
  const result = results[item.id]
  if (failedOnly && !failedBelow(item, results)) return null
  return (
    <li>
      <div className="group flex items-center gap-1 rounded-sm pr-1 hover:bg-elevated/60" style={{ paddingLeft: 4 + depth * 12 }}>
        {item.children ? (
          <button type="button" aria-label={open ? t.tests.collapse(item.name) : t.tests.expand(item.name)} onClick={() => tests.toggle(item.id)} className="text-text-muted">
            <ChevronRight size={12} className={cn('transition-transform', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="w-3" />
        )}
        <StateIcon state={state} />
        <button
          type="button"
          title={item.kind === 'file' ? item.path : `${item.path}:${item.line}`}
          onClick={() => (result?.message ? tests.toggleDetails(item.id) : tests.reveal(item))}
          onDoubleClick={() => tests.reveal(item)}
          className={cn('min-w-0 flex-1 truncate py-[3px] text-left font-sans text-[12.5px]', item.kind === 'file' ? 'font-mono text-[11.5px] text-text-secondary' : 'text-text-primary')}
        >
          {item.name}
        </button>
        {result?.durationMs !== undefined && item.kind === 'test' && <span className="shrink-0 font-mono text-[10px] text-text-muted">{Math.round(result.durationMs)} ms</span>}
        <button type="button" aria-label={t.tests.run(item.name)} title={t.tests.runOne} disabled={busy} onClick={() => void tests.runTests(item.id)} className={cn(tool, 'hidden group-hover:flex')}>
          <Play size={11} />
        </button>
        <button type="button" aria-label={t.tests.debug(item.name)} title={t.tests.debugOne} disabled={busy} onClick={() => void tests.debugTest(item.id)} className={cn(tool, 'hidden group-hover:flex')}>
          <Bug size={11} />
        </button>
      </div>
      {showDetails && result?.message && (
        <pre role="note" className="mx-2 my-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-sm border border-danger/30 bg-danger/6 px-2 py-1 font-mono text-[11px] text-text-secondary" style={{ marginLeft: 20 + depth * 12 }}>
          {result.message}
        </pre>
      )}
      {item.children && open && (
        <ul>
          {item.children.map((c) => (
            <Row key={c.id} item={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

/** VS Code's Testing view: the project's tests, run or debug one or all, what failed and why. */
export function TestsPanel() {
  const t = useT()
  const { items, loaded, loading, run, failedOnly, showOutput, error } = useTests()
  const tests = useTests.getState()
  const counts = summary(items, run?.results ?? {})

  useEffect(() => {
    if (!useTests.getState().loaded) void useTests.getState().discover()
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1.5 px-2 pb-2">
        <div className="flex items-center gap-0.5">
          <p className="mr-auto font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">{t.tests.title}</p>
          {run?.running ? (
            <button type="button" aria-label={t.tests.stop} title={t.tests.stop} onClick={() => void tests.cancel()} className={tool}>
              <Square size={11} />
            </button>
          ) : (
            <button type="button" aria-label={t.tests.runAll} title={t.tests.runAll} disabled={!items.length} onClick={() => void tests.runTests()} className={tool}>
              <Play size={12} />
            </button>
          )}
          <button type="button" aria-label={t.tests.refresh} title={t.tests.refresh} disabled={loading} onClick={() => void tests.discover()} className={tool}>
            <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
          </button>
          <button type="button" aria-label={t.tests.failedOnly} title={t.tests.failedOnly} aria-pressed={failedOnly} onClick={() => tests.setFailedOnly(!failedOnly)} className={cn(tool, failedOnly && 'text-cyan')}>
            <Filter size={12} />
          </button>
          <button type="button" aria-label={t.tests.output} title={t.tests.output} aria-pressed={showOutput} onClick={() => tests.setShowOutput(!showOutput)} className={cn(tool, showOutput && 'text-cyan')}>
            <TerminalSquare size={12} />
          </button>
        </div>
        {counts.total > 0 && (
          <p className="flex flex-wrap gap-x-2 whitespace-nowrap font-mono text-[10.5px] text-text-muted">
            <span className="text-green">{t.tests.passed(counts.passed)}</span>
            {counts.failed > 0 && <span className="text-danger">{t.tests.failed(counts.failed)}</span>}
            {counts.skipped > 0 && <span>{t.tests.skipped(counts.skipped)}</span>}
            <span>{t.tests.total(counts.total)}</span>
          </p>
        )}
        {error && (
          <p role="alert" className="flex items-start gap-1 rounded-sm bg-danger/10 px-2 py-1 font-sans text-[11.5px] text-danger">
            <span className="flex-1 whitespace-pre-wrap">{error}</span>
            <button type="button" aria-label={t.common.dismiss} onClick={() => tests.clearError()}>
              <X size={12} />
            </button>
          </p>
        )}
      </div>
      <ul role="tree" aria-label={t.tests.title} className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {items.map((item) => (
          <Row key={item.id} item={item} depth={0} />
        ))}
        {loaded && !loading && !items.length && (
          <li className="space-y-1 px-2 font-sans text-[12px] text-text-muted">
            <FlaskConical size={18} className="text-text-muted" />
            <p>{t.tests.none}</p>
          </li>
        )}
      </ul>
      {showOutput && (
        <pre aria-label={t.tests.output} className="max-h-[40%] min-h-[80px] overflow-auto border-t border-hud/60 bg-void/40 px-2 py-1 font-mono text-[10.5px] leading-[1.45] text-text-secondary">
          {run?.output || t.tests.noOutput}
        </pre>
      )}
    </div>
  )
}
