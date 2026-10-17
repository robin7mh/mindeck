import { useEffect, useState } from 'react'
import { FolderPlus, FolderGit2, AlertTriangle } from 'lucide-react'
import { Panel } from '@/components/ui/Panel'
import { TechLabel } from '@/components/ui/TechLabel'
import { useProjects, useSelectedProject } from '../store'
import { ProjectListItem } from './ProjectList'
import { ProjectDetailPanel } from './ProjectDetailPanel'
import { FolderPicker } from '@/components/ui/FolderPicker'
import { isDesktop } from '@shared/ipc/client'
import { useT } from '@/lib/i18n'
import type { ModuleId } from '@/types'
import { RemoteMenu } from '@/features/remote/components/RemoteMenu'

export function ProjectsView({ onNavigate }: { onNavigate: (module: ModuleId) => void }) {
  const t = useT()
  const { projects, selectedId, loading, error, load, addViaPicker, addPath, select } = useProjects()
  const selected = useSelectedProject()
  const [browsing, setBrowsing] = useState(false)

  // Desktop: native dialog. Browser: browse folders on the core's machine.
  const add = () => (isDesktop() ? void addViaPicker() : setBrowsing(true))

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Panel
      title={t.projects.title}
      corners
      flush
      className="min-h-0 flex-1"
      headerRight={
        <div className="flex items-center gap-3">
          <TechLabel className="text-text-muted">{t.projects.registered(projects.length)}</TechLabel>
          {isDesktop() && <RemoteMenu project={selected} />}
          <button
            type="button"
            onClick={add}
            className="flex items-center gap-1.5 rounded-md border border-cyan/40 bg-cyan/6 px-2.5 py-1 font-sans text-[12px] font-medium text-cyan transition-colors hover:bg-cyan/12"
          >
            <FolderPlus size={14} strokeWidth={2} />
            {t.projects.add}
          </button>
        </div>
      }
      bodyClassName="flex min-h-0"
    >
      {/* left: list */}
      <div className="flex w-72 shrink-0 flex-col border-r border-hud/50">
        {error && (
          <div className="m-2 flex items-start gap-2 rounded-md border border-danger/40 bg-danger/6 px-2.5 py-2">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger" />
            <span className="font-mono text-[11px] text-text-secondary">{error}</span>
          </div>
        )}
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
          {loading && projects.length === 0 && (
            <p className="px-2 py-4 font-mono text-[11px] text-text-muted">{t.common.loading}</p>
          )}
          {!loading && projects.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-3 py-10 text-center">
              <FolderGit2 size={26} className="text-text-muted" />
              <p className="font-sans text-[12px] text-text-secondary">{t.projects.none}</p>
              <p className="font-mono text-[10px] text-text-muted">{t.projects.addFolder}</p>
            </div>
          )}
          {projects.map((p) => (
            <ProjectListItem
              key={p.id}
              project={p}
              active={p.id === selectedId}
              onSelect={() => select(p.id)}
            />
          ))}
        </div>
      </div>

      {/* right: detail */}
      <div className="min-w-0 flex-1">
        {selected ? (
          <ProjectDetailPanel project={selected} onNavigate={onNavigate} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="font-mono text-[12px] text-text-muted">{t.projects.select}</p>
          </div>
        )}
      </div>
      {browsing && (
        <FolderPicker
          title={t.projects.addFolderTitle}
          confirmLabel={t.projects.add}
          onClose={() => setBrowsing(false)}
          onPick={(path) => {
            setBrowsing(false)
            void addPath(path)
          }}
        />
      )}
    </Panel>
  )
}
