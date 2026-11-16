import { EventEmitter } from 'node:events'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'
import {
  cmdArg,
  executableAt,
  expandWindowsVars,
  findExecutable,
  outputOf,
  programPath,
  programSearch,
  psQuote,
  regValue,
  searchPath,
  spawnProgram,
  whereExe,
  windowsPath,
  withPath
} from '../../../electron/main/lib/executables'
import { powershellArgs } from '../../../electron/main/lib/shellArgs'

/** A spawn double recording what would have started. */
function fakeSpawn() {
  const calls: { file: string; args: string[]; options: Record<string, unknown> }[] = []
  const run = ((file: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options })
    return Object.assign(new EventEmitter(), { stdout: new PassThrough() })
  }) as unknown as typeof spawn
  return { run, calls }
}

describe('finding programs without a shell', () => {
  it('a PATH as folders: per platform, unquoted, without blanks and duplicates; PATHEXT on Windows', () => {
    expect(searchPath('/a::/b:/a', 'linux')).toEqual({ platform: 'linux', dirs: ['/a', '/b'], pathext: [] })
    expect(searchPath('C:\\a;"C:\\Program Files\\x"; ;C:\\a', 'win32', '.EXE;.CMD;')).toEqual({
      platform: 'win32',
      dirs: ['C:\\a', 'C:\\Program Files\\x'],
      pathext: ['.exe', '.cmd']
    })
    expect(searchPath('', 'win32', '').pathext).toEqual(['.com', '.exe', '.bat', '.cmd'])
    expect(searchPath('x').platform).toBe(process.platform)
  })

  it('macOS / Linux: executable files only', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'tool'), '#!/bin/sh\n')
    await chmod(join(dir, 'tool'), 0o755)
    await writeFile(join(dir, 'plain'), '')
    await mkdir(join(dir, 'folder'))
    const search = searchPath(`/nowhere:${dir}`, 'linux')
    expect(findExecutable('tool', search)).toBe(join(dir, 'tool'))
    expect(findExecutable('plain', search)).toBeUndefined()
    expect(findExecutable('folder', search)).toBeUndefined()
    expect(findExecutable('missing', search)).toBeUndefined()
    // A path is checked as it is.
    expect(findExecutable(join(dir, 'tool'), searchPath('', 'linux'))).toBe(join(dir, 'tool'))
    expect(findExecutable('./x/tool', search)).toBeUndefined()
  })

  it('Windows: PATHEXT’s endings for bare names, the name itself when it has one', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'npm'), '') // npm's sh script — not for Windows
    await writeFile(join(dir, 'npm.cmd'), '')
    await writeFile(join(dir, 'gopls.exe'), '')
    await mkdir(join(dir, 'odd.exe'))
    const search = searchPath(dir, 'win32', '.COM;.EXE;.BAT;.CMD')
    expect(findExecutable('npm', search)).toBe(join(dir, 'npm.cmd'))
    expect(findExecutable('gopls', search)).toBe(join(dir, 'gopls.exe'))
    expect(findExecutable('gopls.exe', search)).toBe(join(dir, 'gopls.exe'))
    expect(findExecutable('odd', search)).toBeUndefined()
    expect(findExecutable('C:\\x\\tool', search)).toBeUndefined()
    expect(executableAt(join(dir, 'npm'), search)).toBe(join(dir, 'npm.cmd'))
  })

  it('where.exe answers for many names at once, even when it exits non-zero', async () => {
    const exec = vi.fn(async () => 'C:\\Go\\bin\\go.exe\r\nC:\\Users\\me\\go\\bin\\GOPLS.EXE\r\n\r\nC:\\other\\go.exe\n')
    const hits = await whereExe(['go', 'gopls', 'dlv'], { PATH: 'x' }, exec)
    expect(exec).toHaveBeenCalledWith('where.exe', ['go', 'gopls', 'dlv'], { PATH: 'x' })
    expect([...hits]).toEqual([
      ['go', 'C:\\Go\\bin\\go.exe'],
      ['gopls', 'C:\\Users\\me\\go\\bin\\GOPLS.EXE']
    ])
    expect((await whereExe([], {}, exec)).size).toBe(0)
    expect(exec).toHaveBeenCalledTimes(1)
    expect((await whereExe(['x'], {}, () => Promise.reject(new Error('gone')))).size).toBe(0)
    // Not on Windows: where.exe isn't there — nothing found.
    expect((await whereExe(['node'], process.env as Record<string, string>)).size).toBe(0)
  })

  it('Windows’ PATH from the registry, expanded, followed by Mindeck’s own', async () => {
    const query = vi.fn(async (key: string) => (key.startsWith('HKLM') ? '%SystemRoot%\\system32;%ProgramFiles%\\Git\\cmd' : '%USERPROFILE%\\.cargo\\bin;%NOPE%'))
    const env = { SYSTEMROOT: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', UserProfile: 'C:\\Users\\me', Path: 'C:\\mindeck' }
    expect(await windowsPath(env, query)).toBe('C:\\Windows\\system32;C:\\Program Files\\Git\\cmd;C:\\Users\\me\\.cargo\\bin;%NOPE%;C:\\mindeck')
    expect(await windowsPath({}, () => Promise.reject(new Error('no reg')))).toBe('')
    // reg.exe isn't here: only the process's own PATH remains.
    expect(await windowsPath({ PATH: '/bin' })).toBe('/bin')
    expect(regValue('\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\x  \r\n')).toBe('%USERPROFILE%\\bin;C:\\x')
    expect(regValue('    Path    REG_SZ    C:\\y')).toBe('C:\\y')
    expect(regValue('ERROR: not found')).toBe('')
    expect(expandWindowsVars('%a%%B%', { A: '1', b: '2', c: undefined })).toBe('12')
  })

  it('an environment with its PATH replaced, keeping Windows’ spelling', () => {
    expect(withPath({ Path: 'old', HOME: '/h' }, 'new')).toEqual({ Path: 'new', HOME: '/h' })
    expect(withPath({ PATH: 'old', path: 'x' }, 'new')).toEqual({ PATH: 'new' })
    expect(withPath({}, 'new')).toEqual({ PATH: 'new' })
  })
})

describe('starting programs without a shell', () => {
  it('quotes for cmd.exe and PowerShell', () => {
    expect(cmdArg('--stdio')).toBe('^"--stdio^"')
    expect(cmdArg('a "b" c\\')).toBe('^"a^ \\^"b\\^"^ c\\\\^"')
    expect(cmdArg('100%', true)).toBe('^^^"100^^^%^^^"')
    expect(psQuote("it's here")).toBe("'it''s here'")
    expect(powershellArgs('Get-Date')).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'Get-Date'])
  })

  it('Windows: batch files through cmd.exe (npm’s shims escaped twice), programs directly', () => {
    const { run, calls } = fakeSpawn()
    const comspec = process.env.ComSpec
    delete process.env.ComSpec
    try {
      // Without ComSpec, cmd.exe from the PATH — none here: a path that doesn't exist, never the project's cmd.exe.
      spawnProgram('C:\\t\\npm\\node_modules\\.bin\\pyright-langserver.cmd', ['--stdio'], { cwd: 'C:\\p' }, 'win32', run)
      process.env.ComSpec = 'C:\\Windows\\system32\\cmd.exe'
      spawnProgram('C:\\Program Files\\kotlin\\adapter.bat', ['a b'], {}, 'win32', run)
    } finally {
      if (comspec === undefined) delete process.env.ComSpec
      else process.env.ComSpec = comspec
    }
    spawnProgram('C:\\LLVM\\bin\\lldb-dap.exe', [], { cwd: 'C:\\p' }, 'win32', run)
    spawnProgram('/usr/bin/lldb-dap', ['x'], {}, 'linux', run)
    expect(calls[0]).toEqual({
      file: expect.stringMatching(/not-on-PATH\\cmd\.exe$/),
      args: ['/d', '/s', '/c', '"C:\\t\\npm\\node_modules\\.bin\\pyright-langserver.cmd ^^^"--stdio^^^""'],
      options: { cwd: 'C:\\p', windowsVerbatimArguments: true, windowsHide: true }
    })
    expect(calls[1].file).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(calls[1].args[3]).toBe('"C:\\Program^ Files\\kotlin\\adapter.bat ^"a^ b^""')
    expect(calls[2]).toEqual({ file: 'C:\\LLVM\\bin\\lldb-dap.exe', args: [], options: { cwd: 'C:\\p', windowsHide: true } })
    expect(calls[3]).toEqual({ file: '/usr/bin/lldb-dap', args: ['x'], options: { windowsHide: true } })
  })

  it('programs by name come from the PATH’s absolute folders — never the working folder (binary planting, BE-SEC-03)', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'tool'), '#!/bin/sh\n')
    await chmod(join(dir, 'tool'), 0o755)
    // macOS / Linux: an empty or relative PATH entry means a folder relative to the working folder.
    expect(programSearch({ PATH: `:.:bin:${dir}` }, 'linux').dirs).toEqual([dir])
    expect(programPath('tool', { PATH: `.:${dir}` }, 'linux')).toBe(join(dir, 'tool'))
    const missing = programPath('tool', { PATH: '.:bin' }, 'linux')
    expect(missing).toBe(join(dirname(process.execPath), 'not-on-PATH', 'tool'))
    expect(existsSync(missing)).toBe(false)
    expect(programPath('tool', {}, 'linux')).toBe(missing) // no PATH at all
    // A path is used as given.
    expect(programPath('/usr/bin/git', {}, 'linux')).toBe('/usr/bin/git')
    expect(programPath('./git', {}, 'linux')).toBe('./git')

    // Windows looks into the working folder first for a bare name: only drive and UNC folders count
    // (`//…` is a UNC path there — and the same folder here, so the test runs everywhere).
    await writeFile(join(dir, 'git.exe'), '')
    await writeFile(join(dir, 'npm.cmd'), '')
    const win = { Path: `.;tools;C:tools;\\tools;//${dir}`, PathExt: '.EXE;.CMD' }
    expect(programSearch(win, 'win32')).toEqual({ platform: 'win32', dirs: [`//${dir}`], pathext: ['.exe', '.cmd'] })
    expect(programPath('git', win, 'win32')).toBe(join(`//${dir}`, 'git.exe'))
    expect(programPath('git', { Path: '.;tools' }, 'win32')).toMatch(/not-on-PATH\\git$/)
    expect(programPath('C:\\Git\\cmd\\git.exe', {}, 'win32')).toBe('C:\\Git\\cmd\\git.exe')
    expect(programPath('bin\\git', {}, 'win32')).toBe('bin\\git')
    expect(programPath('bin/git', {}, 'win32')).toBe('bin/git')
    // spawnProgram on Windows: bare names resolved (npm → its .cmd through cmd.exe), else the path that doesn't exist.
    const { run, calls } = fakeSpawn()
    spawnProgram('npm', ['-v'], { cwd: 'C:\\p', env: win }, 'win32', run)
    spawnProgram('git', ['status'], { cwd: 'C:\\p', env: { Path: '.' } }, 'win32', run)
    expect(calls[0].args[3]).toContain('npm.cmd')
    expect(calls[1].file).toMatch(/not-on-PATH\\git$/)
    // Defaults: this machine's PATH and platform.
    expect(programSearch().platform).toBe(process.platform)
    expect(programPath('definitely-not-installed-xyz')).toContain('not-on-PATH')
  })

  it('a program’s output when it succeeds, else nothing', async () => {
    const out = outputOf()
    const env = process.env as Record<string, string>
    expect(await out(process.execPath, ['-e', 'process.stdout.write("v1.2.3")'], { ...env, ELECTRON_RUN_AS_NODE: '1' })).toBe('v1.2.3')
    expect(await out(process.execPath, ['-e', 'process.exit(2)'], { ...env, ELECTRON_RUN_AS_NODE: '1' })).toBe('')
    expect(await out('/definitely/not/here', [], env)).toBe('')
  })
})
