import { useEffect } from 'react'
import { Code2 } from 'lucide-react'
import type { EditorSettings } from '@shared/types/migrate'
import { Card } from '@/components/ui/Card'
import { useT } from '@/lib/i18n'
import { DEFAULTS, useEditorPrefs } from '@/features/editor/prefs'
import { Toggle } from './Toggle'

const number = 'w-16 rounded-md border border-hud/70 bg-surface/70 px-2 py-1 font-mono text-[12px] text-text-primary outline-hidden focus:border-cyan/60'

/** Settings → Editor: formatting and fixing on save, Prettier, ESLint, the look of the text. */
export function EditorCard() {
  const t = useT()
  const e = t.editorSettings
  const settings = useEditorPrefs((s) => s.settings)
  const prefs = useEditorPrefs.getState()
  const value = <K extends keyof typeof DEFAULTS>(key: K) => (settings[key] ?? DEFAULTS[key]) as (typeof DEFAULTS)[K]
  const set = (patch: Partial<EditorSettings>) => void prefs.update(patch)

  useEffect(() => {
    void useEditorPrefs.getState().load()
  }, [])

  return (
    <Card icon={Code2} title={e.title}>
      <p className="mb-1 font-sans text-[11.5px] text-text-muted">{e.hint}</p>
      <Toggle label={e.formatOnSave} hint={e.formatOnSaveHint} checked={value('formatOnSave')} onChange={(v) => set({ formatOnSave: v })} />
      <Toggle label={e.prettier} hint={e.prettierHint} checked={value('prettier')} onChange={(v) => set({ prettier: v })} />
      <Toggle label={e.eslintFix} hint={e.eslintFixHint} checked={!!settings.eslintFixOnSave} onChange={(v) => set({ eslintFixOnSave: v })} />
      <Toggle label={e.minimap} checked={value('minimap')} onChange={(v) => set({ minimap: v })} />
      <Toggle label={e.wordWrap} checked={value('wordWrap') !== 'off'} onChange={(v) => set({ wordWrap: v ? 'on' : 'off' })} />
      <Toggle label={e.stickyScroll} checked={value('stickyScroll')} onChange={(v) => set({ stickyScroll: v })} />
      <Toggle label={e.vim} hint={e.vimHint} checked={!!settings.vim} onChange={(v) => set({ vim: v })} />
      <div className="mt-2 flex flex-wrap gap-4">
        <label className="flex items-center gap-2 font-sans text-[12.5px] text-text-secondary">
          {e.fontSize}
          <input type="number" min={8} max={32} aria-label={e.fontSize} value={value('fontSize')} onChange={(ev) => Number(ev.target.value) >= 8 && set({ fontSize: Math.min(32, Number(ev.target.value)) })} className={number} />
        </label>
        <label className="flex items-center gap-2 font-sans text-[12.5px] text-text-secondary">
          {e.tabSize}
          <input type="number" min={1} max={8} aria-label={e.tabSize} value={value('tabSize')} onChange={(ev) => Number(ev.target.value) >= 1 && set({ tabSize: Math.min(8, Number(ev.target.value)) })} className={number} />
        </label>
      </div>
    </Card>
  )
}
