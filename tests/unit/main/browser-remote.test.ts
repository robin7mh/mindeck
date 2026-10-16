import { describe, expect, it, vi } from 'vitest'
import { setupBrowser } from './browserServiceFixtures'
import type { AutomationTarget } from '../../../electron/main/services/browser/types'
import { SECRET_FOCUS } from '../../../electron/main/services/browser/secretFocus'

/** A tab's DevTools and pictures, as a paired device uses them through the core; `focus.secret`: what the page says of its focused field. */
function target(metrics: unknown = { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } }, focus: { secret: unknown } = { secret: false }) {
  return {
    cdp: vi.fn(async (method: string, _params?: unknown) => {
      if (method === 'Page.getLayoutMetrics') {
        if (metrics instanceof Error) throw metrics
        return metrics
      }
      if (method === 'Runtime.evaluate') {
        if (focus.secret instanceof Error) throw focus.secret
        return { result: { value: focus.secret } }
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
    expect(t.cdp).toHaveBeenCalledWith('Runtime.evaluate', { expression: SECRET_FOCUS, returnByValue: true })
    expect(t.cdp).toHaveBeenCalledWith('Input.insertText', { text: 'hallo' })
    t.cdp.mockClear()
    await b.input(tab.id, { action: 'key', key: 'Enter' })
    expect(t.cdp.mock.calls.filter((c) => c[0] !== 'Runtime.evaluate')).toEqual([
      ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' }],
      ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }]
    ])
    t.cdp.mockClear()
    await b.input(tab.id, { action: 'key', key: 'Backspace' })
    expect(t.cdp.mock.calls[1]).toEqual(['Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }])
    const blank = b.open({})
    await expect(b.input(blank.id, { action: 'type', text: 'x' })).rejects.toMatchObject({ code: 'no-page' })
  })

  it('types no passwords, codes or card numbers — nor into frames of other sites, nor when the page cannot say', async () => {
    const focus: { secret: unknown } = { secret: true }
    const { b, t } = await setup(target(undefined, focus))
    const tab = b.open({ url: 'https://bank.dev/' })
    await expect(b.input(tab.id, { action: 'type', text: 'hunter2' })).rejects.toMatchObject({ code: 'secret-field', message: 'Passwords and codes are typed at the desktop only' })
    await expect(b.input(tab.id, { action: 'key', key: 'Enter' })).rejects.toMatchObject({ code: 'secret-field' })
    focus.secret = new Error('page is gone')
    await expect(b.input(tab.id, { action: 'type', text: 'x' })).rejects.toMatchObject({ code: 'secret-field' })
    focus.secret = undefined
    await expect(b.input(tab.id, { action: 'type', text: 'x' })).rejects.toMatchObject({ code: 'secret-field' })
    expect(t.cdp.mock.calls.some((c) => String(c[0]).startsWith('Input.'))).toBe(false)
    // Taps and scrolls still go: the field gets focus, the desktop types.
    await b.input(tab.id, { action: 'click', x: 1, y: 1 })
    expect(t.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed' }))
  })

  it('tells a paired device which typed text is a web page, and shows the desktop who uses the browser', async () => {
    const { b, sent } = await setup()
    expect(b.webUrl('github.com')).toBe('https://github.com/')
    expect(b.webUrl('http://localhost:5173/x')).toBe('http://localhost:5173/x')
    expect(b.webUrl('center a div')).toMatch(/^https:\/\/[^/]+\/.*center%20a%20div/)
    for (const input of ['/etc/passwd', 'file:///etc/passwd', 'mailto:ada@example.com', 'vscode://file/x', 'javascript:alert(1)', 'mindeck://history', '']) {
      expect(b.webUrl(input), input).toBeUndefined()
    }
    expect(b.state()).not.toHaveProperty('remote')
    b.setRemote([{ deviceId: 'd1', device: 'iPhone', since: '2026-10-16T10:00:00.000Z' }])
    expect(b.state().remote).toEqual([{ deviceId: 'd1', device: 'iPhone', since: '2026-10-16T10:00:00.000Z' }])
    await vi.waitFor(() => expect(sent('browser:state').at(-1)).toMatchObject({ remote: [{ device: 'iPhone' }] }))
    b.setRemote([])
    expect(b.state()).not.toHaveProperty('remote')
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
