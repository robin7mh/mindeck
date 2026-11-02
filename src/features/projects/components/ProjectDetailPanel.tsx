import { useEffect } from 'react'
import {
  AppWindow,
  ArrowDownToLine,
  GitBranch,
  GitCommitHorizontal,
  ArrowUp,
  ArrowDown,
  RefreshCw,
  Trash2,
  FileText,
  Package
} from 'lucide-react'
import type { Project } from '@shared/types/project'
import type { ModuleId } from '@/types'
import { TechLabel } from '@/components/ui/TechLabel'
import { StatusDot } from '@/components/ui/StatusDot'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { repoLink } from '@/lib/repo'
import { useSession } from '@/features/session/store'
import { useProjects } from '../store'
import { isDesktop } from '@shared/ipc/client'
import { ActionButton } from './ActionButton'
import { ContextSection } from './ContextSection'
import { ProjectTerminalMenu } from './ProjectTerminalMenu'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1">
      <TechLabel className="mt-0.5 w-24 shrink-0 text-text-muted">{label}</TechLabel>
      <div className="min-w-0 flex-1 font-mono text-[12px] text-text-secondary">{children}</div>
    </div>
  )
}

export function ProjectDetailPanel({ project, onNavigate }: { project: Project; onNavigate: (module: ModuleId) => void }) {
  const t = useT()
  const { refresh, pull, remove, openInGitHubDesktop, githubDesktop, busyId } = useProjects()
  const busy = busyId === project.id
  const g = project.git
  const s = project.stack
  const desktop = isDesktop()
  // A paired browser gets shells only when the core allows remote shells.
  const shells = useSession((st) => desktop || st.info?.remoteTerminal === true)
  const repo = g?.webUrl ? repoLink(g.webUrl) : undefined

  // Git changes outside Mindeck (commits, pushes, a new remote): re-detect whenever a project is shown.
  useEffect(() => {
    void useProjects.getState().refresh(project.id)
  }, [project.id])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="flex items-start justify-between gap-3 border-b border-hud/50 px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate font-sans text-base font-semibold text-text-primary">{project.name}</h2>
          <p className="mt-0.5 truncate font-mono text-[11px] text-text-muted">{project.path}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusDot tone={g?.isRepo ? (g.dirty ? 'warn' : 'ok') : 'muted'} pulse={false} />
          <TechLabel className="text-text-muted">{g?.isRepo ? (g.dirty ? t.projects.dirty : t.projects.clean) : t.projects.noRepo}</TechLabel>
        </div>
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {/* git */}
        {g?.isRepo && (
          <section>
            <TechLabel className="mb-1.5 block text-text-secondary">{t.projects.git}</TechLabel>
            <Row label={t.projects.branch}>
              <span className="inline-flex items-center gap-1.5">
                <GitBranch size={12} className="text-cyan" />
                {g.branch ?? t.projects.detached}
              </span>
            </Row>
            {(g.ahead != null || g.behind != null) && (
              <Row label={t.projects.upstream}>
                <span className="inline-flex items-center gap-3">
                  <span className="inline-flex items-center gap-1">
                    <ArrowUp size={11} className="text-text-muted" />
                    {g.ahead ?? 0}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <ArrowDown size={11} className="text-text-muted" />
                    {g.behind ?? 0}
                  </span>
                </span>
              </Row>
            )}
            {g.lastCommit && (
              <Row label={t.projects.lastCommit}>
                <span className="flex min-w-0 items-start gap-1.5">
                  <GitCommitHorizontal size={12} className="mt-0.5 shrink-0 text-text-muted" />
                  <span className="min-w-0">
                    <span className="block truncate text-text-primary">{g.lastCommit.subject}</span>
                    <span className="block text-[10px] text-text-muted">
                      {g.lastCommit.hash.slice(0, 7)} · {g.lastCommit.author}
                    </span>
                  </span>
                </span>
              </Row>
            )}
          </section>
        )}

        {/* stack */}
        <section>
          <TechLabel className="mb-1.5 block text-text-secondary">{t.projects.stack}</TechLabel>
          {s?.languages.length ? (
            <Row label={t.projects.languages}>{s.languages.join(', ')}</Row>
          ) : (
            <Row label={t.projects.languages}><span className="text-text-muted">—</span></Row>
          )}
          {s?.frameworks.length ? (
            <Row label={t.projects.frameworks}>
              <span className="flex flex-wrap gap-1.5">
                {s.frameworks.map((f) => (
                  <span
                    key={f}
                    className="rounded-sm border border-hud/60 bg-elevated/40 px-1.5 py-0.5 text-[10px] text-text-secondary"
                  >
                    {f}
                  </span>
                ))}
              </span>
            </Row>
          ) : null}
          {s?.packageManager && <Row label={t.projects.pkgManager}>{s.packageManager}</Row>}
          <Row label={t.projects.readme}>
            <span className={cn('inline-flex items-center gap-1.5', s?.hasReadme ? 'text-text-secondary' : 'text-text-muted')}>
              <FileText size={12} />
              {s?.hasReadme ? t.projects.present : t.projects.none_}
            </span>
          </Row>
          {s?.packageJson?.scripts?.length ? (
            <Row label={t.projects.scripts}>
              <span className="flex flex-wrap gap-1.5">
                {s.packageJson.scripts.slice(0, 8).map((sc) => (
                  <span
                    key={sc}
                    className="inline-flex items-center gap-1 rounded-sm border border-hud/60 bg-elevated/40 px-1.5 py-0.5 text-[10px] text-text-secondary"
                  >
                    <Package size={10} className="text-text-muted" />
                    {sc}
                  </span>
                ))}
              </span>
            </Row>
          ) : null}
        </section>

        <ContextSection projectId={project.id} />
      </div>

      {/* actions */}
      <div className="flex flex-wrap gap-2 border-t border-hud/50 px-4 py-3">
        {shells && <ProjectTerminalMenu projectId={project.id} onShow={() => onNavigate('terminal')} />}
        {repo && <ActionButton icon={repo.Icon} label={repo.label} title={t.projects.openRepo(g!.webUrl!)} href={g!.webUrl} />}
        {desktop && githubDesktop && g?.isRepo && (
          <ActionButton icon={AppWindow} label={githubDesktop} title={t.projects.openIn(githubDesktop)} onClick={() => openInGitHubDesktop(project.id)} />
        )}
        {/* With an upstream: `git pull` right here — no terminal to stop for it. */}
        {shells && (g?.ahead != null || g?.behind != null) && (
          <ActionButton icon={ArrowDownToLine} label={t.projects.pull} title={t.projects.pullHint} onClick={() => void pull(project.id)} disabled={busy} />
        )}
        <ActionButton icon={RefreshCw} label={busy ? t.projects.refreshing : t.projects.refresh} onClick={() => refresh(project.id)} disabled={busy} />
        <div className="flex-1" />
        <ActionButton icon={Trash2} label={t.projects.remove} onClick={() => remove(project.id)} disabled={busy} danger />
      </div>
    </div>
  )
}
