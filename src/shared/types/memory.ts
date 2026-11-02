// Memory = an Obsidian-compatible markdown vault (architecture §5, §11.2).
// Files are the source of truth; everything here is a read model computed from
// them. Pure module (no DOM/Node/Electron) so it compiles under both tsconfigs.

/** Graph coloring: one color per top-level folder, or a single accent. */
export type GraphColorMode = 'colorful' | 'single'

/** Palette keys — mapped to CSS tokens in the renderer (`--graph-<key>`). */
export const GRAPH_COLORS = ['cyan', 'blue', 'purple', 'pink', 'amber', 'green', 'orange', 'lime'] as const
export type GraphColor = (typeof GRAPH_COLORS)[number]

export interface GraphStyle {
  mode: GraphColorMode
  /** Used in `single` mode. */
  color: GraphColor
}

export const DEFAULT_GRAPH_STYLE: GraphStyle = { mode: 'colorful', color: 'cyan' }

export interface VaultStatus {
  /** Absolute vault root (configured, or the default location). */
  root: string
  /** Where "Create Mindeck vault" puts a new vault. */
  defaultRoot: string
  /** Folder name shown in the UI. */
  name: string
  isDefault: boolean
  /** False until the vault folder exists (it is created lazily, never at boot). */
  exists: boolean
  noteCount: number
  graphStyle: GraphStyle
  dailyNotes: DailyNotesSettings
}

/** Vault-relative POSIX path, e.g. `Projekte/Mindeck.md`. Identity in the UI. */
export type NotePath = string

export interface NoteMeta {
  path: NotePath
  /** Filename without `.md` — what `[[wikilinks]]` resolve against. */
  title: string
  /** Top-level folder ('' for the vault root) — drives colorful graph groups. */
  folder: string
  tags: string[]
  /** Frontmatter `type` (personal, project, decision, …) if present. */
  type?: string
  modifiedAt: string
  /** Outgoing + incoming resolved links. */
  linkCount: number
}

export interface Note extends NoteMeta {
  /** Full file text, frontmatter included — what the editor edits. */
  raw: string
  /** Body without the frontmatter block — what the preview renders. */
  body: string
  /** Parsed YAML frontmatter (empty when absent or invalid). */
  frontmatter: Record<string, unknown>
  /** Notes linking here. */
  backlinks: NoteMeta[]
  /** Each outgoing link target as written → resolved note path (null = unresolved). */
  links: Record<string, NotePath | null>
}

export interface GraphNode {
  /** NotePath for files; `ghost:<target>` for unresolved links. */
  id: string
  title: string
  folder: string
  /** Unresolved `[[link]]` with no file behind it (Obsidian shows these too). */
  ghost: boolean
  degree: number
}

export interface GraphEdge {
  source: string
  target: string
}

export interface MemoryGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface SearchHit {
  path: NotePath
  title: string
  /** The best stretch of the note (whitespace collapsed, `…` where cut). */
  snippet: string
  /** [from, to) of each match within `snippet`. */
  matches?: [number, number][]
  /** [from, to) of each match within `title`. */
  titleMatches?: [number, number][]
}

/** Daily notes: one note per day, `YYYY-MM-DD.md` in `folder`, started from `template`. */
export interface DailyNotesSettings {
  /** Vault-relative folder ('' = the vault root). */
  folder: string
  /** Vault-relative path of the template note ('' = start empty). */
  template: string
}

export const DEFAULT_DAILY_NOTES: DailyNotesSettings = { folder: 'Daily', template: '' }

/** Where templates live (Obsidian's core plugin default). */
export const TEMPLATES_FOLDER = 'Templates'
/** Where pasted and dropped files go. */
export const ATTACHMENTS_FOLDER = 'attachments'

/** Pictures a note can show inline (`![[x.png]]`, `![](x.png)`). */
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'] as const

/** Files that sit next to notes and are linked, not notes themselves. */
const ATTACHMENT_EXTS = new Set<string>([...IMAGE_EXTS, 'heic', 'tif', 'tiff', 'pdf', 'mp3', 'wav', 'm4a', 'ogg', 'flac', 'mp4', 'mov', 'webm', 'mkv', 'zip', 'csv', 'canvas'])

/** `[[bild.png]]` points at an attachment, `[[Notiz]]` / `[[v1.2 Plan]]` at a note. */
export function isAttachmentTarget(target: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(target.trim())
  return !!m && ATTACHMENT_EXTS.has(m[1].toLowerCase())
}

/** `bild.PNG` → a picture Mindeck shows inline. */
export function isImageTarget(target: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(target.trim())
  return !!m && (IMAGE_EXTS as readonly string[]).includes(m[1].toLowerCase())
}

/** A vault file for the renderer: a picture as a data: URL. */
export interface VaultAttachment {
  /** Vault-relative path. */
  path: string
  mime: string
  dataUrl: string
}

/** Pushed after any vault change (Mindeck's own writes or external edits). */
export interface MemoryChanged {
  /** Changed paths, or undefined after a full rescan. */
  paths?: NotePath[]
}
