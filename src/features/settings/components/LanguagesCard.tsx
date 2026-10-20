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
    <div className="flex min-w-0 items-center gap-1.5" title={tool.command}>
      <Icon size={11} className="shrink-0 text-text-muted" />
      <span className="min-w-0 truncate font-sans text-[11.5px] text-text-secondary">{tool.name}</span>
      {tool.state === 'ready' ? (
        <span className="flex shrink-0 items-center gap-0.5 font-sans text-[11px] text-green">
          <Check size={11} /> {l.ready}
        </span>
      ) : tool.state === 'missing' ? (
        <button
          type="button"
          aria-label={l.installTool(tool.name)}
          disabled={busy}
          onClick={onInstall}
          className="flex shrink-0 items-center gap-1 rounded-sm border border-cyan/40 px-1.5 py-px font-sans text-[11px] text-cyan hover:bg-cyan/10 disabled:opacity-50"
        >
          {busy ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />} {l.install}
        </button>
      ) : (
        <span className="shrink-0 font-sans text-[11px] text-text-muted">{tool.state === 'toolchain' ? l.needs(tool.requires!) : l.manual}</span>
      )}
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
      <div className="mb-2 flex items-start gap-2">
        <p className="flex-1 font-sans text-[12px] text-text-secondary">{l.intro}</p>
        <button type="button" aria-label={l.refresh} title={l.refresh} onClick={() => void load()} className="text-text-muted hover:text-cyan">
          <RefreshCw size={12} />
        </button>
      </div>
      {error?.key === '' && <p className="font-sans text-[12px] text-danger">{error.message}</p>}
      {!list && !error && <Loader2 size={14} aria-label={t.common.loading} className="animate-spin text-text-muted" />}
      <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {list?.map((lang) => (
          <li key={lang.id} className="rounded-sm border border-hud/40 px-2 py-1.5">
            <p className="font-sans text-[12.5px] font-medium text-text-primary">{lang.name}</p>
            <div className="mt-0.5 space-y-0.5">
              <Tool tool={lang.server} part="server" busy={busy === `${lang.id}:server`} onInstall={() => void install(lang.id, 'server')} />
              {lang.debugger && <Tool tool={lang.debugger} part="debugger" busy={busy === `${lang.id}:debugger`} onInstall={() => void install(lang.id, 'debugger')} />}
            </div>
            {log && log.key.startsWith(`${lang.id}:`) && log.lines.length > 0 && (
              <pre aria-label={l.log} className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-sm bg-void/60 p-1.5 font-mono text-[10.5px] text-text-muted">
                {log.lines.join('\n')}
              </pre>
            )}
            {error && error.key.startsWith(`${lang.id}:`) && (
              <p role="alert" className={cn('mt-1 whitespace-pre-wrap font-mono text-[10.5px] text-danger')}>
                {error.message}
              </p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}
