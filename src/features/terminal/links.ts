import type { IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { ipc } from '@shared/ipc/client'
import type { Project } from '@shared/types/project'

/** A file reference found in terminal output: `src/a.ts:12:5`, `./b.py`, `/x/c.go(3,1)`. */
export interface PathMatch {
  /** Offset in the text and the matched text (with the line suffix). */
  index: number
  text: string
  path: string
  line?: number
}

// A path (absolute, ~/, ./, ../, C:\ or relative with folders) to a file with an
// extension, optionally :line[:col] or (line[,col]). Not inside URLs or words.
const PATH = /(?<![\w/.~:\\-])((?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.@+-]+[\\/])*[\w@+-][\w.@+-]*\.[A-Za-z][\w]*)(?::(\d+)(?::\d+)?|\((\d+)(?:,\s*\d+)?\))?/g

/** The file references in one line of output. */
export function findPaths(text: string): PathMatch[] {
  return [...text.matchAll(PATH)].map((m) => {
    const line = Number(m[2] ?? m[3])
    return { index: m.index!, text: m[0], path: m[1], ...(line ? { line } : {}) }
  })
}

/** Joins and normalizes like path.resolve, for POSIX and Windows paths (keeps the base's separator). */
export function resolvePath(base: string, path: string, home?: string): string | undefined {
  const win = /^[A-Za-z]:/.test(path) || (/^[A-Za-z]:/.test(base) && !path.startsWith('/'))
  let full: string
  if (/^([A-Za-z]:)?[\\/]/.test(path)) full = path
  else if (/^~[\\/]/.test(path)) {
    if (!home) return undefined
    full = `${home}/${path.slice(2)}`
  } else full = `${base}/${path}`
  const [, drive = ''] = /^([A-Za-z]:)?/.exec(full)!
  const parts: string[] = []
  for (const part of full.slice(drive.length).split(/[\\/]/)) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  const sep = win ? '\\' : '/'
  return `${drive}${sep}${parts.join(sep)}`
}

/** Home, read off a folder and its `~` label (`/home/u/x` + `~/x` → `/home/u`). */
export function homeOf(cwd: string, cwdLabel: string): string | undefined {
  if (cwdLabel === '~') return cwd
  return cwdLabel.startsWith('~') && cwd.endsWith(cwdLabel.slice(1)) ? cwd.slice(0, cwd.length - cwdLabel.length + 1) : undefined
}

/** A file that opens in the editor: its project and path in it. */
export interface ProjectFile {
  projectId: string
  path: string
}

let projects: { list: Project[]; at: number } | undefined
const PROJECTS_TTL = 10_000

/** The registered project an absolute path lies in, with the path relative to it (`/`-separated). */
export async function projectFile(abs: string): Promise<ProjectFile | undefined> {
  if (!projects || Date.now() - projects.at > PROJECTS_TTL) {
    projects = { list: await ipc('projects:list').catch(() => []), at: Date.now() }
  }
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const target = norm(abs)
  const project = projects.list.filter((p) => target.startsWith(`${norm(p.path)}/`)).sort((a, b) => b.path.length - a.path.length)[0]
  return project && { projectId: project.id, path: target.slice(norm(project.path).length + 1) }
}

/** Forget the cached project list (tests; a project was added). */
export function resetProjectCache(): void {
  projects = undefined
}

/** A row's text and, per character, the column it sits in (wide characters take two cells). */
export function rowText(line: IBufferLine): { text: string; cols: number[] } {
  let text = ''
  const cols: number[] = []
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x)!
    if (!cell.getWidth()) continue // the second half of a wide character
    const chars = cell.getChars() || ' '
    text += chars
    for (let i = 0; i < chars.length; i += 1) cols.push(x)
  }
  return { text, cols }
}

/**
 * Clickable file references (`path:line`) in a terminal: resolved against the
 * shell's current folder, linked only when the file exists in a registered
 * project — the Mindeck editor opens it there, on that line.
 */
export function fileLinkProvider(
  term: Terminal,
  where: () => { cwd: string; cwdLabel: string },
  open: (file: ProjectFile, line: number) => void
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)
      const row = line ? rowText(line) : { text: '', cols: [] }
      const matches = findPaths(row.text)
      if (!matches.length) return callback(undefined)
      const { cwd, cwdLabel } = where()
      const home = homeOf(cwd, cwdLabel)
      void Promise.all(
        matches.map(async (m): Promise<ILink | undefined> => {
          const abs = resolvePath(cwd, m.path, home)
          const file = abs ? await projectFile(abs) : undefined
          if (!file) return undefined
          const [stat] = await ipc('files:stat', { projectId: file.projectId, paths: [file.path] }).catch(() => [null])
          if (!stat) return undefined
          return {
            text: m.text,
            // 1-based, inclusive cells
            range: { start: { x: row.cols[m.index] + 1, y }, end: { x: row.cols[m.index + m.text.length - 1] + 1, y } },
            activate: () => open(file, m.line ?? 1)
          }
        })
      ).then((links) => {
        const found = links.filter((l): l is ILink => !!l)
        callback(found.length ? found : undefined)
      })
    }
  }
}
