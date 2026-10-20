import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'

// --- programmable child_process.execFile -----------------------------------
type Reply = string | Error
const proc = vi.hoisted(() => {
  const calls: { cmd: string; args: string[]; opts?: unknown }[] = []
  let responder: (cmd: string, args: string[]) => Reply = () => ''
  const execFile = Object.assign(vi.fn(), {})
  return {
    calls,
    execFile,
    setResponder: (fn: (cmd: string, args: string[]) => Reply) => {
      responder = fn
    },
    run: async (cmd: string, args: string[], opts?: unknown) => {
      calls.push({ cmd, args, opts })
      const r = responder(cmd, args)
      if (r instanceof Error) throw r
      return { stdout: r, stderr: '' }
    }
  }
})
vi.mock('node:child_process', () => {
  const execFile = (() => {}) as unknown as Record<symbol, unknown>
  execFile[promisify.custom] = proc.run
  return { execFile }
})

const electron = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  openPath: vi.fn(async () => ''),
  openExternal: vi.fn(async () => {}),
  appForProtocol: vi.fn((_url: string) => ''),
  reveal: vi.fn(),
  encryption: true,
  backend: 'gnome_libsecret',
  clipboardWrites: [] as unknown[],
  trashItem: vi.fn(async (_path: string) => {}),
  fork: vi.fn((..._args: unknown[]) => ({ stdout: null, stderr: null, postMessage() {}, kill: () => true, on() {} }))
}))
vi.mock('electron', () => ({
  app: { getApplicationNameForProtocol: electron.appForProtocol },
  clipboard: { write: async (items: unknown[]) => void electron.clipboardWrites.push(...items), read: async () => [] },
  ClipboardItem: class {
    constructor(public data: Record<string, string>) {}
  },
  dialog: { showOpenDialog: electron.showOpenDialog },
  utilityProcess: { fork: electron.fork },
  shell: { openPath: electron.openPath, openExternal: electron.openExternal, showItemInFolder: electron.reveal, trashItem: electron.trashItem },
  safeStorage: {
    isEncryptionAvailable: () => electron.encryption,
    getSelectedStorageBackend: () => electron.backend,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  }
}))

import { detectGit } from '../../../electron/main/services/projects/gitDetect'
import { detectStack } from '../../../electron/main/services/projects/stackDetect'
import { ProjectService } from '../../../electron/main/services/projects/ProjectService'
import { ProjectRegistry } from '../../../electron/main/services/projects/registry'
import { electronCipher, electronPlatform, secretsProtected } from '../../../electron/main/platform/electron'
import { headlessPlatform } from '../../../electron/main/platform/headless'
import { openInVsCode } from '../../../electron/main/lib/openInVsCode'
import { gitProgram } from '../../../electron/main/lib/git'
import { WorkspaceTrust } from '../../../electron/main/services/projects/trust'

const realPlatform = process.platform
const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p })

beforeEach(() => {
  proc.calls.length = 0
  proc.setResponder(() => '')
})
afterEach(() => setPlatform(realPlatform))

describe('detectGit', () => {
  it('reports non-repos', async () => {
    proc.setResponder(() => new Error('not a git repository'))
    expect(await detectGit('/x')).toEqual({ isRepo: false })
  })

  it('collects branch, dirty state, ahead/behind and the last commit', async () => {
    proc.setResponder((_cmd, args) => {
      const key = args.join(' ')
      if (key.startsWith('rev-parse --is-inside')) return 'true'
      if (key.startsWith('rev-parse --abbrev-ref')) return 'main'
      if (key.startsWith('status')) return ' M file.ts'
      if (key.startsWith('rev-list')) return '2\t5'
      return 'abc123\x1ffix: thing\x1fRobin\x1f2026-10-01T10:00:00+02:00'
    })
    expect(await detectGit('/x', true)).toEqual({
      isRepo: true,
      branch: 'main',
      dirty: true,
      behind: 2,
      ahead: 5,
      lastCommit: { hash: 'abc123', subject: 'fix: thing', author: 'Robin', date: '2026-10-01T10:00:00+02:00' }
    })
    // Git by its full path from the PATH — never a git.exe in the project (BE-SEC-03).
    expect(proc.calls.every((c) => c.cmd === gitProgram())).toBe(true)
  })

  it('keeps partial info when every optional probe fails or is empty', async () => {
    proc.setResponder((_cmd, args) => (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree' ? 'true' : new Error('x')))
    expect(await detectGit('/x', true)).toEqual({ isRepo: true })

    proc.setResponder((_cmd, args) => {
      const key = args.join(' ')
      if (key.startsWith('status')) return ''
      if (key.startsWith('rev-list')) return 'garbage'
      if (key.startsWith('log')) return ''
      return 'HEAD'
    })
    expect(await detectGit('/x', true)).toEqual({ isRepo: true, branch: 'HEAD', dirty: false })
  })

  it('links the repo page from origin, without credentials', async () => {
    proc.setResponder((_cmd, args) => (args[0] === 'remote' ? 'https://robin:token@github.com/robin7mh/testing-games.git' : 'true'))
    expect((await detectGit('/x', true)).webUrl).toBe('https://github.com/robin7mh/testing-games')
  })

  it('untrusted (a project just added): every git call carries the overrides — the repository’s fsmonitor, hooks and filters never run', async () => {
    proc.setResponder((_cmd, args) => {
      if (args.includes('config')) return 'local\0core.fsmonitor\n./x.sh\0local\0filter.evil.clean\ntouch pwned\0'
      if (args.includes('--is-inside-work-tree')) return 'true'
      return ''
    })
    expect(await detectGit('/x')).toMatchObject({ isRepo: true, dirty: false })
    const runs = proc.calls.filter((c) => !c.args.includes('config'))
    expect(runs.length).toBeGreaterThan(3)
    for (const { args } of runs) {
      expect(args).toEqual(expect.arrayContaining(['core.fsmonitor=false', 'core.hooksPath=/dev/null', 'filter.evil.clean=', 'filter.evil.required=false']))
    }
    expect(runs.find((c) => c.args.includes('status'))!.args).toContain('--ignore-submodules=all')
    // A config that can't be made safe: no git at all.
    proc.setResponder((_cmd, args) => (args.includes('config') ? 'local\0core.gitproxy\nevil\0' : 'true'))
    expect(await detectGit('/x')).toEqual({ isRepo: false })
  })
})

describe('detectStack', () => {
  const make = async (files: Record<string, string>) => {
    const dir = await tempDir()
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content)
    return dir
  }

  it('reads package.json: name, version, scripts, TS and frameworks; npm lockfile', async () => {
    const dir = await make({
      'package.json': JSON.stringify({
        name: 'app',
        version: '1.0.0',
        scripts: { dev: 'x', build: 'y' },
        dependencies: { react: '1', next: '1' },
        devDependencies: { typescript: '5', tailwindcss: '3' }
      }),
      'package-lock.json': '{}',
      'README.md': '#',
      'tailwind.config.ts': ''
    })
    expect(await detectStack(dir)).toEqual({
      languages: ['JavaScript', 'TypeScript'],
      frameworks: ['React', 'Next.js', 'Tailwind'],
      packageManager: 'npm',
      hasReadme: true,
      packageJson: { name: 'app', version: '1.0.0', scripts: ['dev', 'build'] }
    })
  })

  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['nothing.txt', undefined]
  ])('detects the package manager from %s', async (lock, pm) => {
    const dir = await make({ 'package.json': '{}', [lock]: '' })
    const stack = await detectStack(dir)
    expect(stack.packageManager).toBe(pm)
    expect(stack.packageJson).toEqual({ name: undefined, version: undefined, scripts: [] })
  })

  it('survives malformed package.json and non-object scripts; TS via tsconfig', async () => {
    const bad = await make({ 'package.json': '{oops', 'tsconfig.json': '{}' })
    expect(await detectStack(bad)).toMatchObject({ languages: ['JavaScript', 'TypeScript'], frameworks: [], packageJson: undefined })

    const odd = await make({ 'package.json': JSON.stringify({ name: 5, scripts: 'nope' }), 'tsconfig.json': '{}' })
    expect((await detectStack(odd)).packageJson).toEqual({ name: undefined, version: undefined, scripts: [] })
  })

  it('recognizes other ecosystems, Docker, standalone Tailwind and readme variants', async () => {
    const dir = await make({
      'Cargo.toml': '',
      'go.mod': '',
      'pyproject.toml': '',
      'Gemfile': '',
      'build.gradle.kts': '',
      'docker-compose.yml': '',
      'tailwind.config.js': '',
      readme: ''
    })
    expect(await detectStack(dir)).toEqual({
      languages: ['Rust', 'Go', 'Python', 'Ruby', 'Java'],
      frameworks: ['Docker', 'Tailwind'],
      packageManager: undefined,
      hasReadme: true,
      packageJson: undefined
    })
    for (const f of ['requirements.txt', 'setup.py', 'pom.xml', 'build.gradle', 'Dockerfile']) {
      const one = await make({ [f]: '' })
      const s = await detectStack(one)
      expect(s.languages.length + s.frameworks.length).toBe(1)
    }
  })

  it('returns an empty stack for unreadable directories', async () => {
    expect(await detectStack('/definitely/not/here')).toEqual({
      languages: [],
      frameworks: [],
      packageManager: undefined,
      hasReadme: false,
      packageJson: undefined
    })
  })
})

describe('ProjectService', () => {
  const setup = async () => {
    const data = await tempDir()
    const service = new ProjectService(new ProjectRegistry(data), electronPlatform)
    await service.init()
    return service
  }

  it('encrypts secrets with the OS keychain when available', () => {
    const cipher = electronCipher()!
    const stored = cipher.encrypt('key')
    expect(stored).toBe(Buffer.from('enc:key').toString('base64'))
    expect(cipher.decrypt(stored)).toBe('key')
    electron.encryption = false
    expect(electronCipher()).toBeUndefined()
    electron.encryption = true
  })

  it('knows when the keychain really protects secrets — not on Linux without a keyring', () => {
    expect(secretsProtected('darwin')).toBe(true)
    expect(secretsProtected('linux')).toBe(true) // libsecret
    for (const backend of ['basic_text', 'unknown']) {
      electron.backend = backend
      expect(secretsProtected('linux')).toBe(false)
    }
    expect(secretsProtected('win32')).toBe(true)
    electron.backend = 'gnome_libsecret'
    electron.encryption = false
    expect(secretsProtected('win32')).toBe(false)
    electron.encryption = true
    expect(typeof secretsProtected()).toBe('boolean')
  })

  it('shows files in the OS file manager on the desktop', async () => {
    electronPlatform.revealPath!('/Users/me/report.pdf')
    // Files on the system clipboard go as the OS's ClipboardItem.
    await electronPlatform.fileClipboard!.write(['/Users/me/a.txt'], false)
    expect((electron.clipboardWrites[0] as { data: Record<string, string> }).data['text/plain']).toBe('/Users/me/a.txt')
    // Every desktop has a trash Mindeck can take things back out of; the plain one is the OS's own.
    expect(electronPlatform.restorableTrash).toBeDefined()
    await electronPlatform.trashItem('/Users/me/old.txt', '/Users/me')
    expect(electron.trashItem).toHaveBeenCalledWith('/Users/me/old.txt')
    expect(electron.reveal).toHaveBeenCalledWith('/Users/me/report.pdf')
  })

  it('runs Node programs in utility processes on the desktop — Mindeck’s binary never runs as Node', () => {
    electronPlatform.node!(['/ts/tsserver.js'], { cwd: '/p', env: { A: '1' }, name: 'TypeScript' })
    expect(electron.fork).toHaveBeenCalledWith(expect.stringMatching(/[/\\]nodeHost\.js$/), ['/ts/tsserver.js'], {
      cwd: '/p',
      env: { A: '1' },
      stdio: 'pipe',
      serviceName: 'TypeScript',
      allowLoadingUnsignedLibraries: false
    })
  })

  it('refuses the picker and opening files on a headless host', async () => {
    const data = await tempDir()
    const s = new ProjectService(new ProjectRegistry(data), headlessPlatform)
    await s.init()
    await expect(s.pickFolder()).rejects.toMatchObject({ code: 'desktop-only' })
    const dir = await tempDir()
    proc.setResponder(() => new Error('nothing installed'))
    const { id } = await s.add(dir)
    await expect(s.openFile(id, '.')).rejects.toMatchObject({ code: 'desktop-only' })
  })

  it('picks a folder via the native dialog, or returns null on cancel', async () => {
    const s = await setup()
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/picked'] })
    expect(await s.pickFolder()).toEqual({ path: '/picked' })
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await s.pickFolder()).toBeNull()
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] })
    expect(await s.pickFolder()).toBeNull()
  })

  it('adds a project (name from package.json or folder), refreshes duplicates, removes', async () => {
    const s = await setup()
    const dir = await tempDir('my-app-')
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '  shiny  ' }))
    proc.setResponder(() => new Error('no git'))

    const p = await s.add(dir)
    expect(p).toMatchObject({ name: 'shiny', git: { isRepo: false } })
    expect(s.list()).toHaveLength(1)
    expect(s.getProjectPath(p.id)).toBe(p.path)

    const again = await s.add(dir) // idempotent → refresh
    expect(again.id).toBe(p.id)
    expect(s.list()).toHaveLength(1)

    await writeFile(join(dir, 'package.json'), JSON.stringify({}))
    expect((await s.refresh(p.id)).name).toBe('shiny') // keeps the old name without package name

    const plain = await tempDir('plain-')
    expect((await s.add(plain)).name).toMatch(/^plain-/)

    await s.remove(p.id)
    expect(s.getProjectPath(p.id)).toBeUndefined()
    await expect(s.refresh('nope')).rejects.toMatchObject({ code: 'not-found', message: 'Unknown project: nope' })
  })

  it('workspace trust: every project added — at the desktop too — starts restricted; trusting is kept and announced', async () => {
    const s = await setup()
    proc.setResponder(() => new Error('no git'))
    const dir = await tempDir()
    const p = await s.add(dir)
    expect(p.trusted).toBe(false)
    expect((await s.add(dir, true)).trusted).toBe(false)
    const heard: string[] = []
    s.onTrustChange((project) => heard.push(`${project.id}:${project.trusted}`))
    expect((await s.trust(p.id, true)).trusted).toBe(true)
    expect((await s.add(dir)).trusted).toBe(true) // added again: still trusted
    expect((await s.refresh(p.id)).trusted).toBe(true)
    await s.trust(p.id, false)
    expect(heard).toEqual([`${p.id}:true`, `${p.id}:false`])
    await expect(s.trust('nope', true)).rejects.toThrow('Unknown project: nope')
  })

  it('workspace trust: projects from before it stay trusted (the upgrade breaks nothing); restricted ones stay restricted', async () => {
    const data = await tempDir()
    const old = (id: string, extra = {}) => ({ id, name: id, path: `/p/${id}`, addedAt: 'a', lastSeenAt: 'b', ...extra })
    await writeFile(join(data, 'projects.json'), JSON.stringify({ version: 1, projects: [old('a'), old('b', { trusted: false })] }))
    const reg = new ProjectRegistry(data)
    await reg.load()
    expect(reg.all().map((p) => [p.id, p.trusted])).toEqual([['a', true], ['b', false]])
    const saved = JSON.parse(await readFile(join(data, 'projects.json'), 'utf8'))
    expect(saved.version).toBe(2)
    // From then on, what is stored counts (a later new project stays restricted).
    await writeFile(join(data, 'projects.json'), JSON.stringify({ version: 2, projects: [old('c')] }))
    const later = new ProjectRegistry(data)
    await later.load()
    expect(later.get('c')?.trusted).toBeUndefined()
    // No version at all (the first format) is from before, too; an empty list needs no saving.
    await writeFile(join(data, 'projects.json'), JSON.stringify({ projects: [old('d')] }))
    const first = new ProjectRegistry(data)
    await first.load()
    expect(first.get('d')?.trusted).toBe(true)
    const empty = await tempDir()
    await writeFile(join(empty, 'projects.json'), JSON.stringify({ version: 1, projects: [] }))
    await new ProjectRegistry(empty).load()
    expect(JSON.parse(await readFile(join(empty, 'projects.json'), 'utf8')).version).toBe(1)
  })

  it('WorkspaceTrust: by id, and by folder — the innermost project decides, folders outside every project are restricted', () => {
    const list = [
      { id: 'mono', name: 'mono', path: '/code', addedAt: '', lastSeenAt: '', trusted: true },
      { id: 'clone', name: 'clone', path: '/code/evil-clone', addedAt: '', lastSeenAt: '', trusted: false },
      { id: 'old', name: 'old', path: '/old', addedAt: '', lastSeenAt: '' },
      { id: 'root', name: 'root', path: '/', addedAt: '', lastSeenAt: '', trusted: false }
    ]
    const trust = new WorkspaceTrust(() => list, 'linux')
    expect(trust.project('mono')).toBe(true)
    expect(trust.project('clone')).toBe(false)
    expect(trust.project('old')).toBe(false)
    expect(trust.project('nope')).toBe(false)
    expect(trust.folder('/code')).toBe(true)
    expect(trust.folder('/code/src/../lib')).toBe(true)
    expect(trust.folder('/code/evil-clone/sub')).toBe(false)
    expect(trust.folder('/code-other')).toBe(false) // only the root '/' holds it
    expect(new WorkspaceTrust(() => list.slice(0, 1), 'linux').folder('/elsewhere')).toBe(false)
    // Windows and macOS compare without case.
    const win = new WorkspaceTrust(() => [{ ...list[0], path: 'C:\\Code' }], 'win32')
    expect(win.folder('c:\\code\\src')).toBe(true)
    expect(new WorkspaceTrust(() => [{ ...list[0], path: '/Users/Me/Code' }], 'darwin').folder('/users/me/code/x')).toBe(true)
    expect(new WorkspaceTrust(() => []).folder(process.cwd())).toBe(false)
  })

  it('marks projects a paired device added — until the desktop adds them too', async () => {
    const s = await setup()
    proc.setResponder(() => new Error('no git'))
    const dir = await tempDir('remote-')
    const p = await s.add(dir, true)
    expect(p.addedRemotely).toBe(true)
    expect((await s.add(dir, true)).addedRemotely).toBe(true)
    const desktop = await s.add(dir)
    expect(desktop.id).toBe(p.id)
    expect(desktop.addedRemotely).toBeUndefined()
    expect((await s.add(await tempDir())).addedRemotely).toBeUndefined()
  })

  it('rejects files and missing paths', async () => {
    const s = await setup()
    const dir = await tempDir()
    await writeFile(join(dir, 'f.txt'), 'x')
    await expect(s.add(join(dir, 'f.txt'))).rejects.toMatchObject({ code: 'not-a-dir', message: expect.stringContaining('not a directory') })
    await expect(s.add(join(dir, 'missing'))).rejects.toMatchObject({ code: 'not-found' })
    // Anything else the disk says is passed on as it is.
    await expect(s.add(join(dir, 'f.txt', 'below'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  describe('openInEditor', () => {
    it('uses `code`, then `open -a` on macOS, then the OS default', async () => {
      const s = await setup()
      const dir = await tempDir()
      proc.setResponder(() => new Error('no git'))
      const { id } = await s.add(dir)

      proc.setResponder(() => '')
      await s.openInEditor(id)
      expect(proc.calls.at(-1)).toMatchObject({ cmd: 'code' })

      setPlatform('darwin')
      proc.setResponder((cmd) => (cmd === 'code' ? new Error('missing') : ''))
      await s.openInEditor(id)
      expect(proc.calls.at(-1)).toMatchObject({ cmd: 'open', args: ['-a', 'Visual Studio Code', dir.replace(/^\/var\//, '/private/var/')] })

      proc.setResponder(() => new Error('missing'))
      await s.openInEditor(id)
      expect(electron.openPath).toHaveBeenCalled()

      setPlatform('linux')
      electron.openPath.mockResolvedValueOnce('could not open')
      await expect(s.openInEditor(id)).rejects.toThrow('could not open')
    })

    it('without VS Code and without a desktop: desktop-only', async () => {
      proc.setResponder(() => new Error('missing'))
      await expect(openInVsCode('/somewhere', {})).rejects.toMatchObject({ code: 'desktop-only' })
    })
  })

  describe('openFile', () => {
    it('opens inside the project (with a line), falls back, and refuses escapes', async () => {
      const s = await setup()
      const dir = await tempDir()
      await writeFile(join(dir, 'a.ts'), '')
      proc.setResponder(() => new Error('no git'))
      const { id, path } = await s.add(dir)

      proc.setResponder(() => '')
      await s.openFile(id, 'a.ts', 12)
      expect(proc.calls.at(-1)).toMatchObject({ cmd: 'code', args: ['-g', `${join(path, 'a.ts')}:12`] })
      await s.openFile(id, 'a.ts', 0)
      expect(proc.calls.at(-1)?.args).toEqual(['-g', join(path, 'a.ts')])
      await s.openFile(id, '.') // the root itself is allowed
      await s.openFile(id, 'not-yet-there.ts') // realpath fails → lexical target

      proc.setResponder(() => new Error('no code'))
      await s.openFile(id, 'a.ts')
      expect(electron.openPath).toHaveBeenLastCalledWith(join(path, 'a.ts'))
      electron.openPath.mockResolvedValueOnce('nope')
      await expect(s.openFile(id, 'a.ts')).rejects.toThrow('nope')

      await expect(s.openFile(id, '../../etc/passwd')).rejects.toMatchObject({ code: 'outside-project', message: expect.stringContaining('outside the project') })
      const outside = await tempDir()
      await mkdir(join(dir, 'sub'))
      await symlink(outside, join(dir, 'sub', 'link'))
      await expect(s.openFile(id, 'sub/link')).rejects.toThrow('outside the project')
    })
  })

  it("pull: fast-forward only, then fresh detection; git's own reason when it fails", async () => {
    const s = await setup()
    proc.setResponder(() => new Error('no git'))
    const { id } = await s.add(await tempDir())
    proc.setResponder(() => '')
    await s.pull(id)
    // Not trusted yet: the repository's hooks and helpers stay off.
    const pull = proc.calls.find((c) => c.args.includes('pull'))!
    expect(pull.cmd).toBe(gitProgram())
    expect(pull.args.slice(-3)).toEqual(['pull', '--ff-only', '--quiet'])
    expect(pull.args).toContain('core.hooksPath=/dev/null')
    await s.trust(id, true)
    proc.calls.length = 0
    await s.pull(id)
    expect(proc.calls.find((c) => c.args.includes('pull'))!.args).toEqual(['pull', '--ff-only', '--quiet'])
    proc.setResponder((_c, args) =>
      args[0] === 'pull' ? Object.assign(new Error('Command failed: git pull'), { stderr: 'fatal: Not possible to fast-forward, aborting.\nmore' }) : ''
    )
    await expect(s.pull(id)).rejects.toMatchObject({ code: 'pull-failed', message: 'fatal: Not possible to fast-forward, aborting.' })
    proc.setResponder((_c, args) => (args[0] === 'pull' ? new Error('spawn git ENOENT') : ''))
    await expect(s.pull(id)).rejects.toMatchObject({ code: 'pull-failed', message: 'spawn git ENOENT' })
  })

  it('GitHub Desktop: found by its link scheme, opens the project folder; absent on a headless host', async () => {
    const s = await setup()
    proc.setResponder(() => new Error('no git'))
    const dir = await tempDir('my repo-')
    const { id } = await s.add(dir)

    expect(s.githubDesktop()).toBeNull()
    electron.appForProtocol.mockReturnValueOnce('GitHub Desktop')
    expect(s.githubDesktop()).toBe('GitHub Desktop')
    expect(electron.appForProtocol).toHaveBeenLastCalledWith('x-github-client://')
    await s.openInGitHubDesktop(id)
    expect(electron.openExternal).toHaveBeenCalledWith(`x-github-client://openLocalRepo/${encodeURIComponent(s.getProjectPath(id)!)}`)

    const headless = new ProjectService(new ProjectRegistry(await tempDir()), headlessPlatform)
    await headless.init()
    const other = await headless.add(dir)
    expect(headless.githubDesktop()).toBeNull()
    await expect(headless.openInGitHubDesktop(other.id)).rejects.toMatchObject({ code: 'desktop-only' })
  })
})
