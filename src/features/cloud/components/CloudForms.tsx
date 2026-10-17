import { useState, type FormEvent, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { TechLabel } from '@/components/ui/TechLabel'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useCloud } from '../store'

const input =
  'rounded-md border border-hud/70 bg-surface/70 px-3 py-2 font-sans text-[13px] text-text-primary outline-hidden placeholder:text-text-muted/60 focus:border-cyan/60'

export const primaryButton =
  'flex items-center justify-center gap-2 rounded-md border border-cyan/50 bg-cyan/[0.10] px-3 py-2 font-sans text-[13px] font-medium text-cyan transition-colors hover:bg-cyan/16 disabled:cursor-not-allowed disabled:opacity-40'

export const quietButton =
  'flex items-center justify-center gap-2 rounded-md border border-hud/70 px-3 py-2 font-sans text-[12.5px] text-text-secondary transition-colors hover:border-cyan/40 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40'

const linkButton = 'font-sans text-[12px] text-text-muted underline-offset-2 hover:text-cyan hover:underline'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <TechLabel className="text-text-muted">{label}</TechLabel>
      {children}
    </label>
  )
}

/** Result of the last account action (error in red, confirmation in cyan). */
export function CloudNotice() {
  const message = useCloud((s) => s.message)
  const statusError = useCloud((s) => s.status?.error)
  const webUrl = useCloud((s) => s.status?.webUrl)
  const t = useT()
  if (message) {
    return (
      <p role={message.kind === 'error' ? 'alert' : 'status'} className={cn('font-sans text-[12px]', message.kind === 'error' ? 'text-danger' : 'text-cyan')}>
        {message.text}
        {/* Too many devices: they are removed on the website's account page. */}
        {message.code === 'device_limit' && webUrl && (
          <>
            {' '}
            <a href={`${webUrl}/account`} target="_blank" rel="noreferrer" className="text-cyan underline-offset-2 hover:underline">
              {t.cloud.manageDevices}
            </a>
          </>
        )}
      </p>
    )
  }
  // Signed out by the cloud (session ended, account disabled): say why.
  const known = statusError ? (t.cloud.errors as Record<string, string>)[statusError] : undefined
  return known ? <p role="alert" className="font-sans text-[12px] text-danger">{known}</p> : null
}

type Mode = 'login' | 'register' | 'forgot'

/** Sign in, create an account, or ask for a password reset — all against Mindeck Cloud. */
export function SignInForm() {
  const t = useT()
  const busy = useCloud((s) => s.busy)
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')

  const switchTo = (next: Mode) => {
    useCloud.getState().clearMessage()
    setMode(next)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const cloud = useCloud.getState()
    if (mode === 'login') void cloud.login(email, password)
    else if (mode === 'register') void cloud.register(email, password, name)
    else void cloud.forgot(email)
  }

  const intro = mode === 'login' ? t.cloud.signInIntro : mode === 'register' ? t.cloud.registerIntro : t.cloud.forgotIntro
  const action = mode === 'login' ? t.cloud.signIn : mode === 'register' ? t.cloud.register : t.cloud.sendLink

  return (
    <form onSubmit={submit} className="flex flex-col gap-3.5" aria-label={mode === 'login' ? t.cloud.signInTitle : mode === 'register' ? t.cloud.registerTitle : t.cloud.forgotTitle}>
      <p className="font-sans text-[13px] leading-relaxed text-text-secondary">{intro}</p>
      <Field label={t.cloud.email}>
        <input
          type="email"
          required
          autoComplete="email"
          aria-label={t.cloud.email}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={input}
        />
      </Field>
      {mode === 'register' && (
        <Field label={t.cloud.name}>
          <input aria-label={t.cloud.name} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} className={input} />
        </Field>
      )}
      {mode !== 'forgot' && (
        <Field label={t.cloud.password}>
          <input
            type="password"
            required
            minLength={mode === 'register' ? 10 : 1}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            aria-label={t.cloud.password}
            placeholder={mode === 'register' ? t.cloud.passwordHint : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={input}
          />
        </Field>
      )}
      <CloudNotice />
      <button type="submit" disabled={busy} className={primaryButton}>
        {busy && <Loader2 size={14} className="animate-spin" />}
        {action}
      </button>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {mode === 'login' ? (
          <>
            <button type="button" className={linkButton} onClick={() => switchTo('register')}>
              {t.cloud.toRegister}
            </button>
            <button type="button" className={linkButton} onClick={() => switchTo('forgot')}>
              {t.cloud.forgot}
            </button>
          </>
        ) : (
          <button type="button" className={linkButton} onClick={() => switchTo('login')}>
            {t.cloud.toSignIn}
          </button>
        )}
      </div>
    </form>
  )
}
