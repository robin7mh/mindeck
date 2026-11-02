import { execFile } from 'node:child_process'
import { lstat, readdir, readFile, rename, rm } from 'node:fs/promises'
import { promisify } from 'node:util'

/**
 * A trash Mindeck can also take things back out of — Files' ⌘Z after "Move
 * to Trash", on all three desktops. Linux: the freedesktop.org trash
 * (`~/.local/share/Trash`, the one GNOME and KDE use), done by Mindeck
 * itself. macOS: the system call Finder uses, which says where the item
 * went (`trashMac.ts`). Windows: the Recycle Bin, found again by its
 * `$I` records (`trashWindows.ts`).
 */
export interface RestorableTrash {
  /**
   * Moves `path` into the trash. Returns where it now lies — or undefined when
   * it is in the trash but cannot be found again (then there is no undo).
   * Fails with EXDEV where this trash cannot take it (another disk).
   */
  trash(path: string): Promise<string | undefined>
  /**
   * Puts a trashed item back at `to` (which must be free). Fails with
   * `trash-gone` when it is no longer in the trash (emptied, deleted there).
   */
  restore(trashed: string, to: string): Promise<void>
}

/** What the OS trashes need from the machine — the real one in the app, fakes in tests. */
export interface TrashHost {
  /** Runs a program (no shell, arguments as they are) and resolves with its output. */
  run(file: string, args: string[]): Promise<string>
  lstat(path: string): Promise<{ ino: number }>
  readdir(dir: string): Promise<string[]>
  readFile(path: string): Promise<Buffer>
  rename(from: string, to: string): Promise<void>
  /** Removes a file; a missing one is fine. */
  rm(path: string): Promise<void>
}

const run = promisify(execFile)

export const nodeTrashHost: TrashHost = {
  run: async (file, args) => (await run(file, args, { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 })).stdout,
  lstat: (path) => lstat(path),
  readdir: (dir) => readdir(dir),
  readFile: (path) => readFile(path),
  rename: (from, to) => rename(from, to),
  rm: (path) => rm(path, { force: true })
}

export function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** The error for an item that left the trash since (emptied, deleted there, or replaced by another). */
export const trashGone = (): Error => coded('trash-gone', 'It is no longer in the Trash')
