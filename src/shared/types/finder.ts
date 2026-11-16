// The Files module: the machine's files, like Finder — browse, preview, move,
// open. Pure module (no DOM/Node/Electron) so it compiles under both tsconfigs.

export interface FinderEntry {
  name: string
  /** Absolute path. */
  path: string
  kind: 'dir' | 'file'
  /** Bytes (files); 0 for folders. */
  size: number
  mtimeMs: number
  /** Starts with a dot. */
  hidden: boolean
  /** A symbolic link (`kind` is what it points to). */
  link?: boolean
  /** A macOS bundle (.app, …): shown and opened like a file. */
  bundle?: boolean
}

/** One page of a folder (huge folders come in pages, so the first ones show at once). */
export interface FinderListing {
  path: string
  /** null at the root. */
  parent: string | null
  entries: FinderEntry[]
  /** Entries in the folder in all (shown ones — hidden files only when asked for). */
  total: number
  /** Where this page starts. */
  offset: number
}

/** What happens to an entry whose name is taken where it goes. */
export type ConflictChoice = 'replace' | 'keep' | 'skip'

export interface TransferRequest {
  /** Names the operation for `finder:progress` and `finder:cancel`. */
  id: string
  paths: string[]
  dest: string
  mode: 'copy' | 'move'
  /** By name; unlisted conflicts keep both ("name 2"). */
  choices?: Record<string, ConflictChoice>
}

/** Something moved to the trash; `restore` (where it lies) when Mindeck can put it back. */
export interface TrashedItem {
  path: string
  restore?: string
}

/** Undo of a trash: where each came back to (a taken name keeps both), and what had left the trash since. */
export interface UntrashResult {
  items: { path: string; to: string }[]
  gone: string[]
}

export interface TransferResult {
  /** What went where. */
  items: { from: string; to: string }[]
  /** Entries that were in the way ("Replace") — now in the trash. */
  replaced: TrashedItem[]
  skipped: string[]
  /** Stopped by the user: `items` is what was done until then. */
  cancelled?: boolean
}

/** A long operation running: bytes done of total (0 = not known yet). */
export interface FinderProgress {
  id: string
  kind: 'copy' | 'move' | 'zip' | 'unzip' | 'size'
  done: number
  total: number
  /** The file at hand. */
  file?: string
  finished?: boolean
}

/** The Info panel: everything about one entry. */
export interface FinderInfo {
  entry: FinderEntry
  createdMs: number
  accessedMs: number
  /** Unix permission bits (e.g. 0o644). */
  mode: number
  /** The owner's name when it is the user; null when someone else (or unknown). */
  owner: string | null
  /** Mindeck may change it (inside Home or on an external drive). */
  writable: boolean
}

export interface FolderSize {
  bytes: number
  files: number
  folders: number
  /** Counting stopped early (time limit or cancelled): the numbers are a minimum. */
  partial: boolean
}

/** A piece of a file read for another device (`finder:read`): base64, at most FINDER_CHUNK bytes. */
export interface FinderChunk {
  /** Base64 of the bytes from `offset`. */
  data: string
  offset: number
  /** The whole file's size. */
  size: number
  mime: string
  /** This piece reaches the end. */
  eof: boolean
}

/** The most a `finder:read` or `finder:write` moves at once (a remote request body stays below 8 MB). */
export const FINDER_CHUNK = 4 * 1024 * 1024

/** The usual places — each only when it exists. */
export type FinderPlaceId = 'home' | 'desktop' | 'documents' | 'downloads' | 'pictures' | 'movies' | 'music'

export interface FinderPlaces {
  home: string
  places: { id: FinderPlaceId; path: string }[]
  /** External drives and partitions. */
  volumes: { name: string; path: string }[]
}

export interface FinderPreview {
  entry: FinderEntry
  type: FileType | 'dir'
  /** 'dir': how many entries it holds. */
  items?: number
  /** 'text': the beginning of the file. */
  text?: string
  truncated?: boolean
}

export type FileType = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'binary'

const TYPES: Record<Exclude<FileType, 'text' | 'binary'>, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'heic', 'tif', 'tiff'],
  video: ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'flac', 'opus'],
  pdf: ['pdf']
}

const TEXT = new Set([
  'txt', 'md', 'markdown', 'mdx', 'json', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'ini', 'env', 'csv', 'tsv', 'log', 'xml', 'html', 'htm',
  'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'astro', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'graphql', 'gql', 'proto',
  'lua', 'dart', 'r', 'scala', 'ex', 'exs', 'erl', 'clj', 'hs', 'ml', 'tf', 'dockerfile', 'gitignore', 'editorconfig', 'lock', 'conf', 'cfg'
])

/** The file's extension in lower case, without the dot ('' when it has none; dotfiles count as their name). */
export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return ''
  if (dot === 0) return name.slice(1).toLowerCase()
  return name.slice(dot + 1).toLowerCase()
}

/** What a file is, by its name: media for the viewer, text for the reader, else binary. */
export function fileType(name: string): FileType {
  const ext = extOf(name)
  for (const [type, exts] of Object.entries(TYPES)) if (exts.includes(ext)) return type as FileType
  if (TEXT.has(ext) || /^(readme|license|makefile|dockerfile|procfile)$/i.test(name)) return 'text'
  return 'binary'
}
