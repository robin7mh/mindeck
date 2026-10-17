import { useEffect, useState } from 'react'
import { Eye, FolderGit2, Globe, Search, Server } from 'lucide-react'
import { ipc } from '@shared/ipc/client'
import type { HistoryEntry } from '@shared/types/browser'
import { TechLabel } from '@/components/ui/TechLabel'
import { StatusDot } from '@/components/ui/StatusDot'
import { useT } from '@/lib/i18n'
import { useProjects } from '@/features/projects/store'
import { useBrowser } from '../store'
import { displayUrl, initial } from '../url'

const tile =
  'group flex min-w-0 items-center gap-2.5 rounded-md border border-hud/50 bg-surface/50 px-3 py-2 text-left transition-colors hover:border-cyan/40 hover:bg-cyan/4'

/**
 * The new-tab page, in Mindeck's look: search, the dev servers running right
 * now, the sites visited most, and the repositories of the user's projects.
 */
export function NewTabPage() {
  const t = useT()
  const devServers = useBrowser((s) => s.state.devServers)
  const projects = useProjects((s) => s.projects)
  const [top, setTop] = useState<HistoryEntry[]>([])
  const go = (url: string) => void useBrowser.getState().go(url)
  const repos = projects.filter((p) => p.git?.webUrl)

  useEffect(() => {
    void ipc('browser:history', { limit: 8 })
      .then(setTop)
      .catch(() => {})
    if (!useProjects.getState().projects.length) void useProjects.getState().load()
  }, [])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-7 px-6 py-10">
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-cyan/40 bg-cyan/6 text-cyan shadow-glow-sm">
            <Globe size={22} />
          </div>
          <button
            type="button"
            onClick={() => useBrowser.setState((s) => ({ focusTick: s.focusTick + 1 }))}
            className="flex w-full max-w-xl items-center gap-3 rounded-lg border border-hud/60 bg-surface/70 px-4 py-3 text-left transition-colors hover:border-cyan/50"
          >
            <Search size={16} className="text-text-muted" />
            <span className="font-sans text-[14px] text-text-muted">{t.browser.ntpSearch}</span>
          </button>
        </div>

        {devServers.length > 0 && (
          <section>
            <TechLabel as="h3" className="mb-2 text-text-secondary">
              {t.browser.devServers}
            </TechLabel>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {devServers.map((s) => {
                const project = projects.find((p) => p.id === s.projectId)
                return (
                  <button key={s.url} type="button" onClick={() => go(s.url)} className={tile} aria-label={t.browser.devServer(s.label)}>
                    <Server size={15} className="shrink-0 text-cyan" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[12.5px] text-text-primary">{s.label}</span>
                      {project && <span className="block truncate font-sans text-[11px] text-text-muted">{project.name}</span>}
                    </span>
                    <StatusDot tone="ok" />
                  </button>
                )
              })}
            </div>
          </section>
        )}

        <section>
          <TechLabel as="h3" className="mb-2 text-text-secondary">
            {t.browser.topSites}
          </TechLabel>
          {top.length ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {top.map((h) => (
                <button key={h.url} type="button" onClick={() => go(h.url)} className={tile} title={h.url}>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-hud/60 bg-elevated/60 font-sans text-[13px] font-semibold text-cyan">
                    {initial(h.url, h.title)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-sans text-[12px] text-text-primary">{h.title || displayUrl(h.url)}</span>
                    <span className="block truncate font-mono text-[10.5px] text-text-muted">{displayUrl(h.url)}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="font-sans text-[12px] text-text-muted">{t.browser.noTopSites}</p>
          )}
        </section>

        {repos.length > 0 && (
          <section>
            <TechLabel as="h3" className="mb-2 text-text-secondary">
              {t.browser.repositories}
            </TechLabel>
            <div className="flex flex-wrap gap-2">
              {repos.map((p) => (
                <button key={p.id} type="button" onClick={() => go(p.git!.webUrl!)} className="flex items-center gap-1.5 rounded-md border border-hud/50 bg-surface/50 px-2.5 py-1.5 font-sans text-[12px] text-text-secondary transition-colors hover:border-cyan/40 hover:text-cyan">
                  <FolderGit2 size={13} /> {p.name}
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="flex flex-col gap-3 border-t border-hud/40 pt-5">
          <p className="flex items-start gap-2 font-sans text-[12px] text-text-secondary">
            <Eye size={14} className="mt-0.5 shrink-0 text-purple" /> {t.browser.agentsSee}
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-1.5">
            {t.browser.tipKeys.map(([keys, what]) => (
              <span key={keys} className="flex items-center gap-1.5 font-sans text-[11.5px] text-text-muted">
                <kbd className="rounded-sm border border-hud/60 bg-elevated/50 px-1.5 py-px font-mono text-[10.5px] text-text-secondary">{keys}</kbd>
                {what}
              </span>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
