import { GitBranch, FolderGit2, Folder } from 'lucide-react'
import type { Project } from '@shared/types/project'
import { StatusDot } from '@/components/ui/StatusDot'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/cn'

function gitTone(p: Project): 'ok' | 'warn' | 'muted' {
  if (!p.git?.isRepo) return 'muted'
  return p.git.dirty ? 'warn' : 'ok'
}

export function ProjectListItem({
  project,
  active,
  onSelect
}: {
  project: Project
  active: boolean
  onSelect: () => void
}) {
  const t = useT()
  const Icon = project.git?.isRepo ? FolderGit2 : Folder
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group relative w-full rounded-md border px-3 py-2.5 text-left transition-colors',
        active
          ? 'border-cyan/40 bg-cyan/6'
          : 'border-hud/50 bg-surface/40 hover:border-hud-strong/60'
      )}
    >
      {active && <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-cyan" />}
      <div className="flex items-center gap-2.5">
        <Icon size={16} strokeWidth={1.8} className={active ? 'text-cyan' : 'text-text-muted'} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-sans text-[13px] font-medium text-text-primary">
            {project.name}
          </span>
          <span className="block truncate font-mono text-[10px] text-text-muted">{project.path}</span>
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 pl-[26px]">
        <StatusDot tone={gitTone(project)} pulse={false} />
        {project.git?.isRepo ? (
          <span className="flex items-center gap-1 font-mono text-[10px] text-text-secondary">
            <GitBranch size={11} className="text-text-muted" />
            {project.git.branch ?? t.projects.detached}
            {project.git.dirty && <span className="text-amber">•{t.projects.dirty}</span>}
          </span>
        ) : (
          <span className="font-mono text-[10px] text-text-muted">{t.projects.noRepo}</span>
        )}
        {project.stack?.frameworks.slice(0, 2).map((f) => (
          <span
            key={f}
            className="rounded-sm border border-hud/60 bg-elevated/40 px-1.5 py-px font-mono text-[9px] text-text-muted"
          >
            {f}
          </span>
        ))}
      </div>
    </button>
  )
}
