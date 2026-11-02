import { useEffect, useState } from 'react'
import { Check, ClipboardCopy, FolderOpen, MonitorCog, ShieldAlert } from 'lucide-react'
import { ipc, isDesktop } from '@shared/ipc/client'
import type { CloseBehavior, DesktopStatus } from '@shared/types/desktop'
import { Card } from '@/components/ui/Card'
import { Select } from '@/components/ui/Select'
import { useT } from '@/lib/i18n'

const button =
  'flex items-center justify-center gap-1.5 rounded-md border border-hud/60 px-2.5 py-1.5 font-sans text-[12px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan'

/** The desktop app itself: unencrypted secrets (Linux without a keyring), closing the window, logs and diagnostics. */
export function DesktopCard() {
  const t = useT()
  const [status, setStatus] = useState<DesktopStatus>()
  const [copied, setCopied] = useState(false)
  /** No file manager took the logs folder: where it is, instead. */
  const [logsFailed, setLogsFailed] = useState(false)

  useEffect(() => {
    if (isDesktop()) void ipc('desktop:status').then(setStatus).catch(() => {})
  }, [])

  if (!status) return null
  const s = t.stability
  const configure = (closeBehavior: CloseBehavior) => void ipc('desktop:configure', { closeBehavior }).then(setStatus).catch(() => {})
  const copyDiagnostics = () =>
    void ipc('desktop:diagnostics')
      .then((text) => navigator.clipboard.writeText(text))
      .then(() => setCopied(true))
      .catch(() => {})

  return (
    <Card icon={MonitorCog} title={s.card}>
      {!status.secretsEncrypted && (
        <div role="alert" className="mb-3 flex items-start gap-2 rounded-md border border-amber/40 bg-amber/6 px-2.5 py-2">
          <ShieldAlert size={14} className="mt-0.5 shrink-0 text-amber" />
          <div className="min-w-0">
            <p className="font-sans text-[12.5px] font-semibold text-text-primary">{s.keyringTitle}</p>
            <p className="mt-0.5 font-sans text-[11.5px] leading-relaxed text-text-secondary">{s.keyringBody}</p>
          </div>
        </div>
      )}
      {status.platform === 'darwin' ? (
        <p className="font-sans text-[12px] text-text-secondary">{s.closeMac}</p>
      ) : (
        <label className="block">
          <span className="mb-1 block font-sans text-[12px] text-text-secondary">{s.closeLabel}</span>
          <Select
            label={s.closeLabel}
            value={status.closeBehavior}
            options={[
              { value: 'ask', label: s.closeAsk },
              { value: 'background', label: s.closeBackground },
              { value: 'quit', label: s.closeQuit }
            ]}
            onChange={(v) => configure(v as CloseBehavior)}
          />
        </label>
      )}
      <p className="mt-3 font-sans text-[11.5px] text-text-muted">{s.logsHint}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={button} onClick={() => void ipc('desktop:openLogs').then(() => setLogsFailed(false), () => setLogsFailed(true))}>
          <FolderOpen size={12} /> {s.openLogs}
        </button>
        <button type="button" className={button} onClick={copyDiagnostics}>
          {copied ? <Check size={12} className="text-green" /> : <ClipboardCopy size={12} />} {copied ? s.copied : s.copyDiagnostics}
        </button>
      </div>
      {logsFailed && (
        <p role="status" className="mt-2 select-text break-all font-sans text-[11.5px] text-amber">
          {s.logsAt(status.logsDir)}
        </p>
      )}
    </Card>
  )
}
