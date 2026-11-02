// Language intelligence for the editor: TypeScript / JavaScript through the
// project's own tsserver (what VS Code runs), positions 1-based like both
// tsserver and Monaco. Paths are relative to the project root.
// Pure module (no DOM/Node/Electron) so it compiles under every tsconfig.

export interface LspPosition {
  line: number
  offset: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspTextEdit {
  range: LspRange
  newText: string
}

/** Edits to one file of the project. */
export interface LspFileEdits {
  path: string
  edits: LspTextEdit[]
}

export interface LspLocation {
  path: string
  range: LspRange
}

export interface LspDiagnostic {
  range: LspRange
  message: string
  severity: 'error' | 'warning' | 'suggestion' | 'info'
  /** TypeScript's error number, or a language server's rule name. */
  code?: number | string
  /** Which tool reported it (Pyright, clangd, …). */
  source?: string
  /** Unused code (shown faded). */
  unnecessary?: boolean
  deprecated?: boolean
}

export interface LspHover {
  /** The symbol's signature, as TypeScript prints it. */
  display: string
  /** Its documentation (markdown), JSDoc tags included. */
  documentation: string
  /** A language server's hover, already markdown (instead of display + documentation). */
  markdown?: string
  range?: LspRange
}

export interface LspCompletion {
  name: string
  /** tsserver's ScriptElementKind (`function`, `property`, …). */
  kind: string
  sortText: string
  insertText?: string
  snippet?: boolean
  /** The span the completion replaces (else the word at the cursor). */
  replacement?: LspRange
  /** Module an auto-import would come from. */
  source?: string
  /** A language server's short description (the type, the signature). */
  detail?: string
  /** Opaque data the details request needs back. */
  data?: unknown
}

export interface LspCompletionDetails {
  detail: string
  documentation: string
  /** Extra edits in the same file (the import an auto-import completion adds). */
  edits: LspTextEdit[]
}

export interface LspSignature {
  items: { label: string; documentation: string; parameters: { label: string; documentation: string }[] }[]
  active: number
  activeParameter: number
}

export interface LspCodeFix {
  title: string
  files: LspFileEdits[]
}

/** A symbol of a file (a class, a function, a heading …) — LSP's DocumentSymbol, for the outline. */
export interface LspSymbol {
  name: string
  detail?: string
  /** LSP's SymbolKind (1 file … 26 type parameter). */
  kind: number
  /** All of it. */
  range: LspRange
  /** Its name. */
  selection: LspRange
  children: LspSymbol[]
}

export interface LspRename {
  /** Why the symbol can't be renamed. */
  error?: string
  files: LspFileEdits[]
}
