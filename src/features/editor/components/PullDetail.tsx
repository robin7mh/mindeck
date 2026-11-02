import { useState, type ReactNode } from 'react'
import { CircleCheck, CircleDashed, CircleMinus, CircleX, ExternalLink, FileDiff, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, Loader2, X } from 'lucide-react'
import type { CheckState, MergeMethod, PullDetail as Detail } from '@shared/types/github'
import { cn } from '@/lib/cn'
import { intlLocale, useT } from '@/lib/i18n'
import { Select } from '@/components/ui/Select'
import { Markdown as Prose } from '@/components/ui/Markdown'
import { useGitHub } from '../github'

const button = 'flex items-center gap-1 rounded-sm border px-2 py-0.5 font-sans text-[12px] transition-colors disabled:opacity-40'
const CHECK_ICON: Record<CheckState, { Icon: typeof CircleCheck; tint: string }> = {
  success: { Icon: CircleCheck, tint: 'text-green' },
  failure: { Icon: CircleX, tint: 'text-danger' },
  pending: { Icon: CircleDashed, tint: 'text-amber' },
  neutral: { Icon: CircleMinus, tint: 'text-text-muted' },
  skipped: { Icon: CircleMinus, tint: 'text-text-muted' }
}
const METHODS: MergeMethod[] = ['merge', 'squash', 'rebase']

function Markdown({ text }: { text: string }) {
  return <Prose text={text} className="chat-prose font-sans text-[12.5px]" />
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-1.5">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">{title}</h3>
      {children}
    </section>
  )
}

const when = (iso: string) => new Date(iso).toLocaleString(intlLocale())

/** Comment, approve or ask for changes. */
function Respond() {
  const t = useT()
  const busy = useGitHub((s) => s.busy)
  const [text, setText] = useState('')
  const send = async (fn: () => Promise<boolean>) => {
    if (await fn()) setText('')
  }
  const gh = useGitHub.getState()
  return (
    <div className="space-y-1.5">
      <textarea aria-label={t.github.comment} placeholder={t.github.commentPlaceholder} value={text} onChange={(e) => setText(e.target.value)} rows={4} className="w-full resize-y rounded-md border border-hud/60 bg-void/40 px-2 py-1 font-mono text-[12px] text-text-primary outline-hidden focus:border-cyan/60" />
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={!text.trim() || !!busy} onClick={() => void send(() => gh.comment(text))} className={cn(button, 'border-hud/60 text-text-secondary hover:text-text-primary')}>
          {busy === 'comment' && <Loader2 size={11} className="animate-spin" />}
          {t.github.comment}
        </button>
        <button type="button" disabled={!!busy} onClick={() => void send(() => gh.review('approve', text))} className={cn(button, 'border-green/50 text-green hover:bg-green/10')}>
          {t.github.approve}
        </button>
        <button type="button" disabled={!text.trim() || !!busy} onClick={() => void send(() => gh.review('request-changes', text))} className={cn(button, 'border-amber/50 text-amber hover:bg-amber/10')}>
          {t.github.requestChanges}
        </button>
      </div>
    </div>
  )
}

function Merge({ pr }: { pr: Detail }) {
  const t = useT()
  const busy = useGitHub((s) => s.busy)
  const [method, setMethod] = useState<MergeMethod>('merge')
  const [deleteBranch, setDeleteBranch] = useState(false)
  const conflicting = pr.mergeable === 'CONFLICTING'
  return (
    <div className="space-y-1.5 rounded-md border border-hud/60 p-2">
      {conflicting && <p className="font-sans text-[12px] text-amber">{t.github.conflicts}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Select label={t.github.merge} variant="quiet" value={method} onChange={(v) => setMethod(v as MergeMethod)} options={METHODS.map((m) => ({ value: m, label: t.github.mergeMethods[m] }))} />
        <label className="flex items-center gap-1.5 font-sans text-[12px] text-text-secondary">
          <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} /> {t.github.deleteBranch}
        </label>
        <button type="button" disabled={conflicting || !!busy} onClick={() => void useGitHub.getState().merge(method, deleteBranch)} className={cn(button, 'ml-auto border-purple/50 text-purple hover:bg-purple/10')}>
          {busy === 'merge' ? <Loader2 size={11} className="animate-spin" /> : <GitMerge size={12} />}
          {t.github.merge}
        </button>
      </div>
    </div>
  )
}

/** A pull request in the editor area: description, checks, files (as diffs), commits, conversation — and what to do with it. */
export function PullDetail() {
  const t = useT()
  const pr = useGitHub((s) => s.detail)
  const busy = useGitHub((s) => s.busy)
  const gh = useGitHub.getState()
  if (!pr) return null
  const open = pr.state === 'OPEN'
  const tint = pr.state === 'MERGED' ? 'bg-purple/15 text-purple' : pr.state === 'CLOSED' ? 'bg-danger/15 text-danger' : 'bg-green/15 text-green'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-start gap-2 border-b border-hud/60 px-4 py-2.5">
        <GitPullRequest size={16} className="mt-0.5 shrink-0 text-cyan" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-sans text-[14px] text-text-primary">
            {pr.title} <span className="text-text-muted">#{pr.number}</span>
          </h2>
          <p className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-text-muted">
            <span className={cn('rounded-sm px-1.5 font-sans', tint)}>{t.github.prState[pr.state]}</span>
            {pr.draft && <span className="rounded-sm bg-elevated px-1.5 font-sans">{t.github.draft}</span>}
            <span>{pr.author}</span>
            <span className="flex items-center gap-1">
              <GitBranch size={11} /> {t.github.into(pr.head, pr.base)}
            </span>
            <span className="text-green">+{pr.additions}</span>
            <span className="text-danger">−{pr.deletions}</span>
            {pr.labels.map((l) => (
              <span key={l} className="rounded-sm bg-cyan/10 px-1.5 font-sans text-cyan">
                {l}
              </span>
            ))}
          </p>
        </div>
        {open && (
          <button type="button" disabled={!!busy} onClick={() => void gh.checkout()} className={cn(button, 'border-hud/60 text-text-secondary hover:text-text-primary')}>
            {busy === 'checkout' && <Loader2 size={11} className="animate-spin" />}
            {t.github.checkout}
          </button>
        )}
        <a href={pr.url} target="_blank" rel="noreferrer" aria-label={t.github.openOnGitHub} title={t.github.openOnGitHub} className="flex h-6 w-6 items-center justify-center rounded-sm text-text-muted hover:bg-elevated hover:text-text-primary">
          <ExternalLink size={13} />
        </a>
        <button type="button" aria-label={t.github.close} title={t.github.close} onClick={() => gh.close()} className="flex h-6 w-6 items-center justify-center rounded-sm text-text-muted hover:bg-elevated hover:text-text-primary">
          <X size={14} />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-3">
        <Section title={t.github.description}>{pr.body.trim() ? <Markdown text={pr.body} /> : <p className="font-sans text-[12px] text-text-muted">{t.github.noDescription}</p>}</Section>

        {pr.checks.length > 0 && (
          <Section title={t.github.checks}>
            <ul className="space-y-0.5">
              {pr.checks.map((c, i) => {
                const { Icon, tint: color } = CHECK_ICON[c.state]
                return (
                  <li key={`${c.name}-${i}`} className="flex items-center gap-1.5 font-sans text-[12px] text-text-secondary">
                    <Icon size={13} className={cn('shrink-0', color)} aria-label={t.github.checkStates[c.state]} />
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer" className="truncate hover:text-cyan hover:underline">
                        {c.name}
                      </a>
                    ) : (
                      <span className="truncate">{c.name}</span>
                    )}
                  </li>
                )
              })}
            </ul>
          </Section>
        )}

        <Section title={t.github.files(pr.changedFiles)}>
          {pr.files.length < pr.changedFiles && (
            <p className="font-sans text-[11.5px] text-text-muted">
              {t.github.firstFiles(pr.files.length)}{' '}
              <a href={`${pr.url}/files`} target="_blank" rel="noreferrer" className="text-cyan hover:underline">
                {t.github.openOnGitHub}
              </a>
            </p>
          )}
          <ul className="space-y-0.5">
            {pr.files.map((f) => (
              <li key={f.path}>
                <button type="button" onClick={() => void gh.openFile(f.path)} className="flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left font-mono text-[11.5px] text-text-secondary hover:bg-elevated/60 hover:text-text-primary">
                  <FileDiff size={12} className="shrink-0 text-text-muted" />
                  <span className="min-w-0 flex-1 truncate">{f.path}</span>
                  <span className="text-green">+{f.additions}</span>
                  <span className="text-danger">−{f.deletions}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>

        <Section title={t.github.commits(pr.commits.length)}>
          <ul className="space-y-0.5">
            {pr.commits.map((c) => (
              <li key={c.oid} className="flex items-center gap-1.5 font-sans text-[12px] text-text-secondary">
                <GitCommitHorizontal size={12} className="shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1 truncate">{c.headline}</span>
                <span className="font-mono text-[10.5px] text-text-muted">
                  {c.oid.slice(0, 7)} · {c.author}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title={t.github.activity}>
          <ul className="space-y-2">
            {pr.events.map((e, i) => (
              <li key={i} className="rounded-md border border-hud/50 px-2.5 py-1.5">
                <p className="font-sans text-[11.5px] text-text-muted">
                  <span className="text-text-primary">{e.author}</span> {t.github.events[e.kind]} · {when(e.at)}
                </p>
                {e.body.trim() && <Markdown text={e.body} />}
              </li>
            ))}
          </ul>
          {open && <Respond />}
        </Section>

        {open && !pr.draft && <Merge pr={pr} />}
      </div>
    </div>
  )
}
