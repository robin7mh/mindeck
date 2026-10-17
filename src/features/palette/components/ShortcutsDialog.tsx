import { useEffect, useRef, useState } from 'react'
import { Keyboard, Search, X } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { useOverlay } from '@/lib/overlay'
import { CONTEXTS, SHORTCUTS, formatBinding, shortcutBindings, type ShortcutContext } from '@/lib/shortcuts'
import { Panel } from '@/components/ui/Panel'
import { macKeys } from '@/features/workspace/keys'
import { usePalette } from '../store'

/**
 * Every keyboard shortcut (lib/shortcuts.ts), by where it works, with a
 * search over names and keys — ⌘/ or "?" from anywhere.
 */
export function ShortcutsDialog() {
  const t = useT()
  const s = t.shortcuts
  const mac = macKeys()
  const [query, setQuery] = useState('')
  const before = useRef(document.activeElement)
  useOverlay(true)

  const close = () => {
    usePalette.getState().close()
    if (before.current instanceof HTMLElement && before.current.isConnected) before.current.focus()
  }
  // Escape closes it wherever the focus is (a click on the list leaves the search field).
  const latest = useRef(close)
  latest.current = close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && latest.current()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const contextName = (c: ShortcutContext) => (c === 'global' ? s.global : t.nav[c])
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const rows = SHORTCUTS.map((sc) => ({ sc, keys: shortcutBindings(sc.id, mac).map((b) => formatBinding(b, mac)) }))
    .filter((r) => r.keys.length > 0)
    .filter((r) => {
      const text = `${s.items[r.sc.id]} ${r.keys.join(' ')} ${contextName(r.sc.context)}`.toLowerCase()
      return words.every((w) => text.includes(w))
    })

  return (
    <div className="fixed inset-0 z-80 flex items-start justify-center bg-void/50 px-4 pt-[8vh] backdrop-blur-[2px]" onMouseDown={close}>
      <div role="dialog" aria-modal="true" aria-label={s.title} onMouseDown={(e) => e.stopPropagation()} className="flex max-h-[80vh] w-[min(760px,100%)]">
        <Panel
          title={s.title}
          corners
          flush
          className="min-h-0 flex-1 shadow-2xl shadow-black/50"
          bodyClassName="flex min-h-0 flex-col"
          headerRight={
            <button type="button" aria-label={t.common.close} onClick={close} className="text-text-muted hover:text-text-primary">
              <X size={14} />
            </button>
          }
        >
          <div className="flex items-center gap-2 border-b border-hud/60 px-3">
            <Search size={14} className="shrink-0 text-text-muted" />
            <input
              autoFocus
              aria-label={s.search}
              placeholder={s.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-w-0 flex-1 bg-transparent py-2.5 font-sans text-[13.5px] text-text-primary outline-hidden placeholder:text-text-muted"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {!rows.length && <p className="font-sans text-[12.5px] text-text-muted">{s.none}</p>}
            <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
              {CONTEXTS.map((context) => {
                const mine = rows.filter((r) => r.sc.context === context)
                if (!mine.length) return null
                return (
                  <section key={context} aria-label={contextName(context)}>
                    <h3 className="mb-1.5 flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wider text-cyan">
                      <Keyboard size={12} /> {contextName(context)}
                    </h3>
                    <ul className="space-y-0.5">
                      {mine.map(({ sc, keys }) => (
                        <li key={sc.id} className="flex items-baseline gap-3 rounded-sm px-1.5 py-1 hover:bg-elevated/40">
                          <span className="min-w-0 flex-1">
                            <span className="block font-sans text-[12.5px] text-text-primary">{s.items[sc.id]}</span>
                            {sc.yields && <span className="block font-sans text-[11px] text-text-muted">{s.yields(sc.yields.map(contextName).join(', '))}</span>}
                          </span>
                          <span className="flex shrink-0 flex-wrap justify-end gap-1">
                            {keys.map((k) => (
                              <kbd key={k} className="rounded-sm border border-hud/70 bg-surface/70 px-1.5 py-px font-mono text-[11px] text-text-secondary">
                                {k}
                              </kbd>
                            ))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )
              })}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  )
}
