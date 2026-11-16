import { copyFile, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './helpers'
import { SftpService, type SftpClient } from '../../../electron/main/services/sftp/SftpService'
import type { SftpProgress } from '@shared/types/sftp'

/** A "server" that is a temp folder: what the SFTP calls would do there. */
function fakeServer(remote: string, opts: { failEnd?: boolean } = {}) {
  const connects: Record<string, unknown>[] = []
  const at = (p: string) => join(remote, p)
  const client: SftpClient = {
    connect: async (o) => void connects.push(o),
    list: async (p) =>
      Promise.all(
        (await readdir(at(p), { withFileTypes: true })).map(async (d) => ({
          name: d.name,
          type: d.isSymbolicLink() ? 'l' : d.isDirectory() ? 'd' : '-',
          size: (await stat(join(at(p), d.name))).size,
          modifyTime: 1
        }))
      ),
    fastPut: (local, r) => copyFile(local, at(r)),
    fastGet: (r, local) => copyFile(at(r), local),
    mkdir: (p) => mkdir(at(p), { recursive: true }),
    end: async () => {
      if (opts.failEnd) throw new Error('already closed')
    }
  }
  return { client, connects }
}

async function project(config: unknown) {
  const root = await tempDir('mindeck-sftp-')
  const remote = await tempDir('mindeck-remote-')
  await mkdir(join(root, '.vscode'), { recursive: true })
  if (config !== undefined) await writeFile(join(root, '.vscode/sftp.json'), typeof config === 'string' ? config : JSON.stringify(config))
  await mkdir(join(root, 'site/css'), { recursive: true })
  await writeFile(join(root, 'site/index.html'), 'index')
  await writeFile(join(root, 'site/css/a.css'), 'a{}')
  await writeFile(join(root, 'site/debug.log'), 'log')
  await writeFile(join(root, 'other.txt'), 'other')
  return { root, remote }
}

const make = (root: string | undefined, client: SftpClient, home = '/home/me', trusted = true) => {
  const progress: SftpProgress[] = []
  const service = new SftpService({ resolveRoot: () => root, trusted: () => trusted, client: async () => client, publish: (p) => progress.push(p), home })
  return { service, progress }
}

describe('SFTP (.vscode/sftp.json like the VS Code extension)', () => {
  it('reads targets: one, several, profiles; none without the file; refuses broken JSON and unknown projects', async () => {
    const none = await project(undefined)
    expect(await make(none.root, fakeServer(none.remote).client).service.targets('p')).toEqual([])

    const single = await project('{ // comment\n "host": "example.com", "username": "me", "remotePath": "/var/www", "context": "./site/", "uploadOnSave": true, "profiles": { "staging": { "host": "staging.example.com" } } }')
    expect(await make(single.root, fakeServer(single.remote).client).service.targets('p')).toEqual([
      { name: 'example.com', host: 'example.com', username: 'me', remotePath: '/var/www', context: 'site', uploadOnSave: true },
      { name: 'example.com/staging', host: 'staging.example.com', username: 'me', remotePath: '/var/www', context: 'site', uploadOnSave: true }
    ])

    const many = await project([{ host: 'a.com' }, { name: 'Prod', host: 'b.com', remotePath: '/srv' }, { name: 'No host' }, {}])
    expect((await make(many.root, fakeServer(many.remote).client).service.targets('p')).map((t) => `${t.name}|${t.remotePath}|${t.context}|${t.uploadOnSave}`)).toEqual([
      'a.com 1|/||false',
      'Prod|/srv||false'
    ])
    const nameless = await project({})
    expect(await make(nameless.root, fakeServer(nameless.remote).client).service.targets('p')).toEqual([])

    const broken = await project('{ nope')
    await expect(make(broken.root, fakeServer(broken.remote).client).service.targets('p')).rejects.toMatchObject({ code: 'bad-config' })
    await expect(make(undefined, fakeServer(broken.remote).client).service.targets('p')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('uploads files and folders inside the context, ignores what it should, reports progress', async () => {
    const { root, remote } = await project({ name: 'T', host: 'h', password: 'pw', remotePath: '/app', context: 'site', ignore: ['/**/*.log'] })
    const server = fakeServer(remote)
    const { service, progress } = make(root, server.client)
    expect(await service.upload('p', 'T', ['site/index.html'])).toBe(1)
    expect(await readFile(join(remote, 'app/index.html'), 'utf8')).toBe('index')
    expect(server.connects[0]).toMatchObject({ host: 'h', port: 22, password: 'pw', agent: undefined, readyTimeout: 10_000 })
    expect(await service.sync('p', 'T', 'up')).toBe(2) // index.html, css/a.css — not debug.log
    expect(await readFile(join(remote, 'app/css/a.css'), 'utf8')).toBe('a{}')
    expect(progress.at(-1)).toEqual({ projectId: 'p', action: 'upload', file: 'site/index.html', done: 2, total: 2 })
    await expect(service.upload('p', 'T', ['other.txt'])).rejects.toMatchObject({ code: 'outside-context' })
    await expect(service.upload('p', 'T', ['../x'])).rejects.toMatchObject({ code: 'outside-project' })
  })

  it('uploads never follow a link inside a folder: `assets -> ~/.ssh` would send the user’s keys', async () => {
    const { root, remote } = await project({ name: 'T', host: 'h', remotePath: '/app', context: 'site' })
    const home = await tempDir('mindeck-home-')
    await mkdir(join(home, '.ssh'))
    await writeFile(join(home, '.ssh/id_ed25519'), 'SECRET KEY')
    await symlink(join(home, '.ssh'), join(root, 'site/assets'), 'dir')
    await symlink(join(home, '.ssh/id_ed25519'), join(root, 'site/key.txt'))
    await symlink(join(root, 'site/index.html'), join(root, 'site/inside.html'))
    await symlink(join(root, 'site/gone'), join(root, 'site/dangling'))
    const { service } = make(root, fakeServer(remote).client)
    expect(await service.sync('p', 'T', 'up')).toBe(3) // index.html, css/a.css, debug.log — no link
    expect((await readdir(join(remote, 'app'))).sort()).toEqual(['css', 'debug.log', 'index.html'])
    // Named directly, a link must lead inside the project (confine) — and then counts.
    await expect(service.upload('p', 'T', ['site/assets'])).rejects.toMatchObject({ code: 'outside-project' })
    expect(await service.upload('p', 'T', ['site/inside.html'])).toBe(1)
  })

  it('a project that isn’t trusted: its .vscode/sftp.json names no server Mindeck connects to', async () => {
    const { root, remote } = await project({ name: 'T', host: 'attacker.example', remotePath: '/', uploadOnSave: true })
    const server = fakeServer(remote)
    const { service } = make(root, server.client, '/home/me', false)
    expect(await service.targets('p')).toEqual([])
    await expect(service.upload('p', 'T', ['other.txt'])).rejects.toMatchObject({ code: 'untrusted' })
    await expect(service.list('p', 'T')).rejects.toMatchObject({ code: 'untrusted' })
    await expect(service.download('p', 'T', ['x'])).rejects.toMatchObject({ code: 'untrusted' })
    await expect(service.sync('p', 'T', 'up')).rejects.toMatchObject({ code: 'not-found' })
    await expect(new SftpService({ resolveRoot: () => root, client: async () => server.client }).list('p', 'T')).rejects.toMatchObject({ code: 'untrusted' })
    expect(server.connects).toEqual([])
  })

  it('lists the server, downloads files and folders into the context, syncs down', async () => {
    const { root, remote } = await project({ name: 'T', host: 'h', remotePath: '/app', context: 'site' })
    await mkdir(join(remote, 'app/img'), { recursive: true })
    await writeFile(join(remote, 'app/index.html'), 'from server')
    await writeFile(join(remote, 'app/img/logo.svg'), '<svg/>')
    await writeFile(join(remote, 'app/.DS_Store'), '')
    await symlink(join(remote, 'app/index.html'), join(remote, 'app/link.html'))
    const { service } = make(root, fakeServer(remote).client)
    expect((await service.list('p', 'T')).map((e) => `${e.path}:${e.type}`)).toEqual(['img:dir', '.DS_Store:file', 'index.html:file', 'link.html:link'])
    expect((await service.list('p', 'T', 'img')).map((e) => e.path)).toEqual(['img/logo.svg'])
    expect(await service.download('p', 'T', ['index.html'])).toEqual(['site/index.html'])
    expect(await readFile(join(root, 'site/index.html'), 'utf8')).toBe('from server')
    expect(await service.download('p', 'T', ['img'])).toEqual(['site/img/logo.svg'])
    await expect(service.download('p', 'T', ['nope.txt'])).rejects.toMatchObject({ code: 'not-found' })
    expect(await service.sync('p', 'T', 'down')).toBe(3) // index, link, logo — never .DS_Store
    await expect(service.sync('p', 'Nope', 'down')).rejects.toMatchObject({ code: 'not-found' })
    await expect(service.list('p', 'Nope')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('a download never lands outside the project through a dangling link of the same name (BE-SEC-02)', async () => {
    const { root, remote } = await project({ name: 'T', host: 'h', remotePath: '/app', context: 'site' })
    const elsewhere = await tempDir()
    await mkdir(join(remote, 'app'), { recursive: true })
    await writeFile(join(remote, 'app/setup.sh'), 'evil')
    await symlink(join(elsewhere, 'autostart.sh'), join(root, 'site/setup.sh'))
    const { service } = make(root, fakeServer(remote).client)
    await expect(service.download('p', 'T', ['setup.sh'])).rejects.toMatchObject({ code: 'outside-project' })
    expect(await readdir(elsewhere)).toEqual([])
  })

  it('signs in with a key (with ~), else the SSH agent; FTP is not supported; a failing close is ignored', async () => {
    const home = await tempDir('mindeck-home-')
    await mkdir(join(home, '.ssh'))
    await writeFile(join(home, '.ssh/id_test'), 'KEY')
    const keyed = await project({ name: 'K', host: 'h', privateKeyPath: '~/.ssh/id_test', passphrase: 'pp', port: 2222, connectTimeout: 5000 })
    const server = fakeServer(keyed.remote, { failEnd: true })
    await make(keyed.root, server.client, home).service.list('p', 'K')
    expect(server.connects[0]).toMatchObject({ privateKey: Buffer.from('KEY'), passphrase: 'pp', port: 2222, readyTimeout: 5000, agent: undefined })

    const lostKey = await project({ name: 'K', host: 'h', privateKeyPath: '/nowhere/key' })
    await expect(make(lostKey.root, fakeServer(lostKey.remote).client).service.list('p', 'K')).rejects.toMatchObject({ code: 'bad-config' })

    const agent = await project({ name: 'A', host: 'h' })
    const agentServer = fakeServer(agent.remote)
    const before = process.env.SSH_AUTH_SOCK
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock'
    await make(agent.root, agentServer.client).service.list('p', 'A')
    process.env.SSH_AUTH_SOCK = before
    expect(agentServer.connects[0]).toMatchObject({ agent: '/tmp/agent.sock' })
    expect(agentServer.connects[0].username).toBe(userInfo().username) // none configured: like ssh
    // Without a context the whole project syncs (never .vscode).
    expect(await make(agent.root, agentServer.client).service.sync('p', 'A', 'up')).toBe(4)
    expect(await readdir(agent.remote)).toEqual(['other.txt', 'site'])
    const explicit = await project({ name: 'E', host: 'h', agent: '/my/agent' })
    const explicitServer = fakeServer(explicit.remote)
    await make(explicit.root, explicitServer.client).service.list('p', 'E')
    expect(explicitServer.connects[0]).toMatchObject({ agent: '/my/agent' })

    const ftp = await project({ name: 'F', host: 'h', protocol: 'ftp' })
    await expect(make(ftp.root, fakeServer(ftp.remote).client).service.list('p', 'F')).rejects.toMatchObject({ code: 'unsupported', message: "FTP isn't supported — use SFTP" })
    const sftp = await project({ name: 'S', host: 'h', protocol: 'sftp' })
    await expect(make(sftp.root, fakeServer(sftp.remote).client).service.list('p', 'S')).resolves.toBeDefined()
  })

  it('the real SFTP client loads on demand', async () => {
    const { root } = await project({ name: 'T', host: '127.0.0.1', port: 1, connectTimeout: 500 })
    const service = new SftpService({ resolveRoot: () => root, trusted: () => true })
    await expect(service.list('p', 'T')).rejects.toBeTruthy() // nothing listens on port 1
    expect(dirname('/a/b')).toBe('/a')
  }, 20_000)
})
