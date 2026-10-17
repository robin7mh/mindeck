import { useEffect, useState } from 'react'
import { BrainCircuit, KeyRound, Trash2 } from 'lucide-react'
import { EFFORTS, INLINE_MODELS, MODELS, type AiStatus, type Effort } from '@shared/types/ai'
import { ipc } from '@shared/ipc/client'
import { Card } from '@/components/ui/Card'
import { Select } from '@/components/ui/Select'
import { StatusDot } from '@/components/ui/StatusDot'
import { TechLabel } from '@/components/ui/TechLabel'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useAssistant } from '@/features/agents/store'
import { Toggle } from './Toggle'

const input = 'rounded-md border border-hud/70 bg-surface/70 px-2.5 py-1.5 font-mono text-[12px] text-text-primary outline-none focus:border-cyan/60'
const button =
  'flex items-center justify-center gap-1.5 rounded-md border border-hud/60 px-2.5 py-1.5 font-sans text-[12px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan disabled:opacity-40'
const hint = 'font-sans text-[11.5px] text-text-muted'

const euro = (cents: number, locale: string) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(cents / 100)

/** How much of the AI credit is used — amber from 80 %. */
function CreditMeter({ cloud }: { cloud: NonNullable<AiStatus['cloud']> }) {
  const t = useT()
  const s = t.settings
  const { credit } = cloud
  const share = credit.allowanceCents > 0 ? credit.usedCents / credit.allowanceCents : 1
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 font-sans text-[12.5px] text-text-primary">
        <span>{s.creditUsed(euro(credit.usedCents, s.locale), euro(credit.allowanceCents, s.locale))}</span>
        <span className="text-text-muted">{credit.period === 'month' ? s.creditRenews(new Date(credit.renewsAt!).toLocaleDateString(s.locale, { day: 'numeric', month: 'long' })) : s.creditTrial}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-hud/60" role="meter" aria-label={s.creditLabel} aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn('h-full rounded-full', share >= 0.8 ? 'bg-amber' : 'bg-cyan')} style={{ width: `${Math.min(100, share * 100)}%` }} />
      </div>
    </div>
  )
}

/**
 * Settings → the assistant's AI: through the Mindeck account (credit, model)
 * — or the user's own Anthropic key (optional, for heavy use and suggestions
 * while typing).
 */
export function AiCard() {
  const t = useT()
  const s = t.settings
  const status = useAssistant((st) => st.status)
  const { setKey, clearKey, configure } = useAssistant.getState()
  const [key, setKeyText] = useState('')
  const [busy, setBusy] = useState(false)
  const own = status?.source === 'env' || status?.source === 'stored'

  // The credit is the cloud's: fresh whenever the settings open.
  useEffect(() => {
    void ipc('ai:status').then(
      (fresh) => fresh && useAssistant.setState({ status: fresh }),
      () => {}
    )
  }, [])

  const save = async () => {
    setBusy(true)
    if (await setKey(key)) setKeyText('')
    setBusy(false)
  }
  /** The cloud model's name (its id when the cloud no longer offers it). */
  const cloudLabel = (st: AiStatus) => st.cloud?.models.find((m) => m.id === st.model)?.label ?? st.model

  return (
    <Card icon={BrainCircuit} title={s.aiCard}>
      <div className="flex items-center gap-2">
        <StatusDot tone={status?.configured ? 'ok' : 'warn'} pulse={false} />
        <span className="font-sans text-[13px] text-text-primary">
          {status?.source === 'cloud'
            ? s.viaCloud(cloudLabel(status))
            : own
              ? s.keyFrom(status.source === 'env', status.keyHint)
              : s.aiSignIn}
        </span>
      </div>

      {status?.cloud && (
        <div className="mt-3 space-y-2">
          <CreditMeter cloud={status.cloud} />
          {status.cloud.blocked && (
            <p role="status" className="font-sans text-[12px] text-amber">
              {s.cloudBlocked}
            </p>
          )}
          {own && <p className={hint}>{s.ownKeyWins}</p>}
          <div className="flex min-w-0 flex-col gap-1">
            <TechLabel className="text-text-muted">{s.cloudModel}</TechLabel>
            <Select
              label={s.cloudModel}
              value={status.settings.cloudModel}
              onChange={(cloudModel) => void configure({ cloudModel })}
              options={status.cloud.models.map((m) => ({ value: m.id, label: m.label, hint: m.costFactor > 1 ? s.costFactor(m.costFactor) : s.cloudDefault }))}
            />
          </div>
        </div>
      )}

      <div className="mt-3 flex min-w-0 flex-col gap-1">
        <TechLabel className="text-text-muted">{s.effort}</TechLabel>
        <Select label={s.effort} value={status?.settings.effort ?? 'high'} onChange={(effort) => void configure({ effort: effort as Effort })} options={EFFORTS.map((e) => ({ value: e, label: e }))} />
      </div>
      <p className={cn(hint, 'mt-2')}>{s.effortHint}</p>
      <p className={cn(hint, 'mt-1')}>{t.inlineAi.editHint}</p>

      <div className="mt-3 space-y-2 border-t border-hud/60 pt-3">
        <TechLabel className="text-text-muted">{s.ownKeyTitle}</TechLabel>
        <p className={hint}>{s.ownKeyHint}</p>
        {status?.source !== 'env' && (
          <div className="flex gap-2">
            <input
              type="password"
              aria-label={s.newKey}
              placeholder={status?.source === 'stored' ? s.replaceKey : 'sk-ant-…'}
              value={key}
              onChange={(e) => setKeyText(e.target.value)}
              className={cn(input, 'min-w-0 flex-1')}
            />
            <button type="button" className={button} disabled={!key.trim() || busy} onClick={() => void save()}>
              <KeyRound size={13} /> {t.common.save}
            </button>
            {status?.source === 'stored' && (
              <button type="button" aria-label={s.removeKey} className={cn(button, 'hover:border-danger/50 hover:text-danger')} onClick={() => void clearKey()}>
                <Trash2 size={13} />
              </button>
            )}
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <TechLabel className="text-text-muted">{s.model}</TechLabel>
          <Select label={s.model} value={status?.settings.model ?? MODELS[0].id} onChange={(model) => void configure({ model })} options={MODELS.map((m) => ({ value: m.id, label: m.label, hint: m.note }))} />
        </div>
        <Toggle
          label={t.inlineAi.suggestions}
          hint={own ? t.inlineAi.suggestionsHint : t.inlineAi.suggestionsOwnKey}
          checked={own && !!status?.settings.inline}
          disabled={!own}
          onChange={(inline) => void configure({ inline })}
        />
        <div className="flex min-w-0 flex-col gap-1">
          <TechLabel className="text-text-muted">{t.inlineAi.suggestionsModel}</TechLabel>
          <Select
            label={t.inlineAi.suggestionsModel}
            value={status?.settings.inlineModel ?? INLINE_MODELS[0].id}
            onChange={(inlineModel) => void configure({ inlineModel })}
            options={INLINE_MODELS.map((m) => ({ value: m.id, label: m.label, hint: m.note }))}
          />
        </div>
      </div>
    </Card>
  )
}
