import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'

// Every path the disk is asked about.
const probed = vi.hoisted(() => [] as string[])
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    existsSync: (p: string) => {
      probed.push(String(p))
      return real.existsSync(p)
    }
  }
})

import { confine } from '../../../electron/main/lib/confine'

describe('confine', () => {
  it('resolves inside the project, following links; a target may not exist yet', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'src'))
    const real = await realpath(root)
    expect(await confine(root, 'src/new/file.ts')).toBe(join(real, 'src', 'new', 'file.ts'))
    expect(await confine(root, '.')).toBe(real)
    await symlink(await tempDir(), join(root, 'out'))
    await expect(confine(root, 'out/new.ts')).rejects.toMatchObject({ code: 'outside-project' })
  })

  it('refuses a path outside as written before asking the disk (a UNC path would send the user’s credentials)', async () => {
    const root = await tempDir()
    probed.length = 0
    await expect(confine(root, '/somewhere/else')).rejects.toMatchObject({ code: 'outside-project' })
    await expect(confine(root, '../../etc/passwd')).rejects.toMatchObject({ code: 'outside-project' })
    await expect(confine(root, `${root}-sibling/x`)).rejects.toMatchObject({ code: 'outside-project' })
    expect(probed).toEqual([])
  })

  it('a dangling link counts as what it points to: a write would create its target (BE-SEC-02)', async () => {
    const base = await tempDir()
    const root = join(base, 'repo')
    const out = join(base, 'outside')
    await mkdir(join(root, 'docs'), { recursive: true })
    await mkdir(out)
    const real = await realpath(root)
    const refused = (rel: string) => expect(confine(root, rel)).rejects.toMatchObject({ code: 'outside-project' })

    // docs/setup.md -> ../../outside/autostart.desktop (does not exist yet)
    await symlink('../../outside/autostart.desktop', join(root, 'docs', 'setup.md'))
    await refused('docs/setup.md')
    await symlink(join(out, 'abs.txt'), join(root, 'abs.txt'))
    await refused('abs.txt')
    // a chain of dangling links, and a dangling folder link in the middle of the path
    await symlink('hop2', join(root, 'hop1'))
    await symlink('../outside/chained.txt', join(root, 'hop2'))
    await refused('hop1')
    await symlink('../outside/missing-dir/', join(root, 'dir'))
    await refused('dir/file.txt')
    // `..` in a link counts from the folder a link before it leads to, not as written
    await mkdir(join(out, 'inner'))
    await symlink(join(out, 'inner'), join(root, 'via'))
    await symlink('via/../sneaky.txt', join(root, 'dotdot'))
    await refused('dotdot')
    // past a missing name, `..` can only climb as written — still not out
    await symlink('missing/../../../outside/x.txt', join(root, 'climb'))
    await refused('climb')
    // loops, and links to another machine (asking it would send the user's credentials)
    await symlink('loop-b', join(root, 'loop-a'))
    await symlink('loop-a', join(root, 'loop-b'))
    await refused('loop-a')
    await symlink('//host/share/x', join(root, 'unc'))
    await refused('unc')

    // dangling links that stay inside are fine — the path itself is returned
    await symlink('./later.txt', join(root, 'docs', 'soon.txt'))
    expect(await confine(root, 'docs/soon.txt')).toBe(join(real, 'docs', 'soon.txt'))
    await symlink('../docs/new/deep.txt', join(root, 'docs', 'up.txt'))
    expect(await confine(root, 'docs/up.txt')).toBe(join(real, 'docs', 'up.txt'))
    await symlink(join(real, 'docs', 'abs-inside.txt'), join(root, 'abs-inside'))
    expect(await confine(root, 'abs-inside')).toBe(join(real, 'abs-inside'))
    // and one that exists is judged by what it points to
    await writeFile(join(out, 'there.txt'), 'x')
    await symlink('../outside/there.txt', join(root, 'there'))
    await refused('there')
  })
})
