import { afterEach, describe, expect, it, vi } from 'vitest'
import { IN_USE_MS, REPEAT_MS, RemoteActivity } from '../../../electron/main/server/RemoteActivity'
import type { CallContext } from '../../../electron/ipc/router'
import type { BrowserRemoteUse } from '@shared/types/browser'

const phone: CallContext = { transport: 'remote', deviceId: 'd1', role: 'admin', browser: true }
const tablet: CallContext = { transport: 'remote', deviceId: 'd2', role: 'admin', browser: true }

function setup() {
  let now = Date.parse('2026-10-16T10:00:00.000Z')
  const logged: [string, string, unknown][] = []
  const inUse: BrowserRemoteUse[][] = []
  const names: Record<string, string> = { d1: 'iPhone', d2: 'iPad' }
  let broken = false
  const a = new RemoteActivity({
    devices: async () => {
      if (broken) throw new Error('no devices file')
      return Object.entries(names).map(([id, name]) => ({ id, name }))
    },
    log: (type, deviceId, payload) => logged.push([type, deviceId, payload]),
    inUse: (list) => inUse.push(list),
    browserTab: (id) => ({ t1: { url: 'https://github.com/ada' }, t2: { url: 'https://bank.example/login' }, blank: { url: '' }, odd: { url: 'not a url' }, about: { url: 'about:blank' } })[id],
    webUrl: (input) => (input.startsWith('http') ? input : input.includes(' ') ? `https://duckduckgo.com/?q=${encodeURIComponent(input)}` : `https://${input}/`),
    now: () => now
  })
  return { a, logged, inUse, names, tick: (ms: number) => (now += ms), breakDevices: () => (broken = true) }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('what paired devices do with the browser', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('logs where a device went and what it did — never what it typed; pictures and taps once a minute', async () => {
    const { a, logged, tick } = setup()
    a.observe('browser:open', { url: 'github.com' }, {}, phone)
    a.observe('browser:open', {}, {}, phone)
    a.observe('browser:navigate', { id: 't1', input: 'my bank password reset' }, undefined, phone)
    a.observe('browser:capture', { id: 't1' }, {}, phone)
    a.observe('browser:capture', { id: 't1' }, {}, phone)
    a.observe('browser:input', { id: 't2', action: 'type', text: 'hunter2' }, undefined, phone)
    a.observe('browser:input', { id: 't2', action: 'key', key: 'Enter' }, undefined, phone)
    a.observe('browser:input', { id: 'blank', action: 'click', x: 1, y: 1 }, undefined, phone)
    a.observe('browser:capture', { id: 'odd' }, {}, phone) // pages without a host: logged without one
    a.observe('browser:capture', { id: 'about' }, {}, phone)
    a.observe('browser:close', { id: 't1' }, undefined, phone)
    a.observe('browser:bookmarkAdd', { title: 'Work', url: 'https://work.example/x' }, {}, phone)
    a.observe('browser:bookmarkAdd', { title: 'A folder' }, {}, phone)
    a.observe('browser:state', undefined, {}, phone) // looking at the tab list: not worth a line
    await flush()
    expect(logged.map(([type, , p]) => [type, p])).toEqual([
      ['device.browser', { device: 'iPhone', action: 'open', host: 'github.com' }],
      ['device.browser', { device: 'iPhone', action: 'open' }],
      ['device.browser', { device: 'iPhone', action: 'navigate', host: 'duckduckgo.com' }],
      ['device.browser', { device: 'iPhone', action: 'view', host: 'github.com' }],
      ['device.browser', { device: 'iPhone', action: 'input', host: 'bank.example' }],
      ['device.browser', { device: 'iPhone', action: 'input' }],
      ['device.browser', { device: 'iPhone', action: 'view' }],
      ['device.browser', { device: 'iPhone', action: 'view' }],
      ['device.browser', { device: 'iPhone', action: 'close' }],
      ['device.browser', { device: 'iPhone', action: 'bookmark', host: 'work.example' }],
      ['device.browser', { device: 'iPhone', action: 'bookmark' }]
    ])
    expect(JSON.stringify(logged)).not.toMatch(/hunter2|password reset/)
    expect(logged.every(([, id]) => id === 'd1')).toBe(true)
    // A minute later the same page is worth a line again.
    tick(REPEAT_MS)
    a.observe('browser:capture', { id: 't1' }, {}, phone)
    a.observe('browser:capture', { id: 't1' }, {}, tablet)
    await flush()
    expect(logged.slice(-2).map(([, id, p]) => [id, p])).toEqual([
      ['d1', { device: 'iPhone', action: 'view', host: 'github.com' }],
      ['d2', { device: 'iPad', action: 'view', host: 'github.com' }]
    ])
    a.dispose()
  })

  it('shows the desktop who uses the browser until 45 s after its last call, or until it is stopped', async () => {
    vi.useFakeTimers()
    const { a, inUse } = setup()
    a.observe('browser:capture', { id: 't1' }, {}, phone)
    await vi.advanceTimersByTimeAsync(0)
    expect(inUse.at(-1)).toEqual([{ deviceId: 'd1', device: 'iPhone', since: '2026-10-16T10:00:00.000Z' }])
    // More calls keep it — without telling the desktop again.
    await vi.advanceTimersByTimeAsync(IN_USE_MS - 1000)
    a.observe('browser:capture', { id: 't1' }, {}, phone)
    await vi.advanceTimersByTimeAsync(IN_USE_MS - 1000)
    expect(inUse).toHaveLength(1)
    a.observe('browser:state', undefined, {}, tablet)
    await vi.advanceTimersByTimeAsync(0)
    expect(inUse.at(-1)!.map((u) => u.device).sort()).toEqual(['iPad', 'iPhone'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(inUse.at(-1)!.map((u) => u.device)).toEqual(['iPad'])
    // Stopped at the desktop: gone at once; releasing a device that uses nothing changes nothing.
    a.release('d2')
    expect(inUse.at(-1)).toEqual([])
    const count = inUse.length
    a.release('d2')
    expect(inUse).toHaveLength(count)
    // Released before its name came: it does not come back.
    a.observe('browser:state', undefined, {}, phone)
    a.release('d1')
    await vi.advanceTimersByTimeAsync(0)
    expect(inUse.at(-1)).toEqual([])
    a.observe('browser:state', undefined, {}, phone)
    a.dispose()
    await vi.advanceTimersByTimeAsync(IN_USE_MS)
  })

  it('keeps time by the clock unless told otherwise', () => {
    const a = new RemoteActivity({ devices: async () => [], log: () => {}, inUse: () => {}, browserTab: () => undefined, webUrl: () => undefined })
    a.observe('browser:state', undefined, {}, phone)
    a.dispose()
  })

  it('forgets what it logged when it remembers too many pages', async () => {
    const { a, logged } = setup()
    for (let i = 0; i <= 1001; i += 1) a.observe('browser:capture', { id: `x${i}` }, {}, phone)
    a.observe('browser:capture', { id: 'x0' }, {}, phone)
    await flush()
    expect(logged).toHaveLength(1003)
    a.dispose()
  })

  it('names a device it cannot find by its id, and ignores the desktop and other channels', async () => {
    const { a, logged, inUse, names, breakDevices } = setup()
    delete names.d1
    a.observe('browser:navigate', { id: 't1', input: 'https://x.dev/' }, undefined, phone)
    await flush()
    breakDevices()
    a.observe('browser:navigate', { id: 't1', input: 'https://x.dev/' }, undefined, { transport: 'remote', deviceId: 'broken' })
    a.observe('browser:navigate', { id: 't1', input: 'https://x.dev/' }, undefined, { transport: 'ipc' })
    a.observe('browser:navigate', { id: 't1', input: 'https://x.dev/' }, undefined, { transport: 'remote' })
    a.observe('memory:read', { path: 'a.md' }, {}, phone)
    a.observe('finder:list', { path: '/home/ada' }, {}, phone)
    await flush()
    expect(logged.map(([, , p]) => p)).toEqual([
      { device: 'd1', action: 'navigate', host: 'x.dev' },
      { device: 'broken', action: 'navigate', host: 'x.dev' }
    ])
    expect(inUse.at(-1)!.map((u) => [u.deviceId, u.device]).sort()).toEqual([
      ['broken', 'broken'],
      ['d1', 'd1']
    ])
    a.dispose()
  })
})

describe('what paired devices do with the files', () => {
  it('logs downloads, uploads and every change — a batch with its first paths and its size', async () => {
    const { a, logged } = setup()
    const many = Array.from({ length: 25 }, (_, i) => `/home/ada/f${i}.txt`)
    a.observe('finder:read', { path: '/home/ada/a.pdf' }, {}, phone)
    a.observe('finder:read', { path: '/home/ada/a.pdf', offset: 4194304 }, {}, phone)
    a.observe('finder:write', { path: '/home/ada/up.jpg', data: 'AAAA' }, { size: 3 }, phone)
    a.observe('finder:write', { path: '/home/ada/up.jpg', data: 'AAAA', offset: 3 }, { size: 6 }, phone)
    a.observe('finder:mkdir', { parent: '/home/ada', name: 'New' }, '/home/ada/New', phone)
    a.observe('finder:rename', { path: '/home/ada/a.txt', name: 'b.txt' }, '/home/ada/b.txt', phone)
    a.observe('finder:trash', { paths: many }, [], phone)
    a.observe('finder:untrash', { items: [{ path: '/home/ada/.Trash/a', restore: '/home/ada/a' }] }, {}, phone)
    a.observe('finder:move', { paths: ['/home/ada/a'], dest: '/home/ada/Archive' }, [], phone)
    a.observe('finder:copy', { paths: ['/home/ada/a', '/home/ada/b'], dest: '/Volumes/USB' }, [], phone)
    a.observe('finder:transfer', { id: 'x', paths: ['/home/ada/a'], dest: '/home/ada/B', mode: 'move' }, {}, phone)
    a.observe('finder:restore', { moves: [{ from: '/a', to: '/b' }] }, undefined, phone)
    a.observe('finder:compress', { paths: ['/home/ada/a'], id: 'z' }, '/home/ada/a.zip', phone)
    a.observe('finder:extract', { path: '/home/ada/a.zip', id: 'z' }, '/home/ada/a', phone)
    a.observe('finder:preview', { path: '/home/ada/a.png' }, {}, phone)
    await flush()
    expect(logged.map(([type, , p]) => [type, p])).toEqual([
      ['device.files', { device: 'iPhone', action: 'download', path: '/home/ada/a.pdf' }],
      ['device.files', { device: 'iPhone', action: 'upload', path: '/home/ada/up.jpg' }],
      ['device.files', { device: 'iPhone', action: 'mkdir', path: '/home/ada/New' }],
      ['device.files', { device: 'iPhone', action: 'rename', path: '/home/ada/a.txt', dest: '/home/ada/b.txt' }],
      ['device.files', { device: 'iPhone', action: 'trash', paths: many.slice(0, 20), count: 25 }],
      ['device.files', { device: 'iPhone', action: 'restore', paths: ['/home/ada/a'], count: 1 }],
      ['device.files', { device: 'iPhone', action: 'move', paths: ['/home/ada/a'], count: 1, dest: '/home/ada/Archive' }],
      ['device.files', { device: 'iPhone', action: 'copy', paths: ['/home/ada/a', '/home/ada/b'], count: 2, dest: '/Volumes/USB' }],
      ['device.files', { device: 'iPhone', action: 'move', paths: ['/home/ada/a'], count: 1, dest: '/home/ada/B' }],
      ['device.files', { device: 'iPhone', action: 'undo', count: 1 }],
      ['device.files', { device: 'iPhone', action: 'compress', paths: ['/home/ada/a'], count: 1, dest: '/home/ada/a.zip' }],
      ['device.files', { device: 'iPhone', action: 'extract', path: '/home/ada/a.zip', dest: '/home/ada/a' }]
    ])
  })
})
