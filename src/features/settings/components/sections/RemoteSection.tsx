import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Copy, FolderPlus, Laptop, QrCode, Smartphone, Trash2, Wifi, WifiOff, X } from 'lucide-react'
import { isDesktop } from '@shared/ipc/client'
import { DEVICE_ROLES, type DeviceRole, type ServerConfig } from '@shared/types/server'
import { FolderPicker } from '@/components/ui/FolderPicker'
import { StatusDot } from '@/components/ui/StatusDot'
import { cn } from '@/lib/cn'
import { intlLocale, useT } from '@/lib/i18n'
import { relativeTime } from '@/features/agents/format'
import { canManage, isLoopback, liveReach, myDeviceId, reachOf, useSettings, type Reach } from '../../store'
import { Advanced, Group, NumberField, Pill, Row, Segmented, SectionHeader, Switch, SwitchRow, btn, btnIcon, btnPrimary, SelectBox } from '../ui'

/** The switches behind each choice. Anywhere needs the server, and HTTPS: the cloud must never see a connection in the clear. */
const REACH_PATCH: Record<Reach, Partial<ServerConfig>> = {
  off: { lan: false, relay: false },
  lan: { enabled: true, lan: true, relay: false },
  any: { enabled: true, lan: true, relay: true, tls: true }
}

/** Copies a text, and says so for a moment. */
function CopyButton({ text }: { text: string }) {
  const s = useT().settings
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button type="button" className={btn} onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => {})}>
      {copied ? <Check size={14} className="text-green" /> : <Copy size={14} />} {copied ? s.copied : s.copy}
    </button>
  )
}

/** Where away access stands — re-read every few seconds while it is on (connecting → online, a cloud restart). */
function RelayLine() {
  const s = useT().settings
  const relay = useSettings((st) => st.server?.relay)
  const refresh = useSettings((st) => st.refreshServer)
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 4000)
    return () => clearInterval(timer)
  }, [refresh])
  if (!relay || relay.state === 'off') return null
  const tone = relay.state === 'online' ? 'ok' : relay.state === 'connecting' ? 'warn' : 'muted'
  return (
    <p className="mt-1.5 flex items-start gap-2 font-sans text-[12.5px] text-text-secondary">
      <StatusDot tone={tone} pulse={relay.state === 'connecting'} />
      <span>{s.relayState(relay.state, relay.reason, relay.pipes ?? 0)}</span>
    </p>
  )
}

/** A pairing code: the QR code, the code, and where to open it (or why nothing can reach this computer yet). */
function PairingPanel() {
  const s = useT().settings
  const pairing = useSettings((st) => st.pairing)
  const closePairing = useSettings((st) => st.closePairing)
  if (!pairing) return null
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-cyan/40 bg-cyan/4 p-4 sm:flex-row sm:items-start">
      {pairing.reachable && <div className="w-40 shrink-0 rounded-md bg-white p-1.5" aria-label={s.pairingQr} dangerouslySetInnerHTML={{ __html: pairing.qr }} />}
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="font-mono text-[24px] tracking-[0.25em] text-text-primary">{pairing.code}</p>
        {pairing.role === 'admin' && <p className="font-sans text-[12.5px] font-medium text-amber">{s.adminCode}</p>}
        {pairing.reachable && pairing.installId && isLoopback(pairing.url) ? (
          // Only through the relay (the LAN is off): no address to open, no browser to warn — the app scans and pairs.
          <p className="font-sans text-[13px] text-text-secondary">{s.pairingRelayOnly}</p>
        ) : pairing.reachable ? (
          <>
            <p className="font-sans text-[13px] text-text-secondary">{s.pairingHint}</p>
            {pairing.installId && <p className="font-sans text-[12.5px] text-text-secondary">{s.pairingRelay}</p>}
            <p className="break-all font-mono text-[12px] text-cyan">{pairing.url}</p>
            {/* The link names the certificate: the phone's browser will warn about it. */}
            {pairing.url.includes('&fp=') && (
              <>
                <p className="font-sans text-[12.5px] text-text-secondary">{s.pairingTls}</p>
                <p className="break-all font-mono text-[11.5px] text-text-primary">{pairing.fingerprint}</p>
              </>
            )}
          </>
        ) : (
          <p className="font-sans text-[13px] text-amber">{s.pairingLocalOnly}</p>
        )}
      </div>
      <button type="button" aria-label={s.closePairing} onClick={closePairing} className={cn(btnIcon, 'self-start')}>
        <X size={16} />
      </button>
    </div>
  )
}

/** The folders paired devices may reach without remote shells (besides the projects added here). */
function SharedFolders({ roots, disabled, onChange }: { roots: string[]; disabled: boolean; onChange: (roots: string[]) => void }) {
  const s = useT().settings
  const [browsing, setBrowsing] = useState(false)
  return (
    <>
      <Row label={s.sharedFolders} hint={s.sharedFoldersHint} align="start">
        <button type="button" className={btn} disabled={disabled} onClick={() => setBrowsing(true)}>
          <FolderPlus size={14} /> {s.addSharedFolder}
        </button>
      </Row>
      {roots.length === 0 ? (
        <Row indent label={<span className="font-sans text-[13px] font-normal text-text-muted">{s.noSharedFolders}</span>} />
      ) : (
        roots.map((root) => (
          <Row key={root} indent label={<span className="break-all font-mono text-[12.5px] font-normal">{root}</span>}>
            <button type="button" aria-label={s.stopSharing(root)} disabled={disabled} onClick={() => onChange(roots.filter((r) => r !== root))} className={cn(btnIcon, 'hover:text-danger')}>
              <Trash2 size={14} />
            </button>
          </Row>
        ))
      )}
      {browsing && (
        <FolderPicker
          title={s.shareFolder}
          confirmLabel={s.share}
          onClose={() => setBrowsing(false)}
          onPick={(path) => {
            setBrowsing(false)
            if (!roots.includes(path)) onChange([...roots, path])
          }}
        />
      )}
    </>
  )
}

/** Settings → Phone & remote access: where devices may connect from, what they may do, the paired devices, and the server underneath. */
export function RemoteSection() {
  const t = useT()
  const s = t.settings
  const st = useSettings()
  const desktop = isDesktop()
  const server = st.server
  const cfg = server?.config
  const editable = desktop && !!server?.configurable
  const myDevice = myDeviceId()
  const manage = canManage(st.devices, desktop, myDevice)
  const [adminCode, setAdminCode] = useState(false)
  const roleOptions = DEVICE_ROLES.map((r) => ({ value: r, label: s.roles[r] }))
  const reach = liveReach(server)

  return (
    <>
      <SectionHeader title={s.sections.remote.title} intro={s.sections.remote.intro} />

      <div className="flex flex-wrap items-center gap-5 rounded-lg border border-hud/45 bg-panel p-5">
        <div className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', reach === 'off' ? 'bg-elevated text-text-muted' : 'bg-green/12 text-green')}>
          {reach === 'off' ? <WifiOff size={22} strokeWidth={1.9} /> : <Wifi size={22} strokeWidth={1.9} />}
        </div>
        <div className="min-w-[220px] flex-1">
          <p className="font-sans text-[15px] font-semibold text-text-primary">{s.reachTitle[reach]}</p>
          <p className="mt-0.5 font-sans text-[13px] text-text-secondary">
            {server?.running ? s.serverRunning : s.serverOff} · {s.devicesPaired(st.devices.length)}
          </p>
        </div>
        {manage && (
          <button type="button" className={btnPrimary} disabled={st.busy || !server?.running} onClick={() => void st.createPairing(adminCode ? 'admin' : 'member')}>
            <QrCode size={15} /> {s.pairDevice}
          </button>
        )}
      </div>
      {server?.error && <p className="font-mono text-[12px] text-danger">{server.error}</p>}
      <PairingPanel />

      {cfg && editable ? (
        <>
          <Group title={s.groups.reach}>
            <Row
              label={s.reachQuestion}
              hint={
                <>
                  {s.reachDesc[reachOf(cfg)]}
                  {cfg.enabled && cfg.relay && <RelayLine />}
                </>
              }
              align="start"
            >
              <Segmented<Reach>
                label={s.reachQuestion}
                value={reachOf(cfg)}
                disabled={st.busy}
                options={(['off', 'lan', 'any'] as const).map((id) => ({ id, label: s.reachOptions[id] }))}
                onChange={(next) => void st.configureServer(REACH_PATCH[next])}
              />
            </Row>
            {reachOf(cfg) === 'any' && (
              <SwitchRow label={s.keepAwake} hint={s.keepAwakeHint} checked={cfg.keepAwake} disabled={st.busy || !cfg.enabled} onChange={(v) => void st.configureServer({ keepAwake: v })} />
            )}
            {cfg.lan && !cfg.tls && (
              <Row label={<span className="flex items-start gap-2 font-normal text-amber"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {s.tlsOff}</span>} />
            )}
          </Group>

          <Group title={s.groups.devicePowers}>
            <SwitchRow
              label={s.shells}
              hint={s.shellsHint}
              badge={<Pill tone="risk">{s.caution}</Pill>}
              checked={cfg.remoteTerminal}
              disabled={st.busy}
              onChange={(v) => void st.configureServer({ remoteTerminal: v })}
            />
            <SharedFolders roots={cfg.remoteRoots ?? []} disabled={st.busy} onChange={(remoteRoots) => void st.configureServer({ remoteRoots })} />
          </Group>
        </>
      ) : (
        cfg && (
          <p className="px-1 font-sans text-[13px] text-text-secondary">
            {server?.configurable ? s.desktopOnly : s.envOnly} {s.remoteShells(cfg.remoteTerminal)}
          </p>
        )
      )}

      <Group title={s.pairedDevices} footnote={manage ? s.pairAsAdminHint : undefined}>
        {manage && <SwitchRow label={s.pairAsAdmin} checked={adminCode} disabled={st.busy} onChange={setAdminCode} />}
        {st.devices.length === 0 && <Row label={<span className="font-normal text-text-muted">{s.noDevices}</span>} />}
        {st.devices.map((d) => (
          <Row
            key={d.id}
            icon={/android|ios|phone/i.test(d.name) ? Smartphone : Laptop}
            label={
              <>
                {d.name}
                {d.id === myDevice && <span className="font-mono text-[11.5px] font-normal text-cyan">{s.thisBrowser}</span>}
              </>
            }
            hint={`${s.paired(relativeTime(d.createdAt))}${d.lastSeenAt ? s.seen(relativeTime(d.lastSeenAt)) : ''}`}
          >
            <div className="flex items-center gap-2">
              {manage ? (
                <SelectBox label={s.roleOf(d.name)} value={d.role} options={roleOptions} onChange={(role) => void st.setDeviceRole(d.id, role as DeviceRole)} width="w-[120px]" />
              ) : (
                <Pill tone="mute">{s.roles[d.role]}</Pill>
              )}
              {(manage || d.id === myDevice) && (
                <button type="button" aria-label={s.revoke(d.name)} onClick={() => void st.revokeDevice(d.id)} className={cn(btnIcon, 'h-9 w-9 hover:text-danger')}>
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          </Row>
        ))}
      </Group>

      <Group>
        <Advanced summary={s.technical}>
          <Row
            label={s.addresses}
            hint={server?.running ? <span className="font-mono text-[12px] leading-[1.7]">{server.urls.map((u) => <span key={u} className="block">{u}</span>)}</span> : undefined}
            align="start"
          >
            <Pill tone={server?.running ? 'ok' : 'mute'}>{server?.running ? s.serverRunning : s.serverOff}</Pill>
          </Row>
          {cfg && editable && (
            <>
              <Row label={s.runServer} hint={s.runServerHint}>
                <Switch label={s.runServer} checked={cfg.enabled} disabled={st.busy} onChange={(v) => void st.configureServer({ enabled: v })} />
              </Row>
              <SwitchRow label={s.lan} hint={s.lanHint} checked={cfg.lan} disabled={st.busy || !cfg.enabled} onChange={(v) => void st.configureServer({ lan: v })} />
              <SwitchRow label={s.relay} hint={s.relayHint} checked={cfg.relay} disabled={st.busy || !cfg.enabled} onChange={(v) => void st.configureServer({ relay: v })} />
              <SwitchRow label={s.tls} hint={s.tlsHint} checked={cfg.tls} disabled={st.busy || !cfg.enabled || !(cfg.lan || cfg.relay)} onChange={(v) => void st.configureServer({ tls: v })} />
              <Row label={s.port} htmlFor="settings-remote-port">
                <NumberField
                  id="settings-remote-port"
                  label={s.port}
                  value={cfg.port}
                  bounds={[1024, 65535]}
                  width="w-[100px]"
                  onSave={(port) => port !== cfg.port && void st.configureServer({ port })}
                />
              </Row>
            </>
          )}
          {server?.tls && (
            <Row
              label={s.certificate}
              hint={
                <>
                  <span className="block break-all font-mono text-[12px]">{server.tls.fingerprint}</span>
                  <span className="block">{(server.tls.selfSigned ? s.certificateSelfSigned : s.certificateOwn)(new Date(server.tls.expiresAt).toLocaleDateString(intlLocale()))}</span>
                </>
              }
              align="start"
            >
              <CopyButton text={server.tls.fingerprint} />
            </Row>
          )}
        </Advanced>
      </Group>
    </>
  )
}
