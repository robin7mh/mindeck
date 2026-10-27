import { useEffect, useState } from 'react'
import { ExternalLink, Globe, Loader2, Lock } from 'lucide-react'
import { ipc } from '@shared/ipc/client'
import { REPO_NAME, repoName, type GitHubOwners } from '@shared/types/github'
import type { ScmStatus } from '@shared/types/scm'
import { Select } from '@/components/ui/Select'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useProjects } from '@/features/projects/store'
import { useEditor } from '../store'
import { useGitHub } from '../github'
import { Hint } from './PullsPanel'

const field = 'w-full rounded-md border border-hud/60 bg-surface/50 px-2 py-1 font-sans text-[12.5px] text-text-primary outline-hidden placeholder:text-text-muted focus:border-cyan/50'
const button = 'flex items-center gap-1 rounded-sm border px-2 py-0.5 font-sans text-[12px] disabled:opacity-40'

/** Who may own the new repository — or why gh can't say. */
type Owners = GitHubOwners | 'gh-missing' | 'gh-auth' | { error: string }

/**
 * VS Code's "Publish to GitHub": account or organization, name, description,
 * private or public. Before the first commit it says what gets committed.
 */
export function PublishForm({ status }: { status: ScmStatus }) {
  const t = useT()
  const g = t.github
  const folder = useProjects((s) => s.projects.find((p) => p.id === useEditor.getState().projectId)?.name ?? '')
  const busy = useGitHub((s) => s.busy)
  const [owners, setOwners] = useState<Owners>()
  const [owner, setOwner] = useState('')
  const [name, setName] = useState(() => repoName(folder))
  const [description, setDescription] = useState('')
  const [isPrivate, setPrivate] = useState(true)
  const [message, setMessage] = useState(g.firstCommitMessage)
  const [done, setDone] = useState<{ nameWithOwner: string; url: string }>()
  const close = () => useGitHub.getState().setPublishing(false)

  useEffect(() => {
    ipc('github:owners', { projectId: useEditor.getState().projectId! }).then(
      (found) => {
        setOwners(found)
        setOwner(found.user)
      },
      (err: { code: string; message: string }) => setOwners(err.code === 'gh-missing' || err.code === 'gh-auth' ? err.code : { error: err.message })
    )
  }, [])

  if (done) {
    return (
      <div role="status" className="space-y-1.5 rounded-md border border-green/40 bg-green/[0.07] px-2 py-1.5">
        <p className="font-sans text-[12px] text-text-primary">{g.published(done.nameWithOwner)}</p>
        <div className="flex gap-1.5">
          <a href={done.url} target="_blank" rel="noreferrer" className={cn(button, 'border-cyan/50 text-cyan hover:bg-cyan/10')}>
            <ExternalLink size={11} /> {g.openOnGitHub}
          </a>
          <button type="button" onClick={close} className={cn(button, 'border-hud/60 text-text-secondary')}>
            {g.close}
          </button>
        </div>
      </div>
    )
  }

  if (!owners) return <Loader2 size={14} aria-label={t.common.loading} className="mx-auto animate-spin text-text-muted" />
  if (owners === 'gh-missing') return <Hint title={g.missing} hint={g.missingHint} commands={['brew install gh', 'gh auth login']} />
  if (owners === 'gh-auth') return <Hint title={g.signedOut} hint={g.signInHint} commands={['gh auth login']} />
  if ('error' in owners) return <p className="whitespace-pre-wrap font-mono text-[11px] text-danger">{owners.error}</p>

  const valid = REPO_NAME.test(name) && name !== '.' && name !== '..'
  const about = description.trim()
  // Nothing committed yet: everything goes into the first commit — an empty folder gets a README first.
  const first = status.head ? undefined : { message: message.trim() || g.firstCommitMessage, ...(status.files.length ? {} : { readme: `# ${name}\n${about ? `\n${about}\n` : ''}` }) }
  const submit = async () => {
    const made = await useGitHub.getState().publish({ name, owner, private: isPrivate, ...(about ? { description: about } : {}) }, first)
    if (made) setDone(made)
  }

  return (
    <form
      aria-label={g.publishTitle}
      className="space-y-1.5 rounded-md border border-hud/60 bg-surface/30 p-2"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <p className="font-sans text-[12px] font-medium text-text-primary">{g.publishTitle}</p>
      <p className="font-sans text-[11px] text-text-muted">{g.publishHint}</p>
      <Select
        label={g.owner}
        value={owner}
        options={[{ value: owners.user, label: owners.user, hint: g.yourAccount }, ...owners.orgs.map((org) => ({ value: org, label: org, hint: g.organization }))]}
        onChange={setOwner}
      />
      <input aria-label={g.repoName} placeholder={g.repoName} value={name} onChange={(e) => setName(e.target.value)} className={cn(field, 'font-mono')} />
      {name && !valid && <p className="font-sans text-[11px] text-amber">{g.repoNameInvalid}</p>}
      <input aria-label={g.repoDescription} placeholder={g.repoDescription} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={350} className={field} />
      <div role="radiogroup" aria-label={g.visibility} className="grid grid-cols-2 gap-1.5">
        {[true, false].map((on) => (
          <button
            key={String(on)}
            type="button"
            role="radio"
            aria-checked={isPrivate === on}
            onClick={() => setPrivate(on)}
            className={cn('rounded-md border px-2 py-1 text-left transition-colors', isPrivate === on ? 'border-cyan/60 bg-cyan/[0.08]' : 'border-hud/60 hover:border-cyan/40')}
          >
            <span className="flex items-center gap-1 font-sans text-[12px] text-text-primary">
              {on ? <Lock size={11} /> : <Globe size={11} />} {on ? g.private : g.public}
            </span>
            <span className="block font-sans text-[10.5px] text-text-muted">{on ? g.privateHint : g.publicHint}</span>
          </button>
        ))}
      </div>
      {first &&
        (status.files.length ? (
          <>
            <p className="font-sans text-[11px] text-text-secondary">{g.firstCommit}</p>
            <input aria-label={g.firstCommitLabel} value={message} onChange={(e) => setMessage(e.target.value)} className={field} />
          </>
        ) : (
          <p className="font-sans text-[11px] text-text-secondary">{g.emptyFolder}</p>
        ))}
      <div className="flex gap-1.5">
        <button type="submit" disabled={!valid || !!busy} className={cn(button, 'border-cyan/50 text-cyan hover:bg-cyan/10')}>
          {busy === 'publish' && <Loader2 size={11} className="animate-spin" />}
          {g.publishSubmit}
        </button>
        <button type="button" onClick={close} className={cn(button, 'border-hud/60 text-text-secondary')}>
          {g.cancel}
        </button>
      </div>
    </form>
  )
}
