import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { ChevronRight } from 'lucide-react'
import type { FinderEntry } from '@shared/types/finder'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { pathChain } from '../kinds'
import { listAll, sortEntries, useFiles, visibleEntries } from '../store'
import type { EntryHandlers } from './Entries'
import { FileIcon } from './FileIcon'
import { DRAG_FILES, dropProps } from './Sidebar'
import { useWindow } from './Virtual'

const ITEM = 26

/** One column: a folder's entries, windowed like the list. */
function Column({ dir, entries, picked, last, handlers }: { dir: string; entries: FinderEntry[]; picked: string[]; last: boolean; handlers: EntryHandlers }) {
  const scroller = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState(false)
  const w = useWindow(scroller, entries.length, ITEM, { offset: 4 })

  const click = (entry: FinderEntry, e: MouseEvent) => {
    const s = useFiles.getState()
    const folder = entry.kind === 'dir' && !entry.bundle
    if (folder) return void s.open(entry.path)
    if (last) return s.select(entry.path, e.metaKey || e.ctrlKey ? 'toggle' : e.shiftKey ? 'range' : 'single')
    // A file in an earlier column: that column's folder becomes the current one.
    void s.open(dir).then(() => useFiles.getState().select(entry.path))
  }

  return (
    <div
      ref={scroller}
      role="listbox"
      aria-label={dir}
      {...dropProps(dir, setOver)}
      className={cn('h-full w-60 shrink-0 overflow-y-auto border-r border-hud/40 p-1', over && 'bg-cyan/5')}
    >
      <div style={{ height: w.before }} />
      {entries.slice(w.start, w.end).map((entry) => {
        const selected = picked.includes(entry.path)
        const folder = entry.kind === 'dir' && !entry.bundle
        return (
          <div
            key={entry.path}
            role="option"
            aria-selected={selected}
            draggable
            onDragStart={(e) => {
              if (useFiles.getState().startDrag([entry.path])) return e.preventDefault()
              e.dataTransfer.setData(DRAG_FILES, JSON.stringify([entry.path]))
            }}
            onClick={(e) => click(entry, e)}
            onDoubleClick={() => handlers.open(entry)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              handlers.menu(entry, e)
            }}
            className={cn(
              'flex h-[26px] cursor-default items-center gap-2 rounded-sm px-2 font-sans text-[12.5px]',
              selected ? (last ? 'bg-cyan/16 text-text-primary' : 'bg-elevated/80 text-text-primary') : 'text-text-secondary hover:bg-elevated/40',
              entry.hidden && 'opacity-60'
            )}
          >
            <FileIcon entry={entry} size={14} />
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {folder && <ChevronRight size={12} className="shrink-0 text-text-muted" />}
          </div>
        )
      })}
      <div style={{ height: w.after }} />
    </div>
  )
}

/**
 * Finder's column view: one column per folder from Home (or the disk) down
 * to the current one; the folder open in each column is marked in the one
 * before. Clicking a folder opens it as the next column.
 */
export function Columns({ handlers }: { handlers: EntryHandlers }) {
  const t = useT()
  const s = useFiles()
  const listing = s.listing!
  const chain = pathChain(listing.path, s.places?.home).map((c) => c.path)
  const [lists, setLists] = useState<Record<string, FinderEntry[]>>({})
  const strip = useRef<HTMLDivElement>(null)
  const key = `${s.hidden}:${chain.join('\n')}`

  // The earlier columns' folders (the current one is the store's listing).
  useEffect(() => {
    let alive = true
    for (const dir of chain.slice(0, -1)) {
      void listAll(dir, s.hidden).then(
        (l) => alive && setLists((prev) => ({ ...prev, [dir]: l.entries })),
        () => {}
      )
    }
    // The newest column comes into view.
    strip.current!.scrollLeft = strip.current!.scrollWidth
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key stands for the chain and the hidden-files setting
  }, [key])

  return (
    <div ref={strip} role="group" aria-label={t.files.columns} className="flex h-full min-w-0 overflow-x-auto">
      {chain.map((dir, i) => {
        const last = i === chain.length - 1
        return (
          <Column
            key={dir}
            dir={dir}
            last={last}
            handlers={handlers}
            entries={last ? visibleEntries(s) : sortEntries(lists[dir] ?? [], s.sort)}
            picked={last ? s.selected : [chain[i + 1]]}
          />
        )
      })}
    </div>
  )
}
