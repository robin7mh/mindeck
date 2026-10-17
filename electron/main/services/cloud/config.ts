import { parsePublicKeys } from './entitlement'

// Release builds bake the cloud's address and entitlement keys in at build
// time: MINDECK_CLOUD_URL / MINDECK_CLOUD_KEY → `define` (electron.vite.config.ts,
// vite.server.config.ts). MINDECK_CLOUD_KEY is a list after a key rotation
// (comma- or line-separated, the original key first — see entitlement.ts). Absent in dev and tests. The server package for
// Remote-SSH / Dev Containers is built with MINDECK_FOLLOWER_BUILD=1
// (remote/Dockerfile): only that build may follow the desktop's license.
declare const __MINDECK_CLOUD_URL__: string | undefined
declare const __MINDECK_CLOUD_KEY__: string | undefined
declare const __MINDECK_FOLLOWER__: string | undefined

/** `npm run dev` in mindeck-cloud. */
export const DEV_CLOUD_URL = 'http://localhost:8080'

export interface CloudConfig {
  url: string
  /** Entitlement public key(s), a list after a rotation; without one the core fetches them from the cloud. */
  publicKey?: string
  /** Whether Mindeck needs a license to run here. */
  enforced: boolean
  /**
   * A core the desktop app runs on another machine (Remote-SSH, Dev Container):
   * it doesn't sign in itself but takes the desktop's signed entitlement over.
   */
  follower?: boolean
}

export function bakedCloud(): { url?: string; key?: string; follower?: boolean } {
  return {
    url: typeof __MINDECK_CLOUD_URL__ === 'string' && __MINDECK_CLOUD_URL__ ? __MINDECK_CLOUD_URL__ : undefined,
    key: typeof __MINDECK_CLOUD_KEY__ === 'string' && __MINDECK_CLOUD_KEY__ ? __MINDECK_CLOUD_KEY__ : undefined,
    ...(typeof __MINDECK_FOLLOWER__ === 'string' && __MINDECK_FOLLOWER__ === '1' ? { follower: true } : {})
  }
}

/**
 * A release build: one with Mindeck Cloud baked in. Decided when it is built —
 * no variable at run time can turn a release into an unlicensed dev core.
 */
export function isReleaseBuild(baked = bakedCloud()): boolean {
  return !!baked.url
}

/**
 * MINDECK_CLOUD_KEY for a `define`, checked: every key in the list must be an
 * Ed25519 public key — a typo fails the build instead of locking every user out.
 */
export function cloudKeyDefine(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.MINDECK_CLOUD_KEY ?? ''
  if (key) {
    try {
      parsePublicKeys(key)
    } catch (err) {
      throw new Error(`MINDECK_CLOUD_KEY holds a key that is not an Ed25519 public key (PEM or base64 SPKI DER): ${(err as Error).message}`)
    }
  }
  return JSON.stringify(key)
}

/**
 * The `define`s that bake Mindeck Cloud into a build (vite.server.config.ts).
 * A cloud without its entitlement key is refused: the core would otherwise
 * trust whatever key the network hands it on the first start.
 */
export function cloudDefines(env: NodeJS.ProcessEnv = process.env): { __MINDECK_CLOUD_URL__: string; __MINDECK_CLOUD_KEY__: string; __MINDECK_FOLLOWER__: string } {
  const url = env.MINDECK_CLOUD_URL ?? ''
  if (url && !env.MINDECK_CLOUD_KEY) throw new Error('MINDECK_CLOUD_URL is set without MINDECK_CLOUD_KEY: a release build needs the entitlement key built in')
  return { __MINDECK_CLOUD_URL__: JSON.stringify(url), __MINDECK_CLOUD_KEY__: cloudKeyDefine(env), __MINDECK_FOLLOWER__: JSON.stringify(env.MINDECK_FOLLOWER_BUILD === '1' ? '1' : '') }
}

/**
 * Where this core finds Mindeck Cloud and whether a license is required.
 * `release` = the packaged desktop app or a server built with the cloud baked in: always
 * enforced, always the baked-in cloud. Dev and test runs are open by default
 * (`MINDECK_LICENSE=required` turns the gate on) and may point elsewhere via
 * MINDECK_CLOUD_URL / MINDECK_CLOUD_KEY. `MINDECK_LICENSE=follower` (the desktop
 * starts its remote cores so) counts in a release only for the server package
 * built to follow — never the desktop app, the Docker image or another server.
 */
export function cloudConfig(release: boolean, env: NodeJS.ProcessEnv = process.env, baked = bakedCloud()): CloudConfig {
  const url = (release ? baked.url : env.MINDECK_CLOUD_URL || baked.url) || DEV_CLOUD_URL
  const publicKey = release ? baked.key : env.MINDECK_CLOUD_KEY || baked.key
  const follower = env.MINDECK_LICENSE === 'follower' && (!release || !!baked.follower)
  return {
    url: url.replace(/\/+$/, ''),
    ...(publicKey ? { publicKey } : {}),
    enforced: release || env.MINDECK_LICENSE === 'required' || follower,
    ...(follower ? { follower: true } : {})
  }
}
