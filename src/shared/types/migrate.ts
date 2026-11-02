// Moving over from VS Code / Cursor: the editor settings, keybindings and
// snippets Mindeck takes along, and what becomes of each extension.
// (Colors and themes stay Mindeck's own, deliberately.)
// Pure module (no DOM/Node/Electron) so it compiles under every tsconfig.

export interface EditorKeybinding {
  /** VS Code's notation: `cmd+shift+p`, chords as `cmd+k cmd+c`. */
  key: string
  command: string
  when?: string
}

/** The editor preferences Mindeck applies (taken from VS Code's settings.json). */
export interface EditorSettings {
  fontSize?: number
  fontFamily?: string
  fontLigatures?: boolean
  lineHeight?: number
  tabSize?: number
  insertSpaces?: boolean
  wordWrap?: 'off' | 'on' | 'wordWrapColumn' | 'bounded'
  wordWrapColumn?: number
  minimap?: boolean
  lineNumbers?: 'on' | 'off' | 'relative' | 'interval'
  renderWhitespace?: 'none' | 'boundary' | 'selection' | 'trailing' | 'all'
  cursorStyle?: 'line' | 'block' | 'underline' | 'line-thin' | 'block-outline' | 'underline-thin'
  cursorBlinking?: 'blink' | 'smooth' | 'phase' | 'expand' | 'solid'
  rulers?: number[]
  stickyScroll?: boolean
  smoothScrolling?: boolean
  bracketPairColorization?: boolean
  /** Format the document when saving (VS Code's editor.formatOnSave). */
  formatOnSave?: boolean
  /**
   * Prettier formats (VS Code's editor.defaultFormatter = Prettier) — the
   * project's own, else Mindeck's. Without it, Prettier formats only projects
   * that use Prettier; the rest the editor's own formatters.
   */
  prettier?: boolean
  /** Who last changed the cursor's line, dimmed after it (git blame); on unless switched off. */
  inlineBlame?: boolean
  /** Prettier's options where a project has no config (the extension's `prettier.*` settings). */
  prettierOptions?: Record<string, string | number | boolean>
  /** Apply ESLint's fixes when saving (editor.codeActionsOnSave: source.fixAll.eslint). */
  eslintFixOnSave?: boolean
  /** Vim keys in the editor (VSCodeVim installed, or switched on here). */
  vim?: boolean
  /** VSCodeVim's key remappings (`vim.insertModeKeyBindings` …), e.g. jj → <Esc>. */
  vimMappings?: VimMapping[]
  /** Blank Line Organizer: on save, squeeze runs of blank lines — to one, or away entirely. */
  blankLines?: { onSave: boolean; keepOne: boolean }
  /** Live Server (ritwickdey.liveserver's settings). */
  liveServer?: LiveServerSettings
  /** Live Sass Compiler (glenn2223.live-sass's settings). */
  sass?: SassSettings
  /** Per language (Monaco id), VS Code's `"[python]": { … }`. */
  languages?: Record<string, LanguageSettings>
  keybindings?: EditorKeybinding[]
  /** Where these came from, when. */
  importedFrom?: { app: string; at: string }
}

export interface LiveServerSettings {
  /** First port to try (the next free one is taken). */
  port?: number
  /** Served folder, relative to the project ('/' = the project). */
  root?: string
  /** Don't open a browser. */
  noBrowser?: boolean
  /** Reload the page on CSS changes too (else styles swap in place). */
  fullReload?: boolean
  /** Changes to these (globs) don't reload. */
  ignore?: string[]
  /** Wait this long (ms) after a change before reloading. */
  wait?: number
}

export interface SassFormat {
  format: 'expanded' | 'compressed'
  extensionName: string
  /** null: next to the .scss; '/css': from the project root; '~/../css': from the .scss file's folder. */
  savePath?: string | null
}

export interface SassSettings {
  formats?: SassFormat[]
  generateMap?: boolean
  /** Folders / globs never compiled. */
  exclude?: string[]
  /** Start watching when a project opens. */
  watchOnLaunch?: boolean
}

/** What a language may override. */
export interface VimMapping {
  mode: 'normal' | 'insert' | 'visual'
  /** Keys in Vim's notation: `jj`, `<leader>w`, `<C-d>`. */
  before: string
  after: string
}

export type LanguageSettings = Omit<
  EditorSettings,
  'languages' | 'keybindings' | 'importedFrom' | 'blankLines' | 'liveServer' | 'sass' | 'prettierOptions' | 'eslintFixOnSave' | 'vim' | 'vimMappings' | 'inlineBlame'
>

export interface Snippet {
  name: string
  /** Monaco language id, or `*` for every language. */
  language: string
  prefix: string
  /** VS Code snippet syntax ($1, ${2:name}, $0) — Monaco reads it as is. */
  body: string
  description?: string
  /** Named imports the snippet needs (added at the top when missing), e.g. MUI components. */
  imports?: { from: string; names: string[] }
}

export type ExtensionFate = 'built-in' | 'language' | 'snippets' | 'theme' | 'unsupported'

export interface MigrationExtension {
  id: string
  name: string
  fate: ExtensionFate
  /** For `language`: the registry id to install under Settings → Languages. */
  language?: string
}

export interface MigrationSource {
  /** Folder name of the app's data: Code, Cursor, VSCodium, Windsurf. */
  app: string
  name: string
  /** Editor settings Mindeck understands. */
  settings: number
  keybindings: number
  snippets: number
  extensions: MigrationExtension[]
}

export interface MigrationResult {
  settings: number
  keybindings: number
  snippets: number
}

/** VS Code's workbench commands → the Mindeck command palette's ids. */
export const WORKBENCH_COMMANDS: Record<string, string> = {
  'workbench.action.quickOpen': 'go.file',
  'workbench.action.showCommands': 'palette',
  'workbench.action.gotoLine': 'go.line',
  'workbench.action.files.save': 'file.save',
  'workbench.action.files.saveAll': 'file.saveAll',
  'workbench.action.closeActiveEditor': 'file.close',
  'workbench.action.files.newUntitledFile': 'file.new',
  'explorer.newFile': 'file.new',
  'explorer.newFolder': 'file.newFolder',
  'workbench.action.findInFiles': 'view.search',
  'workbench.view.search': 'view.search',
  'workbench.view.scm': 'view.scm',
  'workbench.view.explorer': 'view.files',
  'workbench.view.debug': 'debug.view',
  'workbench.action.debug.start': 'debug.start',
  'workbench.action.debug.continue': 'debug.continue',
  'workbench.action.debug.stop': 'debug.stop',
  'workbench.action.debug.restart': 'debug.restart',
  'workbench.action.debug.stepOver': 'debug.stepOver',
  'workbench.action.debug.stepInto': 'debug.stepInto',
  'workbench.action.debug.stepOut': 'debug.stepOut',
  'editor.debug.action.toggleBreakpoint': 'debug.breakpoint',
  'git.commit': 'git.commit',
  'git.pull': 'git.pull',
  'git.push': 'git.push',
  'git.sync': 'git.sync',
  'git.fetch': 'git.fetch',
  'git.checkout': 'git.checkout',
  'workbench.action.terminal.toggleTerminal': 'module.terminal',
  'workbench.action.terminal.new': 'module.terminal'
}

/** A keybinding Mindeck can honor: Monaco's own editor commands, or a mapped workbench command. */
export const isSupportedCommand = (command: string): boolean =>
  command in WORKBENCH_COMMANDS || /^(editor\.|cursor|actions\.find|deleteLines|undo|redo|tab|outdent)/.test(command)

/** What becomes of well-known extensions. Others are judged by what they contain. */
export const KNOWN_EXTENSIONS: Record<string, { fate: ExtensionFate; language?: string }> = {
  'ms-python.python': { fate: 'language', language: 'python' },
  'ms-python.vscode-pylance': { fate: 'language', language: 'python' },
  'ms-python.debugpy': { fate: 'language', language: 'python' },
  'ms-python.vscode-python-envs': { fate: 'language', language: 'python' },
  'golang.go': { fate: 'language', language: 'go' },
  'rust-lang.rust-analyzer': { fate: 'language', language: 'rust' },
  'ms-vscode.cpptools': { fate: 'language', language: 'cpp' },
  'ms-vscode.cpptools-extension-pack': { fate: 'language', language: 'cpp' },
  'llvm-vs-code-extensions.vscode-clangd': { fate: 'language', language: 'cpp' },
  'vadimcn.vscode-lldb': { fate: 'language', language: 'cpp' },
  'llvm-vs-code-extensions.lldb-dap': { fate: 'language', language: 'cpp' },
  'redhat.java': { fate: 'language', language: 'java' },
  'vscjava.vscode-java-pack': { fate: 'language', language: 'java' },
  'vscjava.vscode-java-debug': { fate: 'language', language: 'java' },
  'ms-dotnettools.csharp': { fate: 'language', language: 'csharp' },
  'ms-dotnettools.csdevkit': { fate: 'language', language: 'csharp' },
  'bmewburn.vscode-intelephense-client': { fate: 'language', language: 'php' },
  'xdebug.php-debug': { fate: 'language', language: 'php' },
  'felixfbecker.php-debug': { fate: 'language', language: 'php' },
  'shopify.ruby-lsp': { fate: 'language', language: 'ruby' },
  'swiftlang.swift-vscode': { fate: 'language', language: 'swift' },
  'sswg.swift-lang': { fate: 'language', language: 'swift' },
  'fwcd.kotlin': { fate: 'language', language: 'kotlin' },
  'sumneko.lua': { fate: 'language', language: 'lua' },
  'redhat.vscode-yaml': { fate: 'language', language: 'yaml' },
  'mads-hartmann.bash-ide-vscode': { fate: 'language', language: 'shell' },
  'ms-azuretools.vscode-docker': { fate: 'language', language: 'dockerfile' },
  'eamodio.gitlens': { fate: 'built-in' },
  'mhutchie.git-graph': { fate: 'built-in' },
  'donjayamanne.githistory': { fate: 'built-in' },
  'alefragnani.project-manager': { fate: 'built-in' },
  'anthropic.claude-code': { fate: 'built-in' },
  'openai.chatgpt': { fate: 'built-in' },
  'ms-ceintl.vscode-language-pack-de': { fate: 'built-in' },
  // Built into the editor: format on save (CSS / SCSS / LESS included), blank lines, PHP accessors, MUI snippets.
  'aeschli.vscode-css-formatter': { fate: 'built-in' },
  'ctf0.blank-line-organizer': { fate: 'built-in' },
  'phproberto.vscode-php-getters-setters': { fate: 'built-in' },
  'vscodeshift.mui-snippets': { fate: 'built-in' },
  'ritwickdey.liveserver': { fate: 'built-in' },
  'glenn2223.live-sass': { fate: 'built-in' },
  'natizyskunk.sftp': { fate: 'built-in' },
  'dbaeumer.vscode-eslint': { fate: 'built-in' },
  'esbenp.prettier-vscode': { fate: 'built-in' },
  'github.vscode-pull-request-github': { fate: 'built-in' },
  'mongodb.mongodb-vscode': { fate: 'built-in' },
  // Remote-SSH and Dev Containers (VS Code's and Cursor's).
  'ms-vscode-remote.remote-ssh': { fate: 'built-in' },
  'ms-vscode-remote.remote-ssh-edit': { fate: 'built-in' },
  'ms-vscode.remote-explorer': { fate: 'built-in' },
  'ms-vscode-remote.remote-containers': { fate: 'built-in' },
  'anysphere.remote-ssh': { fate: 'built-in' },
  'anysphere.remote-containers': { fate: 'built-in' },
  'liximomo.sftp': { fate: 'built-in' },
  'vscodevim.vim': { fate: 'built-in' },
  // Jupyter notebooks (kernels through the project's Python).
  'ms-toolsai.jupyter': { fate: 'built-in' },
  'ms-toolsai.jupyter-renderers': { fate: 'built-in' },
  'ms-toolsai.jupyter-keymap': { fate: 'built-in' },
  'ms-toolsai.vscode-jupyter-cell-tags': { fate: 'built-in' }
}
