import { cn } from '@/lib/cn'

/** A setting that is on or off, with what it does — a switch on the right. */
export function Toggle({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={cn('flex cursor-pointer items-center justify-between gap-4 py-2', disabled && 'cursor-not-allowed opacity-50')}>
      <span className="min-w-0">
        <span className="block font-sans text-[13.5px] font-medium text-text-primary">{label}</span>
        {hint && <span className="mt-0.5 block font-sans text-[12.5px] text-text-muted">{hint}</span>}
      </span>
      <span className="relative inline-flex shrink-0">
        <input
          type="checkbox"
          role="switch"
          aria-label={label}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="peer absolute inset-0 h-full w-full cursor-[inherit] opacity-0"
        />
        <span
          aria-hidden
          className="h-[22px] w-[38px] rounded-full bg-hud-strong/70 transition-colors peer-checked:bg-cyan peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-cyan/80"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute left-[3px] top-[3px] h-4 w-4 rounded-full bg-text-primary transition-transform peer-checked:translate-x-4 peer-checked:bg-void"
        />
      </span>
    </label>
  )
}
