import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePointerDrag, type DragHandlers } from '@/lib/pointerDrag'

// jsdom has no PointerEvent: without one, pointer events carry no coordinates (nor buttons).
class FakePointerEvent extends MouseEvent {
  pointerId: number
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 0
  }
}

function Handle(props: DragHandlers) {
  const { dragging, onPointerDown } = usePointerDrag(props)
  return <div role="separator" aria-busy={dragging} onPointerDown={onPointerDown} />
}

function setup() {
  const handlers = { onStart: vi.fn(), onMove: vi.fn(), onEnd: vi.fn() }
  const view = render(<Handle {...handlers} />)
  const handle = screen.getByRole('separator')
  const press = (init: PointerEventInit = {}) => fireEvent.pointerDown(handle, { clientX: 10, clientY: 20, pointerId: 1, ...init })
  const busy = () => handle.getAttribute('aria-busy') === 'true'
  return { ...handlers, ...view, handle, press, busy }
}

describe('a drag that always ends', () => {
  const capture = { set: vi.fn(), release: vi.fn() }
  beforeEach(() => {
    ;(window as unknown as { PointerEvent: unknown }).PointerEvent = FakePointerEvent
    Object.assign(HTMLElement.prototype, { setPointerCapture: capture.set, releasePointerCapture: capture.release })
  })
  afterEach(() => {
    Reflect.deleteProperty(window, 'PointerEvent')
    Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture')
    Reflect.deleteProperty(HTMLElement.prototype, 'releasePointerCapture')
    capture.set.mockReset()
    capture.release.mockReset()
  })

  it('starts on the primary button, follows the pointer anywhere in the window, ends on its up there', () => {
    const d = setup()
    d.press({ button: 2 }) // a right click is no drag
    expect(d.onStart).not.toHaveBeenCalled()
    d.press()
    expect(d.onStart).toHaveBeenCalledWith({ clientX: 10, clientY: 20 })
    expect(capture.set).toHaveBeenCalledWith(1)
    expect(d.busy()).toBe(true)
    fireEvent.pointerMove(document.body, { clientX: 50, clientY: 60, buttons: 1 })
    expect(d.onMove).toHaveBeenCalledWith({ clientX: 50, clientY: 60 })
    fireEvent.pointerUp(document.body, { clientX: 70, clientY: 80 })
    expect(d.onEnd).toHaveBeenCalledWith({ clientX: 70, clientY: 80 })
    expect(capture.release).toHaveBeenCalledWith(1)
    expect(d.busy()).toBe(false)
    fireEvent.pointerMove(document.body, { clientX: 90, buttons: 1 }) // over: nothing follows
    fireEvent.pointerUp(document.body)
    expect(d.onMove).toHaveBeenCalledTimes(1)
    expect(d.onEnd).toHaveBeenCalledTimes(1)
  })

  it('an up the page never saw (over the browser’s page, outside the window): the first move without a button ends it', () => {
    const d = setup()
    d.press()
    fireEvent.pointerMove(document.body, { clientX: 40, buttons: 1 })
    fireEvent.pointerMove(document.body, { clientX: 300 }) // no button held any more
    expect(d.onEnd).toHaveBeenCalledWith({ clientX: 40, clientY: 0 })
    expect(d.onMove).toHaveBeenCalledTimes(1)
    expect(d.busy()).toBe(false)
  })

  it('ends on pointercancel, a lost capture, the window losing the focus — and when the handle goes away', () => {
    const d = setup()
    for (const end of [() => fireEvent.pointerCancel(document.body), () => fireEvent(d.handle, new Event('lostpointercapture')), () => fireEvent.blur(window)]) {
      d.press()
      expect(d.busy()).toBe(true)
      end()
      expect(d.busy()).toBe(false)
    }
    expect(d.onEnd).toHaveBeenCalledTimes(3)
    d.press()
    d.unmount()
    expect(d.onEnd).toHaveBeenCalledTimes(4)
  })

  it('a second press mid-drag starts over; a capture the browser refuses changes nothing', () => {
    const d = setup()
    d.press()
    d.press({ clientX: 99 })
    expect(d.onEnd).toHaveBeenCalledTimes(1)
    expect(d.onStart).toHaveBeenLastCalledWith({ clientX: 99, clientY: 20 })
    fireEvent.pointerUp(document.body, { clientX: 1 })
    capture.set.mockImplementation(() => {
      throw new Error('no such pointer')
    })
    capture.release.mockImplementation(() => {
      throw new Error('released already')
    })
    d.press()
    expect(d.busy()).toBe(true)
    fireEvent.pointerUp(document.body)
    expect(d.busy()).toBe(false)
  })

  it('works without handlers for start and end', () => {
    const onMove = vi.fn()
    render(<Handle onMove={onMove} />)
    fireEvent.pointerDown(screen.getByRole('separator'), { pointerId: 2 })
    fireEvent.pointerMove(document.body, { clientX: 5, buttons: 1 })
    act(() => void fireEvent.pointerUp(document.body))
    expect(onMove).toHaveBeenCalledWith({ clientX: 5, clientY: 0 })
  })
})
