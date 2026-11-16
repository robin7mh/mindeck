import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'

/** A project action: a button — or, with `href`, a link that opens in the browser. */
export function ActionButton({
  icon: Icon,
  label,
  title,
  onClick,
  href,
  expanded,
  disabled,
  danger
}: {
  icon: LucideIcon
  label: string
  title?: string
  onClick?: () => void
  href?: string
  /** Opens a menu: whether it is open. */
  expanded?: boolean
  disabled?: boolean
  danger?: boolean
}) {
  const className = cn(
    'flex items-center gap-2 rounded-md border px-3 py-2 font-sans text-[12px] font-medium transition-colors disabled:opacity-40',
    danger
      ? 'border-hud/60 text-text-secondary hover:border-danger/50 hover:text-danger'
      : 'border-hud/60 text-text-secondary hover:border-hud-strong/80 hover:text-text-primary'
  )
  const body = (
    <>
      <Icon size={14} strokeWidth={1.8} />
      {label}
    </>
  )
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" title={title} className={className}>
      {body}
    </a>
  ) : (
    <button type="button" title={title} aria-expanded={expanded} onClick={onClick} disabled={disabled} className={className}>
      {body}
    </button>
  )
}
