import { lstatSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

/**
 * Resolve `rel` inside `root`, following symlinks; refuses anything outside
 * (`outside-project`). The deepest existing ancestor decides, so the target
 * itself may not exist yet. Shared by the agent's file tools and the editor.
 */
export async function confine(root: string, rel: string): Promise<string> {
  const rootReal = await realpath(root)
  const target = resolve(rootReal, rel)
  const outside = () => Object.assign(new Error('Path is outside the project'), { code: 'outside-project' })
  // lstat, not exists: a dangling symlink is an entry whose target we cannot check — writing through it
  // would create that target wherever it points.
  const present = (p: string) => {
    try {
      lstatSync(p)
      return true
    } catch {
      return false
    }
  }
  let probe = target
  // dirname() of a root is the root itself: a path on a drive that doesn't exist (Windows `Z:\…`) must not loop forever.
  while (!present(probe) && dirname(probe) !== probe) probe = dirname(probe)
  // null: a dangling link, or (Windows) a drive that does not exist — refused either way.
  const real = await realpath(probe).catch(() => null)
  const inside = (p: string) => p === rootReal || p.startsWith(rootReal + sep)
  if (real === null || !inside(target) || !inside(real)) throw outside()
  return target
}
