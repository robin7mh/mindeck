import { Smartphone } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { useSettings } from '@/features/settings/store'
import { useBrowser } from '../store'

const small =
  'flex items-center gap-1 rounded-md border border-hud/60 px-2 py-0.5 font-sans text-[11.5px] text-text-secondary transition-colors hover:border-danger/50 hover:text-danger'

/** A paired device uses this browser right now — with the user's logins: say so, and let the desktop stop it at once. */
export function RemoteUseBar() {
  const t = useT()
  const devices = useBrowser((s) => s.state.remote)
  if (!devices?.length) return null
  return (
    <div role="status" className="shrink-0 space-y-1 border-b border-cyan/30 bg-cyan/[0.06] px-3 py-1.5">
      {devices.map((d) => (
        <div key={d.deviceId} className="flex items-center gap-2">
          <Smartphone size={14} className="shrink-0 text-cyan" />
          <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-text-primary">{t.library.remoteUse(d.device)}</span>
          <button type="button" onClick={() => void useSettings.getState().setDeviceBrowser(d.deviceId, false)} className={small}>
            {t.library.remoteStop}
          </button>
        </div>
      ))}
    </div>
  )
}
