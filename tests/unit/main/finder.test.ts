import { mkdir, readFile, readdir as realReaddir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'

// Pass-through fs, with switches to fail one call the way a real disk sometimes does.
const fsFail = vi.hoisted(() => ({ readdir: null as null | NodeJS.ErrnoException, rename: null as null | NodeJS.ErrnoException, mkdir: null as null | NodeJS.ErrnoException, lstat: null as null | NodeJS.ErrnoException }))
const mountsRead = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const once = <T extends (...a: never[]) => unknown>(key: keyof typeof fsFail, fn: T) =>
    ((...args: Parameters<T>) => {
      const err = fsFail[key]
      if (err) {
        fsFail[key] = null
        return Promise.reject(err)
      }
      return fn(...args)
    }) as T
  // Where the OS mounts drives (/mnt, /media/<user>, /Volumes): never the machine's real ones — they
  // differ per machine (a container has its own /mnt). Reads there are recorded and come back empty.
  const readdir = ((path: unknown, ...rest: never[]) => {
    if (typeof path === 'string' && (path === '/mnt' || path === '/Volumes' || /^\/(run\/)?media\//.test(path))) {
      mountsRead.push(path)
      return Promise.resolve([])
    }
    return (real.readdir as (...a: unknown[]) => Promise<unknown>)(path, ...rest)
  }) as typeof real.readdir
  return { ...real, readdir: once('readdir', readdir), rename: once('rename', real.rename), mkdir: once('mkdir', real.mkdir), lstat: once('lstat', real.lstat) }
})
const exec = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:child_process')>()), execFile: (...a: unknown[]) => exec.fn(...a) }))

import { checkName, FinderService, freeName, macSpotlight, spotlightFor } from '../../../electron/main/services/finder/FinderService'

const realPlatform = process.platform
afterEach(() => Object.defineProperty(process, 'platform', { value: realPlatform }))

const errno = (code: string) => Object.assign(new Error(code), { code })

async function world() {
  const home = await tempDir('mindeck-home-')
  for (const d of ['Desktop', 'Documents', 'Downloads', 'Videos', 'Music', 'Project/src', 'Project/node_modules/lib', 'Project/.git', 'Tools.app/Contents']) await mkdir(join(home, d), { recursive: true })
  await writeFile(join(home, 'Documents', 'report 10.md'), '# Report\n')
  await writeFile(join(home, 'Documents', 'report 2.md'), '# Two\n')
  await writeFile(join(home, 'Documents', '.secret'), 'x')
  await writeFile(join(home, 'Project', 'src', 'report-tool.ts'), 'export {}\n')
  await writeFile(join(home, 'Project', 'node_modules', 'lib', 'report.js'), '')
  await symlink(join(home, 'Documents'), join(home, 'Docs link'))
  await symlink(join(home, 'nowhere'), join(home, 'broken link'))
  const volumes = await tempDir('mindeck-volumes-')
  await mkdir(join(volumes, 'Backup'))
  await mkdir(join(volumes, 'Recovery'))
  await mkdir(join(volumes, '.Spotlight'))
  await writeFile(join(volumes, 'notes.txt'), '')
  await symlink('/', join(volumes, 'Macintosh HD'))
  await symlink(join(volumes, 'unplugged'), join(volumes, 'Gone')) // a link to nothing is no drive
  const trash = vi.fn(async () => {})
  const finder = new FinderService({ home, writableRoots: [home], volumeDirs: [volumes, join(volumes, 'missing')], trash, openPath: vi.fn(async () => {}), revealPath: vi.fn() })
  return { home, volumes, trash, finder }
}

describe('FinderService · reading', () => {
  it('knows the usual places that exist and the external drives — not the startup disk or system partitions', async () => {
    const { finder, home, volumes } = await world()
    const places = await finder.places()
    expect(places.home).toBe(home)
    expect(places.places).toEqual([
      { id: 'home', path: home },
      { id: 'desktop', path: join(home, 'Desktop') },
      { id: 'documents', path: join(home, 'Documents') },
      { id: 'downloads', path: join(home, 'Downloads') },
      { id: 'movies', path: join(home, 'Videos') },
      { id: 'music', path: join(home, 'Music') }
    ])
    expect(places.volumes).toEqual([{ name: 'Backup', path: join(volumes, 'Backup') }])
  })

  it('lists folders first in natural order, flags links, bundles and hidden files', async () => {
    const { finder, home } = await world()
    const listing = await finder.list()
    expect(listing.path).toBe(home)
    expect(listing.parent).not.toBeNull()
    expect(listing).toMatchObject({ total: 9, offset: 0 })
    expect(listing.entries.map((e) => `${e.kind}:${e.name}${e.link ? '@' : ''}${e.bundle ? '+' : ''}`)).toEqual([
      'dir:Desktop',
      'dir:Docs link@',
      'dir:Documents',
      'dir:Downloads',
      'dir:Music',
      'dir:Project',
      'dir:Tools.app+',
      'dir:Videos',
      'file:broken link@'
    ])
    const docs = await finder.list(join(home, 'Documents'))
    expect(docs.entries.map((e) => e.name)).toEqual(['report 2.md', 'report 10.md'])
    expect(docs.entries[0]).toMatchObject({ kind: 'file', size: 6, hidden: false })
    const all = await finder.list(join(home, 'Documents'), true)
    expect(all.entries.map((e) => e.name)).toContain('.secret')
    expect((await finder.list('/')).parent).toBeNull()
    // a folder after a file in the disk's order still comes first
    await mkdir(join(home, 'Mixed', 'b'), { recursive: true })
    await writeFile(join(home, 'Mixed', 'a.txt'), '')
    expect((await finder.list(join(home, 'Mixed'))).entries.map((e) => e.name)).toEqual(['b', 'a.txt'])
  })

  it('says why a folder cannot be listed', async () => {
    const { finder, home } = await world()
    await expect(finder.list('relative/path')).rejects.toMatchObject({ code: 'bad-path' })
    await expect(finder.list(join(home, 'gone'))).rejects.toMatchObject({ code: 'not-found' })
    await expect(finder.list(join(home, 'Documents', 'report 2.md'))).rejects.toMatchObject({ code: 'not-found' })
    fsFail.readdir = errno('EACCES')
    await expect(finder.list(home)).rejects.toMatchObject({ code: 'no-access' })
    fsFail.readdir = errno('EPERM')
    await expect(finder.list(home)).rejects.toMatchObject({ code: 'no-access' })
    fsFail.readdir = errno('EIO')
    await expect(finder.list(home)).rejects.toMatchObject({ code: 'error' })
  })

  it('lists big folders in pages of 1000, keeping the names a while for the next pages', async () => {
    const { finder, home } = await world()
    const big = join(home, 'Big')
    await mkdir(big)
    await Promise.all(Array.from({ length: 2501 }, (_, i) => writeFile(join(big, `f${i}`), '')))
    const first = await finder.list(big)
    expect(first).toMatchObject({ total: 2501, offset: 0 })
    expect(first.entries).toHaveLength(1000)
    expect(first.entries[0].name).toBe('f0')
    // Changes meanwhile do not shift the pages (the names are kept).
    await writeFile(join(big, 'a-new'), '')
    const second = await finder.list(big, false, 1000)
    expect(second).toMatchObject({ total: 2501, offset: 1000 })
    expect(second.entries[0].name).toBe('f1000')
    expect((await finder.list(big, false, 2500)).entries.map((e) => e.name)).toEqual(['f2500'])
    // After a while (or for another view) the folder is read again.
    const now = Date.now()
    const later = vi.spyOn(Date, 'now').mockReturnValue(now + 31_000)
    expect((await finder.list(big, false, 2500)).total).toBe(2502)
    later.mockRestore()
    expect((await finder.list(big, true, 1000)).total).toBe(2502)
    // Small folders are not kept: their page 2 reads again.
    expect((await finder.list(home, false, 5)).entries.length).toBe(5)
    // Only a few big folders are kept at once.
    for (const n of [1, 2, 3, 4]) {
      const d = join(home, `Many${n}`)
      await mkdir(d)
      await Promise.all(Array.from({ length: 1001 }, (_, i) => writeFile(join(d, `g${i}`), '')))
      await finder.list(d)
    }
    expect((finder as unknown as { listings: Map<string, unknown> }).listings.size).toBe(4)
  }, 60_000)

  it('searches with Spotlight where there is one, else (or when it finds nothing) walks — skipping hidden places, packages and node_modules', async () => {
    const { finder, home, trash } = await world()
    expect(await finder.search(home, '  ')).toEqual([])
    const walked = await finder.search(home, 'REPORT')
    expect(walked.map((e) => e.name).sort()).toEqual(['report 10.md', 'report 2.md', 'report-tool.ts'])
    // a folder it may not read is passed over
    fsFail.readdir = errno('EACCES')
    expect(await finder.search(join(home, 'Project', 'src'), 'tool')).toEqual([])

    const spotlight = vi.fn(async () => [join(home, 'Documents', 'report 2.md'), join(home, '.hidden', 'report.md'), '/elsewhere/report.md', join(home, 'Documents', 'vanished.md')])
    const indexed = new FinderService({ home, trash, spotlight })
    expect((await indexed.search(home, ' report ')).map((e) => e.name)).toEqual(['report 2.md'])
    expect(spotlight).toHaveBeenCalledWith(home, 'report')
    // searching the whole disk: everything under "/" counts
    expect((await indexed.search('/', 'x')).map((e) => e.name)).toEqual(['report 2.md'])

    const broken = new FinderService({ home, trash, spotlight: vi.fn(async () => Promise.reject(new Error('indexing'))) })
    expect((await broken.search(join(home, 'Project'), 'tool')).map((e) => e.name)).toEqual(['report-tool.ts'])
    // nothing from Spotlight: the folder may not be indexed — walk it
    const unindexed = new FinderService({ home, trash, spotlight: vi.fn(async () => ['/elsewhere/tool.ts']) })
    expect((await unindexed.search(join(home, 'Project'), 'tool')).map((e) => e.name)).toEqual(['report-tool.ts'])
  })

  it('previews folders, media, text — and tells binary from text by content', async () => {
    const { finder, home } = await world()
    const docs = join(home, 'Documents')
    await expect(finder.preview(join(home, 'gone'))).rejects.toMatchObject({ code: 'not-found' })
    expect(await finder.preview(docs)).toMatchObject({ type: 'dir', items: 2 })
    expect(await finder.preview(join(home, 'Tools.app'))).toMatchObject({ type: 'binary', entry: { bundle: true } })
    for (const [name, type] of [['photo.JPG', 'image'], ['clip.mov', 'video'], ['song.mp3', 'audio'], ['paper.pdf', 'pdf']] as const) {
      await writeFile(join(docs, name), 'x')
      expect((await finder.preview(join(docs, name))).type).toBe(type)
    }
    expect(await finder.preview(join(docs, 'report 2.md'))).toMatchObject({ type: 'text', text: '# Two\n', truncated: false })
    await writeFile(join(docs, 'huge.log'), 'x'.repeat(300 * 1024))
    const huge = await finder.preview(join(docs, 'huge.log'))
    expect(huge.text).toHaveLength(256 * 1024)
    expect(huge.truncated).toBe(true)
    await writeFile(join(docs, 'fake.txt'), Buffer.from([0x50, 0x4b, 0x00, 0x03]))
    expect((await finder.preview(join(docs, 'fake.txt'))).type).toBe('binary')
    await writeFile(join(docs, 'config.xyz'), 'key = value\n')
    expect((await finder.preview(join(docs, 'config.xyz'))).type).toBe('text')
    await writeFile(join(docs, 'blob.xyz'), Buffer.from(Array.from({ length: 200 }, (_, i) => (i % 31) + 1)))
    expect((await finder.preview(join(docs, 'blob.xyz'))).type).toBe('binary')
    await writeFile(join(docs, 'empty.xyz'), '')
    expect(await finder.preview(join(docs, 'empty.xyz'))).toMatchObject({ type: 'text', text: '' })
    // a folder Mindeck may not read still previews, without a count
    const locked = join(home, 'Locked')
    await mkdir(locked)
    fsFail.readdir = errno('EACCES')
    expect(await finder.preview(locked)).toMatchObject({ type: 'dir', items: 0 })
    // a file whose link status can't be read counts as no link
    fsFail.lstat = errno('EIO')
    expect((await finder.preview(join(docs, 'report 2.md'))).entry).not.toHaveProperty('link')
  })
})

describe('FinderService · changes', () => {
  it('creates folders and renames, refusing names that walk the tree and clashes', async () => {
    const { finder, home } = await world()
    const docs = join(home, 'Documents')
    expect(await finder.mkdir(docs, ' Plans ')).toBe(join(docs, 'Plans'))
    await expect(finder.mkdir(docs, 'Plans')).rejects.toMatchObject({ code: 'exists', message: '“Plans” already exists' })
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'nul\0', 'x'.repeat(256)]) await expect(finder.mkdir(docs, bad)).rejects.toMatchObject({ code: 'bad-name' })
    await expect(finder.mkdir(join(home, 'gone', 'deeper'), 'x')).rejects.toMatchObject({ code: 'not-found' })
    fsFail.mkdir = errno('EACCES')
    await expect(finder.mkdir(docs, 'Denied')).rejects.toMatchObject({ code: 'error' })

    const from = join(docs, 'report 2.md')
    expect(await finder.rename(from, 'report 2.md')).toBe(from) // unchanged
    expect(await finder.rename(from, 'two.md')).toBe(join(docs, 'two.md'))
    await expect(finder.rename(join(docs, 'two.md'), 'report 10.md')).rejects.toMatchObject({ code: 'exists' })
    // only the case changes: the same file, not a clash
    expect(await finder.rename(join(docs, 'two.md'), 'Two.md')).toBe(join(docs, 'Two.md'))
    expect(await readdirNames(docs)).toContain('Two.md')
  })

  it('changes nothing outside Home and the drives — and never a root itself', async () => {
    const { finder, home } = await world()
    const outside = await tempDir('mindeck-outside-')
    await writeFile(join(outside, 'x.txt'), 'x')
    await expect(finder.mkdir(outside, 'New')).rejects.toMatchObject({ code: 'read-only' })
    await expect(finder.rename(join(outside, 'x.txt'), 'y.txt')).rejects.toMatchObject({ code: 'read-only' })
    await expect(finder.trash([join(outside, 'x.txt')])).rejects.toMatchObject({ code: 'read-only' })
    await expect(finder.rename(home, 'Renamed home')).rejects.toMatchObject({ code: 'read-only' })
    await expect(finder.move([join(home, 'Desktop')], outside)).rejects.toMatchObject({ code: 'read-only' })
    // a link out of Home does not open a way out
    await symlink(outside, join(home, 'Out'))
    await expect(finder.mkdir(join(home, 'Out'), 'New')).rejects.toMatchObject({ code: 'read-only' })
  })

  it('also changes files in Mindeck’s own folder, wherever it lives', async () => {
    const mindeck = await tempDir('mindeck-own-')
    const finder = new FinderService({ home: await tempDir('mindeck-home-'), alsoWritable: [mindeck], trash: vi.fn(async () => {}) })
    expect(await finder.mkdir(mindeck, 'Plans')).toBe(join(mindeck, 'Plans'))
    await expect(finder.rename(mindeck, 'Elsewhere')).rejects.toMatchObject({ code: 'read-only' }) // never the folder itself
  })

  it('trashes, moves and copies — numbering names that are taken, never into itself', async () => {
    const { finder, home, trash } = await world()
    const docs = join(home, 'Documents')
    const desk = join(home, 'Desktop')
    expect(await finder.trash([join(docs, 'report 2.md')])).toEqual([{ path: join(docs, 'report 2.md') }])
    expect(trash).toHaveBeenCalledWith(join(docs, 'report 2.md'))

    await writeFile(join(desk, 'report 10.md'), 'taken')
    expect(await finder.move([join(docs, 'report 10.md')], desk)).toEqual([join(desk, 'report 10 2.md')])
    expect(await finder.move([join(desk, 'report 10.md')], desk)).toEqual([]) // already there
    await expect(finder.move([docs], join(docs))).rejects.toMatchObject({ code: 'bad-move' })
    await mkdir(join(docs, 'inner'))
    await expect(finder.move([docs], join(docs, 'inner'))).rejects.toMatchObject({ code: 'bad-move' })
    await expect(finder.move([join(desk, 'report 10.md')], join(home, 'gone'))).rejects.toMatchObject({ code: 'not-found' })

    // another disk: copied over, then the original goes
    await writeFile(join(docs, 'far.txt'), 'far')
    fsFail.rename = errno('EXDEV')
    expect(await finder.move([join(docs, 'far.txt')], desk)).toEqual([join(desk, 'far.txt')])
    expect(await readFile(join(desk, 'far.txt'), 'utf8')).toBe('far')
    expect(await readdirNames(docs)).not.toContain('far.txt')
    fsFail.rename = errno('EBUSY')
    await expect(finder.move([join(desk, 'far.txt')], docs)).rejects.toThrow('EBUSY')

    expect(await finder.copy([join(desk, 'far.txt'), join(home, 'Project')], desk)).toEqual([join(desk, 'far 2.txt'), join(desk, 'Project')])
    expect(await readFile(join(desk, 'Project', 'src', 'report-tool.ts'), 'utf8')).toBe('export {}\n')
    await expect(finder.copy([home], desk)).rejects.toMatchObject({ code: 'bad-move' })
  })

  it('opens with the default app and shows in Finder — on the desktop only', async () => {
    const { finder, home } = await world()
    await finder.open(join(home, 'Documents'))
    finder.reveal(join(home, 'Documents'))
    const headless = new FinderService({ home, trash: vi.fn() })
    await expect(headless.open(home)).rejects.toMatchObject({ code: 'desktop-only' })
    expect(() => headless.reveal(home)).toThrow('only available in the Mindeck desktop app')
  })

  it('numbers free names like Finder', async () => {
    const dir = await tempDir()
    expect(await freeName(dir, 'a.txt')).toBe(join(dir, 'a.txt'))
    await writeFile(join(dir, 'a.txt'), '')
    await writeFile(join(dir, 'a 2.txt'), '')
    expect(await freeName(dir, 'a.txt')).toBe(join(dir, 'a 3.txt'))
    await writeFile(join(dir, 'Makefile'), '')
    expect(await freeName(dir, 'Makefile')).toBe(join(dir, 'Makefile 2'))
    expect(checkName('  ok.txt ')).toBe('ok.txt')
  })
})

describe('FinderService · per platform', () => {
  it('finds drives where each OS mounts them, and writes in Home by default', async () => {
    const home = await tempDir('mindeck-home-')
    const user = home.slice(home.lastIndexOf('/') + 1)
    mountsRead.length = 0
    Object.defineProperty(process, 'platform', { value: 'linux' })
    expect((await new FinderService({ home, trash: vi.fn() }).places()).volumes).toEqual([])
    expect(mountsRead.splice(0)).toEqual([`/media/${user}`, `/run/media/${user}`, '/mnt'])
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect((await new FinderService({ home, trash: vi.fn() }).places()).volumes).toEqual([])
    expect(mountsRead.splice(0)).toEqual([])
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const mac = new FinderService({ home, trash: vi.fn() })
    expect(await mac.mkdir(home, 'Made')).toBe(join(home, 'Made'))
    expect((await mac.places()).volumes).toEqual([])
    expect(mountsRead.splice(0)).toEqual(['/Volumes'])
    // the home folder of the machine, when none is given
    expect((await new FinderService({ trash: vi.fn() }).places()).home).toBeTruthy()
  })

  it('asks Spotlight through mdfind with structured arguments', async () => {
    exec.fn.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => cb(null, '/a/x.md\n/a/y.md\n'))
    expect(spotlightFor('darwin')).toBe(macSpotlight)
    expect(spotlightFor('linux')).toBeUndefined()
    expect(await macSpotlight('/a', 'x')).toEqual(['/a/x.md', '/a/y.md'])
    expect(exec.fn).toHaveBeenLastCalledWith('mdfind', ['-onlyin', '/a', '-name', 'x'], expect.objectContaining({ timeout: 5000 }), expect.any(Function))
    exec.fn.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => cb(new Error('mds off'), ''))
    await expect(macSpotlight('/a', 'x')).rejects.toThrow('mds off')
  })
})

async function readdirNames(dir: string): Promise<string[]> {
  return realReaddir(dir)
}
