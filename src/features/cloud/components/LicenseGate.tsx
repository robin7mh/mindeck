import { useEffect, useState, type ReactNode } from 'react'
import { CirclePause, Hourglass, Loader2, LogOut, MailCheck, RefreshCw, ShoppingCart, UserRound, WifiOff } from 'lucide-react'
import type { CloudStatus } from '@shared/types/cloud'
import { Panel } from '@/components/ui/Panel'
import { TechLabel } from '@/components/ui/TechLabel'
import { MindeckMark } from '@/components/brand/MindeckMark'
import { GlowBackground } from '@/components/shell/GlowBackground'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useOverlay } from '@/lib/overlay'
import { useCloud } from '../store'
import { CloudNotice, primaryButton, quietButton, SignInForm } from './CloudForms'

function Frame({ children, overlay }: { children: ReactNode; overlay?: boolean }) {
  const t = useT()
  // Covering the app: the browser's page must not show through.
  useOverlay(!!overlay)
  return (
    <div
      className={cn(
        'flex h-screen w-screen items-center justify-center overflow-hidden p-4',
        overlay ? 'fixed inset-0 z-200 bg-void/85 backdrop-blur-xs' : 'relative'
      )}
    >
      {!overlay && <GlowBackground />}
      <div className="relative z-10 w-full max-w-md">
        <div className="mb-5 flex items-center justify-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center">
            <MindeckMark size={26} className="drop-shadow-[0_0_8px_rgba(56,214,232,0.45)]" />
          </div>
          <div className="leading-none">
            <div className="font-sans text-[15px] font-semibold tracking-wide text-text-primary">Mindeck</div>
            <TechLabel className="text-text-muted">{t.cloud.frame}</TechLabel>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}

function Checking() {
  const t = useT()
  return (
    <div className="flex items-center justify-center gap-2 font-mono text-[12px] text-text-muted">
      <Loader2 size={14} className="animate-spin text-cyan" /> {t.cloud.checking}
    </div>
  )
}

/** One state of a signed-in account that keeps Mindeck locked, with what the user can do about it. */
function Locked({
  icon: Icon,
  title,
  intro,
  email,
  primary,
  secondary
}: {
  icon: typeof WifiOff
  title: string
  intro: string
  email?: string
  primary: { label: string; icon: typeof WifiOff; run: () => void }
  secondary?: { label: string; run: () => void }
}) {
  const t = useT()
  const busy = useCloud((s) => s.busy)
  const checkoutUrl = useCloud((s) => s.checkoutUrl)
  const Primary = primary.icon
  return (
    <Panel title={title} corners>
      <div className="flex flex-col gap-3.5 py-1">
        <div className="flex items-start gap-3">
          <Icon size={22} className="mt-0.5 shrink-0 text-cyan" />
          <p className="font-sans text-[13px] leading-relaxed text-text-secondary">{intro}</p>
        </div>
        <CloudNotice />
        {checkoutUrl && Icon === Hourglass && (
          <a href={checkoutUrl} target="_blank" rel="noreferrer" className="font-sans text-[12px] text-cyan underline-offset-2 hover:underline">
            {t.cloud.openCheckout}
          </a>
        )}
        <button type="button" disabled={busy} onClick={primary.run} className={primaryButton}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Primary size={14} />}
          {primary.label}
        </button>
        <div className="flex flex-wrap gap-2">
          {secondary && (
            <button type="button" disabled={busy} onClick={secondary.run} className={cn(quietButton, 'flex-1')}>
              {secondary.label}
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void useCloud.getState().logout()} className={cn(quietButton, 'flex-1')}>
            <LogOut size={13} /> {t.cloud.signOut}
          </button>
        </div>
        {email && (
          <p className="flex items-center justify-center gap-1.5 font-mono text-[11px] text-text-muted">
            <UserRound size={12} /> {email}
          </p>
        )}
      </div>
    </Panel>
  )
}

/** What Mindeck shows instead of the app while it is not licensed. */
export function CloudScreen({ status, overlay }: { status: CloudStatus; overlay?: boolean }) {
  const t = useT()
  const cloud = useCloud.getState()
  const refresh = () => void cloud.refresh()
  let body: ReactNode
  if (status.state === 'signed_out') {
    body = (
      <Panel title={t.cloud.signInTitle} corners>
        <SignInForm />
      </Panel>
    )
  } else if (status.state === 'offline') {
    body = (
      <Locked
        icon={WifiOff}
        title={t.cloud.offlineTitle}
        intro={t.cloud.offlineIntro}
        email={status.account?.email}
        primary={{ label: t.cloud.checkAgain, icon: RefreshCw, run: refresh }}
      />
    )
  } else if (status.state === 'email_unverified') {
    body = (
      <Locked
        icon={MailCheck}
        title={t.cloud.verifyTitle}
        intro={t.cloud.verifyIntro(status.account?.email ?? '')}
        email={status.account?.email}
        primary={{ label: t.cloud.checkAgain, icon: RefreshCw, run: refresh }}
        secondary={{ label: t.cloud.resend, run: () => void cloud.resend() }}
      />
    )
  } else if (status.state === 'license_suspended') {
    // A disputed payment (chargeback): nothing to buy — the dispute has to be closed.
    body = (
      <Locked
        icon={CirclePause}
        title={t.cloud.suspendedTitle}
        intro={t.cloud.suspendedIntro}
        email={status.account?.email}
        primary={{ label: t.cloud.checkAgain, icon: RefreshCw, run: refresh }}
      />
    )
  } else if (status.state === 'trial_expired') {
    body = (
      <Locked
        icon={Hourglass}
        title={t.cloud.expiredTitle}
        intro={t.cloud.expiredIntro}
        email={status.account?.email}
        primary={{ label: t.cloud.buy, icon: ShoppingCart, run: () => void cloud.buy() }}
        secondary={{ label: t.cloud.checkAgain, run: refresh }}
      />
    )
  } else {
    body = <Checking />
  }
  return <Frame overlay={overlay}>{body}</Frame>
}

/**
 * Renders the app once Mindeck may run (always in dev builds). Before that it
 * shows sign-in / trial / purchase screens. If the license ends while the
 * app is open, the screen covers it instead of unmounting it, so open files
 * and terminals survive until the license is back.
 */
export function LicenseGate({ children }: { children: ReactNode }) {
  const status = useCloud((s) => s.status)
  const loadError = useCloud((s) => s.loadError)
  const [opened, setOpened] = useState(false)

  useEffect(() => useCloud.getState().connect(), [])
  useEffect(() => {
    if (status?.allowed) setOpened(true)
  }, [status?.allowed])

  if (status && (status.allowed || opened)) {
    const locked = !status.allowed
    // The same tree whether locked or not: React keeps the app (and its state) mounted.
    // `inert` takes the covered app out of reach of mouse, keyboard and screen readers.
    return (
      <>
        <div className="contents" {...(locked ? { inert: '' } : {})}>
          {children}
        </div>
        {locked && <CloudScreen status={status} overlay />}
      </>
    )
  }
  if (status) return <CloudScreen status={status} />
  return <Frame>{loadError ? <LoadFailed error={loadError} /> : <Checking />}</Frame>
}

/** The core did not answer the status question (rare: it is the same process on desktop). */
function LoadFailed({ error }: { error: string }) {
  const t = useT()
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <p className="font-mono text-[11px] text-danger">{error}</p>
      <button type="button" onClick={() => void useCloud.getState().load()} className={quietButton}>
        <RefreshCw size={13} /> {t.common.retry}
      </button>
    </div>
  )
}
