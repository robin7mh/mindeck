import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

export type Row = Record<string, unknown>

/** Node's built-in SQLite (Node ≥ 22.13, every Electron since 35) — loaded at run time, so bundlers leave it alone. */
function sqlite(): typeof import('node:sqlite') {
  const mod = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined
  if (!mod) throw Object.assign(new Error('SQLite is not available in this runtime'), { code: 'no-sqlite' })
  return mod
}

/**
 * Reads another browser's SQLite database without touching it: the browser
 * keeps it locked (and half of it in the -wal file) while it runs, so the file
 * and its journals are copied to a temp folder first, queried there, and the
 * copy is deleted afterwards.
 */
export async function querySqliteCopy<T>(file: string, run: (query: (sql: string) => Row[]) => T): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mindeck-import-'))
  try {
    const copy = join(dir, basename(file))
    await copyFile(file, copy)
    for (const suffix of ['-wal', '-journal']) await copyFile(file + suffix, copy + suffix).catch(() => {})
    const db: DatabaseSync = new (sqlite().DatabaseSync)(copy)
    try {
      return run((sql) => db.prepare(sql).all() as Row[])
    } finally {
      db.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : '')
export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
