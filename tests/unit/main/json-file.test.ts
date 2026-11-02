import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'
import { corruptName, readJson, readJsonFile, readJsonOrThrow } from '../../../electron/main/lib/jsonFile'

const at = new Date('2026-10-15T09:30:00.000Z')

describe('readJsonFile', () => {
  it('names the backup after the file and the time, next to it', () => {
    expect(corruptName('/d/agents/abc.json', at)).toBe('/d/agents/abc.corrupt-2026-10-15T09-30-00-000Z.json')
    expect(corruptName('/d/state', at)).toBe('/d/state.corrupt-2026-10-15T09-30-00-000Z')
    expect(corruptName('/d/x.json')).toMatch(/x\.corrupt-\d{4}-.*Z\.json$/)
  })

  it('parses a good file and reports a missing one', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.json'), '{"v":1}')
    expect(await readJsonFile(join(dir, 'a.json'))).toEqual({ status: 'ok', value: { v: 1 } })
    expect(await readJsonFile(join(dir, 'none.json'))).toEqual({ status: 'missing' })
    expect(await readJson(join(dir, 'a.json'))).toEqual({ v: 1 })
    expect(await readJson(join(dir, 'none.json'))).toBeUndefined()
  })

  it('sets a damaged file aside and logs it, so the start goes on and nothing is overwritten', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = await tempDir()
    const file = join(dir, 'sessions.json')
    await writeFile(file, '{"sessions": [')
    const read = await readJsonFile(file, () => at)
    expect(read).toEqual({ status: 'damaged', backup: join(dir, 'sessions.corrupt-2026-10-15T09-30-00-000Z.json') })
    expect(await readdir(dir)).toEqual(['sessions.corrupt-2026-10-15T09-30-00-000Z.json'])
    expect(await readFile(join(dir, 'sessions.corrupt-2026-10-15T09-30-00-000Z.json'), 'utf8')).toBe('{"sessions": [')
    expect(warn.mock.calls[0][0]).toMatch(/sessions\.json is damaged .* set aside as /)
    // the plain reader just starts empty
    await writeFile(file, 'nope')
    expect(await readJson(file)).toBeUndefined()
  })

  it('survives a file it cannot read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = await tempDir()
    // a folder where the file should be: unreadable
    await mkdir(join(dir, 'folder.json'))
    expect(await readJsonFile(join(dir, 'folder.json'))).toEqual({ status: 'damaged' })
    expect(warn.mock.calls.at(-1)![0]).toMatch(/cannot read .*folder\.json/)
  })

  it('for a store that writes itself back whole: a file it cannot read throws instead of reading as empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = await tempDir()
    await writeFile(join(dir, 'a.json'), '{"v":1}')
    expect(await readJsonOrThrow(join(dir, 'a.json'))).toEqual({ v: 1 })
    expect(await readJsonOrThrow(join(dir, 'none.json'))).toBeUndefined()
    await writeFile(join(dir, 'bad.json'), '{')
    expect(await readJsonOrThrow(join(dir, 'bad.json'))).toBeUndefined() // damaged: set aside, as always
    expect((await readdir(dir)).some((f) => f.startsWith('bad.corrupt-'))).toBe(true)
    await mkdir(join(dir, 'folder.json'))
    await expect(readJsonOrThrow(join(dir, 'folder.json'))).rejects.toMatchObject({ code: 'EISDIR' })
    expect(warn.mock.calls.at(-1)![0]).toMatch(/cannot read .*folder\.json/)
  })

  it('reports a backup that could not be made', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = await tempDir()
    await writeFile(join(dir, 'x.json'), '{')
    // the backup name is taken by a non-empty folder: rename fails
    const target = corruptName(join(dir, 'x.json'), at)
    await mkdir(join(target, 'inside'), { recursive: true })
    expect(await readJsonFile(join(dir, 'x.json'), () => at)).toEqual({ status: 'damaged' })
    expect(warn.mock.calls.at(-1)![0]).toMatch(/could not be set aside/)
  })
})
