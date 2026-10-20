import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, readlink, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZipFile } from 'yazl'
import { tempDir } from './helpers'

// Pass-through fs with one-shot failures (a real disk sometimes says no).
const fsFail = vi.hoisted(() => ({
  rename: null as null | NodeJS.ErrnoException,
  readdir: null as null | NodeJS.ErrnoException,
  readlink: null as null | NodeJS.ErrnoException,
  unlink: null as null | NodeJS.ErrnoException,
  statfs: null as null | { bavail: number; bsize: number },
  readStream: null as null | string,
  writeStream: null as null | string
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const once = <T extends (...a: never[]) => unknown>(key: 'rename' | 'readdir' | 'readlink' | 'unlink', fn: T) =>
    ((...args: Parameters<T>) => {
      const err = fsFail[key]
      if (err) {
        fsFail[key] = null
        return Promise.reject(err)
      }
      return fn(...args)
    }) as T
  return {
    ...real,
    rename: once('rename', real.rename),
    readdir: once('readdir', real.readdir),
    readlink: once('readlink', real.readlink),
    unlink: once('unlink', real.unlink),
    statfs: (async (p: string) => fsFail.statfs ?? real.statfs(p)) as typeof real.statfs
  }
})
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    createReadStream: ((path: string, ...rest: unknown[]) => {
      const s = (real.createReadStream as (...a: unknown[]) => ReturnType<typeof real.createReadStream>)(path, ...rest)
      if (fsFail.readStream && String(path).endsWith(fsFail.readStream)) {
        fsFail.readStream = null
        s.destroy(Object.assign(new Error('EIO: read failed'), { code: 'EIO' }))
      }
      return s
    }) as typeof real.createReadStream,
    createWriteStream: ((path: string, ...rest: unknown[]) => {
      const s = (real.createWriteStream as (...a: unknown[]) => ReturnType<typeof real.createWriteStream>)(path, ...rest)
      if (fsFail.writeStream && String(path).includes(fsFail.writeStream)) {
        fsFail.writeStream = null
        s.destroy(Object.assign(new Error('ENOSPC: disk full'), { code: 'ENOSPC' }))
      }
      return s
    }) as typeof real.createWriteStream
  }
})

import { FinderService } from '../../../electron/main/services/finder/FinderService'
import { Cancelled, copyTree, Job, measure } from '../../../electron/main/services/finder/transfer'
import { archiveKind, MAX_TAR_META, safeTarget } from '../../../electron/main/services/finder/archive'
import { desktopTrash, freedesktopTrash } from '../../../electron/main/platform/trash'
import { fileClipboard, pathsToPlist, plistToPaths, raw, urisToPaths } from '../../../electron/main/platform/fileClipboard'
import type { FinderProgress } from '@shared/types/finder'

const errno = (code: string) => Object.assign(new Error(code), { code })
afterEach(() => {
  for (const k of Object.keys(fsFail) as (keyof typeof fsFail)[]) fsFail[k] = null
})

async function world(extra: Partial<ConstructorParameters<typeof FinderService>[0]> = {}) {
  const home = await tempDir('mindeck-ops-')
  for (const d of ['A', 'B', 'A/Sub']) await mkdir(join(home, d), { recursive: true })
  await writeFile(join(home, 'A', 'one.txt'), 'one')
  await writeFile(join(home, 'A', 'two.txt'), 'two!')
  await writeFile(join(home, 'A', 'Sub', 'deep.txt'), 'deep')
  const events: FinderProgress[] = []
  const trash = vi.fn(async (p: string) => rm(p, { recursive: true }))
  const finder = new FinderService({ home, writableRoots: [home], trash, progress: (p) => events.push(p), ...extra })
  return { home, finder, trash, events }
}

describe('transfers: copy and move with choices and progress', () => {
  it('lists the names that are taken — not for the folder itself', async () => {
    const { finder, home } = await world()
    await writeFile(join(home, 'B', 'one.txt'), 'old')
    expect(await finder.conflicts([join(home, 'A', 'one.txt'), join(home, 'A', 'two.txt'), join(home, 'B', 'one.txt')], join(home, 'B'))).toEqual(['one.txt'])
  })

  it('copies with progress, keeping both, skipping or replacing (the old one to the trash)', async () => {
    const { finder, home, trash, events } = await world()
    for (const n of ['one.txt', 'two.txt', 'Sub']) await writeFile(join(home, 'B', n), 'old')
    const res = await finder.transfer({
      id: 'c1',
      mode: 'copy',
      dest: join(home, 'B'),
      paths: [join(home, 'A', 'one.txt'), join(home, 'A', 'two.txt'), join(home, 'A', 'Sub')],
      choices: { 'one.txt': 'keep', 'two.txt': 'skip', Sub: 'replace' }
    })
    expect(res).toEqual({
      items: [
        { from: join(home, 'A', 'one.txt'), to: join(home, 'B', 'one 2.txt') },
        { from: join(home, 'A', 'Sub'), to: join(home, 'B', 'Sub') }
      ],
      replaced: [{ path: join(home, 'B', 'Sub') }],
      skipped: [join(home, 'A', 'two.txt')]
    })
    expect(trash).toHaveBeenCalledWith(join(home, 'B', 'Sub'))
    expect(await readFile(join(home, 'B', 'Sub', 'deep.txt'), 'utf8')).toBe('deep')
    expect(events.at(-1)).toMatchObject({ id: 'c1', kind: 'copy', finished: true, total: 11 })
    // Copying into the same folder duplicates; an unlisted conflict keeps both.
    const dup = await finder.transfer({ id: 'c2', mode: 'copy', dest: join(home, 'A'), paths: [join(home, 'A', 'one.txt')] })
    expect(dup.items[0].to).toBe(join(home, 'A', 'one 2.txt'))
    await expect(finder.transfer({ id: 'c3', mode: 'copy', dest: join(home, 'A', 'Sub'), paths: [join(home, 'A')] })).rejects.toMatchObject({ code: 'bad-move' })
  })

  it('moves: renames on one disk, nothing for the same folder, refuses to replace its own folder', async () => {
    const { finder, home } = await world()
    await mkdir(join(home, 'B', 'x', 'x'), { recursive: true })
    const res = await finder.transfer({ id: 'm1', mode: 'move', dest: join(home, 'B'), paths: [join(home, 'A', 'one.txt'), join(home, 'B', 'x')] })
    expect(res.items).toEqual([{ from: join(home, 'A', 'one.txt'), to: join(home, 'B', 'one.txt') }])
    expect(existsSync(join(home, 'A', 'one.txt'))).toBe(false)
    await mkdir(join(home, 'C', 'C'), { recursive: true })
    await expect(finder.transfer({ id: 'm3', mode: 'move', dest: home, paths: [join(home, 'C', 'C')], choices: { C: 'replace' } })).rejects.toMatchObject({ code: 'bad-move' })
  })

  it('stops when cancelled — keeping what was done, removing the half-done copy', async () => {
    let finder!: FinderService
    const w = await world({ progress: (p) => p.id === 'stop' && !p.finished && finder.cancel('stop') })
    finder = w.finder
    const res = await finder.transfer({ id: 'stop', mode: 'copy', dest: join(w.home, 'B'), paths: [join(w.home, 'A', 'one.txt'), join(w.home, 'A', 'two.txt')] })
    expect(res).toMatchObject({ cancelled: true, items: [{ to: join(w.home, 'B', 'one.txt') }] })
    finder.cancel('not-running')
    // A big file streams; the copy stops in the middle and leaves nothing behind.
    await writeFile(join(w.home, 'A', 'big.bin'), '')
    await truncate(join(w.home, 'A', 'big.bin'), 40 * 1024 * 1024)
    const big = await finder.transfer({ id: 'stop', mode: 'copy', dest: join(w.home, 'B'), paths: [join(w.home, 'A', 'big.bin')] })
    expect(big).toMatchObject({ cancelled: true, items: [] })
    expect(existsSync(join(w.home, 'B', 'big.bin'))).toBe(false)
  })

  it('moves to another disk by copying, and reports other errors', async () => {
    const { finder, home } = await world()
    fsFail.rename = errno('EXDEV')
    const res = await finder.transfer({ id: 'x', mode: 'move', dest: join(home, 'B'), paths: [join(home, 'A', 'Sub')] })
    expect(res.items[0].to).toBe(join(home, 'B', 'Sub'))
    expect(existsSync(join(home, 'A', 'Sub'))).toBe(false)
    fsFail.rename = errno('EBUSY')
    await expect(finder.transfer({ id: 'y', mode: 'move', dest: join(home, 'A'), paths: [join(home, 'B', 'Sub')] })).rejects.toThrow('EBUSY')
  })

  it('a failing copy leaves no half-copy', async () => {
    const { finder, home } = await world()
    await symlink('deep.txt', join(home, 'A', 'Sub', 'link'))
    fsFail.readlink = errno('EIO')
    await expect(finder.transfer({ id: 'f', mode: 'copy', dest: join(home, 'B'), paths: [join(home, 'A', 'Sub')] })).rejects.toThrow('EIO')
    expect(existsSync(join(home, 'B', 'Sub'))).toBe(false)
  })
})

describe('transfer helpers', () => {
  it('measures trees (links not followed, unreadable folders and vanished paths skipped)', async () => {
    const { home } = await world()
    await symlink(join(home, 'A'), join(home, 'link'))
    expect(await measure([join(home, 'A'), join(home, 'link'), join(home, 'gone')])).toEqual({ bytes: 11 + join(home, 'A').length, files: 4, dirs: 2, partial: false })
    fsFail.readdir = errno('EACCES')
    expect(await measure([join(home, 'A')])).toMatchObject({ files: 0, dirs: 1 })
    const late = await measure([join(home, 'A')], undefined, 0)
    expect(late).toMatchObject({ partial: true, files: 0 })
  })

  it('copies links as links, keeps times and modes, skips sockets', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'src', 'f'), 'f')
    await chmod(join(dir, 'src', 'f'), 0o751)
    await symlink('f', join(dir, 'src', 'l'))
    const server = createServer()
    await new Promise<void>((r) => server.listen(join(dir, 'src', 'sock'), r))
    const job = new Job('j', 'copy', vi.fn())
    await copyTree(join(dir, 'src'), join(dir, 'dst'), job)
    server.close()
    expect((await readdir(join(dir, 'dst'))).sort()).toEqual(['f', 'l'])
    expect(await readlink(join(dir, 'dst', 'l'))).toBe('f')
    expect((await stat(join(dir, 'dst', 'f'))).mode & 0o777).toBe(0o751)
    expect(Math.abs((await stat(join(dir, 'dst', 'f'))).mtimeMs - (await stat(join(dir, 'src', 'f'))).mtimeMs)).toBeLessThan(1)
    job.cancelled = true
    await expect(copyTree(join(dir, 'src'), join(dir, 'again'), job)).rejects.toBeInstanceOf(Cancelled)
    expect(new Cancelled().code).toBe('cancelled')
  })

  it('streams big files (progress inside the file)', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'big'), '')
    await truncate(join(dir, 'big'), 33 * 1024 * 1024)
    const emit = vi.fn()
    const job = new Job('b', 'copy', emit)
    await copyTree(join(dir, 'big'), join(dir, 'copy'), job)
    expect((await stat(join(dir, 'copy'))).size).toBe(33 * 1024 * 1024)
    expect(job.done).toBe(33 * 1024 * 1024)
    expect(emit).toHaveBeenCalled()
  })

  it('reports progress at most every 100 ms', () => {
    const emit = vi.fn()
    const job = new Job('p', 'zip', emit)
    job.report('a')
    job.report('b')
    expect(emit).toHaveBeenCalledTimes(1)
    job.finish()
    expect(emit).toHaveBeenLastCalledWith({ id: 'p', kind: 'zip', done: 0, total: 0, finished: true })
  })
})

describe('undo: restore moves and the trash', () => {
  it('moves things back to exactly where they were — never over something', async () => {
    const { finder, home } = await world()
    await finder.restore([{ from: join(home, 'A', 'one.txt'), to: join(home, 'B', 'one.txt') }])
    expect(existsSync(join(home, 'B', 'one.txt'))).toBe(true)
    await expect(finder.restore([{ from: join(home, 'A', 'two.txt'), to: join(home, 'B', 'one.txt') }])).rejects.toMatchObject({ code: 'exists' })
    fsFail.rename = errno('EXDEV')
    await finder.restore([{ from: join(home, 'A', 'Sub'), to: join(home, 'Sub') }])
    expect(await readFile(join(home, 'Sub', 'deep.txt'), 'utf8')).toBe('deep')
  })

  it('trashes into a restorable trash where there is one, and puts things back', async () => {
    const data = await tempDir('mindeck-data-')
    const restorable = freedesktopTrash(data, () => new Date(2026, 9, 15, 9, 30, 5))
    const { finder, home } = await world({ restorableTrash: restorable })
    const items = await finder.trash([join(home, 'A', 'one.txt'), join(home, 'B')])
    expect(items).toEqual([
      { path: join(home, 'A', 'one.txt'), restore: join(data, 'Trash', 'files', 'one.txt') },
      { path: join(home, 'B'), restore: join(data, 'Trash', 'files', 'B') }
    ])
    expect(await readFile(join(data, 'Trash', 'info', 'one.txt.trashinfo'), 'utf8')).toBe(
      `[Trash Info]\nPath=${join(home, 'A', 'one.txt').split('/').map(encodeURIComponent).join('/')}\nDeletionDate=2026-10-15T09:30:05\n`
    )
    // Several at once; a name taken since keeps both (the one coming back gets a number).
    await writeFile(join(home, 'B'), 'new B')
    expect(await finder.untrash(items.map((i) => ({ path: i.path, restore: i.restore! })))).toEqual({
      items: [
        { path: join(home, 'A', 'one.txt'), to: join(home, 'A', 'one.txt') },
        { path: join(home, 'B'), to: join(home, 'B 2') }
      ],
      gone: []
    })
    expect(await readFile(join(home, 'A', 'one.txt'), 'utf8')).toBe('one')
    expect(await readFile(join(home, 'B'), 'utf8')).toBe('new B')
    expect((await stat(join(home, 'B 2'))).isDirectory()).toBe(true)
    expect(existsSync(join(data, 'Trash', 'info', 'one.txt.trashinfo'))).toBe(false)
    // Emptied from the trash since: listed, the rest still comes back.
    const [two] = await finder.trash([join(home, 'A', 'two.txt')])
    expect(await finder.untrash([{ path: join(home, 'x.txt'), restore: join(data, 'Trash', 'files', 'gone') }, { path: two.path, restore: two.restore! }])).toEqual({
      items: [{ path: join(home, 'A', 'two.txt'), to: join(home, 'A', 'two.txt') }],
      gone: [join(home, 'x.txt')]
    })
    await expect(finder.untrash([{ path: join(home, 'x.txt'), restore: join(home, 'A', 'two.txt') }])).rejects.toMatchObject({ code: 'bad-path' })

    // Same names get numbered; the old record stays with its file.
    await writeFile(join(home, 'dup.txt'), '1')
    await finder.trash([join(home, 'dup.txt')])
    await writeFile(join(home, 'dup.txt'), '2')
    expect((await finder.trash([join(home, 'dup.txt')]))[0].restore).toBe(join(data, 'Trash', 'files', 'dup.2.txt'))
  })

  it('falls back to the OS trash on other disks, and passes other errors on', async () => {
    const restorable = { trash: vi.fn(async (): Promise<string | undefined> => Promise.reject(errno('EXDEV'))), restore: vi.fn(async () => {}) }
    const { finder, home, trash } = await world({ restorableTrash: restorable })
    expect(await finder.trash([join(home, 'A', 'one.txt')])).toEqual([{ path: join(home, 'A', 'one.txt') }])
    expect(trash).toHaveBeenCalled()
    restorable.trash.mockRejectedValueOnce(errno('EACCES'))
    await expect(finder.trash([join(home, 'A', 'two.txt')])).rejects.toMatchObject({ code: 'EACCES' })
    // In the OS trash but not found again there: no way back offered.
    restorable.trash.mockResolvedValueOnce(undefined)
    expect(await finder.trash([join(home, 'A', 'two.txt')])).toEqual([{ path: join(home, 'A', 'two.txt') }])
    // Errors putting back other than "gone" (macOS: Full Disk Access) stop the undo.
    restorable.restore.mockRejectedValueOnce(errno('full-disk-access'))
    await expect(finder.untrash([{ path: join(home, 'A', 'two.txt'), restore: '/t/two.txt' }])).rejects.toMatchObject({ code: 'full-disk-access' })
    const plain = (await world()).finder
    await expect(plain.untrash([{ path: join(home, 'x'), restore: join(home, 'y') }])).rejects.toMatchObject({ code: 'no-undo' })
  })

  it('opens the macOS privacy settings where there is a desktop to open them on', async () => {
    const openExternal = vi.fn(async () => {})
    await (await world({ openExternal })).finder.privacySettings()
    expect(openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
    await expect((await world()).finder.privacySettings()).rejects.toMatchObject({ code: 'desktop-only' })
  })

  it('the freedesktop trash removes its record when the move fails, and passes record errors on', async () => {
    const data = await tempDir('mindeck-data-')
    const t = freedesktopTrash(data)
    await expect(t.trash(join(data, 'missing.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(data, 'Trash', 'info'))).toEqual([])
    // Even when the record won't go, the move's error is the one reported.
    fsFail.unlink = errno('EIO')
    await expect(t.trash(join(data, 'missing.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(data, 'Trash', 'info'))).toEqual(['missing.txt.trashinfo'])
    // A name the record cannot have (too long with ".trashinfo") — reported.
    const long = 'n'.repeat(250)
    await writeFile(join(data, long), '')
    await expect(t.trash(join(data, long))).rejects.toMatchObject({ code: 'ENAMETOOLONG' })
  })

  it('uses the freedesktop trash on Linux, under XDG_DATA_HOME when set', async () => {
    const trashItem = vi.fn(async () => {})
    expect(desktopTrash({ platform: 'aix', env: {}, home: '/h', trashItem })).toBeUndefined()
    const data = await tempDir()
    const viaEnv = desktopTrash({ platform: 'linux', env: { XDG_DATA_HOME: data }, home: '/nowhere', trashItem })!
    await writeFile(join(data, 'f'), '')
    expect(await viaEnv.trash(join(data, 'f'))).toBe(join(data, 'Trash', 'files', 'f'))
    const home = await tempDir()
    const viaHome = desktopTrash({ platform: 'linux', env: {}, home, trashItem })!
    await writeFile(join(home, 'g'), '')
    expect(await viaHome.trash(join(home, 'g'))).toBe(join(home, '.local', 'share', 'Trash', 'files', 'g'))
    expect(trashItem).not.toHaveBeenCalled()
  })
})

describe('info and folder sizes', () => {
  it('tells dates, permissions, owner and whether Mindeck may change it', async () => {
    const { finder, home } = await world()
    await chmod(join(home, 'A', 'one.txt'), 0o640)
    const info = await finder.info(join(home, 'A', 'one.txt'))
    expect(info).toMatchObject({ entry: { name: 'one.txt' }, mode: 0o640, writable: true })
    expect(info.owner).toBeTruthy()
    expect((await finder.info('/')).writable).toBe(false)
    await expect(finder.info(join(home, 'gone'))).rejects.toMatchObject({ code: 'not-found' })
    await symlink(join(home, 'nowhere'), join(home, 'broken'))
    expect((await finder.info(join(home, 'broken'))).entry.link).toBe(true)

    const getuid = process.getuid
    Object.defineProperty(process, 'getuid', { value: () => 4242, configurable: true })
    expect((await finder.info(home)).owner).toBeNull()
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true })
    expect((await finder.info(home)).owner).toBeNull()
    Object.defineProperty(process, 'getuid', { value: getuid, configurable: true })
  })

  it('counts what a folder holds, with progress; stops when cancelled or after the time limit', async () => {
    let finder!: FinderService
    const seen: FinderProgress[] = []
    const w = await world({
      progress: (p) => {
        seen.push(p)
        if (p.id === 'cancel' && !p.finished) finder.cancel('cancel')
      }
    })
    finder = w.finder
    expect(await finder.folderSize(join(w.home, 'A'), 's1')).toEqual({ bytes: 11, files: 3, folders: 1, partial: false })
    expect(seen.some((e) => e.kind === 'size' && e.id === 's1')).toBe(true)
    expect(await finder.folderSize(join(w.home, 'A'), 'cancel')).toMatchObject({ partial: true })
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(now).mockReturnValue(now + 60_000)
    expect(await finder.folderSize(join(w.home, 'A'), 's2')).toMatchObject({ partial: true })
    clock.mockRestore()
    expect(await finder.folderSize(join(w.home, 'A', 'one.txt'), 's4')).toEqual({ bytes: 3, files: 1, folders: 0, partial: false })
    await expect(finder.folderSize('relative', 's3')).rejects.toMatchObject({ code: 'bad-path' })
    // Without a home given, the user's.
    expect((await new FinderService({ trash: vi.fn() }).places()).home).toBeTruthy()
  })
})

describe('archives', () => {
  it('knows archives by name', () => {
    expect(['a.zip', 'a.TAR.GZ', 'a.tgz', 'a.tar', 'a.rar'].map(archiveKind)).toEqual(['zip', 'tgz', 'tgz', 'tar', null])
  })

  it('refuses names that would leave the target folder', () => {
    expect(safeTarget('/t', 'a/./b')).toBe('/t/a/b')
    expect(safeTarget('/t', './')).toBe('/t')
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:\\x', 'a\\..\\..\\x', 'a\0b']) expect(() => safeTarget('/t', bad)).toThrow(/unsafe path/)
  })

  it('compresses one item as "name.zip", several as "Archive.zip" — and extracts them again', async () => {
    const { finder, home, events } = await world()
    await symlink('one.txt', join(home, 'A', 'link'))
    await writeFile(join(home, 'A', '.DS_Store'), 'x')
    const zip = await finder.compress([join(home, 'A')], 'z1')
    expect(zip).toBe(join(home, 'A.zip'))
    expect(events.some((e) => e.kind === 'zip' && e.finished)).toBe(true)
    expect(await finder.compress([join(home, 'A', 'one.txt'), join(home, 'A', 'two.txt')], 'z2')).toBe(join(home, 'A', 'Archive.zip'))
    expect(await finder.compress([join(home, 'A')], 'z3')).toBe(join(home, 'A 2.zip'))

    // One top folder: extracted under its own name (numbered, "A" exists).
    const out = await finder.extract(zip, 'u1')
    expect(out).toBe(join(home, 'A 2'))
    expect(await readFile(join(out, 'Sub', 'deep.txt'), 'utf8')).toBe('deep')
    expect((await readdir(out)).sort()).toEqual(['Sub', 'one.txt', 'two.txt']) // no link, no .DS_Store
    // Several top items: into a folder named like the archive.
    const several = await finder.extract(join(home, 'A', 'Archive.zip'), 'u2')
    expect(several).toBe(join(home, 'A', 'Archive'))
    expect((await readdir(several)).sort()).toEqual(['one.txt', 'two.txt'])
    expect((await readdir(home)).filter((n) => n.startsWith('.'))).toEqual([]) // no leftovers

    await expect(finder.extract(join(home, 'A', 'one.txt'), 'u3')).rejects.toMatchObject({ code: 'not-archive' })
  })

  it('leaves out what is neither file, folder nor link (a FIFO)', async () => {
    const { finder, home } = await world()
    execFileSync('mkfifo', [join(home, 'A', 'pipe')])
    const zip = await finder.compress([join(home, 'A')], 'z4')
    const out = await finder.extract(zip, 'u4')
    expect((await readdir(out)).sort()).toEqual(['Sub', 'one.txt', 'two.txt'])
  })

  it('cleans up when compressing fails (unreadable file, unreadable link, full disk)', async () => {
    const { finder, home } = await world()
    await symlink('one.txt', join(home, 'A', 'link'))
    fsFail.readStream = 'two.txt'
    await expect(finder.compress([join(home, 'A')], 'e1')).rejects.toThrow('read failed')
    fsFail.readlink = errno('EIO')
    await expect(finder.compress([join(home, 'A')], 'e2')).rejects.toThrow('EIO')
    fsFail.writeStream = '.part'
    await expect(finder.compress([join(home, 'A')], 'e3')).rejects.toThrow('disk full')
    expect((await readdir(home)).filter((n) => n.includes('.part') || n.endsWith('.zip'))).toEqual([])
    // Stopped by the user.
    let f!: FinderService
    const w = await world({ progress: (p) => !p.finished && f.cancel(p.id) })
    f = w.finder
    await expect(f.compress([join(w.home, 'A')], 'e4')).rejects.toBeInstanceOf(Cancelled)
  })

  async function makeZip(path: string, add: (z: ZipFile) => void) {
    const z = new ZipFile()
    add(z)
    z.end()
    const chunks: Buffer[] = []
    for await (const c of z.outputStream as AsyncIterable<Buffer>) chunks.push(c)
    await writeFile(path, Buffer.concat(chunks))
  }

  it('extracts ZIPs safely: Windows permissions, skipped resource forks; no encrypted ones, not more than the disk holds', async () => {
    const { finder, home } = await world()
    await makeZip(join(home, 'win.zip'), (z) => {
      z.addBuffer(Buffer.from('w'), 'w.txt', { mode: 0o100000 })
      z.addBuffer(Buffer.from('m'), '__MACOSX/._w.txt')
      z.addEmptyDirectory('empty')
    })
    const out = await finder.extract(join(home, 'win.zip'), 'w')
    expect((await stat(join(out, 'w.txt'))).mode & 0o777).toBe(0o644)
    expect((await readdir(out)).sort()).toEqual(['empty', 'w.txt'])

    // Mark the entry as encrypted in the central directory.
    await makeZip(join(home, 'enc.zip'), (z) => z.addBuffer(Buffer.from('s'), 's.txt'))
    const enc = await readFile(join(home, 'enc.zip'))
    const central = enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    enc[central + 8] |= 1
    await writeFile(join(home, 'enc.zip'), enc)
    await expect(finder.extract(join(home, 'enc.zip'), 'e')).rejects.toMatchObject({ code: 'encrypted' })

    fsFail.statfs = { bavail: 0, bsize: 4096 }
    await expect(finder.extract(join(home, 'win.zip'), 'n')).rejects.toMatchObject({ code: 'no-space' })
    expect((await readdir(home)).filter((n) => n.includes('.extracting'))).toEqual([])
    fsFail.statfs = null

    let f!: FinderService
    const w = await world({ progress: (p) => !p.finished && f.cancel(p.id) })
    f = w.finder
    await makeZip(join(w.home, 'two.zip'), (z) => {
      z.addBuffer(Buffer.from('1'), 'a.txt')
      z.addBuffer(Buffer.from('2'), 'b.txt')
    })
    await expect(f.extract(join(w.home, 'two.zip'), 'c')).rejects.toBeInstanceOf(Cancelled)
  })

  /** A tar header block (ustar unless asked otherwise), with a valid checksum. */
  function tarHeader(name: string, o: { size?: number; type?: string; mode?: number | null; prefix?: string; ustar?: boolean; base256?: boolean } = {}) {
    const b = Buffer.alloc(512)
    b.write(name, 0, 100)
    if (o.mode !== null) b.write(`${(o.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100)
    if (o.base256) {
      b[124] = 0x80
      b.writeUInt32BE(o.size ?? 0, 132)
    } else b.write(`${(o.size ?? 0).toString(8).padStart(11, '0')}\0`, 124)
    b.write(`${(1_700_000_000).toString(8).padStart(11, '0')}\0`, 136)
    b.write('        ', 148)
    b.write(o.type ?? '0', 156)
    if (o.ustar !== false) b.write('ustar\0', 257)
    if (o.prefix) b.write(o.prefix, 345)
    let sum = 0
    for (const byte of b) sum += byte
    b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    return b
  }
  const pad = (data: Buffer) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)])
  const entry = (name: string, data = '', o: Parameters<typeof tarHeader>[1] = {}) => Buffer.concat([tarHeader(name, { size: Buffer.byteLength(data), ...o }), pad(Buffer.from(data))])
  const tar = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)])

  it('extracts tar and tar.gz: folders, long names (GNU and pax), big sizes; links and devices skipped', async () => {
    const { finder, home } = await world()
    const long = `${'x'.repeat(120)}.txt`
    const body = tar(
      entry('./', '', { type: '5' }),
      entry('pkg/', '', { type: '5' }),
      entry('pkg/a.txt', 'aaa', { mode: 0o755 }),
      entry('././@LongLink', `pkg/${long}\0`, { type: 'L' }),
      entry('ignored-short-name', 'long'),
      entry('PaxHeader', '30 path=pkg/pax name.txt\n15 mtime=1234\n', { type: 'x' }),
      entry('pax-short', 'pax'),
      entry('PaxHeader', '15 mtime=1234\n', { type: 'x' }),
      entry('pkg/plain.txt', 'plain', { type: '\0' }),
      entry('link', '', { type: '2' }),
      entry('global', '18 comment=hello\n', { type: 'g' }),
      entry('b.txt', 'b256', { prefix: 'pkg/deep', base256: true }),
      entry('pkg/old.txt', 'old', { ustar: false, type: '7' }),
      entry('pkg/nomode.txt', 'n', { mode: null }),
      entry('pkg/large.bin', 'L'.repeat(200_000))
    )
    await writeFile(join(home, 'pkg.tar'), body)
    const out = await finder.extract(join(home, 'pkg.tar'), 't1')
    expect(out).toBe(join(home, 'pkg'))
    expect((await readdir(out)).sort()).toEqual(['deep', 'a.txt', long, 'large.bin', 'nomode.txt', 'old.txt', 'pax name.txt', 'plain.txt'].sort())
    expect((await stat(join(out, 'large.bin'))).size).toBe(200_000)
    expect((await stat(join(out, 'nomode.txt'))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(out, long), 'utf8')).toBe('long')
    expect(await readFile(join(out, 'pax name.txt'), 'utf8')).toBe('pax')
    expect(await readFile(join(out, 'deep', 'b.txt'), 'utf8')).toBe('b256')
    expect((await stat(join(out, 'a.txt'))).mode & 0o777).toBe(0o755)
    expect((await stat(join(out, 'a.txt'))).mtimeMs).toBe(1_700_000_000_000)
    expect(await readFile(join(out, 'plain.txt'), 'utf8')).toBe('plain')

    await writeFile(join(home, 'two.tgz'), gzipSync(tar(entry('x.txt', 'x'), entry('y.txt', 'y'))))
    const both = await finder.extract(join(home, 'two.tgz'), 't2')
    expect(both).toBe(join(home, 'two'))
    expect((await readdir(both)).sort()).toEqual(['x.txt', 'y.txt'])
    await writeFile(join(home, 'one.tar.gz'), gzipSync(tar(entry('solo.txt', 'solo'))))
    expect(await finder.extract(join(home, 'one.tar.gz'), 't3')).toBe(join(home, 'solo.txt'))
    // An archive called just ".tar": the result is named after the file.
    await writeFile(join(home, '.tar'), tar(entry('p.txt', 'p'), entry('q.txt', 'q')))
    expect(await finder.extract(join(home, '.tar'), 't4')).toBe(join(home, '.tar 2'))
  })

  it('refuses broken, unsafe and truncated tars — leaving nothing behind', async () => {
    const { finder, home } = await world()
    const bad = tarHeader('a.txt')
    bad[0] = 'b'.charCodeAt(0) // checksum no longer matches
    await writeFile(join(home, 'bad.tar'), Buffer.concat([bad, Buffer.alloc(1024)]))
    await expect(finder.extract(join(home, 'bad.tar'), 'b1')).rejects.toMatchObject({ code: 'bad-archive' })
    await writeFile(join(home, 'slip.tar'), tar(entry('../evil.txt', 'evil')))
    await expect(finder.extract(join(home, 'slip.tar'), 'b2')).rejects.toMatchObject({ code: 'unsafe-archive' })
    expect(existsSync(join(home, '..', 'evil.txt'))).toBe(false)
    await writeFile(join(home, 'cut.tar'), Buffer.concat([tarHeader('big.txt', { size: 2000 }), Buffer.alloc(600)]))
    await expect(finder.extract(join(home, 'cut.tar'), 'b3')).rejects.toMatchObject({ code: 'bad-archive' })
    await writeFile(join(home, 'cut2.tar'), Buffer.concat([tarHeader('pad.txt', { size: 10 }), Buffer.from('0123456789'), Buffer.alloc(100)]))
    await expect(finder.extract(join(home, 'cut2.tar'), 'b4')).rejects.toMatchObject({ code: 'bad-archive' })
    await writeFile(join(home, 'broken.tgz'), Buffer.from('not gzip at all'))
    await expect(finder.extract(join(home, 'broken.tgz'), 'b5')).rejects.toThrow()
    fsFail.readStream = 'gone.tar'
    await writeFile(join(home, 'gone.tar'), tar(entry('g.txt', 'g')))
    await expect(finder.extract(join(home, 'gone.tar'), 'b6')).rejects.toThrow('read failed')
    // A long-name record big enough to fill the memory is no long name.
    await writeFile(join(home, 'meta.tar'), Buffer.concat([tarHeader('././@LongLink', { type: 'L', size: MAX_TAR_META + 1 }), Buffer.alloc(1024)]))
    await expect(finder.extract(join(home, 'meta.tar'), 'b9')).rejects.toMatchObject({ code: 'bad-archive', message: expect.stringContaining('oversized') })
    await writeFile(join(home, 'pax.tar'), Buffer.concat([tarHeader('PaxHeader', { type: 'x', size: 0xfffffff0, base256: true }), Buffer.alloc(1024)]))
    await expect(finder.extract(join(home, 'pax.tar'), 'b10')).rejects.toMatchObject({ code: 'bad-archive' })
    // A .tar.gz that unpacks to more than the disk has free stops before it fills it.
    fsFail.statfs = { bavail: 2, bsize: 1024 }
    await writeFile(join(home, 'bomb.tgz'), gzipSync(tar(entry('a.bin', 'a'.repeat(1500)), entry('b.bin', 'b'.repeat(1500)))))
    await expect(finder.extract(join(home, 'bomb.tgz'), 'b11')).rejects.toMatchObject({ code: 'no-space' })
    expect((await readdir(home)).filter((n) => n.startsWith('.'))).toEqual([])

    let f!: FinderService
    const w = await world({ progress: (p) => !p.finished && f.cancel(p.id) })
    f = w.finder
    await writeFile(join(w.home, 'c.tar'), tar(entry('c.txt', 'c')))
    await expect(f.extract(join(w.home, 'c.tar'), 'b7')).rejects.toBeInstanceOf(Cancelled)
    await expect(f.extract(join(w.home, 'missing.tar'), 'b8')).rejects.toThrow()
  })
})

describe('system clipboard', () => {
  it('converts paths to and from plists and URI lists', () => {
    const plist = pathsToPlist(['/a & b/<c>.txt', '/d'])
    expect(plist).toContain('<string>/a &amp; b/&lt;c&gt;.txt</string>')
    expect(plistToPaths(plist)).toEqual(['/a & b/<c>.txt', '/d'])
    expect(plistToPaths('<string>&quot;x&apos;</string>')).toEqual(['"x\''])
    expect(urisToPaths('copy\nfile:///tmp/a%20b\r\nhttp://x\nfile://remote/share/x\n# comment')).toEqual(['/tmp/a b'])
    expect(raw('X')).toBe('electron application/osclipboard;format="X"')
  })

  function fakeClipboard(items: Record<string, string | Buffer>[] = [], failWrite = false) {
    const written: Record<string, string>[] = []
    let writes = 0
    return {
      written,
      cb: {
        read: vi.fn(async () =>
          items.map((data) => ({
            types: Object.keys(data),
            getType: async (t: string) => new Blob([data[t] as BlobPart])
          }))
        ),
        write: vi.fn(async (list: never[]) => {
          writes += 1
          if (failWrite && writes === 1) throw new Error('unsupported format')
          written.push(...(list as unknown as Record<string, string>[]))
        })
      }
    }
  }
  const make = (d: Record<string, string>) => d

  it('writes each OS its own format, the paths as text too — and falls back to text', async () => {
    const mac = fakeClipboard()
    await fileClipboard(mac.cb, make, 'darwin').write(['/a', '/b'], false)
    expect(mac.written[0]['text/plain']).toBe('/a\n/b')
    expect(plistToPaths(mac.written[0][raw('NSFilenamesPboardType')])).toEqual(['/a', '/b'])
    const linux = fakeClipboard()
    await fileClipboard(linux.cb, make, 'linux').write(['/a b'], true)
    expect(linux.written[0][raw('x-special/gnome-copied-files')]).toBe('cut\nfile:///a%20b')
    expect(linux.written[0]['text/uri-list']).toBe('file:///a%20b')
    await fileClipboard(linux.cb, make, 'linux').write(['/c'], false)
    expect(linux.written[1][raw('x-special/gnome-copied-files')]).toBe('copy\nfile:///c')
    const win = fakeClipboard([], true)
    await fileClipboard(win.cb, make, 'win32').write(['C:\\a', 'C:\\b'], false)
    expect(win.written).toEqual([{ 'text/plain': 'C:\\a\r\nC:\\b' }])
  })

  it('reads files copied in Finder, Nautilus/KDE or Explorer', async () => {
    const mac = fakeClipboard([{ 'text/plain': 'x' }, { [raw('NSFilenamesPboardType')]: pathsToPlist(['/m']) }])
    expect(await fileClipboard(mac.cb, make, 'darwin').read()).toEqual(['/m'])
    const gnome = fakeClipboard([{ [raw('x-special/gnome-copied-files')]: 'copy\nfile:///g', 'text/uri-list': 'file:///g' }])
    expect(await fileClipboard(gnome.cb, make, 'linux').read()).toEqual(['/g'])
    const kde = fakeClipboard([{ 'text/uri-list': 'file:///k1\r\nfile:///k2' }])
    expect(await fileClipboard(kde.cb, make, 'linux').read()).toEqual(['/k1', '/k2'])
    const win = fakeClipboard([{ [raw('FileNameW')]: Buffer.from('C:\\w.txt\0junk', 'utf16le') }])
    expect(await fileClipboard(win.cb, make, 'win32').read()).toEqual(['C:\\w.txt'])
    expect(await fileClipboard(fakeClipboard([{ 'text/plain': 'x' }]).cb, make, 'win32').read()).toEqual([])
    const broken = { read: vi.fn(async () => Promise.reject(new Error('busy'))), write: vi.fn() }
    expect(await fileClipboard(broken, make, 'darwin').read()).toEqual([])
  })

  it('the service: absolute paths out; only existing absolute paths in; desktop only', async () => {
    const clip = { write: vi.fn(async () => {}), read: vi.fn(async () => [] as string[]) }
    const { finder, home } = await world({ clipboard: clip })
    await finder.clipboardWrite([join(home, 'A')], true)
    expect(clip.write).toHaveBeenCalledWith([join(home, 'A')], true)
    clip.read.mockResolvedValueOnce([join(home, 'A'), 'relative', join(home, 'gone')])
    expect(await finder.clipboardRead()).toEqual([join(home, 'A')])
    const plain = (await world()).finder
    await expect(plain.clipboardWrite([home], false)).rejects.toMatchObject({ code: 'desktop-only' })
    expect(await plain.clipboardRead()).toEqual([])
  })
})
