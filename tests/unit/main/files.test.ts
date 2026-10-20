import { chmod, mkdir, readFile, readdir, realpath, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './helpers'
import { FilesService, MAX_EDIT_BYTES } from '../../../electron/main/services/files/FilesService'

async function project(files: Record<string, string | Buffer>) {
  const root = await tempDir('mindeck-files-')
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), body)
  }
  const service = new FilesService((id) => (id === 'p' ? root : undefined))
  return { root, service }
}

describe('FilesService', () => {
  it('lists one folder: dirs first, natural order, .git hidden, gitignored marked', async () => {
    const { root, service } = await project({
      '.gitignore': 'node_modules\n*.log\n',
      '.git/HEAD': 'ref',
      '.DS_Store': '',
      'file10.ts': '',
      'file2.ts': '',
      'debug.log': '',
      'src/App.tsx': '',
      'node_modules/react/index.js': '',
      'a-dir/x': ''
    })
    await symlink(join(root, 'src'), join(root, 'linked-src'))
    await symlink(join(root, 'file2.ts'), join(root, 'linked.ts'))
    await symlink(join(root, 'missing'), join(root, 'dangling'))

    const top = await service.list('p')
    expect(top.map((e) => `${e.kind}:${e.path}${e.ignored ? ' (ignored)' : ''}`)).toEqual([
      'dir:a-dir',
      'dir:linked-src',
      'dir:node_modules (ignored)',
      'dir:src',
      'file:.gitignore',
      'file:debug.log (ignored)',
      'file:file2.ts',
      'file:file10.ts',
      'file:linked.ts'
    ])
    expect(await service.list('p', 'node_modules/react')).toEqual([
      { name: 'index.js', path: 'node_modules/react/index.js', kind: 'file', ignored: true }
    ])
    // Any spelling of the folder yields the same normalized paths.
    expect((await service.list('p', './src/'))[0].path).toBe('src/App.tsx')
  })

  it('lists without a .gitignore; refuses unknown projects and paths outside', async () => {
    const { root, service } = await project({ 'a.txt': '' })
    expect(await service.list('p', '')).toEqual([{ name: 'a.txt', path: 'a.txt', kind: 'file', ignored: false }])
    await expect(service.list('nope')).rejects.toMatchObject({ code: 'not-found' })
    await expect(service.list('p', '..')).rejects.toMatchObject({ code: 'outside-project' })
    await symlink(dirname(root), join(root, 'escape'))
    await expect(service.read('p', 'escape/x.txt')).rejects.toMatchObject({ code: 'outside-project' })
  })

  it('reads text, flags binary and oversized files, refuses folders and missing files', async () => {
    const { root, service } = await project({ 'a.ts': 'const a = 1\r\n', 'img.png': Buffer.from([137, 80, 0, 71]), 'dir/x': '' })
    const text = await service.read('p', 'a.ts')
    expect(text).toMatchObject({ path: 'a.ts', content: 'const a = 1\r\n', size: 13 })
    expect(text.mtimeMs).toBe((await stat(join(root, 'a.ts'))).mtimeMs)
    expect(await service.read('p', 'img.png')).toMatchObject({ unsupported: 'binary', size: 4 })
    expect((await service.read('p', 'img.png')).content).toBeUndefined()

    await writeFile(join(root, 'big.txt'), Buffer.alloc(MAX_EDIT_BYTES + 1, 'a'))
    expect(await service.read('p', 'big.txt')).toMatchObject({ unsupported: 'too-large' })

    await expect(service.read('p', 'dir')).rejects.toMatchObject({ code: 'not-a-file' })
    await expect(service.read('p', 'gone.ts')).rejects.toMatchObject({ code: 'not-found' })
    await expect(service.read('p', 'a.ts/x')).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('stats many paths; gone, folders and outside paths are null', async () => {
    const { root, service } = await project({ 'a.ts': 'abc', 'dir/x': '' })
    const [a, dir, gone, outside] = await service.stat('p', ['a.ts', 'dir', 'gone.ts', '../x'])
    expect(a).toEqual({ mtimeMs: (await stat(join(root, 'a.ts'))).mtimeMs, size: 3 })
    expect([dir, gone, outside]).toEqual([null, null, null])
  })

  it('writes in place, keeps the file mode, and refuses when the disk copy is newer', async () => {
    const { root, service } = await project({ 'run.sh': 'echo 1\n' })
    const file = join(root, 'run.sh')
    await chmod(file, 0o755)
    const opened = await service.read('p', 'run.sh')

    const saved = await service.write('p', 'run.sh', 'echo 2\n', opened.mtimeMs)
    expect(await readFile(file, 'utf8')).toBe('echo 2\n')
    expect(saved).toEqual({ mtimeMs: (await stat(file)).mtimeMs, size: 7 })
    expect((await stat(file)).mode & 0o777).toBe(0o755)

    // Someone else edits the file → the stale editor copy is refused…
    await utimes(file, new Date(), new Date(Date.now() + 5000))
    await expect(service.write('p', 'run.sh', 'mine', saved.mtimeMs)).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(file, 'utf8')).toBe('echo 2\n')
    // …unless the user chose to overwrite (no expected mtime).
    await service.write('p', 'run.sh', 'mine')
    expect(await readFile(file, 'utf8')).toBe('mine')
  })

  it('recreates a file deleted meanwhile (with its folder); refuses folders and broken paths', async () => {
    const { root, service } = await project({ 'dir/x': '' })
    await service.write('p', 'new/deep/a.ts', 'x', 123)
    expect(await readFile(join(root, 'new/deep/a.ts'), 'utf8')).toBe('x')
    await expect(service.write('p', 'dir', 'x')).rejects.toMatchObject({ code: 'not-a-file' })
    await expect(service.write('p', 'dir/x/y', 'x')).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(service.write('p', '../evil.ts', 'x')).rejects.toMatchObject({ code: 'outside-project' })
  })

  it('never writes through a dangling link to outside the project (BE-SEC-02)', async () => {
    const { root, service } = await project({ 'docs/readme.md': '' })
    const elsewhere = await tempDir()
    await symlink(join(elsewhere, 'autostart', 'x.desktop'), join(root, 'docs', 'setup.md'))
    await symlink(join('..', '..', basename(elsewhere), 'pwned.txt'), join(root, 'docs', 'notes.txt')) // relative, like one checked into a repo
    await expect(service.write('p', 'docs/setup.md', '[Desktop Entry]')).rejects.toMatchObject({ code: 'outside-project' })
    await expect(service.write('p', 'docs/notes.txt', 'x')).rejects.toMatchObject({ code: 'outside-project' })
    await expect(service.create('p', 'docs/setup.md', 'file')).rejects.toMatchObject({ code: 'outside-project' })
    expect(await readdir(elsewhere)).toEqual([])
    // one that stays inside is written through, as before
    await symlink('readme.md', join(root, 'docs', 'alias.md'))
    await service.write('p', 'docs/alias.md', 'hi')
    expect(await readFile(join(root, 'docs', 'readme.md'), 'utf8')).toBe('hi')
  })

  it('creates files and folders (with parents); refuses taken names and the project folder', async () => {
    const { root, service } = await project({ 'a.ts': 'x' })
    await service.create('p', 'src/deep/new.ts', 'file')
    expect(await readFile(join(root, 'src/deep/new.ts'), 'utf8')).toBe('')
    await service.create('p', 'lib/empty', 'dir')
    expect((await stat(join(root, 'lib/empty'))).isDirectory()).toBe(true)
    await expect(service.create('p', 'a.ts', 'file')).rejects.toMatchObject({ code: 'exists' })
    await expect(service.create('p', 'lib', 'dir')).rejects.toMatchObject({ code: 'exists' })
    await expect(service.create('p', '.', 'dir')).rejects.toMatchObject({ code: 'bad-input' })
    await expect(service.create('p', '../x', 'file')).rejects.toMatchObject({ code: 'outside-project' })
  })

  it('renames and moves; never over another entry, never into itself', async () => {
    const { root, service } = await project({ 'a.ts': 'a', 'b.ts': 'b', 'dir/x.ts': 'x' })
    await service.rename('p', 'a.ts', 'moved/A.ts')
    expect(await readFile(join(root, 'moved/A.ts'), 'utf8')).toBe('a')
    // Case-only rename of the same file (case-insensitive disks see it as "taken").
    await service.rename('p', 'moved/A.ts', 'moved/a.ts')
    expect(await readdir(join(root, 'moved'))).toEqual(['a.ts'])
    // Onto itself: the same file on every disk, not "taken" (case-sensitive disks never see the case-only one so).
    await service.rename('p', 'moved/a.ts', 'moved/a.ts')
    expect(await readFile(join(root, 'moved/a.ts'), 'utf8')).toBe('a')
    await expect(service.rename('p', 'b.ts', 'moved/a.ts')).rejects.toMatchObject({ code: 'exists' })
    await expect(service.rename('p', 'gone.ts', 'c.ts')).rejects.toMatchObject({ code: 'not-found' })
    await expect(service.rename('p', 'dir', 'dir/sub')).rejects.toMatchObject({ code: 'bad-input' })
    await service.rename('p', 'dir', 'dir2')
    expect(await readFile(join(root, 'dir2/x.ts'), 'utf8')).toBe('x')
  })

  it('deletes into the trash; refuses missing entries and the project folder', async () => {
    const { root } = await project({ 'a.ts': 'a', 'dir/x.ts': 'x' })
    const trashed: string[] = []
    const service = new FilesService(
      () => root,
      async (abs) => void trashed.push(abs)
    )
    await service.remove('p', 'dir')
    expect(trashed).toEqual([join(await realpath(root), 'dir')])
    await expect(service.remove('p', 'gone')).rejects.toMatchObject({ code: 'not-found' })
    await expect(service.remove('p', '')).rejects.toMatchObject({ code: 'bad-input' })
    // Without a trash the entry is simply removed.
    const plain = new FilesService(() => root)
    await plain.remove('p', 'a.ts')
    expect(await readdir(root)).toEqual(['dir'])
  })
})
