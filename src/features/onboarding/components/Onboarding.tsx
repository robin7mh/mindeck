import { useEffect, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, Columns2, FolderPlus, Languages, Lightbulb, X } from 'lucide-react'
import { isDesktop } from '@shared/ipc/client'
import { Panel } from '@/components/ui/Panel'
import { TechLabel } from '@/components/ui/TechLabel'
import { LanguageSwitch } from '@/components/ui/LanguageSwitch'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useOverlay } from '@/lib/overlay'
import { AppearanceCard } from '@/features/settings/components/AppearanceCard'
import { MigrateCard } from '@/features/settings/components/MigrateCard'
import { useProjects } from '@/features/projects/store'
import { SplitDemo } from '@/features/workspace/components/SplitDemo'
import { primaryButton, quietButton } from '@/features/cloud/components/CloudForms'
import { useOnboarding, type StepId } from '../store'
import { browserImportStep } from '../slots'
import { AgentsStep } from './AgentsStep'

/** Welcome: the language and the look, first. */
function WelcomeStep() {
  const o = useT().onboarding
  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-sans text-[18px] font-semibold text-text-primary">{o.welcomeTitle}</h2>
        <p className="mt-1 font-sans text-[13px] text-text-secondary">{o.welcomeIntro}</p>
      </div>
      <div className="flex items-center gap-3">
        <Languages size={14} className="text-cyan" />
        <TechLabel className="text-text-secondary">{o.language}</TechLabel>
        <LanguageSwitch />
      </div>
      <AppearanceCard />
    </div>
  )
}

/** The first project: a folder from the native dialog. */
function ProjectStep() {
  const o = useT().onboarding
  const projects = useProjects((s) => s.projects)
  const error = useProjects((s) => s.error)
  useEffect(() => {
    void useProjects.getState().load()
  }, [])
  return (
    <div className="space-y-3">
      <p className="font-sans text-[13px] text-text-secondary">{o.projectIntro}</p>
      <button type="button" onClick={() => void useProjects.getState().addViaPicker()} className={primaryButton}>
        <FolderPlus size={14} /> {o.chooseFolder}
      </button>
      {error && <p className="font-mono text-[11px] text-danger">{error}</p>}
      <div>
        <TechLabel className="text-text-muted">{o.yourProjects}</TechLabel>
        {projects.length === 0 ? (
          <p className="mt-1 font-sans text-[12px] text-text-muted">{o.noProjects}</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {projects.map((p) => (
              <li key={p.id} className="flex items-center gap-2">
                <Check size={12} className="shrink-0 text-green" />
                <span className="font-sans text-[13px] text-text-primary">{p.name}</span>
                <span className="min-w-0 truncate font-mono text-[11px] text-text-muted">{p.path}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** Moving over from VS Code / Cursor — Settings' own card. */
function ImportStep() {
  const o = useT().onboarding
  return (
    <div className="space-y-3">
      <p className="font-sans text-[13px] text-text-secondary">{o.importIntro}</p>
      <MigrateCard />
    </div>
  )
}

/** Done: a few things worth knowing — the split screen first, shown as it happens. */
function DoneStep() {
  const o = useT().onboarding
  return (
    <div className="space-y-3">
      <div>
        <h2 className="font-sans text-[18px] font-semibold text-text-primary">{o.doneTitle}</h2>
        <p className="mt-1 font-sans text-[13px] text-text-secondary">{o.doneIntro}</p>
      </div>
      <ul className="space-y-2">
        <li className="rounded-md border border-cyan/40 bg-cyan/4 p-2.5">
          <div className="flex gap-2.5">
            <Columns2 size={14} className="mt-0.5 shrink-0 text-cyan" />
            <span>
              <span className="block font-sans text-[13px] font-medium text-text-primary">{o.splitTip.title}</span>
              <span className="block font-sans text-[12px] text-text-secondary">{o.splitTip.body}</span>
            </span>
          </div>
          <SplitDemo className="mt-2.5" />
        </li>
        {o.tips.map((tip) => (
          <li key={tip.title} className="flex gap-2.5 rounded-md border border-hud/50 p-2.5">
            <Lightbulb size={14} className="mt-0.5 shrink-0 text-cyan" />
            <span>
              <span className="block font-sans text-[13px] font-medium text-text-primary">{tip.title}</span>
              <span className="block font-sans text-[12px] text-text-secondary">{tip.body}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The open setup: steps, progress, back / next / skip. */
function Wizard() {
  const t = useT()
  const o = t.onboarding
  const step = useOnboarding((s) => s.step)
  useOverlay(true)
  const BrowserImport = browserImportStep()
  const steps: { id: StepId; render: () => ReactNode }[] = [
    { id: 'welcome', render: () => <WelcomeStep /> },
    { id: 'agents', render: () => <AgentsStep /> },
    { id: 'project', render: () => <ProjectStep /> },
    { id: 'import', render: () => <ImportStep /> },
    // Filled by the browser package (slots.ts) — only where the core can import browser data.
    ...(BrowserImport ? [{ id: 'browserImport' as const, render: () => <BrowserImport next={next} /> }] : []),
    { id: 'done', render: () => <DoneStep /> }
  ]
  const index = Math.max(0, steps.findIndex((s) => s.id === step))
  const last = index === steps.length - 1
  const { go, finish } = useOnboarding.getState()
  const next = () => (last ? finish() : go(steps[index + 1].id))

  return (
    <div role="dialog" aria-modal="true" aria-label={o.title} className="fixed inset-0 z-90 flex items-center justify-center bg-void/80 p-4 backdrop-blur-xs">
      <Panel
        title={o.title}
        corners
        flush
        className="max-h-[90vh] w-full max-w-3xl"
        bodyClassName="flex flex-col"
        headerRight={
          <>
            <span className="font-mono text-[11px] text-text-muted">{o.stepOf(index + 1, steps.length)}</span>
            <button type="button" aria-label={o.close} onClick={finish} className="text-text-muted hover:text-text-primary">
              <X size={14} />
            </button>
          </>
        }
      >
        <ol className="flex shrink-0 flex-wrap gap-1.5 border-b border-hud/50 px-4 py-2.5">
          {steps.map(({ id }, i) => (
            <li
              key={id}
              aria-current={i === index ? 'step' : undefined}
              className={cn(
                'rounded-full border px-2.5 py-0.5 font-sans text-[11px]',
                i === index ? 'border-cyan/60 bg-cyan/[0.10] text-cyan' : i < index ? 'border-hud/60 text-text-secondary' : 'border-hud/40 text-text-muted'
              )}
            >
              {o.steps[id]}
            </li>
          ))}
        </ol>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{steps[index].render()}</div>
        <footer className="flex shrink-0 items-center gap-2 border-t border-hud/60 px-4 py-3">
          {!last && (
            <button type="button" onClick={finish} className="font-sans text-[12px] text-text-muted hover:text-text-secondary">
              {o.skip}
            </button>
          )}
          <span className="flex-1" />
          {index > 0 && (
            <button type="button" onClick={() => go(steps[index - 1].id)} className={quietButton}>
              <ArrowLeft size={13} /> {o.back}
            </button>
          )}
          <button type="button" onClick={next} className={primaryButton}>
            {last ? (
              <>
                <Check size={14} /> {o.finish}
              </>
            ) : (
              <>
                {o.next} <ArrowRight size={14} />
              </>
            )}
          </button>
        </footer>
      </Panel>
    </div>
  )
}

/**
 * The first-start setup, over the app (desktop window): language and look,
 * coding agents, a first project, moving over from VS Code / Cursor, three
 * tips — on a real first start only. Skippable; Settings → Setup starts it again.
 */
export function Onboarding() {
  const open = useOnboarding((s) => s.open)
  useEffect(() => {
    if (isDesktop()) void useOnboarding.getState().firstStart()
  }, [])
  if (!open || !isDesktop()) return null
  return <Wizard />
}
