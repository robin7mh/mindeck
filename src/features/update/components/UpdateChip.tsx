import { useEffect } from 'react'
import { ArrowUpCircle, Download } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { useUpdate } from '../store'

const chip =
  'flex items-center gap-1.5 rounded-md border border-cyan/50 bg-cyan/[0.10] px-2.5 py-1 font-mono text-[11px] text-cyan transition-colors hover:bg-cyan/18'

/**
 * Top bar: appears once a downloaded update waits for a restart — or, where
 * the app can't update itself (Linux .deb), once a new version is out.
 */
export function UpdateChip() {
  const t = useT()
  const status = useUpdate((s) => s.status)
  useEffect(() => useUpdate.getState().connect(), [])
  if (status?.state === 'available' && status.downloadUrl) {
    return (
      <a href={status.downloadUrl} target="_blank" rel="noreferrer" title={t.update.download} className={chip}>
        <Download size={13} />
        {t.update.chipAvailable(status.version ?? '')}
      </a>
    )
  }
  if (status?.state !== 'ready') return null
  return (
    <button
      type="button"
      onClick={() => void useUpdate.getState().install()}
      title={t.update.install}
      className={chip}
    >
      <ArrowUpCircle size={13} />
      {t.update.chip(status.version ?? '')}
    </button>
  )
}
