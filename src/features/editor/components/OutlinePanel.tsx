import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ChevronDown, ChevronRight, ListTree } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useEditor } from '../store'
import { filterSymbols, revealOf, symbolPath, useOutline, type OutlineSymbol } from '../outline'
import { symbolIcon } from './symbolIcon'

/**
 * VS Code's Outline: the symbols of the file in the focused group as a tree.
 * Type to filter; a click puts the cursor on the symbol; the symbol around
 * the cursor is highlighted and kept in view as the cursor moves.
 */
export function OutlinePanel() {
  const t = useT()
  const id = useEditor((s) => s.activeId)
  const group = useEditor((s) => s.activeGroup)
  const symbols = useOutline((s) => (id ? s.symbols[id] : undefined))
  const cursor = useOutline((s) => s.cursors[group])
  const [query, setQuery] = useState('')
  /** Folded symbols, by their place in the tree. */
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const list = useRef<HTMLUListElement>(null)
  const shown = filterSymbols(symbols ?? [], query)
  const here = symbols && cursor ? symbolPath(symbols, cursor).at(-1) : undefined

  useEffect(() => setFolded({}), [id])
  // Follow the cursor: its symbol scrolls into view.
  useEffect(() => {
    list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [here])

  const reveal = (s: OutlineSymbol) => useEditor.setState({ reveal: { id: id!, ...revealOf(s), group } })

  const rows = (items: OutlineSymbol[], depth: number, prefix: string): ReactElement[] =>
    items.flatMap((s, i) => {
      const key = `${prefix}${i}`
      const { Icon, tint } = symbolIcon(s.kind)
      const open = !!query.trim() || !folded[key]
      return [
        <li
          key={key}
          role="treeitem"
          aria-selected={false}
          aria-expanded={s.children.length ? open : undefined}
          aria-current={s.selection === here?.selection}
          onClick={() => reveal(s)}
          style={{ paddingLeft: 6 + depth * 12 }}
          className={cn(
            'flex cursor-pointer items-center gap-1.5 truncate rounded-sm py-0.5 pr-2 font-sans text-[12.5px] hover:bg-elevated/50',
            s.selection === here?.selection ? 'bg-cyan/8 text-text-primary' : 'text-text-secondary'
          )}
        >
          {s.children.length ? (
            <button
              type="button"
              aria-label={s.name}
              onClick={(e) => {
                e.stopPropagation()
                setFolded((f) => ({ ...f, [key]: open }))
              }}
              className="shrink-0 text-text-muted hover:text-text-primary"
            >
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <Icon size={13} className={cn('shrink-0', tint)} />
          <span className="truncate">{s.name}</span>
          {s.detail && <span className="truncate font-mono text-[10.5px] text-text-muted">{s.detail}</span>}
        </li>,
        ...(open ? rows(s.children, depth + 1, `${key}.`) : [])
      ]
    })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pb-2">
        <input
          aria-label={t.editor.outlineFilter}
          placeholder={t.editor.outlineFilter}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-md border border-hud/60 bg-transparent px-2 py-1 font-sans text-[12.5px] text-text-primary outline-hidden placeholder:text-text-muted focus:border-cyan/50"
        />
      </div>
      {!id ? (
        <p className="px-3 font-sans text-[12.5px] text-text-muted">{t.editor.outlineEmpty}</p>
      ) : !shown.length ? (
        <p className="flex items-center gap-1.5 px-3 font-sans text-[12.5px] text-text-muted">
          <ListTree size={13} /> {t.editor.noSymbols}
        </p>
      ) : (
        <ul ref={list} role="tree" aria-label={t.scm.panes.outline} className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {rows(shown, 0, '')}
        </ul>
      )}
    </div>
  )
}
