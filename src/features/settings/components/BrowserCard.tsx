import { useEffect, useState } from 'react'
import { Check, Globe, Import, Trash2 } from 'lucide-react'
import { ipc, isDesktop } from '@shared/ipc/client'
import { SEARCH_ENGINES, type BrowserSettings, type SearchEngine } from '@shared/types/browser'
import { Card } from '@/components/ui/Card'
import { Select } from '@/components/ui/Select'
import { useT } from '@/lib/i18n'
import { ImportDialog } from '@/features/browser/components/ImportDialog'
import { useBrowser } from '@/features/browser/store'
import { ENGINE_LABELS } from '@/features/browser/url'
import { BrowserExtrasSettings } from './BrowserExtrasSettings'
import { Toggle } from './Toggle'

const action =
  'mt-2 flex items-center gap-1.5 rounded-md border border-hud/60 px-2.5 py-1.5 font-sans text-[12px] text-text-secondary transition-colors'

/** The browser: which search engine (and its suggestions), the bookmarks bar, vertical tabs, where links from Mindeck open, importing, the history. */
export function BrowserCard() {
  const t = useT()
  const [settings, setSettings] = useState<BrowserSettings>()
  const [cleared, setCleared] = useState(false)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    if (isDesktop()) void ipc('browser:settings').then(setSettings).catch(() => {})
  }, [])

  if (!settings) return null
  // The browser module shows the bookmarks bar from its own copy: keep both in step.
  const apply = (next: BrowserSettings) => {
    setSettings(next)
    useBrowser.setState({ settings: next })
  }
  const configure = (patch: Partial<BrowserSettings>) => void ipc('browser:configure', patch).then(apply).catch(() => {})

  return (
    <Card icon={Globe} title={t.settings.browserCard}>
      <label className="block">
        <span className="mb-1 block font-sans text-[12px] text-text-secondary">{t.settings.searchEngine}</span>
        <Select
          label={t.settings.searchEngine}
          value={settings.searchEngine}
          options={SEARCH_ENGINES.map((e) => ({ value: e, label: ENGINE_LABELS[e] }))}
          onChange={(v) => configure({ searchEngine: v as SearchEngine })}
        />
      </label>
      <div className="mt-2">
        <Toggle label={t.settings.searchSuggestions} hint={t.settings.searchSuggestionsHint} checked={settings.searchSuggestions} onChange={(v) => configure({ searchSuggestions: v })} />
        <Toggle label={t.settings.bookmarksBar} checked={settings.bookmarksBar} onChange={(v) => configure({ bookmarksBar: v })} />
        <Toggle label={t.browserTabs.verticalTabs} hint={t.browserTabs.verticalTabsHint} checked={settings.verticalTabs} onChange={(v) => configure({ verticalTabs: v })} />
        <Toggle label={t.settings.openLinks} hint={t.settings.openLinksHint} checked={settings.openLinksInMindeck} onChange={(v) => configure({ openLinksInMindeck: v })} />
      </div>
      <BrowserExtrasSettings settings={settings} configure={configure} onChange={apply} />
      <button type="button" onClick={() => setImporting(true)} className={`${action} hover:border-cyan/50 hover:text-cyan`}>
        <Import size={12} /> {t.settings.importBrowser}
      </button>
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      <button
        type="button"
        onClick={() =>
          void ipc('browser:clearHistory')
            .then(() => setCleared(true))
            .catch(() => {})
        }
        className={`${action} hover:border-danger/50 hover:text-danger`}
      >
        {cleared ? <Check size={12} className="text-green" /> : <Trash2 size={12} />}
        {cleared ? t.settings.historyCleared : t.settings.clearHistory}
      </button>
    </Card>
  )
}
