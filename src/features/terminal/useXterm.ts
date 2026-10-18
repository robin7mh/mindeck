import { useEffect, useRef, type RefObject } from 'react'
import { Terminal, type IDisposable } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { ipc, onEvent, onResync } from '@shared/ipc/client'
import type { TerminalData, TerminalSettings } from '@shared/types/terminal'
import { getT, intlLocale } from '@/lib/i18n'
import { openExternal } from '@/lib/links'
import { APPEARANCE_ATTRIBUTES } from '@/lib/theme'
import { cssRgb } from '@/lib/tokens'
import { CommandTracker } from './commands'
import { terminalAction } from './keys'
import { fileLinkProvider, type ProjectFile } from './links'
import { useTerminalSettings } from './settings'
import { scheduleSave, serializers } from './store'
import { themeFromTokens } from './theme'

export interface XtermHooks {
  /** The process ended; may return a line to print in the terminal. */
  onExit: (exitCode: number) => string | undefined
  /** Keys typed after the process ended (e.g. Enter → restart). */
  onInputAfterExit?: (data: string) => void
  /** ⌘F (Ctrl+Shift+F): the view opens its find bar. Without it the key goes to the program. */
  onFind?: () => void
  /** ⌘W (macOS): the view closes its tab. Without it the workspace closes the pane. */
  onClose?: () => void
  /** The shell's folder now — file references in the output resolve against it. Without it: no file links. */
  where?: () => { cwd: string; cwdLabel: string }
  /** A file reference was clicked. */
  onOpenFile?: (file: ProjectFile, line: number) => void
  /** Output of the last run, shown greyed above the new shell (read when the view mounts). */
  restored?: { scrollback: string; savedAt: string }
  /** A terminal tab: its output is saved for the next start (agents' terminals aren't). */
  persist?: boolean
}

export type FindOptions = Pick<ISearchOptions, 'regex' | 'caseSensitive'>

/** What a view offers its find bar, context menu and shortcuts. */
export interface XtermApi {
  /** Highlight every match and move to the next (or previous) one; whether there is one. */
  find: (query: string, opts: FindOptions, backwards?: boolean) => boolean
  clearFind: () => void
  /** Match count and which one is selected (-1: none / too many to count). */
  onFindResults: (cb: (r: { index: number; count: number }) => void) => IDisposable
  previousCommand: () => void
  nextCommand: () => void
  /** The output of the last finished command (shell integration), if still in the buffer. */
  lastOutput: () => string | undefined
  hasSelection: () => boolean
  copy: () => void
  paste: () => Promise<void>
  clear: () => void
  selectAll: () => void
  focus: () => void
}

/** Lines of a view kept for the next start. */
const SAVED_LINES = 1000

/** How long a view's size must hold still before the terminal (and its shell) takes it. */
export const FIT_SETTLE_MS = 120

/** Serialized output as plain text: colors and cursor moves dropped (a restored tab shows it greyed). */
/* eslint-disable no-control-regex -- ANSI escape sequences are what this strips */
export function plainText(serialized: string): string {
  return serialized
    .replace(/\x1b\[(\d*)C/g, (_, n: string) => ' '.repeat(Number(n || 1)))
    .replace(/\x1b\[[\d;:?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()*+]?./g, '')
    .replace(/\s+$/, '')
}
/* eslint-enable no-control-regex */

/** The restored output, greyed, with a line saying from when. */
function restoredBlock(r: { scrollback: string; savedAt: string }): string {
  const when = new Date(r.savedAt).toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' })
  const text = r.scrollback.replace(/\r?\n/g, '\r\n')
  return `\x1b[0;90m${text}\x1b[0m\r\n\x1b[90m── ${getT().terminal.restored(when)} ──\x1b[0m\r\n`
}

/** Match highlights in the theme's accents (the search addon wants #rrggbb). */
function findColors(): NonNullable<ISearchOptions['decorations']> {
  const amber = cssRgb('--accent-amber', '#f5bf60')
  const cyan = cssRgb('--accent-cyan', '#38d6e8')
  return { matchBackground: amber, matchOverviewRuler: amber, activeMatchBackground: cyan, activeMatchColorOverviewRuler: cyan }
}

const viewOptions = (s: TerminalSettings) => ({
  fontFamily: s.fontFamily,
  fontSize: s.fontSize,
  lineHeight: s.lineHeight,
  cursorStyle: s.cursorStyle,
  cursorBlink: s.cursorBlink,
  scrollback: s.scrollback
})

/**
 * One xterm.js view bound to one core PTY session: attaches to its scrollback,
 * appends live output (`end` offsets prevent duplicates), forwards keys and
 * sizes, follows the theme and the Terminal settings. Draws with WebGL when it
 * can (the DOM renderer otherwise, or once the GPU drops the context), measures
 * emoji and CJK per Unicode 11, finds text, marks the commands a shell with
 * integration reports and links file references to the editor. Shared by
 * terminal tabs and agent sessions.
 */
export function useXterm(hostRef: RefObject<HTMLDivElement>, id: string, exited: boolean, hooks: XtermHooks) {
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const exitedRef = useRef(exited)
  const hooksRef = useRef(hooks)
  hooksRef.current = hooks
  const parts = useRef<{ search: SearchAddon; commands: CommandTracker } | null>(null)

  useEffect(() => {
    const el = hostRef.current!
    const prefs = useTerminalSettings.getState().settings
    const term = new Terminal({
      ...viewOptions(prefs),
      macOptionIsMeta: true,
      allowTransparency: true,
      // Unicode 11 widths and the command marks (decorations) are "proposed" API.
      allowProposedApi: true,
      // OSC 8 hyperlinks (`ls --hyperlink`, compilers): the same way out as plain URLs — xterm's
      // own default opens an empty window first, which the desktop window refuses.
      linkHandler: { activate: (_event, uri) => void openExternal(uri), allowNonHttpProtocols: false },
      theme: themeFromTokens()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // URLs are clickable; main routes window.open to the OS browser.
    term.loadAddon(new WebLinksAddon((_event, uri) => void openExternal(uri)))
    const search = new SearchAddon()
    term.loadAddon(search)
    const serialize = new SerializeAddon()
    term.loadAddon(serialize)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.open(el)
    termRef.current = term
    fitRef.current = fit
    const commands = new CommandTracker(term, (code) => getT().terminal.commandExit(code))
    parts.current = { search, commands }

    // WebGL until it fails or the GPU takes the context back (too many views, driver reset): then the DOM draws.
    let gl: WebglAddon | undefined
    const gpu = (on: boolean) => {
      if (on && !gl) {
        try {
          const addon = new WebglAddon()
          addon.onContextLoss(() => {
            addon.dispose()
            gl = undefined
          })
          term.loadAddon(addon)
          gl = addon
        } catch {
          /* no WebGL2 here: the DOM renderer stays */
        }
      } else if (!on && gl) {
        gl.dispose()
        gl = undefined
      }
    }
    gpu(prefs.gpu)

    const links = hooksRef.current.where
      ? term.registerLinkProvider(
          fileLinkProvider(term, () => hooksRef.current.where!(), (file, line) => hooksRef.current.onOpenFile?.(file, line))
        )
      : undefined

    const { restored, persist } = hooksRef.current
    if (restored) term.write(restoredBlock(restored))
    const unregister = () => {
      if (persist) serializers.delete(id)
    }
    if (persist) {
      serializers.set(id, () =>
        plainText(serialize.serialize({ scrollback: Math.min(term.options.scrollback!, SAVED_LINES), excludeAltBuffer: true, excludeModes: true }))
      )
    }

    // `shown`: the output offset the view has written up to; null while (re)attaching.
    let shown: number | null = null
    const queued: TerminalData[] = []
    const show = (d: TerminalData, mayReattach = true) => {
      if (shown === null) {
        queued.push(d)
        return
      }
      const start = d.end - d.data.length
      if (d.end <= shown) return
      // A gap (events lost while the push channel was down): take the missing part from the scrollback.
      if (start > shown && mayReattach) {
        queued.push(d)
        attach(shown)
        return
      }
      term.write(d.data.slice(Math.max(0, shown - start)))
      shown = d.end
      if (persist) scheduleSave()
    }
    /**
     * Fetches the scrollback: all of it the first time (`from` null), else
     * what came after `from`. If that fails, queued output is shown as it is
     * (without asking again).
     */
    const attach = (from: number | null) => {
      shown = null
      ipc('terminal:attach', { id })
        .then(({ buffer, end }) => {
          const bufferStart = end - buffer.length
          const missing = from === null || bufferStart >= from ? buffer : buffer.slice(from - bufferStart)
          if (from === null || missing) term.write(missing)
          shown = Math.max(end, from ?? 0)
          queued.splice(0).forEach((d) => show(d))
        })
        .catch(() => {
          shown = from ?? 0
          queued.splice(0).forEach((d) => show(d, false))
        })
    }

    const offData = onEvent('terminal:data', (d) => d.id === id && show(d))
    const offExit = onEvent('terminal:exit', (e) => {
      if (e.id !== id) return
      exitedRef.current = true
      const note = hooksRef.current.onExit(e.exitCode)
      if (note) term.write(note)
    })

    attach(null)
    // Back after an outage of the push channel (web UI, phone): fetch what the gap swallowed.
    const offResync = onResync(() => {
      if (shown !== null) attach(shown)
    })

    const input = term.onData((data) => {
      if (exitedRef.current) {
        hooksRef.current.onInputAfterExit?.(data)
        return
      }
      void ipc('terminal:write', { id, data }).catch(() => {})
    })
    const resized = term.onResize(({ cols, rows }) => {
      if (!exitedRef.current) void ipc('terminal:resize', { id, cols, rows }).catch(() => {})
    })
    const selected = term.onSelectionChange(() => {
      if (useTerminalSettings.getState().settings.copyOnSelect && term.hasSelection()) void navigator.clipboard?.writeText(term.getSelection())
    })

    // The Terminal's own shortcuts never reach the shell.
    term.attachCustomKeyEventHandler((e) => {
      const action = terminalAction(e)
      if (action === 'find' && hooksRef.current.onFind) hooksRef.current.onFind()
      else if (action === 'prevCommand') commands.previous()
      else if (action === 'nextCommand') commands.next()
      else if (action === 'clear') term.clear()
      else if (action === 'close' && hooksRef.current.onClose) hooksRef.current.onClose()
      // Consumed even without a selection: Ctrl+Shift+C must never reach the shell as Ctrl+C.
      else if (action === 'copy') api.copy()
      else if (action === 'paste') void api.paste()
      else return true
      e.preventDefault()
      return false
    })

    // Hidden module (display:none) has no size — fit only when measurable.
    let sized = false
    let settling = 0
    const doFit = () => {
      window.clearTimeout(settling)
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        try {
          fit.fit()
          sized = true
        } catch {
          /* renderer not ready yet */
        }
      }
    }
    // A divider being dragged resizes the view every frame; a fit each time makes the
    // shell redraw its prompt each time (it flickers). Fit once the size has settled —
    // at once while the view has never had a real size.
    const ro = new ResizeObserver(() => {
      if (!sized) return doFit()
      window.clearTimeout(settling)
      settling = window.setTimeout(doFit, FIT_SETTLE_MS)
    })
    ro.observe(el)
    doFit()

    // Settings → Terminal applies to open views at once (a new font size refits).
    const offSettings = useTerminalSettings.subscribe((s, prev) => {
      if (s.settings === prev.settings) return
      Object.assign(term.options, viewOptions(s.settings))
      gpu(s.settings.gpu)
      doFit()
    })

    const mo = new MutationObserver(() => {
      term.options.theme = themeFromTokens()
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: APPEARANCE_ATTRIBUTES })

    return () => {
      offData()
      offExit()
      offResync()
      offSettings()
      input.dispose()
      resized.dispose()
      selected.dispose()
      links?.dispose()
      unregister()
      commands.dispose()
      ro.disconnect()
      window.clearTimeout(settling)
      mo.disconnect()
      // A task later: open() left xterm a timer that measures the view (Viewport.syncScrollArea);
      // a view gone in the same task (StrictMode, a layout switching fast) would make it throw.
      window.setTimeout(() => term.dispose())
      termRef.current = null
      fitRef.current = null
      parts.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- api is a stable ref (below); the view lives per session id
  }, [id, hostRef])

  // Stable across renders; a call while the view is gone does nothing.
  const api = useRef<XtermApi>({
    find: (query, opts, backwards) => {
      const search = parts.current?.search
      if (!search || !query) return false
      const options: ISearchOptions = { ...opts, decorations: findColors() }
      return backwards ? search.findPrevious(query, options) : search.findNext(query, options)
    },
    clearFind: () => {
      parts.current?.search.clearDecorations()
      termRef.current?.clearSelection()
    },
    onFindResults: (cb) => parts.current?.search.onDidChangeResults(({ resultIndex, resultCount }) => cb({ index: resultIndex, count: resultCount })) ?? { dispose: () => {} },
    previousCommand: () => void parts.current?.commands.previous(),
    nextCommand: () => void parts.current?.commands.next(),
    lastOutput: () => parts.current?.commands.lastOutput(),
    hasSelection: () => !!termRef.current?.hasSelection(),
    copy: () => {
      const text = termRef.current?.getSelection()
      if (text) void navigator.clipboard?.writeText(text)
    },
    paste: async () => {
      const text = await navigator.clipboard?.readText().catch(() => '')
      if (text) termRef.current?.paste(text)
    },
    clear: () => termRef.current?.clear(),
    selectAll: () => termRef.current?.selectAll(),
    focus: () => termRef.current?.focus()
  }).current

  return { termRef, fitRef, api }
}
