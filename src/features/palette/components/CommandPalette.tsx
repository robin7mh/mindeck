import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Command as CommandIcon, Search } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useOverlay } from '@/lib/overlay'
import { shortcutLabel } from '@/lib/shortcuts'
import { macKeys } from '@/features/workspace/keys'
import { allCommands, prepareCommands, subscribeCommands, type Command } from '../registry'
import { searchCommands } from '../search'
import { usePalette } from '../store'

/** A key hint in the footer. */
function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-sm border border-hud/70 bg-surface/70 px-1 font-mono text-[10px] text-text-secondary">{children}</kbd>
}

/**
 * The command palette (⌘K / ⇧⌘P): everything Mindeck can do, one search
 * away — modules, layouts and panes, settings, projects, recent files, agent
 * sessions, tabs and bookmarks, notes, terminals, the look and the language.
 * Without a query it lists the recently used commands first.
 */
export function CommandPalette() {
  const t = useT()
  const c = t.commands
  const recentIds = usePalette((s) => s.recent)
  const [query, setQuery] = useState(() => usePalette.getState().query)
  const [active, setActive] = useState(0)
  const [tick, setTick] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  // Where the keyboard was: closing without running anything puts it back.
  const before = useRef(document.activeElement)
  useOverlay(true)

  useEffect(() => {
    prepareCommands()
    return subscribeCommands(() => setTick((n) => n + 1))
  }, [])

  // `tick`: what the sources list has changed — allCommands reads them, so it counts as a dependency here.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tick stands for the command sources outside React
  const commands = useMemo(() => allCommands(t), [t, tick])
  const { recent, results } = useMemo(() => searchCommands(commands, query, recentIds), [commands, query, recentIds])
  const items = [...recent, ...results]
  const current = Math.min(active, Math.max(0, items.length - 1))

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [current, query])

  const cancel = () => {
    usePalette.getState().close()
    if (before.current instanceof HTMLElement && before.current.isConnected) before.current.focus()
  }
  const run = (command: Command) => {
    const p = usePalette.getState()
    p.close()
    p.used(command.id)
    void command.run()
  }

  const row = (command: Command, index: number) => {
    const Icon = command.icon ?? CommandIcon
    const selected = index === current
    return (
      <li
        key={command.id}
        id={`palette-${index}`}
        role="option"
        aria-selected={selected}
        onMouseMove={() => setActive(index)}
        onClick={() => run(command)}
        className={cn('flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5', selected ? 'bg-cyan/10' : 'hover:bg-elevated/50')}
      >
        <Icon size={14} className={cn('shrink-0', selected ? 'text-cyan' : 'text-text-muted')} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-sans text-[13px] text-text-primary">{command.label}</span>
          {command.detail && <span className="ml-2 font-mono text-[10.5px] text-text-muted">{command.detail}</span>}
        </span>
        <span className="shrink-0 font-sans text-[11px] text-text-muted">{command.group}</span>
        {command.keys && <span className="shrink-0 font-mono text-[10.5px] text-text-secondary">{command.keys}</span>}
      </li>
    )
  }
  const heading = (label: string) => (
    <li role="presentation" className="px-2.5 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
      {label}
    </li>
  )

  return (
    <div className="fixed inset-0 z-80 flex justify-center bg-void/50 px-4 pt-[12vh] backdrop-blur-[2px]" onMouseDown={cancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={c.title}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-fit max-h-[70vh] w-[min(640px,100%)] flex-col overflow-hidden rounded-lg border border-hud/70 bg-panel/95 shadow-2xl shadow-black/50 backdrop-blur-md"
      >
        <div className="flex items-center gap-2 border-b border-hud/60 px-3">
          <Search size={15} className="shrink-0 text-text-muted" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items.length ? `palette-${current}` : undefined}
            aria-label={c.title}
            placeholder={c.placeholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') return cancel()
              const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : e.key === 'PageDown' ? 8 : e.key === 'PageUp' ? -8 : 0
              if (step) {
                e.preventDefault()
                setActive(Math.min(items.length - 1, Math.max(0, current + step)))
              } else if (e.key === 'Enter' && items[current]) {
                e.preventDefault()
                run(items[current])
              }
            }}
            className="min-w-0 flex-1 bg-transparent py-3 font-sans text-[14px] text-text-primary outline-hidden placeholder:text-text-muted"
          />
        </div>
        <ul ref={list} id="palette-list" role="listbox" aria-label={c.title} className="min-h-0 flex-1 overflow-y-auto p-1">
          {!items.length && <li className="px-3 py-3 font-sans text-[12.5px] text-text-muted">{c.none}</li>}
          {recent.length > 0 && heading(c.recent)}
          {recent.map((command, i) => row(command, i))}
          {recent.length > 0 && results.length > 0 && heading(c.all)}
          {results.map((command, i) => row(command, recent.length + i))}
        </ul>
        <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-hud/60 px-3 py-1.5 font-sans text-[11px] text-text-muted">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> {c.choose}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> {c.run}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Esc</Kbd> {c.closeHint}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Kbd>{shortcutLabel('shortcuts', macKeys())}</Kbd> {t.shortcuts.title}
          </span>
        </footer>
      </div>
    </div>
  )
}
