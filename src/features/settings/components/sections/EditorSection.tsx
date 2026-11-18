import { useEffect } from 'react'
import type { EditorSettings } from '@shared/types/migrate'
import { useT } from '@/lib/i18n'
import { DEFAULTS, useEditorPrefs } from '@/features/editor/prefs'
import { Group, NumberField, Row, SectionHeader, SwitchRow, SelectBox } from '../ui'

/** Settings → Editor: the text, what happens on save, and what the editor shows. */
export function EditorSection() {
  const t = useT()
  const e = t.editorSettings
  const s = t.settings
  const settings = useEditorPrefs((st) => st.settings)
  const value = <K extends keyof typeof DEFAULTS>(key: K) => (settings[key] ?? DEFAULTS[key]) as (typeof DEFAULTS)[K]
  const set = (patch: Partial<EditorSettings>) => void useEditorPrefs.getState().update(patch)

  useEffect(() => {
    void useEditorPrefs.getState().load()
  }, [])

  // Indentation: tabs, or a number of spaces (2 and 4 always offered, any other width as it is set).
  const tabSize = value('tabSize')
  const indent = value('insertSpaces') ? String(tabSize) : 'tab'
  const widths = [...new Set([2, 4, tabSize])].sort((a, b) => a - b)

  return (
    <>
      <SectionHeader title={s.sections.editor.title} intro={s.sections.editor.intro} />
      <Group title={s.groups.text} footnote={e.hint}>
        <Row label={e.fontSize} htmlFor="settings-editor-font-size">
          <NumberField id="settings-editor-font-size" label={e.fontSize} value={value('fontSize')} bounds={[8, 32]} onSave={(fontSize) => set({ fontSize })} />
        </Row>
        <Row label={s.indent}>
          <SelectBox
            label={s.indent}
            value={indent}
            options={[...widths.map((n) => ({ value: String(n), label: s.indentSpaces(n) })), { value: 'tab', label: s.indentTab }]}
            onChange={(v) => set(v === 'tab' ? { insertSpaces: false } : { insertSpaces: true, tabSize: Number(v) })}
            width="w-[160px]"
          />
        </Row>
        <SwitchRow label={e.wordWrap} checked={value('wordWrap') !== 'off'} onChange={(v) => set({ wordWrap: v ? 'on' : 'off' })} />
      </Group>
      <Group title={s.groups.onSave}>
        <SwitchRow label={e.formatOnSave} hint={e.formatOnSaveHint} checked={value('formatOnSave')} onChange={(v) => set({ formatOnSave: v })} />
        <SwitchRow label={e.prettier} hint={e.prettierHint} indent checked={value('prettier')} onChange={(v) => set({ prettier: v })} />
        <SwitchRow label={e.eslintFix} hint={e.eslintFixHint} checked={!!settings.eslintFixOnSave} onChange={(v) => set({ eslintFixOnSave: v })} />
      </Group>
      <Group title={s.groups.display}>
        <SwitchRow label={e.minimap} checked={value('minimap')} onChange={(v) => set({ minimap: v })} />
        <SwitchRow label={e.stickyScroll} checked={value('stickyScroll')} onChange={(v) => set({ stickyScroll: v })} />
        <SwitchRow label={e.vim} hint={e.vimHint} checked={!!settings.vim} onChange={(v) => set({ vim: v })} />
      </Group>
    </>
  )
}
