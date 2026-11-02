import { posix } from 'node:path'
import { coded, trashGone, type RestorableTrash, type TrashHost } from './trashHost'

/**
 * The macOS trash with a way back. Electron's `shell.trashItem` calls
 * `-[NSFileManager trashItemAtURL:resultingItemURL:error:]` and drops the
 * resulting URL; this makes the same call through JavaScript for Automation
 * and keeps it — so the item is found exactly, whatever name the trash gave
 * it (`~/.Trash` for the startup disk, `/Volumes/<disk>/.Trashes/<uid>` for
 * others). Unlike scripting Finder ("delete"), it asks for no Automation
 * permission and plays no sound; unlike searching the trash afterwards by
 * name, it needs no access to the trash folder.
 *
 * Putting back is a move to where it was. `~/.Trash` is protected by the
 * system (TCC): without Full Disk Access that move is refused — reported as
 * `full-disk-access`, so the user knows which switch to turn on.
 */

/** The path comes in as an argument (`run(argv)`), never spliced into the script. */
export const MAC_TRASH_SCRIPT = `ObjC.import('Foundation')
function run(argv) {
  const item = Ref()
  const error = Ref()
  if ($.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0]), item, error)) {
    return JSON.stringify({ path: item[0].path.js })
  }
  return JSON.stringify({ error: Number(error[0].code), message: error[0].localizedDescription.js })
}`

/** NSCocoaErrorDomain codes → the errno codes the rest of Mindeck knows. */
const COCOA_ERRORS: Record<number, string> = { 4: 'ENOENT', 257: 'EACCES', 513: 'EACCES', 640: 'ENOSPC' }

export interface MacTrashOptions {
  home: string
  uid: number
  host: TrashHost
  /** `shell.trashItem` — used when the script cannot run at all. */
  trashItem: (path: string) => Promise<void>
}

export function macTrash({ home, uid, host, trashItem }: MacTrashOptions): RestorableTrash {
  const homeTrash = posix.join(home, '.Trash')
  /** What each item put in the trash was (its inode) — so a different one under that name is never taken back. */
  const known = new Map<string, number>()

  const exists = (path: string) => host.lstat(path).then(() => true, () => false)

  /** The trash folder `dir` is one of this user's: the home trash, or a disk's `.Trashes/<uid>`. */
  const isTrash = (dir: string) => dir === homeTrash || (/^\/Volumes\/[^/]+\/\.Trashes$/.test(posix.dirname(dir)) && posix.basename(dir) === String(uid))

  /** Errors on the way back, said plainly. */
  const explain = (err: unknown, inHome: boolean): Error => {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return trashGone()
    if (code === 'EPERM' && inHome) {
      return coded('full-disk-access', 'macOS lets Mindeck take things out of the Trash only with Full Disk Access (System Settings → Privacy & Security)')
    }
    return err as Error
  }

  return {
    async trash(path) {
      const before = await host.lstat(path)
      let res: { path: string } | { error: number; message: string }
      try {
        res = JSON.parse(await host.run('osascript', ['-l', 'JavaScript', '-e', MAC_TRASH_SCRIPT, path]))
      } catch {
        // No osascript (a locked-down Mac) or no answer: the plain OS trash, without undo — unless it went already.
        if (await exists(path)) await trashItem(path)
        return undefined
      }
      if ('error' in res) throw coded(COCOA_ERRORS[res.error] ?? 'trash-failed', res.message)
      known.set(res.path, before.ino)
      return res.path
    },

    async restore(trashed, to) {
      const at = posix.resolve(trashed)
      if (!isTrash(posix.dirname(at))) throw coded('bad-path', 'Not an item in the trash')
      const inHome = posix.dirname(at) === homeTrash
      const st = await host.lstat(at).catch((err: unknown) => {
        throw explain(err, inHome)
      })
      const ino = known.get(at)
      if (ino !== undefined && ino !== st.ino) throw trashGone()
      await host.rename(at, to).catch((err: unknown) => {
        throw explain(err, inHome)
      })
      known.delete(at)
    }
  }
}
