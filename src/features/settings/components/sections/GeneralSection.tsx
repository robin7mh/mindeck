import { useEffect, useState } from 'react'
import { Monitor, Moon, ShieldAlert, SunMedium, type LucideIcon } from 'lucide-react'
import { ipc, isDesktop } from '@shared/ipc/client'
import type { CloseBehavior, DesktopStatus } from '@shared/types/desktop'
import { LanguageSwitch } from '@/components/ui/LanguageSwitch'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { ACCENTS, DEFAULT_APPEARANCE, MODES, SURFACES, surfaceTokens, useAppearance, type Accent, type Mode } from '@/lib/theme'
import { useOnboarding } from '@/features/onboarding/store'
import { Callout, Group, Pill, Row, Segmented, SectionHeader, btn, SelectBox } from '../ui'

const MODE_ICONS: Record<Mode, LucideIcon> = { dark: Moon, light: SunMedium, system: Monitor }

/** Mode, accent color and the dark background — per device. */
function AppearanceGroup() {
  const s = useT().settings
  const appearance = useAppearance((st) => st.appearance)
  const theme = useAppearance((st) => st.theme)
  const update = useAppearance((st) => st.update)
  const isDefault = JSON.stringify(appearance) === JSON.stringify(DEFAULT_APPEARANCE)

  return (
    <Group title={s.groups.appearance}>
      <Row label={s.themeMode}>
        <Segmented label={s.themeMode} value={appearance.mode} onChange={(mode) => update({ mode })} options={MODES.map((id) => ({ id, label: s.themeModes[id], icon: MODE_ICONS[id] }))} />
      </Row>
      <Row label={s.accent} hint={s.accents[appearance.accent]}>
        <div role="radiogroup" aria-label={s.accent} className="flex flex-wrap gap-2.5">
          {(Object.keys(ACCENTS) as Accent[]).map((id) => {
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
                className={cn('h-8 w-8 rounded-full ring-offset-2 ring-offset-panel transition-transform', on ? 'ring-2 ring-text-primary' : 'hover:scale-105')}
                style={{ background: `rgb(${ACCENTS[id][theme][0]})` }}
              />
            )
          })}
        </div>
      </Row>
      {/* The background tints the dark theme only: in light mode it isn't offered. */}
      {theme === 'dark' && (
        <Row label={s.surface} hint={`${s.surfaceDarkOnly} ${s.surfaceHints[appearance.surface]}`} align="start">
          <div role="radiogroup" aria-label={s.surface} className="flex flex-wrap gap-2.5">
            {SURFACES.map((id) => {
              const tokens = surfaceTokens(id, appearance.accent)
              const on = appearance.surface === id
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => update({ surface: id })}
                  className={cn(
                    'flex w-[132px] flex-col gap-2 rounded-[10px] border p-2 text-left transition-colors',
                    on ? 'border-cyan shadow-[0_0_0_1px_rgb(var(--accent-cyan))]' : 'border-hud/60 hover:border-hud-strong'
                  )}
                >
                  <span className="flex h-14 gap-1 rounded-md p-1.5" style={{ background: `rgb(${tokens['--bg-void']})` }}>
                    <span className="w-1/4 rounded-[3px]" style={{ background: `rgb(${tokens['--bg-panel']})` }} />
                    <span className="flex flex-1 items-end rounded-[3px] p-1.5" style={{ background: `rgb(${tokens['--bg-panel']})` }}>
                      <span className="block h-1 w-1/2 rounded-full bg-cyan" />
                    </span>
                  </span>
                  <span className={cn('px-0.5 font-sans text-[13px]', on ? 'font-medium text-text-primary' : 'text-text-secondary')}>{s.surfaces[id]}</span>
                </button>
              )
            })}
          </div>
        </Row>
      )}
      <Row label={s.defaultLook} hint={s.appearanceHint}>
        <button type="button" className={btn} disabled={isDefault} onClick={() => useAppearance.getState().reset()}>
          {s.resetAppearance}
        </button>
      </Row>
    </Group>
  )
}

/** The desktop app itself: what closing the window does, and the setup once more. */
function AppGroup({ status, onStatus }: { status: DesktopStatus; onStatus: (s: DesktopStatus) => void }) {
  const t = useT()
  const st = t.stability
  const configure = (closeBehavior: CloseBehavior) => void ipc('desktop:configure', { closeBehavior }).then(onStatus).catch(() => {})
  return (
    <Group title={t.settings.groups.app}>
      {status.platform === 'darwin' ? (
        <Row label={st.closeBackground} hint={st.closeMac}>
          <Pill tone="mute">{t.settings.always}</Pill>
        </Row>
      ) : (
        <Row label={st.closeLabel}>
          <SelectBox
            label={st.closeLabel}
            value={status.closeBehavior}
            options={[
              { value: 'ask', label: st.closeAsk },
              { value: 'background', label: st.closeBackground },
              { value: 'quit', label: st.closeQuit }
            ]}
            onChange={(v) => configure(v as CloseBehavior)}
            width="w-[220px]"
          />
        </Row>
      )}
      <Row label={t.onboarding.restart} hint={t.onboarding.settingsHint}>
        <button type="button" className={btn} onClick={() => useOnboarding.getState().restart()}>
          {t.settings.startSetup}
        </button>
      </Row>
    </Group>
  )
}

/** Settings → General & appearance: language, mode, accent, background, and how the app behaves. */
export function GeneralSection() {
  const t = useT()
  const s = t.settings
  const [desktop, setDesktop] = useState<DesktopStatus>()
  useEffect(() => {
    if (isDesktop()) void ipc('desktop:status').then(setDesktop).catch(() => {})
  }, [])

  return (
    <>
      <SectionHeader title={s.sections.general.title} intro={s.sections.general.intro} />
      {desktop && !desktop.secretsEncrypted && (
        <Callout icon={ShieldAlert}>
          <strong className="font-semibold">{t.stability.keyringTitle}</strong> {t.stability.keyringBody}
        </Callout>
      )}
      <Group title={s.groups.language}>
        <Row label={s.interfaceLanguage} hint={t.account.languageHint}>
          <LanguageSwitch />
        </Row>
      </Group>
      <AppearanceGroup />
      {desktop && <AppGroup status={desktop} onStatus={setDesktop} />}
    </>
  )
}
