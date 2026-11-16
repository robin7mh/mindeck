import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm'

/** One command the shell ran, located by markers that move with the buffer. */
export interface TrackedCommand {
  /** Where its prompt starts (OSC 133;A). */
  prompt: IMarker
  /** Where its output starts (133;C) — absent while the user is still typing. */
  output?: IMarker
  /** Where it ended (133;D) and the column the cursor was at. */
  end?: IMarker
  endCol?: number
  exitCode?: number
  mark?: IDecoration
}

/** Commands kept per view: the oldest are dropped (with their markers). */
const MAX_COMMANDS = 500

/**
 * Follows the command boundaries a shell with Mindeck's integration reports
 * (OSC 133): marks each finished command by its exit code at the margin, jumps
 * between prompts, and copies a command's output.
 */
export class CommandTracker implements IDisposable {
  readonly commands: TrackedCommand[] = []
  private readonly handler: IDisposable
  /** The prompt the last jump went to — the next jump goes on from there while it is on screen. */
  private current?: IMarker

  constructor(
    private readonly term: Terminal,
    /** Tooltip of a finished command's mark. */
    private readonly describe: (exitCode: number) => string
  ) {
    this.handler = term.parser.registerOscHandler(133, (data) => {
      this.report(data)
      return true
    })
  }

  private report(data: string): void {
    const [kind, arg] = data.split(';')
    const current = this.commands.at(-1)
    if (kind === 'A') {
      this.current = undefined
      const prompt = this.term.registerMarker(0)
      if (!prompt) return
      this.commands.push({ prompt })
      if (this.commands.length > MAX_COMMANDS) this.drop(this.commands.shift()!)
    } else if (kind === 'C' && current && !current.output) {
      current.output = this.term.registerMarker(0)
    } else if (kind === 'D' && current?.output && !current.end) {
      current.end = this.term.registerMarker(0)
      current.endCol = this.term.buffer.active.cursorX
      const code = Number.parseInt(arg ?? '', 10)
      current.exitCode = Number.isNaN(code) ? undefined : code
      this.decorate(current)
    }
  }

  /** A dot at the margin of the prompt line: green for success, red for an error. */
  private decorate(command: TrackedCommand): void {
    const mark = this.term.registerDecoration({ marker: command.prompt, width: 1, layer: 'top' })
    if (!mark) return
    command.mark = mark
    const failed = command.exitCode !== undefined && command.exitCode !== 0
    mark.onRender((el) => {
      el.classList.add('mindeck-command-mark', failed ? 'is-error' : 'is-ok')
      if (command.exitCode !== undefined) el.title = this.describe(command.exitCode)
    })
  }

  private drop(command: TrackedCommand): void {
    command.mark?.dispose()
    for (const m of [command.prompt, command.output, command.end]) m?.dispose()
  }

  /**
   * The line a jump starts from: the prompt jumped to last, while it is on
   * screen; else the view's top — at the bottom, the prompt being typed at.
   */
  private anchor(): number {
    const buffer = this.term.buffer.active
    const line = this.current?.line ?? -1
    if (line >= buffer.viewportY && line < buffer.viewportY + this.term.rows) return line
    const live = this.commands.at(-1)
    if (buffer.viewportY >= buffer.baseY && live && !live.output && live.prompt.line >= 0) return live.prompt.line
    return buffer.viewportY
  }

  private jump(target: TrackedCommand | undefined, edge: () => void): boolean {
    this.current = target?.prompt
    if (target) this.term.scrollToLine(target.prompt.line)
    else edge()
    return !!target
  }

  /** Scroll to the previous command's prompt (the top, if there is none). Whether there was one. */
  previous(): boolean {
    const from = this.anchor()
    return this.jump(
      [...this.commands].reverse().find((c) => c.prompt.line >= 0 && c.prompt.line < from),
      () => this.term.scrollToTop()
    )
  }

  /** Scroll to the next command's prompt (the bottom, if there is none). */
  next(): boolean {
    const from = this.anchor()
    return this.jump(
      this.commands.find((c) => c.prompt.line > from),
      () => this.term.scrollToBottom()
    )
  }

  /** The output of the last command that finished, as text (undefined: none, or scrolled away). */
  lastOutput(): string | undefined {
    const command = [...this.commands].reverse().find((c) => c.end)
    if (!command || command.output!.line < 0 || command.end!.line < 0) return undefined
    const buffer = this.term.buffer.active
    let text = ''
    for (let y = command.output!.line; y <= command.end!.line; y += 1) {
      const line = buffer.getLine(y)!
      // The end line holds what was printed before the end (no newline), then the next prompt.
      const part = y === command.end!.line ? line.translateToString(true, 0, command.endCol) : line.translateToString(true)
      text += (y > command.output!.line && !line.isWrapped ? '\n' : '') + part
    }
    return text.replace(/\s+$/, '')
  }

  dispose(): void {
    this.handler.dispose()
    this.commands.splice(0).forEach((c) => this.drop(c))
  }
}
