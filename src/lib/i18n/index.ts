import { create } from 'zustand'
import { setErrorLocalizer } from '@shared/ipc/client'
import { en, type Dict } from './en'
import { de } from './de'

export type { Dict } from './en'
export type Locale = 'de' | 'en'

/** The languages the UI speaks, in switcher order. */
export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'de', label: 'Deutsch' },
  { id: 'en', label: 'English' }
]

const DICTS: Record<Locale, Dict> = { de, en }
const KEY = 'mindeck.locale'

/** German systems get German, everything else English. */
export function systemLocale(language: string = navigator.language): Locale {
  return language.toLowerCase().startsWith('de') ? 'de' : 'en'
}

function stored(): Locale | undefined {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'de' || v === 'en' ? v : undefined
  } catch {
    return undefined
  }
}

interface LocaleState {
  locale: Locale
  setLocale: (locale: Locale) => void
}

/** The chosen UI language — remembered per device, defaulting to the system language. */
export const useLocale = create<LocaleState>((set) => ({
  locale: stored() ?? systemLocale(),
  setLocale: (locale) => {
    try {
      localStorage.setItem(KEY, locale)
    } catch {
      /* storage unavailable — the choice lasts until reload */
    }
    document.documentElement.lang = locale
    set({ locale })
  }
}))
document.documentElement.lang = useLocale.getState().locale

/** The dictionary for the current language; re-renders on a switch. */
export function useT(): Dict {
  return DICTS[useLocale((s) => s.locale)]
}

/** The dictionary outside React (stores, formatters). */
export function getT(): Dict {
  return DICTS[useLocale.getState().locale]
}

// The transport's own failures in the UI's language (the core's messages stay as they come).
setErrorLocalizer((code, message) => {
  const t = getT().transport
  if (code === 'offline') return t.offline
  if (code === 'no-bridge') return t.noBridge
  if (code === 'bad-response') return t.badResponse(/\((\d+)\)/.exec(message)?.[1] ?? '?')
  // The core's per-device limit (BE-SEC-18), the AI provider's, or too many failed pairings.
  if (code === 'rate-limited') return t.rateLimited(/in (\d+) s\b/.exec(message)?.[1])
  return undefined
})

/** BCP-47 tag for Intl formatting: German, or the system's English variant. */
export function intlLocale(locale: Locale = useLocale.getState().locale, language: string = navigator.language): string {
  if (locale === 'de') return 'de-DE'
  return language.toLowerCase().startsWith('en') ? language : 'en-US'
}
