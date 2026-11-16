/**
 * How the user moves around right now, as `data-input` on <html>: `pointer`
 * after a click or a tap, `keyboard` after Tab. Focus rings show only while
 * it isn't `pointer` (index.css): Chromium's :focus-visible also counts a key
 * typed after a click (a shortcut, a letter) as keyboard navigation, and the
 * item just clicked got a ring out of nowhere. Returns the way to stop.
 */
export function trackInputModality(doc: Document = document): () => void {
  const root = doc.documentElement
  const pointer = () => {
    root.dataset.input = 'pointer'
  }
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Tab') root.dataset.input = 'keyboard'
  }
  doc.addEventListener('pointerdown', pointer, true)
  doc.addEventListener('keydown', key, true)
  return () => {
    doc.removeEventListener('pointerdown', pointer, true)
    doc.removeEventListener('keydown', key, true)
  }
}
