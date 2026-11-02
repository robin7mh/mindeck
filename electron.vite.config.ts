import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { remoteBundleDefines } from './electron/main/services/remote/bundle'
import { cloudKeyDefine } from './electron/main/services/cloud/config'

// @shared points at src/shared (types + IPC contract shared by main/preload/renderer).
const shared = { '@shared': resolve(__dirname, 'src/shared') }

// monaco-vim imports Monaco's files as `monaco-editor/esm/vs/…`; Monaco's exports map them to `./esm/vs/*.js`.
const monacoDeepImports = { find: /^monaco-editor\/esm\/vs\/(.*?)(\.js)?$/, replacement: `${resolve(__dirname, 'node_modules/monaco-editor/esm/vs')}/$1.js` }

// Release builds bake in where Mindeck Cloud lives (see electron/main/services/cloud/config.ts)
// and the SHA-256 of the Remote-SSH / Dev Containers server packages built with them
// (electron/main/services/remote/bundle.ts).
const cloud = {
  __MINDECK_CLOUD_URL__: JSON.stringify(process.env.MINDECK_CLOUD_URL ?? ''),
  __MINDECK_CLOUD_KEY__: cloudKeyDefine(),
  ...remoteBundleDefines()
}

/**
 * index.html allows no inline scripts. Only the dev server needs one — React
 * Fast Refresh's preamble — so only `serve` loosens the policy, never a build.
 */
const devCsp: Plugin = {
  name: 'mindeck-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
}

export default defineConfig({
  main: {
    resolve: { alias: shared },
    define: cloud,
    build: {
      // Keep npm dependencies (e.g. systeminformation) external — required from
      // node_modules at runtime instead of bundled (they use dynamic requires).
      // ESM-only packages are bundled: the CommonJS main bundle can't require() them.
      externalizeDeps: { exclude: ['@agentclientprotocol/sdk'] },
      outDir: 'out/main',
      // object entry => deterministic `index` output name (matches package.json "main").
      // nodeHost: the entry of the utility processes Node programs run in (lib/nodeProcess.ts).
      lib: { entry: { index: resolve(__dirname, 'electron/main.ts'), nodeHost: resolve(__dirname, 'electron/nodeHost.ts') } }
    }
  },
  preload: {
    resolve: { alias: shared },
    build: {
      externalizeDeps: true,
      outDir: 'out/preload',
      // browserPage: the browser tabs' own preload (session.ts), apart from Mindeck's bridge.
      lib: { entry: { index: resolve(__dirname, 'electron/preload.ts'), browserPage: resolve(__dirname, 'electron/browserPage.ts') } }
    }
  },
  renderer: {
    root: '.',
    resolve: {
      // Its "browser" build is a UMD bundle without named exports: the ESM one.
      alias: [monacoDeepImports, { find: /^monaco-vim$/, replacement: resolve(__dirname, 'node_modules/monaco-vim/dist/index.mjs') }, { find: '@', replacement: resolve(__dirname, 'src') }, { find: '@shared', replacement: shared['@shared'] }]
    },
    optimizeDeps: {
      exclude: ['monaco-vim'],
      // monaco-vim stays out of the pre-bundle, so the dev server would find its Monaco imports only
      // when the editor first loads — then bundle again and reload the window mid-session (it looks
      // like a crash). Bundled at start instead, in the same pass as monaco-editor (one copy of it).
      include: ['monaco-editor/esm/vs/editor/editor.api', 'monaco-editor/esm/vs/editor/common/commands/shiftCommand']
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'index.html')
      }
    },
    plugins: [react(), devCsp]
  }
})
