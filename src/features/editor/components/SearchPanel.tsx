import { useEffect, useMemo, useRef, useState } from 'react'
import { CaseSensitive, ChevronDown, ChevronRight, Ellipsis, FileDiff, Loader2, Regex, Replace, ReplaceAll, Search, Undo2, WholeWord, X } from 'lucide-react'
import { replacementsFor, searchRegExp, type TextMatch } from '@shared/types/search'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useSearch } from '../search'

const toggle = (on: boolean) =>
  cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-sm transition-colors', on ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:bg-elevated hover:text-text-primary')
const icon = 'flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-elevated hover:text-text-primary disabled:opacity-40'
const field = 'flex items-center gap-1 rounded-md border border-hud/60 bg-surface/50 px-2 focus-within:border-cyan/50'
const input = 'min-w-0 flex-1 bg-transparent py-1.5 font-sans text-[12.5px] text-text-primary outline-hidden placeholder:text-text-muted'

/** Searching runs this long after the last keystroke. */
const DEBOUNCE_MS = 300
/** Result rows rendered at first (and per "show more"): huge result sets stay quick. */
const ROWS = 200

/** What a match becomes, for the row's preview (regex groups expanded on the visible line). */
function replacedText(m: TextMatch, replace: string, pattern: { pattern: string; regex: boolean; caseSensitive: boolean; wholeWord: boolean }): string {
  if (!pattern.regex) return replace
  try {
    const line = m.before + m.text + m.after
    return replacementsFor(line, [{ line: 1, column: m.before.length, length: m.text.length }], searchRegExp(pattern), replace, true)[0]?.text ?? replace
  } catch {
    return replace
  }
}

/**
 * VS Code's search view: find (and replace) across the project — match case,
 * whole word, regex, files to include / exclude. Results stream in grouped by
 * file; a click opens the match, the diff button previews a file's
 * replacement, and matches are replaced one by one, per file, or all at once.
 */
export function SearchPanel({ readOnly = false }: { readOnly?: boolean }) {
  const t = useT()
  const s = useSearch()
  const { pattern, replace, regex, caseSensitive, wholeWord, include, exclude, showReplace, showDetails, results, searching, truncated, error, collapsed, replacing, undo } = s
  const first = useRef(true)
  const [budget, setBudget] = useState(ROWS)
  const withReplace = showReplace && !readOnly

  // Search as you type (and when an option flips).
  useEffect(() => {
    if (first.current) {
      first.current = false
      if (results.length) return
    }
    setBudget(ROWS)
    const timer = window.setTimeout(() => void useSearch.getState().run(), DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- new results must not search again; only the query does
  }, [pattern, regex, caseSensitive, wholeWord, include, exclude])

  const total = useMemo(() => results.reduce((n, f) => n + f.matches.length, 0), [results])
  const sorted = useMemo(() => [...results].sort((a, b) => a.path.localeCompare(b.path)), [results])
  /** Rows the whole list would take (a header per file, its matches while open). */
  const needed = sorted.reduce((n, f) => n + 1 + (collapsed[f.path] ? 0 : f.matches.length), 0)
  const options = { pattern, regex, caseSensitive, wholeWord }
  let rows = budget

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1.5 border-b border-hud/50 p-2">
        <div className="flex items-start gap-1">
          {!readOnly && (
            <button type="button" aria-label={t.search.toggleReplace} title={t.search.toggleReplace} aria-expanded={showReplace} className={cn(icon, 'mt-1.5')} onClick={() => s.set({ showReplace: !showReplace })}>
              {showReplace ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          )}
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className={field}>
              <Search size={13} className="shrink-0 text-text-muted" />
              <input
                autoFocus
                aria-label={t.search.placeholder}
                placeholder={t.search.placeholder}
                value={pattern}
                onChange={(e) => s.set({ pattern: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && void s.run()}
                className={input}
              />
              <button type="button" aria-label={t.search.matchCase} title={t.search.matchCase} aria-pressed={caseSensitive} className={toggle(caseSensitive)} onClick={() => s.set({ caseSensitive: !caseSensitive })}>
                <CaseSensitive size={15} />
              </button>
              <button type="button" aria-label={t.search.wholeWord} title={t.search.wholeWord} aria-pressed={wholeWord} className={toggle(wholeWord)} onClick={() => s.set({ wholeWord: !wholeWord })}>
                <WholeWord size={15} />
              </button>
              <button type="button" aria-label={t.search.useRegex} title={t.search.useRegex} aria-pressed={regex} className={toggle(regex)} onClick={() => s.set({ regex: !regex })}>
                <Regex size={13} />
              </button>
            </div>
            {withReplace && (
              <div className={field}>
                <Replace size={13} className="shrink-0 text-text-muted" />
                <input aria-label={t.search.replacePlaceholder} placeholder={t.search.replacePlaceholder} value={replace} onChange={(e) => s.set({ replace: e.target.value })} className={input} />
                <button type="button" aria-label={t.search.replaceAll} title={t.search.replaceAll} className={toggle(false)} disabled={!total || replacing} onClick={() => void s.replaceAll()}>
                  {replacing ? <Loader2 size={13} className="animate-spin" /> : <ReplaceAll size={14} />}
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="flex justify-end">
          <button type="button" aria-label={t.search.toggleDetails} title={t.search.toggleDetails} aria-expanded={showDetails} className={icon} onClick={() => s.set({ showDetails: !showDetails })}>
            <Ellipsis size={14} />
          </button>
        </div>
        {showDetails && (
          <div className="space-y-1.5">
            <label className="block font-sans text-[11px] text-text-muted">
              {t.search.include}
              <input aria-label={t.search.include} placeholder={t.search.globHint} value={include} onChange={(e) => s.set({ include: e.target.value })} className={cn(field, input, 'mt-0.5 w-full px-2 font-mono text-[11.5px]')} />
            </label>
            <label className="block font-sans text-[11px] text-text-muted">
              {t.search.exclude}
              <input aria-label={t.search.exclude} placeholder={t.search.globHint} value={exclude} onChange={(e) => s.set({ exclude: e.target.value })} className={cn(field, input, 'mt-0.5 w-full px-2 font-mono text-[11.5px]')} />
            </label>
          </div>
        )}
        {(pattern || searching) && !error && (
          <p className="flex items-center gap-1.5 px-0.5 font-mono text-[10.5px] text-text-muted">
            {searching && <Loader2 size={10} className="animate-spin" />}
            {total ? t.search.results(total, results.length) : searching ? t.search.searching : t.search.noResults}
          </p>
        )}
        {truncated && <p className="px-0.5 font-sans text-[11px] text-amber">{t.search.truncated}</p>}
        {error && (
          <p role="alert" className="flex items-start gap-1 whitespace-pre-wrap px-0.5 font-mono text-[11px] text-danger">
            <span className="min-w-0 flex-1">{error}</span>
            <button type="button" aria-label={t.common.dismiss} className={icon} onClick={() => s.clearError()}>
              <X size={11} />
            </button>
          </p>
        )}
        {undo && !readOnly && (
          <button type="button" onClick={() => void s.undoReplace()} className="flex items-center gap-1 px-0.5 font-sans text-[11.5px] text-cyan hover:underline">
            <Undo2 size={12} /> {t.search.undo(undo.files.length)}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {sorted.map((file) => {
          if (rows <= 0) return null
          const name = file.path.slice(file.path.lastIndexOf('/') + 1)
          const dir = file.path.slice(0, file.path.length - name.length - 1)
          const open = !collapsed[file.path]
          const shown = open ? file.matches.slice(0, rows) : []
          rows -= shown.length + 1
          return (
            <section key={file.path} className="mb-0.5">
              <div className="group flex items-center gap-1 px-1.5 py-0.5 hover:bg-elevated/40">
                <button type="button" aria-expanded={open} title={file.path} onClick={() => s.toggle(file.path)} className="flex min-w-0 flex-1 items-center gap-1 text-left">
                  {open ? <ChevronDown size={12} className="shrink-0 text-text-muted" /> : <ChevronRight size={12} className="shrink-0 text-text-muted" />}
                  <span className="min-w-0 truncate font-sans text-[12px] text-text-primary">{name}</span>
                  {dir && <span className="min-w-0 truncate font-mono text-[10.5px] text-text-muted">{dir}</span>}
                </button>
                <span className="hidden items-center group-hover:flex">
                  {withReplace && (
                    <>
                      <button type="button" aria-label={`${t.search.preview}: ${file.path}`} title={t.search.preview} className={icon} onClick={() => void s.preview(file.path)}>
                        <FileDiff size={12} />
                      </button>
                      <button type="button" aria-label={`${t.search.replaceFile}: ${file.path}`} title={t.search.replaceFile} className={icon} disabled={replacing} onClick={() => void s.replaceFile(file.path)}>
                        <ReplaceAll size={12} />
                      </button>
                    </>
                  )}
                  <button type="button" aria-label={`${t.search.dismiss}: ${file.path}`} title={t.search.dismiss} className={icon} onClick={() => s.dismiss(file.path)}>
                    <X size={12} />
                  </button>
                </span>
                <span className="shrink-0 rounded-full bg-elevated px-1.5 font-mono text-[10px] text-text-secondary">{file.matches.length}</span>
              </div>
              <ul>
                {shown.map((m) => (
                  <li key={`${m.line}:${m.column}`} className="group flex items-center hover:bg-elevated/50">
                    <button type="button" onClick={() => void s.open(file.path, m)} className="flex min-w-0 flex-1 items-baseline gap-2 py-0.5 pl-6 pr-1 text-left">
                      <span className="w-7 shrink-0 text-right font-mono text-[10.5px] text-text-muted">{m.line}</span>
                      <span className="min-w-0 truncate whitespace-pre font-mono text-[11.5px] text-text-secondary">
                        {m.before}
                        {withReplace ? (
                          <>
                            <del className="bg-danger/15 text-danger">{m.text}</del>
                            <ins className="bg-green/15 text-green no-underline">{replacedText(m, replace, options)}</ins>
                          </>
                        ) : (
                          <mark className="rounded-xs bg-amber/25 text-text-primary">{m.text}</mark>
                        )}
                        {m.after}
                      </span>
                    </button>
                    <span className="hidden shrink-0 items-center pr-1 group-hover:flex">
                      {withReplace && (
                        <button type="button" aria-label={`${t.search.replace}: ${file.path}:${m.line}`} title={t.search.replace} className={icon} disabled={replacing} onClick={() => void s.replaceMatch(file.path, m)}>
                          <Replace size={12} />
                        </button>
                      )}
                      <button type="button" aria-label={`${t.search.dismiss}: ${file.path}:${m.line}`} title={t.search.dismiss} className={icon} onClick={() => s.dismiss(file.path, m)}>
                        <X size={12} />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
        {needed > budget ? (
          <button type="button" onClick={() => setBudget((b) => b + ROWS)} className="mx-2 my-1 font-sans text-[11.5px] text-cyan hover:underline">
            {t.search.showMore}
          </button>
        ) : null}
      </div>
    </div>
  )
}
