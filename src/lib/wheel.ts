import type { WheelEvent } from 'react'

/**
 * A strip that scrolls sideways without a bar (the browser's tabs, its
 * bookmarks): a mouse wheel's up and down moves it too — a trackpad's
 * sideways swipe scrolls it on its own.
 */
export function scrollSideways(e: WheelEvent<HTMLElement>): void {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
}
