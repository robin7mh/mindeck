import { useEffect, useState } from 'react'
import { GitPullRequest, GitPullRequestDraft, Loader2, Plus, RefreshCw } from 'lucide-react'
import type { PullFilter, PullListState, PullSummary } from '@shared/types/github'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { Select } from '@/components/ui/Select'
import { useGitHub } from '../github'
import { useScm } from '../scm'

const tool = 'flex h-6 w-6 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-elevated hover:text-text-primary disabled:opacity-40'
const field = 'w-full rounded-md border border-hud/60 bg-void/40 px-2 py-1 font-sans text-[12.5px] text-text-primary outline-hidden placeholder:text-text-muted focus:border-cyan/60'
const FILTERS: PullFilter[] = ['all', 'mine', 'review']
const STATES: PullListState[] = ['open', 'merged', 'closed', 'all']

/** What to run when gh is missing or signed out. */
function Hint({ title, hint, commands }: { title: string; hint: string; commands: string[] }) {
  return (
    <div className="space-y-1.5 px-2 font-sans text-[12px] text-text-secondary">
      <p className="text-text-primary">{title}</p>
      <p>{hint}</p>
      {commands.map((c) => (
        <code key={c} className="block select-all rounded-sm bg-void/60 px-2 py-1 font-mono text-[11.5px] text-cyan">
          {c}
        </code>
      ))}
    </div>
  )
}

/** A feature branch → GitHub: title, description, target branch, draft. */
function CreateForm() {
  const t = useT()
  const branch = useScm((s) => s.status?.branch)
  const busy = useGitHub((s) => s.busy)
  const [title, setTitle] = useState(() => (branch ?? '').replace(/^(feature|feat|fix|bugfix|hotfix|chore)\//, '').replace(/[-_]+/g, ' '))
  const [body, setBody] = useState('')
  const [base, setBase] = useState(() => useGitHub.getState().status?.repo?.defaultBranch ?? 'main')
  const [draft, setDraft] = useState(false)
  const same = branch === base.trim()
  return (
    <form
      aria-label={t.github.create}
      className="space-y-1.5 px-2"
      onSubmit={(e) => {
        e.preventDefault()
        void useGitHub.getState().create({ title: title.trim(), body, base: base.trim(), draft })
      }}
    >
      <p className="font-sans text-[11.5px] text-text-muted">{t.github.fromBranch(branch ?? '?')}</p>
      <input aria-label={t.github.newTitle} placeholder={t.github.newTitle} value={title} onChange={(e) => setTitle(e.target.value)} className={field} />
      <textarea aria-label={t.github.newBody} placeholder={t.github.newBody} value={body} onChange={(e) => setBody(e.target.value)} rows={6} className={cn(field, 'resize-y font-mono text-[12px]')} />
      <input aria-label={t.github.base} placeholder={t.github.base} value={base} onChange={(e) => setBase(e.target.value)} className={cn(field, 'font-mono')} />
      <label className="flex items-center gap-1.5 font-sans text-[12px] text-text-secondary">
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> {t.github.asDraft}
      </label>
      {same && <p className="font-sans text-[11.5px] text-amber">{t.github.sameBranch}</p>}
      <div className="flex gap-1.5">
        <button type="submit" disabled={!title.trim() || !base.trim() || same || !!busy} className="flex items-center gap-1 rounded-sm border border-cyan/50 px-2 py-0.5 font-sans text-[12px] text-cyan hover:bg-cyan/10 disabled:opacity-40">
          {busy === 'create' && <Loader2 size={11} className="animate-spin" />}
          {t.github.submit}
        </button>
        <button type="button" onClick={() => useGitHub.getState().setCreating(false)} className="rounded-sm border border-hud/60 px-2 py-0.5 font-sans text-[12px] text-text-secondary">
          {t.github.cancel}
        </button>
      </div>
    </form>
  )
}

function Item({ pr, active, opening }: { pr: PullSummary; active: boolean; opening: boolean }) {
  const t = useT()
  const Icon = pr.draft ? GitPullRequestDraft : GitPullRequest
  const tint = pr.state === 'MERGED' ? 'text-purple' : pr.state === 'CLOSED' ? 'text-danger' : pr.draft ? 'text-text-muted' : 'text-green'
  return (
    <li>
      <button
        type="button"
        aria-label={`#${pr.number} ${pr.title}`}
        aria-current={active || undefined}
        onClick={() => void useGitHub.getState().open(pr.number)}
        className={cn('flex w-full gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-elevated/60', active && 'bg-cyan/8')}
      >
        {opening ? <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-text-muted" /> : <Icon size={13} className={cn('mt-0.5 shrink-0', tint)} />}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-sans text-[12.5px] text-text-primary">{pr.title}</span>
          <span className="block truncate font-mono text-[10.5px] text-text-muted">
            #{pr.number} · {pr.author} · {t.github.into(pr.head, pr.base)}
          </span>
          {(pr.draft || pr.review) && (
            <span className="mt-0.5 flex gap-1 font-sans text-[10.5px]">
              {pr.draft && <span className="rounded-sm bg-elevated px-1 text-text-muted">{t.github.draft}</span>}
              {pr.review && <span className={cn('rounded-sm px-1', pr.review === 'APPROVED' ? 'bg-green/10 text-green' : pr.review === 'CHANGES_REQUESTED' ? 'bg-danger/10 text-danger' : 'bg-amber/10 text-amber')}>{t.github.review[pr.review]}</span>}
            </span>
          )}
        </span>
      </button>
    </li>
  )
}

/** The GitHub Pull Requests extension's sidebar: the project's pull requests, filtered; create one. */
export function PullsPanel() {
  const t = useT()
  const { status, filter, state, pulls, loading, creating, opening, detail } = useGitHub()
  const gh = useGitHub.getState()

  useEffect(() => {
    if (!useGitHub.getState().status) void useGitHub.getState().load()
  }, [])

  if (!status) return <Loader2 size={14} aria-label={t.common.loading} className="mx-auto mt-4 animate-spin text-text-muted" />
  if (!status.installed) return <Hint title={t.github.missing} hint={t.github.missingHint} commands={['brew install gh', 'gh auth login']} />
  if (!status.user) return <Hint title={t.github.signedOut} hint={t.github.signInHint} commands={['gh auth login']} />
  if (!status.repo) {
    return (
      <div className="space-y-1 px-2 font-sans text-[12px] text-text-secondary">
        <p className="text-text-primary">{t.github.noRepo}</p>
        {status.error && <p className="whitespace-pre-wrap font-mono text-[11px] text-text-muted">{status.error}</p>}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1.5 px-2 pb-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">{t.github.title}</p>
        <p className="truncate font-mono text-[11px] text-text-secondary" title={t.github.signedInAs(status.user)}>
          {status.repo.nameWithOwner}
        </p>
        <div role="group" aria-label={t.github.title} className="flex gap-0.5 rounded-md bg-void/40 p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => gh.setFilter(f)}
              className={cn('flex-1 whitespace-nowrap rounded-sm px-1 py-0.5 font-sans text-[11.5px] transition-colors', filter === f ? 'bg-elevated text-text-primary' : 'text-text-muted hover:text-text-primary')}
            >
              {t.github.filters[f]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5">
          <Select label={t.github.state} variant="quiet" value={state} onChange={(v) => gh.setState(v as PullListState)} options={STATES.map((s) => ({ value: s, label: t.github.states[s] }))} className="mr-auto" />
          <button type="button" aria-label={t.github.refresh} title={t.github.refresh} disabled={loading} onClick={() => void gh.list()} className={tool}>
            <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
          </button>
          <button type="button" aria-label={t.github.create} title={t.github.create} onClick={() => gh.setCreating(!creating)} className={tool}>
            <Plus size={13} />
          </button>
        </div>
      </div>
      {creating ? (
        <CreateForm />
      ) : (
        <ul aria-label={t.github.title} className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-2">
          {pulls.map((pr) => (
            <Item key={pr.number} pr={pr} active={detail?.number === pr.number} opening={opening === pr.number} />
          ))}
          {!loading && pulls.length === 0 && <li className="px-2 font-sans text-[12px] text-text-muted">{t.github.none}</li>}
        </ul>
      )}
    </div>
  )
}
