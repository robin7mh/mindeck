import { useState, type FormEvent, type ReactNode } from 'react'
import { KeyRound, Loader2, RefreshCw, ShieldCheck, WifiOff } from 'lucide-react'
import { formatFingerprint, normalizeFingerprint } from '@shared/ipc/transport'
import { Panel } from '@/components/ui/Panel'
import { TechLabel } from '@/components/ui/TechLabel'
import { GlowBackground } from '@/components/shell/GlowBackground'
import { useT } from '@/lib/i18n'
import { defaultDeviceName, useSession } from '../store'

/** XXXX-XXXX as the user types (letters/digits only, uppercase). */
export function formatCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw
}

function Frame({ children }: { children: ReactNode }) {
  const t = useT()
  return (
    <div className="relative flex h-screen w-screen items-center justify-center overflow-hidden p-4">
      <GlowBackground />
      <div className="relative z-10 w-full max-w-md">
        <div className="mb-5 flex items-center justify-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-cyan/40 bg-cyan/5 font-mono text-sm font-bold text-cyan text-glow-cyan">
            MD
          </div>
          <div className="leading-none">
            <div className="font-sans text-[15px] font-semibold tracking-wide text-text-primary">Mindeck</div>
            <TechLabel className="text-text-muted">{t.pair.web}</TechLabel>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Shown while checking the stored token. */
export function ConnectingScreen() {
  const t = useT()
  return (
    <Frame>
      <div className="flex items-center justify-center gap-2 font-mono text-[12px] text-text-muted">
        <Loader2 size={14} className="animate-spin text-cyan" /> {t.pair.connecting}
      </div>
    </Frame>
  )
}

export function UnreachableScreen() {
  const t = useT()
  const { error, init } = useSession()
  return (
    <Frame>
      <Panel title={t.pair.unreachable} corners>
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <WifiOff size={26} className="text-danger" />
          <p className="font-sans text-[13px] text-text-secondary">{t.pair.noAnswer}</p>
          {error && <p className="font-mono text-[11px] text-text-muted">{error}</p>}
          <button
            type="button"
            onClick={() => void init()}
            className="mt-1 flex items-center gap-1.5 rounded-md border border-cyan/40 bg-cyan/6 px-3 py-1.5 font-sans text-[12px] font-medium text-cyan hover:bg-cyan/12"
          >
            <RefreshCw size={13} /> {t.common.retry}
          </button>
        </div>
      </Panel>
    </Frame>
  )
}

/**
 * What the QR code handed over in the URL, consumed once: the code
 * (`#pair=XXXX-XXXX`) and, for a core that speaks HTTPS, its certificate's
 * fingerprint (`&fp=…`, shown as `AB:CD:…`).
 */
export function linkFromHash(): { code: string; fingerprint: string | null } {
  const m = /[#&]pair=([^&]+)/.exec(location.hash)
  if (!m) return { code: '', fingerprint: null }
  const fp = normalizeFingerprint(/[#&]fp=([^&]+)/.exec(location.hash)?.[1] ?? '')
  history.replaceState(null, '', location.pathname + location.search)
  let code = ''
  try {
    code = formatCode(decodeURIComponent(m[1]))
  } catch {
    /* a broken link (`%E0%A4%A`): the form starts empty instead of the app crashing */
  }
  return { code, fingerprint: fp && formatFingerprint(fp) }
}

/**
 * The browser cannot check a self-signed certificate, and a page cannot see
 * the one it came over — the person compares the fingerprint from the QR code
 * with the one the browser shows.
 */
function CertificateCheck({ fingerprint }: { fingerprint: string }) {
  const t = useT()
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-amber/40 bg-amber/5 p-2.5">
      <span className="flex items-center gap-1.5 font-sans text-[12.5px] font-medium text-amber">
        <ShieldCheck size={13} /> {t.pair.certificateTitle}
      </span>
      <p className="font-sans text-[12px] leading-relaxed text-text-secondary">{t.pair.certificateHint}</p>
      <p aria-label={t.pair.certificateTitle} className="break-all font-mono text-[11px] text-text-primary">
        {fingerprint}
      </p>
      <p className="font-sans text-[11.5px] text-text-muted">{t.pair.certificateMatch}</p>
    </div>
  )
}

/** First visit from a browser: redeem a one-time pairing code. */
export function PairScreen() {
  const t = useT()
  const { error, pair } = useSession()
  const [link] = useState(linkFromHash)
  const [code, setCode] = useState(link.code)
  const [name, setName] = useState(() => defaultDeviceName())
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const complete = code.replace('-', '').length === 8

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!complete || busy) return
    setBusy(true)
    const ok = await pair(code, name, remember)
    if (!ok) setBusy(false)
  }

  return (
    <Frame>
      <Panel title={t.pair.title} corners>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4 py-1">
          <p className="font-sans text-[13px] leading-relaxed text-text-secondary">
            {t.pair.introBefore}
            <code className="font-mono text-cyan">npm run server:pair</code>
            {t.pair.introMiddle} <span className="text-text-primary">{t.pair.introPath}</span>.
          </p>
          <label className="flex flex-col gap-1.5">
            <TechLabel className="text-text-muted">{t.pair.code}</TechLabel>
            <input
              autoFocus
              aria-label={t.pair.code}
              value={code}
              onChange={(e) => setCode(formatCode(e.target.value))}
              placeholder="XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              className="rounded-md border border-hud/70 bg-surface/70 px-3 py-2 text-center font-mono text-[20px] tracking-[0.3em] text-text-primary outline-hidden placeholder:text-text-muted/50 focus:border-cyan/60"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <TechLabel className="text-text-muted">{t.pair.deviceName}</TechLabel>
            <input
              aria-label={t.pair.deviceName}
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              className="rounded-md border border-hud/70 bg-surface/70 px-3 py-1.5 font-sans text-[13px] text-text-primary outline-hidden focus:border-cyan/60"
            />
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="mt-0.5 accent-cyan" />
            <span className="flex flex-col gap-0.5">
              <span className="font-sans text-[12.5px] text-text-primary">{t.pair.remember}</span>
              <span className="font-sans text-[11.5px] text-text-muted">{t.pair.rememberHint}</span>
            </span>
          </label>
          {link.fingerprint && <CertificateCheck fingerprint={link.fingerprint} />}
          {error && <p className="font-mono text-[11px] text-danger">{error}</p>}
          <button
            type="submit"
            disabled={!complete || busy}
            className="flex items-center justify-center gap-2 rounded-md border border-cyan/50 bg-cyan/[0.10] px-3 py-2 font-sans text-[13px] font-medium text-cyan transition-colors hover:bg-cyan/16 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
            {t.pair.submit}
          </button>
        </form>
      </Panel>
    </Frame>
  )
}
