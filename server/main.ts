// Mindeck core as a standalone server — the same services as the desktop app,
// headless, reachable by the web UI and the mobile app over HTTP + WebSocket.
//
//   node out/server/index.cjs          start (see README → "Web UI & server")
//   node out/server/index.cjs pair     print a one-time pairing code (`pair --admin`: for an admin device)
//
// Configuration (environment):
//   MINDECK_HOME             data + vault root (default ~/Mindeck)
//   MINDECK_PORT             port (default 7420)
//   MINDECK_LAN=1            listen on all interfaces instead of 127.0.0.1
//   MINDECK_TLS=1|0          HTTPS for the network (default 1): a self-signed certificate in
//                            MINDECK_HOME/data/tls, trusted by its fingerprint; 127.0.0.1 keeps HTTP
//   MINDECK_TLS_CERT, MINDECK_TLS_KEY  own certificate + key (PEM files, e.g. Let's Encrypt) instead
//   MINDECK_REMOTE_TERMINAL=1  allow paired devices to open shells (off by default)
//   MINDECK_REMOTE_ROOTS     folders devices may add as projects or vault, separated by
//                            `:` (`;` on Windows); default /projects (the Docker mount)
//   MINDECK_WEB_ROOT         built web UI to serve (default: next to this file)
//   A build with Mindeck Cloud baked in (MINDECK_CLOUD_URL/KEY at build time, the
//   Docker image) requires a Mindeck license; otherwise only with
//   MINDECK_LICENSE=required. Dev: MINDECK_CLOUD_URL at run time.
//   MINDECK_LICENSE=follower started by the desktop app (Remote-SSH, Dev Container):
//                         the desktop hands its entitlement over (cloud:adopt). In a
//                         release only the server package (remote/Dockerfile) honours it.
//   MINDECK_EXIT_WITH_STDIN=1  stop when stdin closes (the desktop's ssh / docker exec ended)

import { delimiter, join } from 'node:path'
import { DEFAULT_SERVER_CONFIG, type ServerConfig } from '@shared/types/server'
import { mindeckPaths } from '../electron/main/lib/paths'
import { headlessPlatform } from '../electron/main/platform/headless'
import { createCore, type Core } from '../electron/main/core/createCore'
import { AuthService } from '../electron/main/services/auth/AuthService'
import { Certificates } from '../electron/main/server/Certificates'
import { tlsWanted } from '../electron/main/server/ServerController'
import { cloudConfig, isReleaseBuild } from '../electron/main/services/cloud/config'

declare const __MINDECK_VERSION__: string

const flag = (v: string | undefined) => v === '1' || v === 'true'

export function serverConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.MINDECK_PORT)
  return {
    enabled: true,
    lan: flag(env.MINDECK_LAN),
    // On unless switched off: whoever reaches the core over the network gets HTTPS.
    tls: env.MINDECK_TLS === undefined || flag(env.MINDECK_TLS),
    port: env.MINDECK_PORT && Number.isInteger(port) && port >= 0 && port < 65536 ? port : DEFAULT_SERVER_CONFIG.port,
    remoteTerminal: flag(env.MINDECK_REMOTE_TERMINAL),
    // A headless core has no browser.
    remoteBrowser: false,
    remoteRoots: env.MINDECK_REMOTE_ROOTS ? env.MINDECK_REMOTE_ROOTS.split(delimiter).filter(Boolean) : ['/projects']
  }
}

/** An own certificate from MINDECK_TLS_CERT + MINDECK_TLS_KEY (both or neither). */
export function tlsFilesFromEnv(env: NodeJS.ProcessEnv = process.env): { cert: string; key: string } | undefined {
  const { MINDECK_TLS_CERT: cert, MINDECK_TLS_KEY: key } = env
  if (!cert && !key) return undefined
  if (!cert || !key) throw new Error('Set both MINDECK_TLS_CERT and MINDECK_TLS_KEY (PEM files), or neither')
  return { cert, key }
}

function banner(code: string, urls: string[], admin = false, fingerprint?: string): string {
  return [
    '',
    '  ┌─ Mindeck pairing ─────────────────────────────',
    `  │  Code:  ${code}   (valid 10 minutes, one use${admin ? ', admin device' : ''})`,
    ...urls.map((u) => `  │  Open:  ${u}`),
    // The browser warns about a self-signed certificate: this is what it should show.
    ...(fingerprint ? [`  │  Certificate SHA-256:`, `  │    ${fingerprint}`] : []),
    '  └─────────────────────────────────────────────',
    ''
  ].join('\n')
}

export async function run(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<Core | null> {
  const paths = mindeckPaths()
  const version = typeof __MINDECK_VERSION__ === 'string' ? __MINDECK_VERSION__ : '0.0.0'

  if (argv[0] === 'pair') {
    // Whoever runs this has the machine's shell: they may hand out the admin role.
    const admin = argv.includes('--admin')
    const { code } = await new AuthService(paths.devicesFile, undefined, true).createPairingCode(admin ? 'admin' : 'member')
    const config = serverConfigFromEnv(env)
    const files = tlsFilesFromEnv(env)
    const secure = tlsWanted(config, !!files)
    // The running core's certificate (this command makes none).
    const tls = secure ? await new Certificates({ dir: paths.tlsDir, files }).current() : null
    console.log(banner(code, [`${secure ? 'https' : 'http'}://127.0.0.1:${config.port}`], admin, tls?.fingerprint))
    return null
  }

  const core = await createCore({
    mode: 'server',
    version,
    paths,
    platform: headlessPlatform,
    serverConfig: serverConfigFromEnv(env),
    webRoot: env.MINDECK_WEB_ROOT || join(__dirname, '../web'),
    tlsFiles: tlsFilesFromEnv(env),
    // A release is a build decision, never an environment variable.
    cloud: cloudConfig(isReleaseBuild(), env)
  })
  await core.server.start()
  const status = core.server.status()
  if (!status.running) {
    await core.dispose()
    throw new Error(`Mindeck server could not start: ${status.error}`)
  }
  console.log(`[server] Mindeck ${version} listening on ${status.urls.join(', ')}`)
  if (!(await core.auth.hasDevices())) {
    const { code, urls, fingerprint } = await core.server.createPairingCode()
    console.log(banner(code, urls, false, fingerprint))
  }
  return core
}

/* v8 ignore start -- process entry point, exercised by the web E2E suite */
if (require.main === module) {
  run(process.argv.slice(2)).then(
    (core) => {
      if (!core) return
      let stopping = false
      const stop = () => {
        if (stopping) return
        stopping = true
        console.log('[server] shutting down')
        void core.dispose().finally(() => process.exit(0))
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      // Started by the desktop app over ssh / docker exec: its end is ours.
      if (flag(process.env.MINDECK_EXIT_WITH_STDIN)) {
        process.stdin.on('end', stop).on('close', stop).resume()
      }
    },
    (err) => {
      console.error(err)
      process.exit(1)
    }
  )
}
/* v8 ignore stop */
