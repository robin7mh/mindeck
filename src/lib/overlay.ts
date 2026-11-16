import { useEffect, useState } from 'react'
import { create } from 'zustand'

/**
 * Menus, dropdowns and dialogs that are open right now. The browser's web
 * pages are native views on top of the UI — while anything here is open, the
 * browser shows a still picture of its page instead, so nothing is hidden
 * behind it.
 */
export const useOverlays = create<{ count: number }>(() => ({ count: 0 }))

/** Counts this menu or dialog as open while `open` is true. */
export function useOverlay(open: boolean): void {
  useEffect(() => {
    if (!open) return
    useOverlays.setState((s) => ({ count: s.count + 1 }))
    return () => useOverlays.setState((s) => ({ count: s.count - 1 }))
  }, [open])
}

/** What counts as a menu or dialog of the UI. */
const FLOATING = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"]'

const intersects = (a: DOMRect, b: DOMRect) =>
  a.width > 0 && a.height > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/** Is a menu or dialog of the UI over a native view (an element marked `data-native-view`)? */
export function coversNativeView(): boolean {
  const views = [...document.querySelectorAll<HTMLElement>('[data-native-view]')]
  const places = views.map((v) => v.getBoundingClientRect())
  for (const el of document.querySelectorAll<HTMLElement>(FLOATING)) {
    if (views.some((v) => v.contains(el))) continue
    const r = el.getBoundingClientRect()
    if (places.some((p) => intersects(r, p))) return true
  }
  return false
}

/**
 * Menus and dialogs that do not count themselves in, found by looking: while
 * `enabled`, any of them lying over a native view counts as open. With modules
 * side by side, a dialog of one module can open over the browser of another.
 */
export function useCoverWatch(enabled: boolean): void {
  const [covered, setCovered] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let frame = 0
    const check = () => {
      frame = 0
      setCovered(coversNativeView())
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check)
    }
    // Batched to one look per frame: editors and terminals change the DOM all the time.
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'role', 'hidden', 'aria-modal'] })
    window.addEventListener('resize', schedule)
    check()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', schedule)
      setCovered(false)
    }
  }, [enabled])
  useOverlay(enabled && covered)
}
