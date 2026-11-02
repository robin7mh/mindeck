import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { TechLabel } from './TechLabel'

/**
 * A titled section inside a module panel (Settings, Profile). `data-card`
 * names it for links into it (the command palette's "Settings: …"), which
 * light it up for a moment (`data-flash`).
 */
export function Card({ icon: Icon, title, children, className }: { icon: LucideIcon; title: string; children: ReactNode; className?: string }) {
  return (
    <section
      data-card={title}
      className={cn('scroll-mt-3 rounded-md border border-hud/60 bg-surface/40 p-3.5 transition-shadow duration-500 data-flash:shadow-[0_0_0_1px_rgb(var(--accent-cyan)/0.7),0_0_24px_rgb(var(--accent-cyan)/0.25)]', className)}
    >
      <div className="mb-3 flex items-center gap-2">
        <Icon size={14} className="text-cyan" />
        <TechLabel className="text-text-secondary">{title}</TechLabel>
      </div>
      {children}
    </section>
  )
}
