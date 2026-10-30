import { describe, expect, it } from 'vitest'
import { RemoteActivity } from '../../../electron/main/server/RemoteActivity'
import type { CallContext } from '../../../electron/ipc/router'

const phone: CallContext = { transport: 'remote', deviceId: 'd1', role: 'admin' }

function setup() {
  const logged: [string, string, unknown][] = []
  const names: Record<string, string> = { d1: 'iPhone', d2: 'iPad' }
  let broken = false
  const a = new RemoteActivity({
    devices: async () => {
      if (broken) throw new Error('no devices file')
      return Object.entries(names).map(([id, name]) => ({ id, name }))
    },
    log: (type, deviceId, payload) => logged.push([type, deviceId, payload])
  })
  return { a, logged, names, breakDevices: () => (broken = true) }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

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

  it('names a device it cannot find by its id, and ignores the desktop, the browser and other channels', async () => {
    const { a, logged, names, breakDevices } = setup()
    delete names.d1
    a.observe('finder:mkdir', { parent: '/home/ada', name: 'A' }, '/home/ada/A', phone)
    await flush()
    breakDevices()
    a.observe('finder:mkdir', { parent: '/home/ada', name: 'B' }, '/home/ada/B', { transport: 'remote', deviceId: 'broken' })
    a.observe('finder:mkdir', { parent: '/home/ada', name: 'C' }, '/home/ada/C', { transport: 'ipc' })
    a.observe('finder:mkdir', { parent: '/home/ada', name: 'D' }, '/home/ada/D', { transport: 'remote' })
    a.observe('browser:open', { url: 'https://x.dev/' }, {}, phone)
    a.observe('memory:read', { path: 'a.md' }, {}, phone)
    a.observe('finder:list', { path: '/home/ada' }, {}, phone)
    a.observe('finder:places', undefined, {}, phone) // no payload at all
    await flush()
    expect(logged.map(([, id, p]) => [id, p])).toEqual([
      ['d1', { device: 'd1', action: 'mkdir', path: '/home/ada/A' }],
      ['broken', { device: 'broken', action: 'mkdir', path: '/home/ada/B' }]
    ])
  })
})
