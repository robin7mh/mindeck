import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

/** Where the pointer is during a drag. */
export interface DragPoint {
  clientX: number
  clientY: number
}

export interface DragHandlers {
  /** The pointer went down on the handle. */
  onStart?: (at: DragPoint) => void
  /** It moved with its button held. */
  onMove: (at: DragPoint) => void
  /** The drag is over — at the pointer's last known place. */
  onEnd?: (at: DragPoint) => void
}

/**
 * A drag on a handle (a divider, an edge) that always ends. The button can
 * come up where the page never hears of it — over a native view (the
 * browser's page), outside the window — and a handle waiting for its own
 * pointerup would hold the drag, and the shield it puts over the UI, for good:
 * nothing could be clicked any more. So the drag also ends on a pointerup or
 * pointercancel anywhere, when the handle loses its pointer capture, when the
 * window loses the focus, at the first move with no button held, and when the
 * handle goes away mid-drag.
 */
export function usePointerDrag(handlers: DragHandlers): { dragging: boolean; onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void } {
  const [dragging, setDragging] = useState(false)
  const latest = useRef(handlers)
  latest.current = handlers
  const stop = useRef<(() => void) | null>(null)

  useEffect(() => () => stop.current?.(), [])

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    stop.current?.()
    const el = e.currentTarget
    const pointer = e.pointerId
    let last: DragPoint = { clientX: e.clientX, clientY: e.clientY }
    const move = (ev: PointerEvent) => {
      // No button held: it came up where this page did not see it.
      if (ev.buttons === 0) return finish()
      last = { clientX: ev.clientX, clientY: ev.clientY }
      latest.current.onMove(last)
    }
    const up = (ev: PointerEvent) => {
      last = { clientX: ev.clientX, clientY: ev.clientY }
      finish()
    }
    // Runs once: its listeners go first (the release below would report a lost capture).
    const finish = () => {
      stop.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      el.removeEventListener('lostpointercapture', finish)
      try {
        el.releasePointerCapture?.(pointer)
      } catch {
        /* released already */
      }
      setDragging(false)
      latest.current.onEnd?.(last)
    }
    stop.current = finish
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
    try {
      el.setPointerCapture?.(pointer)
    } catch {
      /* no such pointer (any more) */
    }
    el.addEventListener('lostpointercapture', finish)
    setDragging(true)
    latest.current.onStart?.(last)
  }

  return { dragging, onPointerDown }
}
