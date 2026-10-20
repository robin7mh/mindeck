import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './helpers'
import { crx, field, idOf, keyPair, varintField, zip } from './extensionFixtures'
import { entryPath, extractZip, readZip } from '../../../electron/main/services/browser/extensions/zip'
import { idFromKey, parseCrx } from '../../../electron/main/services/browser/extensions/crx'
import { pickIcon, readManifest } from '../../../electron/main/services/browser/extensions/manifest'
import { compareVersions, parseUpdateResponse, storeId, updateCheckUrl } from '../../../electron/main/services/browser/extensions/webstore'
import { browserRoots, findProfiles, inProfile } from '../../../electron/main/services/browser/extensions/profiles'

const ID = 'nngceckbapebfimnlniiiahkandclblb'

async function extension(dir: string, manifest: Record<string, unknown> | string, files: Record<string, string> = {}) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true })
    await writeFile(join(dir, name), text)
  }
}

describe('extension archives (ZIP)', () => {
  it('reads stored and deflated files, skips folders, and writes them out', async () => {
    const archive = zip(
      [
        { name: 'manifest.json', data: '{"a":1}' },
        { name: 'icons/', data: '', method: 0 },
        { name: 'icons/16.png', data: Buffer.from([1, 2, 3]), method: 0 },
        { name: 'empty.txt', data: '' },
        { name: 'caf\u00e9.txt', data: 'latin', flags: 0 }
      ],
      { prefix: Buffer.from('junk before the archive') }
    )
    const entries = readZip(archive)
    expect(entries.map((e) => e.name)).toEqual(['manifest.json', 'icons/16.png', 'empty.txt', 'cafÃ©.txt'])
    expect(entries[0].data.toString()).toBe('{"a":1}')
    const dir = join(await tempDir(), 'out')
    await extractZip(archive, dir)
    expect(await readFile(join(dir, 'icons', '16.png'))).toEqual(Buffer.from([1, 2, 3]))
  })

  it('refuses what is no archive, too big, broken, encrypted or reaches outside', () => {
    expect(() => readZip(Buffer.from('not a zip at all, not even close'))).toThrow('Not a ZIP archive')
    expect(() => readZip(Buffer.alloc(10))).toThrow('Not a ZIP archive')
    expect(() => readZip(zip([{ name: 'a', data: 'x' }], { count: 0xffff }))).toThrow('ZIP64')
    expect(() => readZip(zip([{ name: 'a', data: 'x' }], { offset: 0xffffffff }))).toThrow('ZIP64')
    expect(() => readZip(zip([{ name: 'a', data: 'x' }], { offset: 1 }))).toThrow('Broken ZIP directory')
    expect(() => readZip(zip([{ name: 'a', data: 'x' }], { count: 2 }))).toThrow('Broken ZIP directory')
    expect(() => readZip(zip([{ name: 'a', data: 'x', flags: 0x801 }]))).toThrow('Encrypted')
    expect(() => readZip(zip([{ name: 'a', data: 'x', size: 600 * 1024 * 1024 }]))).toThrow('too large')
    expect(() => readZip(zip([{ name: 'a', data: 'x', method: 12 }]))).toThrow('compression (12)')
    expect(() => readZip(zip([{ name: 'a', data: 'xyz', method: 0, size: 2 }]))).toThrow('Corrupt ZIP entry')
    // a local header that is not one
    const broken = zip([{ name: 'a', data: 'x', method: 0 }])
    broken.writeUInt32LE(0, 0)
    expect(() => readZip(broken)).toThrow('Broken ZIP entry')
    // an entry cut short: the directory says 50 bytes, the data stops after 1
    const short = zip([{ name: 'a', data: 'x', method: 0 }])
    const dirAt = short.readUInt32LE(short.length - 6)
    short.writeUInt32LE(5000, dirAt + 20)
    expect(() => readZip(short)).toThrow('Truncated')
    // a local header past the end
    const far = zip([{ name: 'a', data: 'x', method: 0 }])
    far.writeUInt32LE(far.length, far.readUInt32LE(far.length - 6) + 42)
    expect(() => readZip(far)).toThrow('Broken ZIP entry')
    expect(() => readZip(zip([{ name: '../evil', data: 'x' }]))).toThrow('Unsafe path')
  })

  it('takes only paths inside the archive', () => {
    expect(entryPath('a/b/../c.js')).toBe('a/c.js')
    expect(entryPath('dir\\file.js')).toBe('dir/file.js')
    expect(entryPath('folder/')).toBeNull()
    for (const bad of ['/etc/passwd', '..', '../x', 'a/../../x', 'C:/x', 'a\0b', '.']) expect(() => entryPath(bad)).toThrow('Unsafe path')
  })
})

describe('extension packages (CRX3)', () => {
  const archive = zip([{ name: 'manifest.json', data: '{}' }])

  it('checks every signature and the developer key behind the id', () => {
    const dev = keyPair()
    // fields it doesn't know — in the header and in a proof — are skipped
    const extra = Buffer.concat([varintField(4, 300), Buffer.from([0x2d, 1, 2, 3, 4]), Buffer.from([0x29, 0, 0, 0, 0, 0, 0, 0, 0]), field(7, Buffer.from('later'))])
    const pkg = parseCrx(crx(archive, { keys: [dev, keyPair('ec')], extra, proofExtra: field(9, Buffer.from('x')) }))
    expect(pkg.id).toBe(idOf(dev.spki))
    expect(pkg.id).toBe(idFromKey(dev.spki))
    expect(pkg.id).toMatch(/^[a-p]{32}$/)
    expect(pkg.publicKey).toEqual(dev.spki)
    expect(pkg.zip).toEqual(archive)
    // ECDSA proofs (field 3) count the same
    const ec = keyPair('ec')
    expect(parseCrx(crx(archive, { keys: [ec], ecdsa: true })).id).toBe(idOf(ec.spki))
  })

  it('refuses what is not a sound, signed package', () => {
    expect(() => parseCrx(Buffer.from('PK\x03\x04 a zip'))).toThrow('Not a Chrome extension package')
    const v2 = crx(archive)
    v2.writeUInt32LE(2, 4)
    expect(() => parseCrx(v2)).toThrow('Unsupported CRX version 2')
    const long = crx(archive)
    long.writeUInt32LE(1_000_000, 8)
    expect(() => parseCrx(long)).toThrow('Broken CRX header')
    expect(() => parseCrx(crx(archive, { noSignedData: true }))).toThrow('not signed')
    expect(() => parseCrx(crx(archive, { badSignature: true }))).toThrow('does not verify')
    const notAKey = crx(archive, { keys: [{ ...keyPair(), spki: Buffer.from('garbage') }] })
    expect(() => parseCrx(notAKey)).toThrow('does not verify')
    expect(() => parseCrx(crx(archive, { idKey: Buffer.from('someone else') }))).toThrow('not signed by its developer')
    // the signed data names no id (16 bytes)
    const head = (header: Buffer) => {
      const h = Buffer.alloc(12)
      h.write('Cr24', 0, 'latin1')
      h.writeUInt32LE(3, 4)
      h.writeUInt32LE(header.length, 8)
      return Buffer.concat([h, header, archive])
    }
    expect(() => parseCrx(head(field(10000, field(1, Buffer.from('short')))))).toThrow('no id')
    expect(() => parseCrx(head(field(10000, field(2, Buffer.alloc(16)))))).toThrow('no id')
    // broken protobuf: a group wire type, a length past the end, a varint that never ends
    expect(() => parseCrx(head(Buffer.from([0x0b])))).toThrow('Broken CRX header')
    expect(() => parseCrx(head(Buffer.from([0x12, 0x7f, 0x01])))).toThrow('Broken CRX header')
    expect(() => parseCrx(head(Buffer.from([0x08, 0x80])))).toThrow('Broken CRX header')
    expect(() => parseCrx(head(Buffer.from([0x08, ...Array(9).fill(0xff), 0x01])))).toThrow('Broken CRX header')
  })
})

describe('extension manifests', () => {
  it('reads name, version, popup, icon and permissions — localized, with what Electron lacks', async () => {
    const dir = await tempDir()
    await extension(
      dir,
      '\uFEFF' +
        JSON.stringify({
          manifest_version: 3,
          name: '__MSG_extName__',
          description: '__MSG_desc__ __MSG_missing__',
          version: '2025.1.0',
          default_locale: 'en',
          key: 'KEY',
          action: { default_popup: '/popup/index.html', default_icon: { 16: 'i16.png', 32: 'i32.png', 128: 'i128.png' } },
          permissions: ['storage', 'tabs', 'alarms', 'contextMenus', 'storage', '<all_urls>', 42],
          host_permissions: ['https://*/*'],
          content_scripts: [{ matches: ['https://*/*', 'http://*/*', 7] }, { js: ['x.js'] }, null],
          update_url: 'https://clients2.google.com/service/update2/crx'
        }),
      {
        '_locales/en/messages.json': JSON.stringify({ extName: { message: 'Bitwarden' }, desc: { message: 'A password manager' }, odd: 'nope' }),
        '_locales/de/messages.json': JSON.stringify({ EXTNAME: { message: 'Bitwarden (de)' } })
      }
    )
    const info = await readManifest(dir, 'de')
    expect(info).toEqual({
      name: 'Bitwarden (de)',
      version: '2025.1.0',
      description: 'A password manager __MSG_missing__',
      key: 'KEY',
      popup: 'popup/index.html',
      icon: 'i32.png',
      permissions: ['storage', 'tabs', 'alarms', 'contextMenus', '<all_urls>', 'https://*/*', 'http://*/*'],
      unsupported: ['alarms', 'contextMenus'],
      fromStore: true
    })
  })

  it('takes Manifest V2 browser actions, page actions and plain icons — and other update servers', async () => {
    const dir = await tempDir()
    await extension(dir, { manifest_version: 2, name: 'Old', version: '1', browser_action: { default_popup: 'p.html' }, icons: { 48: 'big.png' }, update_url: 'https://edge.microsoft.com/x' })
    expect(await readManifest(dir)).toMatchObject({ popup: 'p.html', icon: 'big.png', permissions: [], unsupported: [], fromStore: false, description: '' })
    const page = await tempDir()
    await extension(page, { manifest_version: 2, name: 'Page', version: '1.2.3.4', page_action: { default_icon: 'a.png' }, permissions: 'not a list', host_permissions: {} })
    const info = await readManifest(page)
    expect(info).toMatchObject({ icon: 'a.png', permissions: [] })
    expect(info).not.toHaveProperty('popup')
    expect(info).not.toHaveProperty('key')
    const bare = await tempDir()
    await extension(bare, { manifest_version: 3, name: 'Bare', version: '1', action: { default_popup: '../outside.html' }, content_scripts: 'x' })
    const b = await readManifest(bare)
    expect(b).not.toHaveProperty('popup')
    expect(b).not.toHaveProperty('icon')
  })

  it('refuses what is no usable extension', async () => {
    const cases: [unknown, string][] = [
      ['not json', 'No readable manifest.json'],
      [[], 'not an object'],
      [null, 'not an object'],
      [{ manifest_version: 1, name: 'x', version: '1' }, 'Manifest V2 and V3'],
      [{ manifest_version: 3, name: 'x', version: '1', theme: {} }, 'Themes'],
      [{ manifest_version: 2, name: 'x', version: '1', app: {} }, 'Chrome apps'],
      [{ manifest_version: 3, name: 'x', version: 'one' }, 'no valid version'],
      [{ manifest_version: 3, name: '  ', version: '1' }, 'no name'],
      [{ manifest_version: 3, version: '1' }, 'no name']
    ]
    for (const [manifest, message] of cases) {
      const dir = await tempDir()
      await extension(dir, typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
      await expect(readManifest(dir)).rejects.toThrow(message)
    }
    await expect(readManifest(join(await tempDir(), 'missing'))).rejects.toMatchObject({ code: 'bad-extension' })
  })

  it('picks the toolbar icon near 32 px', () => {
    expect(pickIcon({ 16: 'a.png', 19: 'b.png' })).toBe('b.png')
    expect(pickIcon({ 16: 'a.png', 48: 'c.png', 32: 'b.png' })).toBe('b.png')
    expect(pickIcon({ x: 'a.png', 16: '', 24: 5 })).toBeUndefined()
    expect(pickIcon('/icon.png')).toBe('icon.png')
    expect(pickIcon('')).toBeUndefined()
    expect(pickIcon('/')).toBeUndefined()
    expect(pickIcon(7)).toBeUndefined()
    expect(pickIcon(null)).toBeUndefined()
  })
})

describe('the Chrome Web Store', () => {
  it('finds the id in store addresses, old and new, or on its own', () => {
    expect(storeId(` ${ID.toUpperCase()} `)).toBe(ID)
    expect(storeId(`https://chromewebstore.google.com/detail/bitwarden-password-manager/${ID}`)).toBe(ID)
    expect(storeId(`https://chromewebstore.google.com/detail/${ID}?hl=de`)).toBe(ID)
    expect(storeId(`https://chrome.google.com/webstore/detail/ublock/${ID}`)).toBe(ID)
    expect(storeId('https://chromewebstore.google.com/category/extensions')).toBeNull()
    expect(storeId(`http://chromewebstore.google.com/detail/x/${ID}`)).toBeNull()
    expect(storeId(`https://evil.example/detail/x/${ID}`)).toBeNull()
    expect(storeId('bitwarden')).toBeNull()
  })

  it('asks for updates the way Chrome does and reads the answer', () => {
    const url = new URL(updateCheckUrl([{ id: ID, version: '1.0' }, { id: 'b'.repeat(32), version: '0.0.0.0' }], '140.0.7339.41'))
    expect(url.origin + url.pathname).toBe('https://clients2.google.com/service/update2/crx')
    expect(url.searchParams.get('prodversion')).toBe('140.0.7339.41')
    expect(url.searchParams.get('acceptformat')).toBe('crx3')
    expect(url.searchParams.getAll('x')).toEqual([`id=${ID}&v=1.0&uc`, `id=${'b'.repeat(32)}&v=0.0.0.0&uc`])

    const xml = `<?xml version="1.0"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
      <app appid="${ID}" status="ok"><updatecheck codebase="https://x.dev/a.crx?a=1&amp;b=2" hash_sha256="ABC" status="ok" version="2.0"/></app>
      <app appid="${'b'.repeat(32)}" status="ok"><updatecheck status="noupdate"/></app>
      <app appid="${'c'.repeat(32)}" status="ok"><updatecheck codebase="https://x.dev/c.crx" status="ok" version="3"></updatecheck></app>
      <app appid="${'d'.repeat(32)}" status="error-unknownApplication"></app>
      <app status="ok"></app>
    </gupdate>`
    const releases = parseUpdateResponse(xml)
    expect(releases.get(ID)).toEqual({ version: '2.0', url: 'https://x.dev/a.crx?a=1&b=2', sha256: 'abc' })
    expect(releases.get('b'.repeat(32))).toBeNull()
    expect(releases.get('c'.repeat(32))).toEqual({ version: '3', url: 'https://x.dev/c.crx' })
    expect(releases.get('d'.repeat(32))).toBeNull()
    expect(releases.size).toBe(4)
  })

  it('compares versions like Chrome', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0', '1.0.0.0')).toBe(0)
    expect(compareVersions('2', '10')).toBeLessThan(0)
    expect(compareVersions('1.x', '1')).toBe(0)
  })
})

describe('other browsers’ profiles', () => {
  it('knows where Chrome, Brave, Edge … keep them on each system', () => {
    const mac = browserRoots('darwin', '/Users/me')
    expect(mac.find((r) => r.browser === 'chrome')!.root).toBe(join('/Users/me', 'Library', 'Application Support', 'Google', 'Chrome'))
    expect(mac.map((r) => r.browser)).toEqual(['chrome', 'brave', 'edge', 'arc', 'vivaldi', 'chromium'])
    expect(browserRoots('win32', 'C:\\Users\\me', { LOCALAPPDATA: '/local' })[0].root).toBe(join('/local', 'Google', 'Chrome', 'User Data'))
    expect(browserRoots('win32', '/home/me')[2].root).toBe(join('/home/me', 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'))
    expect(browserRoots('linux', '/home/me')[0].root).toBe(join('/home/me', '.config', 'google-chrome'))
    expect(browserRoots('linux', '/home/me', { XDG_CONFIG_HOME: '/cfg' })[1].root).toBe(join('/cfg', 'BraveSoftware', 'Brave-Browser'))
  })

  it('lists each profile’s extensions — the newest readable version, names from Local State', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Robin' }, 'Profile 2': { name: '' }, Gone: {}, Null: null } } }))
    const ext = (profile: string, id: string, version: string, manifest: Record<string, unknown>) => extension(join(root, profile, 'Extensions', id, version), manifest)
    await ext('Default', ID, '2025.1.0_0', { manifest_version: 3, name: 'Bitwarden', version: '2025.1.0' })
    await ext('Default', ID, '2024.9.0_0', { manifest_version: 3, name: 'Bitwarden old', version: '2024.9.0' })
    await ext('Default', 'a'.repeat(32), '1.0_0', { manifest_version: 3, name: 'Theme', version: '1', theme: {} })
    await ext('Default', 'b'.repeat(32), '2.0_0', { manifest_version: 3, name: 'Broken', version: 'x' })
    await ext('Default', 'b'.repeat(32), '1.0_0', { manifest_version: 3, name: 'Adblock', version: '1.0' })
    await mkdir(join(root, 'Default', 'Extensions', 'Temp'), { recursive: true })
    await mkdir(join(root, 'Default', 'Extensions', ID, 'Temp'), { recursive: true })
    await ext('Profile 2', 'c'.repeat(32), '3_0', { manifest_version: 3, name: 'Zed', version: '3' })
    await ext('Profile 7', 'd'.repeat(32), '1_0', { manifest_version: 3, name: 'Seven', version: '1' })
    await mkdir(join(root, 'System Profile'), { recursive: true })
    const plain = await tempDir() // no Local State, nothing in it

    const profiles = await findProfiles(
      [
        { browser: 'chrome', root },
        { browser: 'edge', root: plain },
        { browser: 'brave', root: join(root, 'missing') }
      ],
      new Set([ID])
    )
    expect(profiles).toEqual([
      {
        browser: 'chrome',
        name: 'Robin',
        path: join(root, 'Default'),
        extensions: [
          { id: 'b'.repeat(32), name: 'Adblock', version: '1.0', path: join(root, 'Default', 'Extensions', 'b'.repeat(32), '1.0_0'), installed: false },
          { id: ID, name: 'Bitwarden', version: '2025.1.0', path: join(root, 'Default', 'Extensions', ID, '2025.1.0_0'), installed: true }
        ]
      },
      { browser: 'chrome', name: 'Profile 2', path: join(root, 'Profile 2'), extensions: [expect.objectContaining({ name: 'Zed' })] },
      { browser: 'chrome', name: 'Profile 7', path: join(root, 'Profile 7'), extensions: [expect.objectContaining({ name: 'Seven' })] }
    ])
    // a broken Local State, or one without profiles: folder names do
    await writeFile(join(root, 'Local State'), '{')
    expect((await findProfiles([{ browser: 'chrome', root }], new Set()))[0].name).toBe('Default')
    await writeFile(join(root, 'Local State'), '{}')
    expect((await findProfiles([{ browser: 'chrome', root }], new Set()))[0].name).toBe('Default')
  })

  it('takes over only extension folders inside a known profile', () => {
    const roots = [{ browser: 'chrome' as const, root: '/Users/me/Chrome/' }]
    expect(inProfile(roots, `/Users/me/Chrome/Default/Extensions/${ID}/1.0_0`)).toBe(true)
    expect(inProfile(roots, `C:\\x\\Chrome\\Default\\Extensions\\${ID}\\1.0_0`)).toBe(false)
    expect(inProfile([{ browser: 'edge', root: 'C:\\Edge' }], `C:\\Edge\\Default\\Extensions\\${ID}\\1.0_0\\`)).toBe(true)
    expect(inProfile(roots, `/Users/me/Chrome/Default/Extensions/${ID}`)).toBe(false)
    expect(inProfile(roots, `/Users/me/Chrome/Default/Other/${ID}/1`)).toBe(false)
    expect(inProfile(roots, `/Users/me/Chrome/Default/Extensions/not-an-id/1`)).toBe(false)
    expect(inProfile(roots, `/Users/me/Chrome/../Extensions/${ID}/1`)).toBe(false)
    expect(inProfile(roots, `/Users/me/Other/Default/Extensions/${ID}/1`)).toBe(false)
  })
})
