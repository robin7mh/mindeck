import { cn } from '@/lib/cn'
import { LOCALES, useLocale } from '@/lib/i18n'

/** DE / EN segmented switch — the whole UI follows at once. */
export function LanguageSwitch({ className }: { className?: string }) {
  const locale = useLocale((s) => s.locale)
  const setLocale = useLocale((s) => s.setLocale)
  return (
    <div role="radiogroup" aria-label="Language / Sprache" className={cn('inline-flex rounded-md border border-hud/60 bg-surface/50 p-0.5', className)}>
      {LOCALES.map((l) => (
        <button
          key={l.id}
          type="button"
          role="radio"
          aria-checked={locale === l.id}
          onClick={() => setLocale(l.id)}
          className={cn(
            'rounded-sm px-3 py-1 font-sans text-[12px] transition-colors',
            locale === l.id ? 'bg-cyan/12 text-cyan' : 'text-text-muted hover:text-text-secondary'
          )}
        >
          {l.label}
        </button>
      ))}
    </div>
  )
}
