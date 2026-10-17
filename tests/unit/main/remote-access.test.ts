import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './helpers'
import { RemoteAccess, type RemoteAccessDeps } from '../../../electron/main/server/RemoteAccess'
import { FsService } from '../../../electron/main/services/fs/FsService'
import type { Project } from '@shared/types/project'

const project = (id: string, path: string, over: Partial<Project> = {}): Project => ({ id, name: `name-${id}`, path, addedAt: '', lastSeenAt: '', ...over })

/** A home with a shared ~/code, a desktop project, keys, hidden and system folders. */
async function machine(over: Partial<RemoteAccessDeps> = {}) {
  const root = await tempDir()
  const home = join(root, 'home')
  const code = join(home, 'code')
  const desk = join(home, 'desk-project')
  const sys = join(root, 'sys')
  const data = join(home, 'Mindeck', 'data')
  for (const d of [join(code, 'app', 'src'), join(code, 'app', '.ssh'), join(code, 'app', 'node_modules'), join(desk, 'sub'), join(home, '.ssh'), join(home, 'Documents'), join(home, 'Library', 'Keys'), join(sys, 'etc'), data, join(home, 'Mindeck', 'vault')]) {
    await mkdir(d, { recursive: true })
  }
  await writeFile(join(home, 'notes.txt'), 'x')
  let roots = [code]
  let shells = false
  const projects: Project[] = [project('desk', desk), project('remote-in', join(code, 'app'), { addedRemotely: true }), project('remote-out', join(home, 'Documents'), { addedRemotely: true }), project('home', home), project('dot', join(home, '.ssh'))]
  const fs = new FsService(home)
  const access = new RemoteAccess({
    roots: () => roots,
    projects: () => projects,
    remoteShell: () => shells,
    dirs: (path) => fs.dirs(path),
    protectedDirs: [data],
    home,
    systemDirs: [join(sys, 'etc')],
    platform: 'linux',
    ...over
  })
  return {
    access,
    root,
    home,
    code,
    desk,
    sys,
    data,
    projects,
    setRoots: (r: string[]) => (roots = r),
    setShells: (v: boolean) => (shells = v)
  }
}

describe('RemoteAccess · folders', () => {
  it('lets a device add only folders inside the shared ones and the desktop projects', async () => {
    const m = await machine()
    expect(await m.access.folder(join(m.code, 'app'))).toBe(join(m.code, 'app'))
    expect(await m.access.folder(join(m.desk, 'sub'))).toBe(join(m.desk, 'sub')) // inside a desktop project
    await expect(m.access.folder(join(m.home, 'Documents'))).rejects.toMatchObject({ code: 'remote-forbidden', message: expect.stringContaining('not in a folder shared') })
    await expect(m.access.folder('relative/path')).rejects.toMatchObject({ code: 'bad-path' })
    await expect(m.access.folder(join(m.code, 'missing'))).rejects.toMatchObject({ code: 'not-found' })
  })

  it('never: home itself or above, hidden, system, keys, Mindeck data — not even with remote shells', async () => {
    const m = await machine()
    m.setShells(true)
    const why = async (path: string) => (await m.access.folder(path).catch((e: Error) => e.message)) as string
    expect(await why(m.home)).toContain('the home folder')
    expect(await why(m.root)).toContain('the home folder')
    expect(await why('/')).toContain('the disk itself')
    expect(await why(join(m.home, '.ssh'))).toContain('a hidden folder')
    expect(await why(join(m.code, 'app', '.ssh'))).toContain('a hidden folder')
    expect(await why(join(m.sys, 'etc'))).toContain('a system folder')
    expect(await why(m.sys)).toContain('a system folder') // holds one
    expect(await why(join(m.home, 'Library', 'Keys'))).toContain('a system folder')
    expect(await why(m.data)).toContain("Mindeck's own data")
    expect(await why(join(m.home, 'Mindeck'))).toContain("Mindeck's own data") // holds it
    // With remote shells the shared folders no longer bound a device.
    expect(await m.access.folder(join(m.home, 'Documents'))).toBe(join(m.home, 'Documents'))
    expect(await m.access.folder(join(m.home, 'Mindeck', 'vault'))).toBe(join(m.home, 'Mindeck', 'vault'))
  })

  it('guards Mindeck\'s data folder by its path while it doesn\'t exist yet', async () => {
    const base = await tempDir()
    const later = join(base, 'Mindeck', 'data')
    await mkdir(join(base, 'other'))
    const m = await machine({ protectedDirs: [later], roots: () => [join(base, 'other')] })
    expect(await m.access.folder(join(base, 'other'))).toBe(join(base, 'other')) // the guard is taken now
    await mkdir(later, { recursive: true })
    await expect(m.access.folder(later)).rejects.toThrow("Mindeck's own data")
  })

  it('refuses folders whose names are on the deny list', async () => {
    const m = await machine()
    await mkdir(join(m.code, 'id_rsa'), { recursive: true })
    await expect(m.access.folder(join(m.code, 'id_rsa'))).rejects.toThrow('keys or credentials')
  })

  it('resolves symlinks before deciding', async () => {
    const m = await machine()
    await symlink(join(m.home, '.ssh'), join(m.code, 'innocent'))
    await expect(m.access.folder(join(m.code, 'innocent'))).rejects.toThrow('a hidden folder')
  })

  it('validates shared folders for the settings', async () => {
    const m = await machine()
    expect(await m.access.validateRoots([m.code, join(m.code, '.', 'app'), m.code])).toEqual([m.code, join(m.code, 'app')])
    await expect(m.access.validateRoots(['rel'])).rejects.toMatchObject({ code: 'bad-root' })
    await expect(m.access.validateRoots([join(m.home, 'nope')])).rejects.toMatchObject({ code: 'bad-root' })
    await expect(m.access.validateRoots([m.home])).rejects.toMatchObject({ code: 'bad-root', message: expect.stringContaining('the home folder') })
    await expect(m.access.validateRoots([join(m.home, 'notes.txt')])).rejects.toMatchObject({ code: 'bad-root', message: expect.stringContaining('Not a folder') })
  })
})

describe('RemoteAccess · folder browser', () => {
  it('starts in the first shared folder and never climbs out', async () => {
    const m = await machine()
    const top = await m.access.dirs()
    expect(top).toMatchObject({ path: m.code, parent: null, home: m.code, dirs: ['app'] })
    expect(top.roots).toEqual([m.code, m.desk])
    const app = await m.access.dirs(join(m.code, 'app'))
    expect(app.parent).toBe(m.code)
    expect(app.dirs).toEqual(['node_modules', 'src']) // hidden and denied left out
    await expect(m.access.dirs(m.home)).rejects.toMatchObject({ code: 'remote-forbidden' })
  })

  it('without shared folders or projects there is nothing to browse; with remote shells it is the plain browser', async () => {
    const m = await machine()
    m.setRoots([join(m.home, 'gone'), 'relative', m.home]) // missing, relative, off-limits: all ignored
    m.projects.splice(0, m.projects.length)
    await expect(m.access.dirs()).rejects.toMatchObject({ code: 'remote-forbidden', message: expect.stringContaining('No folders are shared') })
    m.setShells(true)
    const home = await m.access.dirs()
    expect(home.path).toBe(m.home)
    expect(home.dirs).toEqual(['code', 'desk-project', 'Documents', 'Library', 'Mindeck'])
    expect(home.roots).toBeUndefined()
  })
})

describe('RemoteAccess · projects and files', () => {
  it('a device uses desktop projects and the ones inside shared folders', async () => {
    const m = await machine()
    await m.access.project('desk')
    await m.access.project('name-remote-in', true) // by name, as the assistant's tools accept it
    await m.access.project('name-home') // the router's calls go by id only
    await expect(m.access.project('name-home', true)).rejects.toThrow('the home folder')
    await m.access.project('unknown') // the handler says "not found"
    await expect(m.access.project('remote-out')).rejects.toThrow('not in a folder shared')
    await expect(m.access.project('home')).rejects.toThrow('the home folder')
    await expect(m.access.project('dot')).rejects.toThrow('a hidden folder')
    expect((await m.access.visible(m.projects)).map((p) => p.id)).toEqual(['desk', 'remote-in'])
    // A shared folder taken away takes its remote projects along — not the desktop's.
    m.setRoots([])
    expect((await m.access.visible(m.projects)).map((p) => p.id)).toEqual(['desk'])
    m.setShells(true)
    expect((await m.access.visible(m.projects)).map((p) => p.id)).toEqual(['desk', 'remote-in', 'remote-out'])
  })

  it('a project named like another one’s id cannot vouch for it', async () => {
    const m = await machine()
    m.projects.unshift(project('decoy', join(m.code, 'app'), { name: 'home', addedRemotely: true }))
    await expect(m.access.check('files:read', { projectId: 'home', path: 'notes.txt' })).rejects.toThrow('the home folder')
    await expect(m.access.tool({ projectId: 'home', path: 'a' })).rejects.toThrow('the home folder')
  })

  it('denies keys and credentials by name, on any separator, ignoring case', () => {
    const m = { access: new RemoteAccess({ roots: () => [], projects: () => [], remoteShell: () => false, dirs: async () => ({ path: '', parent: null, home: '', dirs: [] }), protectedDirs: [] }) }
    for (const bad of ['.ssh/config', '.env', '.env.local', 'config\\.AWS\\credentials', 'certs/server.pem', 'tls.key', 'id_rsa', 'keys/id_ed25519.pub', 'Library/Keychains/login.keychain-db', '.mozilla/x', 'Login Data', '.npmrc', 'a/.git-credentials',
      // BE-SEC-06: tokens in remote URLs, package-manager and infrastructure credentials
      '.git/config', '.git', 'sub/.GIT/credentials', '.yarnrc.yml', '.yarnrc', 'site/.htpasswd', '.terraformrc', '.dockercfg', '.boto', '.s3cfg', '.my.cnf',
      'infra/terraform.tfstate', 'terraform.tfstate.backup', 'credentials.json', 'credentials-prod.json', 'gcp/my-service-account.json', 'sa/service_account_key.json',
      'android/release.jks', 'app.keystore', 'putty.ppk', 'vault.kdbx', 'config/secrets.yml', 'secret.yaml', 'secrets.json', 'wp-config.php']) {
      expect(() => m.access.file(bad), bad).toThrow('off-limits')
    }
    for (const ok of ['src/app.ts', '.gitignore', '.gitattributes', '.gitmodules', '.github/workflows/ci.yml', 'id_utils.py', 'docs/keys.md', 'environment.ts', 'src/credentials.ts', 'terraform/main.tf', 'docs/secrets.md', 'wp-config-sample.php', 'package.json', '.yarn/releases/yarn.cjs']) {
      expect(() => m.access.file(ok), ok).not.toThrow()
    }
  })

  it('checks a remote call: its folder, its project and the files it names', async () => {
    const m = await machine()
    await m.access.check('projects:add', { path: join(m.code, 'app') })
    await expect(m.access.check('projects:add', { path: m.home })).rejects.toMatchObject({ code: 'remote-forbidden' })
    await expect(m.access.check('memory:setVault', { path: join(m.home, '.ssh') })).rejects.toMatchObject({ code: 'remote-forbidden' })
    // The vault is never a project's folder, one holding a project or one inside it — its notes would be project files (BE-SEC-05).
    await mkdir(join(m.code, 'notes'))
    await expect(m.access.check('memory:setVault', { path: join(m.code, 'notes') })).rejects.toThrow('name-home cannot be the vault') // inside the project at home
    const atHome = m.projects.splice(m.projects.findIndex((p) => p.id === 'home'), 1)
    await m.access.check('memory:setVault', { path: join(m.code, 'notes') })
    for (const path of [join(m.code, 'app'), m.code, join(m.code, 'app', 'src'), join(m.desk, 'sub')]) {
      await expect(m.access.check('memory:setVault', { path }), path).rejects.toMatchObject({ code: 'remote-forbidden', message: expect.stringContaining('cannot be the vault') })
    }
    m.setShells(true) // a shell could write there anyway
    await m.access.check('memory:setVault', { path: join(m.code, 'app') })
    m.setShells(false)
    m.projects.push(...atHome)
    await m.access.check('files:read', { projectId: 'desk', path: 'src/a.ts' })
    await expect(m.access.check('files:read', { projectId: 'desk', path: '.env' })).rejects.toMatchObject({ code: 'remote-forbidden' })
    await expect(m.access.check('files:stat', { projectId: 'desk', paths: ['a', 'b/id_rsa', 3] })).rejects.toThrow('id_rsa')
    await expect(m.access.check('files:list', { projectId: 'desk', dir: '.aws' })).rejects.toThrow('.aws')
    await expect(m.access.check('files:read', { projectId: 'desk', path: '.git/config' })).rejects.toThrow('.git is off-limits')
    await expect(m.access.check('files:list', { projectId: 'desk', dir: '.git' })).rejects.toThrow('.git is off-limits')
    await expect(m.access.check('files:read', { projectId: 'home', path: 'notes.txt' })).rejects.toThrow('the home folder')
    // Trusting (an admin device) only for a project the device may use.
    await m.access.check('projects:trust', { id: 'desk', trusted: true })
    await expect(m.access.check('projects:trust', { id: 'home', trusted: true })).rejects.toMatchObject({ code: 'remote-forbidden' })
    await expect(m.access.check('agents:diff', { id: 's', path: 'secrets/prod.pem' })).rejects.toThrow('prod.pem')
    // Project channels that name their project as `id` (BE-SEC-07).
    for (const channel of ['projects:remove', 'projects:refresh', 'projects:pull'] as const) {
      await m.access.check(channel, { id: 'desk' })
      await expect(m.access.check(channel, { id: 'home' }), channel).rejects.toThrow('the home folder')
      await expect(m.access.check(channel, { id: 'remote-out' }), channel).rejects.toThrow('not in a folder shared')
    }
    await m.access.check('agents:get', { id: 'home' }) // an id that is no project's
    await m.access.check('memory:read', { path: '.env.md' }) // a vault note: no project, no file rule
    await m.access.check('app:info', undefined)
  })

  it('judges what a file really is: links to keys and credentials are refused, inside the project or out', async () => {
    const m = await machine()
    await writeFile(join(m.home, '.ssh', 'id_rsa'), 'KEY')
    await writeFile(join(m.desk, '.env'), 'TOKEN=1')
    await writeFile(join(m.desk, 'readme.md'), '# hi')
    await symlink(join(m.home, '.ssh', 'id_rsa'), join(m.desk, 'notes.txt'))
    await symlink(join(m.desk, '.env'), join(m.desk, 'config.txt'))
    await symlink(join(m.home, '.ssh'), join(m.desk, 'docs'))
    await expect(m.access.check('files:read', { projectId: 'desk', path: 'notes.txt' })).rejects.toThrow('.ssh is off-limits')
    await expect(m.access.check('files:read', { projectId: 'desk', path: 'config.txt' })).rejects.toThrow('.env is off-limits')
    await expect(m.access.check('files:list', { projectId: 'desk', dir: 'docs' })).rejects.toThrow('.ssh is off-limits')
    await expect(m.access.check('scm:stage', { projectId: 'desk', paths: ['readme.md', 'notes.txt'] })).rejects.toThrow('off-limits')
    await expect(m.access.tool({ path: 'config.txt' }, 'desk')).rejects.toThrow('.env is off-limits')
    // The assistant's tools name projects by name too.
    await expect(m.access.tool({ projectId: 'name-desk', path: 'notes.txt' })).rejects.toThrow('.ssh is off-limits')
    // Plain files, files that don't exist yet, and paths leaving the project (the handler refuses those) pass here.
    await m.access.check('files:read', { projectId: 'desk', path: 'readme.md' })
    await m.access.check('files:write', { projectId: 'desk', path: 'new/file.ts' })
    await m.access.check('files:read', { projectId: 'desk', path: '../../outside' })
    await m.access.check('scm:status', { projectId: 'desk' })
    // A project whose folder is gone has nothing to resolve.
    m.projects.push(project('gone', join(m.code, 'gone')))
    await m.access.check('files:read', { projectId: 'gone', path: 'a.ts' })
  })

  it('checks a tool call a device started, in the conversation project or the one it names', async () => {
    const m = await machine()
    await m.access.tool({ path: 'src/a.ts' }, 'desk')
    await m.access.tool(undefined)
    await expect(m.access.tool({ projectId: 'home', path: 'a' }, 'desk')).rejects.toThrow('the home folder')
    await expect(m.access.tool({ projectId: '', path: '.env' }, 'desk')).rejects.toThrow('.env')
    await expect(m.access.tool({ path: 'x' }, 'remote-out')).rejects.toThrow('not in a folder shared')
  })
})

describe('RemoteAccess · platforms', () => {
  const on = (platform: NodeJS.Platform, path: string, home = '/Users/me') =>
    new RemoteAccess({
      roots: () => [],
      projects: () => [project('p', path)],
      remoteShell: () => true,
      dirs: async () => ({ path: '', parent: null, home: '', dirs: [] }),
      protectedDirs: [],
      home,
      platform
    }).project('p')

  it('knows each platform’s system folders', async () => {
    await expect(on('darwin', '/Library/Thing')).rejects.toThrow('a system folder')
    await expect(on('darwin', '/private/etc/x')).rejects.toThrow('a system folder')
    await on('darwin', '/private/var/folders/tmp/project') // a temp folder is fine
    await expect(on('linux', '/usr/local/src/x')).rejects.toThrow('a system folder')
    await on('linux', '/srv/code/x')
    const drive = process.env.SystemDrive
    delete process.env.SystemDrive
    await expect(on('win32', 'C:\\Windows\\System32', 'C:\\Users\\me')).rejects.toThrow('a system folder')
    await expect(on('win32', 'C:\\Users\\me\\AppData\\Roaming\\x', 'C:\\Users\\me')).rejects.toThrow('a system folder')
    process.env.SystemDrive = 'D:'
    await expect(on('win32', 'D:\\Program Files\\App', 'C:\\Users\\me')).rejects.toThrow('a system folder')
    await on('win32', 'D:\\code\\app', 'C:\\Users\\me')
    await expect(on('win32', 'C:\\', 'C:\\Users\\me')).rejects.toThrow('the disk itself')
    await expect(on('win32', 'C:\\Users', 'C:\\Users\\me')).rejects.toThrow('the home folder')
    if (drive === undefined) delete process.env.SystemDrive
    else process.env.SystemDrive = drive
  })

  it('reads names the way Windows opens them: trailing dots and spaces, streams', () => {
    const access = (platform: NodeJS.Platform) =>
      new RemoteAccess({ roots: () => [], projects: () => [], remoteShell: () => true, dirs: async () => ({ path: '', parent: null, home: '', dirs: [] }), protectedDirs: [], platform })
    const win = access('win32')
    for (const bad of ['id_rsa.', 'keys\\id_rsa  ', '.env::$DATA', 'certs\\server.pem.', 'x\\.SSH.\\config', 'Login Data .']) {
      expect(() => win.file(bad), bad).toThrow('off-limits')
    }
    expect(() => win.file('src\\app.ts')).not.toThrow()
    expect(() => win.file('C:\\code\\app\\main.ts')).not.toThrow()
    // Elsewhere those are other files.
    expect(access('linux').denied('id_rsa.')).toBeUndefined()
  })

  it('never touches a network or device path on Windows (it would send the user’s credentials there)', async () => {
    const win = new RemoteAccess({ roots: () => [], projects: () => [], remoteShell: () => true, dirs: async () => ({ path: '', parent: null, home: '', dirs: [] }), protectedDirs: [], home: 'C:\\Users\\me', platform: 'win32' })
    for (const unc of ['\\\\evil\\share', '\\\\?\\C:\\code', '//evil/share', '\\\\.\\pipe\\x']) {
      await expect(win.folder(unc), unc).rejects.toMatchObject({ code: 'remote-forbidden', message: expect.stringContaining('Network and device paths') })
    }
  })

  it('compares without case on macOS and Windows only', async () => {
    await expect(on('darwin', '/users/ME')).rejects.toThrow('the home folder')
    await expect(on('win32', 'c:\\users\\ME', 'C:\\Users\\me')).rejects.toThrow('the home folder')
    await on('linux', '/users/ME', '/Users/me')
  })
})
