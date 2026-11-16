import { existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { shellQuote } from '../terminal/TerminalService'
import { psQuote } from '../../lib/executables'

/** The three platforms tools are installed for (anything else unixy counts as Linux). */
export type OS = 'darwin' | 'linux' | 'win32'
export const osOf = (platform: NodeJS.Platform): OS => (platform === 'darwin' || platform === 'win32' ? platform : 'linux')

export interface InstallContext {
  /** Mindeck's tools folder. */
  tools: string
  /** The machine's architecture (x64, arm64), for downloads built per architecture. */
  arch: string
}

/** One way a tool gets onto the machine. */
export interface InstallSpec {
  /** The program installing runs (npm, go, brew, winget, …) — shown when it's missing. */
  requires: string
  /** Further programs the command uses (curl, unzip, pkexec, …): this way only counts when they're there too. */
  uses?: string[]
  /** Only on these architectures (downloads built for some only). */
  arch?: string[]
  /** The command line: POSIX sh on macOS / Linux, PowerShell on Windows. */
  command: (ctx: InstallContext) => string
}

/** Per platform, the ways to install — the first one whose programs are all there is used. */
export type Installs = Partial<Record<OS, InstallSpec[]>>

/** What locating a tool may use — no shell: PATH lookups, files, a program's answer. */
export interface LocateContext {
  tools: string
  platform: NodeJS.Platform
  home: string
  /** Where the system keeps its programs (/usr): Linux's versioned LLVM builds live there. */
  system: string
  env: Record<string, string | undefined>
  /** A program on the user's PATH (Windows: with PATHEXT's endings). */
  which: (name: string) => string | undefined
  /** The program at a path (Windows: with PATHEXT's endings). */
  executable: (file: string) => string | undefined
  /** A program's output, trimmed; '' when it isn't there or fails. */
  ask: (program: string, args: string[]) => Promise<string>
}

export interface ToolSpec {
  name: string
  /** Where the tool is on this machine, or undefined. */
  locate: (ctx: LocateContext) => string | undefined | Promise<string | undefined>
  install?: Installs
}

export interface ServerSpec extends ToolSpec {
  args: (ctx: { root: string; tools: string }) => string[]
  /** The `initialize` request's initializationOptions (jdtls: its debug plugin). */
  initializationOptions?: (ctx: { root: string; tools: string }) => unknown
  /** Answers to `workspace/configuration`, by section. */
  settings?: (root: string) => Record<string, unknown>
}

export interface CatalogEntry {
  server: ServerSpec
  debugger?: ToolSpec
}

// --- locating ---

/** The first of `names` on the PATH. */
export function which(ctx: LocateContext, ...names: string[]): string | undefined {
  for (const name of names) {
    const hit = ctx.which(name)
    if (hit) return hit
  }
  return undefined
}

/** A program inside `dir` — nothing when the folder is unknown (a toolchain that didn't answer). */
export function inDir(ctx: LocateContext, dir: string | undefined, ...parts: string[]): string | undefined {
  return dir ? ctx.executable(join(dir, ...parts)) : undefined
}

/** A program that is an answer itself (`xcrun --find`, `rustup which`). */
async function answer(ctx: LocateContext, program: string, args: string[]): Promise<string | undefined> {
  const out = (await ctx.ask(program, args)).split(/\r?\n/)[0]
  return out ? ctx.executable(out) : undefined
}

/** Numbered folder entries (`llvm-18`, `clangd-17`), newest first. */
function newest(dir: string, pattern: RegExp): string[] {
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    /* not there */
  }
  return entries
    .map((name) => ({ name, n: Number(pattern.exec(name)?.[1] ?? NaN) }))
    .filter((e) => !Number.isNaN(e.n))
    .sort((a, b) => b.n - a.n)
    .map((e) => e.name)
}

/** Linux distributions' versioned LLVM programs: /usr/lib/llvm-18/bin/clangd, /usr/bin/clangd-18. */
export function llvmBuild(ctx: LocateContext, bin: string): string | undefined {
  if (osOf(ctx.platform) !== 'linux') return undefined
  const lib = join(ctx.system, 'lib')
  for (const llvm of newest(lib, /^llvm-(\d+)$/)) {
    const hit = ctx.executable(join(lib, llvm, 'bin', bin))
    if (hit) return hit
  }
  const usrBin = join(ctx.system, 'bin')
  return newest(usrBin, new RegExp(`^${bin}-(\\d+)$`))
    .map((name) => ctx.executable(join(usrBin, name)))
    .find(Boolean)
}

/** Homebrew's LLVM (keg-only: never on the PATH by itself). */
const brewLlvm = (ctx: LocateContext, bin: string) =>
  ctx.platform === 'darwin' ? ['/opt/homebrew/opt/llvm/bin', '/usr/local/opt/llvm/bin'].map((dir) => ctx.executable(join(dir, bin))).find(Boolean) : undefined

/** The official LLVM installer's folder on Windows (it doesn't add itself to the PATH). */
const windowsLlvm = (ctx: LocateContext, bin: string) => (ctx.platform === 'win32' ? inDir(ctx, ctx.env.ProgramFiles ?? 'C:\\Program Files', 'LLVM', 'bin', bin) : undefined)

/** Xcode's tools (macOS only). */
const xcrun = (ctx: LocateContext, bin: string) => (ctx.platform === 'darwin' ? answer(ctx, 'xcrun', ['--find', bin]) : undefined)

/** A server installed with npm into Mindeck's tools folder (found there first). */
const npmBin = (bin: string) => (ctx: LocateContext) => inDir(ctx, ctx.tools, 'npm', 'node_modules', '.bin', bin) ?? which(ctx, bin)

/** A program `go install` put into GOPATH/bin (not always on the PATH). */
async function goBin(ctx: LocateContext, bin: string): Promise<string | undefined> {
  const found = which(ctx, bin)
  if (found) return found
  const gopath = (await ctx.ask('go', ['env', 'GOPATH'])).split(ctx.platform === 'win32' ? ';' : ':')[0]
  return inDir(ctx, gopath, 'bin', bin) ?? inDir(ctx, ctx.home, 'go', 'bin', bin)
}

/** The first match of a folder pattern inside `dir` (a download unpacked into a versioned folder). */
function unpacked(ctx: LocateContext, dir: string, pattern: RegExp, ...parts: string[]): string | undefined {
  let entries: string[] = []
  try {
    entries = readdirSync(dir).filter((e) => pattern.test(e)).sort().reverse()
  } catch {
    /* not downloaded */
  }
  return entries.map((e) => ctx.executable(join(dir, e, ...parts))).find(Boolean)
}

// --- installing ---

const q = shellQuote

/** The same command line on every platform (go, rustup, dotnet, gem, npm read their arguments alike). */
function everywhere(requires: string, command: (ctx: InstallContext, quote: (word: string) => string) => string): Installs {
  const posix: InstallSpec = { requires, command: (ctx) => command(ctx, q) }
  return { darwin: [posix], linux: [posix], win32: [{ requires, command: (ctx) => command(ctx, psQuote) }] }
}

const npm = (...packages: string[]): Installs =>
  everywhere('npm', ({ tools }, quote) => `npm install --prefix ${quote(join(tools, 'npm'))} --no-audit --no-fund --loglevel=error ${packages.join(' ')}`)

const brew = (formula: string): InstallSpec => ({ requires: 'brew', command: () => `brew install ${formula}` })

/** Windows' package manager — silent, agreements accepted (UAC asks when the installer needs it). */
const winget = (id: string): InstallSpec => ({
  requires: 'winget',
  command: () => `winget install --id ${id} --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity`
})

const scoop = (app: string): InstallSpec => ({ requires: 'scoop', command: () => `scoop install ${app}` })

/** A distribution package, installed as root through polkit's password dialog (no terminal for sudo here). */
function linuxPackages(packages: { apt?: string; dnf?: string; pacman?: string; zypper?: string }): InstallSpec[] {
  const ways: [keyof typeof packages, string, (p: string) => string][] = [
    ['apt', 'apt-get', (p) => `pkexec apt-get install -y ${p}`],
    ['dnf', 'dnf', (p) => `pkexec dnf install -y ${p}`],
    ['pacman', 'pacman', (p) => `pkexec pacman -S --needed --noconfirm ${p}`],
    ['zypper', 'zypper', (p) => `pkexec zypper --non-interactive install ${p}`]
  ]
  return ways.filter(([key]) => packages[key]).map(([key, requires, command]) => ({ requires, uses: ['pkexec'], command: () => command(packages[key]!) }))
}

/** POSIX: a fresh folder, an archive downloaded into it and unpacked (`url` is a shell word: quoted, or "$url"). */
function shFetch(dir: string, url: string, kind: 'zip' | 'tar.gz'): string {
  const d = q(dir)
  const file = `${d}/download.${kind}`
  const unpack = kind === 'zip' ? `unzip -oq ${file} -d ${d}` : `tar -xzf ${file} -C ${d}`
  return [`rm -rf ${d}`, `mkdir -p ${d}`, `curl -fsSL ${url} -o ${file}`, unpack, `rm ${file}`].join(' && ')
}

/** PowerShell: likewise (`url` is a PowerShell expression: quoted, or $url). Expand-Archive for ZIPs, Windows' tar for the rest. */
function psFetch(dir: string, url: string, kind: 'zip' | 'tar.gz'): string {
  const file = `"$d\\download.${kind}"`
  const unpack = kind === 'zip' ? `Expand-Archive -Force ${file} $d` : `tar -xzf ${file} -C $d; if ($LASTEXITCODE) { exit $LASTEXITCODE }`
  return [
    `$d = ${psQuote(dir)}`,
    'Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $d',
    'New-Item -ItemType Directory -Force $d | Out-Null',
    `Invoke-WebRequest -UseBasicParsing ${url} -OutFile ${file}`,
    unpack,
    `Remove-Item ${file}`
  ].join('; ')
}

const NO_DOWNLOAD = 'No download for this computer'

/** A release asset's URL from GitHub (its name has the version in it): POSIX sets $url. */
const shGitHubAsset = (repo: string, pattern: string) =>
  `url=$(curl -fsSL https://api.github.com/repos/${repo}/releases/latest | grep -o '"browser_download_url": *"[^"]*"' | cut -d'"' -f4 | grep -E ${q(pattern)} | head -1) && { [ -n "$url" ] || { echo '${NO_DOWNLOAD}' >&2; exit 1; }; }`

/** … and PowerShell sets $url. */
const psGitHubAsset = (repo: string, pattern: string) =>
  `$url = (Invoke-RestMethod -UseBasicParsing 'https://api.github.com/repos/${repo}/releases/latest').assets.browser_download_url | Where-Object { $_ -match ${psQuote(pattern)} } | Select-Object -First 1; if (-not $url) { throw '${NO_DOWNLOAD}' }`

/** A download for every platform: POSIX with curl (+ unzip / tar), Windows with PowerShell alone. */
function download(requires: string, sh: (ctx: InstallContext) => string, ps: (ctx: InstallContext) => string, kind: 'zip' | 'tar.gz'): { posix: InstallSpec; win: InstallSpec } {
  return {
    posix: { requires, uses: ['curl', kind === 'zip' ? 'unzip' : 'tar'], command: sh },
    win: { requires, command: ps }
  }
}

/** A VS Code extension's files from Open VSX (MIT-licensed debug adapters), unpacked into `<tools>/<dir>/extension`. */
function openVsx(requires: string, extension: string, dir: string): Installs {
  const api = `https://open-vsx.org/api/${extension}`
  const { posix, win } = download(
    requires,
    ({ tools }) =>
      `url=$(curl -fsSL ${api} | grep -o '"download":"[^"]*"' | head -1 | cut -d'"' -f4) && ${shFetch(join(tools, dir), '"$url"', 'zip')}`,
    ({ tools }) => `$url = (Invoke-RestMethod -UseBasicParsing '${api}').files.download; ${psFetch(join(tools, dir), '$url', 'zip')}`,
    'zip'
  )
  return { darwin: [posix], linux: [posix], win32: [win] }
}

/** A release asset with a stable name (`releases/latest/download/<file>`), unpacked into `<tools>/<dir>`. */
function githubLatest(requires: string, repo: string, file: string, dir: string, after: { sh?: (d: string) => string } = {}): { posix: InstallSpec; win: InstallSpec } {
  const url = `https://github.com/${repo}/releases/latest/download/${file}`
  return download(
    requires,
    ({ tools }) => [shFetch(join(tools, dir), url, 'zip'), after.sh?.(q(join(tools, dir)))].filter(Boolean).join(' && '),
    ({ tools }) => psFetch(join(tools, dir), psQuote(url), 'zip'),
    'zip'
  )
}

// --- the tools ---

/** LLDB's debug adapter — C, C++, Objective-C, Rust and Swift (Xcode's, an LLVM install, or the distribution's). */
const lldbDap: ToolSpec = {
  name: 'lldb-dap',
  locate: async (ctx) =>
    which(ctx, 'lldb-dap') ?? (await xcrun(ctx, 'lldb-dap')) ?? which(ctx, 'lldb-vscode') ?? brewLlvm(ctx, 'lldb-dap') ?? windowsLlvm(ctx, 'lldb-dap') ?? llvmBuild(ctx, 'lldb-dap') ?? llvmBuild(ctx, 'lldb-vscode'),
  install: {
    darwin: [brew('llvm')],
    linux: [...linuxPackages({ apt: 'lldb', dnf: 'lldb', pacman: 'lldb', zypper: 'lldb' }), brew('llvm')],
    win32: [winget('LLVM.LLVM'), scoop('llvm')]
  }
}

/** Microsoft's Java debug plugin for jdtls (from the Java Debugger extension). */
export function javaDebugJar(tools: string): string | undefined {
  const dir = join(tools, 'java-debug', 'extension', 'server')
  const jar = existsSync(dir) ? readdirSync(dir).filter((f) => /^com\.microsoft\.java\.debug\.plugin-.*\.jar$/.test(f)).sort().pop() : undefined
  return jar && join(dir, jar)
}

/** The project's virtualenv interpreter (`bin/python`, on Windows `Scripts\\python.exe`), if it has one. */
export function venvPython(root: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const inVenv = platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']
  return ['.venv', 'venv', 'env'].map((venv) => join(root, venv, ...inVenv)).find((python) => existsSync(python))
}

/** The Python on the PATH: `python3` (Windows installs call it `python`). */
export const systemPython = (platform: NodeJS.Platform = process.platform): string => (platform === 'win32' ? 'python' : 'python3')

/** A Python interpreter: the project's virtualenv, else the system's. */
export function pythonFor(root: string, platform: NodeJS.Platform = process.platform): string {
  return venvPython(root, platform) ?? systemPython(platform)
}

const clangdDownload = download(
  'curl',
  ({ tools }) => `${shGitHubAsset('clangd/clangd', '/clangd-linux-[^/]*\\.zip$')} && ${shFetch(join(tools, 'clangd'), '"$url"', 'zip')}`,
  ({ tools }) => `${psGitHubAsset('clangd/clangd', '/clangd-windows-[^/]*\\.zip$')}; ${psFetch(join(tools, 'clangd'), '$url', 'zip')}`,
  'zip'
)

/** Eclipse's JDT LS build ("latest" keeps its name); its launcher is a Python script. */
const JDTLS_URL = 'https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz'
const jdtlsDownload = download(
  'java',
  ({ tools }) => shFetch(join(tools, 'jdtls-server'), JDTLS_URL, 'tar.gz'),
  ({ tools }) => psFetch(join(tools, 'jdtls-server'), psQuote(JDTLS_URL), 'tar.gz'),
  'tar.gz'
)

const kotlinServer = githubLatest('java', 'fwcd/kotlin-language-server', 'server.zip', 'kotlin-ls')
const kotlinDebug = githubLatest('java', 'fwcd/kotlin-debug-adapter', 'adapter.zip', 'kotlin-debug', { sh: (d) => `chmod +x ${d}/adapter/bin/kotlin-debug-adapter` })

/** LuaLS's releases are named by version, platform and architecture (linux-x64, win32-x64, …). */
const luaDownload = download(
  'curl',
  ({ tools, arch }) => `${shGitHubAsset('LuaLS/lua-language-server', `-linux-${arch}\\.tar\\.gz$`)} && ${shFetch(join(tools, 'lua-ls'), '"$url"', 'tar.gz')}`,
  ({ tools, arch }) => `${psGitHubAsset('LuaLS/lua-language-server', `-win32-${arch}\\.zip$`)}; ${psFetch(join(tools, 'lua-ls'), '$url', 'zip')}`,
  'tar.gz'
)

/** PowerShell's own requirement: always there on Windows. */
const POWERSHELL = 'powershell'

/**
 * Language servers and debuggers Mindeck knows how to find and install —
 * the tools VS Code's language extensions wrap, used directly. Every
 * platform gets its own way to install: Homebrew on macOS, the distribution
 * or a download on Linux, winget / scoop / a PowerShell download on Windows;
 * npm, go, rustup, dotnet, gem and pip work alike everywhere.
 */
export const CATALOG: Record<string, CatalogEntry> = {
  python: {
    server: {
      name: 'Pyright',
      locate: npmBin('pyright-langserver'),
      args: () => ['--stdio'],
      install: npm('pyright'),
      settings: (root) => ({
        python: { pythonPath: pythonFor(root) },
        'python.analysis': { autoSearchPaths: true, useLibraryCodeForTypes: true, diagnosticMode: 'openFilesOnly' }
      })
    },
    debugger: {
      name: 'debugpy',
      locate: ({ tools }) => {
        const dir = join(tools, 'debugpy')
        return existsSync(join(dir, 'debugpy', '__init__.py')) ? dir : undefined
      },
      install: {
        darwin: [{ requires: 'python3', command: ({ tools }) => `python3 -m pip install --upgrade --quiet --target ${q(join(tools, 'debugpy'))} debugpy` }],
        linux: [{ requires: 'python3', command: ({ tools }) => `python3 -m pip install --upgrade --quiet --target ${q(join(tools, 'debugpy'))} debugpy` }],
        win32: [{ requires: 'python', command: ({ tools }) => `python -m pip install --upgrade --quiet --target ${psQuote(join(tools, 'debugpy'))} debugpy` }]
      }
    }
  },
  go: {
    server: { name: 'gopls', locate: (ctx) => goBin(ctx, 'gopls'), args: () => [], install: everywhere('go', () => 'go install golang.org/x/tools/gopls@latest') },
    debugger: { name: 'Delve', locate: (ctx) => goBin(ctx, 'dlv'), install: everywhere('go', () => 'go install github.com/go-delve/delve/cmd/dlv@latest') }
  },
  rust: {
    server: {
      name: 'rust-analyzer',
      // rustup's own answer first: ~/.cargo/bin/rust-analyzer is a proxy even when the component is missing.
      locate: async (ctx) => (await answer(ctx, 'rustup', ['which', 'rust-analyzer'])) ?? which(ctx, 'rust-analyzer'),
      args: () => [],
      install: everywhere('rustup', () => 'rustup component add rust-analyzer')
    },
    debugger: lldbDap
  },
  cpp: {
    server: {
      name: 'clangd',
      locate: async (ctx) =>
        which(ctx, 'clangd') ??
        brewLlvm(ctx, 'clangd') ??
        (await xcrun(ctx, 'clangd')) ??
        windowsLlvm(ctx, 'clangd') ??
        llvmBuild(ctx, 'clangd') ??
        unpacked(ctx, join(ctx.tools, 'clangd'), /^clangd_/, 'bin', 'clangd'),
      args: () => ['--background-index'],
      install: {
        darwin: [brew('llvm')],
        // clangd's own builds are x64 only; elsewhere the distribution's.
        linux: [{ ...clangdDownload.posix, arch: ['x64'] }, ...linuxPackages({ apt: 'clangd', dnf: 'clang-tools-extra', pacman: 'clang', zypper: 'clang-tools' })],
        win32: [winget('LLVM.LLVM'), scoop('llvm'), { ...clangdDownload.win, requires: POWERSHELL }]
      }
    },
    debugger: lldbDap
  },
  java: {
    server: {
      name: 'Eclipse JDT LS',
      locate: (ctx) => which(ctx, 'jdtls') ?? inDir(ctx, ctx.tools, 'jdtls-server', 'bin', 'jdtls'),
      // jdtls keeps its index per workspace — one folder per project.
      args: ({ root, tools }) => ['-data', join(tools, 'jdtls', createHash('sha1').update(root).digest('hex').slice(0, 12))],
      // The debug plugin rides along when it is installed (Run & Debug starts sessions through jdtls).
      initializationOptions: ({ tools }) => {
        const jar = javaDebugJar(tools)
        return { bundles: jar ? [jar] : [] }
      },
      install: {
        darwin: [brew('jdtls'), { ...jdtlsDownload.posix, uses: [...jdtlsDownload.posix.uses!, 'python3'] }],
        linux: [{ ...jdtlsDownload.posix, uses: [...jdtlsDownload.posix.uses!, 'python3'] }],
        win32: [{ ...jdtlsDownload.win, uses: ['python'] }]
      }
    },
    debugger: {
      name: 'Java Debug',
      locate: ({ tools }) => javaDebugJar(tools),
      install: openVsx('java', 'vscjava/vscode-java-debug', 'java-debug')
    }
  },
  csharp: {
    server: {
      name: 'csharp-ls',
      locate: (ctx) => which(ctx, 'csharp-ls') ?? inDir(ctx, ctx.home, '.dotnet', 'tools', 'csharp-ls'),
      args: () => [],
      install: everywhere('dotnet', () => 'dotnet tool install --global csharp-ls')
    }
  },
  php: {
    server: { name: 'Intelephense', locate: npmBin('intelephense'), args: () => ['--stdio'], install: npm('intelephense') },
    // Xdebug's own adapter; the program needs php with the Xdebug extension.
    debugger: {
      name: 'PHP Debug (Xdebug)',
      locate: ({ tools }) => {
        const js = join(tools, 'php-debug', 'extension', 'out', 'phpDebug.js')
        return existsSync(js) ? js : undefined
      },
      install: openVsx('php', 'xdebug/php-debug', 'php-debug')
    }
  },
  ruby: {
    server: {
      name: 'Ruby LSP',
      locate: async (ctx) => which(ctx, 'ruby-lsp') ?? inDir(ctx, await ctx.ask('ruby', ['-e', 'print Gem.bindir']), 'ruby-lsp'),
      args: () => [],
      install: everywhere('gem', () => 'gem install ruby-lsp')
    }
  },
  swift: {
    // Comes with Xcode (macOS) or the Swift toolchain (swift.org; on Windows through winget).
    server: {
      name: 'SourceKit-LSP',
      locate: async (ctx) => which(ctx, 'sourcekit-lsp') ?? (await xcrun(ctx, 'sourcekit-lsp')),
      args: () => [],
      install: { win32: [winget('Swift.Toolchain')] }
    },
    debugger: lldbDap
  },
  kotlin: {
    server: {
      name: 'Kotlin Language Server',
      locate: (ctx) => which(ctx, 'kotlin-language-server') ?? inDir(ctx, ctx.tools, 'kotlin-ls', 'server', 'bin', 'kotlin-language-server'),
      args: () => [],
      install: { darwin: [brew('kotlin-language-server'), kotlinServer.posix], linux: [kotlinServer.posix], win32: [kotlinServer.win] }
    },
    debugger: {
      name: 'Kotlin Debug Adapter',
      locate: (ctx) => inDir(ctx, ctx.tools, 'kotlin-debug', 'adapter', 'bin', 'kotlin-debug-adapter'),
      install: { darwin: [kotlinDebug.posix], linux: [kotlinDebug.posix], win32: [kotlinDebug.win] }
    }
  },
  lua: {
    server: {
      name: 'Lua Language Server',
      locate: (ctx) => which(ctx, 'lua-language-server') ?? inDir(ctx, ctx.tools, 'lua-ls', 'bin', 'lua-language-server'),
      args: () => [],
      install: { darwin: [brew('lua-language-server')], linux: [luaDownload.posix, brew('lua-language-server')], win32: [scoop('lua-language-server'), { ...luaDownload.win, requires: POWERSHELL }] }
    }
  },
  yaml: {
    server: {
      name: 'YAML Language Server',
      locate: npmBin('yaml-language-server'),
      args: () => ['--stdio'],
      install: npm('yaml-language-server'),
      settings: () => ({ yaml: { validate: true, hover: true, completion: true, schemaStore: { enable: true } } })
    }
  },
  shell: {
    server: { name: 'Bash Language Server', locate: npmBin('bash-language-server'), args: () => ['start'], install: npm('bash-language-server') }
  },
  dockerfile: {
    server: { name: 'Dockerfile Language Server', locate: npmBin('docker-langserver'), args: () => ['--stdio'], install: npm('dockerfile-language-server-nodejs') }
  }
}
