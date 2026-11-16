import Module, { createRequire } from 'node:module'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { runInThisContext } from 'node:vm'

/** The utility process's end of its channel to the main process (Electron's `process.parentPort`). */
export interface ParentPort {
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown
}

/**
 * Inside a utility process (lib/nodeProcess.ts): runs what `node <args…>`
 * would — a script with its arguments, or `-e <code>`. A utility process has
 * no stdin, so what the main process writes arrives as messages (null: the
 * end) and the program reads it as `process.stdin`, as tsserver and the
 * debug adapters do.
 */
export function runNode(port: ParentPort, args: string[], proc: NodeJS.Process = process, runMain: (file: string) => void = Module.runMain): void {
  const input = new PassThrough()
  Object.defineProperty(proc, 'stdin', { configurable: true, enumerable: true, get: () => input })
  port.on('message', ({ data }) => (data === null ? input.end() : input.write(Buffer.from(data as string | Uint8Array))))
  const [first, ...rest] = args
  if (first === '-e') {
    // As `node -e`: CommonJS, modules resolved from the working folder.
    const [code, ...extra] = rest
    const filename = join(proc.cwd(), '[eval]')
    proc.argv = [proc.execPath, ...extra]
    const module = { exports: {} }
    runInThisContext(Module.wrap(code), { filename })(module.exports, createRequire(filename), module, filename, proc.cwd())
    return
  }
  proc.argv = [proc.execPath, first, ...rest]
  runMain(first)
}
