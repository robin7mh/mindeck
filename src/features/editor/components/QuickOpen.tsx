import { useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { usePalette } from '@/features/palette/store'
import { useEditor } from '../store'
import { useScm, type PickItem } from '../scm'

/** Fuzzy match: every query character in order; earlier, denser and file-name hits score better (lower). */
export function fuzzyScore(path: string, query: string): number | null {
  const p = path.toLowerCase()
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return 0
  const base = p.lastIndexOf('/') + 1
  let at = -1
  let score = 0
  for (const ch of q) {
    const next = p.indexOf(ch, at + 1)
    if (next < 0) return null
    score += next - at - 1 // gaps cost
    at = next
  }
  if (p.slice(base).includes(q)) score -= 1000 // the file name itself matches
  return score + p.length / 100
}

/** The best matches of `query`, by `key`. */
function rank<T>(items: T[], query: string, key: (item: T) => string, limit = 60): T[] {
  return items
    .map((item) => ({ item, score: fuzzyScore(key(item), query) }))
    .filter((h): h is { item: T; score: number } => h.score !== null)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((h) => h.item)
}

/**
 * VS Code's quick open: a file by name (⌘P), a line after `:` (⌃G) — or a
 * list another command asked to choose from. A `>` hands over to Mindeck's
 * command palette (⇧⌘P / F1), as in VS Code.
 */
export function QuickOpen() {
  const t = useT()
  const files = useScm((s) => s.files)
  const pick = useScm((s) => s.pick)
  const [query, setQuery] = useState(() => useScm.getState().quickQuery)
  const [active, setActive] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  const close = () => useScm.getState().setQuickOpen(false)

  const mode = pick ? 'pick' : query.startsWith(':') ? 'line' : 'files'
  const line = Number.parseInt(query.slice(1), 10)
  const activeTab = useEditor((s) => s.activeId)

  const hits: PickItem[] = useMemo(() => {
    if (mode === 'pick') return rank(pick!.items, query, (i) => i.label)
    if (mode === 'line') {
      return activeTab && line > 0 ? [{ id: 'line', label: t.palette.lineHint(line), run: () => useEditor.setState({ reveal: { id: activeTab, line } }) }] : []
    }
    return rank(files, query, (path) => path).map((path) => {
      const name = path.slice(path.lastIndexOf('/') + 1)
      return {
        id: path,
        label: name,
        detail: path.slice(0, path.length - name.length),
        run: () => {
          useScm.getState().closeDiff()
          return useEditor.getState().open(path)
        }
      }
    })
  }, [mode, query, files, pick, activeTab, line, t.palette])

  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (item: PickItem) => {
    close()
    void item.run()
  }
  const enter = () => {
    if (hits[active]) return choose(hits[active])
    if (pick?.onText && query.trim()) {
      close()
      void pick.onText(query.trim())
    }
  }

  const label = pick?.placeholder ?? (mode === 'line' ? t.palette.goToLine : t.scm.quickOpen)
  const empty = mode === 'line' ? (activeTab ? t.palette.lineEmpty : t.palette.noEditor) : mode === 'pick' ? (pick!.onText ? null : t.palette.noMatches) : t.scm.noFiles

  return (
    <div role="dialog" aria-label={label} className="fixed inset-0 z-60 flex justify-center bg-void/40 pt-[12vh]" onMouseDown={close}>
      <div className="h-fit w-[min(600px,90vw)] overflow-hidden rounded-lg border border-hud/70 bg-panel/95 shadow-2xl shadow-black/50 backdrop-blur-md" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          aria-label={label}
          placeholder={label}
          value={query}
          onChange={(e) => {
            const value = e.target.value
            // "> …": the commands — the palette takes over with what follows.
            if (!pick && value.startsWith('>')) {
              close()
              return usePalette.getState().show(value.slice(1).trimStart())
            }
            setQuery(value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => Math.min(hits.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') enter()
          }}
          className="w-full border-b border-hud/60 bg-transparent px-3 py-2.5 font-sans text-[13.5px] text-text-primary outline-hidden placeholder:text-text-muted"
        />
        <ul ref={list} role="listbox" aria-label={label} className="max-h-[50vh] overflow-y-auto p-1">
          {!hits.length && pick?.onText && query.trim() && (
            <li className="flex items-center gap-2 px-3 py-2 font-sans text-[12px] text-text-secondary">
              <CornerDownLeft size={12} /> {pick.placeholder}: <span className="font-mono text-text-primary">{query.trim()}</span>
            </li>
          )}
          {!hits.length && empty && <li className="px-3 py-2 font-sans text-[12px] text-text-muted">{empty}</li>}
          {hits.map((h, i) => (
            <li
              key={h.id}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(h)}
              className={cn('flex cursor-pointer items-baseline gap-2 rounded-md px-2.5 py-1.5', i === active && 'bg-cyan/10')}
            >
              <span className="shrink-0 font-sans text-[12.5px] text-text-primary">{h.label}</span>
              {h.detail && <span className="min-w-0 truncate font-mono text-[10.5px] text-text-muted">{h.detail}</span>}
              {h.keys && <span className="ml-auto shrink-0 font-mono text-[10.5px] text-text-muted">{h.keys}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
