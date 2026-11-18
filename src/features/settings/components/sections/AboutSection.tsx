import { useState } from 'react'
import { Check, ClipboardCopy, FolderOpen } from 'lucide-react'
import { ipc, isDesktop } from '@shared/ipc/client'
import { useT } from '@/lib/i18n'
import { useSession } from '@/features/session/store'
import { Group, Row, SectionHeader, btn } from '../ui'

/** Settings → About & diagnostics: the version, this core and client, the logs and diagnostics for support. */
export function AboutSection() {
  const t = useT()
  const s = t.settings
  const info = useSession((st) => st.info)
  const desktop = isDesktop()
  const [copied, setCopied] = useState(false)
  /** No file manager took the logs folder: where it is, instead. */
  const [logsAt, setLogsAt] = useState<string>()

  const value = (text: string) => <span className="font-mono text-[12.5px] text-text-secondary">{text}</span>
  const openLogs = () =>
    void ipc('desktop:openLogs').then(
      () => setLogsAt(undefined),
      () =>
        void ipc('desktop:status').then(
          (status) => setLogsAt(status.logsDir),
          () => {}
        )
    )
  const copyDiagnostics = () =>
    void ipc('desktop:diagnostics')
      .then((text) => navigator.clipboard.writeText(text))
      .then(() => setCopied(true))
      .catch(() => {})

  return (
    <>
      <SectionHeader title={s.sections.about.title} intro={s.sections.about.intro} />
      {info && (
        <Group>
          <Row label={s.version}>{value(info.version)}</Row>
          <Row label={s.core}>{value(info.mode === 'desktop' ? s.desktopApp : s.server)}</Row>
          <Row label={s.host}>{value(`${info.hostname} (${info.platform})`)}</Row>
          <Row label={s.client}>{value(desktop ? s.desktopWindow : s.pairedBrowser)}</Row>
        </Group>
      )}
      {desktop && (
        <Group>
          <Row
            label={s.logs}
            hint={
              <>
                {s.logsHint}
                {logsAt && (
                  <span role="status" className="mt-1 block select-text break-all text-amber">
                    {t.stability.logsAt(logsAt)}
                  </span>
                )}
              </>
            }
          >
            <button type="button" className={btn} onClick={openLogs}>
              <FolderOpen size={14} /> {t.stability.openLogs}
            </button>
          </Row>
          <Row label={s.diagnostics} hint={s.diagnosticsHint}>
            <button type="button" className={btn} onClick={copyDiagnostics}>
              {copied ? <Check size={14} className="text-green" /> : <ClipboardCopy size={14} />} {copied ? t.stability.copied : t.stability.copyDiagnostics}
            </button>
          </Row>
        </Group>
      )}
    </>
  )
}
