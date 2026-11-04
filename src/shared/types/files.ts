// Project files for the editor: a lazily listed tree, text reads, and writes
// that refuse to clobber a file someone else changed since it was opened.
// Pure module (no DOM/Node/Electron) so it compiles under every tsconfig.

export interface FileEntry {
  name: string
  /** Posix path relative to the project root. */
  path: string
  kind: 'file' | 'dir'
  /** Matched by the project's .gitignore (shown dimmed, like VS Code). */
  ignored: boolean
}

export interface FileStat {
  mtimeMs: number
  size: number
}

export interface FileContent extends FileStat {
  path: string
  /** UTF-8 text; absent when the file can't be edited (see `unsupported`). */
  content?: string
  /** `encoding`: text, but not UTF-8 (opened as UTF-8, the next save would damage it). */
  unsupported?: 'binary' | 'too-large' | 'encoding'
}
