import { Component, Fragment, useState, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, Check, Copy, RotateCcw } from 'lucide-react'
import { ipc, isDesktop } from '@shared/ipc/client'
import type { RendererError } from '@shared/types/desktop'
import { Panel } from '@/components/ui/Panel'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'

/** Hands an error to the desktop app's log (desktop: over IPC; a browser: the console). */
export function reportError(report: RendererError): void {
  if (isDesktop()) void ipc('desktop:reportError', report).catch(() => {})
  else console.error(`[${report.module ?? report.kind}]`, report.message, report.stack ?? '')
}

const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)))

/**
 * Uncaught errors and promise rejections anywhere in the UI go to the log as
 * well. Returns the function that stops listening.
 */
export function installErrorReporting(target: Window = window): () => void {
  const onError = (e: ErrorEvent) => {
    const err = toError(e.error ?? e.message)
    reportError({ kind: 'error', message: err.message, stack: err.stack })
  }
  const onRejection = (e: PromiseRejectionEvent) => {
    const err = toError(e.reason)
    reportError({ kind: 'rejection', message: err.message, stack: err.stack })
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}

const button =
  'flex items-center justify-center gap-1.5 rounded-md border border-hud/60 px-2.5 py-1.5 font-sans text-[12px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan'

/** What crashed, how to get it back, and the details to copy into a bug report. */
function CrashPanel({ title, intro, action, onAction, details }: { title: string; intro: string; action: string; onAction: () => void; details: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard
      ?.writeText(details)
      .then(() => setCopied(true))
      .catch(() => {})
  }
  return (
    <Panel title={title} corners className="min-h-0 flex-1" bodyClassName="flex items-center justify-center overflow-y-auto">
      <div role="alert" className="flex w-full max-w-xl flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle size={22} className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0">
            <p className="font-sans text-[14px] font-semibold text-text-primary">{title}</p>
            <p className="mt-1 font-sans text-[13px] leading-relaxed text-text-secondary">{intro}</p>
            {isDesktop() && <p className="mt-1 font-sans text-[11.5px] text-text-muted">{t.stability.reported}</p>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onAction} className={cn(button, 'border-cyan/50 text-cyan')}>
            <RotateCcw size={13} /> {action}
          </button>
          <button type="button" onClick={copy} className={button}>
            {copied ? <Check size={13} className="text-green" /> : <Copy size={13} />} {copied ? t.stability.copied : t.stability.copyDetails}
          </button>
        </div>
        <details className="rounded-md border border-hud/60 bg-surface/40">
          <summary className="cursor-pointer px-2.5 py-1.5 font-mono text-[11px] text-text-muted">{t.stability.details}</summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap wrap-break-word px-2.5 pb-2 font-mono text-[10.5px] text-text-secondary">{details}</pre>
        </details>
      </div>
    </Panel>
  )
}

interface Caught {
  error: Error
  componentStack: string
}

const detailsOf = (c: Caught) => [`${c.error.name}: ${c.error.message}`, c.error.stack, c.componentStack && `Component stack:${c.componentStack}`].filter(Boolean).join('\n\n')

/** Shared state of both boundaries: what was caught, reported once. */
abstract class Boundary<P extends { children: ReactNode }> extends Component<P, { caught: Caught | null; generation: number }> {
  state = { caught: null as Caught | null, generation: 0 }

  static getDerivedStateFromError(error: unknown) {
    return { caught: { error: toError(error), componentStack: '' } }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const caught = { error: toError(error), componentStack: info.componentStack ?? '' }
    this.setState({ caught })
    reportError(this.report(caught))
  }

  protected abstract report(caught: Caught): RendererError
}

/**
 * One module (Agents, Editor, …) that throws while rendering shows a panel
 * instead of taking the whole window down: the rest of Mindeck keeps running.
 * "Reload module" mounts it afresh.
 */
export class ModuleBoundary extends Boundary<{ id: string; name: string; children: ReactNode }> {
  protected report(c: Caught): RendererError {
    return { kind: 'module', module: this.props.id, message: c.error.message, stack: c.error.stack, componentStack: c.componentStack }
  }

  private retry = () => this.setState((s) => ({ caught: null, generation: s.generation + 1 }))

  render() {
    const { caught, generation } = this.state
    // A new key after "Reload module" mounts the module's tree from scratch.
    if (!caught) return <Fragment key={generation}>{this.props.children}</Fragment>
    return <ModuleCrash name={this.props.name} details={detailsOf(caught)} onRetry={this.retry} />
  }
}

function ModuleCrash({ name, details, onRetry }: { name: string; details: string; onRetry: () => void }) {
  const t = useT()
  return <CrashPanel title={t.stability.moduleTitle} intro={t.stability.moduleIntro(name)} action={t.stability.reloadModule} onAction={onRetry} details={details} />
}

/** The last line of defence around the whole UI: the window reloads, the core never stopped. */
export class AppBoundary extends Boundary<{ children: ReactNode; reload?: () => void }> {
  protected report(c: Caught): RendererError {
    return { kind: 'app', message: c.error.message, stack: c.error.stack, componentStack: c.componentStack }
  }

  render() {
    const { caught } = this.state
    if (!caught) return this.props.children
    return <AppCrash details={detailsOf(caught)} reload={this.props.reload ?? (() => location.reload())} />
  }
}

function AppCrash({ details, reload }: { details: string; reload: () => void }) {
  const t = useT()
  return (
    <div className="flex h-screen w-screen p-4">
      <CrashPanel title={t.stability.appTitle} intro={t.stability.appIntro} action={t.stability.reloadApp} onAction={reload} details={details} />
    </div>
  )
}
