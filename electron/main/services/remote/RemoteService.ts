import type { ChildProcess } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { RemoteConnection, SshHost } from '@shared/types/remote'
import type { CloudAccount } from '@shared/types/cloud'
import type { PairResult } from '@shared/types/server'
import { spawnNode, type NodeLauncher, type NodeProcess } from '../../lib/nodeProcess'
import { spawnInShell } from '../debug/adapters'
import { userEnv } from '../tools/ToolsService'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Starts a program the way the user's terminal would (their PATH: ssh, docker). */
export type Start = (command: string, args: string[], env?: Record<string, string>) => ChildProcess

export interface RemoteOptions {
  version: string
  /** The desktop needs a license (release builds): the remote core then runs on it, as a follower. */
  licensed: boolean
  /** This machine's name, for the device the remote core pairs. */
  deviceName: string
  /** The server package for an architecture (a .tar.gz). */
  bundle: (arch: 'x64' | 'arm64') => Promise<string>
  secrets: { get(name: string): Promise<string | undefined>; set(name: string, value: string | null): Promise<void> }
  /** The desktop's current entitlement, handed to the remote core (it runs on this license) while the cloud issues no follower leases. */
  entitlement: () => { token: string; account: CloudAccount } | null
  /** A follower lease from Mindeck Cloud for the remote core with this install id — null when there is none (BE-SEC-09). */
  followerLease?: (installId: string) => Promise<{ token: string; account: CloudAccount } | null>
  openWindow?: (opts: { title: string; url: string; token: string; deviceId: string }) => { closed: Promise<void>; close: () => void }
  publish: (connections: RemoteConnection[]) => void
  /** The ssh config with the hosts (default ~/.ssh/config). */
  sshConfig?: string
  /** How the Dev Containers CLI runs as a Node program (Platform.node). */
  node?: NodeLauncher
  /** Start the Dev Containers CLI's `devcontainer up` for a project (default: defaultDevcontainer). */
  devcontainer?: (root: string) => Promise<NodeProcess>
  start?: Start
  fetch?: typeof fetch
  /** How often the entitlement is handed over again. */
  licenseMs?: number
  timeoutMs?: number
}

interface Live {
  info: RemoteConnection
  procs: ChildProcess[]
  proxy?: Server
  timer?: ReturnType<typeof setInterval>
  window?: { close: () => void }
}

/** Where the package lives over there: per version, next to the user's home. */
const dirOf = (version: string) => `$HOME/.mindeck-server/${version}`

/** `Host` entries of an ssh config — the concrete ones (no patterns), with what they point at. */
export function parseSshConfig(text: string): SshHost[] {
  const hosts: SshHost[] = []
  let current: SshHost[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim()
    const m = /^([^\s=]+)\s*(?:=\s*|\s+)(.+)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'host') {
      current = value
        .split(/\s+/)
        .filter((n) => !/[*?!]/.test(n))
        .map((name) => ({ name }))
      hosts.push(...current)
    } else if (key === 'match') current = []
    else if (key === 'hostname') current.forEach((h) => (h.hostName = value))
    else if (key === 'user') current.forEach((h) => (h.user = value))
    else if (key === 'port') current.forEach((h) => (h.port = Number(value)))
  }
  return hosts
}

/** `uname -m` → the package's architecture. */
export function archOf(machine: string): 'x64' | 'arm64' | undefined {
  const m = machine.trim()
  if (m === 'x86_64' || m === 'amd64') return 'x64'
  if (m === 'aarch64' || m === 'arm64') return 'arm64'
  return undefined
}

/** `user@host:port` → ssh arguments (anything else is a config host). */
export function hostArgs(target: string): string[] {
  const m = /^(.+@)?([^:@\s]+):(\d+)$/.exec(target)
  return m ? ['-p', m[3], `${m[1] ?? ''}${m[2]}`] : [target]
}

/** The code in the server's pairing banner. */
export const pairingCode = (output: string): string | undefined => /Code:\s+(\S+)/.exec(output)?.[1]

/** The command starting the core over there: our package, our license (when this desktop needs one), gone with the connection. */
export function coreCommand(version: string, port: number, licensed: boolean): string {
  const env = ['MINDECK_HOME="$HOME/.mindeck"', `MINDECK_PORT=${port}`, 'MINDECK_REMOTE_TERMINAL=1', 'MINDECK_EXIT_WITH_STDIN=1', ...(licensed ? ['MINDECK_LICENSE=follower', 'NODE_ENV=production'] : [])]
  return `cd "${dirOf(version)}" && ${env.join(' ')} exec ./node out/server/index.cjs`
}

/** Runs a node one-liner inside the container that pipes stdin/stdout to the core's port. */
const PIPE = (port: number) => `const s=require('net').connect(${port},'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout);s.on('close',()=>process.exit(0));s.on('error',()=>process.exit(1))`

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

/**
 * Remote-SSH and Dev Containers: Mindeck's own core runs on the other machine
 * (installed there once per version), the desktop reaches it through an ssh
 * tunnel — or a pipe into the container — pairs itself, hands its license
 * over and opens a window on it. Closing the window ends it all.
 */
export class RemoteService {
  private live = new Map<string, Live>()
  private readonly opts: RemoteOptions & Required<Pick<RemoteOptions, 'start' | 'fetch' | 'devcontainer' | 'licenseMs' | 'timeoutMs'>> & { hostsFile: string }

  constructor(opts: RemoteOptions) {
    this.opts = {
      start: (command, args, env) => spawnInShell(command, args, homedir(), env),
      fetch: globalThis.fetch,
      devcontainer: defaultDevcontainer(opts.node ?? spawnNode),
      licenseMs: 60_000,
      timeoutMs: 60_000,
      hostsFile: opts.sshConfig ?? join(homedir(), '.ssh', 'config'),
      ...opts
    }
  }

  async hosts(): Promise<SshHost[]> {
    return parseSshConfig(await readFile(this.opts.hostsFile, 'utf8').catch(() => ''))
  }

  list(): RemoteConnection[] {
    return [...this.live.values()].map((l) => l.info)
  }

  /** Connect to an ssh host (a config entry or user@host[:port]). */
  async ssh(target: string): Promise<RemoteConnection> {
    const id = `ssh:${target}`
    const ssh = (command: string, extra: string[] = []) => this.start('ssh', [...this.sshArgs(), ...extra, ...hostArgs(target), command])
    return this.connect(id, 'ssh', target, async (live) => {
      const remotePort = randomInt(20_000, 60_000)
      const localPort = await freePort()
      const tunnel = ['-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`]
      return {
        run: (command) => ssh(command),
        install: (command) => ssh(command),
        core: () => ssh(coreCommand(this.opts.version, remotePort, this.opts.licensed), tunnel),
        url: `http://127.0.0.1:${localPort}`,
        title: `SSH: ${target}`,
        live
      }
    })
  }

  /** Does the project describe a Dev Container? */
  hasContainer(root: string): boolean {
    return existsSync(join(root, '.devcontainer', 'devcontainer.json')) || existsSync(join(root, '.devcontainer.json'))
  }

  /** Open a project in its Dev Container (`.devcontainer/devcontainer.json`). */
  async container(root: string): Promise<RemoteConnection> {
    if (!this.hasContainer(root)) throw coded('no-devcontainer', 'This project has no .devcontainer/devcontainer.json')
    const name = basename(root)
    return this.connect(`container:${root}`, 'container', `Container: ${name}`, async (live) => {
      const up = await this.collect(await this.opts.devcontainer(root), 10 * 60_000)
      const result = up.stdout
        .split('\n')
        .reverse()
        .map((l) => {
          try {
            return JSON.parse(l) as { outcome?: string; containerId?: string; remoteUser?: string; remoteWorkspaceFolder?: string; message?: string }
          } catch {
            return null
          }
        })
        .find((r) => r?.outcome)
      if (result?.outcome !== 'success' || !result.containerId) throw coded('devcontainer', result?.message ?? lastLine(up.stderr) ?? 'devcontainer up failed')
      const { containerId: cid, remoteUser: user = 'root', remoteWorkspaceFolder: folder } = result
      const exec = (command: string) => this.start('docker', ['exec', '-i', '-u', user, cid, 'sh', '-c', command])
      const remotePort = randomInt(20_000, 60_000)
      // Each connection to the local port is piped into the container (works without published ports).
      live.proxy = createServer((socket) => {
        const pipe = this.start('docker', ['exec', '-i', '-u', user, cid, 'sh', '-c', `exec "${dirOf(this.opts.version)}/node" -e "${PIPE(remotePort)}"`])
        socket.pipe(pipe.stdin!)
        pipe.stdout!.pipe(socket)
        socket.on('error', () => pipe.kill())
        socket.on('close', () => pipe.kill())
        pipe.on('exit', () => socket.destroy())
      })
      const proxy = live.proxy
      const localPort = await new Promise<number>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve((proxy.address() as { port: number }).port)))
      return {
        run: exec,
        install: exec,
        core: () => exec(coreCommand(this.opts.version, remotePort, this.opts.licensed)),
        url: `http://127.0.0.1:${localPort}`,
        title: `Container: ${name}`,
        folder,
        live
      }
    })
  }

  async disconnect(id: string): Promise<void> {
    const live = this.live.get(id)
    if (!live) return
    this.stop(live, 'closed')
  }

  dispose(): void {
    for (const live of this.live.values()) this.stop(live, 'closed')
  }

  // --- the steps every connection takes ---

  private async connect(
    id: string,
    kind: RemoteConnection['kind'],
    label: string,
    prepare: (live: Live) => Promise<{
      run: (command: string) => ChildProcess
      install: (command: string) => ChildProcess
      core: () => ChildProcess
      url: string
      title: string
      folder?: string
      live: Live
    }>
  ): Promise<RemoteConnection> {
    const existing = this.live.get(id)
    if (existing && existing.info.state !== 'failed' && existing.info.state !== 'closed') return existing.info
    const live: Live = { info: { id, kind, label, state: 'connecting' }, procs: [] }
    this.live.set(id, live)
    this.emit()
    try {
      const target = await prepare(live)
      // Which machine, and is this version there already?
      const probe = await this.collect(target.run(`uname -m; cat "${dirOf(this.opts.version)}/VERSION" 2>/dev/null; true`))
      if (probe.code !== 0) throw coded('remote-unreachable', lastLine(probe.stderr) ?? `exit ${probe.code}`)
      const [machine, installed] = probe.stdout.split('\n')
      const arch = archOf(machine)
      if (!arch) throw coded('remote-unsupported', `Mindeck runs on Linux x64 / arm64 — this machine is ${machine.trim() || 'unknown'}`)
      if (installed?.trim() !== this.opts.version) {
        this.update(live, { state: 'installing' })
        const bundle = await this.opts.bundle(arch)
        const dir = dirOf(this.opts.version)
        const install = target.install(`rm -rf "${dir}" && mkdir -p "${dir}" && tar xzf - -C "${dir}"`)
        createReadStream(bundle).pipe(install.stdin!)
        const done = await this.collect(install, 10 * 60_000)
        if (done.code !== 0) throw coded('remote-install', lastLine(done.stderr) ?? `exit ${done.code}`)
      }
      // Start the core; it lives as long as this process (stdin) does.
      this.update(live, { state: 'starting' })
      const core = target.core()
      live.procs.push(core)
      const started = await this.waitFor(core, /listening on/)
      core.on('exit', () => live.info.state === 'ready' && this.stop(live, 'failed', 'The remote Mindeck stopped'))
      const { token, deviceId } = await this.pair(id, target.url, started, () => this.collect(target.run(`cd "${dirOf(this.opts.version)}" && MINDECK_HOME="$HOME/.mindeck" ./node out/server/index.cjs pair --admin`)))
      await this.handLicense(target.url, token)
      live.timer = setInterval(() => void this.handLicense(target.url, token).catch(() => {}), this.opts.licenseMs)
      live.timer.unref?.()
      if (target.folder) await this.rpc(target.url, token, 'projects:add', { path: target.folder }).catch(() => {})
      this.update(live, { state: 'ready', url: target.url })
      const win = this.opts.openWindow?.({ title: target.title, url: target.url, token, deviceId })
      if (win) {
        live.window = win
        void win.closed.then(() => this.stop(live, 'closed'))
      }
      return live.info
    } catch (err) {
      this.stop(live, 'failed', (err as Error).message)
      throw err
    }
  }

  /** The saved device token if the core still knows it; else pair with the code from its banner (or `pair`). */
  private async pair(id: string, url: string, output: string, pairCmd: () => Promise<{ stdout: string }>): Promise<{ token: string; deviceId: string }> {
    const key = `remote.${id}`
    const saved = await this.opts.secrets.get(key)
    if (saved) {
      const parsed = JSON.parse(saved) as { token: string; deviceId: string }
      if ((await this.rpc(url, parsed.token, 'app:info').then(() => true, () => false))) return parsed
    }
    const code = pairingCode(output) ?? pairingCode((await pairCmd()).stdout)
    if (!code) throw coded('remote-pair', 'The remote Mindeck gave no pairing code')
    const res = await this.opts.fetch(`${url}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: `Mindeck Desktop · ${this.opts.deviceName}` })
    })
    const body = (await res.json()) as { ok: boolean; data?: PairResult; error?: { message: string } }
    if (!body.ok) throw coded('remote-pair', body.error!.message)
    const paired = { token: body.data!.token, deviceId: body.data!.device.id }
    await this.opts.secrets.set(key, JSON.stringify(paired))
    return paired
  }

  /**
   * The remote core runs on this desktop's license (it can't sign in itself):
   * on a lease Mindeck Cloud issues for that core alone — or, while the cloud
   * issues none (or the remote core can't say its install id), on this
   * desktop's own entitlement, which the core then takes for a day at most.
   */
  private async handLicense(url: string, token: string): Promise<void> {
    const entitlement = this.opts.entitlement()
    if (!entitlement) return
    const lease = await this.leaseFor(url, token)
    await this.rpc(url, token, 'cloud:adopt', lease ?? entitlement).catch((err: Error) => {
      // Its package verifies with the key built into it — the same as this app's.
      throw coded('remote-license', `The remote Mindeck can't verify this license (${err.message}) — its server package must come from the same release`)
    })
  }

  private async leaseFor(url: string, token: string): Promise<{ token: string; account: CloudAccount } | null> {
    if (!this.opts.followerLease) return null
    const remote = (await this.rpc(url, token, 'cloud:installId').catch(() => null)) as { installId?: unknown } | null
    if (typeof remote?.installId !== 'string' || !remote.installId) return null
    return this.opts.followerLease(remote.installId).catch(() => null)
  }

  private async rpc(url: string, token: string, channel: string, payload?: unknown): Promise<unknown> {
    const res = await this.opts.fetch(`${url}/api/rpc/${channel}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload ?? null)
    })
    const body = (await res.json().catch(() => ({ ok: false, error: { message: `HTTP ${res.status}` } }))) as { ok: boolean; data?: unknown; error?: { message: string } }
    if (!body.ok) throw coded('remote-rpc', body.error!.message)
    return body.data
  }

  // --- processes ---

  private sshArgs(): string[] {
    return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', ...(this.opts.sshConfig ? ['-F', this.opts.sshConfig] : [])]
  }

  private start(command: string, args: string[], env?: Record<string, string>): ChildProcess {
    return this.opts.start(command, args, env)
  }

  /** Run to the end: exit code and output. */
  private collect(proc: NodeProcess, timeoutMs = this.opts.timeoutMs): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => proc.kill(), timeoutMs)
      proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
      proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
      proc.on('error', (err) => {
        clearTimeout(timer)
        resolve({ code: 127, stdout, stderr: `${stderr}${err.message}` })
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? 1, stdout, stderr })
      })
    })
  }

  /** Wait until the long-running process prints `pattern`; what it printed so far. */
  private waitFor(proc: ChildProcess, pattern: RegExp): Promise<string> {
    return new Promise((resolve, reject) => {
      let out = ''
      const timer = setTimeout(() => reject(coded('remote-start', 'The remote Mindeck did not start in time')), this.opts.timeoutMs)
      const seen = (d: Buffer) => {
        out += d.toString()
        // The pairing banner follows the "listening" line right away.
        if (pattern.test(out)) setTimeout(() => (clearTimeout(timer), resolve(out)), 300)
      }
      proc.stdout?.on('data', seen)
      proc.stderr?.on('data', (d: Buffer) => (out += d.toString()))
      proc.on('close', () => {
        clearTimeout(timer)
        reject(coded('remote-start', lastLine(out) ?? 'The remote Mindeck stopped'))
      })
    })
  }

  private stop(live: Live, state: 'closed' | 'failed', error?: string): void {
    if (live.info.state === 'closed' || (live.info.state === 'failed' && state === 'failed')) return
    clearInterval(live.timer)
    for (const p of live.procs) p.kill()
    live.proxy?.close()
    const win = live.window
    live.window = undefined
    this.update(live, { state, error, url: undefined })
    win?.close()
  }

  private update(live: Live, patch: Partial<RemoteConnection>): void {
    live.info = { ...live.info, ...patch }
    this.emit()
  }

  private emit(): void {
    this.opts.publish(this.list())
  }
}

const lastLine = (text: string): string | undefined =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()

/** The Dev Containers CLI that ships with Mindeck, run as a Node program; it finds docker on the user's PATH. */
export function defaultDevcontainer(node: NodeLauncher, env: () => Promise<Record<string, string>> = userEnv): (root: string) => Promise<NodeProcess> {
  return async (root) =>
    node([require.resolve('@devcontainers/cli/devcontainer.js'), 'up', '--workspace-folder', root], { cwd: homedir(), env: await env(), name: 'Dev Containers' })
}
