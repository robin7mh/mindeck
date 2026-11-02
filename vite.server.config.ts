import { resolve } from 'node:path'
import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'
import pkg from './package.json'
import { cloudDefines } from './electron/main/services/cloud/config'

// The standalone Mindeck core (server/main.ts) as one CommonJS file:
// out/server/index.cjs. npm dependencies stay external (node_modules at
// runtime — native modules like node-pty cannot be bundled).
// ESM-only packages are bundled instead: a CommonJS file can't require() them.
const BUNDLED = ['@agentclientprotocol/sdk']
const external = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  ...Object.keys(pkg.dependencies).filter((d) => !BUNDLED.includes(d))
]

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  define: {
    __MINDECK_VERSION__: JSON.stringify(pkg.version),
    // Where Mindeck Cloud lives (see electron/main/services/cloud/config.ts). With it
    // baked in, the build is a release and requires a license.
    ...cloudDefines()
  },
  build: {
    outDir: 'out/server',
    emptyOutDir: true,
    target: 'node22',
    ssr: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: resolve(__dirname, 'server/main.ts'),
      external: (id) => external.some((e) => id === e || id.startsWith(`${e}/`)),
      output: { format: 'cjs', entryFileNames: 'index.cjs' }
    }
  }
})
