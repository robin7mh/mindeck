import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'

export type MenuItem = { label: string; run: () => void; danger?: boolean; disabled?: boolean } | 'separator'

/** A right-click menu in Mindeck's look; closes on a pick, Escape or a click elsewhere. */
export function ContextMenu({ x, y, items, label, onClose }: { x: number; y: number; items: MenuItem[]; label: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: x, top: y })

  // Keep it inside the window.
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect()
    setPlace({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) })
  }, [x, y])

  useEffect(() => {
    const away = (e: MouseEvent) => !ref.current!.contains(e.target as Node) && onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={place}
      className="fixed z-80 min-w-[200px] rounded-lg border border-hud/70 bg-panel/95 p-1 shadow-xl shadow-black/40 backdrop-blur-md"
    >
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={`sep${i}`} role="separator" className="my-1 h-px bg-hud/50" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.run()
            }}
            className={cn(
              'flex w-full items-center rounded-md px-2.5 py-1.5 text-left font-sans text-[12.5px] transition-colors disabled:opacity-40',
              item.danger ? 'text-danger hover:bg-danger/10' : 'text-text-secondary hover:bg-cyan/10 hover:text-text-primary'
            )}
          >
            {item.label}
          </button>
        )
      )}
    </div>,
    document.body
  )
}
