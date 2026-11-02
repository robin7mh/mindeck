import { useEffect, useRef, useState } from 'react'
import { Bot, Camera, ChevronDown, ChevronUp, ClipboardList, ExternalLink, Bell, MapPin, Mic, MonitorUp, X } from 'lucide-react'
import type { BrowserPermissionKind, BrowserTab } from '@shared/types/browser'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { relativeTime } from '@/features/agents/format'
import { useAssistant } from '@/features/agents/store'
import { ApprovalCard } from '@/features/agents/components/ApprovalCard'
import { useBrowser } from '../store'
import { hostOf } from '../url'

const bar = 'flex shrink-0 items-center gap-2 border-b px-3 py-1.5'
const small =
  'flex items-center gap-1 rounded-md border border-hud/60 px-2 py-0.5 font-sans text-[11.5px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan'

/** In-page search (⌘F): Enter goes on, ⇧Enter back, Escape closes. */
export function FindBar({ tab }: { tab: BrowserTab }) {
  const t = useT()
  const find = useBrowser((s) => s.find)
  const run = useBrowser((s) => s.run)
  const close = () => useBrowser.getState().setFindOpen(false)
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])

  const search = (next: boolean, forward = true) => void run('browser:find', { id: tab.id, text, forward, next })
  const result = find?.tabId === tab.id && text ? (find.matches ? t.browser.matches(find.active, find.matches) : t.browser.noMatches) : ''

  return (
    <div className={cn(bar, 'border-hud/50 bg-surface/40')}>
      <input
        ref={input}
        aria-label={t.browser.find}
        placeholder={t.browser.find}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          void run('browser:find', { id: tab.id, text: e.target.value })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') search(true, !e.shiftKey)
          else if (e.key === 'Escape') close()
        }}
        className="w-64 rounded-md border border-hud/60 bg-surface/70 px-2 py-1 font-sans text-[12px] text-text-primary outline-hidden focus:border-cyan/60"
      />
      <span className="min-w-[70px] font-mono text-[11px] text-text-muted">{result}</span>
      <button type="button" aria-label={t.browser.findPrev} onClick={() => search(true, false)} className="rounded-sm p-1 text-text-muted hover:bg-elevated hover:text-text-primary">
        <ChevronUp size={14} />
      </button>
      <button type="button" aria-label={t.browser.findNext} onClick={() => search(true)} className="rounded-sm p-1 text-text-muted hover:bg-elevated hover:text-text-primary">
        <ChevronDown size={14} />
      </button>
      <button type="button" aria-label={t.browser.findClose} onClick={close} className="ml-auto rounded-sm p-1 text-text-muted hover:bg-elevated hover:text-text-primary">
        <X size={14} />
      </button>
    </div>
  )
}

const PERMISSION_ICON: Record<BrowserPermissionKind, typeof Camera> = {
  camera: Camera,
  microphone: Mic,
  media: Camera,
  notifications: Bell,
  geolocation: MapPin,
  clipboard: ClipboardList,
  screen: MonitorUp,
  external: ExternalLink
}

/** A page asks for something (camera, notifications, another app …): the user answers here, like Chrome's prompt. */
export function PermissionBar({ tabId }: { tabId?: string }) {
  const t = useT()
  const requests = useBrowser((s) => s.state.permissions)
  const run = useBrowser((s) => s.run)
  const [remember, setRemember] = useState(true)
  const req = requests.find((r) => !r.tabId || r.tabId === tabId)
  if (!req) return null
  const Icon = PERMISSION_ICON[req.kind]
  const what = req.kind === 'external' ? t.browser.permissions.external(req.app ?? '') : t.browser.permissions[req.kind]
  const answer = (allow: boolean) => void run('browser:permission', { id: req.id, allow, remember })
  return (
    <div role="alert" className={cn(bar, 'border-amber/30 bg-amber/6')}>
      <Icon size={14} className="shrink-0 text-amber" />
      <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-text-primary">
        <span className="font-mono text-[12px]">{hostOf(req.origin) || req.origin}</span> {what}
      </span>
      <label className="flex items-center gap-1.5 font-sans text-[11.5px] text-text-secondary">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-3.5 w-3.5 accent-cyan" />
        {t.browser.remember}
      </label>
      <button type="button" onClick={() => answer(false)} className={small}>
        {t.browser.block}
      </button>
      <button type="button" onClick={() => answer(true)} className={cn(small, 'border-cyan/50 text-cyan')}>
        {t.browser.allow}
      </button>
    </div>
  )
}

/** What an agent did in this tab — and the switch to make the tab private again. */
export function AgentBar({ tab }: { tab: BrowserTab }) {
  const t = useT()
  const run = useBrowser((s) => s.run)
  const activity = tab.agent
  if (!activity && !tab.openedBy) return null
  return (
    <div className={cn(bar, 'border-purple/30 bg-purple/6')}>
      <Bot size={14} className="shrink-0 text-purple" />
      <span className="min-w-0 flex-1 truncate font-sans text-[12px] text-text-secondary">
        {activity ? (
          <>
            <span className="text-text-primary">{activity.name}</span> {t.browser.agentActions[activity.action]}
            {activity.detail && <span className="font-mono text-[11.5px]"> {activity.detail}</span>}
            <span className="text-text-muted"> · {relativeTime(activity.at)}</span>
          </>
        ) : (
          t.browser.agentTab(tab.openedBy!)
        )}
      </span>
      {tab.shared && (
        <button type="button" onClick={() => void run('browser:update', { id: tab.id, shared: false })} className={small}>
          {t.browser.makePrivate}
        </button>
      )}
    </div>
  )
}

/** Approvals wait right above the page (the floating toasts would sit behind it). */
export function ApprovalDock() {
  const t = useT()
  const pending = useAssistant((s) => s.pending)
  const respond = useAssistant((s) => s.respond)
  if (!pending.length) return null
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-amber/30 bg-amber/4 p-2">
      {pending.length > 1 && <span className="px-1 font-sans text-[11px] text-amber">{t.browser.approvals(pending.length)}</span>}
      <div className="grid gap-2 lg:grid-cols-2">
        {pending.slice(0, 2).map((req) => (
          <ApprovalCard key={req.id} request={req} compact onRespond={(d) => void respond(req.id, d)} />
        ))}
      </div>
    </div>
  )
}
