import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { basename, dirname, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { shellCommand, shellEnv, shellQuote } from '../terminal/TerminalService'
import { shellArgs } from '../../lib/shellArgs'
import { spawnProgram } from '../../lib/executables'
import { spawnNode, type NodeLauncher, type NodeProcess } from '../../lib/nodeProcess'
import { pythonFor } from '../tools/catalog'
import { userEnv } from '../tools/ToolsService'
import type { DapLaunch, DapTransport } from './Dap'

/**
 * Start a program like the user's terminal would (their PATH), with extra
 * environment. Windows: directly, without PowerShell (batch launchers like
 * the Kotlin adapter's through cmd.exe).
 */
export function spawnInShell(command: string, args: string[], cwd: string, env: Record<string, string> = {}, platform: NodeJS.Platform = process.platform): ChildProcess {
  if (platform === 'win32') return spawnProgram(command, args, { cwd, env: { ...shellEnv(), ...env }, stdio: ['pipe', 'pipe', 'pipe'] }, platform)
  const { file } = shellCommand()
  const line = [command, ...args].map(shellQuote).join(' ')
  return spawn(file, shellArgs(line), {
    cwd,
    env: { ...shellEnv(), ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

export function stdioTransport(proc: Pick<NodeProcess, 'stdin' | 'stdout' | 'on' | 'kill'>): DapTransport {
  return {
    write: (data) => void proc.stdin!.write(data),
    onData: (fn) => void proc.stdout!.on('data', fn),
    onClose: (fn) => void proc.on('exit', fn),
    close: () => void proc.kill()
  }
}

export function socketTransport(socket: Socket): DapTransport {
  return {
    write: (data) => void socket.write(data),
    onData: (fn) => void socket.on('data', fn),
    onClose: (fn) => void socket.on('close', fn),
    close: () => void socket.destroy()
  }
}

export interface AdapterContext {
  root: string
  /** The program, absolute. */
  program: string
  args: string[]
  /** Where the language's debugger is (from Settings → Languages). */
  debugger: string
  /** Output the adapter's process prints that isn't protocol (Delve: the program's own output). */
  output: (stream: 'stdout' | 'stderr', text: string) => void
  /** A command of the language's server (jdtls starts Java debug sessions). */
  command?: (command: string, args: unknown[]) => Promise<unknown>
  /** Python: run this module (pytest) rather than the program file. */
  module?: string
  /** Go: run the package's tests. */
  goTest?: boolean
  /** How a debug adapter written in JavaScript runs as a Node program (Platform.node). */
  node?: NodeLauncher
}

export type Spawn = (command: string, args: string[], cwd: string, env?: Record<string, string>) => ChildProcess

/** Languages debugged through a debug adapter (Node runs on its own inspector). */
export const DAP_LANGUAGES = ['python', 'go', 'cpp', 'rust', 'swift', 'php', 'java', 'kotlin']
/** Compiled to a program first, then run under LLDB — with any built program Mindeck has no language for ('native'). */
export const NATIVE_LANGUAGES = ['cpp', 'rust', 'swift', 'native']

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function connectTo(port: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => resolve(s))
    s.on('error', reject)
  })
}

/** Kotlin's JVM class of a file: its package plus `<File>Kt`. */
export async function kotlinMainClass(file: string): Promise<string> {
  const text = await readFile(file, 'utf8')
  const pkg = /^\s*package\s+([\w.]+)/m.exec(text)?.[1]
  const name = basename(file, extname(file))
  const cls = `${name.charAt(0).toUpperCase()}${name.slice(1)}Kt`
  return pkg ? `${pkg}.${cls}` : cls
}

/** Arguments as one command line (java-debug takes a string). */
const argLine = (args: string[]) => args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')

/** Start the language's debug adapter and say how to launch the program with it. */
export async function startAdapter(language: string, ctx: AdapterContext, run: Spawn = spawnInShell): Promise<{ transport: DapTransport; launch: DapLaunch }> {
  if (language === 'python') {
    // debugpy lives in Mindeck's tools folder; the project's virtualenv runs the program.
    const python = pythonFor(ctx.root)
    const proc = run(python, ['-m', 'debugpy.adapter'], ctx.root, { PYTHONPATH: ctx.debugger })
    return {
      transport: stdioTransport(proc),
      launch: {
        adapterID: 'debugpy',
        kill: () => void proc.kill(),
        arguments: {
          type: 'python',
          request: 'launch',
          name: 'Mindeck',
          ...(ctx.module ? { module: ctx.module } : { program: ctx.program }),
          args: ctx.args,
          cwd: ctx.root,
          python: [python],
          console: 'internalConsole',
          justMyCode: true,
          redirectOutput: true
        }
      }
    }
  }
  if (NATIVE_LANGUAGES.includes(language)) {
    // lldb-dap speaks DAP on stdio; the built program runs under it.
    const proc = run(ctx.debugger, [], ctx.root)
    proc.stderr!.on('data', (d: Buffer) => ctx.output('stderr', d.toString()))
    return {
      transport: stdioTransport(proc),
      launch: { adapterID: 'lldb-dap', kill: () => void proc.kill(), arguments: { name: 'Mindeck', program: ctx.program, args: ctx.args, cwd: ctx.root } }
    }
  }
  if (language === 'php') {
    // Xdebug's adapter is JavaScript: Mindeck runs it as a Node program. It starts php (the user's PATH) with Xdebug pointed at its port.
    const proc = (ctx.node ?? spawnNode)([ctx.debugger], { cwd: ctx.root, env: await userEnv(), name: 'PHP Debug' })
    return {
      transport: stdioTransport(proc),
      launch: {
        adapterID: 'php',
        kill: () => void proc.kill(),
        arguments: {
          type: 'php',
          request: 'launch',
          name: 'Mindeck',
          program: ctx.program,
          args: ctx.args,
          cwd: ctx.root,
          port: 0,
          runtimeExecutable: 'php',
          runtimeArgs: ['-dxdebug.mode=debug', '-dxdebug.start_with_request=yes', '-dxdebug.client_port=${port}']
        }
      }
    }
  }
  if (language === 'java') {
    // jdtls (with the debug plugin) finds the main class and classpath, then opens a DAP port.
    const command = ctx.command!
    const mains = ((await command('vscode.java.resolveMainClass', [pathToFileURL(ctx.root).href])) ?? []) as { mainClass: string; projectName?: string; filePath?: string }[]
    const main = mains.find((m) => m.filePath === ctx.program) ?? mains[0]
    if (!main) throw coded('debug-program', 'No class with a main method found — is the project imported by the Java language server?')
    const [modulePaths, classPaths] = (await command('vscode.java.resolveClasspath', [main.mainClass, main.projectName])) as [string[], string[]]
    const port = (await command('vscode.java.startDebugSession', [])) as number
    const socket = await connectTo(port)
    return {
      transport: socketTransport(socket),
      launch: {
        adapterID: 'java',
        kill: () => void socket.destroy(),
        arguments: { type: 'java', request: 'launch', name: 'Mindeck', mainClass: main.mainClass, projectName: main.projectName, modulePaths, classPaths, args: argLine(ctx.args), cwd: ctx.root, console: 'internalConsole' }
      }
    }
  }
  if (language === 'kotlin') {
    // The Kotlin debug adapter runs a Gradle / Maven project's compiled classes.
    const proc = run(ctx.debugger, [], ctx.root)
    return {
      transport: stdioTransport(proc),
      launch: { adapterID: 'kotlin', kill: () => void proc.kill(), arguments: { type: 'kotlin', request: 'launch', name: 'Mindeck', projectRoot: ctx.root, mainClass: await kotlinMainClass(ctx.program) } }
    }
  }
  // Go: Delve's DAP server on a local port; its stdout carries the program's output.
  const proc = run(ctx.debugger, ['dap', '--listen=127.0.0.1:0'], ctx.root)
  const port = await new Promise<number>((resolve, reject) => {
    let listening = false
    proc.stdout!.on('data', (d: Buffer) => {
      const text = d.toString()
      const match = /listening at:? *\[?[\d.:a-f]*?\]?:?(\d+)\s*$/im.exec(text)
      if (!listening && match) {
        listening = true
        return resolve(Number(match[1]))
      }
      if (listening) ctx.output('stdout', text)
    })
    proc.stderr!.on('data', (d: Buffer) => ctx.output('stderr', d.toString()))
    proc.on('exit', () => !listening && reject(Object.assign(new Error('Delve did not start'), { code: 'debug' })))
    proc.on('error', reject)
  })
  const socket = await connectTo(port)
  return {
    transport: socketTransport(socket),
    launch: {
      adapterID: 'go',
      kill: () => void proc.kill(),
      arguments: { request: 'launch', mode: ctx.goTest ? 'test' : 'debug', program: dirname(ctx.program), args: ctx.args, cwd: ctx.root }
    }
  }
}
