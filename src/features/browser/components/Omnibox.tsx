import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AppWindow, Boxes, Clock, FileText, Globe, Laptop, Lock, Search, ShieldAlert, Star, VenetianMask } from 'lucide-react'
import { ipc } from '@shared/ipc/client'
import type { BrowserSuggestion, BrowserTab } from '@shared/types/browser'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useOverlay } from '@/lib/overlay'
import { findByUrl } from '../library'
import { useBrowser } from '../store'
import { displayUrl, inlineCompletion, security, withSuggestions } from '../url'
import { ShieldButton } from './Protection'

const SECURITY_ICON = { secure: Lock, insecure: ShieldAlert, local: Laptop, file: FileText, none: Search }
const KIND_ICON = { navigate: Globe, search: Search, history: Clock, tab: AppWindow, bookmark: Star, suggestion: Search }
/** The search engine is asked once typing pauses this long. */
const SUGGEST_DELAY_MS = 150

/**
 * The address bar: an address or search words, with suggestions from the
 * open tabs, bookmarks, the history and the search engine, and Chrome's
 * inline completion ("git" → "github.com"). While not editing it shows where
 * the tab is — and a star to bookmark it (⌘D).
 */
export function Omnibox({ tab }: { tab?: BrowserTab }) {
  const t = useT()
  const focusTick = useBrowser((s) => s.focusTick)
  const input = useRef<HTMLInputElement>(null)
  const seq = useRef(0)
  const [editing, setEditing] = useState(false)
  const [typed, setTyped] = useState('')
  const [completion, setCompletion] = useState<{ suffix: string; url: string } | null>(null)
  const [items, setItems] = useState<BrowserSuggestion[]>([])
  const [index, setIndex] = useState(-1)
  const open = editing && items.length > 0
  useOverlay(open)
  const bookmarked = useBrowser((s) => !!tab?.url && !!findByUrl(s.bookmarks, tab.url))
  const remote = useRef<ReturnType<typeof setTimeout>>(undefined)
  // The engine's suggestions join below the first line — unless one is picked already (nothing moves under the arrows).
  const picked = useRef(-1)
  useEffect(() => {
    picked.current = index
  }, [index])
  useEffect(() => () => clearTimeout(remote.current), [])

  // ⌘L / ⌘T / a new tab: into the bar, everything selected.
  useEffect(() => {
    if (!focusTick) return
    input.current?.focus()
    input.current?.select()
  }, [focusTick])

  // Focusing the bar selects the whole address — in the very commit that puts it in, so text
  // typed right away (⌘L and go) replaces it instead of landing behind it.
  const selectAll = useRef(false)
  useLayoutEffect(() => {
    if (!selectAll.current) return
    selectAll.current = false
    input.current!.select()
  }, [editing, typed])
  // A click that focuses the bar drops a caret where it lands: on release it selects everything, like Chrome.
  const clickFocus = useRef(false)

  // While the bar has the focus but nothing was typed, it follows the tab: ⌘T focuses it before the
  // new tab arrives, and a page may move on (a redirect). Once something is typed, that stays.
  const url = tab?.url ?? ''
  const typedSinceFocus = useRef(false)
  useLayoutEffect(() => {
    if (!editing || typedSinceFocus.current || typed === url) return
    selectAll.current = true
    setTyped(url)
  }, [editing, typed, url])

  // The completion is shown selected, so typing on replaces it.
  useLayoutEffect(() => {
    if (editing && completion) input.current?.setSelectionRange(typed.length, typed.length + completion.suffix.length)
  }, [editing, typed, completion])

  const suggest = async (text: string, grew: boolean) => {
    const mine = ++seq.current
    clearTimeout(remote.current)
    const list = text.trim() ? await ipc('browser:suggest', { text }).catch(() => [] as BrowserSuggestion[]) : []
    if (mine !== seq.current) return
    setItems(list)
    setIndex(-1)
    const inline = grew ? inlineCompletion(text, list) : null
    setCompletion(inline && inline.value.length > text.length ? { suffix: inline.value.slice(text.length), url: inline.url } : null)
    if (list.length) remote.current = setTimeout(() => void ask(text, mine), SUGGEST_DELAY_MS)
  }

  /** What the search engine suggests (when the user allows it), once typing paused. */
  const ask = async (text: string, mine: number) => {
    const extra = await ipc('browser:searchSuggest', { text }).catch(() => [] as BrowserSuggestion[])
    if (mine !== seq.current || !extra.length || picked.current >= 0) return
    setItems((list) => withSuggestions(list, extra))
  }

  const reset = () => {
    clearTimeout(remote.current)
    seq.current += 1
    setItems([])
    setIndex(-1)
    setCompletion(null)
  }

  const go = (target: BrowserSuggestion | { url: string; kind?: undefined; tabId?: undefined }) => {
    reset()
    setEditing(false)
    input.current?.blur()
    const store = useBrowser.getState()
    if (target.kind === 'tab' && target.tabId) void store.run('browser:activate', { id: target.tabId })
    else void store.go(target.url)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return
      e.preventDefault()
      setCompletion(null)
      setIndex((i) => (e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(-1, i - 1)))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (index >= 0) go(items[index])
      else if (completion) go({ url: completion.url })
      else if (typed.trim()) go({ url: typed })
    } else if (e.key === 'Tab' && completion) {
      e.preventDefault()
      setTyped(typed + completion.suffix)
      setCompletion(null)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (open) return reset()
      setTyped(url)
      input.current?.blur()
    }
  }

  const value = editing ? typed + (completion?.suffix ?? '') : displayUrl(url)
  const kind = security(url)
  const Icon = SECURITY_ICON[kind]
  const iconTitle = { secure: t.browser.secure, insecure: t.browser.insecure, local: t.browser.local, file: t.browser.file, none: t.browser.address }[kind]

  return (
    <div className="relative min-w-0 flex-1">
      <div
        className={cn(
          'flex h-8 items-center gap-2 rounded-md border px-2.5 transition-colors',
          editing ? 'border-cyan/50 bg-surface' : 'border-hud/60 bg-surface/50 hover:border-hud-strong/70'
        )}
      >
        {tab?.profile === 'private' && (
          <span title={t.browserExtras.privateHint} className="flex shrink-0 items-center gap-1 rounded-sm bg-purple/15 px-1.5 py-0.5 font-sans text-[10.5px] text-purple">
            <VenetianMask size={12} aria-hidden /> {t.browserExtras.privateTab}
          </span>
        )}
        {tab?.profile === 'agents' && (
          <span title={t.browserExtras.agentsContainer} aria-label={t.browserExtras.agentsContainer} className="shrink-0 text-purple">
            <Boxes size={13} aria-hidden />
          </span>
        )}
        <span title={iconTitle} className={cn('shrink-0', kind === 'insecure' ? 'text-amber' : kind === 'secure' ? 'text-green' : 'text-text-muted')}>
          <Icon size={13} aria-hidden />
        </span>
        <input
          ref={input}
          aria-label={t.browser.address}
          placeholder={t.browser.addressHint}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={value}
          onFocus={() => {
            selectAll.current = true
            typedSinceFocus.current = false
            setEditing(true)
            setTyped(url)
          }}
          onMouseDown={(e) => {
            clickFocus.current = document.activeElement !== e.currentTarget
          }}
          onMouseUp={(e) => {
            const el = e.currentTarget
            // Dragged over part of the address: that part stays selected.
            if (!clickFocus.current || el.selectionStart !== el.selectionEnd) return
            clickFocus.current = false
            e.preventDefault()
            el.select()
          }}
          onBlur={() => {
            setEditing(false)
            reset()
          }}
          onChange={(e) => {
            typedSinceFocus.current = true
            const next = e.target.value
            const grew = next.length > typed.length && next.startsWith(typed)
            setTyped(next)
            setCompletion(null)
            void suggest(next, grew)
          }}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-text-primary outline-hidden placeholder:font-sans placeholder:text-text-muted"
        />
        {tab && !editing && <ShieldButton tab={tab} />}
        {/* A private tab leaves no bookmarks behind. */}
        {!editing && tab && tab.profile !== 'private' && /^(https?|file):/i.test(tab.url) && (
          <button
            type="button"
            aria-label={bookmarked ? t.library.starred : t.library.star}
            title={bookmarked ? t.library.starred : t.library.star}
            onClick={() => void useBrowser.getState().bookmarkActive()}
            className={cn('shrink-0 rounded-sm p-0.5 transition-colors hover:bg-elevated', bookmarked ? 'text-amber' : 'text-text-muted hover:text-amber')}
          >
            <Star size={13} className={bookmarked ? 'fill-current' : undefined} />
          </button>
        )}
      </div>
      {open && (
        <ul
          role="listbox"
          aria-label={t.browser.address}
          className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-hud/70 bg-panel/95 p-1 shadow-xl shadow-black/40 backdrop-blur-md"
        >
          {items.map((s, i) => {
            const ItemIcon = KIND_ICON[s.kind]
            return (
              <li
                key={`${s.kind}:${s.tabId ?? s.url}`}
                role="option"
                aria-selected={i === index}
                onMouseEnter={() => setIndex(i)}
                onMouseDown={(e) => e.preventDefault()} // keep the bar focused until the pick
                onClick={() => go(s)}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 transition-colors',
                  i === index ? 'bg-cyan/10' : 'hover:bg-elevated/50'
                )}
              >
                <ItemIcon size={13} className={cn('shrink-0', s.kind === 'tab' ? 'text-purple' : s.kind === 'bookmark' ? 'text-amber' : 'text-text-muted')} />
                <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-text-primary">{s.kind === 'search' || s.kind === 'suggestion' ? s.title : s.title || displayUrl(s.url)}</span>
                {s.kind !== 'search' && s.kind !== 'suggestion' && <span className="max-w-[45%] truncate font-mono text-[11px] text-text-muted">{displayUrl(s.url)}</span>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
