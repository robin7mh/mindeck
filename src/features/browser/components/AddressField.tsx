import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent, type RefObject } from 'react'
import { AppWindow, Clock, Globe, Search, Star } from 'lucide-react'
import { ipc } from '@shared/ipc/client'
import type { BrowserSuggestion, BrowserTab } from '@shared/types/browser'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useOverlay } from '@/lib/overlay'
import { activeTab, useBrowser } from '../store'
import { displayUrl, inlineCompletion, withSuggestions } from '../url'

const KIND_ICON = { navigate: Globe, search: Search, history: Clock, tab: AppWindow, bookmark: Star, suggestion: Search }
/** The search engine is asked once typing pauses this long. */
const SUGGEST_DELAY_MS = 150

export type AddressField = ReturnType<typeof useAddressField>

/**
 * Typing an address or search words — the address bar's, and the new-tab
 * page's field the same: suggestions from the open tabs, bookmarks, the history
 * and the search engine, Chrome's inline completion ("git" → "github.com"), the
 * arrows, Enter to go and Escape to let go. Not editing, it shows where `tab` is.
 */
export function useAddressField(tab: BrowserTab | undefined, input: RefObject<HTMLInputElement | null>) {
  const seq = useRef(0)
  const [editing, setEditing] = useState(false)
  const [typed, setTyped] = useState('')
  const [completion, setCompletion] = useState<{ suffix: string; url: string } | null>(null)
  const [items, setItems] = useState<BrowserSuggestion[]>([])
  const [index, setIndex] = useState(-1)
  const open = editing && items.length > 0
  useOverlay(open)
  const remote = useRef<ReturnType<typeof setTimeout>>(undefined)
  // The engine's suggestions join below the first line — unless one is picked already (nothing moves under the arrows).
  const picked = useRef(-1)
  useEffect(() => {
    picked.current = index
  }, [index])
  useEffect(() => () => clearTimeout(remote.current), [])

  // Focusing the field selects the whole address — in the very commit that puts it in, so text
  // typed right away (⌘L and go) replaces it instead of landing behind it.
  const selectAll = useRef(false)
  useLayoutEffect(() => {
    if (!selectAll.current) return
    selectAll.current = false
    input.current!.select()
  }, [editing, typed, input])
  // A click that focuses the field drops a caret where it lands: on release it selects everything, like Chrome.
  const clickFocus = useRef(false)

  // While the field has the focus but nothing was typed, it follows the tab: a page may move on
  // (a redirect). Once something is typed, that stays.
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
  }, [editing, typed, completion, input])

  const suggest = async (text: string, grew: boolean) => {
    const mine = ++seq.current
    clearTimeout(remote.current)
    const list = text.trim() ? await ipc('browser:suggest', { text }).catch(() => [] as BrowserSuggestion[]) : []
    if (mine !== seq.current) return
    setItems(list)
    setIndex(-1)
    const inline = grew ? inlineCompletion(text, list) : null
    setCompletion(inline && inline.value.length > text.length ? { suffix: inline.value.slice(text.length), url: inline.url } : null)
    // A private tab tells the search engine nothing.
    if (list.length && tab?.profile !== 'private') remote.current = setTimeout(() => void ask(text, mine), SUGGEST_DELAY_MS)
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

  return {
    editing,
    open,
    items,
    index,
    setIndex,
    go,
    /** What the `<input>` takes. */
    props: {
      spellCheck: false,
      autoCapitalize: 'off',
      autoCorrect: 'off',
      value: editing ? typed + (completion?.suffix ?? '') : displayUrl(url),
      onFocus: () => {
        selectAll.current = true
        typedSinceFocus.current = false
        setEditing(true)
        setTyped(url)
      },
      onMouseDown: (e: MouseEvent<HTMLInputElement>) => {
        clickFocus.current = document.activeElement !== e.currentTarget
      },
      onMouseUp: (e: MouseEvent<HTMLInputElement>) => {
        const el = e.currentTarget
        // Dragged over part of the address: that part stays selected.
        if (!clickFocus.current || el.selectionStart !== el.selectionEnd) return
        clickFocus.current = false
        e.preventDefault()
        el.select()
      },
      onBlur: () => {
        setEditing(false)
        reset()
      },
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        typedSinceFocus.current = true
        const next = e.target.value
        const grew = next.length > typed.length && next.startsWith(typed)
        setTyped(next)
        setCompletion(null)
        void suggest(next, grew)
      },
      onKeyDown
    }
  }
}

/** The suggestions under a field: the arrows or the mouse pick one, a click goes there. */
export function SuggestionList({ field, label, className }: { field: AddressField; label: string; className?: string }) {
  return (
    <ul role="listbox" aria-label={label} className={cn('absolute left-0 right-0 top-full z-50 overflow-hidden rounded-md border border-hud/50 bg-panel p-1 shadow-xl shadow-black/40', className)}>
      {field.items.map((s, i) => {
        const ItemIcon = KIND_ICON[s.kind]
        return (
          <li
            key={`${s.kind}:${s.tabId ?? s.url}`}
            role="option"
            aria-selected={i === field.index}
            onMouseEnter={() => field.setIndex(i)}
            onMouseDown={(e) => e.preventDefault()} // keep the field focused until the pick
            onClick={() => field.go(s)}
            className={cn('flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 transition-colors', i === field.index ? 'bg-cyan/10' : 'hover:bg-elevated/50')}
          >
            <ItemIcon size={13} className={cn('shrink-0', s.kind === 'tab' ? 'text-purple' : s.kind === 'bookmark' ? 'text-amber' : 'text-text-muted')} />
            <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-text-primary">{s.kind === 'search' || s.kind === 'suggestion' ? s.title : s.title || displayUrl(s.url)}</span>
            {s.kind !== 'search' && s.kind !== 'suggestion' && <span className="max-w-[45%] truncate font-mono text-[11px] text-text-muted">{displayUrl(s.url)}</span>}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The search field in the middle of a new tab (and a private one): typed into
 * right there, with the address bar's suggestions under it. A new tab puts the
 * caret here; ⌘L still goes to the address bar.
 */
export function PageSearch({ tone = 'cyan' }: { tone?: 'cyan' | 'purple' }) {
  const t = useT()
  const tab = useBrowser((s) => activeTab(s.state))
  const focusPage = useBrowser((s) => s.focusPage)
  const input = useRef<HTMLInputElement>(null)
  const field = useAddressField(tab, input)

  // A new tab: the caret is here at once.
  useEffect(() => {
    if (!focusPage) return
    input.current?.focus()
    useBrowser.setState({ focusPage: false })
  }, [focusPage])

  return (
    <div className="relative w-full max-w-xl">
      <label
        className={cn(
          'flex w-full cursor-text items-center gap-3 rounded-lg border px-4 py-3 transition-colors',
          field.editing ? (tone === 'purple' ? 'border-purple/50 bg-surface' : 'border-cyan/50 bg-surface') : cn('border-hud/60 bg-surface/70', tone === 'purple' ? 'hover:border-purple/50' : 'hover:border-hud-strong/80')
        )}
      >
        <Search size={16} className="shrink-0 text-text-muted" />
        <input
          ref={input}
          aria-label={t.browser.ntpSearch}
          placeholder={t.browser.ntpSearch}
          {...field.props}
          className="min-w-0 flex-1 bg-transparent font-sans text-[14px] text-text-primary outline-hidden placeholder:text-text-muted"
        />
      </label>
      {field.open && <SuggestionList field={field} label={t.browser.ntpSearch} className="mt-1.5 text-left" />}
    </div>
  )
}
