import { mkdir, readFile, readdir, readlink, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'

const h = vi.hoisted(() => ({ fail: undefined as undefined | string }))
// rename across file systems (a bind mount and a volume in Docker) fails with EXDEV — so it does here when asked.
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      if (h.fail) throw Object.assign(new Error(`${h.fail}: rename ${from}`), { code: h.fail })
      return fs.rename(from, to)
    }
  }
})

import { headlessPlatform } from '../../../electron/main/platform/headless'

describe('headless trash', () => {
  it('moves into the trash folder; across file systems (EXDEV) it copies — folders and links as they are — and removes the original', async () => {
    const project = await tempDir()
    const trash = join(await tempDir(), 'file-trash')
    await writeFile(join(project, 'a.txt'), 'A')
    h.fail = undefined
    await headlessPlatform.trashItem(join(project, 'a.txt'), trash)
    expect(existsSync(join(project, 'a.txt'))).toBe(false)
    const [moved] = await readdir(join(trash, '.trash'))
    expect(moved).toMatch(/^a \d+\.txt$/)

    await mkdir(join(project, 'src', 'deep'), { recursive: true })
    await writeFile(join(project, 'src', 'deep', 'x.ts'), 'x')
    await symlink('../outside', join(project, 'src', 'link'))
    h.fail = 'EXDEV'
    await headlessPlatform.trashItem(join(project, 'src'), trash)
    expect(existsSync(join(project, 'src'))).toBe(false)
    const copy = (await readdir(join(trash, '.trash'))).find((f) => f.startsWith('src '))!
    expect(await readFile(join(trash, '.trash', copy, 'deep', 'x.ts'), 'utf8')).toBe('x')
    expect(await readlink(join(trash, '.trash', copy, 'link'))).toBe('../outside')
  })

  it('any other failure is the caller’s, and the file stays', async () => {
    const project = await tempDir()
    await writeFile(join(project, 'a.txt'), 'A')
    h.fail = 'EACCES'
    await expect(headlessPlatform.trashItem(join(project, 'a.txt'), join(project, 'trash'))).rejects.toMatchObject({ code: 'EACCES' })
    expect(await readFile(join(project, 'a.txt'), 'utf8')).toBe('A')
    h.fail = undefined
  })
})
