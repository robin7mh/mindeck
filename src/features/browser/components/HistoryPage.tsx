import { useEffect, useRef, useState } from 'react'
import { Clock, Search, Trash2, X } from 'lucide-react'
import type { HistoryEntry } from '@shared/types/browser'
import { TechLabel } from '@/components/ui/TechLabel'
import { useLocale, useT } from '@/lib/i18n'
import { useOverlay } from '@/lib/overlay'
import { byDay, dayStart } from '../library'
import { useBrowser } from '../store'
import { displayUrl, hostOf, initial } from '../url'
import { openBookmark } from './BookmarksBar'

const PAGE = 150
const HOUR = 3_600_000
const DAY = 24 * HOUR

const small =
  'flex items-center gap-1.5 rounded-md border border-hud/60 px-2.5 py-1 font-sans text-[12px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan'

/** "Clear history…": the last hour, day, week — or everything. */
function ClearMenu({ onPick, onClose }: { onPick(range: 'hour' | 'day' | 'week' | 'all'): void; onClose(): void }) {
  const t = useT()
  useOverlay(true)
  return (
    <div className="fixed inset-0 z-60" onMouseDown={onClose}>
      <div role="menu" aria-label={t.library.clear} className="absolute right-6 top-24 w-52 rounded-lg border border-hud/70 bg-panel/95 p-1 shadow-xl shadow-black/40" onMouseDown={(e) => e.stopPropagation()}>
        {(['hour', 'day', 'week', 'all'] as const).map((r) => (
          <button key={r} type="button" role="menuitem" onClick={() => onPick(r)} className="block w-full rounded-md px-2.5 py-1.5 text-left font-sans text-[12.5px] text-text-primary hover:bg-danger/10 hover:text-danger">
            {t.library.clearRanges[r]}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * The history page (mindeck://history), drawn by Mindeck: pages by day,
 * newest first, searchable; single pages, whole days or the last hour, day
 * or week can be forgotten.
 */
export function HistoryPage() {
  const t = useT()
  const locale = useLocale((s) => s.locale)
  const run = useBrowser((s) => s.run)
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [more, setMore] = useState(false)
  const [clearing, setClearing] = useState(false)
  const seq = useRef(0)

  const load = async (before?: number) => {
    const mine = ++seq.current
    const page = await run('browser:historyList', { ...(query.trim() ? { query: query.trim() } : {}), ...(before !== undefined ? { before } : {}), limit: PAGE })
    if (!page || mine !== seq.current) return
    setEntries((prev) => [...(before !== undefined ? prev! : []), ...page])
    setMore(page.length === PAGE)
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new search, from the top; load itself reads the query
  }, [query])

  const forget = async (what: { urls?: string[]; from?: number; to?: number }) => {
    await run('browser:historyDelete', what)
    void load()
  }
  const clear = async (range: 'hour' | 'day' | 'week' | 'all') => {
    setClearing(false)
    if (range === 'all') await run('browser:clearHistory')
    else await run('browser:historyDelete', { from: Date.now() - { hour: HOUR, day: DAY, week: 7 * DAY }[range] })
    void load()
  }

  const today = dayStart(Date.now())
  const dayName = (day: number) =>
    day === today
      ? t.library.today
      : day === dayStart(today - 1)
        ? t.library.yesterday
        : new Date(day).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const time = (iso: string) => new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-8">
        <div className="flex items-center gap-3">
          <Clock size={18} className="text-cyan" />
          <h1 className="flex-1 font-sans text-[18px] font-semibold text-text-primary">{t.library.pages.history}</h1>
          <button type="button" onClick={() => setClearing(true)} className={`${small} hover:border-danger/50 hover:text-danger`}>
            <Trash2 size={12} /> {t.library.clear}
          </button>
        </div>
        <label className="flex items-center gap-2 rounded-lg border border-hud/60 bg-surface/60 px-3 py-2 focus-within:border-cyan/50">
          <Search size={14} className="text-text-muted" />
          <input
            autoFocus
            aria-label={t.library.historySearch}
            placeholder={t.library.historySearch}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent font-sans text-[13px] text-text-primary outline-hidden placeholder:text-text-muted"
          />
        </label>

        {entries && !entries.length && <p className="py-10 text-center font-sans text-[13px] text-text-muted">{query.trim() ? t.library.noHistoryHits : t.library.noHistory}</p>}
        {byDay(entries ?? []).map((group) => (
          <section key={group.day} aria-label={dayName(group.day)}>
            <div className="mb-1.5 flex items-center justify-between">
              <TechLabel as="h2" className="text-text-secondary">
                {dayName(group.day)}
              </TechLabel>
              <button type="button" onClick={() => void forget({ from: group.day, to: dayStart(group.day + DAY + 2 * HOUR) })} className="font-sans text-[11px] text-text-muted hover:text-danger">
                {t.library.removeDay}
              </button>
            </div>
            <ul className="overflow-hidden rounded-lg border border-hud/50 bg-surface/40">
              {group.entries.map((e) => (
                <li key={e.url} className="group flex items-center gap-3 border-b border-hud/30 px-3 py-1.5 last:border-b-0 hover:bg-elevated/40">
                  <span className="w-12 shrink-0 font-mono text-[11px] text-text-muted">{time(e.lastVisit)}</span>
                  <button type="button" title={e.url} onClick={(ev) => openBookmark(e.url, ev)} onAuxClick={(ev) => ev.button === 1 && openBookmark(e.url, ev)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border border-hud/60 bg-elevated/60 font-sans text-[10px] font-semibold text-cyan">{initial(e.url, e.title)}</span>
                    <span className="min-w-0 truncate font-sans text-[12.5px] text-text-primary">{e.title || displayUrl(e.url)}</span>
                    <span className="shrink-0 truncate font-mono text-[11px] text-text-muted">{hostOf(e.url)}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t.library.removeEntry(e.title || displayUrl(e.url))}
                    onClick={() => void forget({ urls: [e.url] })}
                    className="shrink-0 rounded-sm p-1 text-text-muted opacity-0 transition-opacity hover:bg-elevated hover:text-danger focus:opacity-100 group-hover:opacity-100"
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {more && entries && (
          <button type="button" onClick={() => void load(Date.parse(entries[entries.length - 1].lastVisit))} className={`${small} self-center`}>
            {t.library.showMore}
          </button>
        )}
      </div>
      {clearing && <ClearMenu onPick={(r) => void clear(r)} onClose={() => setClearing(false)} />}
    </div>
  )
}
