import { mkdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, extname, join, sep } from 'node:path'
import { coded, nodeTrashHost, trashGone, type RestorableTrash, type TrashHost } from './trashHost'
import { macTrash } from './trashMac'
import { windowsTrash } from './trashWindows'

export type { RestorableTrash, TrashHost } from './trashHost'

/** `YYYY-MM-DDThh:mm:ss` in local time, as the spec wants it. */
function deletionDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export interface DesktopTrashOptions {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
  /** The OS trash as Electron offers it (no way back) — where the restorable one cannot be used. */
  trashItem: (path: string) => Promise<void>
  host?: TrashHost
  /** The user's id — macOS names its trash on other disks after it (default: this process's user). */
  uid?: number
}

/** The desktop's undoable trash; undefined on systems without one. */
export function desktopTrash(opts: DesktopTrashOptions): RestorableTrash | undefined {
  const host = opts.host ?? nodeTrashHost
  if (opts.platform === 'linux') return freedesktopTrash(opts.env.XDG_DATA_HOME || join(opts.home, '.local', 'share'))
  if (opts.platform === 'darwin') return macTrash({ home: opts.home, uid: opts.uid ?? userInfo().uid, host, trashItem: opts.trashItem })
  if (opts.platform === 'win32') return windowsTrash({ host, trashItem: opts.trashItem })
  return undefined
}

export function freedesktopTrash(dataHome: string, now: () => Date = () => new Date()): RestorableTrash {
  const root = join(dataHome, 'Trash')
  const files = join(root, 'files')
  const info = join(root, 'info')

  return {
    async trash(path) {
      await mkdir(files, { recursive: true, mode: 0o700 })
      await mkdir(info, { recursive: true, mode: 0o700 })
      const ext = extname(basename(path))
      const stem = basename(path).slice(0, basename(path).length - ext.length)
      // The .trashinfo file is created first (exclusively): it reserves the name.
      for (let n = 1; ; n += 1) {
        const name = n === 1 ? basename(path) : `${stem}.${n}${ext}`
        const record = join(info, `${name}.trashinfo`)
        const body = `[Trash Info]\nPath=${path.split(sep).map(encodeURIComponent).join('/')}\nDeletionDate=${deletionDate(now())}\n`
        try {
          await writeFile(record, body, { flag: 'wx', mode: 0o600 })
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
          throw err
        }
        try {
          await rename(path, join(files, name))
        } catch (err) {
          await unlink(record).catch(() => {})
          throw err
        }
        return join(files, name)
      }
    },

    async restore(trashed, to) {
      // Only what lies directly in this trash — never a path from elsewhere.
      const real = await realpath(trashed).catch(() => {
        throw trashGone()
      })
      const realFiles = await realpath(files)
      const name = basename(real)
      if (join(realFiles, name) !== real) throw coded('bad-path', 'Not an item in the trash')
      await rename(real, to)
      await rm(join(info, `${name}.trashinfo`), { force: true })
    }
  }
}
