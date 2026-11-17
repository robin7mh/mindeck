import { useEffect, useState, type ComponentProps, type ReactNode } from 'react'
import { ChevronRight, type LucideIcon } from 'lucide-react'
import { Select } from '@/components/ui/Select'
import { cn } from '@/lib/cn'

/**
 * The building blocks of the settings: a section's header, groups of rows on
 * a card, a row (what it is, what it does, its control on the right), a switch,
 * segmented buttons, pills, a fold-out for advanced rows and a callout. Every
 * section is made of these, so they all read alike.
 */

export const btn =
  'inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-hud/60 px-3.5 font-sans text-[13px] font-medium text-text-primary transition-colors hover:bg-elevated disabled:pointer-events-none disabled:opacity-45'
export const btnPrimary =
  'inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-cyan px-3.5 font-sans text-[13px] font-semibold text-void transition-[filter] hover:brightness-110 disabled:pointer-events-none disabled:opacity-45'
export const btnDanger = `${btn} text-danger hover:border-danger/50`
/** A small, borderless action next to a group's title. */
export const btnQuiet =
  'inline-flex h-7 items-center gap-1.5 rounded-md px-2 font-sans text-[12px] font-medium text-text-secondary transition-colors hover:bg-elevated hover:text-text-primary disabled:opacity-45'
/** An icon-only button (edit, remove). */
export const btnIcon =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text-primary disabled:opacity-40'
export const input =
  'h-9 rounded-md border border-hud/60 bg-surface px-3 font-mono text-[12.5px] text-text-primary outline-hidden transition-colors placeholder:text-text-muted focus:border-cyan/70'

/** A section's title and what it is about; `action` sits on the right (e.g. "Check again"). */
export function SectionHeader({ title, intro, action }: { title: string; intro?: string; action?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end gap-4">
      <div className="min-w-[240px] flex-1">
        <h2 className="font-sans text-[22px] font-semibold tracking-[-0.015em] text-text-primary">{title}</h2>
        {intro && <p className="mt-1.5 font-sans text-[14px] leading-relaxed text-text-secondary">{intro}</p>}
      </div>
      {action}
    </header>
  )
}

/** A titled group of rows on one card; `footnote` is a quiet line underneath. */
export function Group({ title, action, footnote, children }: { title?: string; action?: ReactNode; footnote?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      {(title || action) && (
        <div className="flex min-h-7 items-center justify-between gap-3 px-1">
          {title && <h3 className="font-sans text-[13px] font-semibold text-text-secondary">{title}</h3>}
          {action}
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-hud/45 bg-panel">{children}</div>
      {footnote && <p className="px-1 font-sans text-[12px] leading-relaxed text-text-muted">{footnote}</p>}
    </section>
  )
}

/**
 * One setting: its name (`label`, plus `badge` beside it) and what it does
 * (`hint`), the control on the right. `htmlFor` ties the name to an input;
 * `indent` puts a row under the one it depends on; `align="start"` for rows
 * whose control or text runs over several lines.
 */
export function Row({
  label,
  hint,
  badge,
  htmlFor,
  icon: Icon,
  indent,
  align = 'center',
  className,
  children
}: {
  label: ReactNode
  hint?: ReactNode
  badge?: ReactNode
  htmlFor?: string
  icon?: LucideIcon
  indent?: boolean
  align?: 'center' | 'start'
  className?: string
  children?: ReactNode
}) {
  const Name = htmlFor ? 'label' : 'div'
  return (
    <div
      className={cn(
        'flex flex-wrap gap-x-6 gap-y-3 border-t border-hud/45 px-5 py-3.5 first:border-t-0',
        align === 'start' ? 'items-start' : 'items-center',
        indent && 'pl-10',
        className
      )}
    >
      {Icon && <Icon size={18} strokeWidth={1.75} className="shrink-0 text-text-muted" />}
      <div className="min-w-[200px] flex-1">
        <Name {...(htmlFor ? { htmlFor } : {})} className="flex flex-wrap items-center gap-2 font-sans text-[14px] font-medium text-text-primary">
          {label}
          {badge}
        </Name>
        {hint && <div className="mt-0.5 font-sans text-[13px] leading-[1.45] text-text-secondary">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

/** On or off. A real checkbox (role switch) under the drawn track, so keyboard and screen readers know it. */
export function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <span className={cn('relative inline-flex shrink-0', disabled && 'opacity-45')}>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden
        className="h-7 w-[46px] rounded-full bg-hud-strong/70 transition-colors peer-checked:bg-cyan peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-cyan"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.3)] transition-transform peer-checked:translate-x-[18px]"
      />
    </span>
  )
}

/** A row that is just a switch: the most common kind. */
export function SwitchRow({
  label,
  hint,
  badge,
  checked,
  disabled,
  indent,
  onChange
}: {
  label: string
  hint?: ReactNode
  badge?: ReactNode
  checked: boolean
  disabled?: boolean
  indent?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <Row label={label} hint={hint} badge={badge} indent={indent}>
      <Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
    </Row>
  )
}

/** One choice of a few, side by side (radio buttons drawn as a segmented control). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange
}: {
  label: string
  value: T
  options: { id: T; label: string; icon?: LucideIcon }[]
  disabled?: boolean
  onChange: (v: T) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-0.5 rounded-[10px] border border-hud/45 bg-surface p-[3px]">
      {options.map(({ id, label: text, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          disabled={disabled}
          onClick={() => value !== id && onChange(id)}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-[7px] px-3 font-sans text-[13px] transition-colors disabled:opacity-45',
            value === id ? 'bg-panel font-medium text-text-primary shadow-[0_1px_2px_rgb(0_0_0/0.25)]' : 'text-text-secondary hover:text-text-primary'
          )}
        >
          {Icon && <Icon size={14} strokeWidth={1.9} />}
          {text}
        </button>
      ))}
    </div>
  )
}

export type Tone = 'ok' | 'warn' | 'risk' | 'mute'
const TONES: Record<Tone, string> = {
  ok: 'bg-green/12 text-green',
  warn: 'bg-amber/12 text-amber',
  risk: 'bg-danger/12 text-danger',
  mute: 'bg-elevated text-text-secondary'
}

/** A short state or warning, as a rounded label. */
export function Pill({ tone, className, children }: { tone: Tone; className?: string; children: ReactNode }) {
  return <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-[3px] font-sans text-[12px] font-medium', TONES[tone], className)}>{children}</span>
}

/** A tool's or program's name, as a quiet chip. */
export function Chip({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <span title={title} className="rounded-md bg-elevated px-2 py-[3px] font-sans text-[12px] text-text-secondary">
      {children}
    </span>
  )
}

/** Rows that stay folded away until asked for, at the end of a card. */
export function Advanced({ summary, open, children }: { summary: string; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="group/adv border-t border-hud/45 first:border-t-0">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 font-sans text-[13px] font-medium text-text-secondary transition-colors hover:text-text-primary [&::-webkit-details-marker]:hidden">
        <ChevronRight size={14} strokeWidth={2} className="transition-transform group-open/adv:rotate-90" />
        {summary}
      </summary>
      <div className="border-t border-hud/45">{children}</div>
    </details>
  )
}

/** A warning above the groups — something to do — with an optional action. */
export function Callout({ icon: Icon, action, children }: { icon: LucideIcon; action?: ReactNode; children: ReactNode }) {
  return (
    <div role="alert" className="flex flex-wrap items-start gap-3 rounded-lg bg-amber/12 px-4 py-3.5 font-sans text-[13px] leading-[1.45] text-text-primary">
      <Icon size={18} strokeWidth={2} className="mt-px shrink-0 text-amber" />
      <div className="min-w-[200px] flex-1">{children}</div>
      {action}
    </div>
  )
}

/** A number typed freely, saved (within its bounds) on Enter or when the field is left. */
export function NumberField({
  id,
  label,
  value,
  bounds,
  step = 1,
  width = 'w-[88px]',
  onSave
}: {
  id?: string
  label: string
  value: number
  bounds: readonly [number, number]
  step?: number
  width?: string
  onSave: (v: number) => void
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const n = Number(text)
    if (text.trim() === '' || Number.isNaN(n)) return setText(String(value))
    const next = Math.min(bounds[1], Math.max(bounds[0], step < 1 ? n : Math.round(n)))
    setText(String(next))
    if (next !== value) onSave(next)
  }
  return (
    <input
      id={id}
      type="number"
      aria-label={label}
      min={bounds[0]}
      max={bounds[1]}
      step={step}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      className={cn(input, width)}
    />
  )
}

/** Mindeck's dropdown at a fixed width beside a row's text (the dropdown itself fills what it is given). */
export function SelectBox({ width = 'w-[240px]', ...props }: ComponentProps<typeof Select> & { width?: string }) {
  return (
    <div className={cn('max-w-full', width)}>
      <Select {...props} className="h-9" />
    </div>
  )
}
