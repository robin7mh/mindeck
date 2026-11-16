import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'
import { desktopTrash, type TrashHost } from '../../../electron/main/platform/trash'
import { coded, nodeTrashHost } from '../../../electron/main/platform/trashHost'
import { MAC_TRASH_SCRIPT, macTrash } from '../../../electron/main/platform/trashMac'
import { parseRecycleRecord, windowsTrash } from '../../../electron/main/platform/trashWindows'

const errno = (code: string) => Object.assign(new Error(code), { code })

/** A disk in memory: path → file id (and contents); `run` answers programs. */
function fakeHost(dirname: (p: string) => string, files: Record<string, { ino: number; data?: Buffer }> = {}) {
  const disk = new Map(Object.entries(files))
  const host = {
    run: vi.fn(async (_file: string, _args: string[]): Promise<string> => ''),
    lstat: vi.fn(async (p: string) => {
      const f = disk.get(p)
      if (!f) throw errno('ENOENT')
      return { ino: f.ino }
    }),
    readdir: vi.fn(async (dir: string) => {
      const names = [...disk.keys()].filter((p) => dirname(p) === dir).map((p) => p.slice(dir.length + 1))
      if (!names.length) throw errno('ENOENT')
      return names
    }),
    readFile: vi.fn(async (p: string) => {
      const data = disk.get(p)?.data
      if (!data) throw errno('EISDIR')
      return data
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const f = disk.get(from)
      if (!f) throw errno('ENOENT')
      disk.delete(from)
      disk.set(to, f)
    }),
    rm: vi.fn(async (p: string) => {
      disk.delete(p)
    })
  } satisfies TrashHost
  return { host, disk }
}

describe('macOS: the trash call Finder uses, with a way back', () => {
  const home = '/Users/me'
  const world = (files: Record<string, { ino: number }> = { '/Users/me/a.txt': { ino: 7 } }) => {
    const { host, disk } = fakeHost(posix.dirname, files)
    const trashItem = vi.fn(async (p: string) => void disk.delete(p))
    return { host, disk, trashItem, trash: macTrash({ home, uid: 501, host, trashItem }) }
  }

  it('trashes through NSFileManager and keeps where the item went — the path an argument, never in the script', async () => {
    const { host, disk, trash, trashItem } = world()
    host.run.mockImplementation(async () => {
      disk.set('/Users/me/.Trash/a 10.23.45.txt', disk.get('/Users/me/a.txt')!)
      disk.delete('/Users/me/a.txt')
      return `${JSON.stringify({ path: '/Users/me/.Trash/a 10.23.45.txt' })}\n`
    })
    expect(await trash.trash('/Users/me/a.txt')).toBe('/Users/me/.Trash/a 10.23.45.txt')
    expect(host.run).toHaveBeenCalledWith('osascript', ['-l', 'JavaScript', '-e', MAC_TRASH_SCRIPT, '/Users/me/a.txt'])
    expect(MAC_TRASH_SCRIPT).toContain('trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0])')
    expect(trashItem).not.toHaveBeenCalled()
    // Back where it was (the name chosen by Files), and forgotten.
    await trash.restore('/Users/me/.Trash/a 10.23.45.txt', '/Users/me/a 2.txt')
    expect([...disk.keys()]).toEqual(['/Users/me/a 2.txt'])
    await expect(trash.restore('/Users/me/.Trash/a 10.23.45.txt', '/Users/me/a.txt')).rejects.toMatchObject({ code: 'trash-gone' })
  })

  it('reports what NSFileManager refused as the errors Mindeck knows', async () => {
    const { host, trash } = world()
    host.run.mockResolvedValueOnce(JSON.stringify({ error: 4, message: 'The file doesn’t exist.' }))
    await expect(trash.trash('/Users/me/a.txt')).rejects.toMatchObject({ code: 'ENOENT', message: 'The file doesn’t exist.' })
    host.run.mockResolvedValueOnce(JSON.stringify({ error: 513, message: 'No permission' }))
    await expect(trash.trash('/Users/me/a.txt')).rejects.toMatchObject({ code: 'EACCES' })
    host.run.mockResolvedValueOnce(JSON.stringify({ error: 3328, message: 'This volume has no trash' }))
    await expect(trash.trash('/Users/me/a.txt')).rejects.toMatchObject({ code: 'trash-failed', message: 'This volume has no trash' })
    // Gone before it could be trashed.
    await expect(trash.trash('/Users/me/missing.txt')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('without osascript (or an answer) uses the plain OS trash — no undo, and never twice', async () => {
    const { host, disk, trash, trashItem } = world()
    host.run.mockRejectedValueOnce(errno('ENOENT'))
    expect(await trash.trash('/Users/me/a.txt')).toBeUndefined()
    expect(trashItem).toHaveBeenCalledWith('/Users/me/a.txt')
    // The script got as far as trashing, but its answer is unreadable.
    disk.set('/Users/me/b.txt', { ino: 8 })
    host.run.mockImplementationOnce(async () => {
      disk.delete('/Users/me/b.txt')
      return 'garbage'
    })
    expect(await trash.trash('/Users/me/b.txt')).toBeUndefined()
    expect(trashItem).toHaveBeenCalledTimes(1)
  })

  it('takes back only from this user’s trashes, and only what it put there', async () => {
    const { host, trash } = world({ '/Users/me/.Trash/x': { ino: 1 }, '/Volumes/USB/.Trashes/501/y': { ino: 2 }, '/Users/me/a.txt': { ino: 3 } })
    for (const bad of ['/Users/me/a.txt', '/Users/me/.Trash/../a.txt', '/Volumes/USB/.Trashes/502/y', '/Volumes/USB/x/.Trashes/501/y', '/Users/me/.Trash/sub/z']) {
      await expect(trash.restore(bad, '/Users/me/q')).rejects.toMatchObject({ code: 'bad-path' })
    }
    // Put there before Mindeck knew it (an earlier run): taken by its place alone.
    await trash.restore('/Volumes/USB/.Trashes/501/y', '/Volumes/USB/y')
    expect(host.rename).toHaveBeenCalledWith('/Volumes/USB/.Trashes/501/y', '/Volumes/USB/y')
    // Another item under the name Mindeck's went by (emptied, then trashed again in Finder): not that one.
    host.run.mockResolvedValueOnce(JSON.stringify({ path: '/Users/me/.Trash/x' }))
    await trash.trash('/Users/me/a.txt')
    await expect(trash.restore('/Users/me/.Trash/x', '/Users/me/a.txt')).rejects.toMatchObject({ code: 'trash-gone' })
  })

  it('says when macOS wants Full Disk Access for the trash, instead of failing quietly', async () => {
    const { host, trash } = world({ '/Users/me/.Trash/x': { ino: 1 }, '/Volumes/USB/.Trashes/501/y': { ino: 2 } })
    host.lstat.mockRejectedValueOnce(errno('EPERM'))
    await expect(trash.restore('/Users/me/.Trash/x', '/Users/me/x')).rejects.toMatchObject({ code: 'full-disk-access', message: expect.stringContaining('Full Disk Access') })
    host.rename.mockRejectedValueOnce(errno('EPERM'))
    await expect(trash.restore('/Users/me/.Trash/x', '/Users/me/x')).rejects.toMatchObject({ code: 'full-disk-access' })
    // Other disks are not behind that switch; other errors are passed on.
    host.lstat.mockRejectedValueOnce(errno('EPERM'))
    await expect(trash.restore('/Volumes/USB/.Trashes/501/y', '/Volumes/USB/y')).rejects.toMatchObject({ code: 'EPERM' })
    host.rename.mockRejectedValueOnce(errno('ENOTDIR'))
    await expect(trash.restore('/Users/me/.Trash/x', '/Users/me/gone/x')).rejects.toMatchObject({ code: 'trash-gone' })
  })

  it('is the desktop trash on macOS — for this process’s user unless told otherwise', async () => {
    const { host } = fakeHost(posix.dirname, { [`/Volumes/D/.Trashes/${userInfo().uid}/f`]: { ino: 1 }, '/Volumes/D/.Trashes/9/f': { ino: 1 } })
    const trashItem = vi.fn(async () => {})
    const mine = desktopTrash({ platform: 'darwin', env: {}, home, trashItem, host })!
    await mine.restore(`/Volumes/D/.Trashes/${userInfo().uid}/f`, '/Volumes/D/f')
    const other = desktopTrash({ platform: 'darwin', env: {}, home, trashItem, host, uid: 9 })!
    await other.restore('/Volumes/D/.Trashes/9/f', '/Volumes/D/g')
    expect(host.rename).toHaveBeenCalledTimes(2)
  })
})

/** A `$I` record as Windows 10+ writes it (version 2), or Vista–8.1 (version 1). */
function record(path: string, deletedMs: number, version: 1 | 2 = 2): Buffer {
  const name = Buffer.from(`${path}\0`, 'utf16le')
  const head = Buffer.alloc(version === 2 ? 28 : 24)
  head.writeBigUInt64LE(BigInt(version), 0)
  head.writeBigUInt64LE(123n, 8)
  head.writeBigUInt64LE(BigInt(deletedMs + 11_644_473_600_000) * 10_000n, 16)
  if (version === 2) {
    head.writeUInt32LE(name.length / 2, 24)
    return Buffer.concat([head, name])
  }
  return Buffer.concat([head, name, Buffer.alloc(520 - name.length)])
}

describe('Windows: the Recycle Bin, found again by its $I records', () => {
  const SID = 'S-1-5-21-111-222-333-1001'
  const bin = `C:\\$Recycle.Bin\\${SID}`
  const T = 1_800_000_000_000

  it('reads both record versions and nothing else', () => {
    expect(parseRecycleRecord(record('C:\\Users\\me\\ä.txt', T))).toEqual({ path: 'C:\\Users\\me\\ä.txt', deletedMs: T })
    expect(parseRecycleRecord(record('D:\\x', T, 1))).toEqual({ path: 'D:\\x', deletedMs: T })
    expect(parseRecycleRecord(Buffer.alloc(10))).toBeNull()
    const v3 = record('C:\\x', T)
    v3.writeBigUInt64LE(3n, 0)
    expect(parseRecycleRecord(v3)).toBeNull()
    expect(parseRecycleRecord(record('', T))).toBeNull()
  })

  const world = (files: Record<string, { ino: number; data?: Buffer }>) => {
    const { host, disk } = fakeHost(win32.dirname, { 'C:\\Users\\me\\a.txt': { ino: 42 }, ...files })
    host.run.mockResolvedValue(`"desktop-1\\me","${SID}"\r\n`)
    const trashItem = vi.fn(async (p: string) => {
      disk.delete(p)
    })
    const trash = windowsTrash({ host, trashItem, now: () => T })
    return { host, disk, trashItem, trash }
  }

  it('finds the newest record of the path whose item is still the one trashed, and puts it back like Explorer', async () => {
    const { host, disk, trash, trashItem } = world({
      [`${bin}\\desktop.ini`]: { ino: 1, data: Buffer.from('x') },
      [`${bin}\\$IOLD001.txt`]: { ino: 2, data: record('C:\\Users\\me\\a.txt', T - 60_000) },
      [`${bin}\\$ROLD001.txt`]: { ino: 42 },
      [`${bin}\\$IOTHER1.txt`]: { ino: 3, data: record('C:\\Users\\me\\b.txt', T + 10) },
      [`${bin}\\$IBROKEN.txt`]: { ino: 4 },
      [`${bin}\\$INOITEM.txt`]: { ino: 5, data: record('C:\\Users\\me\\a.txt', T + 30) },
      [`${bin}\\$IWRONG1.txt`]: { ino: 6, data: record('c:\\users\\ME\\A.TXT', T + 40) },
      [`${bin}\\$RWRONG1.txt`]: { ino: 99 },
      [`${bin}\\$IABC123.txt`]: { ino: 7, data: record('C:\\Users\\me\\a.txt', T + 20) },
      [`${bin}\\$RABC123.txt`]: { ino: 42 },
      [`${bin}\\$IDEF456.txt`]: { ino: 8, data: record('C:\\Users\\me\\a.txt', T + 50) },
      [`${bin}\\$RDEF456.txt`]: { ino: 42 },
      [`${bin}\\$ILATE01.txt`]: { ino: 9, data: record('C:\\Users\\me\\a.txt', T + 45) },
      [`${bin}\\$RLATE01.txt`]: { ino: 42 }
    })
    expect(await trash.trash('C:\\Users\\me\\a.txt')).toBe(`${bin}\\$RDEF456.txt`)
    expect(trashItem).toHaveBeenCalledWith('C:\\Users\\me\\a.txt')
    expect(host.run).toHaveBeenCalledWith('whoami', ['/user', '/fo', 'csv', '/nh'])
    await trash.restore(`${bin}\\$RDEF456.txt`, 'C:\\Users\\me\\a 2.txt')
    expect(disk.get('C:\\Users\\me\\a 2.txt')).toEqual({ ino: 42 })
    expect(disk.has(`${bin}\\$IDEF456.txt`)).toBe(false)
    // Who is signed in is asked once; records older than an earlier trash are not read again.
    disk.set('C:\\Users\\me\\c.txt', { ino: 0 })
    host.readFile.mockClear()
    disk.delete(`${bin}\\$IOLD001.txt`)
    disk.set(`${bin}\\$IOLD001.txt`, { ino: 2, data: record('C:\\Users\\me\\c.txt', T + 1000) })
    disk.set(`${bin}\\$ROLD001.txt`, { ino: 77 })
    expect(await trash.trash('C:\\Users\\me\\c.txt')).toBeUndefined()
    expect(host.readFile).not.toHaveBeenCalledWith(`${bin}\\$IOLD001.txt`)
    // Once that name left the bin, it is read again when it comes back (a FAT drive: no file ids to compare).
    disk.delete(`${bin}\\$IOLD001.txt`)
    disk.set('C:\\Users\\me\\c.txt', { ino: 0 })
    await trash.trash('C:\\Users\\me\\c.txt')
    disk.set(`${bin}\\$IOLD001.txt`, { ino: 2, data: record('C:\\Users\\me\\c.txt', T + 1000) })
    disk.set('C:\\Users\\me\\c.txt', { ino: 0 })
    expect(await trash.trash('C:\\Users\\me\\c.txt')).toBe(`${bin}\\$ROLD001.txt`)
    await trash.restore(`${bin}\\$ROLD001.txt`, 'C:\\Users\\me\\c.txt')
    expect(host.run).toHaveBeenCalledTimes(1)
  })

  it('offers no way back where nothing is found: shares, no records, nobody signed in', async () => {
    const { host, disk, trash, trashItem } = world({})
    disk.set('\\\\server\\share\\x.txt', { ino: 1 })
    expect(await trash.trash('\\\\server\\share\\x.txt')).toBeUndefined()
    expect(trashItem).toHaveBeenCalledWith('\\\\server\\share\\x.txt')
    expect(host.run).not.toHaveBeenCalled()
    host.run.mockResolvedValueOnce('ERROR: no user')
    disk.set('D:\\b.txt', { ino: 2 })
    expect(await trash.trash('D:\\b.txt')).toBeUndefined()
    // No Recycle Bin on this drive (a removable one): nothing to read.
    expect(await trash.trash('C:\\Users\\me\\a.txt')).toBeUndefined()
    expect(host.run).toHaveBeenCalledTimes(2)
    // The OS trash failing is an error as before.
    await expect(trash.trash('C:\\Users\\me\\missing.txt')).rejects.toMatchObject({ code: 'ENOENT' })
    trashItem.mockRejectedValueOnce(errno('EBUSY'))
    disk.set('D:\\c.txt', { ino: 3 })
    await expect(trash.trash('D:\\c.txt')).rejects.toMatchObject({ code: 'EBUSY' })
  })

  it('takes back only items of a Recycle Bin, and only the one it put there', async () => {
    const { host, disk, trash } = world({
      [`${bin}\\$IABC123.txt`]: { ino: 7, data: record('C:\\Users\\me\\a.txt', T + 20) },
      [`${bin}\\$RABC123.txt`]: { ino: 42 },
      [`D:\\$RECYCLE.BIN\\${SID}\\$RX.txt`]: { ino: 5 }
    })
    for (const bad of ['C:\\Users\\me\\a.txt', `${bin}\\$IABC123.txt`, `C:\\$Recycle.Bin\\me\\$RABC123.txt`, `C:\\Trash\\${SID}\\$RABC123.txt`, `C:\\x\\$Recycle.Bin\\${SID}\\$RA.txt`, `${bin}\\$RABC123.txt\\inner`]) {
      await expect(trash.restore(bad, 'C:\\Users\\me\\a.txt')).rejects.toMatchObject({ code: 'bad-path' })
    }
    // Known by its place alone (an earlier run); the record may already be gone.
    host.rm.mockRejectedValueOnce(errno('EPERM'))
    await trash.restore(`D:\\$RECYCLE.BIN\\${SID}\\$RX.txt`, 'D:\\x.txt')
    expect(disk.get('D:\\x.txt')).toEqual({ ino: 5 })
    // Emptied since, or emptied and refilled under the same name.
    await expect(trash.restore(`D:\\$RECYCLE.BIN\\${SID}\\$RX.txt`, 'D:\\x.txt')).rejects.toMatchObject({ code: 'trash-gone' })
    expect(await trash.trash('C:\\Users\\me\\a.txt')).toBe(`${bin}\\$RABC123.txt`)
    disk.set(`${bin}\\$RABC123.txt`, { ino: 43 })
    await expect(trash.restore(`${bin}\\$RABC123.txt`, 'C:\\Users\\me\\a.txt')).rejects.toMatchObject({ code: 'trash-gone' })
    host.lstat.mockRejectedValueOnce(errno('ENOTDIR'))
    await expect(trash.restore(`${bin}\\$RABC123.txt`, 'C:\\Users\\me\\a.txt')).rejects.toMatchObject({ code: 'trash-gone' })
    host.lstat.mockRejectedValueOnce(errno('EACCES'))
    await expect(trash.restore(`${bin}\\$RABC123.txt`, 'C:\\Users\\me\\a.txt')).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('is the desktop trash on Windows', async () => {
    const { host } = fakeHost(win32.dirname, { [`${bin}\\$RZ`]: { ino: 1 } })
    const t = desktopTrash({ platform: 'win32', env: {}, home: 'C:\\Users\\me', trashItem: vi.fn(), host })!
    await t.restore(`${bin}\\$RZ`, 'C:\\z')
    expect(host.rename).toHaveBeenCalledWith(`${bin}\\$RZ`, 'C:\\z')
  })
})

describe('the real machine behind the OS trashes', () => {
  it('runs programs without a shell and touches files', async () => {
    expect(await nodeTrashHost.run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(echo hi); "x"'])).toBe('$(echo hi); "x"')
    const dir = await tempDir()
    await mkdir(join(dir, 'd'))
    await writeFile(join(dir, 'd', 'f'), 'data')
    expect((await nodeTrashHost.lstat(join(dir, 'd', 'f'))).ino).toBeGreaterThan(0)
    expect(await nodeTrashHost.readdir(join(dir, 'd'))).toEqual(['f'])
    expect((await nodeTrashHost.readFile(join(dir, 'd', 'f'))).toString()).toBe('data')
    await nodeTrashHost.rename(join(dir, 'd', 'f'), join(dir, 'g'))
    await nodeTrashHost.rm(join(dir, 'g'))
    await nodeTrashHost.rm(join(dir, 'missing'))
    expect(await readdir(dir)).toEqual(['d'])
    await expect(readFile(join(dir, 'g'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(coded('x', 'y')).toMatchObject({ code: 'x', message: 'y' })
  })
})
