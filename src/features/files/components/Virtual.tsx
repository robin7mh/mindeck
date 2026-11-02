import { useEffect, useState, type RefObject } from 'react'

/** Rows rendered beyond the visible ones (smooth scrolling). */
const OVERSCAN = 8
/** Before the first measurement (and where there is no layout): a typical window. */
const FALLBACK = { height: 900, width: 900 }

/**
 * The slice of a long list worth rendering: only what the scroll area shows
 * (and a little more) — a folder with 100 000 entries stays as fast as one
 * with 100. Items are `itemHeight` tall; with `itemWidth` they flow in rows
 * as wide as the area (the icon grid). `offset` is what sits above the
 * first item (a header).
 */
export function useWindow(scroller: RefObject<HTMLElement>, count: number, itemHeight: number, opts: { itemWidth?: number; offset: number }) {
  const [box, setBox] = useState({ top: 0, height: 0, width: 0 })

  useEffect(() => {
    const el = scroller.current!
    const update = () => setBox({ top: el.scrollTop, height: el.clientHeight, width: el.clientWidth })
    update()
    el.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [scroller])

  const perRow = opts.itemWidth ? Math.max(1, Math.floor((box.width || FALLBACK.width) / opts.itemWidth)) : 1
  const rows = Math.ceil(count / perRow)
  const top = Math.max(0, box.top - opts.offset)
  const first = Math.max(0, Math.floor(top / itemHeight) - OVERSCAN)
  const last = Math.min(rows, Math.ceil((top + (box.height || FALLBACK.height)) / itemHeight) + OVERSCAN)
  return { start: first * perRow, end: Math.min(count, last * perRow), before: first * itemHeight, after: Math.max(0, rows - last) * itemHeight, perRow }
}

/** Scrolls `el` just enough to show item `index` (keyboard navigation in a windowed list). */
export function revealItem(el: HTMLElement, index: number, itemHeight: number, perRow: number, offset: number): void {
  const top = offset + Math.floor(index / perRow) * itemHeight
  if (top < el.scrollTop + offset) el.scrollTop = top - offset
  else if (top + itemHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + itemHeight - el.clientHeight
}
