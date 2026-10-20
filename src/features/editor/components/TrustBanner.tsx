import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { Project } from '@shared/types/project'
import { useT } from '@/lib/i18n'
import { useProjects } from '@/features/projects/store'
import { useLanguages } from '../languages'
import { useLintStatus } from '../lintStatus'
import { useScm } from '../scm'
import { useSftp } from '../sftp'
import { Banner, primary } from './EditorGroup'

/**
 * Workspace trust (BE-SEC-01): a project that isn't trusted runs none of its
 * own tools — the banner says so and lets the user trust it. Trusted, the
 * editor asks again: open files reach their language servers, ESLint lints,
 * Git and SFTP read the project's config.
 */
export function TrustBanner({ project }: { project: Project }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (project.trusted) return null

  const trust = async () => {
    setBusy(true)
    setError(undefined)
    const failed = await useProjects.getState().trust(project.id)
    setBusy(false)
    if (failed) return setError(failed)
    useLanguages.getState().toolsChanged()
    void useLintStatus.getState().restart()
    void useScm.getState().refresh()
    void useSftp.getState().load()
  }

  return (
    <Banner tone="warn">
      <ShieldAlert size={13} className="shrink-0 text-amber" />
      <span className="mr-auto min-w-0 flex-1">{t.trust.restricted(project.name)}</span>
      {error && <span className="text-danger">{error}</span>}
      <button type="button" disabled={busy} onClick={() => void trust()} className={primary}>
        {busy ? t.trust.trusting : t.trust.trust}
      </button>
    </Banner>
  )
}
