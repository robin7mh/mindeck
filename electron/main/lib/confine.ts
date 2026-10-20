import { existsSync, type Stats } from 'node:fs'
import { lstat, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

/** Links followed at most (the OS gives up after 40 too: ELOOP). */
const MAX_LINKS = 40

/**
 * Resolve `rel` inside `root`, following symlinks; refuses anything outside
 * (`outside-project`). The deepest existing ancestor decides, so the target
 * itself may not exist yet. Shared by the agent's file tools and the editor.
 * A path that is outside as written is refused before the disk is asked:
 * on Windows, merely looking at `\\host\share` sends the user's credentials there.
 *
 * A dangling link counts as what it points to: writing to it creates its
 * target, so `notes.md -> ../../.config/autostart/x.desktop` is outside even
 * while that file does not exist (links to links are followed too).
 */
export async function confine(root: string, rel: string): Promise<string> {
  const rootReal = await realpath(root)
  const target = resolve(rootReal, rel)
  const inside = (p: string) => p === rootReal || p.startsWith(rootReal + sep)
  const outside = () => Object.assign(new Error('Path is outside the project'), { code: 'outside-project' })
  if (!inside(target)) throw outside()
  // What exists is where it really is; anything else is where a write would land.
  const real = await realpath(target).catch(() => null)
  if (real) {
    if (!inside(real)) throw outside()
    return target
  }
  const landing = await follow(rootReal, relative(rootReal, target), { links: 0 }).catch(() => {
    throw outside()
  })
  let probe = landing
  while (!existsSync(probe)) probe = dirname(probe)
  if (!inside(join(await realpath(probe), relative(probe, landing)))) throw outside()
  return target
}

/**
 * Walks `path` from the real folder `base` the way the OS does when it
 * creates a file: links resolve where they are (dangling ones too, `..`
 * inside them from the folder they lead to), and the first missing name ends
 * the walk — the rest is only ever created as written.
 */
async function follow(base: string, path: string, seen: { links: number }): Promise<string> {
  let at = base
  let exists = true
  for (const name of path.split(/[\\/]+/)) {
    if (!name || name === '.') continue
    if (name === '..') {
      at = dirname(at)
      continue
    }
    const next = join(at, name)
    const info: Stats | null = exists ? await lstat(next).catch(() => null) : null
    if (!info?.isSymbolicLink()) {
      exists &&= !!info
      at = next
      continue
    }
    const link = await readlink(next)
    // Too many links (a loop) — or one to another machine (`\\host\share`: asking it sends the user's credentials).
    if (++seen.links > MAX_LINKS || /^[\\/]{2}/.test(link)) throw new Error('Unsafe link')
    at = await follow(isAbsolute(link) ? parse(link).root : at, isAbsolute(link) ? relative(parse(link).root, link) : link, seen)
    exists = existsSync(at)
  }
  return at
}
