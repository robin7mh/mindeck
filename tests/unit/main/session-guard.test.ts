import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import { guardSession } from '../../../electron/main/platform/sessionGuard'

type Request = (contents: unknown, permission: string, callback: (ok: boolean) => void, details: { requestingUrl: string; isMainFrame: boolean }) => void
type Check = (contents: unknown, permission: string, origin: string, details: { requestingUrl?: string; isMainFrame: boolean }) => boolean

function fakeSession() {
  const s = {
    request: undefined as undefined | Request,
    check: undefined as undefined | Check,
    display: undefined as undefined | ((request: unknown, callback: (streams: unknown) => void) => void),
    device: undefined as undefined | ((details: unknown) => boolean),
    setPermissionRequestHandler: vi.fn((fn: Request) => (s.request = fn)),
    setPermissionCheckHandler: vi.fn((fn: Check) => (s.check = fn)),
    setDisplayMediaRequestHandler: vi.fn((fn: typeof s.display) => (s.display = fn)),
    setDevicePermissionHandler: vi.fn((fn: typeof s.device) => (s.device = fn))
  }
  return s
}

const APP = 'file:///Applications/Mindeck.app/renderer/index.html'
const trusted = (url: string) => url.startsWith(APP)

describe('guardSession — Mindeck’s own windows', () => {
  it('allows full screen and copying; refuses microphone, camera, location, the screen, devices and the rest', () => {
    const s = fakeSession()
    guardSession(s as unknown as Session, trusted)
    const ask = (permission: string, url = 'http://evil.example/', isMainFrame = true) => {
      const callback = vi.fn()
      s.request!(null, permission, callback, { requestingUrl: url, isMainFrame })
      return callback.mock.calls[0][0] as boolean
    }
    expect(ask('fullscreen')).toBe(true)
    expect(ask('clipboard-sanitized-write')).toBe(true)
    for (const p of ['media', 'geolocation', 'notifications', 'display-capture', 'openExternal', 'midiSysex', 'hid', 'usb', 'serial', 'pointerLock', 'unknown']) {
      expect(ask(p, APP)).toBe(false)
    }
    // Reading the clipboard: Mindeck's page (its top frame) only — never another page, nor a frame inside it.
    expect(ask('clipboard-read', APP)).toBe(true)
    expect(ask('clipboard-read')).toBe(false)
    expect(ask('clipboard-read', APP, false)).toBe(false)
    expect(ask('clipboard-read', 'about:srcdoc')).toBe(false)

    const check = (permission: string, requestingUrl?: string, isMainFrame = true) => s.check!(null, permission, 'file://', { requestingUrl, isMainFrame })
    expect(check('clipboard-sanitized-write')).toBe(true)
    expect(check('fullscreen', 'http://evil.example/')).toBe(true)
    expect(check('clipboard-read', APP)).toBe(true)
    expect(check('clipboard-read')).toBe(false)
    expect(check('media', APP)).toBe(false)
    expect(check('geolocation', APP)).toBe(false)
    expect(check('usb', APP)).toBe(false)

    const shared = vi.fn()
    s.display!({}, shared)
    expect(shared).toHaveBeenCalledWith(null)
    expect(s.device!({ deviceType: 'hid' })).toBe(false)
  })

  it('a session is set up once', () => {
    const s = fakeSession()
    guardSession(s as unknown as Session, trusted)
    guardSession(s as unknown as Session, () => true)
    expect(s.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    expect(s.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
  })
})
