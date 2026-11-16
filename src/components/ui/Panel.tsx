import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface PanelProps {
  children: ReactNode
  /** Title in the panel's header row. */
  title?: string
  /** Right-aligned content in the header (status dot, value, action). */
  headerRight?: ReactNode
  /** Kept for existing call sites — the modern design has no HUD corner ticks. */
  corners?: boolean
  /** Remove inner padding (e.g. for the terminal / full-bleed content). */
  flush?: boolean
  className?: string
  bodyClassName?: string
}

/**
 * The single Panel primitive. Every framed surface in the app uses this so
 * borders, header treatment and spacing stay identical everywhere: a calm card
 * with a hairline border and a sentence-case title.
 */
export function Panel({ children, title, headerRight, flush = false, className, bodyClassName }: PanelProps) {
  return (
    <section className={cn('panel flex min-h-0 flex-col overflow-hidden', className)}>
      {(title || headerRight) && (
        <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-hud/40 px-4">
          {title ? <span className="truncate font-sans text-[13.5px] font-semibold tracking-[-0.005em] text-text-primary">{title}</span> : <span />}
          {headerRight && <div className="flex items-center gap-2">{headerRight}</div>}
        </header>
      )}
      <div className={cn('min-h-0 flex-1', flush ? '' : 'p-3', bodyClassName)}>{children}</div>
    </section>
  )
}
