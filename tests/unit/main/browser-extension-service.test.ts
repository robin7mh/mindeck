import { createHash } from 'node:crypto'
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onCleanup, tempDir } from './helpers'
import { crx, idOf, keyPair, zip } from './extensionFixtures'
import { ExtensionService, type ExtensionDeps, type ExtensionHost, type FetchResponse } from '../../../electron/main/services/browser/extensions/ExtensionService'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const exists = (p: string) => access(p).then(
  () => true,
  () => false
)

function manifest(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ manifest_version: 3, name: 'Vault', version: '1.0.0', description: 'Keeps secrets', action: { default_popup: 'popup.html', default_icon: 'icon.png' }, permissions: ['storage', 'alarms'], ...extra })
}

/** A Web Store package: the archive, its key, its id. */
function storePackage(version = '1.0.0', extra: Record<string, unknown> = {}, key = keyPair()) {
  const archive = zip([
    { name: 'manifest.json', data: manifest({ version, ...extra }) },
    { name: 'popup.html', data: '<p>hi</p>' },
    { name: 'icon.png', data: PNG, method: 0 },
    { name: '_metadata/verified_contents.json', data: '[]' }
  ])
  return { bytes: crx(archive, { keys: [key] }), id: idOf(key.spki), key }
}

const response = (body: string | Buffer, status = 200): FetchResponse => ({
  ok: status < 400,
  status,
  text: async () => body.toString(),
  arrayBuffer: async () => {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body)
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  }
})

const updateXml = (apps: { id: string; version?: string; url?: string; sha?: string }[]) =>
  `<gupdate>${apps
    .map((a) =>
      a.version
        ? `<app appid="${a.id}"><updatecheck status="ok" codebase="${a.url}" version="${a.version}"${a.sha ? ` hash_sha256="${a.sha}"` : ''}/></app>`
        : `<app appid="${a.id}"><updatecheck status="noupdate"/></app>`
    )
    .join('')}</gupdate>`

function fakeHost() {
  return {
    loadExtension: vi.fn(async (path: string) => ({ id: `loaded-${path.split(/[\\/]/).filter(Boolean).at(-1)}` })),
    unloadExtension: vi.fn(),
    openPopup: vi.fn()
  } satisfies ExtensionHost
}

async function setup(opts: { saved?: unknown; deps?: Partial<ExtensionDeps> } = {}) {
  const dir = await tempDir()
  if (opts.saved !== undefined) await writeFile(join(dir, 'extensions.json'), typeof opts.saved === 'string' ? opts.saved : JSON.stringify(opts.saved))
  const routes = new Map<string, () => FetchResponse>()
  const fetch = vi.fn(async (url: string) => {
    for (const [prefix, answer] of routes) if (url.startsWith(prefix)) return answer()
    return response('not found', 404)
  })
  const roots = await tempDir()
  const deps: ExtensionDeps = {
    dir,
    fetch,
    chromeVersion: '140.0.1.2',
    locale: () => 'en',
    roots: () => [{ browser: 'chrome', root: roots }],
    onChange: vi.fn(),
    now: () => Date.UTC(2026, 9, 15),
    ...opts.deps
  }
  const service = new ExtensionService(deps)
  onCleanup(async () => service.dispose())
  await service.init()
  const host = fakeHost()
  const saved = async () => JSON.parse(await readFile(join(dir, 'extensions.json'), 'utf8'))
  return { dir, roots, deps, service, host, fetch, routes, saved }
}

/** The Web Store answers for `pkg` (update check + download). */
function serve(routes: Map<string, () => FetchResponse>, pkgs: ReturnType<typeof storePackage>[], version?: string, sha?: string) {
  routes.set('https://clients2.google.com/', () =>
    response(updateXml(pkgs.map((p) => ({ id: p.id, version: version ?? '1.0.0', url: `https://cdn.dev/${p.id}.crx`, sha }))))
  )
  for (const p of pkgs) routes.set(`https://cdn.dev/${p.id}.crx`, () => response(p.bytes))
}

afterEach(() => vi.useRealTimers())

describe('extensions · installing', () => {
  it('installs from the Web Store: the signed package, its key in the manifest, Chrome’s bookkeeping gone', async () => {
    const { service, host, routes, dir, saved, fetch } = await setup()
    await service.attach(host)
    const pkg = storePackage()
    serve(routes, [pkg], '1.0.0', createHash('sha256').update(pkg.bytes).digest('hex'))
    const ext = await service.install({ source: 'store', input: `https://chromewebstore.google.com/detail/vault/${pkg.id}` })
    expect(fetch.mock.calls[0][0]).toContain(encodeURIComponent(`id=${pkg.id}&v=0.0.0.0&uc`))
    expect(ext).toMatchObject({
      id: pkg.id,
      name: 'Vault',
      version: '1.0.0',
      description: 'Keeps secrets',
      source: 'store',
      enabled: true,
      icon: `data:image/png;base64,${PNG.toString('base64')}`,
      popup: true,
      permissions: ['storage', 'alarms'],
      unsupported: ['alarms']
    })
    const folder = join(dir, 'extensions', pkg.id)
    expect(host.loadExtension).toHaveBeenCalledWith(folder)
    expect(JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')).key).toBe(pkg.key.spki.toString('base64'))
    expect(await exists(join(folder, '_metadata'))).toBe(false)
    expect((await saved()).extensions).toEqual([{ id: pkg.id, source: 'store', path: folder, enabled: true, installedAt: '2026-10-15T00:00:00.000Z' }])
    expect(service.list()).toHaveLength(1)

    // the popup opens under its icon, on the id Chromium loaded it as
    service.popup(pkg.id, { x: 1, y: 2, width: 3, height: 4 })
    expect(host.openPopup).toHaveBeenCalledWith(`chrome-extension://loaded-${pkg.id}/popup.html`, { x: 1, y: 2, width: 3, height: 4 })

    // installing it again replaces the copy (unloaded first)
    await service.install({ source: 'store', input: pkg.id })
    expect(host.unloadExtension).toHaveBeenCalledWith(`loaded-${pkg.id}`)
    expect(service.list()).toHaveLength(1)
  })

  it('refuses store input that is no extension, and packages that are not what they claim', async () => {
    const { service, routes } = await setup()
    await expect(service.install({ source: 'store', input: 'bitwarden' })).rejects.toMatchObject({ code: 'bad-input' })
    const pkg = storePackage()
    await expect(service.install({ source: 'store', input: pkg.id })).rejects.toMatchObject({ code: 'store-unavailable' }) // the update check 404s
    routes.set('https://clients2.google.com/', () => response(updateXml([{ id: pkg.id }])))
    await expect(service.install({ source: 'store', input: pkg.id })).rejects.toMatchObject({ code: 'not-found' })
    routes.set('https://clients2.google.com/', () => response(updateXml([{ id: pkg.id, version: '1.0.0', url: 'https://cdn.dev/gone.crx' }])))
    await expect(service.install({ source: 'store', input: pkg.id })).rejects.toThrow('HTTP 404')
    serve(routes, [pkg], '1.0.0', 'deadbeef')
    await expect(service.install({ source: 'store', input: pkg.id })).rejects.toThrow('checksum')
    const other = storePackage()
    routes.set('https://clients2.google.com/', () => response(updateXml([{ id: pkg.id, version: '1.0.0', url: 'https://cdn.dev/other.crx' }])))
    routes.set('https://cdn.dev/other.crx', () => response(other.bytes))
    await expect(service.install({ source: 'store', input: pkg.id })).rejects.toThrow('different extension')
    routes.set('https://cdn.dev/other.crx', () => response(Buffer.alloc(101 * 1024 * 1024)))
    await expect(service.install({ source: 'store', input: pkg.id })).rejects.toThrow('too large')
    // a package whose manifest is no extension: nothing stays behind
    const theme = storePackage('1.0.0', { theme: {} })
    serve(routes, [theme])
    await expect(service.install({ source: 'store', input: theme.id })).rejects.toThrow('Themes')
    expect(service.list()).toEqual([])
  })

  it('copies an extension from another browser’s profile — only from there', async () => {
    const { service, roots, host, dir } = await setup()
    const source = join(roots, 'Default', 'Extensions', 'a'.repeat(32), '2.0_0')
    await mkdir(join(source, '_metadata'), { recursive: true })
    await writeFile(join(source, 'manifest.json'), manifest({ version: '2.0', key: 'KEY', action: {} }))
    await writeFile(join(source, '_metadata', 'computed_hashes.json'), '{}')
    // installed before the window is up: loaded once it is
    const ext = await service.install({ source: 'profile', path: source })
    expect(ext).toMatchObject({ id: 'a'.repeat(32), source: 'profile', version: '2.0', popup: false })
    expect(ext).not.toHaveProperty('icon')
    expect(host.loadExtension).not.toHaveBeenCalled()
    expect(await exists(join(dir, 'extensions', 'a'.repeat(32), '_metadata'))).toBe(false)
    await service.attach(host)
    expect(host.loadExtension).toHaveBeenCalledWith(join(dir, 'extensions', 'a'.repeat(32)))
    await expect(service.install({ source: 'profile', path: '/etc' })).rejects.toMatchObject({ code: 'bad-input' })
    expect((await service.profiles())[0].extensions[0]).toMatchObject({ name: 'Vault', installed: true })
  })

  it('loads an unpacked folder in place — picked or given — and keeps the user’s folder when it goes', async () => {
    const pickFolder = vi.fn(async () => null as string | null)
    const { service, host, routes } = await setup({ deps: { pickFolder } })
    await expect(service.install({ source: 'folder', path: '/x' })).rejects.toMatchObject({ code: 'desktop-only' })
    await service.attach(host)
    expect(await service.install({ source: 'folder' })).toBeNull()
    const folder = await tempDir()
    await writeFile(join(folder, 'manifest.json'), manifest({ action: { default_icon: 'icon.svg' } }))
    await writeFile(join(folder, 'icon.svg'), '<svg/>')
    pickFolder.mockResolvedValueOnce(folder)
    const ext = (await service.install({ source: 'folder' }))!
    expect(pickFolder).toHaveBeenCalledWith('Choose an unpacked extension folder')
    expect(ext).toMatchObject({ source: 'folder', icon: expect.stringMatching(/^data:image\/svg\+xml;base64,/) })
    const id = ext.id
    // loading it again (say, after editing it) keeps it one entry
    await service.install({ source: 'folder', path: folder })
    expect(service.list()).toHaveLength(1)
    await service.remove(id)
    expect(await exists(join(folder, 'manifest.json'))).toBe(true)
    expect(host.unloadExtension).toHaveBeenCalledWith(id)

    // a folder with the id of a store install takes its place
    const pkg = storePackage()
    serve(routes, [pkg])
    await service.install({ source: 'store', input: pkg.id })
    await service.setEnabled(pkg.id, false) // switched off: nothing loaded to unload
    host.loadExtension.mockResolvedValueOnce({ id: pkg.id })
    await service.install({ source: 'folder', path: folder })
    expect(service.list()).toEqual([expect.objectContaining({ id: pkg.id, source: 'folder' })])
    // and a folder over a folder (another path, same id) leaves the first folder alone
    const second = await tempDir()
    await writeFile(join(second, 'manifest.json'), manifest())
    host.loadExtension.mockResolvedValueOnce({ id: pkg.id })
    await service.install({ source: 'folder', path: second })
    expect(service.list()).toEqual([expect.objectContaining({ id: pkg.id, source: 'folder' })])
    expect(await exists(join(folder, 'manifest.json'))).toBe(true)
  })

  it('has no folder picker on a headless core; takes folders without icons, or with odd ones', async () => {
    const { service, host } = await setup({ deps: { now: undefined } })
    await service.attach(host)
    await expect(service.install({ source: 'folder' })).rejects.toMatchObject({ code: 'desktop-only' })
    const plain = await tempDir()
    await writeFile(join(plain, 'manifest.json'), manifest({ action: {} }))
    expect(await service.install({ source: 'folder', path: plain })).not.toHaveProperty('icon')
    const odd = await tempDir()
    await writeFile(join(odd, 'manifest.json'), manifest({ action: { default_icon: 'icon.bmp' } }))
    await writeFile(join(odd, 'icon.bmp'), 'BM')
    host.loadExtension.mockResolvedValueOnce({ id: 'odd' })
    const ext = (await service.install({ source: 'folder', path: odd }))!
    expect(ext).not.toHaveProperty('icon')
    expect(Date.parse(ext.installedAt)).toBeGreaterThan(Date.UTC(2026, 0, 1) - 1e12)
  })
})

describe('extensions · managing', () => {
  it('turns extensions on and off, removes them, and shows why one failed to load', async () => {
    const { service, host, routes, dir, saved } = await setup()
    const pkg = storePackage()
    serve(routes, [pkg])
    await service.attach(host)
    await service.install({ source: 'store', input: pkg.id })
    const off = await service.setEnabled(pkg.id, false)
    expect(off.enabled).toBe(false)
    expect(host.unloadExtension).toHaveBeenCalledWith(`loaded-${pkg.id}`)
    expect(() => service.popup(pkg.id, { x: 0, y: 0, width: 1, height: 1 })).toThrow('no popup')
    expect((await saved()).extensions[0].enabled).toBe(false)
    host.loadExtension.mockRejectedValueOnce(new Error('Manifest key is invalid'))
    const failed = await service.setEnabled(pkg.id, true)
    expect(failed.error).toBe('Manifest key is invalid')
    host.unloadExtension.mockClear()
    expect((await service.setEnabled(pkg.id, false)).enabled).toBe(false) // it never loaded: nothing to unload
    expect(host.unloadExtension).not.toHaveBeenCalled()
    host.loadExtension.mockRejectedValueOnce(new Error('Manifest key is invalid'))
    await service.setEnabled(pkg.id, true)
    host.loadExtension.mockRejectedValueOnce('odd')
    expect((await service.setEnabled(pkg.id, true)).error).toBe('odd')
    expect((await service.setEnabled(pkg.id, true)).error).toBeUndefined()
    await service.remove(pkg.id)
    expect(await exists(join(dir, 'extensions', pkg.id))).toBe(false)
    expect(service.list()).toEqual([])
    await expect(service.setEnabled(pkg.id, true)).rejects.toMatchObject({ code: 'not-found' })
    await expect(service.remove(pkg.id)).rejects.toMatchObject({ code: 'not-found' })
    expect(() => service.popup('nope', { x: 0, y: 0, width: 1, height: 1 })).toThrow('not found')
    // a failure does not jam the queue
    expect(await service.checkUpdates()).toEqual({ checked: 0, updated: [], failed: [] })
  })

  it('deletes only copies in its own folder — not what an edited extensions.json points at', async () => {
    const elsewhere = await tempDir()
    await writeFile(join(elsewhere, 'manifest.json'), manifest())
    const id = 'a'.repeat(32)
    const { service, host, dir } = await setup({ saved: { extensions: [{ id, source: 'store', path: elsewhere, enabled: true }] } })
    await service.attach(host)
    await service.remove(id)
    expect(await exists(join(elsewhere, 'manifest.json'))).toBe(true)
    // Its own folder itself is no extension's copy either.
    const internals = service as unknown as { owned(x: { source: string; path: string }): boolean }
    expect(internals.owned({ source: 'store', path: join(dir, 'extensions') })).toBe(false)
    expect(internals.owned({ source: 'store', path: join(dir, 'extensions', id) })).toBe(true)
    expect(internals.owned({ source: 'folder', path: join(dir, 'extensions', id) })).toBe(false)
  })

  it('remembers the installed ones across starts — and keeps one whose folder went missing listed', async () => {
    const folder = await tempDir()
    await writeFile(join(folder, 'manifest.json'), manifest({ action: { default_icon: 'big.png' } }))
    await writeFile(join(folder, 'big.png'), Buffer.alloc(300 * 1024))
    const { service, host } = await setup({
      saved: {
        lastCheck: 'soon',
        extensions: [
          { id: 'f', source: 'folder', path: folder },
          { id: 'g', source: 'store', path: join(folder, 'gone'), enabled: false, installedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'h', source: 'nowhere', path: '/x' },
          { id: 7, source: 'store', path: '/x' },
          null
        ]
      }
    })
    expect(service.list()).toEqual([
      expect.objectContaining({ id: 'f', name: 'Vault', enabled: true, installedAt: '2026-10-15T00:00:00.000Z' }),
      expect.objectContaining({ id: 'g', name: 'g', version: '', enabled: false, error: expect.stringContaining('manifest.json') })
    ])
    expect(service.list()[0]).not.toHaveProperty('icon') // too big to carry around
    await service.attach(host)
    expect(host.loadExtension).toHaveBeenCalledTimes(1)
    // a broken extensions.json starts empty — set aside, so the next save doesn't overwrite what may be rescued
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = await setup({ saved: '{' })
    expect(broken.service.list()).toEqual([])
    expect((await readdir(broken.dir)).some((name) => name.startsWith('extensions.corrupt-'))).toBe(true)
    expect((await setup({ saved: { extensions: 'x' } })).service.list()).toEqual([])
  })

  it('keeps Web Store extensions up to date — now and then, and on request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const { service, host, routes, fetch, saved, roots } = await setup()
    const a = storePackage('1.0.0')
    const b = storePackage('1.0.0')
    serve(routes, [a, b])
    await service.attach(host)
    await service.install({ source: 'store', input: a.id })
    await service.install({ source: 'store', input: b.id })
    // a profile copy from Edge's store is not the Chrome Web Store's to update; neither is a folder
    const edge = join(roots, 'Default', 'Extensions', 'e'.repeat(32), '1_0')
    await mkdir(edge, { recursive: true })
    await writeFile(join(edge, 'manifest.json'), manifest({ update_url: 'https://edge.microsoft.com/extensionwebstorebase/v1/crx' }))
    await service.install({ source: 'profile', path: edge })

    const a2 = storePackage('2.0.0', {}, a.key)
    routes.set('https://clients2.google.com/', () =>
      response(updateXml([{ id: a.id, version: '2.0.0', url: 'https://cdn.dev/a2.crx' }, { id: b.id, version: '1.0.0', url: 'https://cdn.dev/b.crx' }]))
    )
    routes.set('https://cdn.dev/a2.crx', () => response(a2.bytes))
    fetch.mockClear()
    // the first look comes two minutes after start
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    await vi.waitFor(() => expect(service.list().find((x) => x.id === a.id)!.version).toBe('2.0.0'))
    const check = new URL(fetch.mock.calls[0][0] as string)
    expect(check.searchParams.getAll('x')).toEqual([`id=${a.id}&v=1.0.0&uc`, `id=${b.id}&v=1.0.0&uc`])
    expect((await saved()).lastCheck).toBe(Date.UTC(2026, 9, 15))

    // a broken download is reported, the others still update
    const b3 = storePackage('3.0.0', {}, b.key)
    routes.set('https://clients2.google.com/', () =>
      response(updateXml([{ id: a.id, version: '3.0.0', url: 'https://cdn.dev/broken.crx' }, { id: b.id, version: '3.0.0', url: 'https://cdn.dev/b3.crx' }]))
    )
    routes.set('https://cdn.dev/broken.crx', () => response('garbage'))
    routes.set('https://cdn.dev/b3.crx', () => response(b3.bytes))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await service.checkUpdates()).toEqual({ checked: 2, updated: ['Vault'], failed: ['Vault'] })
    expect(errors).toHaveBeenCalled()
    // the twelve-hourly look; the store being down is no crash
    routes.set('https://clients2.google.com/', () => response('down', 503))
    fetch.mockClear()
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000)
    expect(fetch).toHaveBeenCalled()
    await expect(service.checkUpdates()).rejects.toThrow('HTTP 503')
    service.detach()
    fetch.mockClear()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('the first look finding the store down is no crash', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const { service, host, routes, fetch } = await setup()
    const pkg = storePackage()
    serve(routes, [pkg])
    await service.attach(host)
    await service.install({ source: 'store', input: pkg.id })
    routes.set('https://clients2.google.com/', () => response('down', 503))
    fetch.mockClear()
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    expect(fetch).toHaveBeenCalled()
    await expect(service.checkUpdates()).rejects.toThrow('HTTP 503') // queued after the first: that one is over
    expect(service.list()).toEqual([expect.objectContaining({ id: pkg.id, version: '1.0.0' })])
    service.detach()
  })

  it('waits for the next update window after a recent check, and needs no network without store extensions', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const now = Date.UTC(2026, 9, 15)
    const { service, host, fetch } = await setup({ saved: { lastCheck: now - 60 * 60 * 1000, extensions: [] } })
    await service.attach(host)
    await service.attach(host) // a second window: one schedule
    await vi.advanceTimersByTimeAsync(10 * 60 * 60 * 1000)
    expect(fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1)
    expect(fetch).not.toHaveBeenCalled() // nothing to ask about
    // That check saves its time: let the write land (checks run one after another) before the folder goes.
    await service.checkUpdates()
    service.dispose()
  })
})
