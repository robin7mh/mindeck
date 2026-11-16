import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, relative } from 'node:path'
import { z } from 'zod'
import type { Project } from '@shared/types/project'
import type { ProjectContext } from '@shared/types/context'
import type { Note, NoteMeta, SearchHit } from '@shared/types/memory'
import type { SystemSnapshot } from '@shared/types/system'
import type { ToolContext, ToolDefinition } from './types'
import { confine } from '../../../lib/confine'

const MAX_READ = 100 * 1024
const MAX_OUTPUT = 30_000
const MAX_LIST = 300
const SHELL_TIMEOUT_MS = 120_000
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'coverage', '.next', '.venv', '__pycache__'])

/** Services the built-in tools act through (never fs/child_process directly, except confined project files). */
export interface ToolDeps {
  vault: {
    search(query: string): Promise<SearchHit[]>
    read(path: string): Promise<Note>
    list(): Promise<NoteMeta[]>
    create(title: string, folder?: string): Promise<NoteMeta>
    writeBody(path: string, body: string): Promise<NoteMeta>
  }
  projects: { list(): Project[] }
  context: { get(id: string): Promise<ProjectContext | null>; reindex(id: string): Promise<ProjectContext> }
  system: { snapshot(): Promise<SystemSnapshot> }
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export function truncate(text: string, max = MAX_OUTPUT): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]` : text
}

const reason = z.string().min(1).max(500).describe('One sentence for the user: why this action is needed')
const projectId = z.string().max(200).optional().describe('Project id (defaults to the conversation project)')

export function builtinTools(deps: ToolDeps): ToolDefinition<never>[] {
  const project = (id: string | undefined, ctx: ToolContext): Project => {
    const wanted = id || ctx.projectId
    if (!wanted) throw coded('no-project', 'No project selected — pass projectId (see projects_list)')
    // Pinned to its project, another one is "unknown" (not even whether it exists is told).
    const allowed = ctx.onlyProject ? deps.projects.list().filter((x) => x.id === ctx.projectId) : deps.projects.list()
    const p = allowed.find((x) => x.id === wanted || x.name === wanted)
    if (!p) throw coded('no-project', `Unknown project: ${wanted}`)
    return p
  }

  const tools = [
    {
      name: 'memory_search',
      title: 'Search memory',
      description: 'Full-text search over the user\'s memory vault (Obsidian notes). Returns matching note paths with snippets.',
      risk: 'read',
      schema: z.object({ query: z.string().min(1).max(500) }),
      summarize: ({ query }) => `Search the memory vault for "${query}"`,
      async run({ query }) {
        const hits = await deps.vault.search(query)
        if (!hits.length) return 'No matching notes.'
        return hits.slice(0, 20).map((h) => `- ${h.path} (${h.title}): ${h.snippet}`).join('\n')
      }
    } satisfies ToolDefinition<{ query: string }>,
    {
      name: 'memory_read',
      title: 'Read note',
      description: 'Read one note from the memory vault by its vault-relative path (e.g. "Projekte/Mindeck.md").',
      risk: 'read',
      schema: z.object({ path: z.string().min(1).max(1024) }),
      summarize: ({ path }) => `Read the note ${path}`,
      async run({ path }) {
        const note = await deps.vault.read(path)
        const back = note.backlinks.map((b) => b.title).join(', ')
        return truncate(`# ${note.title}\n${note.tags.length ? `tags: ${note.tags.join(', ')}\n` : ''}${back ? `linked from: ${back}\n` : ''}\n${note.body}`)
      }
    } satisfies ToolDefinition<{ path: string }>,
    {
      name: 'memory_list',
      title: 'List notes',
      description: 'List notes in the memory vault, optionally only inside one folder.',
      risk: 'read',
      schema: z.object({ folder: z.string().max(1024).optional() }),
      summarize: ({ folder }) => (folder ? `List the notes in ${folder}` : 'List the notes in the vault'),
      async run({ folder }) {
        const notes = (await deps.vault.list()).filter((n) => !folder || n.path.startsWith(`${folder.replace(/\/$/, '')}/`))
        if (!notes.length) return 'No notes.'
        const lines = notes.slice(0, MAX_LIST).map((n) => `- ${n.path}${n.tags.length ? ` [${n.tags.join(', ')}]` : ''}`)
        return lines.join('\n') + (notes.length > MAX_LIST ? `\n… and ${notes.length - MAX_LIST} more` : '')
      }
    } satisfies ToolDefinition<{ folder?: string }>,
    {
      name: 'memory_create_note',
      title: 'Create note',
      description: 'Create a new note in the memory vault (Markdown, [[wikilinks]] allowed). Never overwrites: a number is appended if the title exists.',
      risk: 'write',
      schema: z.object({
        title: z.string().min(1).max(200),
        folder: z.string().max(1024).optional(),
        body: z.string().max(200_000),
        reason
      }),
      summarize: ({ title, folder }) => `Create the note "${title}"${folder ? ` in ${folder}` : ''}`,
      async run({ title, folder, body }) {
        const meta = await deps.vault.create(title, folder)
        await deps.vault.writeBody(meta.path, body)
        return `Created ${meta.path}`
      }
    } satisfies ToolDefinition<{ title: string; folder?: string; body: string; reason: string }>,
    {
      name: 'memory_append',
      title: 'Append to note',
      description: 'Append Markdown text to the end of an existing note in the memory vault.',
      risk: 'write',
      schema: z.object({ path: z.string().min(1).max(1024), text: z.string().min(1).max(100_000), reason }),
      summarize: ({ path }) => `Append text to the note ${path}`,
      async run({ path, text }) {
        const note = await deps.vault.read(path)
        const body = note.body.replace(/\s*$/, '')
        await deps.vault.writeBody(path, body ? `${body}\n\n${text}\n` : `${text}\n`)
        return `Appended to ${path}`
      }
    } satisfies ToolDefinition<{ path: string; text: string; reason: string }>,
    {
      name: 'projects_list',
      title: 'List projects',
      description: 'List the projects registered in Mindeck (id, name, path, git branch, stack).',
      risk: 'read',
      schema: z.object({}),
      summarize: () => 'List the registered projects',
      async run() {
        const list = deps.projects.list()
        if (!list.length) return 'No projects registered.'
        return list
          .map((p) => {
            const stack = [...(p.stack?.languages ?? []), ...(p.stack?.frameworks ?? [])].join(', ')
            const git = p.git?.isRepo ? ` · ${p.git.branch ?? 'detached'}${p.git.dirty ? ' (uncommitted changes)' : ''}` : ''
            return `- ${p.name} (id ${p.id}) ${p.path}${git}${stack ? ` · ${stack}` : ''}`
          })
          .join('\n')
      }
    } satisfies ToolDefinition<Record<string, never>>,
    {
      name: 'project_context',
      title: 'Project overview',
      description: 'Structural overview of a project: languages, frameworks, dependencies, config files, file tree (top levels), README sections and TODO markers.',
      risk: 'read',
      schema: z.object({ projectId }),
      summarize: ({ projectId: id }) => `Read the structure of project ${id ?? '(current)'}`,
      async run({ projectId: id }, ctx) {
        const p = project(id, ctx)
        const c = (await deps.context.get(p.id)) ?? (await deps.context.reindex(p.id))
        return truncate(formatContext(p, c))
      }
    } satisfies ToolDefinition<{ projectId?: string }>,
    {
      name: 'project_list_files',
      title: 'List files',
      description: 'List the entries of one directory inside a project (dependency and build folders are skipped).',
      risk: 'read',
      schema: z.object({ projectId, dir: z.string().max(2048).optional() }),
      summarize: ({ dir }) => `List the files in ${dir || 'the project root'}`,
      async run({ projectId: id, dir }, ctx) {
        const p = project(id, ctx)
        const abs = await confine(p.path, dir || '.')
        const entries = await readdir(abs, { withFileTypes: true })
        const lines = entries
          .filter((e) => !SKIP_DIRS.has(e.name))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .slice(0, MAX_LIST)
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        return lines.length ? lines.join('\n') : '(empty)'
      }
    } satisfies ToolDefinition<{ projectId?: string; dir?: string }>,
    {
      name: 'project_read_file',
      title: 'Read file',
      description: 'Read a text file inside a project (path relative to the project root, max 100 KB).',
      risk: 'read',
      schema: z.object({ projectId, path: z.string().min(1).max(2048) }),
      summarize: ({ path }) => `Read the file ${path}`,
      async run({ projectId: id, path }, ctx) {
        const p = project(id, ctx)
        const abs = await confine(p.path, path)
        const info = await stat(abs)
        if (!info.isFile()) throw coded('not-a-file', `${path} is not a file`)
        if (info.size > MAX_READ) throw coded('too-large', `${path} is ${Math.round(info.size / 1024)} KB — larger than 100 KB`)
        const buf = await readFile(abs)
        if (buf.includes(0)) throw coded('binary', `${path} is a binary file`)
        return buf.toString('utf8')
      }
    } satisfies ToolDefinition<{ projectId?: string; path: string }>,
    {
      name: 'project_write_file',
      title: 'Write file',
      description: 'Create or overwrite a text file inside a project (path relative to the project root). Prefer small, focused changes; the user approves every write.',
      risk: 'write',
      schema: z.object({ projectId, path: z.string().min(1).max(2048), content: z.string().max(500_000), reason }),
      summarize: ({ path, content }) => `Write ${content.length} characters to ${path}`,
      async run({ projectId: id, path, content }, ctx) {
        const p = project(id, ctx)
        const abs = await confine(p.path, path)
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, content, 'utf8')
        return `Wrote ${relative(await realpath(p.path), abs)} (${content.length} characters)`
      }
    } satisfies ToolDefinition<{ projectId?: string; path: string; content: string; reason: string }>,
    {
      name: 'shell_run',
      title: 'Run command',
      description: 'Run a shell command in a project folder (non-interactive, 2-minute limit) and return its output. Use for builds, tests, git status and the like. The user approves every command.',
      risk: 'execute',
      schema: z.object({ projectId, command: z.string().min(1).max(4000), reason }),
      summarize: ({ command }) => `Run: ${command}`,
      async run({ projectId: id, command }, ctx) {
        const p = project(id, ctx)
        return runShell(command, p.path, ctx.signal)
      }
    } satisfies ToolDefinition<{ projectId?: string; command: string; reason: string }>,
    {
      name: 'system_snapshot',
      title: 'System status',
      description: 'Current machine telemetry: CPU, memory, disk, battery, uptime and the top processes.',
      risk: 'read',
      schema: z.object({}),
      summarize: () => 'Read the current system status',
      async run() {
        const s = await deps.system.snapshot()
        const procs = s.processes.slice(0, 8).map((p) => `${p.name} (cpu ${p.cpu.toFixed(1)}%, ${Math.round(p.mem)} MB)`).join(', ')
        return [
          `CPU ${Math.round(s.cpu.total)}% (${s.cpu.cores.length} cores)`,
          `Memory ${Math.round(s.mem.usedPct)}% (${s.mem.usedGb.toFixed(1)} / ${s.mem.totalGb.toFixed(1)} GB)`,
          `Disk ${Math.round(s.disk.usedPct)}% used on ${s.disk.mount}`,
          s.battery.hasBattery ? `Battery ${Math.round(s.battery.pct)}%${s.battery.charging ? ' (charging)' : ''}` : 'No battery',
          `Uptime ${Math.round(s.uptimeSec / 3600)} h`,
          procs ? `Top processes: ${procs}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      }
    } satisfies ToolDefinition<Record<string, never>>
  ]
  return tools as unknown as ToolDefinition<never>[]
}

export function formatContext(p: Project, c: ProjectContext): string {
  const deps = c.dependencies.slice(0, 40).map((d) => `${d.name}@${d.version}${d.dev ? ' (dev)' : ''}`)
  const tree = c.tree.slice(0, 120).map((n) => (n.type === 'dir' ? `${n.path}/` : n.path))
  const todos = c.todos.slice(0, 30).map((t) => `${t.file}:${t.line} ${t.kind} ${t.text}`)
  return [
    `Project ${p.name} (${p.path})`,
    `Files ${c.fileCount}, folders ${c.dirCount}${c.truncated ? ' (scan truncated)' : ''} · indexed ${c.indexedAt}`,
    c.languages.length ? `Languages: ${c.languages.join(', ')}` : '',
    c.frameworks.length ? `Frameworks: ${c.frameworks.join(', ')}` : '',
    c.packageJson?.scripts.length ? `Scripts: ${c.packageJson.scripts.join(', ')}` : '',
    c.configFiles.length ? `Config: ${c.configFiles.map((f) => `${f.name} (${f.kind})`).join(', ')}` : '',
    deps.length ? `Dependencies: ${deps.join(', ')}` : '',
    c.readme ? `README${c.readme.title ? ` "${c.readme.title}"` : ''}: ${c.readme.sections.join(' · ')}` : '',
    tree.length ? `Tree:\n${tree.join('\n')}` : '',
    todos.length ? `TODOs:\n${todos.join('\n')}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/** Non-interactive login shell in `cwd`; exit code, stdout and stderr as one text. */
export function runShell(command: string, cwd: string, signal: AbortSignal, timeout = SHELL_TIMEOUT_MS): Promise<string> {
  const win = process.platform === 'win32'
  const file = win ? 'powershell.exe' : process.env.SHELL || '/bin/sh'
  const args = win ? ['-NoProfile', '-Command', command] : ['-lc', command]
  return new Promise((resolveRun) => {
    execFile(file, args, { cwd, timeout, signal, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null
      const code = e ? (typeof e.code === 'number' ? e.code : e.killed ? 'killed (timeout or cancel)' : String(e.code)) : 0
      resolveRun(truncate(`exit code: ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`))
    })
  })
}
