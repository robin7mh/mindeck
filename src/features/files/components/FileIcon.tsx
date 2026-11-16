import { useState } from 'react'
import { AppWindow, File, FileAudio, FileCode, FileImage, FileText, FileVideo, Folder, type LucideIcon } from 'lucide-react'
import type { FinderEntry } from '@shared/types/finder'
import { cn } from '@/lib/cn'
import { entryKind, thumbUrl, type EntryKind } from '../kinds'

const ICONS: Record<EntryKind, LucideIcon> = {
  dir: Folder,
  bundle: AppWindow,
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  text: FileCode,
  binary: File
}

const TONES: Record<EntryKind, string> = {
  dir: 'text-cyan',
  bundle: 'text-purple',
  image: 'text-green',
  video: 'text-amber',
  audio: 'text-purple',
  pdf: 'text-danger',
  text: 'text-blue',
  binary: 'text-text-muted'
}

/** An entry's icon — in the grid a real thumbnail (Quick Look on macOS) where the OS has one. */
export function FileIcon({ entry, size = 15, thumb = false }: { entry: FinderEntry; size?: number; thumb?: boolean }) {
  const kind = entryKind(entry)
  const [failed, setFailed] = useState(false)
  const Icon = ICONS[kind]
  // Quick Look pictures where they say something (photos, videos, PDFs, apps, documents) — text reads better as an icon.
  if (thumb && !failed && kind !== 'dir' && kind !== 'text' && kind !== 'audio') {
    return (
      <img
        src={thumbUrl(entry.path, size * 2)}
        alt=""
        loading="lazy"
        draggable={false}
        onError={() => setFailed(true)}
        className="h-full w-full object-contain"
        style={{ maxWidth: size, maxHeight: size }}
      />
    )
  }
  return <Icon size={size} strokeWidth={1.6} className={cn('shrink-0', TONES[kind])} aria-hidden />
}
