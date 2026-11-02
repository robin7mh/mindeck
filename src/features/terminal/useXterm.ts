import { useEffect, useRef, type RefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ipc, onEvent } from '@shared/ipc/client'
import type { TerminalData } from '@shared/types/terminal'
import { APPEARANCE_ATTRIBUTES } from '@/lib/theme'
import { themeFromTokens } from './theme'

export interface XtermHooks {
  /** The process ended; may return a line to print in the terminal. */
  onExit: (exitCode: number) => string | undefined
  /** Keys typed after the process ended (e.g. Enter → restart). */
  onInputAfterExit?: (data: string) => void
}

/**
 * One xterm.js view bound to one core PTY session: attaches to its scrollback,
 * appends live output (`end` offsets prevent duplicates), forwards keys and
 * sizes, follows the theme. Shared by terminal tabs and agent sessions.
 */
export function useXterm(hostRef: RefObject<HTMLDivElement>, id: string, exited: boolean, hooks: XtermHooks) {
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const exitedRef = useRef(exited)
  const hooksRef = useRef(hooks)
  hooksRef.current = hooks

  useEffect(() => {
    const el = hostRef.current!
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      macOptionIsMeta: true,
      allowTransparency: true,
      theme: themeFromTokens()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // URLs are clickable; main routes window.open to the OS browser.
    term.loadAddon(new WebLinksAddon((_event, uri) => void window.open(uri, '_blank', 'noopener,noreferrer')))
    term.open(el)
    termRef.current = term
    fitRef.current = fit

    let attachedEnd: number | null = null
    const queued: TerminalData[] = []
    const show = (d: TerminalData) => {
      if (attachedEnd === null) {
        queued.push(d)
        return
      }
      const start = d.end - d.data.length
      if (d.end <= attachedEnd) return
      term.write(start < attachedEnd ? d.data.slice(attachedEnd - start) : d.data)
    }
    const flushQueue = () => queued.splice(0).forEach(show)

    const offData = onEvent('terminal:data', (d) => d.id === id && show(d))
    const offExit = onEvent('terminal:exit', (e) => {
      if (e.id !== id) return
      exitedRef.current = true
      const note = hooksRef.current.onExit(e.exitCode)
      if (note) term.write(note)
    })

    ipc('terminal:attach', { id })
      .then(({ buffer, end }) => {
        term.write(buffer)
        attachedEnd = end
        flushQueue()
      })
      .catch(() => {
        attachedEnd = 0
        flushQueue()
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

    // Hidden module (display:none) has no size — fit only when measurable.
    const doFit = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        try {
          fit.fit()
        } catch {
          /* renderer not ready yet */
        }
      }
    }
    const ro = new ResizeObserver(doFit)
    ro.observe(el)
    doFit()

    const mo = new MutationObserver(() => {
      term.options.theme = themeFromTokens()
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: APPEARANCE_ATTRIBUTES })

    return () => {
      offData()
      offExit()
      input.dispose()
      resized.dispose()
      ro.disconnect()
      mo.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [id, hostRef])

  return { termRef, fitRef }
}
