// The languages the editor knows beyond TypeScript / JavaScript: which files
// they cover and which Monaco language ids they show as. Their language
// servers and debuggers are set up per machine (Settings → Languages).
// Pure module (no DOM/Node/Electron) so it compiles under every tsconfig.

export interface LanguageInfo {
  id: string
  name: string
  /** File endings, lower case, with the dot. */
  extensions: string[]
  /** Whole file names (Dockerfile, …). */
  filenames?: string[]
  /** Monaco's ids for these files. */
  monaco: string[]
}

export const LANGUAGES: LanguageInfo[] = [
  { id: 'python', name: 'Python', extensions: ['.py', '.pyi'], monaco: ['python'] },
  { id: 'go', name: 'Go', extensions: ['.go'], monaco: ['go'] },
  { id: 'rust', name: 'Rust', extensions: ['.rs'], monaco: ['rust'] },
  { id: 'cpp', name: 'C / C++', extensions: ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.m', '.mm'], monaco: ['c', 'cpp', 'objective-c'] },
  { id: 'java', name: 'Java', extensions: ['.java'], monaco: ['java'] },
  { id: 'csharp', name: 'C#', extensions: ['.cs', '.csx'], monaco: ['csharp'] },
  { id: 'php', name: 'PHP', extensions: ['.php', '.phtml'], monaco: ['php'] },
  { id: 'ruby', name: 'Ruby', extensions: ['.rb', '.rake', '.gemspec'], filenames: ['Gemfile', 'Rakefile'], monaco: ['ruby'] },
  { id: 'swift', name: 'Swift', extensions: ['.swift'], monaco: ['swift'] },
  { id: 'kotlin', name: 'Kotlin', extensions: ['.kt', '.kts'], monaco: ['kotlin'] },
  { id: 'lua', name: 'Lua', extensions: ['.lua'], monaco: ['lua'] },
  { id: 'yaml', name: 'YAML', extensions: ['.yaml', '.yml'], monaco: ['yaml'] },
  { id: 'shell', name: 'Shell', extensions: ['.sh', '.bash'], monaco: ['shell'] },
  { id: 'dockerfile', name: 'Dockerfile', extensions: ['.dockerfile'], filenames: ['Dockerfile', 'Containerfile'], monaco: ['dockerfile'] }
]

/** TypeScript and JavaScript run on the project's own tsserver, not a language server from here. */
export const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** The language a project file belongs to, if the editor has one for it. */
export function languageOf(path: string): LanguageInfo | undefined {
  const name = base(path)
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : ''
  return LANGUAGES.find((l) => l.filenames?.includes(name) || (ext !== '' && l.extensions.includes(ext)))
}

export const isTypeScriptFile = (path: string): boolean => {
  const name = base(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 && TS_EXTENSIONS.includes(name.slice(dot).toLowerCase())
}

/** One piece of a language's tooling: its language server or its debugger. */
export interface ToolState {
  /** What is used (pyright, gopls, debugpy, …). */
  name: string
  /**
   * ready: found on this machine · missing: installable from Settings ·
   * toolchain: needs the language's own toolchain first (`requires`) ·
   * manual: comes with something Mindeck can't install (Xcode, …)
   */
  state: 'ready' | 'missing' | 'toolchain' | 'manual'
  /** The program installing needs (go, rustup, npm, …). */
  requires?: string
  /** The install command, as it will run. */
  command?: string
}

export interface LanguageStatus {
  id: string
  name: string
  server: ToolState
  debugger?: ToolState
}

export interface ToolProgress {
  id: string
  part: 'server' | 'debugger'
  line: string
}

/** A program the onboarding looks for besides the coding agents. */
export interface RuntimeInfo {
  name: 'node' | 'npm' | 'git'
  found: boolean
  path?: string
  version?: string
}
