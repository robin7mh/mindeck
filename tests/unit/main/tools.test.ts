import { existsSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'
import { CATALOG, inDir, llvmBuild, osOf, pythonFor, systemPython, which, type InstallSpec, type LocateContext, type OS } from '../../../electron/main/services/tools/catalog'
import { loginShellRunner, PS_PRELUDE, ToolsService, userEnv, userPath, type Runner } from '../../../electron/main/services/tools/ToolsService'
import type { ToolProgress } from '@shared/types/languages'

/** A machine as locate() sees it: programs on the PATH, files that exist, programs' answers. */
function machine(opts: { platform?: NodeJS.Platform; path?: Record<string, string>; files?: string[]; answers?: Record<string, string>; env?: Record<string, string>; system?: string } = {}): LocateContext {
  const files = new Set(opts.files ?? [])
  return {
    tools: '/t',
    platform: opts.platform ?? 'linux',
    home: '/h',
    system: opts.system ?? '/nowhere',
    env: opts.env ?? {},
    which: (name) => opts.path?.[name],
    executable: (file) => (files.has(file) ? file : undefined),
    ask: async (program, args) => opts.answers?.[[program, ...args].join(' ')] ?? ''
  }
}

const locate = (id: string, part: 'server' | 'debugger', ctx: LocateContext) => Promise.resolve((part === 'server' ? CATALOG[id].server : CATALOG[id].debugger!).locate(ctx))

async function program(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, name)
  await writeFile(file, '#!/bin/sh\n')
  await chmod(file, 0o755)
  return file
}

describe('the tools catalog', () => {
  it('every tool has a way to install per platform — or comes with its toolchain — and the commands fit the platform', () => {
    const oses: OS[] = ['darwin', 'linux', 'win32']
    for (const [id, entry] of Object.entries(CATALOG)) {
      for (const spec of [entry.server, entry.debugger].filter(Boolean)) {
        for (const os of oses) {
          for (const way of spec!.install?.[os] ?? []) {
            for (const arch of ['x64', 'arm64']) {
              const command = way.command({ tools: '/tools', arch })
              expect(command, `${id} ${os}`).toBeTruthy()
              // No POSIX on Windows, no PowerShell elsewhere.
              if (os === 'win32') expect(command, `${id} ${os}`).not.toMatch(/\$\(|&&|\bcurl\b|\bunzip\b|command -v|printf|chmod/)
              else expect(command, `${id} ${os}`).not.toMatch(/Invoke-|Expand-Archive|\$LASTEXITCODE/)
            }
          }
        }
      }
    }
    const command = (id: string, os: OS, i = 0, part: 'server' | 'debugger' = 'server', arch = 'x64') =>
      ((part === 'server' ? CATALOG[id].server : CATALOG[id].debugger!).install![os]![i] as InstallSpec).command({ tools: '/my tools', arch })
    expect(command('python', 'linux')).toBe("npm install --prefix '/my tools/npm' --no-audit --no-fund --loglevel=error pyright")
    expect(command('python', 'win32')).toBe("npm install --prefix '/my tools/npm' --no-audit --no-fund --loglevel=error pyright")
    expect(command('python', 'darwin', 0, 'debugger')).toBe("python3 -m pip install --upgrade --quiet --target '/my tools/debugpy' debugpy")
    expect(command('python', 'win32', 0, 'debugger')).toBe("python -m pip install --upgrade --quiet --target '/my tools/debugpy' debugpy")
    expect(command('python', 'linux', 0, 'debugger')).toContain('python3 -m pip')
    expect(command('cpp', 'darwin')).toBe('brew install llvm')
    expect(command('cpp', 'win32')).toBe('winget install --id LLVM.LLVM --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity')
    expect(command('cpp', 'win32', 1)).toBe('scoop install llvm')
    expect(command('cpp', 'win32', 2)).toContain("Where-Object { $_ -match '/clangd-windows-[^/]*\\.zip$' }")
    expect(command('cpp', 'win32', 2)).toContain('Expand-Archive -Force "$d\\download.zip" $d')
    expect(command('cpp', 'linux')).toContain("grep -E '/clangd-linux-[^/]*\\.zip$'")
    expect(command('cpp', 'linux', 1)).toBe('pkexec apt-get install -y clangd')
    expect(command('cpp', 'linux', 2)).toBe('pkexec dnf install -y clang-tools-extra')
    expect(command('cpp', 'linux', 3)).toBe('pkexec pacman -S --needed --noconfirm clang')
    expect(command('cpp', 'linux', 4)).toBe('pkexec zypper --non-interactive install clang-tools')
    expect(command('rust', 'linux', 4, 'debugger')).toBe('brew install llvm')
    expect(command('java', 'linux')).toContain('curl -fsSL https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz')
    expect(command('java', 'win32')).toContain('tar -xzf "$d\\download.tar.gz" -C $d; if ($LASTEXITCODE) { exit $LASTEXITCODE }')
    expect(command('java', 'linux', 0, 'debugger')).toContain(`url=$(curl -fsSL https://open-vsx.org/api/vscjava/vscode-java-debug | grep -o '"download":"[^"]*"'`)
    expect(command('java', 'win32', 0, 'debugger')).toContain("$url = (Invoke-RestMethod -UseBasicParsing 'https://open-vsx.org/api/vscjava/vscode-java-debug').files.download")
    expect(command('kotlin', 'linux', 0, 'debugger')).toMatch(/adapter\.zip -o .* && chmod \+x '\/my tools\/kotlin-debug'\/adapter\/bin\/kotlin-debug-adapter$/)
    expect(command('kotlin', 'win32')).toContain("Invoke-WebRequest -UseBasicParsing 'https://github.com/fwcd/kotlin-language-server/releases/latest/download/server.zip'")
    expect(command('lua', 'linux', 0, 'server', 'arm64')).toContain("grep -E '-linux-arm64\\.tar\\.gz$'")
    expect(command('lua', 'win32', 1)).toContain("$_ -match '-win32-x64\\.zip$'")
    expect(command('swift', 'win32')).toContain('Swift.Toolchain')
    expect(command('go', 'win32')).toBe('go install golang.org/x/tools/gopls@latest')
    // Only Windows can install Swift's language server; elsewhere it comes with Xcode / the toolchain.
    expect(CATALOG.swift.server.install!.darwin).toBeUndefined()
    // clangd's own Linux builds are x64 only.
    expect(CATALOG.cpp.server.install!.linux![0].arch).toEqual(['x64'])
    expect(osOf('freebsd')).toBe('linux')
  })

  it('arguments and settings for every server', async () => {
    const root = await tempDir()
    for (const entry of Object.values(CATALOG)) {
      expect(Array.isArray(entry.server.args({ root, tools: '/tools' }))).toBe(true)
      entry.server.settings?.(root)
    }
    expect(CATALOG.java.server.args({ root: '/a', tools: '/t' })).toEqual(['-data', expect.stringMatching(/^\/t\/jdtls\/[0-9a-f]{12}$/)])
  })

  it('finds nothing on an empty machine', async () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      for (const [id, entry] of Object.entries(CATALOG)) {
        expect(await locate(id, 'server', machine({ platform })), `${id} ${platform}`).toBeUndefined()
        if (entry.debugger) expect(await locate(id, 'debugger', machine({ platform })), `${id} ${platform}`).toBeUndefined()
      }
    }
  })

  it('finds tools on the PATH, in Mindeck’s tools folder and where toolchains put them', async () => {
    // npm installs into the tools folder (found before the PATH).
    expect(await locate('python', 'server', machine({ files: ['/t/npm/node_modules/.bin/pyright-langserver'], path: { 'pyright-langserver': '/usr/bin/p' } }))).toBe('/t/npm/node_modules/.bin/pyright-langserver')
    expect(await locate('yaml', 'server', machine({ path: { 'yaml-language-server': '/usr/bin/y' } }))).toBe('/usr/bin/y')
    // Go: the PATH, GOPATH/bin (its first entry), ~/go/bin.
    expect(await locate('go', 'server', machine({ path: { gopls: '/bin/gopls' } }))).toBe('/bin/gopls')
    expect(await locate('go', 'server', machine({ answers: { 'go env GOPATH': '/gp:/other' }, files: ['/gp/bin/gopls'] }))).toBe('/gp/bin/gopls')
    expect(await locate('go', 'debugger', machine({ platform: 'win32', answers: { 'go env GOPATH': 'C:\\gp;D:\\x' }, files: [join('C:\\gp', 'bin', 'dlv')] }))).toBe(join('C:\\gp', 'bin', 'dlv'))
    expect(await locate('go', 'debugger', machine({ files: ['/h/go/bin/dlv'] }))).toBe('/h/go/bin/dlv')
    // Rust: rustup's answer first (the PATH's rust-analyzer may be its proxy).
    expect(await locate('rust', 'server', machine({ answers: { 'rustup which rust-analyzer': '/r/ra\n' }, files: ['/r/ra'], path: { 'rust-analyzer': '/proxy' } }))).toBe('/r/ra')
    expect(await locate('rust', 'server', machine({ path: { 'rust-analyzer': '/brew/ra' } }))).toBe('/brew/ra')
    // LLDB: Xcode's, Homebrew's LLVM, the LLVM installer's on Windows.
    expect(await locate('rust', 'debugger', machine({ platform: 'darwin', answers: { 'xcrun --find lldb-dap': '/x/lldb-dap' }, files: ['/x/lldb-dap'] }))).toBe('/x/lldb-dap')
    expect(await locate('cpp', 'debugger', machine({ platform: 'darwin', files: ['/usr/local/opt/llvm/bin/lldb-dap'] }))).toBe('/usr/local/opt/llvm/bin/lldb-dap')
    expect(await locate('swift', 'debugger', machine({ path: { 'lldb-vscode': '/u/lldb-vscode' } }))).toBe('/u/lldb-vscode')
    const pf = join('D:\\Apps', 'LLVM', 'bin', 'lldb-dap')
    expect(await locate('cpp', 'debugger', machine({ platform: 'win32', env: { ProgramFiles: 'D:\\Apps' }, files: [pf] }))).toBe(pf)
    const pfDefault = join('C:\\Program Files', 'LLVM', 'bin', 'clangd')
    expect(await locate('cpp', 'server', machine({ platform: 'win32', files: [pfDefault] }))).toBe(pfDefault)
    expect(await locate('cpp', 'server', machine({ platform: 'darwin', answers: { 'xcrun --find clangd': '/xc/clangd' }, files: ['/xc/clangd'] }))).toBe('/xc/clangd')
    expect(await locate('cpp', 'server', machine({ platform: 'darwin', files: ['/opt/homebrew/opt/llvm/bin/clangd'] }))).toBe('/opt/homebrew/opt/llvm/bin/clangd')
    // Java, C#, Ruby, Swift, Kotlin, Lua, PHP.
    expect(await locate('java', 'server', machine({ files: ['/t/jdtls-server/bin/jdtls'] }))).toBe('/t/jdtls-server/bin/jdtls')
    expect(await locate('csharp', 'server', machine({ files: ['/h/.dotnet/tools/csharp-ls'] }))).toBe('/h/.dotnet/tools/csharp-ls')
    expect(await locate('ruby', 'server', machine({ answers: { 'ruby -e print Gem.bindir': '/gems/bin' }, files: ['/gems/bin/ruby-lsp'] }))).toBe('/gems/bin/ruby-lsp')
    expect(await locate('swift', 'server', machine({ platform: 'darwin', answers: { 'xcrun --find sourcekit-lsp': '/x/sk' }, files: ['/x/sk'] }))).toBe('/x/sk')
    expect(await locate('kotlin', 'server', machine({ files: ['/t/kotlin-ls/server/bin/kotlin-language-server'] }))).toBe('/t/kotlin-ls/server/bin/kotlin-language-server')
    expect(await locate('kotlin', 'debugger', machine({ files: ['/t/kotlin-debug/adapter/bin/kotlin-debug-adapter'] }))).toBe('/t/kotlin-debug/adapter/bin/kotlin-debug-adapter')
    expect(await locate('lua', 'server', machine({ files: ['/t/lua-ls/bin/lua-language-server'] }))).toBe('/t/lua-ls/bin/lua-language-server')
    expect(which(machine({ path: { b: '/b' } }), 'a', 'b')).toBe('/b')
    expect(inDir(machine(), undefined, 'x')).toBeUndefined()
  })

  it('files Mindeck downloaded: debugpy, Java Debug, PHP Debug, clangd’s own build', async () => {
    const tools = await tempDir()
    const ctx = { ...machine(), tools }
    await mkdir(join(tools, 'debugpy', 'debugpy'), { recursive: true })
    await writeFile(join(tools, 'debugpy', 'debugpy', '__init__.py'), '')
    expect(await locate('python', 'debugger', ctx)).toBe(join(tools, 'debugpy'))
    const server = join(tools, 'java-debug', 'extension', 'server')
    await mkdir(server, { recursive: true })
    await writeFile(join(server, 'com.microsoft.java.debug.plugin-0.53.2.jar'), '')
    expect(await locate('java', 'debugger', ctx)).toBe(join(server, 'com.microsoft.java.debug.plugin-0.53.2.jar'))
    const out = join(tools, 'php-debug', 'extension', 'out')
    await mkdir(out, { recursive: true })
    await writeFile(join(out, 'phpDebug.js'), '')
    expect(await locate('php', 'debugger', ctx)).toBe(join(out, 'phpDebug.js'))
    await mkdir(join(tools, 'clangd', 'notes'), { recursive: true })
    const clangd = await program(join(tools, 'clangd', 'clangd_19.1.2', 'bin'), 'clangd')
    expect(await locate('cpp', 'server', { ...ctx, executable: (f: string) => (existsSync(f) ? f : undefined) })).toBe(clangd)
  })

  it('Linux: the distribution’s versioned LLVM builds, newest first', async () => {
    const usr = await tempDir()
    await mkdir(join(usr, 'lib', 'llvm-18', 'bin'), { recursive: true }) // no lldb-dap in the newest
    const llvm17 = await program(join(usr, 'lib', 'llvm-17', 'bin'), 'lldb-dap')
    await mkdir(join(usr, 'lib', 'llvm-x'), { recursive: true })
    const exec = (f: string) => (existsSync(f) ? f : undefined)
    const ctx = { ...machine({ system: usr }), executable: exec }
    expect(await locate('cpp', 'debugger', ctx)).toBe(llvm17)
    const clangd16 = await program(join(usr, 'bin'), 'clangd-16')
    await program(join(usr, 'bin'), 'clangd-x')
    expect(await locate('cpp', 'server', ctx)).toBe(clangd16)
    expect(llvmBuild({ ...ctx, platform: 'darwin' }, 'clangd')).toBeUndefined()
    expect(llvmBuild(ctx, 'nothing')).toBeUndefined()
  })

  it('Python runs in the project’s virtualenv when it has one', async () => {
    const root = await tempDir()
    expect(pythonFor(root)).toBe('python3')
    await mkdir(join(root, 'venv/bin'), { recursive: true })
    await writeFile(join(root, 'venv/bin/python'), '')
    expect(pythonFor(root)).toBe(join(root, 'venv/bin/python'))
    // Windows: the virtualenv keeps it in Scripts, the system's is `python`.
    expect(pythonFor(root, 'win32')).toBe('python')
    await mkdir(join(root, '.venv/Scripts'), { recursive: true })
    await writeFile(join(root, '.venv/Scripts/python.exe'), '')
    expect(pythonFor(root, 'win32')).toBe(join(root, '.venv/Scripts/python.exe'))
    expect([systemPython('linux'), systemPython('win32')]).toEqual(['python3', 'python'])
  })
})

describe('ToolsService', () => {
  /** A machine with these programs on its PATH (empty scripts) and a tools folder. */
  async function setup(programs: string[] = [], opts: Partial<ConstructorParameters<typeof ToolsService>[0]> = {}) {
    const bin = join(await tempDir(), 'bin')
    await mkdir(bin, { recursive: true })
    for (const p of programs) await program(bin, p)
    const dir = join(await tempDir(), 'tools')
    const progress: ToolProgress[] = []
    const tools = new ToolsService({ dir, path: async () => bin, platform: 'linux', arch: 'x64', home: '/h', system: '/nowhere', env: {}, exec: async () => '', publish: (p) => progress.push(p), ...opts })
    return { tools, dir, bin, progress }
  }

  it('tells what is ready, installable, needs its toolchain first or comes with one', async () => {
    const { tools, dir } = await setup(['npm', 'python3', 'clangd', 'curl'])
    await program(join(dir, 'npm', 'node_modules', '.bin'), 'pyright-langserver')
    const byId = Object.fromEntries((await tools.status()).map((l) => [l.id, l]))
    expect(byId.python.server).toEqual({ name: 'Pyright', state: 'ready' })
    expect(byId.python.debugger).toMatchObject({ name: 'debugpy', state: 'missing', requires: 'python3', command: expect.stringContaining('python3 -m pip') })
    expect(byId.go.server).toMatchObject({ state: 'toolchain', requires: 'go', command: 'go install golang.org/x/tools/gopls@latest' })
    expect(byId.cpp.server.state).toBe('ready')
    expect(byId.swift.server).toEqual({ name: 'SourceKit-LSP', state: 'manual' })
    // A download needs everything it uses: curl is there, tar isn't.
    expect(byId.java.server).toMatchObject({ state: 'toolchain', requires: 'java' })
    expect(byId.lua.server).toMatchObject({ state: 'toolchain', requires: 'curl' })
    expect(byId.rust.debugger).toMatchObject({ name: 'lldb-dap', state: 'toolchain', requires: 'apt-get' })
    expect(byId.lua.debugger).toBeUndefined()
    // What status() found is what locate() answers.
    expect(await tools.locate('python', 'server')).toBe(join(dir, 'npm', 'node_modules', '.bin', 'pyright-langserver'))
    expect(await tools.locate('python', 'debugger')).toBeUndefined()
    expect(tools.dir).toBe(dir)
  })

  it('a download built for some architectures only: the distribution’s package elsewhere', async () => {
    const { tools } = await setup(['curl', 'unzip', 'apt-get', 'pkexec'], { arch: 'arm64' })
    const cpp = (await tools.status()).find((l) => l.id === 'cpp')!
    expect(cpp.server).toMatchObject({ state: 'missing', requires: 'apt-get', command: 'pkexec apt-get install -y clangd' })
  })

  it('locate looks up what it doesn’t know yet; unknown tools are not there; a failing lookup finds nothing', async () => {
    const { tools, bin } = await setup(['gopls'])
    expect(await tools.locate('go', 'server')).toBe(join(bin, 'gopls'))
    expect(await tools.locate('go', 'server')).toBe(join(bin, 'gopls')) // cached
    expect(await tools.locate('rust', 'debugger')).toBeUndefined()
    expect(await tools.locate('cobol', 'server')).toBeUndefined()
    expect(await tools.locate('cobol', 'debugger')).toBeUndefined()
    const original = CATALOG.lua.server.locate
    CATALOG.lua.server.locate = () => Promise.reject(new Error('broken'))
    try {
      expect(await tools.locate('lua', 'server')).toBeUndefined()
    } finally {
      CATALOG.lua.server.locate = original
    }
  })

  it('asks a toolchain once per lookup, and only when the toolchain is there', async () => {
    const exec = vi.fn(async (file: string, args: string[]) => (args[0] === 'env' ? '/gp\n' : Promise.reject(new Error('no'))))
    const { tools, bin } = await setup(['go', 'rustup'], { exec })
    const status = await tools.status()
    expect(status.find((l) => l.id === 'go')!.server.state).toBe('missing')
    // `go env GOPATH` served gopls and Delve; rustup's failure is no answer.
    expect(exec.mock.calls.filter(([, args]) => args[0] === 'env')).toEqual([[join(bin, 'go'), ['env', 'GOPATH'], expect.objectContaining({ PATH: bin })]])
    expect(exec.mock.calls.some(([file]) => file.endsWith('rustup'))).toBe(true)
  })

  it('Node, npm and git with their versions', async () => {
    const exec = vi.fn(async (file: string) => (file.endsWith('node') ? 'v22.11.0\n' : 'no version'))
    const { tools, bin } = await setup(['node', 'npm'], { exec })
    expect(await tools.runtimes()).toEqual([
      { name: 'node', found: true, path: join(bin, 'node'), version: '22.11.0' },
      { name: 'npm', found: true, path: join(bin, 'npm'), version: undefined },
      { name: 'git', found: false }
    ])
  })

  it('Windows: PATHEXT’s endings, where.exe for what the PATH missed, PowerShell installs with the fresh PATH', async () => {
    const bin = join(await tempDir(), 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'npm.cmd'), '')
    await writeFile(join(bin, 'winget.exe'), '')
    await writeFile(join(bin, 'powershell.exe'), '')
    const dir = join(await tempDir(), 'tools')
    const where = vi.fn(async (names: string[], _env: Record<string, string>) => new Map(names.includes('go') ? [['go', 'C:\\Go\\bin\\go.exe']] : []))
    const runs: { command: string; env?: Record<string, string> }[] = []
    const run: Runner = async (command, _cwd, onLine, env) => {
      runs.push({ command, env })
      onLine('done')
      return 0
    }
    const tools = new ToolsService({ dir, path: async () => bin, platform: 'win32', arch: 'x64', home: 'C:\\Users\\me', env: { PATHEXT: '.EXE;.CMD', Path: 'C:\\old' }, exec: async () => '', where, run })
    const byId = Object.fromEntries((await tools.status()).map((l) => [l.id, l]))
    expect(where).toHaveBeenCalledTimes(1)
    expect(where.mock.calls[0][0]).toEqual(expect.arrayContaining(['gopls', 'go', 'clangd', 'scoop']))
    expect(where.mock.calls[0][1]).toMatchObject({ Path: bin })
    expect(byId.go.server).toMatchObject({ state: 'missing', requires: 'go' }) // where.exe found go
    expect(byId.cpp.server).toMatchObject({ state: 'missing', requires: 'winget', command: expect.stringContaining('winget install --id LLVM.LLVM') })
    expect(byId.swift.server).toMatchObject({ state: 'missing', requires: 'winget' })
    expect(byId.lua.server).toMatchObject({ state: 'missing', requires: 'powershell', command: expect.stringContaining('Invoke-RestMethod') })
    await tools.install('cpp', 'server')
    expect(runs[0].command).toMatch(/^winget install/)
    expect(runs[0].env).toMatchObject({ PATH: bin })
    // where.exe finding nothing keeps the first answer.
    const none = new ToolsService({ dir, path: async () => bin, platform: 'win32', env: {}, exec: async () => '' }) // where.exe: not on this machine
    expect(await none.locate('yaml', 'server')).toBeUndefined()
  })

  it('installs on request: output streams, a failure says why, one install at a time', async () => {
    let exit = 0
    let release!: () => void
    const { tools, dir, progress } = await setup(['npm', 'go', 'curl'], {
      run: async (command, cwd, onLine) => {
        expect(cwd).toBe(dir)
        for (let i = 1; i <= 14; i += 1) onLine(`line ${i}`)
        if (command.includes('slow')) await new Promise<void>((r) => (release = r))
        if (command.startsWith('npm install') && exit === 0) await program(join(dir, 'npm', 'node_modules', '.bin'), 'pyright-langserver')
        return exit
      }
    })
    const result = await tools.install('python', 'server')
    expect(result.server.state).toBe('ready')
    expect(progress[0]).toEqual({ id: 'python', part: 'server', line: expect.stringContaining('$ npm install --prefix') })
    expect(progress).toHaveLength(15)

    exit = 1
    await expect(tools.install('php', 'server')).rejects.toMatchObject({ code: 'install-failed', message: expect.stringMatching(/^line 3\n[\s\S]*line 14$/) })
    const quiet = await setup(['npm'], { run: async () => 2 })
    await expect(quiet.tools.install('yaml', 'server')).rejects.toMatchObject({ message: 'YAML Language Server: exit 2' })
    await expect(tools.install('swift', 'server')).rejects.toMatchObject({ code: 'not-installable' })
    await expect(tools.install('lua', 'debugger')).rejects.toMatchObject({ code: 'not-installable' })
    await expect(tools.install('cobol', 'server')).rejects.toMatchObject({ code: 'not-installable' })
    await expect(tools.install('ruby', 'server')).rejects.toMatchObject({ code: 'toolchain', message: 'Ruby LSP needs gem — install it first' })

    exit = 0
    const original = CATALOG.go.server.install!.linux![0].command
    CATALOG.go.server.install!.linux![0].command = () => 'slow'
    try {
      const first = tools.install('go', 'server')
      await new Promise((r) => setTimeout(r, 20))
      await expect(tools.install('go', 'server')).rejects.toMatchObject({ code: 'busy' })
      release()
      await first
    } finally {
      CATALOG.go.server.install!.linux![0].command = original
    }
  })

  it('by default it searches the user’s PATH and installs through the login shell', async () => {
    const dir = join(await tempDir(), 'tools')
    const tools = new ToolsService({ dir })
    expect((await tools.status()).map((l) => l.id)).toContain('python')
    expect(await tools.locate('kotlin', 'server')).toSatisfy((v: unknown) => v === undefined || typeof v === 'string')
    expect((await tools.runtimes()).map((r) => r.name)).toEqual(['node', 'npm', 'git'])
    const way = CATALOG.yaml.server.install!.linux![0]
    const original = way.command
    way.command = () => 'echo installed'
    const lines: string[] = []
    const bin = join(await tempDir(), 'bin')
    await program(bin, 'npm')
    try {
      const installer = new ToolsService({ dir, path: async () => bin, platform: 'linux', publish: (p) => lines.push(p.line) })
      await installer.install('yaml', 'server')
    } finally {
      way.command = original
    }
    expect(lines).toEqual(['$ echo installed', 'installed'])
  }, 30_000)

  it('the user’s PATH: the login shell’s, then Mindeck’s; the registry’s on Windows', async () => {
    expect(await userPath('linux', { PATH: '/own' }, async () => '/login/bin:/usr/bin\n')).toBe('/login/bin:/usr/bin:/own')
    expect(await userPath('darwin', {}, () => Promise.reject(new Error('no shell')))).toBe('')
    expect(await userPath('win32', { Path: 'C:\\own' }, undefined, async (key) => (key.startsWith('HKCU') ? 'C:\\user' : ''))).toBe('C:\\user;C:\\own')
    expect(await userPath()).toContain(process.env.PATH!.split(':')[0])
  }, 20_000)

  it('the user’s environment: Mindeck’s for a terminal (no ELECTRON_*), with their PATH', async () => {
    process.env.ELECTRON_RUN_AS_NODE = '1'
    try {
      const env = await userEnv(async () => '/login/bin:/usr/bin')
      expect(env.PATH).toBe('/login/bin:/usr/bin')
      expect(env.TERM_PROGRAM).toBe('Mindeck')
      expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    } finally {
      delete process.env.ELECTRON_RUN_AS_NODE
    }
  })

  it('the install runner: lines from stdout and stderr, the exit code, a shell that can’t start; PowerShell on Windows', async () => {
    const got: string[] = []
    expect(await loginShellRunner("printf 'a\\nb'; echo err >&2; exit 3", await tempDir(), (l) => got.push(l))).toBe(3)
    expect(got.sort()).toEqual(['a', 'b', 'err'])
    expect(await loginShellRunner('kill -9 $$', await tempDir(), () => {})).toBe(1) // killed: no exit code
    const failed: string[] = []
    expect(await loginShellRunner('true', '/definitely/not/here', (l) => failed.push(l))).toBe(127)
    expect(failed[0]).toMatch(/ENOENT/)
    expect(PS_PRELUDE).toContain("$ErrorActionPreference = 'Stop'")
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' }) // powershell.exe isn't on this machine
    try {
      const lines: string[] = []
      expect(await loginShellRunner('winget --version', await tempDir(), (l) => lines.push(l), { PATH: '/nowhere' })).toBe(127)
      expect(lines[0]).toMatch(/powershell\.exe/)
    } finally {
      Object.defineProperty(process, 'platform', { value: platform })
    }
  }, 20_000)
})
