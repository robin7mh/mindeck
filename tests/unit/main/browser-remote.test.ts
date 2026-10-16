import { describe, expect, it, vi } from 'vitest'
import { setupBrowser } from './browserServiceFixtures'
import type { AutomationTarget } from '../../../electron/main/services/browser/types'

/** A tab's DevTools and pictures, as a paired device uses them through the core. */
function target(metrics: unknown = { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } }) {
  return {
    cdp: vi.fn(async (method: string, _params?: unknown) => {
      if (method === 'Page.getLayoutMetrics') {
        if (metrics instanceof Error) throw metrics
        return metrics
      }
      return {}
    }),
    capture: vi.fn(),
    preview: vi.fn(async (width: number) => ({ jpeg: 'anBn', width, height: 506 }))
  }
}

async function setup(t = target()) {
  const s = await setupBrowser()
  s.host.automation.mockReturnValue(t as unknown as AutomationTarget)
  s.b.attach(s.host)
  return { ...s, t }
}

describe('the browser for a paired device', () => {
  it('pictures a tab with the page size taps map onto — loading a tab that was not loaded yet', async () => {
    const { b, t, events, host } = await setup()
    const tab = b.open({ url: 'https://a.dev/' })
    expect(await b.capture(tab.id)).toEqual({ image: 'data:image/jpeg;base64,anBn', width: 900, height: 506, viewport: { width: 1280, height: 720 } })
    expect(t.preview).toHaveBeenCalledWith(900, 70)
    await b.capture(tab.id, 480)
    expect(t.preview).toHaveBeenLastCalledWith(480, 70)

    // A tab from the last session, never shown: its view comes first.
    const later = b.open({ url: 'https://b.dev/', background: true })
    b.detach()
    b.attach(host)
    host.create.mockClear()
    const shot = b.capture(later.id)
    await vi.waitFor(() => expect(host.create).toHaveBeenCalledWith(later.id, 'https://b.dev/', expect.any(Object)))
    events.loading(later.id, false)
    expect(await shot).toMatchObject({ image: 'data:image/jpeg;base64,anBn' })
  })

  it('without the page size, the picture’s own; the new-tab page has no picture', async () => {
    const { b } = await setup(target(new Error('no CDP')))
    const tab = b.open({ url: 'https://a.dev/' })
    expect(await b.capture(tab.id)).toMatchObject({ viewport: { width: 900, height: 506 } })
    const blank = b.open({})
    expect(await b.capture(blank.id)).toBeNull()
    const old = await setup(target({}))
    const page = old.b.open({ url: 'https://c.dev/' })
    expect(await old.b.capture(page.id)).toMatchObject({ viewport: { width: 900, height: 506 } })
  })

  it('taps, scrolls, types and presses keys through DevTools', async () => {
    const { b, t } = await setup()
    const tab = b.open({ url: 'https://a.dev/' })
    await b.input(tab.id, { action: 'click', x: 10, y: 20 })
    expect(t.cdp.mock.calls.map((c) => c[1])).toEqual([
      { type: 'mouseMoved', x: 10, y: 20 },
      { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 10, y: 20, button: 'left', clickCount: 1 }
    ])
    t.cdp.mockClear()
    await b.input(tab.id, { action: 'scroll', x: 5, y: 6, dx: 0, dy: 400 })
    expect(t.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 5, y: 6, deltaX: 0, deltaY: 400 })
    await b.input(tab.id, { action: 'type', text: 'hallo' })
    expect(t.cdp).toHaveBeenCalledWith('Input.insertText', { text: 'hallo' })
    t.cdp.mockClear()
    await b.input(tab.id, { action: 'key', key: 'Enter' })
    expect(t.cdp.mock.calls).toEqual([
      ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' }],
      ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }]
    ])
    t.cdp.mockClear()
    await b.input(tab.id, { action: 'key', key: 'Backspace' })
    expect(t.cdp.mock.calls[0]).toEqual(['Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }])
    const blank = b.open({})
    await expect(b.input(blank.id, { action: 'type', text: 'x' })).rejects.toMatchObject({ code: 'no-page' })
  })

  it('never a private tab, an unknown one, or a core without the desktop window', async () => {
    const { b } = await setup()
    const secret = b.open({ url: 'https://bank.dev/', private: true })
    await expect(b.capture(secret.id)).rejects.toMatchObject({ code: 'remote-forbidden' })
    await expect(b.input(secret.id, { action: 'type', text: 'x' })).rejects.toMatchObject({ code: 'remote-forbidden' })
    await expect(b.capture('nope')).rejects.toMatchObject({ code: 'not-found' })
    const headless = await setupBrowser()
    await expect(headless.b.capture('x')).rejects.toMatchObject({ code: 'desktop-only' })
  })
})
