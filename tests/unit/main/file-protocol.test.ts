import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'
import { pathOf, serveFile } from '../../../electron/main/platform/fileProtocol'

const url = (host: string, path: string, query = '') => `mindeck-file://${host}${path.split('/').map(encodeURIComponent).join('/')}${query}`
const get = (u: string, range?: string, deps?: Parameters<typeof serveFile>[1]) => serveFile(new Request(u, range ? { headers: { range } } : {}), deps)

describe('mindeck-file:// — local files for previews', () => {
  it('serves media as itself, everything else as plain text, with byte ranges for seeking', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'clip one.mp4'), Buffer.from('0123456789'))
    await writeFile(join(dir, 'page.html'), '<script>alert(1)</script>')
    await mkdir(join(dir, 'folder'))

    const full = await get(url('local', join(dir, 'clip one.mp4')))
    expect(full.status).toBe(200)
    expect(Object.fromEntries(full.headers)).toMatchObject({
      'content-type': 'video/mp4',
      'content-length': '10',
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      // An SVG opened as a page would still run nothing.
      'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"
    })
    expect(await full.text()).toBe('0123456789')

    const part = await get(url('local', join(dir, 'clip one.mp4')), 'bytes=2-5')
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await part.text()).toBe('2345')
    const tail = await get(url('local', join(dir, 'clip one.mp4')), 'bytes=7-')
    expect(await tail.text()).toBe('789')
    const suffix = await get(url('local', join(dir, 'clip one.mp4')), 'bytes=-3')
    expect(suffix.headers.get('content-range')).toBe('bytes 7-9/10')
    const past = await get(url('local', join(dir, 'clip one.mp4')), 'bytes=4-99')
    expect(past.headers.get('content-range')).toBe('bytes 4-9/10')
    const wrong = await get(url('local', join(dir, 'clip one.mp4')), 'bytes=20-30')
    expect(wrong.status).toBe(416)
    expect(wrong.headers.get('content-range')).toBe('bytes */10')
    expect((await get(url('local', join(dir, 'clip one.mp4')), 'bytes=-')).status).toBe(200) // no range in it: the whole file
    expect((await get(url('local', join(dir, 'clip one.mp4')), 'items=1-2')).status).toBe(200)

    // nothing runs from here
    expect((await get(url('local', join(dir, 'page.html')))).headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect((await get(url('local', join(dir, 'folder')))).status).toBe(404)
    expect((await get(url('local', join(dir, 'gone.png')))).status).toBe(404)
    expect((await get(url('other', join(dir, 'clip one.mp4')))).status).toBe(404)
    expect((await get('mindeck-file://local/%E0%A4%A')).status).toBe(400)
    expect((await get('mindeck-file://local/a%00b')).status).toBe(400)
  })

  it('serves the OS thumbnail of any file, within sane sizes', async () => {
    const thumbnail = vi.fn(async (path: string, size: number) => (path.endsWith('.pdf') ? Buffer.from(`png${size}`) : null))
    const ok = await get(url('thumb', '/docs/a.pdf', '?size=4000'), undefined, { thumbnail })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    expect(await ok.text()).toBe('png1024')
    await get(url('thumb', '/docs/a.pdf', '?size=2'), undefined, { thumbnail })
    expect(thumbnail).toHaveBeenLastCalledWith('/docs/a.pdf', 16)
    await get(url('thumb', '/docs/a.pdf'), undefined, { thumbnail })
    expect(thumbnail).toHaveBeenLastCalledWith('/docs/a.pdf', 256)
    expect((await get(url('thumb', '/docs/a.bin'), undefined, { thumbnail })).status).toBe(404)
    expect((await get(url('thumb', '/docs/a.pdf'), undefined, { thumbnail: async () => Promise.reject(new Error('no QL')) })).status).toBe(404)
    expect((await get(url('thumb', '/docs/a.pdf'))).status).toBe(404) // no thumbnails on this host
  })

  it('reads Windows drive paths', () => {
    expect(pathOf(new URL('mindeck-file://local/C%3A/Users/me/a.png'), 'win32')).toBe('C:/Users/me/a.png')
    expect(pathOf(new URL('mindeck-file://local/Users/me/a.png'), 'darwin')).toBe('/Users/me/a.png')
    expect(pathOf(new URL('mindeck-file://local/Users/me/a.png'))).toBe('/Users/me/a.png')
  })

  it('never a network or device path on Windows — looking there would send the user’s credentials (BE-SEC-23)', async () => {
    for (const u of ['mindeck-file://local//attacker/share/a.png', 'mindeck-file://local/%5C%5Cattacker%5Cshare%5Ca.png', 'mindeck-file://local/%5Cattacker/a.png', 'mindeck-file://local/%5C%5C%3F%5CC%3A%5Ca.png', 'mindeck-file://thumb//attacker/share/a.pdf']) {
      expect(pathOf(new URL(u), 'win32'), u).toBeNull()
    }
    const thumbnail = vi.fn(async () => Buffer.from('png'))
    expect((await serveFile(new Request('mindeck-file://thumb//attacker/share/a.pdf'), { platform: 'win32', thumbnail })).status).toBe(400)
    expect(thumbnail).not.toHaveBeenCalled()
    // Elsewhere `//x` is just `/x`.
    expect(pathOf(new URL('mindeck-file://local//srv/a.png'), 'linux')).toBe('//srv/a.png')
  })
})
