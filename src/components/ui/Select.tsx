import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useOverlay } from '@/lib/overlay'

export interface SelectOption {
  value: string
  label: string
  /** A second, quieter line — e.g. what a model is good at. */
  hint?: string
}

interface SelectProps {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  /** Accessible name of the field. */
  label: string
  /** Shown when no option matches `value`. */
  placeholder?: string
  /** Icon in front of the current value. */
  icon?: LucideIcon
  /** field: a form field · quiet: a small inline picker (e.g. under the chat composer). */
  variant?: 'field' | 'quiet'
  className?: string
}

/** Room the menu needs below the field before it opens upwards instead. */
const MENU_MAX = 280

interface Place {
  left: number
  minWidth: number
  top?: number
  bottom?: number
}

/**
 * Mindeck's dropdown, instead of the OS menu a native <select> opens: a panel
 * in the app's own look, with keyboard support (arrows, Home/End, Enter,
 * Escape). The menu renders into <body>, so dialogs and scroll areas never
 * clip it, and it opens upwards when there is no room below.
 */
export function Select({ value, options, onChange, label, placeholder, icon: Icon, variant = 'field', className }: SelectProps) {
  const [place, setPlace] = useState<Place | null>(null) // null: closed
  const [active, setActive] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLUListElement>(null)
  const id = useId()
  const selected = options.findIndex((o) => o.value === value)
  const current = options[selected]
  const open = !!place
  useOverlay(open)

  const show = (index = Math.max(0, selected)) => {
    const r = trigger.current!.getBoundingClientRect()
    const up = r.bottom + MENU_MAX > window.innerHeight && r.top > window.innerHeight - r.bottom
    setPlace({ left: r.left, minWidth: r.width, ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) })
    setActive(index)
  }
  const close = () => setPlace(null)
  const pick = (index: number) => {
    close()
    trigger.current!.focus()
    if (options[index].value !== value) onChange(options[index].value)
  }

  // Outside click, scrolling elsewhere or resizing closes it — a menu never floats away from its field.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (!trigger.current!.contains(target) && !menu.current!.contains(target)) close()
    }
    const onScroll = (e: Event) => {
      if (!menu.current!.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  // The highlighted option stays in sight while the arrows move it.
  useEffect(() => {
    if (open) menu.current!.children[active].scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault()
        show()
      }
      return
    }
    const last = options.length - 1
    const move: Record<string, number> = { ArrowDown: Math.min(last, active + 1), ArrowUp: Math.max(0, active - 1), Home: 0, End: last }
    if (e.key in move) {
      e.preventDefault()
      setActive(move[e.key])
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(active)
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault()
      close()
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={!options.length}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKeyDown}
        className={cn(
          'group flex min-w-0 items-center gap-2 text-left outline-hidden transition-colors disabled:opacity-50',
          variant === 'field'
            ? 'w-full rounded-md border bg-surface/50 px-2.5 py-1.5 font-sans text-[12.5px] text-text-primary hover:border-hud-strong focus-visible:border-cyan/60'
            : 'max-w-[240px] rounded-sm px-1.5 py-0.5 font-mono text-[11px] hover:bg-elevated/60 focus-visible:bg-elevated/60',
          variant === 'field' && (open ? 'border-cyan/50' : 'border-hud/60'),
          variant === 'quiet' && (current?.value ? 'text-text-secondary' : 'text-text-muted'),
          className
        )}
      >
        {Icon && <Icon size={variant === 'field' ? 13 : 12} className="shrink-0 text-text-muted" />}
        <span className={cn('min-w-0 flex-1 truncate', !current && 'text-text-muted')}>{current?.label ?? placeholder}</span>
        <ChevronDown size={variant === 'field' ? 14 : 12} className={cn('shrink-0 text-text-muted transition-transform', open && 'rotate-180 text-cyan')} />
      </button>
      {place &&
        createPortal(
          <ul
            ref={menu}
            id={id}
            role="listbox"
            aria-label={label}
            style={{ left: place.left, minWidth: place.minWidth, top: place.top, bottom: place.bottom, maxHeight: MENU_MAX }}
            className="fixed z-70 max-w-[min(420px,90vw)] overflow-y-auto rounded-lg border border-hud/70 bg-panel/95 p-1 shadow-xl shadow-black/40 backdrop-blur-md"
          >
            {options.map((o, i) => (
              <li
                key={o.value}
                role="option"
                aria-selected={i === selected}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()} // keep focus on the field
                onClick={() => pick(i)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 font-sans text-[12.5px] transition-colors',
                  i === active ? 'bg-cyan/10 text-text-primary' : 'text-text-secondary'
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate', i === selected && 'text-cyan')}>{o.label}</span>
                  {o.hint && <span className="block truncate text-[11px] text-text-muted">{o.hint}</span>}
                </span>
                <Check size={13} className={cn('shrink-0 text-cyan', i !== selected && 'invisible')} />
              </li>
            ))}
          </ul>,
          document.body
        )}
    </>
  )
}
