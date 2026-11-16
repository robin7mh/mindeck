import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './helpers'
import { buildProgram, shellBuild, type BuildRunner } from '../../../electron/main/services/debug/build'

/** A runner that records command lines and answers per line. */
function runner(answers: Record<string, { code?: number; stdout?: string }> = {}) {
  const calls: { line: string; cwd: string; quiet?: boolean }[] = []
  const run: BuildRunner = async (line, cwd, { output, quiet }) => {
    calls.push({ line, cwd, quiet })
    const hit = Object.entries(answers).find(([k]) => line.startsWith(k))?.[1] ?? {}
    output('stderr', `ran ${line.split(' ')[0]}\n`)
    return { code: hit.code ?? 0, stdout: hit.stdout ?? '' }
  }
  return { run, calls }
}

async function ctx(language: string, file: string, command?: string) {
  const root = await tempDir('mindeck-build-')
  const out: string[] = []
  return { root, out, ctx: { root, program: join(root, file), language, command, output: (s: string, t: string) => void out.push(`${s}:${t}`), signal: new AbortController().signal } }
}

describe('building what the debugger runs', () => {
  it('C, C++, Objective-C: one file compiled with debug info into .mindeck/build; headers do not run', async () => {
    for (const [file, line] of [
      ['src/main.c', 'clang -g -O0'],
      ['app.cpp', 'clang++ -g -O0'],
      ['tool.m', 'clang -g -O0'],
      ['view.mm', 'clang++ -g -O0']
    ]) {
      const t = await ctx('cpp', file)
      const r = runner()
      const built = await buildProgram(t.ctx, r.run)
      const name = file.split('/').pop()!.replace(/\.[^.]+$/, '')
      expect(built).toBe(join(t.root, '.mindeck', 'build', name))
      expect(r.calls[0].line).toBe(`${line} ${t.ctx.program} -o ${built}${/\.mm?$/.test(file) ? ' -framework Foundation' : ''}`)
      expect(r.calls[0].cwd).toBe(t.root)
      expect(t.out[0]).toBe(`info:$ ${r.calls[0].line}\n`)
    }
    const header = await ctx('cpp', 'a.h')
    await expect(buildProgram(header.ctx, runner().run)).rejects.toMatchObject({ code: 'debug-program' })
    const broken = await ctx('cpp', 'main.c')
    await expect(buildProgram(broken.ctx, runner({ clang: { code: 1 } }).run)).rejects.toMatchObject({ code: 'build-failed', message: expect.stringContaining('(exit 1)') })
  })

  it('the user’s build step runs first (and stops everything when it fails); a built program runs as it is', async () => {
    const t = await ctx('native', 'build/app', 'make all')
    const r = runner()
    expect(await buildProgram(t.ctx, r.run)).toBe(t.ctx.program)
    expect(r.calls.map((c) => c.line)).toEqual(['make all'])
    const failing = await ctx('cpp', 'main.c', 'make')
    const f = runner({ make: { code: 2 } })
    await expect(buildProgram(failing.ctx, f.run)).rejects.toMatchObject({ code: 'build-failed', message: 'Build failed: make (exit 2)' })
    expect(f.calls).toHaveLength(1)
    const python = await ctx('python', 'app.py')
    expect(await buildProgram(python.ctx)).toBe(python.ctx.program)
  })

  it('Windows: programs end in .exe, paths quoted for PowerShell', async () => {
    const t = await ctx('cpp', "it's.c")
    const r = runner()
    expect(await buildProgram({ ...t.ctx, platform: 'win32' }, r.run)).toBe(join(t.root, '.mindeck', 'build', "it's.exe"))
    expect(r.calls[0].line).toBe(`clang -g -O0 '${join(t.root, "it''s.c")}' -o '${join(t.root, '.mindeck', 'build', "it''s.exe")}'`)
  })

  it('Swift with swiftc; Rust with cargo (its JSON names the program) or rustc for a lone file', async () => {
    const swift = await ctx('swift', 'main.swift')
    const s = runner()
    expect(await buildProgram(swift.ctx, s.run)).toBe(join(swift.root, '.mindeck', 'build', 'main'))
    expect(s.calls[0].line).toMatch(/^swiftc -g -Onone /)

    const lone = await ctx('rust', 'hello.rs')
    const l = runner()
    expect(await buildProgram(lone.ctx, l.run)).toBe(join(lone.root, '.mindeck', 'build', 'hello'))
    expect(l.calls[0].line).toMatch(/^rustc -g /)

    const crate = await ctx('rust', 'app/src/main.rs')
    await mkdir(join(crate.root, 'app', 'src'), { recursive: true })
    await writeFile(join(crate.root, 'app', 'Cargo.toml'), '[package]\nname = "app"\n')
    const json = [
      '{"reason":"compiler-artifact","executable":null}',
      'Compiling app',
      '{"reason":"compiler-artifact","executable":"/x/target/debug/app"}',
      '{"reason":"build-finished","success":true}'
    ].join('\n')
    const c = runner({ cargo: { stdout: json } })
    expect(await buildProgram(crate.ctx, c.run)).toBe('/x/target/debug/app')
    expect(c.calls[0]).toEqual({ line: 'cargo build --message-format=json-render-diagnostics', cwd: join(crate.root, 'app'), quiet: true })
    await expect(buildProgram(crate.ctx, runner({ cargo: { stdout: '{"reason":"build-finished"}' } }).run)).rejects.toMatchObject({ code: 'debug-program' })

    // A Cargo.toml at the project root counts too.
    const top = await ctx('rust', 'src/main.rs')
    await writeFile(join(top.root, 'Cargo.toml'), '')
    const tr = runner({ cargo: { stdout: '{"reason":"compiler-artifact","executable":"/t/app"}' } })
    expect(await buildProgram(top.ctx, tr.run)).toBe('/t/app')
    expect(tr.calls[0].cwd).toBe(top.root)
  })

  it('the shell runner: output streams (stdout quiet on request), the exit code, stopping, a folder that isn’t there', async () => {
    const dir = await tempDir()
    const got: string[] = []
    const output = (s: string, t: string) => void got.push(`${s}:${t}`)
    const signal = new AbortController().signal
    expect(await shellBuild('echo out; echo err >&2; exit 3', dir, { output, signal })).toEqual({ code: 3, stdout: 'out\n' })
    expect(got.sort()).toEqual(['stderr:err\n', 'stdout:out\n'])
    got.length = 0
    expect(await shellBuild('echo quiet', dir, { output, quiet: true, signal })).toEqual({ code: 0, stdout: 'quiet\n' })
    expect(got).toEqual([])
    const stop = new AbortController()
    const slow = shellBuild('sleep 5', dir, { output, signal: stop.signal })
    setTimeout(() => stop.abort(), 100)
    expect((await slow).code).toBe(1)
    expect((await shellBuild('true', '/definitely/not/here', { output, signal })).code).toBe(127)
    expect(got.at(-1)).toMatch(/ENOENT/)
  }, 20_000)
})
