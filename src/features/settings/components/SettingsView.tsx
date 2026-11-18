import { useEffect, type ReactNode } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { isDesktop } from '@shared/ipc/client'
import { Panel } from '@/components/ui/Panel'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useSession } from '@/features/session/store'
import { useAssistant } from '@/features/agents/store'
import { liveReach, useSettings } from '../store'
import { DESKTOP_ONLY, NAV, SECTION_ICONS, type SectionId } from '../sections'
import { AboutSection } from './sections/AboutSection'
import { AiSection } from './sections/AiSection'
import { BrowserSection } from './sections/BrowserSection'
import { EditorSection } from './sections/EditorSection'
import { GeneralSection } from './sections/GeneralSection'
import { LanguagesSection } from './sections/LanguagesSection'
import { MemorySection } from './sections/MemorySection'
import { MigrateSection } from './sections/MigrateSection'
import { RemoteSection } from './sections/RemoteSection'
import { TerminalSection } from './sections/TerminalSection'

/** A badge beside a section's name: something to do (warn), or something on (ok). */
function Badge({ tone, children }: { tone: 'ok' | 'warn'; children: ReactNode }) {
  return <span className={cn('ml-auto rounded-full px-[7px] py-0.5 font-sans text-[11px] font-medium', tone === 'ok' ? 'bg-green/12 text-green' : 'bg-amber/12 text-amber')}>{children}</span>
}

/**
 * Settings: a navigation of sections in four groups and the open section
 * beside it — one page each, made of titled groups of rows. Below the
 * container's medium width the navigation runs across the top. Every change
 * is saved as it is made.
 */
export function SettingsView({ onOpenAccount }: { onOpenAccount?: () => void }) {
  const t = useT()
  const s = t.settings
  const desktop = isDesktop()
  const load = useSettings((st) => st.load)
  const error = useSettings((st) => st.error)
  const clearError = useSettings((st) => st.clearError)
  const setSection = useSettings((st) => st.setSection)
  const chosen = useSettings((st) => st.section)
  const server = useSettings((st) => st.server)
  const aiError = useAssistant((st) => st.error)
  const ai = useAssistant((st) => st.status)
  const version = useSession((st) => st.info?.version)

  useEffect(() => {
    void load()
  }, [load])

  const available = (id: SectionId) => desktop || !DESKTOP_ONLY.includes(id)
  const section: SectionId = available(chosen) ? chosen : 'general'
  const nav = NAV.map(({ group, sections }) => ({ group, sections: sections.filter(available) })).filter((g) => g.sections.length)
  const badges: Partial<Record<SectionId, ReactNode>> = {
    ...(ai && !ai.configured ? { ai: <Badge tone="warn">{s.badgeSignIn}</Badge> } : {}),
    ...(liveReach(server) !== 'off' ? { remote: <Badge tone="ok">{s.badgeOn}</Badge> } : {})
  }

  const content: Record<SectionId, () => ReactNode> = {
    general: () => <GeneralSection />,
    ai: () => <AiSection onSignIn={onOpenAccount} />,
    editor: () => <EditorSection />,
    languages: () => <LanguagesSection />,
    terminal: () => <TerminalSection />,
    browser: () => <BrowserSection />,
    remote: () => <RemoteSection />,
    memory: () => <MemorySection />,
    migrate: () => <MigrateSection />,
    about: () => <AboutSection />
  }

  return (
    <Panel title={s.title} flush className="min-h-0 flex-1" bodyClassName="flex min-h-0 flex-col">
      {(error || aiError) && (
        <div className="flex shrink-0 items-start gap-2 border-b border-danger/30 bg-danger/6 px-4 py-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" />
          <span className="min-w-0 flex-1 font-mono text-[11.5px] text-text-secondary">{error ?? aiError}</span>
          <button
            type="button"
            aria-label={t.common.dismiss}
            onClick={() => {
              clearError()
              useAssistant.getState().clearError()
            }}
            className="text-text-muted hover:text-text-primary"
          >
            <X size={13} />
          </button>
        </div>
      )}
      <div className="@container flex min-h-0 flex-1">
        <div className="flex min-h-0 w-full flex-col @3xl:flex-row">
          <aside className="flex shrink-0 flex-col gap-1 border-b border-hud/45 bg-panel px-3 py-3 @3xl:w-[248px] @3xl:overflow-y-auto @3xl:border-b-0 @3xl:border-r @3xl:pb-5 @3xl:pt-1">
            <nav aria-label={s.navLabel} className="flex gap-0.5 overflow-x-auto @3xl:flex-col @3xl:overflow-visible">
              {nav.map(({ group, sections }) => (
                <div key={group} role="group" aria-label={s.navGroups[group]} className="flex shrink-0 gap-0.5 @3xl:flex-col">
                  <p className="hidden px-2.5 pb-1.5 pt-4 font-sans text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted @3xl:block">{s.navGroups[group]}</p>
                  {sections.map((id) => {
                    const Icon = SECTION_ICONS[id]
                    const on = id === section
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-current={on ? 'page' : undefined}
                        onClick={() => setSection(id)}
                        className={cn(
                          'flex h-9 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 text-left font-sans text-[14px] transition-colors @3xl:w-full',
                          on ? 'bg-elevated font-medium text-text-primary' : 'text-text-secondary hover:bg-elevated hover:text-text-primary'
                        )}
                      >
                        <Icon size={16} strokeWidth={1.9} className={cn('shrink-0', on && 'text-cyan')} />
                        {s.sections[id].title}
                        {badges[id]}
                      </button>
                    )
                  })}
                </div>
              ))}
            </nav>
            <p className="mt-auto hidden px-2.5 pt-6 font-sans text-[12px] leading-relaxed text-text-muted @3xl:block">
              {s.saved}
              {version && (
                <>
                  <br />
                  Mindeck {version}
                </>
              )}
            </p>
          </aside>
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface">
            <div key={section} className="mx-auto flex max-w-[760px] flex-col gap-7 px-5 pb-24 pt-8 @3xl:px-8 @3xl:pt-10">
              {content[section]()}
            </div>
          </main>
        </div>
      </div>
    </Panel>
  )
}
