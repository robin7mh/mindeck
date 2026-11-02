import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'

// Which files "exist" (and what /etc/shells lists) for shell detection; null = the real ones.
const fsState = vi.hoisted(() => ({ files: null as Set<string> | null, etcShells: null as string | Error | null }))
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (p: string) => (fsState.files ? fsState.files.has(p) : actual.existsSync(p)),
    readFileSync: ((p: string, ...rest: unknown[]) => {
      if (p !== '/etc/shells' || fsState.etcShells === null) return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
      if (fsState.etcShells instanceof Error) throw fsState.etcShells
      return fsState.etcShells
    }) as typeof actual.readFileSync
  }
})

import { PWSH, SCRIPTS, fileUrlPath, integrate, scanCwd, shellKind, writeScripts } from '../../../electron/main/services/terminal/integration'
import { detectShells } from '../../../electron/main/services/terminal/shells'

afterEach(() => {
  fsState.files = null
  fsState.etcShells = null
})

const hasBash = spawnSync('bash', ['--version']).status === 0

describe('shell integration: who takes it, and how', () => {
  it('knows the shells by their binary', () => {
    expect(shellKind('/bin/zsh', 'darwin')).toBe('zsh')
    expect(shellKind('/usr/local/bin/fish', 'linux')).toBe('fish')
    expect(shellKind('bash', 'linux')).toBe('bash')
    expect(shellKind('/bin/sh', 'linux')).toBeUndefined()
    expect(shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32')).toBe('pwsh')
    expect(shellKind('powershell.exe', 'win32')).toBe('pwsh')
    expect(shellKind('/usr/bin/pwsh', 'linux')).toBe('pwsh')
    expect(shellKind('C:\\Program Files\\Git\\bin\\bash.exe', 'win32')).toBeUndefined()
    expect(shellKind('/bin/zsh')).toBe('zsh') // this platform by default
  })

  it('injects per shell, leaving shells started with arguments of their own alone', () => {
    const dir = '/data/si'
    expect(integrate({ file: '/bin/bash', args: ['-l'] }, dir, {}, 'linux')).toEqual({
      file: '/bin/bash',
      args: ['--init-file', '/data/si/mindeck.bash', '-i'],
      env: { MINDECK_SHELL_LOGIN: '1' }
    })
    expect(integrate({ file: '/bin/bash', args: [] }, dir, {}, 'linux')!.env).toEqual({})
    expect(integrate({ file: '/bin/bash', args: ['-c', 'ls'] }, dir, {}, 'linux')).toBeUndefined()
    expect(integrate({ file: '/bin/zsh', args: ['--login'] }, dir, { ZDOTDIR: '/z' }, 'darwin')).toEqual({
      file: '/bin/zsh',
      args: ['--login'],
      env: { ZDOTDIR: '/data/si/zsh', MINDECK_ZDOTDIR: '/z' }
    })
    expect(integrate({ file: 'fish', args: ['-l'] }, "/it's", {}, 'linux')).toEqual({
      file: 'fish',
      args: ['-l', '--init-command', "source '/it\\'s/mindeck.fish'"]
    })
    expect(integrate({ file: '/bin/sh', args: [] }, dir, {}, 'linux')).toBeUndefined()

    const pwsh = integrate({ file: 'pwsh.exe', args: ['-NoLogo'] }, dir, {}, 'win32')!
    expect(pwsh.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand'])
    expect(Buffer.from(pwsh.args[3], 'base64').toString('utf16le')).toBe(PWSH)
    expect(integrate({ file: '/usr/bin/pwsh', args: ['-Login', '-NoLogo'] }, dir, {}, 'linux')!.args[0]).toBe('-Login')
    expect(integrate({ file: 'pwsh', args: ['-Command', 'x'] }, dir, {}, 'win32')).toBeUndefined()
    expect(integrate({ file: '/bin/zsh', args: ['-l'] }, dir, {})).toBeDefined() // this platform by default
  })

  it('writes the script files', async () => {
    const dir = await tempDir()
    await writeScripts(dir)
    for (const [file, text] of Object.entries(SCRIPTS)) expect(await readFile(join(dir, file), 'utf8')).toBe(text)
    // zsh hands ZDOTDIR back to the user's once its startup files are read
    expect(SCRIPTS['zsh/.zlogin']).toContain('unset ZDOTDIR')
    expect(SCRIPTS['zsh/.zshrc']).toContain('[[ -o login ]] ||')
  })

  it.runIf(hasBash)('bash reports folders and command boundaries, keeping the user’s prompt hooks', async () => {
    const home = await tempDir()
    const dir = await tempDir()
    await writeScripts(dir)
    await writeFile(join(home, '.bashrc'), 'PS1="my> "\nPROMPT_COMMAND="echo user-hook"\n')
    const run = spawnSync('bash', ['--init-file', join(dir, 'mindeck.bash'), '-i'], {
      input: 'cd /tmp\n\nfalse\nexit\n',
      env: { HOME: home, PATH: process.env.PATH, HOSTNAME: 'box' },
      encoding: 'utf8'
    })
    const out = run.stdout
    expect(out).toContain('\x1b]7;file://box/tmp\x07')
    expect(out).toContain('user-hook')
    // `cd` ran (C … D;0), the empty line ran nothing, `false` failed (D;1), then `exit`
    expect(out.match(/\x1b\]133;C\x07/g)).toHaveLength(3)
    expect(out).toContain('\x1b]133;D;0\x07')
    expect(out).toContain('\x1b]133;D;1\x07')
    expect(run.stderr).toContain('\x1b]133;A\x07my> \x1b]133;B\x07')

    // a login shell reads the profile files instead
    await writeFile(join(home, '.profile'), 'echo from-profile\n')
    const login = spawnSync('bash', ['--init-file', join(dir, 'mindeck.bash'), '-i'], {
      input: 'exit\n',
      env: { HOME: home, PATH: process.env.PATH, MINDECK_SHELL_LOGIN: '1' },
      encoding: 'utf8'
    })
    expect(login.stdout).toContain('from-profile')
    expect(login.stdout).not.toContain('user-hook')
  })
})

describe('the folder a shell reports (OSC 7)', () => {
  it('reads file URLs as local paths', () => {
    expect(fileUrlPath('file://host/home/u/a%20b', 'linux')).toBe('/home/u/a b')
    expect(fileUrlPath('file:///tmp/100%', 'linux')).toBe('/tmp/100%') // not encoded after all
    expect(fileUrlPath('file://pc/C:/Users/u', 'win32')).toBe('C:\\Users\\u')
    expect(fileUrlPath('file://pc/home/u', 'win32')).toBeUndefined()
    expect(fileUrlPath('kitty-shell-cwd://h/x', 'linux')).toBeUndefined()
    expect(fileUrlPath('file://host/x')).toBe(process.platform === 'win32' ? undefined : '/x')
  })

  it('finds the last report, carrying an unfinished one to the next chunk', () => {
    expect(scanCwd('plain output', 'linux')).toEqual({ carry: '' })
    expect(scanCwd('\x1b]7;file://h/a\x07x\x1b]7;file://h/b\x1b\\y', 'linux')).toEqual({ cwd: '/b', carry: '' })
    expect(scanCwd('\x1b]7;file://h/a\x07\x1b]7;nope\x07', 'linux')).toEqual({ cwd: '/a', carry: '' })
    expect(scanCwd('out\x1b]7;file://h/pa', 'linux')).toEqual({ carry: '\x1b]7;file://h/pa' })
    expect(scanCwd(`\x1b]7;${'x'.repeat(5000)}`, 'linux')).toEqual({ carry: '' })
    expect(scanCwd('out\x1b]', 'linux')).toEqual({ carry: '\x1b]' })
    expect(scanCwd('out\x1b', 'linux')).toEqual({ carry: '\x1b' })
    expect(scanCwd('\x1b]7;file://h/z\x07')).toMatchObject({ carry: '' }) // this platform by default
  })
})

describe('detectShells', () => {
  it('macOS / Linux: /etc/shells first, then PATH and the usual folders', () => {
    fsState.etcShells = '# comment\n/bin/sh\n/usr/local/bin/zsh\n'
    fsState.files = new Set(['/usr/local/bin/zsh', '/bin/zsh', '/bin/bash', '/home/u/.local/bin/fish', '/opt/homebrew/bin/pwsh'])
    expect(detectShells('darwin', { PATH: '/home/u/.local/bin:relative' })).toEqual([
      { id: 'zsh', name: 'zsh', file: '/usr/local/bin/zsh', args: ['-l'] },
      { id: 'bash', name: 'bash', file: '/bin/bash', args: ['-l'] },
      { id: 'fish', name: 'fish', file: '/home/u/.local/bin/fish', args: ['-l'] },
      { id: 'pwsh', name: 'PowerShell', file: '/opt/homebrew/bin/pwsh', args: ['-Login', '-NoLogo'] }
    ])
    fsState.etcShells = new Error('EACCES')
    fsState.files = new Set(['/usr/bin/bash'])
    expect(detectShells('linux', {})).toEqual([{ id: 'bash', name: 'bash', file: '/usr/bin/bash', args: ['-l'] }])
  })

  it('Windows: PowerShell 7, Windows PowerShell, cmd, WSL and Git Bash', () => {
    fsState.files = new Set([
      'D:\\tools\\pwsh.exe',
      'C:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Win\\System32\\cmd.exe',
      'C:\\Win\\System32\\wsl.exe',
      'C:\\Apps\\Git\\bin\\bash.exe'
    ])
    const env = { SystemRoot: 'C:\\Win', ProgramFiles: 'C:\\Apps', Path: 'D:\\tools;;C:\\x' }
    expect(detectShells('win32', env).map((s) => [s.id, s.file, s.args])).toEqual([
      ['pwsh', 'D:\\tools\\pwsh.exe', ['-NoLogo']],
      ['powershell', 'C:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo']],
      ['cmd', 'C:\\Win\\System32\\cmd.exe', []],
      ['wsl', 'C:\\Win\\System32\\wsl.exe', []],
      ['gitbash', 'C:\\Apps\\Git\\bin\\bash.exe', ['--login', '-i']]
    ])
    // defaults: C:\\Windows, C:\\Program Files, ComSpec, PATH
    fsState.files = new Set(['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\cmd2.exe'])
    expect(detectShells('win32', { ComSpec: 'C:\\cmd2.exe', PATH: 'E:\\bin' }).map((s) => s.id)).toEqual(['pwsh', 'cmd'])
    fsState.files = new Set()
    expect(detectShells('win32', {})).toEqual([])
  })

  it('looks at this machine by default', () => {
    expect(Array.isArray(detectShells())).toBe(true)
  })
})
