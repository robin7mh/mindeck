import { FolderOpen, RotateCcw } from 'lucide-react'
import { ipc } from '@shared/ipc/client'
import type { BrowserSettings } from '@shared/types/browser'
import { useT } from '@/lib/i18n'
import { Toggle } from './Toggle'

const small =
  'flex shrink-0 items-center gap-1 rounded-md border border-hud/60 px-2 py-1 font-sans text-[11.5px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan'

/** The browser's protection, agents' logins and downloads — part of the browser card. */
export function BrowserExtrasSettings({ settings, configure, onChange }: { settings: BrowserSettings; configure: (patch: Partial<BrowserSettings>) => void; onChange: (next: BrowserSettings) => void }) {
  const t = useT()
  const x = t.browserExtras
  const pick = () =>
    void ipc('browser:pickDownloadDir')
      .then((next) => next && onChange(next))
      .catch(() => {})
  return (
    <div className="mt-2 space-y-2">
      <Toggle label={x.adblock} hint={x.adblockHint} checked={settings.adblock} onChange={(v) => configure({ adblock: v })} />
      <Toggle label={x.malware} hint={x.malwareHint} checked={settings.malwareProtection} onChange={(v) => configure({ malwareProtection: v })} />
      <Toggle label={x.agentLogins} hint={x.agentLoginsHint} checked={settings.agentsUseLogins} onChange={(v) => configure({ agentsUseLogins: v })} />
      <Toggle label={x.askDownload} checked={settings.askDownloadLocation} onChange={(v) => configure({ askDownloadLocation: v })} />
      <div>
        <span className="mb-1 block font-sans text-[12px] text-text-secondary">{x.downloadFolder}</span>
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate rounded-md border border-hud/50 bg-surface/50 px-2 py-1 font-mono text-[11.5px] text-text-primary" title={settings.downloadDir || x.systemDownloads}>
            {settings.downloadDir || x.systemDownloads}
          </span>
          <button type="button" onClick={pick} className={small}>
            <FolderOpen size={12} /> {x.choose}
          </button>
          {settings.downloadDir && (
            <button type="button" aria-label={x.reset} title={x.reset} onClick={() => configure({ downloadDir: '' })} className={small}>
              <RotateCcw size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
