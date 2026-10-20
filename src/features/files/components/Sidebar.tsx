import { useEffect, useState, type DragEvent } from 'react'
import { BrainCircuit, Download, FileText, Film, Folder, FolderGit2, HardDrive, House, Image, Monitor, Music, X, type LucideIcon } from 'lucide-react'
import { ipc } from '@shared/ipc/client'
import type { FinderPlaceId } from '@shared/types/finder'
import { TechLabel } from '@/components/ui/TechLabel'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useProjects } from '@/features/projects/store'
import { baseName } from '../kinds'
import { useFiles } from '../store'

export const DRAG_FILES = 'application/x-mindeck-files'

const PLACE_ICONS: Record<FinderPlaceId, LucideIcon> = {
  home: House,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  pictures: Image,
  movies: Film,
  music: Music
}

/** Files from the OS (Finder, Explorer, the desktop — or an OS drag of Mindeck's own). */
const OS_FILES = 'Files'

/**
 * Dropping on a folder: Mindeck's own entries move there (⌥ copies); files
 * from other apps are copied in.
 */
export function dropProps(dest: string, setOver: (over: boolean) => void) {
  return {
    onDragOver: (e: DragEvent) => {
      const types = e.dataTransfer.types
      const os = types.includes(OS_FILES)
      if (!types.includes(DRAG_FILES) && !os) return
      e.preventDefault()
      e.dataTransfer.dropEffect = e.altKey || (os && !useFiles.getState().dragging) ? 'copy' : 'move'
      setOver(true)
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      setOver(false)
      const own = e.dataTransfer.getData(DRAG_FILES)
      if (!own) return void useFiles.getState().dropFiles([...e.dataTransfer.files], dest, e.altKey)
      const paths = (JSON.parse(own) as string[]).filter((p) => p !== dest)
      if (paths.length) void useFiles.getState().move(paths, dest, e.altKey)
    }
  }
}

function Place({ icon: Icon, label, path, tone, onRemove }: { icon: LucideIcon; label: string; path: string; tone?: string; onRemove?: () => void }) {
  const t = useT()
  const current = useFiles((s) => s.listing?.path)
  const [over, setOver] = useState(false)
  const active = current === path
  const button = (
    <button
      type="button"
      title={path}
      onClick={() => void useFiles.getState().open(path)}
      {...dropProps(path, setOver)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-sans text-[12.5px] transition-colors',
        active ? 'bg-cyan/8 text-text-primary' : 'text-text-secondary hover:bg-elevated/50 hover:text-text-primary',
        over && 'bg-cyan/15 ring-1 ring-cyan/50'
      )}
    >
      <Icon size={14} className={cn('shrink-0', active ? 'text-cyan' : tone ?? 'text-text-muted')} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
  if (!onRemove) return button
  // A pinned folder: removable from the sidebar.
  return (
    <div className="group relative">
      {button}
      <button
        type="button"
        aria-label={t.files.removeFromSidebar}
        title={t.files.removeFromSidebar}
        onClick={onRemove}
        className="absolute right-1 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-text-muted opacity-0 transition-opacity hover:text-text-primary group-hover:opacity-100"
      >
        <X size={11} />
      </button>
    </div>
  )
}

/** Favorites, Mindeck's own places, the projects and external drives — like Finder's sidebar. */
export function Sidebar() {
  const t = useT()
  const places = useFiles((s) => s.places)
  const favorites = useFiles((s) => s.favorites)
  const projects = useProjects((s) => s.projects)
  const [vault, setVault] = useState<string>()

  useEffect(() => {
    void ipc('memory:status')
      .then((s) => s.exists && setVault(s.root))
      .catch(() => {})
    if (!useProjects.getState().projects.length) void useProjects.getState().load()
  }, [])

  return (
    <nav aria-label={t.files.title} className="flex w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r border-hud/50 p-2">
      <div>
        <TechLabel className="mb-1 block px-2 text-text-muted">{t.files.favorites}</TechLabel>
        {places?.places.map((p) => <Place key={p.id} icon={PLACE_ICONS[p.id]} label={t.files.places[p.id]} path={p.path} />)}
        {vault && <Place icon={BrainCircuit} label={t.files.vault} path={vault} tone="text-purple" />}
        {favorites.map((path) => (
          <Place key={path} icon={Folder} label={baseName(path)} path={path} tone="text-cyan" onRemove={() => useFiles.getState().toggleFavorite(path)} />
        ))}
      </div>
      {projects.length > 0 && (
        <div>
          <TechLabel className="mb-1 block px-2 text-text-muted">{t.files.projects}</TechLabel>
          {projects.map((p) => (
            <Place key={p.id} icon={FolderGit2} label={p.name} path={p.path} tone="text-cyan" />
          ))}
        </div>
      )}
      {!!places?.volumes.length && (
        <div>
          <TechLabel className="mb-1 block px-2 text-text-muted">{t.files.locations}</TechLabel>
          {places.volumes.map((v) => (
            <Place key={v.path} icon={HardDrive} label={v.name} path={v.path} />
          ))}
        </div>
      )}
    </nav>
  )
}
