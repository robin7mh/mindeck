import { useEffect, useRef } from 'react'
import { Boxes, FileText, Laptop, Lock, Search, ShieldAlert, Star, VenetianMask } from 'lucide-react'
import type { BrowserTab } from '@shared/types/browser'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { findByUrl } from '../library'
import { useBrowser } from '../store'
import { security } from '../url'
import { SuggestionList, useAddressField } from './AddressField'
import { ShieldButton } from './Protection'

const SECURITY_ICON = { secure: Lock, insecure: ShieldAlert, local: Laptop, file: FileText, none: Search }

/**
 * The address bar: an address or search words (useAddressField — suggestions,
 * inline completion, the arrows). While not editing it shows where the tab is
 * — and a star to bookmark it (⌘D).
 */
export function Omnibox({ tab }: { tab?: BrowserTab }) {
  const t = useT()
  const focusTick = useBrowser((s) => s.focusTick)
  const input = useRef<HTMLInputElement>(null)
  const field = useAddressField(tab, input)
  const { editing } = field
  const bookmarked = useBrowser((s) => !!tab?.url && !!findByUrl(s.bookmarks, tab.url))

  // ⌘L: into the bar, everything selected.
  useEffect(() => {
    if (!focusTick) return
    input.current?.focus()
    input.current?.select()
  }, [focusTick])

  const kind = security(tab?.url ?? '')
  const Icon = SECURITY_ICON[kind]
  const iconTitle = { secure: t.browser.secure, insecure: t.browser.insecure, local: t.browser.local, file: t.browser.file, none: t.browser.address }[kind]

  return (
    <div className="relative min-w-0 flex-1">
      <div
        className={cn(
          'flex h-8 items-center gap-2 rounded-md border px-2.5 transition-colors',
          editing ? 'border-cyan/50 bg-surface' : 'border-hud/60 bg-surface/50 hover:border-hud-strong/70'
        )}
      >
        {tab?.profile === 'private' && (
          <span title={t.browserExtras.privateHint} className="flex shrink-0 items-center gap-1 rounded-sm bg-purple/15 px-1.5 py-0.5 font-sans text-[10.5px] text-purple">
            <VenetianMask size={12} aria-hidden /> {t.browserExtras.privateTab}
          </span>
        )}
        {tab?.profile === 'agents' && (
          <span title={t.browserExtras.agentsContainer} aria-label={t.browserExtras.agentsContainer} className="shrink-0 text-purple">
            <Boxes size={13} aria-hidden />
          </span>
        )}
        <span title={iconTitle} className={cn('shrink-0', kind === 'insecure' ? 'text-amber' : kind === 'secure' ? 'text-green' : 'text-text-muted')}>
          <Icon size={13} aria-hidden />
        </span>
        <input
          ref={input}
          aria-label={t.browser.address}
          placeholder={t.browser.addressHint}
          {...field.props}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-text-primary outline-hidden placeholder:font-sans placeholder:text-text-muted"
        />
        {tab && !editing && <ShieldButton tab={tab} />}
        {/* A private tab leaves no bookmarks behind. */}
        {!editing && tab && tab.profile !== 'private' && /^(https?|file):/i.test(tab.url) && (
          <button
            type="button"
            aria-label={bookmarked ? t.library.starred : t.library.star}
            title={bookmarked ? t.library.starred : t.library.star}
            onClick={() => void useBrowser.getState().bookmarkActive()}
            className={cn('shrink-0 rounded-sm p-0.5 transition-colors hover:bg-elevated', bookmarked ? 'text-amber' : 'text-text-muted hover:text-amber')}
          >
            <Star size={13} className={bookmarked ? 'fill-current' : undefined} />
          </button>
        )}
      </div>
      {field.open && <SuggestionList field={field} label={t.browser.address} className="mt-1" />}
    </div>
  )
}
