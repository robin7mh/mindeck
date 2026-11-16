import { ArrowRightLeft, BookOpen, Code2, Globe, Info, Settings, Smartphone, Sparkles, SquareTerminal, Type, type LucideIcon } from 'lucide-react'
import type { Dict } from '@/lib/i18n/en'

export type SectionId = 'general' | 'ai' | 'editor' | 'languages' | 'terminal' | 'browser' | 'remote' | 'memory' | 'migrate' | 'about'

/** The settings' navigation: its groups, each with its sections, in order. */
export const NAV: { group: keyof Dict['settings']['navGroups']; sections: SectionId[] }[] = [
  { group: 'app', sections: ['general'] },
  { group: 'work', sections: ['ai', 'editor', 'languages', 'terminal', 'browser'] },
  { group: 'data', sections: ['remote', 'memory', 'migrate'] },
  { group: 'help', sections: ['about'] }
]

export const SECTION_ICONS: Record<SectionId, LucideIcon> = {
  general: Settings,
  ai: Sparkles,
  editor: Code2,
  languages: Type,
  terminal: SquareTerminal,
  browser: Globe,
  remote: Smartphone,
  memory: BookOpen,
  migrate: ArrowRightLeft,
  about: Info
}

/** What only the desktop window can set (a paired browser doesn't see them). */
export const DESKTOP_ONLY: readonly SectionId[] = ['terminal', 'browser', 'migrate']
