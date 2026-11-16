import { vi } from 'vitest'

// xterm.js and its addons as fakes (jsdom has no canvas, WebGL or layout).
// Tests mock the modules with these and drive the fakes through `xt`:
//   vi.mock('@xterm/xterm', async () => (await import('./xtermFake')).xtermModule)

type Listener<T> = (v: T) => void

/** One row of the fake buffer: text, and whether it continues the row above. */
interface Row {
  text: string
  wrapped?: boolean
}

export interface FakeMarker {
  line: number
  isDisposed: boolean
  dispose: () => void
}

export interface FakeDecoration {
  marker: FakeMarker
  disposed: boolean
  el: HTMLElement
  dispose: () => void
}

export const xt = {
  terms: [] as FakeTerminal[],
  fits: [] as { fit: ReturnType<typeof vi.fn> }[],
  links: [] as ((e: unknown, uri: string) => void)[],
  searches: [] as FakeSearch[],
  webgls: [] as FakeWebgl[],
  fitThrows: false,
  webglThrows: false,
  /** What the serialize addon returns (default: everything written). */
  serialized: undefined as string | undefined,
  reset() {
    xt.terms.length = 0
    xt.fits.length = 0
    xt.links.length = 0
    xt.searches.length = 0
    xt.webgls.length = 0
    xt.fitThrows = false
    xt.webglThrows = false
    xt.serialized = undefined
  }
}

export class FakeTerminal {
  options: Record<string, unknown>
  written: string[] = []
  focus = vi.fn()
  clear = vi.fn()
  selectAll = vi.fn()
  clearSelection = vi.fn()
  paste = vi.fn()
  scrollToLine = vi.fn((line: number) => (this.buffer.active.viewportY = line))
  scrollToTop = vi.fn(() => (this.buffer.active.viewportY = 0))
  scrollToBottom = vi.fn(() => (this.buffer.active.viewportY = this.buffer.active.baseY))
  disposed = false
  addons: unknown[] = []
  unicode = { activeVersion: '6' }
  selection = ''
  /** The rows of the buffer, the screen's height and where the cursor is. */
  lines: Row[] = []
  rows = 24
  cursor = { x: 0, y: 0 }
  markers: FakeMarker[] = []
  decorations: FakeDecoration[] = []
  linkProviders: { provideLinks: (y: number, cb: (links: unknown) => void) => void }[] = []
  keyHandler: (e: KeyboardEvent) => boolean = () => true
  private oscHandlers = new Map<number, (data: string) => boolean>()
  private dataCb: Listener<string> = () => {}
  private resizeCb: Listener<{ cols: number; rows: number }> = () => {}
  private selectionCb: () => void = () => {}

  buffer = {
    active: {
      viewportY: 0,
      baseY: 0,
      cursorX: 0,
      getLine: (y: number) => {
        const row = this.lines[y]
        if (!row) return undefined
        // a wide character (fullwidth, emoji) takes two cells: the second one has width 0
        const cells = [...row.text].flatMap((ch) => (/[ᄀ-￿]|\p{Extended_Pictographic}/u.test(ch) ? [{ ch, w: 2 }, { ch: '', w: 0 }] : [{ ch, w: 1 }]))
        return {
          isWrapped: !!row.wrapped,
          length: cells.length,
          getCell: (x: number) => ({ getChars: () => cells[x].ch, getWidth: () => cells[x].w }),
          translateToString: (trim?: boolean, start = 0, end?: number) => {
            const s = row.text.slice(start, end)
            return trim ? s.replace(/\s+$/, '') : s
          }
        }
      }
    }
  }

  parser = {
    registerOscHandler: (ident: number, cb: (data: string) => boolean) => {
      this.oscHandlers.set(ident, cb)
      return { dispose: () => this.oscHandlers.delete(ident) }
    }
  }

  constructor(opts: Record<string, unknown>) {
    this.options = { ...opts }
    Object.defineProperty(this.buffer.active, 'cursorX', { get: () => this.cursor.x })
    xt.terms.push(this)
  }

  loadAddon(addon: { activate?: (t: FakeTerminal) => void }) {
    this.addons.push(addon)
    addon.activate?.(this)
  }
  open() {}
  write(d: string) {
    this.written.push(d)
  }
  onData(cb: Listener<string>) {
    this.dataCb = cb
    return { dispose: vi.fn() }
  }
  onResize(cb: Listener<{ cols: number; rows: number }>) {
    this.resizeCb = cb
    return { dispose: vi.fn() }
  }
  onSelectionChange(cb: () => void) {
    this.selectionCb = cb
    return { dispose: vi.fn() }
  }
  hasSelection() {
    return this.selection !== ''
  }
  getSelection() {
    return this.selection
  }
  attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) {
    this.keyHandler = fn
  }
  registerLinkProvider(p: FakeTerminal['linkProviders'][number]) {
    this.linkProviders.push(p)
    return { dispose: () => this.linkProviders.splice(this.linkProviders.indexOf(p), 1) }
  }
  registerMarker(offset = 0): FakeMarker | undefined {
    if (this.noMarkers) return undefined
    const marker: FakeMarker = { line: this.cursor.y + offset, isDisposed: false, dispose: () => (marker.isDisposed = true) }
    this.markers.push(marker)
    return marker
  }
  /** Markers can't be placed (xterm returns none for a disposed buffer). */
  noMarkers = false
  noDecorations = false
  registerDecoration({ marker }: { marker: FakeMarker }) {
    if (this.noDecorations) return undefined
    const el = document.createElement('div')
    const deco: FakeDecoration = { marker, disposed: false, el, dispose: () => (deco.disposed = true) }
    this.decorations.push(deco)
    return { ...deco, dispose: deco.dispose, onRender: (cb: (el: HTMLElement) => void) => cb(el) }
  }
  dispose() {
    this.disposed = true
  }

  // --- test drivers ---
  type(d: string) {
    this.dataCb(d)
  }
  resize(cols: number, rows: number) {
    this.resizeCb({ cols, rows })
  }
  select(text: string) {
    this.selection = text
    this.selectionCb()
  }
  /** An OSC sequence as the parser would hand it over; whether a handler took it. */
  osc(ident: number, data: string) {
    return this.oscHandlers.get(ident)?.(data) ?? false
  }
  key(init: Partial<KeyboardEvent>) {
    const e = { type: 'keydown', key: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: vi.fn(), ...init } as unknown as KeyboardEvent
    return { handled: !this.keyHandler(e), e }
  }
}

export class FakeSearch {
  findNext = vi.fn(() => true)
  findPrevious = vi.fn(() => true)
  clearDecorations = vi.fn()
  private cb: Listener<{ resultIndex: number; resultCount: number }> = () => {}
  constructor() {
    xt.searches.push(this)
  }
  onDidChangeResults(cb: Listener<{ resultIndex: number; resultCount: number }>) {
    this.cb = cb
    return { dispose: vi.fn() }
  }
  results(resultIndex: number, resultCount: number) {
    this.cb({ resultIndex, resultCount })
  }
}

export class FakeWebgl {
  disposed = false
  private lost: () => void = () => {}
  constructor() {
    if (xt.webglThrows) throw new Error('no WebGL2')
    xt.webgls.push(this)
  }
  onContextLoss(cb: () => void) {
    this.lost = cb
    return { dispose: vi.fn() }
  }
  loseContext() {
    this.lost()
  }
  dispose() {
    this.disposed = true
  }
}

class FakeSerialize {
  private t?: FakeTerminal
  activate(t: FakeTerminal) {
    this.t = t
  }
  serialize = vi.fn(() => xt.serialized ?? this.t!.written.join(''))
}

export const xtermModule = { Terminal: FakeTerminal }
export const fitModule = {
  FitAddon: class {
    fit = vi.fn(() => {
      if (xt.fitThrows) throw new Error('not ready')
    })
    constructor() {
      xt.fits.push(this)
    }
  }
}
export const webLinksModule = {
  WebLinksAddon: class {
    constructor(cb: (e: unknown, uri: string) => void) {
      xt.links.push(cb)
    }
  }
}
export const searchModule = { SearchAddon: FakeSearch }
export const serializeModule = { SerializeAddon: FakeSerialize }
export const unicodeModule = { Unicode11Addon: class {} }
export const webglModule = { WebglAddon: FakeWebgl }
