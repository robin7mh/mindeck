import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc/contract'
import type { Router } from './router'

/**
 * Binds every contract channel to the desktop window's IPC. Validation,
 * access rules and error wrapping all live in the Router — the same code path
 * the network API uses. Only Mindeck's own page may call (`trusted` checks
 * the calling frame's address): a web page that somehow got into a frame
 * gets nothing.
 */
export function bindIpc(router: Router, trusted: (frameUrl: string) => boolean = () => true): void {
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, (event, req) =>
      trusted(event.senderFrame?.url ?? '')
        ? router.dispatch(channel, req, { transport: 'ipc' })
        : { ok: false, error: { code: 'forbidden', message: 'Only the Mindeck window may call the core' } }
    )
  }
}
