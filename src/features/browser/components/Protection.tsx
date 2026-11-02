import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ExternalLink, Film, KeyRound, Search, Shield, ShieldAlert, ShieldOff, VenetianMask, X } from 'lucide-react'
import type { BrowserAuthRequest, BrowserTab } from '@shared/types/browser'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useOverlay } from '@/lib/overlay'
import { useBrowser } from '../store'
import { hostOf } from '../url'

const NONE: BrowserAuthRequest[] = []

const button =
  'flex items-center gap-1.5 rounded-md border border-hud/60 px-3 py-1.5 font-sans text-[12.5px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan'
const small =
  'flex items-center gap-1 rounded-md border border-hud/60 px-2 py-0.5 font-sans text-[11.5px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan'

/** A private tab's new-tab page: what private means here — no history, no top sites. */
export function PrivateTabPage() {
  const t = useT()
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex max-w-xl flex-col items-center gap-4 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-purple/40 bg-purple/8 text-purple">
          <VenetianMask size={22} />
        </div>
        <h2 className="font-sans text-[16px] font-semibold text-text-primary">{t.browserExtras.privateTitle}</h2>
        <p className="font-sans text-[12.5px] text-text-secondary">{t.browserExtras.privateHint}</p>
        <button
          type="button"
          onClick={() => useBrowser.setState((s) => ({ focusTick: s.focusTick + 1 }))}
          className="flex w-full items-center gap-3 rounded-lg border border-hud/60 bg-surface/70 px-4 py-3 text-left transition-colors hover:border-purple/50"
        >
          <Search size={16} className="text-text-muted" />
          <span className="font-sans text-[14px] text-text-muted">{t.browser.ntpSearch}</span>
        </button>
      </div>
    </div>
  )
}

/** The shield in the address bar: how much was blocked on the page; a click opens its menu (on/off for the site). */
export function ShieldButton({ tab }: { tab: BrowserTab }) {
  const t = useT()
  const shield = tab.shield
  if (!shield) return null
  const label = shield.on ? t.browserExtras.shieldOn(shield.blocked) : t.browserExtras.shieldOff
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.preventDefault()} // the address bar keeps the focus
      onClick={() => void useBrowser.getState().run('browser:tool', { id: tab.id, tool: 'shield' })}
      className={cn('flex shrink-0 items-center gap-1 rounded-sm px-1 py-0.5 transition-colors hover:bg-elevated', shield.on ? 'text-cyan' : 'text-text-muted')}
    >
      {shield.on ? <Shield size={13} aria-hidden /> : <ShieldOff size={13} aria-hidden />}
      {shield.on && shield.blocked > 0 && <span className="font-mono text-[10.5px]">{shield.blocked > 999 ? '999+' : shield.blocked}</span>}
    </button>
  )
}

/** The page needs DRM, which Mindeck's Chromium lacks: say so and offer the system browser. */
export function DrmBar({ tab }: { tab: BrowserTab }) {
  const t = useT()
  const run = useBrowser((s) => s.run)
  if (!tab.drm) return null
  return (
    <div role="status" className="flex shrink-0 items-center gap-2 border-b border-amber/30 bg-amber/6 px-3 py-1.5">
      <Film size={14} className="shrink-0 text-amber" />
      <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-text-primary">{t.browserExtras.drm}</span>
      <button type="button" onClick={() => void run('browser:tool', { id: tab.id, tool: 'handoff' })} className={cn(small, 'border-cyan/50 text-cyan')}>
        <ExternalLink size={12} /> {t.browserExtras.drmOpen}
      </button>
      <button type="button" aria-label={t.common.dismiss} onClick={() => void run('browser:dismissDrm', { id: tab.id })} className="rounded-sm p-0.5 text-text-muted hover:text-text-primary">
        <X size={12} />
      </button>
    </div>
  )
}

/** Mindeck stopped a page on the malware list: back to safety, or — knowingly — on. */
export function DangerPage({ tab }: { tab: BrowserTab }) {
  const t = useT()
  const run = useBrowser((s) => s.run)
  const url = tab.error!.url
  const back = () => void (tab.canGoBack ? run('browser:go', { id: tab.id, action: 'back' }) : run('browser:close', { id: tab.id }))
  return (
    <div className="flex h-full items-center justify-center bg-danger/5 p-8">
      <div className="max-w-md text-center">
        <ShieldAlert size={32} className="mx-auto text-danger" />
        <h2 className="mt-3 font-sans text-[16px] font-semibold text-text-primary">{t.browserExtras.dangerTitle}</h2>
        <p className="mt-1.5 font-sans text-[13px] text-text-secondary">{t.browserExtras.dangerText(hostOf(url) || url)}</p>
        <p className="mt-1 break-all font-mono text-[11px] text-text-muted">{url}</p>
        <div className="mt-4 flex justify-center gap-2">
          <button type="button" onClick={back} className={cn(button, 'border-cyan/50 text-cyan')}>
            {t.browserExtras.goBack}
          </button>
          <button type="button" onClick={() => void run('browser:proceed', { id: tab.id })} className={cn(button, 'hover:border-danger/50 hover:text-danger')}>
            {t.browserExtras.proceed}
          </button>
        </div>
      </div>
    </div>
  )
}

function AuthForm({ req }: { req: BrowserAuthRequest }) {
  const t = useT()
  const run = useBrowser((s) => s.run)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const first = useRef<HTMLInputElement>(null)
  useOverlay(true)
  useEffect(() => first.current?.focus(), [])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run('browser:auth', { id: req.id, username, password })
  }
  const cancel = () => void run('browser:auth', { id: req.id })
  const field = 'mt-1 w-full rounded-md border border-hud/60 bg-surface/70 px-2 py-1.5 font-sans text-[12.5px] text-text-primary outline-hidden focus:border-cyan/60'
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-void/60 p-6">
      <form
        role="dialog"
        aria-label={t.browserExtras.authTitle}
        onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && cancel()}
        className="w-full max-w-sm rounded-lg border border-hud/70 bg-panel p-4 shadow-xl shadow-black/40"
      >
        <div className="flex items-center gap-2">
          <KeyRound size={15} className="text-cyan" />
          <h2 className="font-sans text-[14px] font-semibold text-text-primary">{t.browserExtras.authTitle}</h2>
        </div>
        <p className="mt-1.5 font-sans text-[12.5px] text-text-secondary">{req.isProxy ? t.browserExtras.authProxy(req.host) : t.browserExtras.authSite(req.host)}</p>
        {req.realm && <p className="mt-0.5 truncate font-mono text-[11px] text-text-muted">{req.realm}</p>}
        <label className="mt-3 block font-sans text-[11.5px] text-text-secondary">
          {t.browserExtras.username}
          <input ref={first} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className={field} />
        </label>
        <label className="mt-2 block font-sans text-[11.5px] text-text-secondary">
          {t.browserExtras.password}
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={cancel} className={button}>
            {t.common.cancel}
          </button>
          <button type="submit" className={cn(button, 'border-cyan/50 text-cyan')}>
            {t.browserExtras.signIn}
          </button>
        </div>
      </form>
    </div>
  )
}

/** A server's login question (HTTP authentication) for the tab on screen — or for a popup window. */
export function AuthDialog({ tabId }: { tabId?: string }) {
  const requests = useBrowser((s) => s.state.auth ?? NONE)
  const req = requests.find((r) => !r.tabId || r.tabId === tabId)
  return req ? <AuthForm key={req.id} req={req} /> : null
}
