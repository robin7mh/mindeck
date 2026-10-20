import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { startAppearance } from './lib/theme'
import { AppBoundary, installErrorReporting } from './components/shell/ErrorBoundary'
// The fonts and the terminal's stylesheet come straight from their packages:
// Vite bundles them with their font files (through Tailwind their URLs stay unresolved).
import '@fontsource-variable/inter'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import '@xterm/xterm/css/xterm.css'
import './index.css'

// Before the first paint, so the window never flashes the wrong theme.
startAppearance()
// Uncaught errors in the UI end up in the desktop app's log.
installErrorReporting()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AppBoundary>
      <App />
    </AppBoundary>
  </React.StrictMode>
)
