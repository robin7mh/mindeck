import { useEffect, useState } from 'react'
import { AlertCircle, KeyRound, RefreshCw, Trash2 } from 'lucide-react'
import { ipc } from '@shared/ipc/client'
import { ALL_PROJECTS, EFFORTS, INLINE_MODELS, MODELS, type AiStatus, type Effort, type PermissionGrant } from '@shared/types/ai'
import type { PushSettings } from '@shared/types/cloud'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useAssistant } from '@/features/agents/store'
import { useAgents } from '@/features/agents/sessions'
import { useComposerPrefs } from '@/features/agents/composerPrefs'
import { canManage, useSettings } from '../../store'
import { Advanced, Callout, Group, Pill, Row, Segmented, SectionHeader, Switch, SwitchRow, btn, btnIcon, btnPrimary, btnQuiet, input, SelectBox } from '../ui'

const euro = (cents: number, locale: string) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(cents / 100)

/** How much of the AI credit is used — amber from 80 %. */
function CreditRow({ cloud }: { cloud: NonNullable<AiStatus['cloud']> }) {
  const s = useT().settings
  const { credit } = cloud
  const share = credit.allowanceCents > 0 ? credit.usedCents / credit.allowanceCents : 1
  const renews = credit.period === 'month' ? s.creditRenews(new Date(credit.renewsAt!).toLocaleDateString(s.locale, { day: 'numeric', month: 'long' })) : s.creditTrial
  return (
    <Row label={s.creditLabel} hint={`${s.creditUsed(euro(credit.usedCents, s.locale), euro(credit.allowanceCents, s.locale))} · ${renews}`}>
      <div className="h-1.5 w-40 overflow-hidden rounded-full bg-elevated" role="meter" aria-label={s.creditLabel} aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn('h-full rounded-full', share >= 0.8 ? 'bg-amber' : 'bg-cyan')} style={{ width: `${Math.min(100, share * 100)}%` }} />
      </div>
    </Row>
  )
}

/** The Mindeck Assistant: its connection (account or own key), model, effort — and, folded away, one's own API key. */
function AssistantGroup() {
  const t = useT()
  const s = t.settings
  const status = useAssistant((st) => st.status)
  const { setKey, clearKey, configure } = useAssistant.getState()
  const [key, setKeyText] = useState('')
  const [busy, setBusy] = useState(false)
  const own = status?.source === 'env' || status?.source === 'stored'

  const save = async () => {
    setBusy(true)
    if (await setKey(key)) setKeyText('')
    setBusy(false)
  }
  /** The cloud model's name (its id when the cloud no longer offers it). */
  const cloudLabel = (st: AiStatus) => st.cloud?.models.find((m) => m.id === st.model)?.label ?? st.model
  const connection = status?.source === 'cloud' ? s.viaCloud(cloudLabel(status)) : own ? s.keyFrom(status.source === 'env', status.keyHint) : s.aiSignIn

  return (
    <Group title={s.groups.assistant} footnote={t.inlineAi.editHint}>
      <Row label={s.connection} hint={connection}>
        <Pill tone={status?.configured ? 'ok' : 'warn'}>{status?.configured ? s.agentReady : s.badgeSignIn}</Pill>
      </Row>
      {status?.cloud && <CreditRow cloud={status.cloud} />}
      {status?.cloud && !own ? (
        <Row label={s.model} hint={s.cloudModel}>
          <SelectBox
            label={s.cloudModel}
            value={status.settings.cloudModel}
            onChange={(cloudModel) => void configure({ cloudModel })}
            options={status.cloud.models.map((m) => ({ value: m.id, label: m.label, hint: m.costFactor > 1 ? s.costFactor(m.costFactor) : s.cloudDefault }))}
            width="w-[220px]"
          />
        </Row>
      ) : (
        <Row label={s.model} hint={status?.cloud && own ? s.ownKeyWins : undefined}>
          <SelectBox
            label={s.model}
            value={status?.settings.model ?? MODELS[0].id}
            onChange={(model) => void configure({ model })}
            options={MODELS.map((m) => ({ value: m.id, label: m.label, hint: m.note }))}
            width="w-[220px]"
          />
        </Row>
      )}
      <Row label={s.effort} hint={s.effortHint} align="start">
        <Segmented label={s.effort} value={status?.settings.effort ?? 'high'} onChange={(effort: Effort) => void configure({ effort })} options={EFFORTS.map((e) => ({ id: e, label: s.efforts[e] }))} />
      </Row>
      <Advanced summary={s.ownKeyFold} open={own}>
        <Row label={s.apiKey} hint={s.ownKeyHint} align="start">
          {status?.source !== 'env' && (
            <div className="flex gap-2">
              <input
                type="password"
                aria-label={s.newKey}
                placeholder={status?.source === 'stored' ? s.replaceKey : 'sk-ant-…'}
                value={key}
                onChange={(e) => setKeyText(e.target.value)}
                className={cn(input, 'w-[200px]')}
              />
              <button type="button" className={btn} disabled={!key.trim() || busy} onClick={() => void save()}>
                <KeyRound size={14} /> {t.common.save}
              </button>
              {status?.source === 'stored' && (
                <button type="button" aria-label={s.removeKey} title={s.removeKey} className={cn(btnIcon, 'h-9 w-9 hover:text-danger')} onClick={() => void clearKey()}>
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          )}
        </Row>
        <SwitchRow
          label={t.inlineAi.suggestions}
          hint={own ? t.inlineAi.suggestionsHint : t.inlineAi.suggestionsOwnKey}
          badge={own ? undefined : <Pill tone="mute">{s.needsKey}</Pill>}
          checked={own && !!status?.settings.inline}
          disabled={!own}
          onChange={(inline) => void configure({ inline })}
        />
        <Row label={t.inlineAi.suggestionsModel}>
          <SelectBox
            label={t.inlineAi.suggestionsModel}
            value={status?.settings.inlineModel ?? INLINE_MODELS[0].id}
            onChange={(inlineModel) => void configure({ inlineModel })}
            options={INLINE_MODELS.map((m) => ({ value: m.id, label: m.label, hint: m.note }))}
            width="w-[220px]"
          />
        </Row>
      </Advanced>
    </Group>
  )
}

/** The coding agents found on this machine — they run on the user's own accounts. */
function AgentsGroup() {
  const t = useT()
  const s = t.settings
  const availability = useAgents((st) => st.availability)
  const detecting = useAgents((st) => st.detecting)
  useEffect(() => {
    void useAgents.getState().detect()
  }, [])
  return (
    <Group
      title={s.groups.agents}
      footnote={s.agentsIntro}
      action={
        <button type="button" className={btnQuiet} disabled={detecting} onClick={() => void useAgents.getState().detect()}>
          <RefreshCw size={13} className={cn(detecting && 'animate-spin')} /> {s.checkAgain}
        </button>
      }
    >
      {availability.length === 0 && <Row label={t.common.loading} />}
      {availability.map((a) => (
        <Row
          key={a.kind}
          label={a.name}
          hint={a.ready ? <span className="font-mono text-[12px]">{[a.account, a.version && `v${a.version}`].filter(Boolean).join(' · ')}</span> : a.hint}
        >
          {a.ready ? <Pill tone="ok">{s.agentReady}</Pill> : <Pill tone="mute">{a.installed ? s.agentNotReady : s.agentMissing}</Pill>}
        </Row>
      ))}
    </Group>
  )
}

/** "Always allow" as given, per agent, tool and project — revoked here. */
function PermissionsGroup() {
  const s = useT().settings
  const grants = useSettings((st) => st.grants)
  const projects = useSettings((st) => st.projects)
  const devices = useSettings((st) => st.devices)
  const revokeGrant = useSettings((st) => st.revokeGrant)
  const manage = canManage(devices)
  const where = (g: PermissionGrant) =>
    g.projectId === ALL_PROJECTS ? s.allProjects : g.projectId ? (projects.find((p) => p.id === g.projectId)?.name ?? s.removedProject) : s.noProject
  return (
    <Group title={s.groups.permissions}>
      <Row label={s.standingGrants} hint={s.permissionsIntro} align="start">
        {grants.length === 0 && <Pill tone="mute">{s.none}</Pill>}
      </Row>
      {grants.map((g) => (
        <Row
          key={`${g.agentId}:${g.toolName}:${g.projectId ?? ''}`}
          indent
          label={<span className="font-mono text-[12.5px]">{`${g.agentId} → ${g.toolName}`}</span>}
          hint={<span className={g.projectId === ALL_PROJECTS ? 'text-amber' : undefined}>{where(g)}</span>}
        >
          {manage && (
            <button type="button" aria-label={s.revoke(`${g.agentId} ${g.toolName} · ${where(g)}`)} onClick={() => void revokeGrant(g)} className={cn(btnIcon, 'hover:text-danger')}>
              <Trash2 size={15} />
            </button>
          )}
        </Row>
      ))}
    </Group>
  )
}

/** How the composer sends a message, and whether agents reach the phone (Mindeck Cloud). */
function ChatGroup() {
  const s = useT().settings
  const sendKey = useComposerPrefs((st) => st.sendKey)
  const [push, setPush] = useState<PushSettings>()
  useEffect(() => {
    void ipc('agents:pushSettings').then(setPush, () => {})
  }, [])
  return (
    <Group title={s.groups.chat}>
      <SwitchRow
        label={s.modEnterSends}
        hint={s.modEnterSendsHint}
        checked={sendKey === 'mod-enter'}
        onChange={(v) => useComposerPrefs.getState().setSendKey(v ? 'mod-enter' : 'enter')}
      />
      {push && (
        <Row label={s.pushToPhone} hint={push.signedIn ? s.pushToPhoneHint : s.pushNeedsAccount}>
          <Switch
            label={s.pushToPhone}
            checked={push.enabled && push.signedIn}
            disabled={!push.signedIn}
            onChange={(enabled) => void ipc('agents:setPushSettings', { enabled }).then(setPush, () => {})}
          />
        </Row>
      )}
    </Group>
  )
}

/** Settings → AI & agents: the assistant, the coding agents, standing permissions, chat and notifications. */
export function AiSection({ onSignIn }: { onSignIn?: () => void }) {
  const s = useT().settings
  const status = useAssistant((st) => st.status)

  // The credit is the cloud's: fresh whenever this section opens.
  useEffect(() => {
    void ipc('ai:status').then(
      (fresh) => fresh && useAssistant.setState({ status: fresh }),
      () => {}
    )
  }, [])

  return (
    <>
      <SectionHeader title={s.sections.ai.title} intro={s.sections.ai.intro} />
      {status && !status.configured && (
        <Callout
          tone="warn"
          icon={AlertCircle}
          action={
            onSignIn && (
              <button type="button" className={cn(btnPrimary, 'h-8')} onClick={onSignIn}>
                {s.signIn}
              </button>
            )
          }
        >
          <strong className="font-semibold">{s.notSignedIn}</strong> {s.aiSignIn}.
        </Callout>
      )}
      {status?.cloud?.blocked && (
        <Callout tone="warn" icon={AlertCircle}>
          {s.cloudBlocked}
        </Callout>
      )}
      <AssistantGroup />
      <AgentsGroup />
      <PermissionsGroup />
      <ChatGroup />
    </>
  )
}
