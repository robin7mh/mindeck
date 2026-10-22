import { useEffect, useState } from 'react'
import { Pencil, Plus, SquareTerminal, Trash2 } from 'lucide-react'
import { isDesktop } from '@shared/ipc/client'
import { TERMINAL_CURSORS, TERMINAL_LIMITS, type TerminalProfile, type TerminalSettings } from '@shared/types/terminal'
import { Card } from '@/components/ui/Card'
import { Select } from '@/components/ui/Select'
import { useT } from '@/lib/i18n'
import { useTerminalSettings } from '@/features/terminal/settings'
import { Toggle } from './Toggle'

const field = 'rounded-md border border-hud/70 bg-surface/70 px-2 py-1 font-mono text-[12px] text-text-primary outline-hidden focus:border-cyan/60'
const label = 'flex items-center gap-2 font-sans text-[12.5px] text-text-secondary'
const button =
  'flex items-center justify-center gap-1.5 rounded-md border border-hud/60 px-2.5 py-1.5 font-sans text-[12px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan disabled:opacity-40'

/** A number typed freely, saved (within its bounds) on Enter or leaving the field. */
function NumberField({ name, value, bounds, step = 1, onSave }: { name: string; value: number; bounds: readonly [number, number]; step?: number; onSave: (v: number) => void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const n = Number(text)
    if (text.trim() === '' || Number.isNaN(n)) return setText(String(value))
    const next = Math.min(bounds[1], Math.max(bounds[0], step < 1 ? n : Math.round(n)))
    setText(String(next))
    if (next !== value) onSave(next)
  }
  return (
    <label className={label}>
      {name}
      <input
        type="number"
        aria-label={name}
        min={bounds[0]}
        max={bounds[1]}
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        className={`${field} w-20`}
      />
    </label>
  )
}

/** `NAME=value` lines ↔ an environment. */
const envText = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')
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
  return (
    <div className="mt-2 space-y-2 rounded-md border border-cyan/30 bg-cyan/3 p-2.5">
      <input aria-label={s.profileName} placeholder={s.profileName} value={draft.name} onChange={set('name')} maxLength={80} className={`${field} w-full`} />
      <input aria-label={s.profileCommand} placeholder={s.profileCommand} value={draft.command} onChange={set('command')} spellCheck={false} className={`${field} w-full`} />
      <textarea aria-label={s.profileArgs} placeholder={s.profileArgs} value={draft.args} onChange={set('args')} rows={2} spellCheck={false} className={`${field} w-full resize-y`} />
      <textarea aria-label={s.profileEnv} placeholder={s.profileEnv} value={draft.env} onChange={set('env')} rows={2} spellCheck={false} className={`${field} w-full resize-y`} />
      <input
        aria-label={s.profileCwd}
        aria-invalid={!cwdOk}
        placeholder={s.profileCwd}
        value={draft.cwd}
        onChange={set('cwd')}
        spellCheck={false}
        className={`${field} w-full ${cwdOk ? '' : 'border-danger/60'}`}
      />
      <div className="flex justify-end gap-2">
        <button type="button" className={button} onClick={onCancel}>
          {t.common.cancel}
        </button>
        <button type="button" className={button} disabled={!ok} onClick={save}>
          {t.common.save}
        </button>
      </div>
    </div>
  )
}

/** Settings → Terminal: the look, scrollback, copy on select, GPU, restoring, shell integration and profiles. */
export function TerminalCard() {
  const t = useT()
  const s = t.terminalSettings
  const { settings, shells, error } = useTerminalSettings()
  const [editing, setEditing] = useState<TerminalProfile>()
  const [font, setFont] = useState(settings.fontFamily)
  useEffect(() => setFont(settings.fontFamily), [settings.fontFamily])

  useEffect(() => {
    if (isDesktop()) void useTerminalSettings.getState().load(true)
  }, [])

  if (!isDesktop()) return null
  const set = (patch: Partial<TerminalSettings>) => void useTerminalSettings.getState().configure(patch)
  const saveFont = () => (font.trim() && font.trim() !== settings.fontFamily ? set({ fontFamily: font.trim() }) : setFont(settings.fontFamily))
  const saveProfile = (p: TerminalProfile) => {
    const known = settings.profiles.some((q) => q.id === p.id)
    set({ profiles: known ? settings.profiles.map((q) => (q.id === p.id ? p : q)) : [...settings.profiles, p] })
    setEditing(undefined)
  }
  const removeProfile = (id: string) =>
    set({ profiles: settings.profiles.filter((p) => p.id !== id), ...(settings.defaultProfile === id ? { defaultProfile: '' } : {}) })
  const profileOptions = [
    { value: '', label: s.loginShell },
    ...shells.map((sh) => ({ value: sh.id, label: sh.name, hint: sh.file })),
    ...settings.profiles.map((p) => ({ value: p.id, label: p.name, hint: p.command }))
  ]

  return (
    <Card icon={SquareTerminal} title={s.title}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className={`${label} min-w-0 flex-1`}>
          {s.font}
          <input
            aria-label={s.font}
            value={font}
            onChange={(e) => setFont(e.target.value)}
            onBlur={saveFont}
            onKeyDown={(e) => e.key === 'Enter' && saveFont()}
            spellCheck={false}
            className={`${field} min-w-0 flex-1`}
          />
        </label>
        <NumberField name={s.fontSize} value={settings.fontSize} bounds={TERMINAL_LIMITS.fontSize} onSave={(fontSize) => set({ fontSize })} />
        <NumberField name={s.lineHeight} value={settings.lineHeight} bounds={TERMINAL_LIMITS.lineHeight} step={0.05} onSave={(lineHeight) => set({ lineHeight })} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className={label}>
          {s.cursor}
          <Select
            label={s.cursor}
            value={settings.cursorStyle}
            options={TERMINAL_CURSORS.map((c) => ({ value: c, label: s.cursors[c] }))}
            onChange={(v) => set({ cursorStyle: v as TerminalSettings['cursorStyle'] })}
          />
        </label>
        <NumberField name={s.scrollback} value={settings.scrollback} bounds={TERMINAL_LIMITS.scrollback} onSave={(scrollback) => set({ scrollback })} />
        <NumberField name={s.bufferKb} value={settings.bufferKb} bounds={TERMINAL_LIMITS.bufferKb} onSave={(bufferKb) => set({ bufferKb })} />
      </div>
      <p className="mt-1 font-sans text-[11.5px] text-text-muted">{s.bufferHint}</p>
      <div className="mt-2">
        <Toggle label={s.cursorBlink} checked={settings.cursorBlink} onChange={(cursorBlink) => set({ cursorBlink })} />
        <Toggle label={s.copyOnSelect} hint={s.copyOnSelectHint} checked={settings.copyOnSelect} onChange={(copyOnSelect) => set({ copyOnSelect })} />
        <Toggle label={s.gpu} hint={s.gpuHint} checked={settings.gpu} onChange={(gpu) => set({ gpu })} />
        <Toggle label={s.restore} hint={s.restoreHint} checked={settings.restoreTabs} onChange={(restoreTabs) => set({ restoreTabs })} />
        <Toggle label={s.shellIntegration} hint={s.shellIntegrationHint} checked={settings.shellIntegration} onChange={(shellIntegration) => set({ shellIntegration })} />
      </div>

      <div className="mt-3 border-t border-hud/40 pt-3">
        <label className="block">
          <span className="mb-1 block font-sans text-[12px] text-text-secondary">{s.defaultProfile}</span>
          <Select label={s.defaultProfile} value={settings.defaultProfile ?? ''} options={profileOptions} onChange={(defaultProfile) => set({ defaultProfile })} />
        </label>
        <div className="mt-3 flex items-center justify-between">
          <span className="font-sans text-[12px] text-text-secondary">{s.profiles}</span>
          <button
            type="button"
            className={button}
            disabled={!!editing || settings.profiles.length >= TERMINAL_LIMITS.profiles}
            onClick={() => setEditing({ id: `custom-${crypto.randomUUID()}`, name: '', command: '', args: [], env: {} })}
          >
            <Plus size={12} /> {s.addProfile}
          </button>
        </div>
        <p className="mt-0.5 font-sans text-[11.5px] text-text-muted">{s.profilesHint}</p>
        <ul className="mt-2 space-y-1">
          {settings.profiles.map((p) => (
            <li key={p.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-sans text-[13px] text-text-primary">{p.name}</span>{' '}
                <span className="font-mono text-[11px] text-text-muted">{[p.command, ...p.args].join(' ')}</span>
              </span>
              <button type="button" aria-label={s.editProfile(p.name)} onClick={() => setEditing(p)} className="text-text-muted hover:text-cyan">
                <Pencil size={12} />
              </button>
              <button type="button" aria-label={s.removeProfile(p.name)} onClick={() => removeProfile(p.id)} className="text-text-muted hover:text-danger">
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
        {editing && <ProfileForm key={editing.id} profile={editing} onSave={saveProfile} onCancel={() => setEditing(undefined)} />}
      </div>
      {error && <p className="mt-2 font-mono text-[11px] text-danger">{error}</p>}
    </Card>
  )
}
