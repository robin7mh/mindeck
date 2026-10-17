import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

const root = join(__dirname, '..', '..', '..')
const builder = parse(readFileSync(join(root, 'electron-builder.yml'), 'utf8')) as {
  electronFuses?: Record<string, boolean>
  mac?: { hardenedRuntime?: boolean; entitlements?: string; entitlementsInherit?: string; sign?: string }
}
/** The entitlement keys a plist grants. */
const granted = (file: string) => [...readFileSync(join(root, file), 'utf8').matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1])

describe('packaging', () => {
  it('flips Electron’s fuses: never run as Node, no NODE_OPTIONS or --inspect, code only from a checked app.asar, encrypted cookies', () => {
    expect(builder.electronFuses).toEqual({
      // ELECTRON_RUN_AS_NODE=1 Mindeck -e … would be a Node with Mindeck's camera/microphone/folder permissions.
      // Mindeck's own Node programs run in utility processes (lib/nodeProcess.ts).
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true
    })
    expect(builder.mac?.hardenedRuntime).toBe(true)
  })

  it('grants the signed macOS app only what it needs — the helpers JIT alone, the plugin helper native addons', () => {
    expect(builder.mac?.entitlements).toBe('build/entitlements.mac.plist')
    expect(builder.mac?.entitlementsInherit).toBe('build/entitlements.mac.inherit.plist')
    // No debugger, no injected or foreign libraries, no unsigned executable memory (V8 uses MAP_JIT). Camera and
    // microphone for websites in Mindeck's browser (its permission handler decides per site).
    expect(granted(builder.mac!.entitlements!)).toEqual(['com.apple.security.cs.allow-jit', 'com.apple.security.device.camera', 'com.apple.security.device.audio-input'])
    expect(granted(builder.mac!.entitlementsInherit!)).toEqual(['com.apple.security.cs.allow-jit'])
    // Library validation is off only in the plugin helper: utility processes with the project's ESLint/Prettier
    // and tsconfig plugins (allowLoadingUnsignedLibraries), whose native addons aren't signed by Mindeck.
    expect(granted('build/entitlements.mac.plugin.plist')).toEqual(['com.apple.security.cs.allow-jit', 'com.apple.security.cs.disable-library-validation'])
  })

  it('signs the plugin helper with its own entitlements, everything else as electron-builder would', async () => {
    expect(builder.mac?.sign).toBe('build/sign.cjs')
    const hook = createRequire(__filename)(join(root, 'build/sign.cjs')) as {
      signWith: (sign: (opts: unknown) => Promise<void>) => (opts: { optionsForFile: (file: string) => object }) => Promise<void>
      PLUGIN_ENTITLEMENTS: string
    }
    expect(hook.PLUGIN_ENTITLEMENTS).toBe(join(root, 'build/entitlements.mac.plugin.plist'))
    const sign = vi.fn(async (_opts: unknown) => {})
    const base = (file: string) => ({ entitlements: file.endsWith('Mindeck.app') ? 'main.plist' : 'inherit.plist', hardenedRuntime: true })
    await hook.signWith(sign)({ optionsForFile: base, app: '/out/Mindeck.app' } as never)
    const { optionsForFile, app } = sign.mock.calls[0][0] as { optionsForFile: (file: string) => object; app: string }
    expect(app).toBe('/out/Mindeck.app')
    const fw = '/out/Mindeck.app/Contents/Frameworks'
    expect(optionsForFile('/out/Mindeck.app')).toEqual({ entitlements: 'main.plist', hardenedRuntime: true })
    expect(optionsForFile(`${fw}/Mindeck Helper.app`)).toEqual({ entitlements: 'inherit.plist', hardenedRuntime: true })
    expect(optionsForFile(`${fw}/Mindeck Helper (Renderer).app`)).toEqual({ entitlements: 'inherit.plist', hardenedRuntime: true })
    for (const file of [`${fw}/Mindeck Helper (Plugin).app`, `${fw}/Mindeck Helper (Plugin).app/Contents/MacOS/Mindeck Helper (Plugin)`])
      expect(optionsForFile(file)).toEqual({ entitlements: hook.PLUGIN_ENTITLEMENTS, hardenedRuntime: true })
  })
})

describe('Docker', () => {
  const compose = parse(readFileSync(join(root, 'docker-compose.yml'), 'utf8')) as {
    services: { core: { read_only?: boolean; tmpfs?: string[]; cap_drop?: string[]; security_opt?: string[]; volumes: string[] } }
  }
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8')

  it('runs the core hardened: no capabilities, no privilege gain, a read-only image with in-memory /tmp and home', () => {
    const core = compose.services.core
    expect(core.read_only).toBe(true)
    expect(core.cap_drop).toEqual(['ALL'])
    expect(core.security_opt).toContain('no-new-privileges:true')
    expect(core.tmpfs).toEqual(['/tmp', '/home/node:uid=1000,gid=1000'])
    // The projects folder: an empty ./projects by default (never the compose folder with its .env), read-only unless asked.
    expect(core.volumes).toContain('${MINDECK_PROJECTS_DIR:-./projects}:/projects:${MINDECK_PROJECTS_MODE:-ro}')
    expect(dockerfile).toMatch(/^HEALTHCHECK /m)
  })

  it('builds from base images pinned by digest', () => {
    const bases = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1])
    expect(bases).toHaveLength(2)
    for (const base of bases) expect(base).toMatch(/^node:22-bookworm(-slim)?@sha256:[0-9a-f]{64}$/)
  })
})
