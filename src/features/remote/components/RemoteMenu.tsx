import { useEffect, useRef, useState } from 'react'
import { Box, Loader2, MonitorSmartphone, Server, X } from 'lucide-react'
import type { RemoteConnection } from '@shared/types/remote'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { isActive, useRemote } from '../store'

const row = 'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-sans text-[12.5px] text-text-secondary transition-colors hover:bg-elevated/60 hover:text-text-primary'

function Connection({ c }: { c: RemoteConnection }) {
  const t = useT()
  const busy = c.state === 'connecting' || c.state === 'installing' || c.state === 'starting'
  return (
    <li className="flex items-center gap-2 px-2 py-1">
      {c.kind === 'ssh' ? <Server size={13} className="shrink-0 text-cyan" /> : <Box size={13} className="shrink-0 text-cyan" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-sans text-[12.5px] text-text-primary">{c.label}</span>
        <span className={cn('flex items-center gap-1 font-mono text-[10.5px]', c.state === 'failed' ? 'text-danger' : c.state === 'ready' ? 'text-green' : 'text-text-muted')}>
          {busy && <Loader2 size={10} className="animate-spin" />}
          {t.remote.states[c.state]}
          {c.error && `: ${c.error}`}
        </span>
      </span>
      {isActive(c) && (
        <button type="button" aria-label={`${t.remote.disconnect} ${c.label}`} title={t.remote.disconnect} onClick={() => void useRemote.getState().disconnect(c.id)} className="rounded-sm p-1 text-text-muted hover:bg-elevated hover:text-text-primary">
          <X size={12} />
        </button>
      )}
    </li>
  )
}

/**
 * Remote-SSH and Dev Containers (desktop): connect to a host from
 * ~/.ssh/config or typed in, or open the selected project in its Dev
 * Container; the connections with their state.
 */
export function RemoteMenu({ project }: { project?: { id: string; name: string } }) {
  const t = useT()
  const { connections, hosts, error } = useRemote()
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState('')
  const [container, setContainer] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const remote = useRemote.getState()
  const active = connections.filter(isActive)

  useEffect(() => useRemote.getState().connect(), [])
  useEffect(() => {
    if (!open) return
    void useRemote.getState().loadHosts()
    if (project) void useRemote.getState().hasContainer(project.id).then(setContainer)
    const outside = (e: MouseEvent) => !ref.current!.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', outside)
    return () => window.removeEventListener('mousedown', outside)
  }, [open, project])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md border border-hud/60 px-2.5 py-1 font-sans text-[12px] text-text-secondary transition-colors hover:text-text-primary"
      >
        <MonitorSmartphone size={14} />
        {t.remote.button}
        {active.length > 0 && <span className="rounded-full bg-cyan px-1.5 font-mono text-[10px] font-semibold text-void">{active.length}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label={t.remote.button} className="absolute right-0 top-full z-30 mt-1.5 w-80 space-y-2 rounded-lg border border-hud/70 bg-panel p-2 shadow-panel">
          <p className="px-2 font-sans text-[11.5px] text-text-muted">{t.remote.hint}</p>
          <p className="px-2 font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">{t.remote.hosts}</p>
          <ul>
            {hosts.map((h) => (
              <li key={h.name}>
                <button type="button" onClick={() => void remote.ssh(h.name)} className={row}>
                  <Server size={13} className="shrink-0 text-text-muted" />
                  <span className="truncate">{h.name}</span>
                  {h.hostName && (
                    <span className="ml-auto truncate font-mono text-[10.5px] text-text-muted">
                      {h.user ? `${h.user}@` : ''}
                      {h.hostName}
                      {h.port ? `:${h.port}` : ''}
                    </span>
                  )}
                </button>
              </li>
            ))}
            {hosts.length === 0 && <li className="px-2 py-1 font-sans text-[12px] text-text-muted">{t.remote.noHosts}</li>}
          </ul>
          <form
            className="flex gap-1.5 px-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (target.trim()) void remote.ssh(target.trim())
            }}
          >
            <input aria-label={t.remote.target} placeholder={t.remote.target} value={target} onChange={(e) => setTarget(e.target.value)} className="min-w-0 flex-1 rounded-md border border-hud/60 bg-void/40 px-2 py-1 font-mono text-[12px] text-text-primary outline-hidden focus:border-cyan/60" />
            <button type="submit" disabled={!target.trim()} className="rounded-md border border-cyan/50 px-2 py-1 font-sans text-[12px] text-cyan hover:bg-cyan/10 disabled:opacity-40">
              {t.remote.connect}
            </button>
          </form>
          {project && container && (
            <button type="button" onClick={() => void remote.container(project.id)} className={row}>
              <Box size={13} className="shrink-0 text-cyan" />
              {t.remote.containerOf(project.name)}
            </button>
          )}
          {connections.length > 0 && (
            <>
              <p className="px-2 pt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">{t.remote.active}</p>
              <ul>
                {connections.map((c) => (
                  <Connection key={c.id} c={c} />
                ))}
              </ul>
            </>
          )}
          {error && (
            <p role="alert" className="flex items-start gap-1 rounded-sm bg-danger/10 px-2 py-1 font-sans text-[11.5px] text-danger">
              <span className="flex-1 whitespace-pre-wrap">{error}</span>
              <button type="button" aria-label={t.common.dismiss} onClick={() => remote.clearError()}>
                <X size={12} />
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  )
}
