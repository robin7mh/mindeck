import { useEffect, useState } from 'react'
import { Check, FolderOpen, Import, RotateCcw, Trash2 } from 'lucide-react'
import { ipc } from '@shared/ipc/client'
import { SEARCH_ENGINES, type BrowserSettings, type SearchEngine } from '@shared/types/browser'
import { useT } from '@/lib/i18n'
import { ImportDialog } from '@/features/browser/components/ImportDialog'
import { useBrowser } from '@/features/browser/store'
import { ENGINE_LABELS } from '@/features/browser/url'
import { Advanced, Group, Pill, Row, Segmented, SectionHeader, SwitchRow, btn, btnDanger, btnIcon, SelectBox } from '../ui'

/**
 * Settings → Browser: the search engine and tabs, protection and what agents
 * may use, downloads, importing and the history — and its shortcuts.
 */
export function BrowserSection() {
  const t = useT()
  const s = t.settings
  const x = t.browserExtras
  const [settings, setSettings] = useState<BrowserSettings>()
  const [cleared, setCleared] = useState(false)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    void ipc('browser:settings').then(setSettings).catch(() => {})
  }, [])

  // The browser module draws the bookmarks bar and tabs from its own copy: keep both in step.
  const apply = (next: BrowserSettings) => {
    setSettings(next)
    useBrowser.setState({ settings: next })
  }
  const configure = (patch: Partial<BrowserSettings>) => void ipc('browser:configure', patch).then(apply).catch(() => {})
  const pickFolder = () =>
    void ipc('browser:pickDownloadDir')
      .then((next) => next && apply(next))
      .catch(() => {})

  return (
    <>
      <SectionHeader title={s.sections.browser.title} intro={s.sections.browser.intro} />
      {settings && (
        <>
          <Group title={s.groups.searchTabs}>
            <Row label={s.searchEngine}>
              <SelectBox
                label={s.searchEngine}
                value={settings.searchEngine}
                options={SEARCH_ENGINES.map((e) => ({ value: e, label: ENGINE_LABELS[e] }))}
                onChange={(v) => configure({ searchEngine: v as SearchEngine })}
                width="w-[200px]"
              />
            </Row>
            <SwitchRow label={s.searchSuggestions} hint={s.searchSuggestionsHint} checked={settings.searchSuggestions} onChange={(v) => configure({ searchSuggestions: v })} />
            <SwitchRow label={s.openLinks} hint={s.openLinksHint} checked={settings.openLinksInMindeck} onChange={(v) => configure({ openLinksInMindeck: v })} />
            <Row label={s.tabBar} hint={t.browserTabs.verticalTabsHint}>
              <Segmented
                label={s.tabBar}
                value={settings.verticalTabs ? 'side' : 'top'}
                options={[
                  { id: 'top', label: s.tabsTop },
                  { id: 'side', label: s.tabsSide }
                ]}
                onChange={(v) => configure({ verticalTabs: v === 'side' })}
              />
            </Row>
            <SwitchRow label={s.bookmarksBar} checked={settings.bookmarksBar} onChange={(v) => configure({ bookmarksBar: v })} />
            <SwitchRow label={s.newTabSuggestions} hint={s.newTabSuggestionsHint} checked={settings.newTabSuggestions} onChange={(v) => configure({ newTabSuggestions: v })} />
          </Group>

          <Group title={s.groups.privacy} footnote={t.browser.agentsSee}>
            <SwitchRow label={x.adblock} hint={x.adblockHint} checked={settings.adblock} onChange={(v) => configure({ adblock: v })} />
            <SwitchRow
              label={x.malware}
              hint={x.malwareHint}
              badge={<Pill tone="mute">{s.recommended}</Pill>}
              checked={settings.malwareProtection}
              onChange={(v) => configure({ malwareProtection: v })}
            />
            <SwitchRow
              label={x.agentLogins}
              hint={x.agentLoginsHint}
              badge={<Pill tone="risk">{s.caution}</Pill>}
              checked={settings.agentsUseLogins}
              onChange={(v) => configure({ agentsUseLogins: v })}
            />
          </Group>

          <Group title={s.groups.downloads}>
            <Row label={x.downloadFolder} hint={<span className="break-all font-mono text-[12px]">{settings.downloadDir || x.systemDownloads}</span>}>
              <div className="flex gap-1.5">
                <button type="button" className={btn} onClick={pickFolder}>
                  <FolderOpen size={14} /> {x.choose}
                </button>
                {settings.downloadDir && (
                  <button type="button" aria-label={x.reset} title={x.reset} className={btnIcon + ' h-9 w-9'} onClick={() => configure({ downloadDir: '' })}>
                    <RotateCcw size={14} />
                  </button>
                )}
              </div>
            </Row>
            <SwitchRow label={x.askDownload} checked={settings.askDownloadLocation} onChange={(v) => configure({ askDownloadLocation: v })} />
            <Row label={s.importTitle} hint={s.importHint}>
              <button type="button" className={btn} onClick={() => setImporting(true)}>
                <Import size={14} /> {s.importButton}
              </button>
            </Row>
            <Row label={s.history}>
              <button
                type="button"
                className={btnDanger}
                onClick={() =>
                  void ipc('browser:clearHistory')
                    .then(() => setCleared(true))
                    .catch(() => {})
                }
              >
                {cleared ? <Check size={14} className="text-green" /> : <Trash2 size={14} />}
                {cleared ? s.historyCleared : s.clearHistory}
              </button>
            </Row>
            <Advanced summary={t.browser.tips}>
              <div className="flex flex-wrap gap-x-5 gap-y-2 px-5 py-4">
                {t.browser.tipKeys.map(([keys, what]) => (
                  <span key={keys} className="flex items-center gap-1.5 font-sans text-[12.5px] text-text-secondary">
                    <kbd className="rounded-sm border border-hud/60 bg-elevated/50 px-1.5 py-px font-mono text-[11px] text-text-primary">{keys}</kbd>
                    {what}
                  </span>
                ))}
              </div>
            </Advanced>
          </Group>
          {importing && <ImportDialog onClose={() => setImporting(false)} />}
        </>
      )}
    </>
  )
}
