import { mkdir } from 'node:fs/promises'
import type { DesktopStatus } from '@shared/types/desktop'
import type { Router } from './router'
import type { SettingsService } from '../main/services/settings/SettingsService'
import { diagnosticsReport, type DiagnosticsInfo } from '../main/lib/diagnostics'
import { rendererErrors, type Logger } from '../main/lib/log'

export interface DesktopIpcDeps {
  logger: Logger
  settings: Pick<SettingsService, 'get' | 'update'>
  /** Stored secrets are encrypted by the OS keychain (see secretsProtected). */
  secretsEncrypted: boolean
  /** Opens a folder in the OS file manager; resolves to an error message, or '' (shell.openPath). */
  openPath(path: string): Promise<string>
  /** The facts for "Copy diagnostics", gathered by the desktop app. */
  diagnostics(): Omit<DiagnosticsInfo, 'logsDir' | 'secretsEncrypted'>
}

/** Binds the desktop:* channels: logs, diagnostics, closing the window, the keychain warning. */
export function registerDesktopIpc(router: Router, deps: DesktopIpcDeps): void {
  const { logger } = deps
  const status = (): DesktopStatus => ({
    platform: process.platform,
    logsDir: logger.dir,
    secretsEncrypted: deps.secretsEncrypted,
    closeBehavior: deps.settings.get().closeBehavior ?? 'ask'
  })
  const report = rendererErrors(logger)
  router.register('desktop:status', () => status())
  router.register('desktop:configure', async ({ closeBehavior }) => {
    await deps.settings.update({ closeBehavior })
    return status()
  })
  router.register('desktop:openLogs', async () => {
    await mkdir(logger.dir, { recursive: true })
    const err = await deps.openPath(logger.dir)
    if (err) throw Object.assign(new Error(err), { code: 'open-failed' })
  })
  router.register('desktop:diagnostics', () =>
    diagnosticsReport({ ...deps.diagnostics(), logsDir: logger.dir, secretsEncrypted: deps.secretsEncrypted }, logger.recent())
  )
  router.register('desktop:reportError', (r) => report(r))
}
