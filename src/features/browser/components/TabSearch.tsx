import { useEffect, useMemo, useRef, useState } from 'react'
import { AppWindow, Clock, Star } from 'lucide-react'
import { ipc } from '@shared/ipc/client'
import type { HistoryEntry } from '@shared/types/browser'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useOverlay } from '@/lib/overlay'
import { searchBookmarks, tabLabel } from '../library'
import { useBrowser } from '../store'
import { displayUrl } from '../url'

interface Hit {
  kind: 'tabs' | 'bookmarks' | 'history'
  key: string
  title: string
  url: string
  tabId?: string
}

const ICON = { tabs: AppWindow, bookmarks: Star, history: Clock }

function Search() {
  const t = useT()
  useOverlay(true)
  const tabs = useBrowser((s) => s.state.tabs)
  const tree = useBrowser((s) => s.bookmarks)
  const [query, setQuery] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [active, setActive] = useState(0)
  const seq = useRef(0)
  const list = useRef<HTMLUListElement>(null)
  const close = () => useBrowser.getState().setTabSearch(false)

  useEffect(() => {
    const mine = ++seq.current
    if (!query.trim()) return setHistory([])
    void ipc('browser:history', { query: query.trim(), limit: 8 })
      .then((h) => mine === seq.current && setHistory(h))
      .catch(() => {})
  }, [query])

  const hits = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const out: Hit[] = tabs
      .filter((tab) => words.every((w) => `${tabLabel(tab, t.library.pages)} ${tab.url}`.toLowerCase().includes(w)))
      .map((tab) => ({ kind: 'tabs', key: `t:${tab.id}`, title: tabLabel(tab, t.library.pages) || t.browser.untitled, url: tab.url, tabId: tab.id }))
    out.push(...searchBookmarks(tree, query, 8).map((b): Hit => ({ kind: 'bookmarks', key: `b:${b.id}`, title: b.title || displayUrl(b.url), url: b.url })))
    out.push(...history.map((h): Hit => ({ kind: 'history', key: `h:${h.url}`, title: h.title || displayUrl(h.url), url: h.url })))
    return out
  }, [tabs, tree, history, query, t])

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (hit: Hit) => {
    close()
    const store = useBrowser.getState()
    if (hit.tabId) void store.run('browser:activate', { id: hit.tabId })
    else void store.run('browser:open', { url: hit.url })
  }

  return (
    <div role="dialog" aria-label={t.library.tabSearch} className="fixed inset-0 z-60 flex justify-center bg-void/40 pt-[12vh]" onMouseDown={close}>
      <div className="h-fit w-[min(600px,90vw)] overflow-hidden rounded-lg border border-hud/70 bg-panel/95 shadow-2xl shadow-black/50 backdrop-blur-md" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          aria-label={t.library.tabSearch}
          placeholder={t.library.tabSearch}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
            else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(0, Math.min(hits.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))))
            } else if (e.key === 'Enter' && hits[active]) choose(hits[active])
          }}
          className="w-full border-b border-hud/60 bg-transparent px-3 py-2.5 font-sans text-[13.5px] text-text-primary outline-hidden placeholder:text-text-muted"
        />
        <ul ref={list} role="listbox" aria-label={t.library.tabSearch} className="max-h-[55vh] overflow-y-auto p-1">
          {!hits.length && <li className="px-3 py-3 font-sans text-[12.5px] text-text-muted">{t.library.nothingFound}</li>}
          {hits.map((hit, i) => {
            const Icon = ICON[hit.kind]
            return (
              <li key={hit.key} role="presentation">
                {(i === 0 || hits[i - 1].kind !== hit.kind) && <p className="px-2.5 pb-0.5 pt-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">{t.library.sections[hit.kind]}</p>}
                <div
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(hit)}
                  className={cn('flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5', i === active ? 'bg-cyan/10' : 'hover:bg-elevated/50')}
                >
                  <Icon size={13} className={cn('shrink-0', hit.kind === 'tabs' ? 'text-purple' : 'text-text-muted')} />
                  <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-text-primary">{hit.title}</span>
                  <span className="max-w-[45%] truncate font-mono text-[11px] text-text-muted">{displayUrl(hit.url)}</span>
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

/** ⌘⇧A: one search over the open tabs, the bookmarks and the history. A tab is switched to, the rest opens in a new tab. */
export function TabSearch() {
  const open = useBrowser((s) => s.tabSearchOpen)
  return open ? <Search /> : null
}
