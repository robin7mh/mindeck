import {
  LayoutDashboard,
  Code2,
  TerminalSquare,
  Globe,
  FolderOpen,
  FolderGit2,
  BrainCircuit,
  Bot,
  Cpu,
  ScrollText,
  Settings2
} from 'lucide-react'
import type { NavItem } from '@/types'

export const NAV_ITEMS: NavItem[] = [
  { id: 'core', icon: LayoutDashboard },
  { id: 'editor', icon: Code2 },
  { id: 'terminal', icon: TerminalSquare },
  { id: 'browser', icon: Globe },
  { id: 'files', icon: FolderOpen },
  { id: 'projects', icon: FolderGit2 },
  { id: 'memory', icon: BrainCircuit },
  { id: 'agents', icon: Bot },
  { id: 'system', icon: Cpu },
  { id: 'logs', icon: ScrollText },
  { id: 'settings', icon: Settings2 }
]
