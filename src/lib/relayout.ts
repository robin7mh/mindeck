const listeners = new Set<() => void>()

/**
 * Panes moved inside the window without the window changing size (a divider
 * dragged, two panes swapped). Native views (the browser's pages) measure
 * their place again — a ResizeObserver alone misses a pure move.
 */
export function relayout(): void {
  listeners.forEach((fn) => fn())
}

export function onRelayout(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
