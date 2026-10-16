import { useEffect, useState } from 'react'
import { AlertTriangle, Check, FolderPlus, Globe, Info, Languages, Laptop, QrCode, RefreshCw, ShieldCheck, Smartphone, TerminalSquare, Trash2, Wifi, X } from 'lucide-react'
import { ipc, isDesktop } from '@shared/ipc/client'
import type { VaultStatus } from '@shared/types/memory'
import { ALL_PROJECTS, type PermissionGrant } from '@shared/types/ai'
import { DEVICE_ROLES, type DeviceRole } from '@shared/types/server'
import type { PushSettings } from '@shared/types/cloud'
import { Panel } from '@/components/ui/Panel'
import { TechLabel } from '@/components/ui/TechLabel'
import { Select } from '@/components/ui/Select'
import { Card } from '@/components/ui/Card'
import { LanguageSwitch } from '@/components/ui/LanguageSwitch'
import { intlLocale, useT } from '@/lib/i18n'
import { StatusDot } from '@/components/ui/StatusDot'
import { FolderPicker } from '@/components/ui/FolderPicker'
import { cn } from '@/lib/cn'
import { useSession } from '@/features/session/store'
import { useAssistant } from '@/features/agents/store'
import { useAgents } from '@/features/agents/sessions'
import { relativeTime } from '@/features/agents/format'
import { useComposerPrefs } from '@/features/agents/composerPrefs'
import { canManage, myDeviceId, useSettings } from '../store'
import { AppearanceCard } from './AppearanceCard'
import { LanguagesCard } from './LanguagesCard'
import { MigrateCard } from './MigrateCard'
import { EditorCard } from './EditorCard'
import { AiCard } from './AiCard'
import { BrowserCard } from './BrowserCard'
import { DesktopCard } from './DesktopCard'
import { TerminalCard } from './TerminalCard'
import { Toggle } from './Toggle'
import { OnboardingCard } from '@/features/onboarding/components/OnboardingCard'

const input =
  'rounded-md border border-hud/70 bg-surface/70 px-2.5 py-1.5 font-mono text-[12px] text-text-primary outline-hidden focus:border-cyan/60'
const button =
  'flex items-center justify-center gap-1.5 rounded-md border border-hud/60 px-2.5 py-1.5 font-sans text-[12px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan disabled:opacity-40'

/** How the composer sends a message, and whether agents reach the phone (Mindeck Cloud). */
function AgentPrefs() {
  const t = useT()
  const sendKey = useComposerPrefs((s) => s.sendKey)
  const [push, setPush] = useState<PushSettings>()
  useEffect(() => {
    void ipc('agents:pushSettings').then(setPush, () => {})
  }, [])
  return (
    <div className="mt-3 border-t border-hud/50 pt-2">
      <Toggle
        label={t.settings.modEnterSends}
        hint={t.settings.modEnterSendsHint}
        checked={sendKey === 'mod-enter'}
        onChange={(v) => useComposerPrefs.getState().setSendKey(v ? 'mod-enter' : 'enter')}
      />
      {push && (
        <Toggle
          label={t.settings.pushToPhone}
          hint={push.signedIn ? t.settings.pushToPhoneHint : t.settings.pushNeedsAccount}
          checked={push.enabled && push.signedIn}
          disabled={!push.signedIn}
          onChange={(enabled) => void ipc('agents:setPushSettings', { enabled }).then(setPush, () => {})}
        />
      )}
    </div>
  )
}

/** The coding agents found on this machine — they run on the user's own accounts. */
function AgentsCard() {
  const availability = useAgents((s) => s.availability)
  const detecting = useAgents((s) => s.detecting)
  const t = useT()
  useEffect(() => {
    void useAgents.getState().detect()
  }, [])
  return (
    <Card icon={TerminalSquare} title={t.settings.agentsCard}>
      <p className="font-sans text-[12px] text-text-secondary">
        {t.settings.agentsIntro}
      </p>
      <ul className="mt-2 space-y-1.5">
        {availability.map((a) => (
          <li key={a.kind} className="flex items-start gap-2">
            {a.ready ? <Check size={13} className="mt-0.5 shrink-0 text-green" /> : <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-text-muted" />}
            <span className="min-w-0 flex-1">
              <span className="block font-sans text-[13px] text-text-primary">{a.name}</span>
              <span className="block font-mono text-[10.5px] text-text-muted">
                {a.ready ? [a.account, a.version && `v${a.version}`].filter(Boolean).join(' · ') : a.hint}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <button type="button" className={cn(button, 'mt-3')} disabled={detecting} onClick={() => void useAgents.getState().detect()}>
        <RefreshCw size={12} className={cn(detecting && 'animate-spin')} /> {t.settings.checkAgain}
      </button>
      <AgentPrefs />
    </Card>
  )
}

/** The folders paired devices may reach without remote shells (besides the projects added here). */
function SharedFolders({ roots, disabled, onChange }: { roots: string[]; disabled: boolean; onChange: (roots: string[]) => void }) {
  const t = useT()
  const [browsing, setBrowsing] = useState(false)
  return (
    <div className="mt-2 border-t border-hud/40 pt-2">
      <div className="flex items-center justify-between">
        <TechLabel className="text-text-muted">{t.settings.sharedFolders}</TechLabel>
        <button type="button" className={button} disabled={disabled} onClick={() => setBrowsing(true)}>
          <FolderPlus size={12} /> {t.settings.addSharedFolder}
        </button>
      </div>
      <p className="mt-1 font-sans text-[11.5px] text-text-muted">{t.settings.sharedFoldersHint}</p>
      <ul className="mt-1 space-y-0.5">
        {roots.length === 0 && <li className="font-mono text-[11px] text-text-muted">{t.settings.noSharedFolders}</li>}
        {roots.map((root) => (
          <li key={root} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-secondary">{root}</span>
            <button
              type="button"
              aria-label={t.settings.stopSharing(root)}
              disabled={disabled}
              onClick={() => onChange(roots.filter((r) => r !== root))}
              className="text-text-muted hover:text-danger disabled:opacity-40"
            >
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ul>
      {browsing && (
        <FolderPicker
          title={t.settings.shareFolder}
          confirmLabel={t.settings.share}
          onClose={() => setBrowsing(false)}
          onPick={(path) => {
            setBrowsing(false)
            if (!roots.includes(path)) onChange([...roots, path])
          }}
        />
      )}
    </div>
  )
}

function RemoteCard() {
  const t = useT()
  const s = useSettings()
  const desktop = isDesktop()
  const cfg = s.server?.config
  const editable = desktop && !!s.server?.configurable
  const myDevice = myDeviceId()
  const manage = canManage(s.devices, desktop, myDevice)
  const [adminCode, setAdminCode] = useState(false)
  const roleOptions = DEVICE_ROLES.map((r) => ({ value: r, label: t.settings.roles[r] }))

  return (
    <Card icon={Wifi} title={t.settings.remoteCard} className="pane-lg:row-span-2">
      <div className="flex items-center gap-2">
        <StatusDot tone={s.server?.running ? 'ok' : 'muted'} pulse={false} />
        <span className="font-sans text-[13px] text-text-primary">{s.server?.running ? t.settings.serverRunning : t.settings.serverOff}</span>
      </div>
      {s.server?.running && (
        <ul className="mt-1 space-y-0.5">
          {s.server.urls.map((u) => (
            <li key={u} className="font-mono text-[11.5px] text-text-secondary">
              {u}
            </li>
          ))}
        </ul>
      )}
      {s.server?.error && <p className="mt-1 font-mono text-[11px] text-danger">{s.server.error}</p>}
      {s.server?.tls && (
        <div className="mt-2">
          <TechLabel className="text-text-muted">{t.settings.certificate}</TechLabel>
          <p className="break-all font-mono text-[10.5px] text-text-secondary">{s.server.tls.fingerprint}</p>
          <p className="font-mono text-[10px] text-text-muted">
            {(s.server.tls.selfSigned ? t.settings.certificateSelfSigned : t.settings.certificateOwn)(new Date(s.server.tls.expiresAt).toLocaleDateString(intlLocale()))}
          </p>
        </div>
      )}

      {cfg && editable && (
        <div className="mt-3 border-t border-hud/40 pt-2">
          <Toggle label={t.settings.runServer} hint={t.settings.runServerHint} checked={cfg.enabled} disabled={s.busy} onChange={(v) => void s.configureServer({ enabled: v })} />
          <Toggle label={t.settings.lan} hint={t.settings.lanHint} checked={cfg.lan} disabled={s.busy || !cfg.enabled} onChange={(v) => void s.configureServer({ lan: v })} />
          <Toggle label={t.settings.tls} hint={t.settings.tlsHint} checked={cfg.tls} disabled={s.busy || !cfg.enabled || !cfg.lan} onChange={(v) => void s.configureServer({ tls: v })} />
          {cfg.lan && !cfg.tls && (
            <p className="mb-1 flex items-start gap-1.5 font-sans text-[11.5px] text-amber">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {t.settings.tlsOff}
            </p>
          )}
          <Toggle label={t.settings.shells} hint={t.settings.shellsHint} checked={cfg.remoteTerminal} disabled={s.busy} onChange={(v) => void s.configureServer({ remoteTerminal: v })} />
          <label className="mt-1 flex items-center gap-2">
            <TechLabel className="text-text-muted">{t.settings.port}</TechLabel>
            <input
              aria-label={t.settings.port}
              type="number"
              min={1024}
              max={65535}
              defaultValue={cfg.port}
              key={cfg.port}
              onBlur={(e) => {
                const port = Number(e.target.value)
                if (port !== cfg.port && port >= 1024 && port <= 65535) void s.configureServer({ port })
              }}
              className={cn(input, 'w-24')}
            />
          </label>
          <SharedFolders roots={cfg.remoteRoots ?? []} disabled={s.busy} onChange={(remoteRoots) => void s.configureServer({ remoteRoots })} />
        </div>
      )}
      {cfg && !editable && (
        <p className="mt-2 font-sans text-[11.5px] text-text-muted">
          {s.server?.configurable ? t.settings.desktopOnly : t.settings.envOnly} {t.settings.remoteShells(cfg.remoteTerminal)}
        </p>
      )}

      <div className="mt-3 border-t border-hud/40 pt-3">
        <div className="flex items-center justify-between">
          <TechLabel className="text-text-muted">{t.settings.pairedDevices}</TechLabel>
          {manage && (
            <button type="button" className={button} disabled={s.busy || !s.server?.running} onClick={() => void s.createPairing(adminCode ? 'admin' : 'member')}>
              <QrCode size={13} /> {t.settings.pairDevice}
            </button>
          )}
        </div>
        {manage && <Toggle label={t.settings.pairAsAdmin} hint={t.settings.pairAsAdminHint} checked={adminCode} disabled={s.busy} onChange={setAdminCode} />}
        {s.pairing && (
          <div className="mt-3 flex flex-col items-center gap-2 rounded-md border border-cyan/40 bg-cyan/4 p-3 sm:flex-row sm:items-start">
            {s.pairing.reachable && (
              <div className="w-36 shrink-0 rounded-sm bg-white p-1" aria-label={t.settings.pairingQr} dangerouslySetInnerHTML={{ __html: s.pairing.qr }} />
            )}
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-mono text-[22px] tracking-[0.25em] text-text-primary">{s.pairing.code}</p>
              {s.pairing.role === 'admin' && <p className="font-mono text-[10.5px] uppercase tracking-wider text-amber">{t.settings.adminCode}</p>}
              {s.pairing.reachable ? (
                <>
                  <p className="font-sans text-[12px] text-text-secondary">{t.settings.pairingHint}</p>
                  <p className="break-all font-mono text-[11px] text-cyan">{s.pairing.url}</p>
                  {/* The link names the certificate: the phone's browser will warn about it. */}
                  {s.pairing.url.includes('&fp=') && (
                    <>
                      <p className="font-sans text-[11.5px] text-text-secondary">{t.settings.pairingTls}</p>
                      <p className="break-all font-mono text-[10.5px] text-text-primary">{s.pairing.fingerprint}</p>
                    </>
                  )}
                </>
              ) : (
                <p className="font-sans text-[12px] text-amber">{t.settings.pairingLocalOnly}</p>
              )}
            </div>
            <button type="button" aria-label={t.settings.closePairing} onClick={s.closePairing} className="self-start text-text-muted hover:text-text-primary">
              <X size={14} />
            </button>
          </div>
        )}
        <ul className="mt-2 space-y-1">
          {s.devices.length === 0 && <li className="font-mono text-[11px] text-text-muted">{t.settings.noDevices}</li>}
          {s.devices.map((d) => {
            const Icon = /android|ios|phone/i.test(d.name) ? Smartphone : Laptop
            return (
              <li key={d.id} className="flex items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-elevated/40">
                <Icon size={13} className="shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-sans text-[12.5px] text-text-primary">
                    {d.name}
                    {d.id === myDevice && <span className="ml-1.5 font-mono text-[10px] text-cyan">{t.settings.thisBrowser}</span>}
                  </span>
                  <span className="block font-mono text-[10px] text-text-muted">
                    {t.settings.paired(relativeTime(d.createdAt))}
                    {d.lastSeenAt ? t.settings.seen(relativeTime(d.lastSeenAt)) : ''}
                  </span>
                </span>
                {manage ? (
                  <Select
                    variant="quiet"
                    label={t.settings.roleOf(d.name)}
                    value={d.role}
                    options={roleOptions}
                    onChange={(role) => void s.setDeviceRole(d.id, role as DeviceRole)}
                  />
                ) : (
                  <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{t.settings.roles[d.role]}</span>
                )}
                {/* The browser (with the user's logins) is shared per admin device, at the desktop only. */}
                {desktop && d.role === 'admin' ? (
                  <button
                    type="button"
                    aria-label={t.settings.shareBrowser(d.name)}
                    aria-pressed={d.browser === true}
                    title={t.settings.shareBrowser(d.name)}
                    disabled={s.busy}
                    onClick={() => void s.setDeviceBrowser(d.id, !d.browser)}
                    className={cn('rounded p-0.5', d.browser ? 'text-cyan' : 'text-text-muted/50 hover:text-text-primary')}
                  >
                    <Globe size={12} />
                  </button>
                ) : (
                  d.browser && <Globe size={12} aria-label={t.settings.browserShared} className="text-cyan" />
                )}
                {(manage || d.id === myDevice) && (
                  <button type="button" aria-label={t.settings.revoke(d.name)} onClick={() => void s.revokeDevice(d.id)} className="text-text-muted hover:text-danger">
                    <Trash2 size={12} />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
        {desktop && s.devices.some((d) => d.role === 'admin') && <p className="mt-2 font-sans text-[11px] text-text-muted">{t.settings.shareBrowserHint}</p>}
      </div>
    </Card>
  )
}

function PermissionsCard() {
  const t = useT()
  const grants = useSettings((s) => s.grants)
  const projects = useSettings((s) => s.projects)
  const devices = useSettings((s) => s.devices)
  const revokeGrant = useSettings((s) => s.revokeGrant)
  const manage = canManage(devices)
  const where = (g: PermissionGrant) =>
    g.projectId === ALL_PROJECTS
      ? t.settings.allProjects
      : g.projectId
        ? (projects.find((p) => p.id === g.projectId)?.name ?? t.settings.removedProject)
        : t.settings.noProject
  return (
    <Card icon={ShieldCheck} title={t.settings.permissionsCard}>
      <p className="font-sans text-[12px] text-text-secondary">
        {t.settings.permissionsIntro}
      </p>
      <ul className="mt-2 space-y-1">
        {grants.length === 0 && <li className="font-mono text-[11px] text-text-muted">{t.settings.noGrants}</li>}
        {grants.map((g) => (
          <li key={`${g.agentId}:${g.toolName}:${g.projectId ?? ''}`} className="flex items-center gap-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[12px] text-text-primary">
                {g.agentId} → {g.toolName}
              </span>
              <span className={cn('block truncate font-sans text-[11px]', g.projectId === ALL_PROJECTS ? 'text-amber' : 'text-text-muted')}>{where(g)}</span>
            </span>
            {manage && (
              <button type="button" aria-label={t.settings.revoke(`${g.agentId} ${g.toolName} · ${where(g)}`)} onClick={() => void revokeGrant(g)} className="text-text-muted hover:text-danger">
                <Trash2 size={12} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function VaultCard() {
  const t = useT()
  const [vault, setVault] = useState<VaultStatus>()
  const [browsing, setBrowsing] = useState(false)
  const [error, setError] = useState<string>()
  const refresh = () => ipc('memory:status').then(setVault, (e: Error) => setError(e.message))
  useEffect(() => {
    void refresh()
  }, [])
  const choose = async (path?: string) => {
    setError(undefined)
    try {
      const next = await (path ? ipc('memory:setVault', { path }) : ipc('memory:pickVault'))
      if (next) setVault(next)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <Card icon={Info} title={t.settings.vaultCard}>
      {vault ? (
        <>
          <p className="break-all font-mono text-[12px] text-text-primary">{vault.root}</p>
          <p className="mt-0.5 font-sans text-[12px] text-text-muted">
            {vault.exists ? t.settings.notes(vault.noteCount) : t.settings.notCreated} · {vault.isDefault ? t.settings.defaultLocation : t.settings.customFolder}
          </p>
        </>
      ) : (
        <p className="font-mono text-[11px] text-text-muted">{t.common.loading}</p>
      )}
      {error && <p className="mt-1 font-mono text-[11px] text-danger">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button type="button" className={button} onClick={() => (isDesktop() ? void choose() : setBrowsing(true))}>
          {t.settings.chooseFolder}
        </button>
      </div>
      {browsing && (
        <FolderPicker
          title={t.settings.chooseVault}
          confirmLabel={t.settings.useAsVault}
          onClose={() => setBrowsing(false)}
          onPick={(path) => {
            setBrowsing(false)
            void choose(path)
          }}
        />
      )}
    </Card>
  )
}

function AboutCard() {
  const t = useT()
  const info = useSession((s) => s.info)
  const rows: [string, string][] = info
    ? [
        [t.settings.version, info.version],
        [t.settings.core, info.mode === 'desktop' ? t.settings.desktopApp : t.settings.server],
        [t.settings.host, `${info.hostname} (${info.platform})`],
        [t.settings.client, isDesktop() ? t.settings.desktopWindow : t.settings.pairedBrowser]
      ]
    : []
  return (
    <Card icon={Info} title={t.settings.aboutCard}>
      <dl className="space-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-3">
            <dt className="w-20 shrink-0 font-mono text-[11px] uppercase tracking-wider text-text-muted">{k}</dt>
            <dd className="min-w-0 wrap-break-word font-mono text-[12px] text-text-secondary">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}

/** Settings: appearance, language, agents, AI, remote access & devices, permissions, vault, about. */
export function SettingsView() {
  const t = useT()
  const load = useSettings((s) => s.load)
  const error = useSettings((s) => s.error)
  const clearError = useSettings((s) => s.clearError)
  const aiError = useAssistant((s) => s.error)
  useEffect(() => {
    void load()
  }, [load])
  return (
    <Panel title={t.settings.title} corners flush className="min-h-0 flex-1" bodyClassName="min-h-0 overflow-y-auto">
      {(error || aiError) && (
        <div className="flex items-start gap-2 border-b border-danger/30 bg-danger/6 px-3 py-2">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger" />
          <span className="min-w-0 flex-1 font-mono text-[11px] text-text-secondary">{error ?? aiError}</span>
          <button
            type="button"
            aria-label={t.common.dismiss}
            onClick={() => {
              clearError()
              useAssistant.getState().clearError()
            }}
            className="text-text-muted hover:text-text-primary"
          >
            <X size={12} />
          </button>
        </div>
      )}
      <div className="grid gap-3 p-3 pane-lg:grid-cols-2">
        <AppearanceCard />
        <Card icon={Languages} title={t.account.languageCard}>
          <LanguageSwitch />
          <p className="mt-2 font-sans text-[11.5px] text-text-muted">{t.account.languageHint}</p>
        </Card>
        <AgentsCard />
        <BrowserCard />
        <EditorCard />
        <TerminalCard />
        <MigrateCard />
        <LanguagesCard />
        <AiCard />
        <RemoteCard />
        <PermissionsCard />
        <VaultCard />
        <DesktopCard />
        <OnboardingCard />
        <AboutCard />
      </div>
    </Panel>
  )
}
