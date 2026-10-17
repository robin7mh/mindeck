import type { ReactNode } from 'react'
import { Check, Monitor, Moon, Palette, RotateCcw, SunMedium, type LucideIcon } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { TechLabel } from '@/components/ui/TechLabel'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { ACCENTS, DEFAULT_APPEARANCE, MODES, SURFACES, surfaceTokens, useAppearance, type Accent, type Mode } from '@/lib/theme'

const MODE_ICONS: Record<Mode, LucideIcon> = { dark: Moon, light: SunMedium, system: Monitor }

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <TechLabel className="text-text-muted">{label}</TechLabel>
      {children}
      {hint && <p className="font-sans text-[11.5px] text-text-muted">{hint}</p>}
    </div>
  )
}

/** Segmented radio buttons, styled like the language switch. */
function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: { id: T; label: string; icon: LucideIcon }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex self-start rounded-md border border-hud/60 bg-surface/50 p-0.5">
      {options.map(({ id, label: text, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={cn(
            'flex items-center gap-1.5 rounded-sm px-2.5 py-1 font-sans text-[12px] transition-colors',
            value === id ? 'bg-cyan/12 text-cyan' : 'text-text-muted hover:text-text-secondary'
          )}
        >
          <Icon size={12} />
          {text}
        </button>
      ))}
    </div>
  )
}

/** Theme, accent color and dark background — per device. */
export function AppearanceCard() {
  const t = useT()
  const s = t.settings
  const appearance = useAppearance((st) => st.appearance)
  const theme = useAppearance((st) => st.theme)
  const update = useAppearance((st) => st.update)
  const light = theme === 'light'
  const isDefault = JSON.stringify(appearance) === JSON.stringify(DEFAULT_APPEARANCE)

  return (
    <Card icon={Palette} title={s.appearanceCard} className="pane-lg:col-span-2">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Field label={s.themeMode}>
          <Segmented label={s.themeMode} value={appearance.mode} onChange={(mode) => update({ mode })} options={MODES.map((id) => ({ id, label: s.themeModes[id], icon: MODE_ICONS[id] }))} />
        </Field>

        <Field label={s.accent} hint={s.accents[appearance.accent]}>
          <div role="radiogroup" aria-label={s.accent} className="flex flex-wrap gap-2">
            {(Object.keys(ACCENTS) as Accent[]).map((id) => {
              const [main, second] = ACCENTS[id][theme]
              const on = appearance.accent === id
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={s.accents[id]}
                  title={s.accents[id]}
                  onClick={() => update({ accent: id })}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-full ring-offset-2 ring-offset-surface transition-transform',
                    on ? 'ring-2 ring-text-primary/70' : 'hover:scale-110'
                  )}
                  style={{ background: `linear-gradient(135deg, rgb(${main}), rgb(${second}))` }}
                >
                  {on && <Check size={13} strokeWidth={3} className={light ? 'text-panel' : 'text-void'} />}
                </button>
              )
            })}
          </div>
        </Field>

        <Field label={s.surface} hint={light ? s.surfaceDarkOnly : s.surfaceHints[appearance.surface]}>
          <div role="radiogroup" aria-label={s.surface} className={cn('grid grid-cols-3 gap-2', light && 'opacity-50')}>
            {SURFACES.map((id) => {
              const tokens = surfaceTokens(id, appearance.accent)
              const on = appearance.surface === id
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={light}
                  onClick={() => update({ surface: id })}
                  className={cn(
                    'flex flex-col gap-1.5 rounded-md border p-1.5 text-left transition-colors',
                    on ? 'border-cyan/60' : 'border-hud/60 enabled:hover:border-hud-strong'
                  )}
                >
                  <span className="block rounded-sm p-1.5" style={{ background: `rgb(${tokens['--bg-void']})` }}>
                    <span className="block h-4 rounded-xs border" style={{ background: `rgb(${tokens['--bg-panel']})`, borderColor: `rgb(${tokens['--border-hud-strong']})` }} />
                  </span>
                  <span className={cn('font-sans text-[11.5px]', on ? 'text-cyan' : 'text-text-secondary')}>{s.surfaces[id]}</span>
                </button>
              )
            })}
          </div>
        </Field>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-hud/40 pt-2.5">
        <span className="font-sans text-[11.5px] text-text-muted">{s.appearanceHint}</span>
        <button
          type="button"
          disabled={isDefault}
          onClick={() => useAppearance.getState().reset()}
          className="flex items-center gap-1.5 rounded-md border border-hud/60 px-2.5 py-1.5 font-sans text-[12px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan disabled:opacity-40"
        >
          <RotateCcw size={12} /> {s.resetAppearance}
        </button>
      </div>
    </Card>
  )
}
