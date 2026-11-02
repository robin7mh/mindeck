import { create } from 'zustand'
import { useEditor } from '@/features/editor/store'

/** A file opened in the editor, by project and path inside it. */
export interface RecentFile {
  projectId: string
  path: string
}

const KEY = 'mindeck.recentFiles'
export const MAX_RECENT_FILES = 12

const isRecent = (v: unknown): v is RecentFile =>
  typeof v === 'object' && v !== null && typeof (v as RecentFile).projectId === 'string' && typeof (v as RecentFile).path === 'string'

function load(): RecentFile[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter(isRecent).slice(0, MAX_RECENT_FILES) : []
  } catch {
    return []
  }
}

/** The files last shown in the editor, the latest first — remembered per device, for the palette. */
export const useRecentFiles = create<{ files: RecentFile[] }>(() => ({ files: load() }))

/** A file was shown in the editor: it moves to the top. */
export function rememberFile(file: RecentFile): void {
  const files = [file, ...useRecentFiles.getState().files.filter((f) => f.projectId !== file.projectId || f.path !== file.path)].slice(0, MAX_RECENT_FILES)
  useRecentFiles.setState({ files })
  try {
    localStorage.setItem(KEY, JSON.stringify(files))
  } catch {
    /* storage unavailable: remembered until reload */
  }
}

/** Follow the editor: each file it shows (the active tab) is remembered. Returns: stop following. */
export function trackRecentFiles(): () => void {
  return useEditor.subscribe((s, before) => {
    if (s.activeId === before.activeId) return
    const tab = s.tabs.find((x) => x.id === s.activeId)
    if (tab) rememberFile({ projectId: tab.projectId, path: tab.path })
  })
}
