import { cn } from '@/lib/cn'
import { LOCALES, useLocale } from '@/lib/i18n'

/** DE / EN segmented switch — the whole UI follows at once. */
export function LanguageSwitch({ className }: { className?: string }) {
  const locale = useLocale((s) => s.locale)
  const setLocale = useLocale((s) => s.setLocale)
  return (
    <div role="radiogroup" aria-label="Language / Sprache" className={cn('inline-flex gap-0.5 rounded-md bg-elevated p-[3px]', className)}>
      {LOCALES.map((l) => (
        <button
          key={l.id}
          type="button"
          role="radio"
          aria-checked={locale === l.id}
          onClick={() => setLocale(l.id)}
          className={cn(
            'h-[30px] rounded-sm px-3 font-sans text-[13px] font-medium transition-colors',
            locale === l.id ? 'bg-panel text-text-primary shadow-[0_1px_2px_rgb(0_0_0/0.25)]' : 'text-text-secondary hover:text-text-primary'
          )}
        >
          {l.label}
        </button>
      ))}
    </div>
  )
}
