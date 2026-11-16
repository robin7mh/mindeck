import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

const created: string[] = []
const cleanups: (() => Promise<unknown>)[] = []

/** Runs after the current test, before its temp directories are removed (e.g. flush pending writes). */
export function onCleanup(fn: () => Promise<unknown>): void {
  cleanups.push(fn)
}

/**
 * A fresh temp directory, removed after the current test — its real path:
 * macOS's temp folder is a link (/var → /private/var), and the code under
 * test resolves links.
 */
export async function tempDir(prefix = 'mindeck-test-'): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  created.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()))
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** Resolves after pending timers/IO callbacks have had a chance to run. */
export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
