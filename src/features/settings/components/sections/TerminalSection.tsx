import { useEffect, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { TERMINAL_CURSORS, TERMINAL_LIMITS, type TerminalCursor, type TerminalProfile, type TerminalSettings } from '@shared/types/terminal'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useTerminalSettings } from '@/features/terminal/settings'
import { Advanced, Group, NumberField, Row, Segmented, SectionHeader, SwitchRow, btn, btnIcon, input, SelectBox } from '../ui'

/** `NAME=value` lines ↔ an environment. */
const envText = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf('=')
    const key = line.slice(0, at).trim()
    if (at > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = line.slice(at + 1)
  }
  return env
}

/** One profile being set up: name, command, arguments, environment, folder. */
function ProfileForm({ profile, onSave, onCancel }: { profile: TerminalProfile; onSave: (p: TerminalProfile) => void; onCancel: () => void }) {
  const t = useT()
  const s = t.terminalSettings
  const [draft, setDraft] = useState({ name: profile.name, command: profile.command, args: profile.args.join('\n'), env: envText(profile.env), cwd: profile.cwd ?? '' })
  const set = (key: keyof typeof draft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [key]: e.target.value }))
  const cwd = draft.cwd.trim()
  const cwdOk = !cwd || /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(cwd)
  const ok = draft.name.trim() && draft.command.trim() && cwdOk
  const save = () =>
    onSave({
      id: profile.id,
      name: draft.name.trim(),
      command: draft.command.trim(),
      args: draft.args.split('\n').filter((a) => a.trim()),
      env: parseEnv(draft.env),
      ...(cwd ? { cwd } : {})
    })
  const field = cn(input, 'w-full')
  const area = 'w-full resize-y rounded-md border border-hud/60 bg-surface px-3 py-2 font-mono text-[12.5px] text-text-primary outline-hidden focus:border-cyan/70'
  return (
    <div className="space-y-2 border-t border-hud/45 bg-surface/50 px-5 py-4">
      <input aria-label={s.profileName} placeholder={s.profileName} value={draft.name} onChange={set('name')} maxLength={80} className={field} />
      <input aria-label={s.profileCommand} placeholder={s.profileCommand} value={draft.command} onChange={set('command')} spellCheck={false} className={field} />
      <textarea aria-label={s.profileArgs} placeholder={s.profileArgs} value={draft.args} onChange={set('args')} rows={2} spellCheck={false} className={area} />
      <textarea aria-label={s.profileEnv} placeholder={s.profileEnv} value={draft.env} onChange={set('env')} rows={2} spellCheck={false} className={area} />
      <input aria-label={s.profileCwd} aria-invalid={!cwdOk} placeholder={s.profileCwd} value={draft.cwd} onChange={set('cwd')} spellCheck={false} className={cn(field, !cwdOk && 'border-danger/60')} />
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className={btn} onClick={onCancel}>
          {t.common.cancel}
        </button>
        <button type="button" className={btn} disabled={!ok} onClick={save}>
          {t.common.save}
        </button>
      </div>
    </div>
  )
}

/** Settings → Terminal: the default shell and profiles, the look, behaviour — and, folded away, the rest. */
export function TerminalSection() {
  const t = useT()
  const s = t.terminalSettings
  const st = t.settings
  const { settings, shells, error } = useTerminalSettings()
  const [editing, setEditing] = useState<TerminalProfile>()
  const [font, setFont] = useState(settings.fontFamily)
  useEffect(() => setFont(settings.fontFamily), [settings.fontFamily])

  useEffect(() => {
    void useTerminalSettings.getState().load(true)
  }, [])

  const set = (patch: Partial<TerminalSettings>) => void useTerminalSettings.getState().configure(patch)
  const saveFont = () => (font.trim() && font.trim() !== settings.fontFamily ? set({ fontFamily: font.trim() }) : setFont(settings.fontFamily))
  const saveProfile = (p: TerminalProfile) => {
    const known = settings.profiles.some((q) => q.id === p.id)
    set({ profiles: known ? settings.profiles.map((q) => (q.id === p.id ? p : q)) : [...settings.profiles, p] })
    setEditing(undefined)
  }
  const removeProfile = (id: string) => set({ profiles: settings.profiles.filter((p) => p.id !== id), ...(settings.defaultProfile === id ? { defaultProfile: '' } : {}) })
  const profileOptions = [
    { value: '', label: s.loginShell },
    ...shells.map((sh) => ({ value: sh.id, label: sh.name, hint: sh.file })),
    ...settings.profiles.map((p) => ({ value: p.id, label: p.name, hint: p.command }))
  ]
  const isNew = editing && !settings.profiles.some((p) => p.id === editing.id)

  return (
    <>
      <SectionHeader title={st.sections.terminal.title} intro={st.sections.terminal.intro} />
      {error && <p className="font-mono text-[12px] text-danger">{error}</p>}

      <Group title={st.groups.shell}>
        <Row label={s.defaultProfile}>
          <SelectBox label={s.defaultProfile} value={settings.defaultProfile ?? ''} options={profileOptions} onChange={(defaultProfile) => set({ defaultProfile })} width="w-[200px]" />
        </Row>
        <Row label={s.profiles} hint={s.profilesHint}>
          <button
            type="button"
            className={btn}
            disabled={!!editing || settings.profiles.length >= TERMINAL_LIMITS.profiles}
            onClick={() => setEditing({ id: `custom-${crypto.randomUUID()}`, name: '', command: '', args: [], env: {} })}
          >
            <Plus size={14} /> {s.addProfile}
          </button>
        </Row>
        {settings.profiles.map((p) =>
          editing?.id === p.id ? (
            <ProfileForm key={p.id} profile={editing} onSave={saveProfile} onCancel={() => setEditing(undefined)} />
          ) : (
            <Row key={p.id} indent label={p.name} hint={<span className="font-mono text-[12px]">{[p.command, ...p.args].join(' ')}</span>}>
              <div className="flex gap-1">
                <button type="button" aria-label={s.editProfile(p.name)} onClick={() => setEditing(p)} className={btnIcon}>
                  <Pencil size={14} />
                </button>
                <button type="button" aria-label={s.removeProfile(p.name)} onClick={() => removeProfile(p.id)} className={cn(btnIcon, 'hover:text-danger')}>
                  <Trash2 size={14} />
                </button>
              </div>
            </Row>
          )
        )}
        {isNew && <ProfileForm key={editing.id} profile={editing} onSave={saveProfile} onCancel={() => setEditing(undefined)} />}
      </Group>

      <Group title={st.groups.look}>
        <Row label={s.font} htmlFor="settings-terminal-font">
          <input
            id="settings-terminal-font"
            aria-label={s.font}
            value={font}
            onChange={(e) => setFont(e.target.value)}
            onBlur={saveFont}
            onKeyDown={(e) => e.key === 'Enter' && saveFont()}
            spellCheck={false}
            className={cn(input, 'w-[200px]')}
          />
        </Row>
        <Row label={s.fontSize} htmlFor="settings-terminal-font-size">
          <NumberField id="settings-terminal-font-size" label={s.fontSize} value={settings.fontSize} bounds={TERMINAL_LIMITS.fontSize} onSave={(fontSize) => set({ fontSize })} />
        </Row>
        <Row label={s.cursor}>
          <Segmented<TerminalCursor> label={s.cursor} value={settings.cursorStyle} options={TERMINAL_CURSORS.map((c) => ({ id: c, label: s.cursors[c] }))} onChange={(cursorStyle) => set({ cursorStyle })} />
        </Row>
        <SwitchRow label={s.cursorBlink} checked={settings.cursorBlink} onChange={(cursorBlink) => set({ cursorBlink })} />
      </Group>

      <Group title={st.groups.behaviour}>
        <SwitchRow label={s.copyOnSelect} hint={s.copyOnSelectHint} checked={settings.copyOnSelect} onChange={(copyOnSelect) => set({ copyOnSelect })} />
        <SwitchRow label={s.restore} hint={s.restoreHint} checked={settings.restoreTabs} onChange={(restoreTabs) => set({ restoreTabs })} />
        <SwitchRow label={s.shellIntegration} hint={s.shellIntegrationHint} checked={settings.shellIntegration} onChange={(shellIntegration) => set({ shellIntegration })} />
        <Advanced summary={st.advanced}>
          <Row label={s.lineHeight} htmlFor="settings-terminal-line-height">
            <NumberField
              id="settings-terminal-line-height"
              label={s.lineHeight}
              value={settings.lineHeight}
              bounds={TERMINAL_LIMITS.lineHeight}
              step={0.05}
              onSave={(lineHeight) => set({ lineHeight })}
            />
          </Row>
          <Row label={s.scrollback} htmlFor="settings-terminal-scrollback">
            <NumberField id="settings-terminal-scrollback" label={s.scrollback} value={settings.scrollback} bounds={TERMINAL_LIMITS.scrollback} width="w-[100px]" onSave={(scrollback) => set({ scrollback })} />
          </Row>
          <Row label={s.bufferKb} hint={s.bufferHint} htmlFor="settings-terminal-buffer">
            <NumberField id="settings-terminal-buffer" label={s.bufferKb} value={settings.bufferKb} bounds={TERMINAL_LIMITS.bufferKb} width="w-[100px]" onSave={(bufferKb) => set({ bufferKb })} />
          </Row>
          <SwitchRow label={s.gpu} hint={s.gpuHint} checked={settings.gpu} onChange={(gpu) => set({ gpu })} />
        </Advanced>
      </Group>
    </>
  )
}
