import { win32 } from 'node:path'
import { coded, trashGone, type RestorableTrash, type TrashHost } from './trashHost'

/**
 * The Windows Recycle Bin with a way back. Electron's `shell.trashItem`
 * recycles the item; Windows then keeps it on the same drive as
 * `<drive>:\$Recycle.Bin\<user SID>\$R<id><ext>`, next to a record
 * `$I<id><ext>` with the original path and the time of deletion. Mindeck
 * reads those records itself (a documented, stable binary layout) — no
 * PowerShell, no localized verb names ("Restore" / "Wiederherstellen") and
 * no script to put a path into. Putting back is what Explorer's Restore
 * does: `$R…` moves to where it was and its `$I…` record goes.
 *
 * Drives without a Recycle Bin (network shares, most removable drives) delete
 * for good; nothing is found then, and Files offers no undo.
 */

/** Deletion time vs. our clock: the record may say a little earlier than we started. */
const SLACK_MS = 2000
/** Records read at once. */
const BATCH = 64
/** Windows FILETIME (100 ns since 1601) → ms since 1970. */
const EPOCH_DIFF_MS = 11_644_473_600_000

/** A `$I` record: version 1 (Vista–8.1, fixed 260 characters) or 2 (Windows 10+, length-prefixed). */
export function parseRecycleRecord(buf: Buffer): { path: string; deletedMs: number } | null {
  if (buf.length < 28) return null
  const version = buf.readBigUInt64LE(0)
  const deletedMs = Number(buf.readBigUInt64LE(16) / 10_000n) - EPOCH_DIFF_MS
  let name: Buffer
  if (version === 1n) name = buf.subarray(24, 24 + 520)
  else if (version === 2n) name = buf.subarray(28, 28 + buf.readUInt32LE(24) * 2)
  else return null
  const path = name.toString('utf16le').split('\0')[0]
  return path ? { path, deletedMs } : null
}

/** `C:\` — a drive's root (a UNC share has no Recycle Bin). */
const DRIVE_ROOT = /^[A-Za-z]:\\$/

export interface WindowsTrashOptions {
  host: TrashHost
  /** `shell.trashItem`. */
  trashItem: (path: string) => Promise<void>
  now?: () => number
}

export function windowsTrash({ host, trashItem, now = Date.now }: WindowsTrashOptions): RestorableTrash {
  let sid: string | undefined
  /** What each recycled item was (its file id) — so a different one is never taken back. */
  const known = new Map<string, number>()
  /** Per Recycle Bin: records deleted before an earlier search started — they can never match again. */
  const staleIn = new Map<string, Set<string>>()

  /** The user's SID — the name of their folder in every `$Recycle.Bin`. */
  const userSid = async (): Promise<string> => {
    if (!sid) {
      // `"machine\user","S-1-5-21-…"`: CSV, the same in every language.
      const out = await host.run('whoami', ['/user', '/fo', 'csv', '/nh'])
      const found = out.match(/"(S-1-[\d-]+)"\s*$/)
      if (!found) throw coded('error', 'Cannot tell who is signed in')
      sid = found[1]
    }
    return sid
  }

  /** Where `path` went: the newest record for it since `since` whose item is still the one trashed. */
  const locate = async (path: string, ino: number, since: number): Promise<string | undefined> => {
    const root = win32.parse(path).root
    if (!DRIVE_ROOT.test(root)) return undefined
    const bin = win32.join(root, '$Recycle.Bin', await userSid())
    const all = new Set((await host.readdir(bin)).filter((n) => /^\$I/i.test(n)))
    // Only names still there: an emptied record's name may come back one day.
    const stale = new Set([...(staleIn.get(bin) ?? [])].filter((n) => all.has(n)))
    staleIn.set(bin, stale)
    const names = [...all].filter((n) => !stale.has(n))
    let best: { item: string; at: number } | undefined
    for (let i = 0; i < names.length; i += BATCH) {
      const read = async (n: string) => ({ n, record: parseRecycleRecord(await host.readFile(win32.join(bin, n)).catch(() => Buffer.alloc(0))) })
      const records = await Promise.all(names.slice(i, i + BATCH).map(read))
      for (const { n, record } of records) {
        if (!record) continue
        if (record.deletedMs < since - SLACK_MS) {
          stale.add(n)
          continue
        }
        if (record.path.toLowerCase() !== path.toLowerCase() || (best && best.at >= record.deletedMs)) continue
        const item = win32.join(bin, `$R${n.slice(2)}`)
        const st = await host.lstat(item).catch(() => null)
        // A file id of 0 (FAT drives) says nothing.
        if (st && (!ino || st.ino === ino)) best = { item, at: record.deletedMs }
      }
    }
    return best?.item
  }

  return {
    async trash(path) {
      const full = win32.resolve(path)
      const before = await host.lstat(full)
      const since = now()
      await trashItem(full)
      const item = await locate(full, before.ino, since).catch(() => undefined)
      if (item) known.set(item.toLowerCase(), before.ino)
      return item
    },

    async restore(trashed, to) {
      const at = win32.resolve(trashed)
      const userDir = win32.dirname(at)
      const bin = win32.dirname(userDir)
      const inBin =
        /^\$R/i.test(win32.basename(at)) &&
        /^S-1-[\d-]+$/i.test(win32.basename(userDir)) &&
        win32.basename(bin).toLowerCase() === '$recycle.bin' &&
        DRIVE_ROOT.test(win32.dirname(bin))
      if (!inBin) throw coded('bad-path', 'Not an item in the Recycle Bin')
      const st = await host.lstat(at).catch((err: NodeJS.ErrnoException) => {
        throw err.code === 'ENOENT' || err.code === 'ENOTDIR' ? trashGone() : err
      })
      const ino = known.get(at.toLowerCase())
      if (ino && ino !== st.ino) throw trashGone()
      await host.rename(at, to)
      known.delete(at.toLowerCase())
      // The record goes too, as with Explorer's Restore.
      await host.rm(win32.join(userDir, `$I${win32.basename(at).slice(2)}`)).catch(() => {})
    }
  }
}
