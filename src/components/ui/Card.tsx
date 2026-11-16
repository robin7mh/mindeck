import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * A titled section inside a module panel (Settings, Profile). `data-card`
 * names it for links into it (the command palette's "Settings: …"), which
 * light it up for a moment (`data-flash`).
 */
export function Card({ icon: Icon, title, children, className }: { icon: LucideIcon; title: string; children: ReactNode; className?: string }) {
  return (
    <section
      data-card={title}
      className={cn(
        'scroll-mt-3 rounded-lg border border-hud/45 bg-panel p-4 transition-shadow duration-500 data-flash:shadow-[0_0_0_1px_rgb(var(--accent-cyan)/0.6),0_0_0_4px_rgb(var(--accent-cyan)/0.15)]',
        className
      )}
    >
      <div className="mb-4 flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-elevated text-text-secondary">
          <Icon size={15} strokeWidth={1.75} />
        </span>
        <h3 className="font-sans text-[14px] font-semibold text-text-primary">{title}</h3>
      </div>
      {children}
    </section>
  )
}
