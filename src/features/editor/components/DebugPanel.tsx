import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronRight,
  CircleDot,
  FileCode2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Square,
  StepForward,
  Trash2,
  X
} from 'lucide-react'
import type { DebugVariable } from '@shared/types/debug'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useEditor } from '../store'
import { useDebug } from '../debug'

const tool = 'flex h-7 w-7 items-center justify-center rounded-sm text-text-secondary transition-colors hover:bg-elevated hover:text-text-primary disabled:opacity-40'
const field = 'w-full rounded-md border border-hud/60 bg-surface/50 px-2 py-1 font-mono text-[12px] text-text-primary outline-hidden placeholder:text-text-muted focus:border-cyan/50'

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-hud/50">
      <header className="flex items-center gap-1 px-2 pb-0.5 pt-1.5">
        <h3 className="mr-auto font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">{title}</h3>
        {right}
      </header>
      <div className="px-1 pb-1.5">{children}</div>
    </section>
  )
}

/** One variable; objects expand into their properties (loaded when opened). */
function Variable({ v, path, depth }: { v: DebugVariable; path: string; depth: number }) {
  const open = useDebug((s) => !!s.expanded[path])
  const children = useDebug((s) => (v.objectId ? s.vars[v.objectId] : undefined))
  return (
    <>
      <button
        type="button"
        title={`${v.name}: ${v.value}`}
        disabled={!v.objectId}
        aria-expanded={v.objectId ? open : undefined}
        onClick={() => void useDebug.getState().toggleVariable(path, v.objectId!)}
        style={{ paddingLeft: 4 + depth * 12 }}
        className="flex w-full items-center gap-1 rounded-sm py-px pr-2 text-left font-mono text-[11.5px] hover:bg-elevated/50 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <ChevronRight size={11} className={cn('shrink-0 text-text-muted transition-transform', !v.objectId && 'invisible', open && 'rotate-90')} />
        <span className={cn('shrink-0', v.type === 'scope' ? 'font-sans text-[11.5px] text-text-secondary' : 'text-cyan/90')}>{v.name}</span>
        {v.type !== 'scope' && (
          <>
            <span className="text-text-muted">:</span>
            <span className={cn('min-w-0 truncate', v.type === 'string' ? 'text-amber/90' : v.type === 'error' ? 'text-danger' : 'text-text-secondary')}>{v.value}</span>
          </>
        )}
      </button>
      {open && children?.map((c) => <Variable key={c.name} v={c} path={`${path}/${c.name}`} depth={depth + 1} />)}
    </>
  )
}

/**
 * VS Code's Run and Debug view: what to run, the controls, and — while
 * paused — variables, watch expressions and the call stack; breakpoints
 * always.
 */
export function DebugPanel() {
  const t = useT()
  const d = t.debug
  const projectId = useEditor((s) => s.projectId)!
  const shown = useEditor((s) => s.tabs.find((x) => x.id === s.focusedId()))
  const { session, frame, breakpoints, program, args, build, watches, watchValues, stopOnEntry, error } = useDebug()
  const [watchInput, setWatchInput] = useState('')
  const [showInternal, setShowInternal] = useState(false)
  const debug = useDebug.getState()
  const active = !!session && session.status !== 'exited' && session.projectId === projectId
  const paused = active && session.status === 'paused'
  const frames = paused ? session.frames : []
  const scopes = frames[frame]?.scopes.filter((s) => s.objectId) ?? []
  const own = breakpoints[projectId] ?? []
  const internal = frames.filter((f) => !f.path).length

  // Like VS Code: the innermost scope of the selected frame is open right away.
  const first = scopes[0]
  const auto = useRef<string>()
  useEffect(() => {
    const key = `${frames[frame]?.id}:${first?.objectId}`
    if (!first || auto.current === key) return
    auto.current = key
    if (!useDebug.getState().expanded[`${frame}:0`]) void useDebug.getState().toggleVariable(`${frame}:0`, first.objectId!)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per selected frame and scope (the key), not per new array
  }, [frames[frame]?.id, first?.objectId])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="space-y-1.5 px-2 pb-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">{d.title}</p>
        {!active ? (
          <>
            <label className="block space-y-0.5">
              <span className="font-sans text-[11px] text-text-secondary">{d.program}</span>
              <div className="flex gap-1">
                <input
                  aria-label={d.program}
                  placeholder={shown?.projectId === projectId ? shown.path : d.programHint}
                  value={program[projectId] ?? ''}
                  onChange={(e) => debug.setProgram(projectId, e.target.value)}
                  className={field}
                />
                <button
                  type="button"
                  aria-label={d.useCurrent}
                  title={d.useCurrent}
                  disabled={shown?.projectId !== projectId}
                  onClick={() => debug.setProgram(projectId, shown!.path)}
                  className={cn(tool, 'shrink-0 border border-hud/60')}
                >
                  <FileCode2 size={13} />
                </button>
              </div>
            </label>
            <label className="block space-y-0.5">
              <span className="font-sans text-[11px] text-text-secondary">{d.args}</span>
              <input aria-label={d.args} placeholder="--port 3000" value={args[projectId] ?? ''} onChange={(e) => debug.setArgs(projectId, e.target.value)} className={field} />
            </label>
            <label className="block space-y-0.5">
              <span className="font-sans text-[11px] text-text-secondary">{d.build}</span>
              <input aria-label={d.build} placeholder={d.buildHint} value={build[projectId] ?? ''} onChange={(e) => debug.setBuild(projectId, e.target.value)} className={cn(field, 'font-mono')} />
            </label>
            <label className="flex items-center gap-1.5 font-sans text-[11.5px] text-text-secondary">
              <input type="checkbox" checked={stopOnEntry} onChange={(e) => debug.setStopOnEntry(e.target.checked)} className="accent-cyan" />
              {d.stopOnEntry}
            </label>
            <button
              type="button"
              onClick={() => void debug.start()}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-cyan/40 bg-cyan/8 py-1.5 font-sans text-[12.5px] font-medium text-cyan hover:bg-cyan/[0.14]"
            >
              <Play size={13} /> {d.start} <span className="font-mono text-[10.5px] opacity-70">F5</span>
            </button>
            <p className="font-sans text-[10.5px] leading-snug text-text-muted">{d.nodeHint}</p>
          </>
        ) : (
          <div role="toolbar" aria-label={d.title} className="flex items-center gap-0.5 rounded-md border border-hud/60 bg-surface/40 p-0.5">
            {paused ? (
              <button type="button" aria-label={d.continue} title={`${d.continue} (F5)`} className={cn(tool, 'text-cyan')} onClick={() => void debug.control('continue')}>
                <Play size={14} />
              </button>
            ) : (
              <button type="button" aria-label={d.pause} title={`${d.pause} (F6)`} className={tool} disabled={session.status === 'starting'} onClick={() => void debug.control('pause')}>
                <Pause size={14} />
              </button>
            )}
            <button type="button" aria-label={d.stepOver} title={`${d.stepOver} (F10)`} className={tool} disabled={!paused} onClick={() => void debug.control('stepOver')}>
              <StepForward size={14} />
            </button>
            <button type="button" aria-label={d.stepInto} title={`${d.stepInto} (F11)`} className={tool} disabled={!paused} onClick={() => void debug.control('stepInto')}>
              <ArrowDownToLine size={14} />
            </button>
            <button type="button" aria-label={d.stepOut} title={`${d.stepOut} (⇧F11)`} className={tool} disabled={!paused} onClick={() => void debug.control('stepOut')}>
              <ArrowUpFromLine size={14} />
            </button>
            <button type="button" aria-label={d.restart} title={`${d.restart} (⇧⌘F5)`} className={tool} onClick={() => void debug.restart()}>
              <RotateCcw size={13} />
            </button>
            <button type="button" aria-label={d.stop} title={`${d.stop} (⇧F5)`} className={cn(tool, 'text-danger')} onClick={() => void debug.stop()}>
              <Square size={13} />
            </button>
          </div>
        )}
        {session?.projectId === projectId && (
          <p role="status" className={cn('font-sans text-[11.5px]', paused ? 'text-amber' : 'text-text-secondary')}>
            {session.status === 'paused' ? d.paused(d.reasons[session.reason as keyof typeof d.reasons] ?? session.reason ?? '') : session.status === 'exited' ? d.exited(session.exitCode ?? null) : d[session.status]}
          </p>
        )}
        {session?.exception && session.projectId === projectId && paused && <p className="whitespace-pre-wrap rounded-sm bg-danger/10 px-2 py-1 font-mono text-[11px] text-danger">{session.exception}</p>}
        {error && (
          <p role="alert" className="flex items-start gap-1 rounded-sm bg-danger/10 px-2 py-1 font-sans text-[11.5px] text-danger">
            <span className="flex-1">{error === 'no-program' ? d.noProgram : error}</span>
            <button type="button" aria-label={t.common.dismiss} onClick={() => debug.clearError()}>
              <X size={12} />
            </button>
          </p>
        )}
      </div>

      {paused && (
        <>
          <Section title={d.variables}>
            {scopes.map((s, i) => (
              <Variable key={`${frame}:${i}`} v={{ name: d.scope(s.type, s.name), value: '', type: 'scope', objectId: s.objectId }} path={`${frame}:${i}`} depth={0} />
            ))}
          </Section>
          <Section title={d.callStack}>
            <ul>
              {frames.map((f, i) =>
                !f.path && !showInternal ? null : (
                <li key={f.id}>
                  <button
                    type="button"
                    aria-current={i === frame}
                    onClick={() => debug.selectFrame(i)}
                    className={cn('flex w-full items-baseline gap-2 rounded-sm px-2 py-px text-left hover:bg-elevated/50', i === frame && 'bg-cyan/8', !f.path && 'opacity-60')}
                  >
                    <span className="min-w-0 truncate font-mono text-[11.5px] text-text-primary">{f.name}</span>
                    <span className="ml-auto shrink-0 truncate font-mono text-[10.5px] text-text-muted">
                      {f.path ? `${f.path.slice(f.path.lastIndexOf('/') + 1)}:${f.line}` : d.internal}
                    </span>
                  </button>
                </li>
                )
              )}
              {internal > 0 && (
                <li>
                  <button type="button" onClick={() => setShowInternal(!showInternal)} className="px-2 font-sans text-[11px] text-text-muted hover:text-text-primary">
                    {showInternal ? d.hideInternal : d.showInternal(internal)}
                  </button>
                </li>
              )}
            </ul>
          </Section>
        </>
      )}

      <Section title={d.watch}>
        {watches.map((w) => (
          <div key={w} className="group flex items-center">
            <div className="min-w-0 flex-1">
              <Variable v={watchValues[w] && paused ? { ...watchValues[w], name: w } : { name: w, value: paused ? '…' : d.notPaused, type: 'watch' }} path={`watch:${w}`} depth={0} />
            </div>
            <button type="button" aria-label={`${t.common.remove} ${w}`} onClick={() => debug.removeWatch(w)} className="hidden px-1 text-text-muted hover:text-danger group-hover:block">
              <X size={11} />
            </button>
          </div>
        ))}
        <form
          className="flex items-center gap-1 px-1 pt-0.5"
          onSubmit={(e) => {
            e.preventDefault()
            debug.addWatch(watchInput)
            setWatchInput('')
          }}
        >
          <Plus size={11} className="shrink-0 text-text-muted" />
          <input aria-label={d.addWatch} placeholder={d.addWatch} value={watchInput} onChange={(e) => setWatchInput(e.target.value)} className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-text-primary outline-hidden placeholder:text-text-muted" />
        </form>
      </Section>

      <Section
        title={d.breakpoints}
        right={
          own.length > 0 && (
            <button type="button" aria-label={d.removeAll} title={d.removeAll} onClick={() => debug.clearBreakpoints(projectId)} className="text-text-muted hover:text-danger">
              <Trash2 size={11} />
            </button>
          )
        }
      >
        {!own.length && <p className="px-2 font-sans text-[11px] text-text-muted">{d.noBreakpoints}</p>}
        <ul>
          {own.map((b) => (
            <li key={`${b.path}:${b.line}`} className="group flex items-center">
              <button type="button" onClick={() => void useEditor.getState().openAt(b.path, b.line)} className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-2 py-px text-left hover:bg-elevated/50">
                <CircleDot size={10} className="shrink-0 text-danger" />
                <span className="min-w-0 truncate font-mono text-[11.5px] text-text-primary">{b.path.slice(b.path.lastIndexOf('/') + 1)}</span>
                <span className="ml-auto font-mono text-[10.5px] text-text-muted">{b.line}</span>
              </button>
              <button type="button" aria-label={`${t.common.remove} ${b.path}:${b.line}`} onClick={() => debug.removeBreakpoint(projectId, b)} className="hidden px-1 text-text-muted hover:text-danger group-hover:block">
                <X size={11} />
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  )
}

/** The debug console: the program's output, and expressions evaluated in the selected frame. */
export function DebugConsole() {
  const t = useT()
  const d = t.debug
  const lines = useDebug((s) => s.console)
  const [input, setInput] = useState('')
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [lines])

  return (
    <div className="flex h-44 shrink-0 flex-col border-t border-hud/60 bg-surface/30">
      <header className="flex items-center gap-2 px-3 py-1">
        <h3 className="mr-auto font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">{d.console}</h3>
        <button type="button" aria-label={d.clear} title={d.clear} onClick={() => useDebug.getState().clearConsole()} className="text-text-muted hover:text-text-primary">
          <Trash2 size={11} />
        </button>
        <button type="button" aria-label={t.common.close} title={t.common.close} onClick={() => useDebug.getState().setConsoleOpen(false)} className="text-text-muted hover:text-text-primary">
          <X size={12} />
        </button>
      </header>
      <div role="log" aria-label={d.console} className="min-h-0 flex-1 overflow-y-auto px-3 font-mono text-[11.5px] leading-[1.45]">
        {lines.map((l) => (
          <pre
            key={l.id}
            className={cn(
              'whitespace-pre-wrap wrap-break-word',
              l.kind === 'stderr' || l.kind === 'error' ? 'text-danger' : l.kind === 'info' ? 'text-text-muted' : l.kind === 'input' ? 'text-cyan' : 'text-text-primary'
            )}
          >
            {l.kind === 'input' ? `› ${l.text}` : l.text}
          </pre>
        ))}
        <div ref={end} />
      </div>
      <form
        className="flex items-center gap-1.5 border-t border-hud/40 px-3 py-1"
        onSubmit={(e) => {
          e.preventDefault()
          void useDebug.getState().evaluate(input)
          setInput('')
        }}
      >
        <span className="font-mono text-[11px] text-cyan">›</span>
        <input aria-label={d.evaluate} placeholder={d.evaluate} value={input} onChange={(e) => setInput(e.target.value)} className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-text-primary outline-hidden placeholder:text-text-muted" />
      </form>
    </div>
  )
}
