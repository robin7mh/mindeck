import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './helpers'
import { RemoteAccess, type RemoteAccessDeps } from '../../../electron/main/server/RemoteAccess'

/**
 * Files on the core's machine for a paired device with remote shells: a home
 * with documents, keys, hidden and system folders, Mindeck's data, a drive
 * and the trash. Paths are canonical up front (macOS keeps temp folders
 * behind /var → /private/var).
 */
async function machine(over: Partial<RemoteAccessDeps> = {}) {
  const root = await realpath(await tempDir())
  const home = join(root, 'home')
  const drive = join(root, 'drives', 'USB')
  const data = join(home, 'Mindeck', 'data')
  const bin = join(home, '.Trash')
  for (const d of [join(home, 'Documents', 'Plans'), join(home, '.config'), join(home, '.ssh'), join(home, 'Library', 'Mail'), data, drive, bin, join(root, 'sys', 'etc')]) {
    await mkdir(d, { recursive: true })
  }
  await writeFile(join(home, 'Documents', 'report.pdf'), 'x')
  await writeFile(join(home, '.ssh', 'id_rsa'), 'secret')
  await writeFile(join(bin, 'old.txt'), 'x')
  await writeFile(join(bin, 'id_ed25519'), 'secret')
  const access = new RemoteAccess({
    roots: () => [],
    projects: () => [],
    remoteShell: () => true,
    dirs: async () => ({ path: '', parent: null, home, dirs: [] }),
    protectedDirs: [data],
    home,
    systemDirs: [join(root, 'sys', 'etc')],
    fileRoots: [home, join(root, 'drives')],
    trashDirs: [bin],
    platform: 'linux',
    ...over
  })
  const why = async (path: string) => (await access.reachable(path).then(() => 'ok', (e: Error & { code?: string }) => `${e.code}: ${e.message}`))
  return { access, root, home, drive, data, bin, why }
}

describe('RemoteAccess · Files for a device with remote shells', () => {
  it('reaches Home and the drives — folders, files and names still to be made', async () => {
    const m = await machine()
    expect(await m.access.reachable(m.home)).toBe(m.home)
    expect(await m.access.reachable(join(m.home, 'Documents', 'report.pdf'))).toBe(join(m.home, 'Documents', 'report.pdf'))
    expect(await m.access.reachable(join(m.home, 'Documents', 'new-upload.jpg'))).toBe(join(m.home, 'Documents', 'new-upload.jpg'))
    expect(await m.access.reachable(join(m.drive, 'photos'))).toBe(join(m.drive, 'photos'))
    // Under a folder that is not there either: judged as written.
    expect(await m.why(join(m.home, 'Nope', 'deeper', 'file.txt'))).toBe('ok')
  })

  it('never: outside Home and drives, system folders, Mindeck data, hidden folders, keys', async () => {
    const m = await machine()
    expect(await m.why(m.root)).toContain('outside the home folder and drives')
    expect(await m.why(join(m.root, 'sys', 'etc'))).toContain('outside the home folder')
    expect(await m.why(join(m.home, 'Library', 'Mail'))).toContain('a system folder')
    expect(await m.why(join(m.data, 'devices.json'))).toContain("Mindeck's own data")
    expect(await m.why(join(m.home, '.config'))).toContain('a hidden folder')
    expect(await m.why(join(m.home, '.ssh', 'id_rsa'))).toContain('a hidden folder')
    expect(await m.why(join(m.home, 'Documents', 'server.pem'))).toContain('keys or credentials')
    expect(await m.why('relative/path')).toBe('bad-path: Path must be absolute')
  })

  it('judges what a path really is: a link out of Home or into a hidden folder is refused', async () => {
    const m = await machine()
    await symlink(join(m.home, '.ssh'), join(m.home, 'Documents', 'keys'))
    await symlink(join(m.root, 'sys', 'etc'), join(m.home, 'Documents', 'etc'))
    await writeFile(join(m.home, '.ssh', 'config'), 'Host *')
    expect(await m.why(join(m.home, 'Documents', 'keys', 'config'))).toContain('a hidden folder')
    expect(await m.why(join(m.home, 'Documents', 'etc'))).toContain('outside the home folder')
  })

  it('a system folder inside a reachable root is still off-limits', async () => {
    const m = await machine({ fileRoots: undefined })
    const wide = await machine()
    const access = new RemoteAccess({
      roots: () => [],
      projects: () => [],
      remoteShell: () => true,
      dirs: async () => ({ path: '', parent: null, home: wide.home, dirs: [] }),
      protectedDirs: [],
      home: wide.home,
      systemDirs: [join(wide.root, 'sys', 'etc')],
      fileRoots: [wide.root],
      platform: 'linux'
    })
    await expect(access.reachable(join(wide.root, 'sys', 'etc'))).rejects.toMatchObject({ code: 'remote-forbidden', message: expect.stringContaining('a system folder') })
    // Without its own roots a device reaches Home (and the platform's drives).
    expect(await m.access.reachable(join(m.home, 'Documents'))).toBe(join(m.home, 'Documents'))
  })

  it('checks every path a Files call names — and keeps hidden files on the desktop', async () => {
    const m = await machine()
    const doc = join(m.home, 'Documents')
    await expect(m.access.check('finder:list', { hidden: true })).rejects.toMatchObject({ code: 'remote-forbidden', message: 'Hidden files stay on the desktop' })
    await m.access.check('finder:list', {})
    await m.access.check('finder:list', { path: doc })
    await m.access.check('finder:mkdir', { parent: doc, name: 'New' })
    await m.access.check('finder:transfer', { id: 't', paths: [join(doc, 'report.pdf')], dest: m.drive, mode: 'copy' })
    await m.access.check('finder:restore', { moves: [{ from: join(m.drive, 'report.pdf'), to: join(doc, 'report.pdf') }] })
    await expect(m.access.check('finder:copy', { paths: [join(m.home, '.ssh', 'id_rsa')], dest: doc })).rejects.toMatchObject({ code: 'remote-forbidden' })
    await expect(m.access.check('finder:move', { paths: [join(doc, 'report.pdf')], dest: join(m.home, '.config') })).rejects.toMatchObject({ code: 'remote-forbidden' })
    await expect(m.access.check('finder:mkdir', { parent: m.data, name: 'x' })).rejects.toMatchObject({ code: 'remote-forbidden' })
    await expect(m.access.check('finder:restore', { moves: [{ from: doc, to: join(m.root, 'elsewhere') }] })).rejects.toMatchObject({ code: 'remote-forbidden' })
    await expect(m.access.check('finder:read', { path: join(m.home, '.ssh', 'id_rsa') })).rejects.toMatchObject({ code: 'remote-forbidden' })
  })

  it('a new name is judged where it will be: no hidden files, keys or credentials by renaming or a new folder', async () => {
    const m = await machine()
    const doc = join(m.home, 'Documents')
    await m.access.check('finder:rename', { path: join(doc, 'report.pdf'), name: 'final.pdf' })
    await expect(m.access.check('finder:rename', { path: join(m.home, 'upload.txt'), name: '.zshenv' })).rejects.toMatchObject({ code: 'remote-forbidden', message: expect.stringContaining('a hidden folder') })
    await expect(m.access.check('finder:rename', { path: join(doc, 'report.pdf'), name: 'id_rsa' })).rejects.toMatchObject({ code: 'remote-forbidden', message: expect.stringContaining('keys or credentials') })
    await expect(m.access.check('finder:mkdir', { parent: doc, name: '.git' })).rejects.toMatchObject({ code: 'remote-forbidden' })
    await expect(m.access.check('finder:mkdir', { parent: m.home, name: '.ssh' })).rejects.toMatchObject({ code: 'remote-forbidden' })
  })

  it('shows a search hit only where a device may go', async () => {
    const m = await machine()
    expect(await m.access.shows(join(m.home, 'Documents', 'report.pdf'))).toBe(true)
    for (const path of [join(m.home, 'Library', 'Mail', 'x.emlx'), join(m.data, 'devices.json'), join(m.home, '.config', 'gh', 'hosts.yml'), join(m.root, 'sys', 'etc', 'passwd'), join(m.home, 'server.pem'), 'relative']) {
      expect(await m.access.shows(path)).toBe(false)
    }
  })

  it('an undo of the trash takes things back from the trash only — never keys', async () => {
    const m = await machine()
    const back = join(m.home, 'Documents', 'old.txt')
    await m.access.check('finder:untrash', { items: [{ path: back, restore: join(m.bin, 'old.txt') }] })
    // A key "restored" out of ~/.ssh would hand it over: refused.
    await expect(m.access.check('finder:untrash', { items: [{ path: back, restore: join(m.home, '.ssh', 'id_rsa') }] })).rejects.toMatchObject({ code: 'remote-forbidden', message: expect.stringContaining('Only things in the trash') })
    await expect(m.access.check('finder:untrash', { items: [{ path: back, restore: m.bin }] })).rejects.toMatchObject({ code: 'remote-forbidden' })
    await expect(m.access.check('finder:untrash', { items: [{ path: back, restore: join(m.bin, 'id_ed25519') }] })).rejects.toMatchObject({ code: 'remote-forbidden', message: expect.stringContaining('id_ed25519') })
    await expect(m.access.check('finder:untrash', { items: [{ path: back, restore: 'trash/old.txt' }] })).rejects.toMatchObject({ code: 'bad-path' })
    // Gone from the trash meanwhile: judged as written.
    await m.access.check('finder:untrash', { items: [{ path: back, restore: join(m.bin, 'vanished.txt') }] })
  })

  it('knows each platform’s drives and trash', async () => {
    const home = '/home/ada'
    const deps = { roots: () => [], projects: () => [], remoteShell: () => true, dirs: async () => ({ path: '', parent: null, home, dirs: [] }), protectedDirs: [], home }
    const mac = new RemoteAccess({ ...deps, home: '/Users/ada', platform: 'darwin' })
    expect(await mac.reachable('/Volumes/USB/photo.jpg')).toBe('/Volumes/USB/photo.jpg')
    await mac.check('finder:untrash', { items: [{ path: '/Users/ada/Desktop/a.txt', restore: '/Users/ada/.Trash/a.txt' }] })
    const linux = new RemoteAccess({ ...deps, platform: 'linux' })
    expect(await linux.reachable('/media/ada/USB/a.txt')).toBe('/media/ada/USB/a.txt')
    expect(await linux.reachable('/mnt/disk/a.txt')).toBe('/mnt/disk/a.txt')
    await linux.check('finder:untrash', { items: [{ path: '/home/ada/a.txt', restore: '/home/ada/.local/share/Trash/files/a.txt' }] })
    const win = new RemoteAccess({ ...deps, home: 'C:\\Users\\ada', platform: 'win32', systemDirs: [] })
    expect(await win.reachable('C:\\Users\\ada\\Documents\\a.txt')).toBe('C:\\Users\\ada\\Documents\\a.txt')
    await expect(win.reachable('\\\\server\\share\\a.txt')).rejects.toMatchObject({ code: 'remote-forbidden', message: expect.stringContaining('Network') })
    await expect(win.reachable('D:\\data\\a.txt')).rejects.toMatchObject({ code: 'remote-forbidden', message: expect.stringContaining('outside') })
    await expect(win.check('finder:untrash', { items: [{ path: 'C:\\Users\\ada\\a.txt', restore: 'C:\\$Recycle.Bin\\a.txt' }] })).rejects.toMatchObject({ code: 'remote-forbidden' })
  })
})
