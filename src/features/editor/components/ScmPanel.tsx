import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, Check, CheckCheck, CircleStop, CloudUpload, FileCode2, GitBranch, GitBranchPlus, GitPullRequestCreate, Loader2, Minus, Play, Plus, RefreshCcw, Undo2, X } from 'lucide-react'
import type { ScmChange, ScmFile, ScmStatus } from '@shared/types/scm'
import { Select } from '@/components/ui/Select'
import { TechLabel } from '@/components/ui/TechLabel'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useEditor } from '../store'
import { needsPublish, useScm } from '../scm'
import { useGitHub } from '../github'
import { PublishForm } from './PublishForm'
import { StashSection } from './StashSection'

const LETTER: Record<ScmChange, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflicted: '!' }
const TONE: Record<ScmChange, string> = {
  modified: 'text-amber',
  added: 'text-green',
  deleted: 'text-danger',
  renamed: 'text-blue',
  copied: 'text-blue',
  untracked: 'text-green',
  conflicted: 'text-danger'
}

const icon = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-elevated hover:text-text-primary disabled:opacity-40'
const syncButton =
  'flex flex-1 items-center justify-center gap-1 rounded-md border border-hud/60 px-2 py-1 font-sans text-[11.5px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan disabled:opacity-40'

type Section = 'conflicts' | 'staged' | 'changes'

function FileRow({ file, section, onDiscard }: { file: ScmFile; section: Section; onDiscard: (paths: string[], name: string) => void }) {
  const t = useT()
  const { stage, unstage, openDiff, busy } = useScm.getState()
  const change = (section === 'staged' ? file.staged : file.unstaged)!
  const name = file.path.slice(file.path.lastIndexOf('/') + 1)
  const dir = file.path.slice(0, file.path.length - name.length - 1)
  const target = section === 'staged' ? ({ kind: 'staged' } as const) : ({ kind: 'unstaged' } as const)
  const where = section === 'staged' ? t.scm.index : t.scm.workingTree
  // A conflicted file opens in the editor — its conflicts are resolved there.
  const show = () => (section === 'conflicts' ? openFile(file.path) : openDiff(file, target, `${name} (${where})`))
  return (
    <li className="group flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 hover:bg-elevated/50">
      <button
        type="button"
        title={`${file.path} · ${t.scm.change[change]}`}
        onClick={() => void show()}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <span className="min-w-0 truncate font-sans text-[12.5px] text-text-primary">{name}</span>
        {dir && <span className="min-w-0 truncate font-mono text-[10.5px] text-text-muted">{dir}</span>}
      </button>
      <span className="hidden items-center group-hover:flex">
        <button type="button" aria-label={`${t.scm.openFile}: ${file.path}`} title={t.scm.openFile} className={icon} onClick={() => void openFile(file.path)}>
          <FileCode2 size={13} />
        </button>
        {section !== 'staged' && (
          <button type="button" aria-label={`${t.scm.discard}: ${file.path}`} title={t.scm.discard} className={icon} disabled={!!busy} onClick={() => onDiscard([file.path], name)}>
            <Undo2 size={13} />
          </button>
        )}
        {section === 'staged' ? (
          <button type="button" aria-label={`${t.scm.unstage}: ${file.path}`} title={t.scm.unstage} className={icon} disabled={!!busy} onClick={() => void unstage([file.path])}>
            <Minus size={13} />
          </button>
        ) : section === 'conflicts' ? (
          <button type="button" aria-label={`${t.conflicts.markResolved}: ${file.path}`} title={t.conflicts.markResolved} className={icon} disabled={!!busy} onClick={() => void stage([file.path])}>
            <CheckCheck size={13} />
          </button>
        ) : (
          <button type="button" aria-label={`${t.scm.stage}: ${file.path}`} title={t.scm.stage} className={icon} disabled={!!busy} onClick={() => void stage([file.path])}>
            <Plus size={13} />
          </button>
        )}
      </span>
      <span className={cn('w-3 shrink-0 text-center font-mono text-[11px] font-semibold', TONE[change])}>{LETTER[change]}</span>
    </li>
  )
}

/** A file from the panel, as a normal editor tab (the diff closes). */
async function openFile(path: string) {
  useScm.getState().closeDiff()
  await useEditor.getState().open(path)
}

function Group({ title, files, section, actions, onDiscard }: { title: string; files: ScmFile[]; section: Section; actions: ReactNode; onDiscard: (paths: string[], name: string) => void }) {
  if (!files.length) return null
  return (
    <section className="mt-2">
      <div className="group flex items-center gap-1 px-1.5 py-1">
        <TechLabel className="flex-1 text-text-muted">
          {title} <span className="ml-1 font-mono">{files.length}</span>
        </TechLabel>
        <span className="flex items-center">{actions}</span>
      </div>
      <ul>
        {files.map((f) => (
          <FileRow key={`${section}:${f.path}`} file={f} section={section} onDiscard={onDiscard} />
        ))}
      </ul>
    </section>
  )
}

/** A merge / rebase / cherry-pick / revert that stopped: what it is, abort (asks first), continue once resolved. */
function OperationBanner({ status, readOnly }: { status: ScmStatus; readOnly: boolean }) {
  const t = useT()
  const busy = useScm((s) => s.busy)
  const [confirm, setConfirm] = useState(false)
  const op = status.operation!
  const conflicts = status.files.filter((f) => f.unstaged === 'conflicted').length
  const label = op.kind === 'rebase' && op.step && op.total ? `${t.operation.kinds.rebase} ${op.step}/${op.total}` : t.operation.kinds[op.kind]
  return (
    <div role="status" className="mb-2 space-y-1.5 rounded-md border border-amber/40 bg-amber/[0.07] px-2 py-1.5">
      <p className="font-sans text-[11.5px] text-text-primary">
        <span className="font-semibold">{label}</span> · {conflicts ? t.operation.conflicts(conflicts) : t.operation.resolved}
      </p>
      {!readOnly &&
        (confirm ? (
          <div className="flex items-center gap-1.5">
            <span className="flex-1 font-sans text-[11px] text-text-secondary">{t.operation.confirmAbort}</span>
            <button
              type="button"
              className={cn(syncButton, 'flex-none border-danger/50 text-danger hover:border-danger hover:text-danger')}
              onClick={() => {
                setConfirm(false)
                void useScm.getState().abortOperation()
              }}
            >
              {t.operation.abort}
            </button>
            <button type="button" className={cn(syncButton, 'flex-none')} onClick={() => setConfirm(false)}>
              {t.common.cancel}
            </button>
          </div>
        ) : (
          <div className="flex gap-1.5">
            <button type="button" className={syncButton} disabled={!!busy} onClick={() => setConfirm(true)}>
              <CircleStop size={12} /> {t.operation.abort}
            </button>
            <button type="button" className={syncButton} disabled={!!busy || conflicts > 0} title={conflicts ? t.operation.resolveFirst : undefined} onClick={() => void useScm.getState().continueOperation()}>
              {busy === 'continue' ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} {t.operation.continue}
            </button>
          </div>
        ))}
    </div>
  )
}

/**
 * VS Code's Source Control view: branch, pull / push / fetch, the commit box
 * and the changes — staged, unstaged and conflicts — with stage, unstage,
 * discard and a diff on click; a merge or rebase in progress (abort /
 * continue) and the stashes. Everything runs on the user's own git.
 */
export function ScmPanel({ readOnly = false }: { readOnly?: boolean }) {
  const t = useT()
  const { status, branches, busy, message, amend } = useScm()
  const publishing = useGitHub((s) => s.publishing)
  const [naming, setNaming] = useState(false)
  const [branchName, setBranchName] = useState('')
  const [confirm, setConfirm] = useState<{ paths: string[]; name: string }>()
  const scm = useScm.getState()

  if (!status) return <p className="p-3 font-mono text-[11px] text-text-muted">{t.common.loading}</p>
  if (!status.repo) {
    return (
      <div className="space-y-3 p-3">
        <p className="font-sans text-[12.5px] text-text-secondary">{t.scm.notRepo}</p>
        <button type="button" className={syncButton} disabled={!!busy} onClick={() => void scm.init()}>
          <GitBranch size={13} /> {t.scm.init}
        </button>
      </div>
    )
  }

  const conflicts = status.files.filter((f) => f.unstaged === 'conflicted')
  const staged = status.files.filter((f) => f.staged)
  const changes = status.files.filter((f) => f.unstaged && f.unstaged !== 'conflicted')
  const local = branches.filter((b) => !b.remote)
  const remoteOnly = branches.filter((b) => b.remote && !local.some((l) => b.name.endsWith(`/${l.name}`)))
  const options = [
    // Before the first commit the branch is no ref yet: git lists nothing, but HEAD is on it.
    ...(status.branch && !status.head ? [{ value: status.branch, label: status.branch, hint: t.scm.unborn }] : []),
    ...local.map((b) => ({ value: b.name, label: b.name, hint: b.upstream })),
    ...remoteOnly.map((b) => ({ value: b.name, label: b.name, hint: t.scm.remote }))
  ]
  const canCommit = !busy && (message.trim() !== '' || amend) && (status.files.length > 0 || amend)
  const ask = (paths: string[], name: string) => setConfirm({ paths, name })

  const createBranch = () => {
    const name = branchName.trim()
    if (!name) return
    setNaming(false)
    setBranchName('')
    void scm.createBranch(name)
  }
  const onMessageKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCommit) {
      e.preventDefault()
      void scm.commit()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-hud/50 p-2">
        <div className="flex items-center gap-1.5">
          <Select
            label={t.scm.branch}
            icon={GitBranch}
            value={status.branch ?? ''}
            placeholder={status.head ? `${status.head} (${t.scm.detached})` : t.scm.detached}
            options={options}
            onChange={(name) => void scm.checkout(name)}
            className="flex-1"
          />
          <button type="button" aria-label={t.scm.newBranch} title={t.scm.newBranch} className={cn(icon, 'h-8 w-8')} onClick={() => setNaming((v) => !v)}>
            <GitBranchPlus size={14} />
          </button>
        </div>
        {naming && (
          <div className="flex gap-1.5">
            <input
              autoFocus
              aria-label={t.scm.branchName}
              placeholder={t.scm.branchName}
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createBranch()
                if (e.key === 'Escape') setNaming(false)
              }}
              className="min-w-0 flex-1 rounded-md border border-hud/60 bg-surface/50 px-2 py-1 font-mono text-[12px] text-text-primary outline-hidden focus:border-cyan/50"
            />
            <button type="button" className={syncButton} disabled={!branchName.trim()} onClick={createBranch}>
              {t.scm.create}
            </button>
          </div>
        )}
        <div className="flex gap-1.5">
          <button type="button" className={syncButton} disabled={!!busy} onClick={() => void scm.pull()} title={t.scm.pull}>
            {busy === 'pull' ? <Loader2 size={12} className="animate-spin" /> : <ArrowDownToLine size={12} />} {t.scm.pull}
            {status.behind > 0 && <span className="font-mono">{status.behind}</span>}
          </button>
          {needsPublish(status) ? (
            <button type="button" className={syncButton} disabled={!!busy} aria-expanded={publishing} onClick={() => useGitHub.getState().setPublishing(!publishing)}>
              <CloudUpload size={12} /> {t.scm.publishGitHub}
            </button>
          ) : (
            <button type="button" className={syncButton} disabled={!!busy} onClick={() => void scm.push()} title={status.upstream ? t.scm.push : t.scm.publish}>
              {busy === 'push' ? <Loader2 size={12} className="animate-spin" /> : <ArrowUpFromLine size={12} />} {status.upstream ? t.scm.push : t.scm.publish}
              {status.ahead > 0 && <span className="font-mono">{status.ahead}</span>}
            </button>
          )}
          <button type="button" aria-label={t.scm.fetch} title={t.scm.fetch} className={cn(syncButton, 'flex-none px-2')} disabled={!!busy} onClick={() => void scm.fetch()}>
            <RefreshCcw size={12} className={cn(busy === 'fetch' && 'animate-spin')} />
          </button>
          {status.branch && (
            <button
              type="button"
              aria-label={t.github.create}
              title={t.github.create}
              className={cn(syncButton, 'flex-none px-2')}
              onClick={() => {
                scm.setPane('prs')
                useGitHub.getState().setCreating(true)
              }}
            >
              <GitPullRequestCreate size={12} />
            </button>
          )}
        </div>
        {publishing && <PublishForm status={status} />}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {status.operation && <OperationBanner status={status} readOnly={readOnly} />}
        <textarea
          aria-label={t.scm.message}
          placeholder={t.scm.message}
          value={message}
          rows={3}
          onChange={(e) => scm.setMessage(e.target.value)}
          onKeyDown={onMessageKey}
          className="w-full resize-y rounded-md border border-hud/60 bg-surface/50 px-2 py-1.5 font-sans text-[12.5px] text-text-primary outline-hidden placeholder:text-text-muted focus:border-cyan/50"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            disabled={!canCommit}
            onClick={() => void scm.commit()}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-cyan/50 bg-cyan/[0.1] px-2 py-1.5 font-sans text-[12px] font-medium text-cyan transition-colors hover:bg-cyan/16 disabled:opacity-40"
          >
            {busy === 'commit' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {staged.length || amend ? t.scm.commit : t.scm.commitAll}
          </button>
          <label className="flex items-center gap-1 font-sans text-[11px] text-text-muted" title={t.scm.amend}>
            <input type="checkbox" aria-label={t.scm.amend} checked={amend} onChange={(e) => scm.setAmend(e.target.checked)} className="accent-cyan" />
            amend
          </label>
        </div>

        {confirm && (
          <div role="alertdialog" className="mt-2 space-y-1.5 rounded-md border border-danger/40 bg-danger/6 p-2">
            <p className="font-sans text-[11.5px] text-text-primary">{t.scm.confirmDiscard(confirm.name)}</p>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setConfirm(undefined)
                  void scm.discard(confirm.paths)
                }}
                className="flex-1 rounded-md border border-danger/50 px-2 py-1 font-sans text-[11.5px] text-danger hover:bg-danger/10"
              >
                {t.scm.discard}
              </button>
              <button type="button" onClick={() => setConfirm(undefined)} className="flex-1 rounded-md border border-hud/60 px-2 py-1 font-sans text-[11.5px] text-text-secondary">
                {t.common.cancel}
              </button>
            </div>
          </div>
        )}

        {!status.files.length && <p className="mt-3 px-1 font-sans text-[12px] text-text-muted">{t.scm.clean}</p>}
        <Group title={t.scm.conflicts} files={conflicts} section="conflicts" onDiscard={ask} actions={null} />
        <Group
          title={t.scm.staged}
          files={staged}
          section="staged"
          onDiscard={ask}
          actions={
            <button type="button" aria-label={t.scm.unstageAll} title={t.scm.unstageAll} className={icon} disabled={!!busy} onClick={() => void scm.unstage(staged.map((f) => f.path))}>
              <Minus size={13} />
            </button>
          }
        />
        <Group
          title={t.scm.changes}
          files={changes}
          section="changes"
          onDiscard={ask}
          actions={
            <>
              <button type="button" aria-label={t.scm.discardAll} title={t.scm.discardAll} className={icon} disabled={!!busy} onClick={() => ask(changes.map((f) => f.path), t.scm.allChanges)}>
                <Undo2 size={13} />
              </button>
              <button type="button" aria-label={t.scm.stageAll} title={t.scm.stageAll} className={icon} disabled={!!busy} onClick={() => void scm.stage(changes.map((f) => f.path))}>
                <Plus size={13} />
              </button>
            </>
          }
        />
        <StashSection readOnly={readOnly} />
      </div>
    </div>
  )
}

/** The diff the panel (or the graph) opened, in place of the editor. */
export function DiffHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const t = useT()
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hud/60 px-3">
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-primary">{title}</span>
      <button type="button" aria-label={t.scm.closeDiff} title={t.scm.closeDiff} onClick={onClose} className={icon}>
        <X size={14} />
      </button>
    </div>
  )
}
