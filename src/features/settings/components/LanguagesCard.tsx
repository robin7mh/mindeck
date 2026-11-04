import { useEffect, useState } from 'react'
import { Bug, Check, Code2, Download, Loader2, RefreshCw } from 'lucide-react'
import { errorMessage, ipc, onEvent } from '@shared/ipc/client'
import type { LanguageStatus, ToolState } from '@shared/types/languages'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useLanguages } from '@/features/editor/languages'

type Part = 'server' | 'debugger'

/** One tool's state: ready, an install button, or what it needs first. */
function Tool({ tool, part, busy, onInstall }: { tool: ToolState; part: Part; busy: boolean; onInstall: () => void }) {
  const t = useT()
  const l = t.languages
  const Icon = part === 'server' ? Code2 : Bug
  return (
    <div className="flex min-h-8 items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2" title={tool.command}>
        <Icon size={14} strokeWidth={1.75} className="shrink-0 text-text-muted" />
        <span className="min-w-0 truncate font-sans text-[13px] text-text-secondary">{tool.name}</span>
      </div>
      <div className="flex w-[180px] shrink-0 justify-end">
        {tool.state === 'ready' ? (
          <span className="flex h-7 w-[124px] items-center justify-center gap-1.5 rounded-md bg-green/10 font-sans text-[12.5px] font-medium text-green">
            <Check size={13} strokeWidth={2.2} /> {l.ready}
          </span>
        ) : tool.state === 'missing' ? (
          <button
            type="button"
            aria-label={l.installTool(tool.name)}
            disabled={busy}
            onClick={onInstall}
            className="flex h-7 w-[124px] items-center justify-center gap-1.5 rounded-md border border-hud/60 px-2.5 font-sans text-[12.5px] font-medium text-text-primary transition-colors hover:border-cyan/60 hover:bg-cyan/10 disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin text-cyan" /> : <Download size={13} strokeWidth={2} className="text-cyan" />} {l.install}
          </button>
        ) : (
          <span className="truncate pr-1 text-right font-sans text-[12.5px] text-text-muted" title={tool.state === 'toolchain' ? l.needs(tool.requires!) : l.manual}>{tool.state === 'toolchain' ? l.needs(tool.requires!) : l.manual}</span>
        )}
      </div>
    </div>
  )
}

/**
 * Settings → Languages: every language the editor knows, its language server
 * and debugger on this machine, and installing what is missing — the only
 * place Mindeck installs anything.
 */
export function LanguagesCard() {
  const t = useT()
  const l = t.languages
  const [list, setList] = useState<LanguageStatus[]>()
  const [busy, setBusy] = useState<string>()
  const [log, setLog] = useState<{ key: string; lines: string[] }>()
  const [error, setError] = useState<{ key: string; message: string }>()

  const load = () =>
    ipc('tools:status').then(
      (status) => setList(status),
      (err: unknown) => setError({ key: '', message: errorMessage(err) })
    )

  useEffect(() => {
    void load()
    return onEvent('tools:progress', ({ id, part, line }) =>
      setLog((prev) => {
        const key = `${id}:${part}`
        return { key, lines: [...(prev?.key === key ? prev.lines : []), line].slice(-8) }
      })
    )
  }, [])

  const install = async (id: string, part: Part) => {
    const key = `${id}:${part}`
    setBusy(key)
    setError(undefined)
    setLog({ key, lines: [] })
    try {
      const updated = await ipc('tools:install', { id, part })
      setList((prev) => prev?.map((x) => (x.id === id ? updated : x)))
      setLog(undefined)
      // Files already open in the editor pick up their new server.
      useLanguages.getState().toolsChanged()
    } catch (err) {
      setError({ key, message: errorMessage(err) })
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <Card icon={Code2} title={l.title} className="pane-lg:col-span-2">
      <div className="mb-4 flex items-start gap-3">
        <p className="flex-1 font-sans text-[13px] text-text-secondary">{l.intro}</p>
        <button
          type="button"
          aria-label={l.refresh}
          title={l.refresh}
          onClick={() => void load()}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text-primary"
        >
          <RefreshCw size={15} strokeWidth={1.75} />
        </button>
      </div>
      {error?.key === '' && <p className="font-sans text-[12.5px] text-danger">{error.message}</p>}
      {!list && !error && <Loader2 size={16} aria-label={t.common.loading} className="animate-spin text-text-muted" />}
      {list && list.length > 0 && (
        <ul className="divide-y divide-hud/35 overflow-hidden rounded-md border border-hud/45">
          {list.map((lang) => (
            <li key={lang.id} className="grid grid-cols-[minmax(96px,180px)_minmax(0,1fr)] gap-x-6 px-4 py-2.5 transition-colors hover:bg-elevated/40">
              <p className="flex min-h-8 items-center font-sans text-[13.5px] font-medium text-text-primary">{lang.name}</p>
              <div className="flex min-w-0 flex-col gap-1">
                <Tool tool={lang.server} part="server" busy={busy === `${lang.id}:server`} onInstall={() => void install(lang.id, 'server')} />
                {lang.debugger && <Tool tool={lang.debugger} part="debugger" busy={busy === `${lang.id}:debugger`} onInstall={() => void install(lang.id, 'debugger')} />}
                {log && log.key.startsWith(`${lang.id}:`) && log.lines.length > 0 && (
                  <pre aria-label={l.log} className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-sm bg-void/60 p-2 font-mono text-[11px] text-text-muted">
                    {log.lines.join('\n')}
                  </pre>
                )}
                {error && error.key.startsWith(`${lang.id}:`) && (
                  <p role="alert" className={cn('mt-1 whitespace-pre-wrap font-mono text-[11px] text-danger')}>
                    {error.message}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
