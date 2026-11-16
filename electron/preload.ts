import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS, type IpcChannel, type IpcEvent } from '@shared/ipc/contract'

const channelAllowlist = new Set<string>(IPC_CHANNELS)
const eventAllowlist = new Set<string>(IPC_EVENTS)

/**
 * The single bridge between renderer and main. Window controls are exposed as
 * named methods; all typed domain IPC (projects, and later system/terminal/…)
 * goes through the allowlisted `invoke` — the renderer never touches ipcRenderer
 * directly, and only channels declared in the shared contract can be called.
 */
const api = {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
  onMaximizedChange: (cb: (isMax: boolean) => void): (() => void) => {
    const listener = (_: unknown, isMax: boolean) => cb(isMax)
    ipcRenderer.on('window:maximized-changed', listener)
    return () => {
      ipcRenderer.removeListener('window:maximized-changed', listener)
    }
  },
  toggleFullScreen: () => ipcRenderer.send('window:toggle-fullscreen'),
  isFullScreen: (): Promise<boolean> => ipcRenderer.invoke('window:is-fullscreen'),
  onFullScreenChange: (cb: (isFull: boolean) => void): (() => void) => {
    const listener = (_: unknown, isFull: boolean) => cb(isFull)
    ipcRenderer.on('window:fullscreen-changed', listener)
    return () => {
      ipcRenderer.removeListener('window:fullscreen-changed', listener)
    }
  },
  platform: process.platform,

  /** Files dragged out of Mindeck into Finder / Explorer / other apps (the OS drag, with the file's icon). */
  startDrag: (paths: string[]) => ipcRenderer.send('files:start-drag', paths),
  /** The path of a file dropped in from the OS (Electron no longer puts it on `File`). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  /** Typed domain IPC. Channel is validated against the shared allowlist. */
  invoke: (channel: IpcChannel, payload?: unknown): Promise<unknown> => {
    if (!channelAllowlist.has(channel)) {
      return Promise.reject(new Error(`Blocked IPC channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, payload)
  },

  /** Subscribe to a main→renderer push event. Returns an unsubscribe fn. */
  on: (channel: IpcEvent, cb: (payload: unknown) => void): (() => void) => {
    if (!eventAllowlist.has(channel)) {
      throw new Error(`Blocked IPC event: ${channel}`)
    }
    const listener = (_: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

export type MindeckApi = typeof api

contextBridge.exposeInMainWorld('mindeck', api)
