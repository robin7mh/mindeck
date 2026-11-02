import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import type { FindOptions, XtermApi } from '../useXterm'

/**
 * Find in a terminal's output (⌘F / Ctrl+Shift+F): every match highlighted,
 * Enter / Shift+Enter (or the arrows) to the next / previous, match case and
 * regular expressions. Escape closes it and gives the terminal its keys back.
 */
export function TerminalFind({ api, onClose }: { api: XtermApi; onClose: () => void }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [opts, setOpts] = useState<FindOptions>({ caseSensitive: false, regex: false })
  const [results, setResults] = useState<{ index: number; count: number }>()
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current!.focus()
    const sub = api.onFindResults(setResults)
    return () => {
      sub.dispose()
      api.clearFind()
    }
  }, [api])

  // Typing (or a changed option) searches from where the current match is.
  useEffect(() => {
    if (query) api.find(query, opts)
    else {
      api.clearFind()
      setResults(undefined)
    }
  }, [api, query, opts])

  const step = (backwards: boolean) => void api.find(query, opts, backwards)
  const close = () => {
    onClose()
    api.focus()
  }

  const toggle = (key: keyof FindOptions, label: string, glyph: string) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={!!opts[key]}
      onClick={() => setOpts((o) => ({ ...o, [key]: !o[key] }))}
      className={cn(
        'flex h-5 min-w-5 items-center justify-center rounded-sm px-1 font-mono text-[10.5px] transition-colors',
        opts[key] ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:text-text-secondary'
      )}
    >
      {glyph}
    </button>
  )

  const nav = 'rounded-sm p-0.5 text-text-muted transition-colors hover:bg-elevated hover:text-text-primary disabled:opacity-40'

  return (
    <div
      role="search"
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute right-3 top-1.5 z-20 flex items-center gap-1 rounded-md border border-hud/70 bg-panel/95 px-1.5 py-1 shadow-lg shadow-black/30 backdrop-blur-md"
    >
      <input
        ref={input}
        value={query}
        aria-label={t.terminal.find}
        placeholder={t.terminal.find}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') step(e.shiftKey)
          else if (e.key === 'Escape') close()
          else return
          e.preventDefault()
        }}
        className="w-44 bg-transparent px-1 font-mono text-[12px] text-text-primary outline-hidden placeholder:text-text-muted"
      />
      {toggle('caseSensitive', t.terminal.matchCase, 'Aa')}
      {toggle('regex', t.terminal.regex, '.*')}
      <span className="min-w-[52px] text-center font-mono text-[10.5px] text-text-muted" aria-live="polite">
        {query && results ? (results.count ? t.terminal.findCount(results.index + 1, results.count) : t.terminal.noMatches) : ''}
      </span>
      <button type="button" title={t.terminal.findPrev} aria-label={t.terminal.findPrev} disabled={!query} onClick={() => step(true)} className={nav}>
        <ChevronUp size={13} />
      </button>
      <button type="button" title={t.terminal.findNext} aria-label={t.terminal.findNext} disabled={!query} onClick={() => step(false)} className={nav}>
        <ChevronDown size={13} />
      </button>
      <button type="button" title={t.common.close} aria-label={t.common.close} onClick={close} className={nav}>
        <X size={13} />
      </button>
    </div>
  )
}
