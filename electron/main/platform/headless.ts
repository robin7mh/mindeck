import { cp, mkdir, rename, rm } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { Platform } from './types'

/**
 * Moves `from` to `to` — across file systems too: in Docker the projects are a
 * bind mount and the trash lives in the data volume, where `rename` fails with
 * EXDEV. Then it is copied (links as links) and the original removed.
 */
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true })
    await rm(from, { recursive: true, force: true })
  }
}

/**
 * Headless host (standalone server / Docker). There is no GUI, so there is no
 * picker and nothing to open; deleted notes go to the vault's `.trash` folder
 * — Obsidian's own "move to .trash" convention, so they stay recoverable.
 */
export const headlessPlatform: Platform = {
  kind: 'server',
  async trashItem(path, root) {
    const dir = join(root, '.trash')
    await mkdir(dir, { recursive: true })
    const ext = extname(path)
    const stem = basename(path, ext)
    await move(path, join(dir, `${stem} ${Date.now()}${ext}`))
  }
}
