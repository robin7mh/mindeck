import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { manualUpdateFile, UpdateService, type Updater } from '../../../electron/main/services/update/UpdateService'

class FakeUpdater extends EventEmitter implements Updater {
  autoDownload = false
  autoInstallOnAppQuit = false
  checkForUpdates = vi.fn(async (): Promise<unknown> => undefined)
  quitAndInstall = vi.fn()
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup(updater: FakeUpdater | null = new FakeUpdater()) {
  const onStatus = vi.fn()
  const svc = new UpdateService({ updater, currentVersion: '0.1.0', onStatus })
  return { svc, updater: updater!, onStatus }
}

describe('UpdateService', () => {
  it('a .deb only checks and offers the new version’s download', async () => {
    const updater = new FakeUpdater()
    const onStatus = vi.fn()
    const svc = new UpdateService({ updater, currentVersion: '0.1.0', onStatus, manualDownload: 'Mindeck.deb' })
    svc.start()
    expect([updater.autoDownload, updater.autoInstallOnAppQuit]).toEqual([false, false])
    updater.emit('update-available', { version: '0.2.0' })
    expect(svc.status()).toEqual({
      state: 'available',
      version: '0.2.0',
      downloadUrl: 'https://github.com/robin7mh/mindeck/releases/download/v0.2.0/Mindeck.deb',
      currentVersion: '0.1.0'
    })
    expect(() => svc.install()).toThrow(expect.objectContaining({ code: 'no-update' }))
    await svc.check() // checking again is fine
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    svc.dispose()
  })

  it('which installs download updates by hand: Linux .deb packages', () => {
    const marker = (type: string) => (file: string) => {
      expect(file).toBe('/res/package-type')
      return `${type}\n`
    }
    expect(manualUpdateFile('linux', 'x64', '/res', {}, marker('deb'))).toBe('Mindeck.deb')
    expect(manualUpdateFile('linux', 'arm64', '/res', {}, marker('deb'))).toBe('Mindeck-arm64.deb')
    expect(manualUpdateFile('linux', 'x64', '/res', {}, marker('rpm'))).toBeUndefined()
    expect(manualUpdateFile('linux', 'x64', '/res', { APPIMAGE: '/a/Mindeck.AppImage' }, marker('deb'))).toBeUndefined()
    expect(manualUpdateFile('darwin', 'arm64', '/res', {}, marker('deb'))).toBeUndefined()
    // Not packaged: no marker file.
    expect(manualUpdateFile('linux', 'x64', '/definitely/not/here')).toBeUndefined()
  })

  it('does nothing without an updater (dev runs)', async () => {
    const { svc, onStatus } = setup(null)
    svc.start()
    expect(svc.status()).toEqual({ state: 'disabled', currentVersion: '0.1.0' })
    expect(await svc.check()).toEqual({ state: 'disabled', currentVersion: '0.1.0' })
    expect(() => svc.install()).toThrow(expect.objectContaining({ code: 'no-update' }))
    expect(onStatus).not.toHaveBeenCalled()
    svc.dispose()
  })

  it('checks shortly after start and then every 4 hours, downloading in the background', async () => {
    const { svc, updater, onStatus } = setup()
    svc.start()
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(svc.status().state).toBe('idle')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4 * 3_600_000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    svc.dispose()
    await vi.advanceTimersByTimeAsync(4 * 3_600_000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(onStatus).not.toHaveBeenCalled()
  })

  it('follows the updater from check to ready, then restarts into the new version', async () => {
    const { svc, updater, onStatus } = setup()
    svc.start()
    updater.emit('checking-for-update')
    expect(svc.status()).toEqual({ state: 'checking', currentVersion: '0.1.0' })
    updater.emit('update-not-available')
    expect(svc.status().state).toBe('idle')
    updater.emit('update-available', { version: '0.2.0' })
    expect(svc.status()).toEqual({ state: 'downloading', version: '0.2.0', progress: 0, currentVersion: '0.1.0' })
    updater.emit('download-progress', { percent: 41.6 })
    expect(svc.status()).toMatchObject({ state: 'downloading', version: '0.2.0', progress: 42 })
    expect(await svc.check()).toMatchObject({ state: 'downloading' }) // no re-check mid-download
    expect(() => svc.install()).toThrow('No update is ready')
    updater.emit('update-downloaded', { version: '0.2.0' })
    expect(svc.status()).toEqual({ state: 'ready', version: '0.2.0', currentVersion: '0.1.0' })
    expect(await svc.check()).toMatchObject({ state: 'ready' })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    svc.install()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'ready' }))
    svc.dispose()
  })

  it('reports failures from events and from checking', async () => {
    const { svc, updater } = setup()
    svc.start()
    updater.emit('error', new Error('feed down'))
    expect(svc.status()).toEqual({ state: 'error', error: 'feed down', currentVersion: '0.1.0' })
    updater.checkForUpdates.mockRejectedValueOnce(new Error('offline'))
    expect(await svc.check()).toEqual({ state: 'error', error: 'offline', currentVersion: '0.1.0' })
    expect(await svc.check()).toMatchObject({ state: 'error' }) // an error may be retried
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    svc.dispose()
  })
})
