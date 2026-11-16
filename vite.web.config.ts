import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * index.html allows no inline scripts. Only the dev server needs one — React
 * Fast Refresh's preamble — so only `serve` loosens the policy, never a build.
 */
const devCsp: Plugin = {
  name: 'mindeck-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
}

// The renderer as a web app (no Electron): built into out/web and served by
// the Mindeck core (`npm run web`). In dev (`npm run web:dev`) Vite proxies the
// API to a core running on :7420 (`npm run server:build && npm run server`).
export default defineConfig({
  root: '.',
  base: './',
  resolve: {
    alias: [
      // monaco-vim's deep imports into Monaco (see electron.vite.config.ts).
      { find: /^monaco-editor\/esm\/vs\/(.*?)(\.js)?$/, replacement: `${resolve(__dirname, 'node_modules/monaco-editor/esm/vs')}/$1.js` },
      { find: /^monaco-vim$/, replacement: resolve(__dirname, 'node_modules/monaco-vim/dist/index.mjs') },
      { find: '@', replacement: resolve(__dirname, 'src') },
      { find: '@shared', replacement: resolve(__dirname, 'src/shared') }
    ]
  },
  optimizeDeps: { exclude: ['monaco-vim'] },
  plugins: [react(), devCsp],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:7420', ws: true }
    }
  },
  build: {
    outDir: 'out/web'
  }
})
