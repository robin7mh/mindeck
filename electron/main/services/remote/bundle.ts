import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Release builds bake in the SHA-256 of the server packages built with them
// (release.yml → MINDECK_REMOTE_SHA256_X64 / _ARM64 → `define`, electron.vite.config.ts).
declare const __MINDECK_REMOTE_SHA256__: string | undefined

type Arch = 'x64' | 'arm64'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Where release builds publish the server packages (next to the app's own release). */
export const RELEASES = 'https://github.com/robin7mh/mindeck/releases/download'

/** The `define` that bakes the packages' SHA-256 into a build: each a 64-digit hex, the rest left out. */
export function remoteBundleDefines(env: NodeJS.ProcessEnv = process.env): { __MINDECK_REMOTE_SHA256__: string } {
  const hashes: Partial<Record<Arch, string>> = {}
  for (const [arch, value] of [['x64', env.MINDECK_REMOTE_SHA256_X64], ['arm64', env.MINDECK_REMOTE_SHA256_ARM64]] as const) {
    const hex = value?.trim().toLowerCase()
    if (hex && !/^[0-9a-f]{64}$/.test(hex)) throw new Error(`MINDECK_REMOTE_SHA256_${arch.toUpperCase()} is not a SHA-256 (64 hex digits)`)
    if (hex) hashes[arch] = hex
  }
  return { __MINDECK_REMOTE_SHA256__: JSON.stringify(JSON.stringify(hashes)) }
}

/** The SHA-256 per architecture this build knows (none in dev runs). */
export function bakedBundleHashes(raw = typeof __MINDECK_REMOTE_SHA256__ === 'string' ? __MINDECK_REMOTE_SHA256__ : ''): Partial<Record<Arch, string>> {
  try {
    const parsed = JSON.parse(raw || '{}') as Record<string, unknown>
    return Object.fromEntries(Object.entries(parsed).filter(([arch, hex]) => (arch === 'x64' || arch === 'arm64') && typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex)))
  } catch {
    return {}
  }
}

export interface BundleOptions {
  version: string
  /** Downloaded packages: <dataDir>/remote. */
  dir: string
  /** Packages `npm run remote:bundle` built (dev runs). */
  devDir?: string
  /** The packages' SHA-256 this build was released with: a package that doesn't match is never used. */
  sha256?: Partial<Record<Arch, string>>
  fetch?: typeof fetch
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/**
 * The server package for an architecture: built locally, downloaded before, or
 * downloaded now. It is unpacked and run on the remote host (its own `node`
 * included), so when the build knows the package's SHA-256 every use checks it
 * — a package changed on disk since (or a different one on the server) is
 * thrown away and fetched again, and a download that doesn't match is refused.
 */
export async function remoteBundle(arch: Arch, opts: BundleOptions): Promise<string> {
  const name = `mindeck-server-${opts.version}-linux-${arch}.tar.gz`
  const expected = opts.sha256?.[arch]
  const intact = async (file: string) => !expected || (await sha256Of(file)) === expected
  const file = join(opts.dir, name)
  if (existsSync(file)) {
    if (await intact(file)) return file
    console.warn(`[remote] ${file} does not match this release's SHA-256 — downloading it again`)
    await rm(file, { force: true })
  }
  const dev = opts.devDir && join(opts.devDir, name)
  if (dev && existsSync(dev) && (await intact(dev))) return dev
  const { fetch: get } = { fetch: globalThis.fetch, ...opts }
  const res = await get(`${RELEASES}/v${opts.version}/${name}`)
  if (!res.ok || !res.body) throw coded('remote-bundle', `No Mindeck server package for linux-${arch} (HTTP ${res.status}) — dev: npm run remote:bundle`)
  await mkdir(opts.dir, { recursive: true })
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(`${file}.part`))
  if (!(await intact(`${file}.part`))) {
    await rm(`${file}.part`, { force: true })
    throw coded('remote-bundle-integrity', `The Mindeck server package for linux-${arch} does not match this release's SHA-256 — not installed`)
  }
  await rename(`${file}.part`, file)
  return file
}

/** `remoteBundle` with the options bound — what RemoteService asks for a package. */
export const bundleSource =
  (opts: BundleOptions) =>
  (arch: Arch): Promise<string> =>
    remoteBundle(arch, opts)
