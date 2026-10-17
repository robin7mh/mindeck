import { useEffect } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, CloudCog, Languages, Loader2, LogOut, RefreshCw, Server, ShoppingCart, UserRound } from 'lucide-react'
import { offlineDaysLeft, type CloudLicense, type CloudStatus } from '@shared/types/cloud'
import { Panel } from '@/components/ui/Panel'
import { Card } from '@/components/ui/Card'
import { LanguageSwitch } from '@/components/ui/LanguageSwitch'
import { cn } from '@/lib/cn'
import { intlLocale, useT } from '@/lib/i18n'
import { useSession } from '@/features/session/store'
import { formatDuration, useCloud } from '@/features/cloud/store'
import { useUpdate } from '@/features/update/store'
import { CloudNotice, primaryButton, quietButton, SignInForm } from '@/features/cloud/components/CloudForms'
import { useSync } from '@/features/account/sync'

function TrialMeter({ license }: { license: CloudLicense }) {
  const t = useT()
  const used = Math.min(100, (license.trialUsedSeconds / Math.max(1, license.trialLimitSeconds)) * 100)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-1.5 overflow-hidden rounded-full bg-hud/60" role="progressbar" aria-valuenow={Math.round(used)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-cyan" style={{ width: `${used}%` }} />
      </div>
      <p className="font-mono text-[11px] text-text-muted">{t.cloud.trialLeft(formatDuration(license.trialRemainingSeconds))}</p>
    </div>
  )
}

/** The Mindeck account on this core: who is signed in, the license, and what to do next. */
function AccountCard({ status }: { status: CloudStatus }) {
  const t = useT()
  const busy = useCloud((s) => s.busy)
  const { account, license } = status
  if (!account) {
    return (
      <div className="flex flex-col gap-3">
        <SignInForm />
        {!status.enforced && <p className="font-sans text-[11.5px] text-text-muted">{t.cloud.devBuild}</p>}
      </div>
    )
  }
  const lifetime = license?.plan === 'lifetime'
  const cloud = useCloud.getState()
  const date = (iso: string) => new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium' }).format(new Date(iso))
  // Offline, the certificate holds longer than the lease (a year, renewed with every heartbeat).
  const offlineUntil = status.offlineUntil ?? status.validUntil
  const daysLeft = offlineDaysLeft(status)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-cyan/50 font-sans text-[15px] font-semibold uppercase text-cyan">
          {(account.name ?? account.email).charAt(0)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-sans text-[14px] font-medium text-text-primary">{account.name ?? account.email}</p>
          {account.name && <p className="truncate font-sans text-[12px] text-text-muted">{account.email}</p>}
        </div>
        {license && (
          <span
            className={cn(
              'shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wider',
              lifetime ? 'border-cyan/50 bg-cyan/8 text-cyan' : 'border-blue/50 bg-blue/8 text-blue'
            )}
          >
            {lifetime ? t.cloud.lifetime : t.cloud.trial}
          </span>
        )}
      </div>
      {license && !lifetime && <TrialMeter license={license} />}
      {lifetime && offlineUntil && <p className="font-mono text-[11px] text-text-muted">{t.cloud.offlineUntil(date(offlineUntil))}</p>}
      {daysLeft !== null && (
        <p role="status" className="rounded-md border border-amber/40 bg-amber/[0.06] p-2.5 font-sans text-[12px] text-amber">
          {t.cloud.offlineEnding(daysLeft, date(status.offlineUntil!))}
        </p>
      )}
      {status.state === 'license_suspended' && (
        <p role="status" className="rounded-md border border-amber/40 bg-amber/[0.06] p-2.5 font-sans text-[12px] text-amber">
          <span className="font-semibold">{t.cloud.suspendedTitle}.</span> {t.cloud.suspendedIntro}
        </p>
      )}
      <CloudNotice />
      <div className="flex flex-wrap gap-2">
        {!lifetime && (
          <button type="button" disabled={busy} onClick={() => void cloud.buy()} className={primaryButton}>
            <ShoppingCart size={14} /> {t.cloud.buy}
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => void cloud.refresh()} className={quietButton}>
          <RefreshCw size={13} /> {t.cloud.checkAgain}
        </button>
        <button type="button" disabled={busy} onClick={() => void cloud.logout()} className={quietButton}>
          <LogOut size={13} /> {t.cloud.signOut}
        </button>
      </div>
      {!status.enforced && <p className="font-sans text-[11.5px] text-text-muted">{t.cloud.devBuild}</p>}
    </div>
  )
}

/** Settings Sync: this Mindeck's settings ↔ the account (here, not in Settings — it belongs to the account). */
function SyncCard({ signedIn }: { signedIn: boolean }) {
  const t = useT()
  const { status, busy, conflict, done, error } = useSync()
  const sync = useSync.getState()
  useEffect(() => {
    if (signedIn) void useSync.getState().load()
  }, [signedIn])
  if (!signedIn) return <p className="font-sans text-[12px] text-text-muted">{t.sync.signIn}</p>
  const date = (iso: string) => new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
  const remote = status?.remote
  return (
    <div className="flex flex-col gap-3">
      <p className="font-sans text-[12px] text-text-secondary">{t.sync.hint}</p>
      {status && (
        <div className="space-y-0.5 font-mono text-[11px] text-text-muted">
          <p>{status.local ? t.sync.last(date(status.local.syncedAt)) : t.sync.never}</p>
          <p>{remote ? t.sync.remote(date(remote.updatedAt), remote.device) : t.sync.remoteNone}</p>
        </div>
      )}
      {conflict ? (
        <div role="alertdialog" aria-label={t.sync.conflict} className="space-y-2 rounded-md border border-amber/40 bg-amber/6 p-2.5">
          <p className="font-sans text-[12.5px] text-text-primary">{t.sync.conflict}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!!busy} onClick={() => void sync.pull()} className={cn(primaryButton, 'py-1.5!')}>
              <ArrowDownToLine size={13} /> {t.sync.takeTheirs}
            </button>
            <button type="button" disabled={!!busy} onClick={() => void sync.push(true)} className={cn(quietButton, 'py-1.5!')}>
              {t.sync.keepMine}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!!busy} title={t.sync.syncHint} onClick={() => void sync.sync()} className={primaryButton}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} {t.sync.sync}
          </button>
          <button type="button" disabled={!!busy} onClick={() => void sync.push()} className={quietButton}>
            <ArrowUpFromLine size={13} /> {t.sync.push}
          </button>
          <button type="button" disabled={!!busy || !remote} onClick={() => void sync.pull()} className={quietButton}>
            <ArrowDownToLine size={13} /> {t.sync.pull}
          </button>
        </div>
      )}
      {done && <p className="font-sans text-[12px] text-green">{done === 'pushed' ? t.sync.pushed : t.sync.pulled}</p>}
      {error && (
        <p role="alert" className="font-sans text-[12px] text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

/** The desktop app's own update: state, plus check / restart. */
function UpdateRow() {
  const t = useT()
  const status = useUpdate((s) => s.status)
  const error = useUpdate((s) => s.error)
  if (!status) return null
  const text =
    status.state === 'disabled'
      ? t.update.disabled
      : status.state === 'checking'
        ? t.update.checking
        : status.state === 'downloading'
          ? t.update.downloading(status.progress ?? 0)
          : status.state === 'ready'
            ? t.update.ready(status.version ?? '')
            : status.state === 'available'
              ? t.update.available(status.version ?? '')
            : status.state === 'error'
              ? t.update.error
              : t.update.idle
  const update = useUpdate.getState()
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-hud/50 pt-3">
      <span className="w-24 shrink-0 font-mono text-[11px] uppercase tracking-wider text-text-muted">{t.update.label}</span>
      <span className={cn('font-mono text-[12px]', status.state === 'error' ? 'text-danger' : 'text-text-secondary')}>{error ?? text}</span>
      {status.state === 'ready' ? (
        <button type="button" onClick={() => void update.install()} className={cn(primaryButton, 'ml-auto py-1.5!')}>
          {t.update.install}
        </button>
      ) : status.state === 'available' && status.downloadUrl ? (
        <a href={status.downloadUrl} target="_blank" rel="noreferrer" className={cn(primaryButton, 'ml-auto py-1.5!')}>
          {t.update.download}
        </a>
      ) : (
        status.state !== 'disabled' &&
        status.state !== 'downloading' && (
          <button type="button" disabled={status.state === 'checking'} onClick={() => void update.check()} className={cn(quietButton, 'ml-auto py-1.5!')}>
            {t.update.check}
          </button>
        )
      )}
    </div>
  )
}

/** Profile: the Mindeck account (license, trial), the UI language and the connected core. */
export function AccountView() {
  const t = useT()
  const info = useSession((s) => s.info)
  const cloud = useCloud((s) => s.status)
  const rows: [string, string][] = info
    ? [
        [t.account.mode, info.mode === 'desktop' ? t.account.desktop : t.account.server],
        [t.account.version, `v${info.version}`],
        [t.account.host, info.hostname]
      ]
    : []
  return (
    <Panel title={t.account.title} corners flush className="min-h-0 flex-1" bodyClassName="min-h-0 overflow-y-auto">
      <div className="grid gap-3 p-3 pane-lg:grid-cols-2">
        <Card icon={UserRound} title={t.account.accountCard}>
          {cloud ? <AccountCard status={cloud} /> : <p className="font-mono text-[11px] text-text-muted">{t.account.linking}</p>}
        </Card>

        <Card icon={CloudCog} title={t.sync.title}>
          <SyncCard signedIn={!!cloud?.account} />
        </Card>

        <Card icon={Languages} title={t.account.languageCard}>
          <LanguageSwitch />
          <p className="mt-2 font-sans text-[11.5px] text-text-muted">{t.account.languageHint}</p>
        </Card>

        <Card icon={Server} title={t.account.coreCard}>
          {info ? (
            <dl className="space-y-1">
              {rows.map(([k, v]) => (
                <div key={k} className="flex gap-3">
                  <dt className="w-24 shrink-0 font-mono text-[11px] uppercase tracking-wider text-text-muted">{k}</dt>
                  <dd className="flex min-w-0 items-center gap-1.5 wrap-break-word font-mono text-[12px] text-text-secondary">
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="font-mono text-[11px] text-text-muted">{t.account.linking}</p>
          )}
          <UpdateRow />
        </Card>
      </div>
    </Panel>
  )
}
