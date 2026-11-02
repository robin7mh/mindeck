import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'
import { bakedBundleHashes, bundleSource, RELEASES, remoteBundle, remoteBundleDefines } from '../../../electron/main/services/remote/bundle'

describe('the server package', () => {
  it('found where it was downloaded before, or where `npm run remote:bundle` put it', async () => {
    const dir = await tempDir()
    const dev = await tempDir()
    const name = 'mindeck-server-1.0.0-linux-arm64.tar.gz'
    await writeFile(join(dev, name), 'dev')
    const fetch = vi.fn()
    expect(await remoteBundle('arm64', { version: '1.0.0', dir, devDir: dev, fetch })).toBe(join(dev, name))
    await writeFile(join(dir, name), 'downloaded')
    expect(await bundleSource({ version: '1.0.0', dir, devDir: dev, fetch })('arm64')).toBe(join(dir, name))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('otherwise downloaded from the release (once); a missing one says how to build it', async () => {
    const dir = join(await tempDir(), 'remote')
    const fetch = vi.fn(async () => new Response('TARBALL', { status: 200 }))
    const file = await remoteBundle('x64', { version: '2.0.0', dir, fetch })
    expect(fetch).toHaveBeenCalledWith(`${RELEASES}/v2.0.0/mindeck-server-2.0.0-linux-x64.tar.gz`)
    expect(await readFile(file, 'utf8')).toBe('TARBALL')
    const missing = vi.fn(async () => new Response('nope', { status: 404 }))
    await expect(remoteBundle('arm64', { version: '2.0.0', dir, fetch: missing })).rejects.toMatchObject({ code: 'remote-bundle', message: expect.stringContaining('HTTP 404') })
    const empty = vi.fn(async () => ({ ok: true, status: 200, body: null }) as unknown as Response)
    await expect(remoteBundle('arm64', { version: '2.0.0', dir, fetch: empty })).rejects.toMatchObject({ code: 'remote-bundle' })
  })

  it('a release checks every package against the SHA-256 it was built with — on disk and freshly downloaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = join(await tempDir(), 'remote')
    const dev = await tempDir()
    const name = 'mindeck-server-3.0.0-linux-x64.tar.gz'
    const sha = (s: string) => createHash('sha256').update(s).digest('hex')
    const sha256 = { x64: sha('GOOD'), arm64: sha('ARM') }
    const serve = (body: string) => vi.fn(async () => new Response(body, { status: 200 }))

    // Downloaded: the right one is kept; another one (a swapped release asset) is refused and not kept.
    const good = serve('GOOD')
    expect(await readFile(await remoteBundle('x64', { version: '3.0.0', dir, sha256, fetch: good }), 'utf8')).toBe('GOOD')
    await writeFile(join(dir, name), 'EVIL') // changed on disk since (e.g. by other software)
    const evil = serve('EVIL')
    await expect(remoteBundle('x64', { version: '3.0.0', dir, sha256, fetch: evil })).rejects.toMatchObject({ code: 'remote-bundle-integrity' })
    expect(warn.mock.calls[0][0]).toMatch(/does not match this release's SHA-256/)
    expect(existsSync(join(dir, name))).toBe(false)
    expect(existsSync(join(dir, `${name}.part`))).toBe(false)
    // …and fetched again in its place, now it is the right one.
    await writeFile(join(dir, name), 'EVIL')
    expect(await readFile(await remoteBundle('x64', { version: '3.0.0', dir, sha256, fetch: good }), 'utf8')).toBe('GOOD')
    expect(good).toHaveBeenCalledTimes(2)
    // A local build that isn't this release's package is passed over too.
    await writeFile(join(dev, 'mindeck-server-3.0.0-linux-arm64.tar.gz'), 'OTHER BUILD')
    const arm = serve('ARM')
    expect(await remoteBundle('arm64', { version: '3.0.0', dir, devDir: dev, sha256, fetch: arm })).toBe(join(dir, 'mindeck-server-3.0.0-linux-arm64.tar.gz'))
    await writeFile(join(dev, 'mindeck-server-3.0.0-linux-arm64.tar.gz'), 'ARM')
    await writeFile(join(dir, 'mindeck-server-3.0.0-linux-arm64.tar.gz'), 'CHANGED')
    expect(await remoteBundle('arm64', { version: '3.0.0', dir, devDir: dev, sha256, fetch: arm })).toBe(join(dev, 'mindeck-server-3.0.0-linux-arm64.tar.gz'))
    expect(arm).toHaveBeenCalledTimes(1)
  })

  it('the hashes come from the build: 64 hex digits per architecture, anything else refused or left out', () => {
    const x64 = 'a'.repeat(64)
    expect(remoteBundleDefines({})).toEqual({ __MINDECK_REMOTE_SHA256__: JSON.stringify('{}') })
    const defined = remoteBundleDefines({ MINDECK_REMOTE_SHA256_X64: ` ${x64.toUpperCase()}\n`, MINDECK_REMOTE_SHA256_ARM64: '' })
    expect(bakedBundleHashes(JSON.parse(defined.__MINDECK_REMOTE_SHA256__))).toEqual({ x64 })
    expect(() => remoteBundleDefines({ MINDECK_REMOTE_SHA256_ARM64: 'abc' })).toThrow('MINDECK_REMOTE_SHA256_ARM64 is not a SHA-256')
    expect(bakedBundleHashes()).toEqual({}) // a dev run: nothing baked in
    expect(bakedBundleHashes('not json')).toEqual({})
    expect(bakedBundleHashes(JSON.stringify({ x64: 'short', arm64: 5, riscv: x64 }))).toEqual({})
    Object.assign(globalThis, { __MINDECK_REMOTE_SHA256__: JSON.stringify({ arm64: x64 }) })
    expect(bakedBundleHashes()).toEqual({ arm64: x64 })
    delete (globalThis as Record<string, unknown>).__MINDECK_REMOTE_SHA256__
  })
})
