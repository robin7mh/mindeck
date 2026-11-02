import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { shellCommand, shellEnv, shellQuote } from '../terminal/TerminalService'
import { shellArgs } from '../../lib/shellArgs'
import { psQuote } from '../../lib/executables'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Runs a command line in the user's login shell; stderr (and stdout unless quiet) streams out. */
export type BuildRunner = (
  line: string,
  cwd: string,
  opts: { output: (stream: 'stdout' | 'stderr', text: string) => void; quiet?: boolean; signal: AbortSignal }
) => Promise<{ code: number; stdout: string }>

export const shellBuild: BuildRunner = (line, cwd, { output, quiet, signal }) =>
  new Promise((resolve) => {
    const proc = spawn(shellCommand().file, shellArgs(line, process.platform, false), { cwd, env: shellEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    const out: string[] = []
    const abort = () => proc.kill()
    signal.addEventListener('abort', abort)
    proc.stdout.on('data', (d: Buffer) => {
      out.push(d.toString())
      if (!quiet) output('stdout', d.toString())
    })
    proc.stderr.on('data', (d: Buffer) => output('stderr', d.toString()))
    proc.on('error', (err) => {
      output('stderr', `${err.message}\n`)
      resolve({ code: 127, stdout: '' })
    })
    proc.on('close', (code) => {
      signal.removeEventListener('abort', abort)
      resolve({ code: code ?? 1, stdout: out.join('') })
    })
  })

export interface BuildContext {
  root: string
  /** The chosen program (absolute): a source file or a built binary. */
  program: string
  language: string
  /** The user's own build step (make, cmake --build …), run first. */
  command?: string
  output: (stream: 'stdout' | 'stderr' | 'info', text: string) => void
  signal: AbortSignal
  /** Where it builds (default: this machine's platform). */
  platform?: NodeJS.Platform
}

const HEADERS = ['.h', '.hh', '.hpp', '.hxx']
const C_LIKE = ['.c', '.m']

/** The nearest Cargo.toml from the file's folder up to the project. */
function cargoDir(root: string, file: string): string | undefined {
  for (let dir = dirname(file); dir.startsWith(root); dir = dirname(dir)) {
    if (existsSync(join(dir, 'Cargo.toml'))) return dir
    if (dir === root) break
  }
  return undefined
}

/**
 * What runs under the debugger: the user's build step first (when set),
 * then a single C / C++ / Objective-C / Swift file compiled with debug
 * info, a Rust crate built with cargo — or the program as chosen.
 */
export async function buildProgram(ctx: BuildContext, run: BuildRunner = shellBuild): Promise<string> {
  const step = async (line: string, cwd = ctx.root, quiet = false) => {
    ctx.output('info', `$ ${line}\n`)
    const result = await run(line, cwd, { output: ctx.output, quiet, signal: ctx.signal })
    if (result.code !== 0) throw coded('build-failed', `Build failed: ${line} (exit ${result.code})`)
    return result.stdout
  }
  if (ctx.command) await step(ctx.command)

  const ext = extname(ctx.program).toLowerCase()
  // Windows: programs end in .exe, and the build line runs in PowerShell (its own quoting).
  const win = (ctx.platform ?? process.platform) === 'win32'
  const out = join(ctx.root, '.mindeck', 'build', basename(ctx.program, extname(ctx.program))) + (win ? '.exe' : '')
  const q = win ? psQuote : shellQuote
  if (ctx.language === 'cpp') {
    if (HEADERS.includes(ext)) throw coded('debug-program', 'A header file does not run — choose a source file (.c, .cpp, …) or a built program')
    await mkdir(dirname(out), { recursive: true })
    const compiler = C_LIKE.includes(ext) ? 'clang' : 'clang++'
    const frameworks = ext === '.m' || ext === '.mm' ? ' -framework Foundation' : ''
    await step(`${compiler} -g -O0 ${q(ctx.program)} -o ${q(out)}${frameworks}`)
    return out
  }
  if (ctx.language === 'swift') {
    await mkdir(dirname(out), { recursive: true })
    await step(`swiftc -g -Onone ${q(ctx.program)} -o ${q(out)}`)
    return out
  }
  if (ctx.language === 'rust') {
    const crate = cargoDir(ctx.root, ctx.program)
    if (!crate) {
      await mkdir(dirname(out), { recursive: true })
      await step(`rustc -g ${q(ctx.program)} -o ${q(out)}`)
      return out
    }
    // cargo's JSON lines name the executables it built; diagnostics still read like cargo's.
    const json = await step('cargo build --message-format=json-render-diagnostics', crate, true)
    const built = json
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as { reason?: string; executable?: string | null })
      .filter((m) => m.reason === 'compiler-artifact' && m.executable)
    if (!built.length) throw coded('debug-program', 'cargo built no program (is it a library?)')
    return built.at(-1)!.executable!
  }
  return ctx.program
}
